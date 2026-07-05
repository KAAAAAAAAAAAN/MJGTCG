<script lang="ts">
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher<{ create: { players: number; isPrivate: boolean; mode: "auto" | "manual"; cheats: boolean; league: boolean }; back: void }>();
  export let busy = false;

  let players = 2;
  let visibility: "public" | "private" = "public";
  let mode: "auto" | "manual" = "auto";
  let cheats = false;
  let league = false; // "League" expansion (unimplemented cards) — Manual mode only
  $: if (mode !== "manual") league = false; // auto mode can't use unimplemented cards
</script>

<div class="panel">
  <h2>Create game</h2>

  <div class="opt">
    <span class="lbl">Max Players</span>
    <div class="seg">
      {#each [2, 3, 4] as n}
        <button class:on={players === n} on:click={() => (players = n)}>{n}</button>
      {/each}
    </div>
  </div>

  <div class="opt">
    <span class="lbl">Mode</span>
    <div class="seg">
      <button class:on={mode === "auto"} on:click={() => (mode = "auto")}>Automatic</button>
      <button class:on={mode === "manual"} on:click={() => (mode = "manual")}>Manual</button>
    </div>
  </div>
  <p class="note">{mode === "auto" ? "Rules-enforced: legal actions, turns, and the chain are handled for you." : "Free-form sandbox (like Tabletop Simulator): drag cards anywhere, no rules — everyone can interact at once."}</p>

  <div class="opt">
    <span class="lbl">Expansions</span>
    <div class="seg">
      <button class:on={league} disabled={mode !== "manual"} on:click={() => (league = !league)}>League</button>
      <button class="soon" disabled title="coming soon">Uma</button>
    </div>
  </div>
  <p class="note">{mode !== "manual" ? "Expansions add unimplemented cards — Manual mode only." : league ? "League cards are added to the Main deck." : "No expansions."}</p>

  <div class="opt">
    <span class="lbl">Cheats</span>
    <div class="seg">
      <button class:on={!cheats} on:click={() => (cheats = false)}>Off</button>
      <button class:on={cheats} on:click={() => (cheats = true)}>On</button>
    </div>
  </div>
  <p class="note">{cheats ? "Dev tool and Free mode are available to every player." : "No dev tool, no Free mode — a fair game."}</p>

  <div class="opt">
    <span class="lbl">Visibility</span>
    <div class="seg">
      <button class:on={visibility === "public"} on:click={() => (visibility = "public")}>Public</button>
      <button class:on={visibility === "private"} on:click={() => (visibility = "private")}>Private</button>
    </div>
  </div>
  <p class="note">{visibility === "public" ? "Listed in the public games browser." : "Hidden from the browser — joinable only by its code."}</p>

  <div class="actions">
    <button class="back" on:click={() => dispatch("back")}>Back</button>
    <button class="go" disabled={busy} on:click={() => dispatch("create", { players, isPrivate: visibility === "private", mode, cheats, league })}>
      {busy ? "creating…" : "Create"}
    </button>
  </div>
</div>

<style>
  .panel { max-width: 420px; margin: 64px auto; background: #141923; border: 1px solid #2f3947; border-radius: 12px; padding: 24px; }
  h2 { margin: 0 0 18px; color: #eaeef4; }
  .opt { display: flex; align-items: center; justify-content: space-between; margin: 12px 0; }
  .lbl { color: #aeb6c2; }
  .seg { display: flex; gap: 6px; }
  .seg button { font: inherit; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 7px; padding: 6px 14px; cursor: pointer; }
  .seg button:hover { background: #222a36; }
  .seg button.on { border-color: #6ea8ff; color: #bfe3ff; background: #1e3148; }
  .seg button:disabled { opacity: 0.4; cursor: default; }
  .seg button:disabled:hover { background: #1a212c; }
  .note { color: #69707c; font-size: 12px; min-height: 16px; margin: 4px 0 18px; }
  .actions { display: flex; justify-content: space-between; gap: 10px; }
  .actions button { font: inherit; border-radius: 7px; padding: 8px 18px; cursor: pointer; }
  .back { background: #1a212c; color: #cdd4de; border: 1px solid #39414e; }
  .back:hover { background: #222a36; }
  .go { background: #16271d; color: #cffbe0; border: 1px solid #4f7; }
  .go:hover { background: #1d3528; }
  .go:disabled { opacity: 0.5; cursor: default; }
</style>
