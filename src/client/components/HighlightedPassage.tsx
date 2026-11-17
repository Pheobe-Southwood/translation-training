import React from 'react';
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import type { TranslationDirection } from '../../shared/types.js';

interface HighlightedPassageProps {
  passage: string;
  activeSentence: string;
  /** Tailwind dark-mode text colour for the highlighted target sentence. */
  highlightTextClass?: string;
}

/** Passage markdown with the current target sentence highlighted in place. */
export const HighlightedPassage: React.FC<HighlightedPassageProps> = ({
  passage,
  activeSentence,
  highlightTextClass = 'dark:text-rose-200',
}) => {
  if (!passage) return null;

  const trimmedTarget = activeSentence.trim();
  const parts = trimmedTarget ? passage.split(trimmedTarget) : [passage];

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
            <span
              className={`bg-rose-100/90 dark:bg-rose-950/80 text-swiss-black ${highlightTextClass} font-semibold border-l-4 border-swiss-red px-1 py-0.5 shadow-sm`}
            >
              {trimmedTarget}
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

interface PassageAccordionProps {
  direction: TranslationDirection;
  /** Context title after the `//`, e.g. “2024 年短文语境”. */
  contextTitle: string;
  badge: string;
  passage: string;
  activeSentence: string;
  open: boolean;
  onToggle: () => void;
  /** Mobile drawer body is capped and scrollable in the live match. */
  scrollable?: boolean;
  highlightTextClass?: string;
  footer?: React.ReactNode;
}

/** Passage context card: persistent on desktop, collapsible on mobile. */
export const PassageAccordion: React.FC<PassageAccordionProps> = ({
  direction,
  contextTitle,
  badge,
  passage,
  activeSentence,
  open,
  onToggle,
  scrollable = false,
  highlightTextClass,
  footer,
}) => {
  const isZhEn = direction === 'zh-en';

  return (
    <div className="border-2 border-swiss-black dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-[4px_4px_0px_0px_#09090b] dark:shadow-[4px_4px_0px_0px_#000000]">
      <div
        onClick={onToggle}
        className="p-4 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 cursor-pointer lg:cursor-default hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
            {isZhEn ? 'CHINESE CONTEXT' : 'PASSAGE CONTEXT'} //{' '}
            {contextTitle}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] bg-rose-100 dark:bg-rose-950/80 text-swiss-red dark:text-rose-200 border border-rose-300 dark:border-rose-800 px-2 py-0.5 font-bold uppercase hidden sm:inline">
            {badge}
          </span>
          <div className="text-zinc-500 dark:text-zinc-400 lg:hidden">
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </div>
      </div>

      <div
        className={`p-4 sm:p-6 leading-relaxed ${scrollable ? 'max-h-[460px] overflow-y-auto' : ''} ${
          open ? 'block' : 'hidden lg:block'
        }`}
      >
        <HighlightedPassage
          passage={passage}
          activeSentence={activeSentence}
          highlightTextClass={highlightTextClass}
        />
        {footer}
      </div>
    </div>
  );
};
