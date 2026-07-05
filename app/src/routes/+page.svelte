<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { Client, type Room } from "colyseus.js";
  import type { SeatView, Command, Response, ChainToggle, FreeAction, BoardAction } from "@net/session.js";
  import type { ManualView, ManualAction } from "@net/manual.js";
  import Board from "$lib/Board.svelte";
  import ManualBoard from "$lib/ManualBoard.svelte";
  import { sampleView } from "$lib/sampleView.js";
  import MainMenu from "$lib/menu/MainMenu.svelte";
  import CreateGame from "$lib/menu/CreateGame.svelte";
  import RoomBrowser from "$lib/menu/RoomBrowser.svelte";
  import Chat from "$lib/Chat.svelte";
  import type { RoomEntry, Lobby, ChatMsg } from "$lib/menu/types.js";

  type Screen = "menu" | "create" | "browse" | "lobby" | "game";

  let client: Client | null = null;
  let room: Room | null = null;
  let live: SeatView | null = null;
  let manualLive: ManualView | null = null; // free-form (Manual mode) view
  let lobby: Lobby | null = null;
  let mySeat: number | null = null;
  let rooms: RoomEntry[] = [];
  let screen: Screen = "menu";
  let selected: string | null = null;
  let status = "";
  let statusErr = false;
  let busy = false;
  let leaving = false; // distinguishes an intentional leave from a kick/disconnect
  let nickname = "Anon"; // display name, persisted across sessions
  let nickLoaded = false;
  onMount(() => { try { nickname = localStorage.getItem("mjg-nick") || "Anon"; } catch { /* private mode */ } nickLoaded = true; });
  $: if (nickLoaded) { try { localStorage.setItem("mjg-nick", nickname); } catch { /* ignore */ } }
  let chat: ChatMsg[] = []; // room chat (players + spectators)

  const SPECTATOR = -1;
  $: view = (live ?? sampleView) as SeatView;
  // production: set VITE_SERVER_URL to the deployed server (e.g. wss://xxx.fly.dev).
  // dev fallback: the local Colyseus server on :2567.
  const url = () => (import.meta.env.VITE_SERVER_URL as string | undefined) || `ws://${location.hostname}:2567`;
  const ensureClient = () => (client ??= new Client(url()));

  function flash(m: string, err = true) { status = m; statusErr = err; }
  function clearStatus() { status = ""; statusErr = false; }

  function wireRoom(r: Room) {
    leaving = false;
    room = r;
    r.onMessage("seat", (s: number) => (mySeat = s));
    r.onMessage("lobby", (l: Lobby) => { lobby = l; live = null; manualLive = null; screen = "lobby"; });
    r.onMessage("view", (v: SeatView) => { live = v; manualLive = null; lobby = null; screen = "game"; });
    r.onMessage("manualView", (v: ManualView) => { manualLive = v; live = null; lobby = null; screen = "game"; });
    r.onMessage("error", (m: string) => flash(`server: ${m}`));
    r.onMessage("kicked", () => flash("you were kicked by the host"));
    r.onMessage("chatHistory", (h: ChatMsg[]) => (chat = h ?? []));
    r.onMessage("chat", (m: ChatMsg) => (chat = [...chat, m].slice(-200)));
    r.onMessage("bugAck", (a: { ok: boolean; reason?: string }) => flash(a.ok ? "bug report sent — thanks!" : a.reason ?? "couldn't send report", !a.ok));
    r.onLeave(() => { // kick / dropped connection (not our own Leave button)
      if (leaving) return;
      room = null; live = null; manualLive = null; lobby = null; mySeat = null; screen = "menu"; chat = [];
      if (!status) flash("disconnected from the room");
    });
    r.send("sync");
  }
  async function leaveRoom() {
    leaving = true;
    try { await room?.leave(); } catch { /* ignore */ }
    room = null; live = null; manualLive = null; lobby = null; mySeat = null;
  }
  async function toMenu() { await leaveRoom(); clearStatus(); screen = "menu"; chat = []; }

  async function createGame(e: CustomEvent<{ players: number; isPrivate: boolean; mode: "auto" | "manual"; cheats: boolean; league: boolean }>) {
    clearStatus(); busy = true;
    try { wireRoom(await ensureClient().create("game", { ...e.detail, nickname })); }
    catch (err) { flash(`create failed: ${(err as Error).message} (is \`npm run server\` running?)`); }
    finally { busy = false; }
  }
  async function refreshRooms() {
    clearStatus(); busy = true;
    try { rooms = (await ensureClient().getAvailableRooms("game")) as RoomEntry[]; }
    catch (err) { flash(`can't list games: ${(err as Error).message} (is the server running?)`); rooms = []; }
    finally { busy = false; }
  }
  function toBrowse() { screen = "browse"; void refreshRooms(); }
  async function joinById(e: CustomEvent<string>) {
    clearStatus(); busy = true;
    try { wireRoom(await ensureClient().joinById(e.detail, { nickname })); }
    catch (err) { flash(`join failed: ${(err as Error).message}`); }
    finally { busy = false; }
  }
  async function joinByCode(e: CustomEvent<string>) {
    clearStatus(); busy = true;
    try {
      const all = (await ensureClient().getAvailableRooms("game")) as RoomEntry[];
      const hit = all.find((r) => r.metadata?.code === e.detail);
      if (!hit) { flash(`no game found with code ${e.detail}`); return; }
      wireRoom(await ensureClient().joinById(hit.roomId, { nickname }));
    } catch (err) { flash(`join failed: ${(err as Error).message}`); }
    finally { busy = false; }
  }

  onDestroy(() => { void room?.leave(); });

  const onSelect = (e: CustomEvent<string>) => (selected = selected === e.detail ? null : e.detail);
  function onCommand(e: CustomEvent<Command>) { selected = null; if (room) room.send("command", e.detail); else flash("not connected"); }
  function onRespond(e: CustomEvent<Response>) { selected = null; if (room) room.send("respond", e.detail); }
  const onToggle = (e: CustomEvent<ChainToggle>) => room?.send("toggle", e.detail);
  const onChoose = (e: CustomEvent<unknown>) => room?.send("choose", e.detail);
  function onDevSpawn(e: CustomEvent<string>) { if (room) room.send("devSpawn", e.detail); else flash("not connected"); }
  function onFree(e: CustomEvent<FreeAction>) { if (room) room.send("free", e.detail); else flash("not connected"); }
  function onBoard(e: CustomEvent<BoardAction>) { if (room) room.send("board", e.detail); else flash("not connected"); }
  function onManual(e: CustomEvent<ManualAction>) { if (room) room.send("manual", e.detail); else flash("not connected"); }
  function onChat(e: CustomEvent<string>) { room?.send("chat", e.detail); }
  function onBug(e: CustomEvent<string>) { if (room) room.send("bugReport", e.detail); else flash("not connected"); }
</script>

<header>
  <button class="brand" on:click={toMenu} title="back to menu">MJGTCG</button>
  {#if screen === "game"}
    <span class="conn">● in game — {mySeat === SPECTATOR ? "spectating" : `P${mySeat}`}</span>
    <button class="leave" on:click={toMenu}>≡ menu</button>
  {:else if screen === "lobby"}
    <span class="conn">● in lobby</span>
    <button class="leave" on:click={toMenu}>Leave</button>
  {/if}
  {#if status}<span class="status" class:err={statusErr}>{status}</span>{/if}
</header>

{#if screen === "menu"}
  <MainMenu bind:nickname on:create={() => (screen = "create")} on:join={toBrowse} />
{:else if screen === "create"}
  <CreateGame {busy} on:create={createGame} on:back={() => (screen = "menu")} />
{:else if screen === "browse"}
  <RoomBrowser {rooms} {busy} on:join={joinById} on:code={joinByCode} on:refresh={refreshRooms} on:back={() => (screen = "menu")} />
{:else if screen === "lobby" && lobby}
  {@const lob = lobby}
  {@const amHost = mySeat === lob.host}
  {@const nonHostSeats = lob.seats.filter((s) => s !== lob.host)}
  {@const canStart = lob.joined >= 2 && nonHostSeats.every((s) => lob.ready.includes(s))}
  <div class="lobby">
    <h2>Lobby</h2>
    <div class="code">room code <b>{lobby.code}</b>{#if lobby.isPrivate}<span class="priv"> · private</span>{/if}{#if lobby.cheats}<span class="priv"> · cheats</span>{/if}{#if lobby.league}<span class="priv"> · League</span>{/if}</div>
    <div class="count">{lobby.joined} / {lobby.players} joined</div>
    <div class="seats">
      {#each Array(lobby.players) as _, i}
        {@const filled = lobby.seats.includes(i)}
        {@const isHost = i === lobby.host && filled}
        {@const isReady = filled && (isHost || lobby.ready.includes(i))}
        <div class="seatchip" class:filled class:you={i === mySeat} class:ready={isReady}>
          <div class="who">{#if filled}{lob.names?.[i] ?? `P${i}`} {/if}(P{i}){#if i === mySeat} · you{/if}</div>
          {#if !filled}
            <span class="state empty">waiting…</span>
          {:else if isHost}
            <span class="state host">host</span>
          {:else}
            <span class="state" class:rdy={isReady}>{isReady ? "✓ ready" : "not ready"}</span>
          {/if}
          {#if amHost && filled && !isHost}
            <button class="kick" title="kick player" on:click={() => room?.send("kick", i)}>kick</button>
          {/if}
        </div>
      {/each}
    </div>

    {#if amHost}
      <button class="prim start" disabled={!canStart} on:click={() => room?.send("start")}>Start game</button>
      <div class="note">
        {#if lobby.joined < 2}waiting for at least one more player to join
        {:else if !canStart}waiting for everyone to ready up
        {:else}everyone's ready — start when you are ({lobby.joined}/{lobby.players}){/if}
      </div>
    {:else}
      <button class="prim ready-btn" class:on={mySeat !== null && lobby.ready.includes(mySeat)} on:click={() => room?.send("ready")}>
        {mySeat !== null && lobby.ready.includes(mySeat) ? "✓ Ready" : "Ready"}
      </button>
      <div class="note">share the code <b>{lobby.code}</b> to invite — the host starts when everyone's ready</div>
    {/if}
  </div>
{:else if manualLive}
  <ManualBoard view={manualLive} mySeat={mySeat ?? SPECTATOR} on:manual={onManual} />
{:else}
  <Board {view} {selected} on:select={onSelect} on:command={onCommand} on:respond={onRespond} on:setToggle={onToggle} on:devSpawn={onDevSpawn} on:choose={onChoose} on:free={onFree} on:board={onBoard} />
{/if}

{#if room && (screen === "lobby" || screen === "game")}
  <Chat messages={chat} {mySeat} on:send={onChat} on:bug={onBug} />
{/if}

<style>
  header { display: flex; align-items: center; gap: 14px; padding: 8px 12px; border-bottom: 1px solid #232a34; }
  .brand { font: inherit; font-weight: 700; letter-spacing: 0.04em; color: #cfd6e0; background: none; border: none; cursor: pointer; padding: 0; }
  .conn { color: #8fe0b0; font-size: 12px; }
  .leave { font: inherit; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 6px; padding: 4px 11px; cursor: pointer; }
  .leave:hover { background: #222a36; }
  .status { font-size: 12px; color: #8b95a3; margin-left: auto; }
  .status.err { color: #ffb4bd; }
  .lobby { max-width: 480px; margin: 56px auto; text-align: center; background: #141923; border: 1px solid #2f3947; border-radius: 12px; padding: 28px; }
  .lobby h2 { margin: 0 0 6px; color: #eaeef4; font-size: 18px; }
  .code { color: #aeb6c2; margin-bottom: 12px; }
  .code b { color: #ffe08a; font-size: 18px; letter-spacing: 0.18em; }
  .priv { color: #b69bff; font-size: 12px; }
  .count { color: #9fb6e0; font-size: 22px; margin-bottom: 16px; }
  .seats { display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
  .seatchip { display: flex; flex-direction: column; align-items: center; gap: 5px; border: 1px solid #2f3947; border-radius: 9px; padding: 10px 12px; color: #6b7482; min-width: 84px; }
  .seatchip.filled { color: #cdd4de; border-color: #4a5468; background: #1a212c; }
  .seatchip.you { border-color: #6ea8ff; }
  .seatchip.ready { border-color: #4f7; box-shadow: 0 0 0 1px #4f73 inset; }
  .who { font-weight: 600; }
  .state { font-size: 11px; padding: 1px 8px; border-radius: 9px; background: #20252f; color: #8b95a3; }
  .state.empty { color: #5b6270; background: transparent; }
  .state.rdy { background: #16271d; color: #8fe0b0; }
  .state.host { background: #2a2333; color: #d9c7ff; }
  .kick { font: inherit; font-size: 10px; background: #2e1a1d; color: #ffb4bd; border: 1px solid #5a2a30; border-radius: 6px; padding: 1px 8px; cursor: pointer; }
  .kick:hover { background: #3a2024; }
  .prim { font: inherit; font-size: 15px; padding: 10px 22px; border-radius: 9px; cursor: pointer; }
  .start { background: #16271d; color: #cffbe0; border: 1px solid #4f7; }
  .start:hover:not(:disabled) { background: #1d3528; }
  .prim:disabled { opacity: 0.4; cursor: default; }
  .ready-btn { background: #1a212c; color: #cdd4de; border: 1px solid #4a5468; }
  .ready-btn:hover { background: #222a36; }
  .ready-btn.on { background: #16271d; color: #8fe0b0; border-color: #4f7; box-shadow: 0 0 0 2px #4f73; }
  .note { color: #69707c; font-size: 12px; margin-top: 10px; }
  .note b { color: #ffe08a; letter-spacing: 0.12em; }
  :global(body) { margin: 0; background: #0f1217; color: #d6dae0; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
