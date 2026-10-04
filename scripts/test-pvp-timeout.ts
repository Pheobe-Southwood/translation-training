import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPvpTimeout() {
  console.log('=== Starting Test Server on Port 8892 for PVP Timeout Test ===');
  const server = spawn('node', ['dist/server/index.js'], {
    env: {
      ...process.env,
      PORT: '8892',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      SITE_PASSWORD: 'tt8888',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'sk-180edfd58e274f969c0437def3b9047b',
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (d) => console.log('[Server stdout]', d.toString().trim()));
  server.stderr?.on('data', (d) => console.error('[Server stderr]', d.toString().trim()));

  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch('http://127.0.0.1:8892/api/health');
      if (res.ok) break;
    } catch {}
    await wait(200);
  }

  try {
    const registerUser = async (username: string, nickname: string) => {
      const regRes = await fetch('http://127.0.0.1:8892/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password: 'Password123!',
          invitationCode: 'tt8888',
          nickname,
        }),
      });
      const regData = await regRes.json();
      if (regData.token) return regData;
      const loginRes = await fetch('http://127.0.0.1:8892/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password: 'Password123!',
        }),
      });
      return await loginRes.json();
    };

    const suffix = Date.now().toString().slice(-4);
    const hostData = await registerUser(`test_host_${suffix}`, '测试房主');
    const guestData = await registerUser(`test_guest_${suffix}`, '测试挑战者');

    const hostId = hostData.user.id;
    const guestId = guestData.user.id;
    const hostToken = hostData.token;
    const guestToken = guestData.token;

    const hostWs = new WebSocket(`ws://127.0.0.1:8892/ws?token=${hostToken}&playerId=${hostId}`);
    const guestWs = new WebSocket(`ws://127.0.0.1:8892/ws?token=${guestToken}&playerId=${guestId}`);

    await Promise.all([
      new Promise<void>((r) => hostWs.once('open', () => r())),
      new Promise<void>((r) => guestWs.once('open', () => r())),
    ]);
    console.log('Both Host and Guest WebSockets opened.');

    let roomCode = '';

    await new Promise<void>((resolve, reject) => {
      hostWs.send(
        JSON.stringify({
          type: 'room:create',
          payload: { nickname: '测试房主', year: 2024, durationMinutes: 0.1 }, // 6s duration
        })
      );

      hostWs.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'room:state' && !roomCode) {
          roomCode = msg.payload.roomCode;
          console.log(`Room created: ${roomCode}`);
          guestWs.send(
            JSON.stringify({
              type: 'room:join',
              payload: { roomCode, nickname: '测试挑战者' },
            })
          );
        } else if (
          msg.type === 'room:state' &&
          Object.keys(msg.payload.players).length === 2 &&
          !msg.payload.players[hostId]?.isReady
        ) {
          hostWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
          guestWs.send(JSON.stringify({ type: 'room:toggle_ready' }));
        } else if (msg.type === 'room:state' && msg.payload.status === 'IN_PROGRESS') {
          resolve();
        }
      });

      setTimeout(() => reject(new Error('PVP Match Setup timed out')), 12000);
    });

    console.log('\n--- Step 1: Match Started! Submitting answers before timeout ---');
    // Player A & B both submit Segment 0
    hostWs.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: {
          segmentIndex: 0,
          studentAnswer: '它们有时行进六十多英里去寻找食物或水源。',
        },
      })
    );
    guestWs.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: {
          segmentIndex: 0,
          studentAnswer: '它们有时为了寻找食物或者水而跋涉超过60英里。',
        },
      })
    );

    // Player A submits Segment 1 just before timeout, Player B does NOT submit Segment 1
    await wait(1000);
    hostWs.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: {
          segmentIndex: 1,
          studentAnswer: '这些声音不仅有助于维系庞大家庭群体之间的联系。',
        },
      })
    );

    console.log('\n--- Step 2: Waiting for match countdown timer to expire and two-stage settlement to complete ---');

    let matchEndedPayload: any = null;
    let prematureMatchEnded = false;
    let matchStartTime = Date.now();

    await new Promise<void>((resolve, reject) => {
      hostWs.on('message', (d) => {
        const msg = JSON.parse(d.toString());
        if (msg.type === 'match:ended') {
          console.log('\n[Received match:ended event]');
          console.log('Winner:', msg.payload.winnerId);
          console.log('Reason:', msg.payload.reason);
          const p1 = msg.payload.roomState.players[hostId];
          const p2 = msg.payload.roomState.players[guestId];
          console.log(`Scores -> Host: ${p1.totalScore}, Guest: ${p2.totalScore}`);

          // Check if segments 0 and 1 are actually graded
          const seg0Graded = p1.submissions[0]?.gradingStatus === 'graded';
          const seg1Graded = p1.submissions[1]?.gradingStatus === 'graded';

          if (!seg0Graded || !seg1Graded) {
            console.error('ERROR: match:ended arrived BEFORE grading completed!');
            prematureMatchEnded = true;
          } else {
            console.log('SUCCESS: All in-flight segments are graded upon match:ended!');
          }

          matchEndedPayload = msg.payload;
          resolve();
        }
      });

      // 40s timeout for test
      setTimeout(() => reject(new Error('Match settlement timed out after 40s')), 40000);
    });

    hostWs.close();
    guestWs.close();

    if (prematureMatchEnded) {
      throw new Error('Test failed: Match ended prematurely before grading completed!');
    }

    if (!matchEndedPayload) {
      throw new Error('Test failed: Did not receive match:ended payload');
    }

    // Step 3: Verify SQLite database has authoritative records
    console.log('\n--- Step 3: Verify SQLite database records ---');
    const dbPath = path.resolve(process.cwd(), 'data/app.db');
    const sqlite = new DatabaseSync(dbPath);
    const hostRecords = sqlite
      .prepare('SELECT * FROM history_records WHERE user_id = ? ORDER BY timestamp DESC')
      .all(hostId) as any[];

    if (hostRecords.length === 0) {
      throw new Error('No history record saved in SQLite for host player!');
    }

    const hostRec = hostRecords[0];
    const submissions = JSON.parse(hostRec.submissions_json);
    console.log(`Saved history submissions count: ${submissions.length}`);
    console.log(`Saved total score in DB: ${hostRec.total_score}`);

    if (submissions.length !== 5) {
      throw new Error(`Expected 5 submissions in history record, found ${submissions.length}`);
    }

    // Segment 0 & 1 should have grades
    if (!submissions[0].gradingResult || !submissions[1].gradingResult) {
      throw new Error('Submissions 0 and 1 in DB must have gradingResults!');
    }

    // Segments 2, 3, 4 should be marked as timeout
    if (submissions[2].studentAnswer !== '（超时未作答）' || submissions[2].gradingResult?.score !== 0) {
      throw new Error('Submission 2 must be marked as timed out with 0 score');
    }

    console.log('\n=== PVP TIMEOUT TEST PASSED! All assertions verified! ===');
  } finally {
    server.kill('SIGTERM');
  }
}

testPvpTimeout().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
