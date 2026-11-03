'use strict';

// Same limits as src/validate.js (the server re-checks everything on save).
const LIMITS = {
  buttons: 3, buttonTitle: 20, listRows: 10, listRowTitle: 24, listRowDescription: 72,
  listButton: 20, sectionTitle: 24, bodyText: 1024, plainText: 4096,
};

const TYPE_INFO = {
  list: { label: 'List menu', short: 'LIST', hint: 'Up to 10 options behind a button' },
  buttons: { label: 'Buttons', short: 'BUTTONS', hint: 'Up to 3 reply buttons' },
  message: { label: 'Message', short: 'MESSAGE', hint: 'Plain text, then continues' },
  input: { label: 'Text input', short: 'INPUT', hint: 'Asks the user to type an answer' },
  action: { label: 'Action (code / API)', short: 'ACTION', hint: 'Runs a function from src/actions' },
  template: { label: 'WhatsApp template', short: 'TEMPLATE', hint: 'Sends a pre-approved template' },
};

const S = { files: [], name: null, flow: null, selected: null, dirty: false, errors: [], actions: [], liveNode: null };
const sessionId = Math.random().toString(36).slice(2);

// ---------- small helpers ----------
const $ = (sel) => document.querySelector(sel);
const world = $('#world');

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}
const svgEl = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const waFormat = (t) => esc(t)
  .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
  .replace(/_([^_\n]+)_/g, '<i>$1</i>')
  .replace(/~([^~\n]+)~/g, '<s>$1</s>')
  .replace(/\n/g, '<br>');

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.errors) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), kind === 'err' ? 5000 : 2500);
}

const nodeIds = () => Object.keys(S.flow.nodes);
const cardEl = (id) => world.querySelector(`.card[data-id="${CSS.escape(id)}"]`);

function uniqueId(base) {
  let i = 1;
  while (S.flow.nodes[`${base}_${i}`]) i++;
  return `${base}_${i}`;
}

function titleFor(id, type) {
  const t = id.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return t.slice(0, type === 'list' ? LIMITS.listRowTitle : LIMITS.buttonTitle);
}

// ---------- flow model ----------
function outs(node) {
  if (node.type === 'list' || node.type === 'buttons') {
    return (node.options || []).map((o, i) => ({ key: `opt${i}`, label: o.title || '(no title)', target: o.id, kind: 'opt' }));
  }
  if (node.type === 'action') {
    return [
      { key: 'next', label: 'then', target: node.next, kind: 'next' },
      { key: 'onError', label: 'on error', target: node.onError, kind: 'err' },
    ];
  }
  return [{ key: 'next', label: 'then', target: node.next, kind: 'next' }];
}

function defaultNode(type) {
  const to = S.flow.start;
  switch (type) {
    case 'list': return { type, text: 'Please choose a topic.', button: 'View options', sectionTitle: 'Options', options: [{ id: to, title: 'Main menu' }] };
    case 'buttons': return { type, text: 'Please choose an option.', options: [{ id: to, title: 'Main menu' }] };
    case 'message': return { type, text: 'New message', next: to };
    case 'input': return { type, text: 'Please type your answer.', saveAs: 'answer', minLength: 1, next: to };
    case 'action': return { type, action: S.actions[0] || '', next: to };
    case 'template': return { type, name: 'hello_world', language: 'en_US', params: [], next: to };
  }
}

function createNode(type, pos) {
  const base = { list: 'menu', buttons: 'menu', message: 'message', input: 'ask', action: 'action', template: 'template' }[type];
  let id = prompt(`Name for the new ${TYPE_INFO[type].label} node\n(lowercase letters, digits and _)`, uniqueId(base));
  if (id === null) return null;
  id = id.trim();
  if (!/^[a-z0-9_]+$/.test(id)) { toast('Use lowercase letters, digits and _ only', 'err'); return null; }
  if (S.flow.nodes[id]) { toast(`"${id}" already exists`, 'err'); return null; }
  S.flow.nodes[id] = defaultNode(type);
  S.flow.ui.positions[id] = pos || viewCenter();
  return id;
}

function changeType(id, type) {
  const old = S.flow.nodes[id];
  const n = defaultNode(type);
  if (old.text !== undefined && 'text' in n) n.text = old.text;
  if (old.options && n.options) n.options = old.options;
  if (old.next && 'next' in n) n.next = old.next;
  S.flow.nodes[id] = n;
}

// Points one exit of a node (an option, "next", "onError", or a new option) at a target node.
function setPortTarget(id, key, target) {
  const node = S.flow.nodes[id];
  if (key === 'add' || key.startsWith('opt')) {
    const opts = node.options || (node.options = []);
    const i = key === 'add' ? -1 : Number(key.slice(3));
    if (opts.some((o, j) => o.id === target && j !== i)) {
      toast(`"${id}" already has an option going to "${target}"`, 'err');
      return false;
    }
    if (i === -1) {
      const max = node.type === 'list' ? LIMITS.listRows : LIMITS.buttons;
      if (opts.length >= max) { toast(`A ${node.type} node can have at most ${max} options`, 'err'); return false; }
      opts.push({ id: target, title: titleFor(target, node.type) });
    } else {
      opts[i].id = target;
    }
  } else if (key === 'next') {
    node.next = target;
  } else if (key === 'onError') {
    if (target) node.onError = target;
    else delete node.onError;
  }
  return true;
}

function references(id) {
  const refs = [];
  for (const [nid, node] of Object.entries(S.flow.nodes)) {
    for (const o of outs(node)) if (o.target === id && nid !== id) refs.push(`${nid} (${o.label})`);
  }
  for (const [w, t] of Object.entries(S.flow.keywords || {})) if (t === id) refs.push(`keyword "${w}"`);
  return refs;
}

function renameNode(old, neu) {
  if (neu === old) return false;
  if (!/^[a-z0-9_]+$/.test(neu)) { toast('Use lowercase letters, digits and _ only', 'err'); return false; }
  if (S.flow.nodes[neu]) { toast(`"${neu}" already exists`, 'err'); return false; }
  S.flow.nodes = Object.fromEntries(Object.entries(S.flow.nodes).map(([k, v]) => [k === old ? neu : k, v]));
  for (const node of Object.values(S.flow.nodes)) {
    (node.options || []).forEach((o) => { if (o.id === old) o.id = neu; });
    if (node.next === old) node.next = neu;
    if (node.onError === old) node.onError = neu;
  }
  for (const w of Object.keys(S.flow.keywords || {})) if (S.flow.keywords[w] === old) S.flow.keywords[w] = neu;
  if (S.flow.start === old) S.flow.start = neu;
  S.flow.ui.positions[neu] = S.flow.ui.positions[old];
  delete S.flow.ui.positions[old];
  S.selected = neu;
  return true;
}

function deleteNode(id) {
  if (id === S.flow.start) return toast('The start node cannot be deleted. Make another node the start first.', 'err');
  const refs = references(id);
  if (refs.length) return toast(`Re-point these links first: ${refs.join(', ')}`, 'err');
  if (!confirm(`Delete node "${id}"?`)) return;
  delete S.flow.nodes[id];
  delete S.flow.ui.positions[id];
  S.selected = null;
  markChanged({ inspector: true });
}

function computeReachable() {
  const seen = new Set();
  const stack = [S.flow.start, ...Object.values(S.flow.keywords || {})];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !S.flow.nodes[id]) continue;
    seen.add(id);
    for (const o of outs(S.flow.nodes[id])) stack.push(o.target);
  }
  return seen;
}

function autoLayout() {
  const nodes = S.flow.nodes;
  const level = {};
  const queue = [];
  for (const r of [S.flow.start, ...Object.values(S.flow.keywords || {})]) {
    if (nodes[r] && level[r] === undefined) { level[r] = 0; queue.push(r); }
  }
  while (queue.length) {
    const id = queue.shift();
    for (const o of outs(nodes[id])) {
      if (o.target && nodes[o.target] && level[o.target] === undefined) { level[o.target] = level[id] + 1; queue.push(o.target); }
    }
  }
  const last = Math.max(0, ...Object.values(level)) + 1;
  const cols = {};
  for (const id of Object.keys(nodes)) (cols[level[id] ?? last] ||= []).push(id);
  for (const [l, ids] of Object.entries(cols)) {
    let y = 30;
    for (const id of ids) {
      S.flow.ui.positions[id] = { x: 30 + Number(l) * 290, y };
      const el = cardEl(id);
      y += (el ? el.offsetHeight : 150) + 30;
    }
  }
}

function viewCenter() {
  const c = $('#canvas');
  return { x: Math.round(c.scrollLeft + c.clientWidth / 2 - 115), y: Math.round(c.scrollTop + c.clientHeight / 3) };
}

// ---------- canvas ----------
function nodesWithErrors() {
  const set = new Set();
  for (const e of S.errors) { const m = /node "([^"]+)"/.exec(e); if (m) set.add(m[1]); }
  return set;
}

function renderCanvas() {
  world.querySelectorAll('.card').forEach((c) => c.remove());
  if (!S.flow) return;
  const errs = nodesWithErrors();
  const reach = computeReachable();
  for (const [id, node] of Object.entries(S.flow.nodes)) world.append(buildCard(id, node, errs, reach));
  sizeWorld();
  drawEdges();
}

function buildCard(id, node, errs, reach) {
  const pos = S.flow.ui.positions[id] || { x: 30, y: 30 };
  const info = TYPE_INFO[node.type] || { short: String(node.type).toUpperCase() };
  const cls = ['card', `t-${node.type}`];
  if (S.selected === id) cls.push('selected');
  if (errs.has(id)) cls.push('has-error');
  if (!reach.has(id)) cls.push('unreachable');
  if (S.liveNode === id) cls.push('live');
  const summary = node.type === 'action' ? `Runs ${node.action || '?'}()`
    : node.type === 'template' ? `Template ${node.name || '?'} (${node.language || '?'})`
      : node.text || '';
  const canAdd = (node.type === 'list' || node.type === 'buttons') &&
    (node.options || []).length < (node.type === 'list' ? LIMITS.listRows : LIMITS.buttons);

  return h('div', { class: cls.join(' '), 'data-id': id, style: `left:${pos.x}px;top:${pos.y}px` },
    h('div', { class: 'card-head' },
      h('span', { class: 'badge' }, info.short),
      h('span', { class: 'cid', title: id }, id),
      S.flow.start === id ? h('span', { class: 'start', title: 'Start node' }, 'START') : null),
    h('div', { class: 'card-text' }, summary.length > 110 ? summary.slice(0, 110) + '…' : summary),
    h('div', { class: 'ports' },
      outs(node).map((o) => h('div', { class: `port k-${o.kind}${o.target && !S.flow.nodes[o.target] ? ' broken' : ''}` },
        h('span', { class: 'plabel', title: o.label }, o.label),
        h('span', { class: 'ptarget', title: o.target || '' }, o.target ? `→ ${o.target}` : ''),
        h('i', { class: 'dot', 'data-node': id, 'data-key': o.key, 'data-target': o.target || '', 'data-kind': o.kind, title: 'Drag onto a node to connect' }))),
      canAdd ? h('div', { class: 'port k-add' },
        h('span', { class: 'plabel' }, '+ drag to add option'),
        h('i', { class: 'dot', 'data-node': id, 'data-key': 'add', 'data-target': '', title: 'Drag onto a node to add an option' })) : null));
}

function sizeWorld() {
  const c = $('#canvas');
  let w = c.clientWidth, hgt = c.clientHeight;
  world.querySelectorAll('.card').forEach((el) => {
    w = Math.max(w, el.offsetLeft + el.offsetWidth + 300);
    hgt = Math.max(hgt, el.offsetTop + el.offsetHeight + 300);
  });
  world.style.width = `${w}px`;
  world.style.height = `${hgt}px`;
}

const curve = (x1, y1, x2, y2) => {
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};
const centerOf = (el) => {
  const a = el.getBoundingClientRect(), w = world.getBoundingClientRect();
  return { x: a.left - w.left + a.width / 2, y: a.top - w.top + a.height / 2 };
};

function drawEdges() {
  const svg = $('#edges');
  svg.querySelectorAll('path.edge').forEach((p) => p.remove());
  const wr = world.getBoundingClientRect();
  world.querySelectorAll('.dot').forEach((dot) => {
    const t = dot.dataset.target;
    const tc = t && cardEl(t);
    if (!tc) return;
    const from = dot.dataset.node;
    const hl = S.selected && (S.selected === from || S.selected === t);
    // Links back to the start node ("Main menu") are everywhere; hide them unless asked or selected.
    if (t === S.flow.start && !hl && !$('#showStartLinks').checked) return;
    const back = tc.offsetLeft <= cardEl(from).offsetLeft;
    const a = centerOf(dot);
    const b = tc.getBoundingClientRect();
    svg.append(svgEl('path', {
      d: curve(a.x, a.y, b.left - wr.left, b.top - wr.top + 18),
      class: `edge${dot.dataset.kind === 'err' ? ' k-err' : ''}${hl ? ' hl' : back ? ' back' : ''}`,
      'marker-end': hl ? 'url(#arrow-hl)' : 'url(#arrow)',
    }));
  });
}

function select(id) {
  S.selected = id;
  renderCanvas();
  renderInspector();
}

world.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const dot = e.target.closest('.dot');
  if (dot) { e.preventDefault(); startConnect(dot); return; }
  const card = e.target.closest('.card');
  if (card) { e.preventDefault(); startDrag(card, e); return; }
  if (S.selected) select(null);
});

function startDrag(card, e) {
  const id = card.dataset.id;
  const p = S.flow.ui.positions[id] || { x: 0, y: 0 };
  const sx = e.clientX, sy = e.clientY;
  let moved = false, pos = p;
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    pos = { x: Math.max(0, Math.round((p.x + dx) / 10) * 10), y: Math.max(0, Math.round((p.y + dy) / 10) * 10) };
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    drawEdges();
  };
  const up = () => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    if (!moved) return select(id);
    S.flow.ui.positions[id] = pos;
    S.dirty = true;
    updateStatus();
    sizeWorld();
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

function startConnect(dot) {
  const from = dot.dataset.node, key = dot.dataset.key;
  const start = centerOf(dot);
  const temp = svgEl('path', { class: 'edge temp' });
  $('#edges').append(temp);
  const clearDrop = () => world.querySelectorAll('.card.drop').forEach((c) => c.classList.remove('drop'));
  const move = (ev) => {
    const wr = world.getBoundingClientRect();
    temp.setAttribute('d', curve(start.x, start.y, ev.clientX - wr.left, ev.clientY - wr.top));
    clearDrop();
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.card');
    if (over) over.classList.add('drop');
  };
  const up = (ev) => {
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    temp.remove();
    clearDrop();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const over = el && el.closest('.card');
    if (over) {
      if (setPortTarget(from, key, over.dataset.id)) markChanged({ inspector: S.selected === from });
      return;
    }
    if (el && el.closest('#world')) {
      const wr = world.getBoundingClientRect();
      const pos = { x: Math.round(ev.clientX - wr.left), y: Math.round(ev.clientY - wr.top - 18) };
      showTypeMenu(ev.clientX, ev.clientY, (type) => {
        const id = createNode(type, pos);
        if (id && setPortTarget(from, key, id)) { S.selected = id; markChanged({ inspector: true }); }
        else if (id) markChanged({ inspector: true });
      });
    }
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// ---------- pop-up menu ----------
function closeMenu() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
function showTypeMenu(x, y, onPick) {
  closeMenu();
  const menu = h('div', { class: 'menu' },
    h('div', { class: 'menu-title' }, 'Add a node'),
    Object.entries(TYPE_INFO).map(([t, info]) => h('button', { onclick: () => { closeMenu(); onPick(t); } },
      h('b', {}, info.label), h('small', {}, info.hint))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => {
    const outside = (e) => {
      if (!menu.contains(e.target)) { closeMenu(); removeEventListener('mousedown', outside, true); }
    };
    addEventListener('mousedown', outside, true);
  });
}

// ---------- inspector ----------
function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

function counted(el, max) {
  const counter = h('small', { class: 'counter' });
  const update = () => {
    counter.textContent = `${el.value.length}/${max}`;
    counter.classList.toggle('over', el.value.length > max);
  };
  el.addEventListener('input', update);
  update();
  return h('div', { class: 'counted' }, el, counter);
}

function textInput(value, onInput, max, placeholder) {
  const el = h('input', { type: 'text', value: value ?? '', placeholder, oninput: (e) => onInput(e.target.value) });
  return max ? counted(el, max) : el;
}

function textArea(value, onInput, max, rows = 4) {
  const el = h('textarea', { rows, value: value ?? '', oninput: (e) => onInput(e.target.value) });
  return max ? counted(el, max) : el;
}

function targetSelect(value, onChange, allowEmpty = false) {
  const sel = h('select', {},
    allowEmpty ? h('option', { value: '' }, '— none —') : !value ? h('option', { value: '' }, '— choose —') : null,
    nodeIds().map((id) => h('option', { value: id }, id + (S.flow.start === id ? '  ★' : ''))),
    h('option', { value: '__new' }, '+ New node…'));
  sel.value = value && S.flow.nodes[value] ? value : '';
  sel.addEventListener('change', () => {
    if (sel.value === '__new') {
      const r = sel.getBoundingClientRect();
      sel.value = value || '';
      showTypeMenu(r.left, r.bottom + 4, (type) => {
        const id = createNode(type);
        if (!id) return;
        onChange(id);
        markChanged({ inspector: true });
      });
      return;
    }
    if (onChange(sel.value || undefined) === false) return renderInspector();
    markChanged({ inspector: true });
  });
  return sel;
}

function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  if (!S.flow) return;
  if (!S.selected || !S.flow.nodes[S.selected]) {
    S.selected = null;
    box.append(...settingsPanel());
  } else {
    box.append(...nodePanel(S.selected));
  }
}

function nodePanel(id) {
  const node = S.flow.nodes[id];
  const els = [];
  const idInput = h('input', { type: 'text', value: id });
  els.push(h('div', { class: 'panel-head' }, h('h2', {}, 'Edit node'), h('button', { class: 'link', onclick: () => select(null) }, '✕ Close')));
  els.push(field('Node ID', h('div', { class: 'row' }, idInput,
    h('button', { class: 'secondary', onclick: () => { if (renameNode(id, idInput.value.trim())) markChanged({ inspector: true }); } }, 'Rename')),
  'Other nodes link to this name. Rename updates every link.'));
  els.push(field('Type', h('select', { value: node.type, onchange: (e) => { changeType(id, e.target.value); markChanged({ inspector: true }); } },
    Object.entries(TYPE_INFO).map(([t, i]) => h('option', { value: t }, i.label)))));
  els.push(S.flow.start === id
    ? h('p', { class: 'note' }, '★ This is the start node: new users see it first.')
    : h('button', { class: 'secondary', onclick: () => { S.flow.start = id; markChanged({ inspector: true }); } }, '★ Make this the start node'));

  const textHint = 'Formatting: *bold* _italic_ ~strike~. Insert saved answers with {{name}}.';
  switch (node.type) {
    case 'list':
      els.push(field('Message text', textArea(node.text, (v) => { node.text = v; markChanged(); }, LIMITS.bodyText), textHint));
      els.push(field('Menu button label', textInput(node.button, (v) => { node.button = v; markChanged(); }, LIMITS.listButton)));
      els.push(field('Section title (optional)', textInput(node.sectionTitle, (v) => { if (v) node.sectionTitle = v; else delete node.sectionTitle; markChanged(); }, LIMITS.sectionTitle)));
      els.push(optionsEditor(id, node));
      break;
    case 'buttons':
      els.push(field('Message text', textArea(node.text, (v) => { node.text = v; markChanged(); }, LIMITS.bodyText), textHint));
      els.push(optionsEditor(id, node));
      break;
    case 'message':
      els.push(field('Message text', textArea(node.text, (v) => { node.text = v; markChanged(); }, LIMITS.plainText), textHint));
      els.push(field('Then go to', targetSelect(node.next, (v) => { node.next = v; })));
      break;
    case 'input':
      els.push(field('Question', textArea(node.text, (v) => { node.text = v; markChanged(); }, LIMITS.plainText), textHint));
      els.push(field('Save answer as', textInput(node.saveAs, (v) => { node.saveAs = v.trim(); markChanged(); }),
        `Use it later as {{${node.saveAs || 'name'}}}, and in actions as vars.${node.saveAs || 'name'}.`));
      els.push(field('Minimum length', h('input', { type: 'number', min: 1, value: node.minLength || 1,
        oninput: (e) => { node.minLength = Math.max(1, Number(e.target.value) || 1); markChanged(); } })));
      els.push(field('Reply when too short (optional)', textArea(node.errorText, (v) => { if (v) node.errorText = v; else delete node.errorText; markChanged(); }, LIMITS.plainText, 2)));
      els.push(field('Then go to', targetSelect(node.next, (v) => { node.next = v; })));
      break;
    case 'action':
      els.push(field('Action', h('select', { value: node.action, onchange: (e) => { node.action = e.target.value; markChanged(); } },
        !S.actions.includes(node.action) ? h('option', { value: node.action || '' }, node.action ? `${node.action} (missing!)` : '— choose —') : null,
        S.actions.map((a) => h('option', { value: a }, a))),
      'Functions in src/actions/index.js. Their returned fields become {{fields}}.'));
      els.push(field('Params (JSON, optional)', paramsEditor(node), 'Passed to the action as params.'));
      els.push(field('Then go to', targetSelect(node.next, (v) => { node.next = v; })));
      els.push(field('If it fails, go to (optional)', targetSelect(node.onError, (v) => { if (v) node.onError = v; else delete node.onError; }, true)));
      break;
    case 'template':
      els.push(h('p', { class: 'note' }, 'Templates are created and approved in WhatsApp Manager → Message templates. The name and language must match exactly. Only needed to message users outside the 24-hour window.'));
      els.push(field('Template name', textInput(node.name, (v) => { node.name = v.trim(); markChanged(); }, null, 'e.g. order_update')));
      els.push(field('Language code', textInput(node.language, (v) => { node.language = v.trim(); markChanged(); }, null, 'en_US, en, hi')));
      els.push(field('Body parameters (one per line)', textArea((node.params || []).join('\n'),
        (v) => { node.params = v.split('\n').filter((l) => l.trim() !== ''); markChanged(); }, null, 3),
      'Fill {{1}}, {{2}}… of the template in order. Saved answers work here too: {{name}}.'));
      els.push(field('Then go to', targetSelect(node.next, (v) => { node.next = v; })));
      break;
  }
  els.push(h('hr'), h('button', { class: 'danger', onclick: () => deleteNode(id) }, 'Delete node'));
  return els;
}

function paramsEditor(node) {
  const ta = h('textarea', { rows: 2, value: node.params ? JSON.stringify(node.params) : '', placeholder: '{"key": "value"}' });
  ta.addEventListener('change', () => {
    const v = ta.value.trim();
    if (!v) { delete node.params; return markChanged(); }
    try { node.params = JSON.parse(v); markChanged(); } catch { toast('Params must be valid JSON', 'err'); }
  });
  return ta;
}

function optionsEditor(id, node) {
  const isList = node.type === 'list';
  const max = isList ? LIMITS.listRows : LIMITS.buttons;
  const opts = node.options || (node.options = []);
  const move = (i, j) => { [opts[i], opts[j]] = [opts[j], opts[i]]; markChanged({ inspector: true }); };
  const rows = opts.map((o, i) => h('div', { class: 'opt' },
    h('div', { class: 'opt-top' },
      h('span', { class: 'num' }, i + 1),
      textInput(o.title, (v) => { o.title = v; markChanged(); }, isList ? LIMITS.listRowTitle : LIMITS.buttonTitle, 'Option title'),
      h('button', { class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
      h('button', { class: 'icon', title: 'Move down', disabled: i === opts.length - 1, onclick: () => move(i, i + 1) }, '↓'),
      h('button', { class: 'icon', title: 'Remove', onclick: () => { opts.splice(i, 1); markChanged({ inspector: true }); } }, '✕')),
    isList ? textInput(o.description, (v) => { if (v) o.description = v; else delete o.description; markChanged(); }, LIMITS.listRowDescription, 'Description (optional)') : null,
    h('div', { class: 'opt-target' }, h('span', {}, 'goes to'), targetSelect(o.id, (t) => setPortTarget(id, `opt${i}`, t)))));
  const add = h('button', {
    class: 'secondary',
    disabled: opts.length >= max,
    onclick: () => {
      const free = nodeIds().find((n) => n !== id && !opts.some((o) => o.id === n));
      if (!free) return toast('Every node is already linked from this menu. Create a new node first.', 'err');
      opts.push({ id: free, title: 'New option' });
      markChanged({ inspector: true });
    },
  }, '+ Add option');
  return h('div', {}, h('h3', {}, `Options (${opts.length}/${max})`), rows, add);
}

function settingsPanel() {
  const els = [];
  els.push(h('div', { class: 'panel-head' }, h('h2', {}, 'Flow settings')));
  els.push(h('p', { class: 'note' }, 'Click a node to edit it. Drag from a ● dot onto a node to connect them; drop on empty space to create a new node.'));
  els.push(field('Bot name', textInput(S.flow.name, (v) => { S.flow.name = v; markChanged(); })));
  els.push(field('Start node', targetSelect(S.flow.start, (v) => { S.flow.start = v; }), 'Shown to new users and after a session expires.'));

  // Keywords: typed words that jump to a node from anywhere.
  const entries = Object.entries(S.flow.keywords || {});
  const commit = () => {
    S.flow.keywords = Object.fromEntries(entries.filter(([w]) => w.trim()).map(([w, t]) => [w.trim().toLowerCase(), t]));
    markChanged();
  };
  const list = h('div', {});
  const row = (entry) => h('div', { class: 'kw' },
    h('input', { type: 'text', value: entry[0], placeholder: 'word', oninput: (e) => { entry[0] = e.target.value; commit(); } }),
    targetSelect(entry[1], (t) => { entry[1] = t; commit(); }),
    h('button', { class: 'icon', title: 'Remove', onclick: (e) => { entries.splice(entries.indexOf(entry), 1); e.target.closest('.kw').remove(); commit(); } }, '✕'));
  entries.forEach((en) => list.append(row(en)));
  els.push(h('h3', {}, 'Keywords'), h('small', { class: 'hint' }, 'If the user types one of these words, jump to that node.'), list,
    h('button', { class: 'secondary small', onclick: () => { const en = ['', S.flow.start]; entries.push(en); list.append(row(en)); } }, '+ Add keyword'));

  S.flow.messages ||= {};
  const msg = (key, label) => field(label, textArea(S.flow.messages[key], (v) => { S.flow.messages[key] = v; markChanged(); }, LIMITS.plainText, 2));
  els.push(h('h3', {}, 'Bot messages'),
    msg('fallback', 'When the bot does not understand'),
    msg('unsupported', 'When the user sends a photo, voice note…'),
    msg('error', 'When an action fails'));

  els.push(h('h3', {}, 'Problems'), h('div', { id: 'problems' }));
  setTimeout(renderProblems);
  return els;
}

function renderProblems() {
  const box = $('#problems');
  if (!box) return;
  box.innerHTML = '';
  const reach = computeReachable();
  const warnings = nodeIds().filter((id) => !reach.has(id));
  if (!S.errors.length && !warnings.length) return box.append(h('p', { class: 'ok' }, '✓ No problems. Ready to save.'));
  const item = (text, kind) => {
    const m = /node "([^"]+)"/.exec(text);
    return h('button', { class: `problem ${kind}`, onclick: () => m && S.flow.nodes[m[1]] && select(m[1]) }, text);
  };
  S.errors.forEach((e) => box.append(item(e, '')));
  warnings.forEach((id) => box.append(item(`node "${id}" cannot be reached from the start node or a keyword`, 'warn')));
}

// ---------- validation, status, save ----------
let validateTimer;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(validate, 300);
}
async function validate() {
  try {
    const { errors } = await api('POST', '/api/validate', { flow: S.flow });
    S.errors = errors;
  } catch (e) {
    S.errors = [`Could not validate: ${e.message}`];
  }
  updateStatus();
  const errs = nodesWithErrors();
  world.querySelectorAll('.card').forEach((c) => c.classList.toggle('has-error', errs.has(c.dataset.id)));
  renderProblems();
}

function updateStatus() {
  const pill = $('#statusPill');
  const n = S.errors.length;
  pill.textContent = n ? `✕ ${n} problem${n > 1 ? 's' : ''}` : '✓ Valid';
  pill.className = `pill ${n ? 'bad' : 'ok'}`;
  const save = $('#saveBtn');
  save.disabled = !S.dirty;
  save.textContent = S.dirty ? 'Save •' : 'Saved';
}

function markChanged(opts = {}) {
  S.dirty = true;
  renderCanvas();
  if (opts.inspector) renderInspector();
  updateStatus();
  scheduleValidate();
}

async function save() {
  if (!S.dirty) return;
  const res = await fetch(`/api/flows/${encodeURIComponent(S.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(S.flow),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    S.errors = data.errors || [data.error || 'Save failed'];
    updateStatus();
    select(null);
    return toast('Not saved: fix the problems listed on the right first.', 'err');
  }
  S.dirty = false;
  updateStatus();
  toast('Saved. A running bot picks it up automatically.');
}

// ---------- files ----------
async function loadFiles() {
  S.files = await api('GET', '/api/flows');
  const sel = $('#fileSel');
  sel.innerHTML = '';
  S.files.forEach((f) => sel.append(h('option', { value: f }, `${f}.json`)));
  if (S.name) sel.value = S.name;
}

async function openFlow(name) {
  if (S.dirty && !confirm('You have unsaved changes. Discard them?')) {
    $('#fileSel').value = S.name;
    return;
  }
  const flow = await api('GET', `/api/flows/${encodeURIComponent(name)}`);
  flow.nodes ||= {};
  flow.ui ||= {};
  flow.ui.positions ||= {};
  Object.assign(S, { flow, name, selected: null, dirty: false, errors: [], liveNode: null });
  $('#fileSel').value = name;
  renderCanvas();
  if (nodeIds().some((id) => !flow.ui.positions[id])) { autoLayout(); renderCanvas(); }
  renderInspector();
  updateStatus();
  validate();
  resetPreview();
}

async function newFlow() {
  const name = prompt('Name for the new flow file (letters, digits, - and _):', 'new_flow');
  if (!name) return;
  try {
    await api('POST', '/api/flows', { name: name.trim() });
    await loadFiles();
    await openFlow(name.trim());
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------- preview chat ----------
const chat = $('#chat');
function bubble(who, ...children) {
  chat.append(h('div', { class: `bubble ${who}` }, children));
  chat.scrollTop = chat.scrollHeight;
}

function showBotMessage(m) {
  if (m.type === 'template') {
    return bubble('bot', h('div', { class: 'tpl' }, '📄 Template ', h('b', {}, m.name), ` (${m.language})`,
      m.params.length ? h('small', {}, `Parameters: ${m.params.join(' | ')}`) : null,
      h('small', {}, 'The real template text comes from WhatsApp Manager.')));
  }
  const txt = h('div', {});
  txt.innerHTML = waFormat(m.text);
  if (m.type === 'text') return bubble('bot', txt);
  if (m.type === 'buttons') {
    return bubble('bot', txt, h('div', { class: 'btns' },
      m.options.map((o) => h('button', { onclick: () => sendPreview({ kind: 'reply', id: o.id }, o.title) }, o.title))));
  }
  if (m.type === 'list') {
    const rows = h('div', { class: 'rows hidden' }, m.options.map((o) => h('button', {
      class: 'row-opt',
      onclick: () => { rows.classList.add('hidden'); sendPreview({ kind: 'reply', id: o.id }, o.title); },
    }, h('b', {}, o.title), o.description ? h('small', {}, o.description) : null)));
    return bubble('bot', txt, h('div', { class: 'btns' }, h('button', { onclick: () => rows.classList.toggle('hidden') }, `☰ ${m.button}`)), rows);
  }
}

async function sendPreview(incoming, label) {
  if (label) bubble('user', label);
  try {
    const data = await api('POST', '/api/preview', { flow: S.flow, sessionId, incoming });
    if (data.errors && data.errors.length) {
      return bubble('sys', 'Fix the flow problems first:', h('ul', {}, data.errors.slice(0, 5).map((e) => h('li', {}, e))));
    }
    data.messages.forEach(showBotMessage);
    S.liveNode = data.node || null;
    world.querySelectorAll('.card').forEach((c) => c.classList.toggle('live', c.dataset.id === S.liveNode));
  } catch (e) {
    bubble('sys', `Preview failed: ${e.message}`);
  }
}

async function resetPreview() {
  chat.innerHTML = '';
  S.liveNode = null;
  world.querySelectorAll('.card.live').forEach((c) => c.classList.remove('live'));
  await api('POST', '/api/preview/reset', { sessionId }).catch(() => {});
  bubble('sys', 'Type "hi" to start chatting with your flow. Actions really run here (e.g. saveQuestion writes to data/).');
}

// ---------- wiring ----------
$('#fileSel').addEventListener('change', (e) => openFlow(e.target.value));
$('#newFlowBtn').addEventListener('click', newFlow);
$('#addNodeBtn').addEventListener('click', (e) => {
  const r = e.target.getBoundingClientRect();
  showTypeMenu(r.left, r.bottom + 4, (type) => {
    const id = createNode(type);
    if (id) { S.selected = id; markChanged({ inspector: true }); }
  });
});
$('#layoutBtn').addEventListener('click', () => { autoLayout(); S.dirty = true; renderCanvas(); updateStatus(); });
$('#statusPill').addEventListener('click', () => select(null));
$('#showStartLinks').addEventListener('change', drawEdges);
$('#saveBtn').addEventListener('click', save);
$('#previewBtn').addEventListener('click', () => { $('#preview').classList.toggle('hidden'); drawEdges(); });
$('#resetPreviewBtn').addEventListener('click', resetPreview);
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendPreview({ kind: 'text', text }, text);
});
addEventListener('resize', () => { sizeWorld(); drawEdges(); });
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (e.key === 'Delete' && !typing && S.selected) deleteNode(S.selected);
  if (e.key === 'Escape') { closeMenu(); if (!typing && S.selected) select(null); }
});
addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  try {
    S.actions = await api('GET', '/api/actions');
    await loadFiles();
    const first = S.files.includes('faq') ? 'faq' : S.files[0];
    if (first) await openFlow(first);
    else toast('No flows yet. Click "New flow".');
  } catch (e) {
    toast(`Could not load: ${e.message}`, 'err');
  }
})();
