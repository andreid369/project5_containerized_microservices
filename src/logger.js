'use strict';

// Minimal structured JSON logger: one JSON object per line, which CloudWatch
// Logs Insights can query directly. No dependency needed.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = process.env.LOG_LEVEL || 'info', out = process.stdout) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...fields };
    if (fields.err instanceof Error) {
      entry.err = { message: fields.err.message, code: fields.err.code, stack: fields.err.stack };
    }
    out.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    debug: (msg, f) => write('debug', msg, f),
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
  };
}

module.exports = { createLogger };
