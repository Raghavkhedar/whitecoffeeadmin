import { Timestamp } from 'firebase/firestore';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'operations' | 'office' | 'admin';
  employeeId: string;
  salaryRate?: number;
  plBalance?: number;
  homeLat?: number;
  homeLng?: number;
  conveyanceRateType?: 1 | 2;
  createdAt?: Timestamp;
}

export interface AttendanceStatus {
  id: string;
  date: string;
  userId: string;
  userName: string;
  employeeId: string;
  role: string;
  status: 'Present' | 'HalfDay' | 'Absent' | 'PL' | 'UPL';
  markedBy: 'auto' | 'admin';
  updatedAt?: Timestamp;
}

// SITE MANAGEMENT — NOT IN USE (no geofencing, no daily assignments).
// Re-enable by uncommenting this interface and the site functions in firestore.ts,
// sites/page.tsx, and the Sidebar.tsx nav entry.
//
// export interface Site {
//   id: string;
//   name: string;
//   latitude: number;
//   longitude: number;
//   geofenceRadius: number;
// }

// DAILY ASSIGNMENT SYSTEM — NOT IN USE.
// Re-enable by uncommenting these interfaces and the matching code in firestore.ts,
// Sidebar.tsx, and daily-assignments/page.tsx.
//
// export interface SiteAssignmentItem {
//   siteId: string;
//   siteName: string;
//   workDescription: string;
//   toolsRequired: string;
// }
//
// export interface DailyAssignment {
//   id: string;          // "{date}_{userId}"
//   date: string;        // "yyyy-MM-dd"
//   userId: string;
//   userName: string;
//   sites: SiteAssignmentItem[];
//   assignedAt?: Timestamp;
// }

export interface LeaveRequest {
  id: string;
  userId: string;
  userName: string;
  employeeId: string;
  leaveType: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy: string;
  approverComment: string;
  submittedAt?: Timestamp;
  reviewedAt?: Timestamp;
}

export interface RegularizationRequest {
  id: string;
  userId: string;
  userName: string;
  employeeId: string;
  date: string;
  originalStatus: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  approvedBy: string;
  approverComment: string;
  submittedAt?: Timestamp;
  reviewedAt?: Timestamp;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  employeeId: string;
  date: string;
  type: string;
  timestamp?: Timestamp;
  latitude: number;
  longitude: number;
  siteId: string;
  siteName: string;
  marketName: string;
}

export interface SentNotification {
  id: string;
  title: string;
  body: string;
  type: string;
  recipientType: 'all' | 'operations' | 'office' | 'specific';
  recipientCount: number;
  sentByName: string;
  sentAt?: Timestamp;
}

export interface ConveyanceRecord {
  id: string;
  userId: string;
  userName: string;
  employeeId: string;
  date: string;
  month: string;
  route: string;
  totalKm: number;
  ratePerKm: number;
  conveyance: number;
  computedAt?: Timestamp;
}
