// Visual flow builder: a local web UI to edit flows/*.json.
//   npm run builder   ->   http://localhost:3100
// It listens on 127.0.0.1 only, so it is never reachable through the bot's tunnel.

require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { validateFlow } = require('../src/validate');
const { FlowEngine } = require('../src/engine');
const { MemoryStore } = require('../src/store');
const actions = require('../src/actions');

const FLOWS_DIR = path.join(__dirname, '..', 'flows');
const BACKUP_DIR = path.join(FLOWS_DIR, '.backup');
const NAME = /^[a-z0-9_-]{1,60}$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });
const fileOf = (name) => {
  if (!NAME.test(name || '')) throw fail(400, 'Flow name may only use letters, digits, - and _');
  return path.join(FLOWS_DIR, `${name}.json`);
};
const exists = (file) => fs.access(file).then(() => true, () => false);
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const STARTER = (name) => ({
  name,
  start: 'main',
  keywords: { hi: 'main', hello: 'main', menu: 'main' },
  messages: {
    fallback: "Sorry, I didn't understand that. Please tap one of the options, or type *menu*.",
    unsupported: 'I can only read text messages and button taps for now.',
    error: 'Something went wrong on our side. Please type *menu* to start again.',
  },
  nodes: {
    main: {
      type: 'buttons',
      text: 'Hello! How can we help you?',
      options: [{ id: 'info', title: 'Information' }],
    },
    info: {
      type: 'buttons',
      text: 'Here is some information.',
      options: [{ id: 'main', title: 'Main menu' }],
    },
  },
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/flows', wrap(async (_req, res) => {
  const files = await fs.readdir(FLOWS_DIR);
  res.json(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort());
}));

app.get('/api/flows/:name', wrap(async (req, res) => {
  const file = fileOf(req.params.name);
  if (!(await exists(file))) throw fail(404, 'Flow not found');
  res.json(JSON.parse(await fs.readFile(file, 'utf8')));
}));

// Save. Invalid flows are refused, so the file the live bot reads is always valid.
app.put('/api/flows/:name', wrap(async (req, res) => {
  const file = fileOf(req.params.name);
  const errors = validateFlow(req.body, actions);
  if (errors.length) return res.status(400).json({ errors });
  if (await exists(file)) {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.copyFile(file, path.join(BACKUP_DIR, `${req.params.name}-${stamp()}.json`));
  }
  await fs.writeFile(file, JSON.stringify(req.body, null, 2) + '\n');
  res.json({ ok: true });
}));

app.post('/api/flows', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const file = fileOf(name);
  if (await exists(file)) throw fail(409, `Flow "${name}" already exists`);
  await fs.writeFile(file, JSON.stringify(STARTER(name), null, 2) + '\n');
  res.json({ ok: true, name });
}));

app.post('/api/validate', (req, res) => res.json({ errors: validateFlow(req.body.flow, actions) }));

app.get('/api/actions', (_req, res) => res.json(Object.keys(actions)));

// Preview chat: runs the real engine on the unsaved flow from the editor.
const previewStore = new MemoryStore({ ttlMinutes: 120 });
app.post('/api/preview', wrap(async (req, res) => {
  const { flow, incoming } = req.body;
  const user = 'builder-preview-' + String(req.body.sessionId || 'x').slice(0, 40);
  const errors = validateFlow(flow, actions);
  if (errors.length) return res.json({ errors });
  const engine = new FlowEngine({ flow, actions, store: previewStore });
  const messages = await engine.handle(user, incoming, { name: 'Preview User', phone: '910000000000' });
  const session = await previewStore.get(user);
  res.json({ messages, node: session && session.node });
}));

app.post('/api/preview/reset', wrap(async (req, res) => {
  await previewStore.delete('builder-preview-' + String(req.body.sessionId || 'x').slice(0, 40));
  res.json({ ok: true });
}));

app.use((err, _req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

const port = Number(process.env.BUILDER_PORT) || 3100;
app.listen(port, '127.0.0.1', () => console.log(`Flow builder: http://localhost:${port}`));
