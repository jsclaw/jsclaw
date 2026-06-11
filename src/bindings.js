/**
 * Multi-agent bindings — openclaw's routing shape. A binding maps an
 * inbound message (channel, peer, accountId) to an agent id; the most
 * specific matching binding wins, deterministically.
 *
 *   bindings: [
 *     { match: { channel: 'telegram', peer: 'boss-id' }, agentId: 'researcher' },
 *     { match: { channel: 'telegram' }, agentId: 'assistant' },
 *   ]
 * @module bindings
 */

/**
 * @typedef {Object} Binding
 * @property {{ channel?: string, peer?: string, accountId?: string }} match
 * @property {string} agentId
 */

/**
 * @typedef {Object} AgentEntry
 * @property {string} id
 * @property {string} [folder] - Agent folder (defaults to id)
 * @property {string} [model]
 * @property {Object} [heartbeat]
 */

/**
 * @typedef {Object} AgentsConfig
 * @property {Partial<AgentEntry>} [defaults]
 * @property {AgentEntry[]} [list]
 */

const MATCH_FIELDS = ['channel', 'peer', 'accountId'];

/**
 * Resolve which agent should handle a message.
 *
 * Priority (openclaw semantics): every field specified in a binding's
 * match must equal the message's field; among matching bindings the one
 * with the most specified fields wins; ties break by list order. If
 * nothing matches, defaultAgentId is returned.
 *
 * @param {Binding[]} bindings
 * @param {{ channel?: string, peer?: string, accountId?: string }} message
 * @param {string} [defaultAgentId='main']
 * @returns {string} The agent id to route to
 */
export function resolveBinding(bindings, message, defaultAgentId = 'main') {
  let best = null;
  let bestSpecificity = -1;

  for (const binding of bindings || []) {
    const match = binding.match || {};
    const fields = MATCH_FIELDS.filter((f) => match[f] != null);
    if (fields.length === 0) continue;

    const allMatch = fields.every((f) => match[f] === message[f]);
    if (!allMatch) continue;

    // Most specific wins; first-in-list breaks ties (strict >)
    if (fields.length > bestSpecificity) {
      best = binding;
      bestSpecificity = fields.length;
    }
  }

  return best ? best.agentId : defaultAgentId;
}

/**
 * Resolve an agent's effective config by merging agents.defaults with
 * its list entry. Unknown ids get defaults with folder = id, so simple
 * setups need no agents config at all.
 *
 * @param {AgentsConfig|undefined} agents
 * @param {string} agentId
 * @returns {AgentEntry}
 */
export function resolveAgentConfig(agents, agentId) {
  const defaults = agents?.defaults || {};
  const entry = (agents?.list || []).find((a) => a.id === agentId) || {};
  const merged = { ...defaults, ...entry, id: agentId };
  if (!merged.folder) merged.folder = agentId;
  return merged;
}
