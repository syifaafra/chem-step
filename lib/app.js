'use strict';
const express = require('express');
const topics = require('../data/topics');
const questions = require('../data/questions');
const store = require('./store');
const { isCorrect } = require('./answer');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Optional CORS (only if CORS_ORIGIN is set)
app.use((req, res, next) => {
  if (process.env.CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function clientId(req) {
  const id = req.get('X-Client-Id');
  return id && CLIENT_ID_RE.test(id) ? id : null;
}
function requireClient(req, res, next) {
  const id = clientId(req);
  if (!id) return res.status(400).json({ error: 'Header X-Client-Id wajib (8-64 karakter: huruf, angka, _ atau -).' });
  req.clientId = id;
  next();
}

// Public shape: answer is never included (use POST /check).
const publicQuestion = (q) => ({
  id: q.id,
  title: q.title,
  topicIndex: q.topicIndex,
  topic: topics[q.topicIndex],
  level: q.level,
  text: q.text,
  steps: q.steps,
});

const api = express.Router();

api.get('/health', (req, res) => res.json({ status: 'ok', topics: topics.length, questions: questions.length }));

api.get('/topics', (req, res) => {
  res.json(topics.map((name, index) => ({
    index, name,
    totalQuestions: questions.filter((q) => q.topicIndex === index).length,
  })));
});

api.get('/questions', (req, res) => {
  const { topic, level } = req.query;
  const q = String(req.query.q || '').toLowerCase();
  let list = questions;
  if (topic !== undefined && topic !== 'all') {
    const t = Number(topic);
    if (!Number.isInteger(t) || t < 0 || t >= topics.length) return res.status(400).json({ error: 'topic tidak valid.' });
    list = list.filter((x) => x.topicIndex === t);
  }
  if (level) list = list.filter((x) => x.level.toLowerCase() === String(level).toLowerCase());
  if (q) {
    list = list.filter((x) =>
      x.title.toLowerCase().includes(q) ||
      topics[x.topicIndex].toLowerCase().includes(q) ||
      x.text.toLowerCase().includes(q));
  }
  res.json({ total: list.length, data: list.map(publicQuestion) });
});

function findQuestion(req, res, next) {
  const id = Number(req.params.id);
  const q = Number.isInteger(id) ? questions[id - 1] : null;
  if (!q) return res.status(404).json({ error: 'Soal tidak ditemukan.' });
  req.question = q;
  next();
}

api.get('/questions/:id', findQuestion, (req, res) => res.json(publicQuestion(req.question)));

// Check an answer. If correct and X-Client-Id is present, progress is saved.
api.post('/questions/:id/check', findQuestion, (req, res) => {
  const answer = req.body && req.body.answer;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 200) {
    return res.status(400).json({ error: 'Field "answer" (string, 1-200 karakter) wajib diisi.' });
  }
  const correct = isCorrect(answer, req.question.answer);
  const id = clientId(req);
  if (correct && id) store.markLearned(id, [req.question.id]);
  res.json({ correct, saved: Boolean(correct && id) });
});

api.get('/progress', requireClient, (req, res) => {
  const learned = store.getLearned(req.clientId);
  res.json(progressView(learned));
});

// Merge ids (used by the frontend to push its localStorage copy after a cold start).
api.put('/progress', requireClient, (req, res) => {
  const ids = req.body && req.body.learned;
  if (!Array.isArray(ids) || ids.length > questions.length ||
      !ids.every((n) => Number.isInteger(n) && n >= 1 && n <= questions.length)) {
    return res.status(400).json({ error: `"learned" harus array id soal (1-${questions.length}).` });
  }
  res.json(progressView(store.markLearned(req.clientId, ids)));
});

api.delete('/progress', requireClient, (req, res) => {
  store.reset(req.clientId);
  res.json(progressView([]));
});

function progressView(learned) {
  return {
    learned,
    done: learned.length,
    total: questions.length,
    percent: Math.round((learned.length / questions.length) * 100),
    topics: topics.map((name, index) => ({
      index, name,
      done: learned.filter((id) => questions[id - 1].topicIndex === index).length,
      total: questions.filter((q) => q.topicIndex === index).length,
    })),
  };
}

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON tidak valid.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload terlalu besar.' });
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

module.exports = app;
