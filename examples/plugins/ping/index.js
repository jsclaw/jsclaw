/**
 * Demo plugin — the living documentation of the plugin contract (#64).
 *
 * Enable it:
 *   { "plugins": { "load": { "paths": ["./node_modules/jsclaw/examples/plugins/ping"] } } }
 */

export function activate(api) {
  // A slash command, host-handled on every surface
  api.registerCommand(
    { key: 'ping', description: 'Plugin demo — replies pong', textAliases: ['/ping'], acceptsArgs: true, scope: 'both', category: 'info' },
    async (args) => ({ reply: args ? `pong: ${args}` : 'pong 🏓' }),
  );

  // A gateway WebSocket method
  api.registerGatewayMethod('ping.echo', (params) => ({ echo: params?.text ?? 'pong', from: 'ping plugin' }));

  // An MCP tool (string returns are wrapped as text content)
  api.registerMcpTool('ping', {
    description: 'Plugin demo — returns pong',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    handler: async (args) => `pong${args?.text ? `: ${args.text}` : ''}`,
  });

  api.logger.info?.(`ping plugin active (config: ${JSON.stringify(api.config)})`);
}
