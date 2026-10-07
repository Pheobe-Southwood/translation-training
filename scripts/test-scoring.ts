/**
 * Deterministic unit tests for the round-settlement mathematics.
 *
 *   npx tsx scripts/test-scoring.ts
 *
 * Every scoring rule that can change the outcome of a series is asserted here.
 * No network, no server, no DeepSeek key required.
 */
import {
  settleRound,
  resolveOvertime,
  rankPlayers,
  tiedLeaders,
  drawScheduledYears,
  poolSize,
  type RoundScoreInput,
  type Standing,
} from '../src/shared/scoring.js';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.error(`  ✖ ${label}\n      expected ${e}\n      actual   ${a}`);
  }
}

function checkClose(label: string, actual: number, expected: number) {
  if (Math.abs(actual - expected) < 1e-9) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.error(`  ✖ ${label}\n      expected ${expected}\n      actual   ${actual}`);
  }
}

function entry(playerId: string, smallScore: number, remainingSeconds: number): RoundScoreInput {
  return { playerId, smallScore, remainingSeconds };
}

const PLAIN = { isFinalRound: false, isOvertime: false, onlyOneRound: false };

console.log('\n=== 1. 2-player baseline (不含本人 == 胜−次) ===');
{
  const r = settleRound([entry('A', 8, 300), entry('B', 6, 300)], PLAIN);
  const a = r.find((x) => x.playerId === 'A')!;
  const b = r.find((x) => x.playerId === 'B')!;
  checkClose('A baseline = 6', a.baselineScore, 6);
  checkClose('A ΔS = 2', a.deltaS, 2);
  checkClose('A points = 2.0', a.pointsPart, 2);
  checkClose('A match points = 2.0', a.matchPointsDelta, 2);
  checkClose('B ΔS = -2 → 0', b.matchPointsDelta, 0);
}

console.log('\n=== 2. Time bonus bands (60 / 180 second boundaries) ===');
{
  const at = (remA: number) =>
    settleRound([entry('A', 8, remA), entry('B', 6, 300)], PLAIN).find((x) => x.playerId === 'A')!;
  checkClose('ΔT = 59 → no bonus', at(359).timePart, 0);
  checkClose('ΔT = 60 → +0.5 (inclusive)', at(360).timePart, 0.5);
  checkClose('ΔT = 180 → +0.5 (inclusive)', at(480).timePart, 0.5);
  checkClose('ΔT = 181 → +1.0', at(481).timePart, 1);
  checkClose('ΔT negative → no bonus', at(200).timePart, 0);
}

console.log('\n=== 3. Time bonus requires a score lead ===');
{
  // B is faster but behind on score: no time bonus for anyone.
  const r = settleRound([entry('A', 4, 100), entry('B', 8, 900)], PLAIN);
  checkClose('slower-but-ahead A gets no time bonus (ΔS<0)', r.find((x) => x.playerId === 'A')!.timePart, 0);
  checkClose('faster-and-ahead B gets a time bonus', r.find((x) => x.playerId === 'B')!.timePart, 1);
  // Dead heat on score: nobody scores at all, even with a huge time gap.
  const tie = settleRound([entry('A', 7, 900), entry('B', 7, 60)], PLAIN);
  check('score tie → both zero', tie.map((x) => x.matchPointsDelta), [0, 0]);
}

console.log('\n=== 4. 3-player field ===');
{
  const r = settleRound([entry('A', 9, 0), entry('B', 6, 0), entry('C', 3, 0)], PLAIN);
  checkClose('A baseline = 4.5', r[0].baselineScore, 4.5);
  checkClose('A points = 4.5', r[0].pointsPart, 4.5);
  checkClose('B at the mean → 0', r[1].matchPointsDelta, 0);
  checkClose('C below the mean → 0', r[2].matchPointsDelta, 0);
}

console.log('\n=== 5. 4-player 1/6 granularity ===');
{
  // Everyone within a third of a point of the mean awards nothing.
  const flat = settleRound(
    [entry('A', 7, 0), entry('B', 7, 0), entry('C', 7, 0), entry('D', 6.5, 0)],
    PLAIN
  );
  check('near-tie in a 4-player room → all zero', flat.map((x) => x.matchPointsDelta), [0, 0, 0, 0]);
  // One clear leader: ΔS = 1.0 against a 7.0 baseline.
  const clear = settleRound(
    [entry('A', 8, 0), entry('B', 7, 0), entry('C', 7, 0), entry('D', 7, 0)],
    PLAIN
  );
  checkClose('clear leader ΔS = 1.0', clear[0].deltaS, 1);
  checkClose('clear leader gets 1.0', clear[0].matchPointsDelta, 1);
}

console.log('\n=== 6. Withdrawn player is counted in the baseline as 0 ===');
{
  const r = settleRound([entry('A', 8, 0), entry('B', 7, 0), entry('C', 0, 0)], PLAIN);
  checkClose('A baseline = 3.5', r[0].baselineScore, 3.5);
  checkClose('A gets 4.5', r[0].pointsPart, 4.5);
  checkClose('B baseline = 4 → 3.0', r[1].pointsPart, 3);
  // The inflation case discussed during design review: a 3-way tie becomes a 3-way
  // payday once a withdrawn player's 0 drags everyone's baseline down to 3.33.
  const inflated = settleRound(
    [entry('A', 5, 0), entry('B', 5, 0), entry('C', 5, 0), entry('D', 0, 0)],
    PLAIN
  );
  check('3-way tie + a leaver → three players get +1.5', inflated.map((x) => x.matchPointsDelta), [1.5, 1.5, 1.5, 0]);
  checkClose('the leaver is below the mean and gets nothing', inflated[3].deltaS, -5);
}

console.log('\n=== 7. Final-round doubling and the N=1 exemption ===');
{
  const final = settleRound([entry('A', 8, 300), entry('B', 6, 300)], {
    isFinalRound: true,
    isOvertime: false,
    onlyOneRound: false,
  });
  checkClose('final round doubles', final[0].matchPointsDelta, 4);
  const single = settleRound([entry('A', 8, 300), entry('B', 6, 300)], {
    isFinalRound: true,
    isOvertime: false,
    onlyOneRound: true,
  });
  checkClose('N=1 disables the doubling', single[0].matchPointsDelta, 2);
}

console.log('\n=== 8. Overtime round awards no banded points ===');
{
  const r = settleRound([entry('A', 10, 0), entry('B', 2, 0)], {
    isFinalRound: true,
    isOvertime: true,
    onlyOneRound: false,
  });
  check('overtime settleRound is inert', r.map((x) => x.matchPointsDelta), [0, 0]);
}

console.log('\n=== 9. Overtime resolution chain ===');
{
  check('unique top score wins', resolveOvertime([
    { playerId: 'A', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 3000 },
    { playerId: 'B', smallScore: 6, overtimeElapsedSeconds: 100, seriesElapsedSeconds: 1000 },
  ]), { winnerId: 'A', reason: 'small-score' });

  check('score tie → faster overtime round wins', resolveOvertime([
    { playerId: 'A', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 1000 },
    { playerId: 'B', smallScore: 8, overtimeElapsedSeconds: 200, seriesElapsedSeconds: 3000 },
  ]), { winnerId: 'B', reason: 'overtime-time' });

  check('score + overtime tie → faster series wins', resolveOvertime([
    { playerId: 'A', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 3000 },
    { playerId: 'B', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 1200 },
  ]), { winnerId: 'B', reason: 'series-time' });

  check('all three axes tie → draw', resolveOvertime([
    { playerId: 'A', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 3000 },
    { playerId: 'B', smallScore: 8, overtimeElapsedSeconds: 500, seriesElapsedSeconds: 3000 },
  ]), { winnerId: null, reason: 'draw' });
}

console.log('\n=== 10. Standings, ranks and the overtime trigger ===');
{
  const s = (playerId: string, matchPoints: number, totalScore: number): Standing => ({
    playerId,
    nickname: playerId,
    matchPoints,
    totalScore,
    isFinished: true,
  });

  check('大比分 first, 小分 second', rankPlayers([s('A', 5, 30), s('B', 5, 32), s('C', 3, 40)]).map((r) => [r.playerId, r.rank]),
    [['B', 1], ['A', 2], ['C', 3]]);

  check('full tie shares rank 1', rankPlayers([s('A', 5, 30), s('B', 5, 30), s('C', 3, 40)]).map((r) => [r.playerId, r.rank]),
    [['A', 1], ['B', 1], ['C', 3]]);

  check('tied leaders detected', tiedLeaders([s('A', 5, 30), s('B', 5, 30), s('C', 3, 40)]), ['A', 'B']);
  check('小分 breaks the tie → no overtime', tiedLeaders([s('A', 5, 30), s('B', 5, 32)]), []);
  check('outright leader → no overtime', tiedLeaders([s('A', 6, 30), s('B', 5, 30)]), []);
}

console.log('\n=== 11. Pool sizing and year drawing ===');
{
  const years: number[] = [];
  for (let y = 2002; y <= 2026; y++) years.push(y);

  check('random pool = 25', poolSize(years, 'random'), 25);
  check('range 2018-2024 pool = 7', poolSize(years, 'range', { start: 2018, end: 2024 }), 7);
  check('custom pool = 3', poolSize(years, 'custom', undefined, [2020, 2019, 2018]), 3);

  const rnd = drawScheduledYears(years, 'random', 3, { rng: () => 0.5 });
  check('random draws N unique years', new Set(rnd.years).size, 3);
  check('random over-cap errors', drawScheduledYears(years, 'random', 26).error !== undefined, true);

  const rng = drawScheduledYears(years, 'range', 7, { range: { start: 2018, end: 2024 }, rng: () => 0.5 });
  check('range draws 7 and stays inside', rng.years.every((y) => y >= 2018 && y <= 2024) && rng.years.length === 7, true);
  check('range over-cap errors', drawScheduledYears(years, 'range', 8, { range: { start: 2018, end: 2024 } }).error !== undefined, true);
  check('inverted range errors', drawScheduledYears(years, 'range', 1, { range: { start: 2024, end: 2018 } }).error !== undefined, true);

  check('custom preserves host order', drawScheduledYears(years, 'custom', 3, { customYears: [2021, 2019, 2023] }).years,
    [2021, 2019, 2023]);
  check('custom rejects duplicates', drawScheduledYears(years, 'custom', 2, { customYears: [2020, 2020] }).error !== undefined, true);
  check('custom rejects unknown years', drawScheduledYears(years, 'custom', 1, { customYears: [1999] }).error !== undefined, true);
}

console.log('\n=== 12. No comeback cap exists any more ===');
{
  // A trailing player used to be clipped to the leader's pre-round total. That mechanism
  // is gone: a dominant round now awards the full margin.
  const r = settleRound([entry('A', 10, 800), entry('B', 0, 0)], PLAIN);
  checkClose('10:0 awards the full margin + strong time bonus', r[0].matchPointsDelta, 10 + 1);
}

console.log(`\n${failed === 0 ? '✔' : '✖'} scoring tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
