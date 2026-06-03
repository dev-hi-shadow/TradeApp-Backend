import dotenv from 'dotenv';
dotenv.config();

export const env = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/paper_trading',
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_change_me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  // Short-lived access token + long-lived rotating refresh token. The access
  // token is what the app sends on every request; the refresh token (opaque,
  // hashed at rest in a Session doc) buys a new access token when it expires.
  ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL || '30m',
  REFRESH_TOKEN_TTL_DAYS: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10),
  // Google Sign-In (separate from the Gmail-sending OAuth client below). Create
  // a "Web application" OAuth 2.0 Client ID, add the frontend origin to its
  // Authorized JavaScript origins, and put the client id here + in the
  // frontend's VITE_GOOGLE_CLIENT_ID. The backend verifies the ID token's `aud`
  // against this value. Empty → the /api/auth/google route 503s (button hidden).
  GOOGLE_SIGNIN_CLIENT_ID: process.env.GOOGLE_SIGNIN_CLIENT_ID || '',
  // Validity window for the signup email-verification link.
  VERIFY_TOKEN_TTL_MIN: parseInt(process.env.VERIFY_TOKEN_TTL_MIN || '1440', 10),
  PRICE_TICK_MS: parseInt(process.env.PRICE_TICK_MS || '500', 10),
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  DEFAULT_BALANCE: parseFloat(process.env.DEFAULT_BALANCE || '100000'),
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173',
  ANGEL_KEY: process.env.ANGEL_KEY || '',
  ANGEL_CLIENT_CODE: process.env.ANGEL_CLIENT_CODE || '',
  ANGEL_PASSWORD: process.env.ANGEL_PASSWORD || '',
  ANGEL_TOTP: process.env.ANGEL_TOTP || '',

  // Public base URL of the frontend — used to build password-reset links in
  // emails. Defaults to the first CORS origin so a single env var covers most
  // dev/prod setups.
  APP_URL: process.env.APP_URL || (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim(),

  // Outgoing email via Gmail + Google OAuth2 (no "less secure app" passwords).
  // GMAIL_USER is the sending mailbox; the OAuth2 client/refresh-token are
  // obtained from a Google Cloud OAuth client with the Gmail API enabled.
  GMAIL_USER: process.env.GMAIL_USER || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || '',
  MAIL_FROM: process.env.MAIL_FROM || '',

  // Password-reset token validity window.
  RESET_TOKEN_TTL_MIN: parseInt(process.env.RESET_TOKEN_TTL_MIN || '30', 10),

  // Web Push (VAPID). Public key is exposed to the browser; private key signs
  // push messages and must stay server-side. Subject is a mailto:/https: contact.
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:dev5@smackdab.ai',
};

// Web push is only active when both VAPID keys are configured.
export const pushEnabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

export const angelEnabled = !!(env.ANGEL_KEY && env.ANGEL_CLIENT_CODE && env.ANGEL_PASSWORD && env.ANGEL_TOTP);

// Google Sign-In is only offered when a Sign-In client id is configured.
export const googleSignInEnabled = !!env.GOOGLE_SIGNIN_CLIENT_ID;

// Real email is only sent when the full Gmail OAuth2 set is present. Otherwise
// the email service degrades to console logging so the reset flow still works
// end-to-end in local dev without any Google credentials.
export const mailEnabled = !!(
  env.GMAIL_USER &&
  env.GOOGLE_CLIENT_ID &&
  env.GOOGLE_CLIENT_SECRET &&
  env.GOOGLE_REFRESH_TOKEN
);
