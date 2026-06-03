import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import _ from 'lodash';
import { Types } from 'mongoose';
import { User, IUser } from '../models/User';
import { Watchlist } from '../models/Watchlist';
import { seedDefaultPlansForUser } from '../services/plansSeeder';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { sendPasswordResetEmail, sendVerificationEmail } from '../services/email';
import { verifyGoogleIdToken } from '../services/googleAuth';
import {
  issueSession,
  rotateSession,
  revokeByToken,
  listSessions,
  revokeSessionById,
  revokeOthers,
  publicUser,
} from '../services/session';
import { env, googleSignInEnabled } from '../config/env';

const router = Router();

const DEFAULT_WATCHLIST = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'];
const MIN_PASSWORD_LEN = 6;

/** Hash a raw token for at-rest storage (raw token only ever lives in the email). */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Look up a user by id (used by the rotation flow). */
const userById = (id: Types.ObjectId) => User.findById(id);

/** The refresh token the client is holding (sent as a header on authed calls). */
function currentRefresh(req: Request): string {
  return _.trim((req.headers['x-refresh-token'] as string) || '');
}

/** Mint + persist an email-verification token and email the link. Best-effort. */
async function sendVerification(user: IUser): Promise<void> {
  const raw = crypto.randomBytes(32).toString('hex');
  user.emailVerifyTokenHash = hashToken(raw);
  user.emailVerifyExpires = new Date(Date.now() + env.VERIFY_TOKEN_TTL_MIN * 60 * 1000);
  await user.save();
  const url = `${env.APP_URL}/verify-email?token=${raw}`;
  await sendVerificationEmail(user.email, user.username, url).catch((e) =>
    console.error('[auth] verification email failed:', e?.message || e),
  );
}

/** Build a unique username from an email local-part (for Google sign-ups). */
async function uniqueUsernameFromEmail(email: string): Promise<string> {
  const base = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
  let candidate = base.length >= 3 ? base : `${base}_u`;
  for (let i = 0; i < 50; i++) {
    if (!(await User.findOne({ username: candidate }))) return candidate;
    candidate = `${base}${crypto.randomInt(1000, 9999)}`;
  }
  return `user_${crypto.randomBytes(4).toString('hex')}`;
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    const username = _.trim(req.body?.username);
    const email = _.trim(req.body?.email).toLowerCase();
    const password = req.body?.password ?? '';
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, password required' });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} chars` });
    }
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(409).json({ error: 'User already exists' });

    const user = await User.create({
      username,
      email,
      password,
      emailVerified: false,
      virtualBalance: env.DEFAULT_BALANCE,
    });
    await Watchlist.create({ userId: user._id, symbols: DEFAULT_WATCHLIST });
    await seedDefaultPlansForUser(user._id);
    await sendVerification(user);

    const bundle = await issueSession(user, req);
    res.status(201).json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const emailOrUsername = _.trim(req.body?.emailOrUsername);
    const password = req.body?.password ?? '';
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }
    const user = await User.findOne({
      $or: [{ email: emailOrUsername.toLowerCase() }, { username: emailOrUsername }],
    }).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const bundle = await issueSession(user, req);
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/**
 * POST /google { credential }
 *
 * `credential` is the Google ID token from the GIS button. We verify it
 * server-side, then link/create the user and issue our own session. Google
 * accounts arrive pre-verified, so no email-confirmation step is needed.
 */
router.post('/google', async (req: Request, res: Response) => {
  if (!googleSignInEnabled) {
    return res.status(503).json({ error: 'Google Sign-In is not enabled' });
  }
  try {
    const profile = await verifyGoogleIdToken(_.trim(req.body?.credential));

    // Match by googleId first, then by email (link an existing local account).
    let user = await User.findOne({ googleId: profile.googleId });
    if (!user) user = await User.findOne({ email: profile.email });

    if (!user) {
      const username = await uniqueUsernameFromEmail(profile.email);
      user = await User.create({
        username,
        email: profile.email,
        googleId: profile.googleId,
        avatarUrl: profile.picture,
        emailVerified: profile.emailVerified,
        virtualBalance: env.DEFAULT_BALANCE,
      });
      await Watchlist.create({ userId: user._id, symbols: DEFAULT_WATCHLIST });
      await seedDefaultPlansForUser(user._id);
    } else {
      // Link / refresh Google fields on an existing account.
      let dirty = false;
      if (!user.googleId) { user.googleId = profile.googleId; dirty = true; }
      if (profile.picture && user.avatarUrl !== profile.picture) { user.avatarUrl = profile.picture; dirty = true; }
      if (profile.emailVerified && !user.emailVerified) { user.emailVerified = true; dirty = true; }
      if (dirty) await user.save();
    }

    const bundle = await issueSession(user, req);
    res.json(bundle);
  } catch (err: any) {
    console.error('[auth] google sign-in failed:', err?.message || err);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

/** POST /verify-email { token } — confirm an address. Auth not required. */
router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const raw = _.trim(req.body?.token);
    if (!raw) return res.status(400).json({ error: 'Token required' });
    const user = await User.findOne({
      emailVerifyTokenHash: hashToken(raw),
      emailVerifyExpires: { $gt: new Date() },
    }).select('+emailVerifyTokenHash +emailVerifyExpires');
    if (!user) {
      return res.status(400).json({ error: 'Verification link is invalid or has expired.' });
    }
    user.emailVerified = true;
    user.emailVerifyTokenHash = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();
    res.json({ ok: true, message: 'Email verified.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/** POST /resend-verification (authenticated) — re-send the confirmation email. */
router.post('/resend-verification', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.user!.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, message: 'Email already verified.' });
    await sendVerification(user);
    res.json({ ok: true, message: 'Verification email sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/**
 * POST /refresh { refreshToken } — exchange a refresh token for a fresh pair.
 * No access token needed (the whole point is the access token has expired).
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const raw = _.trim(req.body?.refreshToken);
    const bundle = await rotateSession(raw, userById, req);
    if (!bundle) return res.status(401).json({ error: 'Session expired' });
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/** POST /logout { refreshToken } — revoke just this device's session. */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    await revokeByToken(_.trim(req.body?.refreshToken));
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // logout is best-effort
  }
});

/** GET /sessions (authenticated) — list active devices for this account. */
router.get('/sessions', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = new Types.ObjectId(req.user!.userId);
  const sessions = await listSessions(userId, currentRefresh(req));
  res.json({ sessions });
});

/** DELETE /sessions/:id (authenticated) — log out one device. */
router.delete('/sessions/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = new Types.ObjectId(req.user!.userId);
  const ok = await revokeSessionById(userId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

/** POST /sessions/revoke-others (authenticated) — log out everywhere else. */
router.post('/sessions/revoke-others', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = new Types.ObjectId(req.user!.userId);
  const count = await revokeOthers(userId, currentRefresh(req));
  res.json({ ok: true, revoked: count });
});

/**
 * POST /forgot-password { email }
 *
 * Always responds 200 with the same body whether or not the email exists —
 * leaking "this email is/ isn't registered" is an account-enumeration hole.
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const genericOk = { ok: true, message: 'If that email is registered, a reset link is on its way.' };
  try {
    const email = _.trim(req.body?.email).toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email });
    if (!user) return res.json(genericOk); // don't reveal non-existence

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordTokenHash = hashToken(rawToken);
    user.resetPasswordExpires = new Date(Date.now() + env.RESET_TOKEN_TTL_MIN * 60 * 1000);
    await user.save();

    const resetUrl = `${env.APP_URL}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, user.username, resetUrl);

    res.json(genericOk);
  } catch (err: any) {
    console.error('[auth] forgot-password error:', err?.message || err);
    res.json(genericOk);
  }
});

/**
 * POST /reset-password { token, password }
 *
 * Verifies the raw token against the stored hash + expiry, sets the new
 * password, and clears the one-time reset fields so the link can't be replayed.
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const rawToken = _.trim(req.body?.token);
    const password = req.body?.password ?? '';
    if (!rawToken || !password) {
      return res.status(400).json({ error: 'Token and new password required' });
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} chars` });
    }

    const user = await User.findOne({
      resetPasswordTokenHash: hashToken(rawToken),
      resetPasswordExpires: { $gt: new Date() },
    }).select('+resetPasswordTokenHash +resetPasswordExpires +password');

    if (!user) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired. Request a new one.' });
    }

    user.password = password; // pre-save hook hashes + stamps passwordChangedAt
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    // Auto sign-in after reset so the user isn't bounced back to /login.
    const bundle = await issueSession(user, req);
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/**
 * POST /change-password { currentPassword, newPassword }  (authenticated)
 *
 * For a signed-in user changing their own password. Requires the current
 * password to defend against a hijacked session silently re-keying the account.
 */
router.post('/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const currentPassword = req.body?.currentPassword ?? '';
    const newPassword = req.body?.newPassword ?? '';
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required' });
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} chars` });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    const user = await User.findById(req.user!.userId).select('+password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Google-only accounts have no password to verify against.
    if (!user.password) {
      return res.status(400).json({ error: 'This account signs in with Google and has no password to change.' });
    }
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    user.password = newPassword; // pre-save hook hashes + stamps passwordChangedAt
    await user.save();

    res.json({ ok: true, message: 'Password changed successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

/**
 * GET /config — public auth config the frontend needs. We also hand back the
 * Google client id here (it's a PUBLIC value — GIS exposes it in the browser
 * anyway) so enabling Google needs only ONE backend env var, no frontend build.
 */
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    googleSignIn: googleSignInEnabled,
    googleClientId: googleSignInEnabled ? env.GOOGLE_SIGNIN_CLIENT_ID : '',
  });
});

export default router;
