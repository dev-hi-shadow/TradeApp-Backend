/**
 * Outgoing email via Gmail + Google OAuth2.
 *
 * Why OAuth2 (not an app password): Google has deprecated basic-auth SMTP for
 * most accounts. The robust, production-grade path is an OAuth2 client with the
 * Gmail scope — nodemailer takes a {clientId, clientSecret, refreshToken} and
 * mints short-lived access tokens itself, so we never store a long-lived
 * password and the grant can be revoked from the Google account at any time.
 *
 * Setup (one-time, outside the app):
 *   1. Google Cloud Console → create an OAuth 2.0 Client (type: Web/Desktop).
 *   2. Add scope https://mail.google.com/  (or gmail.send).
 *   3. Use the OAuth Playground (or your own consent flow) to authorise the
 *      sending Gmail account and obtain a REFRESH TOKEN.
 *   4. Put GMAIL_USER / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
 *      GOOGLE_REFRESH_TOKEN in the backend .env.
 *
 * Graceful degradation: if any of those four are missing (`mailEnabled` false),
 * we DON'T throw — we log the message (including the reset link) to the server
 * console. That keeps the whole forgot/reset flow testable in local dev without
 * Google credentials, and means a mail outage never 500s the auth endpoints.
 */
import nodemailer, { Transporter } from 'nodemailer';
import _ from 'lodash';
import { env, mailEnabled } from '../config/env';

let transporter: Transporter | null = null;

/** Lazily build (and memoise) the Gmail OAuth2 transport. */
function getTransporter(): Transporter | null {
  if (!mailEnabled) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: env.GMAIL_USER,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      // No accessToken supplied → nodemailer fetches & refreshes one on demand
      // using the refresh token, so we don't have to manage token lifetimes.
    },
  });
  return transporter;
}

export interface MailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email. Returns `{ sent }` — `sent` is false when we fell back to
 * console logging (no creds) so callers can branch in dev if they want.
 * Never throws on transport failure; logs and returns sent=false.
 */
export async function sendMail(opts: MailOptions): Promise<{ sent: boolean }> {
  const from = env.MAIL_FROM || `Tradar <${env.GMAIL_USER || 'no-reply@tradar.local'}>`;
  const tx = getTransporter();

  if (!tx) {
    // Dev fallback — surface enough to complete the flow by hand.
    console.log('\n[email:dev] ----- (no Gmail OAuth2 creds; logging instead) -----');
    console.log(`[email:dev] from   : ${from}`);
    console.log(`[email:dev] to     : ${opts.to}`);
    console.log(`[email:dev] subject: ${opts.subject}`);
    console.log(`[email:dev] text   : ${opts.text || _.unescape(opts.html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}`);
    console.log('[email:dev] -------------------------------------------------------\n');
    return { sent: false };
  }

  try {
    await tx.sendMail({ from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
    console.log(`[email] sent "${opts.subject}" to ${opts.to}`);
    return { sent: true };
  } catch (err: any) {
    console.error('[email] send failed:', err?.message || err);
    return { sent: false };
  }
}

/** Branded HTML + plaintext for the password-reset email. */
export function sendPasswordResetEmail(to: string, username: string, resetUrl: string) {
  // _.escape guards against any HTML-special chars in the stored username
  // leaking into the markup.
  const name = _.escape(username || 'there');
  const subject = 'Reset your Tradar password';
  const text = [
    `Hi ${username || 'there'},`,
    '',
    'We received a request to reset your Tradar password.',
    `Reset it here (link valid for ${env.RESET_TOKEN_TTL_MIN} minutes):`,
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password won't change.",
    '',
    '— Tradar',
  ].join('\n');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:#00b386;color:#fff;font-weight:700">T</span>
      <span style="font-weight:700;font-size:18px">Tradar</span>
    </div>
    <h1 style="font-size:20px;margin:0 0 8px">Reset your password</h1>
    <p style="font-size:14px;line-height:1.55;color:#334155">
      Hi ${name}, we received a request to reset your Tradar password.
      Click the button below to choose a new one. This link is valid for
      <strong>${env.RESET_TOKEN_TTL_MIN} minutes</strong>.
    </p>
    <p style="margin:24px 0">
      <a href="${resetUrl}" style="display:inline-block;background:#00b386;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px">
        Reset password
      </a>
    </p>
    <p style="font-size:12px;line-height:1.5;color:#64748b">
      Or paste this link into your browser:<br>
      <a href="${resetUrl}" style="color:#00b386;word-break:break-all">${resetUrl}</a>
    </p>
    <p style="font-size:12px;line-height:1.5;color:#64748b;margin-top:24px">
      If you didn't request this, you can safely ignore this email — your password won't change.
    </p>
  </div>`;

  return sendMail({ to, subject, html, text });
}

/** Branded HTML + plaintext for the signup email-verification email. */
export function sendVerificationEmail(to: string, username: string, verifyUrl: string) {
  const name = _.escape(username || 'there');
  const subject = 'Confirm your Tradar email';
  const text = [
    `Hi ${username || 'there'},`,
    '',
    'Welcome to Tradar! Confirm your email address to secure your account:',
    verifyUrl,
    '',
    "If you didn't create a Tradar account, you can ignore this email.",
    '',
    '— Tradar',
  ].join('\n');

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:#00b386;color:#fff;font-weight:700">T</span>
      <span style="font-weight:700;font-size:18px">Tradar</span>
    </div>
    <h1 style="font-size:20px;margin:0 0 8px">Confirm your email</h1>
    <p style="font-size:14px;line-height:1.55;color:#334155">
      Hi ${name}, welcome to Tradar. Tap the button below to confirm this email
      address and finish securing your account.
    </p>
    <p style="margin:24px 0">
      <a href="${verifyUrl}" style="display:inline-block;background:#00b386;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:10px">
        Confirm email
      </a>
    </p>
    <p style="font-size:12px;line-height:1.5;color:#64748b">
      Or paste this link into your browser:<br>
      <a href="${verifyUrl}" style="color:#00b386;word-break:break-all">${verifyUrl}</a>
    </p>
    <p style="font-size:12px;line-height:1.5;color:#64748b;margin-top:24px">
      If you didn't create a Tradar account, you can safely ignore this email.
    </p>
  </div>`;

  return sendMail({ to, subject, html, text });
}
