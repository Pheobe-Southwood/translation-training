import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { generateUserToken } from '../src/server/auth.js';

// --- multi-round protocol helpers -------------------------------------------------
const findPlayer = (payload: any, id: string) =>
  (payload?.players || []).find((p: any) => p.playerId === id);
const findSpectator = (payload: any, id: string) =>
  (payload?.spectators || []).find((s: any) => s.playerId === id);
const playerCount = (payload: any) => (payload?.players || []).length;
const isSummary = (msg: any) => msg?.type === 'room:summary';
// ---------------------------------------------------------------------------------


async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('=== Starting Test Server on Port 8890 ===');
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: '8890',
      HOST: '127.0.0.1',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (d) => console.log('[Server stdout]', d.toString().trim()));
  server.stderr?.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  // Wait for server ready
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8890/api/health');
      if (res.ok) break;
    } catch {}
    await wait(200);
  }

  try {
    const hostId = 'p_host_test';
    const guestId = 'p_guest_test';
    const hostToken = generateUserToken(hostId);
    const guestToken = generateUserToken(guestId);

    console.log('\n--- Step 1: Host creates room ---');
    let hostWs = new WebSocket(`ws://127.0.0.1:8890/ws?token=${hostToken}&playerId=${hostId}`);
    let roomCode = '';

    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', () => {
        hostWs.send(
          JSON.stringify({
            type: 'room:create',
            payload: { nickname: '房主测试', year: 2024 },
          })
        );
      });
      hostWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'room:summary') {
          roomCode = msg.payload.roomCode;
          console.log(`Room created: ${roomCode}`);
          resolve();
        }
      });
      setTimeout(() => reject(new Error('Create room timed out')), 5000);
    });

    console.log('\n--- Step 2: Host abruptly closes WS (switches to WeChat / locks screen) ---');
    hostWs.close();
    await wait(1000);

    console.log('\n--- Step 3: Friend tries to join room code while host is offline ---');
    const guestWs = new WebSocket(`ws://127.0.0.1:8890/ws?token=${guestToken}&playerId=${guestId}`);
    let guestJoined = false;

    await new Promise<void>((resolve, reject) => {
      guestWs.on('open', () => {
        console.log(`Guest sending room:join for ${roomCode}`);
        guestWs.send(
          JSON.stringify({
            type: 'room:join',
            payload: { roomCode, nickname: '好友测试' },
          })
        );
      });
      guestWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('Guest received msg:', msg.type);
        if (msg.type === 'room:summary') {
          const room = msg.payload;
          console.log('Room players:', (room.players || []).map((p: any) => p.playerId));
          if (findPlayer(room, guestId) && findPlayer(room, hostId)) {
            console.log('Success! Friend joined room even though host was temporarily disconnected!');
            guestJoined = true;
            resolve();
          }
        } else if (msg.type === 'error') {
          reject(new Error(`Friend received error: ${msg.payload.message}`));
        }
      });
      setTimeout(() => reject(new Error('Friend join timed out')), 5000);
    });

    console.log('\n--- Step 4: Host returns to browser and reconnects to room ---');
    hostWs = new WebSocket(`ws://127.0.0.1:8890/ws?token=${hostToken}&playerId=${hostId}`);
    let hostReconnected = false;

    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', () => {
        console.log('Host reconnected socket, sending ping & waiting for state...');
      });
      hostWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'room:summary') {
          console.log('Host received room:summary on reconnect! Status:', msg.payload.status);
          hostReconnected = true;
          resolve();
        }
      });
      setTimeout(() => reject(new Error('Host reconnect timed out')), 5000);
    });

    console.log('\n--- Step 5: Both players toggle ready ---');
    let matchStarted = false;

    await new Promise<void>((resolve, reject) => {
      hostWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'room:summary' && msg.payload.status === 'IN_PROGRESS') {
          console.log('Match successfully started in IN_PROGRESS!');
          matchStarted = true;
          resolve();
        }
      });

      hostWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
      guestWs.send(JSON.stringify({ type: 'room:toggle_ready' }));

      setTimeout(() => reject(new Error('Match start timed out')), 8000);
    });

    hostWs.close();
    guestWs.close();

    console.log('\n=== DISCONNECT RECOVERY TEST PASSED 100%! ===');
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
