# Personal Ledger

**English** | [中文](README.zh-CN.md)

> A Build With AI: Basics project · a personal bookkeeping web app for the phone browser, with no running costs

It brings in-store payments and food-delivery orders into one ledger, keeps income from different part-time jobs apart, and shows each month where the money went and where it came from. Transactions whose amount can't be read are never dropped — they are marked "missing amount" so you can fill them in later.

The ledger is a Google Sheet in your own Google account, and the app runs on Google Apps Script: no server, no database software, no payment method attached.

## Features

| Status | Feature |
| --- | --- |
| ✅ Live | Add / edit / delete entries (deleted entries can be restored for 30 days) |
| ✅ Live | Refunds: recorded as a negative expense linked to the original purchase, counted in the refund's month |
| ✅ Live | Income sources (e.g. "Part-time A", "Part-time B"), reusable |
| ✅ Live | Missing amounts: entries whose amount can't be read stay visible with a reminder and are left out of totals until filled in |
| ✅ Live | Monthly report: spending by category, income by category (expandable by source), income vs. expenses |
| ✅ Live | Months follow US Eastern time (America/New_York), whatever the phone's time zone |
| ✅ Live | Soft mint design; two-step entry (pick a category → type the amount on a built-in keypad) |
| ✅ Live | Monthly total and category budgets; donut charts; monthly and yearly bills |
| ✅ Live | Daily check-ins on the "Me" page: streak, total days and milestones |
| ✅ Live | Rule-based Cat Assistant in the top-left corner: budget alerts, praise, overspending pace, five preset questions; "Go fix" walks through months with entries to handle |
| ✅ Live | Apple Pay in stores recorded automatically (iPhone Shortcut → inbox → ledger); missing amounts are flagged |
| ✅ Live | Gmail receipts recorded automatically: DoorDash, Uber Eats (Dining) and Uber rides (Transport); other receipt-like emails go to "Emails to review", where you can record once, add the sender to the list, mute it, or mark it reviewed |
| ✅ Live | Possible duplicates across channels are flagged (e.g. the same purchase from Apple Pay and an email receipt) |
| ✅ Live | Transaction report for any date range (a separate Google Sheet, downloadable as Excel) |
| ✅ Live | Savings goals; spending habits (this month vs. the same period last month, three-month category trend) |
| ✅ Live | Chinese / English interface: "Me → Language", remembered in the browser; built-in categories switch too, your own text stays as typed |
| 🤔 Undecided | A more app-like launch on the phone (full-screen home-screen icon) |

## How it works

```
iPhone Safari ──Google sign-in (only you)──▶ Main app (Apps Script web app)
                                                │  read / write
                                                ▼
                                       "Ledger" Google Sheet
Gmail receipts ──read-only check every 5 min──▶ Main app
Apple Pay Shortcut ──token-protected──▶ Inbox app ──▶ "Inbox" Sheet ──processed every 5 min──▶ Main app
```

- **Cost:** only the free personal quotas of Apps Script and Google Sheets; no billing account is ever attached.
- **Privacy:** only you can open the web app; entries live only in your own Google Sheet and are never sent to a third-party service.
- **Money:** all amounts are whole cents, so there are no rounding errors.
- **Language:** the interface is written in Chinese; in English mode, a translation layer (`apps/main/ui/i18n.js.html` + `i18n-en.js.html`) translates what is shown on screen, so the business code and the ledger are unchanged.

## Quick start (deploy to your own Google account)

The full step-by-step guide is [`docs/setup-guide.md`](docs/setup-guide.md) (in Chinese). In short:

1. Turn on 2-Step Verification for your Google account.
2. Create a "Ledger" spreadsheet and, from it, create the Apps Script project via **Extensions → Apps Script**.
3. Turn on "Google Apps Script API" in the Apps Script **user settings**.
4. Install the dependencies and sign in to clasp (allow all permissions on the consent page):
   ```bash
   npm install
   npx clasp login
   ```
5. Copy `apps/main/.clasp.json.example` to `apps/main/.clasp.json` and fill in your script ID (the file is git-ignored).
6. Upload the code (**run this inside `apps/main`**):
   ```bash
   cd apps/main
   npx clasp push
   ```
7. In the script editor, run `setupLedger` (creates the sheets and default categories; asks for permission the first time).
8. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Only myself**.
9. Run `installTriggers` (daily cleanup of entries deleted more than 30 days ago, and processing the Apple Pay inbox every 5 minutes).
10. Open the web app URL in Safari on your iPhone and choose **Share → Add to Home Screen**.

Both automatic channels are optional; manual entries work without them:

- **Apple Pay:** deploy the inbox app (`apps/inbox`) following [`docs/applepay-setup.md`](docs/applepay-setup.md), then set up the iPhone Shortcut with [`docs/shortcut-setup.md`](docs/shortcut-setup.md).
- **Gmail receipts:** following [`docs/gmail-receipts-setup.md`](docs/gmail-receipts-setup.md), first run the read-only dry run `dryRunReceipts` to check what it recognizes, then run `enableReceiptPolling` to check Gmail every 5 minutes.

After deploying, you can go through [`docs/checklist-slice1.md`](docs/checklist-slice1.md) on your phone. The guides in `docs/` are in Chinese.

## Development

Requires Node.js (developed on v25). There are **no runtime dependencies**; the only dev dependencies are `@google/clasp` (uploading code) and `jsdom` (browser-like UI tests).

```bash
npm install
node --test tests/                        # all tests; no network or sign-in needed
npm run check:i18n                        # check the English dictionary covers all interface text (~1 min)
npm run preview                           # local preview with sample data at http://localhost:8787
cd apps/main && npx clasp show-file-status   # list the files that will be uploaded
```

The tests load the code in `apps/main` into one global scope (just like Apps Script does) with Google services replaced by fakes; the UI tests open the real page in a simulated browser and click through it like a user.

### File structure

```
apps/main/                 Main app (clasp uploads from here)
  appsscript.json          time zone, V8, OAuth scopes, web app access: only me
  web.js                   web entry point and the api_* functions the page can call (writes take a lock)
  store.js                 Google Sheets access (keeps text from turning into dates or formulas)
  gmail.js                 Gmail access (read-only)
  jobs.js                  setupLedger / installTriggers / processInbox / pollReceipts / dryRunReceipts / enableReceiptPolling, etc.
  core/                    pure logic: money, time, reports, budgets, assistant, savings, transaction report, Apple Pay processing
  core/platforms/          per-platform receipt rules (DoorDash, Uber Eats, Uber); shared flow in core/receipt_pipeline.js
  ui/                      the page: index.html, style.html, app.js.html; i18n.js.html (language switch) and i18n-en.js.html (English dictionary)
apps/inbox/                Inbox app: receives the Apple Pay Shortcut (token + rate limits)
tests/                     automated tests (node:test) with fake Google services and Gmail
tools/preview.js           local preview (npm run preview, sample data)
tools/check-i18n.js        English dictionary coverage check (npm run check:i18n)
docs/                      setup guides for deployment, Apple Pay, the Shortcut and Gmail receipts, plus a phone checklist (Chinese)
devpost/                   scope, product requirements, technical spec, build checklist, app map and progress notes (Chinese)
```

### Planning documents (Chinese)

Some planning documents mention files under `.multiagent/` (AI collaboration records) or `START_HERE.md`; those are not included in this public repository.

| File | Contents |
| --- | --- |
| [`devpost/scope.md`](devpost/scope.md) | Scope of the first version |
| [`devpost/prd.md`](devpost/prd.md) | Product behavior and acceptance scenarios |
| [`devpost/spec.md`](devpost/spec.md) | Technical design, permissions, costs and risks |
| [`devpost/checklist.md`](devpost/checklist.md) | Build slices, hands-on review and revisions |
| [`devpost/app-map.html`](devpost/app-map.html) | App map: how the pieces connect and where to start a change |
| [`devpost/plan.md`](devpost/plan.md) | Plan and progress log |
| [`devpost/progress-summary.md`](devpost/progress-summary.md) | Current status and handoff notes |

## Safety rules

- Never put these in the repository: tokens, web app or inbox URLs, spreadsheet IDs, script IDs, real emails or real ledger entries.
- `.clasp.json` (contains the script ID) and `.clasprc.json` (clasp credentials) are git-ignored; only `.clasp.json.example` is committed.
- Before committing, run the checks in section 9.5 of `devpost/spec.md` and confirm they find nothing.
- Treat the "Ledger" sheet as read-only; never sort or edit the "Inbox" sheet by hand.

## About this project

A project for learning to build a product together with AI: a PM role organizes the requirements, developer and reviewer roles implement and independently check each piece, and the author reviews and approves every step before it runs.
