# MJGTCG

An online, multiplayer fan-made trading card game — a **rules-enforcing TypeScript engine**, a
**Colyseus** game server, and a **SvelteKit** web client. Create or join a room, play by the
rules (the engine handles turns, priority, and the chain), or drop into a free-form **Manual**
mode for cards that aren't scripted yet.

**▶ Play:** <https://mjg-tcg.cc> · **Server:** `wss://mjgtcg.fly.dev`

> Non-commercial fan project. Code is MIT-licensed; the card art and names are not — see
> [Assets & license](#assets--license).

---

## The card list

The canonical source of truth for every card — stats, text, tribes, and rulings — is the sheet:

**📄 [MJGTCG card sheet](https://docs.google.com/spreadsheets/d/1zILEX3kWDZFPiBuVYW-9TfV10JgkWh44cyYIG9Yizmc/edit?gid=420648330#gid=420648330)**

When a card's behaviour is ambiguous in code, the sheet wins. The parsed data the engine actually
loads lives in [`base_set.json`](base_set.json); see [Card data](#card-data) below for how it's
produced.

---

## Tech stack

| Piece | What | Where |
| --- | --- | --- |
| **Engine** | Pure, deterministic rules engine (card scripts, effects, triggers, stat & aura resolution). Ported from a Python reference. | `src/engine/` |
| **Server** | Node + [Colyseus](https://colyseus.io) 0.15. Authoritative rooms; sends per-seat **views** over WebSocket. | `src/net/` |
| **Client** | SvelteKit **static SPA** (`adapter-static`). No SSR — it just talks to the server. | `app/` |
| **Card data** | Card definitions + card→art manifest, derived from the sheet. | `base_set.json`, `manifest.json` |

Requires **Node 20+** (CI and production run on 22).

---

## Repository layout

```
.
├── src/
│   ├── engine/         # rules engine: card scripts, effects, triggers, stats, auras, restrictions
│   ├── net/            # Colyseus server — server.ts, GameRoom.ts, session.ts, manual.ts (+ tests)
│   ├── decks.ts        # deck lists
│   └── harness/        # dev/test harness
├── app/                # SvelteKit web client (static SPA)
│   └── src/
│       ├── routes/     # +page.svelte — the app shell (menu, lobby, game)
│       └── lib/        # Board, Card, Chat, ManualBoard, menu/, sampleView, …
├── images/             # card art (copied into app/static/images at build time)
├── base_set.json       # parsed card definitions the engine loads
├── manifest.json       # card id → art path (built by build_manifest.py)
├── MJGTCG.xlsx         # spreadsheet snapshot of the card sheet
├── build_manifest.py   # rebuilds manifest.json + validates art against the card list
├── Dockerfile          # server image (Fly.io / any Docker host)
├── fly.toml            # Fly.io server config
└── DEPLOY.md           # full deployment walkthrough
```

---

## Getting started (local dev)

You need two processes: the **game server** and the **web client**.

```bash
# 1. clone
git clone https://github.com/KAAAAAAAAAAAN/MJGTCG.git
cd MJGTCG

# 2. install deps (root = engine/server, app = client)
npm install
npm --prefix app install

# 3. run the game server on :2567
npm run server

# 4. in a second terminal, run the client on :5174
npm --prefix app run dev
```

Open <http://localhost:5174>, then open a **second tab** (or device on your LAN) to join the room
code and play. No env var is needed locally — the client falls back to `ws://<host>:2567`.

---

## Checks before you commit

Contributions must keep all four of these green. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml))
runs them on every push and pull request:

```bash
npm run typecheck            # tsc --noEmit (engine + server)
npm test                     # vitest (the engine's rules are heavily unit-tested)
npm --prefix app run check   # svelte-check (client types)
npm --prefix app run build   # the client must build
```

The engine is the heart of the project and is covered by hundreds of tests — **if you touch a
rule, add or update a test for it.**

---

## Card data

The sheet is the spec; the engine loads JSON derived from it.

- **[`MJGTCG.xlsx`](MJGTCG.xlsx)** — a snapshot export of the [card sheet](https://docs.google.com/spreadsheets/d/1zILEX3kWDZFPiBuVYW-9TfV10JgkWh44cyYIG9Yizmc/edit?gid=420648330#gid=420648330).
- **[`base_set.json`](base_set.json)** — the parsed card definitions the engine reads at runtime.
- **[`manifest.json`](manifest.json)** — maps each card id to its art in `images/`. Rebuilt and
  validated by `build_manifest.py` (needs Python + `openpyxl`); it flags cards with missing art
  and art with no card.

The client's `sync-images` script copies `images/` into `app/static/images` before every dev run
and build, so all art is served by the client.

**Implementing a card:** unscripted cards are treated as *vanilla* (their text does nothing) and
can still be played in **Manual** mode. To make a card's text actually resolve, script its effect
in `src/engine/` to match the sheet, and add a test.

---

## Deployment

The client and server deploy **separately, by different mechanisms** — see [`DEPLOY.md`](DEPLOY.md)
for the full walkthrough. The short version:

| | Host | How it deploys |
| --- | --- | --- |
| **Client** (`app/`) | Cloudflare Pages | **Auto-deploys** on push to `main`. Build: `npm install && npm run build`, output `build`, env `VITE_SERVER_URL=wss://…`. |
| **Server** (`src/net/`) | Fly.io | **Manual** — run `fly deploy` from the repo root (builds the `Dockerfile`). A git push does **not** deploy the server. |

> ⚠️ **A push only ships the client.** The Fly server is not git-connected, so any server-side
> change needs a `fly deploy`. Because the client bakes in `VITE_SERVER_URL` at build time and the
> two hosts deploy independently, ship server changes that add new client↔server messages **before**
> (or together with) the client that uses them.

**In-game bug reports (optional):** the wrench button next to the chat lets players send a bug
report, which the server forwards to a Discord channel if `DISCORD_BUG_WEBHOOK` is set as a Fly
secret (`fly secrets set DISCORD_BUG_WEBHOOK="…" -a mjgtcg`). Unset → reports go to `fly logs`.

---

## Contributing

1. Fork / branch off `main`.
2. Make your change; if it touches a rule, add or update a test.
3. Run the [four checks](#checks-before-you-commit) — all green.
4. Open a PR. CI must pass before merge.

Found a bug while playing? Use the **wrench button** next to the in-game chat, or open a GitHub issue.

---

## Assets & license

The **source code** (engine, server, client, tooling) is released under the [MIT License](LICENSE).

The **game assets are not** — the card artwork, names, likenesses, and references are modified
from or reference third-party games and media and remain the property of their respective owners.
This is a non-commercial, transformative fan work. If you're a rights holder and want something
removed, please [open an issue](https://github.com/KAAAAAAAAAAAN/MJGTCG/issues). See [`LICENSE`](LICENSE)
for the full notice.
