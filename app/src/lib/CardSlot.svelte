<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import type { CardView } from "@net/session.js";
  import type { LegalAction } from "@engine/legal.js";
  import baseSet from "@root/base_set.json";

  export let card: CardView;
  export let name = "";
  export let front: string | undefined = undefined;
  export let selected = false;
  export let big = false; // render at 2× (BIG ICHIHIME on the board)
  export let actions: LegalAction[] = []; // legal options for THIS card (shown above when selected)
  export let movable = false; // offer a "Move" button (free-position arranging)

  const dispatch = createEventDispatcher<{ select: string; act: LegalAction; move: string }>();
  const labels: Record<string, string> = {
    normalSummon: "Summon",
    attack: "Attack",
    discard: "Discard",
    // hand-pick decision buttons (synthetic actions from a handPick choice)
    reveal: "Reveal",
    banish: "Banish",
    give: "Give",
    summon: "Summon",
    shuffle: "Shuffle in",
    select: "Select",
    place: "Place",
    overlay: "Overlay",
  };
  const TYPE: Record<string, string> = { S: "Spell", A: "Active", F: "Faith", P: "Passive", B: "Brick" };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // ability titles by `${cardId}:${role}` — activation buttons name the ABILITY, not the
  // role slot, so multiple Actives (Twin Personality grants) are distinguishable.
  const TITLE = new Map(
    (baseSet as { id: string; abilities?: { role?: string; title?: string }[] }[]).flatMap((c) =>
      (c.abilities ?? []).filter((a) => a.role && a.title).map((a) => [`${c.id}:${a.role}`, a.title!] as const)),
  );
  const label = (a: LegalAction) =>
    a.kind === "activate"
      ? `${a.category ? (TYPE[a.category] ?? a.category) : "Activate"} (${TITLE.get(`${a.as ?? card.cardId}:${a.role}`) ?? cap(a.role)})`
      : (labels[a.kind] ?? a.kind);
</script>

<span class="slot">
  {#if selected && (actions.length || movable)}
    <span class="pop">
      {#each actions as a}
        <button on:click|stopPropagation={() => dispatch("act", a)}>{label(a)}</button>
      {/each}
      {#if movable}<button class="mv" on:click|stopPropagation={() => dispatch("move", card.iid)}>Move</button>{/if}
    </span>
  {/if}
  <Card {card} {name} {front} {selected} {big} clickable on:click={() => dispatch("select", card.iid)} on:mouseenter on:mouseleave on:overlays />
</span>

<style>
  .slot { position: relative; display: inline-flex; }
  .pop {
    position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
    margin-bottom: 5px; display: flex; flex-direction: column; gap: 4px; white-space: nowrap; z-index: 10;
    background: #11161f; border: 1px solid #4f7; border-radius: 7px; padding: 4px;
    box-shadow: 0 4px 14px #000a;
  }
  .pop::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: #4f7;
  }
  .pop button {
    font: inherit; font-size: 11px; background: #1e3a2a; color: #cffbe0;
    border: 1px solid #4f7; border-radius: 5px; padding: 3px 8px; cursor: pointer;
  }
  .pop button:hover { background: #244a34; }
  .pop button.mv { background: #1e2c3a; color: #cfe4fb; border-color: #6ea8ff; }
  .pop button.mv:hover { background: #26374a; }
</style>
