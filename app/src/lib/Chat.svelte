<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { ChatMsg } from "./menu/types.js";

  export let messages: ChatMsg[] = [];
  export let mySeat: number | null = null;

  const dispatch = createEventDispatcher<{ send: string }>();
  let minimized = false;
  let showLog = false; // full chat-log popup
  let draft = "";
  let listEl: HTMLDivElement | null = null;

  const SPECTATOR = -1;
  // prefer the sender's nickname (stamped on the message); fall back to a seat label
  const who = (m: ChatMsg) => m.name || (m.seat === SPECTATOR ? "Spectator" : `P${m.seat}`);
  // stable per-seat colour so senders are easy to tell apart
  const COLORS = ["#6ea8ff", "#ff9b9b", "#9be7a0", "#ffcf6e", "#c9a2ff", "#7fe0d6"];
  const colorOf = (seat: number) => (seat === SPECTATOR ? "#8b95a3" : COLORS[((seat % COLORS.length) + COLORS.length) % COLORS.length]);

  $: newest2 = messages.slice(-2);

  function send() {
    const t = draft.trim();
    if (!t) return;
    dispatch("send", t);
    draft = "";
  }

  // keep the expanded list pinned to the newest message. Reactive on messages
  // (not afterUpdate+tick, which floods the scheduler and freezes the page); the
  // rAF only reads/writes the DOM, never Svelte state, so it can't loop.
  $: if (listEl && !minimized && messages.length) {
    const el = listEl;
    requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
  }
</script>

<div class="chat" class:min={minimized}>
  <div class="head">
    <b>Chat</b>
    <span class="count">{messages.length}</span>
    <button class="ic" title="full chat log" on:click={() => (showLog = true)}>⤢</button>
    <button class="ic" title={minimized ? "expand" : "minimize"} on:click={() => (minimized = !minimized)}>{minimized ? "▢" : "—"}</button>
  </div>

  {#if minimized}
    <!-- minimized: only the 2 newest messages -->
    <div class="peek">
      {#each newest2 as m}
        <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
      {:else}
        <div class="empty">no messages yet</div>
      {/each}
    </div>
  {:else}
    <div class="list" bind:this={listEl}>
      {#each messages as m}
        <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
      {:else}
        <div class="empty">no messages yet — say hi</div>
      {/each}
    </div>
  {/if}

  <form class="input" on:submit|preventDefault={send}>
    <input placeholder="message…" maxlength="300" bind:value={draft} />
    <button type="submit" disabled={!draft.trim()}>Send</button>
  </form>
</div>

<svelte:window on:keydown={(e) => showLog && e.key === "Escape" && (showLog = false)} />

{#if showLog}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="backdrop" on:click={() => (showLog = false)}>
    <div class="panel" on:click|stopPropagation>
      <div class="phead"><b>Chat log</b><span class="count">{messages.length}</span><button class="x" on:click={() => (showLog = false)}>✕</button></div>
      <div class="plist">
        {#each messages as m}
          <div class="msg"><span class="nm" style="color:{colorOf(m.seat)}">{who(m)}:</span> <span class="tx">{m.text}</span></div>
        {:else}
          <div class="empty">no messages yet</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .chat {
    position: fixed; right: 14px; bottom: 14px; z-index: 70; width: 300px; max-width: calc(100vw - 28px);
    background: #141923; border: 1px solid #2f3947; border-radius: 12px; box-shadow: 0 10px 34px #000a;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; font-size: 13px; }
  .count { color: #69707c; font-size: 11px; }
  .ic { margin-left: auto; background: #20252f; color: #cdd4de; border: 1px solid #39414e; border-radius: 6px;
        width: 24px; height: 22px; display: grid; place-items: center; cursor: pointer; font-size: 12px; }
  .ic + .ic { margin-left: 0; }
  .ic:hover { background: #2a313d; }
  .list { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; overflow-y: auto; height: 180px;
          font: 12px/1.35 ui-sans-serif, system-ui, sans-serif; }
  .peek { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px; font: 12px/1.3 ui-sans-serif, system-ui, sans-serif; }
  .msg { color: #c4ccd6; word-break: break-word; }
  .nm { font-weight: 700; }
  .tx { color: #c4ccd6; }
  .empty { color: #69707c; font-size: 12px; }
  .input { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #232a34; }
  .input input { flex: 1; min-width: 0; font: inherit; font-size: 12px; background: #1a212c; color: #eaeef4;
                 border: 1px solid #39414e; border-radius: 7px; padding: 6px 9px; }
  .input input:focus { outline: none; border-color: #6ea8ff; }
  .input button { font: inherit; font-size: 12px; background: #16271d; color: #cffbe0; border: 1px solid #4f7;
                  border-radius: 7px; padding: 6px 12px; cursor: pointer; }
  .input button:disabled { opacity: 0.4; cursor: default; }
  .backdrop { position: fixed; inset: 0; z-index: 80; background: #000a; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .panel { background: #141923; border: 1px solid #2f3947; border-radius: 12px; max-width: 520px; max-height: 80vh; width: 100%;
           display: flex; flex-direction: column; box-shadow: 0 12px 40px #000c; }
  .phead { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .phead b { color: #eaeef4; }
  .x { margin-left: auto; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .x:hover { background: #2c313c; }
  .plist { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; overflow-y: auto;
           font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; }
</style>
