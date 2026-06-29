'use client';
import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getAllRegularizationRequests, approveRegularization, rejectRegularization } from '@/lib/firestore';
import type { RegularizationRequest } from '@/types';
import ExportButton from '@/components/ExportButton';
import { downloadSheet } from '@/lib/excel';

type Filter = 'pending' | 'approved' | 'rejected' | 'all';

const ATTENDANCE_STATUSES = ['Present', 'HalfDay', 'Absent', 'PL', 'LWP', 'WO'] as const;

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'approved' ? 'badge-approved' : status === 'rejected' ? 'badge-rejected' : 'badge-pending';
  return <span className={cls}>{status}</span>;
}

function OriginalBadge({ status }: { status: string }) {
  const bg = status === 'Absent' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700';
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${bg}`}>{status}</span>;
}

function ApprovedStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Present:  'bg-green-100 text-green-700',
    HalfDay:  'bg-amber-100 text-amber-700',
    Absent:   'bg-red-100 text-red-700',
    PL:       'bg-blue-100 text-blue-700',
    LWP:      'bg-purple-100 text-purple-700',
    WO:       'bg-sky-100 text-sky-700',
  };
  const cls = colors[status] ?? 'bg-gray-100 text-gray-600';
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>→ {status}</span>;
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function offsetMonth(ym: string, offset: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function RegularizationPage() {
  const [requests, setRequests]       = useState<RegularizationRequest[]>([]);
  const [filter, setFilter]           = useState<Filter>('pending');
  const [month, setMonth]             = useState(currentYearMonth());
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [adminName, setAdminName]     = useState('Admin');
  const [actionModal, setActionModal] = useState<{ req: RegularizationRequest; type: 'approve' | 'reject' } | null>(null);
  const [actionComment, setActionComment]     = useState('');
  const [approvedStatus, setApprovedStatus]   = useState<string>('Present');
  const [actioning, setActioning]     = useState('');
  const [employeeFilter, setEmployeeFilter]   = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (user) {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) setAdminName(snap.data().name ?? 'Admin');
      }
    });
    return unsub;
  }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await getAllRegularizationRequests(filter === 'all' ? undefined : filter);
      setRequests(data.filter(r => r.date.startsWith(month)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [filter, month]);

  function openModal(req: RegularizationRequest, type: 'approve' | 'reject') {
    setActionModal({ req, type });
    setActionComment('');
    setApprovedStatus('Present');
  }

  async function handleAction() {
    if (!actionModal) return;
    const { req, type } = actionModal;
    setActioning(req.id);
    try {
      if (type === 'approve') {
        await approveRegularization(req.userId, req.id, req.date, adminName, actionComment, approvedStatus, req.userName, req.employeeId);
      } else {
        await rejectRegularization(req.userId, req.id, adminName, actionComment);
      }
      setActionModal(null);
      setActionComment('');
      await load();
    } catch {
      setError(`${type === 'approve' ? 'Approval' : 'Rejection'} failed.`);
    }
    setActioning('');
  }

  const isApproveDisabled = !!actioning || actionComment.trim() === '';
  const isRejectDisabled  = !!actioning || actionComment.trim() === '';

  const FILTERS: Filter[] = ['pending', 'approved', 'rejected', 'all'];
  const filteredRequests = employeeFilter ? requests.filter(r => r.userId === employeeFilter) : requests;

  function exportXlsx() {
    downloadSheet(`regularization_${month}`, 'Regularization', filteredRequests.map(r => ({
      Date: r.date,
      Employee: r.userName,
      'Emp ID': r.employeeId,
      'Original Status': r.originalStatus,
      Reason: r.reason,
      Status: r.status,
      'Approved Status': r.approvedStatus ?? '',
      'Approved By': r.approvedBy ?? '',
      Comment: r.approverComment ?? '',
    })));
  }

  return (
    <div>

      {/* Month selector */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => setMonth(offsetMonth(month, -1))} className="btn-outline text-sm py-1 px-3">&larr;</button>
        <span className="text-lg font-semibold text-text-primary min-w-[160px] text-center">
          {formatMonthLabel(month)}
        </span>
        <button onClick={() => setMonth(offsetMonth(month, 1))} className="btn-outline text-sm py-1 px-3">&rarr;</button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors ${
              filter === f
                ? 'bg-primary text-white'
                : 'bg-white border border-border text-text-secondary hover:border-primary hover:text-primary'
            }`}>
            {f}
          </button>
        ))}
        <select
          value={employeeFilter}
          onChange={e => setEmployeeFilter(e.target.value)}
          className="ml-auto input text-sm !py-2 min-w-[180px]"
        >
          <option value="">All Employees</option>
          {Array.from(new Map(requests.map(r => [r.userId, r.userName])))
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
        </select>
        <ExportButton onClick={exportXlsx} disabled={loading || filteredRequests.length === 0} />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>
      )}

      <div className="card p-0 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-text-secondary">Loading&hellip;</div>
        ) : filteredRequests.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">
            No {filter === 'all' ? '' : filter} regularization requests for {formatMonthLabel(month)}.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                {['Employee', 'Date', 'Original', 'Outcome', 'Reason / Comment', 'Status', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-text-secondary uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredRequests.map(r => (
                <tr key={r.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{r.userName}</div>
                    <div className="text-xs text-text-secondary">{r.employeeId}</div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary whitespace-nowrap">{r.date}</td>
                  <td className="px-4 py-3"><OriginalBadge status={r.originalStatus} /></td>
                  <td className="px-4 py-3">
                    {r.status === 'approved' && r.approvedStatus
                      ? <ApprovedStatusBadge status={r.approvedStatus} />
                      : <span className="text-text-secondary text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-text-secondary max-w-xs">
                    <p className="truncate">{r.reason}</p>
                    {r.approverComment && (
                      <p className={`text-xs mt-0.5 italic ${r.status === 'rejected' ? 'text-red-500' : 'text-green-600'}`}>
                        &ldquo;{r.approverComment}&rdquo;
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3">
                    {r.status === 'pending' ? (
                      <div className="flex gap-2">
                        <button className="btn-success text-xs py-1 px-3"
                          disabled={actioning === r.id}
                          onClick={() => openModal(r, 'approve')}>
                          Approve
                        </button>
                        <button className="btn-danger text-xs py-1 px-3"
                          disabled={actioning === r.id}
                          onClick={() => openModal(r, 'reject')}>
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-text-secondary">{r.approvedBy}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-text-primary mb-1">
              {actionModal.type === 'approve' ? 'Approve' : 'Reject'} Regularization
            </h2>
            <p className="text-text-secondary text-sm mb-5">
              <span className="font-semibold text-text-primary">{actionModal.req.userName}</span>
              &ensp;&mdash;&ensp;{actionModal.req.date}
              &ensp;&middot;&ensp;Auto-marked: <span className="font-semibold">{actionModal.req.originalStatus}</span>
            </p>

            {actionModal.type === 'approve' && (
              <div className="mb-4">
                <label className="label">Set attendance status to</label>
                <select
                  className="input mt-1"
                  value={approvedStatus}
                  onChange={e => setApprovedStatus(e.target.value)}
                >
                  {ATTENDANCE_STATUSES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="mb-1">
              <label className="label">
                {actionModal.type === 'approve' ? 'Reason for approval' : 'Reason for rejection'}
                <span className="text-red-500 ml-1">*</span>
              </label>
              <textarea
                className="input mt-1 min-h-[80px]"
                value={actionComment}
                onChange={e => setActionComment(e.target.value)}
                placeholder="Enter reason…"
              />
            </div>

            <div className="flex gap-3 mt-5">
              <button
                className={`${actionModal.type === 'approve' ? 'btn-success' : 'btn-danger'} flex-1`}
                onClick={handleAction}
                disabled={actionModal.type === 'approve' ? isApproveDisabled : isRejectDisabled}
              >
                {actionModal.type === 'approve' ? 'Approve' : 'Reject'}
              </button>
              <button className="btn-outline flex-1" onClick={() => setActionModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
