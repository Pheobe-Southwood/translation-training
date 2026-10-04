/**
 * Regression test for the PVP incident in room Q7JZPT (2026-10-04):
 *
 *   A player's websocket died ~68s into the match. The client kept "sending"
 *   submissions into the dead socket, the server never received a single answer,
 *   and the UI stayed frozen on 第 1 题 forever.
 *
 * This script reproduces the server-side failure conditions that made recovery
 * impossible, and asserts the fixes:
 *
 *   T1  a submission advances the authoritative currentSegmentIndex (and is logged)
 *   T2  a late close from a REPLACED socket must not unregister the live socket
 *   T3  reconnecting preserves progress (index + submissions)
 *   T4  an existing participant may re-join an IN_PROGRESS room (refresh recovery)
 *   T5  duplicate submits are idempotent (no overwrite, no re-grading, no index jump)
 *   T6  invalid segment indices are rejected with an explicit error code
 *   T7  reconnecting to a vanished room returns a terminal ROOM_NOT_FOUND error
 *
 * No DeepSeek calls are triggered: a paired grading only starts once BOTH players
 * submit the same segment, and these tests only ever submit from one side.
 *
 * Run: npx tsx scripts/test-pvp-reconnect-submit.ts
 */
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { generateUserToken } from '../src/server/auth.js';

const PORT = 8893;
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

/** Register a listener first, then run `send`, so no fast reply can be missed. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  label: string,
  timeoutMs = 6000,
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

const isRoomState = (msg: any) => msg?.type === 'room:state';

async function run() {
  console.log(`=== Starting test server on port ${PORT} ===`);
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const serverLog: string[] = [];
  server.stdout?.on('data', (d) => {
    const line = d.toString().trim();
    serverLog.push(line);
    console.log('[Server stdout]', line);
  });
  server.stderr?.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  let hostWs: WebSocket | undefined;
  let hostWs2: WebSocket | undefined;
  let guestWs: WebSocket | undefined;
  let guestWs2: WebSocket | undefined;

  try {
    let ready = false;
    for (let i = 0; i < 25; i++) {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await wait(200);
    }
    if (!ready) throw new Error('Server failed to start in time');
    console.log('Server is healthy\n');

    const hostId = `t_host_${Date.now().toString().slice(-6)}`;
    const guestId = `t_guest_${Date.now().toString().slice(-6)}`;

    // --- Setup: create room, join, ready up, start match -------------------
    console.log('--- Setup: room + match start ---');
    hostWs = await connect(hostId);
    const createReply = await waitForMessage(
      hostWs,
      (m) => isRoomState(m) && !!m.payload?.roomCode,
      'room creation',
      6000,
      () =>
        hostWs!.send(
          JSON.stringify({ type: 'room:create', payload: { nickname: '房主测试', year: 2024, durationMinutes: 1 } })
        )
    );
    const roomCode: string = createReply.payload.roomCode;
    console.log(`Room code: ${roomCode}`);

    guestWs = await connect(guestId);
    await waitForMessage(
      guestWs,
      (m) => isRoomState(m) && !!m.payload?.players?.[guestId],
      'guest join',
      6000,
      () =>
        guestWs!.send(JSON.stringify({ type: 'room:join', payload: { roomCode, nickname: '挑战者测试' } }))
    );

    await waitForMessage(
      guestWs,
      (m) => isRoomState(m) && m.payload?.status === 'IN_PROGRESS',
      'match start',
      12000,
      () => {
        hostWs!.send(JSON.stringify({ type: 'room:toggle_ready' }));
        guestWs!.send(JSON.stringify({ type: 'room:toggle_ready' }));
      }
    );
    console.log('Match started (IN_PROGRESS)\n');

    // --- T1: submit advances the authoritative index -----------------------
    console.log('--- T1: submit advances currentSegmentIndex ---');
    const t1 = await waitForMessage(
      guestWs,
      (m) => isRoomState(m) && m.payload?.players?.[guestId]?.submissions?.[0]?.studentAnswer === '第一题答案',
      'segment 1 accepted',
      6000,
      () =>
        guestWs!.send(
          JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 0, studentAnswer: '第一题答案' } })
        )
    );
    assert(t1.payload.players[guestId].currentSegmentIndex === 1, 'currentSegmentIndex advanced 0 -> 1');
    assert(t1.payload.players[guestId].submissions[0].gradingStatus === 'waiting_pair', 'submission stored as waiting_pair');
    assert(
      serverLog.some((l) => l.includes('Segment 1 submitted by') && l.includes(roomCode)),
      'server logged the accepted submission (diagnosability for future incidents)'
    );

    // --- T5: duplicate submit is idempotent --------------------------------
    console.log('\n--- T5: duplicate submit is idempotent ---');
    const firstSubmittedAt = t1.payload.players[guestId].submissions[0].submittedAt;
    const t5 = await waitForMessage(
      guestWs,
      (m) => isRoomState(m) && m.payload?.players?.[guestId]?.submissions?.[0]?.studentAnswer === '第一题答案',
      'duplicate submit echo',
      6000,
      () =>
        guestWs!.send(
          JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 0, studentAnswer: '篡改后的答案' } })
        )
    );
    assert(t5.payload.players[guestId].submissions[0].studentAnswer === '第一题答案', 'original answer was NOT overwritten');
    assert(
      t5.payload.players[guestId].submissions[0].submittedAt === firstSubmittedAt,
      'submittedAt unchanged (no re-grade triggered)'
    );
    assert(t5.payload.players[guestId].currentSegmentIndex === 1, 'index did not jump on duplicate submit');

    // --- T2: stale socket close must not unregister the live socket --------
    console.log('\n--- T2: late close from a replaced socket is ignored ---');
    hostWs2 = await connect(hostId);
    await wait(
      300
    ); // let the server register the replacement socket (it also auto-broadcasts state)
    closeSocket(hostWs);
    hostWs = undefined;
    await wait(500); // give the server time to process the stale close event
    const t2 = await waitForMessage(
      hostWs2,
      (m) => isRoomState(m) && !!m.payload?.players?.[guestId]?.submissions?.[1],
      'broadcast on the replacement socket',
      6000,
      () =>
        guestWs!.send(
          JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 1, studentAnswer: '第二题答案' } })
        )
    );
    assert(
      t2.payload.players[guestId].currentSegmentIndex === 2,
      'replacement socket still receives authoritative broadcasts after the old socket closed'
    );
    assert(
      serverLog.some((l) => l.includes('Ignoring close event from stale socket')),
      'server ignored the stale close event'
    );

    // --- T3: reconnect preserves progress ---------------------------------
    console.log('\n--- T3: reconnect preserves progress ---');
    guestWs2 = await connect(guestId);
    const t3 = await waitForMessage(
      guestWs2,
      (m) => isRoomState(m) && !!m.payload?.players?.[guestId],
      'reconnect state',
      6000
    );
    const recovered = t3.payload.players[guestId];
    assert(recovered.currentSegmentIndex === 2, 'currentSegmentIndex preserved (2) on reconnect');
    assert(recovered.submissions[0]?.studentAnswer === '第一题答案', 'segment 1 answer preserved on reconnect');
    assert(recovered.submissions[1]?.studentAnswer === '第二题答案', 'segment 2 answer preserved on reconnect');

    // --- T4: existing participant may re-join an IN_PROGRESS room ---------
    console.log('\n--- T4: re-join IN_PROGRESS room as existing participant ---');
    const t4 = await waitForMessage(
      guestWs2,
      (m) => isRoomState(m) && !!m.payload?.players?.[guestId],
      'room:join during IN_PROGRESS',
      6000,
      () => guestWs2!.send(JSON.stringify({ type: 'room:join', payload: { roomCode, nickname: '挑战者测试' } }))
    );
    assert(t4.payload.status === 'IN_PROGRESS', 're-join accepted while match is running');
    assert(t4.payload.players[guestId].currentSegmentIndex === 2, 're-join did not reset progress');

    // --- T6: invalid segment index is rejected -----------------------------
    console.log('\n--- T6: invalid segment index rejected ---');
    const t6 = await waitForMessage(
      guestWs2,
      (m) => m?.type === 'error' && m.payload?.code === 'INVALID_SEGMENT',
      'INVALID_SEGMENT error',
      6000,
      () => guestWs2!.send(JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 99, studentAnswer: 'x' } }))
    );
    assert(t6.payload.code === 'INVALID_SEGMENT', 'out-of-range index rejected with explicit error code');

    // --- T7: reconnecting to a vanished room is terminal -------------------
    console.log('\n--- T7: vanished room returns ROOM_NOT_FOUND ---');
    const strangerWs = await connect(`t_stranger_${Date.now().toString().slice(-6)}`);
    const t7 = await waitForMessage(
      strangerWs,
      (m) => m?.type === 'error' && m.payload?.code === 'ROOM_NOT_FOUND',
      'ROOM_NOT_FOUND error',
      6000,
      () => strangerWs.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: 'ZZZZZZ' } }))
    );
    assert(t7.payload.code === 'ROOM_NOT_FOUND', 'room:reconnect to a missing room returns a terminal error');
    closeSocket(strangerWs);

    // --- Cleanup: leave the room so the server drops it and its timers -----
    console.log('\n--- Cleanup: leaving the room ---');
    try {
      guestWs2.send(JSON.stringify({ type: 'room:leave' }));
      hostWs2.send(JSON.stringify({ type: 'room:leave' }));
      await wait(500);
    } catch {}

    console.log('\n=== PVP RECONNECT / SUBMIT REGRESSION TESTS PASSED ===');
  } finally {
    closeSocket(hostWs);
    closeSocket(hostWs2);
    closeSocket(guestWs);
    closeSocket(guestWs2);
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('\nPVP regression test FAILED:', err);
  process.exit(1);
});
