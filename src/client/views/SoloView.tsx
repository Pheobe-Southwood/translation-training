import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Loader2, Trophy, RotateCcw, BookOpen } from 'lucide-react';
import confetti from 'canvas-confetti';
import type { TranslationExam, SegmentSubmission, HistorySessionRecord, TranslationDirection } from '../../shared/types.js';
import { directionLabel, directionShort } from '../../shared/direction.js';
import { getAuthToken, persistHistoryRecord } from '../utils/storage.js';
import { paperPartLabel } from '../utils/exams.js';
import { playSuccessSound } from '../utils/sound.js';
import { GradingCard } from '../components/GradingCard.js';
import { AnswerCard, PrevGradingBar } from '../components/AnswerCard.js';
import { PassageAccordion } from '../components/HighlightedPassage.js';

interface SoloViewProps {
  /** Canonical paper id, e.g. `2024-translation` / `2004-reading-2`. */
  examId: string;
  direction: TranslationDirection;
  onBack: () => void;
}

export const SoloView: React.FC<SoloViewProps> = ({ examId, direction, onBack }) => {
  const isZhEn = direction === 'zh-en';
  const [exam, setExam] = useState<TranslationExam | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [submissions, setSubmissions] = useState<Record<number, SegmentSubmission>>({});
  const [startTime] = useState<number>(Date.now());
  const [isAllCompleted, setIsAllCompleted] = useState(false);
  const [activeCardTab, setActiveCardTab] = useState<number | null>(null);
  const [isPassageOpenMobile, setIsPassageOpenMobile] = useState(false);

  const sessionIdRef = useRef<string>(
    `solo-${examId}-${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const hasPersistedRef = useRef<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchExam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, direction]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [currentIdx]);

  const fetchExam = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const token = getAuthToken();
      // `direction` is still honoured for the translation bank; for cloze/reading
      // the server ignores it and always projects English→Chinese.
      const res = await fetch(
        `/api/exams/${encodeURIComponent(examId)}?direction=${encodeURIComponent(direction)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setExam(data.exam);
      } else {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || `试卷 ${examId} 暂不可用（HTTP ${res.status}）`);
      }
    } catch (err) {
      console.error('Failed to load exam:', err);
      setLoadError('网络异常，未能加载试卷，请稍后重试。');
    } finally {
      setLoading(false);
    }
  };

  /** Number of target sentences: 5 for translation papers, 3–5 for passage papers. */
  const segmentCount = exam?.translationSegments.length || 0;
  const currentSegment = exam?.translationSegments[currentIdx] || '';
  const paperDisplay = exam
    ? exam.bank === 'translation'
      ? `${exam.year} 年英语（一）${directionLabel(direction)}`
      : `${exam.year} 年${paperPartLabel(exam)}`
    : '';

  const totalScore = Object.values(submissions).reduce(
    (acc, s) => acc + (s.gradingResult?.score || 0),
    0
  );

  const handleConfirmSubmit = () => {
    if (!exam || !currentAnswer.trim()) return;

    const segmentIndexToSubmit = currentIdx;
    const answerToSubmit = currentAnswer.trim();
    const originalText = exam.translationSegments[segmentIndexToSubmit];
    const lastIndex = exam.translationSegments.length - 1;

    setSubmissions((prev) => ({
      ...prev,
      [segmentIndexToSubmit]: {
        segmentIndex: segmentIndexToSubmit,
        originalText,
        studentAnswer: answerToSubmit,
        gradingStatus: 'grading',
        submittedAt: Date.now(),
      },
    }));

    setCurrentAnswer('');

    if (segmentIndexToSubmit < lastIndex) {
      setCurrentIdx(segmentIndexToSubmit + 1);
    } else {
      setIsAllCompleted(true);
    }

    triggerBackgroundGrading(segmentIndexToSubmit, answerToSubmit);
  };

  const triggerBackgroundGrading = async (
    segmentIndex: number,
    studentAnswer: string
  ) => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/solo/grade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          examId,
          direction,
          segmentIndex,
          studentAnswer,
        }),
      });

      if (!res.ok) {
        throw new Error('评分接口返回错误');
      }

      const data = await res.json();
      setSubmissions((prev) => ({
        ...prev,
        [segmentIndex]: {
          ...prev[segmentIndex],
          gradingStatus: 'graded' as const,
          gradingResult: data.gradingResult,
        },
      }));
    } catch (err: any) {
      console.error('Grading error:', err);
      setSubmissions((prev) => ({
        ...prev,
        [segmentIndex]: {
          ...prev[segmentIndex],
          gradingStatus: 'error' as const,
        },
      }));
    }
  };

  useEffect(() => {
    if (!isAllCompleted || hasPersistedRef.current || !exam) return;

    const expected = exam.translationSegments.length;
    const keys = Object.keys(submissions);
    if (keys.length === expected) {
      const allSettled = Object.values(submissions).every(
        (s) => s.gradingStatus === 'graded' || s.gradingStatus === 'error'
      );
      if (allSettled) {
        hasPersistedRef.current = true;
        const finalScore = Object.values(submissions).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );
        const record: HistorySessionRecord = {
          id: sessionIdRef.current,
          type: 'solo',
          year: exam.year,
          examId: exam.examId,
          bank: exam.bank,
          partLabel: exam.partLabel,
          direction,
          timestamp: Date.now(),
          totalScore: finalScore,
          timeSpentSeconds: Math.floor((Date.now() - startTime) / 1000),
          submissions: Object.values(submissions),
        };
        persistHistoryRecord(record);
        playSuccessSound();
        try {
          confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
        } catch {}
      }
    }
  }, [submissions, isAllCompleted, exam, examId, direction, startTime]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center font-mono text-xs text-zinc-600 dark:text-zinc-400">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-swiss-red mb-3" />
        正在加载试卷（{directionLabel(direction)}）...
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-10 space-y-5">
        <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 sm:p-8 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] space-y-4 text-center">
          <div className="w-12 h-12 bg-swiss-red text-white flex items-center justify-center mx-auto">
            <BookOpen className="w-6 h-6" />
          </div>
          <h2 className="text-xl sm:text-2xl font-black uppercase text-swiss-black dark:text-zinc-100">
            试卷暂不可用
          </h2>
          <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
            {loadError || `未找到试卷 ${examId}`}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button
              onClick={fetchExam}
              className="px-5 py-3 bg-swiss-black hover:bg-swiss-red text-white dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white font-mono text-xs font-bold uppercase transition-colors active:scale-[0.99]"
            >
              重新加载
            </button>
            <button
              onClick={onBack}
              className="px-5 py-3 border-2 border-swiss-black dark:border-zinc-700 font-mono text-xs font-bold uppercase transition-colors text-swiss-black dark:text-zinc-200 active:scale-[0.99]"
            >
              返回题库首页
            </button>
          </div>
        </div>
      </div>
    );
  }

  const allGradingDone =
    isAllCompleted &&
    Object.values(submissions).length === segmentCount &&
    Object.values(submissions).every(
      (s) => s.gradingStatus === 'graded' || s.gradingStatus === 'error'
    );

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-8 space-y-4 sm:space-y-6">
      {/* Top Header & Progress */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b-2 border-swiss-black dark:border-zinc-800 pb-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 border border-zinc-300 dark:border-zinc-700 hover:border-swiss-black dark:hover:border-zinc-400 font-mono text-xs font-bold transition-colors bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回</span>
        </button>

        <div className="flex items-center gap-1.5 font-mono text-[10px] sm:text-xs font-bold uppercase border border-swiss-black dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-2 py-1">
          <span className="text-swiss-red">{directionShort(direction)}</span>
          <span className="text-zinc-500 dark:text-zinc-400">{directionLabel(direction)}</span>
        </div>

        {/* Per-segment Progress Indicator: count follows the paper (3–5) */}
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-zinc-500 dark:text-zinc-400 font-bold uppercase hidden md:inline">做题进度：</span>
          <div className="flex items-center gap-1">
            {exam.translationSegments.map((_, idx) => {
              const sub = submissions[idx];
              const isCurrent = currentIdx === idx && !isAllCompleted;
              return (
                <button
                  key={idx}
                  onClick={() => {
                    if (sub) setActiveCardTab(activeCardTab === idx ? null : idx);
                  }}
                  className={`w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center font-mono font-bold text-xs border transition-all ${
                    sub?.gradingStatus === 'graded'
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : sub?.gradingStatus === 'grading'
                      ? 'bg-amber-400 text-black border-amber-400 animate-pulse'
                      : isCurrent
                      ? 'bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black border-swiss-black dark:border-zinc-100'
                      : 'bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {sub?.gradingStatus === 'grading' ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    idx + 1
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Score ticker: full score comes from the paper itself */}
        <div className="flex items-center gap-1.5 font-mono bg-zinc-100 dark:bg-zinc-800 border border-swiss-black dark:border-zinc-700 px-2.5 py-0.5 sm:px-3.5 sm:py-1">
          <span className="text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-400 uppercase font-bold">总分</span>
          <span className="text-base sm:text-lg font-black text-swiss-red">{totalScore.toFixed(1)}</span>
          <span className="text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-400">/ {exam.maxScore.toFixed(1)}</span>
        </div>
      </div>

      {!isAllCompleted ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
          {/* Active Target Sentence & Input Box (Desktop Right 5 cols, Mobile TOP 12 cols) */}
          <div className="lg:col-span-5 lg:order-2 space-y-4">
            <AnswerCard
              inputId="answer-input"
              direction={direction}
              segmentNumber={currentIdx + 1}
              segmentCount={segmentCount}
              segmentText={currentSegment}
              value={currentAnswer}
              onChange={setCurrentAnswer}
              onSubmit={handleConfirmSubmit}
              textareaRef={textareaRef}
              placeholder={isZhEn ? '在此输入英文翻译...' : '在此输入中文翻译...'}
              finishLabel="交卷结算"
              disabled={!currentAnswer.trim()}
            />
          </div>

          {/* Passage Context & Previous Scoring (Desktop Left 7 cols, Mobile BOTTOM 12 cols) */}
          <div className="lg:col-span-7 lg:order-1 space-y-4">
            {/* Asynchronous Grading Feedback Bar for Previous Question */}
            {currentIdx > 0 && submissions[currentIdx - 1] && (
              <PrevGradingBar
                variant="solo"
                submission={submissions[currentIdx - 1]}
                segmentNumber={currentIdx}
                expanded={activeCardTab === currentIdx - 1}
                onToggle={() =>
                  setActiveCardTab(activeCardTab === currentIdx - 1 ? null : currentIdx - 1)
                }
              />
            )}

            {/* Expanded Grading Drawer if clicked */}
            {activeCardTab !== null && submissions[activeCardTab]?.gradingResult && (
              <GradingCard
                result={submissions[activeCardTab].gradingResult!}
                studentAnswer={submissions[activeCardTab].studentAnswer}
                originalText={submissions[activeCardTab].originalText}
                segmentIndex={activeCardTab}
                direction={direction}
              />
            )}

            <PassageAccordion
              direction={direction}
              contextTitle={
                exam.bank === 'translation'
                  ? `${exam.year} 年${isZhEn ? '中文语境' : '短文语境'}`
                  : `${exam.year} 年 · ${paperPartLabel(exam)}`
              }
              badge={isZhEn ? '中文题干 · 英文作答' : '红色标尺即为本题目标'}
              passage={exam.contentMarkdown}
              activeSentence={currentSegment}
              open={isPassageOpenMobile}
              onToggle={() => setIsPassageOpenMobile(!isPassageOpenMobile)}
              footer={
                isZhEn ? (
                  <div className="mt-3 pt-2 border-t border-zinc-200 dark:border-zinc-700 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                    语境为网络参考译文；若未高亮，以上方中文题干为准。
                  </div>
                ) : undefined
              }
            />
          </div>
        </div>
      ) : (
        /* Final Scorecard Screen */
        <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
          <div className="border-2 sm:border-4 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 sm:p-12 shadow-[6px_6px_0px_0px_#09090b] dark:shadow-[6px_6px_0px_0px_#000000] text-center space-y-5 sm:space-y-6">
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-swiss-red text-white flex items-center justify-center mx-auto border-2 border-swiss-black dark:border-zinc-700">
              <Trophy className="w-7 h-7 sm:w-8 sm:h-8" />
            </div>

            <div>
              <div className="font-mono text-xs uppercase font-bold tracking-widest text-zinc-500 dark:text-zinc-400 mb-2">
                EXAMINATION COMPLETED // 练习完成
              </div>
              <h2 className="text-2xl sm:text-4xl md:text-5xl font-black uppercase text-swiss-black dark:text-zinc-100">
                {paperDisplay}总评
              </h2>
            </div>

            <div className="py-5 sm:py-6 border-y-2 border-swiss-black dark:border-zinc-800 max-w-sm mx-auto flex items-baseline justify-center gap-3">
              <span className="font-mono text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400">总得分</span>
              <span className="font-mono text-5xl sm:text-6xl font-black text-swiss-red">
                {totalScore.toFixed(1)}
              </span>
              <span className="font-mono text-base sm:text-lg font-bold text-zinc-400 dark:text-zinc-500">/ {exam.maxScore.toFixed(1)}</span>
            </div>

            {!allGradingDone && (
              <div className="flex items-center justify-center gap-2 font-mono text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 py-2 border border-amber-300 dark:border-amber-800 max-w-md mx-auto">
                <Loader2 className="w-4 h-4 animate-spin text-amber-600 dark:text-amber-400" />
                程序正在完成最终几道题的严格评阅，分数自动汇总中...
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4 pt-4">
              <button
                onClick={() => {
                  sessionIdRef.current = `solo-${examId}-${direction}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                  hasPersistedRef.current = false;
                  setCurrentIdx(0);
                  setIsAllCompleted(false);
                  setSubmissions({});
                }}
                className="px-5 py-3 border-2 border-swiss-black dark:border-zinc-700 hover:border-swiss-red hover:text-swiss-red dark:hover:border-swiss-red font-mono text-xs font-bold uppercase transition-colors flex items-center gap-2 bg-white dark:bg-zinc-800 text-swiss-black dark:text-zinc-200 active:scale-[0.99]"
              >
                <RotateCcw className="w-4 h-4" />
                重新练习本套
              </button>
              <button
                onClick={onBack}
                className="px-7 py-3 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase transition-colors active:scale-[0.99]"
              >
                返回题库首页
              </button>
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-swiss-black dark:text-zinc-100 border-l-4 border-swiss-red pl-3">
              全卷逐句评分与阅卷点评回看
            </h3>
            {exam.translationSegments.map((_, idx) => {
              const sub = submissions[idx];
              if (!sub?.gradingResult) return null;
              return (
                <GradingCard
                  key={idx}
                  result={sub.gradingResult}
                  studentAnswer={sub.studentAnswer}
                  originalText={sub.originalText}
                  segmentIndex={idx}
                  direction={direction}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
