#!/usr/bin/env node
/**
 * build-passage-bank.mjs
 *
 * Merge the per-unit curation files in `data/curated/*.json` into the single
 * committed bank `src/shared/data/passage-bank.json`.
 *
 * Each curated file is one cloze / reading unit:
 *
 *   { examId, year, bank, partLabel, title, contentMarkdown,
 *     translationSegments, referenceTranslations, referenceSource,
 *     referenceSegmentSources, referenceNotes? }
 *
 * This script owns the *structural* gate only (required fields, types, examId
 * consistency, segment-count agreement). The deeper content rules — verbatim
 * substring, Han-character ratios, matrix coverage of 2004–2025 × 5 papers,
 * answer-field projection — live in `scripts/validate-passage-bank.ts`, which
 * validates the merged bank.
 *
 * Usage:
 *   node scripts/build-passage-bank.mjs           # validate + write the bank
 *   node scripts/build-passage-bank.mjs --check   # validate only, no write;
 *                                                 # also fails if the committed
 *                                                 # bank is stale
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURATED_DIR = path.join(ROOT, 'data', 'curated');
const OUTPUT_PATH = path.join(ROOT, 'src', 'shared', 'data', 'passage-bank.json');
const OUTPUT_REL = path.relative(ROOT, OUTPUT_PATH);

const FIRST_YEAR = 2004;
const LAST_YEAR = 2025;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 5;

/** Slot order inside one year: cloze first, then Text 1..4. */
const SLOTS = ['cloze', 'reading-1', 'reading-2', 'reading-3', 'reading-4'];
const SLOT_RANK = new Map(SLOTS.map((slot, index) => [slot, index]));
const EXPECTED_PART_LABEL = {
  cloze: '完型填空',
  'reading-1': '阅读理解 Text 1',
  'reading-2': '阅读理解 Text 2',
  'reading-3': '阅读理解 Text 3',
  'reading-4': '阅读理解 Text 4',
};
const ALLOWED_SEGMENT_SOURCES = new Set([
  'book',
  'book-completed',
  'reviewed-fallback',
  'web',
  'web-completed',
]);
const EXAM_ID_RE = /^(\d{4})-(cloze|reading-[1-4])$/;

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * Validate one curated unit. Returns parsed slot metadata when the examId is
 * well formed, so callers do not have to re-parse it.
 */
function validateUnit(unit, fileLabel) {
  if (!isObject(unit)) {
    fail(`${fileLabel}: top-level JSON must be an object`);
    return undefined;
  }

  let slot;
  let year;
  if (!isNonEmptyString(unit.examId)) {
    fail(`${fileLabel}: missing required field "examId"`);
  } else {
    const match = EXAM_ID_RE.exec(unit.examId);
    if (!match) {
      fail(
        `${fileLabel}: invalid examId "${unit.examId}" ` +
          '(expected ${year}-cloze or ${year}-reading-{1..4})'
      );
    } else {
      year = Number(match[1]);
      slot = match[2];
      if (year < FIRST_YEAR || year > LAST_YEAR) {
        fail(`${fileLabel}: year ${year} is outside the supported range ${FIRST_YEAR}–${LAST_YEAR}`);
      }
    }
  }

  if (!Number.isInteger(unit.year)) {
    fail(`${fileLabel}: missing required integer field "year"`);
  } else if (year !== undefined && unit.year !== year) {
    fail(`${fileLabel}: year ${unit.year} does not match examId "${unit.examId}"`);
  } else if (unit.year < FIRST_YEAR || unit.year > LAST_YEAR) {
    fail(`${fileLabel}: year ${unit.year} is outside the supported range ${FIRST_YEAR}–${LAST_YEAR}`);
  }

  if (unit.bank !== 'cloze' && unit.bank !== 'reading') {
    fail(`${fileLabel}: missing required field "bank" (expected "cloze" or "reading")`);
  } else if (slot) {
    const expectedBank = slot === 'cloze' ? 'cloze' : 'reading';
    if (unit.bank !== expectedBank) {
      fail(`${fileLabel}: bank "${unit.bank}" does not match examId "${unit.examId}"`);
    }
  }

  if (!isNonEmptyString(unit.partLabel)) {
    fail(`${fileLabel}: missing required field "partLabel"`);
  } else if (slot && unit.partLabel !== EXPECTED_PART_LABEL[slot]) {
    fail(
      `${fileLabel}: partLabel "${unit.partLabel}" should be "${EXPECTED_PART_LABEL[slot]}" ` +
        `for examId "${unit.examId}"`
    );
  }

  if (!isNonEmptyString(unit.title)) fail(`${fileLabel}: missing required field "title"`);
  if (!isNonEmptyString(unit.contentMarkdown)) {
    fail(`${fileLabel}: missing required field "contentMarkdown"`);
  }

  const segments = unit.translationSegments;
  if (!Array.isArray(segments)) {
    fail(`${fileLabel}: missing required array "translationSegments"`);
  } else {
    if (segments.length < MIN_SEGMENTS || segments.length > MAX_SEGMENTS) {
      fail(
        `${fileLabel}: translationSegments must contain ${MIN_SEGMENTS}–${MAX_SEGMENTS} sentences, ` +
          `got ${segments.length}`
      );
    }
    segments.forEach((segment, index) => {
      if (!isNonEmptyString(segment)) {
        fail(`${fileLabel}: translationSegments[${index}] must be a non-empty string`);
      }
    });
  }

  const translations = unit.referenceTranslations;
  if (!Array.isArray(translations) || translations.length === 0) {
    fail(`${fileLabel}: missing required array "referenceTranslations"`);
  } else {
    if (Array.isArray(segments) && translations.length !== segments.length) {
      fail(
        `${fileLabel}: referenceTranslations.length (${translations.length}) must equal ` +
          `translationSegments.length (${segments.length})`
      );
    }
    translations.forEach((translation, index) => {
      if (!isNonEmptyString(translation)) {
        fail(`${fileLabel}: referenceTranslations[${index}] must be a non-empty string`);
      }
    });
  }

  const source = unit.referenceSource;
  if (!isObject(source)) {
    fail(`${fileLabel}: missing required object "referenceSource"`);
  } else {
    for (const field of ['name', 'url', 'accessedAt']) {
      if (!isNonEmptyString(source[field])) {
        fail(`${fileLabel}: referenceSource.${field} must be a non-empty string`);
      }
    }
  }

  const segmentSources = unit.referenceSegmentSources;
  if (!Array.isArray(segmentSources) || segmentSources.length === 0) {
    fail(`${fileLabel}: missing required array "referenceSegmentSources"`);
  } else {
    if (Array.isArray(segments) && segmentSources.length !== segments.length) {
      fail(
        `${fileLabel}: referenceSegmentSources.length (${segmentSources.length}) must equal ` +
          `translationSegments.length (${segments.length})`
      );
    }
    segmentSources.forEach((segmentSource, index) => {
      if (!ALLOWED_SEGMENT_SOURCES.has(segmentSource)) {
        fail(
          `${fileLabel}: referenceSegmentSources[${index}]="${segmentSource}" is not one of ` +
            `${[...ALLOWED_SEGMENT_SOURCES].join(' | ')}`
        );
      }
    });
  }

  if (unit.referenceNotes !== undefined) {
    if (!Array.isArray(unit.referenceNotes)) {
      fail(`${fileLabel}: referenceNotes must be an array when present`);
    } else {
      unit.referenceNotes.forEach((note, index) => {
        if (!isNonEmptyString(note)) {
          fail(`${fileLabel}: referenceNotes[${index}] must be a non-empty string`);
        }
      });
    }
  }

  return slot ? { year, slot } : undefined;
}

function listCuratedFiles() {
  if (!fs.existsSync(CURATED_DIR)) {
    fail(`curated directory not found: ${path.relative(ROOT, CURATED_DIR)}`);
    return [];
  }
  return fs
    .readdirSync(CURATED_DIR)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(CURATED_DIR, name));
}

function mergeCuratedUnits() {
  const files = listCuratedFiles();
  if (files.length === 0) {
    fail(`no curated units found in ${path.relative(ROOT, CURATED_DIR)}/*.json`);
    return [];
  }

  const byExamId = new Map();
  for (const file of files) {
    const fileLabel = path.relative(ROOT, file);
    let unit;
    try {
      unit = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      fail(`${fileLabel}: invalid JSON — ${error.message}`);
      continue;
    }

    const slotInfo = validateUnit(unit, fileLabel);
    if (!isNonEmptyString(unit?.examId)) continue;

    const existing = byExamId.get(unit.examId);
    if (existing) {
      if (JSON.stringify(existing.unit) === JSON.stringify(unit)) {
        warn(
          `${fileLabel}: exact duplicate of ${existing.fileLabel} (examId "${unit.examId}"), keeping one copy`
        );
      } else {
        fail(
          `duplicate examId "${unit.examId}" in ${existing.fileLabel} and ${fileLabel} ` +
            'with conflicting content'
        );
      }
      continue;
    }
    byExamId.set(unit.examId, { unit, fileLabel, slotInfo });
  }

  return [...byExamId.values()]
    .filter(({ slotInfo }) => !!slotInfo)
    .sort(
      (a, b) =>
        a.slotInfo.year - b.slotInfo.year ||
        SLOT_RANK.get(a.slotInfo.slot) - SLOT_RANK.get(b.slotInfo.slot) ||
        a.unit.examId.localeCompare(b.unit.examId)
    )
    .map(({ unit }) => unit);
}

function printDiagnostics() {
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length > 0) {
    console.error(`\nPassage bank build failed (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
    for (const error of errors) console.error(`  - ${error}`);
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--check');
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(' ')}`);
    console.error('Usage: node scripts/build-passage-bank.mjs [--check]');
    process.exit(2);
  }

  const units = mergeCuratedUnits();
  if (errors.length > 0) {
    printDiagnostics();
    process.exit(1);
  }

  const serialized = `${JSON.stringify(units, null, 2)}\n`;

  if (checkOnly) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`\nPassage bank check failed: ${OUTPUT_REL} does not exist.`);
      console.error('  Run: node scripts/build-passage-bank.mjs');
      process.exit(1);
    }
    const current = fs.readFileSync(OUTPUT_PATH, 'utf8');
    if (current !== serialized) {
      console.error(`\nPassage bank check failed: ${OUTPUT_REL} is stale.`);
      console.error('  Run: node scripts/build-passage-bank.mjs to regenerate it from data/curated.');
      process.exit(1);
    }
    printDiagnostics();
    console.log(
      `Passage bank inputs OK: ${units.length} unit(s), ${units.reduce(
        (sum, unit) => sum + unit.translationSegments.length,
        0
      )} segment(s); ${OUTPUT_REL} is up to date.`
    );
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, serialized, 'utf8');
  printDiagnostics();

  const perBank = {
    cloze: units.filter((unit) => unit.bank === 'cloze').length,
    reading: units.filter((unit) => unit.bank === 'reading').length,
  };
  console.log(
    `Wrote ${units.length} unit(s) (cloze=${perBank.cloze}, reading=${perBank.reading}, ` +
      `${new Set(units.map((unit) => unit.year)).size} year(s)) to ${OUTPUT_REL}.`
  );
  if (units.length < 110) {
    console.warn(
      `note: ${units.length}/110 units merged so far — data/curated is not complete; ` +
        'the full matrix is enforced by validate-passage-bank.'
    );
  }
}

main();
