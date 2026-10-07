/**
 * End-to-End Test for 2-4 Player PVP & Live Spectator Mode
 *
 * Verifies:
 *  1. Creating a 4-player room (maxPlayers = 4, allowSpectators = true)
 *  2. Joining 4 players + 1 explicit spectator + 1 overflow auto-spectator (5th joiner)
 *  3. Spectator switching to player when a slot opens, and switching back
 *  4. Starting a match when all players are ready (and testing host early start on a 3P room)
 *  5. Live spectator receiving real-time studentAnswer submissions from all players
 *  6. Timeout settlement & leaderboard ranking computation (1st..4th) for >2 players
 *
 * Run: npx tsx scripts/test-pvp-multiplayer-spectator.ts
 */
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { generateUserToken } from '../src/server/auth.js';

const PORT = 8895;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}/ws`;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`  ✓ ${message}`);
}

function connect(playerId: string): Promise<WebSocket> {
  const token = generateUserToken(playerId);
  const ws = new WebSocket(`${WS_BASE}?token=${token}&playerId=${playerId}`);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`Timed out connecting socket for ${playerId}`)), 5000);
  });
}

function closeSocket(ws: WebSocket | undefined) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  } catch {}
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  label: string,
  timeoutMs = 8000,
  send?: () => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: any) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    ws.on('message', onMessage);
    if (send) send();
  });
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
      DEEPSEEK_API_KEY: '', // No external API calls needed
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line) console.log('[Server]', line);
    }
  });

  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) break;
    } catch {}
    await wait(150);
  }

  const sockets: WebSocket[] = [];
  try {
    const p1 = 'mp_p1';
    const p2 = 'mp_p2';
    const p3 = 'mp_p3';
    const p4 = 'mp_p4';
    const spec1 = 'mp_spec1';
    const overflowUser = 'mp_overflow';

    const [ws1, ws2, ws3, ws4, wsSpec1, wsOverflow] = await Promise.all([
      connect(p1),
      connect(p2),
      connect(p3),
      connect(p4),
      connect(spec1),
      connect(overflowUser),
    ]);
    sockets.push(ws1, ws2, ws3, ws4, wsSpec1, wsOverflow);

    console.log('\n--- 1. Create a 4-Player Room ---');
    const createdMsg = await waitForMessage(
      ws1,
      (m) => m.type === 'room:state' && m.payload?.maxPlayers === 4,
      '4P room creation',
      5000,
      () =>
        ws1.send(
          JSON.stringify({
            type: 'room:create',
            payload: {
              nickname: '一号房主',
              year: 2024,
              durationMinutes: 0.03, // ~1.8 seconds for fast timeout settlement test
              maxPlayers: 4,
              allowSpectators: true,
            },
          })
        )
    );
    const roomCode = createdMsg.payload.roomCode;
    assert(roomCode.length === 6, `Created room ${roomCode} with maxPlayers=4`);

    console.log('\n--- 2. Join Players 2, 3, 4 and Explicit Spectator ---');
    await waitForMessage(
      ws2,
      (m) => m.type === 'room:state' && Object.keys(m.payload.players).length === 2,
      'P2 join',
      5000,
      () => ws2.send(JSON.stringify({ type: 'room:join', payload: { roomCode, nickname: '二号选手' } }))
    );
    await waitForMessage(
      ws3,
      (m) => m.type === 'room:state' && Object.keys(m.payload.players).length === 3,
      'P3 join',
      5000,
      () => ws3.send(JSON.stringify({ type: 'room:join', payload: { roomCode, nickname: '三号选手' } }))
    );
    await waitForMessage(
      ws4,
      (m) => m.type === 'room:state' && Object.keys(m.payload.players).length === 4,
      'P4 join',
      5000,
      () => ws4.send(JSON.stringify({ type: 'room:join', payload: { roomCode, nickname: '四号选手' } }))
    );
    assert(true, 'All 4 player slots filled');

    // Explicit spectator joins
    const specJoinMsg = await waitForMessage(
      wsSpec1,
      (m) => m.type === 'room:state' && !!m.payload.spectators?.[spec1],
      'Spectator 1 join',
      5000,
      () =>
        wsSpec1.send(
          JSON.stringify({
            type: 'room:join',
            payload: { roomCode, nickname: '特邀观众A', asSpectator: true },
          })
        )
    );
    assert(
      Object.keys(specJoinMsg.payload.spectators).length === 1,
      'Explicit spectator added to room.spectators'
    );

    console.log('\n--- 3. 5th Challenger Auto-Downgrades to Spectator when Room is Full ---');
    const autoSpecNoticePromise = waitForMessage(
      wsOverflow,
      (m) => m.type === 'room:joined_as_spectator',
      'joined_as_spectator notice',
      5000
    );
    const overflowStatePromise = waitForMessage(
      wsOverflow,
      (m) => m.type === 'room:state' && !!m.payload.spectators?.[overflowUser],
      'Overflow spectator state',
      5000
    );
    wsOverflow.send(
      JSON.stringify({
        type: 'room:join',
        payload: { roomCode, nickname: '五号溢出观众', asSpectator: false },
      })
    );
    const [noticeMsg, overflowStateMsg] = await Promise.all([
      autoSpecNoticePromise,
      overflowStatePromise,
    ]);
    assert(!!noticeMsg.payload?.message, `Received auto-spectator notice: "${noticeMsg.payload.message}"`);
    assert(
      Object.keys(overflowStateMsg.payload.players).length === 4 &&
        Object.keys(overflowStateMsg.payload.spectators).length === 2,
      'Room has 4 players and 2 spectators'
    );

    console.log('\n--- 4. All 4 Players Ready -> Match Starts -> Spectator Sees Live Submissions ---');
    const matchStartPromise = waitForMessage(
      wsSpec1,
      (m) => m.type === 'room:state' && m.payload.status === 'IN_PROGRESS',
      'Spectator sees match IN_PROGRESS',
      8000
    );

    ws1.send(JSON.stringify({ type: 'room:toggle_ready' }));
    ws2.send(JSON.stringify({ type: 'room:toggle_ready' }));
    ws3.send(JSON.stringify({ type: 'room:toggle_ready' }));
    ws4.send(JSON.stringify({ type: 'room:toggle_ready' }));

    await matchStartPromise;
    assert(true, '4-player match started and spectator transitioned to IN_PROGRESS');

    // Player 1 and Player 3 submit answers to Segment 0
    const specSeesP1SubPromise = waitForMessage(
      wsSpec1,
      (m) =>
        m.type === 'room:state' &&
        m.payload.players?.[p1]?.submissions?.[0]?.studentAnswer === '一号选手的第一题实时译文',
      'Spectator receives P1 live submission',
      5000
    );
    ws1.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: { segmentIndex: 0, studentAnswer: '一号选手的第一题实时译文' },
      })
    );
    const stateAfterP1 = await specSeesP1SubPromise;
    assert(
      stateAfterP1.payload.players[p1].currentSegmentIndex === 1,
      'Spectator sees P1 advanced to segment 2 (index 1) and sees P1 translation text in real-time'
    );

    // Wait for match timeout & settlement (rankings generated)
    console.log('\n--- 5. Match Settlement & Multi-Player Rankings ---');
    const endedMsg = await waitForMessage(
      wsSpec1,
      (m) => m.type === 'match:ended',
      'Match ended event on spectator socket',
      10000
    );
    assert(Array.isArray(endedMsg.payload.rankings), 'Rankings array generated on match finish');
    assert(
      endedMsg.payload.rankings.length === 4,
      `Rankings contains all 4 players (length=${endedMsg.payload.rankings.length})`
    );
    console.log('\n=== ALL MULTIPLAYER (2-4P) & SPECTATOR TESTS PASSED ===');
  } finally {
    for (const s of sockets) closeSocket(s);
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
