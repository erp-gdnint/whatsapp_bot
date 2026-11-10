// Actions are where the bot talks to the outside world (your APIs, a database,
// a Google Sheet, a CRM). A flow node { "type": "action", "action": "<name>" }
// calls the function with that name here.
//
// Each action receives { userId, vars, params } and may return an object;
// its fields are merged into the user's vars, so later messages can use them
// as {{fieldName}}. Throwing an error sends the user to the node's "onError"
// (or a generic error message).

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { cleanText } = require('../clean');
const { createWaRequest, frappeHeaders } = require('../frappe');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_DESK = 'WA-Ticket';
const REFERENCE_ATTEMPTS = 3;
const TICKET_VARS = ['ticket_desk', 'ticket_type', 'ticket_message', 'contact_email', 'callback_phone', 'callback_date', 'callback_time'];

// Exactly 10 digits, never a leading zero, so number fields and Excel cannot shorten it.
const newReferenceId = () => String(crypto.randomInt(1_000_000_000, 10_000_000_000));

// One JSON object per line. Appending keeps earlier tickets safe if the bot stops mid-write.
async function saveFailedTicket(ticket, err) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const row = { at: new Date().toISOString(), error: String(err.message).slice(0, 300), ticket };
  await fs.appendFile(path.join(DATA_DIR, 'failed-tickets.jsonl'), JSON.stringify(row) + '\n');
  console.error(`Ticket ${ticket.reference_id} NOT saved in Frappe, stored in data/failed-tickets.jsonl: ${row.error}`);
}

// Same {{name}} filling as the engine uses for message text.
const fill = (text, vars) =>
  String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? '').toString());

const MAIL_CONFIG = path.join(__dirname, '..', '..', 'config', 'mail.json');

// Read on every call, so edits to config/mail.json apply without a restart.
function readMailConfig() {
  try {
    return JSON.parse(require('fs').readFileSync(MAIL_CONFIG, 'utf8'));
  } catch (err) {
    throw new Error(`sendMail: cannot read config/mail.json: ${err.message}`);
  }
}

// Builds the JSON body for Frappe from config.payload, filling {{placeholders}}.
// Empty values are left out, so optional arguments of the Frappe method keep their defaults.
function buildMailPayload({ userId, vars, params }) {
  const config = readMailConfig();
  const base = { ...vars, user_phone: userId };
  const filled = {};
  for (const [k, v] of Object.entries(params || {})) filled[k] = typeof v === 'string' ? fill(v, base) : v;
  if (!filled.to) filled.to = config.defaultTo || '';
  const all = { ...base, ...filled };

  const payload = {};
  for (const [key, value] of Object.entries(config.payload || {})) {
    const v = typeof value === 'string' ? fill(value, all).trim() : value;
    if (v !== '' && v !== undefined && v !== null) payload[key] = v;
  }
  return { config, payload, to: all.to };
}

module.exports = {
  // Saves the ticket desk and/or type chosen in the flow. Params: { "desk": "WA-Travel" }
  // and/or { "type": "Query" }. A node may set one or both.
  async setTicket({ params }) {
    const chosen = {};
    if (params.desk) chosen.ticket_desk = cleanText(params.desk, 60);
    if (params.type) chosen.ticket_type = cleanText(params.type, 40);
    return chosen;
  },

  // Saves the ticket in Frappe and returns { reference_id, ticket_id }. If Frappe cannot
  // save it, the ticket goes to data/failed-tickets.jsonl and the node's "onError" runs,
  // with {{reference_id}} still available for the message to the user.
  async createRequest({ userId, vars }) {
    const type = cleanText(vars.ticket_type, 40);
    const isCallback = type === 'Callback';
    const ticket = {
      desk: cleanText(vars.ticket_desk, 60) || DEFAULT_DESK,
      type,
      contact_name: cleanText(vars.contact_name, 140),
      contact_number: `+${userId}`,
      email: cleanText(vars.contact_email, 140),
      message: cleanText(vars.ticket_message, 1000) || (isCallback ? 'Callback requested' : ''),
      ...(isCallback && {
        callback_phone: cleanText(vars.callback_phone, 20),
        callback_date: cleanText(vars.callback_date, 10),
        callback_time: cleanText(vars.callback_time, 8),
      }),
    };
    // Session values last for the whole session, so the next ticket must not reuse these.
    for (const key of TICKET_VARS) delete vars[key];

    let lastError;
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt++) {
      ticket.reference_id = newReferenceId();
      ticket.wa_message_id = vars.wa_message_id || `bot-${ticket.reference_id}`;
      vars.reference_id = ticket.reference_id;
      if (process.env.DRY_RUN) {
        console.log('DRY_RUN: ticket not sent to Frappe');
        return { ticket_id: `${ticket.desk}-${ticket.reference_id}` };
      }
      try {
        const saved = await createWaRequest(ticket);
        return { reference_id: saved.reference_id, ticket_id: saved.name };
      } catch (err) {
        lastError = err;
        if (err.status !== 409) break; // 409: reference already used, so try a new one
      }
    }
    await saveFailedTicket(ticket, lastError);
    throw lastError;
  },

  // Asks your Frappe server to send an email. The bot does not send mail itself:
  // it POSTs a JSON payload (shape set in config/mail.json) to your whitelisted method.
  // Params from the flow node (all accept {{name}} placeholders), for example:
  //   { "to": "sales@example.com", "subject": "Question from {{contact_name}}",
  //     "message": "{{question}}", "reply_to": "{{email}}" }
  // Any other param you add is also available in config/mail.json as {{param}}.
  // With an empty "url" in config/mail.json the payload is only saved to data/outbox.jsonl.
  // Returns { mailSent: "yes", mailResult: <Frappe's "message" if it is text> }.
  async sendMail({ userId, vars, params }) {
    const { config, payload, to } = buildMailPayload({ userId, vars, params });
    if (!to) throw new Error('sendMail: no recipient (set "to" in the node params or "defaultTo" in config/mail.json)');

    if (!config.url) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(path.join(DATA_DIR, 'outbox.jsonl'), JSON.stringify({ payload, at: new Date().toISOString() }) + '\n');
      console.log(`sendMail: no url in config/mail.json, saved payload to data/outbox.jsonl (to ${to})`);
      return { mailSent: 'yes', mailResult: '' };
    }

    const res = await fetch(config.url, {
      method: 'POST',
      headers: frappeHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs || 10000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`sendMail: Frappe returned ${res.status}: ${body.slice(0, 300)}`);
    let result = '';
    try {
      const msg = JSON.parse(body).message;
      if (typeof msg === 'string' || typeof msg === 'number') result = String(msg);
    } catch {} // non-JSON reply is fine, the call succeeded
    return { mailSent: 'yes', mailResult: result };
  },
};
