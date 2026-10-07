import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  LayoutGrid,
  ListChecks,
  Loader2,
  Send,
  Swords,
  Trophy,
  Users,
  Vote,
} from 'lucide-react';
import type {
  HistoryRoundRecord,
  HistorySessionRecord,
  PvpRoomSummary,
  RoundDetail,
  RoundDetailPlayer,
  RoundScoreEntry,
  SegmentSubmission,
} from '../../shared/types.js';
import { PvpSocket, type PvpConnectionStatus } from '../utils/pvpSocket.js';
import {
  clearActivePvpRoom,
  clearPvpDraft,
  getAuthToken,
  getPvpDraft,
  saveHistoryRecord,
  setPvpDraft,
} from '../utils/storage.js';
import { PvpHud } from '../components/PvpHud.js';
import { GradingCard } from '../components/GradingCard.js';

interface PvpMatchViewProps {
  initialSummary: PvpRoomSummary;
  socket: PvpSocket;
  playerId: string;
  onExit: () => void;
}

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'warn';
}

const SEGMENT_COUNT = 5;

const draftKey = (roundIndex: number, segmentIndex: number) => `${roundIndex}:${segmentIndex}`;

export const PvpMatchView: React.FC<PvpMatchViewProps> = ({
  initialSummary,
  socket,
  playerId,
  onExit,
}) => {
  const [summary, setSummary] = useState<PvpRoomSummary>(initialSummary);
  const [roundDetails, setRoundDetails] = useState<Record<number, RoundDetail>>(() => {
    const seeded: Record<number, RoundDetail> = {};
    for (const round of initialSummary.rounds) {
      const cached = socket.getRoundDetail(round.roundIndex);
      if (cached) seeded[round.roundIndex] = cached;
    }
    return seeded;
  });
  const [pinnedRound, setPinnedRound] = useState<number | null>(null);
  const [viewSegmentIndex, setViewSegmentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [spectateViewMode, setSpectateViewMode] = useState<'question' | 'matrix'>('question');
  const [voteRemaining, setVoteRemaining] = useState<number | null>(null);
  const [roundTransition, setRoundTransition] = useState<{ roundIndex: number; year: number } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<PvpConnectionStatus>(socket.getStatus());
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>(socket.getStatusMessage());
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [historySaved, setHistorySaved] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toastSeq = useRef(0);
  const lastRoundRef = useRef<number>(-1);

  const me = summary.players.find((p) => p.playerId === playerId);
  const isSpectator = !me;
  const isPlaying = !!me && me.phase === 'playing' && !me.hasFinishedAllRounds;
  const totalRounds = summary.config.totalRounds;
  const durationSeconds = summary.config.durationMinutes * 60;

  const roomRoundIndex = summary.currentRoundIndex ?? 0;
  const activeRoundIndex = me ? me.currentRoundIndex : roomRoundIndex;
  const viewRoundIndex = pinnedRound ?? activeRoundIndex;
  const viewDetail = roundDetails[viewRoundIndex];
  const isViewingOwnRound = !!me && viewRoundIndex === me.currentRoundIndex && isPlaying;

  const pushToast = (text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  };

  // --- Server subscriptions -------------------------------------------------
  useEffect(() => {
    const unsubscribeMessage = socket.subscribe((msg) => {
      switch (msg.type) {
        case 'room:summary': {
          setSummary(msg.payload as PvpRoomSummary);
          break;
        }
        case 'round:detail': {
          const detail = msg.payload as RoundDetail;
          setRoundDetails((prev) => ({ ...prev, [detail.roundIndex]: detail }));
          break;
        }
        case 'round:started': {
          const { roundIndex, year } = msg.payload || {};
          setRoundDetails((prev) => {
            const next = { ...prev };
            delete next[roundIndex];
            return next;
          });
          setRoundTransition({ roundIndex, year });
          setTimeout(() => setRoundTransition(null), 3000);
          pushToast(`第 ${roundIndex + 1} 轮开始 · ${year} 年真题`, 'info');
          break;
        }
        case 'round:settled': {
          const payload = msg.payload || {};
          const mine: RoundScoreEntry | undefined = (payload.scoreEntries || []).find(
            (e: RoundScoreEntry) => e.playerId === playerId
          );
          const label = payload.isOvertime ? '加赛局' : `第 ${payload.roundIndex + 1} 轮`;
          if (mine) {
            const reasons: string[] = [];
            if (mine.pointsPart > 0) reasons.push(`小分优势 +${mine.pointsPart.toFixed(1)}`);
            if (mine.timePart > 0) reasons.push(`速度加成 +${mine.timePart.toFixed(1)}`);
            pushToast(
              `${label}（${payload.year} 年）结算：${reasons.length > 0 ? reasons.join('，') : '未取得大比分'}` +
                ` → 本轮 +${mine.matchPointsDelta.toFixed(1)}`,
              mine.matchPointsDelta > 0 ? 'good' : 'info'
            );
          } else if (isSpectator) {
            pushToast(`${label}（${payload.year} 年）结算完成`, 'info');
          }
          break;
        }
        case 'segment:graded': {
          break;
        }
        case 'overtime:vote_started': {
          setVoteRemaining(msg.payload?.seconds ?? 30);
          pushToast('终局平分，等待并列选手确认是否加赛', 'warn');
          break;
        }
        case 'overtime:vote_update': {
          break;
        }
        case 'overtime:resolved': {
          setVoteRemaining(null);
          pushToast(
            msg.payload?.agreed
              ? `双方同意加赛，决胜卷：${msg.payload?.year} 年真题`
              : '加赛未达成一致',
            msg.payload?.agreed ? 'good' : 'info'
          );
          break;
        }
        case 'match:ended': {
          setVoteRemaining(null);
          setSummary(msg.payload?.summary ?? summary);
          break;
        }
        case 'error': {
          if (msg.payload?.code === 'ROOM_EXPIRED') {
            setSubmitNotice(msg.payload?.message || '本轮时间已到');
          } else if (msg.payload?.code === 'ROUND_SETTLED' || msg.payload?.code === 'ALREADY_FINISHED') {
            setSubmitNotice(msg.payload?.message || '无法提交');
          } else {
            setSubmitNotice(msg.payload?.message || '操作失败');
          }
          break;
        }
        default:
          break;
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
  }, [socket, playerId]);

  // Ask the server for whichever round we are currently looking at. The server also
  // records this as our "watched round" and will push live updates for it.
  useEffect(() => {
    socket.requestRound(viewRoundIndex);
  }, [socket, viewRoundIndex]);

  // Keep the viewed segment on the next unanswered question of our own round.
  useEffect(() => {
    if (!me || !isViewingOwnRound) return;
    if (lastRoundRef.current !== me.currentRoundIndex) {
      lastRoundRef.current = me.currentRoundIndex;
      setViewSegmentIndex(Math.min(me.currentSegmentIndex, SEGMENT_COUNT - 1));
      setPinnedRound(null);
      setAnswers((prev) => ({ ...prev, [draftKey(me.currentRoundIndex, me.currentSegmentIndex)]: '' }));
    }
  }, [me?.currentRoundIndex, me?.currentSegmentIndex, isViewingOwnRound]);

  // Overtime vote countdown.
  useEffect(() => {
    if (summary.status !== 'OVERTIME_VOTE' || !summary.overtime) {
      setVoteRemaining(null);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((summary.overtime!.deadlineAt - Date.now()) / 1000));
      setVoteRemaining(left);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [summary.status, summary.overtime?.deadlineAt]);

  // Restore any draft for the question currently on screen.
  useEffect(() => {
    if (!isViewingOwnRound) return;
    const draft = getPvpDraft();
    if (
      draft &&
      draft.roomCode === summary.roomCode &&
      draft.roundIndex === viewRoundIndex &&
      draft.segmentIndex === viewSegmentIndex
    ) {
      setAnswers((prev) => ({ ...prev, [draftKey(viewRoundIndex, viewSegmentIndex)]: draft.answer }));
    }
    textareaRef.current?.focus();
  }, [viewRoundIndex, viewSegmentIndex, isViewingOwnRound, summary.roomCode]);

  // --- Derived round data ---------------------------------------------------
  const mySubmissions: Record<number, SegmentSubmission> = useMemo(() => {
    if (!isViewingOwnRound || !viewDetail) return {};
    return viewDetail.players.find((p) => p.playerId === playerId)?.submissions ?? {};
  }, [viewDetail, playerId, isViewingOwnRound]);

  const currentAnswer = answers[draftKey(viewRoundIndex, viewSegmentIndex)] ?? '';
  const currentSubmission = mySubmissions[viewSegmentIndex];
  const currentSegmentText = viewDetail?.exam.translationSegments[viewSegmentIndex] ?? '';
  const isLastRound = !viewDetail?.isOvertime && viewRoundIndex === totalRounds - 1;

  const answeredCount = Object.values(mySubmissions).filter((s) => !!s).length;

  const handleAnswerChange = (value: string) => {
    setAnswers((prev) => ({ ...prev, [draftKey(viewRoundIndex, viewSegmentIndex)]: value }));
    if (isViewingOwnRound) {
      setPvpDraft({
        roomCode: summary.roomCode,
        roundIndex: viewRoundIndex,
        segmentIndex: viewSegmentIndex,
        answer: value,
        updatedAt: Date.now(),
      });
    }
  };

  const handleSubmit = () => {
    const answer = currentAnswer.trim();
    if (!answer || !isViewingOwnRound) return;
    if (currentSubmission) return;

    setSubmitNotice(null);
    const accepted = socket.send({
      type: 'segment:submit',
      payload: { roundIndex: viewRoundIndex, segmentIndex: viewSegmentIndex, studentAnswer: answer },
    });
    if (!accepted) {
      setSubmitNotice('网络连接中断，你的译文已保留，恢复连接后可再次提交');
      return;
    }
    setAnswers((prev) => ({ ...prev, [draftKey(viewRoundIndex, viewSegmentIndex)]: '' }));
    clearPvpDraft();

    // Advance to the next unanswered question in this round (free ordering).
    const answered = { ...mySubmissions, [viewSegmentIndex]: { segmentIndex: viewSegmentIndex } as SegmentSubmission };
    for (let step = 1; step <= SEGMENT_COUNT; step++) {
      const next = (viewSegmentIndex + step) % SEGMENT_COUNT;
      if (!answered[next]) {
        setViewSegmentIndex(next);
        break;
      }
    }
  };

  const handleVote = (agree: boolean) => {
    socket.send({ type: 'overtime:vote', payload: { agree } });
  };

  const handleExit = () => {
    socket.send({ type: 'room:leave' });
    socket.close();
    clearActivePvpRoom();
    clearPvpDraft();
    onExit();
  };

  // --- History persistence on match end -------------------------------------
  useEffect(() => {
    if (summary.status !== 'FINISHED' || !me || historySaved) return;
    setHistorySaved(true);
    clearActivePvpRoom();
    clearPvpDraft();

    const rounds: HistoryRoundRecord[] = [];
    for (let i = 0; i < summary.rounds.length; i++) {
      const detail = roundDetails[i];
      if (!detail) continue;
      const mine = detail.players.find((p) => p.playerId === playerId);
      const entry = detail.scoreEntries?.find((e) => e.playerId === playerId);
      const submissions: SegmentSubmission[] = [];
      for (let seg = 0; seg < SEGMENT_COUNT; seg++) {
        submissions.push(
          mine?.submissions?.[seg] ?? {
            segmentIndex: seg,
            originalText: detail.exam.translationSegments[seg] ?? '',
            studentAnswer: '（超时未作答）',
            gradingStatus: 'graded',
          }
        );
      }
      rounds.push({
        roundIndex: detail.roundIndex,
        year: detail.year,
        isOvertime: detail.isOvertime,
        smallScore: mine?.smallScore ?? 0,
        matchPointsDelta: entry?.matchPointsDelta ?? 0,
        matchPointsAfter: me.matchPoints,
        elapsedSeconds: mine?.elapsedSeconds ?? 0,
        remainingSeconds: mine?.remainingSeconds ?? 0,
        timedOut: mine?.timedOut ?? true,
        submissions,
      });
    }

    const myRank = summary.rankings?.find((r) => r.playerId === playerId)?.rank ?? 1;
    const outcome: 'win' | 'loss' | 'draw' =
      summary.winnerId === playerId ? 'win' : summary.winnerId === 'draw' && myRank === 1 ? 'draw' : 'loss';

    const record: HistorySessionRecord = {
      id: `pvp-${summary.roomCode}-${summary.startedAt ?? summary.createdAt ?? Date.now()}-${playerId}`,
      type: 'pvp',
      year: rounds[0]?.year ?? 0,
      timestamp: Date.now(),
      totalScore: me.totalScore,
      timeSpentSeconds: rounds.reduce((sum, r) => sum + (r.elapsedSeconds || 0), 0),
      submissions: rounds.flatMap((r) => r.submissions),
      roundCount: totalRounds,
      matchPoints: me.matchPoints,
      wentOvertime: rounds.some((r) => r.isOvertime),
      rounds,
      pvpDetails: {
        opponentNickname: summary.players.find((p) => p.playerId !== playerId)?.nickname ?? '',
        opponentScore: summary.players.find((p) => p.playerId !== playerId)?.totalScore ?? 0,
        outcome,
        rank: myRank,
        playerCount: summary.players.length,
        finalMatchPoints: me.matchPoints,
        leaderboard: (summary.rankings ?? []).map((r) => ({
          nickname: r.nickname,
          score: r.totalScore,
          rank: r.rank,
          matchPoints: r.matchPoints,
        })),
      },
    };

    saveHistoryRecord(record);
    (async () => {
      try {
        await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getAuthToken()}` },
          body: JSON.stringify({ record }),
        });
      } catch (err) {
        console.error('Failed to sync PVP history', err);
      }
    })();
  }, [summary.status, historySaved, summary, me, playerId, roundDetails, totalRounds]);

  // --- Round navigation -----------------------------------------------------
  const startedRounds = summary.rounds.filter((r) => r.year !== null);
  const goToRound = (roundIndex: number) => {
    setPinnedRound(roundIndex === (me ? me.currentRoundIndex : roomRoundIndex) ? null : roundIndex);
    setViewSegmentIndex(0);
  };

  const roundLabel = (roundIndex: number, isOvertime: boolean) =>
    isOvertime ? '加赛局' : `第${roundIndex + 1}轮`;

  const renderRoundTabs = (compact = false) => (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {startedRounds.map((round) => {
        const active = round.roundIndex === viewRoundIndex;
        const meta = summary.rounds.find((r) => r.roundIndex === round.roundIndex);
        return (
          <button
            key={round.roundIndex}
            onClick={() => goToRound(round.roundIndex)}
            className={`shrink-0 px-2.5 py-1 border-2 font-mono text-[11px] font-bold transition-colors ${
              active
                ? 'border-swiss-red bg-swiss-red text-white'
                : 'border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-swiss-black'
            }`}
          >
            {roundLabel(round.roundIndex, round.isOvertime)}
            {!compact && meta?.year ? ` · ${meta.year}` : ''}
            {round.settled && <Check className="w-3 h-3 inline ml-1" />}
          </button>
        );
      })}
      {pinnedRound !== null && (
        <button
          onClick={() => {
            setPinnedRound(null);
            setViewSegmentIndex(0);
          }}
          className="shrink-0 px-2 py-1 border-2 border-emerald-500 text-emerald-600 dark:text-emerald-400 font-mono text-[11px] font-bold"
        >
          回到当前轮
        </button>
      )}
    </div>
  );

  const renderScoreStrip = (entry?: RoundScoreEntry) => {
    if (!entry) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-300">
        <span>本轮小分 {entry.smallScore.toFixed(1)}</span>
        <span className="text-zinc-400">|</span>
        <span>他人平均 {entry.baselineScore.toFixed(2)}</span>
        <span className="text-zinc-400">|</span>
        <span className={entry.deltaS > 0 ? 'text-emerald-600 dark:text-emerald-400 font-bold' : ''}>
          ΔS {entry.deltaS.toFixed(2)}
        </span>
        {entry.timePart > 0 && (
          <>
            <span className="text-zinc-400">|</span>
            <span className="text-blue-600 dark:text-blue-400">速度 +{entry.timePart.toFixed(1)}</span>
          </>
        )}
        <span className="text-zinc-400">|</span>
        <span className="font-black text-swiss-red">+{entry.matchPointsDelta.toFixed(1)} 大比分</span>
      </div>
    );
  };

  const renderPlayerRoundCard = (player: RoundDetailPlayer) => {
    const isMe = player.playerId === playerId;
    return (
      <div
        key={player.playerId}
        className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 space-y-3"
      >
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs font-black text-swiss-black dark:text-zinc-100 truncate">
              {player.nickname}
            </span>
            {isMe && (
              <span className="text-[9px] bg-swiss-red text-white px-1 font-mono font-bold uppercase">YOU</span>
            )}
            {player.timedOut && (
              <span className="text-[9px] bg-amber-500 text-black px-1 font-mono font-bold">超时</span>
            )}
          </div>
          <span className="font-mono text-xs font-black text-swiss-red shrink-0">
            {player.smallScore.toFixed(1)} 分
          </span>
        </div>

        {(() => {
          const sub = player.submissions?.[viewSegmentIndex];
          if (!sub) {
            return (
              <p className="font-mono text-[11px] text-zinc-500">
                {player.phase === 'left' ? '该选手已退赛' : '本题未作答'}
              </p>
            );
          }
          if (sub.gradingStatus === 'grading' || sub.gradingStatus === 'idle') {
            return (
              <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                AI 并列评阅中…
              </p>
            );
          }
          if (!sub.studentAnswer) {
            return <p className="font-mono text-[11px] text-zinc-500">（该选手的译文在你完赛后才可见）</p>;
          }
          return (
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">{sub.studentAnswer}</p>
              {sub.gradingResult && (
                <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                  得分 {sub.gradingResult.score.toFixed(1)} / 2.0
                  {sub.gradingResult.critique && (
                    <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{sub.gradingResult.critique}</p>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  };

  const renderStandings = () => (
    <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 font-mono text-xs space-y-2">
      <div className="flex items-center gap-1.5 font-bold text-zinc-700 dark:text-zinc-200 uppercase pb-1.5 border-b border-zinc-200 dark:border-zinc-800">
        <Trophy className="w-3.5 h-3.5 text-swiss-red" />
        <span>实时排名（大比分 → 累计小分）</span>
      </div>
      {[...summary.players]
        .sort((a, b) =>
          b.matchPoints !== a.matchPoints ? b.matchPoints - a.matchPoints : b.totalScore - a.totalScore
        )
        .map((p, idx) => (
          <div
            key={p.playerId}
            className="flex items-center justify-between gap-2 p-1.5 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-black text-zinc-400">#{idx + 1}</span>
              <span className="font-bold truncate text-swiss-black dark:text-zinc-100">{p.nickname}</span>
              {p.phase === 'awaiting' && <span className="text-[9px] text-emerald-600">已完赛</span>}
              {p.phase === 'left' && <span className="text-[9px] text-zinc-500">退赛</span>}
              {p.isOnline === false && <span className="text-[9px] text-amber-500">离线</span>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-swiss-red font-black">MP {p.matchPoints.toFixed(1)}</span>
              <span className="text-zinc-500">小分 {p.totalScore.toFixed(1)}</span>
            </div>
          </div>
        ))}
    </div>
  );

  const renderOvertimeBanner = () => {
    if (!summary.overtime) return null;
    const { participants, votes } = summary.overtime;
    const yes = participants.filter((p) => votes[p] === 'yes').length;
    const no = participants.filter((p) => votes[p] === 'no').length;
    const iAmParticipant = participants.includes(playerId);
    const myVote = votes[playerId];

    if (summary.status === 'OVERTIME_VOTE') {
      return (
        <div className="border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/40 p-4 space-y-3">
          <div className="flex items-center gap-2 font-mono text-xs font-black uppercase text-amber-800 dark:text-amber-300">
            <Vote className="w-4 h-4" />
            <span>终局平分 · 加赛投票{voteRemaining !== null ? ` (${voteRemaining}s)` : ''}</span>
          </div>
          <p className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
            并列选手：
            {participants.map((pid) => summary.players.find((p) => p.playerId === pid)?.nickname ?? pid).join('、')}
            　·　已同意 {yes}/{participants.length}
            {no > 0 && `　·　已拒绝 ${no}`}
          </p>
          <p className="font-mono text-[11px] text-zinc-500">
            全票同意才开启加赛；任一方拒绝或超时未选，以平局完赛。
          </p>
          {iAmParticipant && !myVote && (
            <div className="flex gap-2">
              <button
                onClick={() => handleVote(true)}
                className="flex-1 py-2.5 bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black font-mono text-xs font-bold uppercase"
              >
                同意加赛
              </button>
              <button
                onClick={() => handleVote(false)}
                className="flex-1 py-2.5 border-2 border-swiss-black dark:border-zinc-600 font-mono text-xs font-bold uppercase text-zinc-700 dark:text-zinc-200"
              >
                握手言和（平局）
              </button>
            </div>
          )}
          {iAmParticipant && myVote && (
            <p className="font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
              你已投出「{myVote === 'yes' ? '同意加赛' : '握手言和'}」，等待其他选手…
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  const renderFinalPanel = () => (
    <div className="space-y-4">
      <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 text-center space-y-2">
        <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">
          系列赛结束 · {totalRounds} 轮{summary.rounds.some((r) => r.isOvertime) ? ' · 经历加赛' : ''}
        </div>
        <div className="font-mono text-3xl font-black text-swiss-red">
          {summary.winnerId === 'draw'
            ? '平局'
            : summary.players.find((p) => p.playerId === summary.winnerId)?.nickname ?? '—'}
          {summary.winnerId !== 'draw' && <span className="text-base ml-1">胜出</span>}
        </div>
      </div>

      {renderStandings()}

      <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 font-mono text-xs space-y-3">
        <div className="font-bold uppercase text-zinc-700 dark:text-zinc-200 pb-1.5 border-b border-zinc-200 dark:border-zinc-800">
          逐轮明细
        </div>
        {startedRounds.map((round) => {
          const detail = roundDetails[round.roundIndex];
          const entry = detail?.scoreEntries?.find((e) => e.playerId === playerId);
          const mine = detail?.players.find((p) => p.playerId === playerId);
          return (
            <div key={round.roundIndex} className="p-2 border border-zinc-200 dark:border-zinc-800 space-y-1">
              <div className="flex items-center justify-between">
                <span className="font-bold">
                  {roundLabel(round.roundIndex, round.isOvertime)} · {round.year} 年
                </span>
                <span className="text-swiss-red font-black">
                  {mine ? `${mine.smallScore.toFixed(1)} 分` : '—'}
                  {entry ? ` / +${entry.matchPointsDelta.toFixed(1)}` : ''}
                </span>
              </div>
              {entry && renderScoreStrip(entry)}
            </div>
          );
        })}
      </div>

      {me && (
        <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 font-mono text-xs">
          <div className="font-bold uppercase text-zinc-700 dark:text-zinc-200 pb-2 border-b border-zinc-200 dark:border-zinc-800 mb-2">
            你的答卷回放
          </div>
          {renderRoundTabs()}
          <div className="mt-3 space-y-3">
            {roundDetails[viewRoundIndex]?.players
              .filter((p) => p.playerId === playerId)
              .map((p) => {
                const sub = p.submissions?.[viewSegmentIndex];
                return sub?.gradingResult ? (
                  <GradingCard
                    key={viewSegmentIndex}
                    result={sub.gradingResult}
                    studentAnswer={sub.studentAnswer}
                    originalText={sub.originalText}
                    segmentIndex={viewSegmentIndex}
                  />
                ) : (
                  <p key={viewSegmentIndex} className="text-zinc-500">
                    第 {viewSegmentIndex + 1} 题无评分记录。
                  </p>
                );
              })}
          </div>
          <div className="flex items-center justify-center gap-2 mt-3">
            <button
              onClick={() => setViewSegmentIndex((i) => Math.max(0, i - 1))}
              disabled={viewSegmentIndex === 0}
              className="px-2 py-1 border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[11px]">第 {viewSegmentIndex + 1} / {SEGMENT_COUNT} 题</span>
            <button
              onClick={() => setViewSegmentIndex((i) => Math.min(SEGMENT_COUNT - 1, i + 1))}
              disabled={viewSegmentIndex >= SEGMENT_COUNT - 1}
              className="px-2 py-1 border border-zinc-300 dark:border-zinc-700 disabled:opacity-40"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // --- Spectator / awaiting board ------------------------------------------
  const renderSpectatorBoard = () => (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renderRoundTabs()}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setSpectateViewMode('question')}
            className={`px-2 py-1 border-2 font-mono text-[11px] font-bold flex items-center gap-1 ${
              spectateViewMode === 'question'
                ? 'border-swiss-red bg-swiss-red text-white'
                : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300'
            }`}
          >
            <ListChecks className="w-3 h-3" /> 分题实况
          </button>
          <button
            onClick={() => setSpectateViewMode('matrix')}
            className={`px-2 py-1 border-2 font-mono text-[11px] font-bold flex items-center gap-1 ${
              spectateViewMode === 'matrix'
                ? 'border-swiss-red bg-swiss-red text-white'
                : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300'
            }`}
          >
            <LayoutGrid className="w-3 h-3" /> 全景矩阵
          </button>
        </div>
      </div>

      {spectateViewMode === 'question' ? (
        viewDetail ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            <div className="lg:col-span-5 space-y-3">
              <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 space-y-3">
                <div className="flex items-center justify-between pb-2 border-b-2 border-swiss-black dark:border-zinc-700">
                  <span className="font-mono text-xs font-bold uppercase">
                    {roundLabel(viewDetail.roundIndex, viewDetail.isOvertime)} · {viewDetail.year} 年 · 第{' '}
                    {viewSegmentIndex + 1} 题
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400">满分 2.0</span>
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: SEGMENT_COUNT }).map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setViewSegmentIndex(idx)}
                      className={`flex-1 py-1 border font-mono text-[11px] font-bold ${
                        idx === viewSegmentIndex
                          ? 'border-swiss-red bg-swiss-red text-white'
                          : 'border-zinc-300 dark:border-zinc-700 text-zinc-500'
                      }`}
                    >
                      {idx + 1}
                    </button>
                  ))}
                </div>
                <p className="p-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700 font-serif text-sm leading-relaxed">
                  {viewDetail.exam.translationSegments[viewSegmentIndex]}
                </p>
                <details className="font-mono text-[11px]">
                  <summary className="cursor-pointer text-zinc-500">展开整篇短文</summary>
                  <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap p-2 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 leading-relaxed">
                    {viewDetail.exam.contentMarkdown}
                  </div>
                </details>
              </div>
              {viewDetail.scoreEntries && (
                <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3">
                  <div className="font-mono text-[11px] font-bold uppercase mb-2">本轮结算</div>
                  <div className="space-y-1.5">
                    {viewDetail.scoreEntries.map((e) => (
                      <div key={e.playerId} className="font-mono text-[11px]">
                        <span className="font-bold">
                          {summary.players.find((p) => p.playerId === e.playerId)?.nickname ?? e.playerId}
                        </span>
                        <span className="ml-2 text-swiss-red font-black">+{e.matchPointsDelta.toFixed(1)}</span>
                        <div className="text-zinc-500">{renderScoreStrip(e)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="lg:col-span-7 space-y-3">
              {viewDetail.players
                .slice()
                .sort((a, b) => b.smallScore - a.smallScore)
                .map(renderPlayerRoundCard)}
            </div>
          </div>
        ) : (
          <p className="font-mono text-xs text-zinc-500">该轮暂无数据。</p>
        )
      ) : (
        <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-x-auto">
          <table className="w-full font-mono text-[11px] border-collapse">
            <thead>
              <tr className="bg-zinc-100 dark:bg-zinc-800">
                <th className="p-2 text-left border border-zinc-200 dark:border-zinc-700">轮次 / 题号</th>
                {summary.players.map((p) => (
                  <th key={p.playerId} className="p-2 border border-zinc-200 dark:border-zinc-700">
                    {p.nickname}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {startedRounds.map((round) =>
                Array.from({ length: SEGMENT_COUNT }).map((_, seg) => (
                  <tr key={`${round.roundIndex}-${seg}`}>
                    <td className="p-1.5 border border-zinc-200 dark:border-zinc-700 whitespace-nowrap">
                      <button
                        onClick={() => {
                          goToRound(round.roundIndex);
                          setViewSegmentIndex(seg);
                        }}
                        className="underline decoration-dotted"
                      >
                        {roundLabel(round.roundIndex, round.isOvertime)}-Q{seg + 1}
                      </button>
                    </td>
                    {summary.players.map((p) => {
                      const detail = roundDetails[round.roundIndex];
                      const sub = detail?.players.find((x) => x.playerId === p.playerId)?.submissions?.[seg];
                      const score = sub?.gradingResult?.score;
                      return (
                        <td
                          key={p.playerId}
                          className={`p-1.5 border border-zinc-200 dark:border-zinc-700 text-center ${
                            score !== undefined
                              ? score >= 1.5
                                ? 'bg-emerald-50 dark:bg-emerald-950/40'
                                : score >= 1
                                  ? 'bg-amber-50 dark:bg-amber-950/30'
                                  : 'bg-rose-50 dark:bg-rose-950/30'
                              : ''
                          }`}
                        >
                          {score !== undefined ? score.toFixed(1) : sub ? '…' : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  // --- Live answering ------------------------------------------------------
  const renderAnswering = () => {
    if (!me || !viewDetail) {
      return <p className="font-mono text-xs text-zinc-500 p-4">正在载入本轮试题…</p>;
    }
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-5 lg:order-2 space-y-4">
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-3.5">
            <div className="flex items-center justify-between pb-2 border-b-2 border-swiss-black dark:border-zinc-700">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 bg-swiss-red animate-pulse"></span>
                <span className="font-mono text-xs font-bold uppercase tracking-wider">
                  {viewDetail.isOvertime ? '加赛局' : `第 ${viewRoundIndex + 1} / ${totalRounds} 轮`} ·{' '}
                  {viewDetail.year} 年 · 第 {viewSegmentIndex + 1} 题
                </span>
              </div>
              <span className="font-mono text-xs font-bold text-zinc-400">满分 2.0 分</span>
            </div>

            {/* Free navigation: any of the five questions, in any order */}
            <div className="flex gap-1">
              {Array.from({ length: SEGMENT_COUNT }).map((_, idx) => {
                const sub = mySubmissions[idx];
                const isCurrent = idx === viewSegmentIndex;
                return (
                  <button
                    key={idx}
                    onClick={() => setViewSegmentIndex(idx)}
                    title={sub ? '已提交（可回看）' : '未作答'}
                    className={`flex-1 py-1.5 border-2 font-mono text-[11px] font-bold flex items-center justify-center gap-1 ${
                      isCurrent
                        ? 'border-swiss-red bg-swiss-red text-white'
                        : sub
                          ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                          : 'border-zinc-300 dark:border-zinc-700 text-zinc-500'
                    }`}
                  >
                    {sub ? <Check className="w-3 h-3" /> : null}
                    {idx + 1}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
              <span>已作答 {answeredCount} / {SEGMENT_COUNT} 题</span>
              <span>本轮剩余 {durationSeconds ? `${Math.round(durationSeconds / 60)} 分钟上限` : '—'}</span>
            </div>

            <div className="p-3 sm:p-4 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700 font-serif text-sm sm:text-base leading-relaxed">
              {currentSegmentText}
            </div>

            {currentSubmission ? (
              <div className="space-y-3">
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800 font-mono text-[11px]">
                  本题已提交{currentSubmission.gradingStatus === 'graded' ? '并已出分' : '，AI 并列评阅中…'}
                  <p className="mt-1 text-zinc-700 dark:text-zinc-300">{currentSubmission.studentAnswer}</p>
                </div>
                {currentSubmission.gradingResult && (
                  <GradingCard
                    result={currentSubmission.gradingResult}
                    studentAnswer={currentSubmission.studentAnswer}
                    originalText={currentSubmission.originalText}
                    segmentIndex={viewSegmentIndex}
                  />
                )}
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-xs text-zinc-500">
                    <label htmlFor="pvp-input" className="font-bold uppercase text-[11px]">
                      输入您的中文翻译：
                    </label>
                    <span className="text-[10px] hidden sm:inline">Ctrl + Enter 快捷提交</span>
                  </div>
                  <textarea
                    id="pvp-input"
                    ref={textareaRef}
                    value={currentAnswer}
                    onChange={(e) => handleAnswerChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.ctrlKey && e.key === 'Enter') handleSubmit();
                    }}
                    rows={4}
                    placeholder="在此输入翻译，提交后可自由跳到任意一题…"
                    className="w-full border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3 font-sans text-base sm:text-sm focus:outline-none focus:border-swiss-red transition-colors placeholder:text-zinc-400 resize-none leading-relaxed"
                  />
                </div>
                <button
                  onClick={handleSubmit}
                  disabled={!currentAnswer.trim() || connectionStatus === 'fatal'}
                  className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.99]"
                >
                  <span>
                    提交第 {viewSegmentIndex + 1} 题
                    {answeredCount + 1 >= SEGMENT_COUNT
                      ? isLastRound
                        ? ' · 交卷封顶'
                        : ' · 完成本轮'
                      : ''}
                  </span>
                  <Send className="w-4 h-4" />
                </button>
              </>
            )}
            {submitNotice && (
              <p className="font-mono text-[11px] text-amber-600 dark:text-amber-400">{submitNotice}</p>
            )}
          </div>

          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3.5 font-mono text-xs space-y-2">
            <button
              onClick={() => setSpectateViewMode('question')}
              className="hidden"
              aria-hidden="true"
            ></button>
            <div className="flex items-center justify-between pb-1.5 border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-1.5 font-bold uppercase text-zinc-700 dark:text-zinc-200">
                <Users className="w-3.5 h-3.5 text-swiss-red" />
                <span>同场对手 ({summary.players.length - 1}人)</span>
              </div>
              <span className="text-[11px] text-zinc-500">仅显示进度，答案完赛后可见</span>
            </div>
            {summary.players
              .filter((p) => p.playerId !== playerId)
              .map((p) => (
                <div
                  key={p.playerId}
                  className="flex items-center justify-between gap-2 p-2 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700"
                >
                  <span className="font-bold truncate">{p.nickname}</span>
                  <span className="text-[11px] text-swiss-red font-black shrink-0">
                    MP {p.matchPoints.toFixed(1)} · {p.totalScore.toFixed(1)}分
                  </span>
                  <span className="px-2 py-0.5 text-[11px] font-bold shrink-0 bg-zinc-200/80 dark:bg-zinc-700">
                    {p.phase === 'left'
                      ? '已退赛'
                      : p.phase === 'awaiting'
                        ? '已完赛'
                        : p.isOnline === false
                          ? '离线'
                          : `R${p.currentRoundIndex + 1}-Q${Math.min(p.currentSegmentIndex + 1, 5)}`}
                  </span>
                </div>
              ))}
          </div>

          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
            <Clock className="w-3 h-3" />
            <span>每位选手本轮独立计时；你先完成就能先进入下一轮。</span>
          </div>
        </div>

        {/* Passage drawer */}
        <div className="lg:col-span-7 lg:order-1">
          <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-5">
            <div className="font-mono text-xs font-bold uppercase pb-2 border-b-2 border-swiss-black dark:border-zinc-700 mb-3">
              短文全文（{viewDetail.year} 年真题）
            </div>
            <div className="whitespace-pre-wrap font-serif text-sm leading-loose text-zinc-800 dark:text-zinc-200 max-h-[60vh] overflow-y-auto">
              {viewDetail.exam.contentMarkdown}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderAwaiting = () => (
    <div className="space-y-4">
      <div className="border-2 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 p-4 font-mono text-xs">
        <p className="font-black uppercase text-emerald-800 dark:text-emerald-300 mb-1">
          你已完成全部 {totalRounds} 轮
        </p>
        <p className="text-zinc-700 dark:text-zinc-300">
          其他选手还在作答。你可以在这里观战、回看自己的答卷；若终局平分需要加赛，你会自动回到选手席位。
          为保证公平，其他选手的译文要等你完赛后才可见（你现在已完赛）。
        </p>
      </div>
      {renderOvertimeBanner()}
      {renderStandings()}
      {renderSpectatorBoard()}
    </div>
  );

  const showFinal = summary.status === 'FINISHED';

  return (
    <div className="min-h-screen bg-swiss-paper dark:bg-swiss-paper-dark">
      <PvpHud
        summary={summary}
        currentPlayerId={playerId}
        isSpectator={isSpectator}
        spectatorCount={summary.spectators.length}
        roundDetail={viewDetail}
        onExit={handleExit}
      />

      {/* Non-blocking toasts: round results never interrupt typing */}
      <div className="fixed top-20 right-3 z-40 space-y-2 max-w-xs">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3 py-2 border-2 font-mono text-[11px] shadow-md bg-white dark:bg-zinc-900 ${
              t.tone === 'good'
                ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300'
                : t.tone === 'warn'
                  ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'border-zinc-400 text-zinc-700 dark:text-zinc-200'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>

      {/* Round transition: fades on its own, never blocks input */}
      {roundTransition && !showFinal && (
        <div className="fixed inset-x-0 top-1/3 z-40 flex justify-center pointer-events-none">
          <div className="bg-swiss-black/95 text-white px-6 py-4 border-2 border-white/20 font-mono text-center animate-pulse">
            <div className="text-2xl font-black">
              {roundTransition.roundIndex >= totalRounds
                ? '加赛局'
                : `第 ${roundTransition.roundIndex + 1} 轮`}
            </div>
            <div className="text-xs text-zinc-300 mt-1">{roundTransition.year} 年真题 · 倒计时进行中</div>
          </div>
        </div>
      )}

      {connectionMessage && connectionStatus !== 'open' && (
        <div className="bg-amber-500 text-black font-mono text-[11px] px-3 py-1.5 text-center">
          {connectionMessage}
        </div>
      )}

      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-5">
        {summary.status === 'COUNTDOWN' && (
          <div className="text-center font-mono py-12">
            <Swords className="w-8 h-8 mx-auto text-swiss-red mb-3" />
            <p className="text-lg font-black">对战即将开始…</p>
            <p className="text-xs text-zinc-500 mt-1">
              {totalRounds} 轮 · 每轮 {summary.config.durationMinutes} 分钟独立计时
            </p>
            <button
              onClick={handleExit}
              className="mt-6 inline-flex items-center gap-1 px-3 py-1.5 border-2 border-swiss-black dark:border-zinc-600 font-mono text-[11px] font-bold"
            >
              <ArrowLeft className="w-3 h-3" /> 退出房间
            </button>
          </div>
        )}

        {showFinal && renderFinalPanel()}

        {!showFinal && summary.status !== 'COUNTDOWN' && (
          <>
            {summary.status === 'OVERTIME_VOTE' && renderOvertimeBanner()}
            {isSpectator && (
              <div className="flex items-center gap-2 font-mono text-[11px] text-blue-600 dark:text-blue-400">
                <Eye className="w-3.5 h-3.5" />
                <span>你正在实时观战，可自由切换轮次查看每位选手的作答与 AI 点评</span>
              </div>
            )}
            {isPlaying && renderAnswering()}
            {!isPlaying && !isSpectator && renderAwaiting()}
            {isSpectator && renderSpectatorBoard()}
          </>
        )}
      </div>
    </div>
  );
};
