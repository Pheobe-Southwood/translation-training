// ---------------------------------------------------------------------------
// 1. Examination & content
// ---------------------------------------------------------------------------

export interface TranslationExam {
  id: string; // e.g. "2024-translation"
  year: number; // 2024
  title: string;
  maxScore: number; // 10
  contentMarkdown: string; // Full passage markdown
  translationSegments: string[]; // 5 sentences to translate
}

export interface ScoringPointBreakdown {
  point: string; // The grammatical structure, sense group or key phrase
  score: number; // 0 or 0.5
  analysis: string; // Detailed rationale
}

export interface GradingResult {
  score: number; // 0, 0.5, 1.0, 1.5, 2.0
  points_breakdown: ScoringPointBreakdown[];
  distortion_deduction: number;
  fluency_deduction: number;
  critique: string;
  reference_translation: string;
  gradedAt: number; // timestamp
}

export type GradingStatus = 'idle' | 'grading' | 'graded' | 'error';

export interface SegmentSubmission {
  segmentIndex: number;
  originalText: string;
  studentAnswer: string;
  gradingStatus: GradingStatus;
  gradingResult?: GradingResult;
  comparativeAnalysis?: string;
  error?: string;
  submittedAt?: number;
}

// ---------------------------------------------------------------------------
// 2. Room configuration
// ---------------------------------------------------------------------------

/** How the N exam papers of a multi-round series are drawn. */
export type DrawStrategy = 'random' | 'range' | 'custom';

export interface RoomConfig {
  /** Number of rounds N. Bounded by the size of the pool the strategy yields. */
  totalRounds: number;
  /** Per-round countdown, in minutes. 10 / 15 / 20. */
  durationMinutes: number;
  /** 2, 3 or 4. */
  maxPlayers: number;
  allowSpectators: boolean;
  drawStrategy: DrawStrategy;
  /** Inclusive bounds, used when drawStrategy === 'range'. */
  rangeStart?: number;
  rangeEnd?: number;
  /** Explicitly ordered year list, used when drawStrategy === 'custom'. */
  customYears?: number[];
}

// ---------------------------------------------------------------------------
// 3. Room / round state (authoritative, server-side only)
// ---------------------------------------------------------------------------

export type RoomStatus =
  | 'WAITING'
  | 'READY'
  | 'COUNTDOWN'
  | 'IN_PROGRESS'
  | 'OVERTIME_VOTE'
  | 'OVERTIME'
  | 'FINISHED';

/**
 * playing  — still answering rounds
 * awaiting — finished all N rounds; rendered like a spectator, may be pulled back for overtime
 * left     — quit mid-match; remaining rounds were auto-filled with timeout zeros
 */
export type PlayerPhase = 'playing' | 'awaiting' | 'left';

export interface PlayerState {
  playerId: string;
  nickname: string;
  isHost: boolean;
  isReady: boolean;
  isOnline?: boolean;
  lastActiveAt?: number;
  phase: PlayerPhase;
  /** 0-based; equals config.totalRounds while playing the overtime decider. */
  currentRoundIndex: number;
  /** Lowest unanswered segment of the current round (drives the "R2-03" HUD label). */
  currentSegmentIndex: number;
  /** Absolute epoch ms. The server is the only authority on the countdown. */
  roundStartedAt?: number;
  roundDeadlineAt?: number;
  /** Segment indices already submitted in the current round (free ordering allowed). */
  answeredSegments: number[];
  /** Σ match points (大比分). */
  matchPoints: number;
  /** Σ round small scores (累计小分). */
  totalScore: number;
  roundsCompleted: number;
  hasFinishedAllRounds: boolean;
  finishedAt?: number;
}

export interface SpectatorState {
  playerId: string;
  nickname: string;
  isOnline?: boolean;
  joinedAt: number;
}

export interface PlayerRanking {
  playerId: string;
  nickname: string;
  totalScore: number; // 累计小分
  matchPoints: number; // 大比分
  rank: number;
  isFinished: boolean;
  finishedAt?: number;
}

export interface RoundPlayerState {
  playerId: string;
  /** segmentIndex (0..4) -> submission. Never null once the round is complete. */
  submissions: Record<number, SegmentSubmission>;
  roundCompletedAt?: number;
  /** Own elapsed time in this round, in seconds. */
  elapsedSeconds?: number;
  /** config.durationMinutes * 60 - elapsedSeconds, floored at 0. */
  remainingSeconds?: number;
  timedOut: boolean;
  /** Σ of the 5 segment scores for this round. */
  smallScore: number;
}

export type RoundBatchStatus = 'waiting' | 'grading' | 'graded' | 'failed';

/** One batched paired-evaluation call covering every player's answer for (round, segment). */
export interface RoundBatchState {
  segmentIndex: number;
  status: RoundBatchStatus;
  attempts: number;
  startedAt?: number;
}

export interface RoundScoreEntry {
  playerId: string;
  smallScore: number;
  baselineScore: number; // mean of the OTHER players' small scores
  deltaS: number;
  pointsPart: number; // P_i
  remainingSeconds: number;
  baselineRemaining: number; // mean of the OTHER players' remaining seconds
  deltaT: number;
  timePart: number; // Q_i
  matchPointsDelta: number; // M_i, after the final-round multiplier
}

export interface RoundState {
  roundIndex: number; // 0..totalRounds-1, or totalRounds for the overtime decider
  year: number;
  isOvertime: boolean;
  exam: TranslationExam;
  startedAt: number;
  players: Record<string, RoundPlayerState>;
  batches: Record<number, RoundBatchState>;
  settled: boolean;
  settledAt?: number;
  scoreEntries?: RoundScoreEntry[];
  /** Only present on the overtime decider: how the +1.0 was decided. */
  overtimeResolution?: {
    winnerId: string | null;
    reason: 'small-score' | 'overtime-time' | 'series-time' | 'draw';
  };
}

export interface OvertimeState {
  participants: string[];
  deadlineAt: number;
  votes: Record<string, 'yes' | 'no'>;
  startedAt?: number;
  resolvedReason?: string;
}

/** Full room state. Never broadcast wholesale — see PvpRoomSummary / RoundDetail. */
export interface PvpRoomState {
  roomCode: string;
  config: RoomConfig;
  status: RoomStatus;
  /** Drawn once at match start; index i is round i's year. */
  scheduledYears: number[];
  overtimeYear?: number;
  /** Length === config.totalRounds, plus one entry if the overtime decider ran. */
  rounds: RoundState[];
  players: Record<string, PlayerState>;
  spectators: Record<string, SpectatorState>;
  createdAt?: number;
  startedAt?: number;
  countdownEndTime?: number;
  overtime?: OvertimeState;
  winnerId?: string | 'draw';
  rankings?: PlayerRanking[];
  snapshotAt?: number;
}

// ---------------------------------------------------------------------------
// 4. Broadcast payloads
// ---------------------------------------------------------------------------

export interface PvpRoomSummaryPlayer {
  playerId: string;
  nickname: string;
  isHost: boolean;
  isReady: boolean;
  isOnline?: boolean;
  phase: PlayerPhase;
  currentRoundIndex: number;
  currentSegmentIndex: number;
  roundDeadlineAt?: number;
  /** Segments already submitted in the current round (free ordering allowed). */
  answeredCount: number;
  matchPoints: number;
  totalScore: number;
  roundsCompleted: number;
  hasFinishedAllRounds: boolean;
  finishedAt?: number;
}

export interface PvpRoomSummaryRound {
  roundIndex: number;
  /** null until the round has started — the schedule is revealed one round at a time. */
  year: number | null;
  isOvertime: boolean;
  settled: boolean;
  startedAt?: number;
  gradedSegments: number;
  totalSegments: number;
}

export interface PvpOvertimeSummary {
  participants: string[];
  deadlineAt: number;
  votes: Record<string, 'yes' | 'no'>;
  status: 'voting' | 'running' | 'resolved';
}

export interface PvpRoomSummary {
  roomCode: string;
  status: RoomStatus;
  config: RoomConfig;
  currentRoundIndex: number;
  createdAt?: number;
  startedAt?: number;
  countdownEndTime?: number;
  players: PvpRoomSummaryPlayer[];
  spectators: Array<{ playerId: string; nickname: string; isOnline?: boolean }>;
  rounds: PvpRoomSummaryRound[];
  overtime?: PvpOvertimeSummary;
  winnerId?: string | 'draw';
  rankings?: PlayerRanking[];
}

export interface RoundDetailPlayer {
  playerId: string;
  nickname: string;
  isHost: boolean;
  isOnline?: boolean;
  phase: PlayerPhase;
  submissions: Record<number, SegmentSubmission>;
  roundCompletedAt?: number;
  elapsedSeconds?: number;
  remainingSeconds?: number;
  timedOut: boolean;
  smallScore: number;
  matchPoints: number;
  totalScore: number;
  currentSegmentIndex: number;
}

export interface RoundDetail {
  roundIndex: number;
  year: number;
  isOvertime: boolean;
  exam: TranslationExam;
  startedAt: number;
  settled: boolean;
  scoreEntries?: RoundScoreEntry[];
  players: RoundDetailPlayer[];
  /** Players whose answer text / critique was withheld from this recipient. */
  withheldPlayerIds: string[];
}

// ---------------------------------------------------------------------------
// 5. History / persistence
// ---------------------------------------------------------------------------

export interface HistoryRoundRecord {
  roundIndex: number;
  year: number;
  isOvertime: boolean;
  smallScore: number;
  matchPointsDelta: number;
  matchPointsAfter: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  timedOut: boolean;
  submissions: SegmentSubmission[];
  scoreEntries?: RoundScoreEntry[];
}

export interface HistoryPvpDetails {
  opponentNickname: string;
  opponentScore: number;
  outcome: 'win' | 'loss' | 'draw';
  rank?: number;
  playerCount?: number;
  leaderboard?: Array<{ nickname: string; score: number; rank: number; matchPoints?: number }>;
  finalMatchPoints?: number;
}

export interface HistorySessionRecord {
  id: string;
  type: 'solo' | 'pvp';
  year: number; // first round's year (multi-round) or the single exam year
  timestamp: number;
  totalScore: number; // 累计小分
  timeSpentSeconds: number;
  submissions: SegmentSubmission[]; // flattened across rounds, for legacy rendering
  /** Added for multi-round series. Absent on legacy records. */
  roundCount?: number;
  matchPoints?: number;
  wentOvertime?: boolean;
  rounds?: HistoryRoundRecord[];
  pvpDetails?: HistoryPvpDetails;
}

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
}
