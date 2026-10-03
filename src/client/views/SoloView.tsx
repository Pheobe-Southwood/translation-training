import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Send,
  Loader2,
  CheckCircle2,
  ChevronRight,
  Trophy,
  RotateCcw,
  Sparkles,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type { TranslationExam, SegmentSubmission, HistorySessionRecord } from '../../shared/types.js';
import { getAuthToken, saveHistoryRecord } from '../utils/storage.js';
import { playSuccessSound } from '../utils/sound.js';
import { GradingCard } from '../components/GradingCard.js';

interface SoloViewProps {
  year: number;
  onBack: () => void;
  onFinishSession?: () => void;
}

export const SoloView: React.FC<SoloViewProps> = ({ year, onBack }) => {
  const [exam, setExam] = useState<TranslationExam | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [submissions, setSubmissions] = useState<Record<number, SegmentSubmission>>({});
  const [startTime] = useState<number>(Date.now());
  const [isAllCompleted, setIsAllCompleted] = useState(false);
  const [activeCardTab, setActiveCardTab] = useState<number | null>(null);
  const [isPassageOpenMobile, setIsPassageOpenMobile] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchExam();
  }, [year]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [currentIdx]);

  const fetchExam = async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/exams/${year}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setExam(data.exam);
      }
    } catch (err) {
      console.error('Failed to load exam:', err);
    } finally {
      setLoading(false);
    }
  };

  const currentSegment = exam?.translationSegments[currentIdx] || '';

  const totalScore = Object.values(submissions).reduce(
    (acc, s) => acc + (s.gradingResult?.score || 0),
    0
  );

  const handleConfirmSubmit = () => {
    if (!exam || !currentAnswer.trim()) return;

    const segmentIndexToSubmit = currentIdx;
    const answerToSubmit = currentAnswer.trim();
    const originalText = exam.translationSegments[segmentIndexToSubmit];

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

    if (segmentIndexToSubmit < 4) {
      setCurrentIdx(segmentIndexToSubmit + 1);
    } else {
      setIsAllCompleted(true);
    }

    triggerBackgroundGrading(segmentIndexToSubmit, originalText, answerToSubmit);
  };

  const triggerBackgroundGrading = async (
    segmentIndex: number,
    targetSentence: string,
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
          fullArticle: exam?.contentMarkdown || '',
          targetSentence,
          studentAnswer,
          segmentIndex,
        }),
      });

      if (!res.ok) {
        throw new Error('评分接口返回错误');
      }

      const data = await res.json();
      setSubmissions((prev) => {
        const updated = {
          ...prev,
          [segmentIndex]: {
            ...prev[segmentIndex],
            gradingStatus: 'graded' as const,
            gradingResult: data.gradingResult,
          },
        };
        checkAndPersistHistoryIfDone(updated);
        return updated;
      });
    } catch (err: any) {
      console.error('Grading error:', err);
      setSubmissions((prev) => ({
        ...prev,
        [segmentIndex]: {
          ...prev[segmentIndex],
          gradingStatus: 'error' as const,
          error: err.message || '评分超时，请重试',
        },
      }));
    }
  };

  const checkAndPersistHistoryIfDone = (currentSubs: Record<number, SegmentSubmission>) => {
    const keys = Object.keys(currentSubs);
    if (keys.length === 5) {
      const allSettled = Object.values(currentSubs).every(
        (s) => s.gradingStatus === 'graded' || s.gradingStatus === 'error'
      );
      if (allSettled) {
        const finalScore = Object.values(currentSubs).reduce(
          (sum, s) => sum + (s.gradingResult?.score || 0),
          0
        );
        const record: HistorySessionRecord = {
          id: `solo-${Date.now()}`,
          type: 'solo',
          year,
          timestamp: Date.now(),
          totalScore: finalScore,
          timeSpentSeconds: Math.floor((Date.now() - startTime) / 1000),
          submissions: Object.values(currentSubs),
        };
        saveHistoryRecord(record);
        // Persist to online server database
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
            }).catch((e) => console.error('Failed to post history to server:', e));
          }
        } catch (e) {
          console.error(e);
        }
        playSuccessSound();
        try {
          confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
        } catch {}
      }
    }
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

  if (loading || !exam) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center font-mono text-xs">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-swiss-red mb-3" />
        正在加载 {year} 年考研真题与长难句意群...
      </div>
    );
  }

  const allGradingDone =
    isAllCompleted &&
    Object.values(submissions).length === 5 &&
    Object.values(submissions).every(
      (s) => s.gradingStatus === 'graded' || s.gradingStatus === 'error'
    );

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-6 sm:space-y-8">
      {/* Top Header & Progress */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-swiss-black pb-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 border border-zinc-300 hover:border-swiss-black font-mono text-xs font-bold transition-colors bg-white"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回</span>
        </button>

        {/* 5-step Indicator */}
        <div className="flex items-center gap-1.5 font-mono text-xs">
          <span className="text-zinc-500 font-bold uppercase hidden md:inline">做题进度：</span>
          <div className="flex items-center gap-1">
            {[0, 1, 2, 3, 4].map((idx) => {
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
                      ? 'bg-swiss-black text-white border-swiss-black'
                      : 'bg-white text-zinc-400 border-zinc-200'
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

        {/* Score ticker */}
        <div className="flex items-center gap-1.5 font-mono bg-zinc-100 border border-swiss-black px-2.5 py-0.5 sm:px-3.5 sm:py-1">
          <span className="text-[10px] sm:text-xs text-zinc-500 uppercase font-bold">总分</span>
          <span className="text-base sm:text-lg font-black text-swiss-red">{totalScore.toFixed(1)}</span>
          <span className="text-[10px] sm:text-xs text-zinc-500">/ 10.0</span>
        </div>
      </div>

      {!isAllCompleted ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Active Target Sentence & Input Box (Desktop Right 5 cols, Mobile TOP 12 cols) */}
          <div className="lg:col-span-5 lg:order-2 space-y-4">
            <div className="border-2 border-swiss-black bg-white p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] sm:shadow-[6px_6px_0px_0px_#09090b] space-y-3.5">
              {/* Target Segment Header */}
              <div className="flex items-center justify-between pb-2 border-b-2 border-swiss-black">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 bg-swiss-red"></span>
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-swiss-black">
                    本题待译长难句 [0{currentIdx + 1} / 05]
                  </span>
                </div>
                <span className="font-mono text-xs font-bold text-zinc-400">满分 2.0 分</span>
              </div>

              {/* Target Segment English Content */}
              <div className="p-3 sm:p-4 bg-zinc-50 border border-zinc-300 font-serif text-sm sm:text-base md:text-lg leading-relaxed text-zinc-900 selection:bg-swiss-red selection:text-white">
                {currentSegment}
              </div>

              {/* Input Area */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono text-xs text-zinc-500">
                  <label htmlFor="answer-input" className="font-bold uppercase text-[11px]">
                    输入您的中文翻译：
                  </label>
                  <span className="text-[10px] hidden sm:inline">Ctrl + Enter 快捷提交</span>
                </div>
                <textarea
                  id="answer-input"
                  ref={textareaRef}
                  value={currentAnswer}
                  onChange={(e) => setCurrentAnswer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.ctrlKey && e.key === 'Enter') {
                      handleConfirmSubmit();
                    }
                  }}
                  rows={4}
                  placeholder="在此输入中文翻译..."
                  className="w-full border-2 border-swiss-black p-3 font-sans text-sm focus:outline-none focus:border-swiss-red transition-colors placeholder:text-zinc-400 resize-none leading-relaxed"
                />
              </div>

              {/* Submit CTA */}
              <button
                onClick={handleConfirmSubmit}
                disabled={!currentAnswer.trim()}
                className="w-full py-3.5 bg-swiss-black hover:bg-swiss-red text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:hover:bg-swiss-black"
              >
                <span>
                  确认提交第 {currentIdx + 1} 题，进入下一句 (
                  {currentIdx === 4 ? '交卷结算' : `0${currentIdx + 2}/05`})
                </span>
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Passage Context & Previous Scoring (Desktop Left 7 cols, Mobile BOTTOM 12 cols) */}
          <div className="lg:col-span-7 lg:order-1 space-y-4">
            {/* Asynchronous Grading Feedback Bar for Previous Question */}
            {currentIdx > 0 && submissions[currentIdx - 1] && (
              <div className="border-2 border-swiss-black bg-zinc-50 p-3 sm:p-4 shadow-[4px_4px_0px_0px_#09090b] flex items-center justify-between">
                <div className="flex items-center gap-2 font-mono text-xs">
                  {submissions[currentIdx - 1].gradingStatus === 'grading' ? (
                    <>
                      <Loader2 className="w-4 h-4 text-amber-500 animate-spin shrink-0" />
                      <span className="font-bold text-amber-700 text-xs">
                        DeepSeek 正在阅卷上一句（第 {currentIdx} 题）...
                      </span>
                    </>
                  ) : submissions[currentIdx - 1].gradingStatus === 'graded' ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span className="font-bold text-zinc-900 text-xs">
                        第 {currentIdx} 句出分：
                      </span>
                      <span className="bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5">
                        +{submissions[currentIdx - 1].gradingResult?.score.toFixed(1)} 分
                      </span>
                    </>
                  ) : (
                    <span className="text-red-600 font-bold text-xs">第 {currentIdx} 句评分异常</span>
                  )}
                </div>

                <button
                  onClick={() =>
                    setActiveCardTab(activeCardTab === currentIdx - 1 ? null : currentIdx - 1)
                  }
                  className="font-mono text-xs font-bold text-swiss-black hover:text-swiss-red flex items-center gap-1 shrink-0 ml-2"
                >
                  {activeCardTab === currentIdx - 1 ? '收起点评' : '查看点评'}
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Expanded Grading Drawer if clicked */}
            {activeCardTab !== null && submissions[activeCardTab]?.gradingResult && (
              <GradingCard
                result={submissions[activeCardTab].gradingResult!}
                studentAnswer={submissions[activeCardTab].studentAnswer}
                originalText={submissions[activeCardTab].originalText}
                segmentIndex={activeCardTab}
              />
            )}

            {/* Mobile Collapsible Passage Accordion / Desktop Persistent Card */}
            <div className="border-2 border-swiss-black bg-white shadow-[4px_4px_0px_0px_#09090b] sm:shadow-[6px_6px_0px_0px_#09090b]">
              {/* Header Toggle for Mobile */}
              <div
                onClick={() => setIsPassageOpenMobile(!isPassageOpenMobile)}
                className="p-4 flex items-center justify-between border-b border-zinc-200 cursor-pointer lg:cursor-default"
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-zinc-600" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700">
                    PASSAGE CONTEXT // {year} 年短文语境
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] bg-rose-100 text-swiss-red border border-rose-300 px-2 py-0.5 font-bold uppercase hidden sm:inline">
                    红色标尺即为本题目标
                  </span>
                  <div className="text-zinc-500 lg:hidden">
                    {isPassageOpenMobile ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </div>
              </div>

              {/* Passage text: Persistent on desktop, toggleable on mobile */}
              <div
                className={`p-4 sm:p-6 max-h-[460px] overflow-y-auto leading-relaxed ${
                  isPassageOpenMobile ? 'block' : 'hidden lg:block'
                }`}
              >
                {renderPassageWithHighlight(exam.contentMarkdown, currentSegment)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Final Scorecard Screen */
        <div className="max-w-4xl mx-auto space-y-8">
          <div className="border-4 border-swiss-black bg-white p-6 sm:p-12 shadow-[8px_8px_0px_0px_#09090b] sm:shadow-[10px_10px_0px_0px_#09090b] text-center space-y-6">
            <div className="w-16 h-16 bg-swiss-red text-white flex items-center justify-center mx-auto border-2 border-swiss-black">
              <Trophy className="w-8 h-8" />
            </div>

            <div>
              <div className="font-mono text-xs uppercase font-bold tracking-widest text-zinc-500 mb-2">
                EXAMINATION COMPLETED // 练习完成
              </div>
              <h2 className="text-2xl sm:text-4xl md:text-5xl font-black uppercase text-swiss-black">
                {year} 年英语（一）翻译总评
              </h2>
            </div>

            <div className="py-6 border-y-2 border-swiss-black max-w-sm mx-auto flex items-baseline justify-center gap-3">
              <span className="font-mono text-xs font-bold uppercase text-zinc-500">总得分</span>
              <span className="font-mono text-5xl sm:text-6xl font-black text-swiss-red">
                {totalScore.toFixed(1)}
              </span>
              <span className="font-mono text-base sm:text-lg font-bold text-zinc-400">/ 10.0</span>
            </div>

            {!allGradingDone && (
              <div className="flex items-center justify-center gap-2 font-mono text-xs text-amber-700 bg-amber-50 py-2 border border-amber-300 max-w-md mx-auto">
                <Loader2 className="w-4 h-4 animate-spin text-amber-600" />
                DeepSeek 正在完成最终几道题的严格阅卷，分数自动汇总中...
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
              <button
                onClick={() => {
                  setCurrentIdx(0);
                  setIsAllCompleted(false);
                  setSubmissions({});
                }}
                className="px-6 py-3 border-2 border-swiss-black hover:border-swiss-red hover:text-swiss-red font-mono text-xs font-bold uppercase transition-colors flex items-center gap-2 bg-white"
              >
                <RotateCcw className="w-4 h-4" />
                重新练习本套
              </button>
              <button
                onClick={onBack}
                className="px-8 py-3 bg-swiss-black hover:bg-swiss-red text-white font-mono text-xs font-bold uppercase transition-colors"
              >
                返回真题首页
              </button>
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-swiss-black border-l-4 border-swiss-red pl-3">
              全卷逐句评分与阅卷点评回看
            </h3>
            {[0, 1, 2, 3, 4].map((idx) => {
              const sub = submissions[idx];
              if (!sub?.gradingResult) return null;
              return (
                <GradingCard
                  key={idx}
                  result={sub.gradingResult}
                  studentAnswer={sub.studentAnswer}
                  originalText={sub.originalText}
                  segmentIndex={idx}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
