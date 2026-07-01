// Standalone tests for the OT/shortage/WO ledger math. Run: npx tsx src/lib/otLedger.test.ts
import { computeDayLedger, netLedgerMins, istMinuteOfDay, WO_DEBIT_MINS, type DayLedger } from './otLedger';

let passed = 0;
let failed = 0;

function check(name: string, got: Partial<DayLedger>, want: Partial<DayLedger>) {
  const keys = Object.keys(want) as (keyof DayLedger)[];
  const ok = keys.every(k => got[k] === want[k]);
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else {
    failed++;
    console.log(`  ✗ ${name}`);
    keys.forEach(k => { if (got[k] !== want[k]) console.log(`      ${k}: got ${got[k]}, want ${want[k]}`); });
  }
}

function eq(name: string, got: number, want: number) {
  if (got === want) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}: got ${got}, want ${want}`); }
}

const START = 10 * 60;   // 10:00
const END   = 18 * 60;   // 18:00 (8h shift)
const DECLARED = 30;     // admin pre-declared 30 min OT
// Convenience: build a normal-day input from in/out minute-of-day.
const day = (inMin: number, outMin: number, declaredOtMins = 0) =>
  computeDayLedger({ shiftStartMin: START, shiftEndMin: END, inMin, outMin, declaredOtMins, isRestDay: false, otAuthorized: false });

console.log('Normal working day (shift 10:00–18:00):');
// Exactly on the window: no OT, no shortage.
check('in 10:00 out 18:00 → on time', day(START, END),
  { shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0 });
// Stayed 30 late with 30 declared → all auto-approved, no pending, no shortage.
check('out 18:30, declared 30 → +30 auto, 0 pending', day(START, END + 30, DECLARED),
  { autoOtMins: 30, pendingExtraMins: 0, shortageMins: 0 });
// Stayed 15 late of 30 declared → +15 auto, no pending.
check('out 18:15, declared 30 → +15 auto, 0 pending', day(START, END + 15, DECLARED),
  { autoOtMins: 15, pendingExtraMins: 0, shortageMins: 0 });
// Stayed 60 late, declared 30 → +30 auto, +30 pending.
check('out 19:00, declared 30 → +30 auto, +30 pending', day(START, END + 60, DECLARED),
  { autoOtMins: 30, pendingExtraMins: 30, shortageMins: 0 });
// Left 15 early → 15 shortage, no OT (declared is a ceiling on OT, not a shortage waiver).
check('out 17:45 → 15 shortage, 0 OT', day(START, END - 15, DECLARED),
  { shortageMins: 15, autoOtMins: 0, pendingExtraMins: 0 });
// Stayed 60 late with NO declaration → all pending.
check('out 19:00, no declaration → 0 auto, +60 pending', day(START, END + 60, 0),
  { autoOtMins: 0, pendingExtraMins: 60, shortageMins: 0 });

console.log('\nEdges: early-in earns NOTHING; only late-out is OT:');
// Came 10 early AND left 4 early → early-in ignored, 4 shortage, 0 OT. (devendra)
check('in 09:50 out 17:56 → 0 OT + 4 shortage', day(START - 10, END - 4, 0),
  { pendingExtraMins: 0, shortageMins: 4, autoOtMins: 0 });
// Came an hour early, left exactly on time → nothing at all.
check('in 09:00 out 18:00 → 0 OT, 0 shortage', day(START - 60, END, 0),
  { pendingExtraMins: 0, autoOtMins: 0, shortageMins: 0 });
// Came 20 late AND left 30 late → 20 shortage (late-in) AND 30 OT (late-out), independent.
check('in 10:20 out 18:30 → 20 shortage + 30 OT', day(START + 20, END + 30, 0),
  { shortageMins: 20, pendingExtraMins: 30 });
// Came 15 early AND left 15 late → early-in ignored, only 15 late-out OT.
check('in 09:45 out 18:15 → 15 OT (late-out only), 0 shortage', day(START - 15, END + 15, 0),
  { pendingExtraMins: 15, shortageMins: 0 });

console.log('\nRest day (Sunday/holiday):');
// Authorized → every worked minute is auto-approved OT (out − in), no shortage.
check('authorized, 10:00–15:00 → +300 rest-day OT',
  computeDayLedger({ shiftStartMin: 0, shiftEndMin: 0, inMin: START, outMin: 15 * 60, declaredOtMins: 0, isRestDay: true, otAuthorized: true }),
  { restDayOtMins: 300, shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, unauthorizedRestDay: false });
// Not authorized → 0 OT, flagged, no shortage.
check('unauthorized, 10:00–15:00 → 0 OT, flagged',
  computeDayLedger({ shiftStartMin: 0, shiftEndMin: 0, inMin: START, outMin: 15 * 60, declaredOtMins: 0, isRestDay: true, otAuthorized: false }),
  { restDayOtMins: 0, unauthorizedRestDay: true, shortageMins: 0 });
// Rest day ignores any shift window.
check('rest day ignores shift (authorized 10:00–20:00)',
  computeDayLedger({ shiftStartMin: START, shiftEndMin: END, inMin: START, outMin: 20 * 60, declaredOtMins: 0, isRestDay: true, otAuthorized: true }),
  { restDayOtMins: 600, shortageMins: 0 });

console.log('\nNo shift, not a rest day:');
check('no shift → nothing accrues',
  computeDayLedger({ shiftStartMin: 0, shiftEndMin: 0, inMin: START, outMin: END, declaredOtMins: 0, isRestDay: false, otAuthorized: false }),
  { shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, restDayOtMins: 0 });

console.log('\nistMinuteOfDay (epoch secs → IST minute-of-day):');
eq('2026-06-01 09:50 IST → 590', istMinuteOfDay(Math.floor(new Date('2026-06-01T09:50:00+05:30').getTime() / 1000)), 590);
eq('2026-06-01 17:56 IST → 1076', istMinuteOfDay(Math.floor(new Date('2026-06-01T17:56:00+05:30').getTime() / 1000)), 17 * 60 + 56);

console.log('\nNet ledger:');
eq('prior shortage 30, +15 OT → net -15', netLedgerMins({ autoOtMins: 15, restDayOtMins: 0, approvedGrantedMins: 0, shortageMins: 30, woDebitMins: 0 }), -15);
eq('1 WO day, no OT → net -480', netLedgerMins({ autoOtMins: 0, restDayOtMins: 0, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), -480);
eq('1 WO day + 480 rest-day OT → net 0', netLedgerMins({ autoOtMins: 0, restDayOtMins: 480, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), 0);
eq('1 WO day + 300 rest-day OT → net -180', netLedgerMins({ autoOtMins: 0, restDayOtMins: 300, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), -180);
eq('mixed → +90', netLedgerMins({ autoOtMins: 60, restDayOtMins: 480, approvedGrantedMins: 120, shortageMins: 90, woDebitMins: 480 }), 90);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
