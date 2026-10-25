import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/index.js';
import { createMemoryStore } from '../lib/db.js';
import { webHandler } from '../lib/web-adapter.js';

const fn = () => {
  const store = createMemoryStore();
  return webHandler(createHandler(async () => store));
};
const req = (method, path, body, headers = {}) =>
  new Request(`https://quizzard.example${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body });

test('web adapter: create a group, read it back, CORS preflight, bad JSON', async () => {
  const api = fn();
  const created = await api(req('POST', '/api/groups', JSON.stringify({ name: 'Night Owls', member_name: 'Manav' })), { ip: '1.2.3.4' });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('access-control-allow-origin'), '*');
  const host = await created.json();
  assert.match(host.code, /^[A-Z0-9]+$/);

  const view = await api(req('GET', `/api/groups/${host.code}`, undefined, { authorization: `Bearer ${host.token}` }), {});
  assert.equal(view.status, 200);
  assert.equal((await view.json()).name, 'Night Owls');

  const pre = await api(req('OPTIONS', '/api/groups'), {});
  assert.equal(pre.status, 204);

  const bad = await api(req('POST', '/api/groups', '{nope'), {});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error?.code ?? 'bad_json', 'bad_json');
});
