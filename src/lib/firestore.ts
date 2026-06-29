'use client';

import {
  collection, collectionGroup, doc, getDocs, getDoc,
  setDoc, updateDoc, deleteDoc, writeBatch,
  Timestamp, where, query, orderBy, limit,
} from 'firebase/firestore';
import { db } from './firebase';
import { istTodayStr } from './date';
// Site removed from import — site management not in use
// DailyAssignment, SiteAssignmentItem removed from import — daily assignment system not in use
import type { User, LeaveRequest, AttendanceRecord, SentNotification, AttendanceStatus, RegularizationRequest, ConveyanceRecord, PlannedHours, OtApproval, Holiday } from '@/types';

// ── Users ─────────────────────────────────────────────────────────────────

export async function getAllUsers(): Promise<User[]> {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as User));
}

export async function createUserProfile(uid: string, data: Omit<User, 'id'>) {
  const { salaryRate, homeLat, homeLng, conveyanceRateType, ...rest } = data;
  await setDoc(doc(db, 'users', uid), {
    ...rest,
    salaryRate: salaryRate || 0,
    homeLat: homeLat || null,
    homeLng: homeLng || null,
    conveyanceRateType: conveyanceRateType || null,
    plBalance: 0,
    createdAt: Timestamp.now(),
  });
}

export async function updateUserProfile(uid: string, data: Partial<Omit<User, 'id'>>) {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    payload[k] = v === undefined ? null : v;
  }
  await updateDoc(doc(db, 'users', uid), payload);
}

export async function deleteUserProfile(uid: string) {
  await deleteDoc(doc(db, 'users', uid));
}

// ── Sites — NOT IN USE ────────────────────────────────────────────────────
//
// Re-enable by:
//   1. Uncommenting these four functions
//   2. Uncommenting addDoc in the firebase/firestore import above
//   3. Adding Site back to the @/types import
//   4. Uncommenting the Site interface in src/types/index.ts
//   5. Uncommenting sites/page.tsx and the Sidebar.tsx nav entry
//
// export async function getAllSites(): Promise<Site[]> {
//   const snap = await getDocs(collection(db, 'sites'));
//   return snap.docs.map(d => ({ id: d.id, ...d.data() } as Site));
// }
//
// export async function createSite(data: Omit<Site, 'id'>): Promise<string> {
//   const ref = await addDoc(collection(db, 'sites'), data);
//   return ref.id;
// }
//
// export async function updateSite(siteId: string, data: Partial<Omit<Site, 'id'>>) {
//   await updateDoc(doc(db, 'sites', siteId), data as Record<string, unknown>);
// }
//
// export async function deleteSite(siteId: string) {
//   await deleteDoc(doc(db, 'sites', siteId));
// }

// ── Daily Assignments — NOT IN USE ────────────────────────────────────────
//
// Re-enable by:
//   1. Uncommenting these three functions
//   2. Uncommenting getDoc in the firebase/firestore import above
//   3. Adding DailyAssignment, SiteAssignmentItem back to the @/types import
//   4. Uncommenting SiteAssignmentItem + DailyAssignment in src/types/index.ts
//   5. Uncommenting daily-assignments/page.tsx and Sidebar.tsx nav entry
//   6. Uncommenting SiteTask + getTodayAssignedSites in the Android app
//
// export async function getDailyAssignments(date: string, users?: User[]): Promise<DailyAssignment[]> {
//   // Read documents directly by ID ({date}_{userId}) to avoid collection queries
//   // which can hang on new/empty collections in some Firestore configurations.
//   const allUsers = users ?? (await getDocs(collection(db, 'users'))).docs.map(d => ({ id: d.id, ...d.data() } as User));
//   const opUsers  = allUsers.filter(u => u.role === 'operations');
//   const results = await Promise.all(
//     opUsers.map(u => getDoc(doc(db, 'daily_assignments', `${date}_${u.id}`)))
//   );
//   return results
//     .filter(d => d.exists())
//     .map(d => {
//       const data = d.data()!;
//       const sites: SiteAssignmentItem[] = data.sites ??
//         (data.siteIds ?? []).map((id: string) => ({
//           siteId: id, siteName: id, workDescription: '', toolsRequired: '',
//         }));
//       return { id: d.id, ...data, sites } as DailyAssignment;
//     });
// }
//
// export async function setDailyAssignment(
//   date: string,
//   userId: string,
//   userName: string,
//   sites: SiteAssignmentItem[]
// ): Promise<void> {
//   const docId = `${date}_${userId}`;
//   await setDoc(doc(db, 'daily_assignments', docId), {
//     date, userId, userName, sites, assignedAt: Timestamp.now(),
//   });
// }
//
// export async function clearDailyAssignment(date: string, userId: string): Promise<void> {
//   await deleteDoc(doc(db, 'daily_assignments', `${date}_${userId}`));
// }

// ── Leave Requests ────────────────────────────────────────────────────────

export async function getAllLeaveRequests(status?: string): Promise<LeaveRequest[]> {
  const snap = await getDocs(collectionGroup(db, 'leave_requests'));
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRequest));
  const filtered = status ? all.filter(r => r.status === status) : all;
  return filtered.sort((a, b) => {
    const ta = (a.submittedAt as unknown as { seconds: number })?.seconds ?? 0;
    const tb = (b.submittedAt as unknown as { seconds: number })?.seconds ?? 0;
    return status === 'pending' ? ta - tb : tb - ta;
  });
}

export async function approveLeave(userId: string, requestId: string, approverName: string) {
  await updateDoc(
    doc(db, 'users', userId, 'leave_requests', requestId),
    { status: 'approved', approvedBy: approverName, reviewedAt: Timestamp.now() }
  );
}

export async function rejectLeave(
  userId: string, requestId: string, approverName: string, comment: string
) {
  await updateDoc(
    doc(db, 'users', userId, 'leave_requests', requestId),
    { status: 'rejected', approvedBy: approverName, approverComment: comment, reviewedAt: Timestamp.now() }
  );
}

// ── Regularization Requests ───────────────────────────────────────────────

export async function getAllRegularizationRequests(status?: string): Promise<RegularizationRequest[]> {
  const snap = await getDocs(collectionGroup(db, 'regularization_requests'));
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() } as RegularizationRequest));
  const filtered = status ? all.filter(r => r.status === status) : all;
  return filtered.sort((a, b) => {
    const ta = (a.submittedAt as unknown as { seconds: number })?.seconds ?? 0;
    const tb = (b.submittedAt as unknown as { seconds: number })?.seconds ?? 0;
    return status === 'pending' ? ta - tb : tb - ta;
  });
}

export async function approveRegularization(
  userId: string, requestId: string, date: string, approverName: string,
  comment: string, approvedStatus: string, userName = '', employeeId = ''
) {
  const batch = writeBatch(db);
  batch.update(
    doc(db, 'users', userId, 'regularization_requests', requestId),
    { status: 'approved', approvedBy: approverName, approverComment: comment, approvedStatus, reviewedAt: Timestamp.now() }
  );
  batch.set(
    doc(db, 'users', userId, 'attendance_status', date),
    { date, userId, userName, employeeId, status: approvedStatus, markedBy: 'admin', updatedAt: Timestamp.now() },
    { merge: true }
  );
  await batch.commit();
}

export async function rejectRegularization(
  userId: string, requestId: string, approverName: string, comment: string
) {
  await updateDoc(
    doc(db, 'users', userId, 'regularization_requests', requestId),
    { status: 'rejected', approvedBy: approverName, approverComment: comment, reviewedAt: Timestamp.now() }
  );
}

// ── Attendance ────────────────────────────────────────────────────────────

export async function getAttendanceForDate(date: string): Promise<AttendanceRecord[]> {
  const snap = await getDocs(collectionGroup(db, 'attendance'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as AttendanceRecord))
    .filter(r => r.date === date)
    .sort((a, b) => {
      const ta = (a.timestamp as unknown as { seconds: number })?.seconds ?? 0;
      const tb = (b.timestamp as unknown as { seconds: number })?.seconds ?? 0;
      return ta - tb;
    });
}

// ── Notifications ─────────────────────────────────────────────────────────

/**
 * Writes a notification document to each target user's sub-collection and logs
 * the send event in /sent_notifications for history.
 * Firestore batch limit is 500 ops — safe for teams up to ~200 users.
 */
export async function sendNotification(
  userIds: string[],
  title: string,
  body: string,
  type: string,
  senderName: string,
  recipientType: SentNotification['recipientType']
): Promise<void> {
  const batch  = writeBatch(db);
  const sentAt = Timestamp.now();

  for (const userId of userIds) {
    const notifRef = doc(collection(db, 'users', userId, 'notifications'));
    batch.set(notifRef, { title, body, type, isRead: false, createdAt: sentAt });
  }

  const logRef = doc(collection(db, 'sent_notifications'));
  const logData: Record<string, unknown> = {
    title,
    body,
    type,
    recipientType,
    recipientCount: userIds.length,
    sentByName: senderName,
    sentAt,
  };
  if (recipientType === 'specific' && userIds.length === 1) {
    logData.recipientId = userIds[0];
  }
  batch.set(logRef, logData);

  await batch.commit();
}

export async function getSentNotifications(count = 20): Promise<SentNotification[]> {
  const q    = query(collection(db, 'sent_notifications'), orderBy('sentAt', 'desc'), limit(count));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as SentNotification));
}

// ── Attendance Status ─────────────────────────────────────────────────────

// month is 1-indexed (1 = January)
export async function getAttendanceStatusForMonth(year: number, month: number): Promise<AttendanceStatus[]> {
  const monthStr  = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${monthStr}-01`;
  const endDate   = `${monthStr}-31`; // safe upper bound for any month
  const q = query(
    collectionGroup(db, 'attendance_status'),
    where('date', '>=', startDate),
    where('date', '<=', endDate)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as AttendanceStatus));
}

export async function setAttendanceStatus(
  userId: string,
  date: string,
  data: Omit<AttendanceStatus, 'id' | 'updatedAt'>
): Promise<void> {
  await setDoc(
    doc(db, 'users', userId, 'attendance_status', date),
    { ...data, updatedAt: Timestamp.now() },
    { merge: true }
  );
}

// Remove an admin-set status doc (e.g. clearing a WO) so the nightly function can recompute.
export async function deleteAttendanceStatus(userId: string, date: string): Promise<void> {
  await deleteDoc(doc(db, 'users', userId, 'attendance_status', date));
}

export async function getAttendanceStatusForDateRange(start: string, end: string): Promise<AttendanceStatus[]> {
  const q = query(
    collectionGroup(db, 'attendance_status'),
    where('date', '>=', start),
    where('date', '<=', end)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as AttendanceStatus));
}

// ── Planned Hours (operations shift windows) ──────────────────────────────

// month is 1-indexed (1 = January)
export async function getPlannedHoursForMonth(year: number, month: number): Promise<PlannedHours[]> {
  const monthStr  = `${year}-${String(month).padStart(2, '0')}`;
  const startDate = `${monthStr}-01`;
  const endDate   = `${monthStr}-31`; // safe upper bound for any month
  const q = query(
    collectionGroup(db, 'planned_hours'),
    where('date', '>=', startDate),
    where('date', '<=', endDate)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PlannedHours));
}

export async function getPlannedHoursForDateRange(start: string, end: string): Promise<PlannedHours[]> {
  const q = query(
    collectionGroup(db, 'planned_hours'),
    where('date', '>=', start),
    where('date', '<=', end)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as PlannedHours));
}

export async function getAttendanceForDateRange(start: string, end: string): Promise<AttendanceRecord[]> {
  const snap = await getDocs(collectionGroup(db, 'attendance'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as AttendanceRecord))
    .filter(r => r.date >= start && r.date <= end)
    .sort((a, b) => {
      const ta = (a.timestamp as unknown as { seconds: number })?.seconds ?? 0;
      const tb = (b.timestamp as unknown as { seconds: number })?.seconds ?? 0;
      return ta - tb;
    });
}

export async function setPlannedHours(
  userId: string,
  date: string,
  startTime: string,
  endTime: string,
  declaredOtMins = 0,
): Promise<void> {
  await setDoc(
    doc(db, 'users', userId, 'planned_hours', date),
    { userId, date, startTime, endTime, declaredOtMins, updatedAt: Timestamp.now() },
    { merge: true }
  );
}

// ── Overtime Approvals ────────────────────────────────────────────────────

export async function getOtApprovalsForDateRange(start: string, end: string): Promise<OtApproval[]> {
  // Fetch + client-filter (no collection-group index required; this set stays small).
  const snap = await getDocs(collectionGroup(db, 'ot_approvals'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() } as OtApproval))
    .filter(a => a.date >= start && a.date <= end);
}

// Approve a day's overtime with an admin-adjusted amount + reason. Writes a per-day
// record at users/{uid}/ot_approvals/{date} and recomputes the user's lifetime
// approvedOtMins by summing all approvals (idempotent and safe to re-approve).
export async function approveOt(
  user: Pick<User, 'id' | 'name' | 'employeeId' | 'role'>,
  date: string,
  requestedMins: number,
  approvedMins: number,
  reason: string,
  approverName: string,
): Promise<void> {
  await writeOtDecision(user, date, requestedMins, approvedMins, 'approved', reason, approverName);
}

// Reject a day's overtime: records a 0-minute decision so the day stops showing as pending
// and is logged in history. Reason required (enforced by the caller).
export async function rejectOt(
  user: Pick<User, 'id' | 'name' | 'employeeId' | 'role'>,
  date: string,
  requestedMins: number,
  reason: string,
  approverName: string,
): Promise<void> {
  await writeOtDecision(user, date, requestedMins, 0, 'rejected', reason, approverName);
}

// Shared writer for an OT decision (approve/reject). Recomputes the user's lifetime
// approvedOtMins by summing granted minutes across all decisions (rejected contribute 0).
async function writeOtDecision(
  user: Pick<User, 'id' | 'name' | 'employeeId' | 'role'>,
  date: string,
  requestedMins: number,
  approvedMins: number,
  status: 'approved' | 'rejected',
  reason: string,
  approverName: string,
): Promise<void> {
  await setDoc(
    doc(db, 'users', user.id, 'ot_approvals', date),
    {
      date, userId: user.id, userName: user.name || '', employeeId: user.employeeId || '',
      role: user.role || '', requestedMins, approvedMins, status, reason,
      approvedBy: approverName, approvedAt: Timestamp.now(),
    },
    { merge: true },
  );
  const snap = await getDocs(collection(db, 'users', user.id, 'ot_approvals'));
  const total = snap.docs.reduce((sum, d) => sum + (Number(d.data().approvedMins) || 0), 0);
  await updateDoc(doc(db, 'users', user.id), { approvedOtMins: total });
}

// ── Holidays (company-wide) ───────────────────────────────────────────────
// Stored at holidays/{date}; a marked day is skipped like a Sunday everywhere
// attendance is evaluated (no status, no penalty, excluded from working days).

// month is 1-indexed (1 = January)
export async function getHolidaysForMonth(year: number, month: number): Promise<Holiday[]> {
  const monthStr  = `${year}-${String(month).padStart(2, '0')}`;
  const q = query(
    collection(db, 'holidays'),
    where('date', '>=', `${monthStr}-01`),
    where('date', '<=', `${monthStr}-31`), // safe upper bound for any month
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Holiday));
}

export async function getHolidaysForDateRange(start: string, end: string): Promise<Holiday[]> {
  const q = query(
    collection(db, 'holidays'),
    where('date', '>=', start),
    where('date', '<=', end),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Holiday));
}

export async function setHoliday(date: string, title: string, description: string, createdBy: string): Promise<void> {
  await setDoc(
    doc(db, 'holidays', date),
    { date, title: title.trim(), description: description.trim(), createdBy, createdAt: Timestamp.now() },
    { merge: true },
  );
}

export async function deleteHoliday(date: string): Promise<void> {
  await deleteDoc(doc(db, 'holidays', date));
}

// ── Conveyance Config ────────────────────────────────────────────────────

export async function getConveyanceConfig(): Promise<{ rate1: number; rate2: number }> {
  const snap = await getDoc(doc(db, 'config', 'conveyance'));
  if (snap.exists()) {
    const data = snap.data();
    return { rate1: data.rate1 || 0, rate2: data.rate2 || 0 };
  }
  return { rate1: 0, rate2: 0 };
}

export async function setConveyanceConfig(rate1: number, rate2: number): Promise<void> {
  await setDoc(doc(db, 'config', 'conveyance'), { rate1, rate2 });
}

// ── Site ID entry ────────────────────────────────────────────────────────
// Ops type the site name at check-in but leave Site ID blank. Admin fills the
// Site ID directly onto each individual attendance entry from the portal.
export async function updateAttendanceSiteId(userId: string, eventId: string, siteId: string): Promise<void> {
  await updateDoc(doc(db, 'users', userId, 'attendance', eventId), { siteId: siteId.trim() });
}

// ── Conveyance Records ──────────────────────────────────────────────────

export async function getConveyanceForMonth(month: string): Promise<ConveyanceRecord[]> {
  const snap = await getDocs(query(collection(db, 'conveyance'), where('month', '==', month)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as ConveyanceRecord));
}

// ── Dashboard Stats ───────────────────────────────────────────────────────

export async function getDashboardStats() {
  const today = istTodayStr();
  const [usersSnap, sitesSnap, leavesSnap, attendanceSnap] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(collection(db, 'sites')),
    getDocs(collectionGroup(db, 'leave_requests')),
    getDocs(collectionGroup(db, 'attendance')),
  ]);
  return {
    totalUsers:    usersSnap.size,
    totalSites:    sitesSnap.size,
    pendingLeaves: leavesSnap.docs.filter(d => d.data().status === 'pending').length,
    todayCheckIns: attendanceSnap.docs.filter(d => d.data().date === today && d.data().type?.endsWith('_in')).length,
  };
}
