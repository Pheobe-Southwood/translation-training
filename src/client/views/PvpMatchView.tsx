import React, { useState, useEffect, useRef } from 'react';
import {
  Send,
  Loader2,
  Trophy,
  Swords,
  ChevronRight,
  CheckCircle2,
  Award,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Hourglass,
  Clock,
  Eye,
  LayoutGrid,
  Columns,
  Users,
  Check,
  X,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type {
  PvpRoomState,
  HistorySessionRecord,
  SegmentSubmission,
  PlayerRanking,
} from '../../shared/types.js';
import { PvpHud } from '../components/PvpHud.js';
import { GradingCard } from '../components/GradingCard.js';
import { playSuccessSound } from '../utils/sound.js';
import {
  saveHistoryRecord,
  getAuthToken,
  clearActivePvpRoom,
  clearPvpDraft,
  getPvpDraft,
  setPvpDraft,
} from '../utils/storage.js';
import { PvpSocket, type PvpConnectionStatus } from '../utils/pvpSocket.js';

interface PvpMatchViewProps {
  initialRoomState: PvpRoomState;
  socket: PvpSocket;
  playerId: string;
  onExit: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export const PvpMatchView: React.FC<PvpMatchViewProps> = ({
  initialRoomState,
  socket,
  playerId,
  onExit,
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
  const [connectionStatus, setConnectionStatus] = useState<PvpConnectionStatus>(() =>
    socket.getStatus()
  );
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>(() =>
    socket.getStatusMessage()
  );
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);

  // Spectator & Review UI States
  const [spectateViewMode, setSpectateViewMode] = useState<'question' | 'matrix'>('question');
  const [spectateSegmentIdx, setSpectateSegmentIdx] = useState<number>(0);
  const [expandedDetailKey, setExpandedDetailKey] = useState<string | null>(null);

  const hasPersistedRef = useRef<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittedIndicesRef = useRef<Set<number>>(new Set());
  const pendingSubmissionRef = useRef<{ segmentIndex: number; answer: string } | null>(null);
  const lastSubmittedRef = useRef<{ index: number; answer: string } | null>(null);

  // Sync WebSocket messages
  useEffect(() => {
    const unsubscribeMessage = socket.subscribe((msg) => {
      try {
        if (msg.type === 'room:state') {
          setRoomState(msg.payload);
        } else if (msg.type === 'segment:paired_graded' || msg.type === 'segment:graded') {
          playSuccessSound();
        } else if (msg.type === 'match:ended') {
          setRoomState(msg.payload.roomState);
          handleMatchSettled(msg.payload.roomState);
        } else if (msg.type === 'error') {
          setSubmitNotice(msg.payload?.message || '操作失败，请重试');
        }
      } catch (err) {
        console.error(err);
      }
    });

    const unsubscribeStatus = socket.onStatus((status, detail) => {
      setConnectionStatus(status);
      setConnectionMessage(detail.message);
    });

    return () => {
      unsubscribeMessage();
      unsubscribeStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

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

  const allPlayers = Object.values(roomState.players);
  const spectatorsList = Object.values(roomState.spectators || {});
  const myPlayer = roomState.players[playerId];
  const isSpectator = !myPlayer;
  const opponents = allPlayers.filter((p) => p.playerId !== playerId);

  const currentIdx = myPlayer ? myPlayer.currentSegmentIndex : spectateSegmentIdx;
  const currentSegment = roomState.exam.translationSegments[currentIdx] || '';

  useEffect(() => {
    if (!isSpectator && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [currentIdx, isSpectator]);

  // Restore an unsent translation for the current question
  useEffect(() => {
    if (isSpectator || roomState.status === 'FINISHED') return;
    const draft = getPvpDraft();
    if (draft && draft.roomCode === roomState.roomCode && draft.segmentIndex === currentIdx) {
      setCurrentAnswer((prev) => (prev.trim() ? prev : draft.answer));
      setSubmitNotice('已恢复你上次未提交的译文，请重新点击提交');
    }
  }, [currentIdx, roomState.roomCode, roomState.status, isSpectator]);

  // Re-send a submission that could not be delivered while the socket was down
  useEffect(() => {
    if (connectionStatus !== 'open') return;
    const pending = pendingSubmissionRef.current;
    if (!pending) return;
    pendingSubmissionRef.current = null;
    const ok = socket.send({ type: 'segment:submit', payload: pending });
    if (ok) {
      console.log(
        `[PVP] Retried pending submission for segment ${pending.segmentIndex + 1} after reconnect`
      );
      clearPvpDraft();
    } else {
      pendingSubmissionRef.current = pending;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus]);

  // Clear local draft once confirmed by authoritative room:state
  useEffect(() => {
    const last = lastSubmittedRef.current;
    if (!last) return;
    const sub = myPlayer?.submissions[last.index];
    if (!sub?.submittedAt) return;

    submittedIndicesRef.current.add(last.index);
    pendingSubmissionRef.current = null;
    clearPvpDraft();
    if (currentAnswer === last.answer) {
      setCurrentAnswer('');
    }
    if (submitNotice) {
      setSubmitNotice(null);
    }
  }, [myPlayer, currentAnswer, submitNotice]);

  useEffect(() => {
    if (!myPlayer) return;
    for (const key of Object.keys(myPlayer.submissions)) {
      submittedIndicesRef.current.add(Number(key));
    }
  }, [myPlayer]);

  useEffect(() => {
    if (roomState.status === 'FINISHED') {
      clearActivePvpRoom();
      clearPvpDraft();
    }
  }, [roomState.status]);

  // Compute live rankings
  const computeRankings = (state: PvpRoomState): PlayerRanking[] => {
    if (state.rankings && state.rankings.length > 0) {
      return state.rankings;
    }
    const sorted = Object.values(state.players)
      .slice()
      .sort((a, b) => b.totalScore - a.totalScore);
    let rank = 1;
    return sorted.map((p, idx, arr) => {
      if (idx > 0 && p.totalScore < arr[idx - 1].totalScore) {
        rank = idx + 1;
      }
      return {
        playerId: p.playerId,
        nickname: p.nickname,
        totalScore: p.totalScore,
        rank,
        isFinished: p.isFinished,
        finishedAt: p.finishedAt,
      };
    });
  };

  const handleMatchSettled = (finalState: PvpRoomState) => {
    const me = finalState.players[playerId];
    if (!me) return; // Spectator does not save personal match history

    const rankings = computeRankings(finalState);
    const myRankObj = rankings.find((r) => r.playerId === playerId);
    const myRank = myRankObj ? myRankObj.rank : 1;
    const isWinner = myRank === 1 && finalState.winnerId === playerId;
    const isDraw = finalState.winnerId === 'draw' && myRank === 1;
    const outcome: 'win' | 'draw' | 'loss' = isWinner ? 'win' : isDraw ? 'draw' : 'loss';

    if (!hasPersistedRef.current) {
      hasPersistedRef.current = true;
      if (isWinner) {
        playSuccessSound();
        try {
          confetti({ particleCount: 100, spread: 80, origin: { y: 0.5 } });
        } catch {}
      }
    }

    const otherPlayers = Object.values(finalState.players).filter((p) => p.playerId !== playerId);
    const primaryOpp = otherPlayers[0];

    const submissionsList: SegmentSubmission[] = [0, 1, 2, 3, 4].map((idx) => {
      return (
        me.submissions[idx] || {
          segmentIndex: idx,
          originalText: finalState.exam.translationSegments[idx] || '',
          studentAnswer: '（超时未作答）',
          gradingStatus: 'graded',
          submittedAt: Date.now(),
          gradingResult: {
            score: 0,
            points_breakdown: [],
            distortion_deduction: 0,
            fluency_deduction: 0,
            critique: '未作答，得0分。',
            reference_translation: '',
            gradedAt: Date.now(),
          },
        }
      );
    });

    if (primaryOpp) {
      const record: HistorySessionRecord = {
        id: `pvp-${finalState.roomCode}-${finalState.startedAt || Date.now()}-${playerId}`,
        type: 'pvp',
        year: finalState.year,
        timestamp: Date.now(),
        totalScore: me.totalScore,
        timeSpentSeconds: finalState.startedAt
          ? Math.floor((Date.now() - finalState.startedAt) / 1000)
          : 0,
        submissions: submissionsList,
        pvpDetails: {
          opponentNickname: primaryOpp.nickname,
          opponentScore: primaryOpp.totalScore,
          outcome,
          rank: myRank,
          playerCount: Object.keys(finalState.players).length,
          leaderboard: rankings.map((r) => ({
            nickname: r.nickname,
            score: r.totalScore,
            rank: r.rank,
          })),
        },
      };
      saveHistoryRecord(record);
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
    if (!myPlayer) return;
    const answer = currentAnswer.trim();
    if (!answer || myPlayer.isFinished) return;
    if (roomState.status !== 'IN_PROGRESS') return;

    if (
      submittedIndicesRef.current.has(currentIdx) ||
      pendingSubmissionRef.current?.segmentIndex === currentIdx
    ) {
      setSubmitNotice(`第 ${currentIdx + 1} 题已提交，正在等待评分…`);
      return;
    }

    lastSubmittedRef.current = { index: currentIdx, answer };
    const delivered = socket.send({
      type: 'segment:submit',
      payload: {
        segmentIndex: currentIdx,
        studentAnswer: answer,
      },
    });

    if (delivered) {
      setCurrentAnswer('');
      clearPvpDraft();
      setSubmitNotice(null);
      return;
    }

    pendingSubmissionRef.current = { segmentIndex: currentIdx, answer };
    setPvpDraft({
      roomCode: roomState.roomCode,
      segmentIndex: currentIdx,
      answer,
      updatedAt: Date.now(),
    });
    setSubmitNotice('网络连接已断开，正在自动重连；你的译文已保留，连接恢复后会自动重新提交');
  };

  const handleLeaveAndExit = () => {
    socket.send({ type: 'room:leave' });
    onExit();
  };

  const renderPassageWithHighlight = (passage: string, activeSentence: string) => {
    if (!passage) return null;
    if (!activeSentence) {
      return (
        <div className="whitespace-pre-line leading-relaxed text-zinc-700 dark:text-zinc-300">
          {passage}
        </div>
      );
    }

    const trimmedTarget = activeSentence.trim();
    const parts = passage.split(trimmedTarget);

    if (parts.length <= 1) {
      return (
        <div className="whitespace-pre-line leading-relaxed text-zinc-700 dark:text-zinc-300">
          {passage}
        </div>
      );
    }

    return (
      <div className="whitespace-pre-line leading-relaxed text-zinc-700 dark:text-zinc-300 text-sm md:text-base font-serif">
        {parts.map((part, i) => (
          <React.Fragment key={i}>
            <span>{part}</span>
            {i < parts.length - 1 && (
              <span className="bg-rose-100/90 dark:bg-rose-950/80 text-swiss-black dark:text-rose-100 font-semibold border-l-4 border-swiss-red px-1 py-0.5 shadow-sm">
                {trimmedTarget}
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Helper component: Renders Live Spectator Dashboard (used by spectators & finished players)
  const renderLiveSpectatorDashboard = (embeddedForFinishedPlayer = false) => {
    const rankings = computeRankings(roomState);
    const activeTargetSentence = roomState.exam.translationSegments[spectateSegmentIdx] || '';
    const playerColsClass =
      allPlayers.length <= 2
        ? 'grid-cols-1 md:grid-cols-2'
        : allPlayers.length === 3
        ? 'grid-cols-1 lg:grid-cols-3'
        : 'grid-cols-1 md:grid-cols-2';

    return (
      <div className="space-y-4 sm:space-y-6">
        {/* Spectator Control Header */}
        <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-5 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-blue-600 text-white flex items-center justify-center shrink-0">
                <Eye className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs sm:text-sm font-black uppercase text-swiss-black dark:text-zinc-100">
                    {embeddedForFinishedPlayer
                      ? '实时观战看板 // 查看全场答题进度与译文'
                      : 'LIVE SPECTATOR ARENA // 实时观战大屏'}
                  </span>
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                </div>
                <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  实时同步 {allPlayers.length} 位选手的作答内容、AI 采分点明细与积分榜 · 在场观众{' '}
                  {spectatorsList.length} 人
                </div>
              </div>
            </div>

            {/* View Mode Switcher */}
            <div className="flex items-center border-2 border-swiss-black dark:border-zinc-700 font-mono text-xs font-bold">
              <button
                onClick={() => setSpectateViewMode('question')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
                  spectateViewMode === 'question'
                    ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Columns className="w-3.5 h-3.5" />
                <span>分题横向实况</span>
              </button>
              <button
                onClick={() => setSpectateViewMode('matrix')}
                className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors border-l-2 border-swiss-black dark:border-zinc-700 ${
                  spectateViewMode === 'matrix'
                    ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
                    : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                <span>全景答题矩阵</span>
              </button>
            </div>
          </div>
        </div>

        {spectateViewMode === 'question' ? (
          /* MODE A: QUESTION-BY-QUESTION SIDE-BY-SIDE LIVE ARENA */
          <div className="space-y-4 sm:space-y-5">
            {/* 5 Question Tabs */}
            <div className="grid grid-cols-5 gap-1.5 sm:gap-2.5 font-mono">
              {[0, 1, 2, 3, 4].map((qIdx) => {
                const submittedCount = allPlayers.filter((p) => !!p.submissions[qIdx]).length;
                const gradedCount = allPlayers.filter(
                  (p) => p.submissions[qIdx]?.gradingStatus === 'graded'
                ).length;
                const isSelected = spectateSegmentIdx === qIdx;

                return (
                  <button
                    key={qIdx}
                    onClick={() => setSpectateSegmentIdx(qIdx)}
                    className={`p-2 sm:p-3 border-2 text-left transition-all ${
                      isSelected
                        ? 'border-swiss-red bg-swiss-black text-white shadow-[3px_3px_0px_0px_#dc2626]'
                        : 'border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 text-swiss-black dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs sm:text-sm font-black">第 {qIdx + 1} 题</span>
                      {gradedCount === allPlayers.length && allPlayers.length > 0 && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 hidden sm:inline" />
                      )}
                    </div>
                    <div
                      className={`text-[10px] mt-1 font-bold ${
                        isSelected ? 'text-zinc-300' : 'text-zinc-500 dark:text-zinc-400'
                      }`}
                    >
                      {submittedCount}/{allPlayers.length} 已交卷
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Target Sentence Card + Collapsible Full Context */}
            <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-5 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <span className="bg-swiss-red text-white font-mono text-xs font-black px-2 py-0.5 uppercase">
                    Q{spectateSegmentIdx + 1} / 05 原文长难句
                  </span>
                  <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {roomState.year} 年考研英语一真题 · 满分 2.0 分
                  </span>
                </div>
                <button
                  onClick={() => setIsPassageOpenMobile(!isPassageOpenMobile)}
                  className="font-mono text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:text-swiss-red flex items-center gap-1"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>{isPassageOpenMobile ? '收起全文上下文' : '展开全文上下文'}</span>
                  {isPassageOpenMobile ? (
                    <ChevronUp className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <div className="p-3 sm:p-4 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700 font-serif text-sm sm:text-base leading-relaxed text-zinc-900 dark:text-zinc-100">
                {activeTargetSentence}
              </div>

              {isPassageOpenMobile && (
                <div className="p-4 bg-zinc-50/50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 max-h-72 overflow-y-auto">
                  {renderPassageWithHighlight(roomState.exam.contentMarkdown, activeTargetSentence)}
                </div>
              )}
            </div>

            {/* 2-4 Players Live Answer & Grading Cards */}
            <div className={`grid ${playerColsClass} gap-4`}>
              {rankings.map((rankItem) => {
                const p = roomState.players[rankItem.playerId];
                if (!p) return null;
                const sub = p.submissions[spectateSegmentIdx];
                const isWritingThis = !p.isFinished && p.currentSegmentIndex === spectateSegmentIdx;
                const detailKey = `${p.playerId}-${spectateSegmentIdx}`;
                const isExpanded = expandedDetailKey === detailKey;

                return (
                  <div
                    key={p.playerId}
                    className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-5 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] flex flex-col justify-between space-y-3"
                  >
                    <div className="space-y-3">
                      {/* Player Header */}
                      <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-zinc-200 dark:border-zinc-800">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`font-mono text-xs font-black px-2 py-0.5 ${
                              rankItem.rank === 1 && p.totalScore > 0
                                ? 'bg-amber-500 text-black'
                                : 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
                            }`}
                          >
                            #{rankItem.rank}
                          </span>
                          <span className="font-mono text-sm sm:text-base font-black text-swiss-black dark:text-zinc-100 truncate">
                            {p.nickname}
                          </span>
                          {p.playerId === playerId && (
                            <span className="text-[10px] bg-swiss-red text-white font-mono font-bold px-1.5 py-0.5">
                              YOU
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0 font-mono">
                          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            总分{' '}
                            <strong className="text-swiss-black dark:text-zinc-100">
                              {p.totalScore.toFixed(1)}
                            </strong>
                          </span>
                          {sub?.gradingStatus === 'graded' && sub.gradingResult && (
                            <span className="bg-emerald-600 text-white text-xs font-black px-2 py-0.5">
                              +{sub.gradingResult.score.toFixed(1)} 分
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Submission Content or Live Typing Status */}
                      {sub ? (
                        <div className="space-y-2.5">
                          <div className="flex items-center justify-between font-mono text-[11px]">
                            <span className="font-bold text-zinc-500 dark:text-zinc-400 uppercase">
                              已提交译文：
                            </span>
                            {sub.gradingStatus === 'waiting_pair' && (
                              <span className="text-blue-600 dark:text-blue-400 font-bold flex items-center gap-1">
                                <Hourglass className="w-3 h-3 animate-pulse" /> 等待对手交卷并列评分
                              </span>
                            )}
                            {sub.gradingStatus === 'grading' && (
                              <span className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" /> DeepSeek 正在实时批改...
                              </span>
                            )}
                            {sub.gradingStatus === 'graded' && (
                              <span className="text-emerald-600 dark:text-emerald-400 font-bold flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> 已完成阅卷
                              </span>
                            )}
                          </div>

                          <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100 leading-relaxed font-sans min-h-[60px]">
                            {sub.studentAnswer}
                          </div>

                          {sub.gradingResult && (
                            <div className="space-y-2 pt-1">
                              <div className="p-2.5 bg-zinc-50/80 dark:bg-zinc-800/40 border-l-2 border-swiss-black dark:border-zinc-500 text-xs font-mono text-zinc-600 dark:text-zinc-300">
                                <span className="font-bold text-swiss-black dark:text-zinc-100 mr-1">
                                  [AI 评语]
                                </span>
                                {sub.gradingResult.critique}
                              </div>

                              {/* Expandable Points Breakdown */}
                              {sub.gradingResult.points_breakdown?.length > 0 && (
                                <div>
                                  <button
                                    onClick={() =>
                                      setExpandedDetailKey(isExpanded ? null : detailKey)
                                    }
                                    className="font-mono text-[11px] font-bold text-swiss-red hover:underline flex items-center gap-1"
                                  >
                                    <span>
                                      {isExpanded
                                        ? '收起采分点明细'
                                        : `查看 ${sub.gradingResult.points_breakdown.length} 个采分点明细`}
                                    </span>
                                    <ChevronRight
                                      className={`w-3.5 h-3.5 transition-transform ${
                                        isExpanded ? 'rotate-90' : ''
                                      }`}
                                    />
                                  </button>

                                  {isExpanded && (
                                    <div className="mt-2 space-y-1.5 border-t border-zinc-200 dark:border-zinc-800 pt-2">
                                      {sub.gradingResult.points_breakdown.map((pt, pIdx) => (
                                        <div
                                          key={pIdx}
                                          className="p-2 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-[11px] font-mono"
                                        >
                                          <div className="flex items-center justify-between font-bold">
                                            <span className="text-swiss-black dark:text-zinc-200">
                                              {pt.point}
                                            </span>
                                            <span
                                              className={
                                                pt.score > 0
                                                  ? 'text-emerald-600 dark:text-emerald-400'
                                                  : 'text-red-500'
                                              }
                                            >
                                              {pt.score > 0 ? `+${pt.score}` : '0'} 分
                                            </span>
                                          </div>
                                          <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">
                                            {pt.analysis}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="p-6 border-2 border-dashed border-zinc-200 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/40 flex flex-col items-center justify-center text-center min-h-[120px] font-mono">
                          {isWritingThis ? (
                            <>
                              <Loader2 className="w-5 h-5 animate-spin text-swiss-red mb-2" />
                              <div className="text-xs font-bold text-swiss-black dark:text-zinc-200">
                                正在作答本题 (第 {spectateSegmentIdx + 1} 题)...
                              </div>
                              <div className="text-[11px] text-zinc-400 mt-1">
                                选手点击提交后，译文与 AI 判分将立即在此实时显示
                              </div>
                            </>
                          ) : (
                            <>
                              <Clock className="w-5 h-5 text-zinc-400 mb-2" />
                              <div className="text-xs font-bold text-zinc-500 dark:text-zinc-400">
                                尚未作答第 {spectateSegmentIdx + 1} 题
                              </div>
                              <div className="text-[11px] text-zinc-400 mt-1">
                                当前进度：正在作答第 {p.currentSegmentIndex + 1} 题
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Footer Status */}
                    <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>
                        当前状态：
                        {p.isFinished
                          ? '已交卷 (5/5)'
                          : `正在作答第 ${p.currentSegmentIndex + 1} 题`}
                      </span>
                      <span>
                        已交 {Object.keys(p.submissions).length} / 5 题
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* MODE B: ALL-IN-ONE MATRIX OVERVIEW (5 Questions × N Players) */
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] overflow-x-auto">
            <table className="w-full border-collapse font-mono text-xs min-w-[640px]">
              <thead>
                <tr className="bg-swiss-black text-white border-b-2 border-swiss-black dark:border-zinc-700">
                  <th className="p-3 text-left w-28 uppercase">题号 / 原文</th>
                  {rankings.map((r) => {
                    const p = roomState.players[r.playerId];
                    if (!p) return null;
                    return (
                      <th key={r.playerId} className="p-3 text-left border-l border-zinc-800">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-bold">
                            #{r.rank} {p.nickname}
                          </span>
                          <span className="bg-swiss-red text-white px-1.5 py-0.5 text-[11px] font-black shrink-0">
                            {p.totalScore.toFixed(1)}分
                          </span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {[0, 1, 2, 3, 4].map((qIdx) => {
                  const sentence = roomState.exam.translationSegments[qIdx] || '';
                  return (
                    <tr
                      key={qIdx}
                      className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30 transition-colors"
                    >
                      <td className="p-3 align-top bg-zinc-50/80 dark:bg-zinc-900/80">
                        <button
                          onClick={() => {
                            setSpectateSegmentIdx(qIdx);
                            setSpectateViewMode('question');
                          }}
                          className="font-black text-swiss-black dark:text-zinc-100 hover:text-swiss-red flex items-center gap-1"
                        >
                          <span>第 {qIdx + 1} 题</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                        <div className="text-[11px] font-serif text-zinc-500 dark:text-zinc-400 line-clamp-3 mt-1">
                          {sentence}
                        </div>
                      </td>

                      {rankings.map((r) => {
                        const p = roomState.players[r.playerId];
                        const sub = p?.submissions[qIdx];
                        const isCurrent =
                          p && !p.isFinished && p.currentSegmentIndex === qIdx;

                        return (
                          <td
                            key={r.playerId}
                            onClick={() => {
                              setSpectateSegmentIdx(qIdx);
                              setSpectateViewMode('question');
                            }}
                            className="p-3 align-top border-l border-zinc-200 dark:border-zinc-800 cursor-pointer"
                          >
                            {sub ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                  {sub.gradingStatus === 'graded' ? (
                                    <span className="bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 font-black px-1.5 py-0.5 text-[11px]">
                                      +{sub.gradingResult?.score.toFixed(1)} 分
                                    </span>
                                  ) : sub.gradingStatus === 'grading' ? (
                                    <span className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1 text-[11px]">
                                      <Loader2 className="w-3 h-3 animate-spin" /> 批改中
                                    </span>
                                  ) : (
                                    <span className="text-blue-600 dark:text-blue-400 font-bold flex items-center gap-1 text-[11px]">
                                      <Hourglass className="w-3 h-3" /> 待并列
                                    </span>
                                  )}
                                </div>
                                <div className="font-sans text-xs text-zinc-800 dark:text-zinc-200 line-clamp-3 leading-relaxed">
                                  {sub.studentAnswer}
                                </div>
                              </div>
                            ) : isCurrent ? (
                              <div className="text-amber-600 dark:text-amber-400 font-bold flex items-center gap-1.5 py-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>正在作答本题...</span>
                              </div>
                            ) : (
                              <div className="text-zinc-400 dark:text-zinc-600 py-2">
                                未开始
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  // --- 1. MATCH FINISHED RECAP VIEW (FOR BOTH PLAYERS AND SPECTATORS) ---
  if (roomState.status === 'FINISHED') {
    const rankings = computeRankings(roomState);
    const myRankObj = rankings.find((r) => r.playerId === playerId);
    const myRank = myRankObj?.rank || 1;
    const isWinner = myRank === 1 && roomState.winnerId === playerId;
    const isDraw = roomState.winnerId === 'draw' && myRank === 1;
    const topPlayer = rankings[0];

    const reviewGridCols =
      allPlayers.length <= 2
        ? 'grid-cols-1 md:grid-cols-2'
        : allPlayers.length === 3
        ? 'grid-cols-1 lg:grid-cols-3'
        : 'grid-cols-1 md:grid-cols-2';

    return (
      <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark pb-16 transition-colors duration-150">
        <PvpHud
          players={allPlayers}
          currentPlayerId={playerId}
          isSpectator={isSpectator}
          spectatorCount={spectatorsList.length}
          secondsRemaining={0}
          roomCode={roomState.roomCode}
          onExit={handleLeaveAndExit}
        />

        <div className="max-w-6xl mx-auto px-3 sm:px-6 lg:px-8 py-5 sm:py-10 space-y-6 sm:space-y-8">
          {/* Podium & Winner Banner */}
          <div
            className={`border-2 sm:border-4 border-swiss-black dark:border-zinc-700 p-5 sm:p-10 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] text-center space-y-5 sm:space-y-6 ${
              isSpectator
                ? 'bg-white dark:bg-zinc-900'
                : isWinner
                ? 'bg-amber-50 dark:bg-amber-950/20'
                : isDraw
                ? 'bg-zinc-50 dark:bg-zinc-900/60'
                : 'bg-white dark:bg-zinc-900'
            }`}
          >
            <div
              className={`w-14 h-14 sm:w-16 sm:h-16 flex items-center justify-center mx-auto border-2 border-swiss-black dark:border-zinc-700 ${
                isWinner || isSpectator
                  ? 'bg-amber-500 text-white'
                  : 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black'
              }`}
            >
              {isWinner || isSpectator ? (
                <Trophy className="w-7 h-7 sm:w-8 sm:h-8" />
              ) : (
                <Swords className="w-7 h-7 sm:w-8 sm:h-8" />
              )}
            </div>

            <div>
              <div className="font-mono text-xs uppercase font-bold tracking-widest text-zinc-500 dark:text-zinc-400 mb-1">
                PVP ARENA FINAL STANDINGS // {allPlayers.length}人竞技终局结算
              </div>
              <h1 className="text-2xl sm:text-4xl md:text-5xl font-black uppercase text-swiss-black dark:text-zinc-100">
                {isSpectator
                  ? roomState.winnerId === 'draw'
                    ? 'DRAW 巅峰平局！'
                    : `冠军：${topPlayer?.nickname || '选手'} (${topPlayer?.totalScore.toFixed(1)}分)`
                  : isWinner
                  ? 'VICTORY 夺冠获胜！'
                  : isDraw
                  ? 'DRAW 并列第一！'
                  : allPlayers.length > 2
                  ? `第 ${myRank} 名完赛`
                  : 'DEFEAT 惜败！'}
              </h1>
            </div>

            {/* Multi-Player Final Leaderboard Cards */}
            <div
              className={`max-w-3xl mx-auto grid gap-3 py-4 sm:py-6 border-y-2 border-swiss-black dark:border-zinc-700 ${
                rankings.length <= 2
                  ? 'grid-cols-2'
                  : rankings.length === 3
                  ? 'grid-cols-1 sm:grid-cols-3'
                  : 'grid-cols-2 sm:grid-cols-4'
              }`}
            >
              {rankings.map((r) => {
                const isMe = r.playerId === playerId && !isSpectator;
                return (
                  <div
                    key={r.playerId}
                    className={`p-3.5 border-2 text-center ${
                      r.rank === 1
                        ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/30'
                        : isMe
                        ? 'border-swiss-red bg-rose-50/40 dark:bg-rose-950/20'
                        : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center justify-center gap-1 font-mono text-xs font-black">
                      <span
                        className={`px-1.5 py-0.5 ${
                          r.rank === 1
                            ? 'bg-amber-500 text-black'
                            : r.rank === 2
                            ? 'bg-zinc-400 text-black'
                            : r.rank === 3
                            ? 'bg-amber-700 text-white'
                            : 'bg-zinc-700 text-white'
                        }`}
                      >
                        #{r.rank}
                      </span>
                      <span className="truncate text-swiss-black dark:text-zinc-100">
                        {r.nickname}
                      </span>
                      {isMe && (
                        <span className="text-[10px] text-swiss-red font-bold">(YOU)</span>
                      )}
                    </div>
                    <div
                      className={`font-mono text-2xl sm:text-3xl font-black mt-2 ${
                        isMe || r.rank === 1
                          ? 'text-swiss-red'
                          : 'text-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      {r.totalScore.toFixed(1)}
                    </div>
                    <div className="font-mono text-[10px] text-zinc-400 uppercase mt-0.5">
                      TOTAL SCORE
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-center gap-4 pt-2">
              <button
                onClick={handleLeaveAndExit}
                className="px-8 py-3 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase transition-colors active:scale-[0.99]"
              >
                返回竞技大厅
              </button>
            </div>
          </div>

          {/* Detailed Side-by-Side Review for each of the 5 sentences across all players */}
          <div className="space-y-6">
            <div className="border-b-2 border-swiss-black dark:border-zinc-800 pb-2">
              <h2 className="text-xl sm:text-2xl font-black uppercase text-swiss-black dark:text-zinc-100 flex items-center gap-2">
                <Award className="w-5 h-5 sm:w-6 sm:h-6 text-swiss-red" />
                全员逐题评定复盘与横向对比 ({allPlayers.length}人同题对照)
              </h2>
              <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                展示每位选手在全部 5 道长难句上的翻译原文、得分、AI 评语与采分点明细
              </div>
            </div>

            {[0, 1, 2, 3, 4].map((idx) => {
              const sentence = roomState.exam.translationSegments[idx];
              // Find any available reference translation & comparative analysis from players' submissions
              const sampleSubWithRef = allPlayers
                .map((p) => p.submissions[idx])
                .find((s) => s?.gradingResult?.reference_translation);
              const sampleSubWithComp = allPlayers
                .map((p) => p.submissions[idx])
                .find((s) => s?.comparativeAnalysis);

              return (
                <div
                  key={idx}
                  className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-4 sm:space-y-5"
                >
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-200 dark:border-zinc-800">
                    <span className="font-mono text-xs font-bold bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black px-2 py-0.5 uppercase">
                      第 {idx + 1} 题长难句
                    </span>
                    <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500 font-bold">
                      满分 2.0 分
                    </span>
                  </div>

                  <div className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 font-serif text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                    {sentence}
                  </div>

                  {/* Multi-player translations grid */}
                  <div className={`grid ${reviewGridCols} gap-3 sm:gap-4`}>
                    {rankings.map((r) => {
                      const p = roomState.players[r.playerId];
                      if (!p) return null;
                      const sub = p.submissions[idx];
                      const isMe = p.playerId === playerId && !isSpectator;
                      const detailKey = `fin-${p.playerId}-${idx}`;
                      const isExpanded = expandedDetailKey === detailKey;

                      return (
                        <div
                          key={p.playerId}
                          className={`p-3.5 border-2 space-y-2.5 flex flex-col justify-between ${
                            isMe
                              ? 'border-swiss-black dark:border-zinc-500 bg-zinc-50/80 dark:bg-zinc-800/70'
                              : 'border-zinc-300 dark:border-zinc-700 bg-zinc-50/40 dark:bg-zinc-800/40'
                          }`}
                        >
                          <div className="space-y-2.5">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="font-mono text-[10px] font-black bg-zinc-800 text-white px-1.5 py-0.5">
                                  #{r.rank}
                                </span>
                                <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">
                                  {p.nickname} {isMe ? '(YOU)' : ''}
                                </span>
                              </div>
                              <span
                                className={`font-mono text-base font-black ${
                                  isMe
                                    ? 'text-swiss-red'
                                    : 'text-zinc-800 dark:text-zinc-100'
                                }`}
                              >
                                +{sub?.gradingResult?.score.toFixed(1) || '0.0'} 分
                              </span>
                            </div>

                            <div className="text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 leading-relaxed font-sans min-h-[40px] p-2.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700">
                              {sub?.studentAnswer || '（未作答）'}
                            </div>

                            {sub?.gradingResult && (
                              <div className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400 leading-relaxed">
                                {sub.gradingResult.critique}
                              </div>
                            )}
                          </div>

                          {sub?.gradingResult?.points_breakdown &&
                            sub.gradingResult.points_breakdown.length > 0 && (
                              <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700">
                                <button
                                  onClick={() =>
                                    setExpandedDetailKey(isExpanded ? null : detailKey)
                                  }
                                  className="font-mono text-[11px] font-bold text-swiss-red hover:underline flex items-center gap-1"
                                >
                                  <span>
                                    {isExpanded ? '收起采分点' : '展开采分点明细'}
                                  </span>
                                  <ChevronRight
                                    className={`w-3 h-3 transition-transform ${
                                      isExpanded ? 'rotate-90' : ''
                                    }`}
                                  />
                                </button>
                                {isExpanded && (
                                  <div className="mt-2 space-y-1.5">
                                    {sub.gradingResult.points_breakdown.map((pt, pIdx) => (
                                      <div
                                        key={pIdx}
                                        className="p-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-[11px] font-mono"
                                      >
                                        <div className="flex items-center justify-between font-bold">
                                          <span className="flex items-center gap-1">
                                            {pt.score > 0 ? (
                                              <Check className="w-3 h-3 text-emerald-500" />
                                            ) : (
                                              <X className="w-3 h-3 text-red-500" />
                                            )}
                                            {pt.point}
                                          </span>
                                          <span
                                            className={
                                              pt.score > 0
                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                : 'text-red-500'
                                            }
                                          >
                                            +{pt.score}
                                          </span>
                                        </div>
                                        <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">
                                          {pt.analysis}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Paired Comparative Analysis (for 2P matches) */}
                  {sampleSubWithComp?.comparativeAnalysis && (
                    <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 font-mono text-xs text-amber-950 dark:text-amber-200">
                      <span className="font-bold text-amber-800 dark:text-amber-400 uppercase mr-2">
                        [横向对比裁决]
                      </span>
                      {sampleSubWithComp.comparativeAnalysis}
                    </div>
                  )}

                  {/* Reference translation */}
                  {sampleSubWithRef?.gradingResult?.reference_translation && (
                    <div className="p-3 bg-rose-50/50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                      <span className="text-swiss-red dark:text-rose-400 font-bold uppercase mr-2">
                        [标准参考译文]
                      </span>
                      {sampleSubWithRef.gradingResult.reference_translation}
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

  // --- 2. LIVE SPECTATOR VIEW (WHEN USER IS IN SPECTATOR SEAT) ---
  if (isSpectator) {
    return (
      <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark pb-16 transition-colors duration-150">
        <PvpHud
          players={allPlayers}
          currentPlayerId={playerId}
          isSpectator={true}
          spectatorCount={spectatorsList.length}
          secondsRemaining={secondsRemaining}
          roomCode={roomState.roomCode}
          onExit={handleLeaveAndExit}
        />

        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-4 sm:space-y-6">
          {connectionStatus !== 'open' && connectionStatus !== 'idle' && (
            <div className="p-3 border-2 border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-mono text-xs flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>{connectionMessage || '正在同步实时观战数据...'}</span>
            </div>
          )}

          {renderLiveSpectatorDashboard(false)}
        </div>
      </div>
    );
  }

  // --- 3. LIVE IN-PROGRESS PLAYER BATTLE VIEW ---
  const prevSub = currentIdx > 0 ? myPlayer.submissions[currentIdx - 1] : null;

  return (
    <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark pb-16 transition-colors duration-150">
      <PvpHud
        players={allPlayers}
        currentPlayerId={playerId}
        isSpectator={false}
        spectatorCount={spectatorsList.length}
        secondsRemaining={secondsRemaining}
        roomCode={roomState.roomCode}
        onExit={handleLeaveAndExit}
      />

      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-6 space-y-4 sm:space-y-6">
        {/* Connection status banner */}
        {connectionStatus !== 'open' && connectionStatus !== 'idle' && (
          <div
            className={`p-3 border-2 font-mono text-xs flex items-center gap-2 ${
              connectionStatus === 'fatal'
                ? 'border-red-500 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200'
                : 'border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
            }`}
          >
            {connectionStatus === 'fatal' ? (
              <Clock className="w-4 h-4 shrink-0" />
            ) : (
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            )}
            <span className="font-bold">
              {connectionMessage ||
                (connectionStatus === 'connecting'
                  ? '正在连接对战服务器...'
                  : '连接已断开，正在自动重连...')}
            </span>
            {connectionStatus === 'fatal' && (
              <button
                onClick={onExit}
                className="ml-auto px-3 py-1 border border-red-500 text-red-800 dark:text-red-200 hover:bg-red-100 dark:hover:bg-red-900/40 font-bold uppercase shrink-0"
              >
                返回大厅
              </button>
            )}
          </div>
        )}

        {submitNotice && (
          <div className="p-3 border-2 border-blue-400 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-200 font-mono text-xs">
            {submitNotice}
          </div>
        )}

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
                  <span className="font-mono text-xs font-bold text-zinc-400 dark:text-zinc-500">
                    满分 2.0 分
                  </span>
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
                  disabled={!currentAnswer.trim() || connectionStatus === 'fatal'}
                  className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:hover:bg-swiss-black dark:disabled:hover:bg-zinc-100 active:scale-[0.99]"
                >
                  <span>
                    确认提交第 {currentIdx + 1} 题，进入下一句 (
                    {currentIdx === 4 ? '交卷封顶' : `0${currentIdx + 2}/05`})
                  </span>
                  <Send className="w-4 h-4" />
                </button>
              </div>

              {/* Multi-Opponent Live Progress Board */}
              <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 font-mono text-xs space-y-2.5 shadow-sm">
                <div className="flex items-center justify-between pb-1.5 border-b border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-1.5 font-bold text-zinc-700 dark:text-zinc-200 uppercase">
                    <Users className="w-3.5 h-3.5 text-swiss-red" />
                    <span>同场对手实时动态 ({opponents.length}人)</span>
                  </div>
                  {spectatorsList.length > 0 && (
                    <span className="text-[11px] text-blue-600 dark:text-blue-400 flex items-center gap-1 font-bold">
                      <Eye className="w-3 h-3" /> {spectatorsList.length} 人正在观战
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  {opponents.map((opp) => (
                    <div
                      key={opp.playerId}
                      className="flex items-center justify-between gap-2 p-2 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-bold text-swiss-black dark:text-zinc-100 truncate">
                          {opp.nickname}
                        </span>
                        <span className="text-[11px] text-swiss-red font-black shrink-0">
                          {opp.totalScore.toFixed(1)}分
                        </span>
                      </div>
                      <span
                        className={`px-2 py-0.5 text-[11px] font-bold shrink-0 ${
                          opp.isOnline === false
                            ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300'
                            : opp.isFinished
                            ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                            : 'bg-zinc-200/80 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200'
                        }`}
                      >
                        {opp.isOnline === false
                          ? '离线重连中…'
                          : opp.isFinished
                          ? '已答完全部5题'
                          : `正在作答第 ${opp.currentSegmentIndex + 1} 题`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Passage Context & Previous Scoring (Desktop Left 7 cols, Mobile BOTTOM 12 cols) */}
            <div className="lg:col-span-7 lg:order-1 space-y-4">
              {/* Asynchronous Grading Feedback Bar */}
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
                          DeepSeek 正在实时评阅第 {currentIdx} 句...
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
                      <span className="text-red-600 dark:text-red-400 font-bold text-xs">
                        第 {currentIdx} 句评分异常
                      </span>
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
                      <span className="font-bold text-amber-800 dark:text-amber-400 uppercase mr-2">
                        [双人并列评定解析]
                      </span>
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
                      {isPassageOpenMobile ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
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
          /* Player finished all 5 sentences: show own summary + live spectator view of ongoing match */
          <div className="space-y-6">
            <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 sm:p-8 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] text-center space-y-4">
              <div
                className={`w-12 h-12 flex items-center justify-center mx-auto text-white ${
                  secondsRemaining <= 0 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
              >
                {secondsRemaining <= 0 ? (
                  <Clock className="w-6 h-6" />
                ) : (
                  <CheckCircle2 className="w-6 h-6" />
                )}
              </div>

              <h3 className="text-xl sm:text-2xl font-black uppercase text-swiss-black dark:text-zinc-100">
                {secondsRemaining <= 0
                  ? '对战时间已截止，正在终局判分...'
                  : '您已率先完成全部 5 题翻译！'}
              </h3>

              <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400 max-w-xl mx-auto leading-relaxed">
                {secondsRemaining <= 0
                  ? '比赛时间已耗尽，系统正在等待最后题目的 DeepSeek 裁决并生成终局排行榜...'
                  : '您的作答已全部锁定提交。等待其他选手完卷期间，您可在下方实时观战全场选手的答题情况与出分进度！'}
              </p>

              <div className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 font-mono text-sm font-bold text-zinc-800 dark:text-zinc-200">
                <Loader2 className="w-4 h-4 animate-spin text-swiss-red" />
                <span>您当前累计已出分：{myPlayer.totalScore.toFixed(1)} / 10.0</span>
              </div>
            </div>

            {/* Finished player can immediately watch the live spectator dashboard while waiting! */}
            {renderLiveSpectatorDashboard(true)}
          </div>
        )}
      </div>
    </div>
  );
};
