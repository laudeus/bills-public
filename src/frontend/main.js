/**
 * Bills Dashboard — public frontend (vanilla JS, bundled with esbuild).
 *
 * Auth: Clerk (Google, GitHub, Microsoft, Apple, email+password). The Clerk
 * publishable key comes from GET /api/config at runtime; if Clerk is not
 * configured the app shows a setup message instead of the dashboard.
 * API: all calls carry `Authorization: Bearer <clerk session token>`.
 */

import { Clerk } from '@clerk/clerk-js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtMoney = (n, currency = 'CAD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);

const todayStr = () => new Date().toISOString().slice(0, 10);

function daysUntil(dueDate) {
  const ms = new Date(dueDate + 'T00:00:00Z') - new Date(todayStr() + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

function urgencyLabel(days) {
  if (days < 0) return { text: `Overdue ${-days}d`, cls: 'overdue' };
  if (days === 0) return { text: 'Due today', cls: 'today' };
  if (days === 1) return { text: 'Due tomorrow', cls: 'soon' };
  if (days <= 7) return { text: `Due in ${days}d`, cls: 'soon' };
  return { text: `Due in ${days}d`, cls: 'later' };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  clerk: null,
  token: null,
  user: null,
  bills: [],
  payments: [],
  dashboard: null,
  timeline: [],
  reminders: [],
  settings: { reminderOffsets: [14, 7, 3, 1, 0], notifyInApp: true },
  filter: 'all', // all | due | overdue | subscriptions | bills
  editingId: null,
  expenses: [],
  expenseSummary: null,
  expenseMonth: new Date().toISOString().slice(0, 7), // YYYY-MM
  expenseCategory: 'all',
};

// Suggested expense categories (the input also accepts any custom category).
const EXPENSE_CATEGORIES = [
  'Groceries', 'Fuel/Gas', 'Shoes', 'Clothes', 'Medicines', 'Meats',
  'Hygiene', 'Toiletries', 'Dining', 'Transport', 'Auto Maintenance',
  'Entertainment', 'Household', 'Other',
];

function monthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function shiftMonth(yyyyMm, delta) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const first = `${yyyyMm}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const last = new Date(next.getTime() - 86400000);
  return { from: first, to: last.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function refreshToken() {
  if (state.clerk?.session) {
    state.token = await state.clerk.session.getToken();
  }
}

// ---------------------------------------------------------------------------
// Boot / Clerk
// ---------------------------------------------------------------------------

async function loadClerk(publishableKey) {
  // Derive the Clerk Frontend API domain from the publishable key.
  const clerkDomain = atob(publishableKey.split('_')[2]).slice(0, -1);
  // Load the Clerk UI bundle.
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Clerk UI bundle'));
    document.head.appendChild(script);
  });
  const clerk = new Clerk(publishableKey);
  await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  return clerk;
}

// Facebook's in-app browser (WebView) does not send the Origin header
// Clerk's production key requires, so sign-in fails there with a scary
// error. Detect it and show a friendly "open in a real browser" message
// instead of letting Clerk fail.
function isFacebookWebView() {
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV/.test(ua);
}

async function boot() {
  const root = $('#app');
  if (isFacebookWebView()) {
    root.innerHTML = `
      <div class="setup-card">
        <h1>Bills Dashboard</h1>
        <p>You're viewing this inside Facebook's browser, and sign-in doesn't work there — Facebook's browser doesn't send the info our sign-in provider needs.</p>
        <p>Please open this page in your usual browser instead:</p>
        <p><a class="btn primary" href="intent://bills.laudeus.org/#Intent;scheme=https;S.browser_fallback_url=https%3A%2F%2Fbills.laudeus.org%2F;end">Open in your browser</a></p>
        <p>Or tap the <strong>&#8942;</strong> menu in the top right of this browser and choose <strong>Open in browser</strong>.</p>
        <p>The app itself is fine — it works normally in your browser.</p>
      </div>`;
    return;
  }
  try {
    const config = await (await fetch('/api/config')).json();
    if (!config.configured || !config.clerkPublishableKey) {
      root.innerHTML = `
        <div class="setup-card">
          <h1>Bills Dashboard</h1>
          <p>Sign-in is not configured on this deployment yet. The site owner needs to add the Clerk API keys (see the deployment guide), then sign-up and Google sign-in will appear here.</p>
        </div>`;
      return;
    }
    state.clerk = await loadClerk(config.clerkPublishableKey);
    await refreshToken();
    if (state.clerk.isSignedIn) {
      state.user = state.clerk.user;
      await loadAll();
      renderApp();
    } else {
      renderAuth();
    }
    // Re-render when auth state changes (e.g. after sign-in completes).
    state.clerk.addListener(async ({ session }) => {
      if (session) {
        await refreshToken();
        state.user = state.clerk.user;
        await loadAll();
        renderApp();
      } else {
        state.token = null;
        state.user = null;
        renderAuth();
      }
    });
  } catch (err) {
    root.innerHTML = `
      <div class="setup-card">
        <h1>Bills Dashboard</h1>
        <p>Something went wrong loading the app: ${esc(err.message)}</p>
        <p>Try reloading the page. If it keeps happening, the site owner may need to check the deployment.</p>
      </div>`;
  }
}

// ---------------------------------------------------------------------------
// Auth view
// ---------------------------------------------------------------------------

let authMode = 'sign-in';

function renderAuth() {
  const root = $('#app');
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Bills Dashboard</h1>
        <p class="tagline">Track every bill and subscription in one place. Sign up free — your bills stay private to your account.</p>
        <div class="auth-tabs">
          <button class="auth-tab ${authMode === 'sign-in' ? 'active' : ''}" data-mode="sign-in">Sign in</button>
          <button class="auth-tab ${authMode === 'sign-up' ? 'active' : ''}" data-mode="sign-up">Sign up</button>
        </div>
        <div id="clerk-mount"></div>
        <p class="auth-note">You can sign up with email and a password, or with Google, GitHub, Microsoft or Apple.</p>
      </div>
    </div>`;
  $$('.auth-tab', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      authMode = btn.dataset.mode;
      renderAuth();
    });
  });
  const mount = $('#clerk-mount');
  if (authMode === 'sign-in') state.clerk.mountSignIn(mount);
  else state.clerk.mountSignUp(mount);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAll() {
  const [bills, dashboard, timeline, reminders, payments, settings] = await Promise.all([
    api('/api/bills'),
    api('/api/dashboard'),
    api('/api/timeline'),
    api('/api/reminders'),
    api('/api/payments?limit=20'),
    api('/api/settings'),
  ]);
  state.bills = bills.bills;
  state.dashboard = dashboard;
  state.timeline = timeline.days;
  state.reminders = reminders.reminders;
  state.payments = payments.payments;
  state.settings = settings;
  await loadExpenses();
}

async function loadExpenses() {
  const { from, to } = monthBounds(state.expenseMonth);
  const [expenses, summary] = await Promise.all([
    api(`/api/expenses?from=${from}&to=${to}&limit=500`),
    api(`/api/expenses/summary?month=${state.expenseMonth}`),
  ]);
  state.expenses = expenses.expenses;
  state.expenseSummary = summary;
}

// ---------------------------------------------------------------------------
// Dashboard render
// ---------------------------------------------------------------------------

function billCard(b) {
  const u = urgencyLabel(b.daysUntilDue);
  const due = new Date(b.nextDueDate + 'T00:00:00Z').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  return `
    <article class="bill-card ${u.cls}">
      <div class="bill-top">
        <div>
          <h3>${esc(b.name)}</h3>
          <div class="bill-meta">${esc(b.category)} · ${esc(b.kind)} · ${esc(b.frequency)}${b.autopay ? ' · autopay' : ''}</div>
        </div>
        <div class="bill-amount">${fmtMoney(b.amount, b.currency)}</div>
      </div>
      <div class="bill-mid">
        <span class="pill ${u.cls}">${esc(u.text)}</span>
        <span class="due-date" data-bill-id="${b.id}" title="Tap to change due date">📅 ${esc(due)}</span>
        <span class="bill-source">${esc(b.paymentSource || '')}</span>
      </div>
      ${b.penaltyNote || b.lateFee ? `<div class="bill-fees">${b.lateFee ? `Late fee ${fmtMoney(b.lateFee, b.currency)}` : ''}${b.lateFee && b.penaltyNote ? ' · ' : ''}${esc(b.penaltyNote || '')}${b.graceDays ? ` · ${b.graceDays}d grace` : ''}</div>` : ''}
      ${b.notes ? `<div class="bill-notes">${esc(b.notes)}</div>` : ''}
      <div class="bill-actions">
        <button class="btn primary" data-pay="${b.id}">Mark paid</button>
        <button class="btn" data-edit="${b.id}">Edit</button>
        <button class="btn danger" data-delete="${b.id}">Delete</button>
      </div>
    </article>`;
}

function renderApp() {
  const root = $('#app');
  const d = state.dashboard || {};
  const name = state.user?.firstName || state.user?.username || state.user?.primaryEmailAddress?.emailAddress || 'there';
  const filtered = state.bills.filter((b) => {
    if (state.filter === 'due') return b.daysUntilDue >= 0 && b.daysUntilDue <= 7;
    if (state.filter === 'overdue') return b.daysUntilDue < 0;
    if (state.filter === 'subscriptions') return b.kind === 'subscription';
    if (state.filter === 'bills') return b.kind === 'bill';
    return true;
  });

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">Bills Dashboard</div>
      <div class="topbar-right">
        <span class="hello">Hi, ${esc(name)}</span>
        <div id="user-button"></div>
        <button class="btn small" id="sign-out">Sign out</button>
      </div>
    </header>

    <main class="dashboard">
      <section class="hero">
        <div class="stat"><div class="stat-label">Due in next 7 days</div><div class="stat-value">${fmtMoney(d.dueNext7Total ?? 0)}</div><div class="stat-sub">${d.dueNext7Count ?? 0} bill(s)</div></div>
        <div class="stat"><div class="stat-label">Monthly total</div><div class="stat-value">${fmtMoney(d.monthlyTotal ?? 0)}</div><div class="stat-sub">across all active bills</div></div>
        <div class="stat ${d.overdueCount ? 'alert' : ''}"><div class="stat-label">Overdue</div><div class="stat-value">${d.overdueCount ?? 0}</div><div class="stat-sub">${fmtMoney(d.overdueTotal ?? 0)} outstanding</div></div>
        <div class="stat ${d.atRiskFees ? 'alert' : ''}"><div class="stat-label">At-risk late fees</div><div class="stat-value">${fmtMoney(d.atRiskFees ?? 0)}</div><div class="stat-sub">on overdue bills</div></div>
      </section>

      ${state.reminders.length ? `
      <section class="reminders">
        <h2>🔔 Reminders for today</h2>
        <ul>
          ${state.reminders.map((b) => {
            const u = urgencyLabel(b.daysUntilDue);
            return `<li><strong>${esc(b.name)}</strong> — ${fmtMoney(b.amount, b.currency)} · ${esc(u.text)}${b.autopay ? ' · autopay' : ''}</li>`;
          }).join('')}
        </ul>
      </section>` : ''}

      <section class="timeline">
        <h2>Next 14 days</h2>
        <div class="timeline-row">
          ${state.timeline.map((day) => {
            const label = new Date(day.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
            return `<div class="timeline-day ${day.total > 0 ? 'has-bills' : ''}">
              <div class="tl-date">${esc(label)}</div>
              <div class="tl-total">${day.total > 0 ? fmtMoney(day.total) : '—'}</div>
              <div class="tl-names">${day.bills.map((b) => esc(b.name)).join(', ')}</div>
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="bills">
        <div class="bills-head">
          <h2>Your bills &amp; subscriptions</h2>
          <button class="btn primary" id="add-bill">+ Add a bill</button>
        </div>
        <div class="filters">
          ${[['all', 'All'], ['due', 'Due soon'], ['overdue', 'Overdue'], ['bills', 'Bills'], ['subscriptions', 'Subscriptions']].map(([k, label]) =>
            `<button class="pill filter ${state.filter === k ? 'active' : ''}" data-filter="${k}">${label}</button>`).join('')}
        </div>
        <div class="quick-add">
          ${['Rent', 'Allstate', 'Enbridge', 'Internet', 'Phone'].map((n) =>
            `<button class="chip" data-quick="${n}">+ ${n}</button>`).join('')}
        </div>
        <div class="bill-list">
          ${filtered.length ? filtered.map(billCard).join('') : '<p class="empty">No bills yet. Add your first one above — the quick-add chips pre-fill the form.</p>'}
        </div>
      </section>

      <section class="expenses">
        <div class="bills-head">
          <h2>Expenses</h2>
          <div class="exp-month-nav">
            <button class="btn small" id="exp-prev" title="Previous month">‹</button>
            <span class="exp-month-label">${esc(monthLabel(state.expenseMonth))}</span>
            <button class="btn small" id="exp-next" title="Next month">›</button>
            <button class="btn primary" id="add-expense">+ Add an expense</button>
          </div>
        </div>
        ${(() => {
          const s = state.expenseSummary || {};
          const cats = (s.byCategory || []).map((r) => r.category);
          const shown = state.expenses.filter((e) => state.expenseCategory === 'all' || e.category === state.expenseCategory);
          return `
          <div class="exp-summary">
            <div class="stat"><div class="stat-label">Spent this month</div><div class="stat-value">${fmtMoney(s.total ?? 0)}</div><div class="stat-sub">${s.count ?? 0} expense(s)</div></div>
            <div class="exp-breakdown">
              ${(s.byCategory || []).length ? (s.byCategory || []).map((r) => `
                <button class="pill ${state.expenseCategory === r.category ? 'active' : ''}" data-exp-cat="${esc(r.category)}">${esc(r.category)} · ${fmtMoney(r.total)} (${r.count})</button>`).join('') : '<span class="empty">No expenses this month yet.</span>'}
            </div>
          </div>
          <div class="filters">
            <button class="pill filter ${state.expenseCategory === 'all' ? 'active' : ''}" data-exp-cat="all">All categories</button>
            ${cats.filter((c) => !EXPENSE_CATEGORIES.includes(c)).map((c) => `
              <button class="pill filter ${state.expenseCategory === c ? 'active' : ''}" data-exp-cat="${esc(c)}">${esc(c)}</button>`).join('')}
          </div>
          <div class="bill-list">
            ${shown.length ? shown.map((e) => {
              const when = new Date(e.expenseDate + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
              return `
              <article class="bill-card">
                <div class="bill-top">
                  <div>
                    <h3>${esc(e.name)}</h3>
                    <div class="bill-meta">${esc(e.category)} · ${esc(when)}${e.paymentSource ? ` · ${esc(e.paymentSource)}` : ''}</div>
                  </div>
                  <div class="bill-amount">${fmtMoney(e.amount, e.currency)}</div>
                </div>
                ${e.notes ? `<div class="bill-notes">${esc(e.notes)}</div>` : ''}
                <div class="bill-actions">
                  <button class="btn" data-exp-edit="${e.id}">Edit</button>
                  <button class="btn danger" data-exp-delete="${e.id}">Delete</button>
                </div>
              </article>`;
            }).join('') : '<p class="empty">No expenses in this view. Add one above.</p>'}
          </div>`;
        })()}
      </section>

      <section class="history">
        <h2>Recent payments</h2>
        ${state.payments.length ? `<ul class="payments">
          ${state.payments.map((p) => `<li><strong>${esc(p.billName)}</strong> — ${fmtMoney(p.amount)} · ${esc(p.paidDate)}${p.note ? ` · ${esc(p.note)}` : ''}</li>`).join('')}
        </ul>` : '<p class="empty">No payments logged yet. Marking a bill paid records it here.</p>'}
        <div class="settings-link"><button class="btn" id="open-settings">Reminder settings</button></div>
      </section>
    </main>

    <div id="modal-root"></div>
  `;

  // User button + sign out
  const ub = $('#user-button');
  if (ub && state.clerk) state.clerk.mountUserButton(ub);
  $('#sign-out').addEventListener('click', () => state.clerk.signOut());

  // Filters
  $$('[data-filter]').forEach((btn) => btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    renderApp();
  }));

  // Quick add
  $$('[data-quick]').forEach((btn) => btn.addEventListener('click', () => openBillForm({ name: btn.dataset.quick })));

  $('#add-bill').addEventListener('click', () => openBillForm());
  $('#open-settings').addEventListener('click', openSettings);

  // Bill actions (event delegation)
  $$('[data-pay]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api(`/api/bills/${btn.dataset.pay}/pay`, { method: 'POST', body: {} });
      await loadAll();
      renderApp();
    } catch (e) { alert(e.message); btn.disabled = false; }
  }));
  $$('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const b = state.bills.find((x) => x.id === Number(btn.dataset.edit));
    if (b) openBillForm(b);
  }));
  $$('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const b = state.bills.find((x) => x.id === Number(btn.dataset.delete));
    if (!b || !confirm(`Delete "${b.name}" and its payment history?`)) return;
    try {
      await api(`/api/bills/${b.id}`, { method: 'DELETE' });
      await loadAll();
      renderApp();
    } catch (e) { alert(e.message); }
  }));
  // Tap a due date to edit that bill (calendar ready).
  $$('.due-date').forEach((el) => el.addEventListener('click', () => {
    const b = state.bills.find((x) => x.id === Number(el.dataset.billId));
    if (b) openBillForm(b);
  }));

  // Expenses: month navigation, category filter, add/edit/delete.
  $('#exp-prev').addEventListener('click', async () => {
    state.expenseMonth = shiftMonth(state.expenseMonth, -1);
    state.expenseCategory = 'all';
    await loadExpenses();
    renderApp();
  });
  $('#exp-next').addEventListener('click', async () => {
    state.expenseMonth = shiftMonth(state.expenseMonth, 1);
    state.expenseCategory = 'all';
    await loadExpenses();
    renderApp();
  });
  $$('[data-exp-cat]').forEach((btn) => btn.addEventListener('click', () => {
    state.expenseCategory = btn.dataset.expCat;
    renderApp();
  }));
  $('#add-expense').addEventListener('click', () => openExpenseForm());
  $$('[data-exp-edit]').forEach((btn) => btn.addEventListener('click', () => {
    const e = state.expenses.find((x) => x.id === Number(btn.dataset.expEdit));
    if (e) openExpenseForm(e);
  }));
  $$('[data-exp-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const e = state.expenses.find((x) => x.id === Number(btn.dataset.expDelete));
    if (!e || !confirm(`Delete expense "${e.name}" (${fmtMoney(e.amount, e.currency)})?`)) return;
    try {
      await api(`/api/expenses/${e.id}`, { method: 'DELETE' });
      await loadExpenses();
      renderApp();
    } catch (err) { alert(err.message); }
  }));
}

// ---------------------------------------------------------------------------
// Bill form (add / edit) — native date inputs give the calendar popup.
// ---------------------------------------------------------------------------

const QUICK_DEFAULTS = {
  Rent: { kind: 'bill', category: 'Housing', frequency: 'monthly', amount: 0 },
  Allstate: { kind: 'bill', category: 'Insurance', frequency: 'monthly', amount: 0 },
  Enbridge: { kind: 'bill', category: 'Utilities', frequency: 'monthly', amount: 0 },
  Internet: { kind: 'subscription', category: 'Utilities', frequency: 'monthly', amount: 0 },
  Phone: { kind: 'subscription', category: 'Utilities', frequency: 'monthly', amount: 0 },
};

function openBillForm(existing = null) {
  const isEdit = Boolean(existing && existing.id);
  // Quick-add passes { name: 'Rent' } with no id; edit passes a full bill.
  const quick = !isEdit && existing?.name ? QUICK_DEFAULTS[existing.name] : null;
  const b = isEdit ? existing : {
    name: existing?.name || '',
    kind: quick?.kind || 'bill',
    category: quick?.category || 'General',
    amount: quick?.amount ?? 0,
    currency: 'CAD',
    frequency: quick?.frequency || 'monthly',
    nextDueDate: todayStr(),
    autopay: false,
    paymentSource: '',
    status: 'active',
    lateFee: 0,
    graceDays: 0,
    penaltyNote: '',
    notes: '',
    reminderOffsets: [...state.settings.reminderOffsets],
  };

  const offsets = new Set(b.reminderOffsets);
  const modal = $('#modal-root');
  modal.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <form class="modal" id="bill-form">
        <h2>${isEdit ? 'Edit bill' : 'Add a bill'}</h2>
        <label>Name <input name="name" required maxlength="120" value="${esc(b.name)}"></label>
        <div class="form-row">
          <label>Type
            <select name="kind">
              <option value="bill" ${b.kind === 'bill' ? 'selected' : ''}>Bill</option>
              <option value="subscription" ${b.kind === 'subscription' ? 'selected' : ''}>Subscription</option>
            </select>
          </label>
          <label>Category <input name="category" required maxlength="60" value="${esc(b.category)}"></label>
        </div>
        <div class="form-row">
          <label>Amount <input name="amount" type="number" min="0" step="0.01" required value="${b.amount}"></label>
          <label>Currency <input name="currency" maxlength="3" value="${esc(b.currency)}"></label>
          <label>Frequency
            <select name="frequency">
              ${['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'one-time'].map((f) =>
                `<option ${b.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}
            </select>
          </label>
        </div>
        <label>Next due date
          <span class="date-field">
            <input name="nextDueDate" type="date" required value="${esc(b.nextDueDate)}">
            <button type="button" class="btn small" id="due-date-cal" title="Open calendar">📅</button>
          </span>
        </label>
        <div class="form-row">
          <label>Payment source <input name="paymentSource" maxlength="120" value="${esc(b.paymentSource)}" placeholder="e.g. CIBC *8490"></label>
          <label class="check"><input name="autopay" type="checkbox" ${b.autopay ? 'checked' : ''}> Autopay</label>
          <label>Status
            <select name="status">
              <option value="active" ${b.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="paused" ${b.status === 'paused' ? 'selected' : ''}>Paused</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label>Late fee <input name="lateFee" type="number" min="0" step="0.01" value="${b.lateFee}"></label>
          <label>Grace days <input name="graceDays" type="number" min="0" max="90" step="1" value="${b.graceDays}"></label>
        </div>
        <label>Penalty note <input name="penaltyNote" maxlength="500" value="${esc(b.penaltyNote)}" placeholder="e.g. $50 declined-payment fee"></label>
        <label>Notes <textarea name="notes" maxlength="1000" rows="2">${esc(b.notes)}</textarea></label>

        <fieldset class="reminders-field">
          <legend>Remind me</legend>
          <div class="offset-chips">
            ${[14, 7, 3, 1].map((n) => `
              <label class="chip-check"><input type="checkbox" data-offset="${n}" ${offsets.has(n) ? 'checked' : ''}> ${n} days before</label>`).join('')}
            <label class="chip-check"><input type="checkbox" data-offset="0" ${offsets.has(0) ? 'checked' : ''}> Day of</label>
          </div>
          <div class="specific-date">
            <button type="button" class="btn small" id="specific-date-btn">📅 Specific date</button>
            <input type="date" id="specific-date" hidden>
            <span id="specific-date-label" class="specific-label"></span>
          </div>
          <p class="hint">Pick a specific calendar date and it is saved as the matching days-before-due. Reminders also fire every day once a bill is overdue.</p>
        </fieldset>

        <div class="modal-actions">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">${isEdit ? 'Save changes' : 'Add bill'}</button>
        </div>
        <p class="form-error" id="form-error" hidden></p>
      </form>
    </div>`;

  const form = $('#bill-form');
  const errorEl = $('#form-error');

  // Calendar button focuses/opens the native date picker.
  $('#due-date-cal').addEventListener('click', () => {
    const input = form.elements.nextDueDate;
    if (input.showPicker) input.showPicker();
    else input.focus();
  });

  // Specific reminder date: reveal the date input; on pick, convert to an offset.
  const specBtn = $('#specific-date-btn');
  const specInput = $('#specific-date');
  const specLabel = $('#specific-date-label');
  specBtn.addEventListener('click', () => {
    specInput.hidden = false;
    if (specInput.showPicker) specInput.showPicker();
    else specInput.focus();
  });
  specInput.addEventListener('change', () => {
    const due = form.elements.nextDueDate.value;
    if (!due || !specInput.value) return;
    // Offset = days between the chosen reminder date and the due date.
    const offset = Math.round((new Date(due + 'T00:00:00Z') - new Date(specInput.value + 'T00:00:00Z')) / 86400000);
    if (offset < 0 || offset > 30) {
      specLabel.textContent = 'Pick a date on or before the due date (within 30 days).';
      specInput.value = '';
      return;
    }
    // Tick the matching offset chip if it is one of the standard ones; otherwise
    // remember it as an extra offset.
    const chip = form.querySelector(`[data-offset="${offset}"]`);
    if (chip) chip.checked = true;
    else form.dataset.extraOffset = String(offset);
    specLabel.textContent = `Reminder set for ${specInput.value} (${offset} day${offset === 1 ? '' : 's'} before due)`;
  });

  $('#modal-cancel').addEventListener('click', () => { modal.innerHTML = ''; });
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') modal.innerHTML = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const fd = new FormData(form);
    const offs = new Set(
      $$('[data-offset]', form).filter((c) => c.checked).map((c) => Number(c.dataset.offset))
    );
    if (form.dataset.extraOffset !== undefined) offs.add(Number(form.dataset.extraOffset));
    const payload = {
      name: fd.get('name').trim(),
      kind: fd.get('kind'),
      category: fd.get('category').trim() || 'General',
      amount: Number(fd.get('amount')),
      currency: (fd.get('currency') || 'CAD').trim().toUpperCase() || 'CAD',
      frequency: fd.get('frequency'),
      nextDueDate: fd.get('nextDueDate'),
      autopay: fd.get('autopay') === 'on',
      paymentSource: (fd.get('paymentSource') || '').trim(),
      status: fd.get('status'),
      lateFee: Number(fd.get('lateFee')) || 0,
      graceDays: Number(fd.get('graceDays')) || 0,
      penaltyNote: (fd.get('penaltyNote') || '').trim(),
      notes: (fd.get('notes') || '').trim(),
      reminderOffsets: [...offs].sort((a, b) => b - a),
    };
    try {
      if (isEdit) await api(`/api/bills/${existing.id}`, { method: 'PUT', body: payload });
      else await api('/api/bills', { method: 'POST', body: payload });
      modal.innerHTML = '';
      await loadAll();
      renderApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Expense form (add / edit) — one-off spending.
// ---------------------------------------------------------------------------

function openExpenseForm(existing = null) {
  const isEdit = Boolean(existing && existing.id);
  const e = isEdit ? existing : {
    name: '',
    category: 'Groceries',
    amount: 0,
    currency: 'CAD',
    expenseDate: todayStr(),
    paymentSource: '',
    notes: '',
  };

  const modal = $('#modal-root');
  modal.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <form class="modal" id="expense-form">
        <h2>${isEdit ? 'Edit expense' : 'Add an expense'}</h2>
        <label>Name <input name="name" required maxlength="120" value="${esc(e.name)}" placeholder="e.g. Weekly groceries"></label>
        <div class="form-row">
          <label>Category
            <input name="category" required maxlength="60" list="expense-categories" value="${esc(e.category)}" placeholder="Pick or type a category">
            <datalist id="expense-categories">
              ${EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c)}">`).join('')}
            </datalist>
          </label>
          <label>Date
            <span class="date-field">
              <input name="expenseDate" type="date" required value="${esc(e.expenseDate)}">
              <button type="button" class="btn small" id="exp-date-cal" title="Open calendar">📅</button>
            </span>
          </label>
        </div>
        <div class="form-row">
          <label>Amount <input name="amount" type="number" min="0" step="0.01" required value="${e.amount}"></label>
          <label>Currency <input name="currency" maxlength="3" value="${esc(e.currency)}"></label>
        </div>
        <label>Payment source <input name="paymentSource" maxlength="120" value="${esc(e.paymentSource)}" placeholder="e.g. CIBC *8490, cash"></label>
        <label>Notes <textarea name="notes" maxlength="1000" rows="2">${esc(e.notes)}</textarea></label>
        <div class="modal-actions">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">${isEdit ? 'Save changes' : 'Add expense'}</button>
        </div>
        <p class="form-error" id="form-error" hidden></p>
      </form>
    </div>`;

  const form = $('#expense-form');
  const errorEl = $('#form-error');

  $('#exp-date-cal').addEventListener('click', () => {
    const input = form.elements.expenseDate;
    if (input.showPicker) input.showPicker();
    else input.focus();
  });
  $('#modal-cancel').addEventListener('click', () => { modal.innerHTML = ''; });
  $('#modal-backdrop').addEventListener('click', (ev) => {
    if (ev.target.id === 'modal-backdrop') modal.innerHTML = '';
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    const fd = new FormData(form);
    const payload = {
      name: fd.get('name').trim(),
      category: fd.get('category').trim() || 'Other',
      amount: Number(fd.get('amount')),
      currency: (fd.get('currency') || 'CAD').trim().toUpperCase() || 'CAD',
      expenseDate: fd.get('expenseDate'),
      paymentSource: (fd.get('paymentSource') || '').trim(),
      notes: (fd.get('notes') || '').trim(),
    };
    try {
      if (isEdit) await api(`/api/expenses/${existing.id}`, { method: 'PUT', body: payload });
      else await api('/api/expenses', { method: 'POST', body: payload });
      modal.innerHTML = '';
      // If the saved date falls outside the month being viewed, jump to its month.
      const savedMonth = payload.expenseDate.slice(0, 7);
      if (savedMonth !== state.expenseMonth) state.expenseMonth = savedMonth;
      state.expenseCategory = 'all';
      await loadExpenses();
      renderApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function openSettings() {
  const modal = $('#modal-root');
  const offs = new Set(state.settings.reminderOffsets);
  modal.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <form class="modal" id="settings-form">
        <h2>Reminder settings</h2>
        <p class="hint">Default reminder offsets for new bills. Existing bills keep their own offsets (change them in Edit).</p>
        <div class="offset-chips">
          ${[14, 7, 3, 1, 0].map((n) => `
            <label class="chip-check"><input type="checkbox" data-offset="${n}" ${offs.has(n) ? 'checked' : ''}> ${n === 0 ? 'Day of' : n + ' days before'}</label>`).join('')}
        </div>
        <label class="check"><input type="checkbox" name="notifyInApp" ${state.settings.notifyInApp ? 'checked' : ''}> Show due reminders in the app (daily check)</label>
        <div class="modal-actions">
          <button type="button" class="btn" id="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save settings</button>
        </div>
        <p class="form-error" id="form-error" hidden></p>
      </form>
    </div>`;
  $('#modal-cancel').addEventListener('click', () => { modal.innerHTML = ''; });
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') modal.innerHTML = '';
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const selected = $$('[data-offset]', form).filter((c) => c.checked).map((c) => Number(c.dataset.offset));
    try {
      const saved = await api('/api/settings', {
        method: 'PUT',
        body: { reminderOffsets: selected.sort((a, b) => b - a), notifyInApp: form.elements.notifyInApp.checked },
      });
      state.settings = saved;
      modal.innerHTML = '';
      await loadAll();
      renderApp();
    } catch (err) {
      const el = $('#form-error');
      el.textContent = err.message;
      el.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------

boot();
