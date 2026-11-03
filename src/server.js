require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { loadFlow } = require('./flow');
const { FlowEngine } = require('./engine');
const { MemoryStore } = require('./store');
const { createWhatsAppClient, parseIncoming } = require('./whatsapp');
const actions = require('./actions');

const env = process.env;
for (const key of ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN']) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env (see .env.example)`);
    process.exit(1);
  }
}
if (!env.APP_SECRET) console.warn('APP_SECRET not set: webhook signatures are NOT being checked.');

const flow = loadFlow(env.FLOW_FILE || 'flows/faq.json', actions);
const engine = new FlowEngine({
  flow,
  actions,
  store: new MemoryStore({ ttlMinutes: Number(env.SESSION_TTL_MINUTES) || 30 }),
});
const wa = createWhatsAppClient({
  token: env.WHATSAPP_TOKEN,
  phoneNumberId: env.PHONE_NUMBER_ID,
  version: env.GRAPH_API_VERSION || 'v23.0',
});

const mask = (phone) => `***${String(phone).slice(-4)}`;

// Meta retries webhooks, so the same message can arrive twice. Remember recent ids.
const seen = new Set();
const isDuplicate = (id) => {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
};

// Handle each user's messages one at a time, so fast taps don't race.
const queues = new Map();
const enqueue = (userId, task) => {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  queues.set(userId, next);
};

function signatureIsValid(req) {
  if (!env.APP_SECRET) return true;
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', env.APP_SECRET).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

app.get('/', (_req, res) => res.send(`WhatsApp bot running: ${flow.name || 'flow'}`));

// Meta calls this once when you save the Callback URL.
app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.VERIFY_TOKEN;
  if (ok) {
    console.log('Webhook verified by Meta');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Meta calls this for every incoming message and status update.
app.post('/webhook', (req, res) => {
  if (!signatureIsValid(req)) {
    console.warn('Rejected webhook with bad signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast, then process; slow answers make Meta retry

  for (const { from, messageId, incoming } of parseIncoming(req.body)) {
    if (isDuplicate(messageId)) continue;
    enqueue(from, async () => {
      try {
        console.log(`<- ${mask(from)}`, incoming.kind === 'text' ? `"${incoming.text}"` : incoming.kind, incoming.id || '');
        wa.markRead(messageId);
        const replies = await engine.handle(from, incoming);
        await wa.sendAll(from, replies);
        console.log(`-> ${mask(from)} ${replies.length} message(s)`);
      } catch (err) {
        console.error(`Error handling message from ${mask(from)}:`, err.message);
      }
    });
  }
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`Bot listening on http://localhost:${port}  (webhook path: /webhook)`));
