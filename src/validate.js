// Checks a flow file against WhatsApp's limits BEFORE the bot starts,
// so a typo in the JSON never turns into a failed API call in front of a user.

const LIMITS = {
  bodyText: 1024, // interactive message body
  plainText: 4096, // normal text message
  buttons: 10, // per node; sent as messages of 3 buttons each (WhatsApp's per-message limit)
  buttonTitle: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listButton: 20,
  sectionTitle: 24,
  caption: 1024,
  sessionTimeoutMinutes: 1440, // WhatsApp's customer service window is 24 hours
};

const TYPES = ['message', 'buttons', 'list', 'input', 'action', 'template', 'media'];
const INPUT_KINDS = ['text', 'email', 'phone', 'number', 'date'];
const MEDIA_TYPES = ['image', 'video', 'document'];

function validateFlow(flow, actions = {}) {
  const errors = [];
  const nodes = flow && flow.nodes;
  if (!nodes || typeof nodes !== 'object') return ['Flow must have a "nodes" object'];

  const exists = (id) => Object.prototype.hasOwnProperty.call(nodes, id);
  const ref = (where, id) => {
    if (!id) errors.push(`${where}: missing target node id`);
    else if (!exists(id)) errors.push(`${where}: points to unknown node "${id}"`);
  };
  const len = (where, value, max) => {
    if (typeof value !== 'string' || !value.trim()) errors.push(`${where}: text is empty`);
    else if (value.length > max) errors.push(`${where}: ${value.length} chars, WhatsApp max is ${max}`);
  };

  ref('start', flow.start);
  const timeout = flow.settings && flow.settings.sessionTimeoutMinutes;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= LIMITS.sessionTimeoutMinutes))
    errors.push(`settings: sessionTimeoutMinutes must be a whole number from 1 to ${LIMITS.sessionTimeoutMinutes}`);
  for (const [word, target] of Object.entries(flow.keywords || {})) ref(`keyword "${word}"`, target);

  for (const [id, node] of Object.entries(nodes)) {
    const at = `node "${id}"`;
    if (!TYPES.includes(node.type)) {
      errors.push(`${at}: unknown type "${node.type}" (use ${TYPES.join(', ')})`);
      continue;
    }
    switch (node.type) {
      case 'message':
        len(at, node.text, LIMITS.plainText);
        ref(`${at} next`, node.next);
        break;
      case 'input':
        len(at, node.text, LIMITS.plainText);
        if (!/^\w+$/.test(node.saveAs || '')) errors.push(`${at}: input needs "saveAs" (letters, digits, _)`);
        if (node.validate && !INPUT_KINDS.includes(node.validate))
          errors.push(`${at}: "validate" must be one of ${INPUT_KINDS.join(', ')}`);
        ref(`${at} next`, node.next);
        break;
      case 'media':
        if (!MEDIA_TYPES.includes(node.mediaType))
          errors.push(`${at}: "mediaType" must be one of ${MEDIA_TYPES.join(', ')}`);
        if (!/^https:\/\/\S+$/.test(node.url || '') && !/^\{\{\s*\w+\s*\}\}$/.test(node.url || ''))
          errors.push(`${at}: "url" must be a public https:// link`);
        if (node.caption && node.caption.length > LIMITS.caption)
          errors.push(`${at}: caption is ${node.caption.length} chars, WhatsApp max is ${LIMITS.caption}`);
        ref(`${at} next`, node.next);
        break;
      case 'action':
        if (!actions[node.action]) errors.push(`${at}: action "${node.action}" is not in src/actions`);
        ref(`${at} next`, node.next);
        if (node.onError) ref(`${at} onError`, node.onError);
        break;
      case 'template':
        // A pre-approved WhatsApp message template (created in WhatsApp Manager).
        if (!/^[a-z0-9_]+$/.test(node.name || ''))
          errors.push(`${at}: template "name" must be the approved template name (lowercase, digits, _)`);
        if (!node.language) errors.push(`${at}: template needs "language", e.g. "en_US" or "en"`);
        if (node.params && !Array.isArray(node.params)) errors.push(`${at}: "params" must be a list of texts`);
        ref(`${at} next`, node.next);
        break;
      case 'buttons':
      case 'list': {
        len(at, node.text, LIMITS.bodyText);
        const opts = node.options || [];
        const isList = node.type === 'list';
        const max = isList ? LIMITS.listRows : LIMITS.buttons;
        if (!opts.length) errors.push(`${at}: needs at least 1 option`);
        if (opts.length > max) errors.push(`${at}: ${opts.length} options, WhatsApp max is ${max}`);
        if (!isList && node.moreText && node.moreText.length > LIMITS.bodyText)
          errors.push(`${at}: "moreText" over ${LIMITS.bodyText} chars`);
        if (isList) {
          len(`${at} button`, node.button, LIMITS.listButton);
          if (node.sectionTitle) len(`${at} sectionTitle`, node.sectionTitle, LIMITS.sectionTitle);
        }
        const seen = new Set();
        opts.forEach((o, i) => {
          const where = `${at} option ${i + 1}`;
          ref(where, o.id);
          if (seen.has(o.id)) errors.push(`${where}: duplicate id "${o.id}" in the same menu`);
          seen.add(o.id);
          len(where, o.title, isList ? LIMITS.listRowTitle : LIMITS.buttonTitle);
          if (o.description) {
            if (!isList) errors.push(`${where}: buttons cannot have a description`);
            else if (o.description.length > LIMITS.listRowDescription)
              errors.push(`${where}: description over ${LIMITS.listRowDescription} chars`);
          }
        });
        break;
      }
    }
  }
  return errors;
}

module.exports = { validateFlow, LIMITS };
