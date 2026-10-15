import type { WebSocket } from 'ws';
import type {
  PvpRoomState,
  PlayerState,
  PlayerRanking,
  SpectatorState,
  TranslationExam,
  SegmentSubmission,
  HistorySessionRecord,
} from '../shared/types.js';
import { getExamByYear, getRandomExam } from './examService.js';
import { gradeTranslation, gradePvpPairTranslation } from './deepseek.js';
import { generateSpectateTicket } from './auth.js';
import { CONFIG } from './config.js';
import { db } from './db.js';

/**
 * A single live websocket.
 *
 * Connections are keyed by `connId`, never by `playerId`: the same account may
 * legitimately have several tabs open (a match tab plus a spectator tab), and one
 * tab closing must not unregister another tab's socket. `playerId` is only the
 * *identity* used for seats and scoring.
 *
 * Room membership is bound only by an explicit `room:create` / `room:join` /
 * `room:reconnect`. The previous implementation guessed the room from the
 * playerId on every socket open, which attached live sockets to abandoned rooms
 * and pushed the wrong room state into the live match view.
 */
interface ConnectedClient {
  connId: string;
  ws: WebSocket;
  playerId: string;
  nickname?: string;
  roomCode?: string;
  role: 'player' | 'spectator';
  /**
   * Ticket-authenticated viewer following a shareable spectate link. Such a
   * connection may only ever watch: every player action is rejected, so watching
   * a match can never affect it.
   */
  spectatorOnly: boolean;
}

/** Idle waiting rooms are swept after this long with no online players. */
const ABANDONED_WAITING_ROOM_MS = 10 * 60 * 1000;
/** Offline seats of link spectators are recycled after this long. */
const OFFLINE_ANONYMOUS_SPECTATOR_MS = 10 * 60 * 1000;
/** Finished rooms are kept around for post-match review. */
const FINISHED_ROOM_TTL_MS = 2 * 60 * 60 * 1000;

class PvpManager {
  private rooms: Map<string, PvpRoomState> = new Map();
  private clients: Map<string, ConnectedClient> = new Map(); // connId -> ConnectedClient
  private playerSockets: Map<string, Set<WebSocket>> = new Map(); // playerId -> live sockets
  private matchTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> Timer
  private guardrailTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> Timer
  private countdownTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> Timer
  private connSeq = 0;

  constructor() {
    // Periodic cleanup of truly abandoned rooms (runs every 5 minutes)
    setInterval(() => {
      this.cleanupStaleRooms();
    }, 5 * 60 * 1000);
  }

  // --- Connection lifecycle -------------------------------------------------

  /**
   * Register a player-capable (account-authenticated) connection.
   *
   * Deliberately performs NO implicit room association: the room is chosen by an
   * explicit join/create/reconnect message. Returning the connId lets the caller
   * log/route precisely.
   */
  public registerClient(playerId: string, ws: WebSocket): string {
    const client = this.createConnection(playerId, ws, 'player', false);
    console.log(
      `[PVP] Player socket registered for ${playerId} (conn=${client.connId}). Awaiting explicit room join.`
    );
    return client.connId;
  }

  /**
   * Register a read-only viewer from a shareable spectate link. The ticket already
   * proved possession of the room code, so the seat is created immediately and the
   * connection is locked to that room with the spectator role.
   */
  public registerSpectatorSeat(
    playerId: string,
    roomCode: string,
    nickname: string | undefined,
    ws: WebSocket
  ): { ok: true } | { ok: false; reason: 'ROOM_NOT_FOUND' | 'SPECTATING_DISABLED' } {
    const code = roomCode.toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) {
      console.warn(`[PVP] Spectate ticket rejected, room not found: ${code}`);
      return { ok: false, reason: 'ROOM_NOT_FOUND' };
    }
    if (room.allowSpectators === false) {
      console.warn(`[PVP] Spectate ticket rejected, spectators disabled in room ${code}`);
      return { ok: false, reason: 'SPECTATING_DISABLED' };
    }

    const client = this.createConnection(playerId, ws, 'spectator', true, nickname);
    client.roomCode = code;
    const seat = this.ensureSpectatorSeat(room, playerId, nickname, true);
    seat.isOnline = true;
    console.log(
      `[PVP] Link spectator "${seat.nickname}" (${playerId}) is watching room ${code} (read-only, no account)`
    );
    this.sendToClient(client, { type: 'room:state', payload: room });
    this.broadcastRoomState(code);
    return { ok: true };
  }

  private createConnection(
    playerId: string,
    ws: WebSocket,
    role: 'player' | 'spectator',
    spectatorOnly: boolean,
    nickname?: string
  ): ConnectedClient {
    const client: ConnectedClient = {
      connId: `${playerId}#${++this.connSeq}`,
      ws,
      playerId,
      nickname: nickname ? nickname.trim().slice(0, 16) : undefined,
      role,
      spectatorOnly,
    };
    this.clients.set(client.connId, client);

    let sockets = this.playerSockets.get(playerId);
    if (!sockets) {
      sockets = new Set();
      this.playerSockets.set(playerId, sockets);
    }
    sockets.add(ws);

    ws.on('close', () => {
      this.handleDisconnect(client.connId);
    });

    ws.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(client.connId, msg);
      } catch (err) {
        this.sendError(client, 'Invalid JSON message payload');
      }
    });

    return client;
  }

  private handleMessage(connId: string, message: { type: string; payload?: any }) {
    const client = this.clients.get(connId);
    if (!client) return;

    const { type, payload = {} } = message;

    switch (type) {
      case 'ping':
        this.sendToClient(client, { type: 'pong' });
        break;
      case 'room:create':
        this.createRoom(client, payload);
        break;
      case 'room:join':
        this.joinRoom(client, payload);
        break;
      case 'room:update_settings':
        this.updateRoomSettings(client, payload);
        break;
      case 'room:toggle_ready':
        this.toggleReady(client);
        break;
      case 'room:switch_role':
        this.switchRole(client, payload);
        break;
      case 'room:start_early':
        this.startEarly(client);
        break;
      case 'segment:submit':
        this.submitSegment(client, payload);
        break;
      case 'room:leave':
        this.leaveRoom(client);
        break;
      case 'room:reconnect':
        this.reconnectRoom(client, payload);
        break;
      default:
        this.sendError(client, `Unknown message type: ${type}`);
    }
  }

  // --- Room resolution ------------------------------------------------------

  /**
   * Resolve which room a connection is talking about.
   *
   * Order: an explicitly supplied room code, the connection's own binding, and only
   * as a last resort the newest room this identity still belongs to. The fallback
   * never runs on socket open (see `registerClient`), so an abandoned room can no
   * longer hijack a live connection.
   */
  private resolveRoomForClient(
    client: ConnectedClient,
    explicitRoomCode?: string
  ): PvpRoomState | undefined {
    if (explicitRoomCode) {
      const explicit = this.rooms.get(explicitRoomCode.toUpperCase().trim());
      if (explicit) return explicit;
    }
    if (client.roomCode) {
      const bound = this.rooms.get(client.roomCode);
      if (bound) return bound;
      client.roomCode = undefined;
    }
    const fallback = this.findNewestRoomForPlayer(client.playerId);
    if (fallback) {
      console.warn(
        `[PVP] ${client.connId} had no room binding; falling back to newest membership ${fallback.roomCode}`
      );
    }
    return fallback;
  }

  private findNewestRoomForPlayer(playerId: string): PvpRoomState | undefined {
    let newest: PvpRoomState | undefined;
    for (const room of this.rooms.values()) {
      if (!room.players[playerId] && !room.spectators[playerId]) continue;
      if (!newest || (room.createdAt || 0) > (newest.createdAt || 0)) {
        newest = room;
      }
    }
    return newest;
  }

  /**
   * Detect a seat in another live match. Joining a second match while one is
   * running would silently abandon the first one, so it is refused.
   */
  private findActiveMatchElsewhere(playerId: string, keepRoomCode: string): PvpRoomState | undefined {
    for (const room of this.rooms.values()) {
      if (room.roomCode === keepRoomCode) continue;
      if (!room.players[playerId]) continue;
      if (room.status === 'IN_PROGRESS' || room.status === 'COUNTDOWN') return room;
    }
    return undefined;
  }

  /**
   * Release this identity from every room except the one being entered.
   *
   * Why this exists: abandoned waiting rooms used to accumulate the same playerId
   * forever (cleanup only ran every 5 minutes and never dropped members), so any
   * later reconnect or broadcast from that dead room leaked into the live match.
   *
   * Player seats inside a *running* match are never touched here; such seats are
   * handled by `findActiveMatchElsewhere` (new joins are refused) or left alone
   * (existing players just re-bind). Spectator seats elsewhere are always dropped:
   * watching another room must never keep a stale seat alive.
   */
  private detachFromOtherRooms(
    playerId: string,
    keepRoomCode: string,
    opts: { asPlayer: boolean }
  ): void {
    for (const room of Array.from(this.rooms.values())) {
      if (room.roomCode === keepRoomCode) continue;
      const seatIsPlayer = !!room.players[playerId];
      const seatIsSpectator = !!room.spectators[playerId];
      if (!seatIsPlayer && !seatIsSpectator) continue;

      let changed = false;

      if (seatIsSpectator) {
        delete room.spectators[playerId];
        changed = true;
        console.log(`[PVP] Released spectator seat of ${playerId} from room ${room.roomCode}`);
      }

      if (seatIsPlayer && opts.asPlayer) {
        const isLiveMatch = room.status === 'IN_PROGRESS' || room.status === 'COUNTDOWN';
        if (isLiveMatch) {
          console.log(
            `[PVP] Keeping player seat of ${playerId} in live room ${room.roomCode} (status=${room.status})`
          );
        } else {
          delete room.players[playerId];
          changed = true;
          console.log(
            `[PVP] Detached player ${playerId} from stale room ${room.roomCode} (status=${room.status})`
          );
        }
      }

      if (!changed) continue;

      const remainingPlayers = Object.values(room.players);
      if (remainingPlayers.length === 0) {
        // An empty room is unusable: nobody can play, everyone else is watching a
        // match that will never start.
        console.log(`[PVP] Room ${room.roomCode} has no players left after detach, deleting.`);
        this.deleteRoom(room.roomCode);
        continue;
      }

      if (!remainingPlayers.some((p) => p.isHost)) {
        remainingPlayers[0].isHost = true;
      }
      this.recalculateLobbyStatus(room);
      this.broadcastRoomState(room.roomCode);
    }
  }

  private recalculateLobbyStatus(room: PvpRoomState): void {
    if (room.status !== 'WAITING' && room.status !== 'READY') return;
    const players = Object.values(room.players);
    room.status = players.length >= 2 && players.every((p) => p.isReady) ? 'READY' : 'WAITING';
  }

  private ensureSpectatorSeat(
    room: PvpRoomState,
    playerId: string,
    nickname: string | undefined,
    anonymous: boolean
  ): SpectatorState {
    const existing = room.spectators[playerId];
    if (existing) {
      existing.isOnline = true;
      if (nickname && nickname.trim()) existing.nickname = nickname.trim().slice(0, 16);
      return existing;
    }
    const seat: SpectatorState = {
      playerId,
      nickname: (nickname && nickname.trim() ? nickname : `观众${Object.keys(room.spectators).length + 1}`)
        .trim()
        .slice(0, 16),
      isOnline: true,
      isAnonymous: anonymous,
      joinedAt: Date.now(),
    };
    room.spectators[playerId] = seat;
    return seat;
  }

  // --- Room lifecycle -------------------------------------------------------

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing chars like 0/O, 1/I
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  private createRoom(
    client: ConnectedClient,
    payload: {
      nickname: string;
      year?: number;
      durationMinutes?: number;
      maxPlayers?: number;
      allowSpectators?: boolean;
    }
  ) {
    const playerId = client.playerId;
    if (client.spectatorOnly) {
      return this.sendError(client, '观战席为只读模式，无法创建房间', 'SPECTATOR_READ_ONLY');
    }

    const activeElsewhere = this.findActiveMatchElsewhere(playerId, '');
    if (activeElsewhere) {
      return this.sendError(
        client,
        `你正在另一场进行中的对局（房间 ${activeElsewhere.roomCode}）里，请先结束该对局`,
        'ALREADY_IN_MATCH'
      );
    }

    const code = this.generateRoomCode();
    const duration =
      payload.durationMinutes &&
      ([10, 15, 20].includes(payload.durationMinutes) ||
        (process.env.NODE_ENV === 'test' && payload.durationMinutes > 0))
        ? payload.durationMinutes
        : 15;

    const maxPlayers = [2, 3, 4].includes(payload.maxPlayers as number)
      ? (payload.maxPlayers as number)
      : 2;
    const allowSpectators = payload.allowSpectators !== false;

    let exam: TranslationExam | undefined;
    if (payload.year) {
      exam = getExamByYear(payload.year);
    }
    if (!exam) {
      exam = getRandomExam();
    }

    const hostPlayer: PlayerState = {
      playerId,
      nickname: (payload.nickname || '玩家1').trim().slice(0, 16),
      isHost: true,
      isReady: false,
      isOnline: true,
      lastActiveAt: Date.now(),
      currentSegmentIndex: 0,
      submissions: {},
      totalScore: 0,
      isFinished: false,
    };

    const roomState: PvpRoomState = {
      roomCode: code,
      year: exam.year,
      exam,
      durationMinutes: duration,
      status: 'WAITING',
      maxPlayers,
      allowSpectators,
      spectateTicket: allowSpectators ? generateSpectateTicket(code) : undefined,
      createdAt: Date.now(),
      players: {
        [playerId]: hostPlayer,
      },
      spectators: {},
    };

    this.rooms.set(code, roomState);
    client.roomCode = code;
    client.role = 'player';
    if (payload.nickname) client.nickname = payload.nickname.trim().slice(0, 16);

    // Leave any abandoned lobby behind so it can never broadcast into this room's
    // live connections later.
    this.detachFromOtherRooms(playerId, code, { asPlayer: true });

    console.log(
      `[PVP] Created room ${code} (maxPlayers=${maxPlayers}, spectators=${allowSpectators}) by ${hostPlayer.nickname} (${playerId}), Year: ${exam.year}`
    );
    this.broadcastRoomState(code);
  }

  private joinRoom(
    client: ConnectedClient,
    payload: { roomCode: string; nickname: string; asSpectator?: boolean }
  ) {
    const playerId = client.playerId;
    const code = (payload.roomCode || '').toUpperCase().trim();
    const room = this.rooms.get(code);

    if (!room) {
      console.warn(
        `[PVP] Room join failed, room not found: "${code}". Current active rooms: [${Array.from(this.rooms.keys()).join(', ')}]`
      );
      return this.sendError(
        client,
        `未找到房间号：${code}（请检查房间号是否正确或已被房主解散）`,
        'ROOM_NOT_FOUND'
      );
    }

    if (payload.nickname) client.nickname = payload.nickname.trim().slice(0, 16);

    // Ticket connections are locked to their own room and to the spectator role.
    if (client.spectatorOnly) {
      if (client.roomCode !== code) {
        return this.sendError(client, '观战链接与房间不匹配', 'SPECTATE_ROOM_MISMATCH');
      }
      return this.refreshSpectatorSeat(client, room, payload.nickname, true);
    }

    const existingPlayer = room.players[playerId];

    // A player seat always wins over a spectator seat in the same room.
    if (existingPlayer) {
      existingPlayer.isOnline = true;
      existingPlayer.lastActiveAt = Date.now();
      if (payload.nickname) existingPlayer.nickname = payload.nickname.trim().slice(0, 16);
      client.roomCode = code;
      client.role = 'player';
      this.detachFromOtherRooms(playerId, code, { asPlayer: true });
      console.log(
        `[PVP] Player ${existingPlayer.nickname} (${playerId}) re-bound to room ${code} (status=${room.status})`
      );
      this.sendToClient(client, { type: 'room:state', payload: room });
      this.broadcastRoomState(code);
      return;
    }

    // Explicit request to watch instead of play.
    if (payload.asSpectator) {
      return this.refreshSpectatorSeat(client, room, payload.nickname, false);
    }

    const activeElsewhere = this.findActiveMatchElsewhere(playerId, code);
    if (activeElsewhere) {
      return this.sendError(
        client,
        `你正在另一场进行中的对局（房间 ${activeElsewhere.roomCode}）里，请先结束该对局`,
        'ALREADY_IN_MATCH'
      );
    }

    // If match is already in progress or finished, hand the joiner a spectator seat.
    if (room.status !== 'WAITING' && room.status !== 'READY') {
      if (room.allowSpectators !== false) {
        this.refreshSpectatorSeat(client, room, payload.nickname, false);
        this.sendToClient(client, {
          type: 'room:joined_as_spectator',
          payload: { message: '对战已在进行中，已自动为您开启实时观战席位' },
        });
        return;
      }
      return this.sendError(client, '对战已开始或已结束，无法加入', 'MATCH_ALREADY_STARTED');
    }

    // Room is WAITING or READY: check player capacity
    const currentPlayerCount = Object.keys(room.players).length;
    if (currentPlayerCount >= room.maxPlayers) {
      if (room.allowSpectators !== false) {
        this.refreshSpectatorSeat(client, room, payload.nickname, false);
        this.sendToClient(client, {
          type: 'room:joined_as_spectator',
          payload: { message: `选手席位已满（上限 ${room.maxPlayers} 人），已自动为您转入观战席位` },
        });
        return;
      }
      return this.sendError(client, `房间已满（上限 ${room.maxPlayers} 人对战）`, 'ROOM_FULL');
    }

    // New player seat (possibly standing up from this room's spectator gallery).
    const wasSpectator = !!room.spectators[playerId];
    this.detachFromOtherRooms(playerId, code, { asPlayer: true });
    if (wasSpectator) delete room.spectators[playerId];

    const playerNumber = currentPlayerCount + 1;
    const nickname = (payload.nickname || `玩家${playerNumber}`).trim().slice(0, 16);
    room.players[playerId] = {
      playerId,
      nickname,
      isHost: false,
      isReady: false,
      isOnline: true,
      lastActiveAt: Date.now(),
      currentSegmentIndex: 0,
      submissions: {},
      totalScore: 0,
      isFinished: false,
    };

    client.roomCode = code;
    client.role = 'player';
    if (room.status === 'READY') room.status = 'WAITING'; // a fresh seat invalidates all-ready

    console.log(
      `[PVP] Player ${nickname} (${playerId}) joined room ${code}. Total players: ${Object.keys(room.players).length}/${room.maxPlayers}`
    );
    this.sendToClient(client, { type: 'room:state', payload: room });
    this.broadcastRoomState(code);
  }

  /** Seat a viewer (link spectator or account spectator) without touching player seats. */
  private refreshSpectatorSeat(
    client: ConnectedClient,
    room: PvpRoomState,
    nickname: string | undefined,
    anonymous: boolean
  ): void {
    if (room.allowSpectators === false) {
      return this.sendError(client, '该房间未开启观战功能', 'SPECTATING_NOT_ALLOWED');
    }

    this.detachFromOtherRooms(client.playerId, room.roomCode, { asPlayer: false });

    const seat = this.ensureSpectatorSeat(room, client.playerId, nickname, anonymous);
    seat.isOnline = true;
    client.roomCode = room.roomCode;
    client.role = 'spectator';
    if (nickname && nickname.trim()) client.nickname = nickname.trim().slice(0, 16);

    console.log(
      `[PVP] ${anonymous ? 'Link spectator' : 'Spectator'} "${seat.nickname}" (${client.playerId}) watching room ${room.roomCode}`
    );
    this.sendToClient(client, { type: 'room:state', payload: room });
    this.broadcastRoomState(room.roomCode);
  }

  private switchRole(client: ConnectedClient, payload: { targetRole: 'player' | 'spectator' }) {
    if (client.spectatorOnly) {
      return this.sendError(client, '观战链接为只读模式，如需参赛请使用参赛链接', 'SPECTATOR_READ_ONLY');
    }
    if (!client.roomCode) {
      return this.sendError(client, '你当前不在任何房间中', 'ROOM_NOT_BOUND');
    }
    const room = this.rooms.get(client.roomCode);
    if (!room) {
      client.roomCode = undefined;
      return this.sendError(client, '房间已失效，请重新加入', 'ROOM_NOT_FOUND');
    }

    if (room.status !== 'WAITING' && room.status !== 'READY') {
      return this.sendError(client, '比赛进行中无法切换身份');
    }

    const playerId = client.playerId;
    const { targetRole } = payload;
    if (targetRole === 'player') {
      // Spectator switching to player
      if (!room.spectators[playerId]) return;
      if (Object.keys(room.players).length >= room.maxPlayers) {
        return this.sendError(client, `选手席位已满（上限 ${room.maxPlayers} 人）`);
      }
      const activeElsewhere = this.findActiveMatchElsewhere(playerId, room.roomCode);
      if (activeElsewhere) {
        return this.sendError(
          client,
          `你正在另一场进行中的对局（房间 ${activeElsewhere.roomCode}）里，请先结束该对局`,
          'ALREADY_IN_MATCH'
        );
      }
      const spec = room.spectators[playerId];
      delete room.spectators[playerId];
      room.players[playerId] = {
        playerId,
        nickname: spec.nickname,
        isHost: false,
        isReady: false,
        isOnline: true,
        lastActiveAt: Date.now(),
        currentSegmentIndex: 0,
        submissions: {},
        totalScore: 0,
        isFinished: false,
      };
      client.role = 'player';
      room.status = 'WAITING';
      this.broadcastRoomState(room.roomCode);
    } else if (targetRole === 'spectator') {
      // Player switching to spectator
      if (!room.players[playerId]) return;
      if (room.allowSpectators === false) {
        return this.sendError(client, '该房间未开启观战席');
      }
      const player = room.players[playerId];
      const otherPlayers = Object.values(room.players).filter((p) => p.playerId !== playerId);
      if (player.isHost) {
        if (otherPlayers.length > 0) {
          otherPlayers[0].isHost = true;
        } else {
          return this.sendError(client, '房间内只有房主一人，无法转为观战');
        }
      }
      delete room.players[playerId];
      room.spectators[playerId] = {
        playerId,
        nickname: player.nickname,
        isOnline: true,
        isAnonymous: false,
        joinedAt: Date.now(),
      };
      client.role = 'spectator';
      room.status = 'WAITING';
      this.broadcastRoomState(room.roomCode);
    }
  }

  private startEarly(client: ConnectedClient) {
    if (client.spectatorOnly) {
      return this.sendError(client, '观战席为只读模式，无法操作对局', 'SPECTATOR_READ_ONLY');
    }
    const room = this.resolveRoomForClient(client);
    if (!room || (room.status !== 'WAITING' && room.status !== 'READY')) return;

    const player = room.players[client.playerId];
    if (!player || !player.isHost) {
      return this.sendError(client, '只有房主可以提前开赛');
    }

    const players = Object.values(room.players);
    if (players.length < 2) {
      return this.sendError(client, '至少需要 2 位选手才能开启比赛');
    }

    if (!players.every((p) => p.isReady)) {
      return this.sendError(client, '所有在场选手均需“准备就绪”才能开赛');
    }

    console.log(
      `[PVP] Host ${player.nickname} started match early in room ${room.roomCode} with ${players.length} players`
    );
    this.startCountdown(room);
  }

  private updateRoomSettings(
    client: ConnectedClient,
    payload: {
      year?: number;
      durationMinutes?: number;
      maxPlayers?: number;
      allowSpectators?: boolean;
    }
  ) {
    if (client.spectatorOnly) {
      return this.sendError(client, '观战席为只读模式，无法修改房间设置', 'SPECTATOR_READ_ONLY');
    }
    const room = this.resolveRoomForClient(client);
    if (!room || room.status !== 'WAITING') return;

    const player = room.players[client.playerId];
    if (!player || !player.isHost) {
      return this.sendError(client, '只有房主可以更改房间设置');
    }

    if (payload.year) {
      const exam = getExamByYear(payload.year);
      if (exam) {
        room.year = exam.year;
        room.exam = exam;
      }
    }

    if (payload.durationMinutes && [10, 15, 20].includes(payload.durationMinutes)) {
      room.durationMinutes = payload.durationMinutes;
    }

    if (payload.maxPlayers && [2, 3, 4].includes(payload.maxPlayers)) {
      if (payload.maxPlayers >= Object.keys(room.players).length) {
        room.maxPlayers = payload.maxPlayers;
      } else {
        return this.sendError(
          client,
          `当前已有 ${Object.keys(room.players).length} 名选手在场，无法将人数设为 ${payload.maxPlayers}`
        );
      }
    }

    if (typeof payload.allowSpectators === 'boolean') {
      room.allowSpectators = payload.allowSpectators;
      if (payload.allowSpectators && !room.spectateTicket) {
        room.spectateTicket = generateSpectateTicket(room.roomCode);
      }
    }

    this.broadcastRoomState(room.roomCode);
  }

  private toggleReady(client: ConnectedClient) {
    if (client.spectatorOnly) {
      return this.sendError(client, '观战席为只读模式，无法准备对局', 'SPECTATOR_READ_ONLY');
    }
    const room = this.resolveRoomForClient(client);
    if (!room) {
      return this.sendError(client, '房间已失效，请重新加入', 'ROOM_NOT_FOUND');
    }
    if (room.status !== 'WAITING' && room.status !== 'READY') return;

    const player = room.players[client.playerId];
    if (!player) return;

    player.isReady = !player.isReady;
    player.lastActiveAt = Date.now();

    const players = Object.values(room.players);
    if (players.length >= 2 && players.length === room.maxPlayers && players.every((p) => p.isReady)) {
      this.startCountdown(room);
    } else {
      room.status = players.length >= 2 && players.every((p) => p.isReady) ? 'READY' : 'WAITING';
      this.broadcastRoomState(room.roomCode);
    }
  }

  private startCountdown(room: PvpRoomState) {
    room.status = 'COUNTDOWN';
    const countdownSeconds = 3;
    room.countdownEndTime = Date.now() + countdownSeconds * 1000;
    this.broadcastRoomState(room.roomCode);

    let remaining = countdownSeconds;
    const timer = setInterval(() => {
      if (this.rooms.get(room.roomCode) !== room) {
        clearInterval(timer);
        this.countdownTimers.delete(room.roomCode);
        return;
      }
      remaining -= 1;
      if (remaining > 0) {
        this.broadcast(room.roomCode, {
          type: 'room:countdown',
          payload: { secondsRemaining: remaining },
        });
      } else {
        clearInterval(timer);
        this.countdownTimers.delete(room.roomCode);
        this.startMatch(room);
      }
    }, 1000);
    this.countdownTimers.set(room.roomCode, timer);
  }

  private startMatch(room: PvpRoomState) {
    if (this.rooms.get(room.roomCode) !== room) return;

    room.status = 'IN_PROGRESS';
    room.startedAt = Date.now();
    const durationMs = room.durationMinutes * 60 * 1000;
    room.matchEndTime = room.startedAt + durationMs;

    // Reset player submissions and indices
    for (const p of Object.values(room.players)) {
      p.currentSegmentIndex = 0;
      p.submissions = {};
      p.totalScore = 0;
      p.isFinished = false;
    }

    console.log(
      `[PVP] Match started in room ${room.roomCode}, players: ${Object.keys(room.players).length}, duration: ${room.durationMinutes}m`
    );
    this.broadcastRoomState(room.roomCode);

    // Schedule match timeout
    const timeout = setTimeout(() => {
      this.handleMatchTimeout(room.roomCode);
    }, durationMs);

    this.matchTimers.set(room.roomCode, timeout);
  }

  private handleMatchTimeout(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (!room || room.status === 'FINISHED') return;

    console.log(`[PVP] Match timer expired for room ${roomCode}. Initiating timeout settlement...`);

    const timer = this.matchTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.matchTimers.delete(roomCode);
    }

    const playerList = Object.values(room.players);
    // 1. Lock all players from submitting further answers
    for (const p of playerList) {
      p.isFinished = true;
      if (!p.finishedAt) {
        p.finishedAt = Date.now();
      }
    }

    if (playerList.length === 2) {
      const p1 = playerList[0];
      const p2 = playerList[1];

      for (let idx = 0; idx < 5; idx++) {
        const sub1 = p1.submissions[idx];
        const sub2 = p2.submissions[idx];

        // Case A: Neither player answered this segment
        if (!sub1 && !sub2) {
          p1.submissions[idx] = this.createTimeoutSubmission(room, idx);
          p2.submissions[idx] = this.createTimeoutSubmission(room, idx);
          continue;
        }

        // Case B: Player 1 answered, Player 2 did not
        if (sub1 && !sub2) {
          p2.submissions[idx] = {
            segmentIndex: idx,
            originalText: room.exam.translationSegments[idx] || '',
            studentAnswer: '（超时未作答）',
            gradingStatus: 'waiting_pair',
            submittedAt: Date.now(),
          };
          if (sub1.gradingStatus === 'waiting_pair') {
            this.triggerPairedGrading(room, idx, p1, p2);
          }
          continue;
        }

        // Case C: Player 2 answered, Player 1 did not
        if (!sub1 && sub2) {
          p1.submissions[idx] = {
            segmentIndex: idx,
            originalText: room.exam.translationSegments[idx] || '',
            studentAnswer: '（超时未作答）',
            gradingStatus: 'waiting_pair',
            submittedAt: Date.now(),
          };
          if (sub2.gradingStatus === 'waiting_pair') {
            this.triggerPairedGrading(room, idx, p1, p2);
          }
          continue;
        }

        // Case D: Both submitted, but in waiting_pair status
        if (sub1 && sub2) {
          if (sub1.gradingStatus === 'waiting_pair' || sub2.gradingStatus === 'waiting_pair') {
            this.triggerPairedGrading(room, idx, p1, p2);
          }
        }
      }
    } else {
      // 3 or 4 players timeout handling
      for (const p of playerList) {
        for (let idx = 0; idx < 5; idx++) {
          const sub = p.submissions[idx];
          if (!sub) {
            p.submissions[idx] = this.createTimeoutSubmission(room, idx);
          } else if (sub.gradingStatus === 'waiting_pair') {
            this.triggerIndividualGrading(room, idx, p);
          }
        }
      }
    }

    // Broadcast updated room state (so players know all inputs are locked)
    this.broadcastRoomState(room.roomCode);

    // Guardrail timer so a room can never stay stuck waiting on grading. Derived
    // from the DeepSeek request budget (see CONFIG) so the two stay consistent.
    const guardrailMs = CONFIG.pvpGradingGuardrailMs;
    const guardrail = setTimeout(() => {
      console.warn(
        `[PVP] Guardrail timeout reached (${Math.round(guardrailMs / 1000)}s) for room ${roomCode}. Force-finishing match.`
      );
      this.forceFinishHangingRoom(roomCode);
    }, guardrailMs);
    this.guardrailTimers.set(roomCode, guardrail);

    // Check if all grading is already complete
    this.checkAllFinished(room);
  }

  private createTimeoutSubmission(room: PvpRoomState, idx: number): SegmentSubmission {
    return {
      segmentIndex: idx,
      originalText: room.exam.translationSegments[idx] || '',
      studentAnswer: '（超时未作答）',
      gradingStatus: 'graded',
      submittedAt: Date.now(),
      gradingResult: {
        score: 0,
        points_breakdown: [],
        distortion_deduction: 0,
        fluency_deduction: 0,
        critique: '该题超时未作答，得 0 分。',
        reference_translation: '',
        gradedAt: Date.now(),
      },
    };
  }

  private forceFinishHangingRoom(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (!room || room.status === 'FINISHED') return;

    for (const player of Object.values(room.players)) {
      for (const sub of Object.values(player.submissions)) {
        if (sub.gradingStatus === 'grading' || sub.gradingStatus === 'waiting_pair') {
          sub.gradingStatus = 'error';
          sub.error = '评分超时（网络故障或接口无响应）';
        }
      }
    }

    this.finishMatch(roomCode, 'timeout');
  }

  private submitSegment(
    client: ConnectedClient,
    payload: { segmentIndex: number; studentAnswer: string }
  ) {
    if (client.spectatorOnly) {
      return this.sendError(client, '观战席为只读模式，无法提交译文', 'SPECTATOR_READ_ONLY');
    }
    const playerId = client.playerId;
    const room = this.resolveRoomForClient(client);
    if (!room) {
      return this.sendError(client, '房间已失效，请重新加入', 'ROOM_NOT_FOUND');
    }
    client.roomCode = room.roomCode;

    if (room.status !== 'IN_PROGRESS') {
      return this.sendError(client, '对战未在进行中，无法提交', 'NOT_IN_PROGRESS');
    }

    const player = room.players[playerId];
    if (!player) {
      return this.sendError(client, '你当前不在该房间的选手席中', 'NOT_A_PLAYER');
    }

    if (player.isFinished) {
      return this.sendError(client, '你已交卷，无法继续提交', 'ALREADY_FINISHED');
    }

    const segmentIdx = Number(payload.segmentIndex);
    if (!Number.isInteger(segmentIdx) || segmentIdx < 0 || segmentIdx > 4) {
      console.warn(
        `[PVP] Invalid segment index ${JSON.stringify(payload.segmentIndex)} from player ${player.nickname} (${playerId}) in room ${room.roomCode}`
      );
      return this.sendError(client, '题目序号无效，请刷新页面后重试', 'INVALID_SEGMENT');
    }

    const answer = (payload.studentAnswer || '').trim();
    if (!answer) {
      return this.sendError(client, '译文不能为空', 'EMPTY_ANSWER');
    }

    // Idempotency: never overwrite an already accepted answer
    const existingSubmission = player.submissions[segmentIdx];
    if (existingSubmission && existingSubmission.gradingStatus !== 'error') {
      console.log(
        `[PVP] Duplicate submit ignored for player ${player.nickname} (${playerId}) segment ${segmentIdx + 1} in room ${room.roomCode}`
      );
      this.sendToClient(client, { type: 'room:state', payload: room });
      return;
    }

    const originalText = room.exam.translationSegments[segmentIdx] || '';

    player.lastActiveAt = Date.now();
    player.submissions[segmentIdx] = {
      segmentIndex: segmentIdx,
      originalText,
      studentAnswer: answer,
      gradingStatus: 'waiting_pair',
      submittedAt: Date.now(),
    };

    // Advance player to next segment immediately so no blocking
    player.currentSegmentIndex = Math.max(player.currentSegmentIndex, Math.min(segmentIdx + 1, 4));
    if (segmentIdx === 4) {
      player.isFinished = true;
      player.finishedAt = Date.now();
    }

    console.log(
      `[PVP] Segment ${segmentIdx + 1} submitted by ${player.nickname} (${playerId}) in room ${room.roomCode} (len=${answer.length})`
    );

    const players = Object.values(room.players);
    if (players.length === 2) {
      // 2 players: paired grading
      const opponent = players.find((p) => p.playerId !== playerId);
      if (opponent && opponent.submissions[segmentIdx]) {
        this.triggerPairedGrading(room, segmentIdx, player, opponent);
      } else {
        this.broadcastRoomState(room.roomCode);
      }
    } else {
      // 3 or 4 players: trigger individual grading immediately so no player is blocked
      this.triggerIndividualGrading(room, segmentIdx, player);
    }

    // Safety net: if this submission completed the match, settle it.
    this.checkAllFinished(room);
  }

  private triggerIndividualGrading(
    room: PvpRoomState,
    segmentIdx: number,
    player: PlayerState
  ) {
    const sub = player.submissions[segmentIdx];
    if (!sub) return;
    if (sub.gradingStatus === 'grading' || sub.gradingStatus === 'graded') return;

    sub.gradingStatus = 'grading';
    this.broadcastRoomState(room.roomCode);

    const targetSentence = room.exam.translationSegments[segmentIdx];
    console.log(
      `[PVP Individual] Grading Segment ${segmentIdx + 1} for ${player.nickname} (${player.playerId}) in Room ${room.roomCode}`
    );

    gradeTranslation({
      fullArticle: room.exam.contentMarkdown,
      targetSentence,
      studentAnswer: sub.studentAnswer,
    })
      .then((result) => {
        sub.gradingStatus = 'graded';
        sub.gradingResult = result;

        player.totalScore = Object.values(player.submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );

        console.log(
          `[PVP Individual] Scored Segment ${segmentIdx + 1} for ${player.nickname}: ${result.score}p (Total: ${player.totalScore.toFixed(1)})`
        );

        this.broadcast(room.roomCode, {
          type: 'segment:graded',
          payload: {
            segmentIndex: segmentIdx,
            playerId: player.playerId,
            score: result.score,
            gradingResult: result,
            totalScore: player.totalScore,
          },
        });

        this.broadcastRoomState(room.roomCode);
        this.checkAllFinished(room);
      })
      .catch((err) => {
        console.error(`[PVP Individual] Grading failed for ${player.nickname}:`, err);
        sub.gradingStatus = 'error';
        sub.error = err.message || '评分服务出现暂时错误';

        this.broadcastRoomState(room.roomCode);
        this.checkAllFinished(room);
      });
  }

  private triggerPairedGrading(
    room: PvpRoomState,
    segmentIdx: number,
    playerA: PlayerState,
    playerB: PlayerState
  ) {
    const subA = playerA.submissions[segmentIdx];
    const subB = playerB.submissions[segmentIdx];
    if (!subA || !subB) return;

    const isSettled = (s: typeof subA) => s.gradingStatus === 'grading' || s.gradingStatus === 'graded';
    if (isSettled(subA) || isSettled(subB)) return;

    subA.gradingStatus = 'grading';
    subB.gradingStatus = 'grading';
    this.broadcastRoomState(room.roomCode);

    const targetSentence = room.exam.translationSegments[segmentIdx];
    console.log(`[PVP Pair] Triggering paired grading for Room ${room.roomCode}, Segment ${segmentIdx + 1}`);

    gradePvpPairTranslation({
      fullArticle: room.exam.contentMarkdown,
      targetSentence,
      studentAAnswer: subA.studentAnswer,
      studentBAnswer: subB.studentAnswer,
      studentAName: playerA.nickname,
      studentBName: playerB.nickname,
    })
      .then((pairResult) => {
        subA.gradingStatus = 'graded';
        subA.gradingResult = pairResult.studentA;
        subA.comparativeAnalysis = pairResult.comparativeAnalysis;

        subB.gradingStatus = 'graded';
        subB.gradingResult = pairResult.studentB;
        subB.comparativeAnalysis = pairResult.comparativeAnalysis;

        playerA.totalScore = Object.values(playerA.submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );
        playerB.totalScore = Object.values(playerB.submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );

        console.log(
          `[PVP Pair] Scored Segment ${segmentIdx + 1} for ${playerA.nickname} (${pairResult.studentA.score}p) & ${playerB.nickname} (${pairResult.studentB.score}p)`
        );

        this.broadcast(room.roomCode, {
          type: 'segment:paired_graded',
          payload: {
            segmentIndex: segmentIdx,
            studentA: {
              playerId: playerA.playerId,
              score: pairResult.studentA.score,
              gradingResult: pairResult.studentA,
              totalScore: playerA.totalScore,
            },
            studentB: {
              playerId: playerB.playerId,
              score: pairResult.studentB.score,
              gradingResult: pairResult.studentB,
              totalScore: playerB.totalScore,
            },
            comparativeAnalysis: pairResult.comparativeAnalysis,
          },
        });

        this.broadcastRoomState(room.roomCode);
        this.checkAllFinished(room);
      })
      .catch((err) => {
        console.error('[PVP Pair] Paired grading failed:', err);
        subA.gradingStatus = 'error';
        subA.error = err.message || '评分服务出现暂时错误';
        subB.gradingStatus = 'error';
        subB.error = err.message || '评分服务出现暂时错误';

        this.broadcastRoomState(room.roomCode);
        this.checkAllFinished(room);
      });
  }

  private checkAllFinished(room: PvpRoomState) {
    if (room.status === 'FINISHED') return;

    const players = Object.values(room.players);
    const allDone = players.every((p) => p.isFinished);
    if (!allDone) return;

    // Check if any submissions are still actively grading or waiting_pair
    const anyPending = players.some((p) =>
      Object.values(p.submissions).some((s) => s.gradingStatus === 'grading' || s.gradingStatus === 'waiting_pair')
    );

    if (!anyPending) {
      const reason = room.matchEndTime && Date.now() >= room.matchEndTime ? 'timeout' : 'completed';
      this.finishMatch(room.roomCode, reason);
    }
  }

  private finishMatch(roomCode: string, reason: 'completed' | 'timeout') {
    const room = this.rooms.get(roomCode);
    if (!room || room.status === 'FINISHED') return;

    this.clearRoomTimers(roomCode);

    const playerList = Object.values(room.players);

    // Ensure all 5 segments exist for all players and total scores are accurately summed
    for (const player of playerList) {
      for (let idx = 0; idx < 5; idx++) {
        if (!player.submissions[idx]) {
          player.submissions[idx] = this.createTimeoutSubmission(room, idx);
        }
      }

      player.totalScore = Object.values(player.submissions).reduce(
        (sum, s) => sum + (s.gradingResult?.score || 0),
        0
      );
    }

    room.status = 'FINISHED';

    // Calculate Leaderboard Rankings
    const sorted = playerList.slice().sort((a, b) => b.totalScore - a.totalScore);
    let currentRank = 1;
    const rankings: PlayerRanking[] = sorted.map((p, idx, arr) => {
      if (idx > 0 && p.totalScore < arr[idx - 1].totalScore) {
        currentRank = idx + 1;
      }
      return {
        playerId: p.playerId,
        nickname: p.nickname,
        totalScore: p.totalScore,
        rank: currentRank,
        isFinished: p.isFinished,
        finishedAt: p.finishedAt,
      };
    });
    room.rankings = rankings;

    if (sorted.length > 0) {
      if (sorted.length > 1 && sorted[0].totalScore === sorted[1].totalScore) {
        room.winnerId = 'draw';
      } else {
        room.winnerId = sorted[0].playerId;
      }
    }

    console.log(
      `[PVP] Match ended in room ${roomCode}, winner: ${room.winnerId}, reason: ${reason}, scores: ${playerList
        .map((p) => `${p.nickname}: ${p.totalScore.toFixed(1)}`)
        .join(' | ')}`
    );

    // Authoritative Server-side persistence to SQLite
    for (const player of playerList) {
      const myRankObj = rankings.find((r) => r.playerId === player.playerId);
      const myRank = myRankObj ? myRankObj.rank : 1;
      const isWinner = myRank === 1 && room.winnerId === player.playerId;
      const isDraw = room.winnerId === 'draw' && myRank === 1;
      const outcome: 'win' | 'draw' | 'loss' = isWinner ? 'win' : isDraw ? 'draw' : 'loss';

      const otherPlayers = playerList.filter((p) => p.playerId !== player.playerId);
      const primaryOpponent = otherPlayers[0];

      const deterministicId = `pvp-${room.roomCode}-${room.startedAt || room.createdAt || Date.now()}-${player.playerId}`;

      const submissionsList: SegmentSubmission[] = [0, 1, 2, 3, 4].map((idx) => {
        return (
          player.submissions[idx] || this.createTimeoutSubmission(room, idx)
        );
      });

      const record: HistorySessionRecord = {
        id: deterministicId,
        type: 'pvp',
        year: room.year,
        timestamp: Date.now(),
        totalScore: player.totalScore,
        timeSpentSeconds: room.startedAt
          ? Math.floor((Date.now() - room.startedAt) / 1000)
          : room.durationMinutes * 60,
        submissions: submissionsList,
        pvpDetails: primaryOpponent
          ? {
              opponentNickname: primaryOpponent.nickname,
              opponentScore: primaryOpponent.totalScore,
              outcome,
              rank: myRank,
              playerCount: playerList.length,
              leaderboard: rankings.map((r) => ({
                nickname: r.nickname,
                score: r.totalScore,
                rank: r.rank,
              })),
            }
          : undefined,
      };

      try {
        db.saveHistoryRecord(player.playerId, record);
        console.log(
          `[PVP] Authoritatively saved history record ${record.id} for player ${player.nickname} (${player.playerId})`
        );
      } catch (err) {
        console.error(`[PVP] Failed to save history record for ${player.playerId}:`, err);
      }
    }

    this.broadcast(roomCode, {
      type: 'match:ended',
      payload: {
        winnerId: room.winnerId,
        rankings: room.rankings,
        reason,
        roomState: room,
      },
    });

    this.broadcastRoomState(roomCode);
  }

  private reconnectRoom(client: ConnectedClient, payload: { roomCode?: string }) {
    const playerId = client.playerId;
    const explicit = payload.roomCode ? payload.roomCode.toUpperCase().trim() : undefined;

    // Pick the first candidate room that actually contains this identity: the
    // explicitly requested room first, then this connection's previous binding,
    // then the newest membership. Never blindly trust a room code.
    const candidates: PvpRoomState[] = [];
    if (explicit) {
      const requested = this.rooms.get(explicit);
      if (requested) candidates.push(requested);
    }
    if (client.roomCode && client.roomCode !== explicit) {
      const bound = this.rooms.get(client.roomCode);
      if (bound) candidates.push(bound);
    }
    const newest = this.findNewestRoomForPlayer(playerId);
    if (newest && !candidates.includes(newest)) candidates.push(newest);

    const room = candidates.find((r) => !!r.players[playerId] || !!r.spectators[playerId]);

    if (!room) {
      console.warn(`[PVP] Reconnect failed for user ${playerId} (conn=${client.connId}), room not found`);
      return this.sendError(client, '对战已结束或房间已失效', 'ROOM_NOT_FOUND');
    }

    const isPlayer = !!room.players[playerId];
    const isSpectator = !!room.spectators[playerId];
    if (client.spectatorOnly && !isSpectator) {
      return this.sendError(client, '对战已结束或房间已失效', 'ROOM_NOT_FOUND');
    }

    client.roomCode = room.roomCode;
    client.role = isPlayer ? 'player' : 'spectator';

    if (isPlayer) {
      const player = room.players[playerId];
      player.isOnline = true;
      player.lastActiveAt = Date.now();
      console.log(
        `[PVP] Manual reconnect successful for player ${playerId} into room ${room.roomCode} ` +
          `(status=${room.status}, segment=${player.currentSegmentIndex + 1})`
      );
    } else {
      const spec = room.spectators[playerId];
      spec.isOnline = true;
      console.log(
        `[PVP] Manual reconnect successful for spectator ${playerId} into room ${room.roomCode}`
      );
    }

    this.sendToClient(client, {
      type: 'room:state',
      payload: room,
    });
    this.broadcastRoomState(room.roomCode);
  }

  private leaveRoom(client: ConnectedClient) {
    const playerId = client.playerId;
    const room = this.resolveRoomForClient(client);
    if (!room) {
      client.roomCode = undefined;
      return;
    }

    if (room.spectators[playerId] && client.role === 'spectator') {
      console.log(`[PVP] Spectator ${playerId} explicitly left room ${room.roomCode}`);
      delete room.spectators[playerId];
      client.roomCode = undefined;
      if (Object.keys(room.players).length === 0) {
        this.deleteRoom(room.roomCode);
      } else {
        this.broadcastRoomState(room.roomCode);
      }
      return;
    }

    if (room.spectators[playerId]) {
      delete room.spectators[playerId];
      if (Object.keys(room.players).length === 0) {
        this.deleteRoom(room.roomCode);
        return;
      }
    }

    if (room.players[playerId]) {
      console.log(`[PVP] Player ${playerId} explicitly left room ${room.roomCode}`);
      delete room.players[playerId];
      client.roomCode = undefined;

      const remainingPlayers = Object.values(room.players);
      if (remainingPlayers.length === 0) {
        console.log(`[PVP] Room ${room.roomCode} has 0 players left, deleting.`);
        this.deleteRoom(room.roomCode);
      } else {
        if (!remainingPlayers.some((p) => p.isHost)) {
          remainingPlayers[0].isHost = true;
        }
        if (room.status === 'IN_PROGRESS') {
          this.checkAllFinished(room);
        } else {
          this.recalculateLobbyStatus(room);
        }
        this.broadcastRoomState(room.roomCode);
      }
      return;
    }

    // Bound to a room without a seat (should not happen): just drop the binding.
    client.roomCode = undefined;
  }

  private handleDisconnect(connId: string) {
    const client = this.clients.get(connId);
    if (!client) return;
    this.clients.delete(connId);

    const sockets = this.playerSockets.get(client.playerId);
    if (sockets) {
      sockets.delete(client.ws);
      if (sockets.size === 0) this.playerSockets.delete(client.playerId);
    }

    // Another tab of the same identity is still connected: nothing is offline.
    if ((this.playerSockets.get(client.playerId)?.size ?? 0) > 0) {
      console.log(
        `[PVP] Connection ${connId} closed; player ${client.playerId} still has live sockets, no offline marking`
      );
      return;
    }

    // Last socket for this identity: mark it offline in every room it belongs to.
    for (const room of Array.from(this.rooms.values())) {
      let changed = false;
      const player = room.players[client.playerId];
      if (player) {
        player.isOnline = false;
        player.lastActiveAt = Date.now();
        changed = true;
        console.log(
          `[PVP] Socket disconnected for player ${player.nickname} (${client.playerId}) in room ${room.roomCode}. Room preserved.`
        );
      }
      const spec = room.spectators[client.playerId];
      if (spec) {
        spec.isOnline = false;
        changed = true;
        console.log(
          `[PVP] Socket disconnected for spectator ${spec.nickname} (${client.playerId}) in room ${room.roomCode}.`
        );
      }
      if (changed) this.broadcastRoomState(room.roomCode);
    }
  }

  // --- Delivery -------------------------------------------------------------

  private broadcast(roomCode: string, message: any) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const data = JSON.stringify(message);
    const recipients = new Set([
      ...Object.keys(room.players),
      ...Object.keys(room.spectators),
    ]);

    for (const pid of recipients) {
      this.sendRawToPlayer(pid, data);
    }
  }

  private broadcastRoomState(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    this.broadcast(roomCode, {
      type: 'room:state',
      payload: room,
    });
  }

  /** Deliver a raw frame to every live socket of an identity (multi-tab safe). */
  private sendRawToPlayer(playerId: string, data: string) {
    const sockets = this.playerSockets.get(playerId);
    if (!sockets) return;
    for (const ws of sockets) {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(data);
        } catch (err) {
          console.error(`[PVP] Failed to deliver frame to ${playerId}`, err);
        }
      }
    }
  }

  private sendToClient(client: ConnectedClient, message: any) {
    if (client.ws.readyState !== 1 /* OPEN */) return;
    try {
      client.ws.send(JSON.stringify(message));
    } catch (err) {
      console.error(`[PVP] Failed to reply to ${client.connId}`, err);
    }
  }

  private sendError(client: ConnectedClient, errorMessage: string, code?: string) {
    this.sendToClient(client, {
      type: 'error',
      payload: code ? { message: errorMessage, code } : { message: errorMessage },
    });
  }

  // --- Cleanup --------------------------------------------------------------

  private clearRoomTimers(roomCode: string) {
    const timer = this.matchTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.matchTimers.delete(roomCode);
    }
    const guardrail = this.guardrailTimers.get(roomCode);
    if (guardrail) {
      clearTimeout(guardrail);
      this.guardrailTimers.delete(roomCode);
    }
    const countdown = this.countdownTimers.get(roomCode);
    if (countdown) {
      clearInterval(countdown);
      this.countdownTimers.delete(roomCode);
    }
  }

  private deleteRoom(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    this.clearRoomTimers(roomCode);
    this.rooms.delete(roomCode);
    for (const client of this.clients.values()) {
      if (client.roomCode === roomCode) client.roomCode = undefined;
    }
    console.log(`[PVP] Room ${roomCode} removed`);
  }

  private cleanupStaleRooms() {
    const now = Date.now();
    for (const [code, room] of Array.from(this.rooms.entries())) {
      // 1. Finished rooms older than 2 hours
      if (
        room.status === 'FINISHED' &&
        room.startedAt &&
        now - room.startedAt > FINISHED_ROOM_TTL_MS
      ) {
        console.log(`[PVP] Cleaning up finished stale room ${code}`);
        this.deleteRoom(code);
        continue;
      }

      // 2. Recycle offline seats of link spectators (they carry no account and
      //    would otherwise pile up in the gallery forever).
      let seatsChanged = false;
      for (const [pid, spec] of Object.entries(room.spectators)) {
        if (
          spec.isAnonymous &&
          spec.isOnline === false &&
          now - spec.joinedAt > OFFLINE_ANONYMOUS_SPECTATOR_MS
        ) {
          delete room.spectators[pid];
          seatsChanged = true;
          console.log(`[PVP] Recycled offline spectator seat ${pid} in room ${code}`);
        }
      }
      if (seatsChanged) this.broadcastRoomState(code);

      // 3. Waiting rooms with NO online participants for over 10 minutes
      const hasOnlinePlayers = Object.values(room.players).some((p) => p.isOnline);
      const hasOnlineSpectators = Object.values(room.spectators).some((s) => s.isOnline);
      const isOldWaitingRoom = room.createdAt && now - room.createdAt > ABANDONED_WAITING_ROOM_MS;
      if (room.status === 'WAITING' && !hasOnlinePlayers && !hasOnlineSpectators && isOldWaitingRoom) {
        console.log(`[PVP] Cleaning up abandoned waiting room ${code} (inactive > 10m)`);
        this.deleteRoom(code);
      }
    }
  }
}

export const pvpManager = new PvpManager();
