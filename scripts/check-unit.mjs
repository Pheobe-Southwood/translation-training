#!/usr/bin/env node
/**
 * Fast, read-only sanity check for ONE curated passage-bank unit.
 *
 * Curators write `data/curated/<examId>.json`; this script tells them immediately
 * whether a single file satisfies the content rules — without touching the merged
 * bank (`src/shared/data/passage-bank.json`) that other curators are editing.
 *
 * The authoritative, whole-bank gate is `scripts/validate-passage-bank.ts`.
 * This is the cheap inner-loop tool.
 *
 * Usage:
 *   node scripts/check-unit.mjs data/curated/2004-reading-1.json
 *   node scripts/check-unit.mjs data/curated/*.json
 */

import fs from 'node:fs';

const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 5;
const VALID_SOURCES = new Set(['book', 'book-completed', 'reviewed-fallback', 'web', 'web-completed']);

const hasHan = (text) => /\p{Script=Han}/u.test(text);
const hanRatio = (text) => {
  const chars = [...String(text).replace(/\s/g, '')];
  if (chars.length === 0) return 0;
  return chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length / chars.length;
};
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

function checkUnit(unit, file) {
  const errors = [];
  const expect = (condition, message) => {
    if (!condition) errors.push(message);
  };

  if (!unit || typeof unit !== 'object') {
    return [`${file}: not a JSON object`];
  }

  const examId = unit.examId;
  expect(nonEmpty(examId), 'missing examId');
  const match = typeof examId === 'string' ? examId.match(/^(\d{4})-(cloze|reading-[1-4])$/) : null;
  expect(!!match, `examId must look like 2004-cloze / 2004-reading-1, got ${JSON.stringify(examId)}`);
  if (match) {
    expect(unit.year === Number(match[1]), `year ${unit.year} does not match examId ${examId}`);
    const expectedBank = match[2] === 'cloze' ? 'cloze' : 'reading';
    expect(unit.bank === expectedBank, `bank ${JSON.stringify(unit.bank)} should be "${expectedBank}"`);
  }

  expect(nonEmpty(unit.partLabel), 'missing partLabel');
  expect(nonEmpty(unit.title), 'missing title');
  expect(nonEmpty(unit.contentMarkdown), 'missing contentMarkdown');

  const content = typeof unit.contentMarkdown === 'string' ? unit.contentMarkdown : '';
  const segments = Array.isArray(unit.translationSegments) ? unit.translationSegments : [];
  const translations = Array.isArray(unit.referenceTranslations) ? unit.referenceTranslations : [];
  const sources = Array.isArray(unit.referenceSegmentSources) ? unit.referenceSegmentSources : [];

  expect(
    segments.length >= MIN_SEGMENTS && segments.length <= MAX_SEGMENTS,
    `expected ${MIN_SEGMENTS}–${MAX_SEGMENTS} target sentences, got ${segments.length}`
  );
  expect(
    translations.length === segments.length,
    `referenceTranslations length ${translations.length} != translationSegments length ${segments.length}`
  );
  expect(sources.length === segments.length, `referenceSegmentSources length ${sources.length} != ${segments.length}`);

  segments.forEach((segment, index) => {
    const label = `${examId} segment ${index + 1}`;
    if (!nonEmpty(segment)) {
      errors.push(`${label}: empty target sentence`);
      return;
    }
    expect(!hasHan(segment), `${label}: English target sentence contains Han characters`);
    expect(/[A-Za-z]/.test(segment), `${label}: target sentence has no Latin letters`);
    expect(
      content.includes(segment),
      `${label}: target sentence is NOT a verbatim substring of contentMarkdown`
    );

    const zh = translations[index];
    if (!nonEmpty(zh)) {
      errors.push(`${label}: empty Chinese reference translation`);
    } else {
      expect(hasHan(zh), `${label}: translation has no Han characters`);
      expect(hanRatio(zh) >= 0.25, `${label}: translation is only ${(hanRatio(zh) * 100).toFixed(0)}% Han`);
    }

    const source = sources[index];
    expect(VALID_SOURCES.has(source), `${label}: invalid referenceSegmentSources value ${JSON.stringify(source)}`);
  });

  if (sources.includes('reviewed-fallback')) {
    expect(
      Array.isArray(unit.referenceNotes) && unit.referenceNotes.length > 0,
      'reviewed-fallback requires at least one entry in referenceNotes'
    );
  }

  const source = unit.referenceSource;
  expect(!!source && typeof source === 'object', 'missing referenceSource');
  if (source && typeof source === 'object') {
    expect(nonEmpty(source.name), 'referenceSource.name missing');
    expect(nonEmpty(source.url), 'referenceSource.url missing');
    expect(nonEmpty(source.accessedAt), 'referenceSource.accessedAt missing');
  }

  return errors;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/check-unit.mjs data/curated/<examId>.json [...]');
  process.exit(2);
}

let total = 0;
let failed = 0;
for (const file of files) {
  let unit;
  try {
    unit = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`✗ ${file}: cannot read/parse: ${error.message}`);
    failed += 1;
    total += 1;
    continue;
  }
  const errors = checkUnit(unit, file);
  total += 1;
  if (errors.length > 0) {
    failed += 1;
    console.error(`✗ ${file} (${errors.length} issue${errors.length > 1 ? 's' : ''})`);
    for (const error of errors) console.error(`   - ${error}`);
  } else {
    console.log(`✓ ${file} — ${unit.examId}, ${unit.translationSegments.length} segments`);
  }
}

console.log(`\n${total - failed}/${total} file(s) OK`);
process.exit(failed > 0 ? 1 : 0);
