// App-wide constants.

// Production go-live date (YYYY-MM-DD, IST). Data before this was test/dev data that was
// wiped during pre-production cleanup, so the app must NOT evaluate or display any attendance
// status for earlier dates — they render blank (like a Sunday), never "Absent".
export const LAUNCH_DATE = '2026-07-01';
