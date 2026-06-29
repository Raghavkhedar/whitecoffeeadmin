'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { getAllLeaveRequests } from '@/lib/firestore';
import Icon, { type IconName } from './Icon';

interface NavItem { href: string; icon: IconName; label: string; badgeKey?: 'pending' }

const NAV_GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [
    { href: '/dashboard', icon: 'grid', label: 'Dashboard' },
  ] },
  { label: 'People', items: [
    { href: '/users',              icon: 'users',      label: 'Employees' },
    { href: '/employee-dashboard', icon: 'userCircle', label: 'Emp Dashboard' },
    { href: '/leaves',             icon: 'leave',      label: 'Leave Requests', badgeKey: 'pending' },
    { href: '/regularization',     icon: 'clock',      label: 'Regularization' },
  ] },
  { label: 'Time & Sites', items: [
    { href: '/attendance',  icon: 'calendar', label: 'Attendance' },
    { href: '/ot-shortage', icon: 'clock',    label: 'OT & Shortage' },
    { href: '/site-ids',    icon: 'pin',      label: 'Site IDs' },
  ] },
  { label: 'Records', items: [
    { href: '/submissions',   icon: 'doc',  label: 'Submissions' },
    { href: '/conveyance',    icon: 'car',  label: 'Conveyance' },
    { href: '/notifications', icon: 'bell', label: 'Notifications' },
  ] },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router   = useRouter();
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    getAllLeaveRequests('pending')
      .then(l => setPending(l.length))
      .catch(() => setPending(null));
  }, []);

  async function handleLogout() {
    await signOut(auth);
    router.replace('/login');
  }

  return (
    <aside className="w-[248px] flex-shrink-0 bg-sidebar flex flex-col h-screen">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 h-16 border-b border-white/[0.07]">
        <div className="w-9 h-9 rounded-[10px] bg-primary text-white flex items-center justify-center font-semibold text-[13px] font-mono">WC</div>
        <div className="leading-tight">
          <div className="text-[14.5px] font-semibold text-white tracking-tight">WhiteCoffee</div>
          <div className="text-[11px] text-[#8A93A0] mt-0.5">Admin Portal</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-5' : ''}>
            {group.label && (
              <div className="px-3 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[#6B7480]">{group.label}</div>
            )}
            {group.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/');
              const badge  = item.badgeKey === 'pending' && pending ? pending : null;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-[8.5px] rounded-[9px] text-[13.5px] mb-0.5 transition-colors ${
                    active
                      ? 'bg-white/[0.08] text-white font-semibold'
                      : 'text-[#9AA3AE] font-medium hover:bg-white/[0.05] hover:text-[#F0F2F5]'
                  }`}
                >
                  <span className="flex" style={{ color: active ? '#4D90D9' : undefined }}>
                    <Icon name={item.icon} size={17.5} />
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {badge != null && (
                    <span className="font-mono text-[11px] font-semibold bg-primary text-white rounded-[7px] px-[7px] leading-[1.55]">{badge}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Logout */}
      <div className="px-3 py-3 border-t border-white/[0.07]">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-[8.5px] rounded-[9px] text-[13.5px] font-medium text-[#9AA3AE] hover:bg-white/[0.05] hover:text-[#F0F2F5] transition-colors"
        >
          <span className="flex"><Icon name="logout" size={16} /></span>
          Sign out
        </button>
      </div>
    </aside>
  );
}
