#!/usr/bin/env node
/**
 * End-to-end check for the bilingual feature.
 *
 * Local (real DeepSeek):
 *   E2E_BASE_URL=http://127.0.0.1:5173 E2E_MODE=real node scripts/e2e-zh-en.mjs
 *
 * CI (mock DeepSeek, built server):
 *   E2E_BASE_URL=http://127.0.0.1:8890 E2E_MODE=mock node scripts/e2e-zh-en.mjs
 */
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { chromium } from 'playwright';

const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const MODE = process.env.E2E_MODE || 'real';
const INVITE = process.env.E2E_INVITE_CODE || 'tt8888';
const SHOTS = process.env.E2E_SCREENSHOT_DIR || '/tmp/zh-en-e2e';
const GRADING_TIMEOUT = MODE === 'mock' ? 30_000 : 240_000;
const MATCH_TIMEOUT = MODE === 'mock' ? 45_000 : 300_000;

const exams = JSON.parse(
  fs.readFileSync(path.resolve('src/shared/data/exams.json'), 'utf8')
);
const latestYear = Math.max(...exams.map((e) => e.year));
const latest = exams.find((e) => e.year === latestYear);
assert(latest, `missing ${latestYear} exam`);

fs.mkdirSync(SHOTS, { recursive: true });

function log(message) {
  console.log(`[e2e] ${message}`);
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${pathname} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function register(suffix) {
  const username = `e2e_${suffix}`.slice(0, 24);
  const password = 'e2e-pass-1234';
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      invitationCode: INVITE,
      agreedTerms: true,
      nickname: `E2E-${suffix.slice(-4)}`,
    }),
  });
  return result;
}

async function makeContext(browser, user, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  if (user) {
    await context.addInitScript(
      ({ token, user: authUser }) => {
        localStorage.setItem('tt_auth_token', token);
        localStorage.setItem('tt_auth_user', JSON.stringify(authUser));
      },
      { token: user.token, user: user.user }
    );
  }
  return context;
}

async function gotoHome(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.body.innerText.includes('TRANSLATION DIRECTION'),
    null,
    { timeout: 30_000 }
  );
}

async function bodyText(page) {
  return page.locator('body').innerText();
}

async function waitText(page, text, timeout = 30_000) {
  await page.waitForFunction(
    (needle) => document.body.innerText.includes(needle),
    text,
    { timeout }
  );
}

async function clickDirection(page, direction) {
  const label = direction === 'zh-en' ? '中译英' : '英译中';
  const button = page.locator('button[aria-pressed]').filter({ hasText: label }).first();
  await button.click();
  await page.waitForFunction(
    ({ label }) => {
      const active = document.querySelector('button[aria-pressed="true"]');
      return !!active && active.textContent?.includes(label);
    },
    { label },
    { timeout: 10_000 }
  );
}

async function shot(page, name, fullPage = true) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  log(`screenshot ${file}`);
}

async function submitSoloFive(page, { direction, answers }) {
  for (let i = 0; i < 5; i++) {
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 20_000 });
    await textarea.fill(answers[i]);
    const label = direction === 'zh-en' ? '英文翻译' : '中文翻译';
    const submit = page.getByRole('button', { name: new RegExp(`确认提交第 ${i + 1} 题`) }).first();
    await submit.click();
    await page.waitForTimeout(150);
    log(`solo ${direction} submitted ${i + 1}/5 (${label})`);
  }
  await waitText(page, '全卷逐句评分与阅卷点评回看', GRADING_TIMEOUT);
  await page.waitForFunction(
    () => (document.body.innerText.match(/AI 阅卷评定/g) || []).length >= 5,
    null,
    { timeout: GRADING_TIMEOUT }
  );
}

async function submitPvpFive(page, answers) {
  for (let i = 0; i < 5; i++) {
    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 20_000 });
    await textarea.fill(answers[i]);
    const submit = page.getByRole('button', { name: new RegExp(`确认提交第 ${i + 1} 题`) }).first();
    await submit.click();
    await page.waitForTimeout(250);
    log(`pvp submitted ${i + 1}/5`);
  }
}

async function run() {
  log(`base=${BASE} mode=${MODE} year=${latestYear}`);
  const browser = await chromium.launch({ headless: true });
  let hostContext;
  let guestContext;
  let spectatorContext;
  try {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const hostUser = await register(`${suffix}a`);
    const guestUser = await register(`${suffix}b`);
    log(`registered ${hostUser.user.username} and ${guestUser.user.username}`);

    hostContext = await makeContext(browser, hostUser);
    guestContext = await makeContext(browser, guestUser);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    // --- Home: select 中译英 and verify the route board + mode copy ---
    await gotoHome(host);
    await clickDirection(host, 'zh-en');
    const homeText = await bodyText(host);
    assert(homeText.includes('中译英题干 = 网络公开标准译文'), 'direction source note missing');
    assert(homeText.includes(`开始 ${latestYear} 年中译英练习`), 'C→E solo CTA missing');
    await shot(host, '01-home-zh-en-desktop');

    // --- Solo C→E: five segments, English answers, English reference ---
    await host.getByRole('button', { name: new RegExp(`开始 ${latestYear} 年中译英练习`) }).click();
    await waitText(host, '本题待译中文原句');
    await host.waitForFunction(
      () => document.body.innerText.includes('中文参考语境') || document.body.innerText.includes('中文语境'),
      null,
      { timeout: 20_000 }
    );
    await shot(host, '02-solo-zh-en-question');
    await submitSoloFive(host, {
      direction: 'zh-en',
      answers: latest.translationSegments,
    });
    const soloText = await bodyText(host);
    assert(soloText.includes('标准英文参考译文'), 'C→E English reference label missing');
    assert(soloText.includes(latest.translationSegments[0].slice(0, 40)), 'C→E English reference missing');
    const scoreMatch = soloText.match(/总分\s*([\d.]+)/);
    assert(scoreMatch, 'solo total score not found');
    const soloScore = Number(scoreMatch[1]);
    if (MODE === 'mock') assert(soloScore >= 9.5, `mock solo score too low: ${soloScore}`);
    else assert(soloScore >= 8, `real solo score too low: ${soloScore}`);
    log(`solo C→E score=${soloScore}`);
    await shot(host, '03-solo-zh-en-results');

    // --- PVP C→E: create, join, ready, paired grading, spectator ---
    await host.getByRole('button', { name: /返回真题首页/ }).first().click();
    await waitText(host, 'TRANSLATION DIRECTION');
    await host.getByRole('button', { name: /进入 PVP 联机大厅/ }).click();
    await waitText(host, 'PVP 多人竞技与观战大厅');
    assert((await bodyText(host)).includes('中 → EN'), 'PVP lobby C→E direction missing');
    await host.getByRole('button', { name: /创建 2 人对战房间/ }).click();
    await waitText(host, '房间码：');
    const roomBody = await bodyText(host);
    const codeMatch = roomBody.match(/房间码：\s*([A-Z0-9]{6})/);
    assert(codeMatch, 'room code not found');
    const roomCode = codeMatch[1];
    log(`room ${roomCode}`);

    const spectateUrl = await host.locator('input[readonly]').evaluateAll((inputs) =>
      inputs.map((input) => input.value).find((value) => value.includes('spectate=1'))
    );
    assert(spectateUrl, 'spectate URL not found');
    await shot(host, '04-pvp-zh-en-room');

    await gotoHome(guest);
    await guest.getByRole('button', { name: /进入 PVP 联机大厅/ }).click();
    await waitText(guest, 'PVP 多人竞技与观战大厅');
    await guest.getByRole('button', { name: /输入房间码加入/ }).click();
    await guest.getByPlaceholder('例如：E3PAKQ').fill(roomCode);
    await guest.getByRole('button', { name: /作为参赛选手加入/ }).click();
    await waitText(guest, '房间码：');
    log('guest joined');

    await host.getByRole('button', { name: /准备就绪/ }).first().click();
    await guest.getByRole('button', { name: /准备就绪/ }).first().click();
    await waitText(host, '确认提交第 1 题', 20_000);
    await waitText(guest, '确认提交第 1 题', 20_000);
    log('match started');

    await Promise.all([
      submitPvpFive(host, latest.translationSegments),
      submitPvpFive(guest, latest.translationSegments),
    ]);
    await waitText(host, '全员逐题评定复盘', MATCH_TIMEOUT);
    await waitText(guest, '全员逐题评定复盘', MATCH_TIMEOUT);
    const pvpText = await bodyText(host);
    assert(pvpText.includes('中 → EN'), 'PVP match direction badge missing');
    assert(pvpText.includes('标准英文参考译文') || pvpText.includes('标准英文'), 'PVP C→E reference missing');
    log('pvp paired grading finished');
    await shot(host, '05-pvp-zh-en-results');

    spectatorContext = await makeContext(browser, null);
    const spectator = await spectatorContext.newPage();
    await spectator.goto(spectateUrl, { waitUntil: 'domcontentloaded' });
    await waitText(spectator, '实时观战', 30_000);
    const specText = await bodyText(spectator);
    assert(specText.includes('中 → EN'), 'spectator direction badge missing');
    assert(specText.includes('中文原句'), 'spectator Chinese prompt label missing');
    log('spectator view ok');
    await shot(spectator, '06-pvp-zh-en-spectator');

    // --- English→Chinese regression ---
    await host.getByRole('button', { name: /返回竞技大厅/ }).click();
    await waitText(host, 'TRANSLATION DIRECTION');
    await clickDirection(host, 'en-zh');
    await host.getByRole('button', { name: new RegExp(`开始 ${latestYear} 年英译中练习`) }).click();
    await waitText(host, '本题待译长难句');
    assert((await bodyText(host)).includes('输入您的中文翻译'), 'E→C input label missing');
    await shot(host, '07-solo-en-zh-regression');

    // --- Mobile home screenshot ---
    const mobileContext = await makeContext(browser, hostUser, {
      viewport: { width: 390, height: 844 },
    });
    const mobile = await mobileContext.newPage();
    await gotoHome(mobile);
    await clickDirection(mobile, 'zh-en');
    await shot(mobile, '08-home-zh-en-mobile');
    await mobileContext.close();

    log(`DONE mode=${MODE}`);
  } finally {
    await spectatorContext?.close().catch(() => {});
    await guestContext?.close().catch(() => {});
    await hostContext?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

run().catch((err) => {
  console.error('\n[e2e] FAILED');
  console.error(err);
  process.exit(1);
});
