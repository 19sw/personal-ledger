# Savings Goals and Spending Insights Implementation Plan

> **For agentic workers:** Implement this plan task by task. The approved product requirements are in `.multiagent/runs/2026-10-23-savings-spending-insights/messages/005-pm-to-developer-task-assignment.md`.

**Goal:** Add concurrent savings goals, category spending comparisons, and an estimate of month-end money available after planned savings.

**Architecture:** Keep savings goals and deposits separate from income and expense entries. Reuse existing report aggregation for income, expenses, and categories; add focused forecast calculations and service methods. Present goal progress and spending insights inside the existing app navigation, and surface affordability guidance through the rule-based cat assistant.

**Tech Stack:** Google Apps Script V8, Google Sheets storage, existing HTML/CSS/JavaScript UI, and the current Node.js development environment.

**Spec:** `.multiagent/runs/2026-10-23-savings-spending-insights/messages/005-pm-to-developer-task-assignment.md`

## Global Constraints

- Use US dollars and the app's existing New York time-zone month boundaries.
- Keep savings contributions out of ordinary income/expense entries and all daily spending totals.
- Do not add external AI, runtime dependencies, paid services, account access, deployment, or push.
- Preserve all existing uncommitted project changes; do not stage or commit unrelated work.
- Do not edit `devpost/scope.md` or `devpost/prd.md` until PM shows the exact proposed diffs and receives client approval.
- Do not add or run automated tests unless the client separately asks for testing or verification.

## Review Focus

- Several simultaneous goals: total planned contributions must be compared with one monthly savings capacity.
- Current-month partial data: comparisons must use the same elapsed day count and estimates must not mistake partial months for complete months.
- Refunds and unknown amounts: refunds remain netted with spending, while missing amounts must make the estimate visibly incomplete.
- New or sparse histories: one or two available months must work; no income or expense history must lead to manual estimates rather than false precision.
- Existing ledgers without new optional goal tables must remain readable and show a recoverable setup path.

---

### Task 1: Savings goals and forecast calculations

**Files:** Developer determines exact files, following the existing schema, pure-core-function, and service patterns.

**Interfaces:** Consume existing live transaction and report data. Provide service operations to list/create/update goals, record a contribution, and calculate current estimates.

- [ ] Add storage for named goals and dated contributions, separate from ledger entries; preserve existing sheets during initialization.
- [ ] Validate each goal's target amount, starting saved amount, monthly contribution, and optional future target date.
- [ ] Calculate progress from starting savings plus contributions. With a target date, recommend the remaining target divided across remaining calendar months (the current month counts as one); allow the user to set a different planned monthly contribution. Without a target date, require a monthly contribution and estimate months to goal.
- [ ] Calculate income and spending averages from up to the latest three completed months; fall back to fewer available months. Request a manual estimate when the corresponding history is empty.
- [ ] Allow manual adjustment of current-month expected income. Estimate full-month expense as the greater of the available completed-month average and current-month actual-to-date; use the manual estimate if no expense history exists.
- [ ] Calculate monthly savings capacity as `max(0, projected income - projected expenses)` and month-end free-to-spend estimate as `max(0, projected income - projected expenses - sum(goal monthly contributions))`.
- [ ] Surface an incomplete-data flag when known missing-amount entries affect the estimate.

**Review checks:** Verify calculations with concurrent goals, positive and negative net income, no/one/two/three history months, refunds, and missing amounts by inspecting the resulting code and behavior without adding or running automated tests.

### Task 2: Goal and spending insight screens

**Files:** Developer determines the smallest existing UI surface that gives easy access without disturbing the five-item navigation.

**Interfaces:** Consume Task 1 goal and forecast service responses; use existing category reports for comparison data.

- [ ] Let the user create and edit multiple goals, enter starting savings (including zero), set a planned monthly contribution, and optionally set a completion date.
- [ ] Provide a separate “record deposit” action for each goal; show updated saved amount and progress without adding a ledger expense.
- [ ] Show the month-end available estimate with its income, spending, and planned-savings components and a clear “estimate” label.
- [ ] Compare category spending for the current month-to-date against the same elapsed day count last month.
- [ ] Show category trends for the latest three completed months; do not include merchant or transaction-frequency comparisons.
- [ ] Handle empty states and manual estimate entry when no income or expense history exists.

**Review checks:** Inspect the mobile layout and trace create-goal, deposit, manual estimate, category comparison, and month-boundary journeys in the UI code; do not modify the existing bottom-nav structure unless needed for access.

### Task 3: Affordability reminder and integration review

**Files:** Developer determines exact assistant and integration files.

**Interfaces:** Consume Task 1 monthly savings capacity and the sum of active goal contributions; use existing rule-based assistant messaging and deduplication behavior.

- [ ] When total planned contributions exceed estimated monthly savings capacity, show a gentle cat-assistant message and practical options to lower contributions, lower a target, or move a target date.
- [ ] Never change a goal or contribution automatically.
- [ ] Ensure goal setup and forecast data load safely for existing users whose ledger has no goal records yet.
- [ ] Review changed files for compatibility with existing budget, monthly report, assistant, and entry flows.
- [ ] Return an implementation report and a scoped diff for independent reviewer inspection. Do not commit over pre-existing dirty user work.

**Review checks:** Independently inspect the complete diff against the approved requirements and global constraints. No automated tests are added or run in this task unless the client separately authorizes them.
