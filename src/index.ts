/**
 * Bills Dashboard — public, multi-user version (bills.laudeus.org)
 *
 * Cloudflare Worker + Hono + D1 + Clerk auth.
 * - Every bill/payment/setting row carries a user_id (the Clerk user id) and
 *   every query is scoped to it, so users only ever see their own data.
 * - Auth: Clerk session JWT verified on every /api call via @clerk/backend
 *   verifyToken, with authorizedParties set to the app origin (CSRF defence).
 * - Static frontend is served from ./public via Workers Static Assets.
 */

import { Hono } from 'hono';
import { verifyToken, createClerkClient } from '@clerk/backend';

// ---------------------------------------------------------------------------
// Types & environment
// ---------------------------------------------------------------------------

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  CLERK_SECRET_KEY?: string;
  CLERK_PUBLISHABLE_KEY?: string;
  APP_URL?: string;
};

type Variables = {
  userId: string;
  userEmail: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'one-time'] as const;
type Frequency = (typeof FREQUENCIES)[number];

interface BillRow {
  id: number;
  user_id: string;
  name: string;
  kind: 'bill' | 'subscription';
  category: string;
  amount: number;
  currency: string;
  frequency: Frequency;
  next_due_date: string;
  autopay: number;
  payment_source: string;
  status: 'active' | 'paused';
  late_fee: number;
  grace_days: number;
  penalty_note: string;
  notes: string;
  reminder_offsets: string; // JSON array
  created_at: string;
  updated_at: string;
}

interface PaymentRow {
  id: number;
  bill_id: number;
  user_id: string;
  amount: number;
  paid_date: string;
  note: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Date helpers (all UTC, YYYY-MM-DD)
// ---------------------------------------------------------------------------

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return toISODate(new Date());
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(dateStr: string, n: number): string {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

function daysUntil(dueDate: string, fromDate = todayStr()): number {
  const ms = parseDate(dueDate).getTime() - parseDate(fromDate).getTime();
  return Math.round(ms / 86400000);
}

function urgency(days: number): 'overdue' | 'today' | 'soon' | 'later' {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'soon';
  return 'later';
}

function monthlyEquivalent(amount: number, frequency: Frequency): number {
  switch (frequency) {
    case 'weekly': return (amount * 52) / 12;
    case 'biweekly': return (amount * 26) / 12;
    case 'monthly': return amount;
    case 'quarterly': return amount / 3;
    case 'yearly': return amount / 12;
    case 'one-time': return 0;
  }
}

/** Advance a due date by one period, clamping month-ends (e.g. Jan 31 -> Feb 28). */
function advanceDueDate(dateStr: string, frequency: Frequency): string | null {
  const d = parseDate(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const clamp = (year: number, month: number, d0: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(d0, last)));
  };
  switch (frequency) {
    case 'weekly': return addDays(dateStr, 7);
    case 'biweekly': return addDays(dateStr, 14);
    case 'monthly': return toISODate(clamp(y, m + 1, day));
    case 'quarterly': return toISODate(clamp(y, m + 3, day));
    case 'yearly': return toISODate(clamp(y + 1, m, day));
    case 'one-time': return null;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Bill shaping & validation
// ---------------------------------------------------------------------------

function shapeBill(row: BillRow, today = todayStr()) {
  const days = daysUntil(row.next_due_date, today);
  let offsets: number[] = [];
  try { offsets = JSON.parse(row.reminder_offsets); } catch { offsets = [7, 1]; }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    frequency: row.frequency,
    nextDueDate: row.next_due_date,
    autopay: row.autopay === 1,
    paymentSource: row.payment_source,
    status: row.status,
    lateFee: row.late_fee,
    graceDays: row.grace_days,
    penaltyNote: row.penalty_note,
    notes: row.notes,
    reminderOffsets: offsets,
    daysUntilDue: days,
    urgency: urgency(days),
    monthlyEquivalent: round2(monthlyEquivalent(row.amount, row.frequency)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isValidDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDate(s).getTime());
}

function validateBill(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.length > 120)
    return { ok: false, error: 'name is required (1-120 chars).' };
  if (b.kind !== 'bill' && b.kind !== 'subscription')
    return { ok: false, error: "kind must be 'bill' or 'subscription'." };
  if (typeof b.category !== 'string' || b.category.trim().length < 1 || b.category.length > 60)
    return { ok: false, error: 'category is required (1-60 chars).' };
  if (typeof b.amount !== 'number' || b.amount < 0)
    return { ok: false, error: 'amount must be a number >= 0.' };
  if (b.currency !== undefined && typeof b.currency !== 'string')
    return { ok: false, error: 'currency must be a string.' };
  if (!FREQUENCIES.includes(b.frequency as Frequency))
    return { ok: false, error: `frequency must be one of: ${FREQUENCIES.join(', ')}.` };
  if (!isValidDate(b.nextDueDate))
    return { ok: false, error: 'nextDueDate must be YYYY-MM-DD.' };
  if (typeof b.autopay !== 'boolean')
    return { ok: false, error: 'autopay must be a boolean.' };
  if (typeof b.paymentSource !== 'string')
    return { ok: false, error: 'paymentSource must be a string.' };
  if (b.status !== 'active' && b.status !== 'paused')
    return { ok: false, error: "status must be 'active' or 'paused'." };
  if (typeof b.lateFee !== 'number' || b.lateFee < 0)
    return { ok: false, error: 'lateFee must be a number >= 0.' };
  if (typeof b.graceDays !== 'number' || !Number.isInteger(b.graceDays) || b.graceDays < 0 || b.graceDays > 90)
    return { ok: false, error: 'graceDays must be an integer 0-90.' };
  if (typeof b.penaltyNote !== 'string')
    return { ok: false, error: 'penaltyNote must be a string.' };
  if (typeof b.notes !== 'string')
    return { ok: false, error: 'notes must be a string.' };
  if (!Array.isArray(b.reminderOffsets) || b.reminderOffsets.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 30))
    return { ok: false, error: 'reminderOffsets must be an array of integers 0-30.' };
  return { ok: true, value: b };
}

// ---------------------------------------------------------------------------
// Auth middleware (Clerk)
// ---------------------------------------------------------------------------

async function ensureUser(env: Env, userId: string): Promise<{ email: string; displayName: string }> {
  const existing = await env.DB.prepare('SELECT email, display_name FROM users WHERE id = ?')
    .bind(userId).first<{ email: string; display_name: string }>();
  if (existing) return { email: existing.email, displayName: existing.display_name };

  // First sight of this user: fetch profile from Clerk (one call per new user).
  let email = '';
  let displayName = '';
  try {
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY! });
    const u = await clerk.users.getUser(userId);
    email = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress
      ?? u.emailAddresses[0]?.emailAddress ?? '';
    displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || '';
  } catch {
    // Clerk lookup failed (network or user deleted) — keep the row minimal
    // rather than blocking the request; email can sync on a later call.
  }
  await env.DB.prepare(
    'INSERT INTO users (id, email, display_name) VALUES (?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET updated_at = datetime(\'now\')'
  ).bind(userId, email, displayName).run();
  return { email, displayName };
}

app.use('/api/*', async (c, next) => {
  // Public config endpoint (no auth) — the frontend needs the publishable key.
  if (c.req.path === '/api/config') return next();

  const secret = c.env.CLERK_SECRET_KEY;
  if (!secret) {
    return c.json({ error: 'auth_not_configured', message: 'Clerk is not configured on this deployment yet.' }, 503);
  }
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'unauthorized', message: 'Missing Bearer token.' }, 401);

  const appUrl = c.env.APP_URL || 'https://bills.laudeus.org';
  let payload: { sub: string };
  try {
    payload = await verifyToken(token, {
      secretKey: secret,
      // CSRF defence: only accept tokens issued for this app.
      authorizedParties: [appUrl, 'http://localhost:8787'],
    });
  } catch {
    return c.json({ error: 'unauthorized', message: 'Invalid or expired session.' }, 401);
  }
  const userId = payload.sub;
  if (!userId) return c.json({ error: 'unauthorized', message: 'Token has no subject.' }, 401);

  const profile = await ensureUser(c.env, userId);
  c.set('userId', userId);
  c.set('userEmail', profile.email);
  return next();
});

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

app.get('/api/config', (c) => {
  return c.json({
    configured: Boolean(c.env.CLERK_PUBLISHABLE_KEY && c.env.CLERK_SECRET_KEY),
    clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY || null,
    appUrl: c.env.APP_URL || 'https://bills.laudeus.org',
  });
});

// ---------------------------------------------------------------------------
// Me / settings
// ---------------------------------------------------------------------------

app.get('/api/me', (c) => {
  return c.json({ id: c.get('userId'), email: c.get('userEmail') });
});

app.get('/api/settings', async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare('SELECT reminder_offsets, notify_in_app FROM settings WHERE user_id = ?')
    .bind(userId).first<{ reminder_offsets: string; notify_in_app: number }>();
  let offsets = [14, 7, 3, 1, 0];
  if (row) { try { offsets = JSON.parse(row.reminder_offsets); } catch { /* keep default */ } }
  return c.json({ reminderOffsets: offsets, notifyInApp: row ? row.notify_in_app === 1 : true });
});

app.put('/api/settings', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const offsets = Array.isArray(body.reminderOffsets)
    ? (body.reminderOffsets as unknown[]).filter((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 30)
    : [14, 7, 3, 1, 0];
  const notifyInApp = body.notifyInApp === undefined ? true : body.notifyInApp === true;
  await c.env.DB.prepare(
    'INSERT INTO settings (user_id, reminder_offsets, notify_in_app, updated_at) VALUES (?, ?, ?, datetime(\'now\')) ' +
    'ON CONFLICT(user_id) DO UPDATE SET reminder_offsets = excluded.reminder_offsets, notify_in_app = excluded.notify_in_app, updated_at = datetime(\'now\')'
  ).bind(userId, JSON.stringify(offsets), notifyInApp ? 1 : 0).run();
  return c.json({ reminderOffsets: offsets, notifyInApp });
});

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

app.get('/api/bills', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM bills WHERE user_id = ? ORDER BY next_due_date ASC, name ASC'
  ).bind(userId).all<BillRow>();
  return c.json({ bills: (results ?? []).map((r) => shapeBill(r)) });
});

app.post('/api/bills', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const v = validateBill(body);
  if (!v.ok) return c.json({ error: 'invalid', message: v.error }, 400);
  const b = v.value;
  const res = await c.env.DB.prepare(
    'INSERT INTO bills (user_id, name, kind, category, amount, currency, frequency, next_due_date, autopay, payment_source, status, late_fee, grace_days, penalty_note, notes, reminder_offsets) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    userId, (b.name as string).trim(), b.kind, (b.category as string).trim(), b.amount,
    (b.currency as string) || 'CAD', b.frequency, b.nextDueDate, (b.autopay as boolean) ? 1 : 0,
    (b.paymentSource as string) || '', b.status, b.lateFee, b.graceDays,
    (b.penaltyNote as string) || '', (b.notes as string) || '',
    JSON.stringify(b.reminderOffsets),
  ).run();
  const id = res.meta.last_row_id as number;
  const row = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').bind(id, userId).first<BillRow>();
  return c.json({ bill: row ? shapeBill(row) : null }, 201);
});

app.put('/api/bills/:id', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid', message: 'Bad bill id.' }, 400);
  const body = await c.req.json().catch(() => null);
  const v = validateBill(body);
  if (!v.ok) return c.json({ error: 'invalid', message: v.error }, 400);
  const b = v.value;
  const res = await c.env.DB.prepare(
    'UPDATE bills SET name = ?, kind = ?, category = ?, amount = ?, currency = ?, frequency = ?, next_due_date = ?, autopay = ?, payment_source = ?, status = ?, late_fee = ?, grace_days = ?, penalty_note = ?, notes = ?, reminder_offsets = ?, updated_at = datetime(\'now\') ' +
    'WHERE id = ? AND user_id = ?'
  ).bind(
    (b.name as string).trim(), b.kind, (b.category as string).trim(), b.amount,
    (b.currency as string) || 'CAD', b.frequency, b.nextDueDate, (b.autopay as boolean) ? 1 : 0,
    (b.paymentSource as string) || '', b.status, b.lateFee, b.graceDays,
    (b.penaltyNote as string) || '', (b.notes as string) || '',
    JSON.stringify(b.reminderOffsets), id, userId,
  ).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not_found', message: 'Bill not found.' }, 404);
  const row = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').bind(id, userId).first<BillRow>();
  return c.json({ bill: row ? shapeBill(row) : null });
});

app.delete('/api/bills/:id', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid', message: 'Bad bill id.' }, 400);
  await c.env.DB.prepare('DELETE FROM payments WHERE bill_id = ? AND user_id = ?').bind(id, userId).run();
  await c.env.DB.prepare('DELETE FROM reminder_log WHERE bill_id = ? AND user_id = ?').bind(id, userId).run();
  const res = await c.env.DB.prepare('DELETE FROM bills WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not_found', message: 'Bill not found.' }, 404);
  return c.json({ ok: true });
});

// Mark paid: log the payment and advance the next due date for recurring bills.
app.post('/api/bills/:id/pay', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid', message: 'Bad bill id.' }, 400);
  const row = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').bind(id, userId).first<BillRow>();
  if (!row) return c.json({ error: 'not_found', message: 'Bill not found.' }, 404);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const amount = typeof body.amount === 'number' && body.amount >= 0 ? body.amount : row.amount;
  const paidDate = isValidDate(body.paidDate) ? (body.paidDate as string) : todayStr();
  const note = typeof body.note === 'string' ? body.note : '';

  const next = row.frequency === 'one-time' ? null : advanceDueDate(row.next_due_date, row.frequency);
  // If the old due date is far in the past (e.g. a bill paid late), advance
  // from today instead so the next date is in the future.
  let nextDue = next;
  if (next && daysUntil(next) < 0) {
    let candidate = next;
    for (let i = 0; i < 24 && daysUntil(candidate) < 0; i++) {
      const adv = advanceDueDate(candidate, row.frequency);
      if (!adv) break;
      candidate = adv;
    }
    nextDue = candidate;
  }

  await c.env.DB.prepare(
    'INSERT INTO payments (bill_id, user_id, amount, paid_date, note) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, userId, amount, paidDate, note).run();
  if (nextDue) {
    await c.env.DB.prepare(
      'UPDATE bills SET next_due_date = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?'
    ).bind(nextDue, id, userId).run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM bills WHERE id = ? AND user_id = ?').bind(id, userId).first<BillRow>();
  return c.json({ bill: updated ? shapeBill(updated) : null, paid: { amount, paidDate, note } });
});

// ---------------------------------------------------------------------------
// Expenses (one-off spending: groceries, fuel/gas, shoes, clothes,
// medicines, meats, hygiene, toiletries, ...). Separate from recurring bills.
// ---------------------------------------------------------------------------

interface ExpenseRow {
  id: number;
  user_id: string;
  name: string;
  category: string;
  amount: number;
  currency: string;
  expense_date: string;
  payment_source: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

function shapeExpense(row: ExpenseRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    expenseDate: row.expense_date,
    paymentSource: row.payment_source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateExpense(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.length > 120)
    return { ok: false, error: 'name is required (1-120 chars).' };
  if (typeof b.category !== 'string' || b.category.trim().length < 1 || b.category.length > 60)
    return { ok: false, error: 'category is required (1-60 chars).' };
  if (typeof b.amount !== 'number' || b.amount < 0)
    return { ok: false, error: 'amount must be a number >= 0.' };
  if (b.currency !== undefined && typeof b.currency !== 'string')
    return { ok: false, error: 'currency must be a string.' };
  if (!isValidDate(b.expenseDate))
    return { ok: false, error: 'expenseDate must be YYYY-MM-DD.' };
  if (typeof b.paymentSource !== 'string')
    return { ok: false, error: 'paymentSource must be a string.' };
  if (typeof b.notes !== 'string')
    return { ok: false, error: 'notes must be a string.' };
  return { ok: true, value: b };
}

/** First and last day (YYYY-MM-DD) of a YYYY-MM month. */
function monthBounds(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const first = parseDate(`${month}-01`);
  if (Number.isNaN(first.getTime())) return null;
  const nextMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const last = new Date(nextMonth.getTime() - 86400000);
  return { from: `${month}-01`, to: toISODate(last) };
}

// Monthly totals by category. Defined before the list route so the literal
// /summary path is not shadowed.
app.get('/api/expenses/summary', async (c) => {
  const userId = c.get('userId');
  const month = c.req.query('month') || todayStr().slice(0, 7);
  const bounds = monthBounds(month);
  if (!bounds) return c.json({ error: 'invalid', message: 'month must be YYYY-MM.' }, 400);
  const { results } = await c.env.DB.prepare(
    'SELECT category, SUM(amount) AS total, COUNT(*) AS count FROM expenses ' +
    'WHERE user_id = ? AND expense_date >= ? AND expense_date <= ? GROUP BY category ORDER BY total DESC'
  ).bind(userId, bounds.from, bounds.to).all<{ category: string; total: number; count: number }>();
  const byCategory = (results ?? []).map((r) => ({ category: r.category, total: round2(r.total), count: r.count }));
  return c.json({
    month,
    from: bounds.from,
    to: bounds.to,
    total: round2(byCategory.reduce((s, r) => s + r.total, 0)),
    count: byCategory.reduce((s, r) => s + r.count, 0),
    byCategory,
  });
});

app.get('/api/expenses', async (c) => {
  const userId = c.get('userId');
  const category = c.req.query('category') || '';
  const from = c.req.query('from') || '';
  const to = c.req.query('to') || '';
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  let sql = 'SELECT * FROM expenses WHERE user_id = ?';
  const params: unknown[] = [userId];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (isValidDate(from)) { sql += ' AND expense_date >= ?'; params.push(from); }
  if (isValidDate(to)) { sql += ' AND expense_date <= ?'; params.push(to); }
  sql += ' ORDER BY expense_date DESC, id DESC LIMIT ?';
  params.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<ExpenseRow>();
  return c.json({ expenses: (results ?? []).map(shapeExpense) });
});

app.post('/api/expenses', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json().catch(() => null);
  const v = validateExpense(body);
  if (!v.ok) return c.json({ error: 'invalid', message: v.error }, 400);
  const b = v.value;
  const res = await c.env.DB.prepare(
    'INSERT INTO expenses (user_id, name, category, amount, currency, expense_date, payment_source, notes) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    userId, (b.name as string).trim(), (b.category as string).trim(),
    b.amount, (b.currency as string) || 'CAD', b.expenseDate,
    (b.paymentSource as string) || '', (b.notes as string) || '',
  ).run();
  const id = res.meta.last_row_id as number;
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').bind(id, userId).first<ExpenseRow>();
  return c.json({ expense: row ? shapeExpense(row) : null }, 201);
});

app.put('/api/expenses/:id', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid', message: 'Bad expense id.' }, 400);
  const body = await c.req.json().catch(() => null);
  const v = validateExpense(body);
  if (!v.ok) return c.json({ error: 'invalid', message: v.error }, 400);
  const b = v.value;
  const res = await c.env.DB.prepare(
    'UPDATE expenses SET name = ?, category = ?, amount = ?, currency = ?, expense_date = ?, payment_source = ?, notes = ?, updated_at = datetime(\'now\') ' +
    'WHERE id = ? AND user_id = ?'
  ).bind(
    (b.name as string).trim(), (b.category as string).trim(),
    b.amount, (b.currency as string) || 'CAD', b.expenseDate,
    (b.paymentSource as string) || '', (b.notes as string) || '',
    id, userId,
  ).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not_found', message: 'Expense not found.' }, 404);
  const row = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').bind(id, userId).first<ExpenseRow>();
  return c.json({ expense: row ? shapeExpense(row) : null });
});

app.delete('/api/expenses/:id', async (c) => {
  const userId = c.get('userId');
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid', message: 'Bad expense id.' }, 400);
  const res = await c.env.DB.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').bind(id, userId).run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'not_found', message: 'Expense not found.' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Payments, dashboard, timeline, reminders
// ---------------------------------------------------------------------------

app.get('/api/payments', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const { results } = await c.env.DB.prepare(
    'SELECT p.*, b.name AS bill_name FROM payments p JOIN bills b ON b.id = p.bill_id ' +
    'WHERE p.user_id = ? ORDER BY p.paid_date DESC, p.id DESC LIMIT ?'
  ).bind(userId, limit).all<PaymentRow & { bill_name: string }>();
  return c.json({
    payments: (results ?? []).map((p) => ({
      id: p.id, billId: p.bill_id, billName: p.bill_name,
      amount: p.amount, paidDate: p.paid_date, note: p.note, createdAt: p.created_at,
    })),
  });
});

app.get('/api/dashboard', async (c) => {
  const userId = c.get('userId');
  const today = todayStr();
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM bills WHERE user_id = ? AND status = \'active\' ORDER BY next_due_date ASC'
  ).bind(userId).all<BillRow>();
  const bills = (results ?? []).map((r) => shapeBill(r, today));
  const due7 = bills.filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= 7);
  const overdue = bills.filter((b) => b.daysUntilDue < 0);
  return c.json({
    dueNext7Total: round2(due7.reduce((s, b) => s + b.amount, 0)),
    dueNext7Count: due7.length,
    monthlyTotal: round2(bills.reduce((s, b) => s + b.monthlyEquivalent, 0)),
    overdueCount: overdue.length,
    overdueTotal: round2(overdue.reduce((s, b) => s + b.amount, 0)),
    atRiskFees: round2(overdue.reduce((s, b) => s + (b.lateFee || 0), 0)),
    bills,
  });
});

app.get('/api/timeline', async (c) => {
  const userId = c.get('userId');
  const today = todayStr();
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM bills WHERE user_id = ? AND status = \'active\' ORDER BY next_due_date ASC'
  ).bind(userId).all<BillRow>();
  const days: { date: string; total: number; bills: ReturnType<typeof shapeBill>[] }[] = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const due = (results ?? []).map((r) => shapeBill(r, today)).filter((b) => b.nextDueDate === date);
    days.push({ date, total: round2(due.reduce((s, b) => s + b.amount, 0)), bills: due });
  }
  return c.json({ days });
});

function billsNeedingReminder(rows: BillRow[], today = todayStr()) {
  return (rows ?? []).map((r) => shapeBill(r, today)).filter((b) => {
    if (b.status !== 'active') return false;
    if (b.daysUntilDue < 0) return true; // overdue: remind every day
    return b.reminderOffsets.includes(b.daysUntilDue);
  });
}

app.get('/api/reminders', async (c) => {
  const userId = c.get('userId');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM bills WHERE user_id = ? AND status = \'active\''
  ).bind(userId).all<BillRow>();
  return c.json({ reminders: billsNeedingReminder(results ?? []) });
});

// ---------------------------------------------------------------------------
// Privacy policy (public, no auth). Clean URL /privacy serves the static
// privacy.html asset; /privacy.html works directly too.
// ---------------------------------------------------------------------------

app.get('/privacy', async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/privacy.html', c.req.url)));
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// ---------------------------------------------------------------------------
// Static frontend fallback (Workers Static Assets)
// ---------------------------------------------------------------------------

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json({ error: 'not_found', message: 'Unknown API endpoint.' }, 404);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404 && (c.req.header('Accept') ?? '').includes('text/html')) {
    return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  }
  return res;
});

// ---------------------------------------------------------------------------
// Scheduled daily reminder check (cron). Computes due reminders for every
// user and logs them so the frontend can surface them and a future email/push
// step has a reliable source. Does not send mail itself.
// ---------------------------------------------------------------------------

async function runReminderCheck(env: Env): Promise<{ users: number; reminders: number }> {
  const today = todayStr();
  const users = await env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
  let total = 0;
  for (const u of users.results ?? []) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM bills WHERE user_id = ? AND status = \'active\''
    ).bind(u.id).all<BillRow>();
    for (const b of billsNeedingReminder(results ?? [], today)) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO reminder_log (user_id, bill_id, reminder_date, days_until_due) VALUES (?, ?, ?, ?)'
      ).bind(u.id, b.id, today, b.daysUntilDue).run();
      total++;
    }
  }
  return { users: users.results?.length ?? 0, reminders: total };
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminderCheck(env));
  },
};
