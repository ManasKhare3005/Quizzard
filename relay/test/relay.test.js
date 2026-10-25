import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../api/index.js';
import { createMemoryStore } from '../lib/db.js';

const T0 = Date.parse('2026-10-20T12:00:00Z');
let store, handler;

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  store = createMemoryStore();
  handler = createHandler(async () => store);
});
afterEach(() => mock.timers.reset());

const advance = (ms) => mock.timers.tick(ms);
const at = (iso) => mock.timers.setTime(Date.parse(iso));

async function call(method, path, { body, token, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: path, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, socket: {} });
  const res = {
    statusCode: 0, headers: {}, data: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(d) { this.data = d || ''; },
  };
  await handler(req, res);
  return { status: res.statusCode, json: res.data ? JSON.parse(res.data) : null };
}

const QUESTIONS = [
  { q: 'Dropout mainly reduces...', choices: ['Overfitting', 'Bias', 'Latency', 'Memory'], answer: 0, explain: 'Random units are dropped so they cannot co-adapt.', source: 'Lecture 11, slide 14' },
  { q: 'ReLU gradient for x < 0?', choices: ['1', '0', 'x', '-1'], answer: 1, explain: 'ReLU is flat below zero.', source: 'Lecture 9, slide 6' },
  { q: 'Backprop applies the...', choices: ['Chain rule', 'Bayes rule', 'Power rule'], answer: 0, explain: 'Gradients flow back through the chain rule.', source: 'Lecture 10, slide 3' },
];

async function seed() {
  const host = (await call('POST', '/api/groups', { body: { name: 'Night Owls', member_name: 'Manav', budget: 25 } })).json;
  const reya = (await call('POST', `/api/groups/${host.code}/join`, { body: { member_name: 'Reya' } })).json;
  const jay = (await call('POST', `/api/groups/${host.code}/join`, { body: { member_name: 'Jay' } })).json;
  return { code: host.code, host, reya, jay };
}

async function newQuiz(s, startIso = '2026-10-20T20:00:00-07:00', token = s.reya.token) {
  const r = await call('POST', `/api/groups/${s.code}/quizzes`, { token, body: { topic: 'Backprop', course: 'cse576', start_at: startIso, duration_min: 10, questions: QUESTIONS } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

async function play(s, quizId, token, picks, { as, gapMs = 3000 } = {}) {
  for (const [n, choice] of picks) {
    const q = await call('POST', `/api/quizzes/${quizId}/question`, { token, body: { n, as } });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    advance(gapMs);
    const a = await call('POST', `/api/quizzes/${quizId}/answer`, { token, body: { n, choice, as } });
    assert.equal(a.status, 200, JSON.stringify(a.json));
  }
}

test('create, join and group view hide tokens and normalize the course', async () => {
  const s = await seed();
  assert.match(s.code, /^[A-Z2-9]{6}$/);
  assert.ok(s.host.host && s.host.view_key);
  const g = await call('GET', `/api/groups/${s.code}`, { token: s.jay.token });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.members.map((m) => m.name), ['Manav', 'Reya', 'Jay']);
  assert.ok(!JSON.stringify(g.json).includes(s.jay.token));
  const q = await newQuiz(s);
  assert.equal(q.course, 'CSE 576');
  assert.equal(q.phase, 'scheduled');
  assert.ok(!JSON.stringify(q).includes('"answer"'), 'summary must not leak answers');
});

test('a full round: check-ins, late join, DQ, private answers, scoring', async () => {
  const s = await seed();
  const quiz = await newQuiz(s);
  at('2026-10-21T02:30:00Z'); // 7:30 pm Phoenix, 30 min before
  for (const t of [s.host.token, s.reya.token]) assert.equal((await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: t, body: { status: 'ready' } })).status, 200);
  let view = (await call('GET', `/api/quizzes/${quiz.id}`, { token: s.host.token })).json;
  assert.deepEqual(view.checkins.waiting, ['Jay']);

  // nobody can see a question before the start
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/question`, { token: s.reya.token, body: { n: 1 } })).json.code, 'not_started');

  at('2026-10-21T03:00:00Z');
  await play(s, quiz.id, s.reya.token, [[1, 'A'], [2, 'B'], [3, 'A']], { gapMs: 0 }); // all right, instant
  await play(s, quiz.id, s.host.token, [[1, 'A'], [2, 'C'], [3, 'A']], { gapMs: 15000 });

  // answers are final
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/answer`, { token: s.reya.token, body: { n: 1, choice: 'B' } })).json.code, 'already_answered');
  // results are hidden while live
  assert.equal((await call('GET', `/api/quizzes/${quiz.id}/results`, { token: s.reya.token })).json.code, 'not_closed');

  at('2026-10-21T03:11:00Z');
  const r = (await call('GET', `/api/quizzes/${quiz.id}/results`, { token: s.jay.token })).json;
  const by = Object.fromEntries(r.players.map((p) => [p.name, p]));
  // Reya: 3 x (10 + 5 speed) + 2 streak bonuses of 2 = 49
  assert.equal(by.Reya.points, 49);
  assert.equal(by.Reya.rank, 1);
  // Manav: q1 10 + round(5*(1-15/30))=3 -> 13, q2 wrong, q3 13 again, no streak = 26
  assert.equal(by.Manav.points, 26);
  assert.equal(by.Jay.status, 'dq');
  assert.equal(by.Jay.points, 0);
  assert.equal(r.most_missed.n, 2);
  assert.equal(r.most_missed.source, 'Lecture 9, slide 6');
  assert.deepEqual(r.winner_ids, [s.reya.member_id]);
});

test('late check-in forfeits question 1; excused is no penalty; check-in closes after grace', async () => {
  const s = await seed();
  const quiz = await newQuiz(s);
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.jay.token, body: { status: 'excused' } })).status, 200);
  at('2026-10-21T03:01:00Z');
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.jay.token, body: { status: 'excused' } })).json.code, 'too_late');
  const late = await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.reya.token, body: { status: 'ready' } });
  assert.equal(late.json.late, true);
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/question`, { token: s.reya.token, body: { n: 1 } })).json.code, 'forfeited');
  at('2026-10-21T03:02:30Z');
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.host.token, body: { status: 'ready' } })).json.code, 'too_late');
  at('2026-10-21T03:20:00Z');
  const r = (await call('GET', `/api/quizzes/${quiz.id}/results`, { token: s.jay.token })).json;
  const by = Object.fromEntries(r.players.map((p) => [p.name, p]));
  assert.equal(by.Jay.status, 'excused');
  assert.equal(by.Jay.rank, null);
  assert.equal(by.Reya.status, 'late');
  assert.equal(by.Manav.status, 'dq');
});

test('host can add a friend by name and act for them; others cannot', async () => {
  const s = await seed();
  const add = await call('POST', `/api/groups/${s.code}/members`, { token: s.host.token, body: { name: 'Sam' } });
  assert.equal(add.status, 200);
  assert.equal((await call('POST', `/api/groups/${s.code}/members`, { token: s.reya.token, body: { name: 'Kai' } })).json.code, 'not_host');
  const quiz = await newQuiz(s);
  assert.equal((await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.reya.token, body: { status: 'ready', as: 'Sam' } })).json.code, 'not_host');
  const ok = await call('POST', `/api/quizzes/${quiz.id}/checkin`, { token: s.host.token, body: { status: 'ready', as: 'sam' } });
  assert.equal(ok.json.member, 'Sam');
  at('2026-10-21T03:00:00Z');
  await play(s, quiz.id, s.host.token, [[1, 'A']], { as: 'Sam' });
  // Sam later claims the name from their own phone
  const claim = await call('POST', `/api/groups/${s.code}/join`, { body: { member_name: 'Sam' } });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.member_id, add.json.member_id);
  assert.equal((await call('POST', `/api/groups/${s.code}/join`, { body: { member_name: 'Sam' } })).json.code, 'name_taken');
});

test('monthly scorecard: standings, MVP, last place with budget, most improved, view key', async () => {
  const s = await seed();
  // September round: Jay weak
  at('2026-09-10T12:00:00Z');
  const sep = await newQuiz(s, '2026-09-10T20:00:00-07:00');
  for (const t of [s.host.token, s.reya.token, s.jay.token]) await call('POST', `/api/quizzes/${sep.id}/checkin`, { token: t, body: { status: 'ready' } });
  at('2026-09-11T03:00:00Z');
  await play(s, sep.id, s.jay.token, [[1, 'B'], [2, 'A'], [3, 'A']], { gapMs: 0 });
  await play(s, sep.id, s.reya.token, [[1, 'A'], [2, 'B'], [3, 'A']], { gapMs: 0 });
  await play(s, sep.id, s.host.token, [[1, 'A'], [2, 'B'], [3, 'B']], { gapMs: 0 });

  // October round: Jay perfect
  at('2026-10-20T12:00:00Z');
  const oct = await newQuiz(s);
  for (const t of [s.host.token, s.reya.token, s.jay.token]) await call('POST', `/api/quizzes/${oct.id}/checkin`, { token: t, body: { status: 'ready' } });
  at('2026-10-21T03:00:00Z');
  await play(s, oct.id, s.jay.token, [[1, 'A'], [2, 'B'], [3, 'A']], { gapMs: 0 });
  await play(s, oct.id, s.reya.token, [[1, 'A'], [2, 'C'], [3, 'A']], { gapMs: 0 });
  await play(s, oct.id, s.host.token, [[1, 'B'], [2, 'C'], [3, 'B']], { gapMs: 0 });

  at('2026-10-31T20:00:00Z');
  const card = (await call('GET', `/api/groups/${s.code}/scorecard?month=2026-10`, { token: s.reya.token })).json;
  assert.equal(card.label, 'October 2026');
  assert.equal(card.rounds, 1);
  assert.deepEqual(card.mvp, ['Jay']);
  assert.deepEqual(card.standings.map((r) => r.name), ['Jay', 'Reya', 'Manav']);
  assert.deepEqual(card.last, { names: ['Manav'], tie: false, budget: 25 });
  assert.equal(card.most_improved.name, 'Jay');

  const viaKey = await call('GET', `/api/groups/${s.code}/scorecard?month=2026-10`, { headers: { 'x-view-key': s.host.view_key } });
  assert.equal(viaKey.status, 200);
  const bad = await call('GET', `/api/groups/${s.code}/scorecard`, { headers: { 'x-view-key': 'f'.repeat(32) } });
  assert.equal(bad.status, 401);
  // the view key cannot do anything else
  assert.equal((await call('GET', `/api/groups/${s.code}`, { token: s.host.view_key })).status, 401);
});

test('input validation and leaving', async () => {
  const s = await seed();
  const bad = await call('POST', `/api/groups/${s.code}/quizzes`, { token: s.reya.token, body: { topic: 'X', start_at: '2026-10-20T20:00:00', questions: QUESTIONS } });
  assert.equal(bad.json.code, 'bad_input');
  const past = await call('POST', `/api/groups/${s.code}/quizzes`, { token: s.reya.token, body: { topic: 'X', start_at: '2026-10-19T20:00:00Z', questions: QUESTIONS } });
  assert.match(past.json.error, /past/);
  const two = await call('POST', `/api/groups/${s.code}/quizzes`, { token: s.reya.token, body: { topic: 'X', start_at: '2026-10-21T20:00:00Z', questions: QUESTIONS.slice(0, 2) } });
  assert.match(two.json.error, /3 to 10/);
  assert.equal((await call('POST', '/api/groups', { body: { name: 'A', member_name: 'B', tz: 'Mars/Base' } })).json.code, 'bad_input');

  assert.equal((await call('POST', `/api/groups/${s.code}/leave`, { token: s.host.token })).status, 200);
  const g = (await call('GET', `/api/groups/${s.code}`, { token: s.reya.token })).json;
  assert.equal(g.members.find((m) => m.name === 'Reya').host, true, 'host role passes on');
  await call('POST', `/api/groups/${s.code}/leave`, { token: s.reya.token });
  await call('POST', `/api/groups/${s.code}/leave`, { token: s.jay.token });
  assert.equal(await store.getGroup(s.code), null, 'empty group is deleted');
});
