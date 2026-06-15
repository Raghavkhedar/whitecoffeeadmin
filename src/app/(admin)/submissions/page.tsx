'use client';
import { useEffect, useState } from 'react';
import { collectionGroup, getDocs, doc, updateDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, getDownloadURL } from 'firebase/storage';
import * as XLSX from 'xlsx';
import { db, auth } from '@/lib/firebase';

type CollectionKey = 'material_requests' | 'material_purchases' | 'material_transfers' | 'tool_transfers' | 'work_progress';

const COLLECTIONS: { key: CollectionKey; label: string; icon: string }[] = [
  { key: 'material_requests',  label: 'M&T Requests',      icon: '🔧' },
  { key: 'material_purchases', label: 'M&T Purchases',     icon: '🛒' },
  { key: 'material_transfers', label: 'Material Transfers', icon: '📦' },
  { key: 'tool_transfers',     label: 'Tool Transfers',     icon: '🔨' },
  { key: 'work_progress',      label: 'Work Progress',      icon: '📊' },
];

type FieldType = 'text' | 'number' | 'textarea';
interface EditableField { key: string; label: string; type: FieldType }

const EDITABLE_FIELDS: Record<CollectionKey, EditableField[]> = {
  material_requests: [
    { key: 'siteId',   label: 'Site ID',   type: 'text' },
    { key: 'siteName', label: 'Site Name', type: 'text' },
    { key: 'notes',    label: 'Notes',     type: 'textarea' },
  ],
  material_purchases: [
    { key: 'siteId',     label: 'Site ID',     type: 'text' },
    { key: 'siteName',   label: 'Site Name',   type: 'text' },
    { key: 'grandTotal', label: 'Grand Total', type: 'number' },
    { key: 'notes',      label: 'Notes',       type: 'textarea' },
  ],
  material_transfers: [
    { key: 'fromLocation',  label: 'From Location',  type: 'text' },
    { key: 'toLocation',    label: 'To Location',    type: 'text' },
    { key: 'transferredBy', label: 'Transferred By', type: 'text' },
    { key: 'receivedBy',    label: 'Received By',    type: 'text' },
    { key: 'transferDate',  label: 'Transfer Date',  type: 'text' },
    { key: 'notes',         label: 'Notes',          type: 'textarea' },
  ],
  tool_transfers: [
    { key: 'fromLocation',  label: 'From Location',  type: 'text' },
    { key: 'toLocation',    label: 'To Location',    type: 'text' },
    { key: 'transferredBy', label: 'Transferred By', type: 'text' },
    { key: 'receivedBy',    label: 'Received By',    type: 'text' },
    { key: 'transferDate',  label: 'Transfer Date',  type: 'text' },
    { key: 'notes',         label: 'Notes',          type: 'textarea' },
  ],
  work_progress: [
    { key: 'date',            label: 'Date',             type: 'text' },
    { key: 'siteId',          label: 'Site ID',          type: 'text' },
    { key: 'siteName',        label: 'Site Name',        type: 'text' },
    { key: 'hoursWorked',     label: 'Hours Worked',     type: 'number' },
    { key: 'workDescription', label: 'Work Description', type: 'textarea' },
    { key: 'notes',           label: 'Notes',            type: 'textarea' },
  ],
};

interface Row { id: string; _path: string; [key: string]: unknown }

function isTimestamp(v: unknown): v is { toDate: () => Date } {
  return !!v && typeof v === 'object' && 'toDate' in v;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (isTimestamp(v)) return v.toDate().toLocaleString('en-IN');
  if (Array.isArray(v)) return v.map(item =>
    typeof item === 'object' && item !== null
      ? Object.entries(item).map(([k, val]) => `${k}: ${val}`).join(', ')
      : String(item)
  ).join(' | ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function PhotosSection({ paths }: { paths: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (paths.length === 0) { setLoading(false); return; }
    const storage = getStorage();
    Promise.all(
      paths.map(p =>
        p.startsWith('https://')
          ? Promise.resolve(p)
          : getDownloadURL(ref(storage, p)).catch(() => null)
      )
    ).then(resolved => { setUrls(resolved); setLoading(false); });
  }, [paths]);

  if (paths.length === 0) return <span className="text-text-secondary italic text-xs">No photos</span>;
  if (loading) return <span className="text-text-secondary text-xs">Loading photos…</span>;

  const resolved = urls.filter(Boolean) as string[];
  if (resolved.length === 0) {
    return (
      <div className="space-y-1">
        {paths.map((p, i) => (
          <a key={i} href="https://console.firebase.google.com/" className="text-xs text-primary underline block truncate" title={p}>
            Photo {i + 1}: {p.split('/').pop()}
          </a>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {resolved.map((url, i) => (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`Photo ${i + 1}`} className="w-28 h-28 object-cover rounded-lg border border-border hover:opacity-90 transition-opacity" />
        </a>
      ))}
    </div>
  );
}

function DetailModal({ row, label, onClose }: { row: Row; label: string; onClose: () => void }) {
  const SKIP = new Set(['id', '_path']);
  const entries = Object.entries(row).filter(([k]) => !SKIP.has(k));

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-lg font-bold text-text-primary">{label} — Full Details</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto p-6 space-y-3">
          {entries.map(([key, val]) => (
            <div key={key} className="grid grid-cols-[180px_1fr] gap-3 text-sm">
              <span className="font-medium text-text-secondary capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
              <span className="text-text-primary break-words">
                {key === 'photoUrls' && Array.isArray(val) ? (
                  <PhotosSection paths={val as string[]} />
                ) : Array.isArray(val) ? (
                  <ul className="space-y-1">
                    {(val as unknown[]).map((item, i) => (
                      <li key={i} className="bg-background rounded px-2 py-1">
                        {typeof item === 'object' && item !== null
                          ? Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                              <span key={k} className="mr-3"><span className="text-text-secondary">{k}:</span> {String(v)}</span>
                            ))
                          : String(item)}
                      </li>
                    ))}
                  </ul>
                ) : fmtValue(val)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EditModal({
  row, collectionKey, label, onClose, onSaved,
}: {
  row: Row;
  collectionKey: CollectionKey;
  label: string;
  onClose: () => void;
  onSaved: (updated: Row) => void;
}) {
  const fields = EDITABLE_FIELDS[collectionKey];
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    fields.forEach(f => { init[f.key] = String(row[f.key] ?? ''); });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(key: string, value: string) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const updates: Record<string, unknown> = {};

      fields.forEach(f => {
        const before = row[f.key];
        const after: unknown = f.type === 'number' ? (parseFloat(form[f.key]) || 0) : form[f.key];
        if (String(before ?? '') !== String(after ?? '')) {
          changes[f.key] = { before: before ?? '', after };
          updates[f.key] = after;
        }
      });

      if (Object.keys(changes).length === 0) { onClose(); return; }

      await updateDoc(doc(db, row._path), updates);

      await addDoc(collection(db, 'submission_edits'), {
        collectionName: collectionKey,
        docPath: row._path,
        docId: row.id,
        employeeName: row.userName ?? '',
        editedBy: auth.currentUser?.displayName ?? auth.currentUser?.email ?? 'unknown',
        editedAt: serverTimestamp(),
        changes,
      });

      onSaved({ ...row, ...updates });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Edit {label}</h2>
            <p className="text-xs text-text-secondary mt-0.5">{String(row.userName ?? '')} · {String(row.employeeId ?? '')}</p>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-6 space-y-4">
          {fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1">{f.label}</label>
              {f.type === 'textarea' ? (
                <textarea
                  value={form[f.key]}
                  onChange={e => set(f.key, e.target.value)}
                  rows={3}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary resize-none"
                />
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : 'text'}
                  value={form[f.key]}
                  onChange={e => set(f.key, e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary"
                />
              )}
            </div>
          ))}

          {Array.isArray(row.items) && (row.items as unknown[]).length > 0 && (
            <div className="bg-background rounded-lg p-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Line Items (read-only)</p>
              <ul className="space-y-1">
                {(row.items as Record<string, unknown>[]).map((item, i) => (
                  <li key={i} className="text-xs text-text-secondary">
                    {Object.entries(item).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</p>}
        </div>

        <div className="p-6 border-t border-border flex gap-3 justify-end">
          <button onClick={onClose} className="btn-outline px-4 py-2 text-sm" disabled={saving}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SubmissionsPage() {
  const [active, setActive]   = useState<CollectionKey>('material_requests');
  const [rows, setRows]       = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [viewing, setViewing] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);

  async function load(col: CollectionKey) {
    setLoading(true);
    setError('');
    try {
      const snap = await getDocs(collectionGroup(db, col));
      const data: Row[] = snap.docs.map(d => ({ id: d.id, _path: d.ref.path, ...d.data() }));
      data.sort((a, b) => {
        const ta = (a.submittedAt as { seconds: number } | undefined)?.seconds ?? 0;
        const tb = (b.submittedAt as { seconds: number } | undefined)?.seconds ?? 0;
        return tb - ta;
      });
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    }
    setLoading(false);
  }

  useEffect(() => { load(active); }, [active]);

  function downloadExcel() {
    const exportRows = rows.map(row => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id' || k === '_path') continue;
        flat[k.replace(/([A-Z])/g, ' $1').trim()] = fmtValue(v);
      }
      return flat;
    });
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, active);
    XLSX.writeFile(wb, `${active}_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  function fmtDate(ts: unknown) {
    if (!isTimestamp(ts)) return '—';
    return ts.toDate().toLocaleDateString('en-IN');
  }

  function handleSaved(updated: Row) {
    setRows(prev => prev.map(r => r.id === updated.id ? updated : r));
    setEditing(null);
  }

  const activeLabel = COLLECTIONS.find(c => c.key === active)?.label ?? active;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Submissions</h1>
        <p className="text-text-secondary text-sm mt-1">All form submissions from field teams</p>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {COLLECTIONS.map(c => (
          <button key={c.key} onClick={() => setActive(c.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${active === c.key ? 'bg-primary text-white' : 'bg-white border border-border text-text-secondary hover:border-primary hover:text-primary'}`}>
            {c.icon} {c.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>}

      <div className="card p-0 overflow-hidden overflow-x-auto">
        {!loading && rows.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
            <span className="text-xs text-text-secondary font-medium">{rows.length} submission{rows.length !== 1 ? 's' : ''}</span>
            <button onClick={downloadExcel} className="btn-outline text-xs py-1.5 px-3 flex items-center gap-1.5">
              ⬇ Download Excel
            </button>
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-text-secondary">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">No submissions found.</div>
        ) : (
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-background border-b border-border">
              <tr>
                {['Employee', 'Site', 'Date Submitted', 'Items / Description', ''].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-text-secondary uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(row => (
                <tr key={row.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{String(row.userName ?? '—')}</div>
                    <div className="text-xs text-text-secondary">{String(row.employeeId ?? '')}</div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{String(row.siteName ?? row.fromLocation ?? '—')}</td>
                  <td className="px-4 py-3 text-text-secondary whitespace-nowrap">{fmtDate(row.submittedAt)}</td>
                  <td className="px-4 py-3 text-text-secondary max-w-xs">
                    {Array.isArray(row.items) ? (
                      <span>{(row.items as unknown[]).length} item{(row.items as unknown[]).length !== 1 ? 's' : ''}</span>
                    ) : row.workDescription ? (
                      <span className="truncate block max-w-xs">{String(row.workDescription)}</span>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setViewing(row)} className="text-primary text-xs font-medium hover:underline whitespace-nowrap">
                        View
                      </button>
                      <button onClick={() => setEditing(row)} className="text-text-secondary text-xs font-medium hover:text-primary hover:underline whitespace-nowrap">
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewing && <DetailModal row={viewing} label={activeLabel} onClose={() => setViewing(null)} />}
      {editing && (
        <EditModal
          row={editing}
          collectionKey={active}
          label={activeLabel}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
