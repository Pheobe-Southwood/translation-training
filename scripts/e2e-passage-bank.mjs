#!/usr/bin/env node
/**
 * End-to-end check for the 完型 / 阅读 长难句 passage banks.
 *
 * The translation bank (2002–2026) has its own Playwright suite in
 * `scripts/e2e-zh-en.mjs`. This script covers what that one cannot: papers whose
 * identity is `examId` rather than `year`, variable segment counts (3–5), and the
 * rule that these banks are English→Chinese only.
 *
 * It is API-level on purpose — the behaviours that can silently break are the
 * projection (answer leakage), the bank filtering, the segment-index bounds and
 * the legacy `year` path, and all of those are cheaper and far less flaky to
 * assert over HTTP than through the DOM.
 *
 * CI (mock DeepSeek, built server):
 *   E2E_BASE_URL=http://127.0.0.1:8890 E2E_MODE=mock node scripts/e2e-passage-bank.mjs
 * Local:
 *   E2E_BASE_URL=http://127.0.0.1:5173 E2E_MODE=real node scripts/e2e-passage-bank.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const MODE = process.env.E2E_MODE || 'real';
const INVITE = process.env.E2E_INVITE_CODE || 'tt8888';
const GRADING_TIMEOUT = MODE === 'mock' ? 30_000 : 240_000;

const bankPath = path.resolve('src/shared/data/passage-bank.json');
if (!fs.existsSync(bankPath)) {
  console.log('[e2e-bank] no src/shared/data/passage-bank.json — nothing to check yet, skipping');
  process.exit(0);
}
const bank = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
if (!Array.isArray(bank) || bank.length === 0) {
  console.log('[e2e-bank] passage bank is empty — skipping');
  process.exit(0);
}

const log = (message) => console.log(`[e2e-bank] ${message}`);
let checks = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const eq = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  checks += 1;
};

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function apiOk(pathname, options = {}) {
  const { status, data } = await api(pathname, options);
  if (status < 200 || status >= 300) {
    throw new Error(`${pathname} failed (${status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const ANSWERS_KEYS = [
  'referenceTranslations',
  'referencePassageMarkdown',
  'referenceSource',
  'referenceSegmentSources',
  'referenceNotes',
];

async function main() {
  // --- auth -----------------------------------------------------------------
  const suffix = `${Date.now()}`.slice(-9);
  const registered = await apiOk('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: `e2ebank_${suffix}`.slice(0, 24),
      password: 'e2e-pass-1234',
      invitationCode: INVITE,
      agreedTerms: true,
      nickname: `BANK${suffix.slice(-4)}`,
    }),
  });
  const auth = { Authorization: `Bearer ${registered.token}` };
  ok(!!registered.token, 'register should return a token');
  log('registered test user');

  // --- bank catalogues ------------------------------------------------------
  // The public API exposes paper rows only through the catalogue (there is no
  // standalone years endpoint), so the year coverage is derived from the entries.
  const clozeCatalog = await apiOk('/api/exams/catalog?bank=cloze', { headers: auth });
  const readingCatalog = await apiOk('/api/exams/catalog?bank=reading', { headers: auth });
  const translationCatalog = await apiOk('/api/exams/catalog?bank=translation', { headers: auth });
  const clozeEntries = clozeCatalog.exams || clozeCatalog.entries || clozeCatalog;
  const readingEntries = readingCatalog.exams || readingCatalog.entries || readingCatalog;
  const translationEntries = translationCatalog.exams || translationCatalog.entries || translationCatalog;
  ok(Array.isArray(clozeEntries) && clozeEntries.length === bank.filter((u) => u.bank === 'cloze').length,
    'cloze catalogue length should match the committed bank');
  ok(Array.isArray(readingEntries) && readingEntries.length === bank.filter((u) => u.bank === 'reading').length,
    'reading catalogue length should match the committed bank');
  ok(Array.isArray(translationEntries) && translationEntries.length > 0, 'translation catalogue should be non-empty');
  ok(clozeEntries.every((e) => e.bank === 'cloze' && !!e.partLabel), 'cloze entries carry bank + partLabel');

  const catalogYears = (entries) =>
    [...new Set((Array.isArray(entries) ? entries : []).map((entry) => entry.year))];
  const clozeYears = catalogYears(clozeEntries);
  const readingYears = catalogYears(readingEntries);
  const translationYears = catalogYears(translationEntries);
  ok(clozeYears.length > 0, 'cloze catalogue should cover at least one year');
  ok(readingYears.length > 0, 'reading catalogue should cover at least one year');
  ok(translationYears.length >= 25, 'translation catalogue should cover at least 25 distinct years');

  const badBank = await api('/api/exams/catalog?bank=nope', { headers: auth });
  eq(badBank.status, 400, 'unknown bank should be rejected with 400');

  // --- per-unit projection --------------------------------------------------
  // Prefer a 4-segment unit if one exists, so the variable-length path is covered.
  const sample = bank.find((u) => u.translationSegments.length === 4) || bank[0];
  const exam = (await apiOk(`/api/exams/${sample.examId}`, { headers: auth })).exam;
  eq(exam.examId, sample.examId, 'exam payload should be keyed by examId');
  ok(['cloze', 'reading'].includes(exam.bank), 'new bank paper should report its bank');
  eq(exam.translationSegments.length, sample.translationSegments.length, 'segment count should survive projection');
  eq(exam.maxScore, sample.translationSegments.length * 2, 'maxScore should be segmentCount * 2');
  ok(exam.translationSegments.length >= 3 && exam.translationSegments.length <= 5, 'segment count must be 3–5');

  const serialized = JSON.stringify(exam);
  for (const key of ANSWERS_KEYS) {
    ok(!serialized.includes(key), `public exam must not leak ${key}`);
  }
  for (const translation of sample.referenceTranslations) {
    ok(!serialized.includes(translation), 'public exam must not leak a Chinese reference translation');
  }

  // --- English→Chinese only -------------------------------------------------
  const zhEn = await api(`/api/exams/${sample.examId}?direction=zh-en`, { headers: auth });
  eq(zhEn.status, 404, 'new banks must not expose a Chinese→English paper');

  // --- grading: in-range, out-of-range, and legacy year path ----------------
  const lastIndex = sample.translationSegments.length - 1;
  const graded = await apiOk('/api/solo/grade', {
    method: 'POST',
    headers: { ...auth, 'x-request-timeout': String(GRADING_TIMEOUT) },
    body: JSON.stringify({
      examId: sample.examId,
      segmentIndex: lastIndex,
      direction: 'en-zh',
      studentAnswer: '这是一句用于端到端测试的中文译文，用于确认最后一句序号能够被判分。',
    }),
  });
  const grading = graded.gradingResult || graded;
  ok(typeof grading.score === 'number', 'grading should return a numeric score');
  ok(!!grading.reference_translation, 'grading should return the reference translation');
  log(`graded ${sample.examId} segment ${lastIndex + 1}/${sample.translationSegments.length}`);

  const outOfRange = await api('/api/solo/grade', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      examId: sample.examId,
      segmentIndex: sample.translationSegments.length,
      direction: 'en-zh',
      studentAnswer: '越界测试',
    }),
  });
  eq(outOfRange.status, 404, 'segment index past the end must be rejected');

  // Legacy numeric-year links must keep working for the translation bank.
  const legacyYear = translationYears[0];
  const legacyByYear = await api(`/api/exams/${legacyYear}`, { headers: auth });
  eq(legacyByYear.status, 200, 'numeric year must still resolve to the translation paper');
  eq(legacyByYear.data.exam.bank, 'translation', 'numeric year resolves to the translation bank');

  const legacyGrade = await api('/api/solo/grade', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      year: legacyYear,
      segmentIndex: 0,
      direction: 'en-zh',
      studentAnswer: '旧接口兼容测试译文。',
    }),
  });
  ok(legacyGrade.status === 200 || legacyGrade.status === 429, `legacy year grading should still work (got ${legacyGrade.status})`);

  // --- history round-trip ---------------------------------------------------
  const record = {
    id: `e2e-bank-${suffix}`,
    type: 'solo',
    year: sample.year,
    examId: sample.examId,
    bank: sample.bank,
    partLabel: sample.partLabel,
    direction: 'en-zh',
    timestamp: Date.now(),
    totalScore: 1.5,
    timeSpentSeconds: 42,
    submissions: [
      {
        segmentIndex: lastIndex,
        originalText: sample.translationSegments[lastIndex],
        studentAnswer: '测试译文',
        gradingStatus: 'graded',
        gradingResult: {
          score: 1.5,
          points_breakdown: [],
          distortion_deduction: 0,
          fluency_deduction: 0,
          critique: 'e2e',
          reference_translation: sample.referenceTranslations[lastIndex],
          gradedAt: Date.now(),
        },
      },
    ],
  };
  await apiOk('/api/history', { method: 'POST', headers: auth, body: JSON.stringify({ record }) });
  const history = await apiOk('/api/history', { headers: auth });
  const saved = (history.history || history.records || []).find((item) => item.id === record.id);
  ok(!!saved, 'history record should round-trip');
  eq(saved.examId, sample.examId, 'history should persist examId');
  eq(saved.bank, sample.bank, 'history should persist bank');

  log(`OK — ${checks} assertions passed (${sample.examId}, ${sample.translationSegments.length} segments)`);
}

const timer = setTimeout(() => {
  console.error('[e2e-bank] timed out');
  process.exit(1);
}, GRADING_TIMEOUT + 120_000);

main()
  .then(() => {
    clearTimeout(timer);
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(timer);
    console.error(`[e2e-bank] FAILED: ${error.message}`);
    process.exit(1);
  });
