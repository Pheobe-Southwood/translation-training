import crypto from 'crypto';
import { CONFIG } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_TOKEN_TTL_MS = 30 * DAY_MS;
const SPECTATE_TICKET_TTL_MS = DAY_MS;

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

/**
 * Shared HMAC token codec: `<payload>:<expiresAt>:<hmac>` with a hex HMAC over
 * `<namespace><payload>:<expiresAt>`. `encoding` preserves the deployed token
 * formats (user tokens are base64, spectate tickets are base64url).
 */
function signToken(
  payload: string,
  ttlMs: number,
  encoding: 'base64' | 'base64url',
  namespace = ''
): string {
  const expiresAt = Date.now() + ttlMs;
  const hmac = crypto
    .createHmac('sha256', CONFIG.authSecret)
    .update(`${namespace}${payload}:${expiresAt}`)
    .digest('hex');
  return Buffer.from(`${payload}:${expiresAt}:${hmac}`).toString(encoding);
}

function readToken(
  token: string | undefined,
  encoding: 'base64' | 'base64url',
  namespace = ''
): string | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, encoding).toString('utf8');
    const [payload, expiresAtStr, hmac] = raw.split(':');
    if (!payload || !expiresAtStr || !hmac) return null;

    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || expiresAt < Date.now()) return null;

    const expectedHmac = crypto
      .createHmac('sha256', CONFIG.authSecret)
      .update(`${namespace}${payload}:${expiresAt}`)
      .digest('hex');
    if (!timingSafeStringEqual(hmac, expectedHmac)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function generateUserToken(userId: string): string {
  return signToken(userId, USER_TOKEN_TTL_MS, 'base64');
}

export function verifyUserToken(token: string | undefined): { userId: string } | null {
  const userId = readToken(token, 'base64');
  return userId ? { userId } : null;
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
export function generateSpectateTicket(roomCode: string): string {
  return signToken(
    roomCode.toUpperCase().trim(),
    SPECTATE_TICKET_TTL_MS,
    'base64url',
    'spectate:'
  );
}

export function verifySpectateTicket(ticket: string | undefined): { roomCode: string } | null {
  const roomCode = readToken(ticket, 'base64url', 'spectate:');
  return roomCode ? { roomCode } : null;
}
