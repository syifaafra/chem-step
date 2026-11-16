'use strict';
/**
 * ChemStep backend — Express + Node.js (kompatibel lokal, Docker/Render, dan Vercel).
 * Autentikasi berbasis peran (RBAC) dengan 2 peran: "guru" dan "siswa".
 *
 * Data disimpan di memori dan (opsional) ditulis ke file JSON (DATA_FILE) agar
 * akun, progres, tugas, dan materi tidak hilang saat server restart.
 * Sesi menggunakan token bertanda tangan HMAC (stateless) agar tetap valid di
 * lingkungan serverless multi-instance seperti Vercel.
 *
 * Publik
 *  GET    /api/health
 *  POST   /api/auth/login            <- { role, username, password }
 *  POST   /api/auth/register         <- { role, name, username, password, code }
 *  POST   /api/auth/logout
 *  GET    /api/auth/me
 *  POST   /api/auth/password         <- { oldPassword, newPassword }   (login)
 *
 * Siswa
 *  GET/PUT/DELETE /api/progress      progres & draf langkah milik akun sendiri
 *  POST   /api/quiz-results          <- { topic, score, total, seconds }
 *
 * Guru & Siswa
 *  GET    /api/assignments           guru: tugas buatannya; siswa: tugas dari gurunya
 *  GET    /api/materials             guru: materi buatannya; siswa: materi dari gurunya
 *  GET    /api/stats                 ringkasan anonim hasil kuis
 *
 * Guru
 *  POST/PUT/DELETE /api/assignments[/:id]
 *  POST/PUT/DELETE /api/materials[/:id]
 *  GET    /api/teacher/overview
 *  POST   /api/teacher/class-code
 *  POST   /api/teacher/students
 *  GET    /api/teacher/students/:id
 *  POST   /api/teacher/students/:id/password
 *  DELETE /api/teacher/students/:id
 *  DELETE /api/teacher/students/:id/progress
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

// DATA_FILE="" atau "memory" -> murni in-memory (tanpa file)
// Di Vercel, direktori proyek bersifat read-only sehingga default diarahkan ke /tmp
const DATA_FILE = process.env.DATA_FILE === undefined
  ? (process.env.VERCEL ? path.join('/tmp', 'chemstep-db.json') : path.join(__dirname, 'data', 'chemstep-db.json'))
  : (/^(|memory|:memory:)$/i.test(process.env.DATA_FILE) ? null : path.resolve(process.env.DATA_FILE));

const TOTAL_QUESTIONS = 70;        // id soal 1..70
const TOTAL_TOPICS = 14;           // 70 soal / 5 per submateri
const MAX_BODY = 200 * 1024;       // 200 KB
const MAX_RESULTS = 10000;         // batas riwayat hasil kuis
const RATE_LIMIT = 600;            // request /api per menit per IP (satu kelas sering berbagi 1 IP)
const MAX_TEXT = 2000;             // panjang maksimum 1 isian langkah
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const SESSION_COOKIE = 'cs_sess';
const LOGIN_MAX_FAIL = 8;          // gagal login per (IP+username) per 15 menit
const ROLES = ['guru', 'siswa'];
const ROLE_LABEL = { guru: 'Guru', siswa: 'Siswa' };

// Kode registrasi guru: hanya yang tahu kode ini yang bisa mendaftar sebagai guru.
const TEACHER_CODE = process.env.TEACHER_SIGNUP_CODE ||
  (IS_PROD ? crypto.randomBytes(5).toString('hex').toUpperCase() : 'GURU-CHEMSTEP');

// ---------- penyimpanan ----------
const db = {
  users: new Map(),        // id -> { id, role, name, username, salt, hash, teacherId?, classCode?, createdAt }
  progress: new Map(),     // userId -> { learned, drafts, updatedAt }
  results: [],             // { userId, topic, score, total, seconds, at }
  assignments: new Map(),  // id -> { id, teacherId, title, description, questionIds, due, createdAt, updatedAt }
  materials: new Map(),    // id -> { id, teacherId, title, topic, body, link, createdAt, updatedAt }
  activity: new Map(),     // userId -> timestamp aktivitas terakhir
};
const hits = new Map();            // ip -> { n, reset }
const loginFails = new Map();      // ip|username -> { n, reset }
const revokedSessions = new Map(); // sid -> exp

function loadDB() {
  if (!DATA_FILE) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error('Gagal membaca DATA_FILE:', e.message);
    return;
  }
  for (const u of raw.users || []) db.users.set(u.id, u);
  for (const [k, v] of Object.entries(raw.progress || {})) db.progress.set(k, v);
  db.results = Array.isArray(raw.results) ? raw.results : [];
  for (const a of raw.assignments || []) db.assignments.set(a.id, a);
  for (const m of raw.materials || []) db.materials.set(m.id, m);
  for (const [k, v] of Object.entries(raw.activity || {})) db.activity.set(k, v);
}

let saveTimer = null;
function snapshot() {
  return JSON.stringify({
    version: 1,
    users: [...db.users.values()],
    progress: Object.fromEntries(db.progress),
    results: db.results,
    assignments: [...db.assignments.values()],
    materials: [...db.materials.values()],
    activity: Object.fromEntries(db.activity),
  });
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!DATA_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, snapshot());
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('Gagal menyimpan DATA_FILE:', e.message); }
}
function persist() {
  if (!DATA_FILE) return;
  if (process.env.VERCEL) { saveNow(); return; }
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}

function sweep() {
  const now = Date.now();
  for (const [sid, exp] of revokedSessions) if (now > exp) revokedSessions.delete(sid);
  for (const [ip, h] of hits) if (now > h.reset) hits.delete(ip);
  for (const [k, h] of loginFails) if (now > h.reset) loginFails.delete(k);
}
setInterval(sweep, 10 * 60 * 1000).unref();

// ---------- util ----------
const newId = () => crypto.randomBytes(8).toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_SECRET = sha(process.env.SESSION_SECRET || process.env.TEACHER_SIGNUP_CODE || 'chemstep-default-secret');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newClassCode() {
  for (;;) {
    let c = '';
    const b = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) c += CODE_CHARS[b[i] % CODE_CHARS.length];
    if (![...db.users.values()].some(u => u.classCode === c)) return c;
  }
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('hex') })));
}
async function verifyPassword(pw, user) {
  const { hash } = await hashPassword(pw, user.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// hash palsu agar waktu respons sama untuk username yang tidak ada
let DUMMY = null;
hashPassword('dummy-password').then(d => { DUMMY = d; });

// ---------- validasi ----------
const ID_RE = /^[a-f0-9]{16}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanLearned(a) {
  if (!Array.isArray(a)) return null;
  const s = new Set();
  for (const x of a) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 1 && n <= TOTAL_QUESTIONS) s.add(n);
  }
  return [...s].sort((x, y) => x - y);
}

function cleanDrafts(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  for (const k of Object.keys(o)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 1 || id > TOTAL_QUESTIONS) continue;
    const d = o[k];
    if (!d || !Array.isArray(d.s) || !Array.isArray(d.r)) continue;
    out[id] = {
      s: [0, 1, 2, 3].map(i => (typeof d.s[i] === 'string' ? d.s[i].slice(0, MAX_TEXT) : '')),
      r: [0, 1, 2, 3].map(i => (d.r[i] === 'ok' || d.r[i] === 'bad' ? d.r[i] : null)),
    };
  }
  return out;
}

function cleanAssignment(b) {
  const title = str(b.title, 120);
  const description = str(b.description, 2000);
  const questionIds = cleanLearned(b.questionIds);
  let due = b.due == null || b.due === '' ? null : String(b.due);
  if (due !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(Date.parse(due)))) return { error: 'Format tenggat tidak valid (YYYY-MM-DD).' };
  if (title.length < 3) return { error: 'Judul tugas minimal 3 karakter.' };
  if (!questionIds || !questionIds.length) return { error: 'Pilih minimal 1 soal untuk tugas.' };
  return { value: { title, description, questionIds, due } };
}

function cleanMaterial(b) {
  const title = str(b.title, 120);
  const body = str(b.body, 5000);
  const link = str(b.link, 500);
  const topic = Number(b.topic);
  if (title.length < 3) return { error: 'Judul materi minimal 3 karakter.' };
  if (!body && !link) return { error: 'Isi materi atau tautan wajib diisi.' };
  if (!Number.isInteger(topic) || topic < -1 || topic >= TOTAL_TOPICS) return { error: 'Submateri tidak valid.' };
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) return { error: 'Tautan harus diawali http:// atau https://' };
  return { value: { title, body, link, topic } };
}

// ---------- helper HTTP ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}
const fail = (status, msg, code) => { throw { status, msg, code }; };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject({ status: 413, msg: 'Payload terlalu besar' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject({ status: 400, msg: 'JSON tidak valid' }); }
    });
    req.on('error', () => reject({ status: 400, msg: 'Request error' }));
  });
}

function clientIP(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function limited(req) {
  const ip = clientIP(req), now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { n: 0, reset: now + 60000 }; hits.set(ip, h); }
  return ++h.n > RATE_LIMIT;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isHttps(req) {
  return process.env.COOKIE_SECURE === '1' || req.socket.encrypted ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function sessionCookie(req, token, maxAgeSec) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` + (isHttps(req) ? '; Secure' : '');
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (Date.now() > payload.exp || revokedSessions.has(payload.sid)) return null;

  const user = db.users.get(payload.uid);
  if (!user) return null;
  if (payload.pwv && user.hash.slice(0, 8) !== payload.pwv) return null;
  return { key: payload.sid, exp: payload.exp, user };
}

function createSession(userId) {
  const u = db.users.get(userId);
  return signSession({
    uid: userId,
    sid: newId(),
    pwv: u ? u.hash.slice(0, 8) : '',
    exp: Date.now() + SESSION_TTL,
  });
}

function publicUser(u) {
  const out = { id: u.id, role: u.role, roleLabel: ROLE_LABEL[u.role], name: u.name, username: u.username };
  if (u.role === 'guru') out.classCode = u.classCode;
  if (u.role === 'siswa') {
    const t = db.users.get(u.teacherId);
    out.teacher = t ? { name: t.name } : null;
  }
  return out;
}

function touch(userId) {
  const now = Date.now(), prev = db.activity.get(userId) || 0;
  db.activity.set(userId, now);
  if (now - prev > 60000) persist();
}

// ---------- ringkasan siswa (dipakai dashboard guru) ----------
function studentSummary(u) {
  const p = db.progress.get(u.id) || { learned: [], drafts: {}, updatedAt: 0 };
  const wrong = [0, 0, 0, 0], wrongTopics = {};
  let checked = 0;
  const review = [];
  for (const [k, d] of Object.entries(p.drafts || {})) {
    let bad = false;
    (d.r || []).forEach((x, j) => {
      if (!x) return;
      checked++;
      if (x === 'bad') { wrong[j]++; bad = true; const t = Math.floor((Number(k) - 1) / 5); wrongTopics[t] = (wrongTopics[t] || 0) + 1; }
    });
    if (bad) review.push(Number(k));
  }
  const rs = db.results.filter(r => r.userId === u.id);
  return {
    id: u.id, name: u.name, username: u.username, createdAt: u.createdAt,
    lastActive: Math.max(db.activity.get(u.id) || 0, p.updatedAt || 0) || null,
    learned: p.learned || [], wrong, wrongTopics, stepsChecked: checked, review: review.sort((a, b) => a - b),
    quiz: {
      count: rs.length,
      avgPercent: rs.length ? Math.round(rs.reduce((a, r) => a + r.score / r.total, 0) / rs.length * 100) : null,
      last: rs.length ? rs[rs.length - 1] : null,
    },
  };
}
const studentsOf = teacherId => [...db.users.values()].filter(u => u.role === 'siswa' && u.teacherId === teacherId);
function ownStudent(teacher, id) {
  const s = ID_RE.test(id) ? db.users.get(id) : null;
  if (!s || s.role !== 'siswa' || s.teacherId !== teacher.id) fail(404, 'Siswa tidak ditemukan');
  return s;
}
function removeUserData(userId) {
  db.progress.delete(userId);
  db.activity.delete(userId);
  db.results = db.results.filter(r => r.userId !== userId);
}

// ---------- validasi akun ----------
function validateAccount(b, { needCode = false } = {}) {
  const name = str(b.name, 60).replace(/\s+/g, ' ');
  const username = str(b.username, 40).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (name.length < 2) fail(400, 'Nama minimal 2 karakter.');
  if (!USERNAME_RE.test(username)) fail(400, 'Username 3–32 karakter: huruf kecil, angka, titik, minus, atau garis bawah.');
  if (password.length < 6 || password.length > 128) fail(400, 'Kata sandi minimal 6 karakter.');
  if (needCode && !str(b.code, 40)) fail(400, 'Kode wajib diisi.');
  if ([...db.users.values()].some(u => u.username === username)) fail(409, 'Username sudah dipakai. Pilih username lain.');
  return { name, username, password };
}
async function createUser({ id, role, name, username, password, teacherId, classCode }) {
  const { salt, hash } = await hashPassword(password);
  // cek ulang setelah await (hindari duplikasi bila dua request bersamaan)
  if ([...db.users.values()].some(u => u.username === username)) fail(409, 'Username sudah dipakai. Pilih username lain.');
  const u = { id: id || newId(), role, name, username, salt, hash, createdAt: Date.now() };
  if (role === 'guru') u.classCode = classCode || newClassCode();
  if (role === 'siswa') u.teacherId = teacherId;
  db.users.set(u.id, u);
  persist();
  return u;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  if (limited(req)) return sendJSON(res, 429, { error: 'Terlalu banyak request, coba lagi sebentar.' });
  const p = url.pathname, method = req.method;

  // Perlindungan CSRF sederhana: request yang mengubah data wajib ber-Content-Type JSON
  // (form lintas situs tidak bisa mengirim header ini tanpa preflight CORS).
  if (method !== 'GET' && method !== 'HEAD' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return sendJSON(res, 415, { error: 'Content-Type harus application/json' });
  }

  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), users: db.users.size });
  }

  // ----- auth publik -----
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const role = b.role, username = str(b.username, 40).toLowerCase(), password = typeof b.password === 'string' ? b.password : '';
    if (!ROLES.includes(role)) fail(400, 'Pilih peran (Guru atau Siswa) terlebih dahulu.');
    if (!username || !password) fail(400, 'Username dan kata sandi wajib diisi.');
    const fk = clientIP(req) + '|' + username, now = Date.now();
    let f = loginFails.get(fk);
    if (f && now > f.reset) { loginFails.delete(fk); f = null; }
    if (f && f.n >= LOGIN_MAX_FAIL) fail(429, 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.');

    const user = [...db.users.values()].find(u => u.username === username);
    const ok = user ? await verifyPassword(password, user) : (DUMMY && await verifyPassword(password, DUMMY), false);
    if (!ok) {
      if (!f) { f = { n: 0, reset: now + 15 * 60000 }; loginFails.set(fk, f); }
      f.n++;
      fail(401, 'Username atau kata sandi salah.');
    }
    loginFails.delete(fk);
    // Validasi peran: akun hanya bisa masuk lewat halaman peran yang sesuai.
    if (user.role !== role) {
      fail(403, `Akun ini terdaftar sebagai ${ROLE_LABEL[user.role]}. Silakan masuk melalui halaman ${ROLE_LABEL[user.role]}.`, 'ROLE_MISMATCH');
    }
    const token = createSession(user.id);
    touch(user.id);
    return sendJSON(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL / 1000) });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    if (!ROLES.includes(b.role)) fail(400, 'Pilih peran (Guru atau Siswa) terlebih dahulu.');
    const acc = validateAccount(b, { needCode: true });
    const code = str(b.code, 40).toUpperCase();
    let teacherId;
    if (b.role === 'guru') {
      const a = Buffer.from(sha(code)), e = Buffer.from(sha(TEACHER_CODE.toUpperCase()));
      if (!crypto.timingSafeEqual(a, e)) fail(403, 'Kode registrasi guru salah. Hubungi admin sekolah/aplikasi.');
    } else {
      const t = [...db.users.values()].find(u => u.role === 'guru' && u.classCode === code);
      if (!t) fail(404, 'Kode kelas tidak ditemukan. Minta kode kelas yang benar kepada gurumu.');
      teacherId = t.id;
    }
    const user = await createUser({ role: b.role, ...acc, teacherId });
    const token = createSession(user.id);
    touch(user.id);
    return sendJSON(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL / 1000) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    const s = getSession(req);
    if (s) revokedSessions.set(s.key, s.exp);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // ----- semua endpoint di bawah ini wajib login -----
  const sess = getSession(req);
  if (!sess) return sendJSON(res, 401, { error: 'Sesi berakhir. Silakan masuk kembali.', code: 'UNAUTHENTICATED' });
  const me = sess.user;
  touch(me.id);
  const requireRole = role => { if (me.role !== role) fail(403, `Fitur ini khusus ${ROLE_LABEL[role]}.`, 'FORBIDDEN'); };

  if (p === '/api/auth/me' && method === 'GET') return sendJSON(res, 200, { user: publicUser(me) });

  if (p === '/api/auth/password' && method === 'POST') {
    const b = await readBody(req);
    const np = typeof b.newPassword === 'string' ? b.newPassword : '';
    if (!(await verifyPassword(typeof b.oldPassword === 'string' ? b.oldPassword : '', me))) fail(400, 'Kata sandi lama salah.');
    if (np.length < 6 || np.length > 128) fail(400, 'Kata sandi baru minimal 6 karakter.');
    Object.assign(me, await hashPassword(np));
    persist();
    const newToken = createSession(me.id);
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, newToken, SESSION_TTL / 1000) });
  }

  // ----- progres (siswa) -----
  if (p === '/api/progress') {
    requireRole('siswa');
    if (method === 'GET') {
      const v = db.progress.get(me.id);
      return sendJSON(res, 200, v ? { learned: v.learned, drafts: v.drafts, updatedAt: v.updatedAt, resetAt: v.resetAt || 0 }
                                  : { learned: [], drafts: {}, updatedAt: 0, resetAt: 0 });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const learned = cleanLearned(body.learned), drafts = cleanDrafts(body.drafts);
      if (!learned || !drafts) fail(400, 'Format data tidak valid');
      // Jika guru mereset progres, salinan lama di perangkat siswa tidak boleh menimpanya.
      const cur = db.progress.get(me.id);
      if (cur && cur.resetAt && !(Number(body.resetSeen) >= cur.resetAt)) {
        fail(409, 'Progresmu telah direset oleh guru.', 'PROGRESS_RESET');
      }
      const rec = { learned, drafts, updatedAt: Date.now(), ...(cur && cur.resetAt ? { resetAt: cur.resetAt } : {}) };
      db.progress.set(me.id, rec);
      persist();
      return sendJSON(res, 200, { ok: true, updatedAt: rec.updatedAt });
    }
    if (method === 'DELETE') {
      db.progress.delete(me.id); persist();
      return sendJSON(res, 200, { ok: true });
    }
    fail(405, 'Method tidak diizinkan');
  }

  if (p === '/api/quiz-results' && method === 'POST') {
    requireRole('siswa');
    const b = await readBody(req);
    const total = Number(b.total), score = Number(b.score), seconds = Number(b.seconds);
    const topic = b.topic === 'all' ? 'all' : Number(b.topic);
    if (!Number.isInteger(total) || total < 1 || total > TOTAL_QUESTIONS ||
        !Number.isInteger(score) || score < 0 || score > total ||
        !Number.isFinite(seconds) || seconds < 0 || seconds > 6 * 3600 ||
        !(topic === 'all' || (Number.isInteger(topic) && topic >= 0 && topic < TOTAL_TOPICS))) {
      fail(400, 'Data hasil kuis tidak valid');
    }
    db.results.push({ userId: me.id, topic, score, total, seconds: Math.round(seconds), at: Date.now() });
    if (db.results.length > MAX_RESULTS) db.results.shift();
    persist();
    return sendJSON(res, 201, { ok: true });
  }

  if (p === '/api/quiz-results' && method === 'GET') {
    requireRole('siswa');
    return sendJSON(res, 200, { results: db.results.filter(r => r.userId === me.id).slice(-100) });
  }

  if (p === '/api/stats' && method === 'GET') {
    const n = db.results.length;
    const sumPct = db.results.reduce((a, r) => a + r.score / r.total, 0);
    const sumSec = db.results.reduce((a, r) => a + r.seconds, 0);
    return sendJSON(res, 200, {
      quizzes: n,
      averageScorePercent: n ? Math.round((sumPct / n) * 100) : null,
      averageSeconds: n ? Math.round(sumSec / n) : null,
      learners: db.progress.size,
    });
  }

  // ----- tugas & materi -----
  for (const [base, store, clean, label] of [
    ['/api/assignments', db.assignments, cleanAssignment, 'Tugas'],
    ['/api/materials', db.materials, cleanMaterial, 'Materi'],
  ]) {
    if (p === base && method === 'GET') {
      const owner = me.role === 'guru' ? me.id : me.teacherId;
      const items = [...store.values()].filter(x => x.teacherId === owner).sort((a, b) => b.createdAt - a.createdAt);
      return sendJSON(res, 200, { items });
    }
    if (p === base && method === 'POST') {
      requireRole('guru');
      const r = clean(await readBody(req));
      if (r.error) fail(400, r.error);
      const item = { id: newId(), teacherId: me.id, ...r.value, createdAt: Date.now(), updatedAt: Date.now() };
      store.set(item.id, item); persist();
      return sendJSON(res, 201, { item });
    }
    if (p.startsWith(base + '/')) {
      requireRole('guru');
      const m = p.slice(base.length + 1);
      const item = ID_RE.test(m) ? store.get(m) : null;
      if (!item || item.teacherId !== me.id) fail(404, `${label} tidak ditemukan`);
      if (method === 'PUT') {
        const r = clean(await readBody(req));
        if (r.error) fail(400, r.error);
        Object.assign(item, r.value, { updatedAt: Date.now() }); persist();
        return sendJSON(res, 200, { item });
      }
      if (method === 'DELETE') { store.delete(item.id); persist(); return sendJSON(res, 200, { ok: true }); }
      fail(405, 'Method tidak diizinkan');
    }
  }

  // ----- khusus guru -----
  if (p.startsWith('/api/teacher/')) {
    requireRole('guru');

    if (p === '/api/teacher/overview' && method === 'GET') {
      const students = studentsOf(me.id).map(studentSummary).sort((a, b) => a.name.localeCompare(b.name, 'id'));
      const ids = new Set(students.map(s => s.id)), names = Object.fromEntries(students.map(s => [s.id, s.name]));
      const results = db.results.filter(r => ids.has(r.userId)).slice(-200).reverse()
        .map(r => ({ ...r, studentId: r.userId, studentName: names[r.userId] }));
      return sendJSON(res, 200, { classCode: me.classCode, students, results });
    }

    if (p === '/api/teacher/class-code' && method === 'POST') {
      me.classCode = newClassCode(); persist();
      return sendJSON(res, 200, { classCode: me.classCode });
    }

    if (p === '/api/teacher/students' && method === 'POST') {
      const acc = validateAccount(await readBody(req));
      const u = await createUser({ role: 'siswa', ...acc, teacherId: me.id });
      return sendJSON(res, 201, { student: studentSummary(u) });
    }

    let m = p.match(/^\/api\/teacher\/students\/([^/]+)$/);
    if (m) {
      const s = ownStudent(me, m[1]);
      if (method === 'GET') {
        const prog = db.progress.get(s.id) || { learned: [], drafts: {}, updatedAt: 0 };
        return sendJSON(res, 200, {
          student: studentSummary(s),
          drafts: prog.drafts,
          results: db.results.filter(r => r.userId === s.id).slice(-100).reverse(),
        });
      }
      if (method === 'DELETE') {
        removeUserData(s.id); db.users.delete(s.id); persist();
        return sendJSON(res, 200, { ok: true });
      }
      fail(405, 'Method tidak diizinkan');
    }
    m = p.match(/^\/api\/teacher\/students\/([^/]+)\/password$/);
    if (m && method === 'POST') {
      const s = ownStudent(me, m[1]);
      const b = await readBody(req);
      const pw = typeof b.password === 'string' ? b.password : '';
      if (pw.length < 6 || pw.length > 128) fail(400, 'Kata sandi minimal 6 karakter.');
      Object.assign(s, await hashPassword(pw));
      persist();
      return sendJSON(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/teacher\/students\/([^/]+)\/progress$/);
    if (m && method === 'DELETE') {
      const s = ownStudent(me, m[1]);
      const now = Date.now();
      db.progress.set(s.id, { learned: [], drafts: {}, updatedAt: now, resetAt: now }); persist();
      return sendJSON(res, 200, { ok: true });
    }
  }

  return sendJSON(res, 404, { error: 'Endpoint tidak ditemukan' });
}

// ---------- akun demo (hanya di luar production atau saat SEED_DEMO=1, saat database kosong) ----------
async function seedDemo() {
  if (db.users.size || (IS_PROD && process.env.SEED_DEMO !== '1') || process.env.SEED_DEMO === '0') return;
  const g = await createUser({
    id: '0000000000000001',
    role: 'guru',
    name: 'Bu Rina Kartika',
    username: 'guru',
    password: 'guru123',
    classCode: 'CHEM01',
  });
  await createUser({
    id: '0000000000000002',
    role: 'siswa',
    name: 'Andi Pratama',
    username: 'siswa',
    password: 'siswa123',
    teacherId: g.id,
  });
  saveNow();
  console.log(`Akun demo dibuat — Guru: guru / guru123 · Siswa: siswa / siswa123 · Kode kelas: ${g.classCode}`);
}

// ---------- file statis ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
const fileCache = new Map(); // path -> { buf, gz, mtime }

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';

  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }

  let st;
  try { st = fs.statSync(file); } catch { st = null; }
  if (!st || !st.isFile()) {
    // tidak ada ekstensi -> fallback ke index.html; ada ekstensi -> 404
    if (path.extname(rel)) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    file = path.join(PUBLIC_DIR, 'index.html');
    try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('Not found'); }
  }

  const ext = path.extname(file).toLowerCase();
  let c = fileCache.get(file);
  if (!c || c.mtime !== st.mtimeMs) {
    const buf = fs.readFileSync(file);
    c = { buf, gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(buf) : null, mtime: st.mtimeMs };
    fileCache.set(file, c);
  }

  const isShell = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
  const headers = {
    ...SEC_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isShell ? 'no-cache' : 'public, max-age=86400',
    'Vary': 'Accept-Encoding',
  };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';

  const useGz = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = useGz ? c.gz : c.buf;
  if (useGz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- server Express ----------
loadDB();
const ready = seedDemo().catch(e => console.error(e));

const app = express();
app.disable('x-powered-by');

app.use(async (req, res) => {
  try {
    await ready;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e && e.status) return sendJSON(res, e.status, { error: e.msg, ...(e.code ? { code: e.code } : {}) });
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Terjadi kesalahan pada server' });
  }
});
app.ready = ready;

// Kompatibilitas dengan test.js (server.address, server.close, server.listening)
let activeServer = null;
const origListen = app.listen.bind(app);
app.listen = (...args) => {
  activeServer = origListen(...args);
  activeServer.keepAliveTimeout = app.keepAliveTimeout || 65000;
  activeServer.on('listening', () => app.emit('listening'));
  activeServer.on('close', () => app.emit('close'));
  return activeServer;
};
app.address = () => (activeServer ? activeServer.address() : null);
app.close = cb => (activeServer ? activeServer.close(cb) : (cb && cb()));
Object.defineProperty(app, 'listening', {
  get: () => Boolean(activeServer && activeServer.listening),
});
app.keepAliveTimeout = 65000;

if (require.main === module) {
  ready.then(() => {
    const server = app.listen(PORT, HOST, () => {
      console.log(`ChemStep berjalan di http://${HOST}:${PORT}`);
      console.log(DATA_FILE ? `Data disimpan di ${DATA_FILE}` : 'Mode in-memory: data hilang saat server berhenti.');
      console.log(process.env.TEACHER_SIGNUP_CODE ? 'Kode registrasi guru: (dari TEACHER_SIGNUP_CODE)' : `Kode registrasi guru: ${TEACHER_CODE}`);
    });
    const stop = () => { saveNow(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  });
}

module.exports = app;
