'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { getConveyanceForMonth } from '@/lib/firestore';
import type { ConveyanceRecord } from '@/types';

export default function ConveyancePage() {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [records, setRecords] = useState<ConveyanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getConveyanceForMonth(month);
      setRecords(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, [month]);

  useEffect(() => { loadData(); }, [loadData]);

  const sorted = useMemo(
    () => [...records].sort((a, b) => a.date.localeCompare(b.date) || a.userName.localeCompare(b.userName)),
    [records],
  );

  const summary = useMemo(() => {
    const map = new Map<string, { userName: string; employeeId: string; totalKm: number; totalConveyance: number; days: number }>();
    records.forEach(r => {
      const entry = map.get(r.userId) || { userName: r.userName, employeeId: r.employeeId, totalKm: 0, totalConveyance: 0, days: 0 };
      entry.totalKm += r.totalKm;
      entry.totalConveyance += r.conveyance;
      entry.days += 1;
      map.set(r.userId, entry);
    });
    return Array.from(map.values()).sort((a, b) => a.userName.localeCompare(b.userName));
  }, [records]);

  const grandTotal = summary.reduce((s, e) => s + e.totalConveyance, 0);
  const grandKm    = summary.reduce((s, e) => s + e.totalKm, 0);

  const monthLabel = new Date(month + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  function changeMonth(delta: number) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Conveyance</h1>
        <p className="text-text-secondary text-sm mt-1">Monthly conveyance records computed by the Cloud Function</p>
      </div>

      {/* Month picker */}
      <div className="card mb-6">
        <div className="flex items-center justify-between">
          <button onClick={() => changeMonth(-1)} className="p-2 rounded-lg text-text-secondary hover:bg-background hover:text-text-primary transition-colors text-lg leading-none">‹</button>
          <h2 className="text-base font-semibold text-text-primary">{monthLabel}</h2>
          <button onClick={() => changeMonth(1)} className="p-2 rounded-lg text-text-secondary hover:bg-background hover:text-text-primary transition-colors text-lg leading-none">›</button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>
      )}

      {/* Employee summary */}
      <div className="card mb-6">
        <h2 className="font-bold text-text-primary mb-4">Employee Summary</h2>
        {loading ? (
          <div className="text-text-secondary text-sm py-4 text-center">Loading…</div>
        ) : summary.length === 0 ? (
          <div className="text-text-secondary text-sm py-4 text-center">No conveyance data for {monthLabel}.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-background border-b border-border">
                <tr>
                  {['Employee', 'Emp ID', 'Days', 'Total KM', 'Total Conveyance'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-text-secondary uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summary.map(s => (
                  <tr key={s.employeeId} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3 font-medium text-text-primary">{s.userName}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.employeeId || '—'}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.days}</td>
                    <td className="px-4 py-3 text-text-secondary">{s.totalKm.toFixed(2)} km</td>
                    <td className="px-4 py-3 font-medium text-text-primary">₹{s.totalConveyance.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-border">
                <tr className="font-bold">
                  <td className="px-4 py-3 text-text-primary" colSpan={2}>Grand Total</td>
                  <td className="px-4 py-3 text-text-secondary">{summary.reduce((s, e) => s + e.days, 0)}</td>
                  <td className="px-4 py-3 text-text-secondary">{grandKm.toFixed(2)} km</td>
                  <td className="px-4 py-3 text-text-primary">₹{grandTotal.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Daily breakdown */}
      <div className="card">
        <h2 className="font-bold text-text-primary mb-4">Daily Breakdown</h2>
        {loading ? (
          <div className="text-text-secondary text-sm py-4 text-center">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="text-text-secondary text-sm py-4 text-center">No records.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-background border-b border-border">
                <tr>
                  {['Date', 'Employee', 'Emp ID', 'Route', 'KM', 'Rate', 'Conveyance'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold text-text-secondary uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map(r => (
                  <tr key={r.id} className="hover:bg-background transition-colors">
                    <td className="px-4 py-3 text-text-secondary whitespace-nowrap">{r.date}</td>
                    <td className="px-4 py-3 font-medium text-text-primary">{r.userName}</td>
                    <td className="px-4 py-3 text-text-secondary">{r.employeeId || '—'}</td>
                    <td className="px-4 py-3 text-text-secondary text-xs max-w-xs truncate" title={r.route}>{r.route}</td>
                    <td className="px-4 py-3 text-text-secondary">{r.totalKm.toFixed(2)}</td>
                    <td className="px-4 py-3 text-text-secondary">₹{r.ratePerKm}/km</td>
                    <td className="px-4 py-3 font-medium text-text-primary">₹{r.conveyance.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
