'use client';

import {
  collection, collectionGroup, doc, getDocs,
  addDoc, setDoc, updateDoc, deleteDoc,
  Timestamp, where, query,
  // getDoc,  // used only by getDailyAssignments — re-enable when daily assignment system is re-enabled
} from 'firebase/firestore';
import { db } from './firebase';
// DailyAssignment, SiteAssignmentItem removed from import — daily assignment system not in use
import type { User, Site, LeaveRequest, AttendanceRecord } from '@/types';

// ── Users ─────────────────────────────────────────────────────────────────

export async function getAllUsers(): Promise<User[]> {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as User));
}

export async function createUserProfile(uid: string, data: Omit<User, 'id'>) {
  await setDoc(doc(db, 'users', uid), { ...data, createdAt: Timestamp.now() });
}

export async function updateUserProfile(uid: string, data: Partial<Omit<User, 'id'>>) {
  await updateDoc(doc(db, 'users', uid), data as Record<string, unknown>);
}

export async function deleteUserProfile(uid: string) {
  await deleteDoc(doc(db, 'users', uid));
}

// ── Sites ─────────────────────────────────────────────────────────────────

export async function getAllSites(): Promise<Site[]> {
  const snap = await getDocs(collection(db, 'sites'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Site));
}

export async function createSite(data: Omit<Site, 'id'>): Promise<string> {
  const ref = await addDoc(collection(db, 'sites'), data);
  return ref.id;
}

export async function updateSite(siteId: string, data: Partial<Omit<Site, 'id'>>) {
  await updateDoc(doc(db, 'sites', siteId), data as Record<string, unknown>);
}

export async function deleteSite(siteId: string) {
  await deleteDoc(doc(db, 'sites', siteId));
}

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

// ── Dashboard Stats ───────────────────────────────────────────────────────

export async function getDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
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
