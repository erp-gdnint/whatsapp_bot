// Client for the Frappe methods the bot calls. Secrets stay in .env; the method URL
// and other settings are in config/frappe.json, read on every call.

const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'config', 'frappe.json');

function readFrappeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config/frappe.json: ${err.message}`);
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

// Used by sendMail. Frappe checks this header against the API key of the bot user.
function frappeHeaders() {
  const headers = { ...JSON_HEADERS };
  const { FRAPPE_API_KEY: key, FRAPPE_API_SECRET: secret } = process.env;
  if (key && secret) headers.Authorization = `token ${key}:${secret}`;
  return headers;
}

const fail = (message, status) => Object.assign(new Error(message), { status });

// Sends one ticket to Frappe, with FRAPPE_TOKEN in the payload. Returns the ticket details
// Frappe saved: { name, reference_id }. Throws with err.status on a refused request
// (409 means the reference ID is already used). The token is added only here, so it is
// never written to data/failed-tickets.jsonl.
async function createWaRequest(ticket) {
  const { createRequestUrl, timeoutMs } = readFrappeConfig();
  if (!createRequestUrl) throw new Error('No "createRequestUrl" in config/frappe.json');
  const token = process.env.FRAPPE_TOKEN;
  if (!token) throw new Error('FRAPPE_TOKEN is not set in .env');

  const res = await fetch(createRequestUrl, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...ticket, token }),
    signal: AbortSignal.timeout(timeoutMs || 10000),
  });
  const text = await res.text();
  if (!res.ok) throw fail(`Frappe returned ${res.status}: ${text.slice(0, 300)}`, res.status);

  let details;
  try {
    details = JSON.parse(text).message;
  } catch {
    throw new Error('Frappe sent a reply that is not JSON');
  }
  if (details && details.error) throw fail(`Frappe refused the ticket: ${details.error}`, details.status);
  if (!details || !details.name || !details.reference_id) throw new Error('Frappe sent no ticket details');
  return details;
}

module.exports = { createWaRequest, frappeHeaders, readFrappeConfig };
