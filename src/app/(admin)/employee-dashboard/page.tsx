'use client';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getAllUsers, getAttendanceForDateRange, getPlannedHoursForDateRange, getOtApprovalsForDateRange, getHolidaysForDateRange, approveOt, rejectOt } from '@/lib/firestore';
import type { User, AttendanceRecord, PlannedHours, OtApproval, Holiday } from '@/types';
import { RoleBadge } from '@/components/ui';
import ExportButton from '@/components/ExportButton';
import { downloadSheet } from '@/lib/excel';
import { istTodayStr, istDaysAgoStr } from '@/lib/date';
import { computeDayLedger } from '@/lib/otLedger';

// ── Date range helpers ────────────────────────────────────────────────────────

type Preset = 'custom' | '1d' | '7d' | '15d' | '30d' | '90d' | '180d' | '365d';

const PRESETS: { key: Preset; label: string; days: number | null }[] = [
  { key: 'custom', label: 'Custom Date', days: null },
  { key: '1d',    label: 'Today',        days: 1   },
  { key: '7d',    label: 'Last 7 Days',  days: 7   },
  { key: '15d',   label: 'Last 15 Days', days: 15  },
  { key: '30d',   label: 'Last Month',   days: 30  },
  { key: '90d',   label: 'Last 3 Months',days: 90  },
  { key: '180d',  label: 'Last 6 Months',days: 180 },
  { key: '365d',  label: 'Last Year',    days: 365 },
];

function todayStr() {
  return istTodayStr();
}

function nDaysAgo(n: number): string {
  return istDaysAgoStr(n);
}

function dateRangeFromPreset(preset: Preset, customDate: string): { start: string; end: string } {
  if (preset === 'custom') return { start: customDate, end: customDate };
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
function countWorkingDays(start: string, end: string, holidays?: Set<string>): number {
  let count = 0;
  const d = new Date(start + 'T12:00:00');
  const e = new Date(end + 'T12:00:00');
  while (d <= e) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (d.getDay() !== 0 && !holidays?.has(ds)) count++;
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

const OFFICE_DAY_MINS = 8 * 60;

// Field-work event types for operations (home events excluded — commute bookends)
const OPS_IN_TYPES  = new Set(['site_in', 'market_in']);
const OPS_OUT_TYPES = new Set(['site_out', 'market_out']);

function formatTime(secs: number): string {
  return new Date(secs * 1000).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}

// ── Per-employee aggregation ──────────────────────────────────────────────────

interface DayOt {
  date: string;
  plannedMins: number;
  declaredOtMins: number;   // admin pre-declared OT for the day
  actualMins: number;
  autoOtMins: number;       // pre-authorized OT worked = min(surplus, declared)
  pendingExtraMins: number; // surplus beyond declared → needs review
}

interface EmployeeRow {
  user: User;
  workingMins: number | null;  // null = no plan (ops only)
  actualMins: number | null;   // null = no events
  shortageMins: number;        // sum of per-day shortfalls (only days worked with a known plan)
  pendingOt: DayOt[];          // OT days in range not yet approved
  pendingOtMins: number;
  autoOtRangeMins: number;     // pre-authorized (declared) OT worked in range — counts as approved
  restDayOtRangeMins: number;  // all worked minutes on authorized Sun/holiday rest days — auto-approved
  approvedOtRangeMins: number; // approved OT minutes within the selected range (granted via docs)
  approvedInRange: OtApproval[];
  // Single-day extras
  firstInSecs: number | null;
  lastOutSecs: number | null;
}

function aggregateForEmployee(
  user: User,
  allEvents: AttendanceRecord[],
  plannedItems: PlannedHours[],
  approvals: OtApproval[],
  start: string,
  end: string,
  holidays: Set<string>,
): EmployeeRow {
  const isSingleDay = start === end;
  const isOps = user.role === 'operations';
  const userEvents = allEvents.filter(e => e.userId === user.id);

  // Planned shift + declared-OT minutes per date (ops use admin-set windows; office/admin fixed 8h)
  const plannedByDate = new Map<string, { planned: number; declared: number }>();
  const otAuthByDate = new Set<string>(); // dates with admin-authorized rest-day OT
  plannedItems.filter(p => p.userId === user.id).forEach(p => {
    const dur = hhmmToMinutes(p.endTime) - hhmmToMinutes(p.startTime);
    if (dur > 0) plannedByDate.set(p.date, { planned: dur, declared: Math.max(0, p.declaredOtMins ?? 0) });
    if (p.otAuthorized) otAuthByDate.add(p.date);
  });

  // ── Working minutes (range expected) ───────────────────────────────────
  let workingMins: number | null;
  if (isOps) {
    let total = 0;
    plannedByDate.forEach(d => { total += d.planned; }); // expected = shift windows only (declared OT is overtime)
    workingMins = total > 0 ? total : null;
  } else {
    workingMins = countWorkingDays(start, end, holidays) * OFFICE_DAY_MINS;
  }

  // ── Per-day actual minutes, OT and shortage ────────────────────────────
  const eventsByDate = new Map<string, AttendanceRecord[]>();
  userEvents.forEach(e => {
    if (!eventsByDate.has(e.date)) eventsByDate.set(e.date, []);
    eventsByDate.get(e.date)!.push(e);
  });

  let totalActualMins = 0;
  let hasAnyActual = false;
  let shortageMins = 0;
  let autoOtRangeMins = 0;
  let restDayOtRangeMins = 0;
  const otDays: DayOt[] = [];
  let globalFirstIn: number | null = null;
  let globalLastOut: number | null = null;

  eventsByDate.forEach((dayEvents, date) => {
    const inEvents  = dayEvents.filter(e => isOps ? OPS_IN_TYPES.has(e.type)  : e.type === 'office_in');
    const outEvents = dayEvents.filter(e => isOps ? OPS_OUT_TYPES.has(e.type) : e.type === 'office_out');
    if (inEvents.length === 0) return; // no check-in → nothing to show

    const firstIn  = Math.min(...inEvents.map(tsSeconds));
    const lastOut  = outEvents.length ? Math.max(...outEvents.map(tsSeconds)) : null;
    if (globalFirstIn === null || firstIn < globalFirstIn) globalFirstIn = firstIn;

    // Open day — checked in but not yet checked out. Final hours can't be measured,
    // so it never counts toward totals / OT / shortage, but the check-in time stays
    // visible (shown as "in progress" in the single-day view).
    if (lastOut === null || lastOut <= firstIn) return;

    const dayMins = Math.round((lastOut - firstIn) / 60);
    totalActualMins += dayMins;
    hasAnyActual = true;

    if (globalLastOut === null || lastOut > globalLastOut) globalLastOut = lastOut;

    // Sunday/holiday: all worked minutes count as OT, but only when admin-authorized (auto-approved).
    // Otherwise (normal working day with a shift): declared OT is a pre-approval ceiling, not an
    // obligation — shortage is vs the plain shift; OT up to declared is auto-approved, beyond needs review.
    const restDay     = new Date(date + 'T12:00:00').getDay() === 0 || holidays.has(date);
    const planInfo    = isOps ? plannedByDate.get(date) : { planned: OFFICE_DAY_MINS, declared: 0 };
    const plannedDay  = planInfo?.planned ?? 0;
    const declaredDay = planInfo?.declared ?? 0;
    // Office/admin never accrue OT/shortage here (scope: ops only).
    if (isOps) {
      const led = computeDayLedger({
        plannedMins: plannedDay, declaredOtMins: declaredDay, actualMins: dayMins,
        isRestDay: restDay, otAuthorized: otAuthByDate.has(date),
      });
      shortageMins    += led.shortageMins;
      autoOtRangeMins += led.autoOtMins;
      restDayOtRangeMins += led.restDayOtMins;
      if (led.pendingExtraMins > 0) {
        otDays.push({ date, plannedMins: plannedDay, declaredOtMins: declaredDay, actualMins: dayMins, autoOtMins: led.autoOtMins, pendingExtraMins: led.pendingExtraMins });
      }
    } else if (plannedDay > 0 && !restDay) {
      // Office/admin: shortage only, vs the fixed 8h window (no OT, no rest-day, no holidays).
      shortageMins += Math.max(0, plannedDay - dayMins);
    }
  });

  // Split OT days into pending vs already-approved
  const approvedByDate = new Map<string, OtApproval>();
  approvals.filter(a => a.userId === user.id).forEach(a => approvedByDate.set(a.date, a));

  const pendingOt = otDays.filter(d => !approvedByDate.has(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  const pendingOtMins = pendingOt.reduce((s, d) => s + d.pendingExtraMins, 0);
  const approvedInRange = Array.from(approvedByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  const approvedOtRangeMins = approvedInRange.reduce((s, a) => s + (a.approvedMins || 0), 0);

  return {
    user,
    workingMins,
    actualMins: hasAnyActual ? totalActualMins : null,
    shortageMins,
    pendingOt,
    pendingOtMins,
    autoOtRangeMins,
    restDayOtRangeMins,
    approvedOtRangeMins,
    approvedInRange,
    firstInSecs: isSingleDay ? globalFirstIn : null,
    lastOutSecs: isSingleDay ? globalLastOut : null,
  };
}

// ── OT approval modal ─────────────────────────────────────────────────────────

function OtModal({ row, adminName, onClose, onApproved }: {
  row: EmployeeRow;
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

  async function approve(day: DayOt) {
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

  async function reject(day: DayOt) {
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

  const lifetime = row.user.approvedOtMins ?? 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Overtime — {row.user.name}</h2>
            <p className="text-xs text-text-secondary mt-0.5 font-mono">{row.user.employeeId} · Lifetime approved OT: {minutesToDisplay(lifetime)}</p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-5 space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</p>}

          {row.pendingOt.length === 0 && (
            <p className="text-sm text-text-secondary text-center py-4">No pending overtime to review in this range.</p>
          )}

          {row.pendingOt.map(day => (
            <div key={day.date} className="border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold text-text-primary text-sm">{fmtDay(day.date)}</div>
                <div className="text-xs text-text-secondary font-mono">
                  Planned {minutesToDisplay(day.plannedMins)}
                  {day.autoOtMins > 0 && <> · <span className="text-[#0A7A50]">+{minutesToDisplay(day.autoOtMins)} auto</span></>}
                  {' '}· Worked {minutesToDisplay(day.actualMins)} ·
                  <span className="text-[#9A5B1E] font-semibold"> +{minutesToDisplay(day.pendingExtraMins)} to review</span>
                </div>
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

          {row.approvedInRange.length > 0 && (
            <div>
              <div className="label mb-2">Decisions in this range</div>
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
        </div>

        <div className="p-4 border-t border-border flex justify-end">
          <button onClick={onClose} className="btn-outline px-4 py-2 text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmployeeDashboardPage() {
  const [preset, setPreset]           = useState<Preset>('1d');
  const [customDate, setCustomDate]   = useState(todayStr());
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
  const [otModalUserId, setOtModalUserId] = useState<string | null>(null);

  const { start, end } = useMemo(
    () => dateRangeFromPreset(preset, customDate),
    [preset, customDate],
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

  const rows = useMemo<EmployeeRow[]>(() => {
    return [...users]
      .filter(u => !roleFilter || u.role === roleFilter)
      .filter(u => !empFilter  || u.id   === empFilter)
      .sort((a, b) => {
        const order: Record<string, number> = { office: 0, admin: 1, operations: 2 };
        return (order[a.role] ?? 3) - (order[b.role] ?? 3) || a.name.localeCompare(b.name);
      })
      .map(u => aggregateForEmployee(u, events, planned, approvals, start, end, holidaySet));
  }, [users, events, planned, approvals, roleFilter, empFilter, start, end, holidaySet]);

  const modalRow = otModalUserId ? rows.find(r => r.user.id === otModalUserId) ?? null : null;
  const colCount = isSingleDay ? 10 : 9;

  function exportXlsx() {
    downloadSheet('employee_hours', 'Hours', rows.map(r => ({
      Name: r.user.name,
      'Emp ID': r.user.employeeId ?? '',
      Role: r.user.role,
      'PL Balance': r.user.plBalance ?? 0,
      'WO Balance': r.user.woBalance ?? 0,
      'Working Hrs': r.workingMins !== null ? minutesToDisplay(r.workingMins) : '',
      'Actual Hrs': r.actualMins !== null ? minutesToDisplay(r.actualMins) : '',
      'Shortage (mins)': r.shortageMins,
      'Pending OT (mins)': r.pendingOtMins,
      'Auto-approved OT (mins)': r.autoOtRangeMins,
      'Rest-day OT (mins)': r.restDayOtRangeMins,
      'Granted OT (mins)': r.approvedOtRangeMins,
      'Total Approved OT (mins)': r.autoOtRangeMins + r.restDayOtRangeMins + r.approvedOtRangeMins,
      'Lifetime Approved OT (mins)': r.user.approvedOtMins ?? 0,
      'Lifetime Shortage (mins)': r.user.shortageMins ?? 0,
    })));
  }

  return (
    <div className="max-w-[1240px]">
      {/* Date-range context */}
      <div className="mb-6">
        <p className="text-text-secondary text-sm">
          {formatDateRange(start, end)}
          {!isSingleDay && ` · ${countWorkingDays(start, end, holidaySet)} working days`}
          {!isSingleDay && holidays.length > 0 && ` · ${holidays.length} holiday${holidays.length > 1 ? 's' : ''}`}
        </p>
      </div>

      {/* Preset buttons */}
      <div className="card mb-4">
        <div className="flex flex-wrap gap-2 mb-4">
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
          <div className="flex items-center gap-2 pt-3 border-t border-border">
            <label className="text-sm text-text-secondary whitespace-nowrap">Pick date:</label>
            <input
              type="date"
              value={customDate}
              max={todayStr()}
              onChange={e => setCustomDate(e.target.value)}
              className="input text-sm !py-1.5"
            />
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
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB] pl-[18px]">Name</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Emp ID</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Role</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">PL</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">WO</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Working</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Actual</th>
                  {isSingleDay && <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Check-in / Out</th>}
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB]">Shortage</th>
                  <th className="text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB] pr-[18px]">Overtime</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const { user, workingMins, actualMins, shortageMins, pendingOt, pendingOtMins, approvedOtRangeMins, autoOtRangeMins, restDayOtRangeMins, firstInSecs, lastOutSecs } = r;
                  const totalApprovedOt = approvedOtRangeMins + autoOtRangeMins + restDayOtRangeMins;
                  return (
                    <tr key={user.id} className="border-t border-[#F4F2EF] hover:bg-[#FBFAF8] transition-colors">
                      <td className="px-[14px] py-3 pl-[18px] font-medium text-text-primary whitespace-nowrap">{user.name}</td>
                      <td className="px-[14px] py-3 text-text-secondary text-xs font-mono whitespace-nowrap">{user.employeeId || '—'}</td>
                      <td className="px-[14px] py-3"><RoleBadge role={user.role} /></td>
                      <td className="px-[14px] py-3">
                        <span className="bg-[#EDF2FD] text-[#2456C7] px-2 py-0.5 rounded text-xs">{user.plBalance ?? 0}</span>
                      </td>
                      <td className="px-[14px] py-3">
                        <span className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded text-xs">{user.woBalance ?? 0}</span>
                      </td>
                      <td className="px-[14px] py-3 text-xs whitespace-nowrap font-mono">
                        {workingMins !== null
                          ? <span className="font-medium text-text-primary">{minutesToDisplay(workingMins)}</span>
                          : <span className="italic text-text-secondary/60">{user.role === 'operations' ? 'No plan' : '—'}</span>}
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
                        {actualMins === null ? (
                          <span className="text-text-secondary/60">—</span>
                        ) : shortageMins > 0 ? (
                          <span className="bg-[#FBEAEA] text-[#C42B2B] px-2 py-0.5 rounded font-mono">-{minutesToDisplay(shortageMins)}</span>
                        ) : (
                          <span className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded">On time</span>
                        )}
                      </td>
                      <td className="px-[14px] py-3 pr-[18px] text-xs whitespace-nowrap">
                        {pendingOtMins > 0 ? (
                          <button onClick={() => setOtModalUserId(user.id)}
                            className="inline-flex items-center gap-1.5 bg-[#FDF3E4] text-[#B26B07] hover:bg-[#FBEAD0] px-2.5 py-1 rounded-[7px] font-semibold transition-colors">
                            Review +{minutesToDisplay(pendingOtMins)} · {pendingOt.length}d
                          </button>
                        ) : totalApprovedOt > 0 ? (
                          <button onClick={() => setOtModalUserId(user.id)}
                            className="bg-[#EAF7F0] text-[#0A7A50] px-2 py-0.5 rounded font-mono hover:bg-[#D8F0E4] transition-colors">
                            +{minutesToDisplay(totalApprovedOt)}
                          </button>
                        ) : (
                          <span className="text-text-secondary/60">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="py-10 text-center text-text-secondary text-sm">
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
        <OtModal
          row={modalRow}
          adminName={adminName}
          onClose={() => setOtModalUserId(null)}
          onApproved={loadData}
        />
      )}
    </div>
  );
}
