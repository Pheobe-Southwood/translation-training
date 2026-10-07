/**
 * Pure round-settlement mathematics for multi-round PVP series.
 *
 * This module has zero dependencies on purpose: both the server and the verification
 * scripts import it, and every rule below is covered by `scripts/test-scoring.ts`.
 *
 * Round scoring (per player i):
 *
 *   S_i  = small score of this round (sum of the 5 segment scores, 0..10)
 *   B_i  = mean(S_j for j != i)                       // baseline EXCLUDES the player
 *   ΔS_i = S_i - B_i
 *   P_i  = ΔS_i <= 0 ? 0 : floor(ΔS_i * 2) * 0.5      // +0.5 per full 0.5 of advantage
 *
 *   R_i  = max(0, roundDuration - ownElapsed)          // own remaining seconds
 *   B'_i = mean(R_j for j != i)
 *   ΔT_i = R_i - B'_i
 *   Q_i  = (ΔS_i > 0 && ΔT_i >= 60) ? (ΔT_i > 180 ? 1.0 : 0.5) : 0
 *
 *   M_i  = (P_i + Q_i) * (isFinalRound && !onlyOneRound ? 2 : 1)
 *
 * Overtime rounds award a flat +1.0 to a single winner resolved by
 * small score -> overtime elapsed -> whole-series elapsed.
 */

export const TIME_BONUS_MIN_LEAD_SECONDS = 60;
export const TIME_BONUS_STRONG_LEAD_SECONDS = 180;
export const TIME_BONUS_STANDARD = 0.5;
export const TIME_BONUS_STRONG = 1.0;
export const OVERTIME_MATCH_POINTS = 1.0;

/** Guards `floor()` and the second-threshold comparisons against binary noise. */
const EPSILON = 1e-9;

export interface RoundScoreInput {
  playerId: string;
  smallScore: number;
  remainingSeconds: number;
}

export interface SettleRoundOptions {
  /** True for the last scheduled round (index === totalRounds - 1). */
  isFinalRound: boolean;
  /** True for the overtime decider, which never uses the doubling or the bands. */
  isOvertime: boolean;
  /** True when the series is a single round, which disables the final-round doubling. */
  onlyOneRound: boolean;
}

export interface RoundScoreEntry {
  playerId: string;
  smallScore: number;
  baselineScore: number;
  deltaS: number;
  pointsPart: number;
  remainingSeconds: number;
  baselineRemaining: number;
  deltaT: number;
  timePart: number;
  matchPointsDelta: number;
}

/**
 * Settles one round. Returns one entry per input, in the same order.
 * A single-player "round" awards nothing (there is no field to compare against).
 */
export function settleRound(
  entries: RoundScoreInput[],
  options: SettleRoundOptions
): RoundScoreEntry[] {
  const { isFinalRound, isOvertime, onlyOneRound } = options;

  if (entries.length < 2) {
    return entries.map((e) => ({
      playerId: e.playerId,
      smallScore: e.smallScore,
      baselineScore: 0,
      deltaS: 0,
      pointsPart: 0,
      remainingSeconds: Math.max(0, e.remainingSeconds),
      baselineRemaining: 0,
      deltaT: 0,
      timePart: 0,
      matchPointsDelta: 0,
    }));
  }

  const scores = entries.map((e) => e.smallScore);
  const remaining = entries.map((e) => Math.max(0, e.remainingSeconds));
  const totalScore = scores.reduce((a, b) => a + b, 0);
  const totalRemaining = remaining.reduce((a, b) => a + b, 0);
  const n = entries.length;

  const roundMultiplier = !isOvertime && isFinalRound && !onlyOneRound ? 2 : 1;

  return entries.map((entry, index) => {
    const baselineScore = (totalScore - scores[index]) / (n - 1);
    const deltaS = entry.smallScore - baselineScore;

    // +0.5 for every full 0.5 the player sits above the rest of the field.
    const pointsPart = deltaS <= 0 ? 0 : Math.floor(deltaS * 2 + EPSILON) * 0.5;

    const remainingSeconds = remaining[index];
    const baselineRemaining = (totalRemaining - remainingSeconds) / (n - 1);
    const deltaT = remainingSeconds - baselineRemaining;

    // The time bonus only exists for players who are also ahead on score.
    let timePart = 0;
    if (!isOvertime && deltaS > 0 && deltaT >= TIME_BONUS_MIN_LEAD_SECONDS - EPSILON) {
      timePart = deltaT > TIME_BONUS_STRONG_LEAD_SECONDS + EPSILON
        ? TIME_BONUS_STRONG
        : TIME_BONUS_STANDARD;
    }

    const matchPointsDelta = isOvertime ? 0 : (pointsPart + timePart) * roundMultiplier;

    return {
      playerId: entry.playerId,
      smallScore: entry.smallScore,
      baselineScore,
      deltaS,
      pointsPart,
      remainingSeconds,
      baselineRemaining,
      deltaT,
      timePart,
      matchPointsDelta,
    };
  });
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export interface Standing {
  playerId: string;
  nickname: string;
  matchPoints: number;
  totalScore: number;
  isFinished: boolean;
  finishedAt?: number;
}

export interface RankingEntry extends Standing {
  rank: number;
}

/** Sorts by 大比分 desc, then 累计小分 desc, then nickname; ties share a rank. */
export function rankPlayers(standings: Standing[]): RankingEntry[] {
  const sorted = standings.slice().sort((a, b) => {
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.nickname.localeCompare(b.nickname);
  });

  let currentRank = 1;
  return sorted.map((player, index) => {
    if (index > 0) {
      const prev = sorted[index - 1];
      if (player.matchPoints !== prev.matchPoints || player.totalScore !== prev.totalScore) {
        currentRank = index + 1;
      }
    }
    return { ...player, rank: currentRank };
  });
}

/**
 * Ids sharing first place on BOTH 大比分 and 累计小分.
 * Returns an empty array when there is a single outright leader.
 */
export function tiedLeaders(standings: Standing[]): string[] {
  if (standings.length < 2) return [];
  const ranked = rankPlayers(standings);
  const top = ranked.filter((r) => r.rank === 1);
  return top.length > 1 ? top.map((r) => r.playerId) : [];
}

// ---------------------------------------------------------------------------
// Overtime decider
// ---------------------------------------------------------------------------

export interface OvertimeCandidate {
  playerId: string;
  smallScore: number;
  /** Elapsed seconds inside the overtime round. */
  overtimeElapsedSeconds: number;
  /** Elapsed seconds across the whole series. */
  seriesElapsedSeconds: number;
}

export interface OvertimeResolution {
  winnerId: string | null;
  reason: 'small-score' | 'overtime-time' | 'series-time' | 'draw';
}

/**
 * Resolves the overtime decider: highest small score wins; if tied, the faster
 * overtime round wins; if still tied, the faster whole series wins; else a draw.
 * A tie is only ever declared when the top two contenders are indistinguishable
 * on all three axes.
 */
export function resolveOvertime(entries: OvertimeCandidate[]): OvertimeResolution {
  if (entries.length === 0) return { winnerId: null, reason: 'draw' };

  const best = (pick: (e: OvertimeCandidate) => number, candidates: OvertimeCandidate[]) => {
    let value = Infinity;
    for (const c of candidates) value = Math.min(value, pick(c));
    return candidates.filter((c) => pick(c) <= value + EPSILON);
  };

  const topScore = Math.max(...entries.map((e) => e.smallScore));
  let contenders = entries.filter((e) => e.smallScore >= topScore - EPSILON);
  if (contenders.length === 1) return { winnerId: contenders[0].playerId, reason: 'small-score' };

  contenders = best((e) => e.overtimeElapsedSeconds, contenders);
  if (contenders.length === 1) return { winnerId: contenders[0].playerId, reason: 'overtime-time' };

  contenders = best((e) => e.seriesElapsedSeconds, contenders);
  if (contenders.length === 1) return { winnerId: contenders[0].playerId, reason: 'series-time' };

  return { winnerId: null, reason: 'draw' };
}

// ---------------------------------------------------------------------------
// Pool sizing
// ---------------------------------------------------------------------------

/** The largest legal round count for a strategy over an exam bank. */
export function poolSize(
  availableYears: number[],
  strategy: 'random' | 'range' | 'custom',
  range?: { start?: number; end?: number },
  customYears?: number[]
): number {
  if (strategy === 'random') return availableYears.length;
  if (strategy === 'custom') {
    const unique = new Set(customYears ?? []);
    return availableYears.filter((y) => unique.has(y)).length;
  }
  const start = range?.start ?? Math.min(...availableYears);
  const end = range?.end ?? Math.max(...availableYears);
  return availableYears.filter((y) => y >= start && y <= end).length;
}

/** Fisher-Yates shuffle over a copy. */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Draws the ordered list of exam years for a series.
 * `custom` keeps the host's explicit ordering; the other strategies shuffle.
 */
export function drawScheduledYears(
  availableYears: number[],
  strategy: 'random' | 'range' | 'custom',
  totalRounds: number,
  options?: { range?: { start?: number; end?: number }; customYears?: number[]; rng?: () => number }
): { years: number[]; error?: string } {
  const rng = options?.rng ?? Math.random;
  let pool: number[];

  if (strategy === 'custom') {
    const requested = options?.customYears ?? [];
    const unique = Array.from(new Set(requested));
    if (unique.length !== requested.length) {
      return { years: [], error: '手动指定的考卷存在重复年份' };
    }
    const missing = unique.filter((y) => !availableYears.includes(y));
    if (missing.length > 0) {
      return { years: [], error: `题库中不存在这些年份：${missing.join('、')}` };
    }
    pool = unique;
  } else if (strategy === 'range') {
    const start = options?.range?.start;
    const end = options?.range?.end;
    if (start === undefined || end === undefined || start > end) {
      return { years: [], error: '年份区间的起止年份无效' };
    }
    pool = availableYears.filter((y) => y >= start && y <= end);
  } else {
    pool = availableYears.slice();
  }

  if (totalRounds < 1 || totalRounds > pool.length) {
    return { years: [], error: `可选真题共 ${pool.length} 套，轮数必须在 1 ~ ${pool.length} 之间` };
  }

  const ordered = strategy === 'custom' ? pool.slice(0, totalRounds) : shuffle(pool, rng).slice(0, totalRounds);
  return { years: ordered };
}
