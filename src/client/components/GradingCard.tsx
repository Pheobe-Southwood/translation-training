import React from 'react';
import { CheckCircle2, XCircle, AlertCircle, Quote, Sparkles } from 'lucide-react';
import type { GradingResult } from '../../shared/types.js';

interface GradingCardProps {
  result: GradingResult;
  studentAnswer: string;
  originalText: string;
  segmentIndex: number;
}

export const GradingCard: React.FC<GradingCardProps> = ({
  result,
  studentAnswer,
  segmentIndex,
}) => {
  return (
    <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4 sm:p-6 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000] space-y-4 sm:space-y-5">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 sm:pb-4 border-b-2 border-swiss-black dark:border-zinc-700">
        <div className="flex items-center gap-2.5">
          <span className="bg-swiss-black dark:bg-zinc-100 text-white dark:text-swiss-black font-mono text-xs font-bold px-2 py-1">
            第 {segmentIndex + 1} 题
          </span>
          <span className="font-mono text-xs uppercase text-zinc-500 dark:text-zinc-400 font-semibold tracking-wider">
            AI 阅卷评定
          </span>
        </div>

        {/* Score Badge */}
        <div className="flex items-baseline gap-1.5 bg-zinc-100 dark:bg-zinc-800 border border-swiss-black dark:border-zinc-700 px-3.5 py-1">
          <span className="font-mono text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase">得分</span>
          <span className="font-mono text-xl sm:text-2xl font-black text-swiss-red">
            {result.score.toFixed(1)}
          </span>
          <span className="font-mono text-xs font-bold text-zinc-500 dark:text-zinc-400">/ 2.0</span>
        </div>
      </div>

      {/* Deductions banner if any */}
      {(result.distortion_deduction > 0 || result.fluency_deduction > 0) && (
        <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-xs font-mono space-y-1 text-red-800 dark:text-red-300">
          <div className="flex items-center gap-1.5 font-bold">
            <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
            <span>扣分扣除：</span>
          </div>
          {result.distortion_deduction > 0 && (
            <div>• 意思扭曲扣分：-{result.distortion_deduction} 分</div>
          )}
          {result.fluency_deduction > 0 && (
            <div>• 表达通顺度扣分：-{result.fluency_deduction} 分</div>
          )}
        </div>
      )}

      {/* Scoring Points Breakdown */}
      <div>
        <div className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 mb-2.5 flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-swiss-red" />
          意群采分点明细
        </div>
        <div className="grid grid-cols-1 gap-2">
          {result.points_breakdown.map((pt, idx) => (
            <div
              key={idx}
              className={`p-3 border font-mono text-xs ${
                pt.score > 0
                  ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/30'
                  : 'border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40'
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="font-bold text-swiss-black dark:text-zinc-100 flex items-center gap-1.5">
                  {pt.score > 0 ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" />
                  )}
                  {pt.point}
                </span>
                <span
                  className={`px-1.5 py-0.5 text-[10px] font-black shrink-0 ${
                    pt.score > 0
                      ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950'
                      : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'
                  }`}
                >
                  +{pt.score.toFixed(1)} 分
                </span>
              </div>
              <p className="text-zinc-600 dark:text-zinc-400 text-[11px] leading-relaxed pl-5">
                {pt.analysis}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Student vs Reference Translation */}
      <div className="space-y-3 pt-2">
        <div className="p-3 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700">
          <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400 uppercase font-bold mb-1">
            你的译文
          </div>
          <div className="text-xs text-swiss-black dark:text-zinc-100 font-medium leading-relaxed">
            {studentAnswer || '（未作答）'}
          </div>
        </div>

        <div className="p-3 bg-rose-50/50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60">
          <div className="font-mono text-[10px] text-swiss-red dark:text-rose-400 uppercase font-bold mb-1 flex items-center gap-1">
            <Quote className="w-3 h-3" /> 官方标准参考译文
          </div>
          <div className="text-xs text-zinc-900 dark:text-zinc-100 font-medium leading-relaxed">
            {result.reference_translation}
          </div>
        </div>
      </div>

      {/* Teacher Critique */}
      <div className="p-3.5 bg-zinc-900 dark:bg-black text-white dark:text-zinc-200 font-mono text-xs border border-zinc-800">
        <div className="text-[10px] uppercase text-zinc-400 dark:text-zinc-400 tracking-wider font-bold mb-1.5">
          [ 综合点评 ]
        </div>
        <p className="text-zinc-200 dark:text-zinc-300 leading-relaxed text-[11px]">
          {result.critique}
        </p>
      </div>
    </div>
  );
};
