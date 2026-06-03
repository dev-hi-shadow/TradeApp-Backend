import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  userId: string;
  username: string;
  role?: 'user' | 'admin';
}

export function signToken(payload: JwtPayload): string {
  // Short-lived ACCESS token. The companion refresh token (see services/session)
  // buys a new one when this expires, so this can be aggressively short.
  const options: SignOptions = { expiresIn: env.ACCESS_TOKEN_TTL as any };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
