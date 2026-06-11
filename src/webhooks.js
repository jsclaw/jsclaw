/**
 * Webhook ingress — HTTP endpoints that turn external events into agent
 * messages. API-compatible with openclaw's shape: POST /webhook/<path>,
 * X-Webhook-Secret header auth, {{body.field}} template variables.
 * Zero dependencies (node:http).
 * @module webhooks
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createConfig } from './config.js';

/**
 * @typedef {Object} WebhookEndpoint
 * @property {string} path - URL path under /webhook/ (e.g. '/deploy-alert')
 * @property {string} message - Message template; {{body}} and {{body.x.y}} are substituted
 * @property {string} [groupFolder] - Group whose agent should handle the message
 * @property {string} [chatJid] - Chat to attribute the message to
 */

/**
 * Render a {{body.field}} template against a parsed JSON body.
 * {{body}} inserts the whole body as JSON.
 * Unknown paths render as an empty string.
 * @param {string} template
 * @param {*} body
 * @returns {string}
 */
export function renderTemplate(template, body) {
  return template.replace(/\{\{\s*body((?:\.[\w-]+)*)\s*\}\}/g, (_, pathStr) => {
    if (!pathStr) {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
    let value = body;
    for (const key of pathStr.slice(1).split('.')) {
      if (value == null || typeof value !== 'object') return '';
      value = value[key];
    }
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/**
 * Constant-time secret comparison.
 * @param {string|undefined} provided
 * @param {string} expected
 * @returns {boolean}
 */
function secretMatches(provided, expected) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @typedef {Object} WebhookIngressOptions
 * @property {WebhookEndpoint[]} endpoints
 * @property {string} [secret] - Required X-Webhook-Secret value; if unset, no auth (loopback use only)
 * @property {number} [port] - Listen port (default 18789, openclaw's gateway port)
 * @property {string} [host] - Bind address (default 127.0.0.1; do not bind 0.0.0.0 without auth)
 * @property {number} [maxBodyBytes] - Reject larger payloads (default 1 MiB)
 * @property {(message: string, endpoint: WebhookEndpoint, body: *) => Promise<void>} onMessage
 *   Receives the rendered message — enqueue it, run an agent, etc.
 */

/**
 * Start the webhook ingress server.
 *
 * @param {WebhookIngressOptions} options
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
export function startWebhookIngress(options, config) {
  config = config || createConfig();
  const log = config.logger;
  const {
    endpoints = [],
    secret,
    port = 18789,
    host = '127.0.0.1',
    maxBodyBytes = 1024 * 1024,
    onMessage,
  } = options;

  if (typeof onMessage !== 'function') {
    throw new Error('startWebhookIngress requires an onMessage handler');
  }

  const byPath = new Map(
    endpoints.map((e) => [e.path.startsWith('/') ? e.path : `/${e.path}`, e])
  );

  const server = createServer((req, res) => {
    const respond = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== 'POST' || !req.url?.startsWith('/webhook/')) {
      return respond(404, { error: 'not found' });
    }

    const path = req.url.slice('/webhook'.length).split('?')[0];
    const endpoint = byPath.get(path);
    if (!endpoint) {
      return respond(404, { error: 'unknown webhook' });
    }

    if (secret && !secretMatches(req.headers['x-webhook-secret'], secret)) {
      log.warn('Webhook rejected: bad secret', { path });
      return respond(401, { error: 'unauthorized' });
    }

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        respond(413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (res.writableEnded) return;
      let body = Buffer.concat(chunks).toString('utf-8');
      try {
        body = body ? JSON.parse(body) : {};
      } catch {
        // keep raw string body; {{body}} still works
      }

      const message = renderTemplate(endpoint.message, body);
      try {
        await onMessage(message, endpoint, body);
        respond(200, { ok: true });
      } catch (err) {
        log.error('Webhook handler failed', { path, error: err.message });
        respond(500, { error: 'handler failed' });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`Webhook ingress listening on ${host}:${port}`);
      resolve({
        port,
        stop: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --- Egress ---

/**
 * @typedef {Object} OutgoingWebhook
 * @property {string} event - Event name to deliver, or '*' for all
 * @property {string} url - Destination URL
 * @property {Record<string, string>} [headers] - Extra headers; ${ENV_VAR} is expanded
 * @property {{ channel?: string, groupFolder?: string }} [filter] - Only deliver when payload fields match
 */

/**
 * Expand ${ENV_VAR} references in a header value.
 * @param {string} value
 * @returns {string}
 */
function expandEnv(value) {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * Create an outgoing-webhook emitter — openclaw's shape:
 * events like 'agent.task.completed', 'agent.error',
 * 'channel.message.received' delivered as JSON POSTs.
 *
 * @param {OutgoingWebhook[]} outgoing
 * @param {import('./types.js').JsclawConfig} [config]
 * @returns {(event: string, payload?: Object) => Promise<number>}
 *   emit(event, payload) — resolves to the number of successful deliveries
 */
export function createWebhookEmitter(outgoing, config) {
  config = config || createConfig();
  const log = config.logger;
  const hooks = outgoing || [];

  return async function emit(event, payload = {}) {
    const matching = hooks.filter((h) => {
      if (h.event !== '*' && h.event !== event) return false;
      const filter = h.filter || {};
      return Object.entries(filter).every(([k, v]) => payload[k] === v);
    });

    let delivered = 0;
    await Promise.all(
      matching.map(async (hook) => {
        const headers = { 'Content-Type': 'application/json' };
        for (const [k, v] of Object.entries(hook.headers || {})) {
          headers[k] = expandEnv(v);
        }
        try {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ event, payload, timestamp: new Date().toISOString() }),
          });
          if (res.ok) {
            delivered++;
          } else {
            log.warn(`Webhook egress non-OK response`, { event, url: hook.url, status: res.status });
          }
        } catch (err) {
          log.warn(`Webhook egress failed`, { event, url: hook.url, error: err.message });
        }
      })
    );
    return delivered;
  };
}
