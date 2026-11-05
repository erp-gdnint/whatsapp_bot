// Actions are where the bot talks to the outside world (your APIs, a database,
// a Google Sheet, a CRM). A flow node { "type": "action", "action": "<name>" }
// calls the function with that name here.
//
// Each action receives { userId, vars, params } and may return an object;
// its fields are merged into the user's vars, so later messages can use them
// as {{fieldName}}. Throwing an error sends the user to the node's "onError"
// (or a generic error message).

const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

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
  // Demo: saves the typed question to data/questions.jsonl and returns a reference number.
  // Later, replace the file write with a real API call, for example:
  //   const res = await fetch('https://your-api.example.com/tickets', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CRM_TOKEN}` },
  //     body: JSON.stringify({ phone: userId, question: vars.question }),
  //   });
  //   if (!res.ok) throw new Error(`CRM returned ${res.status}`);
  //   const { id } = await res.json();
  //   return { ticketId: id };
  async saveQuestion({ userId, vars }) {
    return module.exports.createTicket({ userId, vars, params: { type: 'question', team: 'our team' } });
  },

  // Saves a ticket to data/questions.jsonl with a "type" column. Params:
  //   type   ticket type, e.g. "travel", "finance", "logistics" (default "question")
  //   team   team name shown to the user, e.g. "Travel Desk"
  //   field  which saved answer holds the user's text (default "question")
  // Returns { ticketId, ticketType, ticketTeam }. The ID starts with the type's
  // first letter: T… travel, F… finance, L… logistics, Q… question.
  async createTicket({ userId, vars, params }) {
    const type = String(params.type || 'question').toLowerCase();
    const team = params.team || 'our team';
    const ticketId = type[0].toUpperCase() + Date.now().toString(36).toUpperCase();
    await fs.mkdir(DATA_DIR, { recursive: true });
    const row = {
      ticketId,
      type,
      phone: userId,
      name: vars.contact_name || '',
      question: vars[params.field || 'question'] || '',
      at: new Date().toISOString(),
    };
    await fs.appendFile(path.join(DATA_DIR, 'questions.jsonl'), JSON.stringify(row) + '\n');
    return { ticketId, ticketType: type, ticketTeam: team };
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

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const { FRAPPE_API_KEY: key, FRAPPE_API_SECRET: secret } = process.env;
    if (key && secret) headers.Authorization = `token ${key}:${secret}`;

    const res = await fetch(config.url, {
      method: 'POST',
      headers,
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
