/**
 * Refresh-token session service.
 *
 * Issues the access-token + refresh-token pair, persists one Session row per
 * device (storing only the sha256 hash of the refresh token), and handles
 * rotation, revocation and reuse-detection.
 */
import crypto from 'crypto';
import { Request } from 'express';
import { Types } from 'mongoose';
import { IUser } from '../models/User';
import { Session } from '../models/Session';
import { signToken } from '../utils/jwt';
import { env } from '../config/env';
import _ from 'lodash';

export interface AuthBundle {
  token: string; // short-lived access JWT
  refreshToken: string; // opaque, long-lived (raw — only returned, never stored raw)
  user: ReturnType<typeof publicUser>;
}

/** Client-safe user projection (never leaks password/security material). */
export function publicUser(user: IUser) {
  return {
    ..._.pick(user, ['username', 'email', 'virtualBalance', 'role', 'avatarUrl', 'emailVerified']),
    id: user._id.toString(),
  };
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** First ~120 chars of the request's user-agent (for the sessions list UI). */
function uaOf(req?: Request): string | undefined {
  const ua = req?.headers['user-agent'];
  return ua ? String(ua).slice(0, 200) : undefined;
}

function ipOf(req?: Request): string | undefined {
  return req?.ip;
}

/** Mint an access JWT for a user. */
function accessFor(user: IUser): string {
  return signToken({ userId: user._id.toString(), username: user.username, role: user.role });
}

/**
 * Create a brand-new session (login / register / google / reset). Returns the
 * full auth bundle; the raw refresh token is generated here and never stored.
 */
export async function issueSession(user: IUser, req?: Request): Promise<AuthBundle> {
  const raw = crypto.randomBytes(48).toString('hex');
  await Session.create({
    userId: user._id,
    tokenHash: hashToken(raw),
    userAgent: uaOf(req),
    ip: ipOf(req),
    lastUsedAt: new Date(),
    expiresAt: refreshExpiry(),
  });
  return { token: accessFor(user), refreshToken: raw, user: publicUser(user) };
}

/**
 * Rotate a refresh token: validate it, revoke it, mint a fresh pair.
 * Returns null if the token is unknown/expired/revoked. On reuse of an
 * already-revoked token we nuke every live session for that user (theft
 * mitigation) — caller can't tell the difference, just gets null.
 */
export async function rotateSession(
  rawRefresh: string,
  userLookup: (id: Types.ObjectId) => Promise<IUser | null>,
  req?: Request,
): Promise<AuthBundle | null> {
  if (!rawRefresh) return null;
  const tokenHash = hashToken(rawRefresh);
  const session = await Session.findOne({ tokenHash });
  if (!session) return null;

  // Reuse of a revoked token → likely stolen. Kill the whole user's sessions.
  if (session.revokedAt) {
    await Session.updateMany(
      { userId: session.userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    return null;
  }
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const user = await userLookup(session.userId);
  if (!user) return null;

  // Rotate: new raw token, new row, mark the old one revoked + linked.
  const raw = crypto.randomBytes(48).toString('hex');
  const newHash = hashToken(raw);
  await Session.create({
    userId: user._id,
    tokenHash: newHash,
    userAgent: uaOf(req) || session.userAgent,
    ip: ipOf(req) || session.ip,
    lastUsedAt: new Date(),
    expiresAt: refreshExpiry(),
  });
  session.revokedAt = new Date();
  session.replacedBy = newHash;
  await session.save();

  return { token: accessFor(user), refreshToken: raw, user: publicUser(user) };
}

/** Revoke a single session by its raw refresh token (logout this device). */
export async function revokeByToken(rawRefresh: string): Promise<void> {
  if (!rawRefresh) return;
  await Session.updateOne(
    { tokenHash: hashToken(rawRefresh), revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
}

/** List a user's active (non-revoked, non-expired) sessions for the UI. */
export async function listSessions(userId: Types.ObjectId, currentRawRefresh?: string) {
  const currentHash = currentRawRefresh ? hashToken(currentRawRefresh) : null;
  const rows = await Session.find({
    userId,
    revokedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  }).sort({ lastUsedAt: -1 });
  return rows.map((s) => ({
    id: s._id.toString(),
    userAgent: s.userAgent || 'Unknown device',
    ip: s.ip || '',
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    current: currentHash != null && s.tokenHash === currentHash,
  }));
}

/** Revoke one session by id (must belong to the user). */
export async function revokeSessionById(userId: Types.ObjectId, id: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  const r = await Session.updateOne(
    { _id: id, userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date() } },
  );
  return r.modifiedCount > 0;
}

/** Revoke every session for a user except the one holding currentRawRefresh. */
export async function revokeOthers(userId: Types.ObjectId, currentRawRefresh?: string): Promise<number> {
  const keepHash = currentRawRefresh ? hashToken(currentRawRefresh) : null;
  const r = await Session.updateMany(
    { userId, revokedAt: { $exists: false }, ...(keepHash ? { tokenHash: { $ne: keepHash } } : {}) },
    { $set: { revokedAt: new Date() } },
  );
  return r.modifiedCount;
}
