/**
 * Verifies a Google Sign-In ID token (the JWT the GIS button hands the browser)
 * against our Sign-In client id. Returns the trusted profile claims, or throws.
 *
 * google-auth-library checks the signature, issuer, expiry AND that `aud`
 * matches our client id — so a token minted for some other app is rejected.
 */
import { OAuth2Client } from 'google-auth-library';
import { env, googleSignInEnabled } from '../config/env';

const client = new OAuth2Client();

export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  if (!googleSignInEnabled) {
    throw new Error('Google Sign-In is not configured on the server');
  }
  if (!idToken) throw new Error('Missing Google credential');

  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.GOOGLE_SIGNIN_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw new Error('Invalid Google token');
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name,
    picture: payload.picture,
  };
}
