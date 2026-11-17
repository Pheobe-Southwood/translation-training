export type TranslationDirection = 'en-zh' | 'zh-en';

/**
 * Which question bank a paper belongs to.
 *
 * - `translation` — the original 2002–2026 英译汉/中译英 真题卷 (5 segments);
 * - `cloze`       — 完型填空 文章里挑出的长难句 (3–5 segments, English→Chinese only);
 * - `reading`     — 阅读理解 Text 1–4 里挑出的长难句 (3–5 segments, English→Chinese only).
 *
 * Only `translation` has a Chinese reference bank, so only it offers 中译英.
 */
export type ExamBank = 'translation' | 'cloze' | 'reading';

export interface TranslationExam {
  /**
   * Canonical identifier, e.g. `2024-translation`, `2004-cloze`, `2004-reading-2`.
   * A `year` alone is no longer unique: 2004 now has six papers.
   */
  examId: string;
  /** Retained for older clients/records; always equal to `examId`. */
  id: string;
  bank: ExamBank;
  /** Human label for the paper inside its bank, e.g. `完型填空`, `阅读理解 Text 2`. */
  partLabel: string;
  year: number; // 2004
  title: string;
  /** `translationSegments.length * 2` — 3 segments => 6, 5 segments => 10. */
  maxScore: number;
  contentMarkdown: string; // Full passage markdown
  /** Target sentences: 5 for the translation bank, 3–5 for cloze/reading. */
  translationSegments: string[];
  direction?: TranslationDirection;
}

/** One row of the paper picker on the homepage / PVP lobby. */
export interface ExamCatalogEntry {
  examId: string;
  bank: ExamBank;
  year: number;
  partLabel: string;
  title: string;
  segmentCount: number;
  maxScore: number;
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

export interface SegmentSubmission {
  segmentIndex: number;
  originalText: string;
  studentAnswer: string;
  gradingStatus: 'idle' | 'waiting_pair' | 'grading' | 'graded' | 'error';
  gradingResult?: GradingResult;
  comparativeAnalysis?: string;
  error?: string;
  submittedAt?: number;
}

export type RoomStatus = 'WAITING' | 'READY' | 'COUNTDOWN' | 'IN_PROGRESS' | 'FINISHED';

export interface SpectatorState {
  playerId: string;
  nickname: string;
  isOnline?: boolean;
  /** Seat created from a shareable read-only spectate link (no account behind it). */
  isAnonymous?: boolean;
  joinedAt: number;
}

export interface PlayerRanking {
  playerId: string;
  nickname: string;
  totalScore: number;
  rank: number;
  isFinished: boolean;
  finishedAt?: number;
}

export interface PlayerState {
  playerId: string;
  nickname: string;
  isHost: boolean;
  isReady: boolean;
  isOnline?: boolean;
  lastActiveAt?: number;
  currentSegmentIndex: number; // 0..4
  submissions: Record<number, SegmentSubmission>;
  totalScore: number;
  isFinished: boolean;
  finishedAt?: number;
}

export interface PvpRoomSummary {
  roomCode: string;
  year: number;
  examId: string;
  bank: ExamBank;
  partLabel: string;
  direction?: TranslationDirection;
  durationMinutes: number;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  spectatorCount: number;
}

export interface PvpRoomState {
  roomCode: string;
  year: number;
  /** Canonical paper id; `year` alone is ambiguous across banks. */
  examId: string;
  bank: ExamBank;
  partLabel: string;
  direction: TranslationDirection;
  exam: TranslationExam;
  durationMinutes: number; // default 15
  status: RoomStatus;
  maxPlayers: number; // 2, 3, 4
  allowSpectators?: boolean;
  /**
   * Signed, expiring credential for the shareable read-only spectate link
   * (`/#/pvp/<CODE>?spectate=1&t=<ticket>`). Possession of the ticket grants
   * "watch this room" and nothing else, so watching needs no account.
   */
  spectateTicket?: string;
  createdAt?: number;
  startedAt?: number;
  countdownEndTime?: number;
  matchEndTime?: number;
  players: Record<string, PlayerState>;
  spectators: Record<string, SpectatorState>;
  winnerId?: string | 'draw';
  rankings?: PlayerRanking[];
}

export interface HistorySessionRecord {
  id: string;
  type: 'solo' | 'pvp';
  year: number;
  /** Canonical paper id; absent on records written before the passage banks existed. */
  examId?: string;
  bank?: ExamBank;
  partLabel?: string;
  direction?: TranslationDirection;
  timestamp: number;
  totalScore: number;
  timeSpentSeconds: number;
  submissions: SegmentSubmission[];
  pvpDetails?: {
    opponentNickname: string;
    opponentScore: number;
    outcome: 'win' | 'loss' | 'draw';
    rank?: number;
    playerCount?: number;
    leaderboard?: Array<{ nickname: string; score: number; rank: number }>;
  };
}

export interface AuthUser {
  id: string;
  username: string;
  nickname: string;
}

