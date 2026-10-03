import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Loader2,
  Trophy,
  Swords,
  ChevronRight,
  Sparkles,
  CheckCircle2,
  Award,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Hourglass,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type { PvpRoomState, HistorySessionRecord } from '../../shared/types.js';
import { PvpHud } from '../components/PvpHud.js';
import { GradingCard } from '../components/GradingCard.js';
import { playSuccessSound } from '../utils/sound.js';
import { saveHistoryRecord, getAuthToken } from '../utils/storage.js';

interface PvpMatchViewProps {
  initialRoomState: PvpRoomState;
  ws: WebSocket;
  playerId: string;
  onExit: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export const PvpMatchView: React.FC<PvpMatchViewProps> = ({
  initialRoomState,
  ws,
  playerId,
  onExit,
  theme,
  onToggleTheme,
}) => {
  const [roomState, setRoomState] = useState<PvpRoomState>(initialRoomState);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    if (initialRoomState.matchEndTime) {
      return Math.max(0, Math.floor((initialRoomState.matchEndTime - Date.now()) / 1000));
    }
    return initialRoomState.durationMinutes * 60;
  });
  const [activeCardTab, setActiveCardTab] = useState<number | null>(null);
  const [isPassageOpenMobile, setIsPassageOpenMobile] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync WebSocket messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'room:state') {
          setRoomState(msg.payload);
        } else if (msg.type === 'segment:paired_graded' || msg.type === 'segment:graded') {
          playSuccessSound();
        } else if (msg.type === 'match:ended') {
          setRoomState(msg.payload.roomState);
          handleMatchSettled(msg.payload.roomState);
        }
      } catch (err) {
        console.error(err);
      }
    };

    ws.addEventListener('message', handleMessage);
    return () => {
      ws.removeEventListener('message', handleMessage);
    };
  }, [ws]);

  // Match countdown clock ticker
  useEffect(() => {
    if (roomState.status === 'FINISHED') return;

    const interval = setInterval(() => {
      if (roomState.matchEndTime) {
        const rem = Math.max(0, Math.floor((roomState.matchEndTime - Date.now()) / 1000));
        setSecondsRemaining(rem);
        if (rem <= 0) {
          clearInterval(interval);
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [roomState.matchEndTime, roomState.status]);

  const myPlayer = roomState.players[playerId];
  const opponent = Object.values(roomState.players).find((p) => p.playerId !== playerId);

  const currentIdx = myPlayer ? myPlayer.currentSegmentIndex : 0;
  const currentSegment = roomState.exam.translationSegments[currentIdx] || '';

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [currentIdx]);

  const handleMatchSettled = (finalState: PvpRoomState) => {
    const me = finalState.players[playerId];
    const opp = Object.values(finalState.players).find((p) => p.playerId !== playerId);

    if (me && opp) {
      const isWinner = finalState.winnerId === playerId;
      const isDraw = finalState.winnerId === 'draw';
      const outcome = isWinner ? 'win' : isDraw ? 'draw' : 'loss';

      if (isWinner) {
        playSuccessSound();
        try {
          confetti({ particleCount: 100, spread: 80, origin: { y: 0.5 } });
        } catch {}
      }

      // Persist to history
      const record: HistorySessionRecord = {
        id: `pvp-${Date.now()}`,
        type: 'pvp',
        year: finalState.year,
        timestamp: Date.now(),
        totalScore: me.totalScore,
        timeSpentSeconds: finalState.startedAt
          ? Math.floor((Date.now() - finalState.startedAt) / 1000)
          : 0,
        submissions: Object.values(me.submissions),
        pvpDetails: {
          opponentNickname: opp.nickname,
          opponentScore: opp.totalScore,
          outcome,
        },
      };
      saveHistoryRecord(record);
      // Persist to online database
      try {
        const token = getAuthToken();
        if (token) {
          fetch('/api/history', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ record }),
          }).catch((e) => console.error('Failed to post PVP history to server:', e));
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleConfirmSubmit = () => {
    if (!currentAnswer.trim() || myPlayer.isFinished) return;

    ws.send(
      JSON.stringify({
        type: 'segment:submit',
        payload: {
          segmentIndex: currentIdx,
          studentAnswer: currentAnswer.trim(),
        },
      })
    );

    setCurrentAnswer('');
  };

  const renderPassageWithHighlight = (passage: string, activeSentence: string) => {
    if (!passage) return null;
    if (!activeSentence) {
      return <div className="whitespace-pre-line leading-relaxed text-zinc-700">{passage}</div>;
    }

    const trimmedTarget = activeSentence.trim();
    const parts = passage.split(trimmedTarget);

    if (parts.length <= 1) {
      return <div className="whitespace-pre-line leading-relaxed text-zinc-700">{passage}</div>;
    }

    return (
      <div className="whitespace-pre-line leading-relaxed text-zinc-700 text-sm md:text-base font-serif">
        {parts.map((part, i) => (
          <React.Fragment key={i}>
            <span>{part}</span>
            {i < parts.length - 1 && (
              <span className="bg-rose-100/90 text-swiss-black font-semibold border-l-4 border-swiss-red px-1 py-0.5 shadow-sm">
                {trimmedTarget}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    );
  };

  if (!myPlayer) {
    return null;
  }

  // --- MATCH FINISHED RECAP VIEW ---
  if (roomState.status === 'FINISHED') {
    const isWinner = roomState.winnerId === playerId;
    const isDraw = roomState.winnerId === 'draw';

    return (
      <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark pb-16 transition-colors duration-150">
        <PvpHud
          myPlayer={myPlayer}
          opponentPlayer={opponent}
          secondsRemaining={0}
          roomCode={roomState.roomCode}
        />

        <div className="max-w-5xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-10 space-y-6 sm:space-y-8">
          {/* Winner Banner */}
          <div
            className={`border-2 sm:border-4 border-swiss-black dark:border-zinc-700 p-5 sm:p-12 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] text-center space-y-5 sm:space-y-6 ${
              isWinner
                ? 'bg-amber-50 dark:bg-amber-950/20'
                : isDraw
                ? 'bg-zinc-50 dark:bg-zinc-900/60'
                : 'bg-white dark:bg-zinc-900'
            }`}
          >
            <div
              className={`w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center mx-auto border-2 border-swiss-black dark:border-zinc-700 ${
                isWinner ? 'bg-amber-500 text-white' : 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
              }`}
            >
              {isWinner ? <Trophy className="w-7 h-7 sm:w-8 sm:h-8" /> : <Swords className="w-7 h-7 sm:w-8 sm:h-8" />}
            </div>

            <div>
              <div className="font-mono text-xs uppercase font-bold tracking-widest text-zinc-500 dark:text-zinc-400 mb-1">
                PVP ARENA RESULT // 对战终局结算
              </div>
              <h1 className="text-3xl sm:text-5xl md:text-6xl font-black uppercase text-swiss-black dark:text-zinc-100">
                {isWinner ? 'VICTORY 获胜！' : isDraw ? 'DRAW 平局！' : 'DEFEAT 惜败！'}
              </h1>
            </div>

            {/* Final Head-to-Head Scoreboard */}
            <div className="max-w-md mx-auto grid grid-cols-3 items-center py-4 sm:py-6 border-y-2 border-swiss-black dark:border-zinc-700">
              <div className="text-center">
                <div className="text-xs font-mono font-bold text-zinc-500 dark:text-zinc-400 uppercase truncate">
                  {myPlayer.nickname} (YOU)
                </div>
                <div className="font-mono text-3xl sm:text-4xl font-black text-swiss-red mt-1">
                  {myPlayer.totalScore.toFixed(1)}
                </div>
              </div>

              <div className="font-mono text-xl sm:text-2xl font-black text-zinc-300 dark:text-zinc-600 text-center">
                VS
              </div>

              <div className="text-center">
                <div className="text-xs font-mono font-bold text-zinc-500 dark:text-zinc-400 uppercase truncate">
                  {opponent ? opponent.nickname : '对手'}
                </div>
                <div className="font-mono text-3xl sm:text-4xl font-black text-zinc-800 dark:text-zinc-200 mt-1">
                  {opponent ? opponent.totalScore.toFixed(1) : '0.0'}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-center gap-4 pt-2">
              <button
                onClick={onExit}
                className="px-8 py-3 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase transition-colors active:scale-[0.99]"
              >
                返回竞技大厅
              </button>
            </div>
          </div>

          {/* Detailed Side-by-Side Review for each sentence */}
          <div className="space-y-6">
            <div className="border-b-2 border-swiss-black dark:border-zinc-800 pb-2">
              <h2 className="text-xl sm:text-2xl font-black uppercase text-swiss-black dark:text-zinc-100 flex items-center gap-2">
                <Award className="w-5 h-5 sm:w-6 sm:h-6 text-swiss-red" />
                双人并列评定复盘与横向对比
              </h2>
              <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                同一提示词下由 DeepSeek 裁决，无模型随机性偏差
              </div>
            </div>

            {[0, 1, 2, 3, 4].map((idx) => {
              const mySub = myPlayer.submissions[idx];
              const oppSub = opponent?.submissions[idx];
              const sentence = roomState.exam.translationSegments[idx];

              return (
                <div
                  key={idx}
                  className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-4 sm:space-y-5"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-200 dark:border-zinc-800">
                    <span className="font-mono text-xs font-bold bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black px-2 py-0.5 uppercase">
                      第 {idx + 1} 题长难句
                    </span>
                    <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500 font-bold">满分 2.0 分</span>
                  </div>

                  <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 font-serif text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                    {sentence}
                  </div>

                  {/* Side-by-side player translations */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
                    {/* My translation */}
                    <div className="p-3 sm:p-3.5 border-2 border-zinc-300 dark:border-zinc-700 space-y-2.5 bg-zinc-50/50 dark:bg-zinc-800/50">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold text-zinc-700 dark:text-zinc-300">
                          {myPlayer.nickname} (YOU)
                        </span>
                        <span className="font-mono text-base font-black text-swiss-red">
                          +{mySub?.gradingResult?.score.toFixed(1) || '0.0'} 分
                        </span>
                      </div>
                      <div className="text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed font-sans min-h-[40px]">
                        {mySub?.studentAnswer || '（未作答）'}
                      </div>
                      {mySub?.gradingResult && (
                        <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700 text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
                          {mySub.gradingResult.critique}
                        </div>
                      )}
                    </div>

                    {/* Opponent translation */}
                    <div className="p-3 sm:p-3.5 border-2 border-zinc-300 dark:border-zinc-700 space-y-2.5 bg-zinc-50/50 dark:bg-zinc-800/50">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-bold text-zinc-700 dark:text-zinc-300">
                          {opponent?.nickname || '对手'}
                        </span>
                        <span className="font-mono text-base font-black text-zinc-800 dark:text-zinc-200">
                          +{oppSub?.gradingResult?.score.toFixed(1) || '0.0'} 分
                        </span>
                      </div>
                      <div className="text-xs text-zinc-900 dark:text-zinc-100 leading-relaxed font-sans min-h-[40px]">
                        {oppSub?.studentAnswer || '（未作答）'}
                      </div>
                      {oppSub?.gradingResult && (
                        <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700 text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
                          {oppSub.gradingResult.critique}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Paired Comparative Analysis */}
                  {mySub?.comparativeAnalysis && (
                    <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 font-mono text-xs text-amber-950 dark:text-amber-200">
                      <span className="font-bold text-amber-800 dark:text-amber-400 uppercase mr-2">[横向对比裁决]</span>
                      {mySub.comparativeAnalysis}
                    </div>
                  )}

                  {/* Reference translation */}
                  {mySub?.gradingResult?.reference_translation && (
                    <div className="p-3 bg-rose-50/50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                      <span className="text-swiss-red dark:text-rose-400 font-bold uppercase mr-2">[标准参考]</span>
                      {mySub.gradingResult.reference_translation}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // --- LIVE IN-PROGRESS BATTLE VIEW ---
  const prevSub = currentIdx > 0 ? myPlayer.submissions[currentIdx - 1] : null;

  return (
    <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark pb-16 transition-colors duration-150">
      <PvpHud
        myPlayer={myPlayer}
        opponentPlayer={opponent}
        secondsRemaining={secondsRemaining}
        roomCode={roomState.roomCode}
      />

      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-6 space-y-4 sm:space-y-6">
        {!myPlayer.isFinished ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
            {/* Active Target Sentence & Input Box (Desktop Right 5 cols, Mobile TOP 12 cols) */}
            <div className="lg:col-span-5 lg:order-2 space-y-4">
              <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-3.5">
                <div className="flex items-center justify-between pb-2 border-b-2 border-swiss-black dark:border-zinc-700">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 bg-swiss-red animate-pulse"></span>
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-swiss-black dark:text-zinc-100">
                      本题待译长难句 [0{currentIdx + 1} / 05]
                    </span>
                  </div>
                  <span className="font-mono text-xs font-bold text-zinc-400 dark:text-zinc-500">满分 2.0 分</span>
                </div>

                {/* Target Sentence Content */}
                <div className="p-3 sm:p-4 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700 font-serif text-sm sm:text-base md:text-lg leading-relaxed text-zinc-900 dark:text-zinc-100 selection:bg-swiss-red selection:text-white">
                  {currentSegment}
                </div>

                {/* Input Area */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    <label htmlFor="pvp-input" className="font-bold uppercase text-[11px]">
                      输入您的中文翻译：
                    </label>
                    <span className="text-[10px] hidden sm:inline">Ctrl + Enter 快捷提交</span>
                  </div>
                  <textarea
                    id="pvp-input"
                    ref={textareaRef}
                    value={currentAnswer}
                    onChange={(e) => setCurrentAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && e.key === 'Enter') {
                        handleConfirmSubmit();
                      }
                    }}
                    rows={4}
                    placeholder="在此输入翻译，提交后立即进入下一句..."
                    className="w-full border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3 font-sans text-base sm:text-sm focus:outline-none focus:border-swiss-red dark:focus:border-swiss-red transition-colors placeholder:text-zinc-400 dark:placeholder:text-zinc-500 text-swiss-black dark:text-zinc-100 resize-none leading-relaxed"
                  />
                </div>

                <button
                  onClick={handleConfirmSubmit}
                  disabled={!currentAnswer.trim()}
                  className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:hover:bg-swiss-black dark:disabled:hover:bg-zinc-100 active:scale-[0.99]"
                >
                  <span>
                    确认提交第 {currentIdx + 1} 题，进入下一句 (
                    {currentIdx === 4 ? '交卷封顶' : `0${currentIdx + 2}/05`})
                  </span>
                  <Send className="w-4 h-4" />
                </button>
              </div>

              {/* Opponent Status Bar */}
              <div className="p-3 border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 font-mono text-xs flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2">
                  <Swords className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  <span className="font-bold text-zinc-700 dark:text-zinc-300">{opponent?.nickname || '对手'} 进度：</span>
                </div>
                <span className="bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 font-bold text-zinc-800 dark:text-zinc-200">
                  {opponent?.isFinished
                    ? '已答完全部5题'
                    : `正在作答第 ${(opponent?.currentSegmentIndex || 0) + 1} 题`}
                </span>
              </div>
            </div>

            {/* Passage Context & Previous Scoring (Desktop Left 7 cols, Mobile BOTTOM 12 cols) */}
            <div className="lg:col-span-7 lg:order-1 space-y-4">
              {/* Asynchronous Paired Grading Feedback Bar */}
              {prevSub && (
                <div className="border-2 border-swiss-black dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/80 p-3 sm:p-4 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] flex items-center justify-between">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    {prevSub.gradingStatus === 'waiting_pair' ? (
                      <>
                        <Hourglass className="w-4 h-4 text-blue-500 animate-pulse shrink-0" />
                        <span className="font-bold text-blue-800 dark:text-blue-300 text-xs">
                          已提交第 {currentIdx} 句，等待对手完成该句以开启并列评分...
                        </span>
                      </>
                    ) : prevSub.gradingStatus === 'grading' ? (
                      <>
                        <Loader2 className="w-4 h-4 text-amber-500 animate-spin shrink-0" />
                        <span className="font-bold text-amber-700 dark:text-amber-400 text-xs">
                          双方均已提交，DeepSeek 正在并列评分第 {currentIdx} 句...
                        </span>
                      </>
                    ) : prevSub.gradingStatus === 'graded' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                        <span className="font-bold text-zinc-900 dark:text-zinc-100 text-xs">
                          第 {currentIdx} 句出分：
                        </span>
                        <span className="bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 font-bold px-1.5 py-0.5">
                          +{prevSub.gradingResult?.score.toFixed(1)} 分
                        </span>
                      </>
                    ) : (
                      <span className="text-red-600 dark:text-red-400 font-bold text-xs">第 {currentIdx} 句评分异常</span>
                    )}
                  </div>

                  {prevSub.gradingResult && (
                    <button
                      onClick={() =>
                        setActiveCardTab(activeCardTab === currentIdx - 1 ? null : currentIdx - 1)
                      }
                      className="font-mono text-xs font-bold text-swiss-black dark:text-zinc-200 hover:text-swiss-red dark:hover:text-swiss-red flex items-center gap-1 shrink-0 ml-2"
                    >
                      {activeCardTab === currentIdx - 1 ? '收起' : '查看采分'}
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Expanded Grading Drawer if clicked */}
              {activeCardTab !== null && myPlayer.submissions[activeCardTab]?.gradingResult && (
                <div className="space-y-3">
                  <GradingCard
                    result={myPlayer.submissions[activeCardTab].gradingResult!}
                    studentAnswer={myPlayer.submissions[activeCardTab].studentAnswer}
                    originalText={myPlayer.submissions[activeCardTab].originalText}
                    segmentIndex={activeCardTab}
                  />
                  {myPlayer.submissions[activeCardTab].comparativeAnalysis && (
                    <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border-2 border-amber-300 dark:border-amber-800 font-mono text-xs text-amber-950 dark:text-amber-200">
                      <span className="font-bold text-amber-800 dark:text-amber-400 uppercase mr-2">[双人并列评定解析]</span>
                      {myPlayer.submissions[activeCardTab].comparativeAnalysis}
                    </div>
                  )}
                </div>
              )}

              {/* Mobile Collapsible Passage Accordion / Desktop Persistent Card */}
              <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000]">
                <div
                  onClick={() => setIsPassageOpenMobile(!isPassageOpenMobile)}
                  className="p-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 cursor-pointer lg:cursor-default hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
                      PASSAGE CONTEXT // {roomState.year} 年考研真题
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] bg-rose-100 dark:bg-rose-950/80 text-swiss-red dark:text-rose-200 border border-rose-300 dark:border-rose-800 px-2 py-0.5 font-bold uppercase hidden sm:inline">
                      红色标尺即为本题目标
                    </span>
                    <div className="text-zinc-500 dark:text-zinc-400 lg:hidden">
                      {isPassageOpenMobile ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </div>

                <div
                  className={`p-4 sm:p-6 max-h-[460px] overflow-y-auto leading-relaxed ${
                    isPassageOpenMobile ? 'block' : 'hidden lg:block'
                  }`}
                >
                  {renderPassageWithHighlight(roomState.exam.contentMarkdown, currentSegment)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* You finished all 5 sentences, waiting for opponent or remaining paired gradings */
          <div className="max-w-2xl mx-auto border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 sm:p-10 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] text-center space-y-5 sm:space-y-6">
            <div className="w-12 h-12 bg-emerald-500 text-white flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <h3 className="text-2xl font-black uppercase text-swiss-black dark:text-zinc-100">
              您已完成全部 5 题翻译！
            </h3>

            <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              您的全部作答已提交。系统正在等待对手完成相应题目以触发并列裁决，请稍候...
            </p>

            <div className="py-4 border-y border-zinc-200 dark:border-zinc-800 flex items-center justify-center gap-2 font-mono text-sm text-zinc-800 dark:text-zinc-200">
              <Loader2 className="w-4 h-4 animate-spin text-swiss-red" />
              <span>当前累计已出分：{myPlayer.totalScore.toFixed(1)} / 10.0</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
