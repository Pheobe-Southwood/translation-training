import type { WebSocket } from 'ws';
import type {
  PvpRoomState,
  PlayerState,
  PlayerRanking,
  TranslationExam,
  SegmentSubmission,
  HistorySessionRecord,
} from '../shared/types.js';
import { getExamByYear, getRandomExam } from './examService.js';
import { gradeTranslation, gradePvpPairTranslation } from './deepseek.js';
import { db } from './db.js';

interface ConnectedClient {
  ws: WebSocket;
  playerId: string;
  roomCode?: string;
  isSpectator?: boolean;
}

class PvpManager {
  private rooms: Map<string, PvpRoomState> = new Map();
  private clients: Map<string, ConnectedClient> = new Map(); // playerId -> ConnectedClient
  private playerSockets: Map<string, WebSocket> = new Map(); // playerId -> ws
  private matchTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> Timer
  private guardrailTimers: Map<string, NodeJS.Timeout> = new Map(); // roomCode -> Timer

  constructor() {
    // Periodic cleanup of truly abandoned rooms (runs every 5 minutes)
    setInterval(() => {
      this.cleanupStaleRooms();
    }, 5 * 60 * 1000);
  }

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

    // Check if user belongs to an existing active room (for auto-reconnect)
    const existingRoom = this.findRoomByPlayerId(playerId);
    if (existingRoom && existingRoom.status !== 'FINISHED') {
      const player = existingRoom.players[playerId];
      const spectator = existingRoom.spectators[playerId];

      if (player) {
        player.isOnline = true;
        player.lastActiveAt = Date.now();
        const client = this.clients.get(playerId);
        if (client) {
          client.roomCode = existingRoom.roomCode;
          client.isSpectator = false;
        }

        console.log(
          `[PVP] Re-associated socket for player "${player.nickname}" (${playerId}) in room ${existingRoom.roomCode} ` +
            `(status=${existingRoom.status}, segment=${player.currentSegmentIndex + 1})`
        );
        this.broadcastRoomState(existingRoom.roomCode);
      } else if (spectator) {
        spectator.isOnline = true;
        const client = this.clients.get(playerId);
        if (client) {
          client.roomCode = existingRoom.roomCode;
          client.isSpectator = true;
        }

        console.log(
          `[PVP] Re-associated socket for spectator "${spectator.nickname}" (${playerId}) in room ${existingRoom.roomCode}`
        );
        this.broadcastRoomState(existingRoom.roomCode);
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
    playerId: string,
    payload: {
      nickname: string;
      year?: number;
      durationMinutes?: number;
      maxPlayers?: number;
      allowSpectators?: boolean;
    }
  ) {
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
      createdAt: Date.now(),
      players: {
        [playerId]: hostPlayer,
      },
      spectators: {},
    };

    this.rooms.set(code, roomState);
    const client = this.clients.get(playerId);
    if (client) {
      client.roomCode = code;
      client.isSpectator = false;
    }

    console.log(
      `[PVP] Created room ${code} (maxPlayers=${maxPlayers}, spectators=${allowSpectators}) by ${hostPlayer.nickname} (${playerId}), Year: ${exam.year}`
    );
    this.broadcastRoomState(code);
  }

  private joinRoom(
    playerId: string,
    payload: { roomCode: string; nickname: string; asSpectator?: boolean }
  ) {
    const code = (payload.roomCode || '').toUpperCase().trim();
    const room = this.rooms.get(code);

    if (!room) {
      console.warn(`[PVP] Room join failed, room not found: "${code}". Current active rooms: [${Array.from(this.rooms.keys()).join(', ')}]`);
      return this.sendError(playerId, `未找到房间号：${code}（请检查房间号是否正确或已被房主解散）`);
    }

    const existingPlayer = room.players[playerId];
    const existingSpectator = room.spectators[playerId];

    // Reconnecting / Rejoining participant
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
      }
      this.broadcastRoomState(code);
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
      this.broadcastRoomState(code);
      return;
    }

    // Explicit request to join as spectator
    if (payload.asSpectator) {
      if (room.allowSpectators === false) {
        return this.sendError(playerId, '该房间未开启观战功能', 'SPECTATING_NOT_ALLOWED');
      }
      const nickname = (payload.nickname || `观众${Object.keys(room.spectators).length + 1}`).trim().slice(0, 16);
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
      console.log(`[PVP] Player ${nickname} (${playerId}) joined room ${code} as spectator.`);
      this.broadcastRoomState(code);
      return;
    }

    // Attempting to join as player
    // If match is already in progress or finished:
    if (room.status !== 'WAITING' && room.status !== 'READY') {
      if (room.allowSpectators !== false) {
        const nickname = (payload.nickname || `观众${Object.keys(room.spectators).length + 1}`).trim().slice(0, 16);
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
        this.sendToPlayer(playerId, {
          type: 'room:joined_as_spectator',
          payload: { message: '对战已在进行中，已自动为您开启实时观战席位' },
        });
        console.log(`[PVP] Player ${nickname} (${playerId}) auto-joined room ${code} as spectator (match active).`);
        this.broadcastRoomState(code);
        return;
      }
      return this.sendError(playerId, '对战已开始或已结束，无法加入', 'MATCH_ALREADY_STARTED');
    }

    // Room is WAITING or READY: check player capacity
    const currentPlayerCount = Object.keys(room.players).length;
    if (currentPlayerCount >= room.maxPlayers) {
      if (room.allowSpectators !== false) {
        const nickname = (payload.nickname || `观众${Object.keys(room.spectators).length + 1}`).trim().slice(0, 16);
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
        this.sendToPlayer(playerId, {
          type: 'room:joined_as_spectator',
          payload: { message: `选手席位已满（上限 ${room.maxPlayers} 人），已自动为您转入观战席位` },
        });
        console.log(`[PVP] Player ${nickname} (${playerId}) auto-joined room ${code} as spectator (player capacity reached).`);
        this.broadcastRoomState(code);
        return;
      }
      return this.sendError(playerId, `房间已满（上限 ${room.maxPlayers} 人对战）`, 'ROOM_FULL');
    }

    // New challenger player slot
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

    const client = this.clients.get(playerId);
    if (client) {
      client.roomCode = code;
      client.isSpectator = false;
    }

    console.log(
      `[PVP] Player ${nickname} (${playerId}) joined room ${code}. Total players: ${Object.keys(room.players).length}/${room.maxPlayers}`
    );
    this.broadcastRoomState(code);
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
      // Spectator switching to player
      if (!room.spectators[playerId]) return;
      if (Object.keys(room.players).length >= room.maxPlayers) {
        return this.sendError(playerId, `选手席位已满（上限 ${room.maxPlayers} 人）`);
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
      client.isSpectator = false;
      room.status = 'WAITING';
      this.broadcastRoomState(room.roomCode);
    } else if (targetRole === 'spectator') {
      // Player switching to spectator
      if (!room.players[playerId]) return;
      if (room.allowSpectators === false) {
        return this.sendError(playerId, '该房间未开启观战席');
      }
      const player = room.players[playerId];
      const otherPlayers = Object.values(room.players).filter((p) => p.playerId !== playerId);
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
      this.broadcastRoomState(room.roomCode);
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

    const players = Object.values(room.players);
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

  private updateRoomSettings(
    playerId: string,
    payload: {
      year?: number;
      durationMinutes?: number;
      maxPlayers?: number;
      allowSpectators?: boolean;
    }
  ) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room || room.status !== 'WAITING') return;

    const player = room.players[playerId];
    if (!player || !player.isHost) {
      return this.sendError(playerId, '只有房主可以更改房间设置');
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
          playerId,
          `当前已有 ${Object.keys(room.players).length} 名选手在场，无法将人数设为 ${payload.maxPlayers}`
        );
      }
    }

    if (typeof payload.allowSpectators === 'boolean') {
      room.allowSpectators = payload.allowSpectators;
    }

    this.broadcastRoomState(client.roomCode);
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

    // 120-second guardrail timer to prevent rooms getting permanently stuck
    const guardrail = setTimeout(() => {
      console.warn(`[PVP] Guardrail timeout reached (120s) for room ${roomCode}. Force-finishing match.`);
      this.forceFinishHangingRoom(roomCode);
    }, 120000);
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
    playerId: string,
    payload: { segmentIndex: number; studentAnswer: string }
  ) {
    const client = this.clients.get(playerId);
    if (!client?.roomCode) return;
    const room = this.rooms.get(client.roomCode);
    if (!room) return;

    if (room.status !== 'IN_PROGRESS') {
      return this.sendError(playerId, '对战未在进行中，无法提交', 'NOT_IN_PROGRESS');
    }

    const player = room.players[playerId];
    if (!player) return;

    if (player.isFinished) {
      return this.sendError(playerId, '你已交卷，无法继续提交', 'ALREADY_FINISHED');
    }

    const segmentIdx = Number(payload.segmentIndex);
    if (!Number.isInteger(segmentIdx) || segmentIdx < 0 || segmentIdx > 4) {
      console.warn(
        `[PVP] Invalid segment index ${JSON.stringify(payload.segmentIndex)} from player ${player.nickname} (${playerId}) in room ${room.roomCode}`
      );
      return this.sendError(playerId, '题目序号无效，请刷新页面后重试', 'INVALID_SEGMENT');
    }

    const answer = (payload.studentAnswer || '').trim();
    if (!answer) {
      return this.sendError(playerId, '译文不能为空', 'EMPTY_ANSWER');
    }

    // Idempotency: never overwrite an already accepted answer
    const existingSubmission = player.submissions[segmentIdx];
    if (existingSubmission && existingSubmission.gradingStatus !== 'error') {
      console.log(
        `[PVP] Duplicate submit ignored for player ${player.nickname} (${playerId}) segment ${segmentIdx + 1} in room ${room.roomCode}`
      );
      this.sendToPlayer(playerId, { type: 'room:state', payload: room });
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

        this.sendToPlayer(playerId, {
          type: 'room:state',
          payload: room,
        });
        this.broadcastRoomState(room.roomCode);
        return;
      }
    }

    console.warn(`[PVP] Reconnect failed for user ${playerId}, room not found`);
    this.sendError(playerId, '对战已结束或房间已失效', 'ROOM_NOT_FOUND');
  }

  private leaveRoom(playerId: string) {
    const client = this.clients.get(playerId);
    const roomCode = client?.roomCode;
    if (!roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (room.spectators[playerId]) {
      console.log(`[PVP] Spectator ${playerId} explicitly left room ${roomCode}`);
      delete room.spectators[playerId];
      client.roomCode = undefined;
      client.isSpectator = false;
      this.broadcastRoomState(room.roomCode);
      return;
    }

    if (room.players[playerId]) {
      console.log(`[PVP] Player ${playerId} explicitly left room ${roomCode}`);
      delete room.players[playerId];
      client.roomCode = undefined;
      client.isSpectator = false;

      const remainingPlayers = Object.values(room.players);
      if (remainingPlayers.length === 0) {
        console.log(`[PVP] Room ${roomCode} has 0 players left, deleting.`);
        this.rooms.delete(room.roomCode);
        const timer = this.matchTimers.get(room.roomCode);
        if (timer) {
          clearTimeout(timer);
          this.matchTimers.delete(room.roomCode);
        }
        const guardrail = this.guardrailTimers.get(room.roomCode);
        if (guardrail) {
          clearTimeout(guardrail);
          this.guardrailTimers.delete(room.roomCode);
        }
      } else {
        if (!remainingPlayers.some((p) => p.isHost)) {
          remainingPlayers[0].isHost = true;
        }
        if (room.status === 'IN_PROGRESS') {
          this.checkAllFinished(room);
        }
        this.broadcastRoomState(room.roomCode);
      }
    }
  }

  private handleDisconnect(playerId: string, ws?: WebSocket) {
    const currentSocket = this.playerSockets.get(playerId);
    if (ws && currentSocket && currentSocket !== ws) {
      console.log(`[PVP] Ignoring close event from stale socket for player ${playerId} (live socket still registered)`);
      return;
    }

    const room = this.findRoomByPlayerId(playerId);
    if (room) {
      if (room.players[playerId]) {
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
      this.broadcastRoomState(room.roomCode);
    }

    this.playerSockets.delete(playerId);
  }

  private broadcast(roomCode: string, message: any) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const data = JSON.stringify(message);
    const recipients = new Set([
      ...Object.keys(room.players),
      ...Object.keys(room.spectators),
    ]);

    for (const pid of recipients) {
      const ws = this.playerSockets.get(pid);
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
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

  private cleanupStaleRooms() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      // 1. Finished rooms older than 2 hours
      if (room.status === 'FINISHED' && room.startedAt && now - room.startedAt > 2 * 3600 * 1000) {
        console.log(`[PVP] Cleaning up finished stale room ${code}`);
        const timer = this.matchTimers.get(code);
        if (timer) {
          clearTimeout(timer);
          this.matchTimers.delete(code);
        }
        const guardrail = this.guardrailTimers.get(code);
        if (guardrail) {
          clearTimeout(guardrail);
          this.guardrailTimers.delete(code);
        }
        this.rooms.delete(code);
        continue;
      }

      // 2. Waiting rooms with NO online participants for over 30 minutes
      const hasOnlinePlayers = Object.values(room.players).some((p) => p.isOnline);
      const hasOnlineSpectators = Object.values(room.spectators).some((s) => s.isOnline);
      const isOldWaitingRoom = room.createdAt && now - room.createdAt > 30 * 60 * 1000;
      if (room.status === 'WAITING' && !hasOnlinePlayers && !hasOnlineSpectators && isOldWaitingRoom) {
        console.log(`[PVP] Cleaning up abandoned waiting room ${code} (inactive > 30m)`);
        const timer = this.matchTimers.get(code);
        if (timer) {
          clearTimeout(timer);
          this.matchTimers.delete(code);
        }
        const guardrail = this.guardrailTimers.get(code);
        if (guardrail) {
          clearTimeout(guardrail);
          this.guardrailTimers.delete(code);
        }
        this.rooms.delete(code);
      }
    }
  }
}

export const pvpManager = new PvpManager();
