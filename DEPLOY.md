# Deploying MJGTCG

Two pieces, hosted separately:

- **Server** — the Colyseus WebSocket server (`src/net/server.ts`) → **Fly.io** (or any Docker host).
- **Client** — the static SvelteKit SPA (`app/`) → **Cloudflare Pages**.

The client finds the server via the build-time env var **`VITE_SERVER_URL`**. Deploy the
server first, note its URL, then build the client against it.

---

## 1. Server → Fly.io

Prereqs: a [Fly.io](https://fly.io) account and the `flyctl` CLI (`fly auth login`).

From the repo root (the `Dockerfile` and `fly.toml` live here):

```bash
fly launch --no-deploy      # pick a unique app name + a region; it updates fly.toml
fly deploy                  # builds the Dockerfile and boots the server
```

Your server is now at **`wss://<your-app>.fly.dev`** (TLS is automatic; `force_https` is on).

Notes:
- `fly.toml` keeps one machine always running (`auto_stop_machines = false`) so live games
  aren't dropped. A `shared-cpu-1x` / 256 MB machine is plenty for a hobby game.
- **In-game bug reports (optional):** the wrench button next to the chat lets players send a
  bug report. The server forwards it to a Discord channel if you set a webhook secret:
  `fly secrets set DISCORD_BUG_WEBHOOK="https://discord.com/api/webhooks/…" -a <your-app>`.
  Create the webhook in Discord: *channel* → **⚙ Edit Channel → Integrations → Webhooks → New
  Webhook → Copy URL** (a one-person server is fine — reporters need no Discord account). If the
  secret is unset, reports are just written to `fly logs` instead.
- The image only contains the server (`src/` + the three JSON data files) — no client, no
  images (see `.dockerignore`).
- Check it's up: `fly logs` should show `MJGTCG Colyseus server listening on :2567`.

### Alternative: Railway / Render
The `Dockerfile` is portable. On **Railway**: New Project → Deploy from repo → it detects the
Dockerfile → gives you `wss://<app>.up.railway.app`. On **Render**: New → Web Service → Docker.
Both inject `PORT`, which the server honours. (Render's *free* tier sleeps on idle — fine for
testing, not for a live game server; use a paid instance or Fly/Railway for real use.)

---

## 2. Client → Cloudflare Pages

In the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages
→ Connect to Git**, pick this repo, then set:

| Setting | Value |
| --- | --- |
| **Root directory** | `app` |
| **Build command** | `npm install && npm run build` |
| **Build output directory** | `build` |
| **Environment variable** | `VITE_SERVER_URL` = `wss://<your-app>.fly.dev` |
| **Environment variable** | `NODE_VERSION` = `20` (or newer) |

Save and deploy. Your game is live at `https://<project>.pages.dev`.

- The `prebuild` hook copies `images/` into the static output, so all card art is served by
  Pages.
- Changing `VITE_SERVER_URL` requires a **rebuild** (it's baked in at build time). Set it before
  the first build; if you change the server URL later, trigger a new Pages deploy.
- **Custom domain (optional):** in the Pages project → **Custom domains → Set up a custom
  domain**, add e.g. `mjg-tcg.cc`; Cloudflare provisions DNS + TLS automatically. The client keeps
  connecting to the same `wss://…fly.dev` server (a different origin — the server has no origin
  restriction), so **no rebuild is needed** unless you also move the *server* onto a custom
  subdomain (e.g. `wss://ws.mjg-tcg.cc`), in which case add a `fly certs add` cert, update
  `VITE_SERVER_URL`, and redeploy the client.

---

## 3. Verify

Open the Pages URL, create a game, and check the browser console — the WebSocket should connect
to your `wss://…` server (not `ws://localhost`). Open a second tab/device, join the room code,
and confirm moves + chat sync.

---

## Local development (unchanged)

No env var needed — the client falls back to `ws://<host>:2567`:

```bash
npm run server                # game server on :2567 (repo root)
npm --prefix app run dev      # client on :5174
```
