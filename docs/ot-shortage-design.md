# OT, Shortage & WO — System Redesign (WORKING DRAFT)

> **Status:** model fully decided (all 5 questions answered). Ready to finalize the
> implementation plan. No code written yet.
> Today's date when drafted: 2026-06-29. Decisions locked: 2026-06-29.

## Why we're redesigning

The current system *measures* OT and shortage but they **connect to nothing**:
- `users.approvedOtMins` and `users.shortageMins` accumulate **lifetime**, never reset, and
  **never feed payroll**. Salary is `daysNP × salaryRate` from attendance-status counts only
  (`functions/index.js:727-753`). OT/shortage are dead-end counters.
- **Two sources of truth:** the nightly function writes `daily_hours/{date}`, but the
  OT & Shortage page recomputes live from raw events and ignores it → drift risk.
- CLAUDE.md currently says "OT and shortage are tracked separately, never netted."
  **The new model overturns that** — they become one nettable time ledger.

## The new model (CONFIRMED rules)

Everything is **minutes**, held in a **per-employee, per-month signed balance** that
**resets every month (no carry-forward)**. Standard day = **480 min** when undefined.

| Source | Effect on balance |
|---|---|
| Worked < planned, on a **Present** day | − shortage |
| Worked > planned, **pre-declared** by admin (`declaredOtMins`) | + OT (auto-approved, capped at declared) |
| Worked > planned, **beyond** declared | new **pending** OT request → counts only once admin approves |
| **Sunday/holiday** work (authorized) | + all worked minutes as OT |
| **WO** given (no-work weekday) | **paid day (+1 in `daysNP`)** AND **−480 ledger debit** (clawed back if not worked off) |
| **Month end** | net > 0 → pay cash · net < 0 → deduct from salary, **both at `minutes/480 × salaryRate`** |

Additional confirmed points:
- **Shortage only applies after admin regularizes a day to Present** (via the
  regularization flow, *to be built*). It never stacks on SL / Half-Day status —
  those already encode their own pay penalty. No double-counting.
- **Pre-declared OT is a separate `declaredOtMins` field, NOT a widened shift window** —
  it must stay visible as OT so it can offset shortage.
- **Partial fulfillment** of declared OT leaves a shortage for the gap (see formula).
- **Sunday/holiday work needs an authorization flag** (admin called him in) — not auto on any
  punch, or employees self-grant OT by showing up.
- **WO is not auto-cancelled** by Sunday work and the employee need not show on Sunday —
  a WO debit can be cleared by **small OTs throughout the month**.
- **Working 5h to clear an 8h WO** → WO cleared, **3h shortage remains** (WO = 480 debit).
- **No lunch/break deduction** — `actual = lastOut − firstIn` (gross) is accepted.
- **Manual OT entry must be possible** for anomalies (e.g. missed punch but OT really happened —
  admin calls/confirms and sets that day's OT manually).
- Missed-punch (SLNF) days are fixed via the **regularization flow (to be built)**. If OT was
  offsetting a shortage and the punch is missing, the shortage stays unaffected (OT didn't happen).

## The core formula (CONFIRM exact)

Pre-declared OT widens the *expected-out* for shortage purposes, but the over-plan portion is
still credited as OT:

```
expected   = planned + declaredOT
shortage   = max(0, expected − actual)
OT(auto)   = min(declaredOT, max(0, actual − planned))
OT(pending → needs admin approval) = max(0, actual − expected)
```

Worked example — planned 10:00–18:00 (480), declared +30 → expected 510:
- out 18:30 (510): OT +30, shortage 0 ✓
- out 18:15 (495): OT +15, shortage 15 ✓ ("15 min shortage left")
- out 19:00 (540): OT +30 auto, **+30 new pending request** ✓

## Decisions (LOCKED 2026-06-29)

1. **WO semantics → paid day + debit.** A WO day is a **new paid status** counting **+1 in
   `daysNP`** (so the employee is paid for it) AND carries a **−480 min obligation** in the
   monthly ledger. Net effect: he keeps the WO day's pay only if he works it off via rest-day
   OT (−480 + 480 = 0); if unworked, the −480 claws the pay back → that day ends up unpaid.
   No double-docking. *(Today WO is non-functional — see "Key code finding" below.)*
2. **OT pay rate → straight 1×.** Net-positive minutes pay `(net minutes / 480) × salaryRate`.
   No Sunday/holiday premium. 1 OT min = 1 shortage min = same rupee value (clean 1:1 netting).
3. **Shortage deduction → symmetric 1×.** Net-negative minutes deduct at the same
   `(net minutes / 480) × salaryRate`.
4. **Grace window → none.** Exact to the minute, no buffer.
5. **Scope → operations only.** Office/admin stay fixed 8h with no ledger (unchanged).

### Key code finding (WO is vestigial today)
- There is **no "WO" attendance status** — statuses are only Present / SL / HalfDay / SLNF /
  Absent / PL / LWP (`attendance/page.tsx:98-120`).
- `users.woBalance` is a **manual number** shown on dashboards (`employee-dashboard/page.tsx:401`,
  `users/page.tsx:170`); **no function writes it and it has zero salary effect** (`daysNP` ignores WO).
- So a no-work day today is simply uncounted → **already effectively unpaid**. Implementing
  decision 1 means **adding a real paid WO status + automation** from near-scratch.

### Monthly payroll formula (the wiring)
```
payroll = (daysNP × salaryRate)                      # daysNP now INCLUDES WO as +1
        + (netLedgerMins / 480 × salaryRate)         # netLedgerMins may be negative (deduction)

netLedgerMins = Σ approvedOT(weekday, incl. auto-declared)
              + Σ authorizedOT(Sunday/holiday, all worked mins)
              − Σ shortage(Present days only)
              − Σ 480 per WO day
```
All pending (un-approved) OT must be resolved by the admin **before** the month is locked,
or it lapses (does not auto-credit).

## Robustness pieces to add regardless of the answers

- **Month-end lock + snapshot:** freeze a `settlements/{YYYY-MM}` record (every line item + net + who
  settled), make the period immutable; reopening is an audited action.
- **Manual entries survive recompute:** `declaredOtMins`, manual OT adjustments, WO links, and
  regularizations all need a `markedBy:'admin'` guard so the nightly job never clobbers them.
- **Distinguish "free Sunday weekly-off" from "owed WO"** in the data — opposite behaviors, must be
  different markers (not both "WO").
- **Every ledger line carries who/when/why** (extend the existing mandatory-reason rule on OT to WO links and manual adjustments).
- **Single source of truth:** make `daily_hours/{date}` canonical; the portal reads it for closed
  past days and only live-recomputes *today*.

## Architecture changes (planned)

1. **`daily_hours/{date}` becomes canonical.** Portal reads it for closed past days; live-recompute
   only for *today*. Removes the current dual-source drift.
2. **Pre-declared OT** = a `declaredOtMins` field on `planned_hours/{date}` (set by admin). Drives the
   core formula (auto-approve up to declared; flag beyond as pending).
3. **New paid WO status.** Add `'WO'` to the attendance-status set, paid ×1 in `daysNP`; nightly engine
   and the attendance page both recognize it. Marking a day WO writes a `−480` ledger debit for that month.
4. **New `users/{uid}/settlements/{YYYY-MM}`** — monthly snapshot: every ledger line, the net minutes,
   the cash/deduction amount, who settled, `locked` flag. Immutable after lock; reopen is audited.
5. **Sunday/holiday authorization flag** — all-hours-OT only when admin authorized (a `planned_hours`
   entry on that date, or an explicit flag), never on a bare punch.
6. **Manual OT entry / adjustment** path for anomalies (missed-punch days etc.), `markedBy:'admin'`,
   reason required, survives recompute.
7. **Payroll wiring** — `exportToSheets` Employee Dashboard tab + the portal dashboard add the
   `netLedgerMins/480 × salaryRate` line and count WO in `daysNP` (see formula above).
8. **Replace lifetime counters** (`users.approvedOtMins`, `users.shortageMins`) with per-month
   ledger aggregates (keep a lifetime sum only if wanted for history).

**Dependency:** the "shortage only after regularize-to-Present" rule needs the **regularization
flow**, which is *not yet built* — it should land before (or with) shortage going live in payroll.

## Suggested build order
1. Regularization flow (prerequisite).
2. Canonical `daily_hours` + portal reads it (kills drift) — low risk, independent.
3. `declaredOtMins` + the core per-day formula.
4. Paid WO status + ledger debit.
5. Sunday/holiday authorization + all-hours OT.
6. `settlements/{YYYY-MM}` + month lock + payroll wiring.
7. Manual OT entry + retire lifetime counters.

## Relevant code (current)

- Nightly engine: `functions/index.js:287-308` (shortage/OT per day → `daily_hours`, lifetime increment)
- Payroll math: `functions/index.js:710-753` (`daysNP × salaryRate`, no OT/shortage input)
- `approveOt` / `ot_approvals`: `src/lib/firestore.ts:329-360`
- OT & Shortage page (live recompute): `src/app/(admin)/ot-shortage/page.tsx`
- Types: `src/types/index.ts` (`User.approvedOtMins`, `User.shortageMins`, `OtApproval`, `PlannedHours`)
