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
    const ticketId = 'Q' + Date.now().toString(36).toUpperCase();
    await fs.mkdir(DATA_DIR, { recursive: true });
    const row = { ticketId, phone: userId, question: vars.question, at: new Date().toISOString() };
    await fs.appendFile(path.join(DATA_DIR, 'questions.jsonl'), JSON.stringify(row) + '\n');
    return { ticketId };
  },
};
