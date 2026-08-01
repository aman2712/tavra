# Tavra

Tavra is a message-native travel recovery service. This vertical slice is
deliberately small: when the configured Linq number receives a text over
iMessage, Tavra uses OpenAI to produce one concise, sensible reply in the same
chat.

## What is implemented

- Linq Partner API V3 and the pinned `2026-02-03` webhook format.
- Standard Webhooks signature verification using Linq's official SDK.
- iMessage-only handling: SMS and RCS events are ignored.
- Stateless OpenAI Responses API generation with no tools, web access, or memory.
- Concise travel-support prompt that does not claim live data or completed actions.
- Same-chat text reply with a deterministic Linq idempotency key.
- Persistent inbound event deduplication in `data/processed-events.jsonl`.
- A webhook setup command scoped to the configured Linq phone number.
- Health endpoints and structured logs without message bodies or phone numbers.

## Requirements

- Node.js 22 or newer.
- A Linq Partner API V3 token and provisioned iMessage number.
- An OpenAI API key with API billing enabled.
- A public HTTPS URL forwarding to the local port. The current setup uses a
  Microsoft dev tunnel.

## Configure

Copy `.env.example` to `.env` and set:

```dotenv
LINQ_API_KEY=...
LINQ_MODE=live
LINQ_FROM_NUMBER=+12025551234
LINQ_WEBHOOK_SECRET=...
PUBLIC_BASE_URL=https://your-public-tunnel.example
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
PORT=3000
```

`OPENAI_MODEL` is optional and defaults to the cost-efficient `gpt-5-mini`.
The key remains server-side and is never sent through Linq or included in logs.

Never commit `.env`. When a subscription is created by the setup command, its
one-time signing secret is saved to `.env` without being printed.

## Run

```bash
npm install
npm run typecheck
npm test
npm run dev
```

In a second terminal, make sure the public tunnel forwards to `PORT`, then
configure Linq:

```bash
npm run linq:subscriptions
npm run linq:subscribe
```

### Scripted VS Code port forwarding

VS Code's Ports view uses Microsoft Dev Tunnels. To host the existing
`PUBLIC_BASE_URL` from a script, install and authenticate the matching CLI once:

```bash
brew install --cask devtunnel
devtunnel user login -g
```

Then start Tavra and its existing public port forward together:

```bash
npm run dev:imessage
```

To verify the saved tunnel mapping without starting the server or tunnel:

```bash
npm run tunnel:vscode:check
```

This supervises both long-running processes in one terminal. Pressing Ctrl+C
stops both, and if either process fails the other is shut down as well.

The tunnel script validates that the hostname and `PORT` match, resolves VS
Code's public hostname to the authenticated account's actual tunnel ID, and
hosts it with anonymous access because LINQ webhooks cannot complete an
interactive tunnel login. Keep the webhook signature enabled: the public route
is reachable by anyone who knows its URL, while Tavra accepts only requests
signed with `LINQ_WEBHOOK_SECRET`.

`linq:subscribe` creates or updates this target:

```text
https://your-public-tunnel.example/webhooks/linq?version=2026-02-03
```

It subscribes only to `message.received` and filters events to
`LINQ_FROM_NUMBER`.

## Verify from Messages

1. Start Tavra and the tunnel with `npm run dev:imessage`.
2. Confirm `https://your-public-tunnel.example/health` returns `{"status":"ok"}`.
3. From an iMessage-capable Apple account, send a short travel question to the
   provisioned Linq number.
4. The same blue-bubble thread should receive a concise Tavra reply.

Useful local checks:

```bash
curl http://localhost:3000/health
npm run smoke:openai
npm run smoke:webhook
npm run build
```

`smoke:openai` makes one small Responses API request without using Linq.
`smoke:webhook` sends a correctly signed SMS fixture through the public tunnel
and repeats it to verify persistent deduplication. Because SMS is ignored, that
test never calls OpenAI or sends an outbound message.

The webhook request stays open while the Linq send completes. A send failure
returns HTTP 500 so Linq can retry. A bad signature returns HTTP 401 and is not
retried. Duplicate webhook deliveries either share the in-flight result or are
ignored after the first successful send.

## Routes

- `GET /` - service identity and active feature.
- `GET /health` - liveness check.
- `POST /webhooks/linq` - signed Linq webhook receiver.

Linq documentation: [Quickstart](https://docs.linqapp.com/getting-started/quickstart/),
[webhooks](https://docs.linqapp.com/guides/webhooks/), and
[sending messages](https://docs.linqapp.com/guides/messaging/sending-messages/).

OpenAI documentation: [text generation](https://developers.openai.com/api/docs/guides/text)
and [model guidance](https://developers.openai.com/api/docs/guides/latest-model).
