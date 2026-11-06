// The flow engine: takes one incoming user event, moves the user through the
// JSON flow, and returns the messages to send back. It knows nothing about
// WhatsApp's API, so the same engine runs in the terminal simulator, the builder
// preview and the server.
//
// Incoming event:  { kind: 'text', text }  |  { kind: 'reply', id }  |  { kind: 'unsupported' }
//                 (optional messageId -> saved as {{wa_message_id}})
// Contact (optional): { name, phone }  -> saved as {{contact_name}} and {{contact_phone}}
// Outgoing message: { type: 'text', text }
//                   { type: 'buttons', text, options: [{ id, title }] }          (max 3 per message)
//                   { type: 'list', text, button, sectionTitle, options: [{ id, title, description }] }
//                   { type: 'media', mediaType: 'image'|'video'|'document', url, caption, filename }
//                   { type: 'template', name, language, params: [text] }

const BUTTONS_PER_MESSAGE = 3; // WhatsApp's limit; longer button menus are split into several messages

const DEFAULT_MESSAGES = {
  fallback: "Sorry, I didn't understand that. Please choose one of the options.",
  unsupported: 'I can only read text messages and button taps for now.',
  error: 'Something went wrong on our side. Please type *menu* to start again.',
  inputTooShort: 'Please type a little more.',
  invalidEmail: 'Please type a valid email address, like name@example.com.',
  invalidPhone: 'Please type a valid phone number with country code, like +91 98765 43210.',
  invalidNumber: 'Please type a number only, like 25 or 2.5.',
  invalidDate: 'Please type a date like 25/12/2026.',
  invalidTime: 'Please type a time like 14:30 or 2:30 pm.',
};

const fill = (text, vars) =>
  String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? '').toString());

// Accepts DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY or YYYY-MM-DD and returns YYYY-MM-DD, or null.
function parseDate(value) {
  let d, m, y;
  let match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (match) [, d, m, y] = match;
  else if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) [, y, m, d] = match;
  else return null;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) return null;
  return date.toISOString().slice(0, 10);
}

// Accepts 14:30, 14:30:15, 2:30 pm or 2 pm and returns HH:MM:SS, or null.
function parseTime(value) {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*([ap])\.?m?\.?$|^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/i.exec(value);
  if (!match) return null;
  const meridiem = (match[4] || '').toLowerCase();
  let hour = Number(match[1] ?? match[5]);
  const minute = Number(match[2] ?? match[6] ?? 0);
  const second = Number(match[3] ?? match[7] ?? 0);
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (meridiem) hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return [hour, minute, second].map((n) => String(n).padStart(2, '0')).join(':');
}

// Each check returns the cleaned value to save, or null when the input is not acceptable.
const INPUT_CHECKS = {
  text: (v) => v,
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v.toLowerCase() : null),
  phone: (v) => {
    const cleaned = v.replace(/[\s().-]/g, '');
    return /^\+?\d{7,15}$/.test(cleaned) ? cleaned : null;
  },
  number: (v) => (/^-?\d+([.,]\d+)?$/.test(v) ? v.replace(',', '.') : null),
  date: parseDate,
  time: parseTime,
};
const INPUT_ERRORS = { email: 'invalidEmail', phone: 'invalidPhone', number: 'invalidNumber', date: 'invalidDate', time: 'invalidTime' };

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

  async handle(userId, incoming, contact = {}) {
    const session = (await this.store.get(userId)) || { node: null, vars: {} };
    if (contact.name) session.vars.contact_name = contact.name;
    if (contact.phone) session.vars.contact_phone = contact.phone;
    if (incoming.messageId) session.vars.wa_message_id = incoming.messageId;
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
        const problem = this.checkInput(current, typed);
        if (problem) {
          out.push({ type: 'text', text: fill(problem, session.vars) });
        } else {
          session.vars[current.saveAs] = INPUT_CHECKS[current.validate || 'text'](typed).slice(0, current.maxLength || 1000);
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
    const ttl = this.flow.settings && this.flow.settings.sessionTimeoutMinutes;
    await this.store.set(userId, session, ttl);
    return out;
  }

  // Returns the message to send when the typed answer is not acceptable, or null when it is.
  checkInput(node, typed) {
    const kind = node.validate || 'text';
    if (kind === 'text') {
      return typed.length < (node.minLength || 1) ? node.errorText || this.text.inputTooShort : null;
    }
    return INPUT_CHECKS[kind](typed) === null ? node.errorText || this.text[INPUT_ERRORS[kind]] : null;
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
        case 'media':
          out.push({
            type: 'media',
            mediaType: node.mediaType,
            url: fill(node.url, session.vars),
            caption: node.caption ? fill(node.caption, session.vars) : undefined,
            filename: node.filename ? fill(node.filename, session.vars) : undefined,
          });
          id = node.next;
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
        case 'buttons': {
          // WhatsApp shows at most 3 buttons per message, so longer menus go out as several
          // messages. Every button stays tappable, so no extra state is needed.
          const options = node.options.map((o) => ({ id: o.id, title: fill(o.title, session.vars) }));
          for (let i = 0; i < options.length; i += BUTTONS_PER_MESSAGE) {
            out.push({
              type: 'buttons',
              text: i === 0 ? text : fill(node.moreText || '…', session.vars),
              options: options.slice(i, i + BUTTONS_PER_MESSAGE),
            });
          }
          id = null;
          break;
        }
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

module.exports = { FlowEngine, parseDate, parseTime, BUTTONS_PER_MESSAGE };
