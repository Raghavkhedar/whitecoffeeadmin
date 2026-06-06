'use client';

/*
 * DAILY ASSIGNMENT SYSTEM — NOT CURRENTLY IN USE
 *
 * This page lets admins assign sites + work instructions to operations staff per day.
 * It reads /daily_assignments/{date}_{userId} docs in Firestore and writes SiteAssignmentItem arrays.
 * The matching Android feature (SiteTask, getTodayAssignedSites) is also commented out.
 *
 * To re-enable:
 *   1. Uncomment the imports below
 *   2. Uncomment DailyAssignmentsPage implementation below
 *   3. Remove the placeholder return above it
 *   4. Uncomment SiteAssignmentItem + DailyAssignment in src/types/index.ts
 *   5. Uncomment getDailyAssignments / setDailyAssignment / clearDailyAssignment in src/lib/firestore.ts
 *   6. Uncomment the Daily Assignments nav entry in src/components/Sidebar.tsx
 *   7. Uncomment SiteTask + getTodayAssignedSites in the Android app (SiteTask.kt, SiteRepository.kt)
 */

// import { useEffect, useState } from 'react';
// import { getAllUsers, getAllSites, getDailyAssignments, setDailyAssignment, clearDailyAssignment } from '@/lib/firestore';
// import type { User, Site, DailyAssignment, SiteAssignmentItem } from '@/types';

export default function DailyAssignmentsPage() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Daily Site Assignments</h1>
        <p className="text-text-secondary text-sm mt-1">This feature is currently not in use.</p>
      </div>
      <div className="card text-center py-16 text-text-secondary">
        <p className="text-4xl mb-4">📅</p>
        <p className="font-medium text-text-primary mb-2">Feature Disabled</p>
        <p className="text-sm">Daily site assignments are commented out in both the admin portal and the Android app.</p>
        <p className="text-sm mt-1">See the commented code in this file to re-enable.</p>
      </div>
    </div>
  );
}

/*
 * ─── ORIGINAL IMPLEMENTATION (commented out) ──────────────────────────────
 *
 * function today() {
 *   return new Date().toISOString().split('T')[0];
 * }
 *
 * export default function DailyAssignmentsPage() {
 *   const [date, setDate]               = useState(today());
 *   const [users, setUsers]             = useState<User[]>([]);
 *   const [sites, setSites]             = useState<Site[]>([]);
 *   const [assignments, setAssignments] = useState<DailyAssignment[]>([]);
 *   const [loading, setLoading]         = useState(true);
 *   const [error, setError]             = useState('');
 *
 *   // Modal state
 *   const [modalUser, setModalUser] = useState<User | null>(null);
 *   const [selected, setSelected]   = useState<SiteAssignmentItem[]>([]);
 *   const [saving, setSaving]       = useState(false);
 *
 *   async function load(d: string) {
 *     setLoading(true);
 *     setError('');
 *     try {
 *       const [u, s] = await Promise.all([getAllUsers(), getAllSites()]);
 *       const ops = u.filter(u => u.role === 'operations').sort((a, b) => a.name.localeCompare(b.name));
 *       const a = await getDailyAssignments(d, u);
 *       setUsers(ops);
 *       setSites(s.sort((a, b) => a.name.localeCompare(b.name)));
 *       setAssignments(a);
 *     } catch (e: unknown) {
 *       setError(e instanceof Error ? e.message : 'Failed to load.');
 *     }
 *     setLoading(false);
 *   }
 *
 *   useEffect(() => { load(date); }, [date]);
 *
 *   function getAssignment(userId: string): SiteAssignmentItem[] {
 *     return assignments.find(a => a.userId === userId)?.sites ?? [];
 *   }
 *
 *   function openAssign(user: User) {
 *     const existing = assignments.find(a => a.userId === user.id);
 *     setSelected(existing?.sites ?? []);
 *     setModalUser(user);
 *   }
 *
 *   function isSelected(siteId: string) {
 *     return selected.some(s => s.siteId === siteId);
 *   }
 *
 *   function toggleSite(site: Site) {
 *     setSelected(prev => {
 *       if (prev.some(s => s.siteId === site.id)) {
 *         return prev.filter(s => s.siteId !== site.id);
 *       }
 *       return [...prev, { siteId: site.id, siteName: site.name, workDescription: '', toolsRequired: '' }];
 *     });
 *   }
 *
 *   function updateField(siteId: string, field: 'workDescription' | 'toolsRequired', value: string) {
 *     setSelected(prev =>
 *       prev.map(s => s.siteId === siteId ? { ...s, [field]: value } : s)
 *     );
 *   }
 *
 *   async function handleSave() {
 *     if (!modalUser) return;
 *     setSaving(true);
 *     try {
 *       if (selected.length === 0) {
 *         await clearDailyAssignment(date, modalUser.id);
 *       } else {
 *         await setDailyAssignment(date, modalUser.id, modalUser.name, selected);
 *       }
 *       setModalUser(null);
 *       await load(date);
 *     } catch (e: unknown) {
 *       alert(e instanceof Error ? e.message : 'Save failed.');
 *     }
 *     setSaving(false);
 *   }
 *
 *   return (
 *     <div>
 *       <div className="mb-8">
 *         <h1 className="text-2xl font-bold text-text-primary">Daily Site Assignments</h1>
 *         <p className="text-text-secondary text-sm mt-1">Assign sites and work instructions to operations staff</p>
 *       </div>
 *
 *       <div className="flex items-center gap-4 mb-6">
 *         <label className="text-sm font-medium text-text-secondary">Date</label>
 *         <input type="date" className="input w-48" value={date} onChange={e => setDate(e.target.value)} />
 *         {date !== today() && (
 *           <button className="text-primary text-sm underline" onClick={() => setDate(today())}>Back to today</button>
 *         )}
 *       </div>
 *
 *       {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>}
 *
 *       <div className="card p-0 overflow-hidden">
 *         {loading ? (
 *           <div className="p-8 text-center text-text-secondary">Loading…</div>
 *         ) : users.length === 0 ? (
 *           <div className="p-8 text-center text-text-secondary">No operations employees found.</div>
 *         ) : (
 *           <table className="w-full text-sm">
 *             <thead className="bg-background border-b border-border">
 *               <tr>
 *                 {['Employee', 'Employee ID', 'Assigned Sites & Work', ''].map(h => (
 *                   <th key={h} className="px-4 py-3 text-left text-xs font-bold text-text-secondary uppercase tracking-wide">{h}</th>
 *                 ))}
 *               </tr>
 *             </thead>
 *             <tbody className="divide-y divide-border">
 *               {users.map(u => {
 *                 const assignedSites = getAssignment(u.id);
 *                 return (
 *                   <tr key={u.id} className="hover:bg-background transition-colors">
 *                     <td className="px-4 py-3 font-medium text-text-primary">{u.name}</td>
 *                     <td className="px-4 py-3 text-text-secondary">{u.employeeId || '—'}</td>
 *                     <td className="px-4 py-3">
 *                       {assignedSites.length === 0 ? (
 *                         <span className="text-text-secondary italic text-xs">No assignment</span>
 *                       ) : (
 *                         <div className="space-y-1">
 *                           {assignedSites.map(s => (
 *                             <div key={s.siteId}>
 *                               <span className="text-xs bg-accent-light text-primary px-2 py-0.5 rounded-full font-medium">{s.siteName}</span>
 *                               {s.workDescription && <p className="text-xs text-text-secondary mt-0.5 ml-1">Work: {s.workDescription}</p>}
 *                               {s.toolsRequired && <p className="text-xs text-text-secondary ml-1">Tools: {s.toolsRequired}</p>}
 *                             </div>
 *                           ))}
 *                         </div>
 *                       )}
 *                     </td>
 *                     <td className="px-4 py-3">
 *                       <button className="text-primary text-xs font-medium hover:underline" onClick={() => openAssign(u)}>Assign</button>
 *                     </td>
 *                   </tr>
 *                 );
 *               })}
 *             </tbody>
 *           </table>
 *         )}
 *       </div>
 *
 *       {modalUser && (
 *         <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={() => setModalUser(null)}>
 *           <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
 *             <h2 className="text-lg font-bold text-text-primary mb-1">Assign Sites</h2>
 *             <p className="text-sm text-text-secondary mb-5">{modalUser.name} · {date}</p>
 *             {sites.length === 0 ? (
 *               <p className="text-text-secondary text-sm">No sites available.</p>
 *             ) : (
 *               <div className="space-y-3 max-h-96 overflow-y-auto mb-5">
 *                 {sites.map(site => {
 *                   const checked = isSelected(site.id);
 *                   const item = selected.find(s => s.siteId === site.id);
 *                   return (
 *                     <div key={site.id} className="border border-border rounded-lg overflow-hidden">
 *                       <label className="flex items-center gap-3 cursor-pointer px-4 py-3 hover:bg-background transition-colors">
 *                         <input type="checkbox" checked={checked} onChange={() => toggleSite(site)} className="rounded" />
 *                         <span className="text-sm font-medium text-text-primary flex-1">{site.name}</span>
 *                         <span className="text-xs text-text-secondary">{site.geofenceRadius}m</span>
 *                       </label>
 *                       {checked && item && (
 *                         <div className="px-4 pb-3 pt-1 bg-background space-y-2 border-t border-border">
 *                           <div>
 *                             <label className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Work to be done</label>
 *                             <textarea rows={2} className="input mt-1 text-sm resize-none w-full"
 *                               placeholder="e.g. Install electrical panels on floor 2"
 *                               value={item.workDescription}
 *                               onChange={e => updateField(site.id, 'workDescription', e.target.value)} />
 *                           </div>
 *                           <div>
 *                             <label className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Tools required</label>
 *                             <textarea rows={2} className="input mt-1 text-sm resize-none w-full"
 *                               placeholder="e.g. Screwdrivers, wire cutters, multimeter"
 *                               value={item.toolsRequired}
 *                               onChange={e => updateField(site.id, 'toolsRequired', e.target.value)} />
 *                           </div>
 *                         </div>
 *                       )}
 *                     </div>
 *                   );
 *                 })}
 *               </div>
 *             )}
 *             <div className="flex gap-3">
 *               <button className="btn-primary flex-1" onClick={handleSave} disabled={saving}>
 *                 {saving ? 'Saving…' : selected.length === 0 ? 'Clear Assignment' : 'Save'}
 *               </button>
 *               <button className="btn-outline flex-1" onClick={() => setModalUser(null)}>Cancel</button>
 *             </div>
 *           </div>
 *         </div>
 *       )}
 *     </div>
 *   );
 * }
 */
