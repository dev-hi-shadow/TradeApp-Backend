/**
 * Price-alert engine.
 *
 * The WS price loop calls `alertService.check(symbol, newPrice)` after every
 * tick. For each active alert on that symbol we detect a CROSS (not just a
 * "currently true" condition) using the in-memory previous-price map, then
 * honour the alert's frequency rules before firing:
 *
 *   once   → fires a single time then status='triggered'
 *   every  → fires every cross with `cooldownSeconds` minimum gap
 *   daily  → fires at most once per IST day
 *
 * Firing creates an AlertEvent and pushes an `alertTriggered` message to the
 * owning user via subscriptionManager (so the toast appears even if they're
 * on a totally different page).
 */
import { Types } from 'mongoose';
import WebSocket from 'ws';
import { Alert, IAlert } from '../models/Alert';
import { AlertEvent } from '../models/AlertEvent';
import { subscriptionManager } from '../ws/subscriptionManager';
import { sendPushToUser } from './push';

// Last seen price per symbol — used for cross detection.
const prevPrice = new Map<string, number>();

function sendTo(userId: Types.ObjectId, payload: unknown): void {
  for (const ctx of subscriptionManager.authenticatedClients()) {
    if (ctx.userId.toString() === userId.toString()) {
      if (ctx.ws.readyState === WebSocket.OPEN) {
        ctx.ws.send(JSON.stringify(payload));
      }
    }
  }
}

function istDayKey(d: Date): string {
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return `${ist.getUTCFullYear()}-${ist.getUTCMonth() + 1}-${ist.getUTCDate()}`;
}

function pctChange(curr: number, base: number): number {
  if (!base) return 0;
  return ((curr - base) / base) * 100;
}

/**
 * Does this tick CROSS the alert's trigger condition?
 * (Both sides of the previous→current movement matter — we don't fire on
 * a stationary "already true" state, only on the transition.)
 */
function isCross(alert: IAlert, prev: number, curr: number): boolean {
  switch (alert.type) {
    case 'above':
      return prev < alert.value && curr >= alert.value;
    case 'below':
      return prev > alert.value && curr <= alert.value;
    case 'pctUp': {
      if (alert.baselinePrice == null) return false;
      const prevPct = pctChange(prev, alert.baselinePrice);
      const currPct = pctChange(curr, alert.baselinePrice);
      return prevPct < alert.value && currPct >= alert.value;
    }
    case 'pctDown': {
      if (alert.baselinePrice == null) return false;
      const prevPct = pctChange(prev, alert.baselinePrice);
      const currPct = pctChange(curr, alert.baselinePrice);
      return prevPct > -alert.value && currPct <= -alert.value;
    }
    default:
      return false;
  }
}

/** Frequency-rule gating — true if this alert MAY fire right now. */
function passesFrequency(alert: IAlert, now: Date): boolean {
  if (alert.frequency === 'once') return true; // it's still 'active' so we haven't fired
  if (alert.frequency === 'every') {
    if (!alert.lastTriggeredAt) return true;
    const elapsedSec = (now.getTime() - alert.lastTriggeredAt.getTime()) / 1000;
    return elapsedSec >= alert.cooldownSeconds;
  }
  if (alert.frequency === 'daily') {
    if (!alert.lastTriggeredAt) return true;
    return istDayKey(alert.lastTriggeredAt) !== istDayKey(now);
  }
  return false;
}

/** Run alert checks for one symbol given its new live price. */
export async function check(symbol: string, newPrice: number): Promise<void> {
  if (!Number.isFinite(newPrice)) return;
  const sym = symbol.toUpperCase();
  const prev = prevPrice.get(sym);
  // Always update the cache for the next tick (regardless of whether we fire)
  prevPrice.set(sym, newPrice);
  // First-ever tick for this symbol: nothing to compare against
  if (prev == null) return;

  const alerts = await Alert.find({ symbol: sym, status: 'active' });
  if (!alerts.length) return;

  const now = new Date();
  for (const alert of alerts) {
    if (!isCross(alert, prev, newPrice)) continue;
    if (!passesFrequency(alert, now)) continue;

    // Fire!
    alert.lastTriggeredAt = now;
    alert.triggerCount += 1;
    if (alert.frequency === 'once') alert.status = 'triggered';
    await alert.save();

    const event = await AlertEvent.create({
      alertId: alert._id,
      userId: alert.userId,
      symbol: sym,
      type: alert.type,
      triggerPrice: newPrice,
      conditionValue: alert.value,
      baselinePrice: alert.baselinePrice,
      note: alert.note,
    });

    // Push to the user (if they're connected) — works regardless of page.
    sendTo(alert.userId, {
      type: 'alertTriggered',
      alert: {
        id: alert._id.toString(),
        symbol: sym,
        kind: alert.type,
        value: alert.value,
        baselinePrice: alert.baselinePrice,
        frequency: alert.frequency,
        note: alert.note,
        status: alert.status,
        triggerCount: alert.triggerCount,
      },
      event: {
        id: event._id.toString(),
        triggerPrice: newPrice,
        conditionValue: alert.value,
        triggeredAt: event.triggeredAt,
      },
    });

    // Web push — reaches the user even with the app closed.
    const dir = alert.type === 'above' || alert.type === 'pctUp' ? '▲' : '▼';
    const cond = alert.type.startsWith('pct') ? `${alert.value}%` : `₹${alert.value}`;
    sendPushToUser(alert.userId, {
      title: `🔔 ${sym} alert`,
      body: `${dir} ${cond} hit @ ₹${newPrice.toFixed(2)}${alert.note ? ` · ${alert.note}` : ''}`,
      tag: `alert-${alert._id.toString()}`,
      url: '/alerts',
    }).catch(() => {});
  }
}

/** Seed the prev-price cache for a symbol — useful when an alert is freshly created. */
export function seedPrice(symbol: string, price: number): void {
  prevPrice.set(symbol.toUpperCase(), price);
}
