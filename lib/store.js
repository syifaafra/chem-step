'use strict';
// In-memory progress store. No database.
// NOTE: on Vercel (serverless) this lives in the memory of a warm function
// instance. It is NOT shared across instances and is lost on cold start/redeploy.
// The frontend keeps a localStorage copy and re-syncs, so users don't lose progress.

const MAX_CLIENTS = 5000;
const clients = new Map(); // clientId -> { learned:Set<number>, updatedAt:number }

function touch(clientId) {
  let rec = clients.get(clientId);
  if (rec) {
    clients.delete(clientId); // re-insert to mark as most recently used
  } else {
    rec = { learned: new Set(), updatedAt: 0 };
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value);
  }
  rec.updatedAt = Date.now();
  clients.set(clientId, rec);
  return rec;
}

function getLearned(clientId) {
  const rec = clients.get(clientId);
  return rec ? [...rec.learned].sort((a, b) => a - b) : [];
}

function markLearned(clientId, ids) {
  const rec = touch(clientId);
  for (const id of ids) rec.learned.add(id);
  return [...rec.learned].sort((a, b) => a - b);
}

function reset(clientId) {
  clients.delete(clientId);
}

function _clear() {
  clients.clear();
}

module.exports = { getLearned, markLearned, reset, _clear };
