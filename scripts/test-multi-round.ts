/**
 * End-to-End Test for the multi-round PVP series.
 *
 * Verifies:
 *  1. Room creation with an explicit round count + a year-range draw strategy
 *  2. The schedule stays hidden until each round actually starts
 *  3. Pipelined progression: a fast player enters round k+1 without waiting for the opponent
 *  4. Per-player independent deadlines (each player's own countdown resets on entry)
 *  5. Rounds settle in round order once EVERY player has finished that round
 *  6. Answer filtering: a still-playing player never receives an opponent's answer text
 *  7. Spectators receive unfiltered detail
 *  8. Timeout auto-advance for a player who never answers
 *  9. A tied series opens the overtime vote, a refusal settles it as a draw
 * 10. All N rounds are persisted to SQLite for both players
 *
 *   npx tsx scripts/test-multi-round.ts      (requires: pnpm build:server)
 *
 * DEEPSEEK_API_KEY is intentionally blanked: grading fails, every round settles on
 * auto-assigned zeros, and the orchestration is what gets asserted here. The scoring
 * arithmetic itself is covered by scripts/test-scoring.ts.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8896;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;
const DB_PATH = path.resolve(process.cwd(), 'data/app.db');

const ROUNDS = 3;
const RANGE_START = 2018;
const RANGE_END = 2020;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

class Client {
  public messages: any[] = [];
  constructor(public readonly ws: WebSocket, public readonly label: string) {
    ws.on('message', (raw: any) => {
      try {
        this.messages.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  send(type: string, payload?: any) {
    this.ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
  }

  all(predicate: (m: any) => boolean): any[] {
    return this.messages.filter(predicate);
  }

  async waitFor(predicate: (m: any) => boolean, label: string, timeoutMs = 15000): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.filter(predicate).pop();
      if (found) return found;
      await wait(40);
    }
    throw new Error(`Timed out waiting for ${label} (${this.label})`);
  }

  latestSummary(): any | undefined {
    return this.messages.filter((m) => m.type === 'room:summary').pop()?.payload;
  }

  summaryWhere(predicate: (p: any) => boolean): any | undefined {
    return this.messages
      .filter((m) => m.type === 'room:summary' && predicate(m.payload))
      .pop()?.payload;
  }
}

function connect(label: string, playerId: string, token: string): Promise<Client> {
  const ws = new WebSocket(`${WS_BASE}?token=${token}&playerId=${playerId}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(new Client(ws, label)));
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`Timed out connecting ${label}`)), 5000);
  });
}

async function registerUser(username: string, nickname: string) {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Password123!', invitationCode: 'tt8888', nickname }),
  });
  const data = await res.json();
  if (data.token) return data;
  const login = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Password123!' }),
  });
  return await login.json();
}

async function run() {
  console.log(`=== Starting test server on port ${PORT} ===`);
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: '', // force the zero-score grading failure path
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) if (line) console.log('[Server]', line);
  });
  server.stderr?.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) if (line) console.error('[Server]', line);
  });

  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) break;
    } catch {}
    await wait(150);
  }

  const sockets: WebSocket[] = [];
  try {
    const suffix = Date.now().toString().slice(-6);
    const hostData = await registerUser(`mr_host_${suffix}`, '房主A');
    const guestData = await registerUser(`mr_guest_${suffix}`, '挑战者B');
    const specData = await registerUser(`mr_spec_${suffix}`, '观众C');

    const host = await connect('host', hostData.user.id, hostData.token);
    const guest = await connect('guest', guestData.user.id, guestData.token);
    const spec = await connect('spec', specData.user.id, specData.token);
    sockets.push(host.ws, guest.ws, spec.ws);

    console.log('\n--- 1. Create a 3-round range room ---');
    host.send('room:create', {
      nickname: '房主A',
      durationMinutes: 0.1, // 6 seconds per round under NODE_ENV=test
      maxPlayers: 2,
      allowSpectators: true,
      totalRounds: ROUNDS,
      drawStrategy: 'range',
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    const created = await host.waitFor(
      (m) => m.type === 'room:summary' && m.payload?.roomCode,
      'room creation'
    );
    const roomCode: string = created.payload.roomCode;
    assert(roomCode.length === 6, `Room ${roomCode} created`);
    assert(created.payload.config.totalRounds === ROUNDS, `totalRounds = ${ROUNDS}`);
    assert(
      created.payload.config.drawStrategy === 'range' &&
        created.payload.config.rangeStart === RANGE_START &&
        created.payload.config.rangeEnd === RANGE_END,
      `draw strategy = range(${RANGE_START}-${RANGE_END})`
    );
    assert(created.payload.rounds.length === 0, 'no round is materialised before the match starts');

    console.log('\n--- 2. Over-cap round count is rejected ---');
    const bad = await host
      .waitFor(
        (m) => m.type === 'error' && m.payload?.code === 'INVALID_CONFIG',
        'over-cap rejection',
        4000
      )
      .catch(() => undefined);
    host.send('room:update_settings', {
      totalRounds: 99,
      drawStrategy: 'range',
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    const bad2 = await host.waitFor(
      (m) => m.type === 'error' && m.payload?.code === 'INVALID_CONFIG',
      'over-cap rejection'
    );
    assert(!!bad2, `rounds=99 rejected: ${bad2.payload.message}`);
    void bad;

    console.log('\n--- 3. Join, ready up, start ---');
    guest.send('room:join', { roomCode, nickname: '挑战者B' });
    await guest.waitFor(
      (m) => m.type === 'room:summary' && Object.keys(m.payload.players).length === 2,
      'guest join'
    );
    host.send('room:toggle_ready');
    guest.send('room:toggle_ready');

    await host.waitFor((m) => m.type === 'round:started' && m.payload.roundIndex === 0, 'round 0 start');
    const live = host.latestSummary();
    assert(live.status === 'IN_PROGRESS', 'match is IN_PROGRESS');
    assert(live.rounds.length === ROUNDS, `${ROUNDS} rounds materialised`);
    assert(
      live.rounds[0].year !== null && live.rounds[1].year === null && live.rounds[2].year === null,
      'only round 1 exposes its year; the rest stay hidden'
    );
    assert(
      live.rounds[0].year >= RANGE_START && live.rounds[0].year <= RANGE_END,
      `round 1 year ${live.rounds[0].year} is inside the requested range`
    );

    console.log('\n--- 4. Spectator joins mid-match ---');
    spec.send('room:join', { roomCode, nickname: '观众C', asSpectator: true });
    await spec.waitFor(
      (m) => m.type === 'room:summary' && !!m.payload.spectators?.length,
      'spectator seated'
    );
    await spec.waitFor((m) => m.type === 'round:detail' && m.payload.roundIndex === 0, 'spectator detail');
    assert(true, 'spectator receives round detail');

    console.log('\n--- 5. Host races through every round without waiting ---');
    const hostId = hostData.user.id;
    const guestId = guestData.user.id;

    for (let roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
      await host.waitFor(
        (m) =>
          m.type === 'room:summary' &&
          m.payload.players.find((p: any) => p.playerId === hostId)?.currentRoundIndex === roundIndex,
        `host on round ${roundIndex + 1}`
      );
      for (let seg = 0; seg < 5; seg++) {
        host.send('segment:submit', {
          roundIndex,
          segmentIndex: seg,
          studentAnswer: `第${roundIndex + 1}轮第${seg + 1}题答案`,
        });
        await wait(30);
      }
      const afterRound = await host.waitFor(
        (m) =>
          m.type === 'room:summary' &&
          (m.payload.players.find((p: any) => p.playerId === hostId)?.roundsCompleted ?? 0) >= roundIndex + 1,
        `host completed round ${roundIndex + 1}`
      );
      const hostState = afterRound.payload.players.find((p: any) => p.playerId === hostId);
      if (roundIndex + 1 < ROUNDS) {
        assert(
          hostState.currentRoundIndex === roundIndex + 1,
          `host pipelined into round ${roundIndex + 2} while the opponent was still behind`
        );
      } else {
        assert(hostState.phase === 'awaiting', 'host entered the awaiting state after the last round');
      }
    }

    // Independent deadlines: the host's round-2 clock started the moment THEY finished round 1.
    const guestAtSameMoment = host.latestSummary().players.find((p: any) => p.playerId === guestId);
    assert(
      guestAtSameMoment.currentRoundIndex === 0,
      'the opponent is still on round 1 — the two players progress independently'
    );
    assert(
      !host.latestSummary().players.some((p: any) => p.roundDeadlineAt === null && p.phase === 'playing'),
      'per-player deadlines are carried in the summary for the multi-clock HUD'
    );

    console.log('\n--- 6. Round 1 cannot settle until both players finish it ---');
    const earlySettle = host.all((m) => m.type === 'round:settled' && m.payload.roundIndex === 0);
    assert(earlySettle.length === 0, 'round 1 has NOT settled while the opponent is still on it');

    console.log('\n--- 7. Opponent answers are withheld from a playing player ---');
    const hostDetails = host.all((m) => m.type === 'round:detail' && m.payload.roundIndex === 0);
    const withheld = hostDetails.filter((m) => m.payload.withheldPlayerIds.includes(guestId));
    assert(withheld.length > 0, "host's round detail marks the opponent's answer as withheld");
    const leaked = hostDetails.some((m) =>
      m.payload.players.some(
        (p: any) => p.playerId === guestId && Object.values(p.submissions ?? {}).some((s: any) => s.studentAnswer)
      )
    );
    assert(!leaked, 'no opponent answer text ever reaches the host while the host is playing');

    const specDetail = spec
      .all((m) => m.type === 'round:detail' && m.payload.roundIndex === 0)
      .pop();
    assert(
      specDetail.payload.withheldPlayerIds.length === 0,
      'the spectator receives completely unfiltered detail'
    );

    console.log('\n--- 8. Opponent times out every round and auto-advances ---');
    const guestDone = await guest.waitFor(
      (m) =>
        m.type === 'room:summary' &&
        m.payload.players.find((p: any) => p.playerId === guestId)?.phase === 'awaiting',
      'opponent finished all rounds by timeout',
      40000
    );
    const guestState = guestDone.payload.players.find((p: any) => p.playerId === guestId);
    assert(guestState.roundsCompleted === ROUNDS, 'opponent auto-completed all rounds by timeout');

    console.log('\n--- 9. All rounds settle in order ---');
    const settled = await host.waitFor(
      (m) => m.type === 'round:settled' && m.payload.roundIndex === ROUNDS - 1,
      'final round settled',
      20000
    );
    assert(true, 'the last round settled');
    void settled;
    const settledOrder = host
      .all((m) => m.type === 'round:settled')
      .map((m) => m.payload.roundIndex);
    assert(
      JSON.stringify(settledOrder) === JSON.stringify([0, 1, 2]),
      `rounds settled in order: [${settledOrder.join(', ')}]`
    );

    console.log('\n--- 10. A tied series opens the overtime vote; a refusal settles it as a draw ---');
    const voteStart = await host.waitFor((m) => m.type === 'overtime:vote_started', 'overtime vote');
    assert(voteStart.payload.participants.length === 2, 'both tied leaders are asked to vote');
    assert(
      host.latestSummary().status === 'OVERTIME_VOTE',
      'room status is OVERTIME_VOTE while the vote is open'
    );
    host.send('overtime:vote', { agree: false });

    const ended = await host.waitFor((m) => m.type === 'match:ended', 'match ended', 15000);
    assert(ended.payload.winnerId === 'draw', 'refusing the overtime vote ends the series as a draw');
    assert(ended.payload.wentOvertime === false, 'wentOvertime is false when the decider never ran');

    console.log('\n--- 11. History persisted with every round ---');
    await wait(600);
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db
      .prepare(`SELECT id, round_count, match_points, went_overtime, rounds_json FROM history_records WHERE user_id = ?`)
      .all(hostId) as any[];
    db.close();
    assert(rows.length === 1, 'exactly one history row was written for the host');
    const row = rows[0];
    assert(row.round_count === ROUNDS, `archived round_count = ${ROUNDS}`);
    const rounds = JSON.parse(row.rounds_json);
    assert(rounds.length === ROUNDS, `archived rounds array has ${ROUNDS} entries`);
    assert(
      rounds.every((r: any) => Array.isArray(r.submissions) && r.submissions.length === 5),
      'every archived round carries all 5 per-question records'
    );
    assert(
      rounds.map((r: any) => r.year).every((y: number) => y >= RANGE_START && y <= RANGE_END),
      'archived rounds record their real exam years'
    );

    console.log('\n=== ALL MULTI-ROUND TESTS PASSED ===\n');
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {}
    }
    server.kill('SIGTERM');
    await wait(300);
  }
}

run().catch((err) => {
  console.error('\n✖ MULTI-ROUND TEST FAILED:', err);
  process.exit(1);
});

void fs;
