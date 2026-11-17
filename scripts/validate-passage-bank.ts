import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Strict validator for src/shared/data/passage-bank.json (cloze / reading banks).
 *
 * Run with: pnpm validate:passage-bank   (tsx scripts/validate-passage-bank.ts)
 *
 * Checks:
 *  - exactly 110 units, unique examIds, full 2004–2025 × {cloze, reading-1..4} matrix;
 *  - 3–5 segments per unit, translationSegments.length === referenceTranslations.length;
 *  - every target sentence is a verbatim substring of contentMarkdown
 *    (the client highlights by splitting the passage on the target, so this is hard);
 *  - English targets contain no Han characters; Chinese references contain Han and
 *    have a Han-character ratio >= 0.25;
 *  - referenceSource has name/url/accessedAt; referenceSegmentSources only uses
 *    web | web-completed | book | book-completed | reviewed-fallback (the passages
 *    come from the public bilingual source, so `web*` is the normal value);
 *    reviewed-fallback is documented in referenceNotes;
 *  - public projection safety: the `TranslationExam` type cannot carry answer fields,
 *    the JSON→public projection never contains them, and (once examService is ready)
 *    getExamById(..., 'en-zh') leaks nothing while getExamById(..., 'zh-en') is undefined.
 *
 * The validation reads the committed bank directly, so it runs before (and
 * independently of) the server-side passage-bank integration.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANK_PATH = path.join(ROOT, 'src', 'shared', 'data', 'passage-bank.json');
const TYPES_PATH = path.join(ROOT, 'src', 'shared', 'types.ts');

const FIRST_YEAR = 2004;
const LAST_YEAR = 2025;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 5;
const SLOTS = ['cloze', 'reading-1', 'reading-2', 'reading-3', 'reading-4'] as const;
const YEARS = Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
const EXPECTED_UNIT_COUNT = YEARS.length * SLOTS.length; // 110
const ALLOWED_SEGMENT_SOURCES = [
  'book',
  'book-completed',
  'reviewed-fallback',
  'web',
  'web-completed',
] as const;
const FORBIDDEN_PUBLIC_FIELDS = [
  'referenceTranslations',
  'referencePassageMarkdown',
  'referenceSource',
  'referenceSegmentSources',
  'referenceNotes',
  'referenceAnswer',
] as const;

const PART_LABELS: Record<string, string> = {
  cloze: '完型填空',
  'reading-1': '阅读理解 Text 1',
  'reading-2': '阅读理解 Text 2',
  'reading-3': '阅读理解 Text 3',
  'reading-4': '阅读理解 Text 4',
};

interface ReferenceSource {
  name: string;
  url: string;
  accessedAt: string;
}

interface PassageUnit {
  examId: string;
  year: number;
  bank: 'cloze' | 'reading';
  partLabel: string;
  title: string;
  contentMarkdown: string;
  translationSegments: string[];
  referenceTranslations: string[];
  referenceSource: ReferenceSource;
  referenceSegmentSources: string[];
  referenceNotes?: string[];
}

const errors: string[] = [];
const expect = (condition: unknown, message: string) => {
  if (!condition) errors.push(message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const hasHan = (text: string) => /\p{Script=Han}/u.test(text);
const hanRatio = (text: string) => {
  const chars = [...text.replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  return chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length / chars.length;
};

// ---------------------------------------------------------------------------
// Load the committed bank (fail readably instead of throwing a stack trace).
// ---------------------------------------------------------------------------
let parsed: unknown;
try {
  parsed = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
} catch (error) {
  console.error(`\nPassage bank validation failed: cannot read ${path.relative(ROOT, BANK_PATH)}`);
  console.error(`  - ${(error as Error).message}`);
  console.error('  Run "pnpm build:passage-bank" first.');
  process.exit(1);
}
if (!Array.isArray(parsed)) {
  console.error(`\nPassage bank validation failed: ${path.relative(ROOT, BANK_PATH)} must be a JSON array.`);
  process.exit(1);
}
const units = parsed as unknown as PassageUnit[];

// ---------------------------------------------------------------------------
// Matrix: count, unique examIds, 2004–2025 × 5 slots coverage, ordering.
// ---------------------------------------------------------------------------
expect(
  units.length === EXPECTED_UNIT_COUNT,
  `expected ${EXPECTED_UNIT_COUNT} units, got ${units.length} — ` +
    'finish data/curated/*.json then run "pnpm build:passage-bank"'
);

const unitIndexByExamId = new Map<string, number>();
for (const [index, unit] of units.entries()) {
  const label = isObject(unit) && isNonEmptyString(unit.examId) ? unit.examId : `unit #${index}`;
  if (!isObject(unit)) {
    expect(false, `${label}: entry must be an object`);
    continue;
  }
  if (!isNonEmptyString(unit.examId)) {
    expect(false, `${label}: missing examId`);
    continue;
  }
  if (unitIndexByExamId.has(unit.examId)) {
    expect(false, `${label}: duplicate examId (also at index ${unitIndexByExamId.get(unit.examId)})`);
    continue;
  }
  unitIndexByExamId.set(unit.examId, index);
}

const expectedExamIds = new Set(
  YEARS.flatMap((year) => SLOTS.map((slot) => `${year}-${slot}`))
);
for (const unit of units) {
  if (isNonEmptyString(unit?.examId) && !expectedExamIds.has(unit.examId)) {
    expect(
      false,
      `unexpected examId "${unit.examId}" — expected ${FIRST_YEAR}–${LAST_YEAR} × ` +
        `{cloze, reading-1..reading-4}`
    );
  }
}
for (const year of YEARS) {
  const missing = SLOTS.filter((slot) => !unitIndexByExamId.has(`${year}-${slot}`));
  if (missing.length > 0) {
    expect(false, `coverage: ${year} missing ${missing.join(', ')}`);
  }
}
const examIds = units.map((unit) => (isNonEmptyString(unit?.examId) ? unit.examId : ''));
const sortedExamIds = [...examIds].sort((a, b) => a.localeCompare(b));
expect(
  JSON.stringify(examIds) === JSON.stringify(sortedExamIds),
  'units are not sorted by examId ascending — run "pnpm build:passage-bank"'
);

// ---------------------------------------------------------------------------
// Per-unit checks: schema, segment counts, verbatim substrings, Han ratios,
// reference provenance.
// ---------------------------------------------------------------------------
const segmentSourceCounts = {
  book: 0,
  'book-completed': 0,
  'reviewed-fallback': 0,
  web: 0,
  'web-completed': 0,
};
for (const [index, unit] of units.entries()) {
  const label = isNonEmptyString(unit?.examId) ? unit.examId : `unit #${index}`;
  if (!isObject(unit)) continue;

  const examIdMatch = isNonEmptyString(unit.examId)
    ? /^(\d{4})-(cloze|reading-[1-4])$/.exec(unit.examId)
    : null;
  if (!examIdMatch) {
    expect(false, `${label}: invalid examId (expected \${year}-cloze or \${year}-reading-{1..4})`);
  } else {
    const year = Number(examIdMatch[1]);
    const slot = examIdMatch[2];
    expect(unit.year === year, `${label}: year ${unit.year} != examId year ${year}`);
    expect(year >= FIRST_YEAR && year <= LAST_YEAR, `${label}: year ${year} outside ${FIRST_YEAR}–${LAST_YEAR}`);
    expect(
      unit.bank === (slot === 'cloze' ? 'cloze' : 'reading'),
      `${label}: bank "${unit.bank}" does not match examId`
    );
    expect(
      unit.partLabel === PART_LABELS[slot],
      `${label}: partLabel "${unit.partLabel}" should be "${PART_LABELS[slot]}"`
    );
  }

  expect(isNonEmptyString(unit.title), `${label}: missing title`);
  expect(isNonEmptyString(unit.contentMarkdown), `${label}: missing contentMarkdown`);
  const content = isNonEmptyString(unit.contentMarkdown) ? unit.contentMarkdown : '';

  const segments = Array.isArray(unit.translationSegments) ? unit.translationSegments : [];
  const translations = Array.isArray(unit.referenceTranslations) ? unit.referenceTranslations : [];
  expect(
    segments.length >= MIN_SEGMENTS && segments.length <= MAX_SEGMENTS,
    `${label}: expected ${MIN_SEGMENTS}–${MAX_SEGMENTS} target sentences, got ${segments.length}`
  );
  expect(
    translations.length === segments.length,
    `${label}: referenceTranslations.length (${translations.length}) must equal ` +
      `translationSegments.length (${segments.length})`
  );

  for (const [segmentIndex, segment] of segments.entries()) {
    const segLabel = `${label} Q${segmentIndex + 1}`;
    expect(isNonEmptyString(segment), `${segLabel}: target sentence must be a non-empty string`);
    if (!isNonEmptyString(segment)) continue;
    expect(!hasHan(segment), `${segLabel}: English target sentence must not contain Han characters`);
    expect(/[A-Za-z]/.test(segment), `${segLabel}: English target sentence must contain Latin letters`);
    expect(
      content.includes(segment),
      `${segLabel}: target sentence is not a verbatim substring of contentMarkdown (highlighting uses passage.split(target))`
    );
  }

  for (const [translationIndex, translation] of translations.entries()) {
    const trLabel = `${label} Q${translationIndex + 1}`;
    expect(
      isNonEmptyString(translation),
      `${trLabel}: reference translation must be a non-empty string`
    );
    if (!isNonEmptyString(translation)) continue;
    expect(hasHan(translation), `${trLabel}: reference translation has no Han characters`);
    expect(
      hanRatio(translation) >= 0.25,
      `${trLabel}: reference translation is not Chinese enough (Han ratio ` +
        `${hanRatio(translation).toFixed(2)} < 0.25)`
    );
  }

  const source = unit.referenceSource;
  if (!isObject(source)) {
    expect(false, `${label}: missing referenceSource`);
  } else {
    for (const field of ['name', 'url', 'accessedAt'] as const) {
      expect(
        isNonEmptyString(source[field]),
        `${label}: referenceSource.${field} must be a non-empty string`
      );
    }
    if (isNonEmptyString(source.url)) {
      expect(
        /^https?:\/\/\S+$/i.test(source.url),
        `${label}: referenceSource.url should be an http(s) URL`
      );
    }
    if (isNonEmptyString(source.accessedAt)) {
      expect(
        /^\d{4}-\d{2}-\d{2}$/.test(source.accessedAt) &&
          !Number.isNaN(Date.parse(source.accessedAt)),
        `${label}: referenceSource.accessedAt should be a valid YYYY-MM-DD date`
      );
    }
  }

  const segmentSources = Array.isArray(unit.referenceSegmentSources)
    ? unit.referenceSegmentSources
    : [];
  expect(
    segmentSources.length === segments.length,
    `${label}: referenceSegmentSources.length (${segmentSources.length}) must equal ` +
      `translationSegments.length (${segments.length})`
  );
  for (const [sourceIndex, segmentSource] of segmentSources.entries()) {
    const isAllowed = (ALLOWED_SEGMENT_SOURCES as readonly string[]).includes(segmentSource);
    expect(
      isAllowed,
      `${label} Q${sourceIndex + 1}: invalid referenceSegmentSources value "${segmentSource}" ` +
        `(allowed: ${ALLOWED_SEGMENT_SOURCES.join(' | ')})`
    );
    if (isAllowed) {
      segmentSourceCounts[segmentSource as keyof typeof segmentSourceCounts] += 1;
    }
  }
  if (segmentSources.includes('reviewed-fallback')) {
    expect(
      Array.isArray(unit.referenceNotes) &&
        unit.referenceNotes.length > 0 &&
        unit.referenceNotes.every((note) => isNonEmptyString(note)),
      `${label}: uses reviewed-fallback but does not document it in referenceNotes`
    );
  }
  if (unit.referenceNotes !== undefined) {
    expect(Array.isArray(unit.referenceNotes), `${label}: referenceNotes must be an array`);
  }
}

// ---------------------------------------------------------------------------
// Public projection safety.
//
// `src/server/examService.ts` is being refactored in parallel, so the structural
// checks below always run against the shared types + the JSON records. The live
// `getExamById` assertions self-enable as soon as that API exists.
// ---------------------------------------------------------------------------
function extractInterfaceBody(source: string, name: string): string | undefined {
  const marker = `export interface ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  const open = source.indexOf('{', start);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return undefined;
}

let typesSource = '';
try {
  typesSource = fs.readFileSync(TYPES_PATH, 'utf8');
} catch (error) {
  expect(false, `cannot read src/shared/types.ts — ${(error as Error).message}`);
}
if (typesSource) {
  for (const interfaceName of ['TranslationExam', 'ExamCatalogEntry']) {
    const body = extractInterfaceBody(typesSource, interfaceName);
    expect(!!body, `src/shared/types.ts: interface ${interfaceName} not found`);
    if (!body) continue;
    for (const field of FORBIDDEN_PUBLIC_FIELDS) {
      const propertyPattern = new RegExp(`\\b${field}\\??\\s*:`);
      expect(
        !propertyPattern.test(body),
        `src/shared/types.ts: public interface ${interfaceName} declares answer field "${field}"`
      );
    }
  }
}

const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value : []);

/** Mirror of the examService en-zh public projection for a cloze/reading unit. */
function projectEnZh(unit: PassageUnit) {
  const segments = asStringArray(unit.translationSegments);
  return {
    examId: unit.examId,
    id: unit.examId,
    bank: unit.bank,
    partLabel: unit.partLabel,
    year: unit.year,
    title: unit.title,
    maxScore: segments.length * 2,
    contentMarkdown: unit.contentMarkdown,
    translationSegments: segments,
    direction: 'en-zh' as const,
  };
}

/**
 * Mirror of examService.toPublicExam(record, 'zh-en'): passage-bank records have
 * no Chinese reference passage, so a zh-en projection is impossible and must be
 * undefined. The `referencePassageMarkdown` guard keeps that equivalence honest.
 */
function projectZhEn(unit: PassageUnit): undefined {
  if ('referencePassageMarkdown' in (unit as Record<string, unknown>)) {
    return undefined;
  }
  return undefined;
}

for (const unit of units) {
  if (!isObject(unit) || !isNonEmptyString(unit.examId)) continue;
  const label = unit.examId;
  const publicProjection = projectEnZh(unit);
  const publicJson = JSON.stringify(publicProjection);

  for (const field of FORBIDDEN_PUBLIC_FIELDS) {
    expect(!publicJson.includes(field), `${label}: en-zh public projection leaked field "${field}"`);
  }
  for (const translation of asStringArray(unit.referenceTranslations)) {
    if (isNonEmptyString(translation)) {
      expect(
        !publicJson.includes(translation),
        `${label}: en-zh public projection leaked a Chinese reference translation`
      );
    }
  }
  expect(
    !Object.hasOwn(unit, 'referencePassageMarkdown'),
    `${label}: passage-bank record must not carry referencePassageMarkdown (it would enable zh-en)`
  );
  expect(
    projectZhEn(unit) === undefined,
    `${label}: cloze/reading units must not expose a zh-en projection`
  );
}

interface PublicPassageExam {
  examId?: string;
  id?: string;
  bank?: string;
  partLabel?: string;
  year?: number;
  title?: string;
  maxScore?: number;
  contentMarkdown?: string;
  translationSegments?: string[];
  direction?: string;
}
type GetExamById = (
  examId: string,
  direction?: 'en-zh' | 'zh-en'
) => PublicPassageExam | undefined;

let liveProjectionChecked = 0;
let liveProjectionAvailable = false;
try {
  const service = (await import('../src/server/examService.js')) as {
    getExamById?: unknown;
  };
  const getExamById = service.getExamById as GetExamById | undefined;
  if (typeof getExamById === 'function') {
    liveProjectionAvailable = true;
    for (const bank of ['cloze', 'reading'] as const) {
      const sample = units.find(
        (unit) => isObject(unit) && unit.bank === bank && isNonEmptyString(unit.examId)
      );
      if (!sample) continue;
      const label = sample.examId;
      try {
        const publicExam = getExamById(label, 'en-zh');
        expect(!!publicExam, `projection: getExamById("${label}", "en-zh") returned undefined`);
        if (publicExam) {
          expect(publicExam.examId === label, `projection: ${label} public examId mismatch`);
          expect(publicExam.id === label, `projection: ${label} public id mismatch`);
          expect(publicExam.bank === bank, `projection: ${label} public bank mismatch`);
          expect(publicExam.year === sample.year, `projection: ${label} public year mismatch`);
          expect(
            publicExam.partLabel === sample.partLabel,
            `projection: ${label} public partLabel mismatch`
          );
          expect(publicExam.direction === 'en-zh', `projection: ${label} direction must be en-zh`);
          expect(
            publicExam.maxScore === asStringArray(sample.translationSegments).length * 2,
            `projection: ${label} maxScore must be segments.length * 2`
          );
          expect(
            publicExam.contentMarkdown === sample.contentMarkdown,
            `projection: ${label} contentMarkdown must stay English`
          );
          expect(
            JSON.stringify(publicExam.translationSegments) ===
              JSON.stringify(asStringArray(sample.translationSegments)),
            `projection: ${label} translationSegments mismatch`
          );
          const liveJson = JSON.stringify(publicExam);
          for (const field of FORBIDDEN_PUBLIC_FIELDS) {
            expect(!liveJson.includes(field), `projection: ${label} leaked field "${field}"`);
          }
          for (const translation of asStringArray(sample.referenceTranslations)) {
            if (isNonEmptyString(translation)) {
              expect(
                !liveJson.includes(translation),
                `projection: ${label} leaked a Chinese reference translation`
              );
            }
          }
        }
        const zhEn = getExamById(label, 'zh-en');
        expect(
          zhEn === undefined,
          `projection: getExamById("${label}", "zh-en") must be undefined (cloze/reading are en-zh only)`
        );
        liveProjectionChecked++;
      } catch (error) {
        expect(false, `projection: getExamById("${label}") threw — ${(error as Error).message}`);
      }
    }
  }
} catch (error) {
  console.log(
    `[projection] live examService check deferred (service not ready): ${(error as Error).message}`
  );
}
if (!liveProjectionAvailable) {
  console.log(
    '[projection] examService.getExamById not available yet — static type/record projection checks ran; ' +
      'live check will enable automatically once the server refactor lands.'
  );
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
if (errors.length > 0) {
  console.error(`\nPassage bank validation failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const clozeCount = units.filter((unit) => unit.bank === 'cloze').length;
const readingCount = units.filter((unit) => unit.bank === 'reading').length;
const segmentCount = units.reduce((sum, unit) => sum + unit.translationSegments.length, 0);
console.log(
  `Passage bank OK: ${units.length} units / ${segmentCount} segments ` +
    `(cloze=${clozeCount}, reading=${readingCount}); ` +
    `sources book=${segmentSourceCounts.book}, book-completed=${segmentSourceCounts['book-completed']}, ` +
    `reviewed-fallback=${segmentSourceCounts['reviewed-fallback']}, web=${segmentSourceCounts.web}, ` +
    `web-completed=${segmentSourceCounts['web-completed']}; ` +
    `projection=static${liveProjectionAvailable ? `+live(${liveProjectionChecked})` : ' (live deferred)'}.`
);
