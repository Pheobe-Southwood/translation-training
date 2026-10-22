import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TranslationDirection, TranslationExam } from '../shared/types.js';
import { DEFAULT_DIRECTION } from '../shared/direction.js';

/**
 * Server-only exam record. The reference fields must never be exposed through
 * `/api/exams/*` or a PVP `room:state` frame: for Chinese→English they are the
 * answer key.
 */
export interface ExamRecord {
  id: string;
  year: number;
  title: string;
  maxScore: number;
  /** English full passage (used by English→Chinese). */
  contentMarkdown: string;
  /** English target sentences (used by English→Chinese). */
  translationSegments: string[];
  /** Web-researched Chinese full passage (used by Chinese→English). */
  referencePassageMarkdown: string;
  /** Web-researched Chinese target translations (used by Chinese→English). */
  referenceTranslations: string[];
  referenceSource?: {
    name: string;
    url: string;
    accessedAt: string;
  };
  referenceSegmentSources?: Array<'web' | 'web-completed' | 'reviewed-fallback'>;
  referenceNotes?: string[];
}

export interface GradingMaterial {
  sourceText: string;
  referenceAnswer: string;
  fullSource: string;
}

let cachedExams: ExamRecord[] = [];

function loadExams(): ExamRecord[] {
  if (cachedExams.length > 0) return cachedExams;

  const possiblePaths = [
    path.resolve(process.cwd(), 'src/shared/data/exams.json'),
    path.resolve(process.cwd(), 'dist/shared/data/exams.json'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/data/exams.json'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw) as ExamRecord[];
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('exams.json is empty');
        }
        cachedExams = parsed;
        console.log(`Loaded ${cachedExams.length} translation exams from ${p}`);
        return cachedExams;
      } catch (err) {
        console.error(`Error parsing exams from ${p}:`, err);
      }
    }
  }

  throw new Error('Unable to find or load exams.json');
}

function toPublicExam(record: ExamRecord, direction: TranslationDirection): TranslationExam | undefined {
  if (direction === 'zh-en') {
    if (
      !record.referencePassageMarkdown ||
      !Array.isArray(record.referenceTranslations) ||
      record.referenceTranslations.length !== 5
    ) {
      console.error(`[examService] ${record.year} has no usable Chinese reference bank`);
      return undefined;
    }

    return {
      id: `${record.id}-zh-en`,
      year: record.year,
      title: `${record.title} · 中译英`,
      maxScore: record.maxScore,
      contentMarkdown: record.referencePassageMarkdown,
      translationSegments: record.referenceTranslations,
      direction: 'zh-en',
    };
  }

  return {
    id: record.id,
    year: record.year,
    title: record.title,
    maxScore: record.maxScore,
    contentMarkdown: record.contentMarkdown,
    translationSegments: record.translationSegments,
    direction: 'en-zh',
  };
}

export function getAllExams(direction: TranslationDirection = DEFAULT_DIRECTION): TranslationExam[] {
  return loadExams()
    .map((record) => toPublicExam(record, direction))
    .filter((exam): exam is TranslationExam => !!exam);
}

export function getExamYears(): number[] {
  return loadExams()
    .map((e) => e.year)
    .sort((a, b) => b - a); // Newest first
}

export function getExamByYear(
  year: number,
  direction: TranslationDirection = DEFAULT_DIRECTION
): TranslationExam | undefined {
  const record = loadExams().find((e) => e.year === year);
  return record ? toPublicExam(record, direction) : undefined;
}

export function getRandomExam(
  direction: TranslationDirection = DEFAULT_DIRECTION
): TranslationExam {
  const candidates = getAllExams(direction);
  if (candidates.length === 0) {
    throw new Error(`No exams available for direction ${direction}`);
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

/**
 * Resolve the exact source sentence, standard answer and full context for one
 * segment on the server. Clients never supply these values for grading.
 */
export function getGradingMaterial(
  year: number,
  direction: TranslationDirection,
  segmentIndex: number
): GradingMaterial | undefined {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 4) return undefined;

  const record = loadExams().find((e) => e.year === year);
  if (!record) return undefined;

  if (direction === 'zh-en') {
    const sourceText = record.referenceTranslations?.[segmentIndex];
    const referenceAnswer = record.translationSegments?.[segmentIndex];
    if (!sourceText || !referenceAnswer || !record.referencePassageMarkdown) return undefined;
    return {
      sourceText,
      referenceAnswer,
      fullSource: record.referencePassageMarkdown,
    };
  }

  const sourceText = record.translationSegments?.[segmentIndex];
  const referenceAnswer = record.referenceTranslations?.[segmentIndex];
  if (!sourceText || !referenceAnswer || !record.contentMarkdown) return undefined;
  return {
    sourceText,
    referenceAnswer,
    fullSource: record.contentMarkdown,
  };
}
