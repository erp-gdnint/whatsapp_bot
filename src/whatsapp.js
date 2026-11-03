// Thin client for the official WhatsApp Cloud API (graph.facebook.com).
// Converts the engine's simple messages into WhatsApp payloads, and
// incoming webhook payloads into simple engine events.

function createWhatsAppClient({ token, phoneNumberId, version = 'v23.0', logger = console }) {
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  async function post(body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`WhatsApp API ${res.status}: ${detail}`);
    }
    return res.json();
  }

  function toPayload(to, msg) {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
    switch (msg.type) {
      case 'text':
        return { ...base, type: 'text', text: { body: msg.text, preview_url: false } };
      case 'buttons':
        return {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: msg.text },
            action: {
              buttons: msg.options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title } })),
            },
          },
        };
      case 'list':
        return {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: msg.text },
            action: {
              button: msg.button,
              sections: [
                {
                  title: msg.sectionTitle || 'Options',
                  rows: msg.options.map((o) => ({
                    id: o.id,
                    title: o.title,
                    ...(o.description ? { description: o.description } : {}),
                  })),
                },
              ],
            },
          },
        };
      default:
        throw new Error(`Unknown outgoing message type "${msg.type}"`);
    }
  }

  // Sends messages one by one so they arrive in order.
  async function sendAll(to, messages) {
    for (const msg of messages) await post(toPayload(to, msg));
  }

  // Shows blue ticks to the user. Failure here is harmless, so it is only logged.
  async function markRead(messageId) {
    try {
      await post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
    } catch (err) {
      logger.warn('markRead failed:', err.message);
    }
  }

  return { sendAll, markRead, toPayload };
}

// Pulls user messages out of a webhook body. Delivery/read status updates are ignored.
function parseIncoming(body) {
  const events = [];
  if (!body || body.object !== 'whatsapp_business_account') return events;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const m of value.messages || []) {
        let incoming;
        if (m.type === 'text') incoming = { kind: 'text', text: m.text.body };
        else if (m.type === 'interactive' && m.interactive.button_reply)
          incoming = { kind: 'reply', id: m.interactive.button_reply.id };
        else if (m.type === 'interactive' && m.interactive.list_reply)
          incoming = { kind: 'reply', id: m.interactive.list_reply.id };
        else if (m.type === 'button') incoming = { kind: 'reply', id: m.button.payload };
        else incoming = { kind: 'unsupported' };
        events.push({ from: m.from, messageId: m.id, incoming });
      }
    }
  }
  return events;
}

module.exports = { createWhatsAppClient, parseIncoming };
