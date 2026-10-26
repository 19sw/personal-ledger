# Automatic Transaction Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show source labels for automatically recorded transactions while keeping manual categories and balances accurate, and simplify the exported transaction report.

**Architecture:** Keep stored channels and spending categories separate. Add a display-only category label to the existing ledger view, render channel labels for Apple Pay and Gmail receipt entries, and format exported rows with the same labels. Remove category-level budget lines only from the exported spreadsheet; keep its total-budget comparison and all existing in-app category budget calculations unchanged.

**Tech Stack:** Google Apps Script V8, vanilla JavaScript, Node.js built-in test runner, existing Apps Script/Google Sheets test doubles.

**Spec:** `docs/superpowers/specs/2026-10-22-automatic-transaction-labels-design.md`

## Global Constraints

- Do not use AI or paid services to infer categories.
- Do not edit historical transaction amounts, dates, merchants, categories, or budgets.
- Do not infer or fill missing amounts.
- Do not change total budget amounts or the manual-entry flow.
- Preserve the distinct stored values for channel and spending category.
- Do not push or deploy without separate client authorization.

## Review Focus

- A missing category must not affect running-balance completeness; a missing amount must continue to mark that and later balances incomplete.
- Apple Pay and Gmail receipt source labels must not overwrite the stored spending category used by current App budgets.
- Category-level budget detail must disappear from the exported workbook while the total-budget row remains.
- Existing manual categories, income labels, refunds, and month grouping must retain their current display.
- Previously generated report files are snapshots and must not be modified by this feature.

---

### Task 1: Show automatic transaction source labels in the ledger and report rows

**Files:**
- Modify: `apps/main/core/service.js` (`entryView_`)
- Modify: `apps/main/ui/app.js.html` (`renderEntries`)
- Modify: `apps/main/core/transaction_table.js` (`svcGenerateTransactionReport`)
- Test: `tests/ledger.test.js`
- Test: `tests/transaction-table.test.js`
- Test: `tests/ui.test.js`

**Interfaces:**
- `entryView_(entry, lookups)` continues returning `category_name` for edit forms and adds `display_category_name` for read-only ledger display.
- `display_category_name` is `Apple Pay` for `channel === 'apple_pay'`, `Online Order` for `channel === 'gmail_receipt'`, and otherwise the existing `category_name`.
- Transaction-report row `category` follows the same mapping. The existing stored `category_id` and `channel` fields remain unchanged.

- [x] **Step 1: Add service and report behavior checks**

  Extend existing ledger/report fixtures with Apple Pay, Gmail receipt, and manual entries. Assert their display labels are `Apple Pay`, `Online Order`, and the selected manual category, while their stored category IDs remain untouched. Assert a null category with a known amount still produces a complete running balance, while a null amount remains incomplete.

- [x] **Step 2: Run the focused tests and confirm they fail for the missing behavior**

  Run: `node --test tests/ledger.test.js tests/transaction-table.test.js`
  Expected: the new display-label assertions fail before implementation; existing balance assertions remain unchanged.

- [x] **Step 3: Add display-only labels**

  In `entryView_`, add `display_category_name` without changing `category_name`. In `renderEntries`, show the display-only value while keeping the icon based on the actual spending category. In `svcGenerateTransactionReport`, map the `category` display field from the transaction channel using the exact labels above.

- [x] **Step 4: Add an app-rendering check for source labels**

  Extend `tests/ui.test.js` with existing backend fixture helpers to render an Apple Pay and a Gmail receipt row, and assert the ledger shows the source label rather than `未分类`; assert a manual row still shows its selected category.

- [x] **Step 5: Run the focused UI check**

  Run: `node --test tests/ui.test.js`
  Expected: PASS; manual category controls and labels are unchanged.

---

### Task 2: Simplify the exported budget section without changing total-budget math

**Files:**
- Modify: `apps/main/web.js` (`transactionReportSheetValues_`)
- Modify: `tests/ui-assistant.test.js`
- Modify: `tests/transaction-table.test.js` only if an export-row helper is added there

**Interfaces:**
- `transactionReportSheetValues_(report)` continues producing the same seven-column sheet and monthly transaction rows.
- For each month, keep the `当月预算对比（整月实际）` heading, budget headers, and `总预算` row when available; omit rows for individual spending categories.
- Transaction labels and amounts are provided by Task 1. Total actual spending and remaining budget are unchanged.

- [x] **Step 1: Add export-layout assertions**

  Extend the existing transaction-table UI test to assert the exported sheet keeps a configured total-budget row, contains no individual category-budget rows, preserves a manual category label, and shows the Apple Pay/Online Order source labels for automatic rows.

- [x] **Step 2: Run the focused report-generation check and confirm the new category-row assertion fails**

  Run: `node --test tests/ui-assistant.test.js`
  Expected: the category-budget row assertion fails before implementation; the existing total-budget and balance assertions pass.

- [x] **Step 3: Remove only category budget rows from sheet output**

  In `transactionReportSheetValues_`, stop appending `month.budget.categories` rows. Keep the total budget summary and avoid changing `computeBudgetView` or App budget calculations.

- [x] **Step 4: Run focused report and balance checks**

  Run: `node --test tests/ui-assistant.test.js tests/transaction-table.test.js`
  Expected: PASS; the generated Google Sheets workbook still has month groups, source labels, total budget values, and continuous balances.

---

### Task 3: Update product documentation and perform final review

**Files:**
- Modify: `devpost/prd.md` (approved behavior for manual categories and automatic source labels)
- Modify: `devpost/spec.md` (report columns, source labels, and budget-section scope)
- Modify: `devpost/plan.md` and `devpost/progress-summary.md` (implementation and deployment status)

- [x] **Step 1: Update only the relevant product and progress sections**

  Keep documentation consistent with the approved design. Record that the failed October 15 test entry was soft-deleted and that existing exported files are unchanged snapshots. Do not record private deployment identifiers, spreadsheet identifiers, or transaction details.

- [x] **Step 2: Review the full change against the spec**

  Confirm that manual categories remain selectable, source labels are display-only, no categories are written back to old entries, category budget lines are absent only from new exported sheets, and missing amounts still mark balances incomplete.

- [x] **Step 3: Run the full project test suite if the client has authorized test execution**

  Run: `node --test tests/`
  Expected: PASS with no test failures. If test execution has not been authorized for this implementation, stop before running it and report that verification remains pending.

- [x] **Step 4: Confirm release separately**

  Do not run `clasp push` or update the deployed web app in this task unless the client separately authorizes release. No `setupLedger` rerun is expected because the approved design changes display/export behavior only and adds no schema.

