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

async function testPairedPvp() {
  console.log('=== Starting Test Server on Port 8891 for Paired PVP Test ===');
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: '8891',
      HOST: '127.0.0.1',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (d) => console.log('[Server stdout]', d.toString().trim()));
  server.stderr?.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8891/api/health');
      if (res.ok) break;
    } catch {}
    await wait(200);
  }

  try {
    const hostId = 'p_paired_a';
    const guestId = 'p_paired_b';
    const hostToken = generateUserToken(hostId);
    const guestToken = generateUserToken(guestId);

    const hostWs = new WebSocket(`ws://127.0.0.1:8891/ws?token=${hostToken}&playerId=${hostId}`);
    const guestWs = new WebSocket(`ws://127.0.0.1:8891/ws?token=${guestToken}&playerId=${guestId}`);

    let roomCode = '';

    await Promise.all([
      new Promise<void>((r) => hostWs.once('open', () => r())),
      new Promise<void>((r) => guestWs.once('open', () => r())),
    ]);

    await new Promise<void>((resolve, reject) => {
      hostWs.send(
        JSON.stringify({
          type: 'room:create',
          payload: { nickname: '玩家A', year: 2024, durationMinutes: 10 },
        })
      );

      hostWs.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'room:summary' && !roomCode) {
          roomCode = msg.payload.roomCode;
          console.log(`Room created: ${roomCode}`);
          guestWs.send(
            JSON.stringify({
              type: 'room:join',
              payload: { roomCode, nickname: '玩家B' },
            })
          );
        } else if (msg.type === 'room:summary' && playerCount(msg.payload) === 2 && !findPlayer(msg.payload, hostId)?.isReady) {
          hostWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
          guestWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
        } else if (msg.type === 'room:summary' && msg.payload.status === 'IN_PROGRESS') {
          resolve();
        }
      });

      setTimeout(() => reject(new Error('PVP Match Setup timed out')), 12000);
    });

    console.log('\n--- Step 2: Player A submits Question 1 ---');
    hostWs.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: {
          roundIndex: 0,
          segmentIndex: 0,
          studentAnswer: '它们有时行进六十多英里去寻找食物或水源，而且非常擅长判断其他大象的位置。',
        },
      })
    );

    await wait(500);

    console.log('\n--- Step 3: Player B submits Question 1 (Should trigger DeepSeek paired grading) ---');
    let pairedGradedEventReceived = false;

    await new Promise<void>((resolve, reject) => {
      hostWs.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        // Batched paired grading now lands in `round:detail`: every player's answer for
        // the same (round, segment) is graded in one call and both results appear together.
        if (msg.type === 'round:detail' && msg.payload?.roundIndex === 0) {
          const students = msg.payload.players || [];
          const a = students.find((p: any) => p.playerId === hostId)?.submissions?.[0];
          const b = students.find((p: any) => p.playerId === guestId)?.submissions?.[0];
          if (a?.gradingStatus === 'graded' && b?.gradingStatus === 'graded') {
            console.log('\n[SUCCESS] Batched paired grading results received!');
            console.log('Student A Score:', a.gradingResult?.score);
            console.log('Student B Score:', b.gradingResult?.score);
            console.log('Comparative Analysis:', a.comparativeAnalysis || b.comparativeAnalysis);
            pairedGradedEventReceived = true;
            resolve();
          }
        }
      });

      guestWs.send(
        JSON.stringify({
          type: 'segment:submit',
          payload: {
            roundIndex: 0,
            segmentIndex: 0,
            studentAnswer: '它们有时为了寻找食物或者水而跋涉超过60英里，非常善于辨别其他大象在何方，即便不在视线中。',
          },
        })
      );

      setTimeout(() => reject(new Error('Paired grading response timed out')), 15000);
    });

    hostWs.close();
    guestWs.close();

    if (!pairedGradedEventReceived) {
      throw new Error('Did not receive batched paired grading results');
    }

    console.log('\n=== PAIRED GRADING END-TO-END TEST PASSED! ===');
  } finally {
    server.kill('SIGTERM');
  }
}

testPairedPvp().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
