/**
 * Web Push sender.
 *
 * Delivers OS-level notifications to a user's subscribed browsers via the Web
 * Push protocol (VAPID-signed), so notifications arrive even when the app tab
 * is closed — unlike the in-page Notification API. Dead subscriptions (404/410)
 * are pruned automatically.
 *
 * No-ops cleanly when VAPID keys aren't configured (`pushEnabled` false), so
 * the rest of the app is unaffected in setups without push.
 */
import webpush from 'web-push';
import { Types } from 'mongoose';
import { env, pushEnabled } from '../config/env';
import { PushSubscription } from '../models/PushSubscription';

if (pushEnabled) {
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    console.log('[push] web-push enabled (VAPID configured)');
  } catch (err: any) {
    console.error('[push] VAPID setup failed:', err.message || err);
  }
} else {
  console.warn('[push] disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable web push');
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path to open when the notification is clicked (default "/"). */
  url?: string;
  /** Collapse key — a new notif with the same tag replaces the old one. */
  tag?: string;
}

/**
 * Send a push to every subscription a user has. Fire-and-forget friendly:
 * never throws, logs failures, prunes expired endpoints.
 */
export async function sendPushToUser(userId: Types.ObjectId | string, payload: PushPayload): Promise<void> {
  if (!pushEnabled) return;
  let subs;
  try {
    subs = await PushSubscription.find({ userId });
  } catch (err: any) {
    console.error('[push] sub lookup failed:', err.message || err);
    return;
  }
  if (!subs.length) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url || '/',
    tag: payload.tag,
  });

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
          body,
        );
      } catch (err: any) {
        const status = err?.statusCode;
        // 404/410 = subscription gone (browser uninstalled / permission revoked).
        if (status === 404 || status === 410) {
          await PushSubscription.deleteOne({ _id: s._id }).catch(() => {});
        } else {
          console.error('[push] send failed:', status || err.message || err);
        }
      }
    }),
  );
}
