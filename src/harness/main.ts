/**
 * MJGTCG engine test harness — a minimal in-browser UI to drive the current
 * engine by hand. No server: the authoritative engine runs client-side (fine
 * for a local debug tool). Click cards to build a selection, then act on it.
 */
import * as M from "../engine/reducer.js";
import * as E from "../engine/effects.js";
import { CARD_SCRIPTS } from "../engine/card-scripts.js";
import { collectTriggers } from "../engine/triggers.js";
import { computeAuras } from "../engine/auras.js";
import { checkRestrictions } from "../engine/restrictions.js";
import type { Ability } from "../engine/rules.js";
import { buildDecks, type ManifestEntry } from "../decks.js";
import baseSetRaw from "../../base_set.json";
import parsedRaw from "../../base_set_parsed.json";
import manifestRaw from "../../manifest.json";

type CardDef = M.Card & { name: string; abilities: { role?: string; type?: string; title?: string }[] };
const baseSet = baseSetRaw as unknown as CardDef[];
const CARD = new Map(baseSet.map((c) => [c.id, c]));

// ability metadata registry (at-any-time / once-per-X), keyed `${id}:${role}`
const abilityReg: Record<string, Ability> = {};
for (const c of parsedRaw as { id: string; abilities: { role?: string; parsed?: unknown }[] }[]) {
  for (const a of c.abilities) if (a.parsed) abilityReg[`${c.id}:${a.role}`] = a as Ability;
}
M.setEffectResolver(E.resolveChainLink);
M.setTriggerCollector(collectTriggers);
M.setAuraProvider(computeAuras);
M.setRestrictionChecker(checkRestrictions);

// ---- game lifecycle ---------------------------------------------------------
let state: M.GameState;
let sel: string[] = []; // ordered selection of instance iids
let status = "";
let statusErr = false;

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j]!, r[i]!];
  }
  return r;
}

function newGame(nPlayers: number): void {
  const { main: mainIds, faith: faithIds } = buildDecks(manifestRaw as Record<string, ManifestEntry>);
  const faith = shuffle(faithIds);
  const main = shuffle(mainIds);
  state = M.newGame({
    players: Array.from({ length: nPlayers }, (_, i) => i),
    mainDeck: main,
    faithDeck: faith,
    startingHand: 5,
    cardRegistry: baseSet as M.Card[],
    registry: abilityReg,
  });
  sel = [];
  status = `new ${nPlayers}-player game`;
  statusErr = false;
  render();
}

function dispatch(action: M.Action, note?: string): void {
  try {
    state = M.reduce(state, action);
    status = note ?? `ok: ${action.type}`;
    statusErr = false;
  } catch (e) {
    status = `${action.type}: ${(e as Error).message}`;
    statusErr = true;
  }
  render();
}

/** Activate selected[0]'s ability `role`, using the rest of the selection as
 *  targets: announce -> open window (with script ref) -> resolve. */
function activate(role: string): void {
  const self = sel[0];
  if (self === undefined) return;
  const cardId = state.instances[self]?.cardId ?? "";
  const key = `${cardId}:${role}`;
  const targets = sel.slice(1);
  const ap = state.activePlayer;
  try {
    state = M.reduce(state, { type: M.ActionType.PLAYER_ACTS, player: ap, effectId: key });
    state = M.reduce(state, {
      type: M.ActionType.OPEN_RESPONSE,
      player: ap,
      effectId: key,
      script: { cardId, role, self, targets },
    });
    state = M.reduce(state, { type: M.ActionType.RESOLVE_CHAIN });
    status = `activated ${key}${targets.length ? ` -> [${targets.join(",")}]` : ""}`;
    statusErr = false;
  } catch (e) {
    status = `activate ${key}: ${(e as Error).message}`;
    statusErr = true;
  }
  sel = [];
  render();
}

// ---- rendering --------------------------------------------------------------
const V = (n: number | null) => (n === null ? "☆" : String(n));
function label(iid: string): string {
  const ci = state.instances[iid];
  if (!ci) return iid;
  const name = CARD.get(ci.cardId)?.name ?? ci.cardId ?? "opaque";
  const stats = `${M.atkOf(state, iid)}/${M.defOf(state, iid)}/${V(M.valueOf(state, iid))}`;
  return `${name} <span class="id">${stats}${ci.tapped ? " ⊗" : ""}${ci.faceDown ? " ⤵" : ""}</span>`;
}
function cardsHtml(iids: readonly string[]): string {
  if (!iids.length) return `<span class="hint">—</span>`;
  return iids
    .map((iid) => {
      const ci = state.instances[iid];
      const cls = ["card", sel.includes(iid) ? "sel" : "", ci?.tapped ? "tapped" : ""].join(" ");
      return `<span class="${cls}" data-iid="${iid}">${label(iid)}</span>`;
    })
    .join("");
}
function rolesWithScript(iid: string): string[] {
  const cardId = state.instances[iid]?.cardId ?? "";
  return (["top", "bottom"] as const).filter((r) => CARD_SCRIPTS[`${cardId}:${r}`]);
}

function render(): void {
  const app = document.getElementById("app")!;
  const meControls: string[] = [];
  if (state.phase === M.Phase.TURN_START_DRAW)
    meControls.push(`<button data-do="draw">Draw for turn</button>`);
  meControls.push(
    `<button data-do="end">End turn</button>`,
    `<button data-do="resolve">Resolve chain</button>`,
    `<button data-do="advance">Advance</button>`,
  );
  if (state.events.length && state.phase === M.Phase.MAIN_PHASE)
    meControls.push(`<button class="act" data-do="process">Process events (${state.events.length})</button>`);
  // selection-driven actions
  const selControls: string[] = [];
  if (sel.length === 1) {
    selControls.push(`<button class="act" data-do="summon">Normal summon</button>`);
    for (const r of rolesWithScript(sel[0]!))
      selControls.push(`<button class="act" data-do="act:${r}">Activate ${r}</button>`);
  }
  if (sel.length >= 1) {
    for (const r of rolesWithScript(sel[0]!))
      if (sel.length > 1)
        selControls.push(`<button class="act" data-do="act:${r}">Activate ${r} (→targets)</button>`);
  }
  if (sel.length === 2) selControls.push(`<button class="act" data-do="battle">Declare battle (0→1)</button>`);
  if (sel.length === 3) selControls.push(`<button class="act" data-do="meld">Meld</button>`);
  if (sel.length) selControls.push(`<button data-do="clear">Clear selection</button>`);

  const players = state.players
    .map((p) => {
      const cls = ["player", p.pid === state.activePlayer ? "active" : "", p.eliminated ? "dead" : ""].join(" ");
      return `<div class="${cls}">
        <b>Player ${p.pid}</b> ${p.eliminated ? "(eliminated)" : ""}
        ${p.pid === state.activePlayer ? "• turn" : ""}
        ${state.prioritySeat === p.pid ? "• priority" : ""}
        <div class="zone"><span class="lbl">hand ${p.hand.length}</span>${cardsHtml(p.hand)}</div>
        <div class="zone"><span class="lbl">board</span>${cardsHtml(p.board)}</div>
        <div class="zone"><span class="lbl">melds ${p.meldZone.length}/${M.WIN_MELDS}</span>
          ${p.meldZone.map((m) => `${m.kind}${m.kan ? "+KAN" : ""}`).join(", ") || '<span class="hint">—</span>'}</div>
      </div>`;
    })
    .join("");

  const discardTop = state.discard[0] ? label(state.discard[0]) : '<span class="hint">empty</span>';
  app.innerHTML = `
    <div class="col">
      <div class="bar">
        <b>MJGTCG harness</b>
        <button data-do="new:2">New 2p</button>
        <button data-do="new:3">New 3p</button>
        <button data-do="new:4">New 4p</button>
      </div>
      <div class="meta">
        <span>phase <b>${state.phase}</b></span>
        <span>active <b>P${state.activePlayer}</b></span>
        <span>priority <b>${state.prioritySeat ?? "—"}</b></span>
        <span>chain <b>${state.chain.length}</b></span>
        <span>events <b>${state.events.length}</b></span>
        <span>main <b>${state.mainDeck.length}</b></span>
        <span>faith <b>${state.faithDeck.length}</b></span>
        <span>banish <b>${state.banish.length}</b></span>
        ${state.winner !== null ? `<span>🏆 <b>winner P${state.winner}</b></span>` : ""}
      </div>
      <div class="status ${statusErr ? "err" : ""}">${status || "&nbsp;"}</div>
      <div class="bar">${meControls.join("")}</div>
      <div class="bar">${selControls.join("") || '<span class="hint">select cards to act (click to toggle)</span>'}</div>
      <h2>Discard (top)</h2><div class="cards">${discardTop}</div>
      <h2>Players</h2>${players}
      <div class="hint">sel: [${sel.join(", ") || "—"}]</div>
    </div>
    <div class="col">
      <h2>Log</h2>
      <div id="log">${state.log.slice(-40).reverse().map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>
    </div>`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

// ---- event handling ---------------------------------------------------------
document.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest("[data-iid],[data-do]") as HTMLElement | null;
  if (!el) return;
  const iid = el.getAttribute("data-iid");
  if (iid) {
    sel = sel.includes(iid) ? sel.filter((x) => x !== iid) : [...sel, iid];
    render();
    return;
  }
  const cmd = el.getAttribute("data-do")!;
  const ap = state.activePlayer;
  if (cmd.startsWith("new:")) return newGame(Number(cmd.slice(4)));
  if (cmd === "clear") { sel = []; return render(); }
  if (cmd === "draw") return dispatch({ type: M.ActionType.DRAW_RESOLVES });
  if (cmd === "end") return dispatch({ type: M.ActionType.END_TURN });
  if (cmd === "resolve") return dispatch({ type: M.ActionType.RESOLVE_CHAIN });
  if (cmd === "advance") return dispatch({ type: M.ActionType.ADVANCE });
  if (cmd === "process") return dispatch({ type: M.ActionType.PROCESS_EVENTS }, "process events");
  if (cmd === "summon") {
    const id = sel[0];
    sel = [];
    return dispatch({ type: M.ActionType.NORMAL_SUMMON, player: ap, summonId: id }, "normal summon");
  }
  if (cmd === "battle") {
    const [a, t] = sel;
    sel = [];
    return dispatch({ type: M.ActionType.DECLARE_BATTLE, attackerId: a, targetId: t }, "battle declared");
  }
  if (cmd === "meld") {
    const mats = [...sel];
    sel = [];
    return dispatch({ type: M.ActionType.MELD, player: ap, materials: mats }, "meld");
  }
  if (cmd.startsWith("act:")) return activate(cmd.slice(4));
});

newGame(2);
