'use client';
import { useEffect, useState } from 'react';
import { getDashboardStats, getConveyanceConfig, setConveyanceConfig } from '@/lib/firestore';

interface Stats { totalUsers: number; totalSites: number; pendingLeaves: number; todayCheckIns: number; }

const STAT_CARDS = [
  { key: 'totalUsers',    icon: '👥', label: 'Total Employees', color: 'bg-blue-50 border-blue-200' },
  { key: 'totalSites',    icon: '🏗️', label: 'Active Sites',    color: 'bg-emerald-50 border-emerald-200' },
  { key: 'pendingLeaves', icon: '📅', label: 'Pending Leaves',  color: 'bg-amber-50 border-amber-200' },
  { key: 'todayCheckIns', icon: '📋', label: "Today's Check-ins", color: 'bg-purple-50 border-purple-200' },
];

export default function DashboardPage() {
  const [stats, setStats]     = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const [rate1, setRate1]           = useState('');
  const [rate2, setRate2]           = useState('');
  const [ratesLoading, setRatesLoading] = useState(true);
  const [ratesSaving, setRatesSaving]   = useState(false);
  const [ratesMsg, setRatesMsg]     = useState('');

  useEffect(() => {
    getDashboardStats()
      .then(setStats)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));

    getConveyanceConfig()
      .then(c => { setRate1(c.rate1 ? String(c.rate1) : ''); setRate2(c.rate2 ? String(c.rate2) : ''); })
      .catch((err: unknown) => setRatesMsg(err instanceof Error ? err.message : String(err)))
      .finally(() => setRatesLoading(false));
  }, []);

  async function saveRates() {
    setRatesMsg('');
    const r1 = parseFloat(rate1) || 0;
    const r2 = parseFloat(rate2) || 0;
    if (r1 <= 0 && r2 <= 0) { setRatesMsg('Enter at least one rate.'); return; }
    setRatesSaving(true);
    try {
      await setConveyanceConfig(r1, r2);
      setRatesMsg('Saved');
      setTimeout(() => setRatesMsg(''), 2000);
    } catch (err: unknown) {
      setRatesMsg(err instanceof Error ? err.message : 'Failed to save.');
    }
    setRatesSaving(false);
  }

  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
        <p className="text-text-secondary text-sm mt-1">{today}</p>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>}

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {[1,2,3,4].map(i => <div key={i} className="card animate-pulse h-32" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {STAT_CARDS.map(card => (
            <div key={card.key} className={`card border ${card.color}`}>
              <div className="text-3xl mb-3">{card.icon}</div>
              <div className="text-3xl font-bold text-text-primary">
                {stats ? stats[card.key as keyof Stats] : '—'}
              </div>
              <div className="text-text-secondary text-sm mt-1">{card.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <h2 className="font-bold text-text-primary mb-4">Conveyance Rates</h2>
          {ratesLoading ? (
            <div className="text-text-secondary text-sm">Loading…</div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="label">Conveyance 1 (₹/km)</label>
                <input className="input" type="number" step="any" min="0" value={rate1} onChange={e => setRate1(e.target.value)} placeholder="e.g. 2.5" />
              </div>
              <div>
                <label className="label">Conveyance 2 (₹/km)</label>
                <input className="input" type="number" step="any" min="0" value={rate2} onChange={e => setRate2(e.target.value)} placeholder="e.g. 4.0" />
              </div>
              <div className="flex items-center gap-3">
                <button className="btn-primary" onClick={saveRates} disabled={ratesSaving}>
                  {ratesSaving ? 'Saving…' : 'Save Rates'}
                </button>
                {ratesMsg && (
                  <span className={`text-sm ${ratesMsg === 'Saved' ? 'text-green-600' : 'text-red-500'}`}>{ratesMsg}</span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="font-bold text-text-primary mb-4">Quick Actions</h2>
          <div className="space-y-2">
            {[
              { href: '/users', label: '+ Add new employee', icon: '👤' },
              { href: '/leaves', label: 'Review pending leaves', icon: '✅' },
            ].map(a => (
              <a key={a.href} href={a.href} className="flex items-center gap-3 p-3 rounded-lg hover:bg-background transition-colors text-sm text-primary font-medium">
                <span>{a.icon}</span>{a.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
