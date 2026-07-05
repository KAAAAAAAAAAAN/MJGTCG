# MJGTCG — Complete Rules Reference

> Authoritative rules reconstructed from `firstconvp1.txt` / `firstconvp2.txt`
> (the design conversation; lines under `ME:` are the designer's word and are
> authoritative). Detailed rulings/glossary: `_faq_dump.txt`. The card-text
> grammar in `_psct_dump.txt` is **CANON** (designer-confirmed). Real card
> examples: `_base_set_dump.txt` / `base_set.json`. Items the spec left open are
> marked **[OPEN]** — do not invent answers for those.

---

## 1. Overview

MJGTCG is an online card game for **2–4 players**. There is **no life total**;
players never take "damage." The core goal is building **melds** (a
mahjong-inspired mechanic). **The default win condition is completing 4 melds**,
but **specific cards define their own win conditions** (e.g. "What are the
odds..." reads *"You win the game"*; a player may also declare victory by
demonstrating a guaranteed/infinite winning loop — see Phoenix ruling).

Players share two decks (Main + Faith) and one discard pile. Turns proceed in
**fixed anti-clockwise order**. On a turn a player may summon, attack, meld, KAN,
and activate effects, with opponents able to respond on a **chain/stack** at
defined windows.

The engine is an **authoritative server** modeled as an explicit **state
machine**. Clients never mutate state directly.

> Seat terms (mahjong): **shimocha** = the player to your right (next in
> anti-clockwise turn order). Some cards move cards to "your shimocha's board."

---

## 2. Components & Zones

**Shared (not per-player):**
- **Main deck** — starting hands and turn draws come from here. Some cards draw
  from the **top**, some the **bottom**.
- **Faith deck** — searched/drawn from mainly by completing a meld or via KAN /
  specific effects; holds powerful **Faith cards**. Large enough that it should
  not deplete before someone wins.
- **Discard pile** — a single ordered **stack**. Only the **top card** is
  normally usable (e.g. as meld material); effects may reorder it or pull from
  the bottom.
- **Banish zone** — cards can be **banished** (removed from play, distinct from
  discard). Some cards count banished cards or interact with them (e.g. gain
  stats "for each banished card", "banish 6 cards from your hand to summon").

**Per-player:**
- **Hand** — hidden, **unlimited** during the turn; at end of turn discard down
  to a **maximum of 10**.
- **Board** — **unlimited** cards. Holds summoned characters. Cards may be
  **face-up** or **face-down** (face-down cards are treated as if they do not
  exist), and may have **overlaid** cards and **counters** attached.
- **Meld zone** — completed melds (bottom-right of the player). Melded cards do
  **not** count as "on board" and generally **cannot be interacted with**.

**Tapping:** a card **taps** when it attacks or uses an Active effect, and then
cannot attack / use an Active again until it untaps. **All cards untap when the
player ends their turn.** Cards are **summoned untapped**.

---

## 3. Card Stats & Types

Card data columns (per `base_set.json` / `_base_set_dump.txt`):
**ID#**, **N**ame (card title), **F**lavor (face text), **A**TK, **D**EF,
**V**ALUE, category, plus **Rulings** / **Notes**. There is also a **tribe/type**
tag (e.g. Schizo, Hag, Cunny, Furry, Dragon, Uma, Winged Beast, Male/Female).

Every card has **3 numeric-ish stats**: **ATK**, **DEF**, **VALUE**.
- **VALUE** drives **melding** (sequences/triplets/KAN) and many effects.
- **ATK / DEF** decide **battles** (see 6).
- VALUE may be **`☆` (wild/any)** and is occasionally **fractional** (e.g. 2.5).

**Card categories** (column flag): 
- **P — Passive**: always active while the card is on the field. Affects all
  players on any turn unless the card says otherwise. May be **(Mandatory)**.
- **A — Active**: controller chooses to activate **on their turn**; **taps** the
  card.
- **S — Spell**: activated **from the hand**.
- **F — Faith**: see below.
- **B — Brick**: dead card (e.g. "The Brick" — cannot be summoned, discarded, or
  banished from hand).
- **`-`** : vanilla / no effect.

Common timing/clause prefixes seen on real cards:
- **(At any time)** — quick-effect / hand-trap analogue; usable in open windows,
  including by non-turn players.
- **(Once per turn)**, **(Once per player)**, **(Mandatory)**,
  **(Cannot be Negated)**, **(CbNS)** = *Cannot be Normal Summoned*.

**Faith cards (F):** powerful cards that sit in the hand like any other.
- They generally **cannot be normal summoned** (CbNS).
- Each has a **unique Faith summoning condition** (e.g. "discard cards from hand
  and/or board totaling exactly 7 DEF"; "overlay on a [Cunny]"; "banish 6 cards
  from your hand"). **No standard template — most are unique.**
- They can also be **special summoned** by other effects unless stated otherwise.

> Card pool: ~**100–200 mostly-unique cards** (base set ~48 numbered + colab/C
> cards). Engine is **scripted-first** (each card = data + a script over a
> controlled API) with shared helpers only for generic effects.

---

## 4. Summoning

- **Default:** **every card can be normal summoned** unless its text/category says
  otherwise (e.g. Faith cards and **(CbNS)** cards).
- **Normal summon:** **one per turn** by the turn player.
- **Special summon:** triggered by effects; **unlimited** per turn.
- **Overlay:** some cards summon by overlaying onto another character; previously
  overlaid cards travel along; overlaying "counts as summoning."
- Faith / CbNS cards cannot be normal summoned.
- Cards enter the field **untapped**.

---

## 5. Melds, KAN & the Win Condition

A **meld** is **three cards** with either:
- **sequential VALUE** (e.g. 2-3-4), or
- **the same VALUE** (a **triplet**, e.g. 6-6-6).

Meld materials come from the player's **own board** and/or the **top card of the
discard pile** (and some cards allow hand/other sources).

- **Normal meld:** **one per turn**.
- **Special meld:** granted by card effects; **unlimited** per turn. Some effects
  turn a Normal Meld into a Special Meld (e.g. melding with a [Furry]).
- Completing a meld typically lets you **draw 1 from the Faith deck** unless
  stated otherwise.
- **Melded cards leave the board** into the meld zone and become
  non-interactable.
- A **tapped** card **may** be used as meld material.

**KAN** (mahjong fourth-tile): you may **add a fourth card to a triplet meld**.
- A triplet meld can be KAN'd using a matching-VALUE card from hand / top of
  discard (per cards like SAKI).
- **On KAN you draw the BOTTOM card of the Main Deck** (some cards replace this,
  e.g. search the Faith Deck instead).
- KANs **do not count as triplets** for effects that check "triplet melds."
- Cards exist that act as **any VALUE for a KAN**.

**Win:** default = reach **4 melds** (any mix of normal/special). Note
individual cards can grant alternate wins; treat card text as authoritative over
the default.

> One card (**HATS / "keikumusume"**) can **negate a meld** that uses a discard-
> pile card and steal it — an example of a response **on meld declaration**.
> Negated Normal Melds are "used up."

---

## 6. Battle

The turn player may have any **untapped** board card attack **any** character on
**any opponent's** board (not restricted to one opponent).

**Battle is deterministic** — there are **no quick effects that change stats
mid-battle**. Steps (matching the FAQ battle sub-windows):

1. **Battle declaration** (*Initiate Battle*) — **open** window. The attacker has
   committed; opponents/turn player may respond.
2. **Determine Battle** — **closed**, deterministic: the outcome (who *would be*
   discarded) locks and computes; **nothing changes stats mid-battle**.
3. **Battle-discard window** (*Attackee / Attacker Discarded*) — **open**. The
   would-be-discarded cards are pending; their controllers hold priority and may
   apply **replacement effects** (see below) *before* the discard happens.
4. **Finalize & post-battle** — losers not saved by a replacement are discarded
   (defender first, attacker last), firing "after discarded by battle" triggers;
   then a final **open** post-battle window.

**Resolution:** compare attacker ATK vs defender DEF **and** vice versa:
- ATK **>** the other card's DEF → that other card is **discarded**.
- DEF **≥** the attacking ATK → that card is **not** discarded.
- **Mutual destruction:** the **attacking card is discarded last**.

After attacking, the attacker becomes **tapped** unless an effect says otherwise.

### Replacement effects ("…instead")

A **replacement** modifies the would-be-discard *as it happens*, in the
battle-discard window (step 3) — it is **not** a normal after-the-fact response,
and a card saved by a replacement is **never discarded** (so "after this card
discards another by battle" does **not** fire for it). Two forms exist on
**Miko (UGR-005)**:

- **Mandatory passive** (bottom, on board): "you **must** discard this card
  instead" — auto-redirects the discard to the Miko; resolves automatically with
  no prompt. (A Miko cannot replace its **own** discard.)
- **Optional hand-trap** (top, *At any time*, in hand): "you **can** Special
  Summon this card instead" — offered to the affected controller in the
  battle-discard window through the normal chain/priority flow (gated by their
  **chain toggle**: *off* = not prompted, the card is discarded; *auto/always* =
  may activate to save it). Activating it Special Summons the Miko and cancels
  the pending discard.

---

## 7. The Stack / Chain / List & Priority

> Per `_psct_dump.txt`: "This mechanic is **more similar to MTG than Yu-Gi-Oh**,
> as you **cannot chain-block** and can **keep adding to it at any point**."

- It is called **the stack / the chain / the list** interchangeably.
- **An activated card is public** (as in Yu-Gi-Oh): the instant a card is activated
  its identity is revealed to everyone and stays on the (public) chain until it
  resolves — so opponents can see what's been activated, and what it targets, when
  deciding whether to respond.
- **LIFO**: links resolve in reverse order; but priority is **passed around the
  board (anti-clockwise)** and the stack can be **added to at any point** before
  it resolves.
- A player **may respond to themselves** before passing priority.
- **Mandatory Passive effects** must be chained immediately when their owner
  receives priority (worked example: Kaguyahime + Walls + Miko + Yuzu).
- A successfully-summoned card's triggered Passive **still resolves even if that
  card is later discarded** before resolution.

**Open response windows** occur:
- after a player **draws for turn**,
- on **summon** (normal/special),
- on **battle declaration** and **post-battle**,
- on **effect declaration** and **effect resolution**,
- on **meld** (normally before/after; **on declaration** only for the meld-negator),
- when a **card is discarded** / leaves play (cards trigger off these).

**Chain toggles (per player, like Master Duel):** **none** / **auto** / **always on**.
You are only ever prompted when you actually have a legal response. The toggle picks
*which open windows* prompt you:
- **none (off):** never prompted — auto-pass everything.
- **auto:** prompted only when **reacting to an opponent's action** (their summon /
  battle / effect on the chain, or a battle discard they caused). Your own action
  windows and quiet phase-boundary / post-resolution windows do **not** prompt.
- **always on:** prompted at **every** open window where you can respond — including
  responding to your **own** actions and at phase-boundary windows (e.g. Special
  Summoning YUZU during your draw or the starting-hands window).

**Activation conditions cannot be responded to.** You may only respond once a
card/effect is actually placed on the stack (see PSCT timing below).

### Turn phases & open windows (per FAQ)
A turn is a sequence of phases. At every phase marked **open** below, players hold
priority anticlockwise and may respond / activate (At any time) effects / Special
Summon "any open window" cards (e.g. YUZU). "Batched" phases resolve their
passive/triggered effects first — **anticlockwise from the turn player, each owner
ordering their own** — then leave the window open. Phases marked **closed** open no
window (purely mechanical).

| Phase | Open? | Notes / examples |
|-------|-------|------------------|
| **Turn Change** (start of a turn) | **closed** | flip cards face-up, "stuns"/timed effects wear off |
| **Draw for Turn** | **open** | draw 1; on-draw triggers (Ya Boy); responses allowed |
| **Start of Turn** | **open** | batched "at the start of your turn" effects |
| **First Action / Turn Actions / Last Action** | **open** | the main phase; every action opens its own window |
| **End of Turn** | **open** | batched "at the end of your turn" effects (Sprout, Drnuk…) |
| **Hand-Size Discard** | **open** | discard down to your limit **one at a time**, each respondable (Gyrau) |
| **Turn Change** (to next player) | **closed** | as above |

(Battle sub-windows: **Initiate Battle** open, **Determine Battle** closed
deterministic, **Attackee/Attacker Discarded** open. Melding: **Meld**, **Melded**,
**Draw Faith Card** all open.)

The window is "open" regardless of whether any trigger fires — it simply *can* be
responded to; if no one acts it proceeds. Note **"first action" can miss timing**
if a Start-of-Turn (batched) effect resolved first.

**Starting Hands** (game start) is also an **open** window — after the 5-card deal
(one at a time, anticlockwise from the first player) players may respond / SS
before the first turn's draw. (Turn-order setup itself, and End of Game, are
closed.)

---

## 8. PSCT — Problem-Solving Card Text grammar (CANON)

Card text is precise. Connectors and punctuation define timing and dependency.
**Everything before a colon `:` is an ACTIVATION CONDITION** (cannot be responded
to; you cannot "miss timing" — `if` and `when` are equivalent here).

**Conjunctions / punctuation:**

| Form | Meaning | Dependency | Respond between? |
|------|---------|------------|------------------|
| **`then`** = **`;`** (semicolon) | sequential | must do A to do B | **YES** |
| **`.`** (full stop) = **`next`** | sequential | try both; independent | **YES** |
| **`if you do`** (iyd) | sequential | must do A to do B | **NO** (rare) |
| **`and`** / **`and then`** | sequential-both | must be able to do A **and** B to activate | **NO** |
| **`also`** | simultaneous | try both; independent | **NO** |

Notes:
- The **`;`/`then`** chain: if you can't or don't do A, you can't do B; if you
  can't do B, you still did A. Opponents **can** respond between A and B.
- **`.`/`next`**: if you can't do A you can still try B and vice-versa; responses
  allowed between.
- **`and`/`and then`**: because all effects already happen in written order,
  "and then" == "and". You must be **able to perform both** to activate; no
  responses until after.
- **`if you do` / `also`**: like `then`/`next` respectively, **but** the effect
  cannot be chained to until **after the entire sentence** (AAT — "and at
  then?"-style atomic block). `if you do` is **VERY RARE**.
- **Targeting** that fails: you can often still **activate** (and pay/target what
  you can) but the dependent part does nothing.
- **"Target" vs "choose" — WHEN the pick is made.** A **target** is locked at
  **activation** (announced with the effect, public, and respondable; the dependent
  part fizzles if the target becomes invalid). A **choose** (no "target" keyword,
  e.g. Yuzu "Special Summon this card to **any board**") is decided at
  **resolution** — hidden until then and not respondable. The engine reflects this:
  targets are picked by the client before announcing; "choose" effects are prompted
  to the resolving link's controller just before that link resolves.

**Worked timing (draw-negate hand trap):**
`If a draw effect is activated:` (condition — no response) `Special Summon this
card;` (respond to the Special Summon) `Negate that effect and` (the negate
rides with the summon — no response to `and`) `discard that card.` (negate +
discard happen together; respond only after the full stop).

---

## 9. Resolution Rules (atomicity)

Resolution is **atomic** with one exception:

- **No effects activate mid-resolution.** Once an action begins resolving it
  completes before anything else activates. A meld must complete fully before
  another effect may be activated. (PSCT note: effects "resolve down the
  stack/chain" but you can only respond at the punctuation points in §8.)
**Discards are always one-at-a-time and respondable (FAQ).** Whenever an effect
discards **multiple cards** (e.g. a global board wipe), they are **not** discarded
all at once: the **owner of each card chooses the order**, discarding **one card at
a time**, and **each discard is an open window** (responses / chain). When multiple
players discard at once, the **turn player goes first, then anti-clockwise** — that
player discards all of theirs (in any order), then the next player does, and so on.
This is the same interface as the hand-size discard, but with board cards.

**Hand-size discard** at end of turn works the same way: **one card at a time**,
**each discard an open window** (e.g. Gyrau activates when discarded here, YUZU may
be SS'd). The player chooses which card; after each discard, priority passes before
the next.

---

## 10. Cost vs. Effect (resolved by PSCT)

The colon convention from §8 governs this: **text before `:` is the activation
condition** (paid/checked to activate), and the effect body executes on
resolution per its conjunctions. "Cost-like" actions written before a `;`/`then`
are still part of the resolving effect with a response window after them, unless
they sit before the `:` (true activation condition). The script API must express
**activation-condition checks** distinctly from **resolution steps**.

---

## 11. Elimination & Ghost Board

- Drawing from an **empty Main deck eliminates** that player (applies to the
  turn-start draw **and** effect draws). (See "ywnbaw7": *draw the entire deck…
  you are eliminated if you draw from an empty deck.*)
- The Faith deck should not deplete before someone wins.
- An eliminated player's zone becomes a **ghost board**: **inert / nonexistent** —
  its cards cannot be targeted, attacked, or interacted with.
- Play continues until one player remains or a win condition triggers.

---

## 12. Tech Stack (decided in firstconvp1)

| Layer          | Choice                                              |
|----------------|-----------------------------------------------------|
| Language       | TypeScript (everywhere)                             |
| Client         | SvelteKit (browser)                                 |
| Server         | Node.js + **Colyseus** (authoritative, WebSockets)  |
| Client hosting | Cloudflare Pages / Netlify (free)                   |
| Server hosting | Fly.io (best free fit for a stateful WS server)     |

Turn-based, all-UI/state (no physics), small scale (≤20 concurrent); lobby =
Colyseus room; spectators = read-only clients.

---

## 13. Engine shape (agreed direction)

- **Authoritative server, explicit state machine.**
- **Core state:** per-player hand / board (face-up/down, overlays, counters) /
  meld zone; shared Main deck, Faith deck, discard stack, banish zone; turn
  state (turn player, anti-clockwise order, 1 normal summon + 1 normal meld per
  turn); the **stack (LIFO, MTG-style, add-any-time)**; priority/response state.
- **Universal action pattern:** *announce → response window (if applicable) →
  resolve.*
- **Effects = scripted-first**; scripts request actions via a controlled API
  (`discard()`, `banish()`, `specialSummon()`, `overlay()`, `tap()`,
  `kan()`, `moveToMeldZone()`, `drawFaith()`, `openResponseWindow()`,
  `getTopOfDiscard()`, `addCounter()`, `flipFaceDown()`), never mutating state
  directly.
- **PSCT engine:** parse/represent connectors `:` `;`/`then` `.`/`next` `and`
  `if you do` `also` with their response-window semantics from §8.
- **Multi-card discards are one-at-a-time and respondable** (§9) — the owner
  discards each in turn (turn player first, then anti-clockwise), every discard an
  open window; the subtlest mechanic, test hard.

---

## 14. Open / unresolved items

- **[OPEN]** Exact set of **alternate/card-defined win conditions** beyond 4
  melds (handle per-card; "infinite loop → declare victory" is allowed).
- **[OPEN]** Full enumeration of **tribe/type tags** and any tag-based rules.
- **[OPEN]** Precise **total card count** (~100–200; base set + colab).
- **[OPEN]** Counter/overlay limits and exact KAN-source rules per card.

---

## 15. Source-of-truth map

| Topic                          | File |
|--------------------------------|------|
| Core design & Q&A (canonical)  | `cards/firstconvp1.txt`, `cards/firstconvp2.txt` |
| Detailed rulings / glossary    | `cards/_faq_dump.txt` |
| Card-text grammar (**CANON**)  | `cards/_psct_dump.txt` |
| Real card examples / rulings   | `cards/_base_set_dump.txt` |
| Card data                      | `cards/base_set.json` |

*Reconstruction. If it conflicts with `firstconvp1/p2.txt` or the canon dumps,
those win — update this file accordingly.*
