'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getAllUsers, getAttendanceForDateRange, getPlannedHoursForDateRange, getOtApprovalsForDateRange, getHolidaysForDateRange, approveOt } from '@/lib/firestore';
import type { User, AttendanceRecord, PlannedHours, OtApproval, Holiday } from '@/types';
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

const OFFICE_DAY_MINS = 8 * 60;

// Field-work event types for operations (home events excluded — commute bookends)
const OPS_IN_TYPES  = new Set(['site_in', 'market_in']);
const OPS_OUT_TYPES = new Set(['site_out', 'market_out']);

// ── Per-employee aggregation ──────────────────────────────────────────────────

interface DayDetail {
  date: string;
  plannedMins: number;
  actualMins: number;
  otMins: number;        // > 0 only when actual exceeds plan (ops only)
  shortageMins: number;  // > 0 only when actual falls short of plan (ops only)
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
  pendingOt: DayDetail[];
  pendingOtMins: number;
  approvedInRange: OtApproval[];
  approvedOtRangeMins: number;
  shortageDays: DayDetail[];
}

function aggregateForEmployee(
  user: User,
  allEvents: AttendanceRecord[],
  plannedItems: PlannedHours[],
  approvals: OtApproval[],
  start: string,
  end: string,
  holidays: Set<string>,
): EmpRow {
  const isOps = user.role === 'operations';
  const userEvents = allEvents.filter(e => e.userId === user.id);

  // Planned minutes per date (ops use admin-set windows)
  const plannedByDate = new Map<string, number>();
  plannedItems.filter(p => p.userId === user.id).forEach(p => {
    const dur = hhmmToMinutes(p.endTime) - hhmmToMinutes(p.startTime);
    if (dur > 0) plannedByDate.set(p.date, dur);
  });

  let workingMins: number | null;
  if (isOps) {
    let total = 0;
    plannedByDate.forEach(d => { total += d; });
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

    const plannedDay = isOps ? plannedByDate.get(date) : OFFICE_DAY_MINS;
    const detail: DayDetail = { date, plannedMins: plannedDay ?? 0, actualMins: dayMins, otMins: 0, shortageMins: 0, firstInSecs: firstIn, lastOutSecs: lastOut };

    // OT / shortage only for operations, and only on days with an expected window.
    // Holidays carry no window → worked hours still count, but no OT/shortage.
    if (isOps && !holidays.has(date) && plannedDay && plannedDay > 0) {
      if (dayMins > plannedDay) {
        detail.otMins = dayMins - plannedDay;
        otDays.push(detail);
      } else if (dayMins < plannedDay) {
        detail.shortageMins = plannedDay - dayMins;
        shortageRangeMins += detail.shortageMins;
        shortageDays.push(detail);
      }
    }
    workedDays.push(detail);
  });

  const approvedByDate = new Map<string, OtApproval>();
  approvals.filter(a => a.userId === user.id).forEach(a => approvedByDate.set(a.date, a));

  const pendingOt = otDays.filter(d => !approvedByDate.has(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  const pendingOtMins = pendingOt.reduce((s, d) => s + d.otMins, 0);
  const approvedInRange = Array.from(approvedByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const approvedOtRangeMins = approvedInRange.reduce((s, a) => s + (a.approvedMins || 0), 0);

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
    approvedInRange,
    approvedOtRangeMins,
    shortageDays: shortageDays.sort((a, b) => a.date.localeCompare(b.date)),
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
    row.pendingOt.forEach(d => { init[d.date] = { mins: String(d.otMins), reason: '' }; });
    return init;
  });
  const [saving, setSaving] = useState('');
  const [error, setError]   = useState('');

  function set(date: string, field: 'mins' | 'reason', value: string) {
    setDrafts(prev => ({ ...prev, [date]: { ...prev[date], [field]: value } }));
  }

  async function approve(day: DayDetail) {
    const draft = drafts[day.date];
    // Grant is capped at the detected OT for the day — admin may approve less, never more.
    const mins  = Math.min(day.otMins, Math.max(0, Math.round(Number(draft.mins) || 0)));
    if (!draft.reason.trim()) { setError('A reason is required to approve overtime.'); return; }
    setError('');
    setSaving(day.date);
    try {
      await approveOt(row.user, day.date, day.otMins, mins, draft.reason.trim(), adminName);
      onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve. Try again.');
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
                        <div className="text-xs text-text-secondary font-mono">
                          Planned {minutesToDisplay(day.plannedMins)} · Worked {minutesToDisplay(day.actualMins)} ·
                          <span className="text-[#9A5B1E] font-semibold"> +{minutesToDisplay(day.otMins)} OT</span>
                        </div>
                      </div>
                      <div className="text-[11px] text-text-secondary font-mono mb-3">{formatTime(day.firstInSecs)} – {formatTime(day.lastOutSecs)}</div>
                      <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
                        <div>
                          <label className="label">Grant (min)</label>
                          <input type="number" min="0" max={day.otMins} value={drafts[day.date]?.mins ?? ''}
                            onChange={e => set(day.date, 'mins', e.target.value)} className="input" />
                        </div>
                        <div>
                          <label className="label">Reason <span className="text-red-500">*</span></label>
                          <input value={drafts[day.date]?.reason ?? ''} onChange={e => set(day.date, 'reason', e.target.value)}
                            placeholder="e.g. extra site visit at client request" className="input" />
                        </div>
                      </div>
                      <div className="flex justify-end mt-3">
                        <button onClick={() => approve(day)} disabled={saving === day.date} className="btn-success !py-1.5 !px-4 text-[13px]">
                          {saving === day.date ? 'Approving…' : `Approve ${minutesToDisplay(Math.min(day.otMins, Math.max(0, Math.round(Number(drafts[day.date]?.mins) || 0))))}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Approved overtime — history (operations only) */}
          {row.isOps && row.approvedInRange.length > 0 && (
            <div>
              <div className="label mb-2">Approved overtime · +{minutesToDisplay(row.approvedOtRangeMins)}</div>
              <div className="space-y-2">
                {row.approvedInRange.map(a => (
                  <div key={a.date} className="flex items-start justify-between bg-[#FBFAF8] border border-[#F0EEEB] rounded-lg px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-text-primary">{fmtDay(a.date)}</div>
                      <div className="text-xs text-text-secondary">{a.reason}{a.approvedBy ? ` · ${a.approvedBy}` : ''}</div>
                    </div>
                    <span className="font-mono text-[#0A7A50] font-semibold whitespace-nowrap">+{minutesToDisplay(a.approvedMins)}</span>
                  </div>
                ))}
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
      const [fetchedUsers, fetchedEvents, fetchedPlanned, fetchedApprovals, fetchedHolidays] = await Promise.all([
        getAllUsers(),
        getAttendanceForDateRange(start, end),
        getPlannedHoursForDateRange(start, end),
        getOtApprovalsForDateRange(start, end),
        getHolidaysForDateRange(start, end),
      ]);
      setUsers(fetchedUsers);
      setEvents(fetchedEvents);
      setPlanned(fetchedPlanned);
      setApprovals(fetchedApprovals);
      setHolidays(fetchedHolidays);
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
      .map(u => aggregateForEmployee(u, events, planned, approvals, start, end, holidaySet));
  }, [users, events, planned, approvals, roleFilter, empFilter, start, end, holidaySet]);

  const modalRow = modalUserId ? rows.find(r => r.user.id === modalUserId) ?? null : null;

  // Range OT/shortage totals — only operations rows contribute.
  const totals = useMemo(() => rows.reduce((acc, r) => ({
    pendingOtMins: acc.pendingOtMins + r.pendingOtMins,
    pendingOtDays: acc.pendingOtDays + r.pendingOt.length,
    approvedOtMins: acc.approvedOtMins + r.approvedOtRangeMins,
    shortageMins: acc.shortageMins + r.shortageRangeMins,
  }), { pendingOtMins: 0, pendingOtDays: 0, approvedOtMins: 0, shortageMins: 0 }), [rows]);

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
      'Approved OT range (mins)': r.isOps ? r.approvedOtRangeMins : '',
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

      {/* Summary cards (OT/shortage reflect operations only) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
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
                  <th className={`${TH} pr-[18px]`}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const { user, isOps, workingMins, actualMins, firstInSecs, lastOutSecs, shortageRangeMins, pendingOt, pendingOtMins, approvedOtRangeMins } = r;
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
                        ) : approvedOtRangeMins > 0 ? (
                          <span className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded font-mono">+{minutesToDisplay(approvedOtRangeMins)}</span>
                        ) : (
                          <span className="text-text-secondary/60">—</span>
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
                    <td colSpan={isSingleDay ? 9 : 8} className="py-10 text-center text-text-secondary text-sm">
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
