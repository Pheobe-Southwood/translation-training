import React from 'react';
import { CheckCircle2, ChevronRight, Hourglass, Loader2, Send } from 'lucide-react';
import type { SegmentSubmission, TranslationDirection } from '../../shared/types.js';

interface AnswerCardProps {
  /** Unique id for the textarea/label pair (one per page). */
  inputId: string;
  direction: TranslationDirection;
  /** 1-based number of the sentence currently being answered. */
  segmentNumber: number;
  segmentCount: number;
  segmentText: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  placeholder: string;
  /** Submit-button label on the last sentence (结算 / 封顶 wording differs per view). */
  finishLabel: string;
  disabled?: boolean;
  /** Live match marks the active question with a pulsing red square. */
  headerPulse?: boolean;
  maxLabel?: string;
}

/** Target sentence + translation textarea + submit CTA shared by solo and PVP. */
export const AnswerCard: React.FC<AnswerCardProps> = ({
  inputId,
  direction,
  segmentNumber,
  segmentCount,
  segmentText,
  value,
  onChange,
  onSubmit,
  textareaRef,
  placeholder,
  finishLabel,
  disabled = false,
  headerPulse = false,
  maxLabel = '满分 2.0 分',
}) => {
  const isZhEn = direction === 'zh-en';
  const paddedNumber = String(segmentNumber).padStart(2, '0');
  const paddedCount = String(segmentCount).padStart(2, '0');
  const isLast = segmentNumber === segmentCount;

  return (
    <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-3.5">
      <div className="flex items-center justify-between pb-2 border-b-2 border-swiss-black dark:border-zinc-700">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 ${headerPulse ? 'bg-swiss-red animate-pulse' : 'bg-swiss-red'}`}></span>
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-swiss-black dark:text-zinc-100">
            {isZhEn ? '本题待译中文原句' : '本题待译长难句'} [{paddedNumber} / {paddedCount}]
          </span>
        </div>
        <span className="font-mono text-xs font-bold text-zinc-400 dark:text-zinc-500">{maxLabel}</span>
      </div>

      <div className={`p-3 sm:p-4 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-300 dark:border-zinc-700 ${isZhEn ? 'font-zh' : 'font-serif'} text-sm sm:text-base md:text-lg leading-relaxed text-zinc-900 dark:text-zinc-100 selection:bg-swiss-red selection:text-white`}>
        {segmentText}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between font-mono text-xs text-zinc-500 dark:text-zinc-400">
          <label htmlFor={inputId} className="font-bold uppercase text-[11px]">
            {isZhEn ? '输入您的英文翻译：' : '输入您的中文翻译：'}
          </label>
          <span className="text-[10px] hidden sm:inline">Ctrl + Enter 快捷提交</span>
        </div>
        <textarea
          id={inputId}
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              onSubmit();
            }
          }}
          rows={4}
          placeholder={placeholder}
          className="w-full border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3 font-sans text-base sm:text-sm focus:outline-none focus:border-swiss-red dark:focus:border-swiss-red transition-colors placeholder:text-zinc-400 dark:placeholder:text-zinc-500 text-swiss-black dark:text-zinc-100 resize-none leading-relaxed"
        />
      </div>

      <button
        onClick={onSubmit}
        disabled={disabled}
        className="w-full min-h-[48px] py-3.5 bg-swiss-black hover:bg-swiss-red dark:bg-zinc-100 dark:text-swiss-black dark:hover:bg-swiss-red dark:hover:text-white text-white font-mono text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:hover:bg-swiss-black dark:disabled:hover:bg-zinc-100 active:scale-[0.99]"
      >
        <span>
          确认提交第 {segmentNumber} 题，进入下一句 (
          {isLast ? finishLabel : `${String(segmentNumber + 1).padStart(2, '0')}/${paddedCount}`})
        </span>
        <Send className="w-4 h-4" />
      </button>
    </div>
  );
};

interface PrevGradingBarProps {
  variant: 'solo' | 'pvp';
  submission: SegmentSubmission;
  /** 1-based display number of the previous sentence (the current index). */
  segmentNumber: number;
  expanded: boolean;
  onToggle: () => void;
}

/** Asynchronous grading feedback for the previously submitted sentence. */
export const PrevGradingBar: React.FC<PrevGradingBarProps> = ({
  variant,
  submission,
  segmentNumber,
  expanded,
  onToggle,
}) => {
  const isPvp = variant === 'pvp';

  return (
    <div className="border-2 border-swiss-black dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/80 p-3 sm:p-4 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] flex items-center justify-between">
      <div className="flex items-center gap-2 font-mono text-xs">
        {isPvp && submission.gradingStatus === 'waiting_pair' ? (
          <>
            <Hourglass className="w-4 h-4 text-blue-500 animate-pulse shrink-0" />
            <span className="font-bold text-blue-800 dark:text-blue-300 text-xs">
              已提交第 {segmentNumber} 句，等待对手完成该句以开启并列评分...
            </span>
          </>
        ) : submission.gradingStatus === 'grading' ? (
          <>
            <Loader2 className="w-4 h-4 text-amber-500 animate-spin shrink-0" />
            <span className="font-bold text-amber-700 dark:text-amber-400 text-xs">
              {isPvp
                ? `程序正在实时评阅第 ${segmentNumber} 句...`
                : `程序正在评阅上一句（第 ${segmentNumber} 题）...`}
            </span>
          </>
        ) : submission.gradingStatus === 'graded' ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-bold text-zinc-900 dark:text-zinc-100 text-xs">
              第 {segmentNumber} 句出分：
            </span>
            <span className="bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 font-bold px-1.5 py-0.5">
              +{submission.gradingResult?.score.toFixed(1)} 分
            </span>
          </>
        ) : (
          <span className="text-red-600 dark:text-red-400 font-bold text-xs">
            第 {segmentNumber} 句评分异常
          </span>
        )}
      </div>

      {(!isPvp || submission.gradingResult) && (
        <button
          onClick={onToggle}
          className="font-mono text-xs font-bold text-swiss-black dark:text-zinc-200 hover:text-swiss-red dark:hover:text-swiss-red flex items-center gap-1 shrink-0 ml-2"
        >
          {expanded
            ? isPvp
              ? '收起'
              : '收起点评'
            : isPvp
            ? '查看采分'
            : '查看点评'}
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
