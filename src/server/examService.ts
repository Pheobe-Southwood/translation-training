import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  ExamBank,
  ExamCatalogEntry,
  TranslationDirection,
  TranslationExam,
} from '../shared/types.js';
import { DEFAULT_DIRECTION } from '../shared/direction.js';

/**
 * Server-only exam record. The reference fields must never be exposed through
 * `/api/exams/*` or a PVP `room:state` frame: for Chinese→English they are the
 * answer key.
 *
 * Two data files are merged into this one shape:
 *  - `src/shared/data/exams.json`        — the original 2002–2026 translation bank
 *    (records still carry `id` instead of `examId` and no `bank`/`partLabel`);
 *  - `src/shared/data/passage-bank.json` — the cloze / reading passage banks
 *    (one article = one paper, 3–5 target sentences, English→Chinese only).
 * The passage bank deliberately has no `referencePassageMarkdown`, so the
 * Chinese→English projection skips it (the new banks do not offer 中译英).
 */
export interface ExamRecord {
  examId: string;
  bank: ExamBank;
  partLabel: string;
  year: number;
  maxScore: number;
  /** English full passage (used by English→Chinese). */
  contentMarkdown: string;
  /** English target sentences (used by English→Chinese). */
  translationSegments: string[];
  /** Web-researched Chinese full passage (used by Chinese→English). */
  referencePassageMarkdown?: string;
  /** Web-researched Chinese target translations (used by Chinese→English). */
  referenceTranslations?: string[];
}

export interface GradingMaterial {
  sourceText: string;
  referenceAnswer: string;
  fullSource: string;
}

const TRANSLATION_BANK: ExamBank = 'translation';
const TRANSLATION_DATA_FILE = 'exams.json';
const PASSAGE_DATA_FILE = 'passage-bank.json';
const EXAM_BANKS: ExamBank[] = ['translation', 'cloze', 'reading'];

let cachedRecords: ExamRecord[] | null = null;

// --- Id helpers -------------------------------------------------------------

/**
 * Canonicalise a paper identifier.
 *
 * `2024` / `'2024'` are the pre-examId addressing scheme and mean the translation
 * paper of that year, so old links and old clients keep resolving. Everything else
 * must already be canonical (`2024-translation`, `2004-cloze`, `2004-reading-2`).
 */
export function normalizeExamId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `${Math.trunc(value)}-translation` : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^\d+$/.test(trimmed) ? `${Number.parseInt(trimmed, 10)}-translation` : trimmed;
}

/** Strict parser for `?bank=` values. Returns null for anything unrecognised. */
export function parseExamBank(value: unknown): ExamBank | null {
  return EXAM_BANKS.find((bank) => bank === value) ?? null;
}

function inferBankFromExamId(examId: string): ExamBank | undefined {
  if (/-translation$/.test(examId)) return 'translation';
  if (/-cloze$/.test(examId)) return 'cloze';
  if (/-reading(?:-\d+)?$/.test(examId)) return 'reading';
  return undefined;
}

function defaultPartLabel(bank: ExamBank, examId: string): string {
  if (bank === 'cloze') return '完型填空';
  if (bank === 'reading') {
    const match = /-reading-(\d+)$/.exec(examId);
    return match ? `阅读理解 Text ${match[1]}` : '阅读理解';
  }
  return '翻译真题';
}

// --- Raw data loading -------------------------------------------------------

/**
 * Read one data file from the directory next to the running module: `src/shared/data`
 * under tsx and `dist/shared/data` after `pnpm build` (both are always shipped).
 */
function readDataFile(fileName: string): unknown[] {
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../shared/data',
    fileName
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
  } catch (err) {
    throw new Error(`Unable to load ${candidate}: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${candidate}: root value is not an array`);
  if (parsed.length === 0) throw new Error(`${candidate}: file is empty`);
  console.log(`[examService] Loaded ${parsed.length} raw records from ${candidate}`);
  return parsed;
}

// --- Normalisation ----------------------------------------------------------

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Merge either file's raw shape into the single server-side `ExamRecord`.
 * Missing optional fields are tolerated; unusable records are skipped with a
 * warning instead of crashing every exam endpoint.
 */
function normalizeExamRecord(raw: Record<string, unknown>, source: string): ExamRecord | undefined {
  const explicitExamId = normalizeExamId(raw.examId ?? raw.id);
  const label = explicitExamId ?? nonEmptyString(raw.title) ?? '(unknown exam)';

  const year =
    typeof raw.year === 'number' ? raw.year : Number.parseInt(String(raw.year ?? ''), 10);
  if (!Number.isInteger(year) || year < 1990 || year > 2100) {
    console.warn(`[examService] Skipping ${label} from ${source}: invalid year ${String(raw.year)}`);
    return undefined;
  }

  const translationSegments = Array.isArray(raw.translationSegments)
    ? raw.translationSegments.map(nonEmptyString)
    : [];
  const segments = translationSegments.filter((segment): segment is string => !!segment);
  if (segments.length === 0) {
    console.warn(`[examService] Skipping ${label} from ${source}: no translationSegments`);
    return undefined;
  }
  if (segments.length !== translationSegments.length) {
    console.warn(`[examService] ${label} from ${source}: dropped empty translationSegments entries`);
  }

  const contentMarkdown = nonEmptyString(raw.contentMarkdown);
  if (!contentMarkdown) {
    console.warn(`[examService] Skipping ${label} from ${source}: missing contentMarkdown`);
    return undefined;
  }

  const bank =
    parseExamBank(raw.bank) ??
    (explicitExamId ? inferBankFromExamId(explicitExamId) : undefined) ??
    TRANSLATION_BANK;
  const examId = explicitExamId ?? `${year}-${bank}`;
  const partLabel = nonEmptyString(raw.partLabel) ?? defaultPartLabel(bank, examId);

  // Preserve positions so referenceTranslations stays index-aligned with the
  // target sentences; missing/blank entries become empty strings.
  const referenceTranslations = Array.isArray(raw.referenceTranslations)
    ? raw.referenceTranslations.map((value) => (typeof value === 'string' ? value.trim() : ''))
    : undefined;

  return {
    examId,
    bank,
    partLabel,
    year,
    // One target sentence is worth 2 points; papers now have 3–5 sentences.
    maxScore: segments.length * 2,
    contentMarkdown,
    translationSegments: segments,
    referencePassageMarkdown: nonEmptyString(raw.referencePassageMarkdown),
    referenceTranslations,
  };
}

/**
 * Load and merge both banks once. Order matters for duplicate handling: the
 * translation bank wins (it is the historical source of truth).
 */
function loadExamRecords(): ExamRecord[] {
  if (cachedRecords) return cachedRecords;

  const records: ExamRecord[] = [];

  for (const fileName of [TRANSLATION_DATA_FILE, PASSAGE_DATA_FILE]) {
    for (const item of readDataFile(fileName)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = normalizeExamRecord(item as Record<string, unknown>, fileName);
      if (record) records.push(record);
    }
  }

  cachedRecords = records;
  const counts: Record<ExamBank, number> = { translation: 0, cloze: 0, reading: 0 };
  for (const record of records) counts[record.bank]++;
  console.log(
    `[examService] ${records.length} exam records ready ` +
      `(translation=${counts.translation}, cloze=${counts.cloze}, reading=${counts.reading})`
  );
  return cachedRecords;
}

/** Find one normalised server record; never throws for a missing data file. */
function findRecord(examId: string): ExamRecord | undefined {
  try {
    return loadExamRecords().find((record) => record.examId === examId);
  } catch (err) {
    console.error('[examService] Unable to search the exam records:', err);
    return undefined;
  }
}

// --- Public projections -----------------------------------------------------

/**
 * Project a server record into the answer-key-free shape clients receive.
 * Chinese→English exists only for the translation bank (the passage banks have no
 * Chinese reference passage), so `zh-en` returns undefined for cloze/reading.
 */
function toPublicExam(
  record: ExamRecord,
  direction: TranslationDirection
): TranslationExam | undefined {
  const isZhEn = direction === 'zh-en';

  if (isZhEn) {
    if (record.bank !== TRANSLATION_BANK) return undefined;
    if (!record.referencePassageMarkdown || !Array.isArray(record.referenceTranslations)) {
      console.error(`[examService] ${record.examId} has no usable Chinese reference bank`);
      return undefined;
    }
    if (
      record.referenceTranslations.length !== record.translationSegments.length ||
      record.referenceTranslations.some((segment) => !segment)
    ) {
      console.error(`[examService] ${record.examId} has an incomplete Chinese reference bank`);
      return undefined;
    }
  }

  const segments = isZhEn ? (record.referenceTranslations ?? []) : record.translationSegments;
  return {
    examId: record.examId,
    bank: record.bank,
    partLabel: record.partLabel,
    year: record.year,
    maxScore: segments.length * 2,
    contentMarkdown: isZhEn
      ? (record.referencePassageMarkdown ?? '')
      : record.contentMarkdown,
    translationSegments: segments,
    direction,
  };
}

export function getAllExams(
  direction: TranslationDirection = DEFAULT_DIRECTION,
  bank: ExamBank = TRANSLATION_BANK
): TranslationExam[] {
  return loadExamRecords()
    .filter((record) => record.bank === bank)
    .map((record) => toPublicExam(record, direction))
    .filter((exam): exam is TranslationExam => !!exam);
}

/** Distinct years of one bank, newest first (a year can now hold six papers). */
export function getExamYears(bank: ExamBank = TRANSLATION_BANK): number[] {
  const years = new Set(
    loadExamRecords()
      .filter((record) => record.bank === bank)
      .map((record) => record.year)
  );
  return Array.from(years).sort((a, b) => b - a);
}

/** One row per paper for the bank picker, newest year first. */
export function getExamCatalog(bank: ExamBank = TRANSLATION_BANK): ExamCatalogEntry[] {
  return loadExamRecords()
    .filter((record) => record.bank === bank)
    .sort((a, b) => b.year - a.year || a.examId.localeCompare(b.examId))
    .map((record) => ({
      examId: record.examId,
      bank: record.bank,
      year: record.year,
      partLabel: record.partLabel,
      segmentCount: record.translationSegments.length,
      maxScore: record.translationSegments.length * 2,
    }));
}

/**
 * Legacy translation-bank lookup by year. Kept for old clients and the existing
 * `scripts/` helpers; new code should use `getExamById`.
 */
export function getExamByYear(
  year: number,
  direction: TranslationDirection = DEFAULT_DIRECTION
): TranslationExam | undefined {
  const record = loadExamRecords().find(
    (candidate) => candidate.bank === TRANSLATION_BANK && candidate.year === year
  );
  return record ? toPublicExam(record, direction) : undefined;
}

/**
 * Canonical lookup by `examId`. A bare year is accepted for backwards
 * compatibility and maps to `${year}-translation`.
 */
export function getExamById(
  examIdInput: string | number,
  direction: TranslationDirection = DEFAULT_DIRECTION
): TranslationExam | undefined {
  const examId = normalizeExamId(examIdInput);
  if (!examId) return undefined;
  const record = findRecord(examId);
  return record ? toPublicExam(record, direction) : undefined;
}

export function getRandomExam(
  direction: TranslationDirection = DEFAULT_DIRECTION,
  bank: ExamBank = TRANSLATION_BANK
): TranslationExam {
  const candidates = getAllExams(direction, bank);
  if (candidates.length === 0) {
    throw new Error(`No ${bank} exams available for direction ${direction}`);
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

/**
 * Minimal description of an examId, used where loading the full record would be
 * wasteful (history rows). Falls back to the naming convention when the paper is
 * not in the loaded banks (e.g. a retired paper still present in history).
 */
export function describeExamId(
  examIdInput: string | number
): { examId: string; bank: ExamBank; partLabel: string } | undefined {
  const examId = normalizeExamId(examIdInput);
  if (!examId) return undefined;

  const record = findRecord(examId);
  if (record) {
    return { examId: record.examId, bank: record.bank, partLabel: record.partLabel };
  }

  const bank = inferBankFromExamId(examId);
  if (!bank) return undefined;
  return { examId, bank, partLabel: defaultPartLabel(bank, examId) };
}

// --- Grading material -------------------------------------------------------

/**
 * Resolve the exact source sentence, standard answer and full context for one
 * segment on the server. Clients never supply these values for grading.
 *
 * Primary key is `examId`; a bare year is still accepted and means the
 * translation paper of that year (used by older call sites).
 */
export function getGradingMaterial(
  examIdOrYear: string | number,
  direction: TranslationDirection,
  segmentIndex: number
): GradingMaterial | undefined {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return undefined;

  const examId = normalizeExamId(examIdOrYear);
  if (!examId) return undefined;

  const record = findRecord(examId);
  if (!record) return undefined;

  // The upper bound is the actual paper length (3–5), never a hard-coded 4.
  if (segmentIndex >= record.translationSegments.length) return undefined;

  if (direction === 'zh-en') {
    if (record.bank !== TRANSLATION_BANK) return undefined;
    if (!record.referencePassageMarkdown || !record.referenceTranslations) return undefined;

    const sourceText = record.referenceTranslations[segmentIndex];
    const referenceAnswer = record.translationSegments[segmentIndex];
    if (!sourceText || !referenceAnswer) return undefined;

    return {
      sourceText,
      referenceAnswer,
      fullSource: record.referencePassageMarkdown,
    };
  }

  const sourceText = record.translationSegments[segmentIndex];
  const referenceAnswer = record.referenceTranslations?.[segmentIndex] ?? '';
  if (!sourceText || !record.contentMarkdown) return undefined;

  return {
    sourceText,
    referenceAnswer,
    fullSource: record.contentMarkdown,
  };
}
