import React from 'react';
import { Timer, Swords, Loader2, Check, Hourglass } from 'lucide-react';
import type { PlayerState } from '../../shared/types.js';

interface PvpHudProps {
  myPlayer: PlayerState;
  opponentPlayer?: PlayerState;
  secondsRemaining: number;
  roomCode: string;
}

export const PvpHud: React.FC<PvpHudProps> = ({
  myPlayer,
  opponentPlayer,
  secondsRemaining,
  roomCode,
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(Math.max(0, seconds) / 60);
    const secs = Math.max(0, seconds) % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const isTimeLow = secondsRemaining <= 60 && secondsRemaining > 0;

  return (
    <div className="bg-swiss-black dark:bg-zinc-950 text-white border-b-2 border-swiss-black dark:border-zinc-800 sticky top-0 z-30 shadow-md transition-colors duration-150">
      <div className="max-w-7xl mx-auto px-1.5 sm:px-4 py-1.5 sm:py-2">
        <div className="grid grid-cols-12 items-center gap-1 sm:gap-2">
          {/* Left Column: Player 1 (You) - 5 cols */}
          <div className="col-span-5 flex items-center gap-1 sm:gap-2.5 overflow-hidden">
            <div className="w-7 h-7 xs:w-8 xs:h-8 sm:w-9 sm:h-9 bg-white dark:bg-zinc-100 text-swiss-black dark:text-zinc-950 shrink-0 flex items-center justify-center font-mono font-black text-xs sm:text-base border border-white dark:border-zinc-200">
              {myPlayer.totalScore.toFixed(1)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="font-bold text-[11px] sm:text-sm tracking-tight truncate text-zinc-100">
                  {myPlayer.nickname}
                </span>
                <span className="text-[8px] sm:text-[9px] bg-swiss-red px-1 py-0 font-mono font-semibold uppercase shrink-0">
                  YOU
                </span>
              </div>
              {/* 5 Indicator dots */}
              <div className="flex items-center gap-0.5 sm:gap-1 mt-0.5">
                {[0, 1, 2, 3, 4].map((idx) => {
                  const sub = myPlayer.submissions[idx];
                  const isCurrent = myPlayer.currentSegmentIndex === idx && !myPlayer.isFinished;
                  return (
                    <div
                      key={idx}
                      title={`第 ${idx + 1} 题：${
                        sub?.gradingStatus === 'waiting_pair'
                          ? '等待对手提交以并列评分'
                          : sub?.gradingStatus === 'grading'
                          ? 'AI并列评分中'
                          : sub?.gradingStatus === 'graded'
                          ? `已得分 +${sub.gradingResult?.score.toFixed(1)}`
                          : '未作答'
                      }`}
                      className={`w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 shrink-0 flex items-center justify-center font-mono text-[7px] xs:text-[8px] sm:text-[9px] border ${
                        sub?.gradingStatus === 'graded'
                          ? 'bg-emerald-500 border-emerald-400 text-white font-bold'
                          : sub?.gradingStatus === 'grading'
                          ? 'bg-amber-400 border-amber-300 text-black animate-pulse'
                          : sub?.gradingStatus === 'waiting_pair'
                          ? 'bg-blue-500 border-blue-400 text-white animate-pulse'
                          : isCurrent
                          ? 'bg-white text-black font-bold border-white'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                      }`}
                    >
                      {sub?.gradingStatus === 'grading' ? (
                        <Loader2 className="w-1.5 h-1.5 sm:w-2 sm:h-2 animate-spin" />
                      ) : sub?.gradingStatus === 'waiting_pair' ? (
                        <Hourglass className="w-1.5 h-1.5 sm:w-2 sm:h-2" />
                      ) : sub?.gradingStatus === 'graded' ? (
                        <Check className="w-1.5 h-1.5 sm:w-2 sm:h-2 stroke-[3]" />
                      ) : (
                        idx + 1
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Center Column: Timer & Room Code - 2 cols */}
          <div className="col-span-2 flex flex-col items-center justify-center font-mono px-0.5">
            <span className="text-[7px] xs:text-[8px] sm:text-[9px] text-zinc-400 uppercase tracking-tighter truncate max-w-full">
              {roomCode}
            </span>
            <div
              className={`flex items-center justify-center text-[10px] xs:text-xs sm:text-base font-black px-1 sm:px-1.5 py-0.5 border ${
                isTimeLow
                  ? 'bg-swiss-red border-swiss-red text-white animate-pulse'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-100'
              }`}
            >
              <span>{formatTime(secondsRemaining)}</span>
            </div>
          </div>

          {/* Right Column: Player 2 (Opponent) - 5 cols */}
          <div className="col-span-5 flex items-center justify-end gap-1 sm:gap-2.5 overflow-hidden">
            <div className="min-w-0 flex-1 text-right">
              <div className="flex items-center justify-end gap-1">
                <span className="text-[8px] sm:text-[9px] bg-zinc-700 px-1 py-0 font-mono font-semibold uppercase shrink-0">
                  RIVAL
                </span>
                <span className="font-bold text-[11px] sm:text-sm tracking-tight truncate text-zinc-100">
                  {opponentPlayer ? opponentPlayer.nickname : '对手'}
                </span>
              </div>
              {/* Opponent 5 Indicator dots */}
              <div className="flex items-center justify-end gap-0.5 sm:gap-1 mt-0.5">
                {[0, 1, 2, 3, 4].map((idx) => {
                  const sub = opponentPlayer?.submissions[idx];
                  const isCurrent =
                    opponentPlayer &&
                    opponentPlayer.currentSegmentIndex === idx &&
                    !opponentPlayer.isFinished;
                  return (
                    <div
                      key={idx}
                      title={`对手第 ${idx + 1} 题：${sub?.gradingStatus || '未开始'}`}
                      className={`w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 shrink-0 flex items-center justify-center font-mono text-[7px] xs:text-[8px] sm:text-[9px] border ${
                        sub?.gradingStatus === 'graded'
                          ? 'bg-emerald-500 border-emerald-400 text-white font-bold'
                          : sub?.gradingStatus === 'grading'
                          ? 'bg-amber-400 border-amber-300 text-black animate-pulse'
                          : sub?.gradingStatus === 'waiting_pair'
                          ? 'bg-blue-500 border-blue-400 text-white animate-pulse'
                          : isCurrent
                          ? 'bg-zinc-400 text-black font-bold border-zinc-300'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                      }`}
                    >
                      {sub?.gradingStatus === 'grading' ? (
                        <Loader2 className="w-1.5 h-1.5 sm:w-2 sm:h-2 animate-spin" />
                      ) : sub?.gradingStatus === 'waiting_pair' ? (
                        <Hourglass className="w-1.5 h-1.5 sm:w-2 sm:h-2" />
                      ) : sub?.gradingStatus === 'graded' ? (
                        <Check className="w-1.5 h-1.5 sm:w-2 sm:h-2 stroke-[3]" />
                      ) : (
                        idx + 1
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="w-7 h-7 xs:w-8 xs:h-8 sm:w-9 sm:h-9 bg-zinc-800 dark:bg-zinc-900 text-white shrink-0 flex items-center justify-center font-mono font-black text-xs sm:text-base border border-zinc-700">
              {opponentPlayer ? opponentPlayer.totalScore.toFixed(1) : '0.0'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
