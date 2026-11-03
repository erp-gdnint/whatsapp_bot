// The flow engine: takes one incoming user event, moves the user through the
// JSON flow, and returns the messages to send back. It knows nothing about
// WhatsApp's API, so the same engine runs in the terminal simulator and the server.
//
// Incoming event:  { kind: 'text', text }  |  { kind: 'reply', id }  |  { kind: 'unsupported' }
// Outgoing message: { type: 'text', text }
//                   { type: 'buttons', text, options: [{ id, title }] }
//                   { type: 'list', text, button, sectionTitle, options: [{ id, title, description }] }
//                   { type: 'template', name, language, params: [text] }

const DEFAULT_MESSAGES = {
  fallback: "Sorry, I didn't understand that. Please choose one of the options.",
  unsupported: 'I can only read text messages and button taps for now.',
  error: 'Something went wrong on our side. Please type *menu* to start again.',
  inputTooShort: 'Please type a little more.',
};

const fill = (text, vars) =>
  String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? '').toString());

class FlowEngine {
  constructor({ flow, store, actions = {}, logger = console }) {
    this.store = store;
    this.actions = actions;
    this.logger = logger;
    this.setFlow(flow);
  }

  // Swap in a new (already validated) flow, e.g. after the visual builder saves.
  setFlow(flow) {
    this.flow = flow;
    this.text = { ...DEFAULT_MESSAGES, ...(flow.messages || {}) };
    this.keywords = Object.fromEntries(
      Object.entries(flow.keywords || {}).map(([k, v]) => [k.trim().toLowerCase(), v])
    );
  }

  async reset(userId) {
    await this.store.delete(userId);
  }

  async handle(userId, incoming) {
    const session = (await this.store.get(userId)) || { node: null, vars: {} };
    const out = [];
    const nodes = this.flow.nodes;
    if (session.node && !Object.prototype.hasOwnProperty.call(nodes, session.node)) session.node = null; // node was deleted
    const current = session.node ? nodes[session.node] : null;
    let target = null;

    if (incoming.kind === 'text') {
      const typed = (incoming.text || '').trim();
      const keyword = this.keywords[typed.toLowerCase()];
      if (keyword) {
        target = keyword;
      } else if (current && current.type === 'input') {
        const min = current.minLength || 1;
        if (typed.length < min) {
          out.push({ type: 'text', text: fill(current.errorText || this.text.inputTooShort, session.vars) });
        } else {
          session.vars[current.saveAs] = typed.slice(0, current.maxLength || 1000);
          target = current.next;
        }
      } else if (!current) {
        target = this.flow.start; // first message ever (or session expired): show the start menu
      } else {
        out.push({ type: 'text', text: fill(this.text.fallback, session.vars) });
        target = session.node; // show the same menu again
      }
    } else if (incoming.kind === 'reply' && Object.prototype.hasOwnProperty.call(nodes, incoming.id)) {
      target = incoming.id;
    } else {
      const msg = incoming.kind === 'reply' ? this.text.fallback : this.text.unsupported;
      out.push({ type: 'text', text: fill(msg, session.vars) });
      target = session.node || this.flow.start;
    }

    if (target) await this.run(target, session, userId, out);
    await this.store.set(userId, session);
    return out;
  }

  // Walks from a node until it reaches one that waits for the user.
  async run(startId, session, userId, out) {
    let id = startId;
    for (let hops = 0; id; hops++) {
      if (hops > 25) throw new Error(`Flow loop detected near node "${id}"`);
      const node = this.flow.nodes[id];
      session.node = id;
      const text = node.text !== undefined ? fill(node.text, session.vars) : '';

      switch (node.type) {
        case 'message':
          out.push({ type: 'text', text });
          id = node.next;
          break;
        case 'input':
          out.push({ type: 'text', text });
          id = null; // wait for the user to type
          break;
        case 'template':
          out.push({
            type: 'template',
            name: node.name,
            language: node.language,
            params: (node.params || []).map((p) => fill(p, session.vars)),
          });
          id = node.next;
          break;
        case 'buttons':
          out.push({
            type: 'buttons',
            text,
            options: node.options.map((o) => ({ id: o.id, title: fill(o.title, session.vars) })),
          });
          id = null;
          break;
        case 'list':
          out.push({
            type: 'list',
            text,
            button: node.button,
            sectionTitle: node.sectionTitle,
            options: node.options.map((o) => ({
              id: o.id,
              title: fill(o.title, session.vars),
              description: o.description ? fill(o.description, session.vars) : undefined,
            })),
          });
          id = null;
          break;
        case 'action':
          try {
            const result = await this.actions[node.action]({ userId, vars: session.vars, params: node.params || {} });
            if (result && typeof result === 'object') Object.assign(session.vars, result);
            id = node.next;
          } catch (err) {
            this.logger.error(`Action "${node.action}" failed:`, err.message);
            if (node.onError) {
              id = node.onError;
            } else {
              out.push({ type: 'text', text: this.text.error });
              session.node = null; // next message starts fresh
              id = null;
            }
          }
          break;
        default:
          throw new Error(`Unknown node type "${node.type}"`);
      }
    }
  }
}

module.exports = { FlowEngine };
