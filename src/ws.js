/**
 * Minimal RFC 6455 WebSocket server. Zero dependencies.
 *
 * Server-side only: performs the upgrade handshake, decodes masked
 * client frames (with fragmentation), encodes unmasked server frames,
 * answers pings, enforces a payload cap. Text frames only — JSON wire
 * protocols don't need binary.
 * @module ws
 */

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * Compute the Sec-WebSocket-Accept value for a handshake key.
 * @param {string} key
 * @returns {string}
 */
export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * Encode a server→client frame (unmasked, FIN set).
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Attach a WebSocket connection to an already-upgraded socket.
 *
 * @param {import('node:net').Socket} socket
 * @param {Object} handlers
 * @param {(text: string) => void} handlers.onMessage - Complete text message received
 * @param {() => void} [handlers.onClose]
 * @param {number} [handlers.maxPayload] - Per-message cap in bytes (default 1 MiB)
 * @param {Buffer} [head] - Bytes received with the upgrade request
 * @returns {{ send: (text: string) => void, close: (code?: number) => void }}
 */
export function attachWebSocket(socket, handlers, head) {
  const { onMessage, onClose, maxPayload = 1024 * 1024 } = handlers;

  let buf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragmentedOp = null;
  let closed = false;

  function send(text) {
    if (closed || socket.destroyed) return;
    socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf-8')));
  }

  function close(code = 1000) {
    if (closed) return;
    closed = true;
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      socket.write(encodeFrame(OP_CLOSE, body));
    } catch {
      // socket already gone
    }
    socket.end();
    onClose?.();
  }

  function fail(code) {
    close(code);
    socket.destroy();
  }

  /** Try to consume one complete frame from buf. Returns false if more bytes are needed. */
  function consumeFrame() {
    if (buf.length < 2) return false;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return false;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(maxPayload)) { fail(1009); return false; }
      len = Number(big);
      offset += 8;
    }

    if (len > maxPayload) { fail(1009); return false; }
    // RFC 6455 §5.1: client frames MUST be masked
    if (!masked) { fail(1002); return false; }
    if (buf.length < offset + 4 + len) return false;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      payload[i] = buf[offset + i] ^ mask[i & 3];
    }
    buf = buf.subarray(offset + len);

    switch (opcode) {
      case OP_TEXT:
      case OP_CONT: {
        if (opcode === OP_TEXT) {
          fragments = [payload];
          fragmentedOp = OP_TEXT;
        } else {
          if (fragmentedOp === null) { fail(1002); return false; }
          fragments.push(payload);
        }
        const total = fragments.reduce((n, f) => n + f.length, 0);
        if (total > maxPayload) { fail(1009); return false; }
        if (fin) {
          const text = Buffer.concat(fragments).toString('utf-8');
          fragments = [];
          fragmentedOp = null;
          onMessage(text);
        }
        break;
      }
      case OP_PING:
        socket.write(encodeFrame(OP_PONG, payload));
        break;
      case OP_PONG:
        break;
      case OP_CLOSE:
        close(1000);
        return false;
      default:
        fail(1003);
        return false;
    }
    return true;
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      while (consumeFrame()) { /* drain */ }
    } catch {
      fail(1002);
    }
  });

  socket.on('close', () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });
  socket.on('error', () => socket.destroy());

  // Drain any bytes that arrived with the upgrade
  if (buf.length > 0) {
    try {
      while (consumeFrame()) { /* drain */ }
    } catch {
      fail(1002);
    }
  }

  return { send, close };
}
