const { setGlobalOptions } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const SHEETS_KEY   = defineSecret("ATTENDANCE_SHEETS_KEY");
const MAPS_KEY     = defineSecret("MAPS_API_KEY");
const SHEET_ID     = "1pemb9uSbu-NenE_QSkfPx6842EG1T6Z21isGM5IXrYs";

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

async function ensureTab(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function writeTab(sheets, tabName, rows) {
  await ensureTab(sheets, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: tabName });
  if (rows.length === 0) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
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
    const existingStatusSnap = await db.collectionGroup("attendance_status")
      .where("date", "==", today).get();
    const adminOverrides = new Set();
    existingStatusSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.markedBy === "admin") adminOverrides.add(d.userId);
    });

    const batch        = db.batch();
    const plDeductions = [];

    for (const user of allUsers) {
      if (adminOverrides.has(user.id)) continue;
      const events = (eventsByUser.get(user.id) || []).sort(
        (a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0)
      );

      const isOps = user.role === "operations";
      const checkIns  = events.filter((e) => e.type === (isOps ? "home_in"   : "office_in"));
      const checkOuts = events.filter((e) => e.type === (isOps ? "home_out"  : "office_out"));
      let status;

      if (checkIns.length > 0) {
        const firstIn  = checkIns[0];
        const lastOut  = checkOuts.length > 0 ? checkOuts[checkOuts.length - 1] : null;
        const inMinutes = getHourIST(firstIn.timestamp) * 60 + getMinuteIST(firstIn.timestamp);
        const lateIn    = inMinutes > 10 * 60;
        let earlyOut    = true;
        if (lastOut) {
          const outMinutes = getHourIST(lastOut.timestamp) * 60 + getMinuteIST(lastOut.timestamp);
          earlyOut = outMinutes < 18 * 60;
        }
        status = lateIn || earlyOut ? "HalfDay" : "Present";
      } else {
        const leave   = leavesToday.get(user.id);
        if (leave) {
          const balance = user.plBalance || 0;
          if (balance > 0) { status = "PL"; plDeductions.push(user.id); }
          else               status = "UPL";
        } else {
          status = "Absent";
        }
      }

      batch.set(db.doc(`users/${user.id}/attendance_status/${today}`), {
        date: today, userId: user.id, userName: user.name || "",
        employeeId: user.employeeId || "", role: user.role, status,
        markedBy: "auto", updatedAt: admin.firestore.Timestamp.now(),
      });
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
  { schedule: "30 16 * * *", secrets: ["ATTENDANCE_SHEETS_KEY", "MAPS_API_KEY"], timeoutSeconds: 540 },
  async () => {
    const keyJson = JSON.parse(SHEETS_KEY.value());
    const auth    = new google.auth.GoogleAuth({ credentials: keyJson, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets  = google.sheets({ version: "v4", auth });
    const db      = admin.firestore();

    // ── Shared date helpers ────────────────────────────────────────────
    const now        = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const today      = now.toISOString().slice(0, 10);
    const daysPassed = now.getDate();
    const monthLabel = now.toLocaleString("en-IN", { month: "long", year: "numeric" });

    // ── All users (shared across sections) ────────────────────────────
    const allUsersSnap = await db.collection("users").get();
    const allUsersData = allUsersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const userRoleMap  = new Map(allUsersData.map((u) => [u.id, u.role || ""]));

    // ── userId__date → DailyStatus (for Attendance tab) ───────────────
    const statusSnap = await db.collectionGroup("attendance_status").get();
    const statusMap  = new Map();
    statusSnap.docs.forEach((doc) => {
      const d = doc.data();
      statusMap.set(`${d.userId}__${d.date}`, d.status || "");
    });

    // ── MTD attendance summary per user (for Employee Dashboard) ──────
    // Re-use statusSnap (already fetched above) — filter to current month
    const userAttendanceMTD = new Map(); // userId → {present, halfDay, pl, upl, absent}
    statusSnap.docs.forEach((doc) => {
      const d = doc.data();
      if (d.date < monthStart || d.date > today) return;
      if (!userAttendanceMTD.has(d.userId))
        userAttendanceMTD.set(d.userId, { present: 0, halfDay: 0, pl: 0, upl: 0, absent: 0 });
      const ua = userAttendanceMTD.get(d.userId);
      switch (d.status) {
        case "Present":  ua.present++;  break;
        case "HalfDay":  ua.halfDay++;  break;
        case "PL":       ua.pl++;       break;
        case "UPL":      ua.upl++;      break;
        case "Absent":   ua.absent++;   break;
      }
    });

    // ── 1. Attendance ─────────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("attendance").get();
      const header = [
        "Date", "Employee Name", "Employee ID", "Type", "Timestamp",
        "Site ID", "Site Name", "Market Name", "Location Name", "Latitude", "Longitude",
        "OT", "Daily Status",
      ];
      const rows = snap.docs.map((doc) => {
        const d    = doc.data();
        const role = userRoleMap.get(d.userId) || "";
        const isOT = role === "operations" && d.type === "site_out" && getHourIST(d.timestamp) >= 18;
        return [
          d.date || "", d.userName || "", d.employeeId || "", d.type || "", ts(d.timestamp),
          d.siteId || "", d.siteName || "", d.marketName || "", d.locationName || "",
          d.latitude || "", d.longitude || "",
          isOT ? "Yes" : "",
          statusMap.get(`${d.userId}__${d.date}`) || "",
        ];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]) || a[4].localeCompare(b[4]));
      await writeTab(sheets, TABS.ATTENDANCE, [header, ...rows]);
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
        const base   = [ts(d.submittedAt), d.status || "", d.userName || "", d.employeeId || "", d.siteId || "", d.siteName || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.notes || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.REQUESTS, [header, ...rows]);
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
        const base   = [ts(d.submittedAt), d.status || "", d.userName || "", d.employeeId || "", d.siteId || "", d.siteName || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", "", d.grandTotal || "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.pricePerUnit || "", item.totalPrice || "", d.grandTotal || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.PURCHASES, [header, ...rows]);
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
        const base   = [ts(d.submittedAt), d.status || "", d.userName || "", d.employeeId || "", d.transferDate || "", d.fromLocation || "", d.toLocation || "", d.transferredBy || "", d.receivedBy || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || "", photos]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.condition || "", d.notes || "", photos]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.MATERIAL_TRANSFERS, [header, ...rows]);
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
        const base  = [ts(d.submittedAt), d.status || "", d.userName || "", d.employeeId || "", d.transferDate || "", d.fromLocation || "", d.toLocation || "", d.transferredBy || "", d.receivedBy || ""];
        if (items.length === 0) rows.push([...base, "", "", "", "", d.notes || ""]);
        else items.forEach((item) => rows.push([...base, item.itemName || "", item.quantity || "", item.unit || "", item.condition || "", d.notes || ""]));
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.TOOL_TRANSFERS, [header, ...rows]);
      console.log(`Tool Transfers: ${rows.length} rows`);
    }

    // ── 6. Work Progress ──────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("work_progress").get();
      const header = ["Date", "Employee Name", "Employee ID", "Site ID", "Site Name", "Hours Worked", "Work Description", "Status", "Submitted At", "Photo URLs"];
      const rows   = snap.docs.map((doc) => {
        const d = doc.data();
        return [d.date || "", d.userName || "", d.employeeId || "", d.siteId || "", d.siteName || "", d.hoursWorked || "", d.workDescription || "", d.status || "", ts(d.submittedAt), Array.isArray(d.photoUrls) ? d.photoUrls.join("\n") : ""];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.WORK_PROGRESS, [header, ...rows]);
      console.log(`Work Progress: ${rows.length} rows`);
    }

    // ── 7. Leave Requests ─────────────────────────────────────────────
    {
      const snap   = await db.collectionGroup("leave_requests").get();
      const header = ["Submitted At", "Status", "Employee Name", "Employee ID", "Leave Type", "From Date", "To Date", "Total Days", "Reason", "Approved By", "Approver Comment", "Reviewed At"];
      const rows   = snap.docs.map((doc) => {
        const d = doc.data();
        return [ts(d.submittedAt), d.status || "", d.userName || "", d.employeeId || "", d.leaveType || "", d.fromDate || "", d.toDate || "", d.totalDays || "", d.reason || "", d.approvedBy || "", d.approverComment || "", ts(d.reviewedAt)];
      });
      rows.sort((a, b) => a[0].localeCompare(b[0]));
      await writeTab(sheets, TABS.LEAVE_REQUESTS, [header, ...rows]);
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
          const ratePerKm = rateValues[user.conveyanceRateType] || CONVEYANCE_RATE_FALLBACK;
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
      await writeTab(sheets, TABS.CONVEYANCE, [header, ...allRows.map(r => r.slice(0, 7))]);
      console.log(`Conveyance: ${allRows.length} rows`);
    }

    // ── 9. Employee Dashboard — MTD summary, one row per employee ─────
    {
      const TAB = TABS.EMPLOYEE_DASHBOARD;

      // Read existing sheet to preserve manually-entered Imprest (salary rate now comes from Firestore)
      const imprestMap = new Map(); // employeeId → imprest
      try {
        const existing = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: `${TAB}!A:K`,
        });
        const existingRows = existing.data.values || [];
        for (let i = 1; i < existingRows.length; i++) {
          const r = existingRows[i];
          if (!r || !r[2] || r[0] === "CF BAL" || r[0] === "TOTAL") continue;
          const empId = String(r[2]).trim();
          if (empId) {
            imprestMap.set(empId, parseFloat(r[9]) || 0);
          }
        }
      } catch (_) {
        // Tab doesn't exist yet — start fresh
      }

      const header = [
        "Date", "EMP Name", "EMP ID",
        "Days Passed in Month", "Leaves", "Days NP",
        "Salary Rate", "Salary Due MTD",
        "Covy Due (approx avg)", "Imprest Due MTD", "TOTAL DUE",
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
        const ua       = userAttendanceMTD.get(user.id) || { present: 0, halfDay: 0, pl: 0, upl: 0, absent: 0 };

        // Days NP: Present(1) + HalfDay(0.5) + PL(1, paid leave) — UPL and Absent = 0
        const daysNP   = ua.present + ua.halfDay * 0.5 + ua.pl;
        const leaves   = ua.pl + ua.upl; // all leave types shown together

        const salaryRate = user.salaryRate || 0;
        const salaryDue  = parseFloat((daysNP * salaryRate).toFixed(2));

        // Conveyance: operations only, from conveyanceByUserId built in section 8
        const covy       = user.role === "operations"
          ? parseFloat((conveyanceByUserId.get(user.id) || 0).toFixed(2))
          : 0;

        const imprest    = imprestMap.get(empId) || 0;
        const totalDue   = parseFloat((salaryDue + covy + imprest).toFixed(2));

        grandTotal += totalDue;
        grandCfBal += user.plBalance || 0;

        empRows.push([
          monthLabel,
          user.name || "",
          empId,
          daysPassed,
          leaves || "",
          daysNP || "",
          salaryRate || "",
          salaryDue || "",
          covy || "",
          imprest || "",
          totalDue || "",
        ]);
      });

      // CF BAL row — carry-forward leave balance per employee (total in last col)
      const cfBalRow  = ["CF BAL", "", "", "", "", "", "", "", "", "", grandCfBal];

      // TOTAL row — grand total of all dues
      const totalRow  = ["TOTAL", "", "", "", "", "", "", "", "", "", grandTotal];

      await writeTab(sheets, TAB, [header, ...empRows, cfBalRow, totalRow]);
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
