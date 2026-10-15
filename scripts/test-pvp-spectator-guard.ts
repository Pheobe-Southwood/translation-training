/**
 * End-to-End Regression Test: Spectator Isolation & Room Binding
 *
 * Covers the production bugs reported after the 10-14 match:
 *  - "观战者进出房间导致答题者回到第一题" (stale room state hijacking a live socket)
 *  - "观战导致选手无法正常准备" (host reconnect never re-binding its room)
 *  - "无法正常观战 / 观战必须登录" (spectate links required an account)
 *
 * Verifies:
 *  1. Joining a new room releases the seat held in an abandoned room, and the
 *     abandoned room can no longer push state into the live socket.
 *  2. A host that reconnects mid-lobby re-binds the right room and can ready up.
 *  3. A shareable spectate ticket lets an anonymous viewer watch the room,
 *     appears only in the spectator gallery, and is rejected for every player
 *     action (spectating cannot affect the match).
 *  4. Spectators joining/leaving/reconnecting never change players' segment
 *     index, readiness, or submissions.
 *  5. Invalid/expired tickets, spectating-disabled rooms and missing rooms fail
 *     with distinct terminal close codes (4003/4004/4005).
 *  6. Two sockets for the same account coexist; closing one does not mark the
 *     player offline or stop delivery to the other.
 *  7. A token may not be paired with somebody else's playerId (close 4002).
 *  8. A player inside a running match cannot join a second match.
 *
 * Run: npx tsx scripts/test-pvp-spectator-guard.ts
 */
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { generateUserToken, generateSpectateTicket } from '../src/server/auth.js';

const PORT = 8896;
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

function connectSpectator(ticket: string, spectatorId: string, nickname: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `${WS_BASE}?ticket=${encodeURIComponent(ticket)}&playerId=${spectatorId}&nickname=${encodeURIComponent(nickname)}`
  );
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`Timed out connecting spectator ${spectatorId}`)), 5000);
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

/** Wait for a terminal close and resolve with its code. */
function waitForClose(ws: WebSocket, label: string, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for close: ${label}`)), timeoutMs);
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function roomStates(ws: WebSocket, sink: string[]) {
  ws.on('message', (raw: any) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'room:state' && msg.payload?.roomCode) sink.push(msg.payload.roomCode);
    } catch {}
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
      DEEPSEEK_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line) console.log('[Server]', line);
    }
  });

  let ready = false;
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await wait(150);
  }
  if (!ready) throw new Error('Test server failed to start');

  const sockets: WebSocket[] = [];
  try {
    const p1 = 'sg_p1';
    const p2 = 'sg_p2';
    const p3 = 'sg_p3';

    console.log('\n--- 1. Stale Room Isolation: leaving an abandoned lobby releases the seat ---');
    const ws1 = await connect(p1);
    sockets.push(ws1);
    const ws1RoomHistory: string[] = [];
    roomStates(ws1, ws1RoomHistory);

    const roomAState = await waitForMessage(
      ws1,
      (m) => m.type === 'room:state' && m.payload?.status === 'WAITING',
      'room A created',
      5000,
      () =>
        ws1.send(
          JSON.stringify({
            type: 'room:create',
            payload: { nickname: '隔离选手', year: 2024, durationMinutes: 0.2, maxPlayers: 2 },
          })
        )
    );
    const roomA = roomAState.payload.roomCode;
    const ticketA = roomAState.payload.spectateTicket;
    assert(typeof ticketA === 'string' && ticketA.length > 10, `Room A (${roomA}) issued a spectate ticket`);

    const ws2 = await connect(p2);
    sockets.push(ws2);
    await waitForMessage(
      ws2,
      (m) => m.type === 'room:state' && Object.keys(m.payload.players).length === 2,
      'p2 joined room A',
      5000,
      () => ws2.send(JSON.stringify({ type: 'room:join', payload: { roomCode: roomA, nickname: '二号' } }))
    );

    // Char A leaves (room A is WAITING -> detach) and opens room B.
    const roomBState = await waitForMessage(
      ws1,
      (m) => m.type === 'room:state' && m.payload?.roomCode !== roomA,
      'room B created',
      5000,
      () =>
        ws1.send(
          JSON.stringify({
            type: 'room:create',
            payload: { nickname: '隔离选手', year: 2024, durationMinutes: 0.2, maxPlayers: 2 },
          })
        )
    );
    const roomB = roomBState.payload.roomCode;
    assert(roomB !== roomA, `Player opened a second room ${roomB} while holding a seat in ${roomA}`);

    // Room A must no longer hold this player. It may have been deleted outright
    // (no players left) which is reported to the still-connected partner socket.
    const roomAAfter = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out reading room A after detach')), 5000);
      const onMsg = (raw: any) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'error' && msg.payload?.code === 'ROOM_NOT_FOUND') {
            clearTimeout(timer);
            ws2.off('message', onMsg);
            resolve({ deleted: true });
            return;
          }
          if (msg.type === 'room:state' && msg.payload?.roomCode === roomA) {
            clearTimeout(timer);
            ws2.off('message', onMsg);
            resolve(msg.payload);
          }
        } catch {}
      };
      ws2.on('message', onMsg);
      ws2.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: roomA } }));
    });
    if (roomAAfter.deleted) {
      assert(true, 'Room A was dropped once its creator left (no players left)');
    } else {
      assert(
        !roomAAfter.players[p1],
        'Room A no longer lists the departed player in its player slots'
      );
    }

    // A spectator entering the abandoned room A must not reach the player in room B.
    const staleSpec = await connectSpectator(ticketA, 'spec_stale1', '旧房观众');
    sockets.push(staleSpec);
    await waitForMessage(
      staleSpec,
      (m) => m.type === 'room:state' || m.type === 'error',
      'stale room spectator settles',
      5000
    );
    await wait(400);
    assert(
      ws1RoomHistory.every((code) => code === roomA || code === roomB),
      'Player socket only ever received states for the rooms it actually joined'
    );
    assert(
      !ws1RoomHistory.slice(ws1RoomHistory.indexOf(roomB)).includes(roomA),
      'No state from the abandoned room reached the player after switching to the new room'
    );

    console.log('\n--- 2. Host Reconnect Re-binds the Right Room and Can Ready Up ---');
    closeSocket(ws1);
    await wait(200);
    const ws1b = await connect(p1);
    sockets.push(ws1b);
    const rebindHistory: string[] = [];
    roomStates(ws1b, rebindHistory);

    const rebound = await waitForMessage(
      ws1b,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB,
      'host reconnect rebinds room B',
      5000,
      () =>
        ws1b.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: roomB } }))
    );
    assert(
      !!rebound.payload.players[p1],
      'Reconnected host is recognised as a player of the requested room'
    );

    await waitForMessage(
      ws2,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB,
      'p2 joins room B',
      5000,
      () =>
        ws2.send(JSON.stringify({ type: 'room:join', payload: { roomCode: roomB, nickname: '二号选手' } }))
    );

    const readyState = await waitForMessage(
      ws1b,
      (m) => m.type === 'room:state' && !!m.payload?.players?.[p1]?.isReady,
      'host ready toggled in the correct room',
      5000,
      () => ws1b.send(JSON.stringify({ type: 'room:toggle_ready' }))
    );
    assert(
      readyState.payload.roomCode === roomB && readyState.payload.players[p1].isReady === true,
      'Host readiness lands in room B (the room the socket is bound to)'
    );
    assert(
      rebindHistory.every((code) => code === roomB),
      'Reconnected host socket never received a foreign room state'
    );
    await ws1b.send(JSON.stringify({ type: 'room:toggle_ready' })); // reset for the next step

    console.log('\n--- 3. Anonymous Read-Only Spectator via Ticket ---');
    const wsSpec = await connectSpectator(
      roomBState.payload.spectateTicket as string,
      'spec_view1',
      '免登录观众'
    );
    sockets.push(wsSpec);
    const spectatorState = await waitForMessage(
      wsSpec,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB,
      'spectator receives room B state',
      5000
    );
    assert(
      !spectatorState.payload.players['spec_view1'],
      'Link spectator is NOT in the player slots'
    );
    assert(
      !!spectatorState.payload.spectators['spec_view1'],
      'Link spectator appears in the spectator gallery'
    );

    // Spectating is read-only: every player action is refused.
    const submitDenied = await waitForMessage(
      wsSpec,
      (m) => m.type === 'error' && m.payload?.code === 'SPECTATOR_READ_ONLY',
      'spectator submit denied',
      5000,
      () =>
        wsSpec.send(
          JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 0, studentAnswer: '偷看答案' } })
        )
    );
    assert(!!submitDenied.payload.message, 'Spectator submission is rejected by the server');
    await waitForMessage(
      wsSpec,
      (m) => m.type === 'error' && m.payload?.code === 'SPECTATOR_READ_ONLY',
      'spectator ready denied',
      5000,
      () => wsSpec.send(JSON.stringify({ type: 'room:toggle_ready' }))
    );
    await waitForMessage(
      wsSpec,
      (m) => m.type === 'error' && m.payload?.code === 'SPECTATOR_READ_ONLY',
      'spectator create denied',
      5000,
      () => wsSpec.send(JSON.stringify({ type: 'room:create', payload: { nickname: '观众建房' } }))
    );
    // Re-binding a dropped spectator socket must keep the same read-only seat.
    await waitForMessage(
      wsSpec,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB,
      'spectator reconnect re-binds the seat',
      5000,
      () => wsSpec.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: roomB } }))
    );

    console.log('\n--- 4. Starting the Match & Live Spectating Without Side Effects ---');
    const matchStart = waitForMessage(
      wsSpec,
      (m) => m.type === 'room:state' && m.payload?.status === 'IN_PROGRESS',
      'match starts with a spectator watching',
      10000
    );
    ws1b.send(JSON.stringify({ type: 'room:toggle_ready' }));
    ws2.send(JSON.stringify({ type: 'room:toggle_ready' }));
    await matchStart;
    assert(true, 'Match started normally while a link spectator was seated');

    const submissionPromise = waitForMessage(
      wsSpec,
      (m) => m.type === 'room:state' && m.payload?.players?.[p1]?.submissions?.[0]?.studentAnswer === '隔离选手的第一题译文',
      'spectator sees live submission',
      5000
    );
    ws1b.send(
      JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 0, studentAnswer: '隔离选手的第一题译文' } })
    );
    const afterP1Submit = await submissionPromise;
    assert(
      afterP1Submit.payload.players[p1].currentSegmentIndex === 1,
      'Spectator sees the player advance to segment 2 in real time'
    );
    assert(
      Object.keys(afterP1Submit.payload.players).length === 2 &&
        !afterP1Submit.payload.players['spec_view1'],
      'Spectator never leaks into the player list during a live match'
    );

    // Spectators coming and going must not disturb the running match.
    const beforeChurn = JSON.stringify({
      seg: afterP1Submit.payload.players[p1].currentSegmentIndex,
      subs: Object.keys(afterP1Submit.payload.players[p1].submissions || {}).length,
      ready: afterP1Submit.payload.players[p2].isReady,
    });
    const churnSpec = await connectSpectator(roomBState.payload.spectateTicket, 'spec_churn', '进出的观众');
    await waitForMessage(churnSpec, (m) => m.type === 'room:state', 'churn spectator seated', 5000);
    churnSpec.send(JSON.stringify({ type: 'room:leave' }));
    closeSocket(churnSpec);
    await wait(300);
    const churnSpec2 = await connectSpectator(roomBState.payload.spectateTicket, 'spec_churn2', '再来一次');
    await waitForMessage(churnSpec2, (m) => m.type === 'room:state', 'second churn spectator seated', 5000);
    sockets.push(churnSpec2);
    closeSocket(wsSpec);
    await wait(400);

    // Leaving the last churn spectator broadcasts a fresh state; the player's
    // progress in it must be untouched.
    const afterChurn = await waitForMessage(
      ws1b,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB && !m.payload?.spectators?.['spec_churn2'],
      'player state after spectator churn',
      6000,
      () => churnSpec2.send(JSON.stringify({ type: 'room:leave' }))
    );
    const afterChurnSnapshot = JSON.stringify({
      seg: afterChurn.payload.players[p1].currentSegmentIndex,
      subs: Object.keys(afterChurn.payload.players[p1].submissions || {}).length,
      ready: afterChurn.payload.players[p2].isReady,
    });
    assert(
      afterChurnSnapshot === beforeChurn,
      'Spectators joining and leaving did not change segment index, submissions, or readiness'
    );
    assert(
      roomB === afterChurn.payload.roomCode && afterChurn.payload.players[p1].currentSegmentIndex === 1,
      'Player is still on the same question after spectator churn (no reset to question 1)'
    );

    console.log('\n--- 5. Two Sockets for One Account, and Broken Credentials ---');
    const ws1c = await connect(p1);
    sockets.push(ws1c);
    await waitForMessage(
      ws1c,
      (m) => m.type === 'room:state' && m.payload?.roomCode === roomB,
      'second tab rebinds the same account',
      5000,
      () => ws1c.send(JSON.stringify({ type: 'room:reconnect', payload: { roomCode: roomB } }))
    );
    const closeSecondTab = waitForMessage(
      ws1b,
      (m) =>
        m.type === 'room:state' &&
        m.payload?.roomCode === roomB &&
        m.payload?.players?.[p1]?.isOnline !== false &&
        !!m.payload?.players?.[p2]?.submissions?.[0],
      'first tab stays online after the second tab closes',
      6000
    );
    closeSocket(ws1c);
    await wait(400);
    // Another player's submission broadcasts a state that the surviving tab must
    // still receive, and in which the account must not have been marked offline.
    ws2.send(JSON.stringify({ type: 'segment:submit', payload: { segmentIndex: 0, studentAnswer: '二号选手第一题' } }));
    await closeSecondTab;
    assert(true, 'Closing one socket did not mark the account offline in the other tab');

    // Invalid ticket -> 4003
    const badTicket = new WebSocket(`${WS_BASE}?ticket=garbage&playerId=spec_bad&nickname=x`);
    const badTicketCode = await waitForClose(badTicket, 'invalid ticket');
    assert(badTicketCode === 4003, `Forged spectate ticket is rejected with close code 4003 (got ${badTicketCode})`);

    // Ticket for a room that does not exist -> 4005
    const ghostTicket = generateSpectateTicket('ZZZZZZ');
    const ghostSocket = new WebSocket(
      `${WS_BASE}?ticket=${encodeURIComponent(ghostTicket)}&playerId=spec_ghost&nickname=x`
    );
    const ghostCode = await waitForClose(ghostSocket, 'missing room ticket');
    assert(ghostCode === 4005, `Ticket for a non-existent room closes with 4005 (got ${ghostCode})`);

    // Spectators disabled after the fact -> 4004
    const ws3 = await connect(p3);
    sockets.push(ws3);
    const noSpecRoom = await waitForMessage(
      ws3,
      (m) => m.type === 'room:state' && m.payload?.status === 'WAITING',
      'room C created',
      5000,
      () =>
        ws3.send(
          JSON.stringify({
            type: 'room:create',
            payload: { nickname: '关闭观战房主', year: 2024, durationMinutes: 0.2, maxPlayers: 2 },
          })
        )
    );
    const ticketC = noSpecRoom.payload.spectateTicket as string;
    await waitForMessage(
      ws3,
      (m) => m.type === 'room:state' && m.payload?.allowSpectators === false,
      'spectators disabled in room C',
      5000,
      () =>
        ws3.send(JSON.stringify({ type: 'room:update_settings', payload: { allowSpectators: false } }))
    );
    const disabledSocket = new WebSocket(
      `${WS_BASE}?ticket=${encodeURIComponent(ticketC)}&playerId=spec_disabled&nickname=x`
    );
    const disabledCode = await waitForClose(disabledSocket, 'spectating disabled');
    assert(disabledCode === 4004, `Spectating-disabled room closes with 4004 (got ${disabledCode})`);

    // Token paired with someone else's playerId -> 4002
    const impostor = new WebSocket(
      `${WS_BASE}?token=${encodeURIComponent(generateUserToken('sg_real_owner'))}&playerId=sg_other_person`
    );
    const impostorCode = await waitForClose(impostor, 'identity mismatch');
    assert(impostorCode === 4002, `Mismatched token/playerId closes with 4002 (got ${impostorCode})`);

    console.log('\n--- 6. A Player in a Running Match Cannot Join a Second One ---');
    const joinDenied = await waitForMessage(
      ws2,
      (m) => m.type === 'error' && m.payload?.code === 'ALREADY_IN_MATCH',
      'second match refused',
      5000,
      () => ws2.send(JSON.stringify({ type: 'room:join', payload: { roomCode: noSpecRoom.payload.roomCode, nickname: '二号选手' } }))
    );
    assert(!!joinDenied.payload.message, 'Joining a second live match is refused (ALREADY_IN_MATCH)');

    console.log('\n--- 7. Account Spectator Can Still Take a Player Seat (switch_role) ---');
    // The target room had spectators disabled in step 5, so re-enable them first.
    await waitForMessage(
      ws3,
      (m) => m.type === 'room:state' && m.payload?.allowSpectators === true,
      'spectators re-enabled',
      5000,
      () => ws3.send(JSON.stringify({ type: 'room:update_settings', payload: { allowSpectators: true } }))
    );

    const viewerId = 'sg_viewer';
    const wsViewer = await connect(viewerId);
    sockets.push(wsViewer);
    const viewerSeat = await waitForMessage(
      wsViewer,
      (m) => m.type === 'room:state' && !!m.payload?.spectators?.[viewerId],
      'account spectator seated',
      5000,
      () =>
        wsViewer.send(
          JSON.stringify({
            type: 'room:join',
            payload: { roomCode: noSpecRoom.payload.roomCode, nickname: '登录观众', asSpectator: true },
          })
        )
    );
    assert(
      !viewerSeat.payload.players[viewerId],
      'Logged-in spectator starts outside the player slots'
    );

    const stoodUp = await waitForMessage(
      wsViewer,
      (m) => m.type === 'room:state' && !!m.payload?.players?.[viewerId],
      'spectator promoted to player',
      5000,
      () => wsViewer.send(JSON.stringify({ type: 'room:switch_role', payload: { targetRole: 'player' } }))
    );
    assert(!stoodUp.payload.spectators[viewerId], 'Promoted spectator left the gallery');
    const satBackDown = await waitForMessage(
      wsViewer,
      (m) => m.type === 'room:state' && !!m.payload?.spectators?.[viewerId],
      'player demoted back to spectator',
      5000,
      () => wsViewer.send(JSON.stringify({ type: 'room:switch_role', payload: { targetRole: 'spectator' } }))
    );
    assert(!satBackDown.payload.players[viewerId], 'Demoted player left the player slots');

    console.log('\n=== ALL SPECTATOR & ROOM-BINDING REGRESSION TESTS PASSED ===');
  } finally {
    for (const s of sockets) closeSocket(s);
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
