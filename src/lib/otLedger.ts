// Pure OT / shortage / WO ledger math — the single source of truth shared by the
// OT/Shortage page, the Employee Dashboard, and (later) the payroll settlement.
//
// All values are MINUTES. Functions are pure (no Firestore/React) so they can be
// unit-tested in isolation. See docs/ot-shortage-design.md for the model.

export const WO_DEBIT_MINS = 8 * 60; // a WO (paid no-work day off) owes a standard 8h

// Default operations shift (10:00–18:00) used when no valid plan exists for a worked day.
export const DEFAULT_SHIFT_START_MIN = 10 * 60; // 10:00
export const DEFAULT_SHIFT_END_MIN   = 18 * 60; // 18:00

// Epoch seconds → IST (UTC+5:30, no DST) minute-of-day in [0, 1439].
export function istMinuteOfDay(epochSecs: number): number {
  const IST_OFFSET = 5.5 * 3600;
  return Math.floor(((((epochSecs + IST_OFFSET) % 86400) + 86400) % 86400) / 60);
}

export interface DayLedgerInput {
  shiftStartMin: number;  // shift window start, IST minute-of-day (use start==end for "no shift")
  shiftEndMin: number;    // shift window end, IST minute-of-day
  inMin: number;          // actual first-in, IST minute-of-day
  outMin: number;         // actual last-out, IST minute-of-day
  declaredOtMins: number; // admin pre-declared OT for the day (auto-approval ceiling)
  isRestDay: boolean;     // Sunday or company holiday
  otAuthorized: boolean;  // admin authorized rest-day work (only meaningful on a rest day)
}

export interface DayLedger {
  shortageMins: number;       // late-in + early-out (each edge scored on its own); never on a rest day
  autoOtMins: number;         // declared OT actually worked (auto-approved) = min(otEarned, declared)
  pendingExtraMins: number;   // OT beyond declared → needs admin review
  restDayOtMins: number;      // all worked minutes on an authorized rest day (auto-approved)
  unauthorizedRestDay: boolean; // worked a rest day with no authorization → 0 OT credited
}

const ZERO: DayLedger = {
  shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, restDayOtMins: 0, unauthorizedRestDay: false,
};

// Per-day ledger for one operations worked day (both check-in and check-out present).
//
// Each shift edge is scored against the plain window and edges never cancel each other:
//   • checking in  before shift start → nothing (arriving early NEVER earns OT); after → shortage (late-in)
//   • checking out after  shift end   → OT (late-out);  before → shortage (early-out)
// So the ONLY source of OT on a normal day is staying past shift end. Declared OT is a pre-approval
// CEILING on that OT (auto up to declared, beyond is pending) — it never changes shortage.
export function computeDayLedger(i: DayLedgerInput): DayLedger {
  const worked = Math.max(0, i.outMin - i.inMin);

  if (i.isRestDay) {
    // Sunday/holiday: every worked minute is OT, but only when admin-authorized.
    if (i.otAuthorized) return { ...ZERO, restDayOtMins: worked };
    return { ...ZERO, unauthorizedRestDay: true };
  }

  if (i.shiftEndMin > i.shiftStartMin) {
    const lateIn   = Math.max(0, i.inMin - i.shiftStartMin);   // came late → shortage
    const earlyOut = Math.max(0, i.shiftEndMin - i.outMin);    // left early → shortage
    const otEarned = Math.max(0, i.outMin - i.shiftEndMin);    // left late → OT (early-in earns nothing)
    const declared = Math.max(0, i.declaredOtMins);
    return {
      ...ZERO,
      shortageMins: lateIn + earlyOut,
      autoOtMins: Math.min(otEarned, declared),
      pendingExtraMins: Math.max(0, otEarned - declared),
    };
  }

  // No shift and not a rest day → nothing accrues.
  return { ...ZERO };
}

export interface NetLedgerParts {
  autoOtMins: number;        // declared, auto-approved
  restDayOtMins: number;     // authorized rest-day OT, auto-approved
  approvedGrantedMins: number; // admin-granted OT (beyond-declared) via ot_approvals
  shortageMins: number;
  woDebitMins: number;       // (number of WO days) × WO_DEBIT_MINS
}

// Monthly/range net: approved OT (auto + rest-day + granted) minus shortage minus WO debit.
// Pending (un-approved) OT is intentionally excluded — it isn't credited until approved.
export function netLedgerMins(p: NetLedgerParts): number {
  return (p.autoOtMins + p.restDayOtMins + p.approvedGrantedMins) - p.shortageMins - p.woDebitMins;
}
