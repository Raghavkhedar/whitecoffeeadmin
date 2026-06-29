'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { getAllUsers, getAttendanceForDate, getAttendanceStatusForMonth, getPlannedHoursForMonth, setPlannedHours, getHolidaysForMonth, setHoliday, deleteHoliday, setAttendanceStatus, deleteAttendanceStatus } from '@/lib/firestore';
import type { User, AttendanceRecord, AttendanceStatus, PlannedHours, Holiday } from '@/types';
import { RoleBadge, StatusBadge } from '@/components/ui';
import ExportButton from '@/components/ExportButton';
import { downloadSheet } from '@/lib/excel';
import { istTodayStr } from '@/lib/date';
import { auth } from '@/lib/firebase';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(ts: { toDate: () => Date } | undefined) {
  if (!ts) return '—';
  return ts.toDate().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function toDateStr(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function hhmmToMinutes(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const [h, m] = s.split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? fallback : h * 60 + m;
}

type Visit = { in?: AttendanceRecord; out?: AttendanceRecord };

// Pair check-ins with check-outs chronologically so a visit's "out" is always the
// next out *after* its "in" — never matched by list position (which broke when the
// counts/order of in/out events didn't alternate cleanly, e.g. auto-logouts or
// mixed site+market visits). Ops spans site+market events; office uses office_in/out.
function buildVisits(events: AttendanceRecord[], isOps: boolean): Visit[] {
  const ts    = (e: AttendanceRecord) => (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
  const isIn  = (e: AttendanceRecord) => isOps ? (e.type === 'site_in'  || e.type === 'market_in')  : e.type === 'office_in';
  const isOut = (e: AttendanceRecord) => isOps ? (e.type === 'site_out' || e.type === 'market_out') : e.type === 'office_out';
  const ordered = events.filter(e => isIn(e) || isOut(e)).sort((a, b) => ts(a) - ts(b));
  const visits: Visit[] = [];
  let current: Visit | null = null;
  for (const e of ordered) {
    if (isIn(e)) {
      if (current) visits.push(current);   // previous in had no out — keep it open
      current = { in: e };
    } else if (current && !current.out) {
      current.out = e;                      // close the open visit
      visits.push(current);
      current = null;
    } else {
      visits.push({ out: e });             // orphan out (no preceding open in)
    }
  }
  if (current) visits.push(current);
  return visits;
}

function visitLocation(v: Visit): string {
  return v.in?.siteName || v.in?.marketName || v.out?.siteName || v.out?.marketName || '';
}

function VisitCell({ visit }: { visit?: Visit | null }) {
  if (!visit) return <span className="text-text-secondary/50">—</span>;
  const loc = visitLocation(visit);
  return (
    <div>
      <span>{formatTime(visit.in?.timestamp)}</span>
      <span className="mx-1">–</span>
      <span>{formatTime(visit.out?.timestamp)}</span>
      {visit.out?.autoLogout && (
        <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200 font-medium">auto</span>
      )}
      {loc && <div className="text-[10px] text-text-secondary/70 mt-0.5">{loc}</div>}
    </div>
  );
}

// Mirrors the computeDailyAttendanceStatus Cloud Function for live (pre-23:59) display.
// Office/admin: fixed 10:00–18:00 window, office_in/office_out events.
// Operations: planned shift window (required), first site_in / last site_out events.
function deriveStatus(
  role: string,
  userEvents: AttendanceRecord[],
  date: string,
  planned?: PlannedHours,
): AttendanceStatus['status'] | null {
  const dayOfWeek = new Date(date + 'T00:00:00').getDay();
  if (dayOfWeek === 0) return null; // Sunday — no status

  const isOps = role === 'operations';
  if (isOps && (!planned?.startTime || !planned?.endTime)) return null; // no plan → unmarked

  const ts = (e: AttendanceRecord) => (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
  // Ops field-work spans both site and market visits; office uses office_in/out.
  const isIn  = (e: AttendanceRecord) => isOps ? (e.type === 'site_in'  || e.type === 'market_in')  : e.type === 'office_in';
  const isOut = (e: AttendanceRecord) => isOps ? (e.type === 'site_out' || e.type === 'market_out') : e.type === 'office_out';
  const checkIns  = userEvents.filter(isIn).sort((a, b) => ts(a) - ts(b));
  const checkOuts = userEvents.filter(isOut).sort((a, b) => ts(a) - ts(b));
  if (checkIns.length === 0 && checkOuts.length === 0) return 'Absent';

  if (checkIns.length === 0 || checkOuts.length === 0) return 'SLNF';

  const toIST = (d: Date) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000);

  const firstInDate = checkIns[0].timestamp?.toDate();
  const lastOutDate = checkOuts[checkOuts.length - 1].timestamp?.toDate();
  if (!firstInDate || !lastOutDate) return 'SLNF';

  const inIST  = toIST(firstInDate);
  const outIST = toIST(lastOutDate);
  const inMinutes  = inIST.getUTCHours() * 60 + inIST.getUTCMinutes();
  const outMinutes = outIST.getUTCHours() * 60 + outIST.getUTCMinutes();
  const startMin   = isOps ? hhmmToMinutes(planned?.startTime, 10 * 60) : 10 * 60;
  const endMin     = isOps ? hhmmToMinutes(planned?.endTime,   18 * 60) : 18 * 60;
  const lateMinutes  = Math.max(0, inMinutes - startMin);
  const earlyMinutes = Math.max(0, endMin - outMinutes);
  const offMinutes   = lateMinutes + earlyMinutes;

  if (offMinutes === 0) return 'Present';
  if (offMinutes <= 120) return 'SL';
  return 'HalfDay';
}

export default function AttendancePage() {
  const todayStr = istTodayStr();
  const [viewDate, setViewDate]         = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [users, setUsers]               = useState<User[]>([]);
  // date → userId → AttendanceStatus
  const [statusByDate, setStatusByDate] = useState<Map<string, Map<string, AttendanceStatus>>>(new Map());
  // date → userId → PlannedHours (operations shift windows)
  const [plannedByDate, setPlannedByDate] = useState<Map<string, Map<string, PlannedHours>>>(new Map());
  // date → Holiday (company-wide)
  const [holidaysByDate, setHolidaysByDate] = useState<Map<string, Holiday>>(new Map());
  const [selectedEvents, setSelectedEvents] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading]           = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [saving, setSaving]             = useState<Record<string, boolean>>({});
  const [saveError, setSaveError]       = useState('');
  const [dirtyPlans, setDirtyPlans]     = useState<Set<string>>(new Set());
  const [employeeFilter, setEmployeeFilter] = useState('');
  // Holiday editor (for the selected day)
  const [holidayForm, setHolidayForm]   = useState<{ title: string; description: string } | null>(null);
  const [holidaySaving, setHolidaySaving] = useState(false);
  const [holidayError, setHolidayError] = useState('');

  const year  = viewDate.getFullYear();
  const month = viewDate.getMonth(); // 0-indexed

  const loadMonthData = useCallback(async () => {
    setLoading(true);
    try {
      const fetchedUsers = await getAllUsers();
      setUsers(fetchedUsers);
    } catch (err) {
      console.error('Failed to load users', err);
    }

    try {
      const statuses = await getAttendanceStatusForMonth(year, month + 1);
      const map = new Map<string, Map<string, AttendanceStatus>>();
      statuses.forEach(s => {
        if (!map.has(s.date)) map.set(s.date, new Map());
        map.get(s.date)!.set(s.userId, s);
      });
      setStatusByDate(map);
    } catch (err) {
      // attendance_status collection may be empty on first load — not an error
      console.warn('Could not load attendance status (may be empty):', err);
    }

    try {
      const planned = await getPlannedHoursForMonth(year, month + 1);
      const map = new Map<string, Map<string, PlannedHours>>();
      planned.forEach(p => {
        if (!map.has(p.date)) map.set(p.date, new Map());
        map.get(p.date)!.set(p.userId, p);
      });
      setPlannedByDate(map);
    } catch (err) {
      // planned_hours collection may be empty on first load — not an error
      console.warn('Could not load planned hours (may be empty):', err);
    }

    try {
      const holidays = await getHolidaysForMonth(year, month + 1);
      setHolidaysByDate(new Map(holidays.map(h => [h.date, h])));
    } catch (err) {
      // holidays collection may be empty on first load — not an error
      console.warn('Could not load holidays (may be empty):', err);
    }

    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadMonthData(); }, [loadMonthData]);

  // Load raw events when selected date changes
  useEffect(() => {
    if (!selectedDate) return;
    setEventsLoading(true);
    setHolidayForm(null);   // collapse the holiday editor when switching days
    setHolidayError('');
    getAttendanceForDate(selectedDate)
      .then(setSelectedEvents)
      .catch(console.error)
      .finally(() => setEventsLoading(false));
  }, [selectedDate]);

  // Calendar cell array: nulls for empty leading cells
  const daysInMonth   = new Date(year, month + 1, 0).getDate();
  const firstWeekDay  = new Date(year, month, 1).getDay();
  const calendarCells = [
    ...Array<null>(firstWeekDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (calendarCells.length % 7 !== 0) calendarCells.push(null);

  function getDaySummary(date: string) {
    const dayMap = statusByDate.get(date);
    if (!dayMap) return { present: 0, halfDay: 0, sl: 0, slnf: 0, absent: 0, leave: 0 };
    let present = 0, halfDay = 0, sl = 0, slnf = 0, absent = 0, leave = 0;
    dayMap.forEach(s => {
      if (s.status === 'Present')  present++;
      else if (s.status === 'HalfDay') halfDay++;
      else if (s.status === 'SL') sl++;
      else if (s.status === 'SLNF') slnf++;
      else if (s.status === 'Absent')  absent++;
      else if (s.status === 'PL' || s.status === 'LWP') leave++;
    });
    return { present, halfDay, sl, slnf, absent, leave };
  }

  function handlePlannedChange(user: User, date: string, field: 'start' | 'end' | 'ot', value: string) {
    const key      = `${user.id}__${date}`;
    const current  = plannedByDate.get(date)?.get(user.id);
    const startTime = field === 'start' ? value : (current?.startTime || '');
    const endTime   = field === 'end'   ? value : (current?.endTime   || '');
    const declaredOtMins = field === 'ot'
      ? Math.max(0, Math.round(Number(value) || 0))
      : (current?.declaredOtMins ?? 0);

    setPlannedByDate(prev => {
      const next   = new Map(prev);
      const dayMap = new Map(next.get(date) || new Map<string, PlannedHours>());
      dayMap.set(user.id, { id: date, userId: user.id, date, startTime, endTime, declaredOtMins });
      next.set(date, dayMap);
      return next;
    });

    setDirtyPlans(prev => new Set(prev).add(key));
  }

  async function savePlanned(userId: string, date: string) {
    const key     = `${userId}__${date}`;
    const planned = plannedByDate.get(date)?.get(userId);
    if (!planned?.startTime || !planned?.endTime) return;

    setSaving(prev => ({ ...prev, [key]: true }));
    setSaveError('');
    try {
      await setPlannedHours(userId, date, planned.startTime, planned.endTime, planned.declaredOtMins ?? 0);
      setDirtyPlans(prev => { const next = new Set(prev); next.delete(key); return next; });
    } catch (err) {
      setSaveError('Failed to save planned hours. Please try again.');
      console.error(err);
    }
    setSaving(prev => ({ ...prev, [key]: false }));
  }

  // Mark / clear a paid WO (no-work day off) for an ops employee. Writes a markedBy:'admin'
  // status doc the nightly function won't overwrite; clearing removes it so it recomputes.
  async function markWo(user: User, date: string) {
    const key = `${user.id}__${date}`;
    setSaving(prev => ({ ...prev, [key]: true }));
    setSaveError('');
    try {
      await setAttendanceStatus(user.id, date, {
        date, userId: user.id, userName: user.name || '', employeeId: user.employeeId || '',
        role: user.role || '', status: 'WO', markedBy: 'admin',
      });
      setStatusByDate(prev => {
        const next = new Map(prev);
        const dayMap = new Map(next.get(date) || new Map<string, AttendanceStatus>());
        dayMap.set(user.id, { id: date, date, userId: user.id, userName: user.name || '', employeeId: user.employeeId || '', role: user.role || '', status: 'WO', markedBy: 'admin' });
        next.set(date, dayMap);
        return next;
      });
    } catch (err) {
      setSaveError('Failed to mark WO. Please try again.');
      console.error(err);
    }
    setSaving(prev => ({ ...prev, [key]: false }));
  }

  async function clearWo(userId: string, date: string) {
    const key = `${userId}__${date}`;
    setSaving(prev => ({ ...prev, [key]: true }));
    setSaveError('');
    try {
      await deleteAttendanceStatus(userId, date);
      setStatusByDate(prev => {
        const next = new Map(prev);
        const dayMap = new Map(next.get(date) || new Map<string, AttendanceStatus>());
        dayMap.delete(userId);
        next.set(date, dayMap);
        return next;
      });
    } catch (err) {
      setSaveError('Failed to clear WO. Please try again.');
      console.error(err);
    }
    setSaving(prev => ({ ...prev, [key]: false }));
  }

  async function saveHoliday() {
    if (!holidayForm || !holidayForm.title.trim()) {
      setHolidayError('A title is required.');
      return;
    }
    setHolidaySaving(true);
    setHolidayError('');
    try {
      await setHoliday(selectedDate, holidayForm.title, holidayForm.description, auth.currentUser?.uid || '');
      const saved: Holiday = {
        id: selectedDate, date: selectedDate,
        title: holidayForm.title.trim(), description: holidayForm.description.trim(),
      };
      setHolidaysByDate(prev => new Map(prev).set(selectedDate, saved));
      setHolidayForm(null);
    } catch (err) {
      setHolidayError('Failed to save holiday. Please try again.');
      console.error(err);
    }
    setHolidaySaving(false);
  }

  async function removeHoliday() {
    setHolidaySaving(true);
    setHolidayError('');
    try {
      await deleteHoliday(selectedDate);
      setHolidaysByDate(prev => { const next = new Map(prev); next.delete(selectedDate); return next; });
      setHolidayForm(null);
    } catch (err) {
      setHolidayError('Failed to remove holiday. Please try again.');
      console.error(err);
    }
    setHolidaySaving(false);
  }

  const selectedDayMap   = statusByDate.get(selectedDate) || new Map<string, AttendanceStatus>();
  const selectedPlanMap  = plannedByDate.get(selectedDate) || new Map<string, PlannedHours>();
  const selectedHoliday  = holidaysByDate.get(selectedDate);

  // Merge stored (Cloud Function) statuses with client-side derived statuses for the summary chips.
  // Holidays are skipped like Sundays — no live status is derived for them.
  const effectiveStatuses = useMemo(() => {
    const map = new Map<string, AttendanceStatus['status']>();
    users.forEach(user => {
      const stored = selectedDayMap.get(user.id)?.status;
      if (stored) {
        map.set(user.id, stored);
      } else if (!eventsLoading && !selectedHoliday) {
        const derived = deriveStatus(
          user.role,
          selectedEvents.filter(e => e.userId === user.id),
          selectedDate,
          selectedPlanMap.get(user.id),
        );
        if (derived) map.set(user.id, derived);
      }
    });
    return map;
  }, [users, selectedDayMap, selectedPlanMap, selectedEvents, eventsLoading, selectedHoliday]);

  const statusValues = Array.from(effectiveStatuses.values());
  const totalPresent = statusValues.filter(s => s === 'Present').length;
  const totalHalf    = statusValues.filter(s => s === 'HalfDay').length;
  const totalSL      = statusValues.filter(s => s === 'SL').length;
  const totalSLNF    = statusValues.filter(s => s === 'SLNF').length;
  const totalAbsent  = statusValues.filter(s => s === 'Absent').length;
  const totalLeave   = statusValues.filter(s => s === 'PL' || s === 'LWP').length;
  const totalWo      = statusValues.filter(s => s === 'WO').length;

  const selectedDateDisplay = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  function exportXlsx() {
    const tsOf = (e: AttendanceRecord) => (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
    const list = [...users]
      .filter(u => !employeeFilter || u.id === employeeFilter)
      .sort((a, b) => {
        const order: Record<string, number> = { office: 0, admin: 1, operations: 2 };
        return (order[a.role] ?? 3) - (order[b.role] ?? 3) || a.name.localeCompare(b.name);
      });
    const rows = list.map(user => {
      const isOps = user.role === 'operations';
      const evs   = selectedEvents.filter(e => e.userId === user.id);
      // Ops field-work spans both site and market visits (matches buildVisits / status logic).
      const isIn  = (e: AttendanceRecord) => isOps ? (e.type === 'site_in'  || e.type === 'market_in')  : e.type === 'office_in';
      const isOut = (e: AttendanceRecord) => isOps ? (e.type === 'site_out' || e.type === 'market_out') : e.type === 'office_out';
      const ins   = evs.filter(isIn).sort((a, b) => tsOf(a) - tsOf(b));
      const outs  = evs.filter(isOut).sort((a, b) => tsOf(a) - tsOf(b));
      const plan  = selectedPlanMap.get(user.id);
      return {
        Date: selectedDate,
        Name: user.name,
        'Emp ID': user.employeeId || '',
        Role: user.role,
        'Planned Shift': isOps ? (plan?.startTime && plan?.endTime ? `${plan.startTime}–${plan.endTime}` : '') : '10:00–18:00',
        Status: effectiveStatuses.get(user.id) ?? '',
        'First In': formatTime(ins[0]?.timestamp as Parameters<typeof formatTime>[0]),
        'Last Out': formatTime(outs[outs.length - 1]?.timestamp as Parameters<typeof formatTime>[0]),
        'PL Balance': user.plBalance ?? '',
      };
    });
    downloadSheet(`attendance_${selectedDate}`, 'Attendance', rows);
  }

  return (
    <div className="max-w-[1240px]">
      {/* Calendar card */}
      <div className="card mb-6">
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={() => setViewDate(new Date(year, month - 1, 1))}
            className="p-2 rounded-lg text-text-secondary hover:bg-background hover:text-text-primary transition-colors text-lg leading-none"
          >
            ‹
          </button>
          <h2 className="text-base font-semibold text-text-primary">
            {viewDate.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}
          </h2>
          <button
            onClick={() => setViewDate(new Date(year, month + 1, 1))}
            className="p-2 rounded-lg text-text-secondary hover:bg-background hover:text-text-primary transition-colors text-lg leading-none"
          >
            ›
          </button>
        </div>

        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 mb-1">
          {DAYS_OF_WEEK.map(d => (
            <div key={d} className="text-center text-xs font-semibold text-text-secondary py-1.5">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        {loading ? (
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg bg-background animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {calendarCells.map((day, i) => {
              if (!day) return <div key={i} />;
              const ds        = toDateStr(year, month, day);
              const isFuture  = ds > todayStr;
              const isToday   = ds === todayStr;
              const isSelected = ds === selectedDate;
              const holiday   = holidaysByDate.get(ds);
              const summary   = getDaySummary(ds);
              const hasData   = summary.present + summary.halfDay + summary.sl + summary.slnf + summary.absent + summary.leave > 0;

              return (
                <button
                  key={i}
                  onClick={() => setSelectedDate(ds)}
                  className={`min-h-[60px] p-1.5 rounded-lg text-left transition-all border cursor-pointer ${
                    isSelected
                      ? 'border-primary bg-accent-light shadow-sm'
                      : holiday
                      ? 'border-purple-200 bg-purple-50 hover:border-purple-300'
                      : isToday
                      ? 'border-primary/40 bg-background'
                      : 'border-transparent hover:border-border hover:bg-background'
                  } ${isFuture && !holiday && !isSelected ? 'opacity-40' : ''}`}
                >
                  <div className={`text-xs font-bold mb-1 ${isToday ? 'text-primary' : holiday ? 'text-purple-700' : 'text-text-primary'}`}>
                    {day}
                  </div>
                  {holiday ? (
                    <div className="flex flex-wrap gap-0.5">
                      <span className="text-[9px] leading-tight bg-purple-100 text-purple-700 rounded px-1 py-0.5 truncate max-w-full" title={holiday.title}>
                        {holiday.title}
                      </span>
                    </div>
                  ) : !isFuture && hasData ? (
                    <div className="flex flex-wrap gap-0.5">
                      {summary.present > 0 && (
                        <span className="text-[9px] leading-tight bg-green-100 text-green-700 rounded px-1 py-0.5">
                          {summary.present}P
                        </span>
                      )}
                      {summary.halfDay > 0 && (
                        <span className="text-[9px] leading-tight bg-yellow-100 text-yellow-700 rounded px-1 py-0.5">
                          {summary.halfDay}H
                        </span>
                      )}
                      {summary.sl > 0 && (
                        <span className="text-[9px] leading-tight bg-amber-100 text-amber-700 rounded px-1 py-0.5">
                          {summary.sl}SL
                        </span>
                      )}
                      {summary.slnf > 0 && (
                        <span className="text-[9px] leading-tight bg-gray-100 text-gray-700 rounded px-1 py-0.5">
                          {summary.slnf}?
                        </span>
                      )}
                      {summary.absent > 0 && (
                        <span className="text-[9px] leading-tight bg-red-100 text-red-700 rounded px-1 py-0.5">
                          {summary.absent}A
                        </span>
                      )}
                      {summary.leave > 0 && (
                        <span className="text-[9px] leading-tight bg-blue-100 text-blue-700 rounded px-1 py-0.5">
                          {summary.leave}L
                        </span>
                      )}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-border">
          {[
            { label: 'P = Present',       cls: 'bg-green-100 text-green-700' },
            { label: 'H = Half Day',      cls: 'bg-yellow-100 text-yellow-700' },
            { label: 'SL = Short Leave',  cls: 'bg-amber-100 text-amber-700' },
            { label: '? = Log Not Found', cls: 'bg-gray-100 text-gray-700' },
            { label: 'A = Absent',        cls: 'bg-red-100 text-red-700' },
            { label: 'L = PL / LWP',     cls: 'bg-blue-100 text-blue-700' },
            { label: 'Holiday',           cls: 'bg-purple-100 text-purple-700' },
          ].map(({ label, cls }) => (
            <span key={label} className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Day detail panel */}
      <div className="card">
        {/* Detail header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <div>
            <h3 className="text-base font-semibold text-text-primary">{selectedDateDisplay}</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              {selectedDayMap.size} of {users.length} employees marked
            </p>
          </div>
          {/* Summary chips */}
          <div className="flex flex-wrap gap-2">
            {[
              { count: totalPresent, label: 'Present',       cls: 'bg-green-50 text-green-700 border border-green-200' },
              { count: totalHalf,    label: 'Half Day',      cls: 'bg-yellow-50 text-yellow-700 border border-yellow-200' },
              { count: totalSL,      label: 'Short Leave',   cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
              { count: totalSLNF,    label: 'Log Not Found', cls: 'bg-gray-50 text-gray-700 border border-gray-200' },
              { count: totalAbsent,  label: 'Absent',        cls: 'bg-red-50 text-red-700 border border-red-200' },
              { count: totalLeave,   label: 'On Leave',      cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
              { count: totalWo,      label: 'WO',            cls: 'bg-sky-50 text-sky-700 border border-sky-200' },
            ].map(({ count, label, cls }) => (
              <span key={label} className={`text-xs px-2.5 py-1 rounded-lg font-medium ${cls}`}>
                {count} {label}
              </span>
            ))}
          </div>
        </div>

        {/* Holiday banner / editor — admin marks the day a company-wide holiday */}
        <div className="mb-4">
          {selectedHoliday && !holidayForm ? (
            <div className="flex items-start justify-between gap-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Holiday</span>
                  <span className="font-semibold text-text-primary text-sm">{selectedHoliday.title}</span>
                </div>
                {selectedHoliday.description && (
                  <p className="text-xs text-text-secondary mt-1">{selectedHoliday.description}</p>
                )}
                <p className="text-[11px] text-text-secondary/70 mt-1 italic">Skipped like a Sunday — no attendance or salary effect.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setHolidayForm({ title: selectedHoliday.title, description: selectedHoliday.description || '' })}
                  className="btn-outline !py-1 !px-3 !text-xs"
                >
                  Edit
                </button>
                <button onClick={removeHoliday} disabled={holidaySaving} className="btn-danger !py-1 !px-3 !text-xs disabled:opacity-50">
                  {holidaySaving ? '…' : 'Remove'}
                </button>
              </div>
            </div>
          ) : holidayForm ? (
            <div className="p-4 rounded-lg bg-purple-50 border border-purple-200 space-y-3">
              <div className="text-sm font-semibold text-text-primary">
                {selectedHoliday ? 'Edit holiday' : 'Mark as holiday'} · {selectedDate}
              </div>
              <div>
                <label className="label">Title <span className="text-red-500">*</span></label>
                <input
                  className="input"
                  value={holidayForm.title}
                  onChange={e => setHolidayForm(f => ({ ...f!, title: e.target.value }))}
                  placeholder="e.g. Diwali"
                />
              </div>
              <div>
                <label className="label">Description</label>
                <textarea
                  className="input min-h-[60px]"
                  value={holidayForm.description}
                  onChange={e => setHolidayForm(f => ({ ...f!, description: e.target.value }))}
                  placeholder="Optional note shown with the holiday"
                />
              </div>
              {holidayError && <p className="text-xs text-red-600">{holidayError}</p>}
              <div className="flex gap-2">
                <button onClick={saveHoliday} disabled={holidaySaving || !holidayForm.title.trim()} className="btn-primary !py-1.5 !px-4 !text-sm disabled:opacity-50">
                  {holidaySaving ? 'Saving…' : 'Save holiday'}
                </button>
                <button onClick={() => { setHolidayForm(null); setHolidayError(''); }} className="btn-outline !py-1.5 !px-4 !text-sm">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button onClick={() => setHolidayForm({ title: '', description: '' })} className="btn-outline !py-1.5 !px-3 !text-xs">
              + Mark as holiday
            </button>
          )}
        </div>

        <div className="mb-4 flex items-center gap-3">
          <select
            value={employeeFilter}
            onChange={e => setEmployeeFilter(e.target.value)}
            className="input text-sm !py-2 !w-auto min-w-[180px]"
          >
            <option value="">All Employees</option>
            {[...users].sort((a, b) => a.name.localeCompare(b.name)).map(u => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
          <ExportButton onClick={exportXlsx} disabled={loading || users.length === 0} />
        </div>

        {saveError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            {saveError}
          </div>
        )}

        {users.length === 0 ? (
          <p className="text-text-secondary text-sm text-center py-8">No employees found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Name</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Emp ID</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Role</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Planned Shift</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Status</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">First In / Out</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Last In / Out</th>
                  <th className="text-left py-2.5 font-medium text-text-secondary">PL Balance</th>
                </tr>
              </thead>
              <tbody>
                {[...users]
                  .filter(u => !employeeFilter || u.id === employeeFilter)
                  .sort((a, b) => {
                    const roleOrder: Record<string, number> = { office: 0, admin: 1, operations: 2 };
                    return (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3) || a.name.localeCompare(b.name);
                  })
                  .map(user => {
                    const statusDoc  = selectedDayMap.get(user.id);
                    const status     = statusDoc?.status;
                    const isOps      = user.role === 'operations';
                    const saveKey    = `${user.id}__${selectedDate}`;
                    const isSaving   = saving[saveKey] || false;
                    const isDirty    = dirtyPlans.has(saveKey);

                    const userEvents   = eventsLoading ? [] : selectedEvents.filter(e => e.userId === user.id);

                    // Chronologically paired visits; first/last visit drive the two columns.
                    const visits     = buildVisits(userEvents, isOps);
                    const firstVisit = visits[0] ?? null;
                    const lastVisit  = visits.length > 1 ? visits[visits.length - 1] : null;
                    const planned      = selectedPlanMap.get(user.id);
                    const hasPlan      = !!(planned?.startTime && planned?.endTime);
                    // Derive status live from events (+ planned window for ops) until the Cloud
                    // Function runs. Holidays are skipped like Sundays — no live status.
                    const derivedStatus = !status && !eventsLoading && !selectedHoliday
                      ? deriveStatus(user.role, userEvents, selectedDate, planned)
                      : null;
                    const displayStatus = status ?? derivedStatus;

                    return (
                      <tr key={user.id} className="border-b border-border/40 hover:bg-background/60 transition-colors">
                        <td className="py-3 pr-4 font-medium text-text-primary">{user.name}</td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">{user.employeeId || '—'}</td>
                        <td className="py-3 pr-4"><RoleBadge role={user.role} /></td>
                        <td className="py-3 pr-4">
                          {isOps ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="time"
                                value={planned?.startTime || ''}
                                onChange={e => handlePlannedChange(user, selectedDate, 'start', e.target.value)}
                                disabled={isSaving || selectedDate > todayStr}
                                className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
                              />
                              <span className="text-text-secondary text-xs">–</span>
                              <input
                                type="time"
                                value={planned?.endTime || ''}
                                onChange={e => handlePlannedChange(user, selectedDate, 'end', e.target.value)}
                                disabled={isSaving || selectedDate > todayStr}
                                className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
                              />
                              <span className="text-text-secondary text-[11px] pl-1" title="Pre-declared overtime (minutes). OT worked up to this is auto-approved; anything beyond prompts admin review.">+OT</span>
                              <input
                                type="number"
                                min="0"
                                step="15"
                                value={planned?.declaredOtMins ? planned.declaredOtMins : ''}
                                onChange={e => handlePlannedChange(user, selectedDate, 'ot', e.target.value)}
                                disabled={isSaving || selectedDate > todayStr || !planned?.startTime || !planned?.endTime}
                                placeholder="0"
                                title="Pre-declared overtime in minutes"
                                className="w-14 text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:border-primary disabled:opacity-50"
                              />
                              <span className="text-text-secondary text-[10px]">min</span>
                              {isDirty && (
                                <button
                                  onClick={() => savePlanned(user.id, selectedDate)}
                                  disabled={isSaving || !planned?.startTime || !planned?.endTime}
                                  className="btn-primary !py-1 !px-2.5 !text-xs disabled:opacity-50"
                                >
                                  {isSaving ? 'Saving…' : 'Save'}
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-text-secondary">10:00 – 18:00</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {displayStatus ? (
                              <>
                                <StatusBadge status={displayStatus} />
                                {!status && derivedStatus && (
                                  <span className="text-[10px] text-text-secondary italic">live</span>
                                )}
                              </>
                            ) : isOps && !hasPlan ? (
                              <span className="text-xs text-text-secondary italic">Set plan</span>
                            ) : (
                              <span className="text-xs text-text-secondary italic">No data</span>
                            )}
                            {isOps && (status === 'WO' ? (
                              <button onClick={() => clearWo(user.id, selectedDate)} disabled={isSaving}
                                className="text-[11px] text-text-secondary underline hover:text-primary disabled:opacity-50">clear</button>
                            ) : (
                              <button onClick={() => markWo(user, selectedDate)} disabled={isSaving}
                                title="Mark a paid no-work day off (owes 8h, payable by OT this month)"
                                className="text-[11px] text-[#1A5FAF] border border-[#CFE0F3] bg-[#F2F7FC] rounded px-1.5 py-0.5 hover:bg-[#E7F0FA] disabled:opacity-50">Mark WO</button>
                            ))}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">
                          {eventsLoading ? '…' : <VisitCell visit={firstVisit} />}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">
                          {eventsLoading ? '…' : <VisitCell visit={lastVisit} />}
                        </td>
                        <td className="py-3 text-text-secondary text-xs">
                          {user.plBalance !== undefined ? (
                            <span className="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded text-xs">
                              {user.plBalance} PL
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
