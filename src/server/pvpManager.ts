import type { WebSocket } from 'ws';
import type {
  PvpRoomState,
  PlayerState,
  RoomStatus,
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
    this.clients.set(playerId, { ws, playerId });
    this.playerSockets.set(playerId, ws);

    // Check if player belongs to an existing active room (for auto-reconnect)
    const existingRoom = this.findRoomByPlayerId(playerId);
    if (existingRoom && existingRoom.status !== 'FINISHED') {
      const player = existingRoom.players[playerId];
      if (player) {
        player.isOnline = true;
        player.lastActiveAt = Date.now();
        const client = this.clients.get(playerId);
        if (client) client.roomCode = existingRoom.roomCode;

        console.log(`[PVP] Re-associated socket for player "${player.nickname}" (${playerId}) in room ${existingRoom.roomCode}`);
        this.broadcastRoomState(existingRoom.roomCode);
      }
    }

    ws.on('close', () => {
      this.handleDisconnect(playerId);
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
      if (room.players[playerId]) {
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
    payload: { nickname: string; year?: number; durationMinutes?: number }
  ) {
    const code = this.generateRoomCode();
    const duration =
      payload.durationMinutes &&
      ([10, 15, 20].includes(payload.durationMinutes) ||
        (process.env.NODE_ENV === 'test' && payload.durationMinutes > 0))
        ? payload.durationMinutes
        : 15;

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
      createdAt: Date.now(),
      players: {
        [playerId]: hostPlayer,
      },
    };

    this.rooms.set(code, roomState);
    const client = this.clients.get(playerId);
    if (client) client.roomCode = code;

    console.log(`[PVP] Created room ${code} by ${hostPlayer.nickname} (${playerId}), Year: ${exam.year}`);
    this.broadcastRoomState(code);
  }

  private joinRoom(playerId: string, payload: { roomCode: string; nickname: string }) {
    const code = (payload.roomCode || '').toUpperCase().trim();
    const room = this.rooms.get(code);

    if (!room) {
      console.warn(`[PVP] Room join failed, room not found: "${code}". Current active rooms: [${Array.from(this.rooms.keys()).join(', ')}]`);
      return this.sendError(playerId, `未找到房间号：${code}（请检查房间号是否正确或已被房主解散）`);
    }

    if (room.status !== 'WAITING' && room.status !== 'READY') {
      return this.sendError(playerId, '对战已开始或已结束，无法加入');
    }

    const playerKeys = Object.keys(room.players);
    if (playerKeys.length >= 2 && !room.players[playerId]) {
      return this.sendError(playerId, '房间已满（仅支持双人对战）');
    }

    // Existing player rejoining
    if (room.players[playerId]) {
      room.players[playerId].isOnline = true;
      room.players[playerId].lastActiveAt = Date.now();
      if (payload.nickname) {
        room.players[playerId].nickname = payload.nickname.trim().slice(0, 16);
      }
    } else {
      // New challenger player
      room.players[playerId] = {
        playerId,
        nickname: (payload.nickname || '玩家2').trim().slice(0, 16),
        isHost: false,
        isReady: false,
        isOnline: true,
        lastActiveAt: Date.now(),
        currentSegmentIndex: 0,
        submissions: {},
        totalScore: 0,
        isFinished: false,
      };
    }

    const client = this.clients.get(playerId);
    if (client) client.roomCode = code;

    console.log(`[PVP] Player ${room.players[playerId].nickname} (${playerId}) joined room ${code}. Total players: ${Object.keys(room.players).length}`);
    this.broadcastRoomState(code);
  }

  private updateRoomSettings(
    playerId: string,
    payload: { year?: number; durationMinutes?: number }
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
    if (players.length === 2 && players.every((p) => p.isReady)) {
      this.startCountdown(room);
    } else {
      room.status = players.length === 2 ? 'READY' : 'WAITING';
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

    console.log(`[PVP] Match started in room ${room.roomCode}, duration: ${room.durationMinutes}m`);
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

    if (playerList.length >= 2) {
      const p1 = playerList[0];
      const p2 = playerList[1];

      for (let idx = 0; idx < 5; idx++) {
        const sub1 = p1.submissions[idx];
        const sub2 = p2.submissions[idx];

        // Case A: Neither player answered this segment
        if (!sub1 && !sub2) {
          p1.submissions[idx] = {
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
          p2.submissions[idx] = {
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
    }

    // Broadcast updated room state (so players know all inputs are locked)
    this.broadcastRoomState(room.roomCode);

    // Set a 60-second guardrail timer to prevent rooms getting permanently stuck
    // in case DeepSeek API hangs or encounters network failure
    const guardrail = setTimeout(() => {
      console.warn(`[PVP] Guardrail timeout reached (60s) for room ${roomCode}. Force-finishing match.`);
      this.forceFinishHangingRoom(roomCode);
    }, 60000);
    this.guardrailTimers.set(roomCode, guardrail);

    // Check if all grading is already complete (e.g. neither answered remaining questions)
    this.checkAllFinished(room);
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
    if (!room || room.status !== 'IN_PROGRESS') return;

    const player = room.players[playerId];
    if (!player || player.isFinished) return;

    const segmentIdx = payload.segmentIndex;
    const originalText = room.exam.translationSegments[segmentIdx] || '';
    const answer = (payload.studentAnswer || '').trim();

    player.lastActiveAt = Date.now();
    player.submissions[segmentIdx] = {
      segmentIndex: segmentIdx,
      originalText,
      studentAnswer: answer,
      gradingStatus: 'waiting_pair',
      submittedAt: Date.now(),
    };

    // Advance player to next segment immediately so no blocking
    if (segmentIdx < 4) {
      player.currentSegmentIndex = segmentIdx + 1;
    } else {
      player.isFinished = true;
      player.finishedAt = Date.now();
    }

    // Check if opponent has already submitted this segment
    const players = Object.values(room.players);
    const opponent = players.find((p) => p.playerId !== playerId);

    if (opponent && opponent.submissions[segmentIdx]) {
      // Both players have submitted segmentIdx! Trigger paired grading!
      this.triggerPairedGrading(room, segmentIdx, player, opponent);
    } else {
      // Opponent hasn't submitted yet, broadcast state
      this.broadcastRoomState(room.roomCode);
    }
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

    // Prevent duplicate trigger if already in grading
    if (subA.gradingStatus === 'grading' && subB.gradingStatus === 'grading') return;

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

        // Recalculate total scores for both players
        playerA.totalScore = Object.values(playerA.submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );
        playerB.totalScore = Object.values(playerB.submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );

        console.log(`[PVP Pair] Scored Segment ${segmentIdx + 1} for ${playerA.nickname} (${pairResult.studentA.score}p) & ${playerB.nickname} (${pairResult.studentB.score}p)`);

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
      const reason = (room.matchEndTime && Date.now() >= room.matchEndTime) ? 'timeout' : 'completed';
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

    // Ensure all 5 segments exist for both players and total scores are accurately summed
    for (const player of playerList) {
      for (let idx = 0; idx < 5; idx++) {
        if (!player.submissions[idx]) {
          player.submissions[idx] = {
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
              critique: '未作答，得0分。',
              reference_translation: '',
              gradedAt: Date.now(),
            },
          };
        }
      }

      player.totalScore = Object.values(player.submissions).reduce(
        (sum, s) => sum + (s.gradingResult?.score || 0),
        0
      );
    }

    room.status = 'FINISHED';

    if (playerList.length >= 2) {
      const p1 = playerList[0];
      const p2 = playerList[1];
      if (p1.totalScore > p2.totalScore) {
        room.winnerId = p1.playerId;
      } else if (p2.totalScore > p1.totalScore) {
        room.winnerId = p2.playerId;
      } else {
        room.winnerId = 'draw';
      }
    }

    console.log(
      `[PVP] Match ended in room ${roomCode}, winner: ${room.winnerId}, reason: ${reason}, scores: ${playerList
        .map((p) => `${p.nickname}: ${p.totalScore.toFixed(1)}`)
        .join(' vs ')}`
    );

    // Authoritative Server-side persistence to SQLite
    for (const player of playerList) {
      const opp = playerList.find((p) => p.playerId !== player.playerId);
      const isWinner = room.winnerId === player.playerId;
      const isDraw = room.winnerId === 'draw';
      const outcome: 'win' | 'draw' | 'loss' = isWinner ? 'win' : isDraw ? 'draw' : 'loss';

      const deterministicId = `pvp-${room.roomCode}-${room.startedAt || room.createdAt || Date.now()}-${player.playerId}`;

      const submissionsList: SegmentSubmission[] = [0, 1, 2, 3, 4].map((idx) => {
        return (
          player.submissions[idx] || {
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
              critique: '未作答，得0分。',
              reference_translation: '',
              gradedAt: Date.now(),
            },
          }
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
        pvpDetails: opp
          ? {
              opponentNickname: opp.nickname,
              opponentScore: opp.totalScore,
              outcome,
            }
          : undefined,
      };

      try {
        db.saveHistoryRecord(player.playerId, record);
        console.log(`[PVP] Authoritatively saved history record ${record.id} for player ${player.nickname} (${player.playerId})`);
      } catch (err) {
        console.error(`[PVP] Failed to save history record for ${player.playerId}:`, err);
      }
    }

    this.broadcast(roomCode, {
      type: 'match:ended',
      payload: {
        winnerId: room.winnerId,
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

    if (room && room.players[playerId]) {
      const client = this.clients.get(playerId);
      if (client) client.roomCode = room.roomCode;
      room.players[playerId].isOnline = true;
      room.players[playerId].lastActiveAt = Date.now();

      console.log(`[PVP] Manual reconnect successful for player ${playerId} into room ${room.roomCode}`);
      this.sendToPlayer(playerId, {
        type: 'room:state',
        payload: room,
      });
      this.broadcastRoomState(room.roomCode);
    } else {
      console.warn(`[PVP] Reconnect failed for player ${playerId}, room not found`);
    }
  }

  /**
   * Explicit leave initiated by the user (clicking "退出房间")
   */
  private leaveRoom(playerId: string) {
    const client = this.clients.get(playerId);
    const roomCode = client?.roomCode;
    if (!roomCode) return;
    const room = this.rooms.get(roomCode);
    if (!room) return;

    console.log(`[PVP] Player ${playerId} explicitly left room ${roomCode}`);
    delete room.players[playerId];
    client.roomCode = undefined;

    const remainingPlayers = Object.values(room.players);
    if (remainingPlayers.length === 0) {
      // Clean up empty room
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
      // Re-assign host if host left
      if (!remainingPlayers.some((p) => p.isHost)) {
        remainingPlayers[0].isHost = true;
      }
      if (room.status === 'IN_PROGRESS') {
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
        room.status = 'FINISHED';
        room.winnerId = remainingPlayers[0].playerId;
      }
      this.broadcastRoomState(room.roomCode);
    }
  }

  /**
   * Socket disconnects unexpectedly (e.g. mobile switch to WeChat, lock screen, network glitch)
   * We PRESERVE the room and do NOT delete it!
   */
  private handleDisconnect(playerId: string) {
    const room = this.findRoomByPlayerId(playerId);
    if (room && room.players[playerId]) {
      room.players[playerId].isOnline = false;
      room.players[playerId].lastActiveAt = Date.now();
      console.log(`[PVP] Socket disconnected for player ${room.players[playerId].nickname} (${playerId}) in room ${room.roomCode}. Room preserved.`);
      this.broadcastRoomState(room.roomCode);
    }

    this.playerSockets.delete(playerId);
  }

  private broadcast(roomCode: string, message: any) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const data = JSON.stringify(message);
    for (const pid of Object.keys(room.players)) {
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

  private sendError(playerId: string, errorMessage: string) {
    this.sendToPlayer(playerId, {
      type: 'error',
      payload: { message: errorMessage },
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

      // 2. Waiting rooms with NO online players for over 30 minutes
      const hasOnlinePlayers = Object.values(room.players).some((p) => p.isOnline);
      const isOldWaitingRoom = room.createdAt && now - room.createdAt > 30 * 60 * 1000;
      if (room.status === 'WAITING' && !hasOnlinePlayers && isOldWaitingRoom) {
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
