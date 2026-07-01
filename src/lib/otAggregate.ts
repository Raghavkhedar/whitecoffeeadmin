// Range/month-level OT/shortage/WO aggregation for one ops employee, built on the pure
// per-day `computeDayLedger`. Used by the Settlements page (and unit-tested via tsx — the
// domain types below are `import type`, so they're erased at runtime).

import type { AttendanceRecord, PlannedHours, OtApproval, AttendanceStatus } from '@/types';
import {
  computeDayLedger, netLedgerMins, WO_DEBIT_MINS, istMinuteOfDay,
  DEFAULT_SHIFT_START_MIN, DEFAULT_SHIFT_END_MIN,
} from './otLedger';

const OPS_IN_TYPES  = new Set(['site_in', 'market_in']);
const OPS_OUT_TYPES = new Set(['site_out', 'market_out']);

function tsSeconds(e: AttendanceRecord): number {
  return (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
}
function hhmmToMinutes(s?: string): number {
  if (!s) return 0;
  const [h, m] = s.split(':').map(Number);
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}
function isSunday(date: string): boolean {
  return new Date(date + 'T12:00:00').getDay() === 0;
}

export interface RangeLedger {
  autoOtMins: number;
  restDayOtMins: number;
  grantedOtMins: number;          // sum of approvedMins across ot_approvals decisions
  shortageMins: number;
  woDates: string[];
  woDebitMins: number;
  netMins: number;                // (auto + restDay + granted) − shortage − woDebit
  pendingDates: string[];         // un-decided pending OT days (block settlement)
  pendingOtMins: number;
  unauthorizedRestDates: string[];// rest days worked without authorization (block settlement)
}

// Aggregate one ops employee's ledger over already-fetched arrays for a date range/month.
export function computeRangeLedger(
  userId: string,
  events: AttendanceRecord[],
  planned: PlannedHours[],
  approvals: OtApproval[],
  statuses: AttendanceStatus[],
  holidays: Set<string>,
): RangeLedger {
  // Only windows with end > start are valid; an inverted/zero window (e.g. a mis-entered
  // "06:00" end) is treated as no plan → the worked day falls back to the default 10:00–18:00.
  const plannedByDate = new Map<string, { startMin: number; endMin: number; declared: number }>();
  const otAuthByDate = new Set<string>();
  planned.filter(p => p.userId === userId).forEach(p => {
    const startMin = hhmmToMinutes(p.startTime), endMin = hhmmToMinutes(p.endTime);
    if (endMin > startMin) plannedByDate.set(p.date, { startMin, endMin, declared: Math.max(0, p.declaredOtMins ?? 0) });
    if (p.otAuthorized) otAuthByDate.add(p.date);
  });

  const eventsByDate = new Map<string, AttendanceRecord[]>();
  events.filter(e => e.userId === userId).forEach(e => {
    if (!eventsByDate.has(e.date)) eventsByDate.set(e.date, []);
    eventsByDate.get(e.date)!.push(e);
  });

  const apprByDate = new Map<string, OtApproval>();
  approvals.filter(a => a.userId === userId).forEach(a => apprByDate.set(a.date, a));

  // Regularized-to-Present days carry an effective in/out captured by the admin (missed-punch
  // fix). These override raw events for the date so the corrected day can carry shortage/OT.
  const overrideByDate = new Map<string, { inMin: number; outMin: number }>(); // date → effective in/out (IST min-of-day)
  statuses.filter(s => s.userId === userId && s.status === 'Present' && s.inTime && s.outTime).forEach(s => {
    const inMin = hhmmToMinutes(s.inTime), outMin = hhmmToMinutes(s.outTime);
    if (outMin > inMin) overrideByDate.set(s.date, { inMin, outMin });
  });

  let autoOtMins = 0, restDayOtMins = 0, shortageMins = 0, pendingOtMins = 0;
  const pendingDates: string[] = [];
  const unauthorizedRestDates: string[] = [];

  const accrueDay = (date: string, inMin: number, outMin: number) => {
    const info = plannedByDate.get(date);
    const led = computeDayLedger({
      shiftStartMin: info?.startMin ?? DEFAULT_SHIFT_START_MIN,
      shiftEndMin:   info?.endMin   ?? DEFAULT_SHIFT_END_MIN,
      inMin, outMin,
      declaredOtMins: info?.declared ?? 0,
      isRestDay: isSunday(date) || holidays.has(date),
      otAuthorized: otAuthByDate.has(date),
    });
    shortageMins   += led.shortageMins;
    autoOtMins     += led.autoOtMins;
    restDayOtMins  += led.restDayOtMins;
    if (led.pendingExtraMins > 0 && !apprByDate.has(date)) { pendingOtMins += led.pendingExtraMins; pendingDates.push(date); }
    if (led.unauthorizedRestDay) unauthorizedRestDates.push(date);
  };

  eventsByDate.forEach((dayEvents, date) => {
    if (overrideByDate.has(date)) return; // regularization in/out is authoritative for this date
    const ins  = dayEvents.filter(e => OPS_IN_TYPES.has(e.type));
    const outs = dayEvents.filter(e => OPS_OUT_TYPES.has(e.type));
    if (ins.length === 0) return;
    const firstIn = Math.min(...ins.map(tsSeconds));
    const lastOut = outs.length ? Math.max(...outs.map(tsSeconds)) : null;
    if (lastOut === null || lastOut <= firstIn) return; // open/invalid day

    accrueDay(date, istMinuteOfDay(firstIn), istMinuteOfDay(lastOut));
  });

  overrideByDate.forEach(({ inMin, outMin }, date) => accrueDay(date, inMin, outMin));

  const grantedOtMins = Array.from(apprByDate.values()).reduce((s, a) => s + (Number(a.approvedMins) || 0), 0);
  const woDates = statuses.filter(s => s.userId === userId && s.status === 'WO').map(s => s.date).sort();
  const woDebitMins = woDates.length * WO_DEBIT_MINS;
  const netMins = netLedgerMins({ autoOtMins, restDayOtMins, approvedGrantedMins: grantedOtMins, shortageMins, woDebitMins });

  return {
    autoOtMins, restDayOtMins, grantedOtMins, shortageMins,
    woDates, woDebitMins, netMins,
    pendingDates: pendingDates.sort(), pendingOtMins,
    unauthorizedRestDates: unauthorizedRestDates.sort(),
  };
}

// Settlement cash added to payroll TOTAL DUE: WO paid days + net OT/shortage at the straight
// per-minute rate (salaryRate/480). netMins already includes the −480 per WO day, so an
// unworked WO nets to 0 (paid +rate, debited −rate) and a worked-off WO keeps the +rate.
export function settlementCash(salaryRate: number, woDays: number, netMins: number): number {
  const cash = woDays * salaryRate + (netMins / WO_DEBIT_MINS) * salaryRate;
  return Math.round(cash * 100) / 100;
}
