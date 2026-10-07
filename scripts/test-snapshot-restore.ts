/**
 * Boot-safety test for long-match snapshot restore.
 *
 * `restoreSnapshots()` runs inside the PvpManager constructor, so a bug there would
 * stop the production process from ever listening. This test writes one valid and one
 * corrupt snapshot into the local database, boots the server, and asserts that:
 *   1. the valid room is restored,
 *   2. the corrupt row is discarded rather than throwing,
 *   3. the process reaches "Server listening" either way.
 *
 *   npx tsx scripts/test-snapshot-restore.ts      (requires: pnpm build:server)
 */
import { spawn } from 'child_process';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const PORT = 8898;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.resolve(process.cwd(), 'data/app.db');
const GOOD_ROOM = 'SNAP01';
const BAD_ROOM = 'SNAP02';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

function buildSnapshotPayload() {
  const now = Date.now();
  const playerId = 'snap_test_player';
  return JSON.stringify({
    roomCode: GOOD_ROOM,
    config: {
      totalRounds: 2,
      durationMinutes: 20,
      maxPlayers: 2,
      allowSpectators: true,
      drawStrategy: 'random',
    },
    status: 'IN_PROGRESS',
    scheduledYears: [2024, 2023],
    rounds: [
      {
        roundIndex: 0,
        year: 2024,
        isOvertime: false,
        exam: { id: '2024-translation', year: 2024, title: 't', maxScore: 10, contentMarkdown: 'x', translationSegments: ['a', 'b', 'c', 'd', 'e'] },
        startedAt: now - 60_000,
        players: {
          [playerId]: { playerId, submissions: {}, timedOut: false, smallScore: 0 },
          other: { playerId: 'other', submissions: {}, timedOut: false, smallScore: 0 },
        },
        batches: {},
        settled: false,
      },
    ],
    players: {
      [playerId]: {
        playerId,
        nickname: '快照选手',
        isHost: true,
        isReady: true,
        isOnline: true,
        phase: 'playing',
        currentRoundIndex: 0,
        currentSegmentIndex: 0,
        roundStartedAt: now - 60_000,
        roundDeadlineAt: now + 3_600_000,
        answeredSegments: [],
        matchPoints: 0,
        totalScore: 0,
        roundsCompleted: 0,
        hasFinishedAllRounds: false,
      },
      other: {
        playerId: 'other',
        nickname: '对手',
        isHost: false,
        isReady: true,
        isOnline: true,
        phase: 'playing',
        currentRoundIndex: 0,
        currentSegmentIndex: 0,
        roundStartedAt: now - 60_000,
        roundDeadlineAt: now + 3_600_000,
        answeredSegments: [],
        matchPoints: 0,
        totalScore: 0,
        roundsCompleted: 0,
        hasFinishedAllRounds: false,
      },
    },
    spectators: {},
    createdAt: now - 120_000,
    startedAt: now - 60_000,
  });
}

async function run() {
  const db = new DatabaseSync(DB_PATH);
  db.prepare(`DELETE FROM match_snapshots WHERE room_code IN (?, ?)`).run(GOOD_ROOM, BAD_ROOM);
  db.prepare(
    `INSERT INTO match_snapshots (room_code, payload_json, updated_at) VALUES (?, ?, ?)`
  ).run(GOOD_ROOM, buildSnapshotPayload(), Date.now());
  db.prepare(
    `INSERT INTO match_snapshots (room_code, payload_json, updated_at) VALUES (?, ?, ?)`
  ).run(BAD_ROOM, '{ this is not json', Date.now());
  db.close();
  console.log('Seeded 1 valid + 1 corrupt snapshot');

  console.log(`\n=== Booting server on port ${PORT} ===`);
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

  let output = '';
  server.stdout?.on('data', (d) => {
    output += d.toString();
  });
  server.stderr?.on('data', (d) => {
    output += d.toString();
  });

  try {
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await wait(150);
    }

    assert(healthy, 'server reached /api/health despite the snapshots');
    assert(output.includes('Restored 1 in-flight long match'), 'the valid snapshot was restored');
    assert(
      output.includes(`Corrupt snapshot for room ${BAD_ROOM}`) ||
        output.includes('Corrupt snapshot'),
      'the corrupt snapshot was discarded with a log line instead of throwing'
    );

    await wait(300);
    const check = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = check.prepare(`SELECT room_code FROM match_snapshots`).all() as any[];
    check.close();
    assert(
      !rows.some((r) => r.room_code === BAD_ROOM),
      'the corrupt snapshot row was deleted from the database'
    );
    assert(
      rows.some((r) => r.room_code === GOOD_ROOM),
      'the restored snapshot row is kept so a second restart could restore it again'
    );

    console.log('\n=== SNAPSHOT RESTORE TESTS PASSED ===\n');
  } finally {
    server.kill('SIGTERM');
    await wait(400);
    const cleanup = new DatabaseSync(DB_PATH);
    cleanup.prepare(`DELETE FROM match_snapshots WHERE room_code IN (?, ?)`).run(GOOD_ROOM, BAD_ROOM);
    cleanup.close();
    console.log('Cleaned up test snapshot rows');
  }
}

run().catch((err) => {
  console.error('\n✖ SNAPSHOT RESTORE TEST FAILED:', err);
  process.exit(1);
});
