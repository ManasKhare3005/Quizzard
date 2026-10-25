// Pure logic for the Quizzard relay: validation, quiz phases, scoring and the monthly scorecard.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LETTERS = ['A', 'B', 'C', 'D'];
export const GRACE_MS = 2 * 60000; // late check-in allowed this long after the start (first question is forfeited)
export const POINTS_CORRECT = 10;
export const SPEED_MAX = 5; // bonus for an instant answer, falling to 0 at SPEED_WINDOW_S
export const SPEED_WINDOW_S = 30;
export const STREAK_BONUS = 2; // per correct answer after the first in a row

export class InputError extends Error {}

// ---------- strings ----------
function cleanStr(v, max, field, { required = false } = {}) {
  if (typeof v !== 'string') {
    if (required) throw new InputError(`${field} is required.`);
    throw new InputError(`${field} must be a string.`);
  }
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new InputError(`${field} is required.`);
  if (s.length > max) throw new InputError(`${field} must be at most ${max} characters.`);
  return s;
}
export function sanitizeName(v, max, field) {
  return cleanStr(v, max, field, { required: true });
}
export function optStr(v, max, field) {
  if (v === undefined || v === null) return '';
  return cleanStr(v, max, field);
}

export function normalizeCourse(input) {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw new InputError('course must be a string.');
  const t = input.toUpperCase().replace(/\s+/g, ' ').trim();
  const m = /^([A-Z]{2,6}) ?-? ?(\d{2,4}[A-Z]?)$/.exec(t);
  if (m) return `${m[1]} ${m[2]}`;
  if (/^[A-Z0-9 &\-]{2,16}$/.test(t)) return t;
  throw new InputError('course is not a valid course code (try "CSE 576").');
}

// ---------- group settings ----------
export function sanitizeTz(v) {
  if (v === undefined || v === null || v === '') return 'America/Phoenix';
  if (typeof v !== 'string' || v.length > 64) throw new InputError('tz must be an IANA time zone like America/Phoenix.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw new InputError('tz must be an IANA time zone like America/Phoenix.');
  }
  return v;
}
export function sanitizeBudget(v) {
  if (v === undefined || v === null || v === '') return 25;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 500) throw new InputError('budget must be a number from 0 to 500.');
  return Math.round(n);
}

// ---------- quiz input ----------
export function sanitizeQuizInput(body, now = new Date()) {
  const topic = sanitizeName(body.topic, 60, 'topic');
  const course = normalizeCourse(body.course);
  if (typeof body.start_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(body.start_at)) {
    throw new InputError('start_at must be an ISO date-time with a time zone offset, like 2026-10-30T20:00:00-07:00.');
  }
  const start = new Date(body.start_at);
  if (Number.isNaN(start.getTime())) throw new InputError('start_at is not a real date-time.');
  if (start.getTime() < now.getTime() - 60000) throw new InputError('start_at is in the past.');
  if (start.getTime() > now.getTime() + 60 * 86400000) throw new InputError('start_at must be within the next 60 days.');
  const dur = body.duration_min === undefined ? 10 : Number(body.duration_min);
  if (!Number.isInteger(dur) || dur < 3 || dur > 60) throw new InputError('duration_min must be a whole number from 3 to 60.');
  if (!Array.isArray(body.questions)) throw new InputError('questions must be a list.');
  if (body.questions.length < 3 || body.questions.length > 10) throw new InputError('a quiz needs 3 to 10 questions.');
  const questions = body.questions.map((q, i) => {
    const at = `question ${i + 1}`;
    if (!q || typeof q !== 'object') throw new InputError(`${at} must be an object.`);
    const text = sanitizeName(q.q, 300, `${at} text`);
    if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 4) throw new InputError(`${at} needs 2 to 4 choices.`);
    const choices = q.choices.map((c, j) => sanitizeName(c, 120, `${at} choice ${LETTERS[j]}`));
    if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) throw new InputError(`${at} has duplicate choices.`);
    const answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) throw new InputError(`${at} answer must be the index of one of its choices.`);
    return { q: text, choices, answer, explain: optStr(q.explain, 300, `${at} explain`), source: optStr(q.source, 120, `${at} source`) };
  });
  return { topic, course, start_at: start, duration_min: dur, questions };
}

// ---------- phases ----------
export function endsAt(quiz) {
  return new Date(new Date(quiz.start_at).getTime() + quiz.duration_min * 60000);
}
/** 'cancelled' | 'scheduled' (before start) | 'live' | 'closed' */
export function phase(quiz, now = new Date()) {
  if (quiz.status === 'cancelled') return 'cancelled';
  const t = now.getTime();
  if (t < new Date(quiz.start_at).getTime()) return 'scheduled';
  if (t < endsAt(quiz).getTime()) return 'live';
  return 'closed';
}

/** Ready / late / excused / waiting name lists for the check-in alerts. */
export function checkinView(quiz, members) {
  const out = { ready: [], late: [], excused: [], waiting: [] };
  for (const m of members) {
    const c = (quiz.checkins || {})[m.member_id];
    if (!c) out.waiting.push(m.name);
    else if (c.status === 'excused') out.excused.push(m.name);
    else if (c.late) out.late.push(m.name);
    else out.ready.push(m.name);
  }
  return out;
}

// ---------- scoring ----------
export function speedBonus(servedAt, answeredAt) {
  const secs = (new Date(answeredAt).getTime() - new Date(servedAt).getTime()) / 1000;
  return Math.max(0, Math.round(SPEED_MAX * (1 - secs / SPEED_WINDOW_S)));
}

/** Final results for a closed quiz. Members are the group's current members. */
export function scoreQuiz(quiz, members) {
  const qs = quiz.questions;
  const stats = qs.map(() => ({ correct: 0, attempted: 0 }));
  const players = members.map((m) => {
    const c = (quiz.checkins || {})[m.member_id];
    const base = { member_id: m.member_id, name: m.name, points: 0, correct: 0, answered: 0, best_streak: 0 };
    if (!c) return { ...base, status: 'dq' };
    if (c.status === 'excused') return { ...base, status: 'excused' };
    const answers = (quiz.answers || {})[m.member_id] || {};
    const served = (quiz.served || {})[m.member_id] || {};
    let points = 0, correct = 0, answered = 0, run = 0, best = 0;
    qs.forEach((q, i) => {
      const a = answers[String(i + 1)];
      if (!a) {
        run = 0;
        return;
      }
      answered++;
      stats[i].attempted++;
      if (a.choice === q.answer) {
        correct++;
        stats[i].correct++;
        points += POINTS_CORRECT + (served[String(i + 1)] ? speedBonus(served[String(i + 1)], a.at) : 0);
        if (run > 0) points += STREAK_BONUS;
        run++;
        best = Math.max(best, run);
      } else run = 0;
    });
    return { ...base, status: c.late ? 'late' : 'played', points, correct, answered, best_streak: best };
  });
  const playing = players.filter((p) => p.status === 'played' || p.status === 'late');
  // played members who did not answer anything still count toward "played"
  const nPlaying = playing.length;
  const questions = qs.map((q, i) => ({
    n: i + 1, q: q.q, answer: LETTERS[q.answer], answer_text: q.choices[q.answer], explain: q.explain, source: q.source,
    correct: stats[i].correct, out_of: nPlaying,
  }));
  let mostMissed = null;
  if (nPlaying > 0) {
    for (const q of questions) {
      const missed = q.out_of - q.correct;
      if (missed > 0 && (!mostMissed || missed > mostMissed.out_of - mostMissed.correct)) mostMissed = q;
    }
  }
  const ranked = rank(players.filter((p) => p.status !== 'excused'), (p) => p.points);
  const top = ranked.length && ranked[0].points > 0 ? ranked.filter((p) => p.rank === 1).map((p) => p.member_id) : [];
  return {
    quiz_id: quiz.id, topic: quiz.topic, course: quiz.course || null, start_at: new Date(quiz.start_at).toISOString(),
    players: ranked.concat(players.filter((p) => p.status === 'excused').map((p) => ({ ...p, rank: null }))),
    questions, most_missed: mostMissed, winner_ids: top,
  };
}

/** Sort descending by key; equal values share a rank (1, 1, 3). Stable on name. */
export function rank(list, key) {
  const sorted = [...list].sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name));
  let prev = null;
  let r = 0;
  return sorted.map((p, i) => {
    if (prev === null || key(p) !== prev) r = i + 1;
    prev = key(p);
    return { ...p, rank: r };
  });
}

// ---------- months ----------
export function monthOf(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(date));
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}
export function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function totals(results, members) {
  const by = new Map(members.map((m) => [m.member_id, { member_id: m.member_id, name: m.name, points: 0, played: 0, wins: 0, dq: 0, excused: 0, best_streak: 0 }]));
  for (const r of results) {
    for (const p of r.players) {
      const t = by.get(p.member_id);
      if (!t) continue; // member left
      if (p.status === 'dq') t.dq++;
      else if (p.status === 'excused') t.excused++;
      else {
        t.played++;
        t.points += p.points;
        t.best_streak = Math.max(t.best_streak, p.best_streak);
      }
    }
    for (const id of r.winner_ids) if (by.has(id)) by.get(id).wins++;
  }
  return [...by.values()];
}

/** Monthly scorecard from the final results of this month's and last month's quizzes. */
export function buildScorecard({ group, members, month, results, prevResults }) {
  const rows = rank(totals(results, members), (t) => t.points);
  const rounds = results.length;
  let mvp = null, last = null, improved = null, bestRound = null;
  if (rounds > 0 && rows.length && rows[0].points > 0) {
    mvp = rows.filter((r) => r.rank === 1).map((r) => r.name);
    if (rows.length > 1) {
      const lowest = rows[rows.length - 1].points;
      const names = rows.filter((r) => r.points === lowest).map((r) => r.name);
      if (names.length < rows.length) last = { names, tie: names.length > 1, budget: group.budget };
    }
    const prev = new Map(totals(prevResults || [], members).map((t) => [t.member_id, t]));
    let bestDelta = 0;
    for (const r of rows) {
      const p = prev.get(r.member_id);
      if (!p || !p.played || !r.played) continue;
      const delta = r.points / r.played - p.points / p.played;
      if (delta > bestDelta + 1e-9) {
        bestDelta = delta;
        improved = { name: r.name, per_round_gain: Math.round(delta) };
      }
    }
    for (const res of results) {
      const top = res.players.find((p) => p.rank === 1 && p.points > 0);
      if (top && (!bestRound || top.points > bestRound.points)) bestRound = { topic: res.topic, name: top.name, points: top.points };
    }
  }
  return {
    group: group.name, month, label: monthLabel(month), rounds, budget: group.budget,
    standings: rows.map(({ member_id, ...r }) => r), mvp, last, most_improved: improved, best_round: bestRound,
  };
}
