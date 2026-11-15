'use strict';
// Same matching rule the original frontend used, now server-side.
const norm = (s) => String(s).toLowerCase().replace(/\s/g, '').replace(/,/g, '.');

function isCorrect(input, expected) {
  const v = String(input || '').trim().toLowerCase();
  if (!v) return false;
  const a = norm(v);
  const b = norm(expected);
  return a === b || (b.includes(a) && v.length > 2);
}

module.exports = { isCorrect };
