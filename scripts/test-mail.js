// Sends one test payload to your Frappe mail method through the same sendMail
// action the flow uses, so you can check config/mail.json and the API key.
//
//   npm run test-mail                      sends to "defaultTo" from config/mail.json
//   npm run test-mail -- you@example.com   sends to this address
//
// With an empty "url" in config/mail.json nothing is sent: the payload is printed
// (and saved to data/outbox.jsonl) so you can see exactly what Frappe will receive.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendMail } = require('../src/actions');

const to = process.argv[2];

(async () => {
  try {
    const result = await sendMail({
      userId: '910000000000',
      vars: { contact_name: 'Test User' },
      params: {
        ...(to ? { to } : {}),
        subject: 'Test mail from the WhatsApp bot',
        message: 'If you can read this, the WhatsApp bot can send mail through Frappe.\n\nName: {{contact_name}}\nWhatsApp: {{user_phone}}',
      },
    });
    const outbox = path.join(__dirname, '..', 'data', 'outbox.jsonl');
    const { url } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'mail.json'), 'utf8'));
    if (!url) {
      const last = fs.readFileSync(outbox, 'utf8').trim().split('\n').pop();
      console.log('No "url" in config/mail.json, so nothing was sent. Payload Frappe would get:');
      console.log(JSON.stringify(JSON.parse(last).payload, null, 2));
    } else {
      console.log(`OK: Frappe accepted the mail.${result.mailResult ? ` Reply: ${result.mailResult}` : ''}`);
    }
  } catch (err) {
    console.error(`Test mail failed: ${err.message}`);
    if (/\b(401|403)\b/.test(err.message))
      console.error('Hint: check FRAPPE_API_KEY / FRAPPE_API_SECRET in .env, and that the user may call this method.');
    if (/\b404\b|\b417\b/.test(err.message))
      console.error('Hint: check "url" (…/api/method/<app>.<module>.<function>) and that the function has @frappe.whitelist().');
    process.exit(1);
  }
})();
