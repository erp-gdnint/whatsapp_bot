// Chat with the bot in your terminal, no WhatsApp or Meta account needed.
//   npm run chat                 (uses flows/faq.json)
//   npm run chat -- flows/x.json
// Type text like on WhatsApp, or a number to tap that option. /reset restarts, /quit exits.

const readline = require('readline');
const { loadFlow } = require('../src/flow');
const { FlowEngine } = require('../src/engine');
const { MemoryStore } = require('../src/store');
const actions = require('../src/actions');

const file = process.argv[2] || 'flows/faq.json';
const flow = loadFlow(file, actions);
const engine = new FlowEngine({ flow, actions, store: new MemoryStore() });
const USER = 'local-test-user';
let lastOptions = [];

function print(messages) {
  if (messages.length) lastOptions = []; // a plain text question means numbers are typed, not taps
  for (const m of messages) {
    console.log('\n\x1b[32mBOT:\x1b[0m ' + m.text.replace(/\n/g, '\n     '));
    if (m.type === 'buttons' || m.type === 'list') {
      if (m.type === 'list') console.log(`     [${m.button}]`);
      m.options.forEach((o, i) =>
        console.log(`     ${i + 1}. ${o.title}${o.description ? '  - ' + o.description : ''}`)
      );
      lastOptions = m.options;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\nYOU: ' });
console.log(`Loaded "${flow.name || file}". Say hi! (/reset, /quit)`);
rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();
  if (input === '/quit') return rl.close();
  if (input === '/reset') {
    await engine.reset(USER);
    lastOptions = [];
    console.log('(session reset)');
    return rl.prompt();
  }
  const n = Number(input);
  const option = Number.isInteger(n) && n >= 1 ? lastOptions[n - 1] : null;
  const incoming = option ? { kind: 'reply', id: option.id } : { kind: 'text', text: input };
  if (option) console.log(`     (tapped "${option.title}")`);
  try {
    print(await engine.handle(USER, incoming));
  } catch (err) {
    console.error('ERROR:', err.message);
  }
  rl.prompt();
});
