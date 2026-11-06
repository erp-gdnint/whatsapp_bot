# WhatsApp FAQ Bot (JSON-driven, official Cloud API)

A menu bot for WhatsApp. The user taps an option and the bot replies with the next menu or an answer. The whole conversation lives in one JSON file, [flows/faq.json](flows/faq.json). The bot uses only Meta's **official WhatsApp Cloud API**, so there is no ban risk from unofficial access.

```
User's WhatsApp  ──tap──▶  Meta Cloud API  ──webhook──▶  this server (src/server.js)
                 ◀─menu──                  ◀──send API──   reads flows/faq.json
```

## 1. Try it in your terminal first (no Meta account needed)

1. Install Node.js 20 or newer from https://nodejs.org (LTS).
2. In this folder, run:
   ```
   npm install
   npm run chat
   ```
3. Type `hi`. Type a number to tap an option, or type text when the bot asks a question. `/reset` restarts and `/quit` exits.

`npm run check` validates the flow file against WhatsApp's limits (3 buttons, 20-character button titles, 10 list rows, and so on). The server also refuses to start with an invalid flow.

## 2. Connect to WhatsApp (free test number)

1. Go to https://developers.facebook.com, then **My Apps > Create app > Business**.
2. Add the **WhatsApp** product. Meta creates a free **test number** and a WhatsApp Business Account.
3. Open **WhatsApp > API Setup**:
   - In the **To** field, add up to **5** phone numbers that will test the bot. Each number receives a code to confirm.
   - Copy the **Phone number ID**.
4. Create a **permanent token**. The token on the API Setup page expires within about 24 hours.
   - Open https://business.facebook.com/settings and go to **Users > System users > Add** (role: Admin).
   - **Assign assets**: your app (full control) and your WhatsApp account (full control).
   - **Generate token**: choose your app, tick `whatsapp_business_messaging` and `whatsapp_business_management`, and set expiry to *Never*.
5. Copy the **App secret** from **App settings > Basic**.
6. Copy `.env.example` to `.env` and fill in `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `APP_SECRET`, a `VERIFY_TOKEN` of your choice, and `FRAPPE_TO_BOT_TOKEN`. The server refuses to start without them.
7. Start the server: `npm start`
8. Give it a public HTTPS URL:
   - Quick option: install ngrok and run `ngrok http 3000`, then use the `https://….ngrok-free.app` URL.
   - Always-on demo: deploy to Render (free web service). Set the build command to `npm install`, the start command to `npm start`, and enter the same values from `.env` as environment variables.
9. In the Meta app, open **WhatsApp > Configuration > Webhook > Edit**:
   - Callback URL: `https://<your-url>/webhook`
   - Verify token: the same value as `VERIFY_TOKEN`
   - Click **Verify and save**, then **Manage** and subscribe to **messages**.
10. From one of the 5 registered phones, send `hi` to the test number.

## 3. Edit the bot

### Visual builder (recommended)

```
npm run builder
```

Then open http://localhost:3100. The builder listens on your own computer only, so the tunnel never exposes it.

- **Canvas:** each card is a node. Drag a card to move it. Drag from a ● dot onto another card to connect them, or drop on empty space to create a new node there.
- **Right panel:** click a card to edit its text, options, type, or links. Click empty canvas to edit flow settings: start node, keywords, and the bot's fallback messages.
- **Preview:** a WhatsApp-style chat on the right runs your *unsaved* flow. Type `hi` and tap the buttons. The card the chat is on is marked "preview here".
- **Validation:** the status pill shows problems live, such as too many buttons, titles that are too long, or broken links. Save refuses an invalid flow, so the file the bot reads is always valid.
- **Save (Ctrl+S):** writes `flows/<name>.json` and keeps the previous version in `flows/.backup/`. A running bot reloads the file automatically; no restart needed.
- **Links to start:** "Main menu" links to the start node are hidden to keep the canvas readable. Select a node, or tick *Show links to start*, to see them.

### Flow JSON reference

Every screen is a node, and each option's `id` is the name of the next node.

| Node type | What it does | Required fields |
| --- | --- | --- |
| `list` | Menu with up to 10 rows (opens from a button) | `text`, `button` (≤20 chars), `options[{id,title≤24,description≤72}]` |
| `buttons` | Up to 10 reply buttons. WhatsApp shows 3 per message, so the rest go in follow-up messages | `text`, `options[{id,title≤20}]`, optional `moreText` (text above the extra buttons, default `…`) |
| `message` | Plain text, then continues automatically | `text`, `next` |
| `media` | Sends an image, video or document from a public `https://` link, then continues | `mediaType` (`image`/`video`/`document`), `url`, `next`, optional `caption`, `filename` |
| `input` | Asks the user to type something; re-asks if the answer doesn't match | `text`, `saveAs`, `next`, optional `validate` (`text`/`email`/`phone`/`number`/`date`/`time`), `minLength`, `errorText` |
| `action` | Runs code (API call, database, sheet) | `action`, `next`, optional `onError`, `params` |
| `template` | Sends a pre-approved WhatsApp template, then continues | `name`, `language` (e.g. `en_US`), `next`, optional `params` (body `{{1}}`, `{{2}}`…) |

Templates are created and approved in *WhatsApp Manager > Message templates*. You only need them to message a user outside the 24-hour window. Inside the window, normal buttons, lists, and text are free-form and need no approval.

- `keywords` lists words that jump to a node from anywhere, for example `menu` and `hi`.
- `{{name}}` in any text inserts a saved value, for example `{{ticket_message}}`, or `{{reference_id}}` returned by an action.
- `{{contact_name}}` (the user's WhatsApp profile name) and `{{contact_phone}}` are always available.
- Input checks save a cleaned value: phone without spaces (`+919876543210`), number with a dot (`2.5`), date as `YYYY-MM-DD`, time as `HH:MM:SS`, email in lowercase.
- Sessions expire after `settings.sessionTimeoutMinutes` in the flow (1–1440; set it in the builder's flow settings), otherwise after `SESSION_TTL_MINUTES` (default 30). After that, the next message starts again at `start`.
- Media limits (WhatsApp): image JPG/PNG up to 5 MB, video MP4 up to 16 MB, document up to 100 MB. The link must download directly without a login; Google Drive "view" links don't work.

## 4. Tickets in Frappe

The bot saves tickets in Frappe. Frappe assigns a user, sends the email, and calls the bot to alert that user on WhatsApp. The Frappe code is in [frappe-side/wa_tickets.py](frappe-side/wa_tickets.py), and the full plan is in `docs/frappe-ticket-plan.md`.

**Raising a ticket.** The user taps *Raise a ticket*, picks a type, picks a desk, and types a message. Callbacks also ask for a phone, date and time. Each choice is a `setTicket` action node, where the builder lets you pick or type the Desk and Type. The `createRequest` action generates a random 10-digit reference ID and sends the ticket to `createRequestUrl` in [config/frappe.json](config/frappe.json), with `FRAPPE_TOKEN` in the payload.

If Frappe cannot save a ticket, it is added to `data/failed-tickets.jsonl` and the user sees `ticket_failed`. **These tickets are not retried automatically, so check this file.** The builder preview and `npm run chat` never contact Frappe.

**Sending WhatsApp from Frappe.** Call this from server-side Python only, so the token never reaches a browser:

```
POST /api/frappe/notify
Authorization: Bearer <FRAPPE_TO_BOT_TOKEN>

{ "to": "919876543210", "template": "ticket_assigned", "language": "en", "params": ["WA-Travel-4829103756", "Query", "Asha", "+919812345678", "Need help"] }
```

Use this for assigned users, because a template reaches people who never chatted with the bot. Templates must be listed in `allowedTemplates`. Sending `"text"` in place of `template` works only for people who messaged the bot in the last 24 hours. `to` can also be a list of up to 10 numbers. The API allows 60 sends a minute.

## 5. Adding real APIs later

Add a function in [src/actions/index.js](src/actions/index.js) and call it from a node such as `{ "type": "action", "action": "checkOrderStatus", "next": "show_status" }`. Whatever the function returns becomes available as `{{fields}}` in later messages. `createRequest` in that file shows the pattern for a real HTTP API call.

**Sending email.** Frappe mails ticket assignees itself, so the flow no longer uses `sendMail`. It is kept for any other mail trigger. The bot does not send mail itself. The `sendMail` action POSTs a JSON payload to your Frappe whitelisted method, and Frappe sends the email:

```json
{ "type": "action", "action": "sendMail",
  "params": { "to": "sales@example.com", "subject": "Question from {{contact_name}}", "message": "{{question}}" },
  "next": "ask_done", "onError": "ask_done" }
```

Settings are in [config/mail.json](config/mail.json) and apply without a restart:
- `url`: the method, e.g. `https://erp.example.com/api/method/myapp.api.send_bot_mail`. Leave it empty to only save payloads to `data/outbox.jsonl` (handy in the simulator).
- `defaultTo`: the recipient when a node has no `to`.
- `payload`: the JSON keys your Frappe function receives. Placeholders are the node's params (`{{to}}`, `{{subject}}`, `{{message}}`, `{{reply_to}}`, or any param you add), `{{user_phone}}`, and saved values such as `{{contact_name}}`. Empty values are left out.

Put `FRAPPE_API_KEY` and `FRAPPE_API_SECRET` in `.env`; they are sent as `Authorization: token key:secret`. After the call, `{{mailResult}}` holds the method's return value if it is text. A matching Frappe method:

```python
@frappe.whitelist()
def send_bot_mail(recipients, subject, message, reply_to=None, whatsapp_number=None, contact_name=None):
    frappe.sendmail(recipients=recipients, subject=subject, message=message.replace("\n", "<br>"), reply_to=reply_to)
    return "queued"
```

Check the setup with `npm run test-mail` (or `npm run test-mail -- you@example.com`). With an empty `url`, it prints the payload instead of sending.

To scale beyond a demo:
- Replace `MemoryStore` in [src/store.js](src/store.js) with a Redis or Postgres store that has the same `get`, `set` and `delete` methods.
- Run several flows by pointing `FLOW_FILE` at another JSON file.

## 6. Risks: read before the demo

| Risk | Why | What to do |
| --- | --- | --- |
| Number ban | Happens with **unofficial** tools (whatsapp-web.js, Baileys, WAHA) that log in through WhatsApp Web. | This project uses only the official API. Never add those libraries. |
| Meta account restriction | Meta can restrict brand-new or fake Facebook accounts that create developer apps. | Use your real, established Facebook account and turn on 2-factor authentication. |
| Token expiry | The API Setup token dies within about 24 hours and the bot goes silent. | Use the permanent System User token (step 2.4). |
| Only 5 testers | The test number can message only the registered numbers. | Register the demo audience's phones in advance. |
| Bot cannot message first | Outside a 24-hour window after the user's last message, only approved templates can be sent. | Replies to users are fine. Alerts to assigned users need the approved `ticket_assigned` template. |
| Free hosting sleeps | Render's free tier sleeps after about 15 minutes idle, so the first reply can take 30–60 seconds. | Open the URL or send `hi` a few minutes before the demo. |
| ngrok URL changes | A free ngrok URL changes on every restart. | Update the Callback URL in Meta after each restart, or use Render. |
| Message costs (production) | From 1 Oct 2026, Meta gives 1,000 free service messages per number per month and charges after that. With no payment method, delivery stops; you are not charged. | No cost at demo scale. Budget for it in production. |
| Quality rating (production) | If many users block or report the number, Meta lowers its limits. | Do not send unrequested messages; let users start the chat. |
| Secrets | A leaked token lets anyone send messages as your number. | Keep `.env` out of git (already ignored). Rotate the token if it leaks. |

## Project layout

```
flows/faq.json         the conversation (edit in the builder or by hand)
builder/server.js      visual builder API (localhost only): load, validate, save, preview
builder/public/        builder UI (plain HTML/CSS/JS, no build step)
src/server.js          webhook: verifies Meta's signature, dedupes retries, sends replies
src/engine.js          flow engine (no WhatsApp code; easy to test)
src/whatsapp.js        Cloud API client + webhook parser
src/actions/index.js   your custom code / API calls (tickets, sendMail)
src/frappe.js          client for calling Frappe
src/frappe-api.js      API Frappe calls to send WhatsApp messages
src/clean.js           cleans user text before it leaves the bot
config/frappe.json     Frappe ticket method URL and allowed templates
config/mail.json       Frappe mail method URL and payload shape
src/store.js           per-user session store (swap for Redis to scale)
src/validate.js        checks flows against WhatsApp limits
scripts/chat.js        terminal simulator
```
