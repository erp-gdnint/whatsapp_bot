// The API Frappe calls to send WhatsApp messages. Frappe must call it from server-side
// Python with the shared token, so the token never reaches a browser.
//
//   POST /api/frappe/notify
//   Authorization: Bearer <FRAPPE_TO_BOT_TOKEN>
//
// Template (works for anyone, even if they never chatted with the bot):
//   { "to": "919876543210", "template": "ticket_assigned", "language": "en", "params": ["...", "..."] }
// Text (reaches only people who messaged the bot in the last 24 hours):
//   { "to": ["919876543210", "919811111111"], "text": "..." }

const crypto = require('crypto');
const express = require('express');
const { cleanText, cleanParam } = require('./clean');
const { readFrappeConfig } = require('./frappe');

const MAX_RECIPIENTS = 10;
const MAX_PARAMS = 10;
const MAX_SENDS_PER_MINUTE = 60;

const sha = (text) => crypto.createHash('sha256').update(text).digest();
const mask = (phone) => `***${String(phone).slice(-4)}`;

// Turns the request body into { recipients, message }, or returns { error }.
function parseNotify(body) {
  const recipients = [].concat(body.to ?? []).map((n) => String(n).replace(/^\+/, ''));
  if (!recipients.length || recipients.length > MAX_RECIPIENTS)
    return { error: `"to" must have 1 to ${MAX_RECIPIENTS} numbers` };
  if (!recipients.every((n) => /^\d{7,15}$/.test(n)))
    return { error: '"to" must be digits with country code, like 919876543210' };
  if (Boolean(body.template) === Boolean(body.text)) return { error: 'Send either "template" or "text"' };

  if (body.text) {
    const text = cleanText(body.text, 4096);
    return text ? { recipients, message: { type: 'text', text } } : { error: '"text" is empty' };
  }

  const allowed = readFrappeConfig().allowedTemplates || [];
  if (!allowed.includes(body.template)) return { error: `Template "${body.template}" is not allowed` };
  const language = body.language ?? 'en';
  if (!/^[a-zA-Z_]{2,10}$/.test(language)) return { error: '"language" is not valid' };
  const params = body.params ?? [];
  if (!Array.isArray(params) || params.length > MAX_PARAMS)
    return { error: `"params" must be a list of up to ${MAX_PARAMS} values` };
  return {
    recipients,
    message: { type: 'template', name: body.template, language, params: params.map((p) => cleanParam(p)) },
  };
}

function createFrappeRouter({ token, wa, logger = console }) {
  const router = express.Router();
  const wanted = sha(`Bearer ${token}`);
  let windowStart = 0;
  let sends = 0;

  // Hashing gives both values the same length, which timingSafeEqual needs.
  router.use((req, res, next) => {
    if (crypto.timingSafeEqual(sha(req.get('authorization') || ''), wanted)) return next();
    logger.warn(`Rejected Frappe API call with a bad token: ${req.method} ${req.path}`);
    res.status(401).json({ ok: false, error: 'Unauthorized' });
  });

  router.post('/notify', async (req, res) => {
    let parsed;
    try {
      parsed = parseNotify(req.body || {});
    } catch (err) {
      logger.error('Notify failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Bot configuration error' });
    }
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

    const now = Date.now();
    if (now - windowStart > 60000) {
      windowStart = now;
      sends = 0;
    }
    if (sends + parsed.recipients.length > MAX_SENDS_PER_MINUTE)
      return res.status(429).json({ ok: false, error: 'Too many messages, try again in a minute' });
    sends += parsed.recipients.length;

    const results = [];
    for (const to of parsed.recipients) {
      try {
        results.push({ to, ok: true, message_id: await wa.send(to, parsed.message) });
        logger.log(`-> ${mask(to)} ${parsed.message.type} sent for Frappe`);
      } catch (err) {
        logger.error(`Notify to ${mask(to)} failed:`, err.message);
        results.push({ to, ok: false, error: err.message.slice(0, 300) });
      }
    }
    const ok = results.every((r) => r.ok);
    res.status(ok ? 200 : 502).json({ ok, message_id: results[0].message_id, results });
  });

  return router;
}

module.exports = { createFrappeRouter, parseNotify };
