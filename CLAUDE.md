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
- `users/{uid}/attendance_status/{date}` — computed daily status (written by `computeDailyAttendanceStatus`)
- `users/{uid}/planned_hours/{date}` — admin-set shift window for ops (`startTime`/`endTime` as `"HH:MM"`); office fixed 10–18
- `users/{uid}/material_requests/`
- Top-level: `material_purchases`, `material_transfers`, `tool_transfers`, `work_progress`, `conveyance`

Required composite indexes (Firebase Console):
- `leave_requests`: `status` ASC + `submittedAt` ASC
- `attendance`: `date` ASC + `timestamp` ASC
- `material_requests`: `submittedAt` DESC
- collection-group `planned_hours`: `date` ASC (for `getPlannedHoursForMonth`, `getPlannedHoursForDateRange`)
- collection-group `attendance`: `date` ASC + `timestamp` ASC (for `getAttendanceForDateRange`)

## Attendance Status Logic

`computeDailyAttendanceStatus` Cloud Function runs at 23:59 IST.

**Events and window by role:**
- **Office/admin**: `office_in` / `office_out`; fixed 10:00–18:00 IST
- **Operations**: first `site_in` / last `site_out`; window from `planned_hours/{date}`. **No plan + no approved leave → day skipped (no status doc).** Approved leave still produces PL/UPL.

| Status | Condition | Salary (days) |
|--------|-----------|---------------|
| Present | In by window start AND out after window end | 1 |
| Short Leave (SL) | Both events present, total hours < 6 | 0.75 |
| Half Day | Late in AND early out | 0.5 |
| SLNF (Log Not Found) | Missing check-in or check-out | 0.5 |
| PL (Paid Leave) | Approved leave + PL balance | 1 |
| UPL (Unpaid Leave) | Approved leave, no balance | 0 |
| Absent | No events, no approved leave (ops: only when plan exists) | -2 |

`markedBy: 'auto'` on function-written docs; `markedBy: 'admin'` docs (regularization) are skipped on recompute. The attendance page mirrors this logic client-side until the nightly run writes it.

**Days NP**: `present + SL×0.75 + halfDay×0.5 + SLNF×0.5 + PL - absent×2` (UPL = 0)

**Salary**: `daysNP × salaryRate`

PL balance: +1 on 1st of month (`accrueMonthlyLeave`), -1 per PL day used.

## Google Sheets Export

`exportToSheets` Cloud Function runs 16:30 UTC (22:00 IST) → Google Sheet (`SHEET_ID` in `functions/index.js`) via service account (`ATTENDANCE_SHEETS_KEY` secret).

- **Always resolve Name/ID from the live `users` collection** — not the snapshot values on each doc. Use `uidOf(doc)` + `userNameMap`/`userEmpIdMap` (keyed by uid). `uidOf` reads `userId` field, falling back to parent path for subcollection docs.
- **Attendance tab** is per-employee/day (not per-event): In Time / In Location / Site ID / Out Time / Out Location / All Activity. Built from union of attendance events and status docs — Absent/PL/UPL/SLNF days appear even without check-in events. **All Activity** = full chronological log with resolved Site ID in brackets.
- **Employee Dashboard tab** — MTD summary, one row per employee: Date | EMP Name | EMP ID | Days Passed | Present | SL | Half Day | SLNF | PL | UPL | Absent | Leaves | Days NP | Salary Rate | Salary Due MTD | Covy Due | Imprest Due | TOTAL DUE. Includes CF BAL (carry-forward leave) and TOTAL summary rows. **Imprest** is preserved across runs by locating columns by header name (not fixed index). Conveyance is built from the `conveyance` collection (operations only).

## Employee Dashboard Page

`/employee-dashboard` (`src/app/(admin)/employee-dashboard/page.tsx`) — real-time view of expected vs actual working hours across a configurable date range.

- **Filters**: date preset (Today / Last 7/15/30/90/180/365 days / custom), role, individual employee
- **Columns**: Name, Emp ID, Role, PL Bal, WO Bal, Working Hrs (expected), Actual Hrs, Shortage
- **Single-day view**: also shows Check-in / Check-out times
- **Expected hours**: office/admin = 8 h × working days (Mon–Sat); ops = sum of admin-set `planned_hours` windows
- **Actual hours**: derived from `office_in`/`office_out` (office) or `site_in`/`site_out` (ops) attendance events
- **Data**: `getAttendanceForDateRange(start, end)` + `getPlannedHoursForDateRange(start, end)` — both use `collectionGroup` queries
- Sundays excluded from working day count; sort order: office → admin → ops, then alphabetical

## Styling

Global classes in `src/app/globals.css`: `.btn-primary`, `.btn-outline`, `.btn-danger`, `.btn-success`, `.card`, `.input`, `.label`, `.badge-*`. Use these over inline Tailwind for interactive elements.

Tailwind tokens (`tailwind.config.ts`): `primary` `#1A5FAF` · `background` `#F0F4F8` · `border-custom` `#C8D6E8` · `text-primary` `#0D1B2A` · `text-secondary` `#6B7E94`

## Environment

`.env.local` (not committed): `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`

Firebase project: `white-coffee-92c27` · Hosting: `https://white-coffee-92c27.web.app`
