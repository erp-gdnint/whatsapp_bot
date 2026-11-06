// Makes user-supplied values safe to pass on as plain text.
// Text is kept as typed, so "a < b" stays "a < b": only invisible control and
// text-direction characters are removed. Escaping belongs where the text is shown,
// for example HTML-escaping it in a Frappe email.

const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g;

function cleanText(value, max = 1000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(UNSAFE, '').trim().slice(0, max);
}

// WhatsApp template values are one line, and as far as we know cannot be empty.
function cleanParam(value, max = 200) {
  return cleanText(value, 4096).replace(/\s+/g, ' ').slice(0, max).trim() || '-';
}

module.exports = { cleanText, cleanParam };
