'use strict';
// Tes cepat: node test.js   (berjalan in-memory, tidak menyentuh file data)
process.env.DATA_FILE = 'memory';
process.env.SEED_DEMO = '0';
process.env.TEACHER_SIGNUP_CODE = 'KODE-GURU-TES';
const assert = require('assert');
const server = require('./server');

(async () => {
  await server.ready;
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // klien sederhana yang menyimpan cookie sesi
  const client = () => {
    let cookie = '';
    return async (m, p, b, headers = {}) => {
      const r = await fetch(base + p, {
        method: m,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: b ? JSON.stringify(b) : undefined,
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
      return { status: r.status, body: await r.json().catch(() => null), setCookie: sc };
    };
  };
  const anon = client(), guru = client(), siswa = client(), guru2 = client(), siswa2 = client();

  assert.strictEqual((await anon('GET', '/api/health')).body.status, 'ok');

  // --- registrasi ---
  assert.strictEqual((await anon('POST', '/api/auth/register', { role: 'guru', name: 'Bu Guru', username: 'buguru', password: 'rahasia1', code: 'salah' })).status, 403);
  let r = await guru('POST', '/api/auth/register', { role: 'guru', name: 'Bu Guru', username: 'buguru', password: 'rahasia1', code: 'kode-guru-tes' });
  assert.strictEqual(r.status, 201);
  assert.match(r.setCookie, /HttpOnly/);
  const classCode = r.body.user.classCode;
  assert.match(classCode, /^[A-Z0-9]{6}$/);

  assert.strictEqual((await anon('POST', '/api/auth/register', { role: 'siswa', name: 'Siswa', username: 'sis1', password: 'rahasia1', code: 'ZZZZZZ' })).status, 404);
  r = await siswa('POST', '/api/auth/register', { role: 'siswa', name: 'Siti', username: 'siti', password: 'rahasia1', code: classCode.toLowerCase() });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.user.teacher.name, 'Bu Guru');
  assert.strictEqual((await anon('POST', '/api/auth/register', { role: 'siswa', name: 'Dup', username: 'siti', password: 'rahasia1', code: classCode })).status, 409);
  assert.strictEqual((await anon('POST', '/api/auth/register', { role: 'siswa', name: 'X', username: 'a b', password: '1', code: classCode })).status, 400);

  // --- login & validasi peran ---
  const login = anon;
  assert.strictEqual((await login('POST', '/api/auth/login', { username: 'siti', password: 'rahasia1' })).status, 400);       // peran wajib
  assert.strictEqual((await login('POST', '/api/auth/login', { role: 'siswa', username: 'siti', password: 'salah' })).status, 401);
  r = await login('POST', '/api/auth/login', { role: 'guru', username: 'siti', password: 'rahasia1' });
  assert.strictEqual(r.status, 403);                                                                                      // akun siswa lewat halaman guru
  assert.strictEqual(r.body.code, 'ROLE_MISMATCH');
  assert.strictEqual(r.setCookie, null);                                                                                  // tidak ada sesi dibuat
  r = await login('POST', '/api/auth/login', { role: 'siswa', username: 'buguru', password: 'rahasia1' });
  assert.strictEqual(r.body.code, 'ROLE_MISMATCH');
  r = await login('POST', '/api/auth/login', { role: 'siswa', username: 'SITI', password: 'rahasia1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.user.role, 'siswa');
  assert.strictEqual((await login('GET', '/api/auth/me')).body.user.username, 'siti');
  assert.strictEqual((await login('POST', '/api/auth/logout')).status, 200);
  assert.strictEqual((await login('GET', '/api/auth/me')).status, 401);

  // tanpa login -> 401
  assert.strictEqual((await anon('GET', '/api/progress')).status, 401);
  assert.strictEqual((await anon('GET', '/api/teacher/overview')).status, 401);
  // CSRF: request pengubah data tanpa JSON ditolak
  assert.strictEqual((await fetch(base + '/api/auth/logout', { method: 'POST' })).status, 415);

  // --- progres siswa ---
  const put = await siswa('PUT', '/api/progress', {
    learned: [3, 3, 5, 999, 'x'],
    drafts: { 3: { s: ['a', 'b', 'c', 'd'], r: ['ok', 'bad', null, 'zzz'] }, 500: { s: [], r: [] } },
  });
  assert.strictEqual(put.status, 200);
  const got = (await siswa('GET', '/api/progress')).body;
  assert.deepStrictEqual(got.learned, [3, 5]);                 // dedup + buang id tak valid
  assert.deepStrictEqual(got.drafts[3].r, ['ok', 'bad', null, null]);
  assert.strictEqual(got.drafts[500], undefined);
  assert.strictEqual((await siswa('PUT', '/api/progress', { learned: 'x', drafts: {} })).status, 400);

  // --- hak akses: siswa tidak bisa ke fitur guru, guru tidak bisa kirim progres siswa ---
  assert.strictEqual((await siswa('GET', '/api/teacher/overview')).status, 403);
  assert.strictEqual((await siswa('POST', '/api/assignments', { title: 'Curang', questionIds: [1] })).status, 403);
  assert.strictEqual((await siswa('POST', '/api/materials', { title: 'Curang', body: 'x', topic: -1 })).status, 403);
  assert.strictEqual((await guru('PUT', '/api/progress', { learned: [], drafts: {} })).status, 403);
  assert.strictEqual((await guru('POST', '/api/quiz-results', { topic: 'all', score: 1, total: 1, seconds: 1 })).status, 403);

  // --- kuis ---
  assert.strictEqual((await siswa('POST', '/api/quiz-results', { topic: 'all', score: 7, total: 10, seconds: 90 })).status, 201);
  assert.strictEqual((await siswa('POST', '/api/quiz-results', { topic: 2, score: 3, total: 5, seconds: 40 })).status, 201);
  assert.strictEqual((await siswa('POST', '/api/quiz-results', { topic: 'all', score: 11, total: 10, seconds: 1 })).status, 400);
  const st = (await siswa('GET', '/api/stats')).body;
  assert.strictEqual(st.quizzes, 2);
  assert.strictEqual(st.averageScorePercent, 65);

  // --- tugas & materi (guru) ---
  assert.strictEqual((await guru('POST', '/api/assignments', { title: 'Tugas', questionIds: [] })).status, 400);
  r = await guru('POST', '/api/assignments', { title: 'Tugas Mol', description: 'Kerjakan', questionIds: [16, 17, 17, 99], due: '2030-01-31' });
  assert.strictEqual(r.status, 201);
  const aid = r.body.item.id;
  assert.deepStrictEqual(r.body.item.questionIds, [16, 17]);
  assert.strictEqual((await guru('PUT', `/api/assignments/${aid}`, { title: 'Tugas Mol 2', questionIds: [16], due: null })).body.item.title, 'Tugas Mol 2');
  assert.strictEqual((await guru('POST', '/api/materials', { title: 'Link', link: 'javascript:alert(1)', topic: 0 })).status, 400);
  r = await guru('POST', '/api/materials', { title: 'Ringkasan mol', body: 'n = m / Mr', link: 'https://example.com', topic: 3 });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await siswa('GET', '/api/assignments')).body.items.length, 1);
  assert.strictEqual((await siswa('GET', '/api/materials')).body.items[0].title, 'Ringkasan mol');

  // --- guru lain tidak bisa melihat/mengubah data kelas ini ---
  await guru2('POST', '/api/auth/register', { role: 'guru', name: 'Pak Lain', username: 'paklain', password: 'rahasia1', code: 'KODE-GURU-TES' });
  assert.strictEqual((await guru2('GET', '/api/assignments')).body.items.length, 0);
  assert.strictEqual((await guru2('DELETE', `/api/assignments/${aid}`)).status, 404);
  assert.strictEqual((await guru2('GET', '/api/teacher/overview')).body.students.length, 0);

  // --- data siswa (guru) ---
  const ov = (await guru('GET', '/api/teacher/overview')).body;
  assert.strictEqual(ov.students.length, 1);
  const sid = ov.students[0].id;
  assert.deepStrictEqual(ov.students[0].wrong, [0, 1, 0, 0]);
  assert.strictEqual(ov.students[0].quiz.count, 2);
  assert.strictEqual(ov.results.length, 2);
  assert.strictEqual((await guru2('GET', `/api/teacher/students/${sid}`)).status, 404);
  const det = (await guru('GET', `/api/teacher/students/${sid}`)).body;
  assert.strictEqual(det.drafts[3].s[0], 'a');

  r = await guru('POST', '/api/teacher/students', { name: 'Budi', username: 'budi', password: 'budi123' });
  assert.strictEqual(r.status, 201);
  const bid = r.body.student.id;
  r = await siswa2('POST', '/api/auth/login', { role: 'siswa', username: 'budi', password: 'budi123' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await guru('POST', `/api/teacher/students/${bid}/password`, { password: 'baru123' })).status, 200);
  assert.strictEqual((await siswa2('GET', '/api/auth/me')).status, 401);                      // sesi lama dicabut
  assert.strictEqual((await siswa2('POST', '/api/auth/login', { role: 'siswa', username: 'budi', password: 'baru123' })).status, 200);
  assert.strictEqual((await guru('DELETE', `/api/teacher/students/${bid}`)).status, 200);
  assert.strictEqual((await siswa2('GET', '/api/auth/me')).status, 401);

  // reset progres oleh guru: salinan lama siswa ditolak sampai siswa mengakui reset
  assert.strictEqual((await guru('DELETE', `/api/teacher/students/${sid}/progress`)).status, 200);
  const pr = (await siswa('GET', '/api/progress')).body;
  assert.deepStrictEqual(pr.learned, []);
  assert.ok(pr.resetAt > 0);
  r = await siswa('PUT', '/api/progress', { learned: [3, 5], drafts: {} });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'PROGRESS_RESET');
  assert.strictEqual((await siswa('PUT', '/api/progress', { learned: [7], drafts: {}, resetSeen: pr.resetAt })).status, 200);
  assert.deepStrictEqual((await siswa('GET', '/api/progress')).body.learned, [7]);

  // kode kelas baru -> kode lama tidak berlaku
  const newCode = (await guru('POST', '/api/teacher/class-code')).body.classCode;
  assert.notStrictEqual(newCode, classCode);
  assert.strictEqual((await anon('POST', '/api/auth/register', { role: 'siswa', name: 'Lama', username: 'lama', password: 'rahasia1', code: classCode })).status, 404);

  // ganti sandi sendiri
  assert.strictEqual((await siswa('POST', '/api/auth/password', { oldPassword: 'x', newPassword: 'abcdef' })).status, 400);
  assert.strictEqual((await siswa('POST', '/api/auth/password', { oldPassword: 'rahasia1', newPassword: 'abcdef' })).status, 200);

  assert.strictEqual((await siswa('DELETE', '/api/progress')).status, 200);
  assert.deepStrictEqual((await siswa('GET', '/api/progress')).body.learned, []);
  assert.strictEqual((await siswa('GET', '/api/nope')).status, 404);

  // statis
  let s = await fetch(base + '/');            assert.strictEqual(s.status, 200);
  assert.match(s.headers.get('content-type'), /text\/html/);
  s = await fetch(base + '/sw.js');           assert.strictEqual(s.status, 200);
  s = await fetch(base + '/manifest.webmanifest'); assert.strictEqual(s.status, 200);
  s = await fetch(base + '/icon-192.png');    assert.strictEqual(s.headers.get('content-type'), 'image/png');
  s = await fetch(base + '/%2e%2e/server.js'); assert.notStrictEqual(s.status, 200);   // path traversal
  s = await fetch(base + '/server.js');       assert.strictEqual(s.status, 404);       // server.js tidak terekspos
  s = await fetch(base + '/missing.png');     assert.strictEqual(s.status, 404);

  console.log('Semua tes lulus ✔');
  server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
