import { useState, useMemo, useRef, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const TEAMS = ["Rehab", "Peds", "Acute"];
const VISIT_ORDER = ["Acute", "Rehab", "Peds"]; // display order for visits tab
const TEAM_COLORS = {
  Rehab: { bg: "#dbeafe", text: "#1e40af", dot: "#3b82f6" },
  Peds: { bg: "#dcfce7", text: "#166534", dot: "#22c55e" },
  Acute: { bg: "#fee2e2", text: "#991b1b", dot: "#ef4444" },
};
const DEFAULT_NON_WORK = [
  { code: "VAC", label: "Vacation", color: "#8b5cf6" },
  { code: "SICK", label: "Sick", color: "#f59e0b" },
  { code: "DIS", label: "Disability", color: "#64748b" },
  { code: "PFL", label: "PFL", color: "#06b6d4" },
  { code: "BRV", label: "Bereavement", color: "#6b7280" },
  { code: "JURY", label: "Jury Duty", color: "#0ea5e9" },
  { code: "UNPL", label: "Unpaid", color: "#e11d48" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// fteTargets: { Rehab: { 0:2,1:3,2:3,3:3,4:3,5:3,6:2 }, ... }  (0=Sun,6=Sat)
const DEFAULT_FTE_TARGETS = {
  Rehab: { 0:2.0, 1:3.0, 2:3.0, 3:3.0, 4:3.0, 5:3.0, 6:2.0 },
  Peds:  { 0:1.0, 1:2.0, 2:2.0, 3:2.0, 4:2.0, 5:2.0, 6:1.0 },
  Acute: { 0:1.0, 1:2.0, 2:2.0, 3:2.0, 4:2.0, 5:2.0, 6:1.0 },
};
const DEFAULT_CENSUS_TARGETS = { Rehab: 20, Peds: 15, Acute: 12 };
const DEFAULT_PTO_ACCRUAL = { VAC: 80, SICK: 40 }; // default annual hours
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Overridden in published snapshots — keeps data when window.storage unavailable
var PRELOADED_DATA = typeof PRELOADED_DATA !== 'undefined' ? PRELOADED_DATA : {};

const INITIAL_STAFF = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  name: `Staff ${i + 1}`,
  fte: 1.0,
  team: TEAMS[i % TEAMS.length],
  defaultHours: 8,
  shiftStart: "08:00",
  shiftEnd: "16:00",
}));

// Format 08:00 -> 8:00 AM
function fmtTime(t) {
  if (!t || typeof t !== "string" || !t.includes(":")) return "";
  const parts = t.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return "";
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2,"0")} ${ampm}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sortByName = arr => [...arr].sort((a,b) => a.name.localeCompare(b.name));
function getWeekDates(ws) {
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(ws); d.setDate(d.getDate() + i); return d; });
}
function startOfWeek(date) {
  const d = new Date(date); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d;
}
function fmt(date) { return date.toISOString().split("T")[0]; }
function fmtDisplay(date) { return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
function fmtDay(date) { return date.toLocaleDateString("en-US", { weekday: "short" }); }
const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;

function getYearWeekStarts(year) {
  const starts = []; const d = new Date(year, 0, 1); d.setDate(d.getDate() - d.getDay());
  while (d.getFullYear() <= year) { starts.push(new Date(d)); d.setDate(d.getDate() + 7); }
  return starts;
}
function parseCSV(text) {
  // Strip BOM, normalize line endings
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  // Parse a CSV line respecting quoted fields
  const parseLine = (line) => {
    const result = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && !inQ) { inQ = true; }
      else if (c === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"' && inQ) { inQ = false; }
      else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
      else { cur += c; }
    }
    result.push(cur.trim());
    return result;
  };
  const headers = parseLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || "").trim());
    return obj;
  });
}
function buildCSVTemplate(staffList) {
  const header = ["StaffName","Team","ShiftStart","ShiftEnd",...DAYS.flatMap(d=>[`${d}_Hours`,`${d}_NonWork`,`${d}_NonWorkHours`])].join(",");
  const rows = staffList.map(s => {
    const sched = s.defaultSchedule || DAYS.map((_,i)=>({day:i,team:s.team,hours:i===0||i===6?0:8}));
    return [s.name, s.team, s.shiftStart||"08:00", s.shiftEnd||"16:00",
      ...DAYS.flatMap((_,i) => [sched[i]?.hours||0, "", ""])
    ].join(",");
  });
  return [header, ...rows].join("\n");
}
function getDaysInYear(year) {
  const days = []; const d = new Date(year, 0, 1);
  while (d.getFullYear() === year) { days.push(new Date(d)); d.setDate(d.getDate() + 1); }
  return days;
}

// ─── Shared styles ────────────────────────────────────────────────────────────
const lbl = { display:"block", fontSize:12, fontWeight:600, color:"#374151", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" };
const inp = { width:"100%", padding:"8px 12px", border:"1px solid #d1d5db", borderRadius:8, fontSize:14, boxSizing:"border-box" };
const sel = { ...inp, background:"#fff", cursor:"pointer" };
const thS = { padding:"10px 8px", textAlign:"center", fontWeight:700, fontSize:11, borderBottom:"2px solid #e5e7eb", color:"#374151" };
const tdS = { padding:"3px 4px", verticalAlign:"middle" };

// ─── Storage helpers (Claude.ai storage with localStorage fallback) ───────────
const hasClaudeStorage = () => typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";

async function saveToStorage(key, value) {
  const str = JSON.stringify(value);
  if (hasClaudeStorage()) {
    try { await window.storage.set(key, str); return; } catch(e) {}
  }
  try { localStorage.setItem(key, str); } catch(e) { console.warn("Storage save failed:", e); }
}

async function loadFromStorage(key, fallback) {
  // Check preloaded snapshot data first (for published versions)
  if (typeof PRELOADED_DATA !== "undefined" && PRELOADED_DATA[key] !== undefined) {
    try { return JSON.parse(PRELOADED_DATA[key]); } catch(e) {}
  }
  if (hasClaudeStorage()) {
    try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fallback; } catch(e) {}
  }
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch(e) {}
  return fallback;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function StaffingApp() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [entries, setEntries] = useState({});
  const [dailyStats, setDailyStats] = useState({});
  const [staff, setStaff] = useState(INITIAL_STAFF);
  const [nonWorkTypes, setNonWorkTypes] = useState(DEFAULT_NON_WORK);
  const [editingCell, setEditingCell] = useState(null);
  const [drillDay, setDrillDay] = useState(null);
  const [activeTab, setActiveTab] = useState("grid");
  const [filterTeam, setFilterTeam] = useState("All");
  const [editingName, setEditingName] = useState(null);
  const [tempName, setTempName] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showBackupRestore, setShowBackupRestore] = useState(false);
  const [showArchivedManager, setShowArchivedManager] = useState(false);
  const [showVisitEntry, setShowVisitEntry] = useState(false);
  const [showStaffManager, setShowStaffManager] = useState(false);
  const [visitData, setVisitData] = useState({}); // { "2026-W10": { Rehab:{evals:0,visits:0}, Peds:{...}, Acute:{...}, weekStart:"2026-03-03" } }
  const [showNonWorkEditor, setShowNonWorkEditor] = useState(false);
  const [yearView, setYearView] = useState(new Date().getFullYear());
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("saved"); // saved | saving | unsaved
  const saveTimer = useRef(null);
  const xlsxRef = useRef(null); // SheetJS loaded dynamically
  const historyStack = useRef([]); // [{staff,entries,dailyStats}, ...]
  const [canUndo, setCanUndo] = useState(false);
  // Refs so undo callback is stable and doesn't cause re-render chains
  // Initialized to null — synced on every render below (after state is declared)
  const nonWorkTypesRef = useRef(null);
  const alertSettingsRef = useRef(null);
  const ptoBalancesRef = useRef(null);
  const dayNotesRef = useRef(null);
  const triggerSaveRef = useRef(null);
  const isRestoringRef = useRef(false);

  const [unlocked, setUnlocked] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPwManager, setShowPwManager] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [showAlertsEditor, setShowAlertsEditor] = useState(false);
  const [showBatchEntry, setShowBatchEntry] = useState(false);
  const [alertSettings, setAlertSettings] = useState({ fteTargets: DEFAULT_FTE_TARGETS, censusTargets: DEFAULT_CENSUS_TARGETS });
  const [ptoBalances, setPtoBalances] = useState({}); // { staffId: { VAC: 80, SICK: 40 } }
  const [dayNotes, setDayNotes] = useState({});       // { dateStr: "note text" }
  const [dayView, setDayView] = useState(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [monthView, setMonthView] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const menuRef = useRef(null);

  // Load from storage on mount
  useEffect(() => {
    (async () => {
      const [savedStaff, savedEntries, savedDailyStats, savedNonWork, savedPwHash,
             savedAlerts, savedPTO, savedNotes, savedVisits] = await Promise.all([
        loadFromStorage("staffplan:staff", INITIAL_STAFF),
        loadFromStorage("staffplan:entries", {}),
        loadFromStorage("staffplan:dailyStats", {}),
        loadFromStorage("staffplan:nonWorkTypes", DEFAULT_NON_WORK),
        loadFromStorage("staffplan:pwHash", null),
        loadFromStorage("staffplan:alerts", { fteTargets: DEFAULT_FTE_TARGETS, censusTargets: DEFAULT_CENSUS_TARGETS }),
        loadFromStorage("staffplan:pto", {}),
        loadFromStorage("staffplan:notes", {}),
        loadFromStorage("staffplan:visits", {}),
      ]);
      setStaff(savedStaff);
      setEntries(savedEntries);
      setDailyStats(savedDailyStats);
      setNonWorkTypes(savedNonWork);
      setAlertSettings(savedAlerts);
      setPtoBalances(savedPTO);
      setDayNotes(savedNotes);
      if (savedVisits) setVisitData(savedVisits);
      if (!savedPwHash) setUnlocked(true);
      setLoaded(true);
    })();
  }, []);

  // Load SheetJS dynamically
  useEffect(() => {
    if (window.XLSX) { xlsxRef.current = window.XLSX; return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => { xlsxRef.current = window.XLSX; };
    document.head.appendChild(script);
  }, []);

  // Auto-save on changes (debounced)
  const triggerSave = useCallback((newStaff, newEntries, newDailyStats, newNonWork, newAlerts, newPTO, newNotes, newVisits) => {
    if (isRestoringRef.current || window.__staffplanRestoring) return; // suppress saves during backup restore
    setSaveStatus("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      await Promise.all([
        saveToStorage("staffplan:staff", newStaff),
        saveToStorage("staffplan:entries", newEntries),
        saveToStorage("staffplan:dailyStats", newDailyStats),
        saveToStorage("staffplan:nonWorkTypes", newNonWork),
        saveToStorage("staffplan:alerts", newAlerts),
        saveToStorage("staffplan:pto", newPTO),
        saveToStorage("staffplan:notes", newNotes),
        saveToStorage("staffplan:visits", newVisits ?? visitData),
      ]);
      setSaveStatus("saved");
    }, 1200);
  }, [alertSettings, ptoBalances, dayNotes]);

  // Keep refs current so undo can access latest values without dep-array churn
  nonWorkTypesRef.current = nonWorkTypes;
  alertSettingsRef.current = alertSettings;
  ptoBalancesRef.current = ptoBalances;
  dayNotesRef.current = dayNotes;
  triggerSaveRef.current = triggerSave;

  const pushHistory = useCallback((s, e, d) => {
    historyStack.current = [...historyStack.current.slice(-19), { staff: s, entries: e, dailyStats: d }];
    setCanUndo(true);
  }, []);

  const updateStaff = useCallback((val) => { pushHistory(staff, entries, dailyStats); setStaff(val); triggerSave(val, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateEntries = useCallback((val) => { pushHistory(staff, entries, dailyStats); setEntries(val); triggerSave(staff, val, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateDailyStats = useCallback((val) => { pushHistory(staff, entries, dailyStats); setDailyStats(val); triggerSave(staff, entries, val, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateNonWorkTypes = useCallback((val) => { setNonWorkTypes(val); triggerSave(staff, entries, dailyStats, val, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, alertSettings, ptoBalances, dayNotes, triggerSave]);
  const updateAlertSettings = useCallback((val) => { setAlertSettings(val); triggerSave(staff, entries, dailyStats, nonWorkTypes, val, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, ptoBalances, dayNotes, triggerSave]);
  const updatePtoBalances = useCallback((val) => { setPtoBalances(val); triggerSave(staff, entries, dailyStats, nonWorkTypes, alertSettings, val, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, dayNotes, triggerSave]);
  const updateDayNotes = useCallback((val) => { setDayNotes(val); triggerSave(staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, val); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, triggerSave]);
  const updateVisitData = useCallback((val) => { setVisitData(val); triggerSave(staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, val); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave]);

  const undo = useCallback(() => {
    const stack = historyStack.current;
    if (!stack.length) return;
    const prev = stack[stack.length - 1];
    historyStack.current = stack.slice(0, -1);
    setCanUndo(historyStack.current.length > 0);
    setStaff(prev.staff);
    setEntries(prev.entries);
    setDailyStats(prev.dailyStats);
    // Use refs to avoid stale closures and dep-chain re-renders
    if (triggerSaveRef.current) {
      triggerSaveRef.current(prev.staff, prev.entries, prev.dailyStats,
        nonWorkTypesRef.current, alertSettingsRef.current,
        ptoBalancesRef.current, dayNotesRef.current);
    }
  }, []); // stable - all accessed via refs

  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  const filteredStaff = useMemo(() => {
    const active = staff.filter(s => !s.archived);
    if (filterTeam === "All") return sortByName(active);
    return sortByName(active.filter(s => {
      if (s.team === filterTeam) return true;
      return getWeekDates(weekStart).some(date => {
        const segs = (entries[`${s.id}_${fmt(date)}`] || []);
        const arr = Array.isArray(segs) ? segs : [segs];
        return arr.some(e => (e.team || s.team) === filterTeam && Number(e.hours) > 0);
      });
    }));
  }, [staff, filterTeam, entries, weekStart]);
  const nwMap = useMemo(() => Object.fromEntries(nonWorkTypes.map(n => [n.code, n])), [nonWorkTypes]);

  // Returns array of segments: [{hours, team, nonWork, nonWorkHours}, ...]
  const getEntry = useCallback((staffId, dateStr) => {
    const raw = entries[`${staffId}_${dateStr}`];
    if (!raw) return [{ hours: 0, team: staff.find(s => s.id === staffId)?.team || "", nonWork: "", nonWorkHours: 0 }];
    // migrate old single-object format
    const arr = Array.isArray(raw) ? raw : [raw];
    // Sanitise: ensure hours/nonWorkHours are never NaN
    return arr.map(e => ({
      ...e,
      hours: isNaN(Number(e.hours)) ? 0 : (Number(e.hours) || 0),
      nonWorkHours: isNaN(Number(e.nonWorkHours)) ? 0 : (Number(e.nonWorkHours) || 0),
    }));
  }, [entries, staff]);

  // Replace full segment array for a person-day
  const setEntrySegments = useCallback((staffId, dateStr, segments) => {
    const key = `${staffId}_${dateStr}`;
    const next = { ...entries, [key]: segments };
    updateEntries(next);
  }, [entries, updateEntries]);

  // Legacy compat: update a single field on first segment (used by bulk upload)
  const setEntry = useCallback((staffId, dateStr, field, value) => {
    const segs = getEntry(staffId, dateStr);
    const next = { ...entries, [`${staffId}_${dateStr}`]: [{ ...segs[0], [field]: value }, ...segs.slice(1)] };
    updateEntries(next);
  }, [entries, getEntry, updateEntries]);

  const getDailyStats = useCallback((dateStr) =>
    dailyStats[dateStr] || { census:{ Rehab:0, Peds:0, Acute:0 } }, [dailyStats]);

  const setDailyStat = useCallback((dateStr, field, value) => {
    const next = { ...dailyStats, [dateStr]: { ...getDailyStats(dateStr), [field]: value } };
    updateDailyStats(next);
  }, [dailyStats, getDailyStats, updateDailyStats]);

  const setHoliday = useCallback((dateStr, isHoliday) => {
    const nextStats = { ...dailyStats, [dateStr]: { ...getDailyStats(dateStr), holiday: isHoliday } };
    updateDailyStats(nextStats);
    if (isHoliday) {
      const nextEntries = { ...entries };
      staff.forEach(s => { delete nextEntries[`${s.id}_${dateStr}`]; });
      updateEntries(nextEntries);
    }
  }, [dailyStats, getDailyStats, updateDailyStats, entries, staff, updateEntries]);

  const getDayFTE = useCallback((dateStr) => {
    let total = 0; const teamFTE = {}; TEAMS.forEach(t => teamFTE[t] = 0);
    staff.forEach(s => {
      const segs = getEntry(s.id, dateStr);
      segs.forEach(e => {
        const hrs = Number(e.hours) || 0; const fte = hrs / 8;
        total += fte; const team = e.team || s.team; teamFTE[team] = (teamFTE[team] || 0) + fte;
      });
    });
    return { total: total.toFixed(2), byTeam: teamFTE };
  }, [staff, getEntry]);

  const ptoAlerts = useMemo(() => {
    const alerts = [];
    staff.forEach(s => {
      const balance = ptoBalances[s.id] || {};
      const used = {};
      Object.entries(entries).forEach(([key, val]) => {
        if (!key.startsWith(s.id + "_")) return;
        const segs = Array.isArray(val) ? val : (val ? [val] : []);
        segs.forEach(e => {
          if (e.nonWork) {
            const hrs = Number(e.nonWorkHours) || Number(e.hours) || 8;
            used[e.nonWork] = (used[e.nonWork] || 0) + hrs;
          }
        });
      });
      Object.entries(balance).forEach(([code, limit]) => {
        if (!limit || limit <= 0) return;
        const usedHrs = used[code] || 0;
        if (usedHrs > limit) {
          alerts.push({ staffId:s.id, staffName:s.name, team:s.team, code, usedHrs, limit, overBy:usedHrs-limit, severity:"red" });
        } else if (usedHrs >= limit * 0.9) {
          alerts.push({ staffId:s.id, staffName:s.name, team:s.team, code, usedHrs, limit, overBy:0, severity:"amber" });
        }
      });
    });
    return alerts.sort((a,b) => (b.severity==="red"?1:0)-(a.severity==="red"?1:0) || a.staffName.localeCompare(b.staffName));
  }, [staff, entries, ptoBalances]);

  const getDayAlerts = useCallback((dateStr) => {
    const alerts = [];
    const fte = getDayFTE(dateStr);
    const dow = new Date(dateStr + "T12:00:00").getDay(); // 0=Sun
    TEAMS.forEach(t => {
      const targets = alertSettings.fteTargets[t];
      // Support both old flat number format and new per-day object
      const target = targets && typeof targets === "object" ? (targets[dow] ?? 0) : (targets || 0);
      if (target > 0 && (fte.byTeam[t] || 0) < target) {
        const severity = (fte.byTeam[t]||0) < target * 0.5 ? "red" : "amber";
        alerts.push({ type:"fte", team:t, msg:`${t} FTE ${(fte.byTeam[t]||0).toFixed(1)} < target ${target}`, severity, target, actual: fte.byTeam[t]||0 });
      }
    });
    return alerts;
  }, [getDayFTE, alertSettings]);

  const weeklyMetrics = useMemo(() => {
    const m = { totalShifts:0, totalHours:0, nonWork:{} };
    nonWorkTypes.forEach(t => m.nonWork[t.code] = 0);
    weekDates.forEach(date => {
      const ds = fmt(date);
      staff.forEach(s => {
        const segs = getEntry(s.id, ds);
        segs.forEach(e => {
          m.totalHours += Number(e.hours) || 0;
          if (e.nonWork) m.nonWork[e.nonWork] = (m.nonWork[e.nonWork] || 0) + (Number(e.nonWorkHours) || 8);
        });
      });
    });
    m.totalShifts = Math.round(m.totalHours / 8); return m;
  }, [entries, weekDates, staff, nonWorkTypes, getEntry]);

  const prevWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate()-7); setWeekStart(d); };
  const nextWeek = () => { const d = new Date(weekStart); d.setDate(d.getDate()+7); setWeekStart(d); };
  const weekLabel = `${weekDates[0].toLocaleDateString("en-US",{month:"short",day:"numeric"})} - ${weekDates[6].toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}`;

  // Excel export via SheetJS
  const exportToExcel = () => {
    const XLSX = xlsxRef.current || window.XLSX;
    if (!XLSX) { alert("Excel library not loaded yet — please wait a moment and try again."); return; }
    const wb = XLSX.utils.book_new();

    // Weekly sheet
    const weekRows = [["Staff","Team",...weekDates.map(d=>d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}))]];
    filteredStaff.forEach(s => {
      const row = [s.name, s.team];
      weekDates.forEach(date => {
        const e = getEntry(s.id, fmt(date));
        const hrs = Number(e.hours)||0;
        row.push(hrs > 0 ? (e.nonWork ? `${hrs}h / ${e.nonWork}` : `${hrs}h`) : (e.nonWork || ""));
      });
      weekRows.push(row);
    });
    weekRows.push([]);
    weekRows.push(["","Total FTE",...weekDates.map(d=>getDayFTE(fmt(d)).total)]);
    TEAMS.forEach(team => weekRows.push([`${team} FTE`,"",...weekDates.map(d=>(getDayFTE(fmt(d)).byTeam[team]||0).toFixed(2))]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(weekRows), "Week View");

    // Year summary sheet
    const yearDays = getDaysInYear(yearView);
    const yearRows = [["Date","Day","Total FTE","Rehab FTE","Peds FTE","Acute FTE","Total Shifts"]];
    yearDays.forEach(date => {
      const ds = fmt(date); const fte = getDayFTE(ds);
      yearRows.push([ds, date.toLocaleDateString("en-US",{weekday:"short"}),
        fte.total, ...(TEAMS.map(t=>(fte.byTeam[t]||0).toFixed(2))),
        Math.round(Number(fte.total))]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(yearRows), `Year ${yearView}`);

    // Staff roster sheet
    const rosterRows = [["Name","Team","FTE","Default Hrs/Day"]];
    staff.forEach(s => rosterRows.push([s.name, s.team, s.fte, s.defaultHours]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rosterRows), "Staff Roster");

    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
    const uri = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + wbout;
    const a = document.createElement("a");
    a.setAttribute("href", uri);
    a.setAttribute("download", `StaffPlan_Export_${new Date().toISOString().split("T")[0]}.xlsx`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Full data backup to Excel
  const exportBackup = () => {
    const XLSX = xlsxRef.current || window.XLSX;
    if (!XLSX) { alert("Excel library not loaded yet — please wait a moment and try again."); return; }
    const wb = XLSX.utils.book_new();

    // Sheet 1: Staff
    const staffRows = [["id","name","team","fte","defaultHours","shiftStart","shiftEnd","defaultSchedule"]];
    staff.forEach(s => staffRows.push([
      s.id, s.name, s.team, s.fte, s.defaultHours,
      s.shiftStart||"08:00", s.shiftEnd||"16:00",
      JSON.stringify(s.defaultSchedule||[])
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(staffRows), "Staff");

    // Sheet 2: Entries (one row per staff-day)
    const entryRows = [["staffId","date","segments"]];
    Object.entries(entries).forEach(([key, val]) => {
      const [staffId, date] = key.split("_");
      entryRows.push([Number(staffId), date, JSON.stringify(Array.isArray(val)?val:[val])]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(entryRows), "Entries");

    // Sheet 3: Daily Stats (census + holidays)
    const statsRows = [["date","data"]];
    Object.entries(dailyStats).forEach(([date, val]) => {
      statsRows.push([date, JSON.stringify(val)]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(statsRows), "DailyStats");

    // Sheet 4: PTO Balances
    const ptoRows = [["staffId","code","hours"]];
    Object.entries(ptoBalances).forEach(([staffId, codes]) => {
      Object.entries(codes).forEach(([code, hrs]) => {
        ptoRows.push([Number(staffId), code, hrs]);
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ptoRows), "PTO_Balances");

    // Sheet 5: Non-Work Codes
    const nwRows = [["code","label","color"]];
    nonWorkTypes.forEach(n => nwRows.push([n.code, n.label, n.color]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(nwRows), "NonWorkCodes");

    // Sheet 6: Alert Settings
    const alertRows = [["type","team","key","value"]];
    Object.entries(alertSettings.fteTargets||{}).forEach(([team, val]) => {
      if (typeof val === "object") {
        Object.entries(val).forEach(([day, v]) => alertRows.push(["fte", team, day, v]));
      } else {
        alertRows.push(["fte", team, "all", val]);
      }
    });
    Object.entries(alertSettings.censusTargets||{}).forEach(([team, val]) => {
      alertRows.push(["census", team, "target", val]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(alertRows), "AlertSettings");

    // Sheet 7: Day Notes
    const notesRows = [["date","note"]];
    Object.entries(dayNotes).forEach(([date, note]) => notesRows.push([date, note]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notesRows), "DayNotes");

    // Sheet 8: Visit Data (weekly evals + visits by team)
    const visitRows = [["weekKey","weekStart","team","evals","visits"]];
    Object.entries(visitData).forEach(([key, rec]) => {
      TEAMS.forEach(t => {
        visitRows.push([key, rec.weekStart||"", t, rec[t]?.evals||0, rec[t]?.visits||0]);
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(visitRows), "VisitData");

    // Sheet 9: Meta (version info for restore validation)
    const metaRows = [["key","value"],["version","2"],["exported",new Date().toISOString()],["staffCount",staff.length],["entryCount",Object.keys(entries).length],["visitWeeks",Object.keys(visitData).length]];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metaRows), "Meta");

    const wbout = XLSX.write(wb, { bookType:"xlsx", type:"base64" });
    const uri = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + wbout;
    const a = document.createElement("a");
    a.setAttribute("href", uri);
    a.setAttribute("download", `StaffPlan_BACKUP_${new Date().toISOString().split("T")[0]}.xlsx`);
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  // Generate a data snapshot — copies app JSX with current data baked in
  const generateSnapshot = () => {
    const snapshot = {
      "staffplan:staff": JSON.stringify(staff),
      "staffplan:entries": JSON.stringify(entries),
      "staffplan:dailyStats": JSON.stringify(dailyStats),
      "staffplan:nonWorkTypes": JSON.stringify(nonWorkTypes),
    };
    const snapshotLine = `var PRELOADED_DATA = ${JSON.stringify(snapshot)};`;
    const msg = [
      "📋 PUBLISH SNAPSHOT INSTRUCTIONS",
      "",
      "To publish with your staff data baked in:",
      "",
      "1. Go back to Claude and say:",
      '   "Update the published app — replace the PRELOADED_DATA line with this:"',
      "",
      snapshotLine.slice(0, 120) + "...",
      "",
      "2. Claude will update the JSX file with your data embedded.",
      "3. Re-publish the updated artifact.",
      "",
      "Your data snapshot has been copied to clipboard (if allowed)."
    ].join("\n");
    navigator.clipboard.writeText(snapshotLine).catch(() => {});
    alert(msg);
  };

  // Nav helper
  const VIEW_TABS = [
    { id:"day",     icon:"☀️", label:"Day"     },
    { id:"grid",    icon:"📅", label:"Week"    },
    { id:"month",   icon:"🗓", label:"Month"   },
    { id:"year",    icon:"📆", label:"Year"    },
    { id:"summary", icon:"📊", label:"Dept Stats" },
    { id:"visits",  icon:"📈", label:"Visits"  },
  ];

  // Day nav helpers
  const prevDay = () => { const d=new Date(dayView); d.setDate(d.getDate()-1); setDayView(d); };
  const nextDay = () => { const d=new Date(dayView); d.setDate(d.getDate()+1); setDayView(d); };
  // Month nav helpers
  const prevMonth = () => setMonthView(m => { const mo=m.month-1; return mo<0?{year:m.year-1,month:11}:{year:m.year,month:mo}; });
  const nextMonth = () => setMonthView(m => { const mo=m.month+1; return mo>11?{year:m.year+1,month:0}:{year:m.year,month:mo}; });

  const todayStr = fmt(new Date());

  // Ctrl+Z / Cmd+Z undo
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo]);

  // Early returns AFTER all hooks
  if (!loaded) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#f0f4f8",fontFamily:"system-ui"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:12}}>⏳</div>
        <div style={{fontSize:16,fontWeight:700,color:"#1e3a5f"}}>Loading your staffing data...</div>
      </div>
    </div>
  );

  if (!unlocked) return (
    <LockScreen onUnlock={() => setUnlocked(true)} />
  );

  return (
    <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",background:"#f0f4f8",minHeight:"100vh",}}>
      <style>{`
        .comment-tip:hover .comment-tip-box { display:block !important; }
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width:6px; height:6px; }
        ::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:3px; }
        input:focus, select:focus { outline:2px solid #3b82f6; outline-offset:1px; }
        .cell-btn:hover { background:#eff6ff !important; }
        .hov:hover { opacity:0.85; }
        .menu-item:hover { background:#f1f5f9 !important; }
      `}</style>

      {/* ── Header ── */}
      <div style={{background:"#1e3a5f",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:"0 4px 20px rgba(30,58,95,0.3)",gap:10,flexWrap:"wrap"}}>
        {/* Logo */}
        <div style={{flexShrink:0}}>
          <div style={{fontSize:19,fontWeight:800,color:"#fff",letterSpacing:"-0.02em"}}>StaffPlan</div>
          <div style={{fontSize:10,color:"#93c5fd"}}>Department Staffing &amp; Planning</div>
        </div>

        {/* View tabs — always visible */}
        <div style={{display:"flex",gap:3,background:"rgba(255,255,255,0.08)",borderRadius:10,padding:3,flexWrap:"wrap"}}>
          {VIEW_TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              padding:"5px 12px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",border:"none",
              background:activeTab===tab.id?"#fff":"transparent",
              color:activeTab===tab.id?"#1e3a5f":"#93c5fd",
              boxShadow:activeTab===tab.id?"0 1px 4px rgba(0,0,0,0.15)":"none",
              transition:"all 0.15s"
            }}>
              <span style={{marginRight:4}}>{tab.icon}</span>{tab.label}
            </button>
          ))}
        </div>

        {/* Right controls */}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <SaveBadge status={saveStatus} />
          <button onClick={undo} disabled={!canUndo} title="Undo last change (Ctrl+Z)"
            style={{padding:"5px 11px",borderRadius:8,fontSize:13,fontWeight:700,cursor:canUndo?"pointer":"not-allowed",
              border:"1px solid rgba(255,255,255,0.2)",
              background:canUndo?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.05)",
              color:canUndo?"#fff":"rgba(255,255,255,0.25)",
              transition:"all 0.15s"}} >
            ↩ Undo
          </button>

          {/* ⋯ Menu */}
          <div style={{position:"relative"}} ref={menuRef}>
            <button onClick={() => setMenuOpen(o => !o)} style={{
              padding:"6px 14px",borderRadius:8,background:menuOpen?"#fff":"rgba(255,255,255,0.12)",
              border:"1px solid rgba(255,255,255,0.2)",color:menuOpen?"#1e3a5f":"#e2e8f0",
              cursor:"pointer",fontSize:13,fontWeight:700
            }}>☰ Menu</button>
            {menuOpen && (
              <div onClick={() => setMenuOpen(false)} style={{
                position:"absolute",right:0,top:"calc(100% + 6px)",background:"#fff",borderRadius:12,
                boxShadow:"0 8px 32px rgba(0,0,0,0.18)",border:"1px solid #e5e7eb",minWidth:300,zIndex:500,
                padding:"6px 0",overflow:"hidden"
              }}>
                {[
                  { icon:"👥", label:"Staff",              color:"#1e3a5f", action:()=>setShowStaffManager(true),   desc:"Add, edit, or archive staff members and manage their schedules" },
                  { icon:"📝", label:"Enter Visit Data",   color:"#0ea5e9", action:()=>setShowVisitEntry(true),     desc:"Log weekly evals and patient visits by team" },
                  { icon:"📋", label:"Batch Schedule Entry",color:"#7c3aed", action:()=>setShowBatchEntry(true),    desc:"Apply a schedule to multiple staff at once for a date range" },
                  { icon:"⬆", label:"Bulk Upload",         color:"#22c55e", action:()=>setShowUpload(true),         desc:"Import staff schedules from a CSV file" },
                  { icon:"📥", label:"Export Excel",        color:"#f59e0b", action:exportToExcel,                  desc:"Download the current week's schedule as an Excel spreadsheet" },
                  { icon:"💾", label:"Backup All Data",     color:"#0ea5e9", action:exportBackup,                   desc:"Export everything — staff, schedules, visits, settings — to Excel" },
                  { icon:"📂", label:"Restore from Backup", color:"#7c3aed", action:()=>setShowBackupRestore(true), desc:"Reload a previously exported backup file to restore all data" },
                  { icon:"📤", label:"Publish Snapshot",    color:"#0ea5e9", action:generateSnapshot,               desc:"Generate a read-only HTML file of the current schedule to share" },
                  { icon:"📦", label:`Archived Staff${staff.some(s=>s.archived)?` (${staff.filter(s=>s.archived).length})`:""}`, color:"#92400e", action:()=>setShowArchivedManager(true), desc:"View staff who have been archived — restore or permanently delete them" },
                  { icon:"⚙", label:"Non-Work Codes",      color:"#8b5cf6", action:()=>setShowNonWorkEditor(true), desc:"Create and manage leave codes like VAC, SICK, PFL and their colors" },
                  { icon:"🔐", label:"Change Password",     color:"#374151", action:()=>setShowPwManager(true),     desc:"Update the password required to unlock the app" },
                  { icon:"🔒", label:"Lock Screen",         color:"#dc2626", action:()=>setUnlocked(false),         desc:"Lock the app immediately — password required to get back in" },
                ].map(item => (
                  <button key={item.label} onClick={item.action} className="menu-item" title={item.desc} style={{
                    display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 16px",
                    border:"none",background:"transparent",cursor:"pointer",textAlign:"left",fontSize:13,fontWeight:600,color:"#374151",
                    position:"relative"
                  }}>
                    <span style={{fontSize:15,width:22,textAlign:"center",flexShrink:0,color:item.color}}>{item.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600,color:"#111827"}}>{item.label}</div>
                      <div style={{fontSize:10,color:"#9ca3af",fontWeight:400,marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{item.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Sub-nav bar (context-sensitive) ── */}
      <div style={{background:"#fff",borderBottom:"1px solid #e5e7eb",padding:"8px 20px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",minHeight:46}}>
        {/* Day nav */}
        {activeTab==="day" && <>
          <button onClick={prevDay} style={navBtn}>←</button>
          <span style={{fontSize:14,fontWeight:700,color:"#1e3a5f",minWidth:220}}>
            {new Date(dayView.getTime()+43200000).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
          </span>
          <button onClick={nextDay} style={navBtn}>→</button>
          <button onClick={()=>{ const d=new Date(); d.setHours(0,0,0,0); setDayView(new Date(d)); }} style={todayBtn}>Today</button>
        </>}

        {/* Week nav */}
        {activeTab==="grid" && <>
          <button onClick={prevWeek} style={navBtn}>←</button>
          <span style={{fontSize:14,fontWeight:700,color:"#1e3a5f",minWidth:180}}>{weekLabel}</span>
          <button onClick={nextWeek} style={navBtn}>→</button>
          <input type="date" value={fmt(weekStart)}
            onChange={e => { if(e.target.value) setWeekStart(startOfWeek(new Date(e.target.value+"T12:00:00"))); }}
            style={{padding:"4px 8px",borderRadius:8,border:"1px solid #bfdbfe",fontSize:12,fontWeight:600,color:"#1d4ed8",background:"#eff6ff",cursor:"pointer"}}
            title="Jump to week" />
          <button onClick={()=>{ const t=new Date(); t.setHours(0,0,0,0); setWeekStart(startOfWeek(t)); }} style={todayBtn}>Today</button>
          <button onClick={()=>setCompactMode(c=>!c)} title="Toggle compact mode" style={{...todayBtn,background:compactMode?"#1e3a5f":"#eff6ff",color:compactMode?"#fff":"#1d4ed8",border:"1px solid "+(compactMode?"#1e3a5f":"#bfdbfe")}}>
            {compactMode?"⊞ Expand":"⊟ Compact"}
          </button>
          <button onClick={()=>setShowAlertsEditor(true)} style={{...todayBtn,background:"#fff7ed",color:"#c2410c",border:"1px solid #fed7aa"}}>🔔 Alerts</button>
          <div style={{marginLeft:"auto",display:"flex",gap:5,flexWrap:"wrap"}}>
            {["All",...TEAMS].map(t=>(
              <button key={t} onClick={()=>setFilterTeam(t)} style={{
                padding:"3px 10px",borderRadius:99,fontSize:11,fontWeight:600,cursor:"pointer",
                background:filterTeam===t?(t==="All"?"#1e3a5f":TEAM_COLORS[t]?.bg):"#f9fafb",
                color:filterTeam===t?(t==="All"?"#fff":TEAM_COLORS[t]?.text):"#6b7280",
                border:"1px solid "+(filterTeam===t?"transparent":"#e5e7eb")
              }}>{t}</button>
            ))}
          </div>
        </>}

        {/* Month nav */}
        {activeTab==="month" && <>
          <button onClick={prevMonth} style={navBtn}>←</button>
          <span style={{fontSize:15,fontWeight:800,color:"#1e3a5f",minWidth:160}}>
            {new Date(monthView.year, monthView.month, 1).toLocaleDateString("en-US",{month:"long",year:"numeric"})}
          </span>
          <button onClick={nextMonth} style={navBtn}>→</button>
          <button onClick={()=>{const n=new Date();setMonthView({year:n.getFullYear(),month:n.getMonth()});}} style={todayBtn}>This Month</button>
        </>}

        {/* Year nav */}
        {activeTab==="year" && <>
          <button onClick={()=>setYearView(y=>y-1)} style={navBtn}>←</button>
          <span style={{fontSize:15,fontWeight:800,color:"#1e3a5f"}}>{yearView}</span>
          <button onClick={()=>setYearView(y=>y+1)} style={navBtn}>→</button>
          <button onClick={()=>setYearView(new Date().getFullYear())} style={todayBtn}>This Year</button>
        </>}

        {/* Weekly metrics strip inline for week view */}
        {activeTab==="grid" && <div style={{display:"flex",gap:16,marginLeft:"auto",flexWrap:"wrap"}}>
          <Metric label="Shifts" value={weeklyMetrics.totalShifts} />
          <Metric label="Hours" value={weeklyMetrics.totalHours} />
          {nonWorkTypes.map(t => weeklyMetrics.nonWork[t.code] > 0 && (
            <Metric key={t.code} label={t.label} value={weeklyMetrics.nonWork[t.code]+"h"} color={t.color} />
          ))}
        </div>}
      </div>

      {/* ── Tab content ── */}
      <div style={{padding:"16px 20px"}}>
        {activeTab==="day" && (
          <DayView date={dayView} staff={staff} getEntry={getEntry} setEntrySegments={setEntrySegments}
            getDailyStats={getDailyStats} setDailyStat={setDailyStat} setHoliday={setHoliday} getDayFTE={getDayFTE}
            nwMap={nwMap} nonWorkTypes={nonWorkTypes} filterTeam={filterTeam} setFilterTeam={setFilterTeam}
            dayNotes={dayNotes} updateDayNotes={updateDayNotes} getDayAlerts={getDayAlerts} />
        )}
        {activeTab==="grid" && (
          <WeekGrid filteredStaff={filteredStaff} weekDates={weekDates} getEntry={getEntry} getDayFTE={getDayFTE}
            nwMap={nwMap} setEditingCell={setEditingCell} setDrillDay={setDrillDay}
            editingName={editingName} setEditingName={setEditingName} tempName={tempName} setTempName={setTempName}
            updateStaff={updateStaff} staff={staff} compactMode={compactMode} getDayAlerts={getDayAlerts}
            dayNotes={dayNotes} updateDayNotes={updateDayNotes} alertSettings={alertSettings}
            getDailyStats={getDailyStats} setDailyStat={setDailyStat} setHoliday={setHoliday} todayStr={todayStr} />
        )}
        {activeTab==="month" && (
          <MonthView year={monthView.year} month={monthView.month} staff={staff} getEntry={getEntry}
            getDayFTE={getDayFTE} nwMap={nwMap} setDrillDay={setDrillDay}
            setWeekStart={setWeekStart} setActiveTab={setActiveTab} setDayView={setDayView} todayStr={todayStr}
            getDayAlerts={getDayAlerts} />
        )}
        {activeTab==="year" && (
          <YearView year={yearView} staff={staff} getEntry={getEntry} getDayFTE={getDayFTE} nwMap={nwMap}
            setWeekStart={setWeekStart} setActiveTab={setActiveTab} setDrillDay={setDrillDay} />
        )}
        {activeTab==="summary" && (
          <SummaryTab weekDates={weekDates} getEntry={getEntry} getDailyStats={getDailyStats} getDayFTE={getDayFTE} weeklyMetrics={weeklyMetrics} nonWorkTypes={nonWorkTypes} staff={staff} dailyStats={dailyStats} yearView={yearView} ptoAlerts={ptoAlerts} entries={entries} />
        )}
        {activeTab==="visits" && (
          <VisitsTab visitData={visitData} updateVisitData={updateVisitData} staff={staff} weekStart={weekStart} getDayFTE={getDayFTE} />
        )}

      </div>

      {editingCell && <CellEditor staffId={editingCell.staffId} dateStr={editingCell.dateStr} staff={staff}
        getEntry={getEntry} setEntrySegments={setEntrySegments} nwMap={nwMap} nonWorkTypes={nonWorkTypes} onClose={()=>setEditingCell(null)} getDailyStats={getDailyStats} />}
      {drillDay && <DayDrillDown date={drillDay} staff={staff} getEntry={getEntry} getDailyStats={getDailyStats}
        setDailyStat={setDailyStat} setHoliday={setHoliday} getDayFTE={getDayFTE} nwMap={nwMap} onClose={()=>setDrillDay(null)} />}
      {showStaffManager && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"flex-start",justifyContent:"center",zIndex:3000,overflowY:"auto",padding:"24px 16px"}} onClick={()=>setShowStaffManager(false)}>
          <div style={{background:"#f8fafc",borderRadius:18,width:"100%",maxWidth:1100,boxShadow:"0 25px 60px rgba(0,0,0,0.22)",marginBottom:24}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"18px 24px",borderBottom:"1px solid #e5e7eb",background:"#fff",borderRadius:"18px 18px 0 0"}}>
              <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>👥 Staff Management</div>
              <button onClick={()=>setShowStaffManager(false)} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"6px 14px",cursor:"pointer",fontWeight:700,fontSize:13}}>✕ Close</button>
            </div>
            <div style={{padding:20}}>
              <StaffTab staff={staff} updateStaff={updateStaff} entries={entries} updateEntries={updateEntries}
                weekStart={weekStart} nonWorkTypes={nonWorkTypes} ptoBalances={ptoBalances}
                updatePtoBalances={updatePtoBalances} ptoAlerts={ptoAlerts} />
            </div>
          </div>
        </div>
      )}
      {showVisitEntry && (
        <VisitEntryModal
          visitData={visitData} updateVisitData={updateVisitData}
          staff={staff} weekStart={weekStart} getDayFTE={getDayFTE}
          onClose={()=>setShowVisitEntry(false)} />
      )}
      {showArchivedManager && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={()=>setShowArchivedManager(false)}>
          <div style={{background:"#fff",borderRadius:18,padding:28,width:480,maxHeight:"70vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>📦 Archived Staff</div>
              <button onClick={()=>setShowArchivedManager(false)} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
            </div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:18}}>These staff members are hidden from all scheduling views. Restore them to make them active again, or permanently delete if no longer needed.</div>
            <div style={{display:"grid",gap:8}}>
              {staff.filter(s=>s.archived).length === 0 ? (
                <div style={{textAlign:"center",padding:"24px 0",color:"#9ca3af",fontSize:13}}>No archived staff.</div>
              ) : staff.filter(s=>s.archived).map(s => {
                const tc = TEAM_COLORS[s.team];
                return (
                  <div key={s.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:10,background:"#f9fafb",border:"1px solid #e5e7eb"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:tc?.dot,flexShrink:0}} />
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#111827"}}>{s.name}</div>
                      <div style={{fontSize:11,color:tc?.text,fontWeight:600}}>{s.team}</div>
                    </div>
                    <button onClick={()=>{ updateStaff(staff.map(x=>x.id===s.id?{...x,archived:false}:x)); }}
                      style={{padding:"5px 12px",borderRadius:7,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1d4ed8",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                      ↩ Restore
                    </button>
                    <button onClick={()=>{ if(window.confirm(`Permanently delete ${s.name}? This cannot be undone.`)) updateStaff(staff.filter(x=>x.id!==s.id)); }}
                      style={{padding:"5px 10px",borderRadius:7,background:"#fee2e2",border:"none",color:"#dc2626",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
            <button onClick={()=>setShowArchivedManager(false)} style={{marginTop:18,width:"100%",padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Close</button>
          </div>
        </div>
      )}
      {showBackupRestore && <BackupRestoreModal
        onClose={()=>setShowBackupRestore(false)}
        updateStaff={updateStaff} updateEntries={updateEntries}
        updateDailyStats={updateDailyStats} updatePtoBalances={updatePtoBalances}
        updateNonWorkTypes={updateNonWorkTypes} updateAlertSettings={updateAlertSettings}
        updateDayNotes={updateDayNotes} updateVisitData={updateVisitData} />}
      {showUpload && <BulkUploadModal staff={staff} updateStaff={updateStaff} entries={entries} updateEntries={updateEntries}
        nonWorkTypes={nonWorkTypes} onClose={()=>setShowUpload(false)} />}
      {showNonWorkEditor && <NonWorkEditor nonWorkTypes={nonWorkTypes} updateNonWorkTypes={updateNonWorkTypes} onClose={()=>setShowNonWorkEditor(false)} />}
      {showPwManager && <PasswordManager onClose={()=>setShowPwManager(false)} />}
      {showAlertsEditor && <AlertsEditor alertSettings={alertSettings} updateAlertSettings={updateAlertSettings} onClose={()=>setShowAlertsEditor(false)} />}
      {showBatchEntry && <BatchEntryModal staff={staff} entries={entries} updateEntries={updateEntries} nonWorkTypes={nonWorkTypes} onClose={()=>setShowBatchEntry(false)} />}
      {menuOpen && <div style={{position:"fixed",inset:0,zIndex:499}} onClick={()=>setMenuOpen(false)} />}
    </div>
  );
}

// ── Shared nav button styles ──────────────────────────────────────────────────
const navBtn = { padding:"5px 12px",borderRadius:8,background:"#f1f5f9",border:"1px solid #e2e8f0",cursor:"pointer",fontSize:15,fontWeight:700,color:"#374151" };
const todayBtn = { padding:"5px 12px",borderRadius:8,background:"#eff6ff",border:"1px solid #bfdbfe",cursor:"pointer",fontSize:12,fontWeight:600,color:"#1d4ed8" };

// ─── Daily View ──────────────────────────────────────────────────────────────
function DayView({ date, staff, getEntry, setEntrySegments, getDailyStats, setDailyStat, setHoliday, getDayFTE, nwMap, nonWorkTypes, filterTeam, setFilterTeam, dayNotes, updateDayNotes, getDayAlerts }) {
  const ds = fmt(date);
  const stats = getDailyStats(ds);
  const fte = getDayFTE(ds);
  const we = isWeekend(date);
  const isToday2 = ds === fmt(new Date());
  const [nowHour, setNowHour] = useState(() => { const n = new Date(); return n.getHours() + n.getMinutes() / 60; });
  useEffect(() => {
    if (!isToday2) return;
    const tick = setInterval(() => { const n = new Date(); setNowHour(n.getHours() + n.getMinutes() / 60); }, 60000);
    return () => clearInterval(tick);
  }, [isToday2]);

  const filtered = sortByName(filterTeam === "All" ? staff : staff.filter(s => {
    // Include if home team matches
    if (s.team === filterTeam) return true;
    // Also include if they have any segment working that team today
    const segs = getEntry(s.id, ds);
    return segs.some(e => (e.team || s.team) === filterTeam && Number(e.hours) > 0);
  }));

  // Build timeline: hours 6am–10pm, show who is present in each hour block
  const HOUR_START = 6;
  const HOUR_END = 22;
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);

  // Categorise each staff member into: working | nonwork-only (out) | not scheduled
  const getStaffHours = (s) => {
    const segs = getEntry(s.id, ds);
    const totalHrs = segs.reduce((a, e) => a + (Number(e.hours) || 0), 0);
    const hasNonWork = segs.some(e => e.nonWork);
    if (totalHrs === 0 && !hasNonWork) return null;
    const start = s.shiftStart || "08:00";
    const end = s.shiftEnd || "16:00";
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    const nonWorkOnly = totalHrs === 0 && hasNonWork;
    return { startHour: sh + sm / 60, endHour: eh + em / 60, totalHrs: isNaN(totalHrs) ? 0 : totalHrs, segs, nonWorkOnly };
  };

  // Only staff with actual worked hours appear on the timeline
  const staffOnDuty = filtered.map(s => ({ s, info: getStaffHours(s) })).filter(x => x.info && !x.info.nonWorkOnly);
  // Staff with non-work codes but no worked hours
  const staffOut = filtered.map(s => ({ s, info: getStaffHours(s) })).filter(x => x.info && x.info.nonWorkOnly);
  // Staff with no entry at all
  const notScheduled = filtered.filter(s => !getStaffHours(s));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Holiday banner */}
      {stats.holiday && (
        <div style={{padding:"10px 16px",borderRadius:10,background:"#ede9fe",border:"1px solid #c4b5fd",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:700,color:"#7c3aed"}}>
            ⛱ Holiday — staff are not scheduled by default. Manually enter anyone working holiday hours below.
          </div>
          <button onClick={()=>setDailyStat(ds,"holiday",false)} style={{fontSize:11,padding:"3px 10px",borderRadius:6,background:"#7c3aed",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,flexShrink:0}}>Remove Holiday</button>
        </div>
      )}

      {/* Alerts */}
      {getDayAlerts && getDayAlerts(ds).map((a,i) => (
        <div key={i} style={{padding:"8px 14px",borderRadius:9,background:a.severity==="red"?"#fef2f2":"#fffbeb",border:"1px solid "+(a.severity==="red"?"#fca5a5":"#fde68a"),display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:600,color:a.severity==="red"?"#dc2626":"#d97706"}}>
          {a.severity==="red"?"🔴":"🟡"} {a.msg}
        </div>
      ))}

      {/* Day note */}
      <div style={{display:"flex",alignItems:"center",gap:8,background:"#fff",border:"1px solid #e5e7eb",borderRadius:10,padding:"8px 14px"}}>
        <span style={{fontSize:14}}>📝</span>
        <input
          value={dayNotes?.[ds]||""}
          onChange={e => updateDayNotes && updateDayNotes({...dayNotes,[ds]:e.target.value})}
          placeholder="Add a note for today (e.g. short-staffed due to training, holiday coverage...)"
          style={{flex:1,border:"none",outline:"none",fontSize:12,color:"#374151",background:"transparent"}}
        />
      </div>

      {/* Day summary cards — Total FTE + one card per team with FTE & census aligned */}
      <div style={{ display: "grid", gridTemplateColumns: "160px repeat(" + TEAMS.length + ", 1fr)", gap: 10 }}>

        {/* Total FTE card */}
        <div style={{ background: we ? "#faf5ff" : "#fff", border: "1px solid " + (we ? "#e9d5ff" : "#e5e7eb"), borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Total FTE</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#1e3a5f", lineHeight: 1 }}>{fte.total}</div>
          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 6 }}>{staffOnDuty.length} staff on duty</div>
        </div>

        {/* Per-team cards: FTE + census in one aligned card */}
        {TEAMS.map(t => {
          const tc = TEAM_COLORS[t];
          const teamFTE = (fte.byTeam[t] || 0).toFixed(2);
          const census = Number(stats.census?.[t]) || 0;
          const teamStaffCount = staff.filter(s => {
            const segs = getEntry(s.id, ds);
            return segs.some(e => (e.team || s.team) === t && Number(e.hours) > 0);
          }).length;
          const ptsPerFTE = census > 0 && fte.byTeam[t] > 0 ? (census / fte.byTeam[t]).toFixed(1) : "—";
          const ptsPerStaff = census > 0 && teamStaffCount > 0 ? (census / teamStaffCount).toFixed(1) : "—";
          return (
            <div key={t} style={{ background: tc.bg, border: "1px solid " + tc.dot + "44", borderRadius: 12, padding: "14px 16px" }}>
              {/* Team label */}
              <div style={{ fontSize: 11, fontWeight: 800, color: tc.text, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>{t}</div>

              {/* Two-column: FTE | Census */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                {/* FTE */}
                <div style={{ background: "rgba(255,255,255,0.5)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 9, color: tc.text + "99", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>FTE</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: tc.text, lineHeight: 1 }}>{teamFTE}</div>
                  <div style={{ fontSize: 9, color: tc.text + "88", marginTop: 2 }}>{teamStaffCount} staff</div>
                </div>
                {/* Census */}
                <div style={{ background: "rgba(255,255,255,0.5)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 9, color: tc.text + "99", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Census</div>
                  <input
                    type="number" min="0"
                    value={stats.census?.[t] || ""}
                    onChange={e => setDailyStat(ds, "census", { ...stats.census, [t]: e.target.value === "" ? 0 : Number(e.target.value) })}
                    style={{ width: "100%", border: "none", borderRadius: 4, padding: "0", fontSize: 22, fontWeight: 800, color: tc.text, background: "transparent", lineHeight: 1 }}
                    placeholder="0"
                  />
                  <div style={{ fontSize: 9, color: tc.text + "88", marginTop: 2 }}>patients</div>
                </div>
              </div>

              {/* Ratio row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, borderTop: "1px solid " + tc.dot + "22", paddingTop: 8 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: tc.text + "88", fontWeight: 600 }}>pts / FTE</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: tc.text }}>{ptsPerFTE}</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: tc.text + "88", fontWeight: 600 }}>pts / staff</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: tc.text }}>{ptsPerStaff}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Team filter */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {["All", ...TEAMS].map(t => (
          <button key={t} onClick={() => setFilterTeam(t)} style={{
            padding: "3px 12px", borderRadius: 99, fontSize: 11, fontWeight: 600, cursor: "pointer",
            background: filterTeam === t ? (t === "All" ? "#1e3a5f" : TEAM_COLORS[t]?.bg) : "#f9fafb",
            color: filterTeam === t ? (t === "All" ? "#fff" : TEAM_COLORS[t]?.text) : "#6b7280",
            border: "1px solid " + (filterTeam === t ? "transparent" : "#e5e7eb")
          }}>{t}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 14 }}>
        {/* Timeline */}
        <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6", fontSize: 13, fontWeight: 700, color: "#1e3a5f" }}>
            Timeline — {staffOnDuty.length} staff on duty
          </div>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 600, padding: "0 16px 16px" }}>
              {/* Hour labels */}
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 0, marginBottom: 4 }}>
                <div />
                <div style={{ display: "flex" }}>
                  {hours.map(h => (
                    <div key={h} style={{ flex: 1, fontSize: 9, color: "#9ca3af", textAlign: "center", fontWeight: 600 }}>
                      {h === 12 ? "12p" : h > 12 ? `${h-12}p` : `${h}a`}
                    </div>
                  ))}
                </div>
              </div>
              {/* Staff rows + current-time overlay */}
              <div style={{ position: "relative" }}>
                {isToday2 && nowHour >= HOUR_START && nowHour <= HOUR_END && (() => {
                  const pct = ((nowHour - HOUR_START) / (HOUR_END - HOUR_START)) * 100;
                  const n = new Date();
                  const label = fmtTime(`${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`);
                  return (
                    <div style={{ position:"absolute", top:0, bottom:0, left:0, right:0, pointerEvents:"none", zIndex:10, display:"grid", gridTemplateColumns:"140px 1fr" }}>
                      <div />{/* spacer matching name column */}
                      <div style={{ position:"relative" }}>
                        <div style={{ position:"absolute", top:0, bottom:0, left:`${pct}%`, width:2, background:"#ef4444" }}>
                          <div style={{ position:"absolute", top:-18, left:"50%", transform:"translateX(-50%)", background:"#ef4444", color:"#fff", fontSize:9, fontWeight:700, padding:"2px 5px", borderRadius:4, whiteSpace:"nowrap" }}>{label}</div>
                          <div style={{ position:"absolute", top:0, left:"50%", transform:"translateX(-50%) translateY(-50%)", width:8, height:8, borderRadius:"50%", background:"#ef4444" }} />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              {staffOnDuty.map(({ s, info }) => {
                const tc = TEAM_COLORS[s.team];
                const totalCols = HOUR_END - HOUR_START;
                const startPct = Math.max(0, (info.startHour - HOUR_START) / totalCols) * 100;
                const widthPct = Math.min(100 - startPct, (info.endHour - Math.max(info.startHour, HOUR_START)) / totalCols * 100);
                const nwSegs = info.segs.filter(e => e.nonWork);
                return (
                  <div key={s.id} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 0, marginBottom: 4, alignItems: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", paddingRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: tc?.dot, marginRight: 5 }} />
                      {s.name}
                    </div>
                    <div style={{ position: "relative", height: 24, background: "#f8fafc", borderRadius: 6 }}>
                      {/* Hour grid lines */}
                      {hours.map((h, i) => (
                        <div key={h} style={{ position: "absolute", left: `${(i / totalCols) * 100}%`, top: 0, bottom: 0, width: 1, background: "#f1f5f9" }} />
                      ))}
                      {/* Shift bar */}
                      <div style={{
                        position: "absolute", left: `${startPct}%`, width: `${widthPct}%`,
                        top: 3, bottom: 3, borderRadius: 4,
                        background: nwSegs.length > 0 ? nwSegs[0] && nwMap[nwSegs[0].nonWork]?.color + "88" || tc?.dot + "88" : tc?.dot + "cc",
                        display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden"
                      }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", padding: "0 4px" }}>
                          {info.totalHrs}h
                          {info.segs.length > 1 && " split"}
                          {nwSegs.length > 0 && " · " + nwSegs[0].nonWork}
                        </span>
                      </div>
                      {/* Team split segments */}
                      {info.segs.length > 1 && (() => {
                        let cursor = info.startHour;
                        return info.segs.map((seg, si) => {
                          const segHrs = Number(seg.hours) || 0;
                          const segStart = cursor;
                          cursor += segHrs;
                          const tc2 = TEAM_COLORS[seg.team || s.team];
                          const sp = Math.max(0, (segStart - HOUR_START) / totalCols) * 100;
                          const sw = (segHrs / totalCols) * 100;
                          return <div key={si} style={{
                            position: "absolute", left: `${sp}%`, width: `${sw}%`,
                            top: 3, bottom: 3, borderRadius: 3,
                            background: tc2?.dot + "dd", border: "1px solid " + tc2?.dot,
                            display: "flex", alignItems: "center", justifyContent: "center"
                          }}>
                            <span style={{ fontSize: 8, color: "#fff", fontWeight: 700, padding: "0 2px", whiteSpace: "nowrap" }}>{seg.team?.split(" ")[0]}</span>
                          </div>;
                        });
                      })()}
                    </div>
                  </div>
                );
              })}
              {staffOnDuty.length === 0 && (
                <div style={{ padding: "24px", textAlign: "center", color: "#9ca3af", fontSize: 13 }}>No staff scheduled for this day</div>
              )}
              </div>
            </div>
          </div>
        </div>

        {/* Staff roster panel */}
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", fontSize: 12, fontWeight: 700, color: "#15803d" }}>
              ✓ On Duty ({staffOnDuty.length})
            </div>
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {staffOnDuty.map(({ s, info }) => {
                const tc = TEAM_COLORS[s.team];
                return (
                  <div key={s.id} style={{ padding: "7px 14px", borderBottom: "1px solid #f9fafb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: tc?.dot }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{s.name}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#1e3a5f" }}>{info.totalHrs}h</span>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 99, background: tc?.bg, color: tc?.text, fontWeight: 600 }}>{s.team}</span>
                    </div>
                  </div>
                );
              })}
              {staffOnDuty.length === 0 && <div style={{ padding: 14, fontSize: 12, color: "#9ca3af" }}>None scheduled</div>}
            </div>
          </div>

          {staffOut.length > 0 && (
            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #fde68a", overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: "1px solid #fef9c3", fontSize: 12, fontWeight: 700, color: "#d97706" }}>
                ⚠ Out / Leave ({staffOut.length})
              </div>
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                {staffOut.map(({ s, info }) => {
                  const tc = TEAM_COLORS[s.team];
                  const nwSegs = info.segs.filter(e => e.nonWork);
                  return (
                    <div key={s.id} style={{ padding: "7px 14px", borderBottom: "1px solid #fffbeb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: tc?.dot + "88" }} />
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{s.name}</span>
                      </div>
                      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {nwSegs.map((e, i) => {
                          const nwInfo = nwMap[e.nonWork];
                          return nwInfo ? (
                            <span key={i} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 99, background: nwInfo.color + "22", color: nwInfo.color, fontWeight: 700 }}>
                              {Number(e.nonWorkHours) || 8}h {nwInfo.code}
                            </span>
                          ) : null;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", fontSize: 12, fontWeight: 700, color: "#9ca3af" }}>
              ○ Not Scheduled ({notScheduled.length})
            </div>
            <div style={{ maxHeight: 130, overflowY: "auto" }}>
              {notScheduled.map(s => (
                <div key={s.id} style={{ padding: "6px 14px", borderBottom: "1px solid #f9fafb", fontSize: 11, color: "#9ca3af" }}>
                  <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: TEAM_COLORS[s.team]?.dot + "66", marginRight: 6 }} />
                  {s.name}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Monthly View ─────────────────────────────────────────────────────────────
function MonthView({ year, month, staff, getEntry, getDayFTE, nwMap, setDrillDay, setWeekStart, setActiveTab, setDayView, todayStr, getDayAlerts }) {
  const [hovered, setHovered] = useState(null);

  // Get all days in this month
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay(); // 0=Sun
  const daysInMonth = lastDay.getDate();
  const cells = Array.from({ length: startPad + daysInMonth }, (_, i) => {
    if (i < startPad) return null;
    return new Date(year, month, i - startPad + 1);
  });

  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const getDayData = (date) => {
    if (!date) return null;
    const ds = fmt(date);
    const fte = getDayFTE(ds);
    const staffOn = staff.filter(s => {
      const segs = getEntry(s.id, ds);
      return segs.some(e => Number(e.hours) > 0 || e.nonWork);
    });
    const nonWorkCount = staff.reduce((a, s) => {
      const segs = getEntry(s.id, ds);
      return a + segs.filter(e => e.nonWork).length;
    }, 0);
    return { ds, fte, staffOn, nonWorkCount };
  };

  const maxFTE = staff.length * 0.5 || 1;

  const getFTEColor = (fteVal) => {
    if (!fteVal || fteVal === 0) return "#f9fafb";
    const pct = Math.min(Number(fteVal) / maxFTE, 1);
    const r = Math.round(219 - pct * 150);
    const g = Math.round(234 - pct * 80);
    const b = Math.round(254 - pct * 100);
    return `rgb(${r},${g},${b})`;
  };

  return (
    <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e5e7eb", overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
      {/* Day-of-week headers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", background: "#f8fafc", borderBottom: "2px solid #e5e7eb" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
          <div key={d} style={{ padding: "10px 0", textAlign: "center", fontSize: 11, fontWeight: 700, color: i === 0 || i === 6 ? "#7c3aed" : "#374151", textTransform: "uppercase", letterSpacing: "0.05em" }}>{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      {weeks.map((week, wi) => (
        <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderBottom: wi < weeks.length - 1 ? "1px solid #f3f4f6" : "none" }}>
          {week.map((date, di) => {
            if (!date) return <div key={di} style={{ background: "#fafafa", minHeight: 110 }} />;
            const data = getDayData(date);
            const isToday = data.ds === todayStr;
            const we = di === 0 || di === 6;
            const isHov = hovered === data.ds;

            return (
              <div key={di}
                onMouseEnter={() => setHovered(data.ds)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  minHeight: 110, padding: "8px 10px", cursor: "pointer",
                  background: isHov ? "#f0f9ff" : isToday ? "#fefce8" : we ? "#faf5ff" : getFTEColor(data.fte.total),
                  borderLeft: di > 0 ? "1px solid #f3f4f6" : "none",
                  transition: "background 0.1s",
                  position: "relative"
                }}
                onClick={() => {
                  setDayView(new Date(date)); setActiveTab("day");
                }}
              >
                {/* Date number */}
                <div style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, borderRadius: "50%",
                  background: isToday ? "#eab308" : "transparent",
                  color: isToday ? "#fff" : we ? "#7c3aed" : "#374151",
                  boxShadow: isToday ? "0 0 0 3px #fef08a" : "none",
                  fontSize: 13, fontWeight: isToday ? 800 : 600, marginBottom: 4
                }}>{date.getDate()}</div>

                {/* FTE badge + alert indicator */}
                {Number(data.fte.total) > 0 && (() => {
                  const alerts = getDayAlerts ? getDayAlerts(data.ds) : [];
                  const hasRed   = alerts.some(a=>a.severity==="red");
                  const hasAmber = alerts.some(a=>a.severity==="amber");
                  const alertColor = hasRed ? "#dc2626" : hasAmber ? "#d97706" : null;
                  return (
                    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:3}}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: "#1e3a5f" }}>
                        {data.fte.total} FTE
                      </div>
                      {alertColor && (
                        <div title={alerts.map(a=>a.msg).join(", ")} style={{
                          display:"flex",alignItems:"center",gap:2,
                          padding:"1px 5px",borderRadius:99,
                          background:alertColor+"18",border:"1px solid "+alertColor+"55",
                          fontSize:9,fontWeight:800,color:alertColor,cursor:"default"
                        }}>
                          {hasRed?"🔴":"🟡"} {alerts.length} alert{alerts.length>1?"s":""}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Team FTE mini bars */}
                {TEAMS.map(t => {
                  const v = data.fte.byTeam[t] || 0;
                  if (v === 0) return null;
                  const tc = TEAM_COLORS[t];
                  return (
                    <div key={t} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 2 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: tc.dot, flexShrink: 0 }} />
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: "#f1f5f9" }}>
                        <div style={{ height: "100%", width: `${Math.min(v / (maxFTE * 0.3) * 100, 100)}%`, background: tc.dot, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 9, color: tc.text, fontWeight: 600, minWidth: 20 }}>{v.toFixed(1)}</span>
                    </div>
                  );
                })}

                {/* Non-work count */}
                {data.nonWorkCount > 0 && (
                  <div style={{ marginTop: 3, fontSize: 9, color: "#d97706", fontWeight: 700 }}>
                    ⚠ {data.nonWorkCount} non-work
                  </div>
                )}

                {/* Staff count */}
                <div style={{ position: "absolute", bottom: 5, right: 7, fontSize: 9, color: "#9ca3af", fontWeight: 600 }}>
                  {data.staffOn.length} staff
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* Hover tooltip */}
      {hovered && (() => {
        const date = new Date(hovered + "T12:00:00");
        const data = getDayData(date);
        if (!data) return null;
        return (
          <div style={{ position: "fixed", bottom: 24, right: 24, background: "#1e3a5f", color: "#fff", borderRadius: 12, padding: "12px 18px", boxShadow: "0 8px 30px rgba(0,0,0,0.25)", zIndex: 100, minWidth: 210 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
              {date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <div style={{ fontSize: 12, color: "#93c5fd" }}>Total FTE: <b style={{ color: "#fff" }}>{data.fte.total}</b></div>
            {TEAMS.map(t => <div key={t} style={{ fontSize: 11, color: "#93c5fd" }}>{t}: <b style={{ color: "#fff" }}>{(data.fte.byTeam[t] || 0).toFixed(2)}</b></div>)}
            <div style={{ fontSize: 11, color: "#93c5fd", marginTop: 4 }}>Staff on duty: <b style={{ color: "#fff" }}>{data.staffOn.length}</b></div>
            {data.nonWorkCount > 0 && <div style={{ fontSize: 11, color: "#fbbf24" }}>Non-work: {data.nonWorkCount}</div>}
            <div style={{ fontSize: 10, color: "#64748b", marginTop: 5 }}>Click to open Day view</div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Simple hash (not cryptographic — just obfuscation for shared link) ────────
async function hashPin(pin) {
  // Use SubtleCrypto if available, fallback to simple checksum
  if (window.crypto && window.crypto.subtle) {
    const buf = new TextEncoder().encode("staffplan:" + pin);
    const hash = await window.crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
  }
  // Simple fallback
  let h = 0;
  for (const c of "staffplan:" + pin) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return String(h);
}

// ─── Lock Screen ─────────────────────────────────────────────────────────────
function LockScreen({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const tryUnlock = async () => {
    if (!pin) return;
    setChecking(true);
    const stored = await loadFromStorage("staffplan:pwHash", null);
    if (!stored) { onUnlock(); return; }
    const hashed = await hashPin(pin);
    if (hashed === stored) {
      setError(""); onUnlock();
    } else {
      setError("Incorrect password. Please try again.");
      setPin("");
      setTimeout(() => setError(""), 3000);
    }
    setChecking(false);
  };

  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"linear-gradient(135deg,#1e3a5f 0%,#1e40af 100%)",fontFamily:"'DM Sans',system-ui,sans-serif"}}>
      <div style={{background:"#fff",borderRadius:20,padding:"40px 36px",width:360,boxShadow:"0 25px 60px rgba(0,0,0,0.3)",textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:8}}>🔒</div>
        <div style={{fontSize:22,fontWeight:800,color:"#1e3a5f",marginBottom:4}}>StaffPlan</div>
        <div style={{fontSize:13,color:"#6b7280",marginBottom:28}}>Enter your password to continue</div>

        <input
          ref={inputRef}
          type="password"
          value={pin}
          onChange={e => { setPin(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && tryUnlock()}
          placeholder="Password"
          style={{width:"100%",padding:"12px 16px",border:"2px solid "+(error?"#fca5a5":"#e5e7eb"),borderRadius:10,fontSize:16,textAlign:"center",boxSizing:"border-box",marginBottom:12,outline:"none",letterSpacing:"0.1em"}}
        />

        {error && (
          <div style={{fontSize:12,color:"#dc2626",marginBottom:12,padding:"6px 12px",background:"#fef2f2",borderRadius:7}}>{error}</div>
        )}

        <button onClick={tryUnlock} disabled={checking || !pin} style={{
          width:"100%",padding:"12px",borderRadius:10,background:pin?"#1e3a5f":"#e5e7eb",
          color:pin?"#fff":"#9ca3af",border:"none",fontSize:15,fontWeight:700,cursor:pin?"pointer":"not-allowed",
          transition:"all 0.15s"
        }}>
          {checking ? "Checking..." : "Unlock →"}
        </button>

        <div style={{marginTop:20,fontSize:11,color:"#9ca3af"}}>Department Staffing &amp; Planning</div>
      </div>
    </div>
  );
}

// ─── Password Manager ─────────────────────────────────────────────────────────
function PasswordManager({ onClose }) {
  const [mode, setMode] = useState("set"); // set | change | remove
  const [current, setCurrent] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null); // {text, type: ok|err}
  const [hasPassword, setHasPassword] = useState(null);

  useEffect(() => {
    loadFromStorage("staffplan:pwHash", null).then(h => {
      setHasPassword(!!h);
      setMode(h ? "change" : "set");
    });
  }, []);

  const showMsg = (text, type) => { setMsg({text, type}); setTimeout(() => setMsg(null), 3500); };

  const save = async () => {
    if (newPw !== confirm) { showMsg("Passwords don't match.", "err"); return; }
    if (newPw.length < 4) { showMsg("Password must be at least 4 characters.", "err"); return; }
    if (hasPassword) {
      const curHash = await hashPin(current);
      const storedHash = await loadFromStorage("staffplan:pwHash", null);
      if (curHash !== storedHash) { showMsg("Current password is incorrect.", "err"); return; }
    }
    const hash = await hashPin(newPw);
    await saveToStorage("staffplan:pwHash", hash);
    showMsg("Password saved! ✓", "ok");
    setTimeout(onClose, 1200);
  };

  const remove = async () => {
    if (hasPassword) {
      const curHash = await hashPin(current);
      const storedHash = await loadFromStorage("staffplan:pwHash", null);
      if (curHash !== storedHash) { showMsg("Current password is incorrect.", "err"); return; }
    }
    await saveToStorage("staffplan:pwHash", "");
    showMsg("Password removed. App is now open access.", "ok");
    setTimeout(onClose, 1500);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:30,width:400,boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>🔐 Password Settings</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        {hasPassword === null ? <div style={{textAlign:"center",padding:20,color:"#9ca3af"}}>Loading...</div> : (<>
          <div style={{display:"flex",gap:6,marginBottom:18}}>
            {(hasPassword ? ["change","remove"] : ["set"]).map(m => (
              <button key={m} onClick={()=>setMode(m)} style={{
                flex:1,padding:"8px",borderRadius:8,border:"1px solid "+(mode===m?"#1e3a5f":"#e5e7eb"),
                background:mode===m?"#eff6ff":"#fff",color:mode===m?"#1e3a5f":"#6b7280",
                fontWeight:700,fontSize:12,cursor:"pointer",textTransform:"capitalize"
              }}>{m === "set" ? "Set Password" : m === "change" ? "Change Password" : "Remove Password"}</button>
            ))}
          </div>

          <div style={{display:"grid",gap:12}}>
            {hasPassword && mode !== "remove" && (
              <div>
                <label style={lbl}>Current Password</label>
                <input type="password" value={current} onChange={e=>setCurrent(e.target.value)} style={inp} placeholder="Enter current password" />
              </div>
            )}
            {hasPassword && mode === "remove" && (
              <div>
                <label style={lbl}>Current Password (to confirm removal)</label>
                <input type="password" value={current} onChange={e=>setCurrent(e.target.value)} style={inp} placeholder="Enter current password" />
              </div>
            )}
            {mode !== "remove" && (<>
              <div>
                <label style={lbl}>New Password</label>
                <input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} style={inp} placeholder="At least 4 characters" />
              </div>
              <div>
                <label style={lbl}>Confirm New Password</label>
                <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&save()} style={inp} placeholder="Repeat password" />
              </div>
            </>)}
          </div>

          {msg && (
            <div style={{marginTop:12,padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:600,
              background:msg.type==="ok"?"#f0fdf4":"#fef2f2",color:msg.type==="ok"?"#15803d":"#dc2626"}}>
              {msg.text}
            </div>
          )}

          <div style={{display:"flex",gap:8,marginTop:18}}>
            <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
            <button onClick={mode==="remove"?remove:save} style={{flex:2,padding:"10px",borderRadius:10,
              background:mode==="remove"?"#dc2626":"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>
              {mode==="remove"?"Remove Password":"Save Password"}
            </button>
          </div>

          <div style={{marginTop:14,fontSize:11,color:"#9ca3af",lineHeight:1.5}}>
            Note: This password protects the app when shared as a link. It uses SHA-256 hashing stored in your session. It is not suitable for protecting highly sensitive clinical data.
          </div>
        </>)}
      </div>
    </div>
  );
}

// ─── Alerts Editor ───────────────────────────────────────────────────────────
function AlertsEditor({ alertSettings, updateAlertSettings, onClose }) {
  // Normalise fteTargets to per-day object format
  const normalise = (targets) => {
    const out = {};
    TEAMS.forEach(t => {
      const v = targets[t];
      if (v && typeof v === "object") out[t] = {...v};
      else { const n = Number(v)||0; out[t] = {0:n,1:n,2:n,3:n,4:n,5:n,6:n}; }
    });
    return out;
  };
  const [fteTargets, setFteTargets] = useState(() => normalise(alertSettings.fteTargets));
  const [censusTargets, setCensusTargets] = useState({...alertSettings.censusTargets});
  const [mode, setMode] = useState("perday"); // perday | simple
  const save = () => { updateAlertSettings({ fteTargets, censusTargets }); onClose(); };

  const setFTE = (team, day, val) => setFteTargets(prev => ({ ...prev, [team]: { ...prev[team], [day]: Number(val) } }));
  const setFTEAll = (team, val) => setFteTargets(prev => ({ ...prev, [team]: {0:Number(val),1:Number(val),2:Number(val),3:Number(val),4:Number(val),5:Number(val),6:Number(val)} }));
  const setCensus = (team, val) => setCensusTargets(prev => ({ ...prev, [team]: Number(val) }));

  const dayLabels = ["Su","Mo","Tu","We","Th","Fr","Sa"];

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:520,maxHeight:"90vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>🔔 Staffing Alert Thresholds</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:14}}>
          FTE below target shows a colored dot on that team's count. 🟡 = under target, 🔴 = under 50%.
        </div>

        {/* Mode toggle */}
        <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:8,padding:3,marginBottom:16,width:"fit-content"}}>
          {[["perday","Per Day of Week"],["simple","Same Every Day"]].map(([v,l])=>(
            <button key={v} onClick={()=>setMode(v)} style={{padding:"4px 14px",borderRadius:6,fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
              background:mode===v?"#fff":"transparent",color:mode===v?"#1e3a5f":"#6b7280",
              boxShadow:mode===v?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>{l}</button>
          ))}
        </div>

        <div style={{display:"grid",gap:14}}>
          {TEAMS.map(t => {
            const tc = TEAM_COLORS[t];
            const targets = fteTargets[t] || {};
            return (
              <div key={t} style={{padding:"14px 16px",borderRadius:10,background:tc.bg,border:"1px solid "+tc.dot+"44"}}>
                <div style={{fontSize:13,fontWeight:800,color:tc.text,marginBottom:12}}>{t}</div>

                {mode === "simple" ? (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    <div>
                      <label style={{...lbl,color:tc.text,fontSize:10}}>Min FTE (all days)</label>
                      <input type="number" min="0" step="0.5" value={targets[1]||0}
                        onChange={e=>setFTEAll(t,e.target.value)}
                        style={{...inp,background:"rgba(255,255,255,0.8)"}} />
                    </div>
                    <div>
                      <label style={{...lbl,color:tc.text,fontSize:10}}>Census Target</label>
                      <input type="number" min="0" step="1" value={censusTargets[t]||0}
                        onChange={e=>setCensus(t,e.target.value)}
                        style={{...inp,background:"rgba(255,255,255,0.8)"}} />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label style={{...lbl,color:tc.text,fontSize:10,marginBottom:6,display:"block"}}>Min FTE by Day</label>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4,marginBottom:10}}>
                      {[0,1,2,3,4,5,6].map(d => (
                        <div key={d} style={{textAlign:"center"}}>
                          <div style={{fontSize:9,fontWeight:700,color:tc.text+"99",marginBottom:3,
                            background:(d===0||d===6)?"rgba(0,0,0,0.07)":"transparent",borderRadius:3,padding:"1px 0"}}>{dayLabels[d]}</div>
                          <input type="number" min="0" step="0.5" value={targets[d]||0}
                            onChange={e=>setFTE(t,d,e.target.value)}
                            style={{width:"100%",textAlign:"center",border:"1px solid "+tc.dot+"55",borderRadius:6,
                              padding:"4px 2px",fontSize:12,fontWeight:700,color:tc.text,
                              background:(d===0||d===6)?"rgba(255,255,255,0.6)":"rgba(255,255,255,0.85)"}} />
                        </div>
                      ))}
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                      <div>
                        <label style={{...lbl,color:tc.text,fontSize:10}}>Census Target</label>
                        <input type="number" min="0" step="1" value={censusTargets[t]||0}
                          onChange={e=>setCensus(t,e.target.value)}
                          style={{...inp,background:"rgba(255,255,255,0.8)"}} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{display:"flex",gap:8,marginTop:18}}>
          <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
          <button onClick={save} style={{flex:2,padding:"10px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>Save Thresholds</button>
        </div>
      </div>
    </div>
  );
}

// ─── Save Badge ───────────────────────────────────────────────────────────────
function SaveBadge({ status }) {
  const cfg = {
    saved:   { bg:"#dcfce7", color:"#15803d", text:"✓ Saved" },
    saving:  { bg:"#fef9c3", color:"#854d0e", text:"⏳ Saving..." },
    unsaved: { bg:"#fee2e2", color:"#dc2626", text:"● Unsaved" },
  }[status];
  return <span style={{padding:"4px 10px",borderRadius:99,fontSize:11,fontWeight:700,background:cfg.bg,color:cfg.color}}>{cfg.text}</span>;
}

function HdrBtn({ onClick, color, children }) {
  return <button onClick={onClick} className="hov" style={{padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:700,background:color,color:"#fff",border:"none",cursor:"pointer"}}>{children}</button>;
}

// ─── Holiday Toggle Button (inline confirm, no window.confirm) ───────────────
function HolidayToggleBtn({ ds, isHoliday, setHoliday, setDailyStat, small }) {
  const [confirming, setConfirming] = useState(false);
  if (isHoliday) return (
    <button onClick={()=>setDailyStat(ds,"holiday",false)}
      style={{fontSize:small?9:11,padding:small?"1px 4px":"4px 12px",borderRadius:small?4:7,border:"none",background:"#7c3aed",color:"#fff",cursor:"pointer",fontWeight:700}}>
      {small?"⛱ HOL":"Remove Holiday ⛱"}
    </button>
  );
  if (confirming) return (
    <div style={{display:"flex",gap:4,alignItems:"center"}}>
      <span style={{fontSize:small?9:11,color:"#dc2626",fontWeight:600}}>Delete all entries?</span>
      <button onClick={()=>{setHoliday(ds,true);setConfirming(false);}}
        style={{fontSize:small?9:11,padding:small?"1px 6px":"3px 10px",borderRadius:5,border:"none",background:"#ef4444",color:"#fff",cursor:"pointer",fontWeight:700}}>Yes</button>
      <button onClick={()=>setConfirming(false)}
        style={{fontSize:small?9:11,padding:small?"1px 6px":"3px 10px",borderRadius:5,border:"none",background:"#9ca3af",color:"#fff",cursor:"pointer",fontWeight:700}}>No</button>
    </div>
  );
  return (
    <button onClick={()=>setConfirming(true)}
      style={{fontSize:small?9:11,padding:small?"1px 4px":"4px 12px",borderRadius:small?4:7,border:"none",background:small?"#f3f4f6":"#ede9fe",color:small?"#9ca3af":"#7c3aed",cursor:"pointer",fontWeight:700}}>
      {small?"+ HOL":"Mark as Holiday ⛱"}
    </button>
  );
}

// ─── Week Grid ────────────────────────────────────────────────────────────────
function WeekGrid({ filteredStaff, weekDates, getEntry, getDayFTE, nwMap, setEditingCell, setDrillDay, editingName, setEditingName, tempName, setTempName, updateStaff, staff, compactMode, getDayAlerts, dayNotes, updateDayNotes, alertSettings, getDailyStats, setDailyStat, setHoliday, todayStr }) {
  const [confirmHolidayDs, setConfirmHolidayDs] = useState(null);
  return (
    <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"calc(100vh - 220px)"}}>
      <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,minWidth:860}}>
        <thead style={{position:"sticky",top:0,zIndex:20}}>
          <tr>
            <th style={{...thS,minWidth:155,background:"#fff",position:"sticky",left:0,zIndex:30,textAlign:"left",paddingLeft:12}}>Staff Member</th>
            {weekDates.map((date,i) => {
              const we = isWeekend(date); const ds = fmt(date); const fte = getDayFTE(ds);
              const alerts = getDayAlerts ? getDayAlerts(ds) : [];
              const isToday = ds === todayStr;
              return (
                <th key={i} style={{...thS,background:isToday?"#fefce8":we?"#faf5ff":"#fff",minWidth:130,borderBottom:isToday?"3px solid #eab308":alerts.length?"3px solid "+(alerts[0].severity==="red"?"#ef4444":"#f59e0b"):""}}>
                  {/* Holiday toggle */}
                  {getDailyStats && (() => {
                    const isHoliday = getDailyStats(ds)?.holiday;
                    return (
                      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:1}}>
                        <div onClick={e=>e.stopPropagation()}>
                          <HolidayToggleBtn ds={ds} isHoliday={isHoliday} setHoliday={setHoliday} setDailyStat={setDailyStat} small={true} />
                        </div>
                      </div>
                    );
                  })()}
                  <button onClick={()=>setDrillDay(date)} style={{background:"none",border:"none",cursor:"pointer",padding:0,width:"100%"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                      <div style={{fontSize:10,fontWeight:700,color:we?"#7c3aed":"#9ca3af",textTransform:"uppercase"}}>{fmtDay(date)}</div>
                      {dayNotes[ds] && <span title={dayNotes[ds]} style={{fontSize:10}}>📝</span>}
                      {getDailyStats && getDailyStats(ds)?.holiday && <span style={{fontSize:10}}>⛱</span>}
                    </div>
                    <div style={{fontSize:14,fontWeight:800,color:isToday?"#854d0e":getDailyStats&&getDailyStats(ds)?.holiday?"#7c3aed":we?"#7c3aed":"#1e3a5f"}}>{fmtDisplay(date)}{isToday&&<span style={{marginLeft:4,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99,background:"#fef08a",color:"#854d0e",verticalAlign:"middle"}}>TODAY</span>}</div>
                    <div style={{marginTop:4}}>
                      {/* Total FTE */}
                      <div style={{fontSize:11,fontWeight:800,color:alerts.length?(alerts[0].severity==="red"?"#dc2626":"#d97706"):isToday?"#854d0e":"#374151",marginBottom:3}}>
                        FTE {fte.total}
                        {alerts.length>0 && <span style={{marginLeft:3}}>{alerts[0].severity==="red"?"🔴":"🟡"}</span>}
                      </div>
                      {/* Per-team FTE with alert dot */}
                      <div style={{display:"flex",gap:4,justifyContent:"center",flexWrap:"wrap"}}>
                        {["Acute","Rehab","Peds"].map(t => {
                          const tFTE = (fte.byTeam[t]||0);
                          const tc = TEAM_COLORS[t];
                          const teamAlert = alerts.find(a=>a.team===t);
                          return (
                            <span key={t} style={{fontSize:9,fontWeight:700,color:teamAlert?(teamAlert.severity==="red"?"#dc2626":"#d97706"):tc.text,
                              background:teamAlert?(teamAlert.severity==="red"?"#fee2e2":"#fef9c3"):tc.bg,
                              padding:"1px 5px",borderRadius:99,whiteSpace:"nowrap",
                              border:"1px solid "+(teamAlert?(teamAlert.severity==="red"?"#fca5a5":"#fde68a"):tc.dot+"33")}}>
                              {teamAlert && <span style={{marginRight:2}}>{teamAlert.severity==="red"?"🔴":"🟡"}</span>}
                              {t.slice(0,3)} {tFTE.toFixed(1)}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {filteredStaff.map(s => (
            <tr key={s.id}>
              <td style={{...tdS,fontWeight:600,fontSize:12,background:"#fff",position:"sticky",left:0,zIndex:5,borderBottom:"1px solid #f1f5f9",boxShadow:"2px 0 6px rgba(0,0,0,0.04)",paddingLeft:8,paddingRight:6}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:7,height:7,borderRadius:"50%",background:TEAM_COLORS[s.team]?.dot,flexShrink:0}} />
                  {editingName===s.id ? (
                    <input autoFocus value={tempName} onChange={e=>setTempName(e.target.value)}
                      onBlur={()=>{updateStaff(staff.map(x=>x.id===s.id?{...x,name:tempName||x.name}:x));setEditingName(null);}}
                      onKeyDown={e=>{if(e.key==="Enter"){updateStaff(staff.map(x=>x.id===s.id?{...x,name:tempName||x.name}:x));setEditingName(null);}}}
                      style={{fontSize:12,fontWeight:600,border:"1px solid #3b82f6",borderRadius:4,padding:"2px 5px",width:100}} />
                  ) : (
                    <span style={{cursor:"pointer",color:"#111827"}} onDoubleClick={()=>{setEditingName(s.id);setTempName(s.name);}} title="Double-click to rename">{s.name}</span>
                  )}
                </div>
                <div style={{fontSize:10,color:TEAM_COLORS[s.team]?.text,marginLeft:13}}>{s.team}</div>
              </td>
              {weekDates.map((date,di) => {
                const ds = fmt(date); const segs = getEntry(s.id,ds); const we = isWeekend(date);
                const isHoliday = getDailyStats && getDailyStats(ds)?.holiday;
                const isToday = ds === todayStr;
                const totalHrs = segs.reduce((a,e)=>a+(Number(e.hours)||0),0);
                const hasNW = segs.some(e=>e.nonWork);
                const hasComment = segs.some(e=>e.comment);
                const hasSwap = segs.some(e=>e.swap);
                const hasData = totalHrs > 0 || hasNW;
                const holBg = "#f5f3ff";
                return (
                  <td key={di} style={{...tdS,background:isHoliday?holBg:isToday?"#fffde7":we?"#fdf8ff":"#fff",borderBottom:"1px solid #f1f5f9",padding:3}}>
                    <button className="cell-btn" onClick={()=>setEditingCell({staffId:s.id,dateStr:ds})} style={{
                      width:"100%",minHeight:compactMode?30:52,borderRadius:7,cursor:"pointer",padding:compactMode?"2px 5px":"4px 5px",
                      display:"flex",flexDirection:"column",alignItems:"stretch",justifyContent:"center",gap:2,
                      border:"1px solid "+(hasData?"#dbeafe":isHoliday?"#c4b5fd":"#f1f5f9"),
                      background:hasData?"#f0f7ff":isHoliday?"#ede9fe":"transparent",transition:"all 0.1s",
                      position:"relative"
                    }}>
                      {/* Comment / swap indicators */}
                      {(hasComment||hasSwap) && (
                        <div style={{position:"absolute",top:2,right:3,display:"flex",gap:2,zIndex:5}}>
                          {hasSwap && <span style={{fontSize:9,background:"#fef9c3",borderRadius:3,padding:"0 2px",lineHeight:1.4}}>⇄</span>}
                          {hasComment && (() => {
                            const commentText = segs.filter(e=>e.comment).map(e=>e.comment).join(" · ");
                            return (
                              <span className="comment-tip" style={{fontSize:10,background:"#3b82f6",color:"#fff",borderRadius:4,padding:"1px 4px",lineHeight:1.4,fontWeight:700,cursor:"default",position:"relative"}}
                                title={commentText}>
                                💬
                                <span className="comment-tip-box" style={{
                                  display:"none",position:"absolute",bottom:"calc(100% + 5px)",right:0,
                                  background:"#1e3a5f",color:"#fff",fontSize:10,fontWeight:500,
                                  padding:"6px 9px",borderRadius:7,whiteSpace:"pre-wrap",
                                  minWidth:140,maxWidth:220,lineHeight:1.5,
                                  boxShadow:"0 4px 16px rgba(0,0,0,0.25)",zIndex:50,
                                  pointerEvents:"none"
                                }}>{commentText}</span>
                              </span>
                            );
                          })()}
                        </div>
                      )}
                      {hasData ? segs.map((e,si) => {
                        const hrs = Number(e.hours)||0;
                        const nw = e.nonWork ? nwMap[e.nonWork] : null;
                        const nwHrs = Number(e.nonWorkHours)||0;
                        const tc = TEAM_COLORS[e.team||s.team];
                        const nonWorkOnly = !hrs && nw; // no work hours — NW is the whole story
                        const mixed = hrs > 0 && nw;    // partial day — working + NW

                        if (nonWorkOnly) {
                          // Full non-work day: show code prominently, no team label
                          return (
                            <div key={si} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:3,padding:"2px 4px",borderRadius:4,background:nw.color+"18",border:"1px solid "+nw.color+"44"}}>
                              <span style={{fontSize:12,fontWeight:800,color:nw.color}}>{nw.code}</span>
                              <span style={{fontSize:10,color:nw.color+"bb",fontWeight:600}}>{nwHrs||8}h</span>
                            </div>
                          );
                        }
                        if (mixed) {
                          // Partial day: show hours + team, then NW hours + code
                          return (
                            <div key={si} style={{display:"flex",flexDirection:"column",gap:2,padding:"1px 3px",borderRadius:4,background:tc?.bg||"#f0f7ff",borderLeft:"2px solid "+(tc?.dot||"#3b82f6")}}>
                              <div style={{display:"flex",alignItems:"center",gap:3}}>
                                <span style={{fontSize:11,fontWeight:700,color:"#1e3a5f",flexShrink:0}}>{hrs}h</span>
                                <span style={{fontSize:9,color:tc?.text||"#1e40af",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{e.team||s.team}</span>
                              </div>
                              <div style={{display:"flex",alignItems:"center",gap:2,padding:"1px 3px",borderRadius:3,background:nw.color+"18"}}>
                                <span style={{fontSize:9,fontWeight:800,color:nw.color}}>{nw.code}</span>
                                <span style={{fontSize:9,color:nw.color+"bb",fontWeight:600}}>{nwHrs||8}h</span>
                              </div>
                            </div>
                          );
                        }
                        // Normal working day: hours + team
                        return (
                          <div key={si} style={{display:"flex",alignItems:"center",gap:3,padding:"1px 3px",borderRadius:4,background:tc?.bg||"#f0f7ff",borderLeft:"2px solid "+(tc?.dot||"#3b82f6")}}>
                            <span style={{fontSize:11,fontWeight:700,color:"#1e3a5f",flexShrink:0}}>{hrs}h</span>
                            <span style={{fontSize:9,color:tc?.text||"#1e40af",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{e.team||s.team}</span>
                          </div>
                        );
                      }) : isHoliday ? <span style={{fontSize:9,color:"#7c3aed",fontWeight:700,textAlign:"center",width:"100%"}}>HOL</span>
                        : <span style={{fontSize:16,color:"#e2e8f0",textAlign:"center",width:"100%"}}>+</span>}
                      {hasData && s.shiftStart && s.shiftEnd && !compactMode && fmtTime(s.shiftStart) && fmtTime(s.shiftEnd) && <span style={{fontSize:8,color:"#94a3b8",textAlign:"center"}}>{fmtTime(s.shiftStart)}-{fmtTime(s.shiftEnd)}</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>

      </table>
    </div>
  );
}

// ─── Year At A Glance ─────────────────────────────────────────────────────────
function YearView({ year, staff, getEntry, getDayFTE, nwMap, setWeekStart, setActiveTab, setDrillDay }) {
  const [hovered, setHovered] = useState(null);
  const [metric, setMetric] = useState("fte"); // fte | staffed | nonwork

  const yearDays = useMemo(() => getDaysInYear(year), [year]);
  const byMonth = useMemo(() => {
    const months = Array.from({length:12},(_,m)=>yearDays.filter(d=>d.getMonth()===m));
    return months;
  }, [yearDays]);

  const getDayColor = useCallback((date) => {
    const ds = fmt(date); const fte = getDayFTE(ds); const val = Number(fte.total);
    if (isWeekend(date)) return "#f5f3ff";
    if (val === 0) return "#f9fafb";
    if (metric==="fte") {
      const maxFTE = staff.length; const pct = Math.min(val / (maxFTE * 0.5), 1);
      const r = Math.round(219 - pct * 150); const g = Math.round(234 - pct * 80); const b = Math.round(254 - pct * 100);
      return `rgb(${r},${g},${b})`;
    }
    if (metric==="nonwork") {
      let nwCount = 0;
      staff.forEach(s => { const e = getEntry(s.id, ds); if (e.nonWork) nwCount++; });
      if (nwCount === 0) return "#f9fafb";
      const pct = Math.min(nwCount / 5, 1);
      const r = Math.round(254 - pct*20); const g = Math.round(242 - pct*140); const b = Math.round(242 - pct*140);
      return `rgb(${r},${g},${b})`;
    }
    return "#f9fafb";
  }, [staff, getEntry, getDayFTE, metric]);

  const today = fmt(new Date());

  return (
    <div style={{display:"grid",gap:16}}>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:13,fontWeight:700,color:"#374151"}}>Color by:</span>
        {[["fte","FTE Density"],["nonwork","Non-Work Load"]].map(([v,l])=>(
          <button key={v} onClick={()=>setMetric(v)} style={{
            padding:"4px 12px",borderRadius:99,fontSize:12,fontWeight:600,cursor:"pointer",
            background:metric===v?"#1e3a5f":"#f9fafb",color:metric===v?"#fff":"#6b7280",
            border:"1px solid "+(metric===v?"transparent":"#e5e7eb")
          }}>{l}</button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",fontSize:11,color:"#6b7280"}}>
          <span style={{width:12,height:12,background:"#dbeafe",borderRadius:2,display:"inline-block"}}></span>Low
          <span style={{width:12,height:12,background:"#3b82f6",borderRadius:2,display:"inline-block",marginLeft:6}}></span>High
          <span style={{width:12,height:12,background:"#f5f3ff",borderRadius:2,display:"inline-block",marginLeft:6}}></span>Weekend
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
        {byMonth.map((days,month) => {
          // pad to start on correct weekday
          const firstDay = days[0].getDay();
          return (
            <div key={month} style={{background:"#fff",borderRadius:12,padding:14,border:"1px solid #e5e7eb",boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
              <div style={{fontSize:13,fontWeight:800,color:"#1e3a5f",marginBottom:8}}>{MONTHS[month]}</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2,marginBottom:4}}>
                {["S","M","T","W","T","F","S"].map((d,i)=>(
                  <div key={i} style={{fontSize:9,fontWeight:700,color:"#9ca3af",textAlign:"center"}}>{d}</div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:2}}>
                {Array.from({length:firstDay},(_,i)=><div key={"pad"+i} />)}
                {days.map(date => {
                  const ds = fmt(date); const isToday = ds===today;
                  const fte = getDayFTE(ds);
                  return (
                    <div key={ds}
                      onMouseEnter={()=>setHovered({date,ds,fte})}
                      onMouseLeave={()=>setHovered(null)}
                      onClick={()=>{
                        if(date.getDay()===0){setWeekStart(new Date(date));setActiveTab("grid");}
                        else {setDrillDay(date);}
                      }}
                      style={{
                        aspectRatio:"1",borderRadius:3,cursor:"pointer",
                        background:getDayColor(date),
                        border:isToday?"2px solid #1e3a5f":"1px solid transparent",
                        display:"flex",alignItems:"center",justifyContent:"center",
                        fontSize:8,fontWeight:isToday?800:500,color:isToday?"#1e3a5f":"#6b7280",
                        transition:"transform 0.1s",transform:hovered?.ds===ds?"scale(1.2)":"scale(1)"
                      }}
                    >
                      {date.getDate()}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {hovered && (
        <div style={{position:"fixed",bottom:24,right:24,background:"#1e3a5f",color:"#fff",borderRadius:12,padding:"12px 18px",boxShadow:"0 8px 30px rgba(0,0,0,0.25)",zIndex:100,minWidth:200}}>
          <div style={{fontSize:13,fontWeight:800,marginBottom:6}}>
            {new Date(hovered.ds+"T12:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}
          </div>
          <div style={{fontSize:12,color:"#93c5fd"}}>Total FTE: <b style={{color:"#fff"}}>{hovered.fte.total}</b></div>
          {TEAMS.map(t=><div key={t} style={{fontSize:11,color:"#93c5fd"}}>{t}: <b style={{color:"#fff"}}>{(hovered.fte.byTeam[t]||0).toFixed(2)}</b></div>)}
          <div style={{fontSize:10,color:"#64748b",marginTop:6}}>Click to open day detail</div>
        </div>
      )}
    </div>
  );
}

// ─── Non-Work Code Editor ─────────────────────────────────────────────────────
function NonWorkEditor({ nonWorkTypes, updateNonWorkTypes, onClose }) {
  const [codes, setCodes] = useState(nonWorkTypes.map(n=>({...n})));
  const [newCode, setNewCode] = useState(""); const [newLabel, setNewLabel] = useState(""); const [newColor, setNewColor] = useState("#6366f1");

  const save = () => { updateNonWorkTypes(codes); onClose(); };
  const addCode = () => {
    if (!newCode.trim() || !newLabel.trim()) return;
    if (codes.find(c=>c.code===newCode.toUpperCase())) { alert("Code already exists"); return; }
    setCodes(prev=>[...prev,{code:newCode.toUpperCase().slice(0,6),label:newLabel,color:newColor}]);
    setNewCode(""); setNewLabel(""); setNewColor("#6366f1");
  };
  const removeCode = (code) => setCodes(prev=>prev.filter(c=>c.code!==code));
  const updateCode = (code, field, value) => setCodes(prev=>prev.map(c=>c.code===code?{...c,[field]:value}:c));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:560,maxHeight:"80vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>Non-Work Code Manager</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        <div style={{display:"grid",gap:8,marginBottom:20}}>
          {codes.map(c => (
            <div key={c.code} style={{display:"grid",gridTemplateColumns:"80px 1fr auto 36px",gap:8,alignItems:"center",padding:"8px 10px",borderRadius:8,background:"#f9fafb",border:"1px solid #f3f4f6"}}>
              <input value={c.code} onChange={e=>updateCode(c.code,"code",e.target.value.toUpperCase().slice(0,6))}
                style={{...inp,padding:"4px 8px",fontSize:12,fontFamily:"monospace",fontWeight:700}} />
              <input value={c.label} onChange={e=>updateCode(c.code,"label",e.target.value)}
                style={{...inp,padding:"4px 8px",fontSize:13}} />
              <input type="color" value={c.color} onChange={e=>updateCode(c.code,"color",e.target.value)}
                style={{width:40,height:32,border:"none",borderRadius:6,cursor:"pointer",padding:2}} />
              <button onClick={()=>removeCode(c.code)} style={{background:"#fee2e2",border:"none",borderRadius:6,color:"#dc2626",fontWeight:700,cursor:"pointer",fontSize:13}}>✕</button>
            </div>
          ))}
        </div>

        <div style={{background:"#f0f9ff",borderRadius:10,padding:14,border:"1px solid #bae6fd",marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:700,color:"#0369a1",marginBottom:8}}>Add New Code</div>
          <div style={{display:"grid",gridTemplateColumns:"80px 1fr auto",gap:8}}>
            <input value={newCode} onChange={e=>setNewCode(e.target.value.toUpperCase().slice(0,6))} placeholder="CODE" style={{...inp,padding:"6px 8px",fontSize:12,fontFamily:"monospace",fontWeight:700}} />
            <input value={newLabel} onChange={e=>setNewLabel(e.target.value)} placeholder="Label (e.g. Training)" style={{...inp,padding:"6px 8px",fontSize:13}} />
            <input type="color" value={newColor} onChange={e=>setNewColor(e.target.value)} style={{width:40,height:36,border:"none",borderRadius:6,cursor:"pointer",padding:2}} />
          </div>
          <button onClick={addCode} style={{marginTop:8,padding:"7px 16px",borderRadius:8,background:"#0369a1",color:"#fff",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>+ Add Code</button>
        </div>

        <div style={{display:"flex",gap:10}}>
          <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
          <button onClick={save} style={{flex:2,padding:"10px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}

// ─── Cell Editor (multi-segment) ─────────────────────────────────────────────
function CellEditor({ staffId, dateStr, staff, getEntry, setEntrySegments, nwMap, nonWorkTypes, onClose, getDailyStats }) {
  const s = staff.find(x=>x.id===staffId);
  const isHoliday = getDailyStats ? getDailyStats(dateStr)?.holiday : false;
  const [segs, setSegs] = useState(() => {
    const raw = getEntry(staffId, dateStr);
    return raw.length ? raw.map(r=>({...r})) : [{ hours:"", team: s?.team||TEAMS[0], nonWork: isHoliday?"HOL":"", nonWorkHours: isHoliday?"8":"", comment:"", swap:false }];
  });

  const updateSeg = (i, field, value) => setSegs(prev => prev.map((sg, idx) => {
    if (idx !== i) return sg;
    const updated = { ...sg, [field]: value };
    const staffDefaultHrs = s?.defaultHours || 8;
    // Auto-adjust work hours when NW code or NW hours change
    if (field === "nonWork") {
      if (value) {
        // Code just set — default NW hours to full day if not already set
        const nwHrs = Number(updated.nonWorkHours) || staffDefaultHrs;
        updated.nonWorkHours = String(nwHrs);
        // Set work hours to remainder (clamped to 0)
        updated.hours = String(Math.max(0, staffDefaultHrs - nwHrs));
      } else {
        // Code cleared — restore work hours to default
        updated.nonWorkHours = "";
        updated.hours = String(staffDefaultHrs);
      }
    }
    if (field === "nonWorkHours" && sg.nonWork) {
      const nwHrs = Number(value) || 0;
      // Only auto-adjust if user hasn't manually overridden work hours beyond default
      updated.hours = String(Math.max(0, staffDefaultHrs - nwHrs));
    }
    return updated;
  }));
  const addSeg = () => setSegs(prev=>[...prev,{ hours:"", team: s?.team||TEAMS[0], nonWork:"", nonWorkHours:"", comment:"", swap:false }]);
  const removeSeg = i => setSegs(prev=>prev.filter((_,idx)=>idx!==i));

  const save = () => {
    const cleaned = segs.filter(sg=>Number(sg.hours)>0||sg.nonWork);
    setEntrySegments(staffId, dateStr, cleaned.length ? cleaned : []);
    onClose();
  };

  const totalHrs = segs.reduce((a,sg)=>a+(Number(sg.hours)||0),0);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:16,padding:26,width:440,maxHeight:"90vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.2)"}} onClick={e=>e.stopPropagation()}>
        
        {/* Header */}
        <div style={{marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:17,fontWeight:700,color:"#111827"}}>{s?.name}</div>
            {isHoliday && <span style={{fontSize:11,fontWeight:700,padding:"2px 8px",borderRadius:99,background:"#ede9fe",color:"#7c3aed"}}>⛱ Holiday</span>}
          </div>
          <div style={{fontSize:12,color:"#6b7280",marginTop:2}}>{new Date(dateStr+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</div>
          {s?.shiftStart && <div style={{fontSize:11,color:"#3b82f6",fontWeight:600,marginTop:4,background:"#eff6ff",padding:"3px 8px",borderRadius:6,display:"inline-block"}}>Standard: {fmtTime(s.shiftStart)} – {fmtTime(s.shiftEnd)}</div>}
          {totalHrs > 0 && <div style={{fontSize:11,color:"#6b7280",marginTop:4}}>Total hours: <b style={{color:"#1e3a5f"}}>{totalHrs}h</b></div>}
        </div>

        {/* Segments */}
        <div style={{display:"grid",gap:10}}>
          {segs.map((sg,i) => {
            const tc = TEAM_COLORS[sg.team||s?.team];
            const nwInfo = sg.nonWork ? nwMap[sg.nonWork] : null;
            return (
              <div key={i} style={{border:"1px solid "+(tc?.dot||"#e5e7eb"),borderRadius:10,padding:12,background:tc?.bg+"44"||"#f9fafb"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontSize:11,fontWeight:700,color:tc?.text||"#374151"}}>
                    {segs.length > 1 ? `Segment ${i+1}` : "Work Entry"}
                  </span>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {/* Swap toggle */}
                    <button onClick={()=>updateSeg(i,"swap",!sg.swap)}
                      title="Mark as day swap"
                      style={{fontSize:10,padding:"2px 7px",borderRadius:6,border:"1px solid "+(sg.swap?"#f59e0b":"#e5e7eb"),
                        background:sg.swap?"#fef9c3":"#f9fafb",color:sg.swap?"#92400e":"#9ca3af",fontWeight:700,cursor:"pointer"}}>
                      ⇄ {sg.swap?"Swap":"Swap?"}
                    </button>
                    {segs.length > 1 && <button onClick={()=>removeSeg(i)} style={{background:"#fee2e2",border:"none",borderRadius:5,color:"#dc2626",fontWeight:700,cursor:"pointer",padding:"2px 7px",fontSize:12}}>✕</button>}
                  </div>
                </div>

                {/* Team + Hours */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div>
                    <label style={{...lbl,fontSize:10}}>Team / Location</label>
                    <select value={sg.team||s?.team} onChange={e=>updateSeg(i,"team",e.target.value)} style={{...sel,fontSize:12,padding:"5px 8px"}}>
                      {TEAMS.map(t=><option key={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{...lbl,fontSize:10}}>
                      Hours Worked
                      {sg.nonWork && Number(sg.hours) >= 0 && <span style={{marginLeft:4,fontSize:9,color:"#9ca3af",fontWeight:400}}>(auto)</span>}
                    </label>
                    <input type="number" min="0" max="24" step="0.5" value={sg.hours||""} placeholder="0"
                      onChange={e=>updateSeg(i,"hours",e.target.value)}
                      style={{...inp,fontSize:12,padding:"5px 8px",borderColor:sg.nonWork?"#93c5fd":"#e5e7eb"}} />
                  </div>
                </div>

                {/* Non-work + NW hours */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div>
                    <label style={{...lbl,fontSize:10}}>Non-Work Code</label>
                    <select value={sg.nonWork||""} onChange={e=>updateSeg(i,"nonWork",e.target.value)} style={{...sel,fontSize:12,padding:"5px 8px",borderColor:nwInfo?nwInfo.color:"#e5e7eb"}}>
                      <option value="">— None —</option>
                      {nonWorkTypes.map(t=><option key={t.code} value={t.code}>{t.code} – {t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{...lbl,fontSize:10,color:nwInfo?.color||"#6b7280"}}>
                      {sg.nonWork ? `${sg.nonWork} Hours` : "NW Hours"}
                    </label>
                    <input type="number" min="0" max="24" step="0.5"
                      value={sg.nonWorkHours||""} placeholder={sg.nonWork?"8":"—"}
                      disabled={!sg.nonWork}
                      onChange={e=>updateSeg(i,"nonWorkHours",e.target.value)}
                      style={{...inp,fontSize:12,padding:"5px 8px",background:sg.nonWork?(nwInfo?.color+"11"||"#f9fafb"):"#f9fafb",
                        border:"1px solid "+(nwInfo?nwInfo.color+"66":"#e5e7eb"),color:nwInfo?.color||"#374151",fontWeight:sg.nonWork?700:400}} />
                  </div>
                </div>

                {/* Per-segment comment */}
                <div>
                  <label style={{...lbl,fontSize:10}}>💬 Note / Comment</label>
                  <input value={sg.comment||""} onChange={e=>updateSeg(i,"comment",e.target.value)}
                    placeholder={sg.swap?"e.g. Swapping with Friday 1/10":"e.g. Covering for Jones"}
                    style={{...inp,fontSize:11,padding:"5px 8px"}} />
                </div>

                {/* Swap info box */}
                {sg.swap && (
                  <div style={{marginTop:6,padding:"5px 8px",borderRadius:6,background:"#fef9c3",border:"1px solid #fde68a",fontSize:10,color:"#92400e"}}>
                    ⇄ Marked as a day swap — add note above to record which day this is swapping with
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button onClick={addSeg} style={{marginTop:10,width:"100%",padding:"8px",background:"#f0f9ff",border:"1px dashed #93c5fd",borderRadius:8,fontSize:12,fontWeight:600,color:"#1d4ed8",cursor:"pointer"}}>
          + Add Another Location / Split
        </button>

        <div style={{display:"flex",gap:8,marginTop:12}}>
          <button onClick={onClose} style={{flex:1,padding:"9px",background:"#f3f4f6",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
          <button onClick={save} style={{flex:2,padding:"9px",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer"}}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Day Drill Down ───────────────────────────────────────────────────────────
function DayDrillDown({ date, staff, getEntry, getDailyStats, setDailyStat, setHoliday, getDayFTE, nwMap, onClose }) {
  const ds = fmt(date); const stats = getDailyStats(ds); const fte = getDayFTE(ds);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:560,maxHeight:"84vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{fontSize:20,fontWeight:800,color:"#111827"}}>{date.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</div>
          {stats.holiday && <span style={{padding:"3px 10px",borderRadius:99,background:"#ede9fe",color:"#7c3aed",fontSize:12,fontWeight:700}}>⛱ Holiday</span>}
          <HolidayToggleBtn ds={ds} isHoliday={stats.holiday} setHoliday={setHoliday} setDailyStat={setDailyStat} />
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:20}}>
          <StatCard label="Total FTE" value={fte.total} color="#1e3a5f" />
          {TEAMS.map(t=><StatCard key={t} label={t+" FTE"} value={(fte.byTeam[t]||0).toFixed(2)} color={TEAM_COLORS[t].dot} />)}
        </div>
        <div style={{fontSize:14,fontWeight:700,color:"#374151",marginBottom:10}}>Census by Team</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:20}}>
          {TEAMS.map(t=>{
            const census = Number(stats.census?.[t])||0;
            const teamStaffCount = staff.filter(s=>{
              const segs=getEntry(s.id,ds);
              return segs.some(e=>(e.team||s.team)===t&&Number(e.hours)>0);
            }).length||1;
            const tc=TEAM_COLORS[t];
            return (
              <div key={t} style={{background:tc.bg,borderRadius:10,padding:"10px 12px",border:"1px solid "+tc.dot+"44"}}>
                <label style={{...lbl,color:tc.text}}>{t}</label>
                <input type="number" min="0" value={stats.census?.[t]||""} onChange={e=>setDailyStat(ds,"census",{...stats.census,[t]:e.target.value===''?0:Number(e.target.value)})} style={{...inp,background:"transparent",border:"1px solid "+tc.dot+"55",color:tc.text,fontWeight:800,fontSize:18}} placeholder="0" />
                <div style={{fontSize:10,color:tc.text+"aa",marginTop:3}}>{census>0?(census/teamStaffCount).toFixed(1)+" pts/staff":"—"}</div>
              </div>
            );
          })}
        </div>
        <div style={{fontSize:14,fontWeight:700,color:"#374151",marginBottom:10}}>Staff on Duty</div>
        <div style={{display:"grid",gap:5}}>
          {sortByName(staff).map(s=>{
            const segs=getEntry(s.id,ds);
            const totalHrs=segs.reduce((a,e)=>a+(Number(e.hours)||0),0);
            const hasData=totalHrs>0||segs.some(e=>e.nonWork);
            if(!hasData) return null;
            return (
              <div key={s.id} style={{padding:"7px 10px",borderRadius:8,background:"#f9fafb",border:"1px solid #f3f4f6"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:segs.length>1?5:0}}>
                  <span style={{fontSize:12,fontWeight:700,color:"#374151"}}>{s.name}</span>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    <span style={{fontSize:11,color:"#1e3a5f",fontWeight:600}}>{totalHrs}h total</span>
                    {s.shiftStart&&<span style={{fontSize:10,color:"#64748b"}}>{fmtTime(s.shiftStart)}–{fmtTime(s.shiftEnd)}</span>}
                  </div>
                </div>
                {segs.map((e,si)=>{
                  const hrs=Number(e.hours)||0; const nw=e.nonWork?nwMap[e.nonWork]:null;
                  const tc=TEAM_COLORS[e.team||s.team];
                  return (
                    <div key={si} style={{display:"flex",gap:5,alignItems:"center",marginTop:3,padding:"3px 6px",borderRadius:5,background:tc?.bg||"#f3f4f6",borderLeft:"2px solid "+(tc?.dot||"#94a3b8"),flexWrap:"wrap"}}>
                      {hrs>0&&<span style={{fontSize:11,fontWeight:600,color:"#1e3a5f"}}>{hrs}h</span>}
                      {!hrs&&nw&&<span style={{fontSize:11,fontWeight:700,color:nw.color}}>{Number(e.nonWorkHours)||8}h</span>}
                      <span style={{fontSize:11,color:tc?.text||"#374151",fontWeight:500}}>{e.team||s.team}</span>
                      {nw&&<span style={{fontSize:10,padding:"0px 5px",borderRadius:99,background:nw.color+"22",color:nw.color,fontWeight:700}}>{nw.code}</span>}
                      {e.swap&&<span style={{fontSize:9,padding:"0px 5px",borderRadius:99,background:"#fef9c3",color:"#92400e",fontWeight:700}}>⇄ swap</span>}
                      {e.comment&&<span style={{fontSize:10,color:"#6b7280",fontStyle:"italic",width:"100%"}}>💬 {e.comment}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <button onClick={onClose} style={{marginTop:16,width:"100%",padding:"9px",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer"}}>Close</button>
      </div>
    </div>
  );
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────
function SummaryTab({ weekDates, getEntry, getDailyStats, getDayFTE, weeklyMetrics, nonWorkTypes, staff, dailyStats, yearView, ptoAlerts, entries }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const defaultStart = fmt(weekDates[0]);
  const defaultEnd   = fmt(weekDates[6]);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate,   setEndDate]   = useState(defaultEnd);
  const [quickRange, setQuickRange] = useState("week");

  const applyQuick = (range) => {
    setQuickRange(range);
    const t = new Date(); t.setHours(0,0,0,0);
    // Current week always calculated from today, not from the grid's weekDates
    const thisSun = new Date(t); thisSun.setDate(t.getDate() - t.getDay());
    const thisSat = new Date(thisSun); thisSat.setDate(thisSun.getDate() + 6);
    if (range === "week") {
      setStartDate(fmt(thisSun)); setEndDate(fmt(thisSat));
    } else if (range === "lastweek") {
      const lastSun = new Date(thisSun); lastSun.setDate(thisSun.getDate() - 7);
      const lastSat = new Date(lastSun); lastSat.setDate(lastSun.getDate() + 6);
      setStartDate(fmt(lastSun)); setEndDate(fmt(lastSat));
    } else if (range === "month") {
      const y=t.getFullYear(),m=t.getMonth();
      setStartDate(fmt(new Date(y,m,1))); setEndDate(fmt(new Date(y,m+1,0)));
    } else if (range === "year") {
      setStartDate(`${t.getFullYear()}-01-01`); setEndDate(`${t.getFullYear()}-12-31`);
    }
  };

  // Build array of dateStrings in range
  const rangeDays = useMemo(() => {
    const days = [];
    const s = new Date(startDate+"T12:00:00");
    const e = new Date(endDate+"T12:00:00");
    if (isNaN(s)||isNaN(e)||s>e) return days;
    const cur = new Date(s);
    while (cur <= e) { days.push(fmt(cur)); cur.setDate(cur.getDate()+1); }
    return days;
  }, [startDate, endDate]);

  const rangeLabel = rangeDays.length === 1
    ? new Date(startDate+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})
    : `${new Date(startDate+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})} – ${new Date(endDate+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}`;

  // Census stats over range
  const censusData = useMemo(() => {
    const result = {};
    TEAMS.forEach(t => { result[t] = { total:0, daysWithData:0, sumRatios:0, ratioDays:0, max:0 }; });
    rangeDays.forEach(ds => {
      const stats = getDailyStats(ds);
      const fte = getDayFTE(ds);
      TEAMS.forEach(t => {
        const c = Number(stats.census?.[t]) || 0;
        if (c > 0) {
          result[t].total += c;
          result[t].daysWithData++;
          result[t].max = Math.max(result[t].max, c);
          const tFTE = fte.byTeam[t] || 0;
          if (tFTE > 0) { result[t].sumRatios += c/tFTE; result[t].ratioDays++; }
        }
      });
    });
    TEAMS.forEach(t => {
      const r = result[t];
      r.avg = r.daysWithData > 0 ? (r.total/r.daysWithData).toFixed(1) : "—";
      r.avgRatio = r.ratioDays > 0 ? (r.sumRatios/r.ratioDays).toFixed(1) : "—";
    });
    return result;
  }, [rangeDays, getDailyStats, getDayFTE]);

  const totalAvgCensus = TEAMS.reduce((a,t) => {
    const d = censusData[t]; return a + (d.daysWithData > 0 ? d.total/d.daysWithData : 0);
  }, 0);

  // Non-work totals over range
  const nonWorkTotals = useMemo(() => {
    const totals = {};
    rangeDays.forEach(ds => {
      staff.forEach(s => {
        const key = `${s.id}_${ds}`;
        const raw = entries[key];
        if (!raw) return;
        const segs = Array.isArray(raw) ? raw : [raw];
        segs.forEach(e => {
          if (e.nonWork) {
            const hrs = Number(e.nonWorkHours) || Number(e.hours) || 8;
            totals[e.nonWork] = (totals[e.nonWork]||0) + hrs;
          }
        });
      });
    });
    return totals;
  }, [rangeDays, staff, entries]);

  // FTE averages over range
  const fteAvgs = useMemo(() => {
    const sums = { total:0, ...Object.fromEntries(TEAMS.map(t=>[t,0])) };
    let days = 0;
    rangeDays.forEach(ds => {
      const fte = getDayFTE(ds);
      if (Number(fte.total) > 0) {
        sums.total += Number(fte.total); days++;
        TEAMS.forEach(t => { sums[t] += (fte.byTeam[t]||0); });
      }
    });
    return { total: days>0?(sums.total/days).toFixed(1):"—", byTeam: Object.fromEntries(TEAMS.map(t=>[t,days>0?(sums[t]/days).toFixed(1):"—"])), days };
  }, [rangeDays, getDayFTE]);

  return (
    <div style={{display:"grid",gap:18}}>

      {/* ── PTO Alerts ── */}
      {ptoAlerts && ptoAlerts.length > 0 && (
        <div style={{background:"#fff",borderRadius:14,padding:16,border:"1px solid #fca5a5"}}>
          <div style={{fontSize:14,fontWeight:800,color:"#dc2626",marginBottom:12}}>⚠ PTO Balance Alerts ({ptoAlerts.length})</div>
          <div style={{display:"grid",gap:6}}>
            {ptoAlerts.map((a,i) => {
              const tc = TEAM_COLORS[a.team]; const isOver = a.overBy > 0;
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:9,
                  background:isOver?"#fef2f2":"#fffbeb",border:"1px solid "+(isOver?"#fca5a5":"#fde68a"),flexWrap:"wrap"}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:tc?.dot,flexShrink:0,display:"inline-block"}} />
                  <span style={{fontSize:12,fontWeight:700,color:"#111827",flex:1,minWidth:120}}>{a.staffName}</span>
                  <span style={{fontSize:11,padding:"1px 7px",borderRadius:99,background:tc?.bg,color:tc?.text,fontWeight:600}}>{a.team}</span>
                  <span style={{fontSize:11,fontWeight:700,color:isOver?"#dc2626":"#d97706"}}>
                    {a.code}: {a.usedHrs}h of {a.limit}h
                    {isOver ? <span style={{marginLeft:6,padding:"1px 7px",borderRadius:99,background:"#fee2e2",fontSize:10,fontWeight:800}}>🔴 {a.overBy}h over</span>
                            : <span style={{marginLeft:6,padding:"1px 7px",borderRadius:99,background:"#fef9c3",fontSize:10,fontWeight:700}}>🟡 90%+ used</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Date Range Selector ── */}
      <div style={{background:"#fff",borderRadius:14,padding:16,border:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#1e3a5f",flexShrink:0}}>📅 Date Range</div>
        {/* Quick buttons */}
        <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:8,padding:3}}>
          {[["week","This Week"],["lastweek","Last Week"],["month","This Month"],["year","This Year"]].map(([v,l])=>(
            <button key={v} onClick={()=>applyQuick(v)} style={{
              padding:"4px 12px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
              background:quickRange===v?"#fff":"transparent",color:quickRange===v?"#1e3a5f":"#6b7280",
              boxShadow:quickRange===v?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          <input type="date" value={startDate} onChange={e=>{setStartDate(e.target.value);setQuickRange("custom");}}
            style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12,fontWeight:600,color:"#374151"}} />
          <span style={{fontSize:12,color:"#9ca3af"}}>to</span>
          <input type="date" value={endDate} onChange={e=>{setEndDate(e.target.value);setQuickRange("custom");}}
            style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12,fontWeight:600,color:"#374151"}} />
        </div>
        <div style={{fontSize:11,color:"#9ca3af",marginLeft:"auto"}}>{rangeDays.length} days · {rangeLabel}</div>
      </div>

      {/* ── Census + FTE Overview ── */}
      <div style={{background:"#fff",borderRadius:14,padding:20,border:"1px solid #e5e7eb"}}>
        <div style={{fontSize:15,fontWeight:800,color:"#1e3a5f",marginBottom:16}}>🏥 Census & Staffing</div>

        {/* Summary banner */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
          <div style={{background:"linear-gradient(135deg,#1e3a5f,#1e40af)",borderRadius:10,padding:"14px 20px"}}>
            <div style={{fontSize:10,color:"#93c5fd",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Avg Daily Census</div>
            <div style={{fontSize:32,fontWeight:800,color:"#fff"}}>{totalAvgCensus > 0 ? totalAvgCensus.toFixed(1) : "—"}</div>
          </div>
          <div style={{background:"linear-gradient(135deg,#065f46,#047857)",borderRadius:10,padding:"14px 20px"}}>
            <div style={{fontSize:10,color:"#6ee7b7",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em"}}>Avg Daily FTE</div>
            <div style={{fontSize:32,fontWeight:800,color:"#fff"}}>{fteAvgs.total}</div>
          </div>
        </div>

        {/* Per-team grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {TEAMS.map(t => {
            const d = censusData[t]; const tc = TEAM_COLORS[t];
            return (
              <div key={t} style={{background:tc.bg,borderRadius:12,padding:14,border:"1px solid "+tc.dot+"44"}}>
                <div style={{fontSize:11,fontWeight:800,color:tc.text,textTransform:"uppercase",marginBottom:10}}>{t}</div>
                <div style={{display:"grid",gap:5}}>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:tc.text+"99"}}>Avg Census</span>
                    <span style={{fontSize:16,fontWeight:800,color:tc.text}}>{d.avg}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:tc.text+"99"}}>Peak</span>
                    <span style={{fontSize:13,fontWeight:700,color:tc.text}}>{d.max||"—"}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:tc.text+"99"}}>Pts / FTE</span>
                    <span style={{fontSize:13,fontWeight:700,color:tc.dot}}>{d.avgRatio}</span>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:tc.text+"99"}}>Avg FTE</span>
                    <span style={{fontSize:13,fontWeight:700,color:tc.text}}>{fteAvgs.byTeam[t]}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{fontSize:11,color:"#9ca3af",textAlign:"right",marginTop:10}}>
          Census based on days with data: {TEAMS.map(t=>`${t}: ${censusData[t].daysWithData}d`).join(" · ")}
        </div>
      </div>

      {/* ── Non-Work Summary ── */}
      <div style={{background:"#fff",borderRadius:14,padding:20,border:"1px solid #e5e7eb"}}>
        <div style={{fontSize:14,fontWeight:800,color:"#1e3a5f",marginBottom:14}}>🏖 Non-Work / Leave Summary</div>
        {Object.values(nonWorkTotals).every(v=>v===0) || Object.keys(nonWorkTotals).length===0 ? (
          <div style={{fontSize:12,color:"#9ca3af",textAlign:"center",padding:"20px 0"}}>No non-work hours recorded in this date range.</div>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
            {nonWorkTypes.filter(t=>nonWorkTotals[t.code]>0).map(t=>(
              <div key={t.code} style={{padding:"12px 14px",borderRadius:8,background:t.color+"11",border:"1px solid "+t.color+"33"}}>
                <div style={{fontSize:10,fontWeight:700,color:t.color,textTransform:"uppercase"}}>{t.label}</div>
                <div style={{fontSize:24,fontWeight:800,color:t.color}}>{nonWorkTotals[t.code]}h</div>
                <div style={{fontSize:10,color:t.color+"99"}}>{(nonWorkTotals[t.code]/8).toFixed(1)} days</div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

// ─── Visits Tab ──────────────────────────────────────────────────────────────
const ANNUAL_WORK_DAYS = 227;
const VISIT_GOAL_PER_PERSON = 1300; // dept-wide weighted average goal
const TEAM_VISIT_GOALS = {
  Rehab:  { visitsPerFTEDay: 4.0,  annualPerPerson: 908  },
  Peds:   { visitsPerFTEDay: 6.5,  annualPerPerson: 1476 },
  Acute:  { visitsPerFTEDay: 6.5,  annualPerPerson: 1476 },
};

function getISOWeekKey(dateStr) {
  // Key is simply the Sunday date of the week — reliable and human-readable
  const d = new Date(dateStr + "T12:00:00");
  const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
  return `week_${fmt(sun)}`;
}

function getWeekStartFromKey(key) {
  // key format: "YYYY-WNN_YYYY-MM-DD"
  const parts = key.split("_");
  return parts[1] || parts[0];
}

function VisitsTab({ visitData, updateVisitData, staff, weekStart, getDayFTE }) {
  const today = new Date(); today.setHours(0,0,0,0);

  // Entry state — which week is being edited
  const [entryWeekStart, setEntryWeekStart] = useState(() => fmt(weekStart));
  const [entryValues, setEntryValues] = useState({ Rehab:{evals:"",visits:""}, Peds:{evals:"",visits:""}, Acute:{evals:"",visits:""} });
  const [saveMsg, setSaveMsg] = useState(null);

  // View state — default to YTD so all entered data is always visible
  const defaultViewStart = `${today.getFullYear()}-01-01`;
  const [viewStart, setViewStart] = useState(defaultViewStart);
  const [viewEnd, setViewEnd] = useState(fmt(today));
  const [quickRange, setQuickRange] = useState("ytd");

  const applyQuick = (range) => {
    setQuickRange(range);
    const t = new Date(); t.setHours(0,0,0,0);
    const thisSun = new Date(t); thisSun.setDate(t.getDate() - t.getDay());
    if (range === "lastweek") {
      const lastSun = new Date(thisSun); lastSun.setDate(thisSun.getDate() - 7);
      const lastSat = new Date(lastSun); lastSat.setDate(lastSun.getDate() + 6);
      setViewStart(fmt(lastSun)); setViewEnd(fmt(lastSat));
    } else if (range === "month") {
      const d = new Date(t); d.setDate(d.getDate()-27);
      setViewStart(fmt(d)); setViewEnd(fmt(t));
    } else if (range === "quarter") {
      const d = new Date(t); d.setDate(d.getDate()-89);
      setViewStart(fmt(d)); setViewEnd(fmt(t));
    } else if (range === "ytd") {
      setViewStart(`${t.getFullYear()}-01-01`); setViewEnd(fmt(t));
    } else if (range === "year") {
      setViewStart(`${t.getFullYear()}-01-01`); setViewEnd(`${t.getFullYear()}-12-31`);
    }
  };

  // Load entry values when entryWeekStart changes
  useEffect(() => {
    const key = getISOWeekKey(entryWeekStart);
    const saved = visitData[key];
    if (saved) {
      setEntryValues({
        Rehab: { evals: saved.Rehab?.evals ?? "", visits: saved.Rehab?.visits ?? "" },
        Peds:  { evals: saved.Peds?.evals  ?? "", visits: saved.Peds?.visits  ?? "" },
        Acute: { evals: saved.Acute?.evals ?? "", visits: saved.Acute?.visits ?? "" },
      });
    } else {
      setEntryValues({ Rehab:{evals:"",visits:""}, Peds:{evals:"",visits:""}, Acute:{evals:"",visits:""} });
    }
    setSaveMsg(null);
  }, [entryWeekStart, visitData]);

  const saveEntry = () => {
    const key = getISOWeekKey(entryWeekStart);
    const rec = {
      weekStart: entryWeekStart,
      Rehab: { evals: Number(entryValues.Rehab.evals)||0, visits: Number(entryValues.Rehab.visits)||0 },
      Peds:  { evals: Number(entryValues.Peds.evals)||0,  visits: Number(entryValues.Peds.visits)||0  },
      Acute: { evals: Number(entryValues.Acute.evals)||0, visits: Number(entryValues.Acute.visits)||0 },
    };
    updateVisitData({ ...visitData, [key]: rec });
    setSaveMsg("✓ Saved");
    setTimeout(() => setSaveMsg(null), 2000);
  };

  const setVal = (team, field, val) => {
    setEntryValues(prev => ({ ...prev, [team]: { ...prev[team], [field]: val } }));
    setSaveMsg(null);
  };

  // Get weeks within view range
  const viewWeeks = useMemo(() => {
    const weeks = [];
    const s = new Date(viewStart+"T12:00:00");
    const e = new Date(viewEnd+"T12:00:00");
    if (isNaN(s)||isNaN(e)) return weeks;
    // collect all Sunday-starting weeks in range
    const cur = new Date(s); cur.setDate(cur.getDate()-cur.getDay()); // go to Sunday
    while (cur <= e) {
      const wStart = fmt(cur);
      const wEnd = new Date(cur); wEnd.setDate(wEnd.getDate()+6);
      const key = getISOWeekKey(wStart);
      const rec = visitData[key];
      if (rec) weeks.push({ key, wStart, wEnd: fmt(wEnd), rec });
      cur.setDate(cur.getDate()+7);
    }
    return weeks.sort((a,b) => a.wStart.localeCompare(b.wStart));
  }, [viewStart, viewEnd, visitData]);

  // Aggregate metrics for view range
  const metrics = useMemo(() => {
    let totalEvals=0, totalVisits=0;
    const byTeam = {
      Rehab: {evals:0, visits:0, fte:0},
      Peds:  {evals:0, visits:0, fte:0},
      Acute: {evals:0, visits:0, fte:0},
    };
    let workDays = 0;
    let totalFTE = 0; // sum of daily FTE across all days (incl. weekends)
    viewWeeks.forEach(({wStart, wEnd, rec}) => {
      TEAMS.forEach(t => {
        byTeam[t].evals  += rec[t]?.evals  || 0;
        byTeam[t].visits += rec[t]?.visits || 0;
        totalEvals  += rec[t]?.evals  || 0;
        totalVisits += rec[t]?.visits || 0;
      });
      // Walk all 7 days — dept runs 7-day schedule including weekends
      const cur2 = new Date(wStart+"T12:00:00");
      for (let di=0; di<7; di++, cur2.setDate(cur2.getDate()+1)) {
        const ds2 = fmt(cur2);
        if (ds2 < viewStart || ds2 > viewEnd) continue;
        workDays++;
        const fte = getDayFTE ? getDayFTE(ds2) : null;
        if (fte) {
          totalFTE += Number(fte.total)||0;
          TEAMS.forEach(t => { byTeam[t].fte += Number(fte.byTeam?.[t])||0; });
        }
      }
    });
    const avgFTEPerDay = workDays > 0 ? totalFTE / workDays : 0;
    const avgVisitsPerFTEDay = totalFTE > 0 ? totalVisits / totalFTE : 0;
    const avgVisitsPerDay = workDays > 0 ? totalVisits / workDays : 0;
    // Per-team visits/FTE/day and forecast
    TEAMS.forEach(t => {
      byTeam[t].visitsPerFTEDay = byTeam[t].fte > 0 ? byTeam[t].visits / byTeam[t].fte : 0;
      byTeam[t].avgFTEPerDay = workDays > 0 ? byTeam[t].fte / workDays : 0;
      byTeam[t].forecastPerPerson = byTeam[t].visitsPerFTEDay * ANNUAL_WORK_DAYS;
      const tGoal = TEAM_VISIT_GOALS[t];
      byTeam[t].visitDayTarget = tGoal?.visitsPerFTEDay || VISIT_GOAL_PER_PERSON / ANNUAL_WORK_DAYS;
      byTeam[t].annualTarget   = tGoal?.annualPerPerson || VISIT_GOAL_PER_PERSON;
      byTeam[t].goalPct = byTeam[t].annualTarget > 0 ? (byTeam[t].forecastPerPerson / byTeam[t].annualTarget * 100) : 0;
    });
    const staffCount = staff.length || 1;
    const forecastPerPerson = avgVisitsPerFTEDay * ANNUAL_WORK_DAYS;
    const annualForecast = forecastPerPerson * (avgFTEPerDay || staffCount);
    const goalPct = VISIT_GOAL_PER_PERSON > 0 ? (forecastPerPerson/VISIT_GOAL_PER_PERSON)*100 : 0;
    const hasFTEData = avgFTEPerDay > 0;
    return { totalEvals, totalVisits, byTeam, workDays, avgVisitsPerDay, avgVisitsPerFTEDay, avgFTEPerDay, totalFTE, annualForecast, forecastPerPerson, goalPct, staffCount, weeksWithData: viewWeeks.length, hasFTEData };
  }, [viewWeeks, staff, viewStart, viewEnd, getDayFTE]);

  const entryWeekEnd = (() => { const d = new Date(entryWeekStart+"T12:00:00"); d.setDate(d.getDate()+6); return fmt(d); })();
  const goalColor = metrics.goalPct >= 100 ? "#15803d" : metrics.goalPct >= 80 ? "#d97706" : "#dc2626";
  const goalBg    = metrics.goalPct >= 100 ? "#f0fdf4" : metrics.goalPct >= 80 ? "#fffbeb" : "#fef2f2";

  return (
    <div style={{display:"grid",gap:18}}>

      {/* ── Entry hint banner ── */}
      <div style={{background:"#eff6ff",borderRadius:10,padding:"10px 16px",border:"1px solid #bfdbfe",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
        <div style={{fontSize:12,color:"#1e40af"}}>
          <b>📝 Enter visit data</b> via the <b>☰ Menu → Enter Visit Data</b>
          {saveMsg && <span style={{marginLeft:10,color:"#15803d",fontWeight:700}}>{saveMsg}</span>}
        </div>
        <div style={{fontSize:11,color:"#6b7280"}}>
          Last entry: {Object.keys(visitData).length > 0
            ? (() => { const keys = Object.keys(visitData).sort().reverse(); const rec = visitData[keys[0]]; return new Date((rec.weekStart||keys[0].replace("week_",""))+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); })()
            : "none yet"}
        </div>
      </div>

      {/* ── Date Range for Analytics ── */}
      <div style={{background:"#fff",borderRadius:14,padding:14,border:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#1e3a5f",flexShrink:0}}>📅 View Range</div>
        <div style={{display:"flex",gap:4,background:"#f1f5f9",borderRadius:8,padding:3}}>
          {[["lastweek","Last Week"],["month","28 Days"],["quarter","Quarter"],["ytd","YTD"],["year","Full Year"]].map(([v,l])=>(
            <button key={v} onClick={()=>applyQuick(v)} style={{
              padding:"4px 11px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
              background:quickRange===v?"#fff":"transparent",color:quickRange===v?"#1e3a5f":"#6b7280",
              boxShadow:quickRange===v?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>{l}</button>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <input type="date" value={viewStart} onChange={e=>{setViewStart(e.target.value);setQuickRange("custom");}}
            style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12,fontWeight:600,color:"#374151"}} />
          <span style={{fontSize:12,color:"#9ca3af"}}>to</span>
          <input type="date" value={viewEnd} onChange={e=>{setViewEnd(e.target.value);setQuickRange("custom");}}
            style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12,fontWeight:600,color:"#374151"}} />
        </div>
        <div style={{fontSize:11,color:"#9ca3af",marginLeft:"auto"}}>{metrics.weeksWithData} weeks with data · {metrics.workDays} days · {metrics.hasFTEData ? `avg ${metrics.avgFTEPerDay.toFixed(1)} FTE/day` : ""}</div>
      </div>

      {/* ── Key Metrics ── */}
      {metrics.weeksWithData === 0 ? (
        <div style={{background:"#fff",borderRadius:14,padding:32,border:"1px solid #e5e7eb",textAlign:"center",color:"#9ca3af",fontSize:13}}>
          No visit data in this range yet. Enter data above and it will appear here.
        </div>
      ) : (<>

        {/* Annual forecast banner */}
        <div style={{background:"linear-gradient(135deg,#1e3a5f,#1e40af)",borderRadius:14,padding:20,color:"#fff"}}>
          <div style={{fontSize:11,color:"#93c5fd",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>
            Annual Forecast — based on {metrics.workDays} work days · avg FTE {metrics.hasFTEData ? metrics.avgFTEPerDay.toFixed(1) : "(no FTE data)"}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:20,marginTop:8}}>
            <div>
              <div style={{fontSize:11,color:"#93c5fd"}}>
                {metrics.hasFTEData ? "Avg Visits / FTE / Day" : "Avg Visits / Day"}
              </div>
              <div style={{fontSize:36,fontWeight:800}}>
                {metrics.hasFTEData ? metrics.avgVisitsPerFTEDay.toFixed(2) : metrics.avgVisitsPerDay.toFixed(1)}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:"#93c5fd"}}>Projected Annual Total</div>
              <div style={{fontSize:36,fontWeight:800}}>{Math.round(metrics.annualForecast).toLocaleString()}</div>
              <div style={{fontSize:10,color:"#93c5fd"}}>
                {metrics.hasFTEData
                  ? `(${metrics.avgVisitsPerFTEDay.toFixed(2)} visits/FTE/day × ${ANNUAL_WORK_DAYS} days × ${metrics.avgFTEPerDay.toFixed(1)} avg FTE)`
                  : `(${metrics.avgVisitsPerDay.toFixed(1)} visits/day × ${ANNUAL_WORK_DAYS} days)`}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:"#93c5fd"}}>Per Therapist / Year</div>
              <div style={{fontSize:36,fontWeight:800,color:metrics.goalPct>=100?"#6ee7b7":metrics.goalPct>=80?"#fde68a":"#fca5a5"}}>
                {Math.round(metrics.forecastPerPerson).toLocaleString()}
              </div>
              <div style={{fontSize:10,color:"#93c5fd"}}>
                {metrics.hasFTEData ? `${metrics.avgVisitsPerFTEDay.toFixed(2)} × ${ANNUAL_WORK_DAYS} days` : `÷ ${metrics.staffCount} staff`}
              </div>
            </div>
            <div style={{background:goalBg,borderRadius:10,padding:"10px 16px",alignSelf:"center"}}>
              <div style={{fontSize:11,color:goalColor,fontWeight:700}}>Dept Goal: {VISIT_GOAL_PER_PERSON.toLocaleString()}/person/yr (weighted avg)</div>
              <div style={{fontSize:28,fontWeight:800,color:goalColor}}>{metrics.goalPct.toFixed(0)}%</div>
              <div style={{height:6,background:goalColor+"22",borderRadius:3,marginTop:6}}>
                <div style={{height:"100%",width:Math.min(metrics.goalPct,100)+"%",background:goalColor,borderRadius:3,transition:"width 0.4s"}} />
              </div>
            </div>
          </div>
        </div>

        {/* Totals by team */}
        <div style={{background:"#fff",borderRadius:14,padding:20,border:"1px solid #e5e7eb"}}>
          <div style={{fontSize:14,fontWeight:800,color:"#1e3a5f",marginBottom:14}}>Totals by Department</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
            {VISIT_ORDER.map(t => {
              const tc = TEAM_COLORS[t]; const d = metrics.byTeam[t];
              const pct = metrics.totalVisits > 0 ? ((d.visits/metrics.totalVisits)*100).toFixed(0) : 0;
              const tGoalColor = d.goalPct >= 100 ? "#15803d" : d.goalPct >= 80 ? "#d97706" : "#dc2626";
              const tGoalBg    = d.goalPct >= 100 ? "#f0fdf4" : d.goalPct >= 80 ? "#fffbeb" : "#fef2f2";
              return (
                <div key={t} style={{background:tc.bg,borderRadius:12,padding:16,border:"1px solid "+tc.dot+"44"}}>
                  <div style={{fontSize:11,fontWeight:800,color:tc.text,textTransform:"uppercase",marginBottom:10}}>{t}</div>
                  <div style={{display:"grid",gap:6}}>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{fontSize:11,color:tc.text+"99"}}>Evaluations</span>
                      <span style={{fontSize:15,fontWeight:800,color:tc.text}}>{d.evals.toLocaleString()}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{fontSize:11,color:tc.text+"99"}}>Patient Visits</span>
                      <span style={{fontSize:15,fontWeight:800,color:tc.text}}>{d.visits.toLocaleString()}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{fontSize:11,color:tc.text+"99"}}>Avg FTE/Day</span>
                      <span style={{fontSize:14,fontWeight:700,color:tc.text}}>{metrics.hasFTEData ? d.avgFTEPerDay.toFixed(1) : "—"}</span>
                    </div>
                    <div style={{borderTop:"1px solid "+tc.dot+"22",paddingTop:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,color:tc.text,fontWeight:700}}>Visits/FTE/Day</span>
                      <span style={{fontSize:22,fontWeight:800,color:tc.dot}}>{metrics.hasFTEData ? d.visitsPerFTEDay.toFixed(2) : "—"}</span>
                    </div>
                    {metrics.hasFTEData && (
                      <div style={{background:tGoalBg,borderRadius:6,padding:"5px 8px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                          <span style={{fontSize:10,color:tGoalColor,fontWeight:600}}>Forecast/person/yr</span>
                          <span style={{fontSize:13,fontWeight:800,color:tGoalColor}}>{Math.round(d.forecastPerPerson).toLocaleString()}</span>
                        </div>
                        <div style={{height:4,background:tGoalColor+"22",borderRadius:2}}>
                          <div style={{height:"100%",width:Math.min(d.goalPct,100)+"%",background:tGoalColor,borderRadius:2,transition:"width 0.4s"}} />
                        </div>
                        <div style={{fontSize:10,color:tGoalColor,textAlign:"right",marginTop:2}}>{d.goalPct.toFixed(0)}% of {d.annualTarget?.toLocaleString()} goal ({d.visitDayTarget?.toFixed(1)} v/FTE/day)</div>
                      </div>
                    )}
                    <div style={{height:3,background:tc.dot+"22",borderRadius:2,marginTop:2}}>
                      <div style={{height:"100%",width:pct+"%",background:tc.dot,borderRadius:2}} />
                    </div>
                    <div style={{fontSize:10,color:tc.text+"88",textAlign:"right"}}>{pct}% of dept visits</div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Dept totals row */}
          <div style={{background:"#f8fafc",borderRadius:10,padding:"12px 16px",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,border:"1px solid #e5e7eb"}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Total Evals</div>
              <div style={{fontSize:24,fontWeight:800,color:"#1e3a5f"}}>{metrics.totalEvals.toLocaleString()}</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Total Visits</div>
              <div style={{fontSize:24,fontWeight:800,color:"#1e3a5f"}}>{metrics.totalVisits.toLocaleString()}</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>Total Visits (incl. Evals)</div>
              <div style={{fontSize:24,fontWeight:800,color:"#0ea5e9"}}>{metrics.totalVisits.toLocaleString()}</div>
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:10,color:"#6b7280",fontWeight:600,textTransform:"uppercase"}}>
                {metrics.hasFTEData ? "Visits/FTE/Day" : "Visits/Day"}
              </div>
              <div style={{fontSize:24,fontWeight:800,color:"#7c3aed"}}>
                {metrics.hasFTEData ? metrics.avgVisitsPerFTEDay.toFixed(2) : metrics.avgVisitsPerDay.toFixed(1)}
              </div>
            </div>
          </div>
        </div>

        {/* Weekly history table */}
        <div style={{background:"#fff",borderRadius:14,padding:20,border:"1px solid #e5e7eb"}}>
          <div style={{fontSize:14,fontWeight:800,color:"#1e3a5f",marginBottom:14}}>Weekly History</div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{borderBottom:"2px solid #e5e7eb"}}>
                  <th style={{textAlign:"left",padding:"6px 10px",fontWeight:700,color:"#374151",fontSize:11}}>Week</th>
                  {VISIT_ORDER.map(t=><th key={t} colSpan={2} style={{textAlign:"center",padding:"6px 8px",fontWeight:700,color:TEAM_COLORS[t].text,fontSize:11,background:TEAM_COLORS[t].bg}}>{t}</th>)}
                  <th style={{textAlign:"center",padding:"6px 8px",fontWeight:700,color:"#374151",fontSize:11}}>Total Evals</th>
                  <th style={{textAlign:"center",padding:"6px 8px",fontWeight:700,color:"#374151",fontSize:11}}>Total Visits</th>
                  <th style={{textAlign:"center",padding:"6px 8px",fontWeight:700,color:"#7c3aed",fontSize:11}}>V/FTE/Day</th>
                </tr>
                <tr style={{borderBottom:"1px solid #f3f4f6"}}>
                  <th style={{padding:"2px 10px"}} />
                  {VISIT_ORDER.map(t=>[
                    <th key={t+"e"} style={{textAlign:"center",padding:"2px 6px",fontWeight:600,color:TEAM_COLORS[t].text+"99",fontSize:10,background:TEAM_COLORS[t].bg+"66"}}>Eval</th>,
                    <th key={t+"v"} style={{textAlign:"center",padding:"2px 6px",fontWeight:600,color:TEAM_COLORS[t].text+"99",fontSize:10,background:TEAM_COLORS[t].bg+"66"}}>Visit</th>
                  ])}
                  <th /><th /><th />
                </tr>
              </thead>
              <tbody>
                {[...viewWeeks].reverse().map(({key, wStart, wEnd, rec}) => {
                  const weekTotal = TEAMS.reduce((a,t)=>(rec[t]?.evals||0)+(rec[t]?.visits||0)+a,0);
                  const weekVisits = TEAMS.reduce((a,t)=>(rec[t]?.visits||0)+a,0);
                  const weekEvals  = TEAMS.reduce((a,t)=>(rec[t]?.evals||0)+a,0);
                  // Sum FTE across the 5 weekdays of this week
                  const weekFTETotal = (() => {
                    if (!getDayFTE) return 0;
                    let s = 0;
                    for (let di=0; di<7; di++) {
                      const dObj = new Date(wStart+"T12:00:00"); dObj.setDate(dObj.getDate()+di);
                      s += Number(getDayFTE(fmt(dObj)).total)||0; // all 7 days
                    }
                    return s;
                  })();
                  const vPerDay = weekFTETotal > 0 ? (weekVisits/weekFTETotal).toFixed(2) : (weekVisits/7).toFixed(1);
                  return (
                    <tr key={key} style={{borderBottom:"1px solid #f9fafb"}}
                      onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
                      onMouseLeave={e=>e.currentTarget.style.background=""}>
                      <td style={{padding:"7px 10px",fontWeight:600,color:"#374151",whiteSpace:"nowrap"}}>
                        {new Date(wStart+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})}–
                        {new Date(wEnd+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
                      </td>
                      {VISIT_ORDER.map(t=>[
                        <td key={t+"e"} style={{textAlign:"center",padding:"7px 6px",color:TEAM_COLORS[t].text,fontWeight:600}}>{rec[t]?.evals||0}</td>,
                        <td key={t+"v"} style={{textAlign:"center",padding:"7px 6px",color:TEAM_COLORS[t].text,fontWeight:700}}>{rec[t]?.visits||0}</td>
                      ])}
                      <td style={{textAlign:"center",padding:"7px 8px",fontWeight:700,color:"#1e3a5f"}}>{weekEvals}</td>
                      <td style={{textAlign:"center",padding:"7px 8px",fontWeight:700,color:"#1e3a5f"}}>{weekVisits}</td>
                      <td style={{textAlign:"center",padding:"7px 8px",fontWeight:800,color:"#7c3aed"}}>{vPerDay}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>)}
    </div>
  );
}

// ─── Visit Entry Modal ────────────────────────────────────────────────────────
function VisitEntryModal({ visitData, updateVisitData, staff, weekStart, getDayFTE, onClose }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const thisSun = new Date(today); thisSun.setDate(today.getDate() - today.getDay());
  const lastSun = new Date(thisSun); lastSun.setDate(thisSun.getDate() - 7);
  const [entryWeekStart, setEntryWeekStart] = useState(() => fmt(lastSun));
  const [entryValues, setEntryValues] = useState({ Rehab:{evals:"",visits:""}, Peds:{evals:"",visits:""}, Acute:{evals:"",visits:""} });
  const [saveMsg, setSaveMsg] = useState(null);

  const entryWeekEnd = (() => { const d = new Date(entryWeekStart+"T12:00:00"); d.setDate(d.getDate()+6); return fmt(d); })();

  useEffect(() => {
    const key = getISOWeekKey(entryWeekStart);
    const saved = visitData[key];
    if (saved) {
      setEntryValues({
        Rehab: { evals: saved.Rehab?.evals ?? "", visits: saved.Rehab?.visits ?? "" },
        Peds:  { evals: saved.Peds?.evals  ?? "", visits: saved.Peds?.visits  ?? "" },
        Acute: { evals: saved.Acute?.evals ?? "", visits: saved.Acute?.visits ?? "" },
      });
    } else {
      setEntryValues({ Rehab:{evals:"",visits:""}, Peds:{evals:"",visits:""}, Acute:{evals:"",visits:""} });
    }
    setSaveMsg(null);
  }, [entryWeekStart, visitData]);

  const setVal = (team, field, val) => {
    setEntryValues(prev => ({ ...prev, [team]: { ...prev[team], [field]: val } }));
    setSaveMsg(null);
  };

  const saveEntry = () => {
    const key = getISOWeekKey(entryWeekStart);
    const rec = {
      weekStart: entryWeekStart,
      Rehab: { evals: Number(entryValues.Rehab.evals)||0, visits: Number(entryValues.Rehab.visits)||0 },
      Peds:  { evals: Number(entryValues.Peds.evals)||0,  visits: Number(entryValues.Peds.visits)||0  },
      Acute: { evals: Number(entryValues.Acute.evals)||0, visits: Number(entryValues.Acute.visits)||0 },
    };
    updateVisitData({ ...visitData, [key]: rec });
    setSaveMsg("✓ Saved");
    setTimeout(() => setSaveMsg(null), 2000);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:24,width:520,boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:16,fontWeight:800,color:"#1e3a5f"}}>📝 Enter Weekly Visits</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        {/* Week picker */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,padding:"8px 12px",background:"#f8fafc",borderRadius:9,border:"1px solid #e5e7eb"}}>
          <span style={{fontSize:12,color:"#6b7280",fontWeight:600}}>Week of:</span>
          <input type="date" value={entryWeekStart}
            onChange={e=>{ if(e.target.value){ const d=new Date(e.target.value+"T12:00:00"); d.setDate(d.getDate()-d.getDay()); setEntryWeekStart(fmt(d)); }}}
            style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12,fontWeight:600,color:"#374151"}} />
          <span style={{fontSize:11,color:"#9ca3af"}}>
            {new Date(entryWeekStart+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})}–{new Date(entryWeekEnd+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
          </span>
        </div>

        {/* Team entry cards — compact */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:14}}>
          {VISIT_ORDER.map(t => {
            const tc = TEAM_COLORS[t];
            return (
              <div key={t} style={{background:tc.bg,borderRadius:10,padding:"10px 12px",border:"1px solid "+tc.dot+"44"}}>
                <div style={{fontSize:11,fontWeight:800,color:tc.text,textTransform:"uppercase",marginBottom:8}}>{t}</div>
                <div style={{display:"grid",gap:6}}>
                  <div>
                    <label style={{display:"block",fontSize:9,fontWeight:700,color:tc.text+"99",textTransform:"uppercase",marginBottom:3}}>Evals</label>
                    <input type="number" min="0" value={entryValues[t].evals}
                      onChange={e=>setVal(t,"evals",e.target.value)} placeholder="0"
                      style={{width:"100%",padding:"5px 6px",borderRadius:6,border:"1px solid "+tc.dot+"55",fontSize:15,fontWeight:800,color:tc.text,background:"rgba(255,255,255,0.8)",textAlign:"center"}} />
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:9,fontWeight:700,color:tc.text+"99",textTransform:"uppercase",marginBottom:3}}>Visits</label>
                    <input type="number" min="0" value={entryValues[t].visits}
                      onChange={e=>setVal(t,"visits",e.target.value)} placeholder="0"
                      style={{width:"100%",padding:"5px 6px",borderRadius:6,border:"1px solid "+tc.dot+"55",fontSize:15,fontWeight:800,color:tc.text,background:"rgba(255,255,255,0.8)",textAlign:"center"}} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <button onClick={saveEntry} style={{padding:"9px 24px",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>
            Save Week
          </button>
          {saveMsg && <span style={{fontSize:13,fontWeight:700,color:"#15803d"}}>{saveMsg}</span>}
          <div style={{marginLeft:"auto",fontSize:11,color:"#6b7280"}}>
            Dept: <b style={{color:"#1e3a5f"}}>{VISIT_ORDER.reduce((a,t)=>(Number(entryValues[t].visits)||0)+a,0)}</b> visits
            <span style={{marginLeft:6,color:"#9ca3af"}}>({VISIT_ORDER.reduce((a,t)=>(Number(entryValues[t].evals)||0)+a,0)} evals)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Staff Tab ────────────────────────────────────────────────────────────────
// defaultSchedule: [{day:0-6, team, hours}]  (day 0=Sun)
function StaffTab({ staff, updateStaff, entries, updateEntries, weekStart, nonWorkTypes, ptoBalances, updatePtoBalances, ptoAlerts }) {
  const [newName, setNewName] = useState("");
  const [newTeam, setNewTeam] = useState(TEAMS[0]);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState("");

  const add = () => {
    if (!newName.trim()) return;
    const id = Date.now();
    updateStaff([...staff, {
      id, name: newName.trim(), team: newTeam, fte: 1.0, defaultHours: 8,
      shiftStart: "08:00", shiftEnd: "16:00",
      defaultSchedule: DAYS.map((_,i) => ({ day: i, team: newTeam, hours: i===0||i===6 ? 0 : 8 }))
    }]);
    setNewName("");
  };
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const remove = id => setConfirmDelete(id);
  const confirmRemove = () => { updateStaff(staff.filter(s => s.id !== confirmDelete)); setConfirmDelete(null); };
  const update = (id, field, value) => updateStaff(staff.map(s => s.id === id ? { ...s, [field]: value } : s));
  const archiveStaff = (id) => updateStaff(staff.map(s => s.id === id ? { ...s, archived: true } : s));
  const unarchiveStaff = (id) => updateStaff(staff.map(s => s.id === id ? { ...s, archived: false } : s));
  const archivedCount = staff.filter(s => s.archived).length;

  // Calc weekly hours from actual entries for current week
  const weekDates = getWeekDates(weekStart);
  const getWeeklyHours = (staffId) => {
    let total = 0;
    weekDates.forEach(date => {
      const raw = entries[`${staffId}_${fmt(date)}`];
      const segs = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
      segs.forEach(e => { total += Number(e.hours) || 0; });
    });
    return total;
  };

  // Compute all-time non-work totals for a staff member across all entries
  const getNonWorkSummary = (staffId) => {
    const totals = {};
    Object.entries(entries).forEach(([key, val]) => {
      if (!key.startsWith(staffId + "_")) return;
      const segs = Array.isArray(val) ? val : (val ? [val] : []);
      segs.forEach(e => {
        if (e.nonWork) {
          const hrs = Number(e.nonWorkHours) || Number(e.hours) || 8;
          totals[e.nonWork] = (totals[e.nonWork] || 0) + hrs;
        }
      });
    });
    return totals;
  };

  // Date range of entries for a staff member
  const getEntryDateRange = (staffId) => {
    const keys = Object.keys(entries).filter(k => k.startsWith(staffId + "_"));
    if (!keys.length) return null;
    const dates = keys.map(k => k.split("_")[1]).filter(Boolean).sort();
    return { from: dates[0], to: dates[dates.length - 1] };
  };

  const [nwOpenId, setNwOpenId] = useState(null); // which staff has time-off panel open
  const [carryFwdId, setCarryFwdId] = useState(null);
  const [carryFwdWeeks, setCarryFwdWeeks] = useState(4);

  // Carry forward: apply default schedule for N weeks from today
  // updateEntries is passed as a prop so we can properly persist
  const applyCarryForward = (s) => {
    const sched = s.defaultSchedule || DAYS.map((_,i) => ({ day: i, team: s.team, hours: i===0||i===6?0:8 }));
    const today = new Date(); today.setHours(0,0,0,0);
    const ws = startOfWeek(today);
    const newEntries = { ...entries };
    let filled = 0;
    for (let w = 0; w < carryFwdWeeks; w++) {
      const weekStart2 = new Date(ws); weekStart2.setDate(weekStart2.getDate() + w * 7);
      sched.forEach((dayEntry, di) => {
        const date = new Date(weekStart2); date.setDate(date.getDate() + di);
        const ds2 = fmt(date);
        const key = `${s.id}_${ds2}`;
        const existing = newEntries[key];
        const hasData = existing && Array.isArray(existing) && existing.some(e => Number(e.hours) > 0);
        if (!hasData && Number(dayEntry.hours) > 0) {
          newEntries[key] = [{ hours: Number(dayEntry.hours), team: dayEntry.team || s.team, nonWork: "", nonWorkHours: 0 }];
          filled++;
        }
      });
    }
    updateEntries(newEntries);
    setCarryFwdId(null);
    alert(`Done! Applied ${filled} day entries for ${s.name} over ${carryFwdWeeks} weeks.`);
  };

  const getPTOBalance = (staffId) => ptoBalances[staffId] || { VAC: 80, SICK: 40 };
  const setPTOBalance = (staffId, code, val) => {
    const cur = getPTOBalance(staffId);
    updatePtoBalances({ ...ptoBalances, [staffId]: { ...cur, [code]: Number(val) } });
  };

  const filtered = sortByName(staff.filter(s => {
    if (s.archived && !showArchived) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Add bar */}
      <div style={{ background: "#fff", borderRadius: 12, padding: 18, border: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#1e3a5f", marginBottom: 12 }}>Add Staff Member</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full name"
            onKeyDown={e => e.key === "Enter" && add()}
            style={{ ...inp, flex: 1, minWidth: 160, padding: "7px 12px" }} />
          <select value={newTeam} onChange={e => setNewTeam(e.target.value)}
            style={{ ...sel, width: 160, padding: "7px 12px" }}>
            {TEAMS.map(t => <option key={t}>{t}</option>)}
          </select>
          <button onClick={add} style={{ padding: "7px 18px", borderRadius: 8, background: "#1e3a5f", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>+ Add</button>
        </div>
      </div>

      {/* Confirm delete modal */}
      {confirmDelete && (() => {
        const s = staff.find(x => x.id === confirmDelete);
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000 }} onClick={() => setConfirmDelete(null)}>
            <div style={{ background: "#fff", borderRadius: 16, padding: 28, width: 360, boxShadow: "0 25px 60px rgba(0,0,0,0.22)", textAlign: "center" }} onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
              <div style={{ fontSize: 17, fontWeight: 800, color: "#111827", marginBottom: 6 }}>Delete {s?.name}?</div>
              <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 22 }}>This will <b>permanently delete</b> {s?.name} from the system. If you want to keep their history, use Archive instead.</div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setConfirmDelete(null)} style={{ flex: 1, padding: "10px", borderRadius: 9, background: "#f3f4f6", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                <button onClick={confirmRemove} style={{ flex: 1, padding: "10px", borderRadius: 9, background: "#dc2626", color: "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Yes, Delete</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Search + archived toggle */}
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search staff..."
          style={{...inp,flex:1,padding:"8px 14px",background:"#fff"}} />
        {archivedCount > 0 && (
          <button onClick={()=>setShowArchived(v=>!v)} style={{
            padding:"8px 14px",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",
            background:showArchived?"#fef9c3":"#f3f4f6",
            border:"1px solid "+(showArchived?"#fbbf24":"#e5e7eb"),
            color:showArchived?"#92400e":"#6b7280"}}>
            {showArchived?"▲ Hide Archived":`📦 Archived (${archivedCount})`}
          </button>
        )}
      </div>

      {/* Staff cards */}
      <div style={{ display: "grid", gap: 8 }}>
        {filtered.map(s => {
          const tc = TEAM_COLORS[s.team];
          const isOpen = editingId === s.id;
          const sched = s.defaultSchedule || DAYS.map((_,i) => ({ day: i, team: s.team, hours: i===0||i===6?0:8 }));
          const actualHrs = getWeeklyHours(s.id);
          const schedHrs = sched.reduce((a, d) => a + (Number(d.hours) || 0), 0);
          const weeklyHrs = actualHrs > 0 ? actualHrs : schedHrs;
          const autoFTE = +(weeklyHrs / 40).toFixed(2);

          return (
            <div key={s.id} style={{ background:s.archived?"#f9fafb":"#fff", borderRadius:12, border:"1px solid #e5e7eb", overflow:"hidden", boxShadow:"0 1px 3px rgba(0,0,0,0.04)", opacity:s.archived?0.75:1 }}>
              {s.archived && (
                <div style={{background:"#f3f4f6",borderBottom:"1px solid #e5e7eb",padding:"4px 16px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#6b7280"}}>📦 Archived — hidden from all scheduling views</span>
                  <button onClick={()=>unarchiveStaff(s.id)} style={{fontSize:11,fontWeight:700,color:"#1d4ed8",background:"none",border:"none",cursor:"pointer",padding:"2px 6px",textDecoration:"underline"}}>↩ Restore to Active</button>
                </div>
              )}
              {/* Main row */}
              <div style={{ padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <div style={{ position:"relative", flexShrink:0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: tc?.dot }} />
                  {ptoAlerts && ptoAlerts.some(a=>a.staffId===s.id) && (
                    <div style={{ position:"absolute", top:-3, right:-3, width:7, height:7, borderRadius:"50%",
                      background: ptoAlerts.some(a=>a.staffId===s.id&&a.overBy>0) ? "#ef4444" : "#f59e0b",
                      border:"1px solid #fff" }} />
                  )}
                </div>
                {/* Editable name */}
                <input
                  value={s.name}
                  onChange={e => update(s.id, "name", e.target.value)}
                  style={{ fontSize: 13, fontWeight: 700, border: "none", background: "transparent", outline: "none", color: "#111827", width: "100%", minWidth: 140, flex: 1 }}
                />
                {/* Team */}
                <select value={s.team} onChange={e => update(s.id, "team", e.target.value)}
                  style={{ fontSize: 11, padding: "3px 7px", borderRadius: 6, border: "1px solid #e5e7eb", background: tc?.bg, color: tc?.text, fontWeight: 600, cursor: "pointer" }}>
                  {TEAMS.map(t => <option key={t}>{t}</option>)}
                </select>
                {/* Weekly hrs */}
                <div style={{ textAlign: "center", minWidth: 64 }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase" }}>Wk Hrs</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1e3a5f" }}>{weeklyHrs}h</div>
                  <div style={{ fontSize: 9, color: actualHrs > 0 ? "#15803d" : "#9ca3af" }}>{actualHrs > 0 ? "actual" : "sched"}</div>
                </div>
                {/* Auto FTE */}
                <div style={{ textAlign: "center", minWidth: 54 }}>
                  <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase" }}>FTE</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: autoFTE >= 1 ? "#15803d" : autoFTE >= 0.5 ? "#d97706" : "#dc2626" }}>{autoFTE}</div>
                </div>
                {/* Shift times */}
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input type="time" value={s.shiftStart || "08:00"} onChange={e => update(s.id, "shiftStart", e.target.value)}
                    style={{ fontSize: 11, padding: "3px 5px", borderRadius: 6, border: "1px solid #e5e7eb", width: 86 }} />
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>–</span>
                  <input type="time" value={s.shiftEnd || "16:00"} onChange={e => update(s.id, "shiftEnd", e.target.value)}
                    style={{ fontSize: 11, padding: "3px 5px", borderRadius: 6, border: "1px solid #e5e7eb", width: 86 }} />
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setEditingId(isOpen ? null : s.id)}
                    style={{ background: isOpen ? "#eff6ff" : "#f3f4f6", border: "1px solid " + (isOpen ? "#93c5fd" : "#e5e7eb"), borderRadius: 6, color: isOpen ? "#1d4ed8" : "#6b7280", fontWeight: 700, cursor: "pointer", padding: "3px 10px", fontSize: 11 }}>
                    {isOpen ? "▲ Hide" : "▼ Schedule"}
                  </button>
                  <button onClick={() => setNwOpenId(nwOpenId === s.id ? null : s.id)}
                    style={{ background: nwOpenId === s.id ? "#fef9c3" : "#f3f4f6", border: "1px solid " + (nwOpenId === s.id ? "#fbbf24" : "#e5e7eb"), borderRadius: 6, color: nwOpenId === s.id ? "#92400e" : "#6b7280", fontWeight: 700, cursor: "pointer", padding: "3px 10px", fontSize: 11, whiteSpace: "nowrap" }}>
                    {nwOpenId === s.id ? "▲ Hide" : "📋 Time Off"}
                  </button>
                  <button onClick={() => setCarryFwdId(carryFwdId === s.id ? null : s.id)}
                    title="Apply default schedule forward"
                    style={{ background: carryFwdId===s.id?"#f0fdf4":"#f3f4f6", border:"1px solid "+(carryFwdId===s.id?"#86efac":"#e5e7eb"), borderRadius:6, color:carryFwdId===s.id?"#15803d":"#6b7280", fontWeight:700, cursor:"pointer", padding:"3px 10px", fontSize:11, whiteSpace:"nowrap" }}>
                    {carryFwdId===s.id?"▲ Hide":"📅 Forward"}
                  </button>
                  {s.archived ? (
                    <button onClick={()=>remove(s.id)} title="Permanently delete"
                      style={{background:"#fee2e2",border:"none",borderRadius:6,color:"#dc2626",fontWeight:700,cursor:"pointer",padding:"3px 9px",fontSize:11,whiteSpace:"nowrap"}}>🗑 Delete</button>
                  ) : (
                    <button onClick={()=>archiveStaff(s.id)} title="Archive — hides from scheduling but keeps all history"
                      style={{background:"#f3f4f6",border:"1px solid #e5e7eb",borderRadius:6,color:"#6b7280",fontWeight:700,cursor:"pointer",padding:"3px 9px",fontSize:11,whiteSpace:"nowrap"}}>📦 Archive</button>
                  )}
                </div>
              </div>

              {/* Carry-forward panel */}
              {carryFwdId === s.id && (
                <div style={{ borderTop:"1px solid #f3f4f6", padding:"14px 16px", background:"#f0fdf4" }}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#15803d", marginBottom:10 }}>📅 Apply Default Schedule Forward</div>
                  <div style={{ fontSize:12, color:"#374151", marginBottom:10 }}>Apply {s.name}'s default weekly schedule starting from today for:</div>
                  <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                    {[2,4,8,12,26,52].map(w => (
                      <button key={w} onClick={()=>setCarryFwdWeeks(w)}
                        style={{ padding:"5px 12px", borderRadius:7, border:"1px solid "+(carryFwdWeeks===w?"#22c55e":"#e5e7eb"), background:carryFwdWeeks===w?"#22c55e":"#fff", color:carryFwdWeeks===w?"#fff":"#374151", fontWeight:600, fontSize:12, cursor:"pointer" }}>
                        {w}w
                      </button>
                    ))}
                    <button onClick={()=>applyCarryForward(s)} style={{ marginLeft:"auto", padding:"6px 18px", borderRadius:8, background:"#15803d", color:"#fff", border:"none", fontWeight:700, fontSize:12, cursor:"pointer" }}>
                      Apply →
                    </button>
                  </div>
                  <div style={{ fontSize:11, color:"#6b7280", marginTop:8 }}>Note: This fills in weeks that have no hours yet. Existing entries are not overwritten.</div>
                </div>
              )}

              {/* Non-work summary panel */}
              {nwOpenId === s.id && (() => {
                const summary = getNonWorkSummary(s.id);
                const range = getEntryDateRange(s.id);
                const hasSummary = Object.keys(summary).length > 0;
                const nwMap = Object.fromEntries(nonWorkTypes.map(n => [n.code, n]));
                return (
                  <div style={{ borderTop: "1px solid #f3f4f6", padding: "14px 16px", background: "#fffbeb" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e" }}>
                        📋 Time Off Summary
                      </div>
                      {range && (
                        <div style={{ fontSize: 10, color: "#9ca3af" }}>
                          All entries: {range.from} → {range.to}
                        </div>
                      )}
                    </div>
                    {hasSummary ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                        {nonWorkTypes.map(nw => {
                          const hrs = summary[nw.code] || 0;
                          const days = (hrs / 8).toFixed(1);
                          return (
                            <div key={nw.code} style={{
                              padding: "10px 12px", borderRadius: 9,
                              background: hrs > 0 ? nw.color + "18" : "#f9fafb",
                              border: "1px solid " + (hrs > 0 ? nw.color + "44" : "#f3f4f6"),
                              opacity: hrs > 0 ? 1 : 0.5
                            }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: hrs > 0 ? nw.color : "#9ca3af", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>{nw.label}</div>
                              <div style={{ fontSize: 18, fontWeight: 800, color: hrs > 0 ? nw.color : "#d1d5db" }}>{hrs}h</div>
                              <div style={{ fontSize: 10, color: hrs > 0 ? "#6b7280" : "#d1d5db" }}>{days} day{days !== "1.0" ? "s" : ""}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ padding: "16px 0", textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                        No non-work time recorded for this staff member yet.
                      </div>
                    )}
                    {hasSummary && (
                      <div style={{ marginTop: 10, padding: "8px 12px", background: "#fff", borderRadius: 7, border: "1px solid #fde68a", fontSize: 11, color: "#92400e" }}>
                        Total non-work: <b>{Object.values(summary).reduce((a, b) => a + b, 0)}h</b>
                        {" · "}
                        {(Object.values(summary).reduce((a, b) => a + b, 0) / 8).toFixed(1)} days
                      </div>
                    )}
                    {/* PTO Balance tracking */}
                    <div style={{ marginTop: 12, borderTop: "1px solid #fde68a", paddingTop: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", marginBottom: 8 }}>PTO Balances (Annual Hours)</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
                        {["VAC","SICK"].map(code => {
                          const nw = nonWorkTypes.find(n => n.code === code);
                          if (!nw) return null;
                          const balance = getPTOBalance(s.id)[code] || 0;
                          const used = summary[code] || 0;
                          const remaining = Math.max(0, balance - used);
                          const pct = balance > 0 ? Math.min((used / balance) * 100, 100) : 0;
                          return (
                            <div key={code} style={{ padding:"10px 12px", borderRadius:9, background:"#fff", border:"1px solid "+nw.color+"33" }}>
                              <div style={{ fontSize:10, fontWeight:700, color:nw.color, marginBottom:4 }}>{nw.label} Balance</div>
                              <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                                <span style={{ fontSize:10, color:"#6b7280" }}>Annual:</span>
                                <input type="number" min="0" step="8" value={balance}
                                  onChange={e => setPTOBalance(s.id, code, e.target.value)}
                                  style={{ width:60, border:"1px solid #e5e7eb", borderRadius:5, padding:"1px 5px", fontSize:12, fontWeight:700, textAlign:"center" }} />
                                <span style={{ fontSize:10, color:"#6b7280" }}>h</span>
                              </div>
                              <div style={{ height:5, background:"#f3f4f6", borderRadius:3, marginBottom:4 }}>
                                <div style={{ height:"100%", width:pct+"%", background:pct>80?"#ef4444":pct>60?"#f59e0b":nw.color, borderRadius:3, transition:"width 0.3s" }} />
                              </div>
                              <div style={{ fontSize:10, color:"#6b7280" }}>
                                Used: <b style={{ color:nw.color }}>{used}h</b> · Left: <b style={{ color:remaining<8?"#dc2626":"#15803d" }}>{remaining}h</b>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Custom schedule panel */}
              {isOpen && (
                <div style={{ borderTop: "1px solid #f3f4f6", padding: "14px 16px", background: "#f8fafc" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 10 }}>
                    Default Weekly Schedule
                    <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 400, marginLeft: 8 }}>
                      Set per-day team and hours — used as the template when bulk uploading
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                    {sched.map((dayEntry, di) => {
                      const dayTc = TEAM_COLORS[dayEntry.team || s.team];
                      const isWE = di === 0 || di === 6;
                      return (
                        <div key={di} style={{ borderRadius: 8, border: "1px solid " + (isWE ? "#e9d5ff" : "#e5e7eb"), background: isWE ? "#faf5ff" : "#fff", padding: "8px 6px" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: isWE ? "#7c3aed" : "#6b7280", textAlign: "center", marginBottom: 5, textTransform: "uppercase" }}>{DAYS[di]}</div>
                          <input type="number" min="0" max="24" step="0.5"
                            value={dayEntry.hours === 0 && isWE ? "" : dayEntry.hours}
                            placeholder={isWE ? "OFF" : "8"}
                            onChange={e => {
                              const newSched = sched.map((d, i) => i === di ? { ...d, hours: e.target.value === "" ? 0 : Number(e.target.value) } : d);
                              update(s.id, "defaultSchedule", newSched);
                            }}
                            style={{ width: "100%", padding: "4px 5px", border: "1px solid #e5e7eb", borderRadius: 5, fontSize: 12, textAlign: "center", boxSizing: "border-box", background: isWE ? "#faf5ff" : "#fff" }} />
                          <select
                            value={dayEntry.team || s.team}
                            onChange={e => {
                              const newSched = sched.map((d, i) => i === di ? { ...d, team: e.target.value } : d);
                              update(s.id, "defaultSchedule", newSched);
                            }}
                            style={{ marginTop: 4, width: "100%", padding: "3px 4px", border: "1px solid " + (dayTc?.dot || "#e5e7eb"), borderRadius: 5, fontSize: 9, fontWeight: 600, background: dayTc?.bg || "#f9fafb", color: dayTc?.text || "#374151", boxSizing: "border-box", cursor: "pointer" }}>
                            {TEAMS.map(t => <option key={t}>{t}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11, color: "#6b7280", display: "flex", gap: 16 }}>
                    <span>Schedule total: <b style={{ color: "#1e3a5f" }}>{schedHrs}h</b></span>
                    <span>Schedule FTE: <b style={{ color: schedHrs/40 >= 1 ? "#15803d" : schedHrs/40 >= 0.5 ? "#d97706" : "#dc2626" }}>{(schedHrs/40).toFixed(2)}</b></span>
                    {actualHrs > 0 && <span style={{ color: "#15803d" }}>Actual this week: <b>{actualHrs}h</b></span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Batch Schedule Entry Modal ──────────────────────────────────────────────
function BatchEntryModal({ staff, entries, updateEntries, nonWorkTypes, onClose }) {
  const [step, setStep] = useState("setup"); // setup | preview | done
  const [selectedStaff, setSelectedStaff] = useState([]);
  const [startDate, setStartDate] = useState(fmt(new Date()));
  const [endDate, setEndDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 13); return fmt(d);
  });
  const [entryType, setEntryType] = useState("nonwork"); // nonwork | schedule | off
  const [nonWorkCode, setNonWorkCode] = useState(nonWorkTypes[0]?.code || "VAC");
  const [nonWorkHours, setNonWorkHours] = useState(8);
  const [workTeam, setWorkTeam] = useState(TEAMS[0]);
  const [workHours, setWorkHours] = useState(8);
  const [applyDays, setApplyDays] = useState([1,2,3,4,5]); // 0=Sun, 6=Sat
  const [overwrite, setOverwrite] = useState(false);
  const [comment, setComment] = useState("");
  const [swap, setSwap] = useState(false);
  const [preview, setPreview] = useState([]);

  const toggleDay = d => setApplyDays(prev => prev.includes(d) ? prev.filter(x=>x!==d) : [...prev, d].sort());
  const toggleStaff = id => setSelectedStaff(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  const selectTeam = team => setSelectedStaff(staff.filter(s=>s.team===team).map(s=>s.id));
  const selectAll = () => setSelectedStaff(staff.map(s=>s.id));
  const clearAll = () => setSelectedStaff([]);

  // Generate list of dates in range matching selected days
  const getDatesInRange = () => {
    const dates = [];
    const cur = new Date(startDate + "T12:00:00");
    const end = new Date(endDate + "T12:00:00");
    while (cur <= end) {
      if (applyDays.includes(cur.getDay())) dates.push(fmt(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  };

  const buildPreview = () => {
    const dates = getDatesInRange();
    const rows = [];
    selectedStaff.forEach(sid => {
      const s = staff.find(x=>x.id===sid);
      if (!s) return;
      dates.forEach(ds => {
        const existing = entries[`${sid}_${ds}`];
        const hasData = existing && Array.isArray(existing) && existing.some(e=>Number(e.hours)>0||e.nonWork);
        if (hasData && !overwrite) return; // skip
        rows.push({ staffId: sid, name: s.name, team: s.team, dateStr: ds, hasExisting: hasData });
      });
    });
    setPreview(rows);
    setStep("preview");
  };

  const apply = () => {
    const newEntries = { ...entries };
    preview.forEach(row => {
      let seg;
      if (entryType === "nonwork") {
        seg = [{ hours: 0, team: row.team, nonWork: nonWorkCode, nonWorkHours: Number(nonWorkHours), comment, swap }];
      } else if (entryType === "schedule") {
        seg = [{ hours: Number(workHours), team: workTeam, nonWork: "", nonWorkHours: 0, comment, swap }];
      } else { // off — clear the entry
        newEntries[`${row.staffId}_${row.dateStr}`] = [];
        return;
      }
      newEntries[`${row.staffId}_${row.dateStr}`] = seg;
    });
    updateEntries(newEntries);
    setStep("done");
  };

  const nwInfo = nonWorkTypes.find(n=>n.code===nonWorkCode);
  const dates = getDatesInRange();

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:620,maxHeight:"90vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>📋 Batch Schedule Entry</div>
            <div style={{fontSize:12,color:"#6b7280",marginTop:2}}>Apply a schedule change to multiple staff over a date range</div>
          </div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontWeight:700,fontSize:14}}>✕</button>
        </div>

        {step === "done" && (
          <div style={{textAlign:"center",padding:"30px 0"}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontSize:18,fontWeight:800,color:"#15803d",marginBottom:6}}>Batch applied!</div>
            <div style={{fontSize:13,color:"#6b7280",marginBottom:20}}>{preview.length} entries updated across {selectedStaff.length} staff member{selectedStaff.length!==1?"s":""}.</div>
            <button onClick={onClose} style={{padding:"10px 28px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",fontWeight:700,fontSize:14,cursor:"pointer"}}>Done</button>
          </div>
        )}

        {step === "preview" && (
          <div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:"#374151",marginBottom:4}}>Preview — {preview.length} entries to create</div>
              {overwrite && preview.some(r=>r.hasExisting) && (
                <div style={{padding:"6px 10px",borderRadius:7,background:"#fef2f2",border:"1px solid #fca5a5",fontSize:11,color:"#dc2626",fontWeight:600,marginBottom:8}}>
                  ⚠ {preview.filter(r=>r.hasExisting).length} existing entries will be overwritten
                </div>
              )}
              <div style={{fontSize:12,color:"#6b7280"}}>
                {entryType==="nonwork" && `${nonWorkCode} — ${nonWorkHours}h per day`}
                {entryType==="schedule" && `Working ${workHours}h on ${workTeam}`}
                {entryType==="off" && "Clearing entries (marking as not scheduled)"}
                {" · "}{dates.length} days · {DAYS.filter((_,i)=>applyDays.includes(i)).join(", ")}
              </div>
            </div>

            <div style={{maxHeight:260,overflowY:"auto",border:"1px solid #e5e7eb",borderRadius:10,marginBottom:16}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead>
                  <tr style={{background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>
                    <th style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:"#374151"}}>Staff</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:"#374151"}}>Date</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:"#374151"}}>Entry</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:"#374151"}}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0,100).map((row,i) => {
                    const tc = TEAM_COLORS[row.team];
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #f3f4f6",background:row.hasExisting?"#fff7ed":"#fff"}}>
                        <td style={{padding:"6px 12px",fontWeight:600,color:"#111827"}}>
                          <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:tc?.dot,marginRight:5}} />
                          {row.name}
                        </td>
                        <td style={{padding:"6px 12px",color:"#374151"}}>
                          {new Date(row.dateStr+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}
                        </td>
                        <td style={{padding:"6px 12px"}}>
                          {entryType==="nonwork" && <span style={{padding:"1px 7px",borderRadius:99,background:(nwInfo?.color||"#6b7280")+"22",color:nwInfo?.color||"#6b7280",fontWeight:700,fontSize:11}}>{nonWorkCode} {nonWorkHours}h</span>}
                          {entryType==="schedule" && <span style={{padding:"1px 7px",borderRadius:99,background:tc?.bg,color:tc?.text,fontWeight:700,fontSize:11}}>{workHours}h {workTeam}</span>}
                          {entryType==="off" && <span style={{fontSize:11,color:"#9ca3af"}}>— clear —</span>}
                        </td>
                        <td style={{padding:"6px 12px",fontSize:11,color:row.hasExisting?"#d97706":"#15803d"}}>
                          {row.hasExisting?"⚠ overwrites":"+ new"}
                        </td>
                      </tr>
                    );
                  })}
                  {preview.length > 100 && <tr><td colSpan={4} style={{padding:"8px 12px",textAlign:"center",color:"#9ca3af",fontSize:11}}>...and {preview.length-100} more</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setStep("setup")} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>← Back</button>
              <button onClick={apply} style={{flex:2,padding:"10px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>
                Apply {preview.length} Entries →
              </button>
            </div>
          </div>
        )}

        {step === "setup" && (<>
          {/* Entry type */}
          <div style={{marginBottom:18}}>
            <div style={{fontSize:13,fontWeight:700,color:"#374151",marginBottom:8}}>What are you scheduling?</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {[
                { id:"nonwork", icon:"🏖", label:"Non-Work / Leave", desc:"Vacation, PFL, sick, etc." },
                { id:"schedule", icon:"📅", label:"Schedule Change", desc:"Different team or hours" },
                { id:"off",      icon:"⭕", label:"Not Working",     desc:"Clear / unschedule days" },
              ].map(t => (
                <button key={t.id} onClick={()=>setEntryType(t.id)} style={{
                  padding:"10px 12px",borderRadius:10,border:"2px solid "+(entryType===t.id?"#1e3a5f":"#e5e7eb"),
                  background:entryType===t.id?"#eff6ff":"#f9fafb",cursor:"pointer",textAlign:"left"
                }}>
                  <div style={{fontSize:18,marginBottom:3}}>{t.icon}</div>
                  <div style={{fontSize:12,fontWeight:700,color:"#111827"}}>{t.label}</div>
                  <div style={{fontSize:10,color:"#9ca3af",marginTop:1}}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Entry details */}
          {entryType==="nonwork" && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14,padding:14,background:"#f9fafb",borderRadius:10,border:"1px solid #e5e7eb"}}>
              <div>
                <label style={lbl}>Non-Work Code</label>
                <select value={nonWorkCode} onChange={e=>setNonWorkCode(e.target.value)} style={sel}>
                  {nonWorkTypes.map(n=><option key={n.code} value={n.code}>{n.code} – {n.label}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Hours Per Day</label>
                <input type="number" min="0" max="24" step="0.5" value={nonWorkHours}
                  onChange={e=>setNonWorkHours(e.target.value)} style={inp} />
              </div>
            </div>
          )}
          {entryType==="schedule" && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14,padding:14,background:"#f9fafb",borderRadius:10,border:"1px solid #e5e7eb"}}>
              <div>
                <label style={lbl}>Team / Location</label>
                <select value={workTeam} onChange={e=>setWorkTeam(e.target.value)} style={sel}>
                  {TEAMS.map(t=><option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Hours Per Day</label>
                <input type="number" min="0" max="24" step="0.5" value={workHours}
                  onChange={e=>setWorkHours(e.target.value)} style={inp} />
              </div>
            </div>
          )}

          {/* Comment + swap */}
          <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:10,marginBottom:14,alignItems:"end"}}>
            <div>
              <label style={lbl}>💬 Comment (optional)</label>
              <input value={comment} onChange={e=>setComment(e.target.value)}
                placeholder={entryType==="nonwork"?"e.g. Approved PFL leave":"e.g. Covering Acute during remodel"}
                style={inp} />
            </div>
            {entryType!=="off" && (
              <button onClick={()=>setSwap(!swap)} style={{padding:"8px 12px",borderRadius:8,border:"1px solid "+(swap?"#f59e0b":"#e5e7eb"),background:swap?"#fef9c3":"#f9fafb",color:swap?"#92400e":"#9ca3af",fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>
                ⇄ {swap?"Swap":"Mark Swap"}
              </button>
            )}
          </div>

          {/* Date range */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,color:"#374151",marginBottom:8}}>Date Range</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div><label style={lbl}>Start Date</label><input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={inp} /></div>
              <div><label style={lbl}>End Date</label><input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={inp} /></div>
            </div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}>Apply on which days of the week?</div>
            <div style={{display:"flex",gap:5}}>
              {DAYS.map((d,i)=>(
                <button key={i} onClick={()=>toggleDay(i)} style={{
                  flex:1,padding:"6px 2px",borderRadius:7,border:"1px solid "+(applyDays.includes(i)?"#1e3a5f":"#e5e7eb"),
                  background:applyDays.includes(i)?"#1e3a5f":"#f9fafb",
                  color:applyDays.includes(i)?"#fff":"#6b7280",fontWeight:600,fontSize:11,cursor:"pointer"
                }}>{d}</button>
              ))}
            </div>
            {dates.length > 0 && <div style={{marginTop:6,fontSize:11,color:"#6b7280"}}>{dates.length} days selected ({startDate} → {endDate})</div>}
          </div>

          {/* Staff selection */}
          <div style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:6}}>
              <div style={{fontSize:13,fontWeight:700,color:"#374151"}}>Apply to Staff ({selectedStaff.length} selected)</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                <button onClick={selectAll} style={{fontSize:11,padding:"3px 9px",borderRadius:6,border:"1px solid #e5e7eb",background:"#f9fafb",cursor:"pointer",fontWeight:600}}>All</button>
                <button onClick={clearAll} style={{fontSize:11,padding:"3px 9px",borderRadius:6,border:"1px solid #e5e7eb",background:"#f9fafb",cursor:"pointer",fontWeight:600}}>None</button>
                {TEAMS.map(t=>(
                  <button key={t} onClick={()=>selectTeam(t)} style={{fontSize:11,padding:"3px 9px",borderRadius:6,border:"1px solid "+TEAM_COLORS[t].dot+"55",background:TEAM_COLORS[t].bg,color:TEAM_COLORS[t].text,cursor:"pointer",fontWeight:600}}>{t}</button>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:5,maxHeight:200,overflowY:"auto",border:"1px solid #e5e7eb",borderRadius:10,padding:10}}>
              {sortByName(staff).map(s=>{
                const tc=TEAM_COLORS[s.team];
                const sel2=selectedStaff.includes(s.id);
                return (
                  <button key={s.id} onClick={()=>toggleStaff(s.id)} style={{
                    padding:"5px 10px",borderRadius:7,border:"1px solid "+(sel2?tc.dot:"#e5e7eb"),
                    background:sel2?tc.bg:"#f9fafb",color:sel2?tc.text:"#374151",
                    fontWeight:sel2?700:400,fontSize:12,cursor:"pointer",textAlign:"left",
                    display:"flex",alignItems:"center",gap:5
                  }}>
                    <span style={{width:6,height:6,borderRadius:"50%",background:sel2?tc.dot:"#d1d5db",display:"inline-block",flexShrink:0}} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Overwrite toggle */}
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:18,padding:"8px 12px",background:"#fffbeb",borderRadius:8,border:"1px solid #fde68a"}}>
            <button onClick={()=>setOverwrite(o=>!o)} style={{width:20,height:20,borderRadius:4,border:"2px solid "+(overwrite?"#d97706":"#e5e7eb"),background:overwrite?"#d97706":"#fff",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:12}}>
              {overwrite?"✓":""}
            </button>
            <span style={{fontSize:12,color:"#92400e",fontWeight:600}}>Overwrite existing entries</span>
            <span style={{fontSize:11,color:"#9ca3af"}}>(if unchecked, days that already have data are skipped)</span>
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
            <button onClick={buildPreview} disabled={selectedStaff.length===0||dates.length===0}
              style={{flex:2,padding:"10px",borderRadius:10,background:selectedStaff.length>0&&dates.length>0?"#1e3a5f":"#e5e7eb",color:selectedStaff.length>0&&dates.length>0?"#fff":"#9ca3af",border:"none",cursor:selectedStaff.length>0?"pointer":"not-allowed",fontSize:14,fontWeight:700}}>
              Preview Changes →
            </button>
          </div>
        </>)}
      </div>
    </div>
  );
}

// ─── Backup / Restore Modal ──────────────────────────────────────────────────
function BackupRestoreModal({ onClose, updateStaff, updateEntries, updateDailyStats, updatePtoBalances, updateNonWorkTypes, updateAlertSettings, updateDayNotes, updateVisitData }) {
  const [status, setStatus] = useState(null);
  const fileRef = useRef();

  const restore = async (file) => {
    const XLSX = window.XLSX;
    if (!XLSX) {
      // Try loading on demand
      setStatus({ok:true, msg:"Loading Excel library..."});
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      }).catch(() => {});
      if (!window.XLSX) { setStatus({ok:false, msg:"Could not load Excel library. Check your connection."}); return; }
    }
    const XLSXLib = window.XLSX;
    setStatus({ok:true, msg:"Reading file..."});
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSXLib.read(buf, {type:"array"});
      const sheetData = (name) => {
        const ws = wb.Sheets[name];
        if (!ws) return [];
        return XLSXLib.utils.sheet_to_json(ws, {header:1, defval:""}).slice(1);
      };
      const staffRows = sheetData("Staff");
      if (!staffRows.length) throw new Error("Staff sheet missing or empty — is this a StaffPlan backup file?");
      const newStaff = staffRows.filter(r=>r[0]).map(r => ({
        id:Number(r[0]), name:String(r[1]), team:String(r[2]),
        fte:Number(r[3])||1, defaultHours:Number(r[4])||8,
        shiftStart:r[5]||"08:00", shiftEnd:r[6]||"16:00",
        defaultSchedule:(() => { try { return JSON.parse(r[7]||"[]"); } catch(e) { return []; } })()
      }));
      const entryRows = sheetData("Entries");
      const newEntries = {};
      entryRows.filter(r=>r[0]&&r[1]).forEach(r => {
        try { newEntries[`${r[0]}_${r[1]}`] = JSON.parse(r[2]||"[]"); } catch(e) {}
      });
      const statsRows = sheetData("DailyStats");
      const newDailyStats = {};
      statsRows.filter(r=>r[0]).forEach(r => { try { newDailyStats[r[0]] = JSON.parse(r[1]||"{}"); } catch(e) {} });
      const ptoRows = sheetData("PTO_Balances");
      const newPTO = {};
      ptoRows.filter(r=>r[0]).forEach(r => { const id=String(r[0]); if(!newPTO[id]) newPTO[id]={}; newPTO[id][r[1]]=Number(r[2])||0; });
      const nwRows = sheetData("NonWorkCodes");
      const newNW = nwRows.filter(r=>r[0]).map(r => ({code:String(r[0]),label:String(r[1]),color:String(r[2])||"#6b7280"}));
      const alertRows = sheetData("AlertSettings");
      const newAlerts = {fteTargets:{},censusTargets:{}};
      alertRows.filter(r=>r[0]).forEach(r => {
        const [type,team,key,val] = r;
        if (type==="fte") {
          if (!newAlerts.fteTargets[team]) newAlerts.fteTargets[team]={};
          if (key==="all") { [0,1,2,3,4,5,6].forEach(d=>newAlerts.fteTargets[team][d]=Number(val)); }
          else newAlerts.fteTargets[team][Number(key)]=Number(val);
        } else if (type==="census") { newAlerts.censusTargets[team]=Number(val); }
      });
      const notesRows = sheetData("DayNotes");
      const newNotes = {};
      notesRows.filter(r=>r[0]).forEach(r => { newNotes[r[0]]=String(r[1]); });
      // Restore visit data (sheet added in backup version 2)
      const visitRows2 = sheetData("VisitData");
      const newVisits = {};
      visitRows2.filter(r => r[2]).forEach(r => {
        let [key, weekStart, team, evals, visits] = r;
        if (!team) return;
        // Normalize old-format keys (YYYY-WNN_YYYY-MM-DD) to new format (week_YYYY-MM-DD)
        if (key && String(key).includes("_")) {
          const datePart = String(key).split("_").pop();
          if (datePart && datePart.match(/^\d{4}-\d{2}-\d{2}$/)) key = "week_" + datePart;
        }
        // If key is missing but weekStart exists, derive it
        if (!key && weekStart) {
          const d = new Date(String(weekStart)+"T12:00:00");
          if (!isNaN(d)) { d.setDate(d.getDate()-d.getDay()); key = "week_"+fmt(d); }
        }
        if (!key) return;
        weekStart = weekStart || key.replace("week_","");
        if (!newVisits[key]) newVisits[key] = { weekStart: String(weekStart) };
        newVisits[key][String(team)] = { evals: Number(evals)||0, visits: Number(visits)||0 };
      });
      const finalNW     = newNW.length ? newNW : null;
      const finalAlerts = Object.keys(newAlerts.fteTargets).length ? newAlerts : null;
      const finalVisits = Object.keys(newVisits).length ? newVisits : {};
      // Save ALL keys directly via saveToStorage (handles both Claude and localStorage)
      // and await every promise so nothing races or gets overwritten
      await Promise.all([
        saveToStorage("staffplan:staff",        newStaff),
        saveToStorage("staffplan:entries",      newEntries),
        saveToStorage("staffplan:dailyStats",   newDailyStats),
        saveToStorage("staffplan:pto",          newPTO),
        saveToStorage("staffplan:notes",        newNotes),
        saveToStorage("staffplan:visits",       finalVisits),
        finalNW     ? saveToStorage("staffplan:nonWorkTypes", finalNW)     : Promise.resolve(),
        finalAlerts ? saveToStorage("staffplan:alerts",       finalAlerts) : Promise.resolve(),
      ]);
      // Update React state AFTER storage is confirmed written.
      // isRestoringRef suppresses triggerSave so state updates don't overwrite storage.
      // Pass flag setter via a custom event since modal doesn't have direct ref access.
      window.__staffplanRestoring = true;
      updateStaff(newStaff);
      updateEntries(newEntries);
      updateDailyStats(newDailyStats);
      updatePtoBalances(newPTO);
      if (finalNW)     updateNonWorkTypes(finalNW);
      if (finalAlerts) updateAlertSettings(finalAlerts);
      updateDayNotes(newNotes);
      updateVisitData(finalVisits);
      window.__staffplanRestoring = false;
      const visitWeekCount = Object.keys(finalVisits).length;
      setStatus({ok:true, msg:`✅ Restored! ${newStaff.length} staff · ${Object.keys(newEntries).length} schedule entries · ${Object.keys(newDailyStats).length} daily stats${visitWeekCount ? ` · ${visitWeekCount} visit weeks` : ""}. Data saved — you can close and reopen safely.`});
    } catch(err) {
      setStatus({ok:false, msg:`❌ Restore failed: ${err.message}`});
    }
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:460,boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>📂 Restore from Backup</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:20,lineHeight:1.6}}>
          Upload a <b>StaffPlan_BACKUP_*.xlsx</b> file to fully restore all staff, schedules, PTO balances, settings and notes.<br/>
          <span style={{color:"#dc2626",fontWeight:600}}>⚠ This will overwrite all current data.</span>
        </div>
        {(!status || status.msg === "Reading file...") && (
          <div style={{border:"2px dashed #bfdbfe",borderRadius:12,padding:32,textAlign:"center",background:"#f0f9ff",cursor:"pointer"}}
            onClick={()=>fileRef.current?.click()}>
            <div style={{fontSize:32,marginBottom:8}}>📁</div>
            <div style={{fontSize:14,fontWeight:600,color:"#1d4ed8"}}>Click to choose backup file</div>
            <div style={{fontSize:11,color:"#9ca3af",marginTop:4}}>StaffPlan_BACKUP_*.xlsx</div>
            <input ref={fileRef} type="file" accept=".xlsx" style={{display:"none"}}
              onChange={e=>{ if(e.target.files[0]) restore(e.target.files[0]); }} />
          </div>
        )}
        {status && (
          <div style={{marginTop:16,padding:"12px 16px",borderRadius:10,
            background:status.ok?"#f0fdf4":"#fef2f2",
            border:"1px solid "+(status.ok?"#86efac":"#fca5a5"),
            fontSize:13,fontWeight:600,color:status.ok?"#15803d":"#dc2626",lineHeight:1.6}}>
            {status.msg}
          </div>
        )}
        <div style={{marginTop:20}}>
          <button onClick={onClose} style={{width:"100%",padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>
            {status?.ok && status.msg !== "Reading file..." ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Bulk Upload Modal ────────────────────────────────────────────────────────
function BulkUploadModal({ staff, updateStaff, entries, updateEntries, nonWorkTypes, onClose }) {
  const [step,setStep]=useState("intro"); const [parsedRows,setParsedRows]=useState([]);
  const [applyMode,setApplyMode]=useState("year"); const [yearTarget,setYearTarget]=useState(new Date().getFullYear());
  const [customStart,setCustomStart]=useState(fmt(startOfWeek(new Date()))); const [customEnd,setCustomEnd]=useState(fmt(new Date(new Date().getFullYear(),11,31)));
  const [overwrite,setOverwrite]=useState(false); const [errors,setErrors]=useState([]); const [appliedCount,setAppliedCount]=useState(0);
  const fileRef=useRef(); const nwCodes=nonWorkTypes.map(n=>n.code);

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const templateCSV = buildCSVTemplate(staff);

  const downloadTemplate = () => setShowTemplateModal(true);

  const handleFile = e => {
    const file=e.target.files[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=ev=>{
      const rows=parseCSV(ev.target.result); const errs=[];
      rows.forEach((row,i)=>{
        if(!row.StaffName) errs.push(`Row ${i+2}: Missing StaffName`);
        if(row.Team&&!TEAMS.includes(row.Team)) errs.push(`Row ${i+2}: Unknown team "${row.Team}"`);
        DAYS.forEach(d=>{
          const h=Number(row[d+"_Hours"]);
          if(row[d+"_Hours"]!==""&&(isNaN(h)||h<0||h>24)) errs.push(`Row ${i+2}: Invalid hours for ${d}`);
          const nw=row[d+"_NonWork"];
          if(nw&&!nwCodes.includes(nw)) errs.push(`Row ${i+2}: Unknown non-work code "${nw}" — add it in Non-Work Code Manager first`);
        });
      });
      setErrors(errs); setParsedRows(rows); setStep("preview");
    };
    reader.readAsText(file);
  };

  const applySchedule = () => {
    let weekStarts=[];
    if(applyMode==="year") { weekStarts=getYearWeekStarts(yearTarget); }
    else {
      const s=startOfWeek(new Date(customStart)); const e=new Date(customEnd); const cur=new Date(s);
      while(cur<=e){weekStarts.push(new Date(cur));cur.setDate(cur.getDate()+7);}
    }

    const newEntries={...entries};
    // Build updated staff list: start with CSV rows, match to existing by name
    const csvNames = new Set(parsedRows.map(r=>r.StaffName.trim().toLowerCase()));
    // Keep existing staff that either appear in CSV OR have real (non-placeholder) names
    const isPlaceholder = s => /^staff \d+$/i.test(s.name.trim());
    const keptStaff = staff.filter(s => csvNames.has(s.name.trim().toLowerCase()) || !isPlaceholder(s));
    const newStaff = [...keptStaff];

    parsedRows.forEach(row=>{
      if (!row.StaffName.trim()) return;
      let s = newStaff.find(x=>x.name.trim().toLowerCase()===row.StaffName.trim().toLowerCase());
      if(!s){
        s={id:Date.now()+Math.random(),name:row.StaffName.trim(),team:row.Team||TEAMS[0],fte:1.0,defaultHours:8,shiftStart:row.ShiftStart||"08:00",shiftEnd:row.ShiftEnd||"16:00"};
        newStaff.push(s);
      } else {
        // Update team and shift times from CSV
        if(row.Team && TEAMS.includes(row.Team)) s.team=row.Team;
        if(row.ShiftStart) s.shiftStart=row.ShiftStart;
        if(row.ShiftEnd) s.shiftEnd=row.ShiftEnd;
      }
      const team=row.Team||s.team;

      weekStarts.forEach(ws=>{
        DAYS.forEach((dayName,dayIdx)=>{
          const date=new Date(ws); date.setDate(date.getDate()+dayIdx);
          const ds=fmt(date); const key=`${s.id}_${ds}`;

          // Check existing segment array for data
          const existing = newEntries[key];
          const hasExisting = existing && Array.isArray(existing)
            ? existing.some(e=>Number(e.hours)>0||e.nonWork)
            : existing && (Number(existing.hours)>0||existing.nonWork);
          if(!overwrite && hasExisting) return;

          const hrs = row[dayName+"_Hours"];
          const nw  = row[dayName+"_NonWork"];
          const nwh = row[dayName+"_NonWorkHours"];
          const hoursNum = (hrs!==undefined && hrs!=="") ? Number(hrs) : 0;

          // Store as segment array (new format)
          if(hoursNum>0 || nw) {
            newEntries[key]=[{hours:hoursNum, nonWork:nw||"", nonWorkHours:nwh?Number(nwh):(nw?8:0), team}];
          } else {
            newEntries[key]=[];
          }
        });
      });
    });
    updateEntries(newEntries); updateStaff(newStaff); setAppliedCount(weekStarts.length); setStep("done");
  };

  const STEP_KEYS=["intro","preview","confirm","done"];
  const STEP_LABELS=["1. Template","2. Preview","3. Configure","4. Done"];

  if (showTemplateModal) return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={()=>setShowTemplateModal(false)}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:700,maxHeight:"88vh",overflow:"auto",boxShadow:"0 30px 80px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>CSV Template</div>
          <button onClick={()=>setShowTemplateModal(false)} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:10,padding:12,marginBottom:14,fontSize:12,color:"#0369a1"}}>
          <b>How to use:</b> Select all the text below (Ctrl+A or Cmd+A inside the box), copy it, paste into a blank Notepad or TextEdit file, then save it as <b>staffplan_template.csv</b>. Open in Excel to fill in.
        </div>
        <textarea
          readOnly
          value={templateCSV}
          style={{width:"100%",height:320,fontFamily:"monospace",fontSize:11,padding:12,border:"1px solid #e5e7eb",borderRadius:8,background:"#f9fafb",resize:"vertical",boxSizing:"border-box"}}
          onFocus={e=>e.target.select()}
        />
        <button
          onClick={()=>{navigator.clipboard.writeText(templateCSV).then(()=>alert("Copied to clipboard! Paste into Notepad and save as .csv")).catch(()=>alert("Select all text above and copy manually (Ctrl+C)"));}}
          style={{marginTop:12,width:"100%",padding:"11px",background:"#1e3a5f",color:"#fff",border:"none",borderRadius:8,fontSize:14,fontWeight:700,cursor:"pointer"}}
        >
          Copy to Clipboard
        </button>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:680,maxHeight:"86vh",overflow:"auto",boxShadow:"0 30px 80px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:20,fontWeight:800,color:"#1e3a5f"}}>Bulk Schedule Upload</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{display:"flex",gap:0,marginBottom:24,borderRadius:10,overflow:"hidden",border:"1px solid #e5e7eb"}}>
          {STEP_KEYS.map((key,idx)=>(
            <div key={key} style={{flex:1,padding:"8px 4px",textAlign:"center",fontSize:11,fontWeight:700,
              background:step===key?"#1e3a5f":STEP_KEYS.indexOf(step)>idx?"#dbeafe":"#f9fafb",
              color:step===key?"#fff":STEP_KEYS.indexOf(step)>idx?"#1e40af":"#9ca3af",
              borderRight:idx<3?"1px solid #e5e7eb":"none"}}>{STEP_LABELS[idx]}</div>
          ))}
        </div>

        {step==="intro" && (
          <div style={{display:"grid",gap:16}}>
            <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,fontWeight:700,color:"#0369a1",marginBottom:8}}>How it works</div>
              {["Download the CSV template — pre-filled with your staff names and teams.",
                "Fill in each person's typical weekly schedule: hours per day + non-work codes.",
                "Upload the filled CSV and choose the year or date range to apply it to.",
                "The template repeats across all weeks — individual days can still be overridden."
              ].map((t,i)=>(
                <div key={i} style={{display:"flex",gap:8,marginBottom:6}}>
                  <span style={{background:"#1e3a5f",color:"#fff",borderRadius:"50%",width:18,height:18,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,flexShrink:0}}>{i+1}</span>
                  <span style={{fontSize:12,color:"#374151"}}>{t}</span>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={downloadTemplate} style={{flex:1,padding:"12px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer"}}>⬇ Download Template</button>
              <button onClick={()=>fileRef.current?.click()} style={{flex:1,padding:"12px",borderRadius:10,background:"#22c55e",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer"}}>⬆ Upload CSV</button>
            </div>
            <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={handleFile} />
          </div>
        )}

        {step==="preview" && (
          <div style={{display:"grid",gap:14}}>
            {errors.length>0
              ? <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:12}}><div style={{fontSize:12,fontWeight:700,color:"#dc2626",marginBottom:4}}>⚠ {errors.length} issue(s) found</div>{errors.slice(0,6).map((e,i)=><div key={i} style={{fontSize:11,color:"#b91c1c"}}>{e}</div>)}</div>
              : <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:10,padding:10}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#15803d"}}>✓ {parsedRows.length} staff rows parsed — no errors</div>
                  <div style={{fontSize:11,color:"#374151",marginTop:4}}>
                    Staff found: {parsedRows.map(r=>r.StaffName).filter(Boolean).join(", ")}
                  </div>
                </div>
            }
            <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #e5e7eb",maxHeight:300}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead style={{position:"sticky",top:0,background:"#f9fafb",zIndex:1}}>
                  <tr>
                    <th style={{padding:"7px 10px",textAlign:"left",fontWeight:700,color:"#374151",borderBottom:"1px solid #e5e7eb"}}>Name</th>
                    <th style={{padding:"7px 10px",textAlign:"left",fontWeight:700,color:"#374151",borderBottom:"1px solid #e5e7eb"}}>Team</th>
                    {DAYS.map(d=><th key={d} style={{padding:"7px 5px",textAlign:"center",fontWeight:700,color:d==="Sun"||d==="Sat"?"#7c3aed":"#374151",borderBottom:"1px solid #e5e7eb"}}>{d}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.map((row,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #f3f4f6"}}>
                      <td style={{padding:"6px 10px",fontWeight:600,color:"#111827"}}>{row.StaffName}</td>
                      <td style={{padding:"6px 10px"}}><span style={{fontSize:10,padding:"1px 6px",borderRadius:99,background:TEAM_COLORS[row.Team]?.bg||"#f3f4f6",color:TEAM_COLORS[row.Team]?.text||"#374151",fontWeight:600}}>{row.Team||"?"}</span></td>
                      {DAYS.map(d=>{
                        const h=row[d+"_Hours"]; const nw=row[d+"_NonWork"];
                        return <td key={d} style={{padding:"4px 5px",textAlign:"center"}}>
                          {Number(h)>0&&<div style={{fontSize:11,fontWeight:700,color:"#1e3a5f"}}>{h}h</div>}
                          {nw&&<div style={{fontSize:9,padding:"1px 4px",borderRadius:99,background:"#8b5cf622",color:"#8b5cf6",fontWeight:700}}>{nw}</div>}
                          {!Number(h)&&!nw&&<span style={{color:"#d1d5db"}}>—</span>}
                        </td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setStep("intro")} style={{padding:"9px 16px",borderRadius:8,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:12,fontWeight:600}}>← Back</button>
              <button onClick={()=>fileRef.current?.click()} style={{padding:"9px 16px",borderRadius:8,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:12,fontWeight:600}}>Re-upload</button>
              <button disabled={errors.length>0} onClick={()=>setStep("confirm")} style={{flex:1,padding:"9px",borderRadius:8,background:errors.length>0?"#d1d5db":"#1e3a5f",color:"#fff",border:"none",cursor:errors.length>0?"not-allowed":"pointer",fontSize:13,fontWeight:700}}>Continue →</button>
            </div>
            <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={handleFile} />
          </div>
        )}

        {step==="confirm" && (
          <div style={{display:"grid",gap:16}}>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#1e3a5f",marginBottom:8}}>Apply to…</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                {[["year","Full Year"],["custom","Custom Range"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setApplyMode(v)} style={{padding:"12px",borderRadius:10,border:"2px solid "+(applyMode===v?"#1e3a5f":"#e5e7eb"),background:applyMode===v?"#eff6ff":"#fff",cursor:"pointer",fontWeight:700,fontSize:13,color:applyMode===v?"#1e3a5f":"#6b7280"}}>{l}</button>
                ))}
              </div>
              {applyMode==="year"&&<div><label style={lbl}>Year</label><input type="number" value={yearTarget} min="2020" max="2040" onChange={e=>setYearTarget(Number(e.target.value))} style={{...inp,maxWidth:140}} /><div style={{fontSize:11,color:"#6b7280",marginTop:4}}>{getYearWeekStarts(yearTarget).length} weeks in {yearTarget}</div></div>}
              {applyMode==="custom"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}><div><label style={lbl}>Start</label><input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={inp} /></div><div><label style={lbl}>End</label><input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={inp} /></div></div>}
            </div>
            <div style={{background:"#fffbeb",border:"1px solid #fcd34d",borderRadius:10,padding:14}}>
              <div style={{fontSize:13,fontWeight:700,color:"#92400e",marginBottom:8}}>Existing entries</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[[false,"Skip existing","Filled days are preserved","#f0fdf4","#15803d"],[true,"Overwrite all","All days replaced by template","#fef2f2","#dc2626"]].map(([v,t,d,bg,col])=>(
                  <button key={String(v)} onClick={()=>setOverwrite(v)} style={{padding:"10px",borderRadius:8,border:"2px solid "+(overwrite===v?col:"#e5e7eb"),background:overwrite===v?bg:"#fff",cursor:"pointer",textAlign:"left"}}>
                    <div style={{fontWeight:700,fontSize:12,color:overwrite===v?col:"#374151"}}>{t}</div>
                    <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>{d}</div>
                  </button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setStep("preview")} style={{padding:"9px 16px",borderRadius:8,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:12,fontWeight:600}}>← Back</button>
              <button onClick={applySchedule} style={{flex:1,padding:"12px",borderRadius:10,background:"#22c55e",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:800}}>✓ Apply Schedule</button>
            </div>
          </div>
        )}

        {step==="done" && (
          <div style={{textAlign:"center",padding:"28px 0"}}>
            <div style={{fontSize:56,marginBottom:12}}>🎉</div>
            <div style={{fontSize:22,fontWeight:800,color:"#15803d",marginBottom:6}}>Schedule Applied!</div>
            <div style={{fontSize:14,color:"#374151",marginBottom:4}}><b>{parsedRows.length}</b> staff × <b>{appliedCount}</b> weeks — all saved automatically.</div>
            <div style={{fontSize:12,color:"#6b7280",marginBottom:24}}>Navigate any week in the grid to review or override individual days.</div>
            <button onClick={onClose} style={{padding:"12px 32px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>Back to Grid</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared small components ──────────────────────────────────────────────────
function Metric({ label, value, color }) {
  return <div style={{display:"flex",flexDirection:"column"}}><span style={{fontSize:9,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}</span><span style={{fontSize:17,fontWeight:800,color:color||"#1e3a5f"}}>{value}</span></div>;
}
function StatCard({ label, value, color }) {
  return <div style={{padding:"12px 14px",borderRadius:10,background:"#f8fafc",border:"1px solid #e5e7eb"}}><div style={{fontSize:10,color:"#9ca3af",fontWeight:600,textTransform:"uppercase"}}>{label}</div><div style={{fontSize:22,fontWeight:800,color:color||"#111827",marginTop:2}}>{value}</div></div>;
}
function Row({ label, value, small }) {
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:small?10:11,color:"#9ca3af"}}>{label}</span><span style={{fontSize:small?11:12,fontWeight:700,color:"#374151"}}>{value}</span></div>;
}
