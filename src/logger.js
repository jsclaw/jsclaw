/**
 * Minimal logger with no external dependencies.
 * @module logger
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/**
 * Create a minimal logger.
 * @param {{ level?: string, name?: string }} [options]
 * @returns {import('./types.js').Logger}
 */
export function createLogger(options = {}) {
  const { level = 'info', name = 'jsclaw' } = options;
  const minLevel = LEVELS[level] ?? LEVELS.info;

  function log(lvl, msg, data) {
    if (LEVELS[lvl] < minLevel) return;
    const entry = {
      level: lvl,
      time: new Date().toISOString(),
      name,
      msg,
      ...data,
    };
    const out = lvl === 'error' || lvl === 'fatal' ? console.error : console.log;
    out(JSON.stringify(entry));
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
    fatal: (msg, data) => log('fatal', msg, data),
  };
}
