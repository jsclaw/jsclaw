/**
 * Session store — openclaw's session model (#57): sessions are the
 * addressable unit (a sessionKey names a conversation), agents are a
 * property of the session. Two layers, like openclaw: this store is
 * the index (key → row); transcripts stay where the runner keeps them,
 * referenced by row.sessionId.
 *
 * Key conventions: 'main' (webchat/TUI default), '<channel>:<peer>'
 * for channel conversations. Persisted as JSON under dataDir so
 * conversations survive gateway restarts.
 * @module sessions
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConfig } from './config.js';

/**
 * @typedef {Object} SessionRow
 * @property {string} key - Session key (the address)
 * @property {string} agentId - Agent this session converses with
 * @property {string} [sessionId] - Runner-side transcript id (continuity)
 * @property {string} [label] - Human label (sessions.patch)
 * @property {string} [model] - Per-session model override (sessions.patch)
 * @property {number} updatedAt - Epoch ms of last activity
 */

export class SessionStore {
  /** @param {import('./types.js').JsclawConfig} [config] */
  constructor(config) {
    this.config = config || createConfig();
    this.path = join(this.config.dataDir, 'sessions.json');
    /** @type {Record<string, SessionRow>} */
    this.rows = {};
    try {
      this.rows = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch { /* first run or unreadable — start empty */ }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.rows, null, 2));
  }

  /**
   * Get or create the row for a key.
   * @param {string} key
   * @param {string} [agentId] - Agent for newly created rows (default 'main')
   * @returns {SessionRow}
   */
  resolve(key, agentId = 'main') {
    if (!this.rows[key]) {
      this.rows[key] = { key, agentId, updatedAt: Date.now() };
      this.save();
    }
    return this.rows[key];
  }

  /**
   * Record the runner's transcript id after a run (SDK runners that own
   * their own transcript, e.g. Claude Code — continuity by opaque id).
   * @param {string} key
   * @param {string|undefined} sessionId
   */
  advance(key, sessionId) {
    const row = this.resolve(key);
    if (sessionId) row.sessionId = sessionId;
    row.updatedAt = Date.now();
    this.save();
  }

  /**
   * Transcript file for a row, under the state root (never the workspace)
   * — openclaw's `agents/<id>/sessions/` mapped onto jsclaw's data dir.
   * @param {SessionRow} row
   * @returns {string}
   */
  transcriptPath(row) {
    return join(this.config.dataDir, 'sessions', row.agentId, `${row.sessionId}.json`);
  }

  /**
   * Load a host-owned transcript (messages array) for a key. Empty when
   * the key has no transcript yet, or for SDK-owned sessions.
   * @param {string} key
   * @returns {Array}
   */
  loadMessages(key) {
    const row = this.rows[key];
    if (!row?.sessionId) return [];
    try {
      const msgs = JSON.parse(readFileSync(this.transcriptPath(row), 'utf-8'));
      return Array.isArray(msgs) ? msgs : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist a host-owned transcript. Mints the sessionId on first write
   * (the host owns the id; the runner stays stateless — jsclaw#79).
   * @param {string} key
   * @param {Array} messages
   * @param {string} [agentId]
   */
  saveMessages(key, messages, agentId) {
    if (!Array.isArray(messages)) return;
    const row = this.resolve(key, agentId);
    if (!row.sessionId) row.sessionId = randomUUID();
    const path = this.transcriptPath(row);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(messages));
    row.updatedAt = Date.now();
    this.save();
  }

  /**
   * openclaw sessions.reset: fresh conversation under the same key.
   * @param {string} key
   * @param {'reset'|'new'} [reason]
   * @returns {{ ok: boolean, key: string, reason: string }}
   */
  reset(key, reason = 'reset') {
    const row = this.resolve(key);
    if (row.sessionId) {
      try { rmSync(this.transcriptPath(row), { force: true }); } catch { /* best-effort */ }
    }
    delete row.sessionId;
    row.updatedAt = Date.now();
    this.save();
    return { ok: true, key, reason };
  }

  /**
   * openclaw sessions.patch (PoC subset: label, model; null clears).
   * @param {string} key
   * @param {{ label?: string|null, model?: string|null, agentId?: string }} fields
   * @returns {SessionRow}
   */
  patch(key, fields = {}) {
    const row = this.resolve(key, fields.agentId);
    if ('label' in fields) {
      if (fields.label === null) delete row.label;
      else row.label = String(fields.label);
    }
    if ('model' in fields) {
      if (fields.model === null) delete row.model;
      else row.model = String(fields.model);
    }
    if (fields.agentId) row.agentId = fields.agentId;
    row.updatedAt = Date.now();
    this.save();
    return row;
  }

  /**
   * openclaw sessions.list shape (PoC: no hasActiveRun).
   * @param {{ agentId?: string }} [opts]
   * @returns {{ sessions: SessionRow[] }}
   */
  list(opts = {}) {
    let sessions = Object.values(this.rows);
    if (opts.agentId) sessions = sessions.filter((r) => r.agentId === opts.agentId);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions };
  }
}
