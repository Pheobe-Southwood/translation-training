import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG } from './config.js';
import {
  hashPassword,
  verifyPasswordHash,
  verifyInvitationCode,
  generateUserToken,
  verifyUserToken,
  verifySpectateTicket,
} from './auth.js';
import { db } from './db.js';
import { getExamByYear, getExamYears, getGradingMaterial, getRandomExam } from './examService.js';
import { gradeTranslation } from './deepseek.js';
import { pvpManager } from './pvpManager.js';
import { DEFAULT_DIRECTION, parseDirection } from '../shared/direction.js';
import { checkNickname } from './moderation.js';
import { SlidingWindowLimiter, clientIp, auditLog } from './rateLimit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      userId: string;
      username: string;
      nickname: string;
    };
  }
}

const app = Fastify({
  // nginx terminates TLS and forwards X-Forwarded-*; trust it for req.ip/protocol.
  trustProxy: CONFIG.trustProxy,
  bodyLimit: 1_048_576,
  // Request logging is emitted by the onResponse hook below, without query
  // strings (the WebSocket URL carries tokens) and in a stable audit shape.
  disableRequestLogging: true,
  logger: {
    level: 'info',
  },
});

/**
 * Abuse controls. The login form protects a paid AI quota, so both the source IP
 * and the targeted account are limited; registration and grading are limited too.
 */
const loginIpLimiter = new SlidingWindowLimiter(10, 10 * 60 * 1000);
const loginAccountLimiter = new SlidingWindowLimiter(5, 10 * 60 * 1000);
const registerLimiter = new SlidingWindowLimiter(5, 60 * 60 * 1000);
const gradeLimiter = new SlidingWindowLimiter(30, 10 * 60 * 1000);
const nicknameLimiter = new SlidingWindowLimiter(10, 60 * 60 * 1000);

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;'
  );

/** Inject filing/operator values into the static legal pages at request time. */
function renderLegalPage(template: string): string {
  const site = CONFIG.site;
  const icpLine = site.icpNumber
    ? `<div>ICP备案号：<a href="${escapeHtml(site.icpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        site.icpNumber
      )}</a></div>`
    : '<div>ICP备案号：待配置</div>';
  const psbLine = site.psbNumber
    ? `<div>公安备案：<a href="https://beian.mps.gov.cn/#/query/webSearch?code=${encodeURIComponent(
        site.psbCode
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(site.psbNumber)}</a></div>`
    : '';
  const email = site.contactEmail
    ? `<a href="mailto:${escapeHtml(site.contactEmail)}">${escapeHtml(site.contactEmail)}</a>`
    : '（待配置）';

  return template
    .replaceAll('%%SITE_NAME%%', escapeHtml(site.name))
    .replaceAll('%%ICP%%', escapeHtml(site.icpNumber || '待配置'))
    .replaceAll('%%ICP_LINE%%', icpLine)
    .replaceAll('%%PSB_LINE%%', psbLine)
    .replaceAll('%%OPERATOR%%', escapeHtml(site.operator || '本站主办者'))
    .replaceAll('%%CONTACT_EMAIL%%', email)
    .replaceAll('%%UPDATED_AT%%', escapeHtml(site.policyUpdatedAt))
    .replaceAll('%%TERMS_VERSION%%', escapeHtml(site.termsVersion))
    .replaceAll('%%YEAR%%', String(new Date().getFullYear()));
}

async function main() {
  // Same-origin is the only supported deployment; only register CORS when an
  // operator explicitly whitelists extra origins (never reflect arbitrary ones).
  if (CONFIG.allowedOrigins.length > 0) {
    await app.register(fastifyCors, {
      origin: CONFIG.allowedOrigins,
      credentials: true,
    });
  }

  await app.register(fastifyWebsocket);

  // Runtime site identity: keeps the ICP filing number out of the public repo.
  app.get('/site-info.js', async (_req, reply) => {
    const site = CONFIG.site;
    const payload = {
      siteName: site.name,
      icpNumber: site.icpNumber,
      icpUrl: site.icpUrl || 'https://beian.miit.gov.cn/',
      psbNumber: site.psbNumber,
      psbCode: site.psbCode,
      operator: site.operator,
      contactEmail: site.contactEmail,
      policyUpdatedAt: site.policyUpdatedAt,
      termsVersion: site.termsVersion,
    };
    reply
      .type('application/javascript; charset=utf-8')
      .header('Cache-Control', 'no-store');
    return `window.__SITE_INFO__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
  });

  // Legal pages are deliberately static and login-free so regulators, crawlers and
  // users can always reach them — even while the app gate is showing.
  for (const legalFile of ['terms.html', 'privacy.html', 'copyright.html', 'report.html']) {
    app.get(`/legal/${legalFile}`, async (_req, reply) => {
      const candidates = [
        path.join(CONFIG.staticDir, 'legal', legalFile),
        path.join(process.cwd(), 'public', 'legal', legalFile),
      ];
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      if (!found) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
      reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'public, max-age=300');
      return renderLegalPage(fs.readFileSync(found, 'utf8'));
    });
  }

  // Baseline security headers (CSP only in production so Vite HMR still works).
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');

    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (CONFIG.nodeEnv === 'production') {
      reply.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "img-src 'self' data:",
          "connect-src 'self' ws: wss:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; ')
      );
    }
    return payload;
  });

  // Access log kept free of query strings and bodies; retained by journald/nginx.
  app.addHook('onResponse', async (req, reply) => {
    app.log.info(
      {
        event: 'http_access',
        method: req.method,
        path: (req.url || '').split('?')[0],
        status: reply.statusCode,
        ip: clientIp(req),
        ua: String(req.headers['user-agent'] || '').slice(0, 160),
        ms: Math.round(reply.elapsedTime),
      },
      'http_access'
    );
  });

  // Serve static files if build exists
  const clientDist = CONFIG.staticDir;
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        reply.status(404).send({ error: 'API route not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  // --- Auth APIs ---

  // 1. Login API
  app.post('/api/auth/login', async (req, reply) => {
    const ip = clientIp(req);
    const ipGate = loginIpLimiter.consume(ip);
    if (!ipGate.allowed) {
      auditLog(app.log, 'auth.login.rate_limited', { ip, retryAfterSec: ipGate.retryAfterSec });
      return reply
        .code(429)
        .header('Retry-After', String(ipGate.retryAfterSec))
        .send({ success: false, error: '登录尝试过于频繁，请稍后再试' });
    }

    const body = (req.body as any) || {};
    const { username, password } = body;

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return reply.status(400).send({
        success: false,
        error: '请输入账号和密码',
      });
    }

    const trimmedUser = username.trim().toLowerCase();
    const accountGate = loginAccountLimiter.consume(`${ip}:${trimmedUser}`);
    if (!accountGate.allowed) {
      auditLog(app.log, 'auth.login.account_limited', { ip, username: trimmedUser });
      return reply
        .code(429)
        .header('Retry-After', String(accountGate.retryAfterSec))
        .send({ success: false, error: '该账号尝试次数过多，请稍后再试' });
    }

    const user = db.getUserByUsername(trimmedUser);

    if (!user) {
      auditLog(app.log, 'auth.login.unknown_user', { ip, username: trimmedUser });
      // Return code USER_NOT_FOUND so frontend can seamlessly auto-switch to registration
      return reply.status(404).send({
        success: false,
        code: 'USER_NOT_FOUND',
        error: '账号不存在',
      });
    }

    if (!verifyPasswordHash(password, user.password_hash, user.password_salt)) {
      auditLog(app.log, 'auth.login.bad_password', { ip, userId: user.id });
      return reply.status(401).send({
        success: false,
        code: 'INVALID_PASSWORD',
        error: '密码错误，请重新输入',
      });
    }

    loginAccountLimiter.reset(`${ip}:${trimmedUser}`);
    db.updateLastLogin(user.id);
    auditLog(app.log, 'auth.login.ok', { ip, userId: user.id });
    const token = generateUserToken(user.id);

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
      },
    };
  });

  // 2. Register API (Requires valid invitation code to prevent quota drain)
  app.post('/api/auth/register', async (req, reply) => {
    const body = (req.body as any) || {};
    const { username, password, invitationCode, nickname } = body;

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return reply.status(400).send({
        success: false,
        error: '请输入账号和密码',
      });
    }

    const ip = clientIp(req);
    const registerGate = registerLimiter.consume(ip);
    if (!registerGate.allowed) {
      auditLog(app.log, 'auth.register.rate_limited', { ip });
      return reply
        .code(429)
        .header('Retry-After', String(registerGate.retryAfterSec))
        .send({ success: false, error: '注册请求过于频繁，请稍后再试' });
    }

    // Consent is a hard gate: no account is created without an explicit opt-in.
    if (body.agreedTerms !== true) {
      return reply.status(400).send({
        success: false,
        error: '请先阅读并同意《用户协议》和《隐私政策》',
      });
    }

    const trimmedUser = username.trim().toLowerCase();
    if (trimmedUser.length < 2 || trimmedUser.length > 24) {
      return reply.status(400).send({
        success: false,
        error: '账号长度需在 2 到 24 个字符之间',
      });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(trimmedUser)) {
      return reply.status(400).send({
        success: false,
        error: '账号仅支持字母、数字、下划线、点和短横线',
      });
    }

    if (password.length < CONFIG.passwordMinLength) {
      return reply.status(400).send({
        success: false,
        error: `密码长度至少 ${CONFIG.passwordMinLength} 位`,
      });
    }
    if (password.toLowerCase() === trimmedUser || password === trimmedUser) {
      return reply.status(400).send({
        success: false,
        error: '密码不能与账号相同',
      });
    }

    // Protect DeepSeek Quota: Invitation code is mandatory
    if (!verifyInvitationCode(invitationCode)) {
      return reply.status(400).send({
        success: false,
        error: '邀请码错误，无有效邀请码无法激活使用',
      });
    }

    const existing = db.getUserByUsername(trimmedUser);
    if (existing) {
      return reply.status(400).send({
        success: false,
        error: '该账号已存在，请直接登录',
      });
    }

    const { salt, hash } = hashPassword(password);
    const userId = `u_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const nicknameCheck = checkNickname(
      typeof nickname === 'string' && nickname.trim() ? nickname : trimmedUser
    );
    if (!nicknameCheck.ok || !nicknameCheck.value) {
      return reply.status(400).send({
        success: false,
        error: nicknameCheck.reason || '昵称不符合规范',
      });
    }
    const finalNickname = nicknameCheck.value;

    const user = db.createUser({
      id: userId,
      username: trimmedUser,
      passwordHash: hash,
      passwordSalt: salt,
      nickname: finalNickname,
      termsVersion: CONFIG.termsVersion,
    });

    auditLog(app.log, 'auth.register.ok', { ip, userId: user.id });
    const token = generateUserToken(user.id);

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
      },
    };
  });

  // 3. Auth Check API
  app.get('/api/auth/check', async (req, reply) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (req.headers['x-site-token'] as string);

    const verified = verifyUserToken(token);
    if (!verified) {
      return reply.status(401).send({ authenticated: false });
    }

    const user = db.getUserById(verified.userId);
    if (!user) {
      return reply.status(401).send({ authenticated: false });
    }

    return {
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
      },
    };
  });

  // Auth Hook for protected /api routes (except /api/auth/* and /api/health)
  app.addHook('preHandler', async (req, reply) => {
    if (
      !req.url.startsWith('/api/') ||
      req.url.startsWith('/api/auth/') ||
      req.url.startsWith('/api/health')
    ) {
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (req.headers['x-site-token'] as string);

    const verified = verifyUserToken(token);
    if (!verified) {
      return reply.status(401).send({ error: 'Unauthorized: 请先登录账号' });
    }

    const user = db.getUserById(verified.userId);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized: 用户凭据已失效，请重新登录' });
    }

    req.user = {
      userId: user.id,
      username: user.username,
      nickname: user.nickname,
    };
  });

  // --- User Profile APIs ---
  app.post('/api/user/nickname', async (req, reply) => {
    const ip = clientIp(req);
    const nicknameGate = nicknameLimiter.consume(req.user!.userId);
    if (!nicknameGate.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(nicknameGate.retryAfterSec))
        .send({ error: '昵称修改过于频繁，请稍后再试' });
    }

    const body = (req.body as any) || {};
    const { nickname } = body;
    if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
      return reply.status(400).send({ error: '昵称不能为空' });
    }

    const check = checkNickname(nickname);
    if (!check.ok || !check.value) {
      auditLog(app.log, 'user.nickname.rejected', { ip, userId: req.user!.userId });
      return reply.status(400).send({ error: check.reason || '昵称不符合规范' });
    }

    db.updateNickname(req.user!.userId, check.value);
    auditLog(app.log, 'user.nickname.updated', { ip, userId: req.user!.userId });
    return { success: true, nickname: check.value };
  });

  // --- Online History Records APIs ---
  app.get('/api/history', async (req) => {
    const records = db.getUserHistory(req.user!.userId);
    return { success: true, records };
  });

  app.post('/api/history', async (req, reply) => {
    const body = (req.body as any) || {};
    const { record } = body;
    if (!record || !record.id) {
      return reply.status(400).send({ error: 'Invalid history record payload' });
    }

    db.saveHistoryRecord(req.user!.userId, record);
    return { success: true, id: record.id };
  });

  app.delete('/api/history', async (req) => {
    db.clearUserHistory(req.user!.userId);
    return { success: true };
  });

  /**
   * Data-access right (PIPL art. 45): a machine-readable copy of everything the
   * operator stores about the signed-in account.
   */
  app.get('/api/user/export', async (req, reply) => {
    const exported = db.exportUser(req.user!.userId);
    if (!exported) return reply.status(404).send({ error: '账号不存在' });

    reply
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="translation-training-account.json"');
    return {
      exportedAt: new Date().toISOString(),
      ...exported,
      notes: '本文件包含你的账号资料与练习记录，请妥善保管。',
    };
  });

  /**
   * Account deletion (PIPL art. 47). Password re-authentication prevents a stolen
   * token from destroying the account; history rows cascade with the user row.
   */
  app.delete('/api/user/account', async (req, reply) => {
    const body = (req.body as any) || {};
    const password = typeof body.password === 'string' ? body.password : '';

    const user = db.getUserById(req.user!.userId);
    if (!user) return reply.status(404).send({ error: '账号不存在' });

    if (!password || !verifyPasswordHash(password, user.password_hash, user.password_salt)) {
      return reply.status(401).send({ error: '密码错误，无法注销账号' });
    }

    const deleted = db.deleteUser(user.id);
    auditLog(app.log, 'user.account.deleted', {
      ip: clientIp(req),
      userId: user.id,
      deleted,
    });
    return { success: true };
  });

  // --- Exam APIs ---
  app.get('/api/exams/years', async () => {
    return { years: getExamYears() };
  });

  app.get('/api/exams/random', async (req, reply) => {
    const rawDirection = (req.query as any)?.direction;
    const direction = rawDirection === undefined ? DEFAULT_DIRECTION : parseDirection(rawDirection);
    if (!direction) {
      return reply.status(400).send({ error: '无效的翻译方向，仅支持 en-zh 或 zh-en' });
    }
    try {
      const exam = getRandomExam(direction);
      return { exam };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message || '题库暂不可用' });
    }
  });

  app.get('/api/exams/:year', async (req, reply) => {
    const params = req.params as { year: string };
    const year = parseInt(params.year, 10);
    const rawDirection = (req.query as any)?.direction;
    const direction = rawDirection === undefined ? DEFAULT_DIRECTION : parseDirection(rawDirection);
    if (!direction) {
      return reply.status(400).send({ error: '无效的翻译方向，仅支持 en-zh 或 zh-en' });
    }
    const exam = getExamByYear(year, direction);
    if (!exam) {
      return reply.status(404).send({ error: `未找到 ${year} 年真题（${direction}）` });
    }
    return { exam };
  });

  // --- Solo Grading API ---
  app.post('/api/solo/grade', async (req, reply) => {
    const body = (req.body as any) || {};
    const { fullArticle, targetSentence, studentAnswer, segmentIndex, year } = body;
    const rawDirection = body.direction;
    const direction =
      rawDirection === undefined ? DEFAULT_DIRECTION : parseDirection(rawDirection);

    if (!direction) {
      return reply.status(400).send({ error: '无效的翻译方向，仅支持 en-zh 或 zh-en' });
    }

    const hasStructuredExam = Number.isInteger(year) && Number.isInteger(segmentIndex);
    let material: { sourceText: string; referenceAnswer: string; fullSource: string } | undefined;
    let gradingDirection = direction;

    if (hasStructuredExam) {
      material = getGradingMaterial(year, direction, segmentIndex);
      if (!material) {
        return reply.status(404).send({ error: `未找到 ${year} 年第 ${segmentIndex + 1} 题的材料` });
      }
    } else if (direction === 'en-zh' && targetSentence) {
      // Backward-compatible English→Chinese payload used by older clients.
      material = {
        sourceText: String(targetSentence),
        referenceAnswer: '',
        fullSource: String(fullArticle || ''),
      };
      gradingDirection = 'en-zh';
    } else {
      return reply.status(400).send({
        error: direction === 'zh-en'
          ? '中译英评分需要 year 和 segmentIndex'
          : 'Missing targetSentence',
      });
    }

    const gradeGate = gradeLimiter.consume(req.user!.userId);
    if (!gradeGate.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(gradeGate.retryAfterSec))
        .send({ error: '评分请求过于频繁，请稍后再试' });
    }

    try {
      const gradingResult = await gradeTranslation({
        fullArticle: material.fullSource,
        targetSentence: material.sourceText,
        studentAnswer: studentAnswer || '',
        direction: gradingDirection,
        referenceAnswer: material.referenceAnswer || undefined,
      });
      // Explicit AI labelling at the transport layer as well as in the UI.
      reply.header('X-AI-Generated', 'true').header('X-AI-Model', 'deepseek');
      return {
        success: true,
        segmentIndex,
        direction: gradingDirection,
        gradingResult,
        aiGenerated: true,
        aiNotice: '评分与点评由人工智能模型自动生成，仅供学习参考。',
      };
    } catch (err: any) {
      req.log.error(err, 'Failed to grade translation via DeepSeek');
      return reply.status(500).send({ error: err.message || 'DeepSeek 评分失败' });
    }
  });

  // --- WebSocket Route for PVP ---
  //
  // Two ways in, with strictly different powers:
  //  - `?ticket=<spectateTicket>&playerId=spec_...&nickname=...` : read-only viewer.
  //    The ticket proves possession of the shareable spectate link, so watching
  //    needs no account and can never touch a player seat.
  //  - `?token=<userToken>&playerId=<userId>` : player-capable connection. The
  //    playerId must match the token owner, so nobody can hijack another seat.
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    const ticket = url.searchParams.get('ticket');
    const playerId = url.searchParams.get('playerId');
    const nickname = url.searchParams.get('nickname') || undefined;

    if (ticket) {
      const verifiedTicket = verifySpectateTicket(ticket);
      if (!verifiedTicket) {
        socket.close(4003, 'Spectate link invalid or expired');
        return;
      }
      if (!playerId || !playerId.startsWith('spec_')) {
        socket.close(4003, 'Spectator identity required');
        return;
      }

      const safeSpectator =
        nickname && checkNickname(nickname).ok ? checkNickname(nickname).value : '观众';
      const result = pvpManager.registerSpectatorSeat(
        playerId,
        verifiedTicket.roomCode,
        safeSpectator,
        socket as any
      );
      if (!result.ok) {
        socket.close(result.reason === 'ROOM_NOT_FOUND' ? 4005 : 4004, result.reason);
      }
      return;
    }

    const verified = verifyUserToken(token || undefined);
    if (!verified || !playerId) {
      socket.close(4001, 'Unauthorized token or missing playerId');
      return;
    }
    if (playerId !== verified.userId) {
      socket.close(4002, 'playerId does not match the authenticated token');
      return;
    }

    pvpManager.registerClient(playerId, socket as any);
  });

  // Health check endpoint
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  console.log(
    `[DeepSeek] thinking=enabled reasoning_effort=${CONFIG.deepseekReasoningEffort} model=deepseek-flash`
  );

  try {
    await app.listen({ port: CONFIG.port, host: CONFIG.host });
    console.log(`[translation-training] Server listening on http://${CONFIG.host}:${CONFIG.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
