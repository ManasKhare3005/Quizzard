// Demo data for local recordings: one group with a month of finished rounds, inserted straight
// into a store. Scores are still computed by the real scoring code from the stored answers.
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const DEMO = { code: 'NGHT26', viewKey: 'demoview0123456789abcdef', month: '2026-10' };

const PLAYERS = ['Manav', 'Reya', 'Jay', 'Sam'];
const Q = (q, choices, answer) => ({ q, choices, answer, explain: '', source: '' });
const ROUNDS = [
  // [topic, course, start (UTC), per-player [choices], per-player answer gap seconds; null = DQ, 'x' = excused]
  ['Backprop', 'CSE 576', '2026-10-03T03:00:00Z', { Manav: [0, 1, 0, 2, 1], Reya: [0, 1, 0, 1, 1], Jay: [0, 1, 0, 1, 1], Sam: [1, 1, 2, 1, 0] }, { Manav: 12, Reya: 6, Jay: 3, Sam: 20 }],
  ['CNNs', 'CSE 576', '2026-10-10T03:00:00Z', { Manav: [0, 0, 1, 1, 2], Reya: [0, 0, 1, 1, 2], Jay: [0, 0, 1, 2, 2], Sam: null }, { Manav: 9, Reya: 5, Jay: 4 }],
  ['Eigenvalues', 'MAT 343', '2026-10-17T03:00:00Z', { Manav: [1, 0, 2, 0, 1], Reya: [1, 0, 2, 0, 0], Jay: [1, 0, 2, 0, 1], Sam: [1, 2, 2, 0, 0] }, { Manav: 8, Reya: 10, Jay: 2, Sam: 14 }],
  ['Attention', 'CSE 576', '2026-10-24T03:00:00Z', { Manav: 'x', Reya: [2, 1, 0, 0, 1], Jay: [2, 1, 0, 0, 1], Sam: [2, 0, 0, 1, 1] }, { Reya: 7, Jay: 3, Sam: 18 }],
];
const KEY = [[0, 1, 0, 1, 1], [0, 0, 1, 1, 2], [1, 0, 2, 0, 1], [2, 1, 0, 0, 1]];

export async function seedDemo(store) {
  await store.createGroup({ code: DEMO.code, name: 'Night Owls', tz: 'America/Phoenix', budget: 25, view_key_hash: sha256(DEMO.viewKey), created_at: new Date('2026-10-01T00:00:00Z') });
  const ids = {};
  for (const [i, name] of PLAYERS.entries()) {
    ids[name] = `demo000${i}`;
    await store.insertMember({ group_code: DEMO.code, member_id: ids[name], name, token_hash: sha256(`demotoken${name}0000000`), joined_at: new Date('2026-10-01T00:00:00Z'), host: i === 0 });
  }
  for (const [r, [topic, course, start, picks, gaps]] of ROUNDS.entries()) {
    const quiz = {
      id: `demoq00${r}`, group_code: DEMO.code, created_by: ids.Reya, topic, course, start_at: new Date(start), duration_min: 10, status: 'scheduled',
      questions: KEY[r].map((a, n) => Q(`Question ${n + 1}`, ['A', 'B', 'C'], a)), checkins: {}, served: {}, answers: {}, created_at: new Date(start),
    };
    for (const name of PLAYERS) {
      const p = picks[name];
      if (p === null || p === undefined) continue;
      const id = ids[name];
      quiz.checkins[id] = { status: p === 'x' ? 'excused' : 'ready', at: new Date(start), late: false };
      if (p === 'x') continue;
      quiz.served[id] = {};
      quiz.answers[id] = {};
      p.forEach((choice, n) => {
        const served = new Date(new Date(start).getTime() + n * 60000);
        quiz.served[id][n + 1] = served;
        quiz.answers[id][n + 1] = { choice, at: new Date(served.getTime() + gaps[name] * 1000) };
      });
    }
    await store.insertQuiz(quiz);
  }
  return DEMO;
}
