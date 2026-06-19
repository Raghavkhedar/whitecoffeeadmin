'use client';

import { useState, useEffect } from 'react';
import { auth } from '@/lib/firebase';
import { getAllUsers, sendNotification, getSentNotifications } from '@/lib/firestore';
import type { User, SentNotification } from '@/types';

type RecipientType = 'all' | 'operations' | 'office' | 'specific';

const NOTIF_TYPES = [
  { value: 'general',        label: 'General Announcement' },
  { value: 'leave_update',   label: 'Leave Update' },
  { value: 'work_reminder',  label: 'Work Reminder' },
  { value: 'urgent',         label: 'Urgent' },
];

export default function NotificationsPage() {
  const [users, setUsers]             = useState<User[]>([]);
  const [history, setHistory]         = useState<SentNotification[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Form state
  const [title, setTitle]               = useState('');
  const [body, setBody]                 = useState('');
  const [type, setType]                 = useState('general');
  const [recipientType, setRecipientType] = useState<RecipientType>('all');
  const [specificUserId, setSpecificUserId] = useState('');

  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending]   = useState(false);
  const [success, setSuccess]   = useState('');
  const [error, setError]       = useState('');

  useEffect(() => {
    // Users are needed for the form — load separately so a history failure
    // doesn't block the Send button.
    async function loadUsers() {
      try {
        const u = await getAllUsers();
        setUsers(u.sort((a, b) => a.name.localeCompare(b.name)));
      } catch (e) {
        console.error('Failed to load users', e);
      } finally {
        setLoadingData(false);
      }
    }

    async function loadHistory() {
      try {
        const h = await getSentNotifications();
        setHistory(h);
      } catch {
        // History not critical — rules may not be deployed yet
      } finally {
        setLoadingHistory(false);
      }
    }

    loadUsers();
    loadHistory();
  }, []);

  function resolveRecipientIds(): string[] {
    switch (recipientType) {
      case 'all':        return users.map(u => u.id);
      case 'operations': return users.filter(u => u.role === 'operations').map(u => u.id);
      case 'office':     return users.filter(u => u.role === 'office' || u.role === 'admin').map(u => u.id);
      case 'specific':   return specificUserId ? [specificUserId] : [];
    }
  }

  async function handleSend() {
    setError('');
    setSuccess('');

    if (!title.trim()) { setError('Title is required.'); return; }
    if (!body.trim())  { setError('Message body is required.'); return; }

    const ids = resolveRecipientIds();
    if (ids.length === 0) { setError('No recipients found for the selected group.'); return; }

    setSending(true);
    try {
      const senderName = auth.currentUser?.displayName ||
        users.find(u => u.id === auth.currentUser?.uid)?.name ||
        'Admin';

      await sendNotification(ids, title.trim(), body.trim(), type, senderName, recipientType);

      setSuccess(`Notification sent to ${ids.length} employee${ids.length !== 1 ? 's' : ''}.`);
      setTitle('');
      setBody('');
      setType('general');
      setRecipientType('all');
      setSpecificUserId('');

      // Refresh history
      const h = await getSentNotifications();
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send notification.');
      console.error(e);
    } finally {
      setSending(false);
    }
  }

  function formatTime(notif: SentNotification): string {
    const ts = notif.sentAt as unknown as { seconds: number } | undefined;
    if (!ts?.seconds) return '—';
    return new Date(ts.seconds * 1000).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  const recipientLabel = {
    all:        'All employees',
    operations: 'Operations team',
    office:     'Office & Admin',
    specific:   'Specific employee',
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Send Notification</h1>
        <p className="text-sm text-gray-500 mt-1">
          Notifications appear in the employee's app under the bell icon.
        </p>
      </div>

      {/* Send form */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Site visit tomorrow — Gurugram"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={100}
          />
        </div>

        {/* Body */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Message</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Write the full notification message here..."
            rows={4}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            maxLength={500}
          />
          <p className="text-xs text-gray-400 text-right mt-0.5">{body.length}/500</p>
        </div>

        {/* Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {NOTIF_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {/* Recipients */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Recipients</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['all', 'operations', 'office', 'specific'] as RecipientType[]).map(r => (
              <button
                key={r}
                onClick={() => setRecipientType(r)}
                className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${
                  recipientType === r
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                }`}
              >
                {recipientLabel[r]}
              </button>
            ))}
          </div>

          {recipientType === 'specific' && (
            <select
              value={specificUserId}
              onChange={e => setSpecificUserId(e.target.value)}
              className="mt-3 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— Select employee —</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.employeeId}) — {u.role}
                </option>
              ))}
            </select>
          )}

          {!loadingData && recipientType !== 'specific' && (
            <p className="text-xs text-gray-400 mt-2">
              {resolveRecipientIds().length} recipient{resolveRecipientIds().length !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        {/* Feedback */}
        {error   && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        {success && <p className="text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg">{success}</p>}

        {/* Submit */}
        <button
          onClick={handleSend}
          disabled={sending || loadingData}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
        >
          {sending ? 'Sending…' : '🔔  Send Notification'}
        </button>
      </div>

      {/* History */}
      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Recent Notifications</h2>
        {loadingHistory ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-gray-400">No notifications sent yet.</p>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">Title</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Recipients</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Sent by</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {history.map(n => (
                  <tr key={n.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 truncate max-w-xs">{n.title}</p>
                      <p className="text-gray-500 text-xs truncate max-w-xs">{n.body}</p>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="inline-block bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded-full">
                        {recipientLabel[n.recipientType]} ({n.recipientCount})
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{n.sentByName}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatTime(n)}</td>
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
