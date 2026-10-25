// Single Vercel function; vercel.json rewrites /api/(.*) here and routing is done below.
import crypto from 'node:crypto';
import * as L from '../lib/logic.js';
import { getStore } from '../lib/db.js';

const MAX_BODY = 64 * 1024;
const MAX_MEMBERS = 12;
const MAX_OPEN_QUIZZES = 5;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (d) => (d ? new Date(d).toISOString() : null);
const randHex = (n) => crypto.randomBytes(n).toString('hex');

// best-effort per-instance rate limit for create/join
const hits = new Map();
function rateLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const t = Date.now();
  const list = (hits.get(ip) || []).filter((x) => t - x < 600000);
  list.push(t);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  if (list.length > 120) throw new HttpError(429, 'rate_limited', 'Too many requests, please slow down and try again in a few minutes.');
}

async function readBody(req) {
  let b;
  try {
    b = req.body; // Vercel's lazy body parser throws on invalid JSON
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
  }
  if (b === undefined || b === null) {
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX_BODY) throw new HttpError(400, 'body_too_large', 'Request body is too large (64KB max).');
      chunks.push(ch);
    }
    b = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    if (b.length > MAX_BODY) throw new HttpError(400, 'body_too_large', 'Request body is too large (64KB max).');
    if (!b.trim()) return {};
    try {
      b = JSON.parse(b);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body is not valid JSON.');
    }
  } else if (JSON.stringify(b).length > MAX_BODY) {
    throw new HttpError(400, 'body_too_large', 'Request body is too large (64KB max).');
  }
  return b;
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

const KEY_RE = /^[A-Za-z0-9]{16,128}$/;
function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9]{16,128})$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : null;
}

/** Resolves the member for a token; if `code` given, checks the group exists and the member belongs to it. */
async function authMember(store, token, code) {
  const member = token ? await store.getMemberByTokenHash(sha256(token)) : null;
  if (!member) throw new HttpError(401, 'bad_token', 'Your token was not accepted. Join the group again.');
  if (code) {
    if (!(await store.getGroup(code))) throw new HttpError(404, 'code_not_found', 'No Quizzard group with that code.');
    if (member.group_code !== code) throw new HttpError(401, 'bad_token', 'Your token is not valid for this group.');
  }
  return member;
}

/** The member a request acts for: the caller, or (host only) the member named in body.as. */
function actingFor(me, members, as) {
  if (as === undefined || as === null || as === '') return me;
  if (!me.host) throw new HttpError(403, 'not_host', 'Only the group host can act for another member.');
  const name = L.sanitizeName(as, 24, 'as').toLowerCase();
  const m = members.find((x) => x.name.toLowerCase() === name);
  if (!m) throw new HttpError(404, 'unknown_member', `No one called "${as}" is in this group.`);
  return m;
}

async function quizFor(store, me, id) {
  const quiz = await store.getQuiz(id);
  if (!quiz || quiz.group_code !== me.group_code) throw new HttpError(404, 'quiz_not_found', 'No such quiz in this group.');
  return quiz;
}

function quizSummary(quiz, members, now = new Date()) {
  return {
    id: quiz.id, topic: quiz.topic, course: quiz.course || null, start_at: iso(quiz.start_at), ends_at: iso(L.endsAt(quiz)),
    duration_min: quiz.duration_min, questions: quiz.questions.length, phase: L.phase(quiz, now),
    created_by: (members.find((m) => m.member_id === quiz.created_by) || {}).name || 'a former member',
    checkins: L.checkinView(quiz, members),
  };
}

/** Scores a closed quiz once and stores the results; later calls return the stored copy. */
async function finalize(store, quiz, members) {
  if (quiz.results) return quiz.results;
  const results = L.scoreQuiz(quiz, members);
  await store.setQuizIfAbsent(quiz.id, 'results', results);
  const fresh = await store.getQuiz(quiz.id);
  return fresh.results || results;
}

async function addMember(store, code, name, { host = false, claimed = true } = {}) {
  const token = claimed ? randHex(32) : null;
  const m = { group_code: code, member_id: randHex(4), name, token_hash: token ? sha256(token) : null, joined_at: new Date(), host };
  try {
    await store.insertMember(m);
  } catch (e) {
    if (e.dup) return addMember(store, code, name, { host, claimed });
    throw e;
  }
  return { member: m, token };
}

function newCode() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += L.CODE_ALPHABET[bytes[i] % L.CODE_ALPHABET.length];
  return s;
}

function groupView(group, members) {
  return {
    code: group.code, name: group.name, tz: group.tz, budget: group.budget,
    members: members.map((m) => ({ member_id: m.member_id, name: m.name, host: !!m.host, claimed: !!m.token_hash })),
  };
}

// ---------- handlers ----------
const H = {
  async createGroup(ctx) {
    rateLimit(ctx.req);
    const name = L.sanitizeName(ctx.body.name, 40, 'name');
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    const tz = L.sanitizeTz(ctx.body.tz);
    const budget = L.sanitizeBudget(ctx.body.budget);
    const viewKey = randHex(16);
    let code;
    for (let i = 0; i < 10 && !code; i++) {
      const c = newCode();
      try {
        await ctx.store.createGroup({ code: c, name, tz, budget, view_key_hash: sha256(viewKey), created_at: new Date() });
        code = c;
      } catch (e) {
        if (!e.dup) throw e;
      }
    }
    if (!code) throw new HttpError(500, 'code_exhausted', 'Could not allocate a group code, try again.');
    const { member, token } = await addMember(ctx.store, code, memberName, { host: true });
    return [200, { code, name, tz, budget, member_id: member.member_id, host: true, token, view_key: viewKey }];
  },

  async join(ctx, code) {
    rateLimit(ctx.req);
    const memberName = L.sanitizeName(ctx.body.member_name, 24, 'member_name');
    const group = await ctx.store.getGroup(code);
    if (!group) throw new HttpError(404, 'code_not_found', 'No Quizzard group with that code.');
    const members = await ctx.store.listMembers(code);
    const same = members.find((m) => m.name.toLowerCase() === memberName.toLowerCase());
    if (same && same.token_hash) throw new HttpError(409, 'name_taken', 'Someone in this group already uses that name. Pick another.');
    if (same) {
      // the host added this name from the group chat; joining claims it
      const token = randHex(32);
      await ctx.store.setMember(code, same.member_id, { token_hash: sha256(token) });
      return [200, { code, name: group.name, tz: group.tz, budget: group.budget, member_id: same.member_id, host: !!same.host, token }];
    }
    if (members.length >= MAX_MEMBERS) throw new HttpError(409, 'group_full', `This group already has ${MAX_MEMBERS} members.`);
    const { member, token } = await addMember(ctx.store, code, memberName);
    return [200, { code, name: group.name, tz: group.tz, budget: group.budget, member_id: member.member_id, host: false, token }];
  },

  async addByHost(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    if (!me.host) throw new HttpError(403, 'not_host', 'Only the group host can add people by name.');
    const name = L.sanitizeName(ctx.body.name, 24, 'name');
    const members = await ctx.store.listMembers(code);
    if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'name_taken', 'Someone in this group already uses that name.');
    if (members.length >= MAX_MEMBERS) throw new HttpError(409, 'group_full', `This group already has ${MAX_MEMBERS} members.`);
    const { member } = await addMember(ctx.store, code, name, { claimed: false });
    return [200, { member_id: member.member_id, name }];
  },

  async getGroup(ctx, code) {
    await authMember(ctx.store, ctx.token, code);
    const [group, members, quizzes] = await Promise.all([ctx.store.getGroup(code), ctx.store.listMembers(code), ctx.store.listQuizzes(code)]);
    const now = new Date();
    const open = quizzes.filter((q) => ['scheduled', 'live'].includes(L.phase(q, now)));
    const recent = quizzes.filter((q) => L.phase(q, now) === 'closed').slice(-3);
    return [200, { ...groupView(group, members), quizzes: [...recent, ...open].map((q) => quizSummary(q, members, now)) }];
  },

  async settings(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    if (!me.host) throw new HttpError(403, 'not_host', 'Only the group host can change settings.');
    const set = {};
    if (ctx.body.budget !== undefined) set.budget = L.sanitizeBudget(ctx.body.budget);
    if (ctx.body.tz !== undefined) set.tz = L.sanitizeTz(ctx.body.tz);
    if (!Object.keys(set).length) throw new L.InputError('nothing to change: send budget or tz.');
    await ctx.store.setGroup(code, set);
    const [group, members] = await Promise.all([ctx.store.getGroup(code), ctx.store.listMembers(code)]);
    return [200, groupView(group, members)];
  },

  async leave(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const id = me.member_id;
    await ctx.store.deleteMember(code, id);
    await ctx.store.unsetQuizPaths(code, [`checkins.${id}`, `served.${id}`, `answers.${id}`]);
    const rest = await ctx.store.listMembers(code);
    if (rest.length === 0 || rest.every((m) => !m.token_hash)) await ctx.store.deleteGroupAll(code);
    else if (me.host && !rest.some((m) => m.host)) {
      const next = rest.find((m) => m.token_hash);
      await ctx.store.setMember(code, next.member_id, { host: true });
    }
    return [200, { ok: true, deleted: true }];
  },

  async createQuiz(ctx, code) {
    const me = await authMember(ctx.store, ctx.token, code);
    const input = L.sanitizeQuizInput(ctx.body);
    const [members, quizzes] = await Promise.all([ctx.store.listMembers(code), ctx.store.listQuizzes(code)]);
    const now = new Date();
    if (quizzes.filter((q) => ['scheduled', 'live'].includes(L.phase(q, now))).length >= MAX_OPEN_QUIZZES) {
      throw new HttpError(409, 'too_many_quizzes', `This group already has ${MAX_OPEN_QUIZZES} quizzes coming up. Cancel one first.`);
    }
    const quiz = {
      id: randHex(4), group_code: code, created_by: me.member_id, topic: input.topic, start_at: input.start_at,
      duration_min: input.duration_min, questions: input.questions, status: 'scheduled', checkins: {}, served: {}, answers: {}, created_at: now,
    };
    if (input.course) quiz.course = input.course;
    await ctx.store.insertQuiz(quiz);
    return [200, quizSummary(quiz, members, now)];
  },

  async getQuiz(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    return [200, quizSummary(quiz, await ctx.store.listMembers(me.group_code))];
  },

  async cancel(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    if (quiz.created_by !== me.member_id && !me.host) throw new HttpError(403, 'not_allowed', 'Only whoever set up this quiz, or the host, can cancel it.');
    if (L.phase(quiz) !== 'scheduled') throw new HttpError(409, 'quiz_started', 'This quiz has already started.');
    await ctx.store.setQuiz(id, { status: 'cancelled' });
    return [200, { ok: true }];
  },

  async checkin(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    const members = await ctx.store.listMembers(me.group_code);
    const who = actingFor(me, members, ctx.body.as);
    const status = ctx.body.status;
    if (status !== 'ready' && status !== 'excused') throw new L.InputError('status must be ready or excused.');
    const now = new Date();
    const ph = L.phase(quiz, now);
    if (ph === 'cancelled') throw new HttpError(409, 'quiz_cancelled', 'This quiz was cancelled.');
    const start = new Date(quiz.start_at).getTime();
    if (status === 'excused' && ph !== 'scheduled') throw new HttpError(409, 'too_late', 'Excuses close when the quiz starts.');
    if (status === 'ready' && now.getTime() > start + L.GRACE_MS) throw new HttpError(409, 'too_late', 'Check-in closed 2 minutes after the start. This round counts as a DQ.');
    const prev = (quiz.checkins || {})[who.member_id];
    if (prev && prev.status === 'ready' && status === 'excused') throw new HttpError(409, 'already_ready', `${who.name} is already checked in.`);
    const late = status === 'ready' && now.getTime() >= start;
    await ctx.store.setQuiz(id, { [`checkins.${who.member_id}`]: { status, at: now, late } });
    const fresh = await ctx.store.getQuiz(id);
    return [200, { member: who.name, status, late, quiz: quizSummary(fresh, members, now) }];
  },

  async question(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    const members = await ctx.store.listMembers(me.group_code);
    const who = actingFor(me, members, ctx.body.as);
    const now = new Date();
    const ph = L.phase(quiz, now);
    if (ph === 'scheduled') throw new HttpError(409, 'not_started', 'The quiz has not started yet.');
    if (ph !== 'live') throw new HttpError(409, 'quiz_closed', 'The quiz is over.');
    const c = (quiz.checkins || {})[who.member_id];
    if (!c || c.status !== 'ready') throw new HttpError(409, 'not_checked_in', `${who.name} did not check in for this quiz.`);
    const n = Number(ctx.body.n);
    if (!Number.isInteger(n) || n < 1 || n > quiz.questions.length) throw new L.InputError(`n must be 1 to ${quiz.questions.length}.`);
    if (c.late && n === 1) throw new HttpError(409, 'forfeited', 'Checked in late, so question 1 is forfeited. Start at question 2.');
    await ctx.store.setQuizIfAbsent(id, `served.${who.member_id}.${n}`, now);
    const q = quiz.questions[n - 1];
    const answered = !!((quiz.answers || {})[who.member_id] || {})[String(n)];
    return [200, { n, total: quiz.questions.length, q: q.q, choices: q.choices.map((t, i) => ({ letter: L.LETTERS[i], text: t })), answered, ends_at: iso(L.endsAt(quiz)) }];
  },

  async answer(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    const members = await ctx.store.listMembers(me.group_code);
    const who = actingFor(me, members, ctx.body.as);
    const now = new Date();
    if (L.phase(quiz, now) !== 'live') throw new HttpError(409, 'quiz_closed', L.phase(quiz, now) === 'scheduled' ? 'The quiz has not started yet.' : 'Time is up, answers are closed.');
    const n = Number(ctx.body.n);
    if (!Number.isInteger(n) || n < 1 || n > quiz.questions.length) throw new L.InputError(`n must be 1 to ${quiz.questions.length}.`);
    if (!((quiz.served || {})[who.member_id] || {})[String(n)]) throw new HttpError(409, 'not_served', `Question ${n} has not been sent to ${who.name} yet.`);
    const choice = typeof ctx.body.choice === 'string' ? L.LETTERS.indexOf(ctx.body.choice.trim().toUpperCase()) : Number(ctx.body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= quiz.questions[n - 1].choices.length) throw new L.InputError('choice must be one of the letters shown.');
    const ok = await ctx.store.setQuizIfAbsent(id, `answers.${who.member_id}.${n}`, { choice, at: now });
    if (!ok) throw new HttpError(409, 'already_answered', `Question ${n} is already answered. Answers are final.`);
    const fresh = await ctx.store.getQuiz(id);
    const done = Object.keys((fresh.answers || {})[who.member_id] || {}).length;
    return [200, { ok: true, n, answered: done, total: quiz.questions.length, ends_at: iso(L.endsAt(quiz)) }];
  },

  async results(ctx, id) {
    const me = await authMember(ctx.store, ctx.token);
    const quiz = await quizFor(ctx.store, me, id);
    const ph = L.phase(quiz);
    if (ph === 'cancelled') throw new HttpError(409, 'quiz_cancelled', 'This quiz was cancelled.');
    if (ph !== 'closed') throw new HttpError(409, 'not_closed', 'Results come out when the quiz ends.');
    return [200, await finalize(ctx.store, quiz, await ctx.store.listMembers(me.group_code))];
  },

  async scorecard(ctx, code) {
    const viewKey = String(ctx.req.headers['x-view-key'] || '');
    const group = await ctx.store.getGroup(code);
    if (KEY_RE.test(viewKey) && group && sha256(viewKey) === group.view_key_hash) {
      // read-only scorecard link
    } else {
      await authMember(ctx.store, ctx.token, code);
    }
    const month = ctx.query.get('month') || L.monthOf(new Date(), group.tz);
    if (!L.isMonth(month)) throw new L.InputError('month must look like 2026-10.');
    const [members, quizzes] = await Promise.all([ctx.store.listMembers(code), ctx.store.listQuizzes(code)]);
    const now = new Date();
    const closedIn = async (m) => {
      const out = [];
      for (const q of quizzes) if (L.phase(q, now) === 'closed' && L.monthOf(q.start_at, group.tz) === m) out.push(await finalize(ctx.store, q, members));
      return out;
    };
    const card = L.buildScorecard({ group, members, month, results: await closedIn(month), prevResults: await closedIn(L.prevMonth(month)) });
    return [200, card];
  },
};

function route(method, parts) {
  const [a, b, c] = parts;
  if (a === 'groups') {
    if (parts.length === 1 && method === 'POST') return [H.createGroup];
    if (parts.length === 2 && method === 'GET') return [H.getGroup, b];
    if (parts.length === 3) {
      if (c === 'join' && method === 'POST') return [H.join, b];
      if (c === 'members' && method === 'POST') return [H.addByHost, b];
      if (c === 'settings' && method === 'POST') return [H.settings, b];
      if (c === 'leave' && method === 'POST') return [H.leave, b];
      if (c === 'quizzes' && method === 'POST') return [H.createQuiz, b];
      if (c === 'scorecard' && method === 'GET') return [H.scorecard, b];
    }
  }
  if (a === 'quizzes' && b) {
    if (parts.length === 2 && method === 'GET') return [H.getQuiz, b];
    if (parts.length === 3 && method === 'POST') {
      if (c === 'checkin') return [H.checkin, b];
      if (c === 'question') return [H.question, b];
      if (c === 'answer') return [H.answer, b];
      if (c === 'cancel') return [H.cancel, b];
    }
    if (parts.length === 3 && c === 'results' && method === 'GET') return [H.results, b];
  }
  return null;
}

export function createHandler(getStoreFn) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-View-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/^\/api(?=\/|$)/, '');
      const parts = path.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      if (parts[0] === 'groups' && parts[1]) parts[1] = parts[1].toUpperCase();
      const r = route(req.method, parts);
      if (!r) throw new HttpError(404, 'not_found', 'No such endpoint.');
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
      const ctx = { req, body, query: url.searchParams, token: bearer(req), store: await getStoreFn() };
      const [status, data] = await r[0](ctx, ...r.slice(1));
      return send(res, status, data);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      if (e instanceof L.InputError) return send(res, 400, { error: e.message, code: 'bad_input' });
      if (e instanceof URIError) return send(res, 400, { error: 'Bad URL.', code: 'bad_input' });
      console.error('quizzard relay error:', e && e.message);
      return send(res, 500, { error: 'Something went wrong on the server. Please try again.', code: 'server_error' });
    }
  };
}

export default createHandler(getStore);
