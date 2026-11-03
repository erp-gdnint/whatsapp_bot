// Checks a flow file against WhatsApp's limits BEFORE the bot starts,
// so a typo in the JSON never turns into a failed API call in front of a user.

const LIMITS = {
  bodyText: 1024, // interactive message body
  plainText: 4096, // normal text message
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listButton: 20,
  sectionTitle: 24,
};

const TYPES = ['message', 'buttons', 'list', 'input', 'action'];

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
        if (!node.saveAs) errors.push(`${at}: input needs "saveAs"`);
        ref(`${at} next`, node.next);
        break;
      case 'action':
        if (!actions[node.action]) errors.push(`${at}: action "${node.action}" is not in src/actions`);
        ref(`${at} next`, node.next);
        if (node.onError) ref(`${at} onError`, node.onError);
        break;
      case 'buttons':
      case 'list': {
        len(at, node.text, LIMITS.bodyText);
        const opts = node.options || [];
        const isList = node.type === 'list';
        const max = isList ? LIMITS.listRows : LIMITS.buttons;
        if (!opts.length) errors.push(`${at}: needs at least 1 option`);
        if (opts.length > max) errors.push(`${at}: ${opts.length} options, WhatsApp max is ${max}`);
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
