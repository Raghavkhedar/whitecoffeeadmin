// Deploy stamp: 2026-06-30 — step 6b payroll arrears + step 7 lifetime-counter retirement.
const { setGlobalOptions } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

// Operations field-work events: a worked day spans the first arrival and last
// departure across both site and market visits (home events are commute bookends
// and never count toward the working window).
const OPS_IN_TYPES  = new Set(["site_in", "market_in"]);
const OPS_OUT_TYPES = new Set(["site_out", "market_out"]);

const SHEETS_KEY   = defineSecret("ATTENDANCE_SHEETS_KEY");
const MAPS_KEY     = defineSecret("MAPS_API_KEY");
// Sheet1: Employee Dashboard, Leave Requests, Conveyance
const SHEET_ID_1 = "1Qwi1-H13OEAQmVWVf2VRahpG8NiUIDow-QQKQKWh57M";
// Sheet2: Attendance
const SHEET_ID_2 = "1Te3esJocJvBYp9r2yFyB9lp4onKJUSy4Hobe3LkBzYM";
// Sheet3: MT Requests
const SHEET_ID_3 = "10l2g55q_yPrirjD71u70D6K_9seED6NOjCadJ0kgeIU";
// Sheet4: MT Purchases
const SHEET_ID_4 = "1Gc1mRffcjEmZnk6aeOVf3eTcNCk1qfeTdsnkk5-OFdE";
// Sheet5: Material Transfers
const SHEET_ID_5 = "1Hy4GJ57Cn-uln7k3xXtJxI6Ka_VofDbJz1XYGqs2qGY";
// Sheet6: Tool Transfers
const SHEET_ID_6 = "1Ar1d7kNwgOB5w6MSGX40MAXorR9dpzr3oN72Wa-JQE4";
// Sheet7: Work Progress
const SHEET_ID_7 = "1c2JtarmbteClXaADF666WYEGNmx4CozM7EKo7bcteKE";

// Conveyance rates are now stored in Firestore (config/conveyance) and
// assigned per employee (user.conveyanceRateType = 1 or 2).
// Fallback if config is missing:
const CONVEYANCE_RATE_FALLBACK = 2.5;

const TABS = {
  EMPLOYEE_DASHBOARD: "Employee Dashboard",
  CONVEYANCE:         "Conveyance",
  ATTENDANCE:         "Attendance",
  REQUESTS:           "MT Requests",
  PURCHASES:          "MT Purchases",
  MATERIAL_TRANSFERS: "Material Transfers",
  TOOL_TRANSFERS:     "Tool Transfers",
  WORK_PROGRESS:      "Work Progress",
  LEAVE_REQUESTS:     "Leave Requests",
};

async function getRoadKm(lat1, lon1, lat2, lon2, apiKey) {
  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat1},${lon1}&destinations=${lat2},${lon2}&key=${apiKey}`;
    const res  = await fetch(url);
    const json = await res.json();
    const el   = json.rows?.[0]?.elements?.[0];
    return el?.status === "OK" ? el.distance.value / 1000 : 0;
  } catch {
    return 0;
  }
}

function ts(timestamp) {
  if (!timestamp) return "";
  return timestamp.toDate().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// Parse a "HH:MM" 24h string into minutes-from-midnight; fallback if invalid.
function toMinutes(hhmm, fallback) {
  if (!hhmm || typeof hhmm !== "string") return fallback;
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallback;
  return h * 60 + m;
}

function timeIST(timestamp) {
  if (!timestamp) return "";
  return timestamp.toDate().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function getHourIST(timestamp) {
  if (!timestamp) return -1;
  const istMs = timestamp.toDate().getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCHours();
}

function getMinuteIST(timestamp) {
  if (!timestamp) return 0;
  const istMs = timestamp.toDate().getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCMinutes();
}

// Resolve the owning user id for an exported doc, whether it's a top-level doc
// (carries a userId field) or a subcollection doc under users/{uid}/...
function uidOf(doc) {
  const d = doc.data();
  if (d.userId) return d.userId;
  const parent = doc.ref.parent.parent;
  return parent ? parent.id : "";
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function writeTab(sheets, spreadsheetId, tabName, rows) {
  await ensureTab(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

// ── Monthly PL Accrual — midnight IST on 1st of each month ──────────────────
exports.accrueMonthlyLeave = onSchedule(
  { schedule: "0 0 1 * *", timeZone: "Asia/Kolkata", timeoutSeconds: 120 },
  async () => {
    const db = admin.firestore();
    const usersSnap = await db.collection("users").get();
    const batch = db.batch();
    usersSnap.docs.forEach((doc) => {
      batch.update(doc.ref, { plBalance: admin.firestore.FieldValue.increment(1) });
    });
    await batch.commit();
    console.log(`accrueMonthlyLeave: +1 PL applied to ${usersSnap.size} users`);
  }
);

// ── Daily Attendance Status — 23:59 IST, ALL users ──────────────────────────
exports.computeDailyAttendanceStatus = onSchedule(
  { schedule: "59 23 * * *", timeZone: "Asia/Kolkata", timeoutSeconds: 300 },
  async () => {
    const db = admin.firestore();
    const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const today  = nowIST.toISOString().slice(0, 10);

    const usersSnap   = await db.collection("users").get();
    const allUsers    = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const attendSnap = await db.collectionGroup("attendance").where("date", "==", today).get();
    const eventsByUser = new Map();
    attendSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (!eventsByUser.has(d.userId)) eventsByUser.set(d.userId, []);
      eventsByUser.get(d.userId).push(d);
    });

    const leavesSnap = await db.collectionGroup("leave_requests").get();
    const leavesToday = new Map();
    leavesSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.status === "approved" && d.fromDate <= today && d.toDate >= today) leavesToday.set(d.userId, d);
    });

    // Skip users whose attendance_status was manually set by admin (regularization approvals)
    // Read per-user docs directly to avoid needing a collectionGroup index on date.
    const adminOverrides = new Set();
    const priorStatus    = new Map(); // userId → status already recorded for today
    const statusChecks = allUsers.map(async (user) => {
      const statusDoc = await db.doc(`users/${user.id}/attendance_status/${today}`).get();
      if (statusDoc.exists) {
        if (statusDoc.data().markedBy === "admin") adminOverrides.add(user.id);
        priorStatus.set(user.id, statusDoc.data().status);
      }
    });

    // Operations have variable shifts: admin sets a planned start/end per day.
    // Status is evaluated against that window. No plan → day left unmarked.
    const plannedHours = new Map(); // userId → { startTime, endTime }
    const planChecks = allUsers
      .filter((u) => u.role === "operations")
      .map(async (user) => {
        const planDoc = await db.doc(`users/${user.id}/planned_hours/${today}`).get();
        if (planDoc.exists) {
          const p = planDoc.data();
          if (p.startTime && p.endTime) plannedHours.set(user.id, p);
        }
      });

    await Promise.all([...statusChecks, ...planChecks]);

    // Skip Sundays — no status written, no penalty
    const todayDate = new Date(today + "T00:00:00+05:30");
    if (todayDate.getDay() === 0) {
      console.log(`computeDailyAttendanceStatus: skipping Sunday ${today}`);
      return;
    }

    // Skip company-wide holidays the same way — no status, no Absent penalty.
    const holidayDoc = await db.doc(`holidays/${today}`).get();
    if (holidayDoc.exists) {
      console.log(`computeDailyAttendanceStatus: skipping holiday ${today} (${holidayDoc.data().title || ""})`);
      return;
    }

    const batch           = db.batch();
    const plDeductions    = [];

    for (const user of allUsers) {
      if (adminOverrides.has(user.id)) continue;
      const events = (eventsByUser.get(user.id) || []).sort(
        (a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0)
      );

      const isOps = user.role === "operations";
      const plan  = plannedHours.get(user.id);
      const leave = leavesToday.get(user.id);

      // Operations need a planned shift to be auto-evaluated. With no plan and
      // no approved leave, leave the day unmarked (admin must enter a plan).
      if (isOps && !plan && !leave) continue;

      // Working window: office is fixed 10:00–18:00; operations use the planned
      // start/end the admin entered for the day.
      let startMin = isOps ? toMinutes(plan?.startTime, 10 * 60) : 10 * 60;
      let endMin   = isOps ? toMinutes(plan?.endTime,   18 * 60) : 18 * 60;
      // Inverted/zero window (e.g. a mis-entered "06:00" end meaning 6 PM) → fall back to 10:00–18:00.
      if (endMin <= startMin) { startMin = 10 * 60; endMin = 18 * 60; }

      // Operations: in/out come from the first place they reached and the last
      // they left, across site and market visits. Office: office_in / office_out.
      const checkIns  = events.filter((e) => isOps ? OPS_IN_TYPES.has(e.type)  : e.type === "office_in");
      const checkOuts = events.filter((e) => isOps ? OPS_OUT_TYPES.has(e.type) : e.type === "office_out");
      let status;

      if (checkIns.length > 0 && checkOuts.length > 0) {
      const firstIn  = checkIns[0];
      const lastOut  = checkOuts[checkOuts.length - 1];
      const inMinutes  = getHourIST(firstIn.timestamp) * 60 + getMinuteIST(firstIn.timestamp);
      const outMinutes = getHourIST(lastOut.timestamp) * 60 + getMinuteIST(lastOut.timestamp);
      const lateMinutes  = Math.max(0, inMinutes - startMin);
        const earlyMinutes = Math.max(0, endMin - outMinutes);
        const offMinutes   = lateMinutes + earlyMinutes;

        if (offMinutes === 0) status = "Present";
        else if (offMinutes <= 120) status = "SL";
        else status = "HalfDay";
      } else if (checkIns.length > 0 || checkOuts.length > 0) {
        status = "SLNF";
      } else {
        if (leave) {
          const balance = user.plBalance || 0;
          if (balance > 0) {
            status = "PL";
            // Only deduct when today wasn't already counted as PL, so a re-run
            // (manual trigger / retry) doesn't decrement the balance twice.
            if (priorStatus.get(user.id) !== "PL") plDeductions.push(user.id);
          } else {
            status = "LWP";
          }
        } else {
          status = "Absent";
        }
      }

      batch.set(db.doc(`users/${user.id}/attendance_status/${today}`), {
        date: today, userId: user.id, userName: user.name || "",
        employeeId: user.employeeId || "", role: user.role, status,
        markedBy: "auto", updatedAt: admin.firestore.Timestamp.now(),
      });

      // Per-day worked hours → shortage (auto) and overtime (admin-approved later).
      // Only on fully-worked days; absent / leave / log-not-found never accrue.
      if (checkIns.length > 0 && checkOuts.length > 0) {
        const firstIn    = checkIns[0];
        const lastOut     = checkOuts[checkOuts.length - 1];
        const inMin       = getHourIST(firstIn.timestamp) * 60 + getMinuteIST(firstIn.timestamp);
        const outMin      = getHourIST(lastOut.timestamp) * 60 + getMinuteIST(lastOut.timestamp);
        const actualMins  = Math.max(0, outMin - inMin);
        const plannedMins = Math.max(0, endMin - startMin);
        // Shortage = late-in + early-out; OT = late-out only (arriving early never earns OT).
        const shortageMins = Math.max(0, inMin - startMin) + Math.max(0, endMin - outMin);
        const otMins       = Math.max(0, outMin - endMin);

        // Per-day canonical record (the OT/shortage ledger reads this, not a lifetime counter).
        batch.set(db.doc(`users/${user.id}/daily_hours/${today}`), {
          date: today, userId: user.id, role: user.role,
          plannedMins, actualMins, shortageMins, otMins,
          updatedAt: admin.firestore.Timestamp.now(),
        });
      }
    }

    await batch.commit();
    for (const uid of plDeductions) {
      await db.doc(`users/${uid}`).update({ plBalance: admin.firestore.FieldValue.increment(-1) });
    }
    console.log(`computeDailyAttendanceStatus: ${allUsers.length} users for ${today}, PL deducted: ${plDeductions.length}`);
  }
);

// ── Daily Sheets Export ───────────────────────────────────────────────────────
exports.exportToSheets = onSchedule(
  { schedule: "30 16 * * *", secrets: ["ATTENDANCE_SHEETS_KEY", "MAPS_API_KEY"], timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    const keyJson = JSON.parse(SHEETS_KEY.value());
    const auth    = new google.auth.GoogleAuth({ credentials: keyJson, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets  = google.sheets({ version: "v4", auth });
    const db      = admin.firestore();

    // ── Shared date helpers ────────────────────────────────────────────
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const today      = now.toISOString().slice(0, 10);
    // Company-wide holidays this month — excluded from working-day counts.
    const holidaySnap = await db.collection("holidays")
      .where("date", ">=", monthStart).where("date", "<=", today).get();
    const holidaySet = new Set(holidaySnap.docs.map((h) => h.id));
    // Count working days (Mon–Sat, excluding Sundays and holidays) passed in the month
    let daysPassed = 0;
    for (let d = 1; d <= now.getDate(); d++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), d);
      const ds = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (dt.getDay() !== 0 && !holidaySet.has(ds)) daysPassed++;
    }
    const monthLabel = now.toLocaleString("en-IN", { month: "long", year: "numeric" });

    // ── All users (shared across sections) ────────────────────────────
    const allUsersSnap = await db.collection("users").get();
    const allUsersData = allUsersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const userRoleMap  = new Map(allUsersData.map((u) => [u.id, u.role || ""]));
    const userEmpIdMap = new Map(allUsersData.map((u) => [u.id, u.employeeId || ""]));
    const userNameMap  = new Map(allUsersData.map((u) => [u.id, u.name || ""]));

    // ── userId__date → DailyStatus (for Attendance tab) ───────────────
    const statusSnap = await db.collectionGroup("attendance_status").get();
    const statusMap  = new Map();
    statusSnap.docs.forEach((doc) => {
      const d = doc.data();
      statusMap.set(`${d.userId}__${d.date}`, d.status || "");
    });

    // ── MTD attendance summary per user (for Employee Dashboard) ──────
    // Re-use statusSnap (already fetched above) — filter to current month
    const userAttendanceMTD = new Map(); // userId → {present, halfDay, pl, lwp, absent}
    statusSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.date < monthStart || d.date > today) return;
      // Skip Sundays — they are not working days
      const dayOfWeek = new Date(d.date + "T00:00:00+05:30").getDay();
      if (dayOfWeek === 0) return;
      if (!userAttendanceMTD.has(d.userId))
        userAttendanceMTD.set(d.userId, { present: 0, halfDay: 0, sl: 0, slnf: 0, pl: 0, lwp: 0, absent: 0});
      const ua = userAttendanceMTD.get(d.userId);
      switch (d.status) {
        case "Present":  ua.present++;  break;
        case "HalfDay":  ua.halfDay++;  break;
        case "SL":       ua.sl++;       break;
        case "SLNF":     ua.slnf++;     break;
        case "PL":       ua.pl++;       break;
        case "LWP":      ua.lwp++;      break;
        case "Absent":   ua.absent++;   break;
      }
    });

    // ── 1. Attendance — one row per employee per day ──────────────────
    // In/Out times: office uses office_in/office_out; operations uses the
    // first site reached (site_in) and the last site left (site_out).
    {
      const snap   = await db.collectionGroup("attendance").get();
      const header = [
        "Date", "Employee Name", "Employee ID", "Role",
        "In Time", "In Location", "Site ID", "Out Time", "Out Location",
        "All Activity", "OT", "Daily Status",
      ];

      // Group all events by employee + date.
      const groups = new Map(); // `${uid}__${date}` → { uid, date, events[] }
      snap.docs.forEach((doc) => {
        const d   = doc.data();
        const uid = uidOf(doc);
        const key = `${uid}__${d.date || ""}`;
        if (!groups.has(key)) groups.set(key, { uid, date: d.date || "", events: [] });
        groups.get(key).events.push(d);
      });

      // Build a row for every employee/day that has EITHER attendance events
      // OR a computed status doc — so Absent / PL / LWP / SLNF days (which have
      // no check-in events) still appear with their status.
      const allKeys = new Set([...groups.keys(), ...statusMap.keys()]);
      const rows = [...allKeys].map((key) => {
        const group = groups.get(key);
        const sep   = key.lastIndexOf("__");
        const uid   = group ? group.uid  : key.slice(0, sep);
        const date  = group ? group.date : key.slice(sep + 2);
        const role  = userRoleMap.get(uid) || "";
        const isOps = role === "operations";

        const locOf = (e) => !e ? "" : (isOps ? (e.siteName || "Site") : (e.locationName || "Office"));
        // Site ID is filled in per-entry by the admin (Site IDs page) on the attendance doc.
        const siteIdOf = (e) => (isOps && e) ? (e.siteId || "") : "";

        let firstIn, lastOut, allActivity = "";
        if (group) {
          group.events.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
          firstIn = group.events.filter((e) => e.type === (isOps ? "site_in"  : "office_in"))[0];
          const outs = group.events.filter((e) => e.type === (isOps ? "site_out" : "office_out"));
          lastOut = outs[outs.length - 1];

          // Full chronological log of every check-in / check-out and site visited,
          // with the resolved Site ID in brackets when one is mapped.
          allActivity = group.events.map((e) => {
            const inOut = (e.type || "").endsWith("_in") ? "In" : "Out";
            const id    = siteIdOf(e);
            return `${inOut} ${timeIST(e.timestamp)} — ${locOf(e)}${id ? ` [${id}]` : ""}`;
          }).join("\n");
        }

        const isOT  = isOps && lastOut && getHourIST(lastOut.timestamp) >= 18;

        return [
          date,
          userNameMap.get(uid) ?? "",
          userEmpIdMap.get(uid) ?? "",
          role,
          timeIST(firstIn?.timestamp), locOf(firstIn), siteIdOf(firstIn),
          timeIST(lastOut?.timestamp), locOf(lastOut),
          allActivity,
          isOT ? "Yes" : "",
          statusMap.get(`${uid}__${date}`) || "",
        ];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      await writeTab(sheets, SHEET_ID_2, TABS.ATTENDANCE, [header, ...rows]);
      console.log(`Attendance: ${rows.length} rows`);
    }

    // ── 2. MT Requests ────────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("material_requests").get();
      const header = [
        "Submitted At", "Status", "Employee Name", "Employee ID",
        "Site ID", "Site Name", "Item Name", "Quantity", "Unit", "Item Notes", "Overall Notes", "Photo URLs",
      ];
      const rows = [];
      snap.docs.forEach((doc) => {
        const d      = doc.data();
        const items  = Array.isArray(d.items) ? d.items : [];
        const photos = Array.isArray(d.photoUrls) ? d.photoUrls.join("\n") : "";
        const uid    = uidOf(doc);
        const base   = [ts(d.submittedAt), d.status || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.siteId || "", d.siteName || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.notes || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_3, TABS.REQUESTS, [header, ...rows]);
      console.log(`MT Requests: ${rows.length} rows`);
    }

    // ── 3. MT Purchases ───────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("material_purchases").get();
      const header = [
        "Submitted At", "Status", "Employee Name", "Employee ID",
        "Site ID", "Site Name", "Item Name", "Quantity", "Unit",
        "Price Per Unit", "Total Price", "Grand Total", "Notes", "Photo URLs",
      ];
      const rows = [];
      snap.docs.forEach((doc) => {
        const d      = doc.data();
        const items  = Array.isArray(d.items) ? d.items : [];
        const photos = Array.isArray(d.photoUrls) ? d.photoUrls.join("\n") : "";
        const uid    = uidOf(doc);
        const base   = [ts(d.submittedAt), d.status || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.siteId || "", d.siteName || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", "", d.grandTotal || "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.pricePerUnit || "", item.totalPrice || "", d.grandTotal || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_4, TABS.PURCHASES, [header, ...rows]);
      console.log(`MT Purchases: ${rows.length} rows`);
    }

    // ── 4. Material Transfers ─────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("material_transfers").get();
      const header = [
        "Submitted At", "Status", "Employee Name", "Employee ID", "Transfer Date",
        "From", "To", "Transferred By", "Received By",
        "Item Name", "Quantity", "Unit", "Condition", "Notes", "Photo URLs",
      ];
      const rows = [];
      snap.docs.forEach((doc) => {
        const d      = doc.data();
        const items  = Array.isArray(d.items) ? d.items : [];
        const photos = Array.isArray(d.photoUrls) ? d.photoUrls.join("\n") : "";
        const uid    = uidOf(doc);
        const base   = [ts(d.submittedAt), d.status || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.transferDate || "", d.fromLocation || "", d.toLocation || "", d.transferredBy || "", d.receivedBy || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.condition || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_5, TABS.MATERIAL_TRANSFERS, [header, ...rows]);
      console.log(`Material Transfers: ${rows.length} rows`);
    }

    // ── 5. Tool Transfers ─────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("tool_transfers").get();
      const header = [
        "Submitted At", "Status", "Employee Name", "Employee ID", "Transfer Date",
        "From", "To", "Transferred By", "Received By",
        "Item Name", "Quantity", "Unit", "Condition", "Notes",
      ];
      const rows = [];
      snap.docs.forEach((doc) => {
        const d    = doc.data();
        const items = Array.isArray(d.items) ? d.items : [];
        const uid   = uidOf(doc);
        const base  = [ts(d.submittedAt), d.status || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.transferDate || "", d.fromLocation || "", d.toLocation || "", d.transferredBy || "", d.receivedBy || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || ""]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.condition || "", d.notes || ""]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_6, TABS.TOOL_TRANSFERS, [header, ...rows]);
      console.log(`Tool Transfers: ${rows.length} rows`);
    }

    // ── 6. Work Progress ──────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("work_progress").get();
      const header = ["Date", "Employee Name", "Employee ID", "Site ID", "Site Name", "Hours Worked", "Work Description", "Status", "Submitted At", "Photo URLs"];
      const rows   = snap.docs.map((doc) => {
        const d   = doc.data();
        const uid = uidOf(doc);
        return [d.date || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.siteId || "", d.siteName || "", d.hoursWorked || "", d.workDescription || "", d.status || "", ts(d.submittedAt), Array.isArray(d.photoUrls) ? d.photoUrls.join("\n") : ""];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_7, TABS.WORK_PROGRESS, [header, ...rows]);
      console.log(`Work Progress: ${rows.length} rows`);
    }

    // ── 7. Leave Requests ─────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("leave_requests").get();
      const header = ["Submitted At", "Status", "Employee Name", "Employee ID", "Leave Type", "From Date", "To Date", "Total Days", "Reason", "Approved By", "Approver Comment", "Reviewed At"];
      const rows   = snap.docs.map((doc) => {
        const d   = doc.data();
        const uid = uidOf(doc);
        return [ts(d.submittedAt), d.status || "", userNameMap.get(uid) ?? d.userName ?? "", userEmpIdMap.get(uid) ?? d.employeeId ?? "", d.leaveType || "", d.fromDate || "", d.toDate || "", d.totalDays || "", d.reason || "", d.approvedBy || "", d.approverComment || "", ts(d.reviewedAt)];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, SHEET_ID_1, TABS.LEAVE_REQUESTS, [header, ...rows]);
      console.log(`Leave Requests: ${rows.length} rows`);
    }

    // ── 8. Conveyance — also builds conveyanceByUserId for Employee Dashboard
    let conveyanceByUserId = new Map(); // userId → total ₹ conveyance this month
    {
      const mapsKey    = MAPS_KEY.value();

      // Read per-employee conveyance rate config from Firestore
      const convConfigSnap = await db.doc("config/conveyance").get();
      const convConfig     = convConfigSnap.exists ? convConfigSnap.data() : {};
      const rateValues     = { 1: convConfig.rate1 || CONVEYANCE_RATE_FALLBACK, 2: convConfig.rate2 || CONVEYANCE_RATE_FALLBACK };

      const opsUsersSnap = await db.collection("users").where("role", "==", "operations").get();
      const opsUsers   = new Map(opsUsersSnap.docs.map((d) => [d.id, d.data()]));

      const attendSnap = await db.collectionGroup("attendance")
        .where("date", ">=", monthStart)
        .where("date", "<=", today)
        .get();

      const grouped = new Map();
      attendSnap.docs.forEach((doc) => {
        const d = doc.data();
        const user = opsUsers.get(d.userId);
        if (!user) return;
        const hasGPS  = d.latitude && d.longitude;
        const isHome  = d.type === "home_in" || d.type === "home_out";
        const hasHome = user.homeLat && user.homeLng;
        if (!hasGPS && !(isHome && hasHome)) return;
        const key = `${d.userId}__${d.date}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(d);
      });
      grouped.forEach((events) => events.sort((a, b) => a.timestamp.seconds - b.timestamp.seconds));

      function buildRoute(events) {
        const parts = [];
        events.forEach((e) => {
          let loc = "";
          if (e.type === "home_in"   || e.type === "home_out")   loc = "Home";
          if (e.type === "site_in"   || e.type === "site_out")   loc = e.siteName   || "Site";
          if (e.type === "market_in" || e.type === "market_out") loc = e.marketName || "Market";
          if (loc && parts[parts.length - 1] !== loc) parts.push(loc);
        });
        return parts.join(" → ");
      }

      function resolveCoords(event, user) {
        if ((event.type === "home_in" || event.type === "home_out") && user.homeLat && user.homeLng) {
          return { lat: user.homeLat, lng: user.homeLng };
        }
        return { lat: event.latitude, lng: event.longitude };
      }

      const entries = [...grouped.entries()];
      const BATCH   = 20;
      const allRows = [];

      for (let i = 0; i < entries.length; i += BATCH) {
        const batch   = entries.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async ([key, events]) => {
          const userId = key.split("__")[0];
          const user   = opsUsers.get(userId) || {};
          const ratePerKm = rateValues[user.conveyanceRateType] || rateValues[1] || CONVEYANCE_RATE_FALLBACK;
          let totalKm  = 0;
          for (let j = 0; j < events.length - 1; j++) {
            const a = resolveCoords(events[j], user);
            const b = resolveCoords(events[j + 1], user);
            totalKm += await getRoadKm(a.lat, a.lng, b.lat, b.lng, mapsKey);
          }
          const conveyance = totalKm * ratePerKm;
          conveyanceByUserId.set(userId, (conveyanceByUserId.get(userId) || 0) + conveyance);
          return [events[0].date, user.name || user.userName || "", user.employeeId || "", buildRoute(events), totalKm.toFixed(2), conveyance.toFixed(2), `₹${ratePerKm}/km`, userId, ratePerKm];
        }));
        allRows.push(...results);
      }

      allRows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

      // Persist daily conveyance records to Firestore
      {
        const BATCH_LIMIT = 500;
        let fbBatch = db.batch();
        let opCount = 0;
        const monthStr = monthStart.slice(0, 7);

        for (const row of allRows) {
          const [date, userName, employeeId, route, totalKmStr, conveyanceStr, , odUserId, ratePerKm] = row;
          const docRef = db.collection("conveyance").doc(`${odUserId}__${date}`);
          fbBatch.set(docRef, {
            userId: odUserId, userName, employeeId, date, month: monthStr,
            route, totalKm: parseFloat(totalKmStr), ratePerKm,
            conveyance: parseFloat(conveyanceStr),
            computedAt: admin.firestore.Timestamp.now(),
          });
          opCount++;
          if (opCount >= BATCH_LIMIT) {
            await fbBatch.commit();
            fbBatch = db.batch();
            opCount = 0;
          }
        }
        if (opCount > 0) await fbBatch.commit();
        console.log(`Conveyance: ${allRows.length} records persisted to Firestore`);
      }

      const header = ["Date", "Employee Name", "Employee ID", "Route", "Total KM", "Conveyance (₹)", "Rate"];
      await writeTab(sheets, SHEET_ID_1, TABS.CONVEYANCE, [header, ...allRows.map(r => r.slice(0, 7))]);
      console.log(`Conveyance: ${allRows.length} rows`);
    }

    // ── 9. Employee Dashboard — MTD summary, one row per employee ─────
    {
      const TAB = TABS.EMPLOYEE_DASHBOARD;

      // Read existing sheet to preserve manually-entered Imprest (salary rate now comes from Firestore).
      // Locate columns by header name so this survives layout changes (e.g. added NP-breakdown columns).
      const imprestMap = new Map(); // employeeId → imprest
      try {
        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID_1,
          range: `${TAB}!A:Z`,
        });
        const existingRows = existing.data.values || [];
        const hdr        = existingRows[0] || [];
        const empIdCol   = hdr.indexOf("EMP ID");
        const imprestCol = hdr.findIndex((h) => String(h).toLowerCase().startsWith("imprest"));
        if (empIdCol !== -1 && imprestCol !== -1) {
          for (let i = 1; i < existingRows.length; i++) {
            const r = existingRows[i];
            if (!r || !r[empIdCol] || r[0] === "CF BAL" || r[0] === "TOTAL") continue;
            const empId = String(r[empIdCol]).trim();
            if (empId) imprestMap.set(empId, parseFloat(r[imprestCol]) || 0);
          }
        }
      } catch (_) {
        // Tab doesn't exist yet — start fresh
      }

      // Prior-month settlement (OT/shortage/WO) — paid in arrears. Read each user's LOCKED
      // settlement for the previous month and add its cash to this month's TOTAL DUE.
      const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}`;
      const settlementCashMap = new Map(); // userId → settlement cash (locked only)
      await Promise.all(allUsersData.map(async (u) => {
        try {
          const sdoc = await db.collection("users").doc(u.id).collection("settlements").doc(prevMonth).get();
          const s = sdoc.data();
          if (s && s.locked) settlementCashMap.set(u.id, Number(s.settlementCash) || 0);
        } catch (_) { /* no settlement for this user — skip */ }
      }));

      const header = [
        "Date", "EMP Name", "EMP ID", "Days Passed in Month",
        "Present (×1)", "SL (×0.75)", "Half Day (×0.5)", "SLNF (×0.5)", "PL (×1)", "LWP (×0)", "Absent (×-2)",
        "Leaves", "Days NP",
        "Salary Rate", "Salary Due MTD",
        "Covy Due (approx avg)", "Imprest Due MTD", `Prior Settlement ${prevMonth} (₹)`, "TOTAL DUE",
      ];

      const sortedUsers = [...allUsersData].sort((a, b) => {
        const roleOrder = { office: 0, admin: 1, operations: 2 };
        return (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3) || (a.name || "").localeCompare(b.name || "");
      });

      let grandTotal    = 0;
      let grandCfBal    = 0;
      const empRows     = [];

      sortedUsers.forEach((user) => {
        const empId    = user.employeeId || "";
        const ua       = userAttendanceMTD.get(user.id) || { present: 0, halfDay: 0, sl: 0, slnf: 0, pl: 0, lwp: 0, absent: 0};

        // Absent = 2-day penalty (lose the day + a penalty day) → ×-2. LWP = unpaid, contributes 0.
        const daysNP   = ua.present + ua.sl * 0.75 + ua.halfDay * 0.5 + ua.slnf * 0.5 + ua.pl - ua.absent * 2;
        const leaves   = ua.pl + ua.lwp; // all leave types shown together

        const salaryRate = user.salaryRate || 0;
        const salaryDue  = parseFloat((daysNP * salaryRate).toFixed(2));

        // Conveyance: operations only, from conveyanceByUserId built in section 8
        const covy       = user.role === "operations"
          ? parseFloat((conveyanceByUserId.get(user.id) || 0).toFixed(2))
          : 0;

        const imprest    = imprestMap.get(empId) || 0;
        const settlement = parseFloat((settlementCashMap.get(user.id) || 0).toFixed(2));
        const totalDue   = parseFloat((salaryDue + covy + imprest + settlement).toFixed(2));

        grandTotal += totalDue;
        grandCfBal += user.plBalance || 0;

        empRows.push([
          monthLabel,
          user.name || "",
          empId,
          daysPassed,
          ua.present, ua.sl, ua.halfDay, ua.slnf, ua.pl, ua.lwp, ua.absent,
          leaves,
          daysNP,
          salaryRate,
          salaryDue,
          covy,
          imprest,
          settlement,
          totalDue,
        ]);
      });

      // Build a blank summary row of the right width, with a label first and a value in the last column.
      const summaryRow = (label, lastVal) => {
        const row = new Array(header.length).fill("");
        row[0] = label;
        row[header.length - 1] = lastVal;
        return row;
      };

      // CF BAL row — carry-forward leave balance per employee (total in last col)
      const cfBalRow  = summaryRow("CF BAL", grandCfBal);

      // TOTAL row — grand total of all dues
      const totalRow  = summaryRow("TOTAL", grandTotal);

      await writeTab(sheets, SHEET_ID_1, TAB, [header, ...empRows, cfBalRow, totalRow]);
      console.log(`Employee Dashboard: ${empRows.length} employees, total due ₹${grandTotal}`);
    }

    console.log("Full Sheets export complete.");
  }
);

// ── FCM Push Notifications ────────────────────────────────────────────────────
// Triggered when admin portal writes a new doc to /sent_notifications/.
// Reads FCM tokens for the target audience and sends push to all their devices,
// even when the app is closed. The in-app notification record is written by the
// admin portal (writeBatch to /users/{uid}/notifications/); this function only
// handles the push delivery layer.
exports.sendPushNotification = onDocumentCreated(
  "sent_notifications/{docId}",
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const { title, body, type = "general", recipientType, recipientId } = data;
    if (!title || !body) {
      console.log("sendPushNotification: missing title or body — skipping");
      return;
    }

    const db        = admin.firestore();
    const messaging = admin.messaging();
    let tokens      = [];

    if (recipientType === "specific") {
      if (!recipientId) {
        console.log("sendPushNotification: recipientType=specific but recipientId is missing");
        return;
      }
      const userDoc = await db.collection("users").doc(recipientId).get();
      const token   = userDoc.data()?.fcmToken;
      if (token) tokens = [token];
    } else {
      let query = db.collection("users");
      if (recipientType === "operations") {
        query = query.where("role", "==", "operations");
      } else if (recipientType === "office") {
        // isOffice is true for both office and admin roles
        query = query.where("role", "in", ["office", "admin"]);
      }
      // "all" — no role filter
      const snap = await query.get();
      tokens = snap.docs.map((d) => d.data().fcmToken).filter(Boolean);
    }

    if (tokens.length === 0) {
      console.log(`sendPushNotification: no FCM tokens found for recipientType=${recipientType}`);
      return;
    }

    // FCM multicast is capped at 500 tokens per call
    const CHUNK = 500;
    let totalSuccess = 0;
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const chunk    = tokens.slice(i, i + CHUNK);
      const response = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { type },
        android: { priority: "high" },
      });
      totalSuccess += response.successCount;
      console.log(`sendPushNotification: chunk ${Math.floor(i / CHUNK) + 1} — ${response.successCount}/${chunk.length} delivered`);
    }
    console.log(`sendPushNotification: done — ${totalSuccess}/${tokens.length} tokens reached`);
  }
);

// ── Monthly Regularization Reminder — 25th of each month, 10 AM IST ─────────
exports.regularizationReminder = onSchedule(
  { schedule: "0 10 25 * *", timeZone: "Asia/Kolkata", timeoutSeconds: 120 },
  async () => {
    const db = admin.firestore();

    const snap = await db.collectionGroup("regularization_requests").get();
    const pending = snap.docs
      .map((d) => d.data())
      .filter((r) => r.status === "pending");

    if (pending.length === 0) {
      console.log("regularizationReminder: no pending requests, skipping");
      return;
    }

    const adminsSnap = await db.collection("users").where("role", "==", "admin").get();
    if (adminsSnap.empty) {
      console.log("regularizationReminder: no admin users found");
      return;
    }

    const notifBatch = db.batch();
    adminsSnap.docs.forEach((adminDoc) => {
      const notifRef = db.collection("users").doc(adminDoc.id)
        .collection("notifications").doc();
      notifBatch.set(notifRef, {
        title: "Regularization Review Pending",
        body: `${pending.length} attendance regularization request(s) need your review.`,
        type: "work_reminder",
        isRead: false,
        createdAt: admin.firestore.Timestamp.now(),
      });
    });
    await notifBatch.commit();

    console.log(`regularizationReminder: notified ${adminsSnap.size} admin(s) about ${pending.length} pending requests`);
  }
);

// ── Employee Logout — auto check-out from everywhere + home_out ──────────────
exports.onEmployeeLogout = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be signed in.");

  const db  = admin.firestore();
  const now = admin.firestore.Timestamp.now();
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today  = nowIST.toISOString().slice(0, 10);

  const userDoc = await db.doc(`users/${uid}`).get();
  if (!userDoc.exists) throw new HttpsError("not-found", "User profile not found.");
  const user = userDoc.data();

  const attendSnap = await db.collection(`users/${uid}/attendance`)
    .where("date", "==", today).get();
  const events = attendSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const inTypes  = new Set(events.filter((e) => e.type.endsWith("_in")).map((e) => e.type));
  const outTypes = new Set(events.filter((e) => e.type.endsWith("_out")).map((e) => e.type));

  const batch = db.batch();
  let wrote = 0;

  for (const inType of inTypes) {
    const outType = inType.replace("_in", "_out");
    if (outTypes.has(outType)) continue;

    const lastIn = events
      .filter((e) => e.type === inType)
      .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0))[0];

    const ref = db.collection(`users/${uid}/attendance`).doc();
    batch.set(ref, {
      userId: uid,
      userName: user.name || "",
      employeeId: user.employeeId || "",
      date: today,
      type: outType,
      timestamp: now,
      latitude: lastIn?.latitude || 0,
      longitude: lastIn?.longitude || 0,
      siteId: lastIn?.siteId || "",
      siteName: lastIn?.siteName || "",
      marketName: lastIn?.marketName || "",
      autoLogout: true,
    });
    wrote++;
  }

  if (!outTypes.has("home_out") && !inTypes.has("home_out")) {
    const homeIn = events.find((e) => e.type === "home_in");
    const ref = db.collection(`users/${uid}/attendance`).doc();
    batch.set(ref, {
      userId: uid,
      userName: user.name || "",
      employeeId: user.employeeId || "",
      date: today,
      type: "home_out",
      timestamp: now,
      latitude: user.homeLat || homeIn?.latitude || 0,
      longitude: user.homeLng || homeIn?.longitude || 0,
      siteId: "",
      siteName: "",
      marketName: "",
      autoLogout: true,
    });
    wrote++;
  }

  if (wrote > 0) await batch.commit();
  console.log(`onEmployeeLogout: ${uid} — ${wrote} auto-checkout event(s) for ${today}`);
  return { success: true, eventsCreated: wrote };
});
