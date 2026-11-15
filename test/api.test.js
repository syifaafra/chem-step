'use strict';
const test = require('node:test');
const assert = require('node:assert');
const app = require('../lib/app');
const store = require('../lib/store');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api`; r(); }); }));
test.after(() => server.close());
test.beforeEach(() => store._clear());

const H = { 'Content-Type': 'application/json', 'X-Client-Id': 'test-client-1' };
const j = async (p, o) => { const r = await fetch(base + p, o); return [r.status, await r.json()]; };

test('health & topics', async () => {
  assert.deepStrictEqual((await j('/health'))[1], { status: 'ok', topics: 12, questions: 60 });
  const [, t] = await j('/topics');
  assert.strictEqual(t.length, 12);
  assert.ok(t.every((x) => x.totalQuestions === 5));
});

test('questions list never leaks answers; filters work', async () => {
  const [, all] = await j('/questions');
  assert.strictEqual(all.total, 60);
  assert.ok(!('answer' in all.data[0]));
  assert.strictEqual((await j('/questions?topic=2'))[1].total, 5);
  assert.ok((await j('/questions?q=termit'))[1].total >= 1);
  assert.strictEqual((await j('/questions?topic=99'))[0], 400);
  assert.strictEqual((await j('/questions/61'))[0], 404);
});

test('check answer saves progress only when correct', async () => {
  const post = (id, answer) => j(`/questions/${id}/check`, { method: 'POST', headers: H, body: JSON.stringify({ answer }) });
  assert.deepStrictEqual((await post(1, '999'))[1], { correct: false, saved: false });
  assert.deepStrictEqual((await post(1, '110 Gram'))[1], { correct: true, saved: true });
  const [, p] = await j('/progress', { headers: H });
  assert.deepStrictEqual(p.learned, [1]);
  assert.strictEqual(p.percent, 2);
  assert.strictEqual(p.topics[0].done, 1);
  assert.strictEqual((await post(1, ''))[0], 400);
});

test('progress merge, validation, reset, client isolation', async () => {
  assert.strictEqual((await j('/progress'))[0], 400);
  const put = (body, h = H) => j('/progress', { method: 'PUT', headers: h, body: JSON.stringify(body) });
  assert.deepStrictEqual((await put({ learned: [3, 1, 3] }))[1].learned, [1, 3]);
  assert.strictEqual((await put({ learned: [0] }))[0], 400);
  assert.strictEqual((await put({ learned: 'x' }))[0], 400);
  const other = { ...H, 'X-Client-Id': 'other-client-2' };
  assert.deepStrictEqual((await j('/progress', { headers: other }))[1].learned, []);
  assert.deepStrictEqual((await j('/progress', { method: 'DELETE', headers: H }))[1].learned, []);
});

test('bad json and unknown route', async () => {
  const r = await fetch(base + '/progress', { method: 'PUT', headers: H, body: '{bad' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await j('/nope'))[0], 404);
});
