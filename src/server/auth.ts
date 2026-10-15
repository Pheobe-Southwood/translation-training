import crypto from 'crypto';
import { CONFIG } from './config.js';

const SECRET_SALT = 'swiss-translation-training-auth-salt-v2';

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPasswordHash(password: string, hash: string, salt: string): boolean {
  try {
    const calculatedHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculatedHash, 'hex'));
  } catch {
    return false;
  }
}

export function verifyInvitationCode(code: string | undefined): boolean {
  if (!code) return false;
  const trimmed = code.trim();
  const expected = CONFIG.invitationCode.trim();
  if (trimmed.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(trimmed), Buffer.from(expected));
}

export function generateUserToken(userId: string): string {
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const data = `${userId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SECRET_SALT).update(data).digest('hex');
  return Buffer.from(`${userId}:${expiresAt}:${hmac}`).toString('base64');
}

export function verifyUserToken(token: string | undefined): { userId: string } | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf8');
    const [userId, expiresAtStr, hmac] = raw.split(':');
    if (!userId || !expiresAtStr || !hmac) return null;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || expiresAt < Date.now()) {
      return null;
    }

    const data = `${userId}:${expiresAt}`;
    const expectedHmac = crypto.createHmac('sha256', SECRET_SALT).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
      return null;
    }

    return { userId };
  } catch {
    return null;
  }
}

/**
 * Read-only spectator credential embedded in the shareable spectate link
 * (`/#/pvp/<CODE>?spectate=1&t=<ticket>`).
 *
 * Why a ticket instead of a user token: watching a match must work without an
 * account, and a spectator must never be able to touch a player seat. The ticket
 * is bound to one room code and expires on its own, so following a link grants
 * exactly "look at this room" and nothing else.
 */
export function generateSpectateTicket(roomCode: string, ttlMs = 24 * 60 * 60 * 1000): string {
  const code = roomCode.toUpperCase().trim();
  const expiresAt = Date.now() + ttlMs;
  const hmac = crypto
    .createHmac('sha256', SECRET_SALT)
    .update(`spectate:${code}:${expiresAt}`)
    .digest('hex');
  return Buffer.from(`${code}:${expiresAt}:${hmac}`).toString('base64url');
}

export function verifySpectateTicket(ticket: string | undefined): { roomCode: string } | null {
  if (!ticket) return null;
  try {
    const raw = Buffer.from(ticket, 'base64url').toString('utf8');
    const [roomCode, expiresAtStr, hmac] = raw.split(':');
    if (!roomCode || !expiresAtStr || !hmac) return null;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || expiresAt < Date.now()) return null;

    const expectedHmac = crypto
      .createHmac('sha256', SECRET_SALT)
      .update(`spectate:${roomCode}:${expiresAt}`)
      .digest('hex');
    if (!timingSafeStringEqual(hmac, expectedHmac)) return null;

    return { roomCode };
  } catch {
    return null;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Backwards compatibility helpers
export function generateToken(userId = 'default'): string {
  return generateUserToken(userId);
}

export function verifyToken(token: string | undefined): boolean {
  return verifyUserToken(token) !== null;
}

export function verifyPassword(password: string): boolean {
  return verifyInvitationCode(password);
}
