'use strict';
/**
 * Every failure a command can report. Commands throw CmdError; the core turns it into a
 * clean message (or a JSON error object) — a failing network command never crashes the terminal.
 */
class CmdError extends Error {
  /**
   * @param {string} code  USAGE | INVALID | MISSING_DEPENDENCY | PERMISSION | UNAVAILABLE |
   *                       UNSUPPORTED_PLATFORM | NOT_FOUND | TIMEOUT | UNREACHABLE | DNS | FAILED | CANCELLED
   */
  constructor(code, message, { hints = [], exit = 1 } = {}) {
    super(message);
    this.name = 'CmdError';
    this.code = code;
    this.hints = hints;
    this.exit = exit;
  }
}

module.exports = { CmdError };
