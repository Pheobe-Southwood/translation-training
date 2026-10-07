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
  durationMinutes: number;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  spectatorCount: number;
}

export interface PvpRoomState {
  roomCode: string;
  year: number;
  exam: TranslationExam;
  durationMinutes: number; // default 15
  status: RoomStatus;
  maxPlayers: number; // 2, 3, 4
  allowSpectators?: boolean;
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

