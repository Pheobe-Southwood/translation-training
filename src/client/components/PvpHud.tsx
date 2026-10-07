import React, { useEffect, useState } from 'react';
import { Check, Eye, LogOut, Swords, Trophy, WifiOff } from 'lucide-react';
import type { PvpRoomSummary, RoundDetail } from '../../shared/types.js';

interface PvpHudProps {
  summary: PvpRoomSummary;
  currentPlayerId: string;
  isSpectator?: boolean;
  spectatorCount?: number;
  /** Detail of the round this client is looking at, used for the finer dot states. */
  roundDetail?: RoundDetail;
  onExit?: () => void;
}

/**
 * Multi-round arena header.
 *
 * Every player owns their own countdown, so the HUD renders one clock per player
 * instead of the single shared match clock the single-round version had. All clocks
 * are derived from each player's absolute `roundDeadlineAt`, which the server owns.
 */
export const PvpHud: React.FC<PvpHudProps> = ({
  summary,
  currentPlayerId,
  isSpectator = false,
  spectatorCount = 0,
  roundDetail,
  onExit,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (seconds: number) => {
    const safe = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const remainingFor = (deadlineAt?: number) =>
    deadlineAt ? Math.max(0, Math.ceil((deadlineAt - now) / 1000)) : undefined;

  const me = summary.players.find((p) => p.playerId === currentPlayerId);
  const myRemaining = remainingFor(me?.roundDeadlineAt);
  const isTimeLow = myRemaining !== undefined && myRemaining <= 60;

  // Order by 大比分 then 累计小分, keeping "me" on the left when I am a player.
  const rankedPlayers = [...summary.players].sort((a, b) => {
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    return a.nickname.localeCompare(b.nickname);
  });

  const playerRanks: Record<string, number> = {};
  let currentRank = 1;
  rankedPlayers.forEach((p, idx) => {
    if (idx > 0) {
      const prev = rankedPlayers[idx - 1];
      if (p.matchPoints !== prev.matchPoints || p.totalScore !== prev.totalScore) currentRank = idx + 1;
    }
    playerRanks[p.playerId] = currentRank;
  });

  const displayPlayers = isSpectator
    ? rankedPlayers
    : [
        ...summary.players.filter((p) => p.playerId === currentPlayerId),
        ...rankedPlayers.filter((p) => p.playerId !== currentPlayerId),
      ];

  const gridColsClass =
    displayPlayers.length <= 2
      ? 'grid-cols-2'
      : displayPlayers.length === 3
        ? 'grid-cols-1 sm:grid-cols-3'
        : 'grid-cols-2 lg:grid-cols-4';

  const totalRounds = summary.config.totalRounds;
  const viewingRound = roundDetail?.roundIndex;

  return (
    <div className="bg-swiss-black dark:bg-zinc-950 text-white border-b-2 border-swiss-black dark:border-zinc-800 sticky top-0 z-30 shadow-md transition-colors duration-150">
      <div className="max-w-7xl mx-auto px-2 sm:px-4 py-1.5 sm:py-2 space-y-1.5">
        {/* Top Row: Room Info, Round Badge, Own Clock & Exit */}
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-1.5">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 bg-zinc-900 border border-zinc-700 px-1.5 sm:px-2 py-0.5 font-mono text-[10px] sm:text-xs font-bold text-zinc-200">
              <Swords className="w-3 h-3 text-swiss-red shrink-0" />
              <span>{summary.roomCode}</span>
            </span>

            <span className="font-mono text-[10px] sm:text-xs font-bold px-1.5 py-0.5 bg-zinc-800 text-zinc-300 uppercase whitespace-nowrap">
              {summary.players.length}人 · {totalRounds}轮
            </span>

            {roundDetail?.isOvertime && (
              <span className="font-mono text-[10px] sm:text-xs font-bold px-1.5 py-0.5 bg-swiss-red text-white whitespace-nowrap">
                加赛局
              </span>
            )}

            {isSpectator && (
              <span className="inline-flex items-center gap-1 bg-blue-600 text-white px-1.5 sm:px-2 py-0.5 font-mono text-[10px] sm:text-xs font-bold uppercase whitespace-nowrap">
                <Eye className="w-3 h-3 shrink-0" />
                <span className="hidden sm:inline">实时观战位</span>
                <span className="sm:hidden">观战</span>
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

          <div className="flex items-center gap-1.5 font-mono">
            {!isSpectator && me && (
              <>
                <span className="text-[10px] text-zinc-400 uppercase hidden md:inline">
                  R{(me.currentRoundIndex ?? 0) + 1}
                  {me.hasFinishedAllRounds ? ' 完赛' : ''}
                </span>
                <div
                  className={`flex items-center justify-center text-xs sm:text-base font-black px-2 sm:px-2.5 py-0.5 border ${
                    me.hasFinishedAllRounds || me.phase !== 'playing'
                      ? 'bg-zinc-900 border-zinc-700 text-zinc-400'
                      : isTimeLow
                        ? 'bg-swiss-red border-swiss-red text-white animate-pulse'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-100'
                  }`}
                >
                  <span>
                    {me.phase === 'playing' && myRemaining !== undefined
                      ? formatTime(myRemaining)
                      : me.phase === 'left'
                        ? '已退赛'
                        : '已交卷'}
                  </span>
                </div>
              </>
            )}
          </div>

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

        {/* Bottom Row: per-player cards, each with its own independent clock */}
        <div className={`grid ${gridColsClass} gap-1.5 sm:gap-2.5`}>
          {displayPlayers.map((player) => {
            const isMe = player.playerId === currentPlayerId && !isSpectator;
            const rank = playerRanks[player.playerId] || 1;
            const remaining = remainingFor(player.roundDeadlineAt);
            const playerLow = remaining !== undefined && remaining <= 60;
            const isViewingThisPlayer = viewingRound === player.currentRoundIndex;

            // Fine-grained dot states are only known for the player whose round we hold.
            const detailPlayer = isMe
              ? roundDetail?.players.find((p) => p.playerId === player.playerId)
              : undefined;

            return (
              <div
                key={player.playerId}
                className={`flex items-center gap-1.5 sm:gap-2.5 p-1.5 sm:px-2.5 sm:py-1.5 border transition-colors overflow-hidden ${
                  isMe ? 'bg-zinc-900/95 border-swiss-red/80' : 'bg-zinc-900/50 border-zinc-800'
                }`}
              >
                <div className="flex flex-col items-center gap-0.5 shrink-0">
                  <div
                    className={`w-7 h-7 sm:w-8 sm:h-8 flex flex-col items-center justify-center font-mono font-black text-xs sm:text-sm border ${
                      isMe
                        ? 'bg-white text-swiss-black border-white'
                        : rank === 1 && player.matchPoints > 0
                          ? 'bg-amber-500 text-black border-amber-400'
                          : 'bg-zinc-800 text-white border-zinc-700'
                    }`}
                    title={`大比分 ${player.matchPoints}`}
                  >
                    <span>{player.matchPoints.toFixed(1)}</span>
                  </div>
                  <span className="font-mono text-[8px] text-zinc-500 leading-none">MP</span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="font-mono text-[10px] font-black text-zinc-400 shrink-0">#{rank}</span>
                      <span className="font-bold text-[11px] sm:text-xs tracking-tight truncate text-zinc-100">
                        {player.nickname}
                      </span>
                      {isMe && (
                        <span className="text-[8px] sm:text-[9px] bg-swiss-red px-1 py-0 font-mono font-bold uppercase shrink-0 text-white">
                          YOU
                        </span>
                      )}
                      {player.isOnline === false && (
                        <WifiOff className="w-2.5 h-2.5 text-amber-400 shrink-0" aria-label="离线" />
                      )}
                      {player.phase === 'left' && (
                        <span className="text-[8px] bg-zinc-700 text-zinc-300 px-1 font-mono shrink-0">
                          退赛
                        </span>
                      )}
                    </div>

                    {rank === 1 && player.matchPoints > 0 && (
                      <Trophy className="w-3 h-3 text-amber-400 shrink-0 hidden xs:inline" />
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <span
                      className={`font-mono text-[9px] sm:text-[10px] font-bold ${
                        isViewingThisPlayer ? 'text-zinc-300' : 'text-zinc-500'
                      }`}
                    >
                      R{player.currentRoundIndex + 1}-Q{Math.min(player.currentSegmentIndex + 1, 5)}
                      <span className="text-zinc-500 ml-1">小分 {player.totalScore.toFixed(1)}</span>
                    </span>
                    <span
                      className={`font-mono text-[9px] sm:text-[10px] font-bold px-1 border ${
                        player.phase !== 'playing'
                          ? 'text-zinc-500 border-zinc-800'
                          : playerLow
                            ? 'text-white bg-swiss-red border-swiss-red animate-pulse'
                            : 'text-zinc-300 border-zinc-700'
                      }`}
                      title={`${player.nickname} 本轮剩余时间`}
                    >
                      {player.phase !== 'playing'
                        ? player.hasFinishedAllRounds
                          ? '完赛'
                          : '—'
                        : remaining !== undefined
                          ? formatTime(remaining)
                          : '--:--'}
                    </span>
                  </div>

                  <div className="flex items-center gap-0.5 sm:gap-1 mt-1">
                    {[0, 1, 2, 3, 4].map((idx) => {
                      const sub = detailPlayer?.submissions?.[idx];
                      const answered = idx < player.answeredCount;
                      const isCurrent = player.currentSegmentIndex === idx && player.phase === 'playing';

                      return (
                        <div
                          key={idx}
                          title={`${player.nickname} 第 ${idx + 1} 题：${
                            sub?.gradingStatus === 'grading'
                              ? 'AI 评分中'
                              : sub?.gradingStatus === 'graded'
                                ? `已出分 +${(sub.gradingResult?.score ?? 0).toFixed(1)}`
                                : answered
                                  ? '已提交'
                                  : isCurrent
                                    ? '正在作答'
                                    : '未作答'
                          }`}
                          className={`w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 flex items-center justify-center font-mono text-[8px] sm:text-[9px] border ${
                            sub?.gradingStatus === 'graded'
                              ? 'bg-emerald-500 border-emerald-400 text-white font-bold'
                              : sub?.gradingStatus === 'grading'
                                ? 'bg-amber-400 border-amber-300 text-black animate-pulse'
                                : answered
                                  ? 'bg-blue-500 border-blue-400 text-white'
                                  : isCurrent
                                    ? isMe
                                      ? 'bg-white text-black font-bold border-white'
                                      : 'bg-zinc-300 text-black font-bold border-zinc-200'
                                    : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                          }`}
                        >
                          {sub?.gradingStatus === 'grading' ? (
                            <span className="animate-pulse">…</span>
                          ) : answered ? (
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
