import fs from 'fs';
import path from 'path';

import { getExamByYear, getExamYears, getGradingMaterial } from '../src/server/examService.js';
import type { TranslationDirection } from '../src/shared/types.js';

const EXAMS_PATH = path.resolve('src/shared/data/exams.json');

interface RawExam {
  year: number;
  contentMarkdown: string;
  translationSegments: string[];
  referencePassageMarkdown: string;
  referenceTranslations: string[];
  referenceSource?: { name: string; url: string; accessedAt: string };
  referenceSegmentSources?: string[];
  referenceNotes?: string[];
}

const errors: string[] = [];
const expect = (condition: unknown, message: string) => {
  if (!condition) errors.push(message);
};

const hasHan = (text: string) => /\p{Script=Han}/u.test(text);
const hanRatio = (text: string) => {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  return chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length / chars.length;
};

const raw = JSON.parse(fs.readFileSync(EXAMS_PATH, 'utf8')) as RawExam[];
const years = raw.map((e) => e.year).sort((a, b) => a - b);
const expectedYears = Array.from({ length: 25 }, (_, i) => 2002 + i);

expect(raw.length === 25, `expected 25 exams, got ${raw.length}`);
expect(
  JSON.stringify(years) === JSON.stringify(expectedYears),
  `expected years 2002–2026, got ${years.join(',')}`
);

let fallbackCount = 0;
let completedCount = 0;
for (const exam of raw) {
  expect(exam.translationSegments?.length === 5, `${exam.year}: expected 5 English segments`);
  expect(exam.referenceTranslations?.length === 5, `${exam.year}: expected 5 Chinese references`);
  expect(!!exam.referencePassageMarkdown, `${exam.year}: missing Chinese passage`);
  expect(!!exam.referenceSource?.url, `${exam.year}: missing reference source URL`);
  expect(
    exam.referenceSegmentSources?.length === 5,
    `${exam.year}: expected 5 reference segment sources`
  );

  for (let i = 0; i < 5; i++) {
    const zh = exam.referenceTranslations?.[i] || '';
    expect(!!zh.trim(), `${exam.year} Q${i + 1}: empty Chinese reference`);
    expect(hasHan(zh), `${exam.year} Q${i + 1}: Chinese reference has no Han characters`);
    expect(hanRatio(zh) >= 0.25, `${exam.year} Q${i + 1}: Chinese reference is not Chinese enough`);

    const source = exam.referenceSegmentSources?.[i];
    expect(
      source === 'web' || source === 'web-completed' || source === 'reviewed-fallback',
      `${exam.year} Q${i + 1}: invalid segment source ${source}`
    );
    if (source === 'reviewed-fallback') fallbackCount++;
    if (source === 'web-completed') completedCount++;
  }

  if ((exam.referenceSegmentSources || []).includes('reviewed-fallback')) {
    expect(
      Array.isArray(exam.referenceNotes) && exam.referenceNotes.length > 0,
      `${exam.year}: reviewed fallback must be documented in referenceNotes`
    );
  }
}

expect(fallbackCount <= 5, `too many reviewed fallbacks: ${fallbackCount}`);

// Public projection and answer-leak checks.
const zhExam = getExamByYear(2024, 'zh-en');
const enExam = getExamByYear(2024, 'en-zh');
expect(!!zhExam, '2024 zh-en exam should exist');
expect(!!enExam, '2024 en-zh exam should exist');
expect(zhExam?.direction === 'zh-en', 'zh-en exam must carry direction=zh-en');
expect(enExam?.direction === 'en-zh', 'en-zh exam must carry direction=en-zh');
expect(zhExam?.contentMarkdown === raw.find((e) => e.year === 2024)?.referencePassageMarkdown, 'zh-en content must use Chinese passage');
expect(
  JSON.stringify(zhExam?.translationSegments) ===
    JSON.stringify(raw.find((e) => e.year === 2024)?.referenceTranslations),
  'zh-en segments must use Chinese references'
);
expect(enExam?.contentMarkdown === raw.find((e) => e.year === 2024)?.contentMarkdown, 'en-zh content must stay English');

const zhJson = JSON.stringify(zhExam);
for (const forbidden of [
  'referenceTranslations',
  'referencePassageMarkdown',
  'referenceSource',
  'referenceSegmentSources',
  'referenceNotes',
]) {
  expect(!zhJson.includes(forbidden), `zh-en public exam leaked ${forbidden}`);
}
for (const english of raw.find((e) => e.year === 2024)?.translationSegments || []) {
  expect(!zhJson.includes(english), `zh-en public exam leaked English answer: ${english.slice(0, 40)}`);
}

const material = getGradingMaterial(2024, 'zh-en', 0);
expect(!!material, 'zh-en grading material should exist');
expect(hasHan(material?.sourceText || ''), 'zh-en sourceText must be Chinese');
expect(!hasHan(material?.referenceAnswer || ''), 'zh-en referenceAnswer must be English');
expect(
  material?.referenceAnswer === raw.find((e) => e.year === 2024)?.translationSegments[0],
  'zh-en referenceAnswer must equal the existing English segment'
);

const enMaterial = getGradingMaterial(2024, 'en-zh', 0);
expect(!!enMaterial, 'en-zh grading material should exist');
expect(!hasHan(enMaterial?.sourceText || ''), 'en-zh sourceText must be English');
expect(hasHan(enMaterial?.referenceAnswer || ''), 'en-zh referenceAnswer must be Chinese');

// Direction-aware list/projection smoke checks.
const directions: TranslationDirection[] = ['en-zh', 'zh-en'];
for (const direction of directions) {
  const publicExam = getExamByYear(2002, direction);
  expect(!!publicExam, `2002 ${direction} public exam should exist`);
  expect(publicExam?.translationSegments.length === 5, `2002 ${direction} should have 5 segments`);
}
expect(getExamYears().length === 25, 'getExamYears should return 25 years');

if (errors.length > 0) {
  console.error(`\nBilingual bank validation failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `Bilingual bank OK: ${raw.length} exams / ${raw.length * 5} segments; ` +
    `web-completed=${completedCount}, reviewed-fallback=${fallbackCount}.`
);
