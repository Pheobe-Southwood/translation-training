import type { WebSocket } from 'ws';
import type {
  PvpRoomState,
  PlayerState,
  PlayerRanking,
  TranslationExam,
  SegmentSubmission,
  HistorySessionRecord,
  HistoryRoundRecord,
  RoomConfig,
  RoundState,
  RoundPlayerState,
  RoundScoreEntry,
  RoundDetail,
  RoundDetailPlayer,
  PvpRoomSummary,
  PvpRoomSummaryPlayer,
  PvpRoomSummaryRound,
  DrawStrategy,
} from '../shared/types.js';
import { getAllExams, getExamByYear } from './examService.js';
import { gradePvpBatchTranslation, type BatchAnswerInput } from './deepseek.js';
import { db } from './db.js';
import {
  settleRound,
  rankPlayers,
  tiedLeaders,
  resolveOvertime,
  drawScheduledYears,
  poolSize,
  type Standing,
} from '../shared/scoring.js';

const SEGMENTS_PER_ROUND = 5;
const COUNTDOWN_SECONDS = 3;
const OVERTIME_VOTE_SECONDS = 30;
const SWEEP_INTERVAL_MS = 1000;
/** 3 attempts x 90s timeout + backoff, with headroom. */
const GRADING_STUCK_MS = 300_000;
const LONG_MATCH_MINUTES = 90;

interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  roomCode?: string;
  isSpectator?: boolean;
  /** Round the client is currently looking at (players follow their own round). */
  watchingRound?: number;
}

interface CreateRoomPayload {
  nickname: string;
  /** Legacy single-round field, still accepted for compatibility. */
  year?: number;
  durationMinutes?: number;
  maxPlayers?: number;
  allowSpectators?: boolean;
  totalRounds?: number;
  drawStrategy?: DrawStrategy;
  rangeStart?: number;
  rangeEnd?: number;
  customYears?: number[];
}

class PvpManager {
  private rooms: Map<string, PvpRoomState> = new Map();
  private clients: Map<string, ConnectedClient> = new Map();
  private playerSockets: Map<string, WebSocket> = new Map();
  /** roomCode -> overtime vote timeout handle */
  private voteTimers: Map<string, NodeJS.Timeout> = new Map();
  private sweepHandle?: NodeJS.Timeout;

  constructor() {
    // A single 1s sweep drives every round deadline and overtime vote deadline.
    // Using absolute `roundDeadlineAt` values instead of per-player setTimeout handles
    // means deadlines survive snapshot restore unchanged and can never leak.
    this.sweepHandle = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        console.error('[PVP] Sweep failed:', err);
      }
    }, SWEEP_INTERVAL_MS);

    setInterval(
      () => {
        this.cleanupStaleRooms();
      },
      5 * 60 * 1000
    );

    this.restoreSnapshots();
  }

  // -------------------------------------------------------------------------
  // Connection plumbing
  // -------------------------------------------------------------------------

  public registerClient(playerId: string, ws: WebSocket) {
    const previousSocket = this.playerSockets.get(playerId);
    if (previousSocket && previousSocket !== ws) {
      console.log(
        `[PVP] Replacing stale socket for player ${playerId} (previous readyState=${previousSocket.readyState})`
      );
    }

    // The newest socket always owns outgoing replies. A late close event from a
    // replaced socket must never unregister the live one (see handleDisconnect).
    this.clients.set(playerId, { ws, playerId });
    this.playerSockets.set(playerId, ws);

    const existingRoom = this.findRoomByPlayerId(playerId);
    if (existingRoom && existingRoom.status !== 'FINISHED') {
      const player = existingRoom.players[playerId];
      const spectator = existingRoom.spectators[playerId];
      const client = this.clients.get(playerId);

      if (player) {
        player.isOnline = true;
        player.lastActiveAt = Date.now();
        if (client) {
          client.roomCode = existingRoom.roomCode;
          client.isSpectator = false;
          client.watchingRound = player.currentRoundIndex;
        }
        console.log(
          `[PVP] Re-associated socket for player "${player.nickname}" (${playerId}) in room ${existingRoom.roomCode} ` +
            `(status=${existingRoom.status}, round=${player.currentRoundIndex + 1}, segment=${player.currentSegmentIndex + 1})`
        );
        this.sendSummaryTo(playerId);
        if (existingRoom.rounds[player.currentRoundIndex]) {
          this.pushRoundDetail(playerId, player.currentRoundIndex);
        }
      } else if (spectator) {
        spectator.isOnline = true;
        if (client) {
          client.roomCode = existingRoom.roomCode;
          client.isSpectator = true;
        }
        console.log(
          `[PVP] Re-associated socket for spectator "${spectator.nickname}" (${playerId}) in room ${existingRoom.roomCode}`
        );
        this.broadcastSummary(existingRoom.roomCode);
      }
    }

    ws.on('close', () => {
      this.handleDisconnect(playerId, ws);
    });

    ws.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(playerId, msg);
      } catch (err) {
        this.sendError(playerId, 'Invalid JSON message payload');
      }
    });
  }

  private findRoomByPlayerId(playerId: string): PvpRoomState | undefined {
    for (const room of this.rooms.values()) {
      if (room.players[playerId] || room.spectators[playerId]) {
        return room;
      }
    }
    return undefined;
  }

  private handleMessage(playerId: string, message: { type: string; payload?: any }) {
    const { type, payload = {} } = message;

    switch (type) {
      case 'ping':
        this.sendToPlayer(playerId, { type: 'pong' });
        break;
      case 'room:create':
        this.createRoom(playerId, payload);
        break;
      case 'room:join':
        this.joinRoom(playerId, payload);
        break;
      case 'room:update_settings':
        this.updateRoomSettings(playerId, payload);
        break;
      case 'room:toggle_ready':
        this.toggleReady(playerId);
        break;
      case 'room:switch_role':
        this.switchRole(playerId, payload);
        break;
      case 'room:start_early':
        this.startEarly(playerId);
        break;
      case 'segment:submit':
        this.submitSegment(playerId, payload);
        break;
      case 'round:request':
        this.requestRound(playerId, payload);
        break;
      case 'overtime:vote':
        this.handleOvertimeVote(playerId, payload);
        break;
      case 'room:leave':
        this.leaveRoom(playerId);
        break;
      case 'room:reconnect':
        this.reconnectRoom(playerId, payload);
        break;
      default:
        this.sendError(playerId, `Unknown message type: ${type}`);
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private allPlayers(room: PvpRoomState): PlayerState[] {
    return Object.values(room.players);
  }

  private activePlayers(room: PvpRoomState): PlayerState[] {
    return this.allPlayers(room).filter((p) => p.phase !== 'left');
  }

  private durationSeconds(room: PvpRoomState): number {
    return room.config.durationMinutes * 60;
  }

  private availableYears(): number[] {
    return getAllExams()
      .map((e) => e.year)
      .sort((a, b) => a - b);
  }

  private refreshTotals(room: PvpRoomState, player: PlayerState) {
    let total = 0;
    for (const round of room.rounds) {
      const rp = round.players[player.playerId];
      if (rp && rp.roundCompletedAt) total += rp.smallScore;
    }
    player.totalScore = Math.round(total * 10) / 10;
  }

  private lowestUnanswered(rp: RoundPlayerState): number {
    for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
      if (!rp.submissions[i]) return i;
    }
    return SEGMENTS_PER_ROUND - 1;
  }

  private createTimeoutSubmission(exam: TranslationExam, idx: number): SegmentSubmission {
    return {
      segmentIndex: idx,
      originalText: exam.translationSegments[idx] || '',
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

  private buildRoundPlayer(playerId: string): RoundPlayerState {
    return { playerId, submissions: {}, timedOut: false, smallScore: 0 };
  }

  private recomputeSmallScore(rp: RoundPlayerState) {
    let sum = 0;
    for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
      sum += rp.submissions[i]?.gradingResult?.score || 0;
    }
    rp.smallScore = Math.round(sum * 10) / 10;
  }

  // -------------------------------------------------------------------------
  // Room creation & configuration
  // -------------------------------------------------------------------------

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  /** Normalises a create/update payload into a validated RoomConfig. */
  private buildConfig(
    payload: Partial<CreateRoomPayload> & Record<string, any>,
    previous?: RoomConfig
  ): { config?: RoomConfig; error?: string } {
    const years = this.availableYears();

    const duration =
      payload.durationMinutes && [10, 15, 20].includes(payload.durationMinutes)
        ? payload.durationMinutes
        : payload.durationMinutes && process.env.NODE_ENV === 'test' && payload.durationMinutes > 0
          ? payload.durationMinutes
          : (previous?.durationMinutes ?? 15);

    const maxPlayers = [2, 3, 4].includes(payload.maxPlayers as number)
      ? (payload.maxPlayers as number)
      : (previous?.maxPlayers ?? 2);

    const allowSpectators =
      typeof payload.allowSpectators === 'boolean'
        ? payload.allowSpectators
        : (previous?.allowSpectators ?? true);

    // Legacy single-round create payload: { year } with no strategy.
    let drawStrategy: DrawStrategy = payload.drawStrategy ?? previous?.drawStrategy ?? 'random';
    let rangeStart = payload.rangeStart ?? previous?.rangeStart;
    let rangeEnd = payload.rangeEnd ?? previous?.rangeEnd;
    let customYears = payload.customYears ?? previous?.customYears;

    if (!payload.drawStrategy && payload.year && !previous) {
      drawStrategy = 'custom';
      customYears = [payload.year];
    }

    const totalRounds =
      typeof payload.totalRounds === 'number' && Number.isInteger(payload.totalRounds)
        ? payload.totalRounds
        : payload.year && !previous
          ? 1
          : (previous?.totalRounds ?? 1);

    const size = poolSize(years, drawStrategy, { start: rangeStart, end: rangeEnd }, customYears);
    if (totalRounds < 1 || totalRounds > size) {
      return { error: `当前抽取策略可选真题共 ${size} 套，轮数必须在 1 ~ ${size} 之间` };
    }
    if (drawStrategy === 'range') {
      if (rangeStart === undefined || rangeEnd === undefined) {
        return { error: '请选择年份区间的起止年份' };
      }
      if (rangeStart > rangeEnd) {
        return { error: '年份区间的起始年份不能晚于结束年份' };
      }
      if (size === 0) {
        return { error: '所选年份区间内没有可用真题' };
      }
    }
    if (drawStrategy === 'custom') {
      const selected = customYears ?? [];
      if (selected.length === 0) {
        return { error: '请至少选择一套真题' };
      }
      if (new Set(selected).size !== selected.length) {
        return { error: '手动指定的考卷存在重复年份' };
      }
      const missing = selected.filter((y) => !years.includes(y));
      if (missing.length > 0) {
        return { error: `题库中不存在这些年份：${missing.join('、')}` };
      }
    }

    return {
      config: {
        totalRounds,
        durationMinutes: duration,
        maxPlayers,
        allowSpectators,
        drawStrategy,
        rangeStart,
        rangeEnd,
        customYears,
      },
    };
  }

  private createRoom(playerId: string, payload: CreateRoomPayload) {
    const built = this.buildConfig(payload);
    if (!built.config) {
      return this.sendError(playerId, built.error || '房间设置无效', 'INVALID_CONFIG');
    }
    const config = built.config;

    const code = this.generateRoomCode();
    const hostPlayer: PlayerState = {
      playerId,
      nickname: (payload.nickname || '玩家1').trim().slice(0, 16),
      isHost: true,
      isReady: false,
      isOnline: true,
      lastActiveAt: Date.now(),
      phase: 'playing',
      currentRoundIndex: 0,
      currentSegmentIndex: 0,
      answeredSegments: [],
      matchPoints: 0,
      totalScore: 0,
      roundsCompleted: 0,
      hasFinishedAllRounds: false,
    };

    const roomState: PvpRoomState = {
      roomCode: code,
      config,
      status: 'WAITING',
      scheduledYears: [],
      rounds: [],
      createdAt: Date.now(),
      players: { [playerId]: hostPlayer },
      spectators: {},
    };

    this.rooms.set(code, roomState);
    const client = this.clients.get(playerId);
    if (client) {
      client.roomCode = code;
      client.isSpectator = false;
    }

    console.log(
      `[PVP] Created room ${code} (rounds=${config.totalRounds}, strategy=${config.drawStrategy}, ` +
        `duration=${config.durationMinutes}m, maxPlayers=${config.maxPlayers}, spectators=${config.allowSpectators}) ` +
        `by ${hostPlayer.nickname} (${playerId})`
    );
    this.broadcastSummary(code);
  }

  private joinRoom(
    playerId: string,
    payload: { roomCode: string; nickname: string; asSpectator?: boolean }
  ) {
    const code = (payload.roomCode || '').toUpperCase().trim();
    const room = this.rooms.get(code);

    if (!room) {
      console.warn(
        `[PVP] Room join failed, room not found: "${code}". Current active rooms: [${Array.from(this.rooms.keys()).join(', ')}]`
      );
      return this.sendError(playerId, `未找到房间号：${code}（请检查房间号是否正确或已被房主解散）`, 'ROOM_NOT_FOUND');
    }

    const existingPlayer = room.players[playerId];
    const existingSpectator = room.spectators[playerId];

    if (existingPlayer) {
      existingPlayer.isOnline = true;
      existingPlayer.lastActiveAt = Date.now();
      if (payload.nickname) {
        existingPlayer.nickname = payload.nickname.trim().slice(0, 16);
      }
      const client = this.clients.get(playerId);
      if (client) {
        client.roomCode = code;
        client.isSpectator = false;
        client.watchingRound = existingPlayer.currentRoundIndex;
      }
      this.broadcastSummary(code);
      if (room.rounds[existingPlayer.currentRoundIndex]) {
        this.pushRoundDetail(playerId, existingPlayer.currentRoundIndex);
      }
      return;
    }

    if (existingSpectator) {
      existingSpectator.isOnline = true;
      if (payload.nickname) {
        existingSpectator.nickname = payload.nickname.trim().slice(0, 16);
      }
      const client = this.clients.get(playerId);
      if (client) {
        client.roomCode = code;
        client.isSpectator = true;
      }
      this.broadcastSummary(code);
      this.pushRoundDetail(playerId, this.spectatorRoundFor(room));
      return;
    }

    const seatSpectator = (message: string, asExplicit: boolean) => {
      const nickname = (payload.nickname || `观众${Object.keys(room.spectators).length + 1}`)
        .trim()
        .slice(0, 16);
      room.spectators[playerId] = {
        playerId,
        nickname,
        isOnline: true,
        joinedAt: Date.now(),
      };
      const client = this.clients.get(playerId);
      if (client) {
        client.roomCode = code;
        client.isSpectator = true;
      }
      if (!asExplicit) {
        this.sendToPlayer(playerId, { type: 'room:joined_as_spectator', payload: { message } });
      }
      console.log(`[PVP] Player ${nickname} (${playerId}) seated as spectator in room ${code}.`);
      this.broadcastSummary(code);
      this.pushRoundDetail(playerId, this.spectatorRoundFor(room));
    };

    if (payload.asSpectator) {
      if (room.config.allowSpectators === false) {
        return this.sendError(playerId, '该房间未开启观战功能', 'SPECTATING_NOT_ALLOWED');
      }
      return seatSpectator('', true);
    }

    if (room.status !== 'WAITING' && room.status !== 'READY') {
      if (room.config.allowSpectators !== false) {
        return seatSpectator('对战已在进行中，已自动为您开启实时观战席位', false);
      }
      return this.sendError(playerId, '对战已开始或已结束，无法加入', 'MATCH_ALREADY_STARTED');
    }

    const currentPlayerCount = Object.keys(room.players).length;
    if (currentPlayerCount >= room.config.maxPlayers) {
      if (room.config.allowSpectators !== false) {
        return seatSpectator(
          `选手席位已满（上限 ${room.config.maxPlayers} 人），已自动为您转入观战席位`,
          false
        );
      }
      return this.sendError(playerId, `房间已满（上限 ${room.config.maxPlayers} 人对战）`, 'ROOM_FULL');
    }

    const playerNumber = currentPlayerCount + 1;
    const nickname = (payload.nickname || `玩家${playerNumber}`).trim().slice(0, 16);
    room.players[playerId] = {
      playerId,
      nickname,
      isHost: false,
      isReady: false,
      isOnline: true,
      lastActiveAt: Date.now(),
      phase: 'playing',
      currentRoundIndex: 0,
      currentSegmentIndex: 0,
      answeredSegments: [],
      matchPoints: 0,
      totalScore: 0,
      roundsCompleted: 0,
      hasFinishedAllRounds: false,
    };

    const client = this.clients.get(playerId);
    if (client) {
      client.roomCode = code;
      client.isSpectator = false;
    }

    console.log(
      `[PVP] Player ${nickname} (${playerId}) joined room ${code}. Total players: ${Object.keys(room.players).length}/${room.config.maxPlayers}`
    );
    this.broadcastSummary(code);
  }

  private switchRole(playerId: string, payload: { targetRole: 'player' | 'spectator' }) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;

    if (room.status !== 'WAITING' && room.status !== 'READY') {
      return this.sendError(playerId, '比赛进行中无法切换身份');
    }

    const { targetRole } = payload;
    if (targetRole === 'player') {
      if (!room.spectators[playerId]) return;
      if (Object.keys(room.players).length >= room.config.maxPlayers) {
        return this.sendError(playerId, `选手席位已满（上限 ${room.config.maxPlayers} 人）`);
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
        phase: 'playing',
        currentRoundIndex: 0,
        currentSegmentIndex: 0,
        answeredSegments: [],
        matchPoints: 0,
        totalScore: 0,
        roundsCompleted: 0,
        hasFinishedAllRounds: false,
      };
      client.isSpectator = false;
      room.status = 'WAITING';
      this.broadcastSummary(room.roomCode);
    } else if (targetRole === 'spectator') {
      if (!room.players[playerId]) return;
      if (room.config.allowSpectators === false) {
        return this.sendError(playerId, '该房间未开启观战席');
      }
      const player = room.players[playerId];
      const otherPlayers = this.allPlayers(room).filter((p) => p.playerId !== playerId);
      if (player.isHost) {
        if (otherPlayers.length > 0) {
          otherPlayers[0].isHost = true;
        } else {
          return this.sendError(playerId, '房间内只有房主一人，无法转为观战');
        }
      }
      delete room.players[playerId];
      room.spectators[playerId] = {
        playerId,
        nickname: player.nickname,
        isOnline: true,
        joinedAt: Date.now(),
      };
      client.isSpectator = true;
      room.status = 'WAITING';
      this.broadcastSummary(room.roomCode);
    }
  }

  private startEarly(playerId: string) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || (room.status !== 'WAITING' && room.status !== 'READY')) return;

    const player = room.players[playerId];
    if (!player || !player.isHost) {
      return this.sendError(playerId, '只有房主可以提前开赛');
    }

    const players = this.activePlayers(room);
    if (players.length < 2) {
      return this.sendError(playerId, '至少需要 2 位选手才能开启比赛');
    }
    if (!players.every((p) => p.isReady)) {
      return this.sendError(playerId, '所有在场选手均需“准备就绪”才能开赛');
    }

    console.log(
      `[PVP] Host ${player.nickname} started match early in room ${room.roomCode} with ${players.length} players`
    );
    this.startCountdown(room);
  }

  private updateRoomSettings(playerId: string, payload: Record<string, any>) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'WAITING') return;

    const player = room.players[playerId];
    if (!player || !player.isHost) {
      return this.sendError(playerId, '只有房主可以更改房间设置');
    }

    // maxPlayers cannot drop below the people already seated.
    if (payload.maxPlayers && [2, 3, 4].includes(payload.maxPlayers)) {
      if (payload.maxPlayers < Object.keys(room.players).length) {
        return this.sendError(
          playerId,
          `当前已有 ${Object.keys(room.players).length} 名选手在场，无法将人数设为 ${payload.maxPlayers}`
        );
      }
    }

    const built = this.buildConfig(payload, room.config);
    if (!built.config) {
      return this.sendError(playerId, built.error || '房间设置无效', 'INVALID_CONFIG');
    }
    room.config = built.config;
    this.broadcastSummary(room.roomCode);
  }

  private toggleReady(playerId: string) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;
    if (room.status !== 'WAITING' && room.status !== 'READY') return;

    const player = room.players[playerId];
    if (!player) return;

    player.isReady = !player.isReady;
    player.lastActiveAt = Date.now();

    const players = this.activePlayers(room);
    if (players.length >= 2 && players.length === room.config.maxPlayers && players.every((p) => p.isReady)) {
      this.startCountdown(room);
    } else {
      room.status = players.length >= 2 && players.every((p) => p.isReady) ? 'READY' : 'WAITING';
      this.broadcastSummary(room.roomCode);
    }
  }

  // -------------------------------------------------------------------------
  // Match start
  // -------------------------------------------------------------------------

  private startCountdown(room: PvpRoomState) {
    room.status = 'COUNTDOWN';
    room.countdownEndTime = Date.now() + COUNTDOWN_SECONDS * 1000;
    this.broadcastSummary(room.roomCode);

    let remaining = COUNTDOWN_SECONDS;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        this.broadcast(room.roomCode, {
          type: 'room:countdown',
          payload: { secondsRemaining: remaining },
        });
      } else {
        clearInterval(timer);
        this.startMatch(room);
      }
    }, 1000);
  }

  private startMatch(room: PvpRoomState) {
    const years = this.availableYears();
    const drawn = drawScheduledYears(
      years,
      room.config.drawStrategy,
      room.config.totalRounds,
      {
        range: { start: room.config.rangeStart, end: room.config.rangeEnd },
        customYears: room.config.customYears,
      }
    );
    if (drawn.error) {
      room.status = 'WAITING';
      console.error(`[PVP] Cannot start match in ${room.roomCode}: ${drawn.error}`);
      for (const p of this.allPlayers(room)) {
        this.sendError(p.playerId, drawn.error, 'INVALID_CONFIG');
      }
      this.broadcastSummary(room.roomCode);
      return;
    }

    const now = Date.now();
    room.scheduledYears = drawn.years;
    room.status = 'IN_PROGRESS';
    room.startedAt = now;
    room.winnerId = undefined;
    room.rankings = undefined;
    room.overtime = undefined;

    // One RoundState per scheduled round; each pre-seeds a RoundPlayerState for every
    // player so settlement and the "withdrawn player counts as 0" rule stay uniform.
    // `startedAt` stays 0 until the round is actually entered, which is also what keeps
    // the exam year hidden in the summary until that round begins.
    room.rounds = drawn.years.map((year, index) => {
      const exam = getExamByYear(year) as TranslationExam;
      const players: Record<string, RoundPlayerState> = {};
      for (const p of this.allPlayers(room)) {
        players[p.playerId] = this.buildRoundPlayer(p.playerId);
      }
      const batches: RoundState['batches'] = {};
      for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
        batches[i] = { segmentIndex: i, status: 'waiting', attempts: 0 };
      }
      return {
        roundIndex: index,
        year,
        isOvertime: false,
        exam,
        startedAt: index === 0 ? now : 0,
        players,
        batches,
        settled: false,
      };
    });

    const durationSec = this.durationSeconds(room);
    for (const p of this.allPlayers(room)) {
      p.currentRoundIndex = 0;
      p.currentSegmentIndex = 0;
      p.answeredSegments = [];
      p.matchPoints = 0;
      p.totalScore = 0;
      p.roundsCompleted = 0;
      p.hasFinishedAllRounds = false;
      p.finishedAt = undefined;
      p.phase = 'playing';
      p.roundStartedAt = now;
      p.roundDeadlineAt = now + durationSec * 1000;
    }

    console.log(
      `[PVP] Match started in room ${room.roomCode}: ${room.config.totalRounds} rounds, ` +
        `years=[${drawn.years.join(', ')}], duration=${room.config.durationMinutes}m, ` +
        `players=${this.allPlayers(room).length}`
    );

    this.broadcastSummary(room.roomCode);
    this.broadcast(room.roomCode, {
      type: 'round:started',
      payload: { roundIndex: 0, year: drawn.years[0] },
    });
    for (const p of this.activePlayers(room)) {
      this.pushRoundDetail(p.playerId, 0);
    }
    for (const s of Object.keys(room.spectators)) {
      this.pushRoundDetail(s, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Round progression
  // -------------------------------------------------------------------------

  private requestRound(playerId: string, payload: { roundIndex?: number }) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;

    const roundIndex = Number(payload.roundIndex);
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= room.rounds.length) {
      return this.sendError(playerId, '轮次序号无效', 'INVALID_ROUND');
    }

    const player = room.players[playerId];
    if (player && player.phase !== 'left' && roundIndex > player.currentRoundIndex) {
      return this.sendError(playerId, '该轮次尚未解锁', 'FORBIDDEN_ROUND');
    }
    if (!player && room.status !== 'FINISHED') {
      // Spectators may watch any round that has actually started.
      if (!room.rounds[roundIndex]?.startedAt) {
        return this.sendError(playerId, '该轮次尚未开始', 'ROUND_NOT_STARTED');
      }
    }

    client.watchingRound = roundIndex;
    this.pushRoundDetail(playerId, roundIndex);
  }

  private enterRound(room: PvpRoomState, player: PlayerState, roundIndex: number) {
    const now = Date.now();
    const round = room.rounds[roundIndex];
    if (!round) return;

    player.currentRoundIndex = roundIndex;
    player.answeredSegments = [];
    player.currentSegmentIndex = 0;
    player.roundStartedAt = now;
    player.roundDeadlineAt = now + this.durationSeconds(room) * 1000;
    if (!round.startedAt) round.startedAt = now;

    console.log(
      `[PVP] ${player.nickname} entered round ${roundIndex + 1}/${room.config.totalRounds} in room ${room.roomCode}`
    );

    const client = this.clients.get(player.playerId);
    if (client) client.watchingRound = roundIndex;

    this.sendToPlayer(player.playerId, {
      type: 'round:started',
      payload: { roundIndex, year: round.year, deadlineAt: player.roundDeadlineAt },
    });
    this.broadcastSummary(room.roomCode);
    this.pushRoundDetail(player.playerId, roundIndex);
  }

  /** Marks the player's current round complete and pipelines them into the next one. */
  private completeRoundForPlayer(room: PvpRoomState, player: PlayerState, timedOut: boolean) {
    const roundIndex = player.currentRoundIndex;
    const round = room.rounds[roundIndex];
    if (!round) return;
    const rp = round.players[player.playerId];
    if (!rp || rp.roundCompletedAt) return;

    const now = Date.now();
    const durationSec = this.durationSeconds(room);

    if (timedOut) {
      for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
        if (!rp.submissions[i]) {
          rp.submissions[i] = this.createTimeoutSubmission(round.exam, i);
        }
      }
      rp.timedOut = true;
      rp.elapsedSeconds = durationSec;
      rp.remainingSeconds = 0;
    } else {
      for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
        if (!rp.submissions[i]) {
          rp.submissions[i] = this.createTimeoutSubmission(round.exam, i);
        }
      }
      const elapsed = Math.max(0, Math.round((now - (player.roundStartedAt ?? now)) / 1000));
      rp.timedOut = false;
      rp.elapsedSeconds = Math.min(elapsed, durationSec);
      rp.remainingSeconds = Math.max(0, durationSec - rp.elapsedSeconds);
    }

    rp.roundCompletedAt = now;
    this.recomputeSmallScore(rp);
    player.roundsCompleted = Math.max(player.roundsCompleted, roundIndex + 1);
    this.refreshTotals(room, player);

    // A player who timed out (or quit) has just handed in zero-score placeholders for
    // the segments they skipped. Those may be the last missing piece of a batch, so
    // every segment has to be re-examined now.
    for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
      this.maybeTriggerBatch(room, roundIndex, i);
    }

    console.log(
      `[PVP] ${player.nickname} completed round ${roundIndex + 1} in room ${room.roomCode} ` +
        `(${rp.smallScore}p, ${rp.timedOut ? 'timed out' : `${rp.elapsedSeconds}s used`})`
    );

    // Pipelines: the next round starts for this player immediately, independent of others.
    if (player.phase !== 'left') {
      if (roundIndex + 1 < room.config.totalRounds) {
        this.enterRound(room, player, roundIndex + 1);
      } else {
        player.phase = 'awaiting';
        player.hasFinishedAllRounds = true;
        player.finishedAt = now;
        player.roundDeadlineAt = undefined;
        console.log(`[PVP] ${player.nickname} finished all rounds in room ${room.roomCode}`);
      }
    }

    this.broadcastSummary(room.roomCode);
    this.checkRoundSettle(room, roundIndex);
    this.checkMatchComplete(room);
  }

  // -------------------------------------------------------------------------
  // Submissions & batched grading
  // -------------------------------------------------------------------------

  private submitSegment(
    playerId: string,
    payload: { roundIndex?: number; segmentIndex: number; studentAnswer: string }
  ) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;

    if (room.status !== 'IN_PROGRESS' && room.status !== 'OVERTIME') {
      return this.sendError(playerId, '对战未在进行中，无法提交', 'NOT_IN_PROGRESS');
    }

    const player = room.players[playerId];
    if (!player) return;
    if (player.phase !== 'playing') {
      return this.sendError(playerId, '你已完成本次系列赛，无法继续提交', 'ALREADY_FINISHED');
    }

    const roundIndex = payload.roundIndex === undefined ? player.currentRoundIndex : Number(payload.roundIndex);
    if (!Number.isInteger(roundIndex) || roundIndex !== player.currentRoundIndex) {
      return this.sendError(playerId, '轮次序号无效，请刷新页面后重试', 'INVALID_ROUND');
    }

    const round = room.rounds[roundIndex];
    if (!round || round.settled) {
      return this.sendError(playerId, '该轮已结算，无法提交', 'ROUND_SETTLED');
    }

    if (player.roundDeadlineAt && Date.now() >= player.roundDeadlineAt) {
      this.completeRoundForPlayer(room, player, true);
      return this.sendError(playerId, '本轮时间已到，已自动进入下一轮', 'ROUND_EXPIRED');
    }

    const segmentIdx = Number(payload.segmentIndex);
    if (!Number.isInteger(segmentIdx) || segmentIdx < 0 || segmentIdx >= SEGMENTS_PER_ROUND) {
      console.warn(
        `[PVP] Invalid segment index ${JSON.stringify(payload.segmentIndex)} from player ${player.nickname} (${playerId}) in room ${room.roomCode}`
      );
      return this.sendError(playerId, '题目序号无效，请刷新页面后重试', 'INVALID_SEGMENT');
    }

    const answer = (payload.studentAnswer || '').trim();
    if (!answer) {
      return this.sendError(playerId, '译文不能为空', 'EMPTY_ANSWER');
    }

    const rp = round.players[player.playerId];
    if (!rp) return;

    // Idempotency: never overwrite an already accepted answer.
    const existing = rp.submissions[segmentIdx];
    if (existing && existing.gradingStatus !== 'error') {
      console.log(
        `[PVP] Duplicate submit ignored for ${player.nickname} (${playerId}) round ${roundIndex + 1} segment ${segmentIdx + 1}`
      );
      this.pushRoundDetail(playerId, roundIndex);
      return;
    }

    const originalText = round.exam.translationSegments[segmentIdx] || '';
    player.lastActiveAt = Date.now();
    rp.submissions[segmentIdx] = {
      segmentIndex: segmentIdx,
      originalText,
      studentAnswer: answer,
      gradingStatus: 'idle',
      submittedAt: Date.now(),
    };

    if (!player.answeredSegments.includes(segmentIdx)) {
      player.answeredSegments.push(segmentIdx);
      player.answeredSegments.sort((a, b) => a - b);
    }
    player.currentSegmentIndex = this.lowestUnanswered(rp);

    console.log(
      `[PVP] R${roundIndex + 1}Q${segmentIdx + 1} submitted by ${player.nickname} (${playerId}) in room ${room.roomCode} (len=${answer.length})`
    );

    this.broadcastSummary(room.roomCode);
    this.maybeTriggerBatch(room, roundIndex, segmentIdx);

    // Free navigation: the round only ends once all five segments are in.
    const answeredAll = player.answeredSegments.length >= SEGMENTS_PER_ROUND;
    if (answeredAll) {
      this.completeRoundForPlayer(room, player, false);
    } else {
      this.pushRoundDetail(playerId, roundIndex);
    }
  }

  /** Fires the batched paired evaluation for (round, segment) once every player is in. */
  private maybeTriggerBatch(room: PvpRoomState, roundIndex: number, segmentIndex: number) {
    const round = room.rounds[roundIndex];
    if (!round) return;
    const batch = round.batches[segmentIndex];
    if (!batch) return;
    if (batch.status === 'grading' || batch.status === 'graded' || batch.status === 'failed') return;

    const playerIds = Object.keys(round.players);
    const missing = playerIds.filter((pid) => !round.players[pid].submissions[segmentIndex]);
    if (missing.length > 0) return;

    // Timeout placeholders already carry a 0 score and must not be sent to the model.
    const needingGrading = playerIds.filter((pid) => {
      const sub = round.players[pid].submissions[segmentIndex];
      return sub.gradingStatus === 'idle' || sub.gradingStatus === 'error';
    });

    if (needingGrading.length === 0) {
      batch.status = 'graded';
      this.broadcast(room.roomCode, {
        type: 'segment:graded',
        payload: { roundIndex, segmentIndex, graded: playerIds.length },
      });
      this.checkRoundSettle(room, roundIndex);
      this.checkMatchComplete(room);
      return;
    }

    batch.status = 'grading';
    batch.attempts += 1;
    batch.startedAt = Date.now();

    for (const pid of needingGrading) {
      round.players[pid].submissions[segmentIndex].gradingStatus = 'grading';
    }
    this.broadcastSummary(room.roomCode);

    const answers: BatchAnswerInput[] = needingGrading.map((pid) => {
      const sub = round.players[pid].submissions[segmentIndex];
      return {
        playerId: pid,
        nickname: room.players[pid]?.nickname || pid,
        answer: sub.studentAnswer,
      };
    });

    console.log(
      `[PVP Batch] Grading room ${room.roomCode} R${roundIndex + 1}Q${segmentIndex + 1} for ${answers.length} player(s)`
    );

    gradePvpBatchTranslation({
      fullArticle: round.exam.contentMarkdown,
      targetSentence: round.exam.translationSegments[segmentIndex],
      answers,
    })
      .then((outcome) => {
        for (const student of outcome.students) {
          const sub = round.players[student.playerId]?.submissions[segmentIndex];
          if (!sub) continue;
          sub.gradingStatus = 'graded';
          sub.gradingResult = student.result;
          if (outcome.comparativeAnalysis) sub.comparativeAnalysis = outcome.comparativeAnalysis;
        }
        for (const pid of playerIds) {
          this.recomputeSmallScore(round.players[pid]);
          const p = room.players[pid];
          if (p) this.refreshTotals(room, p);
        }
        batch.status = 'graded';

        console.log(
          `[PVP Batch] R${roundIndex + 1}Q${segmentIndex + 1} graded in ${room.roomCode}: ` +
            outcome.students
              .map((s) => `${s.nickname} ${s.result.score}p`)
              .join(' | ')
        );

        this.broadcast(room.roomCode, {
          type: 'segment:graded',
          payload: {
            roundIndex,
            segmentIndex,
            scores: outcome.students.map((s) => ({
              playerId: s.playerId,
              score: s.result.score,
            })),
          },
        });
        this.broadcastSummary(room.roomCode);
        this.pushWatchedRound(room, roundIndex);
        this.checkRoundSettle(room, roundIndex);
        this.checkMatchComplete(room);
      })
      .catch((err) => {
        console.error(`[PVP Batch] Grading failed in ${room.roomCode} R${roundIndex + 1}Q${segmentIndex + 1}:`, err);
        const reason = err?.message || '评分服务出现暂时错误';
        for (const pid of needingGrading) {
          const sub = round.players[pid]?.submissions[segmentIndex];
          if (!sub) continue;
          sub.gradingStatus = 'graded';
          sub.gradingResult = {
            score: 0,
            points_breakdown: [],
            distortion_deduction: 0,
            fluency_deduction: 0,
            critique: `本题评分服务异常，按 0 分计（${reason}）`,
            reference_translation: '',
            gradedAt: Date.now(),
          };
          sub.error = reason;
        }
        batch.status = 'failed';

        for (const pid of playerIds) {
          this.recomputeSmallScore(round.players[pid]);
          const p = room.players[pid];
          if (p) this.refreshTotals(room, p);
        }
        this.broadcastSummary(room.roomCode);
        this.pushWatchedRound(room, roundIndex);
        this.checkRoundSettle(room, roundIndex);
        this.checkMatchComplete(room);
      });
  }

  // -------------------------------------------------------------------------
  // Round settlement
  // -------------------------------------------------------------------------

  private checkRoundSettle(room: PvpRoomState, roundIndex: number) {
    const round = room.rounds[roundIndex];
    if (!round || round.settled) return;

    const playerIds = Object.keys(round.players);
    if (playerIds.length === 0) return;
    if (playerIds.some((pid) => !round.players[pid].roundCompletedAt)) return;
    if (Object.values(round.batches).some((b) => b.status === 'waiting' || b.status === 'grading')) return;

    const entries = playerIds.map((pid) => {
      const rp = round.players[pid];
      this.recomputeSmallScore(rp);
      return {
        playerId: pid,
        smallScore: rp.smallScore,
        remainingSeconds: rp.timedOut ? 0 : Math.max(0, rp.remainingSeconds ?? 0),
      };
    });

    const isFinalRound = !round.isOvertime && roundIndex === room.config.totalRounds - 1;
    const scoreEntries: RoundScoreEntry[] = settleRound(entries, {
      isFinalRound,
      isOvertime: round.isOvertime,
      onlyOneRound: room.config.totalRounds === 1,
    });

    if (round.isOvertime) {
      this.applyOvertimeDecider(room, round, scoreEntries);
    }

    for (const entry of scoreEntries) {
      const player = room.players[entry.playerId];
      if (!player) continue;
      player.matchPoints = Math.round((player.matchPoints + entry.matchPointsDelta) * 10) / 10;
      this.refreshTotals(room, player);
    }

    round.settled = true;
    round.settledAt = Date.now();
    round.scoreEntries = scoreEntries;

    console.log(
      `[PVP] Round ${roundIndex + 1} settled in ${room.roomCode} (year ${round.year}): ` +
        scoreEntries
          .map(
            (e) =>
              `${room.players[e.playerId]?.nickname ?? e.playerId} ${e.smallScore}p ΔS=${e.deltaS.toFixed(2)} +${e.matchPointsDelta}`
          )
          .join(' | ')
    );

    this.broadcast(room.roomCode, {
      type: 'round:settled',
      payload: {
        roundIndex,
        year: round.year,
        isOvertime: round.isOvertime,
        scoreEntries,
        matchPoints: Object.fromEntries(
          this.allPlayers(room).map((p) => [p.playerId, p.matchPoints])
        ),
        totalScores: Object.fromEntries(
          this.allPlayers(room).map((p) => [p.playerId, p.totalScore])
        ),
      },
    });
    this.broadcastSummary(room.roomCode);
    this.pushWatchedRound(room, roundIndex);
    this.maybeSnapshot(room);
  }

  /** Overtime is a flat +1.0 decided by score -> overtime time -> series time. */
  private applyOvertimeDecider(
    room: PvpRoomState,
    round: RoundState,
    scoreEntries: RoundScoreEntry[]
  ) {
    const seriesElapsed = (playerId: string) => {
      let sum = 0;
      for (const r of room.rounds) {
        const rp = r.players[playerId];
        if (rp?.roundCompletedAt) sum += rp.elapsedSeconds ?? 0;
      }
      return sum;
    };

    const resolution = resolveOvertime(
      Object.values(round.players).map((rp) => ({
        playerId: rp.playerId,
        smallScore: rp.smallScore,
        overtimeElapsedSeconds: rp.timedOut ? Number.MAX_SAFE_INTEGER : (rp.elapsedSeconds ?? 0),
        seriesElapsedSeconds: seriesElapsed(rp.playerId),
      }))
    );

    round.overtimeResolution = resolution;

    if (resolution.winnerId) {
      const winner = scoreEntries.find((e) => e.playerId === resolution.winnerId);
      if (winner) winner.matchPointsDelta = 1.0;
      console.log(
        `[PVP] Overtime decider in ${room.roomCode}: ${room.players[resolution.winnerId]?.nickname} wins (+1.0) via ${resolution.reason}`
      );
    } else {
      console.log(`[PVP] Overtime decider in ${room.roomCode} ended in a draw`);
    }
  }

  // -------------------------------------------------------------------------
  // Match completion, overtime vote, final ranking
  // -------------------------------------------------------------------------

  private checkMatchComplete(room: PvpRoomState) {
    if (room.status === 'FINISHED' || room.status === 'OVERTIME_VOTE') return;

    if (room.status === 'OVERTIME') {
      const decider = room.rounds.find((r) => r.isOvertime);
      if (!decider || !decider.settled) return;
      if (this.allPlayers(room).some((p) => p.phase === 'playing')) return;
      const ranked = rankPlayers(this.standingsOf(room));
      this.finishSeries(room, ranked, `加赛决胜（${decider.overtimeResolution?.reason ?? 'draw'}）`);
      return;
    }

    if (room.status !== 'IN_PROGRESS') return;

    const scheduled = room.rounds.filter((r) => !r.isOvertime);
    if (scheduled.length < room.config.totalRounds) return;
    if (!scheduled.every((r) => r.settled)) return;
    if (this.allPlayers(room).some((p) => p.phase === 'playing')) return;

    this.finalizeMatch(room);
  }

  private standingsOf(room: PvpRoomState): Standing[] {
    return this.allPlayers(room).map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      matchPoints: p.matchPoints,
      totalScore: p.totalScore,
      isFinished: p.hasFinishedAllRounds || p.phase === 'left',
      finishedAt: p.finishedAt,
    }));
  }

  private finalizeMatch(room: PvpRoomState) {
    const standings = this.standingsOf(room);
    const tied = tiedLeaders(standings);

    if (tied.length > 0) {
      this.startOvertimeVote(room, tied);
      return;
    }

    const ranked = rankPlayers(standings);
    this.finishSeries(room, ranked, '无并列，按大比分与小分直接排名');
  }

  private startOvertimeVote(room: PvpRoomState, participants: string[]) {
    room.status = 'OVERTIME_VOTE';
    room.overtime = {
      participants,
      deadlineAt: Date.now() + OVERTIME_VOTE_SECONDS * 1000,
      votes: {},
    };

    console.log(
      `[PVP] Room ${room.roomCode} is tied at the top — starting overtime vote with ` +
        participants.map((p) => room.players[p]?.nickname ?? p).join(', ')
    );

    this.broadcastSummary(room.roomCode);
    this.broadcast(room.roomCode, {
      type: 'overtime:vote_started',
      payload: {
        participants,
        deadlineAt: room.overtime.deadlineAt,
        seconds: OVERTIME_VOTE_SECONDS,
      },
    });

    const existing = this.voteTimers.get(room.roomCode);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const current = this.rooms.get(room.roomCode);
      if (!current || current.status !== 'OVERTIME_VOTE') return;
      console.log(`[PVP] Overtime vote in ${room.roomCode} timed out — settling as a draw`);
      this.resolveOvertimeAsDraw(current, '投票超时');
    }, OVERTIME_VOTE_SECONDS * 1000);
    this.voteTimers.set(room.roomCode, timer);
  }

  private handleOvertimeVote(playerId: string, payload: { agree?: boolean }) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'OVERTIME_VOTE' || !room.overtime) return;

    const { participants, votes } = room.overtime;
    if (!participants.includes(playerId)) {
      return this.sendError(playerId, '你不是并列领先者，无法参与加赛投票', 'NOT_A_PARTICIPANT');
    }
    if (votes[playerId]) return;

    votes[playerId] = payload.agree ? 'yes' : 'no';
    console.log(
      `[PVP] Overtime vote in ${room.roomCode}: ${room.players[playerId]?.nickname} voted ${votes[playerId]}`
    );

    this.broadcast(room.roomCode, {
      type: 'overtime:vote_update',
      payload: { votes, participants, deadlineAt: room.overtime.deadlineAt },
    });
    this.broadcastSummary(room.roomCode);

    if (Object.values(votes).includes('no')) {
      return this.resolveOvertimeAsDraw(room, '有选手拒绝加赛');
    }
    if (participants.every((pid) => votes[pid] === 'yes')) {
      return this.startOvertimeRound(room);
    }
  }

  private clearVoteTimer(roomCode: string) {
    const timer = this.voteTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.voteTimers.delete(roomCode);
    }
  }

  private resolveOvertimeAsDraw(room: PvpRoomState, reason: string) {
    this.clearVoteTimer(room.roomCode);
    if (room.overtime) {
      room.overtime.resolvedReason = reason;
      room.status = 'OVERTIME_VOTE';
    }
    const ranked = rankPlayers(this.standingsOf(room));
    console.log(`[PVP] Room ${room.roomCode} finished as a draw: ${reason}`);
    this.finishSeries(room, ranked, reason);
  }

  private drawOvertimeExam(room: PvpRoomState): { year: number; exam: TranslationExam } {
    const years = this.availableYears();
    const used = new Set(room.scheduledYears);
    const participants = room.overtime?.participants ?? Object.keys(room.players);

    // 1) an exam nobody in the room has ever played and that this series has not used
    let played = new Map<string, Set<number>>();
    try {
      played = db.getPlayedYears(participants);
    } catch (err) {
      console.warn('[PVP] getPlayedYears failed, falling back to series-local pool:', err);
    }
    const unseen = years.filter((y) => {
      if (used.has(y)) return false;
      return participants.every((pid) => !played.get(pid)?.has(y));
    });

    // 2) any exam this series has not used
    const fresh = years.filter((y) => !used.has(y));

    // 3) the whole bank
    const pick = <T>(pool: T[]): T => pool[Math.floor(Math.random() * pool.length)];
    const year = unseen.length > 0 ? pick(unseen) : fresh.length > 0 ? pick(fresh) : pick(years);
    const exam = getExamByYear(year) as TranslationExam;
    console.log(
      `[PVP] Overtime exam for ${room.roomCode}: ${year} ` +
        `(unseen=${unseen.length}, unused-in-series=${fresh.length})`
    );
    return { year, exam };
  }

  private startOvertimeRound(room: PvpRoomState) {
    if (!room.overtime) return;
    this.clearVoteTimer(room.roomCode);

    const participants = room.overtime.participants.filter((pid) => room.players[pid]);
    if (participants.length < 2) {
      return this.resolveOvertimeAsDraw(room, '可参赛选手不足');
    }

    const { year, exam } = this.drawOvertimeExam(room);
    room.overtimeYear = year;
    room.overtime.startedAt = Date.now();

    const batches: RoundState['batches'] = {};
    for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
      batches[i] = { segmentIndex: i, status: 'waiting', attempts: 0 };
    }
    const players: Record<string, RoundPlayerState> = {};
    for (const pid of participants) players[pid] = this.buildRoundPlayer(pid);

    const round: RoundState = {
      roundIndex: room.config.totalRounds,
      year,
      isOvertime: true,
      exam,
      startedAt: Date.now(),
      players,
      batches,
      settled: false,
    };
    room.rounds[room.config.totalRounds] = round;
    room.status = 'OVERTIME';

    const now = Date.now();
    for (const pid of participants) {
      const p = room.players[pid];
      p.phase = 'playing';
      p.hasFinishedAllRounds = false;
      p.finishedAt = undefined;
      p.currentRoundIndex = room.config.totalRounds;
      p.currentSegmentIndex = 0;
      p.answeredSegments = [];
      p.roundStartedAt = now;
      p.roundDeadlineAt = now + this.durationSeconds(room) * 1000;
      const client = this.clients.get(pid);
      if (client) client.watchingRound = round.roundIndex;
    }

    console.log(
      `[PVP] Overtime round started in ${room.roomCode} on year ${year} with ` +
        participants.map((p) => room.players[p]?.nickname ?? p).join(', ')
    );

    this.broadcast(room.roomCode, {
      type: 'overtime:resolved',
      payload: { agreed: true, year, roundIndex: round.roundIndex },
    });
    this.broadcastSummary(room.roomCode);
    this.broadcast(room.roomCode, {
      type: 'round:started',
      payload: { roundIndex: round.roundIndex, year, isOvertime: true },
    });
    for (const pid of participants) this.pushRoundDetail(pid, round.roundIndex);
    for (const sid of Object.keys(room.spectators)) this.pushRoundDetail(sid, round.roundIndex);
  }

  private finishSeries(room: PvpRoomState, ranked: PlayerRanking[], reason: string) {
    room.status = 'FINISHED';
    room.rankings = ranked;
    const top = ranked.filter((r) => r.rank === 1);
    room.winnerId = top.length === 1 ? top[0].playerId : 'draw';
    this.clearVoteTimer(room.roomCode);

    console.log(
      `[PVP] Series finished in room ${room.roomCode} (${reason}). Winner: ${room.winnerId}. ` +
        ranked
          .map((r) => `${r.nickname} MP=${r.matchPoints} PTS=${r.totalScore} rank=${r.rank}`)
          .join(' | ')
    );

    this.persistSeries(room, ranked);

    this.broadcast(room.roomCode, {
      type: 'match:ended',
      payload: {
        winnerId: room.winnerId,
        rankings: room.rankings,
        reason,
        wentOvertime: room.rounds.some((r) => r.isOvertime),
        summary: this.summaryFor(room),
      },
    });
    this.broadcastSummary(room.roomCode);
  }

  private persistSeries(room: PvpRoomState, ranked: PlayerRanking[]) {
    const wentOvertime = room.rounds.some((r) => r.isOvertime);

    for (const player of this.allPlayers(room)) {
      const myRank = ranked.find((r) => r.playerId === player.playerId)?.rank ?? 1;
      const isWinner = myRank === 1 && room.winnerId === player.playerId;
      const isDraw = room.winnerId === 'draw' && myRank === 1;
      const outcome: 'win' | 'draw' | 'loss' = isWinner ? 'win' : isDraw ? 'draw' : 'loss';

      const roundsRecord: HistoryRoundRecord[] = room.rounds.map((round) => {
        const rp = round.players[player.playerId];
        const entry = round.scoreEntries?.find((e) => e.playerId === player.playerId);
        const submissions: SegmentSubmission[] = [];
        for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
          submissions.push(
            rp?.submissions[i] ??
              this.createTimeoutSubmission(round.exam, i)
          );
        }
        return {
          roundIndex: round.roundIndex,
          year: round.year,
          isOvertime: round.isOvertime,
          smallScore: rp?.smallScore ?? 0,
          matchPointsDelta: entry?.matchPointsDelta ?? 0,
          matchPointsAfter: player.matchPoints,
          elapsedSeconds: rp?.elapsedSeconds ?? 0,
          remainingSeconds: rp?.remainingSeconds ?? 0,
          timedOut: rp?.timedOut ?? true,
          submissions,
          scoreEntries: round.scoreEntries,
        };
      });

      const flatSubmissions = roundsRecord.flatMap((r) => r.submissions);
      const otherPlayers = this.allPlayers(room).filter((p) => p.playerId !== player.playerId);
      const primaryOpponent = otherPlayers[0];

      const record: HistorySessionRecord = {
        id: `pvp-${room.roomCode}-${room.startedAt || room.createdAt || Date.now()}-${player.playerId}`,
        type: 'pvp',
        year: room.rounds[0]?.year ?? room.scheduledYears[0] ?? 0,
        timestamp: Date.now(),
        totalScore: player.totalScore,
        timeSpentSeconds: roundsRecord.reduce((sum, r) => sum + (r.elapsedSeconds || 0), 0),
        submissions: flatSubmissions,
        roundCount: room.config.totalRounds,
        matchPoints: player.matchPoints,
        wentOvertime,
        rounds: roundsRecord,
        pvpDetails: primaryOpponent
          ? {
              opponentNickname: primaryOpponent.nickname,
              opponentScore: primaryOpponent.totalScore,
              outcome,
              rank: myRank,
              playerCount: this.allPlayers(room).length,
              finalMatchPoints: player.matchPoints,
              leaderboard: ranked.map((r) => ({
                nickname: r.nickname,
                score: r.totalScore,
                rank: r.rank,
                matchPoints: r.matchPoints,
              })),
            }
          : undefined,
      };

      try {
        db.saveHistoryRecord(player.playerId, record);
        console.log(
          `[PVP] Saved ${room.config.totalRounds}-round history for ${player.nickname} (${player.playerId}) id=${record.id}`
        );
      } catch (err) {
        console.error(`[PVP] Failed to save history record for ${player.playerId}:`, err);
      }
    }

    this.deleteSnapshot(room.roomCode);
  }

  // -------------------------------------------------------------------------
  // Snapshots (only used for matches long enough to survive a restart)
  // -------------------------------------------------------------------------

  private isLongMatch(room: PvpRoomState): boolean {
    return room.config.totalRounds * room.config.durationMinutes > LONG_MATCH_MINUTES;
  }

  private maybeSnapshot(room: PvpRoomState) {
    if (!this.isLongMatch(room)) return;
    if (room.status === 'FINISHED') return;
    try {
      room.snapshotAt = Date.now();
      db.saveMatchSnapshot(room.roomCode, JSON.stringify(room));
    } catch (err) {
      console.error(`[PVP] Failed to snapshot room ${room.roomCode}:`, err);
    }
  }

  private deleteSnapshot(roomCode: string) {
    try {
      db.deleteMatchSnapshot(roomCode);
    } catch (err) {
      console.error(`[PVP] Failed to delete snapshot for ${roomCode}:`, err);
    }
  }

  private restoreSnapshots() {
    let restored = 0;
    try {
      for (const row of db.loadMatchSnapshots()) {
        try {
          const room = JSON.parse(row.payload_json) as PvpRoomState;
          if (!room || room.status === 'FINISHED' || !room.roomCode) {
            db.deleteMatchSnapshot(row.room_code);
            continue;
          }
          for (const p of Object.values(room.players)) {
            p.isOnline = false;
          }
          for (const s of Object.values(room.spectators)) {
            s.isOnline = false;
          }
          this.rooms.set(room.roomCode, room);
          restored++;
        } catch (err) {
          console.error(`[PVP] Corrupt snapshot for room ${row.room_code}, discarding:`, err);
          db.deleteMatchSnapshot(row.room_code);
        }
      }
    } catch (err) {
      console.error('[PVP] Failed to load match snapshots:', err);
    }
    if (restored > 0) {
      console.log(`[PVP] Restored ${restored} in-flight long match(es) from snapshots`);
    }
  }

  // -------------------------------------------------------------------------
  // Deadlines swept once per second
  // -------------------------------------------------------------------------

  private sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.status === 'IN_PROGRESS' || room.status === 'OVERTIME') {
        for (const player of this.allPlayers(room)) {
          if (player.phase !== 'playing') continue;
          if (!player.roundDeadlineAt || now < player.roundDeadlineAt) continue;
          console.log(
            `[PVP] Round ${player.currentRoundIndex + 1} deadline hit for ${player.nickname} in ${room.roomCode}`
          );
          this.completeRoundForPlayer(room, player, true);
        }

        // Watchdog for a grading call that never settled.
        for (const round of room.rounds) {
          for (const batch of Object.values(round.batches)) {
            if (batch.status === 'grading' && batch.startedAt && now - batch.startedAt > GRADING_STUCK_MS) {
              console.error(
                `[PVP] Batch R${round.roundIndex + 1}Q${batch.segmentIndex + 1} in ${room.roomCode} stuck for ` +
                  `${Math.round((now - batch.startedAt) / 1000)}s — forcing it closed`
              );
              batch.status = 'failed';
              for (const pid of Object.keys(round.players)) {
                const sub = round.players[pid].submissions[batch.segmentIndex];
                if (sub && (sub.gradingStatus === 'grading' || sub.gradingStatus === 'idle')) {
                  sub.gradingStatus = 'graded';
                  sub.gradingResult = {
                    score: 0,
                    points_breakdown: [],
                    distortion_deduction: 0,
                    fluency_deduction: 0,
                    critique: '本题评分超时，按 0 分计。',
                    reference_translation: '',
                    gradedAt: Date.now(),
                  };
                }
              }
              this.checkRoundSettle(room, round.roundIndex);
              this.checkMatchComplete(room);
            }
          }
        }
      }

      if (room.status === 'OVERTIME_VOTE' && room.overtime && now >= room.overtime.deadlineAt) {
        this.resolveOvertimeAsDraw(room, '投票超时');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast & per-recipient payloads
  // -------------------------------------------------------------------------

  private spectatorRoundFor(room: PvpRoomState): number {
    let max = 0;
    for (const p of this.allPlayers(room)) {
      max = Math.max(max, p.currentRoundIndex);
    }
    return Math.min(max, Math.max(0, room.rounds.length - 1));
  }

  private summaryFor(room: PvpRoomState): PvpRoomSummary {
    const players: PvpRoomSummaryPlayer[] = this.allPlayers(room).map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      isHost: p.isHost,
      isReady: p.isReady,
      isOnline: p.isOnline,
      phase: p.phase,
      currentRoundIndex: p.currentRoundIndex,
      currentSegmentIndex: p.currentSegmentIndex,
      roundDeadlineAt: p.phase === 'playing' ? p.roundDeadlineAt : undefined,
      answeredCount: p.answeredSegments.length,
      matchPoints: p.matchPoints,
      totalScore: p.totalScore,
      roundsCompleted: p.roundsCompleted,
      hasFinishedAllRounds: p.hasFinishedAllRounds,
      finishedAt: p.finishedAt,
    }));

    const rounds: PvpRoomSummaryRound[] = room.rounds.map((r) => {
      const started = r.startedAt > 0;
      const batchValues = Object.values(r.batches);
      return {
        roundIndex: r.roundIndex,
        year: started ? r.year : null,
        isOvertime: r.isOvertime,
        settled: r.settled,
        startedAt: r.startedAt,
        gradedSegments: batchValues.filter((b) => b.status === 'graded' || b.status === 'failed').length,
        totalSegments: SEGMENTS_PER_ROUND,
      };
    });

    let currentRoundIndex = 0;
    for (const p of this.allPlayers(room)) currentRoundIndex = Math.max(currentRoundIndex, p.currentRoundIndex);

    return {
      roomCode: room.roomCode,
      status: room.status,
      config: room.config,
      currentRoundIndex,
      createdAt: room.createdAt,
      startedAt: room.startedAt,
      countdownEndTime: room.countdownEndTime,
      players,
      spectators: Object.values(room.spectators).map((s) => ({
        playerId: s.playerId,
        nickname: s.nickname,
        isOnline: s.isOnline,
      })),
      rounds,
      overtime: room.overtime
        ? {
            participants: room.overtime.participants,
            deadlineAt: room.overtime.deadlineAt,
            votes: room.overtime.votes,
            status: room.status === 'OVERTIME_VOTE' ? 'voting' : room.status === 'OVERTIME' ? 'running' : 'resolved',
          }
        : undefined,
      winnerId: room.winnerId,
      rankings: room.rankings,
    };
  }

  private roundDetailFor(room: PvpRoomState, roundIndex: number, viewerId: string, isSpectator: boolean): RoundDetail | undefined {
    const round = room.rounds[roundIndex];
    if (!round) return undefined;

    const viewer = room.players[viewerId];
    // A player must not read anyone else's answers until their own series is over.
    const withholdOthers = !isSpectator && !!viewer && viewer.phase === 'playing' && !viewer.hasFinishedAllRounds;

    const withheldPlayerIds: string[] = [];
    const players: RoundDetailPlayer[] = Object.keys(round.players).map((pid) => {
      const rp = round.players[pid];
      const p = room.players[pid];
      const isSelf = pid === viewerId;

      let submissions = rp.submissions;
      if (withholdOthers && !isSelf) {
        withheldPlayerIds.push(pid);
        submissions = Object.fromEntries(
          Object.entries(rp.submissions).map(([key, sub]) => [
            key,
            {
              ...sub,
              studentAnswer: '',
              gradingResult: sub.gradingResult
                ? { ...sub.gradingResult, critique: '', reference_translation: '', points_breakdown: [] }
                : undefined,
              comparativeAnalysis: undefined,
            },
          ])
        );
      }

      return {
        playerId: pid,
        nickname: p?.nickname ?? pid,
        isHost: p?.isHost ?? false,
        isOnline: p?.isOnline,
        phase: p?.phase ?? 'left',
        submissions,
        roundCompletedAt: rp.roundCompletedAt,
        elapsedSeconds: rp.elapsedSeconds,
        remainingSeconds: rp.remainingSeconds,
        timedOut: rp.timedOut,
        smallScore: rp.smallScore,
        matchPoints: p?.matchPoints ?? 0,
        totalScore: p?.totalScore ?? 0,
        currentSegmentIndex: p?.currentRoundIndex === roundIndex ? p.currentSegmentIndex : -1,
      };
    });

    return {
      roundIndex,
      year: round.year,
      isOvertime: round.isOvertime,
      exam: round.exam,
      startedAt: round.startedAt,
      settled: round.settled,
      scoreEntries: round.scoreEntries,
      players,
      withheldPlayerIds,
    };
  }

  private pushRoundDetail(playerId: string, roundIndex: number) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;
    const detail = this.roundDetailFor(room, roundIndex, playerId, !!client.isSpectator);
    if (!detail) return;
    client.watchingRound = roundIndex;
    this.sendToPlayer(playerId, { type: 'round:detail', payload: detail });
  }

  /** Pushes an updated detail to everyone currently looking at this round. */
  private pushWatchedRound(room: PvpRoomState, roundIndex: number) {
    for (const [playerId, client] of this.clients.entries()) {
      if (client.roomCode !== room.roomCode) continue;
      const player = room.players[playerId];
      const watching = client.watchingRound ?? (player ? player.currentRoundIndex : this.spectatorRoundFor(room));
      if (watching !== roundIndex) continue;
      const detail = this.roundDetailFor(room, roundIndex, playerId, !!client.isSpectator);
      if (detail) this.sendToPlayer(playerId, { type: 'round:detail', payload: detail });
    }
  }

  broadcast(roomCode: string, message: any) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const data = JSON.stringify(message);
    const recipients = new Set([...Object.keys(room.players), ...Object.keys(room.spectators)]);

    for (const pid of recipients) {
      const ws = this.playerSockets.get(pid);
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
    }
  }

  private broadcastSummary(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    this.broadcast(roomCode, { type: 'room:summary', payload: this.summaryFor(room) });
  }

  private sendSummaryTo(playerId: string) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;
    this.sendToPlayer(playerId, { type: 'room:summary', payload: this.summaryFor(room) });
  }

  private sendToPlayer(playerId: string, message: any) {
    const ws = this.playerSockets.get(playerId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(playerId: string, errorMessage: string, code?: string) {
    this.sendToPlayer(playerId, {
      type: 'error',
      payload: code ? { message: errorMessage, code } : { message: errorMessage },
    });
  }

  // -------------------------------------------------------------------------
  // Reconnect / leave / disconnect
  // -------------------------------------------------------------------------

  private reconnectRoom(playerId: string, payload: { roomCode?: string }) {
    let room: PvpRoomState | undefined;
    if (payload.roomCode) {
      room = this.rooms.get(payload.roomCode.toUpperCase().trim());
    }
    if (!room) {
      room = this.findRoomByPlayerId(playerId);
    }

    if (room) {
      const isPlayer = !!room.players[playerId];
      const isSpectator = !!room.spectators[playerId];

      if (isPlayer || isSpectator) {
        const client = this.clients.get(playerId);
        if (client) {
          client.roomCode = room.roomCode;
          client.isSpectator = isSpectator;
        }

        if (isPlayer) {
          const player = room.players[playerId];
          player.isOnline = true;
          player.lastActiveAt = Date.now();
          if (client) client.watchingRound = player.currentRoundIndex;
          console.log(
            `[PVP] Manual reconnect for player ${playerId} into room ${room.roomCode} ` +
              `(status=${room.status}, round=${player.currentRoundIndex + 1}, segment=${player.currentSegmentIndex + 1})`
          );
        } else {
          room.spectators[playerId].isOnline = true;
          console.log(`[PVP] Manual reconnect for spectator ${playerId} into room ${room.roomCode}`);
        }

        this.sendSummaryTo(playerId);
        if (isPlayer) {
          const player = room.players[playerId];
          if (room.rounds[player.currentRoundIndex]) {
            this.pushRoundDetail(playerId, player.currentRoundIndex);
          }
        } else {
          this.pushRoundDetail(playerId, this.spectatorRoundFor(room));
        }
        this.broadcastSummary(room.roomCode);
        return;
      }
    }

    console.warn(`[PVP] Reconnect failed for user ${playerId}, room not found`);
    this.sendError(playerId, '对战已结束或房间已失效', 'ROOM_NOT_FOUND');
  }

  /** Fills every not-yet-played round of a departing player with timeout zeros. */
  private abandonRemainingRounds(room: PvpRoomState, player: PlayerState) {
    for (const round of room.rounds) {
      const rp = round.players[player.playerId];
      if (!rp) continue;
      if (!rp.roundCompletedAt) {
        for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
          if (!rp.submissions[i]) rp.submissions[i] = this.createTimeoutSubmission(round.exam, i);
        }
        rp.timedOut = true;
        rp.elapsedSeconds = this.durationSeconds(room);
        rp.remainingSeconds = 0;
        rp.roundCompletedAt = Date.now();
        this.recomputeSmallScore(rp);
      }
      for (let i = 0; i < SEGMENTS_PER_ROUND; i++) {
        this.maybeTriggerBatch(room, round.roundIndex, i);
      }
    }
    player.phase = 'left';
    player.hasFinishedAllRounds = true;
    player.roundDeadlineAt = undefined;
    player.roundsCompleted = room.config.totalRounds;
    this.refreshTotals(room, player);
  }

  private leaveRoom(playerId: string) {
    const client = this.clients.get(playerId);
    const roomCode = client?.roomCode;
    if (!roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (room.spectators[playerId]) {
      console.log(`[PVP] Spectator ${playerId} left room ${roomCode}`);
      delete room.spectators[playerId];
      client.roomCode = undefined;
      client.isSpectator = false;
      this.broadcastSummary(room.roomCode);
      return;
    }

    if (room.players[playerId]) {
      const player = room.players[playerId];
      const inFlight =
        room.status === 'IN_PROGRESS' || room.status === 'OVERTIME' || room.status === 'OVERTIME_VOTE';

      console.log(`[PVP] Player ${playerId} left room ${roomCode} (inFlight=${inFlight})`);
      client.roomCode = undefined;
      client.isSpectator = false;

      if (!inFlight) {
        delete room.players[playerId];
      } else {
        // The leaver stays in the roster: their auto-filled zeros are part of every
        // remaining round's baseline, and they still receive an archived loss.
        this.abandonRemainingRounds(room, player);
        player.isOnline = false;
        this.broadcastSummary(room.roomCode);
        for (const round of room.rounds) this.checkRoundSettle(room, round.roundIndex);
        this.checkMatchComplete(room);
      }

      const remaining = this.allPlayers(room);
      if (remaining.length === 0) {
        console.log(`[PVP] Room ${roomCode} has 0 players left, deleting.`);
        this.rooms.delete(room.roomCode);
        this.clearVoteTimer(room.roomCode);
        this.deleteSnapshot(room.roomCode);
      } else if (!remaining.some((p) => p.isHost)) {
        remaining[0].isHost = true;
      }
      this.broadcastSummary(room.roomCode);
    }
  }

  private handleDisconnect(playerId: string, ws?: WebSocket) {
    const currentSocket = this.playerSockets.get(playerId);
    if (ws && currentSocket && currentSocket !== ws) {
      console.log(
        `[PVP] Ignoring close event from stale socket for player ${playerId} (live socket still registered)`
      );
      return;
    }

    const room = this.findRoomByPlayerId(playerId);
    if (room) {
      if (room.players[playerId]) {
        // The clock keeps running while offline; the sweep will time the round out.
        room.players[playerId].isOnline = false;
        room.players[playerId].lastActiveAt = Date.now();
        console.log(
          `[PVP] Socket disconnected for player ${room.players[playerId].nickname} (${playerId}) in room ${room.roomCode}. Room preserved.`
        );
      } else if (room.spectators[playerId]) {
        room.spectators[playerId].isOnline = false;
        console.log(
          `[PVP] Socket disconnected for spectator ${room.spectators[playerId].nickname} (${playerId}) in room ${room.roomCode}.`
        );
      }
      this.broadcastSummary(room.roomCode);
    }

    this.playerSockets.delete(playerId);
  }

  private cleanupStaleRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      if (room.status === 'FINISHED' && room.startedAt && now - room.startedAt > 2 * 3600 * 1000) {
        console.log(`[PVP] Cleaning up finished stale room ${code}`);
        this.rooms.delete(code);
        this.clearVoteTimer(code);
        this.deleteSnapshot(code);
        continue;
      }

      const hasOnlinePlayers = Object.values(room.players).some((p) => p.isOnline);
      const hasOnlineSpectators = Object.values(room.spectators).some((s) => s.isOnline);
      const isOldWaitingRoom = room.createdAt && now - room.createdAt > 30 * 60 * 1000;
      if (room.status === 'WAITING' && !hasOnlinePlayers && !hasOnlineSpectators && isOldWaitingRoom) {
        console.log(`[PVP] Cleaning up abandoned waiting room ${code} (inactive > 30m)`);
        this.rooms.delete(code);
        this.clearVoteTimer(code);
        this.deleteSnapshot(code);
      }
    }
  }
}

export const pvpManager = new PvpManager();
