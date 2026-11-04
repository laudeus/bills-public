# Bills Dashboard — Public, Multi-User Version

A public web app at **https://bills.laudeus.org** where family members sign up
and track their own bills and subscriptions privately. Each user only ever
sees and edits their own bills.

The personal, single-user Bills Dashboard (the Muse artifact) is untouched —
this is a separate codebase that lives on Cloudflare.

## What it does

- **Sign-up / sign-in** with email + password, or with Google, GitHub,
  Microsoft or Apple (single sign-on via Clerk).
- **Per-user private data** — every bill, payment and setting is scoped to the
  signed-in user (Clerk user id) in the database.
- **Bills & subscriptions**: name, type (bill/subscription), category, amount,
  currency, frequency (weekly / biweekly / monthly / quarterly / yearly /
  one-time), next due date, autopay, payment source, status (active/paused),
  late fee, grace days, penalty note, notes, reminder offsets.
- **Calendar date pickers** for the due date and for a specific reminder date
  (native `<input type="date">` — taps open the calendar on phones).
- **Mark Paid** logs the payment and auto-advances the next due date for
  recurring bills (month-end aware: Jan 31 → Feb 28).
- **Dashboard**: due in the next 7 days, monthly total, overdue count/total,
  at-risk late fees, a 14-day timeline of when money leaves, and recent
  payment history.
- **Reminders**: per-bill reminder offsets (14/7/3/1/day-of, or a specific
  calendar date) plus a daily 09:00 check that surfaces due reminders in the
  app. Overdue bills remind every day until paid.

## Architecture

```
Browser (bills.laudeus.org)
  └─ Static frontend (public/index.html + app.js + styles.css)
       served by Workers Static Assets
  └─ ClerkJS (sign-in / sign-up / Google, GitHub, Microsoft, Apple SSO)
       → Clerk session JWT (Bearer token)
  └─ Cloudflare Worker (Hono, src/index.ts)
       → verifies the Clerk JWT on every /api call
       → Cloudflare D1 (SQLite) — users, bills, payments, settings, reminder_log
  └─ Cron trigger daily 09:00 EST — computes due reminders into reminder_log
```

### Decision: database — Cloudflare D1

D1 was chosen over the alternatives:

| Store | Verdict |
|---|---|
| **D1 (SQLite)** | **Chosen.** Structured, relational data — exactly what bills are. SQL makes "my bills due in 7 days" and "monthly total" trivial. Lives in the same Cloudflare account as the Worker, free tier is generous (5 GB, 25M reads/day, 50k writes/day), and migrations are versioned in this repo. |
| KV | Key-value only — no relational queries, no "list bills due soon" without scanning everything. Wrong shape for a ledger. |
| Durable Objects | Single-instance stateful objects — built for coordination (chat rooms, live state), not for per-user rows at rest. Overkill and the wrong data model. |
| External DB (Neon / Supabase / PlanetScale) | Adds a second vendor, network latency, another bill and another credential to manage. No benefit for a family app when D1 is already in the account. |

### Decision: auth — Clerk

Clerk was chosen over hand-rolled OAuth and over Auth0:

| Approach | Verdict |
|---|---|
| **Clerk** | **Chosen.** One SDK covers email+password, Google, GitHub, Microsoft and Apple. It manages sessions, email verification and password reset, and its `@clerk/backend` package is built for Cloudflare Workers (V8 isolates) with `verifyToken()`. Free tier covers 10,000 monthly active users — far above a family. The Worker verifies each session JWT with `authorizedParties` set to the app origin (CSRF defence). |
| Hand-rolled OAuth (Google + GitHub + Apple, direct) | No third-party dependency, but it means writing and maintaining OAuth flows, PKCE, state, session cookies, password hashing, email verification and password reset by hand — for three separate providers. That is exactly the code you do not want to own in a family app. |
| Auth0 | Similar to Clerk, but its Workers integration is less first-class and its free tier is smaller (7,000 MAU). |
| Cloudflare Access | An access gate for a fixed allowlist, not a public self-serve sign-up system. Wrong tool for "family members sign up". |

Trade-off, stated plainly: auth depends on Clerk (a third party). That is
acceptable because auth is the part that must not be hand-rolled, and the
auth layer is isolated to `src/index.ts` (the Clerk middleware) plus the
ClerkJS loader in `src/frontend/main.js`, so it can be swapped later without
rewriting the bills logic.

## Project layout

```
bills-public/
  wrangler.toml          Worker config: D1 binding, static assets, cron trigger
  migrations/
    0001_init.sql        D1 schema (users, bills, payments, settings, reminder_log)
  src/
    index.ts             Worker + Hono API (auth, bills, payments, dashboard, reminders)
    frontend/
      main.js            SPA: auth gate, dashboard, bill form, settings
  public/
    index.html           App shell
    styles.css           Ledger-style design
    app.js               Built bundle (generated by `npm run build`; do not edit by hand)
  package.json           Scripts: build, typecheck, dev, deploy, db:migrate:*
  README.md              This file
```

## API (all under /api, Clerk Bearer token required except /api/config)

| Method & path | What it does |
|---|---|
| `GET /api/config` | Public. Returns whether Clerk is configured + the publishable key. |
| `GET /api/me` | Current user (creates the D1 user row on first call). |
| `GET /api/bills` | List my bills with computed `daysUntilDue`, `urgency`, `monthlyEquivalent`. |
| `POST /api/bills` | Create a bill. |
| `PUT /api/bills/:id` | Update a bill (mine only). |
| `DELETE /api/bills/:id` | Delete a bill + its payments (mine only). |
| `POST /api/bills/:id/pay` | Mark paid: logs the payment, advances the next due date if recurring. |
| `GET /api/payments?limit=` | Recent payment history (mine only). |
| `GET /api/dashboard` | Due-in-7-days total/count, monthly total, overdue count/total, at-risk fees. |
| `GET /api/timeline` | 14-day timeline: each day's due bills + total. |
| `GET /api/reminders` | Bills needing a reminder today (offset hit, or overdue). |
| `GET /api/settings` · `PUT /api/settings` | My default reminder offsets + in-app notification preference. |

Every query is scoped with `WHERE user_id = ?`, so a user can never read or
change another user's bills — even if they guess an id.

## Local development

```bash
cd bills-public
npm install
npm run build        # bundle the frontend into public/app.js
npm run typecheck    # TypeScript check on the Worker
npm run db:migrate:local   # create the local D1 tables
npm run dev          # wrangler dev on http://localhost:8787 (local D1)
```

Without Clerk keys set, `/api/config` reports `configured: false` and the app
shows a setup message; the API returns `503 auth_not_configured`. That is the
intended clean failure — the app never pretends auth works when it does not.

To test with real auth locally, create `.dev.vars` (git-ignored) with:
```
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
APP_URL=http://localhost:8787
```
then `npm run dev`. Use Clerk **test** keys for local work, **live** keys for
production.

## Deployment (production)

### 0. Credentials needed — provide these first

Two things are needed before the app can go live. Nothing below can be
done without them, and neither is stored anywhere in this repo.

**A. A Cloudflare API token** (to deploy the Worker, create the D1 database
and set the DNS record). Create it at
https://dash.cloudflare.com/profile/api-tokens → **Create Token** → use the
**Edit Cloudflare Workers** template, and add these permissions:
- Account → Workers Scripts: Edit
- Account → D1: Edit
- Zone → DNS: Edit (for the `bills` record in the `laudeus.org` zone)
- Zone → Workers Routes: Edit (only if a route is used; the app uses a
  `workers.dev` route + a custom domain via `wrangler.toml` routes — see step 3)

Scope it to Account `2048be62a67a4de048200227e2095446` and Zone
`laudeus.org` (`75ec27284805d80f6bb6e9047bf27f57`). Give the token to the
deployer through the secure entry — never paste it in chat.

Then, in this directory:
```bash
export CLOUDFLARE_API_TOKEN="<the token>"
```

**B. Clerk API keys** (to enable sign-up and Google/GitHub/Microsoft/Apple
sign-in). Create them at https://dashboard.clerk.com:
1. Create an application (name it e.g. "Bills Dashboard").
2. In **User & Authentication → Social Connections**, enable **Google**,
   **GitHub**, **Microsoft** and **Apple**. Each provider needs its own
   OAuth client (Clerk walks you through creating the Google Cloud / GitHub /
   Microsoft / Apple credentials — about 5 minutes per provider; Google is
   the one most people will use).
3. In **API Keys**, copy the **Publishable Key** (`pk_live_...`) and the
   **Secret Key** (`sk_live_...`).
4. Set them as Worker secrets (never commit them):
```bash
npx wrangler secret put CLERK_PUBLISHABLE_KEY   # paste pk_live_...
npx wrangler secret put CLERK_SECRET_KEY        # paste sk_live_...
```
   The publishable key is public-safe; the secret key must stay secret.
   (The frontend gets the publishable key from `GET /api/config` at runtime,
   so it is never hard-coded in the HTML.)

### 1. Create the D1 database (first time only)

```bash
npx wrangler d1 create bills-public-db
```
Copy the `database_id` it prints into `wrangler.toml`, replacing the
`00000000-0000-0000-0000-000000000000` placeholder. Then apply the schema:

```bash
npx wrangler d1 migrations apply bills-public-db --remote
```

### 2. Deploy the Worker

```bash
npm run build
npx wrangler deploy
```
This deploys the Worker and its static assets. First deploy lands on
`https://bills-public.<your-subdomain>.workers.dev` — verify the app loads
there before wiring the custom domain.

### 3. Point bills.laudeus.org at it

Option 1 — Workers custom domain (recommended):
```bash
npx wrangler custom-domains add bills.laudeus.org
```
This creates the DNS record in the `laudeus.org` zone automatically and
provisions the certificate.

Option 2 — manual DNS: in the Cloudflare dashboard for `laudeus.org`,
add a CNAME `bills` → `bills-public.<your-subdomain>.workers.dev` (proxied
on), then add the route in `wrangler.toml`:
```toml
routes = [{ pattern = "bills.laudeus.org", custom_domain = true }]
```
and redeploy.

### 4. Verify

1. Open https://bills.laudeus.org — the sign-in / sign-up screen appears.
2. Sign up with Google (or email + password) as a test user.
3. Add a bill, mark it paid, confirm the next due date advances and the
   payment appears in Recent payments.
4. Sign in as a second user and confirm the first user's bills are not visible.
5. Check the cron: `npx wrangler tail` the next morning, or call
   `GET /api/reminders` after signing in — due reminders appear in the app.

## Reminders & notifications — what is live now, what is next

- **Live now:** per-bill reminder offsets (14/7/3/1/day-of or a specific
  calendar date), the daily 09:00 EST cron that computes due reminders into
  `reminder_log`, and the in-app Reminders banner surfaced via
  `GET /api/reminders` when a user opens the app.
- **Next step (not built yet):** email or push delivery of those reminders.
  That needs a mail/push provider key (e.g. Resend for email, or a Web Push
  VAPID key pair for browser push). The `reminder_log` table already records
  exactly what is due each day, so the delivery step is a small Worker
  addition — it was left out deliberately rather than wiring a provider
  nobody has chosen yet.

## Security notes

- All `/api/*` routes (except `/api/config`) require a valid Clerk session
  JWT. The Worker verifies it with `verifyToken()` and pins
  `authorizedParties` to the app origin, so a token issued for another app
  is rejected.
- Per-user scoping is enforced in SQL (`WHERE user_id = ?`) on every read,
  write and delete — there is no code path that returns another user's rows.
- The Clerk secret key is a Worker secret, never in the repo or the HTML.
- No passwords are stored in D1 — Clerk holds credentials; D1 only stores
  the Clerk user id, email and display name.
- The app does not send email itself and does not store any payment
  credentials — `payment_source` is a free-text label (e.g. "CIBC *8490"),
  not a card number.

## Costs (Cloudflare + Clerk, family scale)

- Cloudflare Workers free tier: 100,000 requests/day. D1 free tier: 5 GB,
  25M rows read/day, 50k rows written/day. A family will not come close.
- Clerk free tier: 10,000 monthly active users. A family is a handful.
- Expected running cost: **$0/month** at family scale.

## Troubleshooting

- **App shows "Sign-in is not configured"** — the Clerk secrets are not set
  on the Worker. Run the two `wrangler secret put` commands in step 0-B and
  redeploy.
- **API returns 503 `auth_not_configured`** — same cause as above.
- **API returns 401 `unauthorized`** — the session token is missing, expired
  or issued for a different origin. Sign out and back in; check that
  `APP_URL` in `wrangler.toml` matches the real origin.
- **D1 errors on deploy** — the `database_id` in `wrangler.toml` is still the
  placeholder. Create the database (step 1) and paste the real id.
- **Sign-in works but bills do not load** — check `npx wrangler tail` for
  Worker errors; most often a D1 migration that was never applied
  (`npm run db:migrate:remote`).
