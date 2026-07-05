<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { RoomEntry } from "./types.js";

  export let rooms: RoomEntry[] = [];
  export let busy = false;

  const dispatch = createEventDispatcher<{ join: string; code: string; refresh: void; back: void }>();
  let code = "";

  // public games browser: any public room you can enter — an open lobby (free seat)
  // OR an already-started game (join as a spectator).
  $: open = rooms.filter((r) => r.metadata && !r.metadata.isPrivate && (r.metadata.started || r.metadata.joined < r.metadata.players));
  const onCodeInput = (e: Event) => (code = (e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 5));
</script>

<div class="panel">
  <div class="head">
    <h2>Join game</h2>
    <button class="ghost" on:click={() => dispatch("refresh")} disabled={busy} title="refresh">↻</button>
    <button class="back" on:click={() => dispatch("back")}>Back</button>
  </div>

  <div class="codebar">
    <input inputmode="numeric" placeholder="5-digit code" value={code} on:input={onCodeInput} />
    <button class="go" disabled={code.length !== 5} on:click={() => dispatch("code", code)}>Join by code</button>
  </div>

  <div class="listhead">Public games {busy ? "…" : `(${open.length})`}</div>
  <div class="list">
    {#each open as r (r.roomId)}
      {@const started = r.metadata?.started}
      <button class="room" class:started on:click={() => dispatch("join", r.roomId)}>
        <span class="rc">#{r.metadata?.code}</span>
        <span class="rp">{r.metadata?.joined}/{r.metadata?.players} players{#if started} <span class="tag">(started)</span>{/if}</span>
        <span class="go-in">{started ? "spectate" : "join"} ›</span>
      </button>
    {:else}
      <div class="none">no public games — create one or enter a code</div>
    {/each}
  </div>
</div>

<style>
  .panel { max-width: 460px; margin: 56px auto; background: #141923; border: 1px solid #2f3947; border-radius: 12px; padding: 22px; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .head h2 { margin: 0; color: #eaeef4; flex: 1; }
  .ghost { font: inherit; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 7px; padding: 5px 10px; cursor: pointer; }
  .back { font: inherit; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 7px; padding: 5px 12px; cursor: pointer; }
  .ghost:hover, .back:hover { background: #222a36; }
  .codebar { display: flex; gap: 8px; margin-bottom: 18px; }
  .codebar input { flex: 1; font: inherit; letter-spacing: 0.3em; text-align: center; background: #0f141c; color: #eaeef4; border: 1px solid #39414e; border-radius: 7px; padding: 8px; }
  .go { font: inherit; background: #162232; color: #bfe3ff; border: 1px solid #6ea8ff; border-radius: 7px; padding: 8px 14px; cursor: pointer; }
  .go:disabled { opacity: 0.45; cursor: default; }
  .listhead { color: #8b95a3; font-size: 12px; margin-bottom: 8px; }
  .list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow: auto; }
  .room { display: flex; align-items: center; gap: 12px; font: inherit; text-align: left; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 8px; padding: 10px 12px; cursor: pointer; }
  .room:hover { background: #222a36; border-color: #6ea8ff; }
  .rc { font-weight: 700; color: #eaeef4; }
  .rp { color: #8b95a3; flex: 1; }
  .tag { color: #ffcf6e; font-size: 11px; }
  .room.started { border-color: #4d4330; }
  .room.started:hover { border-color: #ffcf6e; }
  .go-in { color: #6ea8ff; }
  .room.started .go-in { color: #ffcf6e; }
  .none { color: #69707c; padding: 10px; text-align: center; }
</style>
