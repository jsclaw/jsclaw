/**
 * Agent id handling (#79 Phase 0). agentId is used as a folder name and
 * a container name, so it must be a safe slug. Ported from openclaw's
 * normalizeAgentId: lowercase, collapse any disallowed run to a single
 * dash, trim dashes, fall back to the default when empty.
 *
 * Slugify-on-input (never reject): a 64-char nostr pubkey hex and an
 * npub pass through unchanged; a URI/DID is slugified; `..` and path
 * separators become `-`, closing path traversal.
 * @module agents
 */

export const DEFAULT_AGENT_ID = 'main';

/**
 * @param {*} value
 * @returns {string} a filesystem- and container-name-safe agent id
 */
export function normalizeAgentId(value) {
  return (value ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/g, '')
    .replace(/-+$/g, '')
    || DEFAULT_AGENT_ID;
}
