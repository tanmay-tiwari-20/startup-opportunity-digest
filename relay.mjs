import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import makeWASocket, {
  BufferJSON, DisconnectReason, generateMessageIDV2, initAuthCreds,
  isJidBroadcast, isJidGroup, isJidNewsletter, jidNormalizedUser, proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

// One process owns this local service. It can only send to the linked account itself.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(path.resolve(process.env.DATA_DIR || ROOT), 'config');
const PORT = Number(process.env.WHATSAPP_RELAY_PORT || 18764);
const HOST = process.env.WHATSAPP_RELAY_BIND_HOST || '127.0.0.1';
const BODY_LIMIT = 256 * 1024;
const TEXT_LIMIT = 18000;
const SEND_TIMEOUT = 30000;
const MAGIC = Buffer.from('WADR1');
const logger = pino({ level: 'silent' });
const now = () => new Date().toISOString();
const log = (event) => process.stdout.write(`${now()} ${event}\n`);

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error('Invalid relay port');
}

async function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

// AES-GCM authenticates the file as well as encrypting it. A damaged existing
// store is an error, never an invitation to discard the linked account state.
class EncryptedStore {
  constructor(filename, key, initial) {
    this.filename = filename;
    this.key = key;
    this.data = initial;
    this.pending = Promise.resolve();
    this.failed = false;
  }
  async load() {
    let bytes;
    try { bytes = await fs.readFile(this.filename); }
    catch (error) {
      if (error.code === 'ENOENT') return this;
      throw error;
    }
    if (bytes.length < MAGIC.length + 12 + 16 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Invalid encrypted store');
    }
    const iv = bytes.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = bytes.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()]);
    this.data = JSON.parse(plain.toString('utf8'), BufferJSON.reviver);
    return this;
  }
  save() {
    // Capture at call time, then serialize durable writes in mutation order.
    const snapshot = JSON.stringify(this.data, BufferJSON.replacer);
    const operation = this.pending.then(async () => {
      if (this.failed) throw new Error('Store unavailable');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(MAGIC);
      const ciphertext = Buffer.concat([cipher.update(snapshot, 'utf8'), cipher.final()]);
      await atomicWrite(this.filename, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]));
    });
    this.pending = operation.catch(() => { this.failed = true; });
    return operation;
  }
}

let auth;
let outbox;
let controlToken;
let socket;
let connection = 'starting';
let qr;
let reconnectTimer;
let reconnectAttempts = 0;
let stopping = false;
let sendQueue = Promise.resolve();
let dispatchBusy = false;
const messageIndex = new Map();
const statusRank = { sending: 0, uncertain: 0, sent: 1, server_acknowledged: 2, delivered: 3, read: 4 };

function storageHealthy() { return Boolean(auth && outbox && !auth.failed && !outbox.failed); }
function failStorage() {
  connection = 'storage_error';
  qr = undefined;
  clearTimeout(reconnectTimer);
  socket?.end(new Error('Storage unavailable'));
  log('Storage unavailable; delivery stopped');
}
function ownJids() {
  const me = auth?.data.creds.me;
  return [me?.lid, me?.id].filter(Boolean).map(jidNormalizedUser);
}
function ownRecipient() {
  // Read the current creds object rather than a getter copied by a socket spread.
  const me = auth.data.creds.me;
  const identity = me?.lid || me?.id;
  if (!identity) throw new Error('Identity unavailable');
  const jid = jidNormalizedUser(identity);
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) {
    throw new Error('Invalid self identity');
  }
  return jid;
}
function isOwnJid(jid) {
  return Boolean(jid && ownJids().includes(jidNormalizedUser(jid)));
}
function publicEntry(entry) {
  return {
    digestId: entry.digestId,
    status: ['sent', 'server_acknowledged'].includes(entry.status) ? 'accepted' : entry.status,
    whatsappStatus: entry.status,
    messageId: entry.messageId,
    updatedAt: entry.updatedAt,
    deliveryConfirmed: ['delivered', 'read'].includes(entry.status),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}
async function saveOutbox() {
  try { await outbox.save(); }
  catch { failStorage(); throw new Error('Storage unavailable'); }
}
async function trackStatuses(updates) {
  let changed = false;
  for (const { key, update } of updates) {
    // Ignore every event except a message ID reserved by this relay to itself.
    const digestId = key?.id && messageIndex.get(key.id);
    if (!digestId || key.fromMe === false || !isOwnJid(key.remoteJid)) continue;
    const entry = outbox.data.entries[digestId];
    const code = Number(update?.status);
    const next = code === 2 ? 'server_acknowledged' : code === 3 ? 'delivered' : [4, 5].includes(code) ? 'read' : undefined;
    if (next && statusRank[next] > statusRank[entry.status]) {
      entry.status = next;
      entry.reason = undefined;
      entry.updatedAt = now();
      changed = true;
    } else if (code === 0 && statusRank[entry.status] < 2) {
      entry.status = 'uncertain';
      entry.reason = 'WhatsApp reported an error; inspect the self chat before any manual resend';
      entry.updatedAt = now();
      changed = true;
    }
  }
  if (changed) await saveOutbox();
}

function scheduleReconnect(code) {
  if (stopping || !storageHealthy() || reconnectTimer) return;
  if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
    connection = 'needs_pairing';
    qr = undefined;
    log('WhatsApp session needs manual re-pairing');
    return;
  }
  if (++reconnectAttempts > 20) {
    connection = 'reconnect_stopped';
    log('Reconnect limit reached; restart the relay to try again');
    return;
  }
  const delay = code === DisconnectReason.restartRequired
    ? 500 : Math.min(60000, 1000 * (2 ** Math.min(reconnectAttempts - 1, 6)));
  connection = 'reconnecting';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWhatsApp();
  }, delay);
}

function connectWhatsApp() {
  if (stopping || !storageHealthy()) return;
  connection = 'connecting';
  qr = undefined;
  let active;
  try {
    const state = {
      creds: auth.data.creds,
      keys: {
        async get(type, ids) {
          const values = {};
          const category = auth.data.keys[type] || {};
          for (const id of ids) {
            let value = Object.hasOwn(category, id) ? category[id] : null;
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            values[id] = value;
          }
          return values;
        },
        async set(updates) {
          for (const [type, changes] of Object.entries(updates)) {
            const category = auth.data.keys[type] ||= Object.create(null);
            for (const [id, value] of Object.entries(changes)) {
              if (value == null) delete category[id];
              else Object.defineProperty(category, id, { value, writable: true, enumerable: true, configurable: true });
            }
          }
          try { await auth.save(); }
          catch { failStorage(); throw new Error('Auth storage unavailable'); }
        },
      },
    };
    active = makeWASocket({
      auth: state,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      emitOwnEvents: true,
      // Keep default initial synchronization for the PN/LID mappings.
      shouldIgnoreJid: (jid) => isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid),
      getMessage: async (key) => {
        const digestId = key?.id && messageIndex.get(key.id);
        if (!digestId || key.fromMe === false || !isOwnJid(key.remoteJid)) return undefined;
        return outbox.data.entries[digestId].message;
      },
    });
    socket = active;
  } catch {
    log('WhatsApp connection could not start');
    scheduleReconnect();
    return;
  }
  active.ev.on('creds.update', (update) => {
    Object.assign(auth.data.creds, update);
    auth.save().catch(failStorage);
  });
  active.ev.on('connection.update', (update) => {
    if (active !== socket || stopping || !storageHealthy()) return;
    if (update.qr) { qr = update.qr; connection = 'awaiting_scan'; }
    if (update.connection === 'open') {
      qr = undefined;
      connection = 'open';
      reconnectAttempts = 0;
      log('WhatsApp connected');
    }
    if (update.connection === 'close') {
      qr = undefined;
      const code = update.lastDisconnect?.error?.output?.statusCode;
      scheduleReconnect(code);
    }
  });
  active.ev.on('messages.update', (updates) => {
    trackStatuses(updates).catch(() => {});
  });
  active.ev.on('messages.upsert', ({ messages }) => {
    let changed = false;
    for (const message of messages) {
      const digestId = message.key?.id && messageIndex.get(message.key.id);
      if (!digestId || !message.key.fromMe || !isOwnJid(message.key.remoteJid)) continue;
      if (message.message) { outbox.data.entries[digestId].message = message.message; changed = true; }
    }
    if (changed) saveOutbox().catch(() => {});
  });
}

class RequestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function validateDigest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Expected a JSON object');
  if (Object.keys(body).some((key) => !['digestId', 'text'].includes(key))) {
    throw new RequestError(400, 'Only digestId and text are allowed; recipients cannot be supplied');
  }
  if (typeof body.digestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.digestId)) {
    throw new RequestError(400, 'Invalid digestId');
  }
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > TEXT_LIMIT || body.text.includes('\u0000')) {
    throw new RequestError(400, `text must contain 1 to ${TEXT_LIMIT} characters`);
  }
}
async function deliverDigest(body) {
  validateDigest(body);
  const hash = createHash('sha256').update(body.text, 'utf8').digest('hex');
  const previous = Object.hasOwn(outbox.data.entries, body.digestId) && outbox.data.entries[body.digestId];
  if (previous) {
    if (previous.hash !== hash) throw new RequestError(409, 'digestId already exists with different text');
    return { ...publicEntry(previous), duplicate: true };
  }
  if (!storageHealthy()) throw new RequestError(503, 'Storage unavailable');
  if (connection !== 'open' || !socket) throw new RequestError(503, 'WhatsApp is not connected');
  if (dispatchBusy) throw new RequestError(503, 'A previous send is still awaiting its outcome');
  const recipient = ownRecipient();
  const active = socket;
  const entry = {
    digestId: body.digestId, hash, status: 'sending', createdAt: now(), updatedAt: now(),
    messageId: generateMessageIDV2(auth.data.creds.me.id),
    message: { conversation: body.text },
  };
  Object.defineProperty(outbox.data.entries, body.digestId, { value: entry, writable: true, enumerable: true, configurable: true });
  messageIndex.set(entry.messageId, body.digestId);
  await saveOutbox(); // Reserve durably before anything may leave the process.
  if (active !== socket || connection !== 'open') {
    entry.status = 'uncertain';
    entry.reason = 'Connection changed before dispatch; this digest remains reserved to avoid duplicate delivery';
    entry.updatedAt = now();
    await saveOutbox();
    return publicEntry(entry);
  }
  let timeout;
  dispatchBusy = true;
  const send = (async () => {
    try {
      const message = await active.sendMessage(recipient, { text: body.text }, { messageId: entry.messageId });
      if (!message?.key?.id || message.key.id !== entry.messageId) throw new Error('Unconfirmed send');
      entry.message = message.message || entry.message;
      if (statusRank[entry.status] < 1) entry.status = 'sent';
      entry.reason = undefined;
    } catch {
      if (statusRank[entry.status] < 2) {
        entry.status = 'uncertain';
        entry.reason = 'Send outcome is unknown; inspect the WhatsApp self chat before any manual resend';
      }
    }
    entry.updatedAt = now();
    await saveOutbox();
    return publicEntry(entry);
  })().finally(() => { dispatchBusy = false; });
  try {
    return await Promise.race([
      send,
      new Promise((resolve, reject) => {
        timeout = setTimeout(async () => {
          try {
            if (statusRank[entry.status] < 1) {
              entry.status = 'uncertain';
              entry.reason = 'Send timed out; it may still complete. This digest will not be retried automatically';
              entry.updatedAt = now();
              await saveOutbox();
            }
            resolve(publicEntry(entry));
          } catch (error) { reject(error); }
        }, SEND_TIMEOUT);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    // Observe a late rejection; a late successful result updates this same ledger.
    send.catch(() => {});
  }
}
function enqueueDigest(body) {
  const result = sendQueue.then(() => deliverDigest(body));
  sendQueue = result.catch(() => {});
  return result;
}

function secureLocalRequest(req) {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host)) throw new RequestError(403, 'Local host required');
  if (req.headers.origin && !hosts.some((host) => req.headers.origin === `http://${host}`)) {
    throw new RequestError(403, 'Cross-origin requests are not allowed');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Cross-site requests are not allowed');
}
function authenticate(req) {
  const expected = Buffer.from(`Bearer ${controlToken}`);
  const received = Buffer.from(req.headers.authorization || '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new RequestError(401, 'Authentication required');
  }
}
async function readJSON(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new RequestError(415, 'application/json is required');
  }
  if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) {
    req.resume();
    throw new RequestError(413, 'Request body is too large');
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) throw new RequestError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON'); }
}
function respond(res, code, value, type = 'application/json; charset=utf-8') {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
const server = http.createServer(async (req, res) => {
  try {
    secureLocalRequest(req);
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      const entries = Object.values(outbox.data.entries);
      const last = entries.at(-1);
      respond(res, storageHealthy() ? 200 : 503, {
        service: 'private-startup-digest-relay',
        ok: storageHealthy(), connection, connected: connection === 'open', qrAvailable: Boolean(qr),
        delivery: { lastStatus: last?.status || null, deliveryConfirmed: last ? ['delivered', 'read'].includes(last.status) : false },
      });
    } else if (req.method === 'POST' && url.pathname === '/shutdown') {
      authenticate(req);
      respond(res, 200, { status: 'stopping' });
      setImmediate(() => { shutdown().catch(() => process.exit(1)); });
    } else if (req.method === 'GET' && url.pathname === '/status') {
      authenticate(req);
      const digestId = url.searchParams.get('digestId');
      if (!digestId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(digestId)) {
        throw new RequestError(400, 'Invalid digestId');
      }
      const entry = Object.hasOwn(outbox.data.entries, digestId) && outbox.data.entries[digestId];
      if (!entry) throw new RequestError(404, 'Digest has not been reserved or sent');
      respond(res, 200, publicEntry(entry));
    } else if (req.method === 'GET' && url.pathname === '/api/qr') {
      respond(res, 200, { qrAvailable: Boolean(qr), connection });
    } else if (req.method === 'GET' && url.pathname === '/qr.png') {
      if (!qr) throw new RequestError(404, 'No pairing QR is available');
      const bytes = await QRCode.toBuffer(qr, { type: 'png', width: 320, margin: 2 });
      respond(res, 200, bytes, 'image/png');
    } else if (req.method === 'GET' && url.pathname === '/') {
      respond(res, 200, await fs.readFile(path.join(ROOT, 'ui.html')), 'text/html; charset=utf-8');
    } else if (req.method === 'POST' && url.pathname === '/send') {
      authenticate(req);
      const result = await enqueueDigest(await readJSON(req));
      respond(res, ['uncertain', 'sending'].includes(result.status) ? 202 : 200, result);
    } else {
      throw new RequestError(404, 'Endpoint not found');
    }
  } catch (error) {
    respond(res, error instanceof RequestError ? error.code : 503, {
      error: error instanceof RequestError ? error.message : 'Relay operation unavailable',
    });
  }
});
server.requestTimeout = 20000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  connection = 'stopping';
  qr = undefined;
  clearTimeout(reconnectTimer);
  server.close();
  socket?.end(new Error('Relay stopping'));
  const deadline = setTimeout(() => process.exit(exitCode), 5000);
  deadline.unref();
  await Promise.allSettled([auth?.pending, outbox?.pending, sendQueue]);
  process.exit(exitCode);
}
process.on('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
// Never dump a third-party exception object: it can contain account identifiers.
process.on('unhandledRejection', () => {
  log('Unhandled relay operation; stopping');
  shutdown(1).catch(() => process.exit(1));
});
process.on('uncaughtException', () => {
  log('Unexpected relay error; stopping');
  shutdown(1).catch(() => process.exit(1));
});

async function main() {
  const key = await fs.readFile(path.join(CONFIG, 'auth-key.bin'));
  if (key.length !== 32) throw new Error('Auth key must contain 32 bytes');
  controlToken = (await fs.readFile(path.join(CONFIG, 'control-token.txt'), 'utf8')).trim();
  if (controlToken.length < 32 || /\s/.test(controlToken)) throw new Error('Invalid control token');
  auth = await new EncryptedStore(path.join(CONFIG, 'auth-state.enc'), key, { version: 1, creds: initAuthCreds(), keys: {} }).load();
  outbox = await new EncryptedStore(path.join(CONFIG, 'outbox.enc'), key, { version: 1, entries: {} }).load();
  if (auth.data.version !== 1 || !auth.data.creds || !auth.data.keys || outbox.data.version !== 1 || !outbox.data.entries) {
    throw new Error('Invalid store schema');
  }
  for (const entry of Object.values(outbox.data.entries)) {
    if (entry.messageId) messageIndex.set(entry.messageId, entry.digestId);
    if (entry.status === 'sending') {
      entry.status = 'uncertain';
      entry.reason = 'Relay restarted during a send; inspect the self chat before any manual resend';
      entry.updatedAt = now();
    }
  }
  await Promise.all([auth.save(), outbox.save()]);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  server.on('error', () => { log('Local HTTP service error'); });
  log('Local relay started');
  connectWhatsApp();
}

main().catch(() => {
  log('Relay startup failed; check configuration, encrypted stores, and local port');
  process.exitCode = 1;
  server.close();
});
