// Shared presentational helpers for the redesigned admin pages.
import type { CSSProperties } from 'react';

export function initials(name: string) {
  return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <div
      className="rounded-full bg-[#EFE9E2] text-[#7A6E63] flex items-center justify-center font-semibold font-mono flex-shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </div>
  );
}

const ROLE_MAP: Record<string, { label: string; bg: string; color: string }> = {
  admin:      { label: 'Admin',  bg: '#FBECEC', color: '#B4322F' },
  office:     { label: 'Office', bg: '#ECF1FC', color: '#2456C7' },
  operations: { label: 'Ops',    bg: '#F7EFE3', color: '#9A5B1E' },
};

export function RoleBadge({ role }: { role: string }) {
  const m = ROLE_MAP[role] || ROLE_MAP.office;
  return (
    <span
      className="inline-flex items-center px-[9px] py-0.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap"
      style={{ background: m.bg, color: m.color }}
    >
      {m.label}
    </span>
  );
}

const STATUS_MAP: Record<string, { label: string; bg: string; color: string }> = {
  Present:   { label: 'Present',       bg: '#EAF7F0', color: '#0A7A50' },
  HalfDay:   { label: 'Half Day',      bg: '#FDF3E4', color: '#B26B07' },
  SL:        { label: 'Short Leave',   bg: '#FBF1E2', color: '#A2670F' },
  SLNF:      { label: 'Log Not Found', bg: '#F2EEFB', color: '#6D40C9' },
  PL:        { label: 'Paid Leave',    bg: '#EDF2FD', color: '#2456C7' },
  LWP:       { label: 'LWP',           bg: '#F2EFEC', color: '#6B5E54' },
  Absent:    { label: 'Absent',        bg: '#FBEAEA', color: '#C42B2B' },
  WO:        { label: 'WO',            bg: '#E7F0FA', color: '#1A5FAF' },
};

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_MAP[status] || { label: status, bg: '#F2F0ED', color: '#8A817A' };
  return (
    <span
      className="inline-flex items-center px-2.5 py-[3px] rounded-[7px] text-[12px] font-semibold whitespace-nowrap"
      style={{ background: m.bg, color: m.color }}
    >
      {m.label}
    </span>
  );
}

// Shared table cell style tokens
export const TH = 'text-left text-[11px] font-semibold tracking-[0.05em] uppercase text-[#A8A29E] px-[14px] py-3 bg-[#FCFBFA] border-b border-[#F0EEEB] whitespace-nowrap';
export const TD = 'px-[14px] py-[13px] text-[13.5px] align-middle';
export const rowHover: CSSProperties = {};
