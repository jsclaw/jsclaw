/**
 * Slash commands — openclaw's registry shapes (#60). Commands are
 * host-handled: intercepted before the agent sees the message, so they
 * are deterministic, instant, and cost no tokens. One namespace merges
 * built-ins with user-invocable skills (`user-invocable: true` skills
 * surface as /<name> and force-inject their body).
 * @module commands
 */

import { loadSkills, buildSkillContext } from './skills.js';

/**
 * Built-in command specs — openclaw's shape: key, description,
 * textAliases (first alias is canonical), acceptsArgs, scope, category.
 */
export const BUILTIN_COMMANDS = [
  { key: 'reset', description: 'Clear this conversation and start fresh', textAliases: ['/reset', '/new'], acceptsArgs: false, scope: 'both', category: 'session' },
  { key: 'status', description: 'Show gateway, agent, and model status', textAliases: ['/status'], acceptsArgs: false, scope: 'both', category: 'info' },
  { key: 'skills', description: 'List installed skills', textAliases: ['/skills'], acceptsArgs: false, scope: 'both', category: 'tools' },
  { key: 'help', description: 'List available commands', textAliases: ['/help', '/commands'], acceptsArgs: false, scope: 'both', category: 'info' },
];

/**
 * Parse a leading slash command from a message.
 * @param {string} text
 * @returns {{ name: string, args: string }|null} null when not a command
 */
export function parseCommand(text) {
  const m = (text || '').trim().match(/^\/([a-z0-9_-]+)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2].trim() };
}

/**
 * Every available command in openclaw's commands.list entry shape:
 * built-ins plus user-invocable skills.
 * @param {import('./types.js').JsclawConfig} config
 * @returns {Array<Object>}
 */
export function listCommands(config) {
  const entries = BUILTIN_COMMANDS.map((c) => ({
    name: c.textAliases[0],
    textAliases: c.textAliases,
    description: c.description,
    category: c.category,
    source: 'native',
    scope: c.scope,
    acceptsArgs: c.acceptsArgs,
  }));
  for (const skill of loadSkills(config)) {
    if (!skill.userInvocable) continue;
    entries.push({
      name: `/${skill.name}`,
      textAliases: [`/${skill.name}`],
      description: skill.description,
      category: 'tools',
      source: 'skill',
      scope: 'both',
      acceptsArgs: true,
    });
  }
  return entries.slice(0, 500);
}

/**
 * Handle a message that may be a command.
 *
 * @param {string} text - The inbound message
 * @param {Object} ctx
 * @param {import('./types.js').JsclawConfig} ctx.config
 * @param {string} ctx.agentId
 * @param {string} [ctx.version]
 * @param {() => Promise<void>|void} [ctx.reset] - Surface-specific session reset
 * @returns {Promise<null | { reply: string } | { prompt: string }>}
 *   null: not a command (send to the agent unchanged).
 *   reply: host-handled — deliver this text, skip the agent.
 *   prompt: skill command — send this transformed prompt to the agent.
 */
export async function handleCommand(text, ctx) {
  const parsed = parseCommand(text);
  if (!parsed) return null;

  const alias = `/${parsed.name}`;
  const builtin = BUILTIN_COMMANDS.find((c) => c.textAliases.includes(alias));

  if (builtin) {
    switch (builtin.key) {
      case 'reset': {
        await ctx.reset?.();
        return { reply: 'Conversation cleared — next message starts fresh.' };
      }
      case 'status': {
        const skills = loadSkills(ctx.config);
        const parts = [
          `jsclaw${ctx.version ? ` v${ctx.version}` : ''}`,
          `agent: ${ctx.agentId}`,
          ctx.config.model ? `model: ${ctx.config.model}` : null,
          `skills: ${skills.length}`,
        ].filter(Boolean);
        return { reply: parts.join(' · ') };
      }
      case 'skills': {
        const skills = loadSkills(ctx.config);
        if (skills.length === 0) return { reply: 'No skills installed.' };
        return { reply: skills.map((s) => `${s.name}${s.userInvocable ? ` (/${s.name})` : ''} — ${s.description}`).join('\n') };
      }
      case 'help': {
        return { reply: listCommands(ctx.config).map((c) => `${c.name} — ${c.description}`).join('\n') };
      }
    }
  }

  // Skill bridge: /<name> force-invokes a user-invocable skill
  const skill = loadSkills(ctx.config).find((s) => s.userInvocable && s.name.toLowerCase() === parsed.name);
  if (skill) {
    const invocation = parsed.args || `The user invoked /${skill.name}.`;
    return { prompt: `${buildSkillContext([skill])}\n\n${invocation}` };
  }

  // Unknown slash command: be explicit rather than confusing the agent
  return { reply: `Unknown command: ${alias} — try /help` };
}
