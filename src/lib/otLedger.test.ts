// Standalone tests for the OT/shortage/WO ledger math. Run: npx tsx src/lib/otLedger.test.ts
import { computeDayLedger, netLedgerMins, WO_DEBIT_MINS, type DayLedger } from './otLedger';

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

const PLANNED = 480;   // 8h shift
const DECLARED = 30;   // admin pre-declared 30 min OT

console.log('Normal working day (shift 480, declared 30):');
// Out exactly at shift end: no OT, no shortage.
check('worked 480 → on time', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: 0, actualMins: 480, isRestDay: false, otAuthorized: false }),
  { shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0 });
// Worked exactly the declared OT → all auto-approved, no pending, no shortage.
check('480+30 declared → +30 auto, 0 pending, 0 shortage', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: DECLARED, actualMins: 510, isRestDay: false, otAuthorized: false }),
  { autoOtMins: 30, pendingExtraMins: 0, shortageMins: 0 });
// Partial declared (worked 15 of 30): +15 auto, NO new shortage (key correctness case).
check('495 (15 of 30 declared) → +15 auto, 0 pending, 0 shortage', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: DECLARED, actualMins: 495, isRestDay: false, otAuthorized: false }),
  { autoOtMins: 15, pendingExtraMins: 0, shortageMins: 0 });
// Beyond declared (worked 60, declared 30): +30 auto, +30 pending review.
check('540 (declared 30) → +30 auto, +30 pending', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: DECLARED, actualMins: 540, isRestDay: false, otAuthorized: false }),
  { autoOtMins: 30, pendingExtraMins: 30, shortageMins: 0 });
// Left before shift end: shortage vs the plain shift, no OT.
check('465 (under shift) → 15 shortage, 0 OT', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: DECLARED, actualMins: 465, isRestDay: false, otAuthorized: false }),
  { shortageMins: 15, autoOtMins: 0, pendingExtraMins: 0 });
// Overtime with NO declaration: all surplus is pending review (nothing auto).
check('540 (no declaration) → 0 auto, +60 pending', computeDayLedger({ plannedMins: PLANNED, declaredOtMins: 0, actualMins: 540, isRestDay: false, otAuthorized: false }),
  { autoOtMins: 0, pendingExtraMins: 60, shortageMins: 0 });

console.log('\nRest day (Sunday/holiday):');
// Authorized → every worked minute is auto-approved OT, no shortage.
check('authorized, worked 300 → +300 rest-day OT', computeDayLedger({ plannedMins: 0, declaredOtMins: 0, actualMins: 300, isRestDay: true, otAuthorized: true }),
  { restDayOtMins: 300, shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, unauthorizedRestDay: false });
// Not authorized → 0 OT, flagged as unauthorized (no shortage either).
check('unauthorized, worked 300 → 0 OT, flagged', computeDayLedger({ plannedMins: 0, declaredOtMins: 0, actualMins: 300, isRestDay: true, otAuthorized: false }),
  { restDayOtMins: 0, unauthorizedRestDay: true, shortageMins: 0 });
// Rest day takes priority even if a shift somehow exists.
check('rest day ignores any shift (authorized 600)', computeDayLedger({ plannedMins: 480, declaredOtMins: 0, actualMins: 600, isRestDay: true, otAuthorized: true }),
  { restDayOtMins: 600, shortageMins: 0 });

console.log('\nNo shift, not a rest day (ops, no plan):');
check('no plan → nothing accrues', computeDayLedger({ plannedMins: 0, declaredOtMins: 0, actualMins: 400, isRestDay: false, otAuthorized: false }),
  { shortageMins: 0, autoOtMins: 0, pendingExtraMins: 0, restDayOtMins: 0 });

console.log('\nNet ledger:');
// "Offset a pre-existing shortage" story: prior 30 shortage, today +15 auto OT → net -15.
eq('prior shortage 30, +15 OT → net -15', netLedgerMins({ autoOtMins: 15, restDayOtMins: 0, approvedGrantedMins: 0, shortageMins: 30, woDebitMins: 0 }), -15);
// WO debit: one WO day unworked → -480.
eq('1 WO day, no OT → net -480', netLedgerMins({ autoOtMins: 0, restDayOtMins: 0, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), -480);
// WO worked off by a full rest-day shift → net 0.
eq('1 WO day + 480 rest-day OT → net 0', netLedgerMins({ autoOtMins: 0, restDayOtMins: 480, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), 0);
// WO worked off only 5h (300) → net -180 (the 3h shortage from your example).
eq('1 WO day + 300 rest-day OT → net -180', netLedgerMins({ autoOtMins: 0, restDayOtMins: 300, approvedGrantedMins: 0, shortageMins: 0, woDebitMins: WO_DEBIT_MINS }), -180);
// Mixed: 60 auto + 120 granted + 480 rest-day − 90 shortage − 480 WO → +90.
eq('mixed → +90', netLedgerMins({ autoOtMins: 60, restDayOtMins: 480, approvedGrantedMins: 120, shortageMins: 90, woDebitMins: 480 }), 90);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
