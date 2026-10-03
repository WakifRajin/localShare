'use strict';
/** JSON mode: stdout carries ONLY JSON — never ANSI, banners or progress text. */

const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

const stringify = (obj, compact = false) => JSON.stringify(obj, replacer, compact ? 0 : 2);

function errorObject(err) {
  return { error: { code: err.code || 'FAILED', message: err.message, ...(err.hints && err.hints.length ? { hints: err.hints } : {}) } };
}

module.exports = { stringify, errorObject };
