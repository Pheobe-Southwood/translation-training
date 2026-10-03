import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== [1] Starting Server on Port 8889 for Verification ===');
  const serverProcess = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: '8889',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', (d) => console.log('[Server stdout]', d.toString().trim()));
  serverProcess.stderr?.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  // Wait for server to be ready with polling
  let ready = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8889/api/health');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await wait(300);
  }
  if (!ready) throw new Error('Server failed to start in time');

  const BASE_URL = 'http://127.0.0.1:8889';

  try {
    // 1. Health check
    console.log('\n--- Test 1: Health check ---');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const healthData = await healthRes.json();
    console.log('Health check response:', healthData);
    if (healthData.status !== 'ok') throw new Error('Health check failed');

    // 2. Auth - Wrong password
    console.log('\n--- Test 2: Auth with wrong password ---');
    const wrongAuthRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    console.log('Wrong auth status:', wrongAuthRes.status);
    if (wrongAuthRes.status !== 401) throw new Error('Wrong password should return 401');

    // 3. Auth - Correct password
    console.log('\n--- Test 3: Auth with correct password (tt8888) ---');
    const authRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'tt8888' }),
    });
    const authData = await authRes.json();
    console.log('Auth login response:', authData);
    if (!authData.success || !authData.token) throw new Error('Auth login failed');
    const token = authData.token;

    // 4. Token verification
    console.log('\n--- Test 4: Token validation check ---');
    const checkRes = await fetch(`${BASE_URL}/api/auth/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const checkData = await checkRes.json();
    console.log('Token check response:', checkData);
    if (!checkData.authenticated) throw new Error('Token verification failed');

    // 5. Exam years
    console.log('\n--- Test 5: Get exam years ---');
    const yearsRes = await fetch(`${BASE_URL}/api/exams/years`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const yearsData = await yearsRes.json();
    console.log(`Found ${yearsData.years.length} exam years:`, yearsData.years.slice(0, 5), '...');
    if (yearsData.years.length !== 25) throw new Error('Expected 25 exam years (2002-2026)');

    // 6. Exam details for 2024
    console.log('\n--- Test 6: Get 2024 Exam details ---');
    const exam2024Res = await fetch(`${BASE_URL}/api/exams/2024`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const exam2024Data = await exam2024Res.json();
    console.log('2024 Title:', exam2024Data.exam.title);
    console.log('2024 Segment count:', exam2024Data.exam.translationSegments.length);
    console.log('Segment 1 preview:', exam2024Data.exam.translationSegments[0].slice(0, 60), '...');
    if (exam2024Data.exam.translationSegments.length !== 5) throw new Error('Expected 5 segments');

    // 7. DeepSeek Grading with Tool Calling
    console.log('\n--- Test 7: DeepSeek Tool Calling Grading ---');
    const gradeStart = Date.now();
    const gradeRes = await fetch(`${BASE_URL}/api/solo/grade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fullArticle: exam2024Data.exam.contentMarkdown,
        targetSentence: exam2024Data.exam.translationSegments[0],
        studentAnswer: '一个难题在于，几乎所有所谓的行为科学都继续将行为归因于心理状态、情感、性格特征和人性等。',
        segmentIndex: 0,
      }),
    });
    const gradeData = await gradeRes.json();
    const durationSec = ((Date.now() - gradeStart) / 1000).toFixed(1);
    console.log(`Grading returned in ${durationSec}s:`);
    console.log('Score:', gradeData.gradingResult?.score, '/ 2.0');
    console.log('Points breakdown count:', gradeData.gradingResult?.points_breakdown?.length);
    console.log('Critique preview:', gradeData.gradingResult?.critique?.slice(0, 80), '...');
    console.log('Reference preview:', gradeData.gradingResult?.reference_translation?.slice(0, 60), '...');

    if (typeof gradeData.gradingResult?.score !== 'number') {
      throw new Error('Invalid grading result score');
    }

    // 8. PVP WebSocket Room Flow (Host & Guest)
    console.log('\n--- Test 8: PVP WebSocket Room & Match Flow ---');
    const hostPlayerId = 'p_host_123';
    const guestPlayerId = 'p_guest_456';

    const wsUrl = `ws://127.0.0.1:8889/ws?token=${token}`;

    const hostWs = new WebSocket(`${wsUrl}&playerId=${hostPlayerId}`);
    const guestWs = new WebSocket(`${wsUrl}&playerId=${guestPlayerId}`);

    let roomCode = '';

    await new Promise<void>((resolve, reject) => {
      hostWs.on('open', () => {
        console.log('Host WS connected');
        // Host creates room
        hostWs.send(
          JSON.stringify({
            type: 'room:create',
            payload: { nickname: '测试房主', year: 2024, durationMinutes: 10 },
          })
        );
      });

      hostWs.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'room:state') {
          const room = msg.payload;
          if (!roomCode && room.roomCode) {
            roomCode = room.roomCode;
            console.log(`Room created with code: ${roomCode}`);
            // Guest joins
            guestWs.send(
              JSON.stringify({
                type: 'room:join',
                payload: { roomCode, nickname: '测试挑战者' },
              })
            );
          } else if (Object.keys(room.players).length === 2 && !room.players[hostPlayerId]?.isReady) {
            console.log('Both players in room, toggling ready!');
            hostWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
            guestWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
          } else if (room.status === 'COUNTDOWN') {
            console.log('Countdown started, waiting for match start...');
          } else if (room.status === 'IN_PROGRESS') {
            console.log('Match successfully started in IN_PROGRESS state!');
            resolve();
          }
        }
      });

      guestWs.on('open', () => {
        console.log('Guest WS connected');
      });

      setTimeout(() => reject(new Error('PVP Flow timed out')), 15000);
    });

    hostWs.close();
    guestWs.close();

    console.log('\n=== ALL END-TO-END TESTS PASSED SUCCESSFULLY! ===');
  } finally {
    serverProcess.kill('SIGTERM');
  }
}

runTests().catch((err) => {
  console.error('\nVerification FAILED:', err);
  process.exit(1);
});
