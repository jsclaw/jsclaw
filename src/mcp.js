/**
 * MCP server envelope — Streamable HTTP transport, JSS's stateless
 * style (#73): JSON-RPC 2.0 over a single POST endpoint, single-shot
 * JSON responses, no session header. Spec 2025-03-26.
 *
 * This module is the protocol layer only; the gateway supplies the
 * tool table (which delegates to its existing method dispatch).
 * @module mcp
 */

export const MCP_PROTOCOL_VERSION = '2025-03-26';

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function toolText(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: false };
}

export function toolJson(value) {
  return toolText(JSON.stringify(value, null, 2));
}

export function toolError(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

/**
 * Build an MCP request handler over a tool table.
 *
 * @param {Object} options
 * @param {{ name: string, version: string }} options.serverInfo
 * @param {Record<string, { description: string, inputSchema: Object, handler: (args: Object) => Promise<Object> }>} options.tools
 * @returns {(msg: Object) => Promise<Object|null>} JSON-RPC response, or
 *   null for notifications (transport answers 202 with no body)
 */
export function createMcpHandler({ serverInfo, tools }) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg?.id ?? null, RPC_ERRORS.INVALID_REQUEST, 'expected a JSON-RPC 2.0 request');
    }
    const { id, method, params } = msg;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo,
          capabilities: { tools: { listChanged: false } },
        });

      case 'initialized':
      case 'notifications/initialized':
        return null;

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const name = params?.name;
        const tool = name && tools[name];
        if (!tool) return rpcError(id, RPC_ERRORS.INVALID_PARAMS, `unknown tool: ${name}`);
        try {
          return rpcResult(id, await tool.handler(params?.arguments || {}));
        } catch (err) {
          return rpcResult(id, toolError(err.message));
        }
      }

      default:
        return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  };
}
