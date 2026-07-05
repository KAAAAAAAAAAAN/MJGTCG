<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import type { CardView } from "@net/session.js";
  import type { LegalAction } from "@engine/legal.js";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";

  export let title: string;
  export let cards: CardView[] = [];
  export let pick = false; // when set, clicking a card picks it (target selection)
  export let picked: string[] = []; // multi-pick (Second Hand): already-chosen cards, outlined
  export let closable = true; // false = a mandatory pick: no ✕ / Escape / backdrop dismiss
  export let choice: { yes: string; no?: string } | null = null; // a yes/no (or confirm-only) answered on this viewer (Collusion)
  export let actions: Record<string, LegalAction[]> = {}; // iid -> activatable actions (e.g. Resurrection from the discard)

  const dispatch = createEventDispatcher<{ close: void; hover: CardView | null; pick: string; act: LegalAction; yes: void; no: void }>();
  const CARD = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const MAN = manifest as Record<string, { image?: string }>;
  const nameOf = (c: CardView) => (c.cardId ? (CARD.get(c.cardId) ?? c.cardId) : "");
  const frontOf = (c: CardView) => (c.cardId && MAN[c.cardId]?.image ? `/${MAN[c.cardId]!.image}` : undefined);
  const TYPE: Record<string, string> = { S: "Spell", A: "Active", F: "Faith", P: "Passive", B: "Brick" };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // buttons name the ABILITY (title), not the role slot
  const TITLE = new Map(
    (baseSet as { id: string; abilities?: { role?: string; title?: string }[] }[]).flatMap((c) =>
      (c.abilities ?? []).filter((a) => a.role && a.title).map((a) => [`${c.id}:${a.role}`, a.title!] as const)),
  );
  const actLabel = (a: LegalAction) =>
    a.kind === "activate" ? `Activate — ${a.category ? (TYPE[a.category] ?? a.category) : ""} (${TITLE.get(`${a.as ?? ""}:${a.role}`) ?? TITLE.get(`${cardIdOf(a.iid)}:${a.role}`) ?? cap(a.role)})` : a.kind;
  const cardIdOf = (iid: string) => cards.find((c) => c.iid === iid)?.cardId ?? "";
</script>

<svelte:window on:keydown={(e) => closable && e.key === "Escape" && dispatch("close")} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" on:click={() => closable && dispatch("close")}>
  <div class="panel" on:click|stopPropagation>
    <div class="head">
      <b>{title} ({cards.length})</b>
      <span class="hint">{pick ? "pick a card" : "top first"}</span>
      {#if closable}<button class="x" on:click={() => dispatch("close")}>✕</button>{/if}
    </div>
    <div class="grid">
      {#each cards as c (c.iid)}
        <div class="cell">
          <Card card={c} name={nameOf(c)} front={frontOf(c)} clickable={pick} selected={picked.includes(c.iid)}
            on:click={() => pick && dispatch("pick", c.iid)}
            on:mouseenter={() => dispatch("hover", c)} on:mouseleave={() => dispatch("hover", null)} />
          {#if !pick}
            {#each actions[c.iid] ?? [] as a}
              <button class="act" on:click|stopPropagation={() => dispatch("act", a)}>{actLabel(a)}</button>
            {/each}
          {/if}
        </div>
      {:else}
        <span class="empty">empty</span>
      {/each}
    </div>
    {#if choice}
      <div class="choicefoot">
        <button class="yes" on:click={() => dispatch("yes")}>{choice.yes}</button>
        {#if choice.no}<button class="noo" on:click={() => dispatch("no")}>{choice.no}</button>{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 60; background: #000a;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .panel {
    background: #141923; border: 1px solid #2f3947; border-radius: 12px;
    max-width: 720px; max-height: 80vh; width: 100%; display: flex; flex-direction: column;
    box-shadow: 0 12px 40px #000c;
  }
  .head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; }
  .hint { color: #69707c; font-size: 11px; }
  .x { margin-left: auto; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .x:hover { background: #2c313c; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px; overflow: auto; align-items: flex-start; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .act { font: inherit; font-size: 11px; background: #16271d; color: #cffbe0; border: 1px solid #4f7; border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .act:hover { background: #1d3528; }
  .empty { color: #69707c; }
  .choicefoot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid #232a34; }
  .choicefoot button { font: inherit; border-radius: 7px; padding: 7px 14px; cursor: pointer; }
  .choicefoot .yes { background: #16271d; color: #cffbe0; border: 1px solid #4f7; }
  .choicefoot .yes:hover { background: #1d3528; }
  .choicefoot .noo { background: #2e1a1d; color: #ffb4bd; border: 1px solid #5a2a30; }
  .choicefoot .noo:hover { background: #3a2024; }
</style>
