# CLAUDE.md

## Commands

```bash
npm run dev          # Start dev server at http://localhost:3000
npm run build        # Static export to /out (required before deploy)
npm run deploy       # build + firebase deploy --only hosting
firebase login       # One-time auth before first deploy
firebase login --reauth  # Re-authenticate when credentials expire (run in terminal, not Claude Code)
```

No test framework configured.

## Architecture

**Next.js 14 static export** → Firebase Hosting. `output: 'export'` in `next.config.ts`; `next start` unused — builds produce static HTML in `/out`. All pages are `'use client'`.

**Data flow**: Pages → `src/lib/firestore.ts` → Firebase SDK. All Firestore operations are centralized in `firestore.ts` (40+ functions). Pages use local `useState` — no global state.

**Auth guard**: `src/app/(admin)/layout.tsx` listens to `onAuthStateChanged`, redirects to `/login`, and verifies `role === 'admin'` in Firestore.

**Routing**: `(admin)` is a route group (no URL segment) — `/dashboard`, `/employee-dashboard`, `/users`, `/sites`, `/leaves`, `/attendance`, `/submissions` are all protected.

## Firestore Collections

- `users/` — employee profiles; `role`: `admin` | `office` | `operations`
- `sites/` — geofenced locations with GPS coordinates
- `users/{uid}/leave_requests/`
- `users/{uid}/attendance/` — check-in/out events. Ops `site_in`/`site_out` carry free-text `siteName`; `siteId` is filled later by admin via **Site IDs** page (`updateAttendanceSiteId`).
- `users/{uid}/attendance_status/{date}` — computed daily status (written by `computeDailyAttendanceStatus`). Statuses: `Present`/`HalfDay`/`SL`/`SLNF`/`Absent`/`PL`/`LWP`/`WO`. **WO** (paid no-work day off for ops) is admin-set (`markedBy:'admin'`) via the Attendance page (Mark WO / clear) or as a regularization outcome; in the OT/shortage ledger it owes a standard 8h, payable by OT in the same month (not yet wired into salary — see redesign spec)
- `users/{uid}/planned_hours/{date}` — admin-set shift window for ops (`startTime`/`endTime` as `"HH:MM"`); office fixed 10–18. Optional `declaredOtMins` = admin pre-declared overtime for that day (OT worked up to this is auto-approved; set inline on the Attendance page next to the shift). Optional `otAuthorized` (boolean) = Sunday/holiday OT authorization: when true, **all** worked minutes that rest day count as auto-approved OT (set via the "Authorize OT" toggle that replaces the shift inputs on Sundays/holidays). Without it, rest-day work credits 0 OT (flagged as "unauthorized" in the OT/Shortage modal)
- `users/{uid}/daily_hours/{date}` — per-day `plannedMins`/`actualMins`/`shortageMins`/`otMins` (written by `computeDailyAttendanceStatus`, fully-worked days only)
- `users/{uid}/ot_approvals/{date}` — admin-approved overtime: `requestedMins`/`approvedMins`/`reason`/`approvedBy` (written by `approveOt` from the employee dashboard)
- `users/{uid}/material_requests/`
- Top-level: `material_purchases`, `material_transfers`, `tool_transfers`, `work_progress`, `conveyance`
- `holidays/{date}` — company-wide holidays (`title`/`description`), marked by admin on the **Attendance** calendar. A marked day is skipped like a Sunday: no status doc, no Absent penalty, excluded from expected working days (unpaid, no payroll effect). Managed via `setHoliday`/`deleteHoliday`; read by `getHolidaysForMonth`/`getHolidaysForDateRange`.

Required composite indexes (Firebase Console):
- `leave_requests`: `status` ASC + `submittedAt` ASC
- `attendance`: `date` ASC + `timestamp` ASC
- `material_requests`: `submittedAt` DESC
- collection-group `planned_hours`: `date` ASC (for `getPlannedHoursForMonth`, `getPlannedHoursForDateRange`)
- collection-group `attendance`: `date` ASC + `timestamp` ASC (for `getAttendanceForDateRange`)

## Attendance Status Logic

> Full backend reference: **`docs/cloud-functions.md`** (all 6 functions, triggers, collections, deploy/auth notes).

`computeDailyAttendanceStatus` Cloud Function runs at 23:59 IST. **Sundays and company-wide holidays (`holidays/{date}`) are skipped entirely — no status doc written, no penalty.**

**Events and window by role:**
- **Office/admin**: `office_in` / `office_out`; fixed 10:00–18:00 IST
- **Operations**: first in / last out across both site and market visits (`site_in`/`market_in` and `site_out`/`market_out`); window from `planned_hours/{date}`. **No plan + no approved leave → day skipped (no status doc).** Approved leave still produces PL/LWP.

| Status | Condition | Salary (days) |
|--------|-----------|---------------|
| Present | In by window start AND out after window end | 1 |
| Short Leave (SL) | Both events present, total hours < 6 | 0.75 |
| Half Day | Late in AND early out | 0.5 |
| SLNF (Log Not Found) | Missing check-in or check-out | 0.5 |
| PL (Paid Leave) | Approved leave + PL balance | 1 |
| LWP (Leave Without Pay) | Approved leave, no balance | 0 |
| Absent | No events, no approved leave (ops: only when plan exists) | -2 |

`markedBy: 'auto'` on function-written docs; `markedBy: 'admin'` docs (regularization) are skipped on recompute. The attendance page mirrors this logic client-side until the nightly run writes it.

**Days NP**: `present + SL×0.75 + halfDay×0.5 + SLNF×0.5 + PL - absent×2` (LWP = 0)

**Salary**: `daysNP × salaryRate`

PL balance: +1 on 1st of month (`accrueMonthlyLeave`), -1 per PL day used.

## Google Sheets Export

`exportToSheets` Cloud Function runs 16:30 UTC (22:00 IST) → Google Sheet (`SHEET_ID` in `functions/index.js`) via service account (`ATTENDANCE_SHEETS_KEY` secret).

- **Always resolve Name/ID from the live `users` collection** — not the snapshot values on each doc. Use `uidOf(doc)` + `userNameMap`/`userEmpIdMap` (keyed by uid). `uidOf` reads `userId` field, falling back to parent path for subcollection docs.
- **Attendance tab** is per-employee/day (not per-event): In Time / In Location / Site ID / Out Time / Out Location / All Activity. Built from union of attendance events and status docs — Absent/PL/LWP/SLNF days appear even without check-in events. **All Activity** = full chronological log with resolved Site ID in brackets.
- **Employee Dashboard tab** — MTD summary, one row per employee: Date | EMP Name | EMP ID | Days Passed | Present | SL | Half Day | SLNF | PL | LWP | Absent | Leaves | Days NP | Salary Rate | Salary Due MTD | Covy Due | Imprest Due | TOTAL DUE. Includes CF BAL (carry-forward leave) and TOTAL summary rows. **Imprest** is preserved across runs by locating columns by header name (not fixed index). Conveyance is built from the `conveyance` collection (operations only).

## Employee Dashboard Page

`/employee-dashboard` (`src/app/(admin)/employee-dashboard/page.tsx`) — real-time view of expected vs actual working hours across a configurable date range.

- **Filters**: date preset (Today / Last 7/15/30/90/180/365 days / custom), role, individual employee
- **Columns**: Name, Emp ID, Role, PL, WO, Working (expected), Actual, Shortage, Overtime
- **Single-day view**: also shows Check-in / Check-out times
- **Expected hours**: office/admin = 8 h × working days (Mon–Sat); ops = sum of admin-set `planned_hours` windows
- **Actual hours**: derived from `office_in`/`office_out` (office) or `site_in`/`market_in` … `site_out`/`market_out` (ops) attendance events
- **Data**: `getAttendanceForDateRange` + `getPlannedHoursForDateRange` + `getOtApprovalsForDateRange` (all `collectionGroup`)
- Sundays excluded from working day count; sort order: office → admin → ops, then alphabetical

### Shortage & Overtime (per-day, every minute counts)

Computed **per worked day** (both check-in and check-out present — absent/leave/SLNF days never count). `plannedDay` = ops `planned_hours` window for that date, or 8 h for office/admin. `actualDay` = last out − first in.
- **Shortage** = Σ `max(0, plannedDay − actualDay)`. Automatic, no approval. Shown live for the selected range; the nightly function also accrues a lifetime total to `users/{uid}.shortageMins` (idempotent — increments only the delta vs the existing `daily_hours/{date}` record).
- **Overtime** = `max(0, actualDay − plannedDay)` per day, split by the day's `declaredOtMins` (pre-declared by admin): worked OT **up to `declaredOtMins` is auto-approved** (no review); only the **surplus beyond it is pending** and needs admin action. The dashboard lists pending OT days; admin grants an adjusted amount (≤ the beyond-declared surplus) with a **mandatory reason** via `approveOt`, which writes `ot_approvals/{date}` and recomputes `users/{uid}.approvedOtMins`. Declared OT is a pre-approval **ceiling, not an obligation** — leaving before the declared end never creates extra shortage (shortage is always measured vs the plain shift). Full redesign spec: **`docs/ot-shortage-design.md`**. OT and shortage are tracked **separately** (never netted). OT detection in the portal is live (no Cloud Function dependency); only the lifetime `shortageMins` needs the nightly run — **redeploy functions** (`firebase deploy --only functions`) after changing it.

## Styling

Global classes in `src/app/globals.css`: `.btn-primary`, `.btn-outline`, `.btn-danger`, `.btn-success`, `.card`, `.input`, `.label`, `.badge-*`. Use these over inline Tailwind for interactive elements.

Tailwind tokens (`tailwind.config.ts`): `primary` `#1A5FAF` · `background` `#F0F4F8` · `border-custom` `#C8D6E8` · `text-primary` `#0D1B2A` · `text-secondary` `#6B7E94`

## Environment

`.env.local` (not committed): `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`

Firebase project: `white-coffee-92c27` · Hosting: `https://white-coffee-92c27.web.app`
