/**
 * Plugin loader — openclaw's config shape over jsclaw's existing seams
 * (#64). A plugin is a directory with jsclaw.plugin.json
 * ({ id, version, entry, description? }) whose entry module exports
 * activate(api). Plugins extend the GATEWAY (channels, commands,
 * gateway methods, MCP tools); agent capabilities are MCP's job.
 *
 * Config (openclaw's field names):
 *   plugins: {
 *     enabled: true,
 *     allow: [...], deny: [...],        // deny > allow > entry.enabled
 *     load: { paths: ["./my-plugin"] },
 *     entries: { "<id>": { enabled: true, config: {...} } }
 *   }
 * @module plugins
 */

import { readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

function resolvePluginDir(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/**
 * @typedef {Object} PluginRegistrations
 * @property {Record<string, Function>} channels - name -> channel factory
 * @property {Array} commands - command specs with handlers
 * @property {Record<string, Function>} gatewayMethods - method -> handler(params, ctx)
 * @property {Record<string, Object>} mcpTools - name -> { description, inputSchema, handler }
 */

/**
 * Load every enabled plugin from config.plugins.load.paths.
 *
 * @param {import('./types.js').JsclawConfig} config
 * @param {{ logger?: Object }} [opts]
 * @returns {Promise<{ registrations: PluginRegistrations, plugins: Array<{ id: string, version?: string, path: string }> }>}
 */
export async function loadPlugins(config, opts = {}) {
  const log = opts.logger || config.logger || console;
  const registrations = { channels: {}, commands: [], gatewayMethods: {}, mcpTools: {} };
  const plugins = [];

  const pc = config.plugins;
  if (!pc || pc.enabled === false) return { registrations, plugins };

  for (const rawPath of pc.load?.paths || []) {
    const dir = resolvePluginDir(rawPath);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'jsclaw.plugin.json'), 'utf-8'));
      const { id, entry } = manifest;
      if (!id || !entry) throw new Error('manifest requires id and entry');

      // Policy: deny > allow > per-entry enabled (openclaw semantics)
      if (Array.isArray(pc.deny) && pc.deny.includes(id)) {
        log.warn?.(`plugin ${id} denied by plugins.deny — skipped`);
        continue;
      }
      if (Array.isArray(pc.allow) && !pc.allow.includes(id)) {
        log.warn?.(`plugin ${id} not in plugins.allow — skipped`);
        continue;
      }
      if (pc.entries?.[id]?.enabled === false) continue;

      const mod = await import(pathToFileURL(join(dir, entry)).href);
      if (typeof mod.activate !== 'function') throw new Error('entry must export activate(api)');

      const api = {
        config: pc.entries?.[id]?.config || {},
        logger: log,
        registerChannel(name, factory) {
          registrations.channels[name] = factory;
        },
        registerCommand(spec, handler) {
          registrations.commands.push({ ...spec, source: `plugin:${id}`, handler });
        },
        registerGatewayMethod(name, handler) {
          registrations.gatewayMethods[name] = handler;
        },
        registerMcpTool(name, tool) {
          registrations.mcpTools[name] = tool;
        },
      };

      await mod.activate(api);
      plugins.push({ id, version: manifest.version, path: dir });
    } catch (err) {
      log.warn?.(`plugin at ${rawPath} failed to load: ${err.message} — skipped`);
    }
  }

  return { registrations, plugins };
}
