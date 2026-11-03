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
6. Copy `.env.example` to `.env` and fill in `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `APP_SECRET`, and a `VERIFY_TOKEN` of your choice.
7. Start the server: `npm start`
8. Give it a public HTTPS URL:
   - Quick option: install ngrok and run `ngrok http 3000`, then use the `https://….ngrok-free.app` URL.
   - Always-on demo: deploy to Render (free web service). Set the build command to `npm install`, the start command to `npm start`, and enter the same values from `.env` as environment variables.
9. In the Meta app, open **WhatsApp > Configuration > Webhook > Edit**:
   - Callback URL: `https://<your-url>/webhook`
   - Verify token: the same value as `VERIFY_TOKEN`
   - Click **Verify and save**, then **Manage** and subscribe to **messages**.
10. From one of the 5 registered phones, send `hi` to the test number.

## 3. Edit the bot (flows/faq.json)

Every screen is a node, and each option's `id` is the name of the next node.

| Node type | What it does | Required fields |
| --- | --- | --- |
| `list` | Menu with up to 10 rows (opens from a button) | `text`, `button` (≤20 chars), `options[{id,title≤24,description≤72}]` |
| `buttons` | Up to 3 reply buttons | `text`, `options[{id,title≤20}]` |
| `message` | Plain text, then continues automatically | `text`, `next` |
| `input` | Asks the user to type something | `text`, `saveAs`, `next`, optional `minLength`, `errorText` |
| `action` | Runs code (API call, database, sheet) | `action`, `next`, optional `onError`, `params` |

- `keywords` lists words that jump to a node from anywhere, for example `menu` and `hi`.
- `{{name}}` in any text inserts a saved value, for example `{{question}}`, or `{{ticketId}}` returned by an action.
- Sessions expire after `SESSION_TTL_MINUTES` (default 30). After that, the next message starts again at `start`.

## 4. Adding real APIs later

Add a function in [src/actions/index.js](src/actions/index.js) and call it from a node such as `{ "type": "action", "action": "checkOrderStatus", "next": "show_status" }`. Whatever the function returns becomes available as `{{fields}}` in later messages. `saveQuestion` in that file shows the pattern, with a commented example of a real HTTP API call.

To scale beyond a demo:
- Replace `MemoryStore` in [src/store.js](src/store.js) with a Redis or Postgres store that has the same `get`, `set` and `delete` methods.
- Run several flows by pointing `FLOW_FILE` at another JSON file.

## 5. Risks: read before the demo

| Risk | Why | What to do |
| --- | --- | --- |
| Number ban | Happens with **unofficial** tools (whatsapp-web.js, Baileys, WAHA) that log in through WhatsApp Web. | This project uses only the official API. Never add those libraries. |
| Meta account restriction | Meta can restrict brand-new or fake Facebook accounts that create developer apps. | Use your real, established Facebook account and turn on 2-factor authentication. |
| Token expiry | The API Setup token dies within about 24 hours and the bot goes silent. | Use the permanent System User token (step 2.4). |
| Only 5 testers | The test number can message only the registered numbers. | Register the demo audience's phones in advance. |
| Bot cannot message first | Outside a 24-hour window after the user's last message, only approved templates can be sent. | Not an issue for this bot, which always replies to the user. Just ask people to send `hi` first. |
| Free hosting sleeps | Render's free tier sleeps after about 15 minutes idle, so the first reply can take 30–60 seconds. | Open the URL or send `hi` a few minutes before the demo. |
| ngrok URL changes | A free ngrok URL changes on every restart. | Update the Callback URL in Meta after each restart, or use Render. |
| Message costs (production) | From 1 Oct 2026, Meta gives 1,000 free service messages per number per month and charges after that. With no payment method, delivery stops; you are not charged. | No cost at demo scale. Budget for it in production. |
| Quality rating (production) | If many users block or report the number, Meta lowers its limits. | Do not send unrequested messages; let users start the chat. |
| Secrets | A leaked token lets anyone send messages as your number. | Keep `.env` out of git (already ignored). Rotate the token if it leaks. |

## Project layout

```
flows/faq.json         the conversation (edit this)
src/server.js          webhook: verifies Meta's signature, dedupes retries, sends replies
src/engine.js          flow engine (no WhatsApp code; easy to test)
src/whatsapp.js        Cloud API client + webhook parser
src/actions/index.js   your custom code / API calls
src/store.js           per-user session store (swap for Redis to scale)
src/validate.js        checks flows against WhatsApp limits
scripts/chat.js        terminal simulator
```
