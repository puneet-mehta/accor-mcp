# accor-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an LLM search Accor hotels, look up rooms, and pull live nightly pricing in any currency — including ALL loyalty member rates.

Built in TypeScript. Runs in **two transport modes**:

- 🖥️ **stdio** — for local use with Claude Desktop / Claude Code / any local MCP client
- 🌐 **Streamable HTTP** — for self-hosted/cloud deployment, multi-user access, or sharing with friends

### 🐒 Why this exists

Planning a month-long stay turned into an afternoon of tab-juggling:

- 🗂️  A dozen hotel pages open at once, hunting for "1BR with kitchen + balcony"
- 🧮  Mental-mathing 31 × nightly to compare totals
- ❌  Retrying when a property silently capped reservations at 28 nights
- 🤷  Brand filters that hide apartments at Mercure, Pullman, Sofitel…

So I taught Claude to do all of it. **One prompt → side-by-side comparison → member-tier pricing → chunked-stay strategies → bookable links.**

---

## ⚠️ Disclaimer

> **This is a personal learning project. It is not affiliated with, endorsed by, or sponsored by Accor SA, ALL Accor Live Limitless, or any of their subsidiaries.**
>
> - The MCP only consumes **publicly accessible** endpoints exposed by `all.accor.com` — the same endpoints the website itself calls when you (an unauthenticated visitor) browse, search, or use the homepage's "Just enter your card number" widget.
> - **No login flows, no scraping behind authentication walls, no data that requires a password.** Functionality that requires an authenticated user account (e.g. a personal points balance, booking history, profile editing) is intentionally **NOT** wired up.
> - The "member card number" parameter is treated exactly as the public homepage widget treats it: an identifier you voluntarily enter to see your tier-specific rates. Card numbers are not scraped, harvested, or stored — the MCP forwards what you provide directly to Accor's own affiliation endpoint and uses the returned session token for that single rate lookup.
> - Endpoints, schemas, and credentials embedded in the public Accor frontend can change at any time. This project may break without notice.
> - You are responsible for complying with [Accor's Terms of Service](https://all.accor.com/) when using this tool. **Use at your own risk and responsibility.** Don't use it to make commercial bookings programmatically, don't automate it against rate-limited endpoints, don't redistribute discovered API keys or schemas in a way that violates ToS.
>
> If you work at Accor and want this taken down or modified, please open an issue.

---

## Tools

| Tool | Purpose |
|---|---|
| `search_hotels` | Find hotels by destination/brand/stars. Optional `has_apartment=true` flag actually verifies (via GraphQL) which properties have apartment-classified rooms — surfaces apartments at non-Adagio brands (Mercure, Pullman, Sofitel, Mövenpick, Fairmont) that the brand filter alone misses. |
| `get_hotel_details` | Lightweight Algolia-backed hotel info (address, GPS, amenities, rating, photos). |
| `get_hotel_details_graphql` | Heavyweight HotelPageCold payload — adds GM welcome message, full advantages list, certifications, facilities catalog (restaurants, bars, pools, spas, fitness, breakfast), recent guest reviews, media gallery, room-occupancy limits, payment methods. |
| `list_hotel_rooms` | Full accommodation catalog for a hotel — codes, sizes (m²), bedding, classification (room/suite/apartment), key features. Use codes with `accommodation_code` on `get_hotel_rates`. |
| `search_special_rates` | New openings, highly-rated, or 5★ luxury filters. |
| `get_hotel_rates` | Day-by-day INR/USD/EUR/etc. pricing via GraphQL BFF. Returns: per-night breakdown, full-stay package options (room only / breakfast / half board / flexible / non-refundable), and **booking strategies** — tests full-stay + 2-week + 1-week chunkings to reveal which lengths the property actually allows (most cap at <31 nights). Optional `member_card_number` unlocks tier-specific rates. Optional `accommodation_code` filters to a specific room type. |

---

## Quick start — Local (stdio)

Best for: personal use with Claude Desktop, local development, no exposing the server to the network.

### Prerequisites

- Node 20+ (uses native `fetch`)
- npm

### Install & build

```bash
git clone https://github.com/puneet-mehta/accor-mcp.git
cd accor-mcp
npm install
npm run build
```

### Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add:

```json
{
  "mcpServers": {
    "accor": {
      "command": "node",
      "args": ["/absolute/path/to/accor-mcp/build/index.js"]
    }
  }
}
```

Restart Claude Desktop. Then ask things like:

- *"Find apartment stays in &lt;city&gt; from &lt;date&gt; for two weeks"*
- *"What 1-bedroom options does this property have?"*
- *"Get day-by-day rates for hotel ID &lt;hotel_id&gt; for these dates in &lt;currency&gt;"*
- *"Compare these two properties for a month-long stay using my ALL card &lt;card_number&gt;"*

### Try it standalone (without Claude)

```bash
npx @modelcontextprotocol/inspector build/index.js
```

---

## Quick start — Remote (Streamable HTTP)

Best for: deploying once and using from anywhere, sharing with friends/family, integrating with web clients, running on a server you control.

### Run locally in HTTP mode

```bash
npm run build
npm run start:http       # listens on http://0.0.0.0:3000/mcp
```

Or with a custom port:

```bash
PORT=8080 MCP_TRANSPORT=http node build/index.js
```

The server exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health probe (returns active session count) |
| `GET` | `/` | Index page with usage |
| `POST` | `/mcp` | JSON-RPC requests + session init |
| `GET` | `/mcp` | SSE notifications channel (requires `mcp-session-id` header) |
| `DELETE` | `/mcp` | Close a session |

### Connect Claude Desktop to a remote HTTP server

Claude Desktop doesn't yet speak Streamable HTTP natively, so use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge:

```json
{
  "mcpServers": {
    "accor": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-domain.com/mcp"]
    }
  }
}
```

For clients that **do** speak HTTP/SSE directly (Claude.ai web, custom integrations):

```json
{
  "mcpServers": {
    "accor": {
      "url": "https://your-domain.com/mcp"
    }
  }
}
```

---

## 🚀 One-click deploy

### Railway (recommended — supports stateful sessions)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/puneet-mehta/accor-mcp)

Railway picks up `railway.json` + `Dockerfile` automatically. After deploy, grab the public URL from the Railway dashboard and use it in your MCP client config.

### Render (free tier available)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/puneet-mehta/accor-mcp)

Render reads `render.yaml` for service config. Free-tier instances cold-start after 15 min idle — fine for personal use, slow for first request.

### Fly.io / Docker / VPS

Anywhere you can run a Docker container:

```bash
docker build -t accor-mcp .
docker run -p 3000:3000 -e MCP_TRANSPORT=http accor-mcp
```

For Fly.io specifically:

```bash
fly launch --image accor-mcp
fly deploy
```

> **Vercel / Cloudflare Workers caveat**: serverless platforms don't fit MCP's stateful Streamable HTTP sessions well (sessions need sticky connections + persistent SSE). Stick to Railway / Render / Fly / Docker / a regular VPS.

---

## How it works

The MCP fans out to three public Accor endpoints:

1. **Algolia search index** (`prod_hotels_en`) — embedded in the all.accor.com homepage HTML. Used by `search_hotels`, `search_special_rates`, `get_hotel_details`. Public search-only API key.
2. **GraphQL BFF** (`api.accor.com/bff/v1/graphql`) — the same backend the website calls. Used by `get_hotel_rates`, `get_hotel_details_graphql`, `list_hotel_rooms`. Public API key embedded in the frontend bundle.
3. **Affiliation endpoint** (`api.accor.com/bff/v1/affiliation-and-identification`) — same endpoint used by the homepage's "Just enter your card number" rate-lookup widget. Returns a short-lived session token (decoded as a JWT) when a valid card number is submitted.

When you pass `member_card_number` to `get_hotel_rates`:

```
[card number] → affiliation-and-identification (POST)
              → identification-token (in response headers)
              → decoded JWT payload (linked cards, tier flags, expiry)
              → identification-token header on every subsequent GraphQL call
              → personalised member-tier pricing
```

The decoded JWT card summary is shown back to the user as confirmation that the card was accepted.

---

## Project structure

```
accor-mcp/
├── src/
│   ├── index.ts              # MCP server entry — tool registrations + transport selector
│   ├── accor-client.ts       # Algolia search client + apartment-bearing filter
│   ├── graphql-client.ts     # BFF GraphQL client — rates, rooms, details, affiliation
│   └── types.ts              # Shared TypeScript types
├── build/                    # tsc output (gitignored)
├── Dockerfile                # Multi-stage build for HTTP deployment
├── railway.json              # Railway one-click config
├── render.yaml               # Render one-click config
├── package.json
├── tsconfig.json
└── README.md
```

### Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework (stdio + Streamable HTTP transports)
- `express` — HTTP server for remote mode
- `zod` — input validation

No browser automation, no Playwright, no Puppeteer. Everything is plain HTTP via `fetch`.

---

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` for local, `http` for remote |
| `PORT` | `3000` | HTTP listen port (HTTP mode only) |
| `HOST` | `0.0.0.0` | HTTP bind host (HTTP mode only) |

---

## Caveats & known limits

- **API churn**: Accor's frontend bundle changes every few weeks. If queries start 4xx/5xx-ing, the embedded API keys or GraphQL schema may have shifted. Re-extract from the live bundle.
- **Rate limits**: be polite. The MCP fans out parallel requests in batches of 10 for nightly rate queries — a long stay can produce 100+ calls per `get_hotel_rates` invocation. Don't hammer.
- **Identification token TTL**: the bootstrapped session token is short-lived. Each new `get_hotel_rates` call with a card number bootstraps a fresh one — no caching of personal data.
- **Currencies & markets**: pass `currency` (ISO 4217) and `country_market` (ISO 2-letter) to match the user's geo. Some rates only render correctly when market matches the booking origin.
- **Apartment filter**: `has_apartment=true` is N+1 (one GraphQL call per Algolia candidate). Slow on large cities; capped at 200 candidates. Most cities resolve in under a minute.
- **HTTP mode is stateful**: sessions live in process memory. Single-instance deployments only — don't horizontally scale without sticky sessions or a session store.
- **Booking**: this MCP **does not book hotels**. It returns booking URLs that you click through to complete checkout on accor.com. Bookings always happen on Accor's site, never here.

---

## Development

```bash
npm run dev              # stdio + watch mode
npm run dev:http         # HTTP + watch mode
npm run inspector        # MCP inspector UI
```

To probe new GraphQL fields, you can introspect the schema directly:

```bash
curl -s -X POST https://api.accor.com/bff/v1/graphql \
  -H 'apikey: <key from frontend bundle>' \
  -H 'app-id: all.accor' \
  -H 'app-version: 1.39.1' \
  -H 'clientid: all.accor' \
  -H 'content-type: application/json' \
  -H 'Origin: https://all.accor.com' \
  -H 'Referer: https://all.accor.com/' \
  -d '{"query":"{ __type(name:\"V2User\") { fields { name } } }"}'
```

---

## License

MIT — but **read the disclaimer above** before doing anything beyond personal use. The code is yours to learn from; the data you fetch with it is governed by Accor's ToS, not by this license.

---

## Acknowledgements

- The MCP protocol team at Anthropic
- The Accor frontend engineers who built a tidy GraphQL BFF whose introspection is enabled in production 😅
