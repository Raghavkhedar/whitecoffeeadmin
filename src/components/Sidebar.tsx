'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';

const NAV = [
  { href: '/dashboard', icon: '📊', label: 'Dashboard' },
  { href: '/users',     icon: '👥', label: 'Users' },
  // SITES — NOT IN USE (no daily assignment system, no geofencing). Re-enable with sites/page.tsx + firestore site functions + Site type.
  // { href: '/sites',             icon: '🏗️', label: 'Sites' },
  // DAILY ASSIGNMENT SYSTEM — NOT IN USE. Re-enable by uncommenting this line and the page/types/firestore functions.
  // { href: '/daily-assignments', icon: '📅', label: 'Daily Assignments' },
  { href: '/leaves',          icon: '🏖️', label: 'Leave Requests' },
  { href: '/regularization', icon: '🕐', label: 'Regularization' },
  { href: '/attendance',    icon: '📋', label: 'Attendance' },
  { href: '/conveyance',    icon: '🚗', label: 'Conveyance' },
  { href: '/submissions',   icon: '📝', label: 'Submissions' },
  { href: '/notifications', icon: '🔔', label: 'Notifications' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router   = useRouter();

  async function handleLogout() {
    await signOut(auth);
    router.replace('/login');
  }

  return (
    <aside className="fixed inset-y-0 left-0 w-60 bg-primary flex flex-col z-40">
      {/* Logo */}
      <div className="px-6 py-6 border-b border-white/10">
        <div className="text-white font-bold text-lg">☕ WhiteCoffee</div>
        <div className="text-blue-200 text-xs mt-0.5">Admin Portal</div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV.map(item => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-white/20 text-white'
                  : 'text-blue-100 hover:bg-white/10 hover:text-white'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-white/10">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium text-blue-100 hover:bg-white/10 hover:text-white transition-colors"
        >
          <span>🚪</span> Sign Out
        </button>
      </div>
    </aside>
  );
}
