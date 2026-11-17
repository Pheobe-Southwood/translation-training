import type { ExamBank, ExamCatalogEntry, TranslationDirection } from '../../shared/types.js';
import { getAuthToken } from './storage.js';

/**
 * Client-side helpers for the three question banks.
 *
 * A paper is now identified by `examId` (`2004-translation`, `2004-cloze`,
 * `2004-reading-2`) because one year has several papers. The homepage, the PVP
 * lobby and the history list all need the same grouping/label rules, so they
 * live here instead of being duplicated per view.
 */

export const EXAM_BANKS: readonly ExamBank[] = ['translation', 'cloze', 'reading'] as const;

export interface ExamBankMeta {
  /** Chinese label used for tabs / badges. */
  label: string;
  english: string;
}

export const EXAM_BANK_META: Record<ExamBank, ExamBankMeta> = {
  translation: { label: '翻译真题', english: 'TRANSLATION' },
  cloze: { label: '完型长难句', english: 'CLOZE' },
  reading: { label: '阅读长难句', english: 'READING' },
};

/** Only the translation bank has a Chinese reference bank, so only it offers 中译英. */
export function isEnZhOnlyBank(bank: ExamBank): boolean {
  return bank !== 'translation';
}

/** Best-effort bank detection from the canonical examId format. */
export function inferBankFromExamId(examId?: string | null): ExamBank {
  if (!examId) return 'translation';
  if (examId.endsWith('-translation')) return 'translation';
  if (examId.endsWith('-cloze')) return 'cloze';
  if (/-reading-\d+$/.test(examId)) return 'reading';
  return 'translation';
}

export function defaultPartLabel(bank: ExamBank): string {
  if (bank === 'cloze') return '完型填空';
  if (bank === 'reading') return '阅读理解长难句';
  return '翻译';
}

export function paperPartLabel(entry: Pick<ExamCatalogEntry, 'bank' | 'partLabel'>): string {
  return entry.partLabel || defaultPartLabel(entry.bank);
}

/** Compact unit label: “翻译” / “完型填空” / “Text 2”. */
export function unitLabel(entry: Pick<ExamCatalogEntry, 'bank' | 'partLabel'>): string {
  if (entry.bank === 'translation') return '翻译';
  if (entry.bank === 'cloze') return '完型填空';
  const match = entry.partLabel.match(/Text\s*(\d+)/i);
  return match ? `Text ${match[1]}` : paperPartLabel(entry);
}

/** Direction line shown next to a paper selection. */
export function paperDirectionHint(bank: ExamBank): string {
  return isEnZhOnlyBank(bank) ? '仅英译中' : '英译中 / 中译英';
}

/** Unique years, newest first. */
export function uniqueYears(entries: ExamCatalogEntry[]): number[] {
  return Array.from(new Set(entries.map((entry) => entry.year))).sort((a, b) => b - a);
}

export function entriesForYear(entries: ExamCatalogEntry[], year: number | null): ExamCatalogEntry[] {
  if (year === null) return [];
  return entries.filter((entry) => entry.year === year);
}

/** Pick the unit to display for a year, preferring the currently selected paper. */
export function pickUnitForYear(
  entries: ExamCatalogEntry[],
  year: number | null,
  preferredExamId?: string | null
): ExamCatalogEntry | null {
  const units = entriesForYear(entries, year);
  if (units.length === 0) return null;
  return units.find((entry) => entry.examId === preferredExamId) || units[0];
}

/** “2004–2025” style span for a bank, or an empty string while loading. */
export function yearSpan(entries: ExamCatalogEntry[]): string {
  const years = uniqueYears(entries);
  if (years.length === 0) return '';
  if (years.length === 1) return String(years[0]);
  return `${years[years.length - 1]}–${years[0]}`;
}

/** “3–5” style segment span for a bank, or an empty string while loading. */
export function segmentSpan(entries: ExamCatalogEntry[]): string {
  if (entries.length === 0) return '';
  const counts = entries.map((entry) => entry.segmentCount);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return min === max ? String(min) : `${min}–${max}`;
}

function sortCatalog(entries: ExamCatalogEntry[]): ExamCatalogEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    if (a.bank !== b.bank) return EXAM_BANKS.indexOf(a.bank) - EXAM_BANKS.indexOf(b.bank);
    return a.partLabel.localeCompare(b.partLabel, 'zh-CN');
  });
}

function authHeaders(): Record<string, string> | undefined {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/**
 * Fetch one bank's catalog; a failed request degrades to an empty list.
 */
export async function fetchExamCatalog(bank: ExamBank): Promise<ExamCatalogEntry[]> {
  try {
    const res = await fetch(`/api/exams/catalog?bank=${encodeURIComponent(bank)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return sortCatalog(data.exams as ExamCatalogEntry[]);
  } catch (err) {
    console.error(`Failed to fetch exam catalog (${bank}):`, err);
    return [];
  }
}

/** Fetch all three banks; a failing bank degrades to an empty list. */
export async function fetchAllExamCatalogs(): Promise<Record<ExamBank, ExamCatalogEntry[]>> {
  const loaded = await Promise.all(
    EXAM_BANKS.map(async (bank) => [bank, await fetchExamCatalog(bank)] as const)
  );
  return Object.fromEntries(loaded) as Record<ExamBank, ExamCatalogEntry[]>;
}

export interface ExamSelection {
  bank: ExamBank;
  year: number;
  /** Canonical paper id, e.g. `2004-reading-2`. */
  examId: string;
}

/**
 * Resolve the selection to show first: an explicitly requested examId wins;
 * otherwise fall back to the newest paper of that bank (or of any bank).
 */
export function resolveInitialSelection(
  catalogs: Record<ExamBank, ExamCatalogEntry[]>,
  initialExamId?: string | null
): ExamSelection | null {
  for (const bank of EXAM_BANKS) {
    const match = catalogs[bank].find((entry) => entry.examId === initialExamId);
    if (match) return { bank, year: match.year, examId: match.examId };
  }

  const preferredBank = inferBankFromExamId(initialExamId);
  const preferredYear = uniqueYears(catalogs[preferredBank])[0];
  const preferred = pickUnitForYear(catalogs[preferredBank], preferredYear ?? null);
  if (preferred) {
    return { bank: preferredBank, year: preferred.year, examId: preferred.examId };
  }

  for (const bank of EXAM_BANKS) {
    const first = catalogs[bank][0];
    if (first) return { bank, year: first.year, examId: first.examId };
  }
  return null;
}

/** Full sentence describing the currently selected paper. */
export function paperSummary(
  entry: Pick<ExamCatalogEntry, 'year' | 'bank' | 'partLabel' | 'segmentCount' | 'maxScore'>,
  direction?: TranslationDirection
): string {
  const parts = [
    `${entry.year} 年 · ${paperPartLabel(entry)}`,
    `${entry.segmentCount} 句`,
    `满分 ${entry.maxScore.toFixed(1)} 分`,
  ];
  if (entry.bank === 'translation' && direction) {
    parts.push(direction === 'zh-en' ? '中译英' : '英译中');
  } else {
    parts.push(paperDirectionHint(entry.bank));
  }
  return parts.join(' · ');
}
