'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { getAllUsers, getAttendanceForDate, getAttendanceStatusForMonth, setAttendanceStatus } from '@/lib/firestore';
import type { User, AttendanceRecord, AttendanceStatus } from '@/types';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_STYLES: Record<string, string> = {
  Present:  'bg-green-100 text-green-700 border-green-200',
  HalfDay:  'bg-yellow-100 text-yellow-700 border-yellow-200',
  Absent:   'bg-red-100 text-red-700 border-red-200',
  PL:       'bg-blue-100 text-blue-700 border-blue-200',
  UPL:      'bg-orange-100 text-orange-700 border-orange-200',
};

const STATUS_LABEL: Record<string, string> = {
  Present: 'Present',
  HalfDay: 'Half Day',
  Absent:  'Absent',
  PL:      'PL',
  UPL:     'UPL',
};

function formatTime(ts: { toDate: () => Date } | undefined) {
  if (!ts) return '—';
  return ts.toDate().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function toDateStr(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Derives Present/HalfDay from raw events when Cloud Function hasn't run yet.
// Returns null if there are no events (can't determine Absent/PL/UPL client-side).
function deriveStatusFromEvents(userEvents: AttendanceRecord[]): AttendanceStatus['status'] | null {
  const ts = (e: AttendanceRecord) => (e.timestamp as unknown as { seconds: number })?.seconds ?? 0;
  const checkIns  = userEvents.filter(e => e.type === 'office_in').sort((a, b) => ts(a) - ts(b));
  const checkOuts = userEvents.filter(e => e.type === 'office_out').sort((a, b) => ts(a) - ts(b));
  if (checkIns.length === 0) return null;

  const firstInDate = checkIns[0].timestamp?.toDate();
  if (!firstInDate) return null;

  // Use UTC+5:30 offset to get IST time regardless of browser timezone
  const toIST = (d: Date) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const inIST = toIST(firstInDate);
  const inMinutes = inIST.getUTCHours() * 60 + inIST.getUTCMinutes();
  const lateIn = inMinutes > 10 * 60; // after 10:00 AM

  let earlyOut = true; // no checkout = half day condition
  if (checkOuts.length > 0) {
    const lastOutDate = checkOuts[checkOuts.length - 1].timestamp?.toDate();
    if (lastOutDate) {
      const outIST = toIST(lastOutDate);
      const outMinutes = outIST.getUTCHours() * 60 + outIST.getUTCMinutes();
      earlyOut = outMinutes < 18 * 60; // before 6:00 PM
    }
  }

  return lateIn || earlyOut ? 'HalfDay' : 'Present';
}

export default function AttendancePage() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const [viewDate, setViewDate]         = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [users, setUsers]               = useState<User[]>([]);
  // date → userId → AttendanceStatus
  const [statusByDate, setStatusByDate] = useState<Map<string, Map<string, AttendanceStatus>>>(new Map());
  const [selectedEvents, setSelectedEvents] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading]           = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [saving, setSaving]             = useState<Record<string, boolean>>({});
  const [saveError, setSaveError]       = useState('');

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

    setLoading(false);
  }, [year, month]);

  useEffect(() => { loadMonthData(); }, [loadMonthData]);

  // Load raw events when selected date changes
  useEffect(() => {
    if (!selectedDate) return;
    setEventsLoading(true);
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
    if (!dayMap) return { present: 0, halfDay: 0, absent: 0, leave: 0 };
    let present = 0, halfDay = 0, absent = 0, leave = 0;
    dayMap.forEach(s => {
      if (s.status === 'Present')  present++;
      else if (s.status === 'HalfDay') halfDay++;
      else if (s.status === 'Absent')  absent++;
      else if (s.status === 'PL' || s.status === 'UPL') leave++;
    });
    return { present, halfDay, absent, leave };
  }

  async function handleOpsStatus(user: User, date: string, newStatus: AttendanceStatus['status']) {
    const key = `${user.id}__${date}`;
    setSaving(prev => ({ ...prev, [key]: true }));
    setSaveError('');
    try {
      const statusData: Omit<AttendanceStatus, 'id' | 'updatedAt'> = {
        date,
        userId:     user.id,
        userName:   user.name,
        employeeId: user.employeeId || '',
        role:       'operations',
        status:     newStatus,
        markedBy:   'admin',
      };
      await setAttendanceStatus(user.id, date, statusData);
      setStatusByDate(prev => {
        const next = new Map(prev);
        if (!next.has(date)) next.set(date, new Map());
        const dayMap = new Map(next.get(date)!);
        dayMap.set(user.id, { id: date, ...statusData });
        next.set(date, dayMap);
        return next;
      });
    } catch (err) {
      setSaveError('Failed to save. Please try again.');
      console.error(err);
    }
    setSaving(prev => ({ ...prev, [key]: false }));
  }

  const selectedDayMap = statusByDate.get(selectedDate) || new Map<string, AttendanceStatus>();

  // Merge stored (Cloud Function) statuses with client-side derived statuses for the summary chips
  const effectiveStatuses = useMemo(() => {
    const map = new Map<string, AttendanceStatus['status']>();
    users.forEach(user => {
      const stored = selectedDayMap.get(user.id)?.status;
      if (stored) {
        map.set(user.id, stored);
      } else if (user.role !== 'operations' && !eventsLoading) {
        const derived = deriveStatusFromEvents(selectedEvents.filter(e => e.userId === user.id));
        if (derived) map.set(user.id, derived);
      }
    });
    return map;
  }, [users, selectedDayMap, selectedEvents, eventsLoading]);

  const totalPresent = Array.from(effectiveStatuses.values()).filter(s => s === 'Present').length;
  const totalHalf    = Array.from(effectiveStatuses.values()).filter(s => s === 'HalfDay').length;
  const totalAbsent  = Array.from(effectiveStatuses.values()).filter(s => s === 'Absent').length;
  const totalLeave   = Array.from(effectiveStatuses.values()).filter(s => s === 'PL' || s === 'UPL').length;

  const selectedDateDisplay = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Attendance Management</h1>
        <p className="text-text-secondary text-sm mt-1">
          Calendar view · Office/admin status is auto-computed · Operations status is set manually
        </p>
      </div>

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
              const summary   = getDaySummary(ds);
              const hasData   = summary.present + summary.halfDay + summary.absent + summary.leave > 0;

              return (
                <button
                  key={i}
                  onClick={() => !isFuture && setSelectedDate(ds)}
                  disabled={isFuture}
                  className={`min-h-[60px] p-1.5 rounded-lg text-left transition-all border ${
                    isSelected
                      ? 'border-primary bg-accent-light shadow-sm'
                      : isToday
                      ? 'border-primary/40 bg-background'
                      : 'border-transparent hover:border-border hover:bg-background'
                  } ${isFuture ? 'opacity-30 cursor-default' : 'cursor-pointer'}`}
                >
                  <div className={`text-xs font-bold mb-1 ${isToday ? 'text-primary' : 'text-text-primary'}`}>
                    {day}
                  </div>
                  {!isFuture && hasData && (
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
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-border">
          {[
            { label: 'P = Present',   cls: 'bg-green-100 text-green-700' },
            { label: 'H = Half Day',  cls: 'bg-yellow-100 text-yellow-700' },
            { label: 'A = Absent',    cls: 'bg-red-100 text-red-700' },
            { label: 'L = PL / UPL', cls: 'bg-blue-100 text-blue-700' },
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
              { count: totalPresent, label: 'Present',  cls: 'bg-green-50 text-green-700 border border-green-200' },
              { count: totalHalf,    label: 'Half Day', cls: 'bg-yellow-50 text-yellow-700 border border-yellow-200' },
              { count: totalAbsent,  label: 'Absent',   cls: 'bg-red-50 text-red-700 border border-red-200' },
              { count: totalLeave,   label: 'On Leave', cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
            ].map(({ count, label, cls }) => (
              <span key={label} className={`text-xs px-2.5 py-1 rounded-lg font-medium ${cls}`}>
                {count} {label}
              </span>
            ))}
          </div>
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
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Status</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Check In</th>
                  <th className="text-left py-2.5 pr-4 font-medium text-text-secondary">Check Out</th>
                  <th className="text-left py-2.5 font-medium text-text-secondary">PL Balance</th>
                </tr>
              </thead>
              <tbody>
                {[...users]
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

                    const userEvents   = eventsLoading ? [] : selectedEvents.filter(e => e.userId === user.id);
                    const firstIn      = userEvents.find(e => e.type.endsWith('_in'));
                    const lastOut      = [...userEvents].reverse().find(e => e.type.endsWith('_out'));
                    // For office/admin: derive status from events when Cloud Function hasn't run yet
                    const derivedStatus = !isOps && !status && !eventsLoading
                      ? deriveStatusFromEvents(userEvents)
                      : null;
                    const displayStatus = status ?? derivedStatus;

                    return (
                      <tr key={user.id} className="border-b border-border/40 hover:bg-background/60 transition-colors">
                        <td className="py-3 pr-4 font-medium text-text-primary">{user.name}</td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">{user.employeeId || '—'}</td>
                        <td className="py-3 pr-4">
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
                            user.role === 'operations'
                              ? 'bg-purple-50 text-purple-700 border-purple-200'
                              : user.role === 'admin'
                              ? 'bg-red-50 text-red-700 border-red-200'
                              : 'bg-sky-50 text-sky-700 border-sky-200'
                          }`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          {isOps ? (
                            <select
                              value={status || ''}
                              onChange={e => {
                                if (e.target.value) {
                                  handleOpsStatus(user, selectedDate, e.target.value as AttendanceStatus['status']);
                                }
                              }}
                              disabled={isSaving || selectedDate > todayStr}
                              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:border-primary disabled:opacity-50 min-w-[130px]"
                            >
                              <option value="">— Not Marked —</option>
                              <option value="Present">Present</option>
                              <option value="Absent">Absent</option>
                              <option value="PL">PL (Paid Leave)</option>
                              <option value="UPL">UPL (Unpaid Leave)</option>
                            </select>
                          ) : displayStatus ? (
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs px-2.5 py-1 rounded border font-medium ${STATUS_STYLES[displayStatus] || 'bg-background text-text-secondary border-border'}`}>
                                {STATUS_LABEL[displayStatus] || displayStatus}
                              </span>
                              {!status && derivedStatus && (
                                <span className="text-[10px] text-text-secondary italic">live</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-text-secondary italic">No data</span>
                          )}
                          {isSaving && <span className="ml-2 text-xs text-text-secondary">Saving…</span>}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">
                          {eventsLoading ? '…' : firstIn ? formatTime(firstIn.timestamp as Parameters<typeof formatTime>[0]) : '—'}
                        </td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">
                          {eventsLoading ? '…' : lastOut ? formatTime(lastOut.timestamp as Parameters<typeof formatTime>[0]) : '—'}
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
