# Cloud Functions Reference

Backend automation for the WhiteCoffee admin system. All functions live in `functions/index.js` and run on **Firebase Cloud Functions (2nd gen)**, Node.js runtime, project `white-coffee-92c27`.

- **Global options:** `maxInstances: 10` (applies to every function).
- **Admin SDK:** initialized once via `admin.initializeApp()` — functions use the project's default service account for Firestore/FCM.
- **Deploy:** `firebase deploy --only functions` (run from repo root or `functions/`). Requires a valid Firebase login; see [Operations](#operations--deployment).

---

## Function summary

| Function | Type | Trigger / Schedule (IST unless noted) | Purpose |
|----------|------|----------------------------------------|---------|
| `accrueMonthlyLeave` | Scheduled | `0 0 1 * *` — 00:00 on the 1st | +1 PL balance for every user |
| `computeDailyAttendanceStatus` | Scheduled | `59 23 * * *` — 23:59 daily | Compute each user's daily status + per-day hours/shortage |
| `exportToSheets` | Scheduled | `30 16 * * *` UTC = **22:00 IST** daily | Rebuild 9 Google Sheets tabs; persist conveyance |
| `sendPushNotification` | Firestore | `onDocumentCreated` `sent_notifications/{docId}` | Deliver FCM push to the target audience |
| `regularizationReminder` | Scheduled | `0 10 25 * *` — 10:00 on the 25th | Notify admins of pending regularizations |
| `onEmployeeLogout` | Callable | `onCall` (from the employee app) | Auto-close open check-ins on logout |

---

## Secrets & external services

| Secret (`defineSecret`) | Used by | Purpose |
|-------------------------|---------|---------|
| `ATTENDANCE_SHEETS_KEY` | `exportToSheets` | Service-account JSON for the Google Sheets API |
| `MAPS_API_KEY` | `exportToSheets` | Google Distance Matrix API (road km for conveyance) |

Secrets are declared with `defineSecret(...)` and bound on the function via `secrets: [...]` in its options. Every `deploy --only functions` reads these bindings from Secret Manager — so an auth failure there blocks the whole deploy even though no secret value is wrong (see [Operations](#operations--deployment)).

**Target spreadsheets** (IDs are constants at the top of the file):

| Const | Spreadsheet | Tabs written |
|-------|-------------|--------------|
| `SHEET_ID_1` | Sheet1 | Employee Dashboard, Leave Requests, Conveyance |
| `SHEET_ID_2` | Sheet2 | Attendance |
| `SHEET_ID_3` | Sheet3 | MT Requests |
| `SHEET_ID_4` | Sheet4 | MT Purchases |
| `SHEET_ID_5` | Sheet5 | Material Transfers |
| `SHEET_ID_6` | Sheet6 | Tool Transfers |
| `SHEET_ID_7` | Sheet7 | Work Progress |

---

## 1. `accrueMonthlyLeave`

**Trigger:** scheduled `0 0 1 * *` (00:00 IST, 1st of each month), `timeoutSeconds: 120`.

**Logic:**
1. Read every doc in `users/`.
2. In a single batch, `plBalance += 1` (`FieldValue.increment(1)`) for all users.
3. Commit.

**Writes:** `users/{uid}.plBalance`.

**Notes:** This is the only place PL is *added*. PL is *spent* in `computeDailyAttendanceStatus` (−1 when a PL day is recorded). There is no idempotency guard — a manual re-run on the same day would add PL again, so do not re-trigger it manually within the same month.

---

## 2. `computeDailyAttendanceStatus`

The nightly attendance engine. **Trigger:** scheduled `59 23 * * *` (23:59 IST), `timeoutSeconds: 300`.

### Inputs gathered
- `today` = current date in IST (`YYYY-MM-DD`).
- All `users/`.
- Today's events via `collectionGroup("attendance").where("date","==",today)`, grouped per user.
- All approved `leave_requests` covering today (`status==="approved"` and `fromDate <= today <= toDate`).
- Per user: existing `attendance_status/{today}` (to detect `markedBy:"admin"` overrides and the prior status) and `daily_hours/{today}` (prior hours, for idempotent accrual).
- Operations only: `planned_hours/{today}` (the admin-set shift window).

### Guards
- **Sundays are skipped** entirely (no status doc, no penalty).
- Users whose `attendance_status/{today}` was set by **admin** (regularization, `markedBy:"admin"`) are skipped — the function never overwrites a manual correction.
- **Operations with no plan and no approved leave are skipped** (left unmarked; admin must enter a plan).

### Working window
- **Office / admin:** fixed **10:00–18:00 IST**.
- **Operations:** the `startTime`/`endTime` from `planned_hours/{today}` (fallback 10:00–18:00 if a field is missing).

### Status decision (per user)
Check-in/out events: ops use `site_in`/`site_out`; office uses `office_in`/`office_out`. First in, last out.

| Condition | Status | Salary weight |
|-----------|--------|---------------|
| Both punches present, in by window start **and** out by window end (off-minutes = 0) | **Present** | ×1 |
| Both punches, total off-minutes ≤ 120 | **SL** (Short Leave) | ×0.75 |
| Both punches, off-minutes > 120 | **HalfDay** | ×0.5 |
| Exactly one punch (in OR out missing) | **SLNF** (Log Not Found) | ×0.5 |
| No punches + approved leave + `plBalance > 0` | **PL** (queues −1 PL) | ×1 |
| No punches + approved leave + no balance | **LWP** (Leave Without Pay) | ×0 |
| No punches + no leave | **Absent** | ×−2 |

> "Off-minutes" = `max(0, lateMinutes) + max(0, earlyMinutes)` against the working window.

### Per-day hours, shortage & overtime
On **fully-worked days only** (both a check-in and check-out exist):
- `actualMins  = lastOut − firstIn` (IST minutes, clamped ≥ 0)
- `plannedMins = windowEnd − windowStart`
- `shortageMins = max(0, plannedMins − actualMins)`
- `otMins       = max(0, actualMins − plannedMins)`

Writes these to **`users/{uid}/daily_hours/{today}`**. Absent / leave / SLNF days never write hours or accrue shortage.

### Outputs / writes
- `users/{uid}/attendance_status/{today}` — `{date, userId, userName, employeeId, role, status, markedBy:"auto", updatedAt}`.
- `users/{uid}/daily_hours/{today}` — `{date, userId, role, plannedMins, actualMins, shortageMins, otMins, updatedAt}`.
- `users/{uid}.plBalance` — `−1` for each PL day (after the batch).
- `users/{uid}.shortageMins` — incremented by the **delta** vs the previously stored `daily_hours/{today}.shortageMins`.

### Idempotency
Safe to re-run for the same day:
- PL is only deducted when the prior status for today wasn't already `PL`.
- Shortage increments use `newShortage − priorShortage`, so a recompute adjusts rather than double-counts.
- All status/hours docs are keyed by date and overwritten.

> Overtime is **detected** here (`otMins` in `daily_hours`) but **not** auto-applied to any balance — it requires admin approval in the Employee Dashboard (`approveOt` → `ot_approvals/{date}` + `users/{uid}.approvedOtMins`). See `CLAUDE.md › Shortage & Overtime`.

---

## 3. `exportToSheets`

**Trigger:** scheduled `30 16 * * *` **UTC** = 22:00 IST, `timeoutSeconds: 540`, `memory: "512MiB"`, `secrets: ["ATTENDANCE_SHEETS_KEY","MAPS_API_KEY"]`.

Authenticates to Google Sheets with the service-account JSON and rebuilds 9 tabs. Each tab is **cleared then fully rewritten** (`writeTab` → `ensureTab` + `values.clear` + `values.update`). Employee Name / ID / role are always resolved from the **live `users` collection** via `uidOf(doc)` (reads `userId`, else the parent path), not from snapshot values on each doc.

### Shared setup
- `monthStart` = 1st of current month; `today` = current date.
- `daysPassed` = working days (Mon–Sat) elapsed this month.
- Maps: `userRoleMap`, `userEmpIdMap`, `userNameMap` (keyed by uid).
- `statusMap` (`userId__date → status`) from all `attendance_status` docs.
- `userAttendanceMTD` — per-user month-to-date counts of each status (Sundays excluded), used by the Employee Dashboard tab.

### Tabs produced
1. **Attendance** (`SHEET_ID_2`) — one row per employee/day: In/Out time + location, Site ID, full chronological **All Activity** log (with resolved Site ID in brackets), OT flag (ops who left ≥ 18:00), Daily Status. Built from the union of attendance events **and** status docs, so Absent/PL/LWP/SLNF days appear even without punches.
2. **MT Requests** (`SHEET_ID_3`) — `material_requests`, one row per line item (or one row if none).
3. **MT Purchases** (`SHEET_ID_4`) — `material_purchases`, line items with price/total/grand total.
4. **Material Transfers** (`SHEET_ID_5`) — `material_transfers`, from/to/by + line items.
5. **Tool Transfers** (`SHEET_ID_6`) — `tool_transfers`, similar shape (no photos).
6. **Work Progress** (`SHEET_ID_7`) — `work_progress`, one row per entry.
7. **Leave Requests** (`SHEET_ID_1`) — `leave_requests`, full request + approval metadata.
8. **Conveyance** (`SHEET_ID_1`) — **operations only**:
   - Reads `config/conveyance` for `rate1`/`rate2` (fallback `2.5 ₹/km`); each user's `conveyanceRateType` (1 or 2) picks the rate.
   - Groups the month's GPS-bearing attendance events per user/day, sorts chronologically.
   - For each consecutive pair, calls Google Distance Matrix (`getRoadKm`) for **road** distance; `home_in`/`home_out` resolve to the user's stored home coords.
   - `conveyance = totalKm × ratePerKm`; builds a human route string (Home → Site → …).
   - **Persists** each day to the top-level `conveyance` collection (doc id `{uid}__{date}`), batched at 500 writes.
   - Accumulates `conveyanceByUserId` (monthly ₹ total) for the dashboard tab.
9. **Employee Dashboard** (`SHEET_ID_1`) — MTD summary, one row per employee:
   `Date | EMP Name | EMP ID | Days Passed | Present | SL | Half Day | SLNF | PL | LWP | Absent | Leaves | Days NP | Salary Rate | Salary Due MTD | Covy Due | Imprest Due | TOTAL DUE`, plus **CF BAL** (sum of PL balances) and **TOTAL** rows.
   - **Days NP** = `present + SL×0.75 + halfDay×0.5 + SLNF×0.5 + PL − absent×2` (LWP contributes 0).
   - **Salary Due** = `daysNP × salaryRate`.
   - **Imprest is preserved** across runs: the existing sheet is read first and the Imprest column is matched **by header name** (survives layout changes), keyed by EMP ID.
   - **Covy Due** = monthly conveyance total (operations only).
   - **Prior Settlement** = the **previous month's locked** OT/shortage/WO `settlementCash`, read per user from `users/{uid}/settlements/{prevMonth}` (only when `locked`). OT is paid **in arrears** — June's settlement appears in July's export once June is locked on the portal Settlements page. `settlementCash = woDays×rate + netMins/480×rate`.
   - **TOTAL DUE** = `salaryDue + covy + imprest + priorSettlement`.

### Failure modes
- A bad/expired `ATTENDANCE_SHEETS_KEY` fails Sheets auth.
- Distance Matrix errors are swallowed per-pair (`getRoadKm` returns 0 km on failure), so conveyance degrades gracefully rather than crashing.

---

## 4. `sendPushNotification`

**Trigger:** Firestore `onDocumentCreated` on `sent_notifications/{docId}` — fires when the admin portal creates a notification doc.

**Logic:**
1. Read `title`, `body`, `type` (default `"general"`), `recipientType`, `recipientId`. Skip if `title`/`body` missing.
2. Resolve FCM tokens:
   - `specific` → the single `recipientId` user's `fcmToken`.
   - `operations` → users where `role == "operations"`.
   - `office` → users where `role in ["office","admin"]`.
   - `all` → no role filter.
3. Send via `messaging.sendEachForMulticast`, chunked at **500 tokens** per call, with `android.priority: "high"` and `data: { type }`.

**Notes:** This handles **push delivery only**. The in-app notification records (`users/{uid}/notifications/`) are written separately by the admin portal. Delivers even when the app is closed.

---

## 5. `regularizationReminder`

**Trigger:** scheduled `0 10 25 * *` (10:00 IST, 25th of each month), `timeoutSeconds: 120`.

**Logic:**
1. Scan `regularization_requests` (collection group) for `status === "pending"`. Exit if none.
2. Find all `admin` users (exit if none).
3. Write one in-app notification into each admin's `users/{adminId}/notifications/` subcollection: "N attendance regularization request(s) need your review."

**Notes:** Writes notification docs directly (does **not** route through `sendPushNotification`, so this is in-app only unless a push is separately created).

---

## 6. `onEmployeeLogout`

**Trigger:** callable `onCall` — invoked by the employee app on logout. Requires `request.auth` (throws `unauthenticated` otherwise).

**Logic:**
1. Resolve the caller's uid and load `users/{uid}` (throws `not-found` if missing).
2. Load today's `attendance` events; compute which `*_in` types have no matching `*_out`.
3. For each open `*_in`, write the corresponding `*_out` event — timestamped now, copying the last check-in's `latitude/longitude/siteId/siteName/marketName`, flagged `autoLogout: true`.
4. If there's an open `home_in` with no `home_out`, write a `home_out` (using the user's stored home coords or the `home_in` coords).
5. Commit if anything was written. Returns `{ success: true, eventsCreated }`.

**Why:** prevents dangling check-ins that would otherwise be scored **SLNF** or distort hours/conveyance.

---

## Helper functions (internal)

| Helper | Purpose |
|--------|---------|
| `getRoadKm(lat1,lon1,lat2,lon2,key)` | Google Distance Matrix road distance in km; returns 0 on any error |
| `toMinutes(hhmm, fallback)` | Parse `"HH:MM"` → minutes-from-midnight |
| `ts(timestamp)` | Firestore Timestamp → IST locale datetime string |
| `timeIST(timestamp)` | Timestamp → IST `HH:MM` (24h) |
| `getHourIST` / `getMinuteIST` | Hour/minute of a Timestamp in IST |
| `uidOf(doc)` | Owning user id: `userId` field, else subcollection parent path |
| `ensureTab` / `writeTab` | Create a Sheets tab if missing; clear + rewrite its values |

---

## Firestore collections touched

| Collection / path | Read by | Written by |
|-------------------|---------|------------|
| `users/` | all | `accrueMonthlyLeave` (plBalance), `computeDailyAttendanceStatus` (plBalance, shortageMins) |
| `users/{uid}/attendance/` | compute, export, logout | `onEmployeeLogout` |
| `users/{uid}/attendance_status/{date}` | compute, export | `computeDailyAttendanceStatus` |
| `users/{uid}/daily_hours/{date}` | compute (prior) | `computeDailyAttendanceStatus` |
| `users/{uid}/planned_hours/{date}` | compute | — (set by admin portal) |
| `users/{uid}/leave_requests/` | compute, export | — |
| `users/{uid}/ot_approvals/{date}` | — | — (written by portal `approveOt`; detected here via `daily_hours.otMins`) |
| `users/{uid}/notifications/` | — | `regularizationReminder` |
| `regularization_requests` (group) | `regularizationReminder` | — |
| `material_requests`/`material_purchases`/`material_transfers`/`tool_transfers`/`work_progress` (groups) | `exportToSheets` | — |
| `conveyance` | — | `exportToSheets` |
| `config/conveyance` | `exportToSheets` | — |
| `sent_notifications/{docId}` | `sendPushNotification` (trigger) | — (written by portal) |

---

## Scheduling overview (IST)

```
Day  1, 00:00  →  accrueMonthlyLeave        (+1 PL to everyone)
Day 25, 10:00  →  regularizationReminder    (nudge admins)
Daily, 22:00   →  exportToSheets            (rebuild all sheets, persist conveyance)
Daily, 23:59   →  computeDailyAttendanceStatus (status + hours + shortage)
On demand      →  sendPushNotification      (Firestore trigger)
On demand      →  onEmployeeLogout          (callable from app)
```

> Note the export (22:00) runs **before** the nightly status compute (23:59), so the Employee Dashboard / Attendance tabs reflect statuses computed the *previous* night plus any live events up to 22:00.

---

## Operations & deployment

**Deploy:**
```bash
firebase deploy --only functions
```

**Common failure — `UNAUTHENTICATED` / `CREDENTIALS_MISSING` (HTTP 401)** while listing functions or reading `secretmanager.googleapis.com`:
- The CLI's auth token is expired/missing. Fix with a fresh login (interactive, needs a browser):
  ```bash
  firebase logout
  firebase login
  ```
- Verify the right account and project access:
  ```bash
  firebase login:list
  firebase projects:list   # should list white-coffee-92c27
  ```
- If it still 401s on Secret Manager after a correct login, the account is missing IAM permissions (e.g. `roles/secretmanager.admin` / deploy roles) — a Google Cloud Console fix.

**Other notes:**
- Changing `computeDailyAttendanceStatus` (e.g. the UPL→LWP rename, shortage accrual) only takes effect after redeploy; historical docs are not rewritten retroactively.
- Logs: `firebase functions:log` or the Cloud Console → Functions → Logs. Each function logs a one-line summary on completion.
- Manual trigger for testing: scheduled functions can be run from the Cloud Scheduler console or `gcloud scheduler jobs run <job>`. Mind the idempotency notes above (especially `accrueMonthlyLeave`).
```
