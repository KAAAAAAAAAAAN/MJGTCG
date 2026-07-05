// Room shapes shared between the menu screens and the page orchestrator.
export type RoomMeta = { code: string; players: number; joined: number; isPrivate: boolean; started: boolean; cheats?: boolean; league?: boolean; names?: Record<number, string> };
export type RoomEntry = { roomId: string; clients: number; maxClients: number; metadata?: RoomMeta };
export type Lobby = { code: string; players: number; joined: number; seats: number[]; host: number; ready: number[]; isPrivate: boolean; started: boolean; cheats?: boolean; league?: boolean; names?: Record<number, string> };
export type ChatMsg = { seat: number; name?: string; text: string };
