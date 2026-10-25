#!/usr/bin/env python3
"""Quizzard client: group quiz battles for a Cubbie group chat.

Talks to the Quizzard relay (JSON over HTTPS). State (groups, tokens) is kept in
~/.config/quizzard/state.json with mode 600. Tokens are never printed.

Exit codes: 0 ok, 2 not in a group, 3 group/quiz/member not found, 4 server unreachable,
5 auth rejected, 6 bad input or not allowed right now (the message says why), 7 other server error.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
from pathlib import Path

DEFAULT_SERVER = "https://quizzard-cubbie.vercel.app"
LETTERS = "ABCD"


def fail(message: str, code: int):
    print(f"quizzard: {message}", file=sys.stderr)
    sys.exit(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):  # argparse would exit 2, which means "not in a group"
        fail(message, 6)


# ---------- state ----------

def state_path() -> Path:
    return Path.home() / ".config" / "quizzard" / "state.json"


def load_state() -> dict:
    try:
        st = json.loads(state_path().read_text())
        if isinstance(st, dict):
            st.setdefault("groups", {})
            return st
    except (OSError, ValueError):
        pass
    return {"groups": {}}


def save_state(st: dict) -> None:
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(p.parent, 0o700)
    except OSError:
        pass
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(st, f, indent=2)
    os.chmod(p, 0o600)


def server_url(st: dict) -> str:
    return (os.environ.get("QUIZZARD_SERVER") or st.get("server") or DEFAULT_SERVER).rstrip("/")


def pick_group(st: dict, wanted: str | None):
    """Return (code, group dict) or exit 2."""
    groups = st.get("groups", {})
    code = (wanted or st.get("default") or "").strip().upper()
    if not code and len(groups) == 1:
        code = next(iter(groups))
    if not code or code not in groups:
        if wanted:
            fail(f"not in group {wanted.upper()}. Run join --code {wanted.upper()} --me \"<name>\".", 2)
        fail("not in a Quizzard group yet. Run create --name \"<group>\" --me \"<name>\" or join --code <CODE> --me \"<name>\".", 2)
    return code, groups[code]


# ---------- http ----------

def http(method: str, base: str, path: str, body=None, token: str | None = None, query: dict | None = None):
    url = base + "/api" + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json", "User-Agent": "quizzard-cubbie/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8", "replace")).get("error")
        except Exception:
            msg = None
        msg = msg or f"server returned HTTP {e.code}"
        if e.code == 401:
            fail(f"{msg} (token invalid or removed; run join again).", 5)
        if e.code == 404:
            fail(msg, 3)
        if e.code in (400, 403, 409):
            fail(msg, 6)
        fail(msg, 7)
    except (urllib.error.URLError, HTTPException, TimeoutError, OSError, ValueError) as e:
        reason = getattr(e, "reason", e)
        fail(f"cannot reach the Quizzard server at {base} ({reason}).", 4)
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        fail("server sent a response that is not JSON.", 7)


# ---------- time ----------

def zone(tz: str):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(tz)
    except Exception:
        return None


def parse_start(s: str, tz: str) -> str:
    """'2026-10-30 20:00' in the group's zone, or an ISO time with an offset -> ISO with offset."""
    t = s.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        fail(f"bad --start '{s}': use \"YYYY-MM-DD HH:MM\" (24h), e.g. \"2026-10-30 20:00\".", 6)
    if dt.tzinfo is None:
        z = zone(tz)
        if z is None:
            fail(f"time zone {tz} is not available here; pass --start with an offset like 2026-10-30T20:00-07:00.", 6)
        dt = dt.replace(tzinfo=z)
    return dt.isoformat(timespec="seconds")


def local(iso: str, tz: str) -> datetime:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    z = zone(tz)
    return dt.astimezone(z) if z else dt


def pretty_time(iso: str, tz: str) -> str:
    dt = local(iso, tz)
    hour = dt.strftime("%I").lstrip("0") or "12"
    return f"{dt.strftime('%a %b')} {dt.day}, {hour}:{dt.strftime('%M')} {dt.strftime('%p').lower()}"


def clock(iso: str, tz: str) -> str:
    dt = local(iso, tz)
    return f"{dt.strftime('%I').lstrip('0') or '12'}:{dt.strftime('%M')} {dt.strftime('%p').lower()}"


def now_in(tz: str) -> datetime:
    z = zone(tz)
    return datetime.now(z) if z else datetime.now(timezone.utc)


def month_arg(v: str | None, tz: str) -> str:
    today = now_in(tz)
    if not v or v == "this":
        return f"{today.year}-{today.month:02d}"
    if v == "last":
        first = today.replace(day=1)
        prev = first - timedelta(days=1)
        return f"{prev.year}-{prev.month:02d}"
    try:
        datetime.strptime(v, "%Y-%m")
    except ValueError:
        fail(f"bad --month '{v}': use this, last or YYYY-MM.", 6)
    return v


# ---------- helpers ----------

def names(xs: list) -> str:
    if not xs:
        return ""
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def current_quiz(base: str, g: dict, code: str, want: str | None, prefer: str = "open") -> str:
    """Quiz id: --id, else a live quiz, else the next scheduled one, else (for results) the latest closed one."""
    if want:
        return want
    info = http("GET", base, f"/groups/{code}", token=g["token"])
    qs = info.get("quizzes", [])
    live = [q for q in qs if q["phase"] == "live"]
    sched = sorted([q for q in qs if q["phase"] == "scheduled"], key=lambda q: q["start_at"])
    closed = sorted([q for q in qs if q["phase"] == "closed"], key=lambda q: q["start_at"])
    order = (closed[::-1] + live + sched) if prefer == "closed" else (live + sched)
    if not order:
        fail("no quiz to use right now." + (" None has finished yet." if prefer == "closed" else " Start one with new."), 3)
    return order[0]["id"]


def checkin_lines(q: dict) -> list[str]:
    c = q["checkins"]
    out = []
    if c["ready"] or c["late"]:
        out.append("Ready: " + names(c["ready"] + [f"{n} (late)" for n in c["late"]]))
    if c["excused"]:
        out.append("Excused: " + names(c["excused"]))
    if c["waiting"]:
        out.append("Waiting on: " + names(c["waiting"]))
    return out


def scorecard_link(base: str, code: str, view_key: str, month: str) -> str:
    return f"{base}/scorecard.html#" + urllib.parse.urlencode({"c": code, "v": view_key, "m": month})


# ---------- commands ----------

def cmd_create(a, st):
    base = server_url(st)
    r = http("POST", base, "/groups", {"name": a.name, "member_name": a.me, "tz": a.tz, "budget": a.budget})
    st["groups"][r["code"]] = {"name": r["name"], "me": a.me, "member_id": r["member_id"], "token": r["token"],
                               "view_key": r["view_key"], "tz": r["tz"], "host": True}
    st["default"] = r["code"]
    save_state(st)
    print(f"Created {r['name']}. Group code:")
    print(r["code"])
    print(f"Treat budget for last place: ${r['budget']}. Time zone: {r['tz']}.")


def cmd_join(a, st):
    base = server_url(st)
    code = a.code.strip().upper()
    r = http("POST", base, f"/groups/{urllib.parse.quote(code)}/join", {"member_name": a.me})
    st["groups"][code] = {"name": r["name"], "me": a.me, "member_id": r["member_id"], "token": r["token"],
                          "tz": r["tz"], "host": r["host"]}
    st["default"] = code
    save_state(st)
    print(f"Joined {r['name']} as {a.me}.")


def cmd_add(a, st):
    code, g = pick_group(st, a.group)
    r = http("POST", server_url(st), f"/groups/{code}/members", {"name": a.name}, token=g["token"])
    print(f"Added {r['name']} to {g['name']}.")


def cmd_status(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    r = http("GET", base, f"/groups/{code}", token=g["token"])
    g.update({"tz": r["tz"], "name": r["name"]})
    save_state(st)
    print(f"{r['name']} ({code}), you are {g['me']}{' (host)' if g.get('host') else ''}")
    print("Members: " + names([m["name"] for m in r["members"]]))
    print(f"Treat budget: ${r['budget']}")
    for q in r["quizzes"]:
        label = {"live": "LIVE now", "scheduled": "Coming up", "closed": "Finished"}[q["phase"]]
        print(f"- {label}: {q['topic']}{' · ' + q['course'] if q['course'] else ''}, {pretty_time(q['start_at'], r['tz'])} (id {q['id']})")


def cmd_settings(a, st):
    code, g = pick_group(st, a.group)
    body = {}
    if a.budget is not None:
        body["budget"] = a.budget
    if a.tz:
        body["tz"] = a.tz
    r = http("POST", server_url(st), f"/groups/{code}/settings", body, token=g["token"])
    g["tz"] = r["tz"]
    save_state(st)
    print(f"Saved. Treat budget ${r['budget']}, time zone {r['tz']}.")


def load_questions(path: str) -> list:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"cannot read questions file {path} ({e}).", 6)
    if not isinstance(raw, list):
        fail("questions file must be a JSON list.", 6)
    out = []
    for i, q in enumerate(raw, 1):
        if not isinstance(q, dict) or not isinstance(q.get("choices"), list):
            fail(f"question {i} needs q, choices and answer.", 6)
        ans = q.get("answer")
        if isinstance(ans, str):
            letter = ans.strip().upper()[:1]
            if letter not in LETTERS[: len(q["choices"])]:
                fail(f"question {i} answer '{ans}' is not one of its choice letters.", 6)
            ans = LETTERS.index(letter)
        out.append({"q": q.get("q"), "choices": q["choices"], "answer": ans,
                    "explain": q.get("explain", ""), "source": q.get("source", "")})
    return out


def cmd_new(a, st):
    code, g = pick_group(st, a.group)
    body = {"topic": a.topic, "start_at": parse_start(a.start, g.get("tz") or "America/Phoenix"),
            "duration_min": a.minutes, "questions": load_questions(a.questions_file)}
    if a.course:
        body["course"] = a.course
    q = http("POST", server_url(st), f"/groups/{code}/quizzes", body, token=g["token"])
    tz = g.get("tz") or "America/Phoenix"
    print(f"Locked: {q['topic']}{' · ' + q['course'] if q['course'] else ''}, {pretty_time(q['start_at'], tz)}")
    print(f"{q['questions']} questions, {q['duration_min']} min. Quiz id {q['id']}.")
    start = local(q["start_at"], tz)
    for label, mins in (("check-in", 30), ("alert", 10)):
        t = start - timedelta(minutes=mins)
        print(f"Schedule {label} at {clock(t.isoformat(), tz)}")
    print(f"Schedule start at {clock(q['start_at'], tz)}")
    print(f"Schedule results at {clock((local(q['ends_at'], tz) + timedelta(minutes=1)).isoformat(), tz)}")


def cmd_quiz(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id)
    q = http("GET", base, f"/quizzes/{qid}", token=g["token"])
    tz = g.get("tz") or "America/Phoenix"
    phase = {"live": "live now", "scheduled": "starts", "closed": "finished", "cancelled": "cancelled"}[q["phase"]]
    print(f"{q['topic']}{' · ' + q['course'] if q['course'] else ''}: {phase} {pretty_time(q['start_at'], tz) if q['phase'] == 'scheduled' else ''}".rstrip())
    print(f"{q['questions']} questions, ends {clock(q['ends_at'], tz)}. Set up by {q['created_by']}. Quiz id {q['id']}.")
    for line in checkin_lines(q):
        print(line)


def cmd_checkin(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id)
    r = http("POST", base, f"/quizzes/{qid}/checkin", {"status": a.status, "as": a.as_name}, token=g["token"])
    if r["status"] == "excused":
        print(f"{r['member']} is excused this round. No penalty.")
    elif r["late"]:
        print(f"{r['member']} made it, just late. Question 1 is forfeited.")
    else:
        print(f"{r['member']} is ready.")
    for line in checkin_lines(r["quiz"]):
        print(line)


def cmd_question(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id)
    r = http("POST", base, f"/quizzes/{qid}/question", {"n": a.n, "as": a.as_name}, token=g["token"])
    print(f"Q{r['n']} of {r['total']}")
    print(r["q"])
    for c in r["choices"]:
        print(f"{c['letter']}) {c['text']}")
    if r["answered"]:
        print("(already answered)")


def cmd_answer(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id)
    r = http("POST", base, f"/quizzes/{qid}/answer", {"n": a.n, "choice": a.choice, "as": a.as_name}, token=g["token"])
    tz = g.get("tz") or "America/Phoenix"
    if r["answered"] >= r["total"]:
        print(f"Locked in. All {r['total']} done. Results at {clock(r['ends_at'], tz)} in the group.")
    else:
        print(f"Locked in ({r['answered']} of {r['total']}).")


def cmd_results(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id, prefer="closed")
    r = http("GET", base, f"/quizzes/{qid}/results", token=g["token"])
    print(f"Results: {r['topic']}{' · ' + r['course'] if r['course'] else ''}")
    for p in r["players"]:
        if p["status"] == "excused":
            print(f"- {p['name']}: excused")
        elif p["status"] == "dq":
            print(f"- {p['name']}: DQ (no check-in), 0")
        else:
            extra = f", {p['correct']}/{len(r['questions'])} right" + (", late" if p["status"] == "late" else "")
            print(f"{p['rank']}. {p['name']} {p['points']} pts{extra}")
    winners = [p["name"] for p in r["players"] if p["member_id"] in r["winner_ids"]]
    if winners:
        print("Round winner: " + names(winners))
    m = r.get("most_missed")
    if m:
        print(f"Most missed: Q{m['n']} ({m['out_of'] - m['correct']} of {m['out_of']} missed). {m['q']}")
        print(f"Answer: {m['answer']}) {m['answer_text']}" + (f". {m['explain']}" if m["explain"] else ""))
        if m["source"]:
            print(f"Source: {m['source']}")
    elif any(p["status"] in ("played", "late") for p in r["players"]):
        print("Nobody missed a question. Clean sweep.")


def cmd_cancel(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    qid = current_quiz(base, g, code, a.id)
    http("POST", base, f"/quizzes/{qid}/cancel", {}, token=g["token"])
    print("Quiz cancelled.")


def cmd_scorecard(a, st):
    code, g = pick_group(st, a.group)
    base = server_url(st)
    tz = g.get("tz") or "America/Phoenix"
    if a.only_if_last_day:
        today = now_in(tz)
        if today.day != calendar.monthrange(today.year, today.month)[1]:
            return  # not the last day of the month: print nothing
    month = month_arg(a.month, tz)
    c = http("GET", base, f"/groups/{code}/scorecard", token=g["token"], query={"month": month})
    print(f"Quizzard scorecard · {c['label']} · {c['group']}")
    if not c["rounds"]:
        print("No rounds this month.")
        return
    print(f"{c['rounds']} round{'s' if c['rounds'] != 1 else ''}")
    for s in c["standings"]:
        tail = []
        if s["wins"]:
            tail.append(f"{s['wins']} win{'s' if s['wins'] != 1 else ''}")
        if s["dq"]:
            tail.append(f"{s['dq']} DQ")
        print(f"{s['rank']}. {s['name']} {s['points']} pts" + (f" ({', '.join(tail)})" if tail else ""))
    if c["mvp"]:
        print("Quizzard of the month: " + names(c["mvp"]))
    if c["last"]:
        who = names(c["last"]["names"])
        verb = "split the treat" if c["last"]["tie"] else "treats the group"
        print(f"Last place: {who} {verb}" + (f", up to ${c['last']['budget']}" if c["last"]["budget"] else ""))
    if c["most_improved"]:
        print(f"Most improved: {c['most_improved']['name']} (+{c['most_improved']['per_round_gain']} pts a round)")
    if c["best_round"]:
        b = c["best_round"]
        print(f"Best round: {b['name']}, {b['points']} pts on {b['topic']}")
    if g.get("view_key"):
        print("Card:")
        print(scorecard_link(base, code, g["view_key"], month))


def cmd_leave(a, st):
    code, g = pick_group(st, a.group)
    http("POST", server_url(st), f"/groups/{code}/leave", {}, token=g["token"])
    st["groups"].pop(code, None)
    if st.get("default") == code:
        st.pop("default", None)
    save_state(st)
    print(f"Left {g['name']}. Your points and answers are deleted.")


def main(argv=None):
    p = Parser(prog="quizzard.py", description="Quizzard: group quiz battles for Cubbie.")
    p.add_argument("--group", help="group code (default: your only or last-used group)")
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=Parser)

    s = sub.add_parser("create", help="start a group (you become host)")
    s.add_argument("--name", required=True)
    s.add_argument("--me", required=True)
    s.add_argument("--tz", default="America/Phoenix")
    s.add_argument("--budget", type=int, default=25)
    s = sub.add_parser("join", help="join a group with its code")
    s.add_argument("--code", required=True)
    s.add_argument("--me", required=True)
    s = sub.add_parser("add", help="host: add a friend by name")
    s.add_argument("--name", required=True)
    sub.add_parser("status", help="group, members and quizzes")
    s = sub.add_parser("settings", help="host: change treat budget or time zone")
    s.add_argument("--budget", type=int)
    s.add_argument("--tz")
    s = sub.add_parser("new", help="lock in a quiz")
    s.add_argument("--topic", required=True)
    s.add_argument("--course")
    s.add_argument("--start", required=True, help='"YYYY-MM-DD HH:MM" in the group time zone')
    s.add_argument("--minutes", type=int, default=10)
    s.add_argument("--questions-file", required=True)
    for name in ("quiz", "results", "cancel"):
        s = sub.add_parser(name)
        s.add_argument("--id")
    s = sub.add_parser("checkin")
    s.add_argument("--status", choices=["ready", "excused"], required=True)
    s.add_argument("--id")
    s.add_argument("--as", dest="as_name")
    s = sub.add_parser("question")
    s.add_argument("--n", type=int, required=True)
    s.add_argument("--id")
    s.add_argument("--as", dest="as_name")
    s = sub.add_parser("answer")
    s.add_argument("--n", type=int, required=True)
    s.add_argument("--choice", required=True)
    s.add_argument("--id")
    s.add_argument("--as", dest="as_name")
    s = sub.add_parser("scorecard")
    s.add_argument("--month", help="this, last or YYYY-MM (default this)")
    s.add_argument("--only-if-last-day", action="store_true", help="print nothing unless today is the month's last day")
    sub.add_parser("leave")

    a = p.parse_args(argv)
    st = load_state()
    {
        "create": cmd_create, "join": cmd_join, "add": cmd_add, "status": cmd_status, "settings": cmd_settings,
        "new": cmd_new, "quiz": cmd_quiz, "checkin": cmd_checkin, "question": cmd_question, "answer": cmd_answer,
        "results": cmd_results, "cancel": cmd_cancel, "scorecard": cmd_scorecard, "leave": cmd_leave,
    }[a.cmd](a, st)


if __name__ == "__main__":
    main()
