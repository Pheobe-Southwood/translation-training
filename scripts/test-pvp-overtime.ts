/**
 * End-to-End Test for the overtime decider.
 *
 * Scenario (N = 1, DEEPSEEK_API_KEY blank so both players finish on zeros):
 *  1. Both players are tied on 大比分 (0) and 累计小分 (0) → the vote opens
 *  2. Both agree → a fresh overtime round is drawn
 *  3. The overtime round is a flat +1.0 decider: with the small scores still tied it
 *     falls through to "who finished the overtime round faster"
 *  4. The faster player takes the series outright, and `wentOvertime` is archived
 *
 *   npx tsx scripts/test-pvp-overtime.ts      (requires: pnpm build:server)
 */
import { spawn } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8897;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;
const DB_PATH = path.resolve(process.cwd(), 'data/app.db');

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
      } catch {}
    });
  }
  send(type: string, payload?: any) {
    this.ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
  }
  all(pred: (m: any) => boolean) {
    return this.messages.filter(pred);
  }
  async waitFor(pred: (m: any) => boolean, label: string, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.filter(pred).pop();
      if (found) return found;
      await wait(40);
    }
    throw new Error(`Timed out waiting for ${label} (${this.label})`);
  }
  latestSummary() {
    return this.messages.filter((m) => m.type === 'room:summary').pop()?.payload;
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
      DEEPSEEK_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line && !line.includes('at ')) console.log('[Server]', line);
    }
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
    const fastData = await registerUser(`ot_fast_${suffix}`, '快手A');
    const slowData = await registerUser(`ot_slow_${suffix}`, '慢手B');
    const fastId = fastData.user.id;
    const slowId = slowData.user.id;

    const fast = await connect('fast', fastId, fastData.token);
    const slow = await connect('slow', slowId, slowData.token);
    sockets.push(fast.ws, slow.ws);

    console.log('\n--- 1. Create a single-round room and start ---');
    fast.send('room:create', {
      nickname: '快手A',
      durationMinutes: 0.1, // 6 s
      maxPlayers: 2,
      allowSpectators: true,
      totalRounds: 1,
      drawStrategy: 'custom',
      customYears: [2024],
    });
    const created = await fast.waitFor((m) => m.type === 'room:summary' && m.payload?.roomCode, 'room created');
    const roomCode = created.payload.roomCode;
    assert(created.payload.config.totalRounds === 1, 'single-round series created');
    assert(created.payload.config.customYears?.[0] === 2024, 'custom pick honours the chosen year');

    slow.send('room:join', { roomCode, nickname: '慢手B' });
    await slow.waitFor((m) => m.type === 'room:summary' && Object.keys(m.payload.players).length === 2, 'join');
    fast.send('room:toggle_ready');
    slow.send('room:toggle_ready');
    await fast.waitFor((m) => m.type === 'round:started' && m.payload.roundIndex === 0, 'round start');
    const detail = await fast.waitFor((m) => m.type === 'round:detail' && m.payload.roundIndex === 0, 'detail');
    assert(detail.payload.year === 2024, 'round 1 paper is the custom-picked 2024 exam');

    console.log('\n--- 2. A answers fast, B never answers ---');
    for (let seg = 0; seg < 5; seg++) {
      fast.send('segment:submit', { roundIndex: 0, segmentIndex: seg, studentAnswer: `快答${seg + 1}` });
      await wait(30);
    }
    await fast.waitFor(
      (m) => m.type === 'room:summary' && m.payload.players.find((p: any) => p.playerId === fastId)?.phase === 'awaiting',
      'A awaiting'
    );
    assert(true, 'A finished round 1 immediately and entered the awaiting state');

    console.log('\n--- 3. B times out; the round settles level, opening the vote ---');
    const voteStart = await slow.waitFor((m) => m.type === 'overtime:vote_started', 'overtime vote', 20000);
    assert(voteStart.payload.participants.length === 2, 'both players are tied leaders');
    assert(
      fast.latestSummary().status === 'OVERTIME_VOTE',
      'status is OVERTIME_VOTE while the players decide'
    );

    console.log('\n--- 4. Both agree → a fresh overtime paper is drawn ---');
    fast.send('overtime:vote', { agree: true });
    slow.send('overtime:vote', { agree: true });
    const resolved = await fast.waitFor((m) => m.type === 'overtime:resolved' && m.payload.agreed, 'overtime agreed');
    assert(resolved.payload.roundIndex === 1, 'the decider is round index 1 (one past the schedule)');
    assert(
      typeof resolved.payload.year === 'number' && resolved.payload.year >= 2002 && resolved.payload.year <= 2026,
      `overtime paper drawn: ${resolved.payload.year}`
    );

    await fast.waitFor(
      (m) => m.type === 'round:started' && m.payload.roundIndex === 1 && m.payload.isOvertime,
      'overtime round started'
    );
    const otDetail = await fast.waitFor((m) => m.type === 'round:detail' && m.payload.roundIndex === 1, 'overtime detail');
    assert(otDetail.payload.isOvertime === true, 'the decider is flagged isOvertime');
    assert(
      otDetail.payload.players.length === 2,
      'only the tied leaders are seated in the decider'
    );

    console.log('\n--- 5. A finishes the decider fast; B times out again ---');
    for (let seg = 0; seg < 5; seg++) {
      fast.send('segment:submit', { roundIndex: 1, segmentIndex: seg, studentAnswer: `决胜${seg + 1}` });
      await wait(30);
    }
    const ended = await fast.waitFor((m) => m.type === 'match:ended', 'match ended', 20000);
    assert(ended.payload.wentOvertime === true, 'the series is flagged as having gone to overtime');
    assert(ended.payload.winnerId === fastId, 'the faster player wins the decider outright');

    const rankings = ended.payload.rankings;
    const fastRank = rankings.find((r: any) => r.playerId === fastId);
    const slowRank = rankings.find((r: any) => r.playerId === slowId);
    assert(fastRank.rank === 1 && slowRank.rank === 2, 'final ranking places the decider winner first');
    assert(
      fastRank.matchPoints === 1 && slowRank.matchPoints === 0,
      `the decider awards exactly +1.0 (no final-round doubling): ${fastRank.matchPoints} vs ${slowRank.matchPoints}`
    );

    console.log('\n--- 6. Overtime is archived ---');
    await wait(600);
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db
      .prepare(`SELECT round_count, went_overtime, match_points, rounds_json FROM history_records WHERE user_id = ?`)
      .get(fastId) as any;
    db.close();
    assert(row.round_count === 1, 'round_count archives the scheduled rounds (1), not the decider');
    assert(row.went_overtime === 1, 'went_overtime = 1');
    assert(row.match_points === 1, 'archived final match points = 1.0');
    const rounds = JSON.parse(row.rounds_json);
    assert(rounds.length === 2, 'both the scheduled round and the decider are archived');
    assert(
      rounds[1].isOvertime === true && rounds[1].submissions.length === 5,
      'the decider round is archived with its 5 per-question records'
    );

    console.log('\n=== ALL OVERTIME TESTS PASSED ===\n');
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
  console.error('\n✖ OVERTIME TEST FAILED:', err);
  process.exit(1);
});
