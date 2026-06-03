import { Router, Request, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { PushSubscription } from '../models/PushSubscription';
import { env, pushEnabled } from '../config/env';

const router = Router();

/** Public VAPID key the browser needs to create a push subscription. */
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ key: pushEnabled ? env.VAPID_PUBLIC_KEY : null, enabled: pushEnabled });
});

/** Register (upsert by endpoint) a browser's push subscription for this user. */
router.post('/subscribe', requireAuth, async (req: AuthRequest, res: Response) => {
  const sub = req.body?.subscription || req.body;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  // Upsert by endpoint — re-subscribing the same browser updates ownership/keys
  // rather than creating duplicates (and re-homes a device to the current user).
  await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      userId: req.user!.userId,
      endpoint,
      keys: { p256dh, auth },
      userAgent: req.headers['user-agent'],
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json({ ok: true });
});

/** Remove a subscription (on logout / permission revoke). */
router.post('/unsubscribe', requireAuth, async (req: AuthRequest, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) {
    await PushSubscription.deleteOne({ endpoint, userId: req.user!.userId });
  }
  res.json({ ok: true });
});

export default router;
