// Storage for the Quizzard relay. createMongoStore and createMemoryStore expose the same async
// interface, so handlers can be tested without a database.

const NO_ID = { projection: { _id: 0 } };

function dupAware(fn) {
  return async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e && e.code === 11000) {
        const err = new Error('duplicate');
        err.dup = true;
        throw err;
      }
      throw e;
    }
  };
}

export function createMongoStore(db) {
  const c = { groups: db.collection('groups'), members: db.collection('members'), quizzes: db.collection('quizzes') };
  return {
    createGroup: dupAware((g) => c.groups.insertOne({ ...g })),
    getGroup: (code) => c.groups.findOne({ code }, NO_ID),
    async setGroup(code, set) {
      await c.groups.updateOne({ code }, { $set: set });
    },
    async deleteGroupAll(code) {
      await Promise.all([c.groups.deleteMany({ code }), c.members.deleteMany({ group_code: code }), c.quizzes.deleteMany({ group_code: code })]);
    },
    listMembers: (code) => c.members.find({ group_code: code }, NO_ID).sort({ joined_at: 1, member_id: 1 }).toArray(),
    getMemberByTokenHash: (hash) => c.members.findOne({ token_hash: hash }, NO_ID),
    insertMember: dupAware((m) => c.members.insertOne({ ...m })),
    async setMember(code, id, set) {
      await c.members.updateOne({ group_code: code, member_id: id }, { $set: set });
    },
    async deleteMember(code, id) {
      await c.members.deleteOne({ group_code: code, member_id: id });
    },
    insertQuiz: (q) => c.quizzes.insertOne({ ...q }),
    getQuiz: (id) => c.quizzes.findOne({ id }, NO_ID),
    listQuizzes: (code) => c.quizzes.find({ group_code: code }, NO_ID).sort({ start_at: 1 }).toArray(),
    async setQuiz(id, set) {
      await c.quizzes.updateOne({ id }, { $set: set });
    },
    /** Sets `path` only if it is not set yet. Returns true when this call set it. */
    async setQuizIfAbsent(id, path, value) {
      const r = await c.quizzes.updateOne({ id, [path]: { $exists: false } }, { $set: { [path]: value } });
      return r.modifiedCount === 1;
    },
    async unsetQuizPaths(code, paths) {
      if (!paths.length) return;
      await c.quizzes.updateMany({ group_code: code }, { $unset: Object.fromEntries(paths.map((p) => [p, ''])) });
    },
  };
}

// ---------- in-memory store (tests and local runs) ----------
const clone = (v) => (v === undefined ? v : structuredClone(v));
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = value;
}
function unsetPath(obj, path) {
  const keys = path.split('.');
  const parent = getPath(obj, keys.slice(0, -1).join('.')) ?? (keys.length === 1 ? obj : undefined);
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
}

export function createMemoryStore() {
  const groups = new Map();
  const members = [];
  const quizzes = new Map();
  const dup = () => Object.assign(new Error('duplicate'), { dup: true });
  return {
    async createGroup(g) {
      if (groups.has(g.code)) throw dup();
      groups.set(g.code, clone(g));
    },
    getGroup: async (code) => clone(groups.get(code)) || null,
    async setGroup(code, set) {
      const g = groups.get(code);
      if (g) Object.assign(g, clone(set));
    },
    async deleteGroupAll(code) {
      groups.delete(code);
      for (let i = members.length - 1; i >= 0; i--) if (members[i].group_code === code) members.splice(i, 1);
      for (const [id, q] of quizzes) if (q.group_code === code) quizzes.delete(id);
    },
    listMembers: async (code) => clone(members.filter((m) => m.group_code === code)),
    getMemberByTokenHash: async (hash) => clone(members.find((m) => hash && m.token_hash === hash)) || null,
    async insertMember(m) {
      if (members.some((x) => x.group_code === m.group_code && x.member_id === m.member_id)) throw dup();
      members.push(clone(m));
    },
    async setMember(code, id, set) {
      const m = members.find((x) => x.group_code === code && x.member_id === id);
      if (m) Object.assign(m, clone(set));
    },
    async deleteMember(code, id) {
      const i = members.findIndex((x) => x.group_code === code && x.member_id === id);
      if (i >= 0) members.splice(i, 1);
    },
    async insertQuiz(q) {
      quizzes.set(q.id, clone(q));
    },
    getQuiz: async (id) => clone(quizzes.get(id)) || null,
    listQuizzes: async (code) => clone([...quizzes.values()].filter((q) => q.group_code === code).sort((a, b) => new Date(a.start_at) - new Date(b.start_at))),
    async setQuiz(id, set) {
      const q = quizzes.get(id);
      if (q) for (const [k, v] of Object.entries(set)) setPath(q, k, clone(v));
    },
    async setQuizIfAbsent(id, path, value) {
      const q = quizzes.get(id);
      if (!q || getPath(q, path) !== undefined) return false;
      setPath(q, path, clone(value));
      return true;
    },
    async unsetQuizPaths(code, paths) {
      for (const q of quizzes.values()) if (q.group_code === code) for (const p of paths) unsetPath(q, p);
    },
  };
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('groups').createIndex({ code: 1 }, { unique: true }),
    db.collection('members').createIndex({ group_code: 1, member_id: 1 }, { unique: true }),
    db.collection('members').createIndex({ token_hash: 1 }),
    db.collection('quizzes').createIndex({ id: 1 }, { unique: true }),
    db.collection('quizzes').createIndex({ group_code: 1, start_at: 1 }),
    // bound growth: quizzes expire after 400 days, enough for last month's "most improved"
    db.collection('quizzes').createIndex({ created_at: 1 }, { expireAfterSeconds: 400 * 86400 }),
  ]);
}

/** Cached across invocations on globalThis; indexes ensured once per cold start. */
export async function getStore() {
  if (!globalThis.__quizzardStore) {
    globalThis.__quizzardStore = (async () => {
      const uri = (process.env.MONGODB_URI || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
      if (!uri) throw new Error('MONGODB_URI is not set');
      if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://');
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000 });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'quizzard');
      await ensureIndexes(db);
      return createMongoStore(db);
    })().catch((e) => {
      globalThis.__quizzardStore = null;
      throw e;
    });
  }
  return globalThis.__quizzardStore;
}
