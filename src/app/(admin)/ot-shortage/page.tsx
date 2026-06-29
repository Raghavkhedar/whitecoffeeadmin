'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getAllUsers, getAttendanceForDateRange, getPlannedHoursForDateRange, getOtApprovalsForDateRange, getHolidaysForDateRange, getAttendanceStatusForDateRange, approveOt, rejectOt } from '@/lib/firestore';
import type { User, AttendanceRecord, PlannedHours, OtApproval, Holiday, AttendanceStatus } from '@/types';
import { RoleBadge } from '@/components/ui';
import ExportButton from '@/components/ExportButton';
import { downloadSheet } from '@/lib/excel';
import { istTodayStr, istDaysAgoStr } from '@/lib/date';

// ── Date range helpers ────────────────────────────────────────────────────────

type Preset = 'custom' | '1d' | '7d' | '15d' | '30d' | '90d' | '180d' | '365d';

const PRESETS: { key: Preset; label: string; days: number | null }[] = [
  { key: '1d',    label: 'Today',        days: 1   },
  { key: '7d',    label: 'Last 7 Days',  days: 7   },
  { key: '15d',   label: 'Last 15 Days', days: 15  },
  { key: '30d',   label: 'Last Month',   days: 30  },
  { key: '90d',   label: 'Last 3 Months',days: 90  },
  { key: '180d',  label: 'Last 6 Months',days: 180 },
  { key: '365d',  label: 'Last Year',    days: 365 },
  { key: 'custom', label: 'Custom Range', days: null },
];

function todayStr() {
  return istTodayStr();
}

function nDaysAgo(n: number): string {
  return istDaysAgoStr(n);
}

function dateRangeFromPreset(preset: Preset, customStart: string, customEnd: string): { start: string; end: string } {
  if (preset === 'custom') return { start: customStart, end: customEnd };
  if (preset === '1d') return { start: todayStr(), end: todayStr() };
  const p = PRESETS.find(p => p.key === preset)!;
  return { start: nDaysAgo(p.days!), end: todayStr() };
}

function formatDateRange(start: string, end: string): string {
  const fmt = (s: string) =>
    new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

function fmtDay(s: string): string {
  return new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Count Mon–Sat days (no Sundays, no company holidays) in a date range, inclusive.
function countWorkingDays(start: string, end: string, holidays: Set<string>): number {
  let count = 0;
  const d = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  while (d <= e) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (d.getDay() !== 0 && !holidays.has(ds)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ── Hour computation helpers ──────────────────────────────────────────────────

function hhmmToMinutes(s?: string): number {
  if (!s) return 0;
  const [h, m] = s.split(':').map(Number);
  return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
}

function minutesToDisplay(mins: number): string {
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function tsSeconds(e: AttendanceRecord): number {
  return (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
}

function formatTime(secs: number): string {
  return new Date(secs * 1000).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}

// "18:30" → "6:30 PM"; returns '' for blank/invalid input.
function fmtHHMM(hhmm?: string): string {
  if (!hhmm || !hhmm.includes(':')) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const OFFICE_DAY_MINS = 8 * 60;
const WO_DEBIT_MINS = 8 * 60; // a WO (paid no-work day off) owes a standard 8h, payable by OT

// Field-work event types for operations (home events excluded — commute bookends)
const OPS_IN_TYPES  = new Set(['site_in', 'market_in']);
const OPS_OUT_TYPES = new Set(['site_out', 'market_out']);

// ── Per-employee aggregation ──────────────────────────────────────────────────

interface DayDetail {
  date: string;
  plannedMins: number;      // shift window
  plannedStart: string;     // shift start "HH:MM" (ops) — '' if none
  plannedEnd: string;       // shift end "HH:MM" (ops) — '' if none
  declaredOtMins: number;   // admin pre-declared OT for the day
  actualMins: number;
  autoOtMins: number;       // pre-authorized OT actually worked = min(surplus, declared) → no review
  pendingExtraMins: number; // surplus beyond declared → needs admin review
  shortageMins: number;     // max(0, planned − actual) — measured vs the plain shift
  firstInSecs: number;
  lastOutSecs: number;
}

interface EmpRow {
  user: User;
  isOps: boolean;
  workingMins: number | null;  // expected (ops: planned windows; office/admin: 8h × working days)
  actualMins: number | null;   // null = no worked days
  firstInSecs: number | null;  // earliest in across range (for single-day view)
  lastOutSecs: number | null;  // latest out across range
  workedDays: DayDetail[];     // every fully-worked day, with check-in/out
  // OT/shortage — operations only
  shortageRangeMins: number;
  pendingOt: DayDetail[];      // days with surplus beyond declared, not yet approved
  pendingOtMins: number;
  autoOtRangeMins: number;     // pre-authorized (declared) OT worked in range — counts as approved
  approvedInRange: OtApproval[];
  approvedOtRangeMins: number; // approved via ot_approvals docs (the beyond-declared grants)
  shortageDays: DayDetail[];
  // WO (paid no-work day off) — operations only
  woDates: string[];           // dates marked WO in range
  woDebitMins: number;         // woDates.length × WO_DEBIT_MINS
  netLedgerMins: number;       // (autoOt + approvedOt) − shortage − woDebit; pending OT excluded
}

function aggregateForEmployee(
  user: User,
  allEvents: AttendanceRecord[],
  plannedItems: PlannedHours[],
  approvals: OtApproval[],
  statuses: AttendanceStatus[],
  start: string,
  end: string,
  holidays: Set<string>,
): EmpRow {
  const isOps = user.role === 'operations';
  const userEvents = allEvents.filter(e => e.userId === user.id);

  // Planned shift + declared-OT minutes per date (ops use admin-set windows)
  const plannedByDate = new Map<string, { planned: number; declared: number; startTime: string; endTime: string }>();
  plannedItems.filter(p => p.userId === user.id).forEach(p => {
    const dur = hhmmToMinutes(p.endTime) - hhmmToMinutes(p.startTime);
    if (dur > 0) plannedByDate.set(p.date, { planned: dur, declared: Math.max(0, p.declaredOtMins ?? 0), startTime: p.startTime, endTime: p.endTime });
  });

  let workingMins: number | null;
  if (isOps) {
    let total = 0;
    plannedByDate.forEach(d => { total += d.planned; }); // expected = shift windows only (declared OT is overtime)
    workingMins = total > 0 ? total : null;
  } else {
    workingMins = countWorkingDays(start, end, holidays) * OFFICE_DAY_MINS;
  }

  // Group events per day
  const eventsByDate = new Map<string, AttendanceRecord[]>();
  userEvents.forEach(e => {
    if (!eventsByDate.has(e.date)) eventsByDate.set(e.date, []);
    eventsByDate.get(e.date)!.push(e);
  });

  let totalActualMins = 0;
  let hasAnyActual = false;
  let shortageRangeMins = 0;
  let autoOtRangeMins = 0;
  const otDays: DayDetail[] = [];
  const shortageDays: DayDetail[] = [];
  const workedDays: DayDetail[] = [];
  let globalFirstIn: number | null = null;
  let globalLastOut: number | null = null;

  eventsByDate.forEach((dayEvents, date) => {
    const inEvents  = dayEvents.filter(e => isOps ? OPS_IN_TYPES.has(e.type)  : e.type === 'office_in');
    const outEvents = dayEvents.filter(e => isOps ? OPS_OUT_TYPES.has(e.type) : e.type === 'office_out');
    if (inEvents.length === 0) return; // no check-in → nothing to show

    const firstIn = Math.min(...inEvents.map(tsSeconds));
    const lastOut = outEvents.length ? Math.max(...outEvents.map(tsSeconds)) : null;
    if (globalFirstIn === null || firstIn < globalFirstIn) globalFirstIn = firstIn;

    // Open day — checked in but not yet checked out. Final hours can't be measured,
    // so it never counts toward totals / OT / shortage, but the check-in time stays
    // visible (shown as "in progress" in the single-day view).
    if (lastOut === null || lastOut <= firstIn) return;

    const dayMins = Math.round((lastOut - firstIn) / 60);
    totalActualMins += dayMins;
    hasAnyActual = true;

    if (globalLastOut === null || lastOut > globalLastOut) globalLastOut = lastOut;

    const planInfo    = isOps ? plannedByDate.get(date) : { planned: OFFICE_DAY_MINS, declared: 0, startTime: '10:00', endTime: '18:00' };
    const plannedDay  = planInfo?.planned ?? 0;
    const declaredDay = planInfo?.declared ?? 0;
    const detail: DayDetail = {
      date, plannedMins: plannedDay, plannedStart: planInfo?.startTime ?? '', plannedEnd: planInfo?.endTime ?? '',
      declaredOtMins: declaredDay, actualMins: dayMins,
      autoOtMins: 0, pendingExtraMins: 0, shortageMins: 0, firstInSecs: firstIn, lastOutSecs: lastOut,
    };

    // OT / shortage only for operations, and only on days with an expected window.
    // Holidays carry no window → worked hours still count, but no OT/shortage.
    // Declared OT is a pre-approval ceiling, NOT an obligation: shortage is measured vs the
    // plain shift; OT worked up to the declared amount is auto-approved, beyond it needs review.
    if (isOps && !holidays.has(date) && plannedDay > 0) {
      const surplus = Math.max(0, dayMins - plannedDay);
      detail.shortageMins     = Math.max(0, plannedDay - dayMins);
      detail.autoOtMins       = Math.min(surplus, declaredDay);
      detail.pendingExtraMins = Math.max(0, surplus - declaredDay);

      if (detail.shortageMins > 0) {
        shortageRangeMins += detail.shortageMins;
        shortageDays.push(detail);
      }
      if (detail.autoOtMins > 0) autoOtRangeMins += detail.autoOtMins;
      if (detail.pendingExtraMins > 0) otDays.push(detail);
    }
    workedDays.push(detail);
  });

  const approvedByDate = new Map<string, OtApproval>();
  approvals.filter(a => a.userId === user.id).forEach(a => approvedByDate.set(a.date, a));

  const pendingOt = otDays.filter(d => !approvedByDate.has(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  const pendingOtMins = pendingOt.reduce((s, d) => s + d.pendingExtraMins, 0);
  const approvedInRange = Array.from(approvedByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const approvedOtRangeMins = approvedInRange.reduce((s, a) => s + (a.approvedMins || 0), 0);

  // WO debit (ops only): each WO-marked day owes a standard 8h, payable by OT this month.
  const woDates = isOps
    ? statuses.filter(s => s.userId === user.id && s.status === 'WO').map(s => s.date).sort()
    : [];
  const woDebitMins = woDates.length * WO_DEBIT_MINS;

  // Net ledger for the range: approved OT (auto + granted) minus shortage minus WO debit.
  // Pending OT is excluded (not credited until approved). Informational only — no payroll effect yet.
  const netLedgerMins = isOps
    ? (autoOtRangeMins + approvedOtRangeMins) - shortageRangeMins - woDebitMins
    : 0;

  return {
    user,
    isOps,
    workingMins,
    actualMins: hasAnyActual ? totalActualMins : null,
    firstInSecs: globalFirstIn,
    lastOutSecs: globalLastOut,
    workedDays: workedDays.sort((a, b) => a.date.localeCompare(b.date)),
    shortageRangeMins,
    pendingOt,
    pendingOtMins,
    autoOtRangeMins,
    approvedInRange,
    approvedOtRangeMins,
    shortageDays: shortageDays.sort((a, b) => a.date.localeCompare(b.date)),
    woDates,
    woDebitMins,
    netLedgerMins,
  };
}

// ── Drill-in modal: OT review/approval + shortage (ops) and worked days ────────

function DetailModal({ row, adminName, onClose, onApproved }: {
  row: EmpRow;
  adminName: string;
  onClose: () => void;
  onApproved: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, { mins: string; reason: string }>>(() => {
    const init: Record<string, { mins: string; reason: string }> = {};
    row.pendingOt.forEach(d => { init[d.date] = { mins: String(d.pendingExtraMins), reason: '' }; });
    return init;
  });
  const [saving, setSaving] = useState('');
  const [error, setError]   = useState('');

  function set(date: string, field: 'mins' | 'reason', value: string) {
    setDrafts(prev => ({ ...prev, [date]: { ...prev[date], [field]: value } }));
  }

  async function approve(day: DayDetail) {
    const draft = drafts[day.date];
    // Grant is capped at the beyond-declared OT for the day — admin may approve less, never more.
    // (The declared portion is already auto-approved and not part of this grant.)
    const mins  = Math.min(day.pendingExtraMins, Math.max(0, Math.round(Number(draft.mins) || 0)));
    if (!draft.reason.trim()) { setError('A reason is required to approve overtime.'); return; }
    setError('');
    setSaving(day.date);
    try {
      await approveOt(row.user, day.date, day.pendingExtraMins, mins, draft.reason.trim(), adminName);
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve. Try again.');
    }
    setSaving('');
  }

  async function reject(day: DayDetail) {
    const draft = drafts[day.date];
    if (!draft.reason.trim()) { setError('A reason is required to reject overtime.'); return; }
    setError('');
    setSaving(day.date);
    try {
      await rejectOt(row.user, day.date, day.pendingExtraMins, draft.reason.trim(), adminName);
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reject. Try again.');
    }
    setSaving('');
  }

  const lifetimeOt = row.user.approvedOtMins ?? 0;
  const lifetimeShortage = row.user.shortageMins ?? 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-text-primary">{row.user.name}</h2>
              <RoleBadge role={row.user.role} />
            </div>
            <p className="text-xs text-text-secondary mt-0.5 font-mono">
              {row.user.employeeId}
              {row.isOps && <> · Lifetime OT <span className="text-[#0A7A50] font-semibold">{minutesToDisplay(lifetimeOt)}</span> · Lifetime shortage <span className="text-[#C42B2B] font-semibold">{minutesToDisplay(lifetimeShortage)}</span></>}
            </p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5">
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</p>}

          {/* Net ledger for the range (operations only) — informational, no payroll effect yet */}
          {row.isOps && (
            <div className="flex items-center justify-between bg-[#FBFAF8] border border-[#F0EEEB] rounded-xl px-4 py-3">
              <div className="text-sm text-text-secondary">Net ledger (range) · approved OT − shortage − WO</div>
              <div className={`text-lg font-bold font-mono ${row.netLedgerMins < 0 ? 'text-[#C42B2B]' : 'text-[#0A7A50]'}`}>
                {row.netLedgerMins < 0 ? '-' : '+'}{minutesToDisplay(row.netLedgerMins)}
              </div>
            </div>
          )}

          {/* Pending overtime — actionable (operations only) */}
          {row.isOps && (
            <div>
              <div className="label mb-2">Pending overtime · {row.pendingOt.length} day{row.pendingOt.length === 1 ? '' : 's'}</div>
              {row.pendingOt.length === 0 ? (
                <p className="text-sm text-text-secondary py-2">No pending overtime to review in this range.</p>
              ) : (
                <div className="space-y-3">
                  {row.pendingOt.map(day => (
                    <div key={day.date} className="border border-border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="font-semibold text-text-primary text-sm">{fmtDay(day.date)}</div>
                        <span className="text-[11px] font-semibold bg-[#FDF3E4] text-[#B26B07] px-2 py-0.5 rounded">+{minutesToDisplay(day.pendingExtraMins)} to review</span>
                      </div>

                      {/* Detailed breakdown: planned shift, actual punches, OT split */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs mb-3 bg-[#FBFAF8] border border-[#F0EEEB] rounded-lg p-3">
                        <div className="flex justify-between"><span className="text-text-secondary">Planned shift</span><span className="font-mono text-text-primary">{day.plannedStart ? `${fmtHHMM(day.plannedStart)} – ${fmtHHMM(day.plannedEnd)}` : '—'}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Planned hrs</span><span className="font-mono text-text-primary">{minutesToDisplay(day.plannedMins)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Checked in / out</span><span className="font-mono text-text-primary">{formatTime(day.firstInSecs)} – {formatTime(day.lastOutSecs)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Worked hrs</span><span className="font-mono text-text-primary">{minutesToDisplay(day.actualMins)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">OT after</span><span className="font-mono text-text-primary">{day.plannedEnd ? fmtHHMM(day.plannedEnd) : '—'}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Declared OT</span><span className="font-mono text-text-primary">{minutesToDisplay(day.declaredOtMins)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Auto-approved</span><span className="font-mono text-[#0A7A50]">+{minutesToDisplay(day.autoOtMins)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Pending review</span><span className="font-mono text-[#9A5B1E] font-semibold">+{minutesToDisplay(day.pendingExtraMins)}</span></div>
                      </div>

                      <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
                        <div>
                          <label className="label">Grant (min)</label>
                          <input type="number" min="0" max={day.pendingExtraMins} value={drafts[day.date]?.mins ?? ''}
                            onChange={e => set(day.date, 'mins', e.target.value)} className="input" />
                        </div>
                        <div>
                          <label className="label">Reason <span className="text-red-500">*</span></label>
                          <input value={drafts[day.date]?.reason ?? ''} onChange={e => set(day.date, 'reason', e.target.value)}
                            placeholder="e.g. extra site visit at client request" className="input" />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-3">
                        <button onClick={() => reject(day)} disabled={saving === day.date} className="btn-danger !py-1.5 !px-4 text-[13px]">
                          {saving === day.date ? 'Saving…' : 'Reject'}
                        </button>
                        <button onClick={() => approve(day)} disabled={saving === day.date} className="btn-success !py-1.5 !px-4 text-[13px]">
                          {saving === day.date ? 'Saving…' : `Approve ${minutesToDisplay(Math.min(day.pendingExtraMins, Math.max(0, Math.round(Number(drafts[day.date]?.mins) || 0))))}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* OT decisions — history (operations only): pre-declared auto, plus admin approve/reject. */}
          {row.isOps && (row.approvedInRange.length > 0 || row.autoOtRangeMins > 0) && (
            <div>
              <div className="label mb-2">OT decisions · approved +{minutesToDisplay(row.autoOtRangeMins + row.approvedOtRangeMins)}</div>
              {row.autoOtRangeMins > 0 && (
                <div className="flex items-start justify-between bg-[#EAF7F0] border border-[#D6EFE0] rounded-lg px-3 py-2 text-sm mb-2">
                  <div>
                    <div className="font-medium text-text-primary">Pre-declared (auto-approved)</div>
                    <div className="text-xs text-text-secondary">OT worked within the admin-declared amount each day</div>
                  </div>
                  <span className="font-mono text-[#0A7A50] font-semibold whitespace-nowrap">+{minutesToDisplay(row.autoOtRangeMins)}</span>
                </div>
              )}
              <div className="space-y-2">
                {row.approvedInRange.map(a => {
                  const rejected = a.status === 'rejected';
                  return (
                    <div key={a.date} className={`flex items-start justify-between border rounded-lg px-3 py-2 text-sm ${rejected ? 'bg-[#FCF7F7] border-[#F4E4E4]' : 'bg-[#FBFAF8] border-[#F0EEEB]'}`}>
                      <div>
                        <div className="font-medium text-text-primary">{fmtDay(a.date)}</div>
                        <div className="text-xs text-text-secondary">{a.reason}{a.approvedBy ? ` · ${a.approvedBy}` : ''}</div>
                      </div>
                      {rejected ? (
                        <span className="text-[11px] font-semibold bg-[#FBEAEA] text-[#C42B2B] px-2 py-0.5 rounded whitespace-nowrap self-center">Rejected</span>
                      ) : (
                        <span className="font-mono text-[#0A7A50] font-semibold whitespace-nowrap">+{minutesToDisplay(a.approvedMins)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Shortage days — view only (operations only) */}
          {row.isOps && (
            <div>
              <div className="label mb-2">Shortage days · -{minutesToDisplay(row.shortageRangeMins)}</div>
              {row.shortageDays.length === 0 ? (
                <p className="text-sm text-text-secondary py-2">No shortage days in this range.</p>
              ) : (
                <div className="space-y-2">
                  {row.shortageDays.map(day => (
                    <div key={day.date} className="flex items-start justify-between bg-[#FCF7F7] border border-[#F4E4E4] rounded-lg px-3 py-2 text-sm">
                      <div>
                        <div className="font-medium text-text-primary">{fmtDay(day.date)}</div>
                        <div className="text-xs text-text-secondary font-mono">
                          Planned {minutesToDisplay(day.plannedMins)} · Worked {minutesToDisplay(day.actualMins)} · {formatTime(day.firstInSecs)} – {formatTime(day.lastOutSecs)}
                        </div>
                      </div>
                      <span className="font-mono text-[#C42B2B] font-semibold whitespace-nowrap">-{minutesToDisplay(day.shortageMins)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* WO days — paid no-work days off, each owes 8h payable by OT (operations only) */}
          {row.isOps && row.woDates.length > 0 && (
            <div>
              <div className="label mb-2">WO days · -{minutesToDisplay(row.woDebitMins)} ({row.woDates.length} × 8h)</div>
              <div className="space-y-2">
                {row.woDates.map(date => (
                  <div key={date} className="flex items-start justify-between bg-[#F2F7FC] border border-[#DCE9F6] rounded-lg px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-text-primary">{fmtDay(date)}</div>
                      <div className="text-xs text-text-secondary">Paid no-work day off — owes 8h, payable by OT this month</div>
                    </div>
                    <span className="font-mono text-[#1A5FAF] font-semibold whitespace-nowrap">-{minutesToDisplay(WO_DEBIT_MINS)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Worked days — hours + check-in/out for every fully-worked day */}
          <div>
            <div className="label mb-2">Worked days · {row.workedDays.length}</div>
            {row.workedDays.length === 0 ? (
              <p className="text-sm text-text-secondary py-2">No check-in/out events in this range.</p>
            ) : (
              <div className="space-y-2">
                {row.workedDays.map(day => (
                  <div key={day.date} className="flex items-start justify-between bg-[#FBFAF8] border border-[#F0EEEB] rounded-lg px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-text-primary">{fmtDay(day.date)}</div>
                      <div className="text-xs text-text-secondary font-mono">{formatTime(day.firstInSecs)} – {formatTime(day.lastOutSecs)}</div>
                    </div>
                    <span className="font-mono text-text-primary font-semibold whitespace-nowrap">{minutesToDisplay(day.actualMins)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-border flex justify-end">
          <button onClick={onClose} className="btn-outline px-4 py-2 text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function OtShortagePage() {
  const [preset, setPreset]           = useState<Preset>('30d');
  const [customStart, setCustomStart] = useState(nDaysAgo(30));
  const [customEnd, setCustomEnd]     = useState(todayStr());
  const [users, setUsers]             = useState<User[]>([]);
  const [events, setEvents]           = useState<AttendanceRecord[]>([]);
  const [planned, setPlanned]         = useState<PlannedHours[]>([]);
  const [approvals, setApprovals]     = useState<OtApproval[]>([]);
  const [holidays, setHolidays]       = useState<Holiday[]>([]);
  const [statuses, setStatuses]       = useState<AttendanceStatus[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [roleFilter, setRoleFilter]   = useState('');
  const [empFilter, setEmpFilter]     = useState('');
  const [adminName, setAdminName]     = useState('Admin');
  const [modalUserId, setModalUserId] = useState<string | null>(null);

  const { start, end } = useMemo(
    () => dateRangeFromPreset(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  const isSingleDay = start === end;
  const nowSecs = Math.floor(Date.now() / 1000);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) return;
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) setAdminName(snap.data().name ?? 'Admin');
    });
    return unsub;
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [fetchedUsers, fetchedEvents, fetchedPlanned, fetchedApprovals, fetchedHolidays, fetchedStatuses] = await Promise.all([
        getAllUsers(),
        getAttendanceForDateRange(start, end),
        getPlannedHoursForDateRange(start, end),
        getOtApprovalsForDateRange(start, end),
        getHolidaysForDateRange(start, end),
        getAttendanceStatusForDateRange(start, end),
      ]);
      setUsers(fetchedUsers);
      setEvents(fetchedEvents);
      setPlanned(fetchedPlanned);
      setApprovals(fetchedApprovals);
      setHolidays(fetchedHolidays);
      setStatuses(fetchedStatuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, [start, end]);

  useEffect(() => { loadData(); }, [loadData]);

  const holidaySet = useMemo(() => new Set(holidays.map(h => h.date)), [holidays]);

  const rows = useMemo<EmpRow[]>(() => {
    return [...users]
      .filter(u => !roleFilter || u.role === roleFilter)
      .filter(u => !empFilter  || u.id   === empFilter)
      .sort((a, b) => {
        const order: Record<string, number> = { office: 0, admin: 1, operations: 2 };
        return (order[a.role] ?? 3) - (order[b.role] ?? 3) || a.name.localeCompare(b.name);
      })
      .map(u => aggregateForEmployee(u, events, planned, approvals, statuses, start, end, holidaySet));
  }, [users, events, planned, approvals, statuses, roleFilter, empFilter, start, end, holidaySet]);

  const modalRow = modalUserId ? rows.find(r => r.user.id === modalUserId) ?? null : null;

  // Range OT/shortage totals — only operations rows contribute.
  const totals = useMemo(() => rows.reduce((acc, r) => ({
    pendingOtMins: acc.pendingOtMins + r.pendingOtMins,
    pendingOtDays: acc.pendingOtDays + r.pendingOt.length,
    approvedOtMins: acc.approvedOtMins + r.approvedOtRangeMins + r.autoOtRangeMins,
    shortageMins: acc.shortageMins + r.shortageRangeMins,
    woDebitMins: acc.woDebitMins + r.woDebitMins,
    woDays: acc.woDays + r.woDates.length,
    netLedgerMins: acc.netLedgerMins + r.netLedgerMins,
  }), { pendingOtMins: 0, pendingOtDays: 0, approvedOtMins: 0, shortageMins: 0, woDebitMins: 0, woDays: 0, netLedgerMins: 0 }), [rows]);

  function exportXlsx() {
    downloadSheet('ot_shortage', 'OT & Shortage', rows.map(r => ({
      Name: r.user.name,
      'Emp ID': r.user.employeeId ?? '',
      Role: r.user.role,
      'Planned Hrs': r.workingMins !== null ? minutesToDisplay(r.workingMins) : '',
      'Actual Hrs': r.actualMins !== null ? minutesToDisplay(r.actualMins) : '',
      'Check-in': isSingleDay && r.firstInSecs ? formatTime(r.firstInSecs) : '',
      'Check-out': isSingleDay && r.lastOutSecs ? formatTime(r.lastOutSecs) : '',
      'Shortage (mins)': r.isOps ? r.shortageRangeMins : '',
      'Pending OT (mins)': r.isOps ? r.pendingOtMins : '',
      'Pending OT (days)': r.isOps ? r.pendingOt.length : '',
      'Auto-approved OT (mins)': r.isOps ? r.autoOtRangeMins : '',
      'Granted OT (mins)': r.isOps ? r.approvedOtRangeMins : '',
      'Total Approved OT (mins)': r.isOps ? (r.autoOtRangeMins + r.approvedOtRangeMins) : '',
      'WO days': r.isOps ? r.woDates.length : '',
      'WO debit (mins)': r.isOps ? r.woDebitMins : '',
      'Net ledger (mins)': r.isOps ? r.netLedgerMins : '',
      'Lifetime Approved OT (mins)': r.isOps ? (r.user.approvedOtMins ?? 0) : '',
      'Lifetime Shortage (mins)': r.isOps ? (r.user.shortageMins ?? 0) : '',
    })));
  }

  const TH = 'text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]';

  return (
    <div className="max-w-[1240px]">
      {/* Date-range context */}
      <div className="mb-6">
        <p className="text-text-secondary text-sm">
          {formatDateRange(start, end)}
          {holidays.length > 0 && ` · ${holidays.length} holiday${holidays.length > 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Summary cards (OT/shortage/WO reflect operations only) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">Pending OT · Ops</div>
          <div className="text-xl font-bold text-[#B26B07]">+{minutesToDisplay(totals.pendingOtMins)}</div>
          <div className="text-[11px] text-text-secondary mt-0.5">{totals.pendingOtDays} day{totals.pendingOtDays === 1 ? '' : 's'} to review</div>
        </div>
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">Approved OT · Ops</div>
          <div className="text-xl font-bold text-[#0A7A50]">+{minutesToDisplay(totals.approvedOtMins)}</div>
          <div className="text-[11px] text-text-secondary mt-0.5">in this range</div>
        </div>
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">Shortage · Ops</div>
          <div className="text-xl font-bold text-[#C42B2B]">-{minutesToDisplay(totals.shortageMins)}</div>
          <div className="text-[11px] text-text-secondary mt-0.5">automatic, no approval</div>
        </div>
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">WO debit · Ops</div>
          <div className="text-xl font-bold text-[#1A5FAF]">-{minutesToDisplay(totals.woDebitMins)}</div>
          <div className="text-[11px] text-text-secondary mt-0.5">{totals.woDays} WO day{totals.woDays === 1 ? '' : 's'} × 8h</div>
        </div>
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">Net · Ops</div>
          <div className={`text-xl font-bold ${totals.netLedgerMins < 0 ? 'text-[#C42B2B]' : 'text-[#0A7A50]'}`}>
            {totals.netLedgerMins < 0 ? '-' : '+'}{minutesToDisplay(totals.netLedgerMins)}
          </div>
          <div className="text-[11px] text-text-secondary mt-0.5">OT − shortage − WO</div>
        </div>
        <div className="card !p-4">
          <div className="text-xs text-text-secondary mb-1">Employees</div>
          <div className="text-xl font-bold text-text-primary">{rows.length}</div>
          <div className="text-[11px] text-text-secondary mt-0.5">in view</div>
        </div>
      </div>

      {/* Preset buttons */}
      <div className="card mb-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                preset === p.key
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white text-text-secondary border-border hover:border-primary hover:text-primary'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 pt-3 mt-4 border-t border-border">
            <label className="text-sm text-text-secondary whitespace-nowrap">From:</label>
            <input type="date" value={customStart} max={customEnd}
              onChange={e => setCustomStart(e.target.value)} className="input text-sm !py-1.5 !w-auto" />
            <label className="text-sm text-text-secondary whitespace-nowrap">To:</label>
            <input type="date" value={customEnd} max={todayStr()}
              onChange={e => setCustomEnd(e.target.value)} className="input text-sm !py-1.5 !w-auto" />
          </div>
        )}
      </div>

      {/* Secondary filters */}
      <div className="flex flex-wrap gap-3 items-center mb-5">
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} className="input text-sm !py-2 !w-auto">
          <option value="">All Roles</option>
          <option value="office">Office</option>
          <option value="operations">Operations</option>
          <option value="admin">Admin</option>
        </select>
        <select value={empFilter} onChange={e => setEmpFilter(e.target.value)} className="input text-sm !py-2 !w-auto min-w-[180px]">
          <option value="">All Employees</option>
          {[...users].sort((a, b) => a.name.localeCompare(b.name)).map(u => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <button onClick={loadData} className="btn-outline !py-2 !px-4 !text-sm">Refresh</button>
        <ExportButton onClick={exportXlsx} disabled={loading || rows.length === 0} />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white border border-[#E9E6E2] rounded-2xl overflow-hidden">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="h-10 bg-background rounded animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className={`${TH} pl-[18px]`}>Name</th>
                  <th className={TH}>Emp ID</th>
                  <th className={TH}>Role</th>
                  <th className={TH}>Planned</th>
                  <th className={TH}>Actual</th>
                  {isSingleDay && <th className={TH}>Check-in / Out</th>}
                  <th className={TH}>Shortage</th>
                  <th className={TH}>Overtime</th>
                  <th className={TH}>WO</th>
                  <th className={TH}>Net</th>
                  <th className={`${TH} pr-[18px]`}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const { user, isOps, workingMins, actualMins, firstInSecs, lastOutSecs, shortageRangeMins, pendingOt, pendingOtMins, approvedOtRangeMins, autoOtRangeMins, woDates, netLedgerMins } = r;
                  const totalApprovedOt = approvedOtRangeMins + autoOtRangeMins;
                  return (
                    <tr key={user.id} className="border-t border-[#F4F2EF] hover:bg-[#FBFAF8] transition-colors cursor-pointer" onClick={() => setModalUserId(user.id)}>
                      <td className="px-[14px] py-3 pl-[18px] font-medium text-text-primary whitespace-nowrap">{user.name}</td>
                      <td className="px-[14px] py-3 text-text-secondary text-xs font-mono whitespace-nowrap">{user.employeeId || '—'}</td>
                      <td className="px-[14px] py-3"><RoleBadge role={user.role} /></td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap font-mono">
                        {workingMins !== null
                          ? <span className="font-medium text-text-primary">{minutesToDisplay(workingMins)}</span>
                          : <span className="italic text-text-secondary/60">{isOps ? 'No plan' : '—'}</span>}
                      </td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap font-mono">
                        {actualMins !== null ? (
                          <span className="font-medium text-text-primary">{minutesToDisplay(actualMins)}</span>
                        ) : isSingleDay && firstInSecs && !lastOutSecs ? (
                          <span className="font-medium text-text-primary">
                            {minutesToDisplay(Math.max(0, Math.round((nowSecs - firstInSecs) / 60)))}
                            <span className="ml-1.5 not-italic bg-[#EAF7F0] text-[#0A7A50] px-1.5 py-0.5 rounded text-[10px] font-semibold">in</span>
                          </span>
                        ) : (
                          <span className="italic text-text-secondary/60">No data</span>
                        )}
                      </td>
                      {isSingleDay && (
                        <td className="px-[14px] py-3 text-xs text-text-secondary whitespace-nowrap font-mono">
                          {firstInSecs ? (
                            lastOutSecs
                              ? `${formatTime(firstInSecs)} – ${formatTime(lastOutSecs)}`
                              : <>{formatTime(firstInSecs)} – <span className="text-[#0A7A50] font-semibold">still in</span></>
                          ) : '—'}
                        </td>
                      )}
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap">
                        {!isOps ? (
                          <span className="text-text-secondary/50">n/a</span>
                        ) : actualMins === null ? (
                          <span className="text-text-secondary/60">—</span>
                        ) : shortageRangeMins > 0 ? (
                          <span className="bg-[#FBEAEA] text-[#C42B2B] px-2 py-0.5 rounded font-mono">-{minutesToDisplay(shortageRangeMins)}</span>
                        ) : (
                          <span className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded">On time</span>
                        )}
                      </td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap">
                        {!isOps ? (
                          <span className="text-text-secondary/50">n/a</span>
                        ) : pendingOtMins > 0 ? (
                          <span className="inline-flex items-center gap-1.5 bg-[#FDF3E4] text-[#B26B07] px-2.5 py-1 rounded-[7px] font-semibold">
                            Review +{minutesToDisplay(pendingOtMins)} · {pendingOt.length}d
                          </span>
                        ) : totalApprovedOt > 0 ? (
                          <span className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded font-mono">+{minutesToDisplay(totalApprovedOt)}</span>
                        ) : (
                          <span className="text-text-secondary/60">—</span>
                        )}
                      </td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap">
                        {!isOps ? (
                          <span className="text-text-secondary/50">n/a</span>
                        ) : woDates.length > 0 ? (
                          <span className="bg-[#E7F0FA] text-[#1A5FAF] px-2 py-0.5 rounded font-mono">-{minutesToDisplay(woDates.length * 480)} · {woDates.length}d</span>
                        ) : (
                          <span className="text-text-secondary/60">—</span>
                        )}
                      </td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap">
                        {!isOps ? (
                          <span className="text-text-secondary/50">n/a</span>
                        ) : (
                          <span className={`px-2 py-0.5 rounded font-mono font-semibold ${netLedgerMins < 0 ? 'bg-[#FBEAEA] text-[#C42B2B]' : netLedgerMins > 0 ? 'bg-[#EAF7F0] text-[#0A7A50]' : 'text-text-secondary/60'}`}>
                            {netLedgerMins < 0 ? '-' : '+'}{minutesToDisplay(netLedgerMins)}
                          </span>
                        )}
                      </td>
                      <td className="px-[14px] py-3 pr-[18px] text-right whitespace-nowrap">
                        <span className="text-xs text-primary font-medium">View →</span>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={isSingleDay ? 11 : 10} className="py-10 text-center text-text-secondary text-sm">
                      No employees match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modalRow && (
        <DetailModal
          row={modalRow}
          adminName={adminName}
          onClose={() => setModalUserId(null)}
          onApproved={loadData}
        />
      )}
    </div>
  );
}
