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
} from './auth.js';
import { db } from './db.js';
import { getExamByYear, getExamYears, getRandomExam } from './examService.js';
import { gradeTranslation } from './deepseek.js';
import { pvpManager } from './pvpManager.js';

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
  logger: {
    level: CONFIG.nodeEnv === 'development' ? 'info' : 'warn',
  },
});

async function main() {
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyWebsocket);

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
    const body = (req.body as any) || {};
    const { username, password } = body;

    if (!username || typeof username !== 'string' || !password || typeof password !== 'string') {
      return reply.status(400).send({
        success: false,
        error: '请输入账号和密码',
      });
    }

    const trimmedUser = username.trim().toLowerCase();
    const user = db.getUserByUsername(trimmedUser);

    if (!user) {
      // Return code USER_NOT_FOUND so frontend can seamlessly auto-switch to registration
      return reply.status(404).send({
        success: false,
        code: 'USER_NOT_FOUND',
        error: '账号不存在',
      });
    }

    if (!verifyPasswordHash(password, user.password_hash, user.password_salt)) {
      return reply.status(401).send({
        success: false,
        code: 'INVALID_PASSWORD',
        error: '密码错误，请重新输入',
      });
    }

    db.updateLastLogin(user.id);
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

    const trimmedUser = username.trim().toLowerCase();
    if (trimmedUser.length < 2 || trimmedUser.length > 24) {
      return reply.status(400).send({
        success: false,
        error: '账号长度需在 2 到 24 个字符之间',
      });
    }

    if (password.length < 4) {
      return reply.status(400).send({
        success: false,
        error: '密码长度至少需 4 个字符',
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
    const finalNickname = (nickname && typeof nickname === 'string' && nickname.trim())
      ? nickname.trim().slice(0, 20)
      : trimmedUser;

    const user = db.createUser({
      id: userId,
      username: trimmedUser,
      passwordHash: hash,
      passwordSalt: salt,
      nickname: finalNickname,
    });

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
    const body = (req.body as any) || {};
    const { nickname } = body;
    if (!nickname || typeof nickname !== 'string' || !nickname.trim()) {
      return reply.status(400).send({ error: '昵称不能为空' });
    }

    const cleanNickname = nickname.trim().slice(0, 20);
    db.updateNickname(req.user!.userId, cleanNickname);
    return { success: true, nickname: cleanNickname };
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

  // --- Exam APIs ---
  app.get('/api/exams/years', async () => {
    return { years: getExamYears() };
  });

  app.get('/api/exams/random', async () => {
    const exam = getRandomExam();
    return { exam };
  });

  app.get('/api/exams/:year', async (req, reply) => {
    const params = req.params as { year: string };
    const year = parseInt(params.year, 10);
    const exam = getExamByYear(year);
    if (!exam) {
      return reply.status(404).send({ error: `未找到 ${year} 年真题` });
    }
    return { exam };
  });

  // --- Solo Grading API ---
  app.post('/api/solo/grade', async (req, reply) => {
    const body = (req.body as any) || {};
    const { fullArticle, targetSentence, studentAnswer, segmentIndex } = body;

    if (!targetSentence) {
      return reply.status(400).send({ error: 'Missing targetSentence' });
    }

    try {
      const gradingResult = await gradeTranslation({
        fullArticle: fullArticle || '',
        targetSentence,
        studentAnswer: studentAnswer || '',
      });
      return { success: true, segmentIndex, gradingResult };
    } catch (err: any) {
      req.log.error(err, 'Failed to grade translation via DeepSeek');
      return reply.status(500).send({ error: err.message || 'DeepSeek 评分失败' });
    }
  });

  // --- WebSocket Route for PVP ---
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    const playerId = url.searchParams.get('playerId');

    const verified = verifyUserToken(token || undefined);
    if (!verified || !playerId) {
      socket.close(4001, 'Unauthorized token or missing playerId');
      return;
    }

    // The claimed playerId must belong to the authenticated user. Without this binding any
    // logged-in user could open a second socket under a forged id, re-enter a live room as a
    // "spectator" and read every player's answers.
    if (verified.userId !== playerId) {
      socket.close(4001, 'playerId does not match the authenticated user');
      return;
    }

    pvpManager.registerClient(playerId, socket as any);
  });

  // Health check endpoint
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  try {
    await app.listen({ port: CONFIG.port, host: CONFIG.host });
    console.log(`[translation-training] Server listening on http://${CONFIG.host}:${CONFIG.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
