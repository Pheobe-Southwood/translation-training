import React from 'react';
import { Loader2, Check, Hourglass, Eye, LogOut, Swords, Trophy } from 'lucide-react';
import type { PlayerState } from '../../shared/types.js';

interface PvpHudProps {
  players: PlayerState[];
  currentPlayerId: string;
  isSpectator?: boolean;
  spectatorCount?: number;
  secondsRemaining: number;
  roomCode: string;
  onExit?: () => void;
}

export const PvpHud: React.FC<PvpHudProps> = ({
  players,
  currentPlayerId,
  isSpectator = false,
  spectatorCount = 0,
  secondsRemaining,
  roomCode,
  onExit,
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(Math.max(0, seconds) / 60);
    const secs = Math.max(0, seconds) % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const isTimeLow = secondsRemaining <= 60 && secondsRemaining > 0;

  // Sort players: by totalScore descending, but keep stable order if tied (put currentPlayer first on tie)
  const rankedPlayers = [...players].sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (a.playerId === currentPlayerId) return -1;
    if (b.playerId === currentPlayerId) return 1;
    return 0;
  });

  // Compute rank numbers (1, 2, 3, 4 with ties)
  const playerRanks: Record<string, number> = {};
  let currentRank = 1;
  rankedPlayers.forEach((p, idx) => {
    if (idx > 0 && p.totalScore < rankedPlayers[idx - 1].totalScore) {
      currentRank = idx + 1;
    }
    playerRanks[p.playerId] = currentRank;
  });

  // Order for display: if user is a player, put user first on the left, then others by rank;
  // if spectator, order strictly by live rank.
  const displayPlayers = isSpectator
    ? rankedPlayers
    : [
        ...players.filter((p) => p.playerId === currentPlayerId),
        ...rankedPlayers.filter((p) => p.playerId !== currentPlayerId),
      ];

  const gridColsClass =
    displayPlayers.length <= 2
      ? 'grid-cols-2'
      : displayPlayers.length === 3
      ? 'grid-cols-1 sm:grid-cols-3'
      : 'grid-cols-2 lg:grid-cols-4';

  return (
    <div className="bg-swiss-black dark:bg-zinc-950 text-white border-b-2 border-swiss-black dark:border-zinc-800 sticky top-0 z-30 shadow-md transition-colors duration-150">
      <div className="max-w-7xl mx-auto px-2 sm:px-4 py-1.5 sm:py-2 space-y-1.5">
        {/* Top Row: Room Info, Timer, Spectator Status & Exit */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-1.5">
          {/* Left: Room Code & Mode Badge */}
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 bg-zinc-900 border border-zinc-700 px-1.5 sm:px-2 py-0.5 font-mono text-[10px] sm:text-xs font-bold text-zinc-200">
              <Swords className="w-3 h-3 text-swiss-red shrink-0" />
              <span>{roomCode}</span>
            </span>

            <span className="font-mono text-[10px] sm:text-xs font-bold px-1.5 py-0.5 bg-zinc-800 text-zinc-300 uppercase">
              {players.length}人局
            </span>

            {isSpectator && (
              <span className="inline-flex items-center gap-1 bg-blue-600 text-white px-1.5 sm:px-2 py-0.5 font-mono text-[10px] sm:text-xs font-bold uppercase">
                <Eye className="w-3 h-3 shrink-0" />
                <span>实时观战位</span>
              </span>
            )}

            {spectatorCount > 0 && !isSpectator && (
              <span
                className="inline-flex items-center gap-1 bg-zinc-900 border border-zinc-700 text-blue-400 px-1.5 py-0.5 font-mono text-[10px] sm:text-xs font-bold"
                title={`${spectatorCount} 位观众正在实时观战`}
              >
                <Eye className="w-3 h-3 shrink-0" />
                <span>{spectatorCount}</span>
              </span>
            )}
          </div>

          {/* Center: Match Countdown Clock */}
          <div className="flex items-center gap-1.5 font-mono">
            <span className="text-[10px] text-zinc-400 uppercase hidden md:inline">TIME</span>
            <div
              className={`flex items-center justify-center text-xs sm:text-base font-black px-2 sm:px-2.5 py-0.5 border ${
                isTimeLow
                  ? 'bg-swiss-red border-swiss-red text-white animate-pulse'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-100'
              }`}
            >
              <span>{formatTime(secondsRemaining)}</span>
            </div>
          </div>

          {/* Right: Spectator Count (if spectator) & Exit Button */}
          <div className="flex items-center gap-2">
            {isSpectator && spectatorCount > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400">
                <Eye className="w-3 h-3 text-blue-400" />
                {spectatorCount} 人同看
              </span>
            )}
            {onExit && (
              <button
                onClick={onExit}
                className="inline-flex items-center gap-1 px-2 py-0.5 border border-zinc-700 hover:border-zinc-400 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-mono text-[10px] sm:text-xs font-bold uppercase transition-colors"
                title={isSpectator ? '退出观战' : '离开对局'}
              >
                <LogOut className="w-3 h-3" />
                <span>{isSpectator ? '退出观战' : '退出'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Bottom Row: Dynamic 2-4 Player Cards */}
        <div className={`grid ${gridColsClass} gap-1.5 sm:gap-2.5`}>
          {displayPlayers.map((player) => {
            const isMe = player.playerId === currentPlayerId && !isSpectator;
            const rank = playerRanks[player.playerId] || 1;

            return (
              <div
                key={player.playerId}
                className={`flex items-center gap-1.5 sm:gap-2.5 p-1.5 sm:px-2.5 sm:py-1.5 border transition-colors overflow-hidden ${
                  isMe
                    ? 'bg-zinc-900/95 border-swiss-red/80'
                    : 'bg-zinc-900/50 border-zinc-800'
                }`}
              >
                {/* Score Box */}
                <div
                  className={`w-7 h-7 sm:w-8 sm:h-8 shrink-0 flex flex-col items-center justify-center font-mono font-black text-xs sm:text-sm border ${
                    isMe
                      ? 'bg-white text-swiss-black border-white'
                      : rank === 1 && player.totalScore > 0
                      ? 'bg-amber-500 text-black border-amber-400'
                      : 'bg-zinc-800 text-white border-zinc-700'
                  }`}
                >
                  <span>{player.totalScore.toFixed(1)}</span>
                </div>

                {/* Nickname + Badges + 5 Progress Dots */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="font-mono text-[10px] font-black text-zinc-400 shrink-0">
                        #{rank}
                      </span>
                      <span className="font-bold text-[11px] sm:text-xs tracking-tight truncate text-zinc-100">
                        {player.nickname}
                      </span>
                      {isMe && (
                        <span className="text-[8px] sm:text-[9px] bg-swiss-red px-1 py-0 font-mono font-bold uppercase shrink-0 text-white">
                          YOU
                        </span>
                      )}
                      {player.isOnline === false && (
                        <span className="text-[8px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1 font-mono shrink-0">
                          离线
                        </span>
                      )}
                    </div>

                    {rank === 1 && player.totalScore > 0 && (
                      <Trophy className="w-3 h-3 text-amber-400 shrink-0 hidden xs:inline" />
                    )}
                  </div>

                  {/* 5 Segment Indicator Dots */}
                  <div className="flex items-center gap-0.5 sm:gap-1 mt-1">
                    {[0, 1, 2, 3, 4].map((idx) => {
                      const sub = player.submissions[idx];
                      const isCurrent =
                        player.currentSegmentIndex === idx && !player.isFinished;

                      return (
                        <div
                          key={idx}
                          title={`${player.nickname} 第 ${idx + 1} 题：${
                            sub?.gradingStatus === 'waiting_pair'
                              ? '已提交，等待并列评分'
                              : sub?.gradingStatus === 'grading'
                              ? 'AI 评分中'
                              : sub?.gradingStatus === 'graded'
                              ? `已出分 +${sub.gradingResult?.score.toFixed(1)}`
                              : isCurrent
                              ? '正在作答'
                              : '未开始'
                          }`}
                          className={`w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 flex items-center justify-center font-mono text-[8px] sm:text-[9px] border ${
                            sub?.gradingStatus === 'graded'
                              ? 'bg-emerald-500 border-emerald-400 text-white font-bold'
                              : sub?.gradingStatus === 'grading'
                              ? 'bg-amber-400 border-amber-300 text-black animate-pulse'
                              : sub?.gradingStatus === 'waiting_pair'
                              ? 'bg-blue-500 border-blue-400 text-white animate-pulse'
                              : isCurrent
                              ? isMe
                                ? 'bg-white text-black font-bold border-white'
                                : 'bg-zinc-300 text-black font-bold border-zinc-200'
                              : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                          }`}
                        >
                          {sub?.gradingStatus === 'grading' ? (
                            <Loader2 className="w-2 h-2 animate-spin" />
                          ) : sub?.gradingStatus === 'waiting_pair' ? (
                            <Hourglass className="w-2 h-2" />
                          ) : sub?.gradingStatus === 'graded' ? (
                            <Check className="w-2 h-2 stroke-[3]" />
                          ) : (
                            idx + 1
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
