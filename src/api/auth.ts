import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env';
import { getKitStore } from '../persistence/kitStore';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/**
 * Authentication, kept deliberately small.
 *
 * scrypt for passwords (in Node's standard library, memory-hard, no
 * dependency) and a signed, expiring session token in an httpOnly cookie. No
 * email verification, no password reset, no roles: the brief puts those out of
 * scope, and every line here is a line that has to be right.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

export interface SessionPayload {
  sub: string;
  exp: number;
}

function sign(value: string): string {
  return createHmac('sha256', config.api.sessionSecret).update(value).digest('base64url');
}

export function createSessionToken(userId: string): string {
  const payload: SessionPayload = {
    sub: userId,
    exp: Date.now() + config.api.sessionTtlHours * 3600_000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = sign(body);
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'prep_session';

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

/**
 * Rejects anonymous callers with a structured error. An expired token is
 * reported as SESSION_EXPIRED so the interface can send the user to the login
 * screen instead of showing a generic failure.
 */
export async function requireAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const token = bearer || readCookie(request, SESSION_COOKIE);
  const payload = readSessionToken(token);
  if (!payload) {
    response.status(401).json({
      error: { code: token ? 'SESSION_EXPIRED' : 'NOT_AUTHENTICATED', message: 'sign in to continue' },
    });
    return;
  }
  const user = await getKitStore().findUserById(payload.sub);
  if (!user) {
    response.status(401).json({ error: { code: 'SESSION_INVALID', message: 'session no longer valid' } });
    return;
  }
  request.userId = user.id;
  next();
}
