-- Bills Dashboard (public, multi-user) — D1 schema
-- Users are identified by their Clerk user id (user_...). Every bill, payment
-- and setting row carries a user_id, and every query is scoped to it, so a
-- user can only ever see or touch their own data.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- Clerk user id, e.g. user_2abc...
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bill', 'subscription')),
  category TEXT NOT NULL DEFAULT 'General',
  amount REAL NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'CAD',
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'one-time')),
  next_due_date TEXT NOT NULL,      -- YYYY-MM-DD
  autopay INTEGER NOT NULL DEFAULT 0,
  payment_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  late_fee REAL NOT NULL DEFAULT 0,
  grace_days INTEGER NOT NULL DEFAULT 0,
  penalty_note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  reminder_offsets TEXT NOT NULL DEFAULT '[7,1]',  -- JSON array of days-before-due
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_user_due ON bills(user_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_bills_user_status ON bills(user_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  paid_date TEXT NOT NULL,          -- YYYY-MM-DD
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, paid_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id, paid_date DESC);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  reminder_offsets TEXT NOT NULL DEFAULT '[14,7,3,1,0]',
  notify_in_app INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Log of the daily reminder check (one row per bill reminded, per day).
-- Lets the app show "reminded" state and gives a future email/push step a
-- reliable source of what is due.
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  bill_id INTEGER NOT NULL REFERENCES bills(id),
  reminder_date TEXT NOT NULL,      -- YYYY-MM-DD the reminder was computed
  days_until_due INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, bill_id, reminder_date)
);
CREATE INDEX IF NOT EXISTS idx_reminder_log_user ON reminder_log(user_id, reminder_date DESC);
