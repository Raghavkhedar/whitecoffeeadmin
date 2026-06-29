// Pure OT / shortage / WO ledger math — the single source of truth shared by the
// OT/Shortage page, the Employee Dashboard, and (later) the payroll settlement.
//
// All values are MINUTES. Functions are pure (no Firestore/React) so they can be
// unit-tested in isolation. See docs/ot-shortage-design.md for the model.

export const WO_DEBIT_MINS = 8 * 60; // a WO (paid no-work day off) owes a standard 8h

export interface DayLedgerInput {
  plannedMins: number;    // shift-window duration for the day; 0 if no shift
  declaredOtMins: number; // admin pre-declared OT for the day (pre-approval ceiling)
  actualMins: number;     // worked minutes = last out − first in (≥ 0)
  isRestDay: boolean;     // Sunday or company holiday
  otAuthorized: boolean;  // admin authorized rest-day work (only meaningful on a rest day)
}

export interface DayLedger {
  shortageMins: number;       // max(0, planned − actual); never on a rest day
  autoOtMins: number;         // declared OT actually worked (auto-approved) = min(surplus, declared)
  pendingExtraMins: number;   // OT beyond declared → needs admin review
  restDayOtMins: number;      // all worked minutes on an authorized rest day (auto-approved)
  unauthorizedRestDay: boolean; // worked a rest day with no authorization → 0 OT credited
}

const ZERO: DayLedger = {
  shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, restDayOtMins: 0, unauthorizedRestDay: false,
};

// Per-day ledger for one operations worked day (both check-in and check-out present).
// Declared OT is a pre-approval CEILING, not an obligation: shortage is measured against the
// plain shift, and leaving early never manufactures extra shortage.
export function computeDayLedger(i: DayLedgerInput): DayLedger {
  const actual = Math.max(0, i.actualMins);

  if (i.isRestDay) {
    // Sunday/holiday: every worked minute is OT, but only when admin-authorized.
    if (i.otAuthorized) return { ...ZERO, restDayOtMins: actual };
    return { ...ZERO, unauthorizedRestDay: true };
  }

  if (i.plannedMins > 0) {
    const surplus = Math.max(0, actual - i.plannedMins);
    const declared = Math.max(0, i.declaredOtMins);
    return {
      ...ZERO,
      shortageMins: Math.max(0, i.plannedMins - actual),
      autoOtMins: Math.min(surplus, declared),
      pendingExtraMins: Math.max(0, surplus - declared),
    };
  }

  // No shift and not a rest day (e.g. ops with no plan) → nothing accrues.
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
