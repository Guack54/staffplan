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
const DEFAULT_LOCATIONS = [
  { id: 1, team: "Acute",  name: "4 East" },
  { id: 2, team: "Acute",  name: "4 West" },
  { id: 3, team: "Acute",  name: "5 North" },
  { id: 4, team: "Rehab",  name: "Gym" },
  { id: 5, team: "Rehab",  name: "Outpatient" },
  { id: 6, team: "Peds",   name: "NICU" },
  { id: 7, team: "Peds",   name: "PICU" },
];
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
function useWindowWidth() {
  const [w, setW] = useState(() => typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const handler = () => setW(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return w;
}
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

// ─── Supabase client ──────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ouwertzfrcytkbvypmda.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91d2VydHpmcmN5dGtidnlwbWRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzE1NzcsImV4cCI6MjA4ODg0NzU3N30.It7k5LvnUzHf5pQWngg6N_Hg1bN0oVX9ZnGkUOrhXMA";

// Lazy-load the Supabase JS client from CDN
let _sb = null;
async function getSB() {
  if (_sb) return _sb;
  if (!window.supabase) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  return _sb;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
async function sbSignIn(email, password) {
  const sb = await getSB();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function sbSignOut() {
  const sb = await getSB();
  await sb.auth.signOut();
}

async function sbGetSession() {
  const sb = await getSB();
  const { data } = await sb.auth.getSession();
  return data.session;
}

async function sbGetProfile(userId) {
  const sb = await getSB();
  const { data, error } = await sb.from("user_profiles").select("*").eq("id", userId).single();
  if (error) return null;
  return data;
}

async function sbUpdatePassword(newPassword) {
  const sb = await getSB();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// ── Usage Analytics ──────────────────────────────────────────────────────────
async function trackEvent(userId, userEmail, eventType, payload = {}) {
  try {
    const sb = await getSB();
    await sb.from("usage_events").insert({
      user_id: userId,
      user_email: userEmail,
      event_type: eventType,
      payload,
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* best-effort — never throw */ }
}

async function sbLoadHolidays() {
  try {
    const sb = await getSB();
    const { data } = await sb.from("alert_settings").select("data").eq("key", "holidays").single();
    if (data?.data) return data.data; // { year: [ { name, date, floating } ] }
    return {};
  } catch(_) { return {}; }
}

async function sbSaveHolidays(holidays) {
  try {
    const sb = await getSB();
    await sb.from("alert_settings").upsert(
      { key: "holidays", data: holidays },
      { onConflict: "key" }
    );
  } catch(_) {}
}

async function sbLoadCompetencies() {
  try {
    const sb = await getSB();
    const { data } = await sb.from("alert_settings").select("data").eq("key", "competencies").single();
    if (data?.data) return data.data;
    return [];
  } catch(_) { return []; }
}

async function sbSaveCompetencies(comps) {
  try {
    const sb = await getSB();
    await sb.from("alert_settings").upsert(
      { key: "competencies", data: comps },
      { onConflict: "key" }
    );
  } catch(_) {}
}

async function sbLoadUsageEvents() {
  try {
    const sb = await getSB();
    const since = new Date(); since.setDate(since.getDate() - 90);
    const { data } = await sb.from("usage_events")
      .select("*")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(5000);
    return data || [];
  } catch (_) { return []; }
}

// ─── Data loaders ─────────────────────────────────────────────────────────────
async function sbLoadStaff() {
  const sb = await getSB();
  const { data, error } = await sb.from("staff").select("*").order("id");
  if (error || !data?.length) return null;
  return data.map(r => ({
    id: r.id, name: r.name, team: r.team, fte: r.fte,
    defaultHours: r.default_hours, shiftStart: r.shift_start, shiftEnd: r.shift_end,
    defaultSchedule: r.default_schedule || [], notes: r.notes || "", archived: r.archived || false,
    competencies: r.competencies || [],
    startDate: r.start_date || null,
    terminationDate: r.termination_date || null,
  }));
}

async function sbLoadEntries() {
  const sb = await getSB();
  const out = {};
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb.from("entries").select("*").range(from, from + pageSize - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    data.forEach(r => { out[`${r.staff_id}_${r.date_str}`] = r.segments || []; });
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return Object.keys(out).length ? out : null;
}

async function sbLoadDailyStats() {
  const sb = await getSB();
  const out = {};
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb.from("daily_stats").select("*").range(from, from + pageSize - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    data.forEach(r => { out[r.date_str] = r.data; });
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return Object.keys(out).length ? out : null;
}

async function sbLoadPTO() {
  const sb = await getSB();
  const { data, error } = await sb.from("pto_balances").select("*");
  if (error || !data) return null;
  const out = {};
  data.forEach(r => { out[String(r.staff_id)] = r.data; });
  return out;
}

async function sbLoadNotes() {
  const sb = await getSB();
  const { data, error } = await sb.from("day_notes").select("*");
  if (error || !data) return null;
  const out = {};
  data.forEach(r => { out[r.date_str] = r.note; });
  return out;
}

async function sbLoadVisits() {
  const sb = await getSB();
  const { data, error } = await sb.from("visit_data").select("*");
  if (error || !data) return null;
  const out = {};
  data.forEach(r => { out[r.week_key] = { weekStart: r.week_start, ...r.data }; });
  return out;
}

async function sbLoadNonWorkTypes() {
  const sb = await getSB();
  const { data, error } = await sb.from("non_work_types").select("*").order("sort_order");
  if (error || !data?.length) return null;
  return data.map(r => ({ code: r.code, label: r.label, color: r.color }));
}

async function sbLoadAlertSettings() {
  const sb = await getSB();
  const { data, error } = await sb.from("alert_settings").select("*");
  if (error || !data?.length) return null;
  const out = {};
  data.forEach(r => { out[r.key] = r.data; });
  return (out.fteTargets && out.censusTargets)
    ? { fteTargets: out.fteTargets, censusTargets: out.censusTargets }
    : null;
}

// ─── Data savers ──────────────────────────────────────────────────────────────
async function sbDeleteStaff(staffId) {
  const sb = await getSB();
  await sb.from("staff").delete().eq("id", String(staffId));
}

async function sbDeleteEntriesForDate(dateStr) {
  const sb = await getSB();
  const { error } = await sb.from("entries").delete().eq("date_str", dateStr);
}

async function sbSaveStaff(staffArr) {
  const sb = await getSB();
  // Deduplicate by rounded ID — keep last occurrence
  const seen = new Map();
  staffArr.forEach(s => seen.set(String(s.id), s));
  const rows = Array.from(seen.values()).map(s => ({
    id: String(s.id), name: s.name, team: s.team, fte: s.fte,
    default_hours: s.defaultHours, shift_start: s.shiftStart || "08:00",
    shift_end: s.shiftEnd || "16:00", default_schedule: s.defaultSchedule || [],
    notes: s.notes || "", archived: s.archived || false,
    competencies: s.competencies || [],
    start_date: s.startDate || null,
    termination_date: s.terminationDate || null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await sb.from("staff").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`Staff save failed: ${error.message}`);
}

async function sbSaveEntry(staffId, dateStr, segments) {
  const sb = await getSB();
  await sb.from("entries").upsert(
    { staff_id: staffId, date_str: dateStr, segments, updated_at: new Date().toISOString() },
    { onConflict: "staff_id,date_str" }
  );
}

async function sbSaveEntries(entriesObj) {
  const sb = await getSB();
  const rows = [];
  Object.entries(entriesObj).forEach(([key, segs]) => {
    // key format is staffId_YYYY-MM-DD — split on first underscore only
    const underscoreIdx = key.indexOf("_");
    if (underscoreIdx === -1) return;
    const staffId = key.substring(0, underscoreIdx);
    const dateStr = key.substring(underscoreIdx + 1);
    if (isNaN(staffId) || !dateStr || !dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return;
    rows.push({ staff_id: String(staffId), date_str: dateStr, segments: segs || [], updated_at: new Date().toISOString() });
  });
  if (!rows.length) return;
  // Deduplicate by staff_id+date_str — keep last occurrence
  const seen = new Map();
  rows.forEach(r => seen.set(`${String(r.staff_id)}_${r.date_str}`, r));
  const deduped = Array.from(seen.values());
  // Batch in chunks of 200 to avoid request size limits
  for (let i = 0; i < deduped.length; i += 200) {
    const { error } = await sb.from("entries").upsert(deduped.slice(i, i+200), { onConflict: "staff_id,date_str" });
    if (error) throw new Error(`Entries save failed: ${error.message}`);
  }
}

async function sbSaveDailyStats(statsObj) {
  const sb = await getSB();
  const rows = Object.entries(statsObj).map(([date_str, data]) => ({
    date_str, data, updated_at: new Date().toISOString()
  }));
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("daily_stats").upsert(rows.slice(i, i+500), { onConflict: "date_str" });
    if (error) {
      console.error("[StaffPlan] daily_stats save error:", error);
    }
  }
}

async function sbSavePTO(ptoObj) {
  const sb = await getSB();
  const rows = Object.entries(ptoObj).map(([staff_id, data]) => ({
    staff_id: String(staff_id), data, updated_at: new Date().toISOString()
  })).filter(r => !isNaN(r.staff_id));
  if (!rows.length) return;
  await sb.from("pto_balances").upsert(rows, { onConflict: "staff_id" });
}

async function sbSaveNotes(notesObj) {
  const sb = await getSB();
  const rows = Object.entries(notesObj).map(([date_str, note]) => ({
    date_str, note, updated_at: new Date().toISOString()
  }));
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    await sb.from("day_notes").upsert(rows.slice(i, i+500), { onConflict: "date_str" });
  }
}

async function sbSaveVisits(visitsObj) {
  const sb = await getSB();
  const rows = Object.entries(visitsObj).map(([week_key, rec]) => {
    const { weekStart, ...data } = rec;
    return { week_key, week_start: weekStart || week_key.replace("week_",""), data, updated_at: new Date().toISOString() };
  });
  if (!rows.length) return;
  await sb.from("visit_data").upsert(rows, { onConflict: "week_key" });
}

async function sbSaveNonWorkTypes(nwArr, sb_) {
  const sb = sb_ || await getSB();
  await sb.from("non_work_types").delete().neq("code", "___never___");
  const rows = nwArr.map((n, i) => ({ code: n.code, label: n.label, color: n.color, sort_order: i }));
  await sb.from("non_work_types").insert(rows);
}

async function sbSaveAlertSettings(alertObj) {
  const sb = await getSB();
  await sb.from("alert_settings").upsert([
    { key: "fteTargets", data: alertObj.fteTargets, updated_at: new Date().toISOString() },
    { key: "censusTargets", data: alertObj.censusTargets, updated_at: new Date().toISOString() },
  ], { onConflict: "key" });
}

// ─── Realtime subscription ────────────────────────────────────────────────────
let _realtimeChannel = null;
async function subscribeRealtime(onStaffChange, onEntriesChange, onStatsChange, onVisitsChange) {
  const sb = await getSB();
  if (_realtimeChannel) { sb.removeChannel(_realtimeChannel); }
  _realtimeChannel = sb.channel("staffplan-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "staff" }, onStaffChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, onEntriesChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "daily_stats" }, onStatsChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "visit_data" }, onVisitsChange)
    .subscribe();
}

// ─── Legacy localStorage fallback (kept for backup/restore) ──────────────────
const hasClaudeStorage = () => typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
async function saveToStorage(key, value) {
  const str = JSON.stringify(value);
  if (hasClaudeStorage()) { try { await window.storage.set(key, str); return; } catch(e) {} }
  try { localStorage.setItem(key, str); } catch(e) {}
}
async function loadFromStorage(key, fallback) {
  if (typeof PRELOADED_DATA !== "undefined" && PRELOADED_DATA[key] !== undefined) {
    try { return JSON.parse(PRELOADED_DATA[key]); } catch(e) {}
  }
  if (hasClaudeStorage()) { try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : fallback; } catch(e) {} }
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch(e) {}
  return fallback;
}

// ─── Login Screen ────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) { setError("Please enter your email and password."); return; }
    setLoading(true); setError("");
    try {
      const data = await sbSignIn(email, password);
      const profile = await sbGetProfile(data.user.id);
      if (!profile) throw new Error("Account not set up correctly. Contact your administrator.");
      onLogin({ ...data.user, profile });
    } catch(e) {
      setError(e.message || "Login failed. Check your email and password.");
    } finally { setLoading(false); }
  };

  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"linear-gradient(135deg,#0f2744 0%,#1e3a5f 60%,#1e4d8c 100%)"}}>
      <div style={{background:"#fff",borderRadius:20,padding:"40px 36px",width:380,boxShadow:"0 30px 80px rgba(0,0,0,0.35)"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontSize:28,fontWeight:800,color:"#1e3a5f",letterSpacing:"-0.02em"}}>StaffPlan</div>
          <div style={{fontSize:12,color:"#6b7280",marginTop:4}}>Department Staffing & Planning</div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12,fontWeight:600,color:"#374151",display:"block",marginBottom:5}}>Email</label>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            placeholder="your@email.com"
            style={{width:"100%",padding:"10px 12px",borderRadius:9,border:"1px solid #d1d5db",fontSize:14,outline:"none"}} />
        </div>
        <div style={{marginBottom:20}}>
          <label style={{fontSize:12,fontWeight:600,color:"#374151",display:"block",marginBottom:5}}>Password</label>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            placeholder="••••••••"
            style={{width:"100%",padding:"10px 12px",borderRadius:9,border:"1px solid #d1d5db",fontSize:14,outline:"none"}} />
        </div>
        {error && <div style={{padding:"8px 12px",borderRadius:8,background:"#fef2f2",color:"#dc2626",fontSize:12,fontWeight:600,marginBottom:14}}>{error}</div>}
        <button onClick={handleLogin} disabled={loading}
          style={{width:"100%",padding:"12px",borderRadius:10,background:loading?"#93c5fd":"#1e3a5f",color:"#fff",border:"none",fontWeight:700,fontSize:15,cursor:loading?"not-allowed":"pointer"}}>
          {loading ? "Signing in..." : "Sign In →"}
        </button>
        <div style={{textAlign:"center",marginTop:16,fontSize:11,color:"#9ca3af"}}>
          Contact your administrator to get access.
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function StaffingApp() {
  const [currentUser, setCurrentUser] = useState(null); // { id, email, profile: {role, display_name} }
  const [authChecked, setAuthChecked] = useState(false);

  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [entries, setEntries] = useState({});
  const [dailyStats, setDailyStats] = useState({});
  const [staff, setStaff] = useState([]);
  const [nonWorkTypes, setNonWorkTypes] = useState(DEFAULT_NON_WORK);
  const [locations, setLocations] = useState(DEFAULT_LOCATIONS);
  const [competencies, setCompetencies] = useState([]);
  const [holidays, setHolidays] = useState({}); // { "2026": [{name, date, confirmed}] }
  const [showHolidayCalendar, setShowHolidayCalendar] = useState(false); // [{ id, name, color }]
  const [filterCompetencies, setFilterCompetencies] = useState([]); // ids — AND logic
  const [showCompetencyEditor, setShowCompetencyEditor] = useState(false);
  const [editingCell, setEditingCell] = useState(null);
  const [drillDay, setDrillDay] = useState(null);
  const [activeTab, setActiveTab] = useState("grid");
  const tabEnteredAt = useRef(Date.now());
  const [onlineUsers, setOnlineUsers] = useState({});
  const presenceChannel = useRef(null);
  const [filterTeam, setFilterTeam] = useState("All");
  const [filterPersons, setFilterPersons] = useState([]); // [] = show all
  const [editingName, setEditingName] = useState(null);
  const [tempName, setTempName] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showBackupRestore, setShowBackupRestore] = useState(false);
  const [showArchivedManager, setShowArchivedManager] = useState(false);
  const [showVisitEntry, setShowVisitEntry] = useState(false);
  const [showStaffManager, setShowStaffManager] = useState(false);
  const [visitData, setVisitData] = useState({});
  const [showNonWorkEditor, setShowNonWorkEditor] = useState(false);
  const [yearView, setYearView] = useState(new Date().getFullYear());
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("saved");
  const [showUserManager, setShowUserManager] = useState(false);
  const [showLocationEditor, setShowLocationEditor] = useState(false);
  const saveTimer = useRef(null);
  const xlsxRef = useRef(null);
  const historyStack = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const nonWorkTypesRef = useRef(null);
  const alertSettingsRef = useRef(null);
  const ptoBalancesRef = useRef(null);
  const dayNotesRef = useRef(null);
  const triggerSaveRef = useRef(null);
  const isRestoringRef = useRef(false);
  const realtimeDebounce = useRef({});
  const isSavingRef = useRef(false); // suppress realtime reloads while we're saving

  const [menuOpen, setMenuOpen] = useState(false);
  const [showPwManager, setShowPwManager] = useState(false);
  const [compactMode, setCompactMode] = useState(true);
  const [showAlertsEditor, setShowAlertsEditor] = useState(false);
  const [showBatchEntry, setShowBatchEntry] = useState(false);
  const [alertSettings, setAlertSettings] = useState({ fteTargets: DEFAULT_FTE_TARGETS, censusTargets: DEFAULT_CENSUS_TARGETS });
  const [ptoBalances, setPtoBalances] = useState({});
  const [dayNotes, setDayNotes] = useState({});
  const [dayView, setDayView] = useState(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [monthView, setMonthView] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const menuRef = useRef(null);

  const userRole = currentUser?.profile?.role || "viewer";
  const canEdit = userRole === "admin" || userRole === "manager";
  const isAdmin = userRole === "admin";
  const isStaffRole = userRole === "staff";

  // ── Check existing session on mount ──
  useEffect(() => {
    (async () => {
      try {
        const session = await sbGetSession();
        if (session?.user) {
          const profile = await sbGetProfile(session.user.id);
          if (profile) setCurrentUser({ ...session.user, profile });
        }
      } catch(e) {}
      setAuthChecked(true);
    })();
  }, []);

  // ── Load all data from Supabase once logged in ──
  useEffect(() => {
    if (!currentUser) return;
    (async () => {
      try {
        const [sbStaff, sbEntries, sbStats, sbNW, sbAlerts, sbPTO, sbNotes, sbVisits] = await Promise.all([
          sbLoadStaff(), sbLoadEntries(), sbLoadDailyStats(),
          sbLoadNonWorkTypes(), sbLoadAlertSettings(), sbLoadPTO(),
          sbLoadNotes(), sbLoadVisits(),
        ]);
        if (sbStaff)   setStaff(sbStaff);
        if (sbEntries) setEntries(sbEntries);
        if (sbStats)   setDailyStats(sbStats);
        if (sbNW)      setNonWorkTypes(sbNW);
        if (sbAlerts)  setAlertSettings(sbAlerts);
        const savedLocs = await loadFromStorage("staffplan:locations", DEFAULT_LOCATIONS);
        const savedComps = await sbLoadCompetencies();
        const savedHolidays = await sbLoadHolidays();
        if (savedLocs) setLocations(savedLocs);
        if (savedComps && savedComps.length > 0) setCompetencies(savedComps);
        if (savedHolidays && Object.keys(savedHolidays).length > 0) setHolidays(savedHolidays);
        if (sbPTO)     setPtoBalances(sbPTO);
        if (sbNotes)   setDayNotes(sbNotes);
        if (sbVisits)  setVisitData(sbVisits);
      } catch(e) { console.error("Load error:", e); }
      setLoaded(true);
    })();
  }, [currentUser]);

  // ── Real-time subscriptions ──
  useEffect(() => {
    if (!currentUser) return;
    const debounce = (key, fn, ms=800) => {
      if (realtimeDebounce.current[key]) clearTimeout(realtimeDebounce.current[key]);
      realtimeDebounce.current[key] = setTimeout(fn, ms);
    };
    subscribeRealtime(
      () => { if (isSavingRef.current) return; debounce("staff", async () => { const d=await sbLoadStaff(); if(d) setStaff(d); }); },
      (payload) => {
        if (isSavingRef.current) return; // skip — this is our own save echoing back
        const r = payload.new;
        if (r && r.staff_id && r.date_str) {
          setEntries(prev => ({ ...prev, [`${r.staff_id}_${r.date_str}`]: r.segments || [] }));
        }
      },
      () => { if (isSavingRef.current) return; debounce("stats", async () => { const d=await sbLoadDailyStats(); if(d) setDailyStats(d); }); },
      () => { if (isSavingRef.current) return; debounce("visits", async () => { const d=await sbLoadVisits(); if(d) setVisitData(d); }); },
    );
    return () => { if (_realtimeChannel) getSB().then(sb => sb.removeChannel(_realtimeChannel)); };
  }, [currentUser]);

  // ── Presence: who is online ──
  useEffect(() => {
    if (!currentUser) return;
    const PRESENCE_COLORS = ["#3b82f6","#10b981","#f59e0b","#8b5cf6","#ef4444","#06b6d4","#f97316","#ec4899"];
    const myColor = PRESENCE_COLORS[Math.abs([...currentUser.id].reduce((a,c)=>a+c.charCodeAt(0),0)) % PRESENCE_COLORS.length];
    const myName = currentUser?.profile?.display_name || currentUser.email;
    const myInitials = myName.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2);
    getSB().then(sb => {
      const ch = sb.channel("staffplan-presence", { config: { presence: { key: currentUser.id } } });
      presenceChannel.current = ch;
      const syncState = () => {
        const state = ch.presenceState();
        const users = {};
        Object.entries(state).forEach(([uid, arr]) => { if (arr[0]) users[uid] = arr[0]; });
        setOnlineUsers(users);
      };
      ch.on("presence", { event: "sync" }, syncState);
      ch.on("presence", { event: "join" }, syncState);
      ch.on("presence", { event: "leave" }, syncState);
      ch.subscribe(async status => {
        if (status === "SUBSCRIBED") {
          await ch.track({
            userId: currentUser.id,
            name: myName,
            initials: myInitials,
            role: currentUser?.profile?.role || "viewer",
            tab: activeTab,
            color: myColor,
            online_at: new Date().toISOString(),
          });
        }
      });
    });
    return () => {
      if (presenceChannel.current) {
        getSB().then(sb => { try { sb.removeChannel(presenceChannel.current); } catch(_){} });
        presenceChannel.current = null;
      }
    };
  }, [currentUser]);

  // Load SheetJS dynamically
  useEffect(() => {
    if (window.XLSX) { xlsxRef.current = window.XLSX; return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => { xlsxRef.current = window.XLSX; };
    document.head.appendChild(script);
  }, []);

  // Auto-save on changes (debounced) — saves to Supabase
  const triggerSave = useCallback((newStaff, newEntries, newDailyStats, newNonWork, newAlerts, newPTO, newNotes, newVisits) => {
    if (isRestoringRef.current || window.__staffplanRestoring) return;
    if (!canEdit) return; // viewers cannot save
    setSaveStatus("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      isSavingRef.current = true; // block realtime reloads during save
      try {
        await Promise.all([
          sbSaveStaff(staffRef.current ?? newStaff),
          sbSaveEntries(entriesRef.current ?? newEntries),
          sbSaveDailyStats(dailyStatsRef.current ?? newDailyStats),
          sbSaveNonWorkTypes(nonWorkTypesRef.current ?? newNonWork),
          sbSaveAlertSettings(alertSettingsRef.current ?? newAlerts),
          sbSavePTO(ptoBalancesRef.current ?? newPTO),
          sbSaveNotes(dayNotesRef.current ?? newNotes),
          sbSaveVisits(visitDataRef.current ?? newVisits ?? visitData),
        ]);
        setSaveStatus("saved");
      } catch(e) { console.error("Save error:", e); setSaveStatus("unsaved"); }
      finally {
        // Re-enable realtime reloads after a short buffer
        setTimeout(() => { isSavingRef.current = false; }, 2000);
      }
    }, 1200);
  }, [canEdit, visitData]);

  // Keep refs current so undo can access latest values without dep-array churn
  nonWorkTypesRef.current = nonWorkTypes;
  alertSettingsRef.current = alertSettings;
  ptoBalancesRef.current = ptoBalances;
  dayNotesRef.current = dayNotes;
  triggerSaveRef.current = triggerSave;
  // Latest state refs — used by triggerSave to always write fresh data
  const staffRef = useRef(staff);
  const entriesRef = useRef(entries);
  const dailyStatsRef = useRef(dailyStats);
  const visitDataRef = useRef(visitData);
  staffRef.current = staff;
  entriesRef.current = entries;
  dailyStatsRef.current = dailyStats;
  visitDataRef.current = visitData;

  const pushHistory = useCallback((s, e, d) => {
    historyStack.current = [...historyStack.current.slice(-19), { staff: s, entries: e, dailyStats: d }];
    setCanUndo(true);
  }, []);

  const updateStaff = useCallback((val) => { pushHistory(staff, entries, dailyStats); setStaff(val); triggerSave(val, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateEntries = useCallback((val) => { pushHistory(staff, entries, dailyStats); setEntries(val); triggerSave(staff, val, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateDailyStats = useCallback((val) => { pushHistory(staff, entries, dailyStats); setDailyStats(val); triggerSave(staff, entries, val, nonWorkTypes, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes, triggerSave, pushHistory]);
  const updateNonWorkTypes = useCallback((val) => { setNonWorkTypes(val); triggerSave(staff, entries, dailyStats, val, alertSettings, ptoBalances, dayNotes); }, [staff, entries, dailyStats, alertSettings, ptoBalances, dayNotes, triggerSave]);
  const updateLocations = useCallback((val) => { setLocations(val); saveToStorage("staffplan:locations", val); }, []);
  const updateCompetencies = useCallback((val) => { setCompetencies(val); sbSaveCompetencies(val); }, []);
  const updateHolidays = useCallback((val) => { setHolidays(val); sbSaveHolidays(val); }, []);
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
    // Filter out archived staff, then filter by employment window for the current week
    const weekDs = getWeekDates(weekStart).map(d => fmt(d));
    const active = staff.filter(s => {
      if (s.archived) return false;
      return weekDs.some(ds => {
        if (s.startDate && ds < s.startDate) return false;
        if (s.terminationDate && ds > s.terminationDate) return false;
        return true;
      });
    });
    // Apply competency filter first — AND logic (must have ALL selected)
    const compFiltered = filterCompetencies.length === 0 ? active : active.filter(s =>
      filterCompetencies.every(cid => (s.competencies || []).includes(cid))
    );
    const personFiltered = filterPersons.length === 0 ? compFiltered : compFiltered.filter(s => filterPersons.includes(s.id));
    if (filterTeam === "All") return sortByName(personFiltered);
    return sortByName(personFiltered.filter(s => {
      if (s.team === filterTeam) return true;
      return getWeekDates(weekStart).some(date => {
        const segs = (entries[`${s.id}_${fmt(date)}`] || []);
        const arr = Array.isArray(segs) ? segs : [segs];
        return arr.some(e => (e.team || s.team) === filterTeam && Number(e.hours) > 0);
      });
    }));
  }, [staff, filterTeam, filterCompetencies, filterPersons, entries, weekStart]);
  const nwMap = useMemo(() => Object.fromEntries(nonWorkTypes.map(n => [n.code, n])), [nonWorkTypes]);

  // Returns true if staff member is active on a given date string
  // Respects startDate and terminationDate if set; if not set, always active
  const isStaffActiveOn = useCallback((s, dateStr) => {
    if (s.startDate && dateStr < s.startDate) return false;
    if (s.terminationDate && dateStr > s.terminationDate) return false;
    return true;
  }, []);

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
    if (isHoliday) {
      // Update both stats and entries atomically
      const nextEntries = { ...entries };
      staff.forEach(s => { delete nextEntries[`${s.id}_${dateStr}`]; });
      pushHistory(staff, entries, dailyStats);
      setDailyStats(nextStats);
      setEntries(nextEntries);
      triggerSave(staff, nextEntries, nextStats, nonWorkTypes, alertSettings, ptoBalances, dayNotes);
      // Also explicitly delete entries from Supabase — upsert alone won't remove them
      sbDeleteEntriesForDate(dateStr);
    } else {
      updateDailyStats(nextStats);
    }
  }, [dailyStats, getDailyStats, updateDailyStats, entries, staff, pushHistory,
      setDailyStats, setEntries, triggerSave, nonWorkTypes, alertSettings, ptoBalances, dayNotes]);

  // getDayFTE counts ALL non-archived staff entries for a date
  // Used by visits metrics and reporting — not filtered by employment dates
  // so historical data is always accurate
  // getDayFTE counts entries for ALL staff (including archived) on a given date
  // Archive status only affects scheduling views — past hours always count in metrics
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

  const SICK_BALANCE_HRS = 56; // fixed annual sick balance, resets Jan 1
  const currentYear = new Date().getFullYear();
  const ptoAlerts = useMemo(() => {
    const alerts = [];
    // Find SICK code from nonWorkTypes
    const sickNW = nonWorkTypes.find(t => t.code === "SICK" || t.label?.toLowerCase().includes("sick"));
    const sickCode = sickNW?.code || "SICK";
    if (!sickNW) return []; // sick code not defined yet
    staff.forEach(s => {
      const used = {};
      Object.entries(entries).forEach(([key, val]) => {
        if (!key.startsWith(s.id + "_")) return;
        // Only count entries in the current year
        const dateStr = key.substring(key.indexOf("_") + 1);
        if (!dateStr.startsWith(String(currentYear))) return;
        const segs = Array.isArray(val) ? val : (val ? [val] : []);
        segs.forEach(e => {
          if (e.nonWork) {
            const hrs = Number(e.nonWorkHours) || Number(e.hours) || 8;
            used[e.nonWork] = (used[e.nonWork] || 0) + hrs;
          }
        });
      });
      // Only alert on sick time
      const sickUsed = used[sickCode] || 0;
      if (sickUsed > SICK_BALANCE_HRS) {
        alerts.push({ staffId:s.id, staffName:s.name, team:s.team, code:sickCode, usedHrs:sickUsed, limit:SICK_BALANCE_HRS, overBy:sickUsed-SICK_BALANCE_HRS, severity:"red" });
      } else if (sickUsed >= SICK_BALANCE_HRS * 0.9) {
        alerts.push({ staffId:s.id, staffName:s.name, team:s.team, code:sickCode, usedHrs:sickUsed, limit:SICK_BALANCE_HRS, overBy:0, severity:"amber" });
      }
    });
    return alerts.sort((a,b) => (b.severity==="red"?1:0)-(a.severity==="red"?1:0) || a.staffName.localeCompare(b.staffName));
  }, [staff, entries, nonWorkTypes]);

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
      // Use all non-archived staff (not filteredStaff) to match timesheet total
      const activeStaff = staff.filter(s => {
        if (s.archived) return false;
        if (s.startDate && ds < s.startDate) return false;
        if (s.terminationDate && ds > s.terminationDate) return false;
        return true;
      });
      activeStaff.forEach(s => {
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
    const staffRows = [["id","name","team","fte","defaultHours","shiftStart","shiftEnd","defaultSchedule","notes"]];
    staff.forEach(s => staffRows.push([
      s.id, s.name, s.team, s.fte, s.defaultHours,
      s.shiftStart||"08:00", s.shiftEnd||"16:00",
      JSON.stringify(s.defaultSchedule||[]),
      s.notes||""
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

    // Sheet 6: Locations
    const locRows = [["id","team","name"]];
    locations.forEach(l => locRows.push([l.id, l.team, l.name]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(locRows), "Locations");

    // Sheet 7: Alert Settings
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
    { id:"day",       icon:"☀️", label:"Day"        },
    { id:"grid",      icon:"📅", label:"Week"       },
    { id:"master",    icon:"📋", label:"Master"     },
    { id:"month",     icon:"🗓", label:"Month",     staffHidden: true },
    { id:"year",      icon:"📆", label:"Year",      staffHidden: true },
    { id:"summary",   icon:"📊", label:"Dept Stats & Visits", staffHidden: true },
    { id:"timesheet", icon:"🕐", label:"Timesheets",staffHidden: true },
    { id:"analytics", icon:"🔍", label:"Analytics", adminOnly: true },
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
  if (!authChecked) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"linear-gradient(135deg,#0f2744,#1e3a5f)"}}>
      <div style={{textAlign:"center",color:"#fff"}}>
        <div style={{fontSize:32,marginBottom:12}}>⏳</div>
        <div style={{fontSize:16,fontWeight:700}}>StaffPlan</div>
        <div style={{fontSize:12,opacity:0.6,marginTop:4}}>Checking session...</div>
      </div>
    </div>
  );

  if (!currentUser) return (
    <LoginScreen onLogin={(user) => {
      setCurrentUser(user);
      trackEvent(user.id, user.email, "login", { role: user.profile?.role });
      tabEnteredAt.current = Date.now();
    }} />
  );

  if (!loaded) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:"#f0f4f8"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:12}}>⏳</div>
        <div style={{fontSize:16,fontWeight:700,color:"#1e3a5f"}}>Loading staffing data...</div>
        <div style={{fontSize:12,color:"#6b7280",marginTop:4}}>Signed in as {currentUser.email}</div>
      </div>
    </div>
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
          {VIEW_TABS.filter(tab => (!tab.adminOnly || userRole === "admin") && (!tab.staffHidden || !isStaffRole)).map(tab => (
            <button key={tab.id} onClick={() => {
              const duration = Math.round((Date.now() - tabEnteredAt.current) / 1000);
              trackEvent(currentUser.id, currentUser.email, "tab_exit", { tab: activeTab, duration_seconds: duration });
              tabEnteredAt.current = Date.now();
              trackEvent(currentUser.id, currentUser.email, "tab_view", { tab: tab.id });
              setActiveTab(tab.id);
              // Update presence with new tab
              if (presenceChannel.current) {
                presenceChannel.current.track({ tab: tab.id }).catch(()=>{});
              }
            }} style={{
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

        {/* Online presence indicators */}
        {Object.keys(onlineUsers).length > 0 && (
          <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:99,background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.12)"}}>
            <span style={{fontSize:9,color:"#93c5fd",fontWeight:600,marginRight:2}}>ONLINE</span>
            {Object.entries(onlineUsers).map(([uid, u]) => (
              <PresenceAvatar key={uid} user={u} isMe={uid === currentUser?.id} />
            ))}
          </div>
        )}

        {/* Right controls */}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <SaveBadge status={saveStatus} />
          {canEdit && <button onClick={undo} disabled={!canUndo} title="Undo last change (Ctrl+Z)"
            style={{padding:"5px 11px",borderRadius:8,fontSize:13,fontWeight:700,cursor:canUndo?"pointer":"not-allowed",
              border:"1px solid rgba(255,255,255,0.2)",
              background:canUndo?"rgba(255,255,255,0.15)":"rgba(255,255,255,0.05)",
              color:canUndo?"#fff":"rgba(255,255,255,0.25)",
              transition:"all 0.15s"}} >
            ↩ Undo
          </button>}

          {/* User pill */}
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:8,background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.15)"}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:isAdmin?"#f59e0b":canEdit?"#22c55e":"#93c5fd",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#fff",flexShrink:0}}>
              {(currentUser?.profile?.display_name||currentUser?.email||"?")[0].toUpperCase()}
            </div>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:"#fff",lineHeight:1}}>{currentUser?.profile?.display_name||currentUser?.email}</div>
              <div style={{fontSize:9,color:"#93c5fd",textTransform:"uppercase",letterSpacing:"0.05em"}}>{userRole}</div>
            </div>
          </div>

          {/* ⋯ Menu */}
          <div style={{position:"relative"}} ref={menuRef}>
            {!isStaffRole && <button onClick={() => setMenuOpen(o => !o)} style={{
              padding:"6px 14px",borderRadius:8,background:menuOpen?"#fff":"rgba(255,255,255,0.12)",
              border:"1px solid rgba(255,255,255,0.2)",color:menuOpen?"#1e3a5f":"#e2e8f0",
              cursor:"pointer",fontSize:13,fontWeight:700
            }}>☰ Menu</button>}
            {menuOpen && (
              <div onClick={() => setMenuOpen(false)} style={{
                position:"absolute",right:0,top:"calc(100% + 6px)",background:"#fff",borderRadius:12,
                boxShadow:"0 8px 32px rgba(0,0,0,0.18)",border:"1px solid #e5e7eb",minWidth:300,zIndex:500,
                padding:"6px 0",overflow:"hidden"
              }}>
                {[
                  canEdit && { icon:"👥", label:"Staff",              color:"#1e3a5f", action:()=>setShowStaffManager(true),   desc:"Add, edit, or archive staff members and manage their schedules" },
                  canEdit && { icon:"📝", label:"Enter Visit Data",   color:"#0ea5e9", action:()=>setShowVisitEntry(true),     desc:"Log weekly evals and patient visits by team" },
                  canEdit && { icon:"📋", label:"Batch Schedule Entry",color:"#7c3aed", action:()=>setShowBatchEntry(true),    desc:"Apply a schedule to multiple staff at once for a date range" },
                  canEdit && { icon:"⬆", label:"Bulk Upload",         color:"#22c55e", action:()=>setShowUpload(true),         desc:"Import staff schedules from a CSV file" },
                  { icon:"📥", label:"Export Excel",                  color:"#f59e0b", action:exportToExcel,                   desc:"Download the current week's schedule as an Excel spreadsheet" },
                  isAdmin && { icon:"💾", label:"Backup All Data",    color:"#0ea5e9", action:exportBackup,                    desc:"Export everything — staff, schedules, visits, settings — to Excel" },
                  isAdmin && { icon:"📂", label:"Restore from Backup",color:"#7c3aed", action:()=>setShowBackupRestore(true),  desc:"Reload a previously exported backup file to restore all data" },
                  canEdit && { icon:"📦", label:`Archived Staff${staff.some(s=>s.archived)?` (${staff.filter(s=>s.archived).length})`:""}`, color:"#92400e", action:()=>setShowArchivedManager(true), desc:"View staff who have been archived — restore or permanently delete them" },
                  isAdmin && { icon:"⚙", label:"Non-Work Codes",     color:"#8b5cf6", action:()=>setShowNonWorkEditor(true),  desc:"Create and manage leave codes like VAC, SICK, PFL and their colors" },
                  isAdmin && { icon:"📍", label:"Locations",             color:"#0ea5e9", action:()=>setShowLocationEditor(true),  desc:"Define locations within each team that staff can be assigned to" },
                  isAdmin && { icon:"🎯", label:"Competencies",           color:"#10b981", action:()=>setShowCompetencyEditor(true), desc:"Define clinical competency areas staff can be qualified in" },
                  isAdmin && { icon:"📅", label:"Holiday Calendar",        color:"#f59e0b", action:()=>setShowHolidayCalendar(true),  desc:"Manage annual holidays — mark them on the calendar with one click" },
                  isAdmin && { icon:"🔔", label:"Alert Settings",     color:"#f59e0b", action:()=>setShowAlertsEditor(true),   desc:"Set FTE and census thresholds for warnings" },
                  isAdmin && { icon:"👤", label:"Manage Users",       color:"#1e3a5f", action:()=>setShowUserManager(true),    desc:"Add users and control who can view or edit the schedule" },
                  { icon:"🔐", label:"Change Password",               color:"#374151", action:()=>setShowPwManager(true),      desc:"Update your account password" },
                  { icon:"🚪", label:"Sign Out",                      color:"#dc2626", action:async()=>{ await sbSignOut(); setCurrentUser(null); setLoaded(false); setStaff([]); setEntries({}); }, desc:"Sign out of StaffPlan" },
                ].filter(Boolean).map(item => (
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

          <div style={{marginLeft:"auto",display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
            {["All",...TEAMS].map(t=>(
              <button key={t} onClick={()=>setFilterTeam(t)} style={{
                padding:"3px 10px",borderRadius:99,fontSize:11,fontWeight:600,cursor:"pointer",
                background:filterTeam===t?(t==="All"?"#1e3a5f":TEAM_COLORS[t]?.bg):"#f9fafb",
                color:filterTeam===t?(t==="All"?"#fff":TEAM_COLORS[t]?.text):"#6b7280",
                border:"1px solid "+(filterTeam===t?"transparent":"#e5e7eb")
              }}>{t}</button>
            ))}
            {competencies.length > 0 && (
              <CompetencyFilterDropdown
                competencies={competencies}
                filterCompetencies={filterCompetencies}
                setFilterCompetencies={setFilterCompetencies}
              />
            )}
            <PersonFilterDropdown
              staff={staff.filter(s => !s.archived)}
              filterPersons={filterPersons}
              setFilterPersons={setFilterPersons}
            />
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
          {!isStaffRole && <Metric label="Shifts" value={weeklyMetrics.totalShifts} />}
          {!isStaffRole && <Metric label="Hours" value={weeklyMetrics.totalHours} />}
          {!isStaffRole && nonWorkTypes.map(t => weeklyMetrics.nonWork[t.code] > 0 && (
            <Metric key={t.code} label={t.label} value={(weeklyMetrics.nonWork[t.code]/8 % 1 === 0 ? weeklyMetrics.nonWork[t.code]/8 : (weeklyMetrics.nonWork[t.code]/8).toFixed(1))+"d"} color={t.color} />
          ))}
        </div>}
      </div>

      {/* ── Tab content ── */}
      <div style={{padding: typeof window !== "undefined" && window.innerWidth < 640 ? "10px 10px" : "16px 20px"}}>
        {activeTab==="day" && (
          <DayView date={dayView} staff={staff} getEntry={getEntry} setEntrySegments={setEntrySegments}
            getDailyStats={getDailyStats} setDailyStat={setDailyStat} setHoliday={setHoliday} getDayFTE={getDayFTE}
            nwMap={nwMap} nonWorkTypes={nonWorkTypes} filterTeam={filterTeam} setFilterTeam={setFilterTeam}
            dayNotes={dayNotes} updateDayNotes={updateDayNotes} getDayAlerts={getDayAlerts} canEdit={canEdit} isStaffRole={isStaffRole} />
        )}
        {activeTab==="grid" && (
          <WeekGrid filteredStaff={filteredStaff} weekDates={weekDates} getEntry={getEntry} getDayFTE={getDayFTE}
            nwMap={nwMap} setEditingCell={setEditingCell} setDrillDay={setDrillDay}
            editingName={editingName} setEditingName={setEditingName} tempName={tempName} setTempName={setTempName}
            updateStaff={updateStaff} staff={staff} compactMode={compactMode} getDayAlerts={getDayAlerts}
            dayNotes={dayNotes} updateDayNotes={updateDayNotes} alertSettings={alertSettings}
            getDailyStats={getDailyStats} setDailyStat={setDailyStat} setHoliday={setHoliday} todayStr={todayStr}
            canEdit={canEdit} competencies={competencies} filterCompetencies={filterCompetencies} setFilterCompetencies={setFilterCompetencies} isStaffRole={isStaffRole} />
        )}
        {activeTab==="month" && (
          <MonthView year={monthView.year} month={monthView.month} staff={staff} getEntry={getEntry}
            getDayFTE={getDayFTE} nwMap={nwMap} setDrillDay={setDrillDay}
            setWeekStart={setWeekStart} setActiveTab={setActiveTab} setDayView={setDayView} todayStr={todayStr}
            getDayAlerts={getDayAlerts} />
        )}
        {activeTab==="year" && (
          <YearView year={yearView} staff={staff} getEntry={getEntry} getDayFTE={getDayFTE} nwMap={nwMap}
            setWeekStart={setWeekStart} setActiveTab={setActiveTab} setDrillDay={setDrillDay} getDayAlerts={getDayAlerts} />
        )}
        {activeTab==="master" && (
          <MasterScheduleView staff={staff} filterTeam={filterTeam} />
        )}
        {activeTab==="summary" && (
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <SummaryTab weekDates={weekDates} getEntry={getEntry} getDailyStats={getDailyStats} getDayFTE={getDayFTE} weeklyMetrics={weeklyMetrics} nonWorkTypes={nonWorkTypes} staff={staff} dailyStats={dailyStats} yearView={yearView} ptoAlerts={ptoAlerts} entries={entries} />
            <div style={{borderTop:"2px solid #e5e7eb",paddingTop:16}}>
              <VisitsTab visitData={visitData} updateVisitData={updateVisitData} staff={staff} weekStart={weekStart} getDayFTE={getDayFTE} />
            </div>
          </div>
        )}
        {activeTab==="timesheet" && (
          <TimesheetTab staff={staff} entries={entries} weekStart={weekStart} nonWorkTypes={nonWorkTypes} />
        )}
        {activeTab==="analytics" && userRole === "admin" && (
          <AnalyticsDashboard currentUser={currentUser} />
        )}

      </div>

      {editingCell && <CellEditor staffId={editingCell.staffId} dateStr={editingCell.dateStr} staff={staff}
        getEntry={getEntry} setEntrySegments={setEntrySegments} nwMap={nwMap} nonWorkTypes={nonWorkTypes} onClose={()=>setEditingCell(null)} getDailyStats={getDailyStats} locations={locations} />}
      {drillDay && <DayDrillDown date={drillDay} staff={staff} getEntry={getEntry} getDailyStats={getDailyStats}
        setDailyStat={setDailyStat} setHoliday={setHoliday} getDayFTE={getDayFTE} nwMap={nwMap} onClose={()=>setDrillDay(null)} canEdit={canEdit} />}
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
                updatePtoBalances={updatePtoBalances} ptoAlerts={ptoAlerts} competencies={competencies} />
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
        updateDayNotes={updateDayNotes} updateVisitData={updateVisitData}  updateLocations={updateLocations} />}
      {showUpload && <BulkUploadModal staff={staff} updateStaff={updateStaff} entries={entries} updateEntries={updateEntries}
        nonWorkTypes={nonWorkTypes} onClose={()=>setShowUpload(false)} />}
      {showNonWorkEditor && <NonWorkEditor nonWorkTypes={nonWorkTypes} updateNonWorkTypes={updateNonWorkTypes} onClose={()=>setShowNonWorkEditor(false)} />}
      {showPwManager && <PasswordManager currentUser={currentUser} onClose={()=>setShowPwManager(false)} />}
      {showAlertsEditor && <AlertsEditor alertSettings={alertSettings} updateAlertSettings={updateAlertSettings} onClose={()=>setShowAlertsEditor(false)} />}
      {showBatchEntry && <BatchEntryModal staff={staff} entries={entries} updateEntries={updateEntries} nonWorkTypes={nonWorkTypes} onClose={()=>setShowBatchEntry(false)} />}
      {showUserManager && <UserManagerModal currentUser={currentUser} onClose={()=>setShowUserManager(false)} />}
      {showLocationEditor && <LocationEditor locations={locations} updateLocations={updateLocations} onClose={()=>setShowLocationEditor(false)} />}
      {showCompetencyEditor && <CompetencyEditor competencies={competencies} updateCompetencies={updateCompetencies} onClose={()=>setShowCompetencyEditor(false)} />}
      {showHolidayCalendar && <HolidayCalendarEditor holidays={holidays} updateHolidays={updateHolidays} setHoliday={setHoliday} onClose={()=>setShowHolidayCalendar(false)} />}
      {menuOpen && <div style={{position:"fixed",inset:0,zIndex:499}} onClick={()=>setMenuOpen(false)} />}
    </div>
  );
}

// ── Shared nav button styles ──────────────────────────────────────────────────
const navBtn = { padding:"5px 12px",borderRadius:8,background:"#f1f5f9",border:"1px solid #e2e8f0",cursor:"pointer",fontSize:15,fontWeight:700,color:"#374151" };
const todayBtn = { padding:"5px 12px",borderRadius:8,background:"#eff6ff",border:"1px solid #bfdbfe",cursor:"pointer",fontSize:12,fontWeight:600,color:"#1d4ed8" };

// ─── Daily View ──────────────────────────────────────────────────────────────
function DayView({ date, staff, getEntry, setEntrySegments, getDailyStats, setDailyStat, setHoliday, getDayFTE, nwMap, nonWorkTypes, filterTeam, setFilterTeam, dayNotes, updateDayNotes, getDayAlerts, canEdit=false, isStaffRole=false }) {
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
    const [sh, sm] = start.split(":").map(Number);
    const startHour = sh + sm / 60;
    // End hour derived from actual scheduled hours, not the default shift end time
    const endHour = totalHrs > 0 ? startHour + totalHrs : startHour;
    const nonWorkOnly = totalHrs === 0 && hasNonWork;
    return { startHour, endHour, totalHrs: isNaN(totalHrs) ? 0 : totalHrs, segs, nonWorkOnly };
  };

  // Only staff with actual worked hours appear on the timeline
  // Filter by employment window for this specific day
  const activeFiltered = filtered.filter(s => {
    if (s.startDate && ds < s.startDate) return false;
    if (s.terminationDate && ds > s.terminationDate) return false;
    return true;
  });
  const staffOnDuty = activeFiltered.map(s => ({ s, info: getStaffHours(s) })).filter(x => x.info && !x.info.nonWorkOnly);
  // Staff with non-work codes but no worked hours
  const staffOut = activeFiltered.map(s => ({ s, info: getStaffHours(s) })).filter(x => x.info && x.info.nonWorkOnly);
  // Staff with no entry at all
  const notScheduled = activeFiltered.filter(s => !getStaffHours(s));

  const isMobile = useWindowWidth() < 640;

  return (
    <div style={{ display: "grid", gap: isMobile ? 10 : 14 }}>
      {/* Holiday banner */}
      {stats.holiday && (
        <div style={{padding:"10px 16px",borderRadius:10,background:"#ede9fe",border:"1px solid #c4b5fd",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:700,color:"#7c3aed"}}>
            ⛱ Holiday — staff are not scheduled by default. Manually enter anyone working holiday hours below.
          </div>
          {canEdit && <button onClick={()=>setDailyStat(ds,"holiday",false)} style={{fontSize:11,padding:"3px 10px",borderRadius:6,background:"#7c3aed",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,flexShrink:0}}>Remove Holiday</button>}
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
        {canEdit ? (
          <input
            value={dayNotes?.[ds]||""}
            onChange={e => updateDayNotes && updateDayNotes({...dayNotes,[ds]:e.target.value})}
            placeholder="Add a note for today..."
            style={{flex:1,border:"none",outline:"none",fontSize:isMobile?14:12,color:"#374151",background:"transparent"}}
          />
        ) : (
          <span style={{flex:1,fontSize:12,color:dayNotes?.[ds]?"#374151":"#9ca3af"}}>{dayNotes?.[ds]||"No note for today"}</span>
        )}
      </div>

      {/* Day summary cards — Total FTE + one card per team with FTE & census aligned */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "100px repeat(" + TEAMS.length + ", 1fr)", gap: 8 }}>

        {/* Total FTE card */}
        {(() => {
          const totalCensus = TEAMS.reduce((sum, t) => sum + (Number(stats.census?.[t]) || 0), 0);
          return (
            <div style={{ background: we ? "#faf5ff" : "#fff", border: "1px solid " + (we ? "#e9d5ff" : "#e5e7eb"), borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Total FTE</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#1e3a5f", lineHeight: 1 }}>{fte.total}</div>
              <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 3 }}>{staffOnDuty.length} on duty</div>
              {totalCensus > 0 && <>
                <div style={{ width: "100%", height: 1, background: "#e5e7eb", margin: "6px 0" }} />
                <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Census</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#1e3a5f", lineHeight: 1 }}>{totalCensus}</div>
                <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>total pts</div>
              </>}
            </div>
          );
        })()}

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
            <div key={t} style={{ background: tc.bg, border: "1px solid " + tc.dot + "44", borderRadius: 10, padding: "8px 10px" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: tc.text, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5 }}>{t}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5, marginBottom: 5 }}>
                {/* FTE */}
                <div style={{ background: "rgba(255,255,255,0.5)", borderRadius: 6, padding: "5px 7px" }}>
                  <div style={{ fontSize: 9, color: tc.text + "99", fontWeight: 700, textTransform: "uppercase", marginBottom: 1 }}>FTE</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: tc.text, lineHeight: 1 }}>{teamFTE}</div>
                  <div style={{ fontSize: 9, color: tc.text + "88", marginTop: 1 }}>{teamStaffCount} staff</div>
                </div>
                {/* Census */}
                <div style={{ background: "rgba(255,255,255,0.5)", borderRadius: 6, padding: "5px 7px" }}>
                  <div style={{ fontSize: 9, color: tc.text + "99", fontWeight: 700, textTransform: "uppercase", marginBottom: 1 }}>Census</div>
                  {canEdit ? (
                    <input
                      type="number" min="0"
                      value={stats.census?.[t] || ""}
                      onChange={e => setDailyStat(ds, "census", { ...stats.census, [t]: e.target.value === "" ? 0 : Number(e.target.value) })}
                      style={{ width: "100%", border: "none", borderRadius: 4, padding: "0", fontSize: 16, fontWeight: 800, color: tc.text, background: "transparent", lineHeight: 1 }}
                      placeholder="0"
                    />
                  ) : (
                    <div style={{ fontSize: 16, fontWeight: 800, color: tc.text, lineHeight: 1 }}>{stats.census?.[t] || 0}</div>
                  )}
                  <div style={{ fontSize: 9, color: tc.text + "88", marginTop: 1 }}>patients</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, borderTop: "1px solid " + tc.dot + "22", paddingTop: 4 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: tc.text + "88", fontWeight: 600 }}>pts/FTE</div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: tc.text }}>{ptsPerFTE}</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 8, color: tc.text + "88", fontWeight: 600 }}>pts/staff</div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: tc.text }}>{ptsPerStaff}</div>
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
            padding: isMobile ? "6px 16px" : "3px 12px", borderRadius: 99, fontSize: isMobile ? 13 : 11, fontWeight: 600, cursor: "pointer",
            background: filterTeam === t ? (t === "All" ? "#1e3a5f" : TEAM_COLORS[t]?.bg) : "#f9fafb",
            color: filterTeam === t ? (t === "All" ? "#fff" : TEAM_COLORS[t]?.text) : "#6b7280",
            border: "1px solid " + (filterTeam === t ? "transparent" : "#e5e7eb")
          }}>{t}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: 14 }}>
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
                const homeTc = TEAM_COLORS[s.team];
                // Use the team they're actually working that day, not their home team
                const workSegs = info.segs.filter(e => Number(e.hours) > 0);
                const primaryWorkTeam = workSegs.length > 0 ? (workSegs[0].team || s.team) : s.team;
                const tc = TEAM_COLORS[primaryWorkTeam] || homeTc;
                const totalCols = HOUR_END - HOUR_START;
                const startPct = Math.max(0, (info.startHour - HOUR_START) / totalCols) * 100;
                const widthPct = Math.min(100 - startPct, (info.endHour - Math.max(info.startHour, HOUR_START)) / totalCols * 100);
                const nwSegs = info.segs.filter(e => e.nonWork);
                return (
                  <div key={s.id} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 0, marginBottom: 4, alignItems: "center" }}>
                    <div style={{ paddingRight: 8, overflow: "hidden", minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {/* Dot shows actual working team color; home team dot shown smaller if different */}
                        <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: tc?.dot, marginRight: primaryWorkTeam !== s.team ? 2 : 5, flexShrink: 0 }} />
                        {primaryWorkTeam !== s.team && (
                          <span title={`Home team: ${s.team}`} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: homeTc?.dot, marginRight: 4, opacity: 0.5, flexShrink: 0 }} />
                        )}
                        {s.name}
                      </div>
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
                        display: "flex", alignItems: "center", overflow: "hidden", gap: 0
                      }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", padding: "0 5px", flexShrink: 0 }}>
                          {info.totalHrs}h
                          {info.segs.length > 1 && " split"}
                          {nwSegs.length > 0 && !isStaffRole && " · " + nwSegs[0].nonWork}
                        </span>
                        {info.segs.filter(e=>e.location).map((e,li) => {
                          const tc2 = TEAM_COLORS[e.team||s.team];
                          return (
                            <span key={li} style={{
                              fontSize:8, fontWeight:800, color:"#fff", whiteSpace:"nowrap",
                              padding:"0 5px", borderRadius:0, flexShrink:0,
                              background:"rgba(0,0,0,0.18)",
                              borderLeft:"1px solid rgba(255,255,255,0.3)",
                              letterSpacing:"0.03em", alignSelf:"stretch",
                              display:"flex", alignItems:"center"
                            }}>📍 {e.location}</span>
                          );
                        })}
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
          )}
        </div>

        {/* Staff roster panel */}
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid #f3f4f6", fontSize: 12, fontWeight: 700, color: "#15803d" }}>
              ✓ On Duty ({staffOnDuty.length})
            </div>
            <div style={{ maxHeight: isMobile ? "none" : 220, overflowY: isMobile ? "visible" : "auto" }}>
              {staffOnDuty.map(({ s, info }) => {
                const homeTc = TEAM_COLORS[s.team];
                const workSegs = info.segs.filter(e => Number(e.hours) > 0);
                const primaryWorkTeam = workSegs.length > 0 ? (workSegs[0].team || s.team) : s.team;
                const tc = TEAM_COLORS[primaryWorkTeam] || homeTc;
                return (
                  <div key={s.id} style={{ padding: "7px 14px", borderBottom: "1px solid #f9fafb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 6, height: 6, borderRadius: "50%", background: tc?.dot }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{s.name}</span>
                    </div>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap:"wrap", justifyContent:"flex-end" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#1e3a5f" }}>{info.totalHrs}h</span>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 99, background: tc?.bg, color: tc?.text, fontWeight: 600 }}>{primaryWorkTeam}{primaryWorkTeam !== s.team && <span style={{opacity:0.6}}> ↩{s.team}</span>}</span>

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
              <div style={{ maxHeight: isMobile ? "none" : 160, overflowY: isMobile ? "visible" : "auto" }}>
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
                        {isStaffRole ? (
                          <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 99, background: "#f3f4f6", color: "#6b7280", fontWeight: 700 }}>Out</span>
                        ) : nwSegs.map((e, i) => {
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
            <div style={{ maxHeight: isMobile ? "none" : 130, overflowY: isMobile ? "visible" : "auto" }}>
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
                  background: isHov ? "#f0f9ff" : isToday ? "#fef08a" : we ? "#faf5ff" : getFTEColor(data.fte.total),
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
// ─── Password Manager (Supabase) ─────────────────────────────────────────────
function PasswordManager({ currentUser, onClose }) {
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const showMsg = (text, type) => { setMsg({text, type}); setTimeout(()=>setMsg(null), 3500); };

  const save = async () => {
    if (newPw !== confirm) { showMsg("Passwords don't match.", "err"); return; }
    if (newPw.length < 8) { showMsg("Password must be at least 8 characters.", "err"); return; }
    setLoading(true);
    try {
      await sbUpdatePassword(newPw);
      showMsg("Password updated! ✓", "ok");
      setTimeout(onClose, 1500);
    } catch(e) { showMsg(e.message || "Failed to update password.", "err"); }
    setLoading(false);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:30,width:400,boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>🔐 Change Password</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>Changing password for: <strong>{currentUser?.email}</strong></div>
        <div style={{display:"grid",gap:12}}>
          <div>
            <label style={lbl}>New Password</label>
            <input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} style={inp} placeholder="At least 8 characters" />
          </div>
          <div>
            <label style={lbl}>Confirm New Password</label>
            <input type="password" value={confirm} onChange={e=>setConfirm(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&save()} style={inp} placeholder="Repeat password" />
          </div>
        </div>
        {msg && <div style={{marginTop:12,padding:"8px 14px",borderRadius:8,fontSize:13,fontWeight:600,background:msg.type==="ok"?"#f0fdf4":"#fef2f2",color:msg.type==="ok"?"#15803d":"#dc2626"}}>{msg.text}</div>}
        <div style={{display:"flex",gap:8,marginTop:18}}>
          <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
          <button onClick={save} disabled={loading} style={{flex:2,padding:"10px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>
            {loading?"Saving...":"Update Password"}
          </button>
        </div>
      </div>
    </div>
  );
}




// ─── Competency Filter Dropdown ───────────────────────────────────────────────
function CompetencyFilterDropdown({ competencies, filterCompetencies, setFilterCompetencies }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{position:"relative"}}>
      <button onClick={()=>setOpen(v=>!v)} style={{
        padding:"3px 10px",borderRadius:99,fontSize:11,fontWeight:600,cursor:"pointer",
        background:filterCompetencies.length>0?"#1e3a5f":"#f9fafb",
        color:filterCompetencies.length>0?"#fff":"#6b7280",
        border:"1px solid "+(filterCompetencies.length>0?"#1e3a5f":"#e5e7eb"),
        display:"flex",alignItems:"center",gap:5
      }}>
        {"🎯 " + (filterCompetencies.length > 0 ? "Competency ("+filterCompetencies.length+")" : "Competency ▼")}
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:200,
          background:"#fff",borderRadius:12,border:"1px solid #e5e7eb",
          boxShadow:"0 8px 24px rgba(0,0,0,0.12)",padding:"10px 12px",minWidth:190}}>
          <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>
            Filter by Competency
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            {competencies.map(c => {
              const active = filterCompetencies.includes(c.id);
              return (
                <button key={c.id} onClick={()=>setFilterCompetencies(prev =>
                  active ? prev.filter(x=>x!==c.id) : [...prev, c.id]
                )} style={{
                  display:"flex",alignItems:"center",gap:8,padding:"5px 8px",
                  borderRadius:8,border:"1px solid "+(active?c.color+"66":"#f3f4f6"),
                  background:active?c.color+"15":"#f9fafb",
                  cursor:"pointer",textAlign:"left"
                }}>
                  <span style={{width:10,height:10,borderRadius:"50%",background:c.color,flexShrink:0,
                    outline:active?"2px solid "+c.color:"none",outlineOffset:"1px"}} />
                  <span style={{fontSize:12,fontWeight:active?700:500,color:active?c.color:"#374151",flex:1}}>{c.name}</span>
                  {active && <span style={{fontSize:10,color:c.color}}>✓</span>}
                </button>
              );
            })}
          </div>
          {filterCompetencies.length > 0 && (
            <button onClick={()=>{setFilterCompetencies([]);setOpen(false);}} style={{
              marginTop:8,width:"100%",padding:"5px",borderRadius:7,
              background:"#f3f4f6",border:"none",fontSize:11,fontWeight:600,
              color:"#6b7280",cursor:"pointer"
            }}>✕ Clear all</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Competency Editor ────────────────────────────────────────────────────────
function CompetencyEditor({ competencies, updateCompetencies, onClose }) {
  const [items, setItems] = useState(competencies.map(c=>({...c})));
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#10b981");

  const PRESET_COLORS = ["#10b981","#ef4444","#f59e0b","#3b82f6","#8b5cf6","#06b6d4","#f97316","#ec4899","#64748b","#dc2626"];

  const addItem = () => {
    if (!newName.trim()) return;
    const id = Date.now();
    setItems(prev => [...prev, { id, name: newName.trim(), color: newColor }]);
    setNewName("");
  };

  const removeItem = (id) => setItems(prev => prev.filter(c => c.id !== id));
  const updateColor = (id, color) => setItems(prev => prev.map(c => c.id===id ? {...c, color} : c));
  const updateName = (id, name) => setItems(prev => prev.map(c => c.id===id ? {...c, name} : c));

  const save = () => { updateCompetencies(items); onClose(); };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:480,maxHeight:"85vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>🎯 Competency Areas</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>
          Define clinical competency areas. Assign them to staff members, then filter the weekly schedule by competency to see who can cover specific areas.
        </div>

        {/* Existing items */}
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:18}}>
          {items.length === 0 && (
            <div style={{textAlign:"center",padding:"16px 0",color:"#9ca3af",fontSize:13}}>No competencies defined yet</div>
          )}
          {items.map(c => (
            <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",borderRadius:10,background:"#f9fafb",border:"1px solid #f3f4f6"}}>
              <input type="color" value={c.color} onChange={e=>updateColor(c.id,e.target.value)}
                style={{width:28,height:28,borderRadius:6,border:"1px solid #e5e7eb",cursor:"pointer",padding:2}} />
              <input value={c.name} onChange={e=>updateName(c.id,e.target.value)}
                style={{flex:1,border:"1px solid #e5e7eb",borderRadius:7,padding:"5px 8px",fontSize:13,fontWeight:600}} />
              <span style={{fontSize:11,padding:"2px 10px",borderRadius:99,background:c.color+"22",color:c.color,fontWeight:700,border:"1px solid "+c.color+"44"}}>{c.name}</span>
              <button onClick={()=>removeItem(c.id)} style={{background:"#fee2e2",border:"none",borderRadius:6,color:"#dc2626",fontWeight:700,cursor:"pointer",padding:"3px 8px",fontSize:11}}>✕</button>
            </div>
          ))}
        </div>

        {/* Add new */}
        <div style={{borderTop:"1px solid #f3f4f6",paddingTop:16,marginBottom:18}}>
          <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:10}}>Add New Competency</div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {PRESET_COLORS.map(col => (
                <button key={col} onClick={()=>setNewColor(col)} style={{
                  width:20,height:20,borderRadius:"50%",background:col,border:newColor===col?"3px solid #1e3a5f":"2px solid transparent",cursor:"pointer",padding:0
                }} />
              ))}
              <input type="color" value={newColor} onChange={e=>setNewColor(e.target.value)}
                style={{width:20,height:20,borderRadius:"50%",border:"1px solid #e5e7eb",cursor:"pointer",padding:1}} />
            </div>
            <input value={newName} onChange={e=>setNewName(e.target.value)}
              placeholder="e.g. Burn, NICU, Psych..."
              onKeyDown={e=>e.key==="Enter"&&addItem()}
              style={{flex:1,minWidth:140,border:"1px solid #e5e7eb",borderRadius:8,padding:"6px 10px",fontSize:13}} />
            <button onClick={addItem} style={{padding:"6px 16px",borderRadius:8,background:"#1e3a5f",color:"#fff",border:"none",fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Add</button>
          </div>
        </div>

        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{padding:"8px 20px",borderRadius:9,background:"#f3f4f6",border:"none",fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
          <button onClick={save} style={{padding:"8px 20px",borderRadius:9,background:"#1e3a5f",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Location Editor ──────────────────────────────────────────────────────────
function LocationEditor({ locations, updateLocations, onClose }) {
  const [locs, setLocs] = useState(locations.map(l=>({...l})));
  const [newName, setNewName] = useState("");
  const [newTeam, setNewTeam] = useState(TEAMS[0]);

  const add = () => {
    if (!newName.trim()) return;
    const id = Date.now();
    setLocs(prev => [...prev, { id, team: newTeam, name: newName.trim() }]);
    setNewName("");
  };

  const remove = (id) => setLocs(prev => prev.filter(l => l.id !== id));

  const save = () => { updateLocations(locs); onClose(); };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:480,maxHeight:"85vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div>
            <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>📍 Manage Locations</div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>Define locations within each team that staff can be assigned to</div>
          </div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        {/* Existing locations by team */}
        <div style={{marginBottom:18}}>
          {TEAMS.map(team => {
            const teamLocs = locs.filter(l => l.team === team);
            const tc = TEAM_COLORS[team];
            return (
              <div key={team} style={{marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,color:tc?.text||"#374151",marginBottom:6,padding:"3px 8px",background:tc?.bg||"#f9fafb",borderRadius:6,display:"inline-block"}}>{team}</div>
                {teamLocs.length === 0 && <div style={{fontSize:11,color:"#9ca3af",marginLeft:4}}>No locations defined</div>}
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
                  {teamLocs.map(l => (
                    <div key={l.id} style={{display:"flex",alignItems:"center",gap:4,padding:"4px 10px",borderRadius:99,background:tc?.bg||"#f9fafb",border:"1px solid "+(tc?.dot||"#e5e7eb")}}>
                      <span style={{fontSize:12,fontWeight:600,color:tc?.text||"#374151"}}>{l.name}</span>
                      <button onClick={()=>remove(l.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#9ca3af",fontSize:12,fontWeight:700,padding:0,lineHeight:1}}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Add new location */}
        <div style={{padding:"14px 16px",background:"#f8fafc",borderRadius:10,border:"1px solid #e5e7eb",marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:10}}>➕ Add Location</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"end"}}>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Team</label>
              <select value={newTeam} onChange={e=>setNewTeam(e.target.value)} style={{...sel,fontSize:12,padding:"7px 8px",width:"100%"}}>
                {TEAMS.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Location Name</label>
              <input value={newName} onChange={e=>setNewName(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&add()}
                placeholder="e.g. 4 East, NICU, Gym..."
                style={{...inp,fontSize:12,padding:"7px 8px",width:"100%"}} />
            </div>
            <button onClick={add} style={{padding:"7px 14px",borderRadius:8,background:"#1e3a5f",color:"#fff",border:"none",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>
              Add
            </button>
          </div>
        </div>

        <div style={{display:"flex",gap:8}}>
          <button onClick={onClose} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>Cancel</button>
          <button onClick={save} style={{flex:2,padding:"10px",borderRadius:10,background:"#1e3a5f",color:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:700}}>Save Locations</button>
        </div>
      </div>
    </div>
  );
}

// ─── User Manager Modal (admin only) ─────────────────────────────────────────
function UserManagerModal({ currentUser, onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("viewer");
  const [msg, setMsg] = useState(null);
  const [creating, setCreating] = useState(false);

  const showMsg = (text, type="ok") => { setMsg({text,type}); setTimeout(()=>setMsg(null),4000); };

  const loadUsers = async () => {
    const sb = await getSB();
    const { data } = await sb.from("user_profiles").select("*").order("created_at");
    setUsers(data || []);
    setLoading(false);
  };

  useEffect(() => { loadUsers(); }, []);

  const createUser = async () => {
    if (!newEmail || !newPw || newPw.length < 8) {
      showMsg("Email and password (min 8 chars) required.", "err"); return;
    }
    setCreating(true);
    try {
      const sb = await getSB();
      // Create user via standard signUp (works with anon key, email confirm disabled)
      const { data, error } = await sb.auth.signUp({
        email: newEmail, password: newPw,
        options: { data: { display_name: newName || newEmail.split("@")[0] } }
      });
      if (error) throw error;
      if (!data.user) throw new Error("User creation failed — check Supabase Auth settings.");
      // Wait for DB trigger to create the profile row, then update all required fields
      await new Promise(r => setTimeout(r, 1500));
      const displayName = newName || newEmail.split("@")[0];
      const { error: roleErr } = await sb.from("user_profiles").update({
        role: newRole,
        display_name: displayName,
        email: newEmail,
        updated_at: new Date().toISOString()
      }).eq("id", data.user.id);
      if (roleErr) console.error("Role update error:", roleErr.message, roleErr.code);
      showMsg("✓ User " + newEmail + " created as " + newRole + ". They can sign in now.");
      setNewEmail(""); setNewPw(""); setNewName(""); setNewRole("viewer");
      setTimeout(loadUsers, 500);
    } catch(e) { showMsg(e.message || "Failed to create user.", "err"); }
    setCreating(false);
  };

  const updateRole = async (userId, role) => {
    const sb = await getSB();
    await sb.from("user_profiles").update({ role }).eq("id", userId);
    setUsers(prev => prev.map(u => u.id===userId ? {...u, role} : u));
  };

  const deleteUser = async (userId, email) => {
    if (!confirm("Remove " + email + "? They will lose access immediately.")) return;
    const sb = await getSB();
    const { error: delErr } = await sb.from("user_profiles").delete().eq("id", userId);
    if (delErr) {
      showMsg("Failed to remove: " + delErr.message, "err");
      return;
    }
    setUsers(prev => prev.filter(u => u.id !== userId));
    showMsg(email + " removed. They can no longer log in.");
  };

  const roleBadge = (role) => {
    const c = role==="admin"?"#f59e0b":role==="manager"?"#22c55e":"#93c5fd";
    return <span style={{padding:"2px 8px",borderRadius:99,background:c+"22",color:c,fontSize:10,fontWeight:800,textTransform:"uppercase"}}>{role}</span>;
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:580,maxHeight:"85vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <div style={{fontSize:18,fontWeight:800,color:"#1e3a5f"}}>👤 Manage Users</div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:2}}>Control who can access and edit StaffPlan</div>
          </div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        {/* Role legend */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16,padding:"12px 14px",background:"#f8fafc",borderRadius:9,border:"1px solid #e5e7eb"}}>
          <div style={{fontSize:11,color:"#6b7280"}}><strong style={{color:"#f59e0b"}}>Admin</strong> — full access, manage users, settings & holidays</div>
          <div style={{fontSize:11,color:"#6b7280"}}><strong style={{color:"#22c55e"}}>Manager</strong> — edit schedules, census & visit data</div>
          <div style={{fontSize:11,color:"#6b7280"}}><strong style={{color:"#3b82f6"}}>Viewer</strong> — read only, all tabs visible, no editing</div>
          <div style={{fontSize:11,color:"#6b7280"}}><strong style={{color:"#a78bfa"}}>Staff</strong> — Day, Week & Master views only · hours visible, no reason codes shown</div>
        </div>

        {/* Existing users */}
        {loading ? <div style={{textAlign:"center",padding:20,color:"#9ca3af"}}>Loading...</div> : (
          <div style={{marginBottom:20}}>
            <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:8}}>Current Users ({users.length})</div>
            <div style={{border:"1px solid #e5e7eb",borderRadius:10,overflow:"hidden"}}>
              {users.map((u,i) => (
                <div key={u.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderBottom:i<users.length-1?"1px solid #f3f4f6":"none",background:u.id===currentUser?.id?"#f0f7ff":"#fff"}}>
                  <div style={{width:32,height:32,borderRadius:"50%",background:u.role==="admin"?"#fef3c7":u.role==="manager"?"#dcfce7":"#dbeafe",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,flexShrink:0}}>
                    {(u.display_name||u.email||"?")[0].toUpperCase()}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#111827"}}>{u.display_name||"—"}</div>
                    <div style={{fontSize:11,color:"#6b7280"}}>{u.email}</div>
                  </div>
                  {roleBadge(u.role)}
                  {u.id !== currentUser?.id && <>
                    <select value={u.role} onChange={e=>updateRole(u.id,e.target.value)}
                      style={{padding:"4px 8px",borderRadius:7,border:"1px solid #e5e7eb",fontSize:11,fontWeight:600,background:"#fff",cursor:"pointer"}}>
                      <option value="staff">Staff (schedule view only)</option>
                      <option value="viewer">Viewer</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                    <button onClick={()=>deleteUser(u.id,u.email)} title="Remove user"
                      style={{padding:"4px 8px",borderRadius:7,background:"#fef2f2",border:"none",color:"#dc2626",cursor:"pointer",fontSize:12,fontWeight:700,flexShrink:0}}>✕</button>
                  </>}
                  {u.id === currentUser?.id && <span style={{fontSize:10,color:"#9ca3af"}}>(you)</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Create new user */}
        <div style={{padding:"14px 16px",background:"#f8fafc",borderRadius:10,border:"1px solid #e5e7eb"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:10}}>➕ Add New User</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Email *</label>
              <input type="email" value={newEmail} onChange={e=>setNewEmail(e.target.value)} style={{...inp,fontSize:12}} placeholder="user@hospital.org" />
            </div>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Display Name</label>
              <input value={newName} onChange={e=>setNewName(e.target.value)} style={{...inp,fontSize:12}} placeholder="First Last" />
            </div>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Temporary Password * (min 8 chars)</label>
              <input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} style={{...inp,fontSize:12}} placeholder="They can change it later" />
            </div>
            <div>
              <label style={{fontSize:10,fontWeight:600,color:"#6b7280",display:"block",marginBottom:3}}>Role</label>
              <select value={newRole} onChange={e=>setNewRole(e.target.value)} style={{...inp,fontSize:12,cursor:"pointer"}}>
                <option value="staff">Staff (Day + Week only)</option>
                <option value="viewer">Viewer (read only)</option>
                <option value="manager">Manager (can edit)</option>
                <option value="admin">Admin (full access)</option>
              </select>
            </div>
          </div>
          {msg && <div style={{padding:"6px 10px",borderRadius:7,fontSize:12,fontWeight:600,background:msg.type==="ok"?"#f0fdf4":"#fef2f2",color:msg.type==="ok"?"#15803d":"#dc2626",marginBottom:8}}>{msg.text}</div>}
          <button onClick={createUser} disabled={creating}
            style={{width:"100%",padding:"9px",borderRadius:9,background:creating?"#93c5fd":"#1e3a5f",color:"#fff",border:"none",fontWeight:700,fontSize:13,cursor:creating?"not-allowed":"pointer"}}>
            {creating?"Creating...":"Create User →"}
          </button>
          <div style={{fontSize:10,color:"#9ca3af",marginTop:6}}>Users can sign in immediately with the email and temporary password you set. Advise them to change it via Menu → Change Password.</div>
        </div>
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


// ─── Mismatch Row (needs useState so must be its own component) ──────────────

// ─── Presence Avatar ──────────────────────────────────────────────────────────
function PresenceAvatar({ user, isMe }) {
  const [showTip, setShowTip] = useState(false);
  const TAB_LABELS = {
    day:"Day view", grid:"Week view", master:"Master Schedule", month:"Month view",
    year:"Year view", summary:"Dept Stats", timesheet:"Timesheets", analytics:"Analytics"
  };
  return (
    <div style={{position:"relative",display:"inline-flex"}}
      onMouseEnter={()=>setShowTip(true)}
      onMouseLeave={()=>setShowTip(false)}>
      <div style={{
        width:26,height:26,borderRadius:"50%",
        background:user.color||"#3b82f6",
        display:"flex",alignItems:"center",justifyContent:"center",
        fontSize:10,fontWeight:800,color:"#fff",
        border:isMe?"2px solid #fff":"2px solid rgba(255,255,255,0.3)",
        cursor:"default",flexShrink:0,
      }}>
        {user.initials||"?"}
      </div>
      {showTip && (
        <div style={{
          position:"absolute",top:"calc(100% + 6px)",left:"50%",transform:"translateX(-50%)",
          background:"#1e293b",color:"#fff",borderRadius:8,padding:"6px 10px",
          fontSize:11,whiteSpace:"nowrap",zIndex:1000,
          boxShadow:"0 4px 12px rgba(0,0,0,0.3)",pointerEvents:"none",
        }}>
          <div style={{fontWeight:700}}>{user.name}{isMe?" (you)":""}</div>
          <div style={{fontSize:9,color:"#94a3b8",marginTop:2,textTransform:"uppercase",letterSpacing:"0.04em"}}>{user.role}</div>
          {user.tab && <div style={{fontSize:10,color:"#7dd3fc",marginTop:3}}>{"📍 " + (TAB_LABELS[user.tab]||user.tab)}</div>}
          <div style={{position:"absolute",top:-4,left:"50%",transform:"translateX(-50%) rotate(45deg)",
            width:8,height:8,background:"#1e293b"}} />
        </div>
      )}
    </div>
  );
}


// ─── Person Filter Dropdown ───────────────────────────────────────────────────
function PersonFilterDropdown({ staff, filterPersons, setFilterPersons }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = staff.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id) => setFilterPersons(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  const count = filterPersons.length;

  return (
    <div ref={ref} style={{position:"relative"}}>
      <button onClick={()=>setOpen(v=>!v)} style={{
        padding:"3px 10px",borderRadius:99,fontSize:11,fontWeight:600,cursor:"pointer",
        background:count>0?"#1e3a5f":"#f9fafb",
        color:count>0?"#fff":"#6b7280",
        border:"1px solid "+(count>0?"#1e3a5f":"#e5e7eb"),
        display:"flex",alignItems:"center",gap:5
      }}>
        {"👤 " + (count > 0 ? "People (" + count + ")" : "People ▼")}
      </button>
      {open && (
        <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:200,
          background:"#fff",borderRadius:12,border:"1px solid #e5e7eb",
          boxShadow:"0 8px 24px rgba(0,0,0,0.12)",padding:"10px 12px",minWidth:210}}>
          <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.05em"}}>Filter by Person</div>
          <input
            value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search..."
            style={{width:"100%",border:"1px solid #e5e7eb",borderRadius:7,padding:"5px 8px",fontSize:12,marginBottom:7,boxSizing:"border-box"}}
          />
          <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:3}}>
            {filtered.map(s => {
              const active = filterPersons.includes(s.id);
              const tc = TEAM_COLORS[s.team];
              return (
                <button key={s.id} onClick={()=>toggle(s.id)} style={{
                  display:"flex",alignItems:"center",gap:8,padding:"5px 8px",
                  borderRadius:7,border:"1px solid "+(active?"#1e3a5f22":"#f3f4f6"),
                  background:active?"#eff6ff":"#f9fafb",
                  cursor:"pointer",textAlign:"left"
                }}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:tc?.dot||"#94a3b8",flexShrink:0}} />
                  <span style={{fontSize:12,fontWeight:active?700:500,color:active?"#1e3a5f":"#374151",flex:1}}>{s.name}</span>
                  {active && <span style={{fontSize:10,color:"#1e3a5f"}}>✓</span>}
                </button>
              );
            })}
            {filtered.length === 0 && <div style={{fontSize:11,color:"#9ca3af",textAlign:"center",padding:8}}>No matches</div>}
          </div>
          {count > 0 && (
            <button onClick={()=>{setFilterPersons([]);setSearch("");setOpen(false);}} style={{
              marginTop:8,width:"100%",padding:"5px",borderRadius:7,
              background:"#f3f4f6",border:"none",fontSize:11,fontWeight:600,
              color:"#6b7280",cursor:"pointer"
            }}>✕ Clear all</button>
          )}
        </div>
      )}
    </div>
  );
}

function MismatchRow({ item }) {
  const { s, standardTotal, enteredTotal, diff } = item;
  const [expanded, setExpanded] = useState(false);
  const tc = TEAM_COLORS[s.team];
  const isUnder = diff < 0;
  const isOver = diff > 0;
  return (
    <div style={{borderRadius:7,
      background:isUnder?"#fef2f2":isOver?"#fffbeb":"#f9fafb",
      border:"1px solid "+(isUnder?"#fca5a5":isOver?"#fde68a":"#e5e7eb")}}>
      <div onClick={()=>setExpanded(v=>!v)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px",cursor:"pointer"}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:tc?.dot,display:"inline-block",flexShrink:0}}/>
          <span style={{fontSize:11,fontWeight:700,color:"#111827"}}>{s.name}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,fontWeight:800,color:isUnder?"#dc2626":isOver?"#d97706":"#374151"}}>
            {enteredTotal}h / {standardTotal}h
            {isUnder ? " (-" + Math.abs(diff) + "h)" : isOver ? " (+" + diff + "h)" : ""}
          </span>
          <span style={{fontSize:9,color:"#9ca3af"}}>{expanded?"▲":"▼"}</span>
        </div>
      </div>
      {expanded && (
        <div style={{padding:"4px 8px 8px",fontSize:10,color:"#6b7280"}}>
          Weekly standard: <b>{standardTotal}h</b> · Entered: <b style={{color:isUnder?"#dc2626":isOver?"#d97706":"#15803d"}}>{enteredTotal}h</b>
        </div>
      )}
    </div>
  );
}

// ─── Week Grid ────────────────────────────────────────────────────────────────
function WeekGrid({ filteredStaff, weekDates, getEntry, getDayFTE, nwMap, setEditingCell, setDrillDay, editingName, setEditingName, tempName, setTempName, updateStaff, staff, compactMode, getDayAlerts, dayNotes, updateDayNotes, alertSettings, getDailyStats, setDailyStat, setHoliday, todayStr, canEdit, competencies=[], filterCompetencies=[], setFilterCompetencies, isStaffRole=false }) {
  const [confirmHolidayDs, setConfirmHolidayDs] = useState(null);
  const [showHourAlerts, setShowHourAlerts] = useState(false);

  const hourMismatches = useMemo(() => {
    const result = [];
    filteredStaff.forEach(s => {
      const rawSched = s.defaultSchedule && s.defaultSchedule.length > 0
        ? s.defaultSchedule
        : weekDates.map((_, i) => ({ day: i, team: s.team, hours: i===0||i===6 ? 0 : 8 }));
      const normSched = weekDates.map((date) => {
        const dow = date.getDay();
        const found = rawSched.find(d => Number(d.day) === dow);
        return found ? Number(found.hours)||0 : 0;
      });
      const standardTotal = normSched.reduce((a, h) => a + h, 0);
      if (standardTotal === 0) return;

      // Count total entered hours + non-work hours across the whole week
      let enteredTotal = 0;
      weekDates.forEach((date) => {
        const ds = fmt(date);
        const segs = getEntry(s.id, ds);
        segs.forEach(e => {
          enteredTotal += Number(e.hours) || 0;
          if (e.nonWork) enteredTotal += Number(e.nonWorkHours) || 8;
        });
      });

      const diff = enteredTotal - standardTotal;
      // Only flag if weekly total differs by 0.5h or more
      if (Math.abs(diff) >= 0.5) {
        result.push({ s, standardTotal, enteredTotal, diff });
      }
    });
    return result.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }, [filteredStaff, weekDates, getEntry]);

  return (
    <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"calc(100vh - 220px)"}}>
      <table style={{width:"100%",borderCollapse:"separate",borderSpacing:0,minWidth:860}}>
        <thead style={{position:"sticky",top:0,zIndex:20}}>
          <tr>
            <th style={{...thS,minWidth:155,background:"#fff",position:"sticky",left:0,zIndex:30,textAlign:"left",paddingLeft:12}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span>Staff Member</span>
                {hourMismatches.length > 0 ? (
                  <button onClick={()=>setShowHourAlerts(v=>!v)}
                    title={hourMismatches.length + " staff with hour mismatches"}
                    style={{display:"flex",alignItems:"center",gap:3,padding:"2px 7px",borderRadius:99,border:"none",cursor:"pointer",
                      background:showHourAlerts?"#fef2f2":"#fff7ed",
                      color:showHourAlerts?"#dc2626":"#d97706",
                      fontSize:10,fontWeight:800,whiteSpace:"nowrap"}}>
                    {"⚠️ " + hourMismatches.length}
                  </button>
                ) : (
                  <span style={{fontSize:10,color:"#86efac"}}>✓</span>
                )}
              </div>
              {showHourAlerts && hourMismatches.length > 0 && (
                <div style={{position:"absolute",top:"100%",left:0,zIndex:100,width:310,
                  background:"#fff",borderRadius:10,border:"1px solid #fca5a5",
                  boxShadow:"0 8px 24px rgba(0,0,0,0.15)",padding:"10px 12px",marginTop:2}}>
                  <div style={{fontSize:11,fontWeight:800,color:"#dc2626",marginBottom:8}}>Hour Mismatches This Week</div>
                  <div style={{maxHeight:240,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
                    {hourMismatches.map((m) => (
                      <MismatchRow key={m.s.id} item={m} />
                    ))}
                  </div>
                  <div style={{marginTop:8,fontSize:9,color:"#9ca3af"}}>Compares entered hours + non-work codes vs standard schedule</div>
                </div>
              )}
            </th>
            {weekDates.map((date,i) => {
              const we = isWeekend(date); const ds = fmt(date); const fte = getDayFTE(ds);
              const alerts = getDayAlerts ? getDayAlerts(ds) : [];
              const isToday = ds === todayStr;
              return (
                <th key={i} style={{...thS,background:isToday?"#fef08a":we?"#faf5ff":"#fff",minWidth:130,borderBottom:isToday?"3px solid #ca8a04":alerts.length?"3px solid "+(alerts[0].severity==="red"?"#ef4444":"#f59e0b"):"",outline:isToday?"2px solid #ca8a04":"none",outlineOffset:"-2px"}}>
                  {/* Holiday toggle */}
                  {getDailyStats && (() => {
                    const isHoliday = getDailyStats(ds)?.holiday;
                    return (
                      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:1}}>
                        <div onClick={e=>e.stopPropagation()}>
                          {canEdit && <HolidayToggleBtn ds={ds} isHoliday={isHoliday} setHoliday={setHoliday} setDailyStat={setDailyStat} small={true} />}
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
                    <div style={{fontSize:14,fontWeight:800,color:isToday?"#92400e":getDailyStats&&getDailyStats(ds)?.holiday?"#7c3aed":we?"#7c3aed":"#1e3a5f"}}>{fmtDisplay(date)}{isToday&&<span style={{marginLeft:4,fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:99,background:"#fef08a",color:"#854d0e",verticalAlign:"middle"}}>TODAY</span>}</div>
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
                  {editingName===s.id && canEdit ? (
                    <input autoFocus value={tempName} onChange={e=>setTempName(e.target.value)}
                      onBlur={()=>{updateStaff(staff.map(x=>x.id===s.id?{...x,name:tempName||x.name}:x));setEditingName(null);}}
                      onKeyDown={e=>{if(e.key==="Enter"){updateStaff(staff.map(x=>x.id===s.id?{...x,name:tempName||x.name}:x));setEditingName(null);}}}
                      style={{fontSize:12,fontWeight:600,border:"1px solid #3b82f6",borderRadius:4,padding:"2px 5px",width:100}} />
                  ) : (
                    <span style={{color:"#111827",cursor:canEdit?"pointer":"default"}} onDoubleClick={()=>{if(canEdit){setEditingName(s.id);setTempName(s.name);}}} title={canEdit?"Double-click to rename":""}>{s.name}</span>
                  )}
                </div>
                <div style={{fontSize:10,color:TEAM_COLORS[s.team]?.text,marginLeft:13}}>{s.team}</div>
                {!compactMode && (s.competencies||[]).length > 0 && (
                  <div style={{display:"flex",gap:3,flexWrap:"wrap",marginLeft:13,marginTop:3}}>
                    {(s.competencies||[]).map(cid => {
                      const comp = competencies.find(c=>c.id===cid);
                      if (!comp) return null;
                      const isActive = filterCompetencies.includes(cid);
                      return (
                        <span key={cid} style={{
                          fontSize:8,padding:"1px 5px",borderRadius:99,fontWeight:700,
                          background:isActive?comp.color:comp.color+"22",
                          color:isActive?"#fff":comp.color,
                          border:"1px solid "+comp.color+"44"
                        }}>{comp.name}</span>
                      );
                    })}
                  </div>
                )}
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
                    <button className="cell-btn" onClick={()=>canEdit&&setEditingCell({staffId:s.id,dateStr:ds})} style={{
                      width:"100%",minHeight:compactMode?30:52,borderRadius:7,cursor:"pointer",padding:compactMode?"2px 5px":"4px 5px",
                      display:"flex",flexDirection:"column",alignItems:"stretch",justifyContent:"center",gap:2,
                      border:"1px solid "+(hasData?"#dbeafe":isHoliday?"#c4b5fd":"#f1f5f9"),
                      background:hasData?"#f0f7ff":isHoliday?"#ede9fe":"transparent",transition:"all 0.1s",
                      position:"relative"
                    }}>
                      {/* Comment / swap indicators — hidden for staff role */}
                      {!isStaffRole && (hasComment||hasSwap||segs.some(e=>e.extraComp)) && (
                        <div style={{position:"absolute",top:2,right:3,display:"flex",gap:2,zIndex:5}}>
                          {segs.some(e=>e.extraComp) && <span style={{fontSize:9,background:"#fef9c3",borderRadius:3,padding:"0 2px",lineHeight:1.4}}>⭐</span>}
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
                      {hasComment && !hasData && (() => {
                        const commentText = segs.filter(e=>e.comment).map(e=>e.comment).join(" · ");
                        return (
                          <div style={{fontSize:9,color:"#6b7280",fontStyle:"italic",padding:"1px 2px",textAlign:"center",lineHeight:1.3}}>
                            💬 {commentText}
                          </div>
                        );
                      })()}
                      {hasData ? segs.map((e,si) => {
                        const hrs = Number(e.hours)||0;
                        const nw = e.nonWork ? nwMap[e.nonWork] : null;
                        const nwHrs = Number(e.nonWorkHours)||0;
                        const tc = TEAM_COLORS[e.team||s.team];
                        const nonWorkOnly = !hrs && nw; // no work hours — NW is the whole story
                        const mixed = hrs > 0 && nw;    // partial day — working + NW

                        if (nonWorkOnly) {
                          return (
                            <div key={si} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:3,padding:"2px 4px",borderRadius:4,
                              background:isStaffRole?"#f3f4f6":`repeating-linear-gradient(45deg,${nw.color}11,${nw.color}11 3px,${nw.color}22 3px,${nw.color}22 6px)`,
                              border:"1px solid "+(isStaffRole?"#e5e7eb":nw.color+"55")}}>
                              <span style={{fontSize:11,fontWeight:700,color:isStaffRole?"#6b7280":nw.color}}>{isStaffRole?"Out":nw.code}</span>
                              {!isStaffRole && <span style={{fontSize:10,color:nw.color+"bb",fontWeight:600}}>{nwHrs||8}h</span>}
                            </div>
                          );
                        }
                        if (mixed) {
                          if (isStaffRole) {
                            // Staff role: show work hours + "Out Xh" instead of NW code
                            const outHrs = nwHrs || 8;
                            return (
                              <div key={si} style={{display:"flex",flexDirection:"column",gap:2,padding:"1px 3px",borderRadius:4,background:tc?.bg||"#f0f7ff",borderLeft:"2px solid "+(tc?.dot||"#3b82f6")}}>
                                <div style={{display:"flex",alignItems:"center",gap:3}}>
                                  <span style={{fontSize:11,fontWeight:700,color:"#1e3a5f",flexShrink:0}}>{hrs}h</span>
                                  <span style={{fontSize:9,color:tc?.text||"#1e40af",fontWeight:600,flex:1}}>{e.team||s.team}</span>
                                </div>
                                <div style={{display:"flex",alignItems:"center",gap:2,padding:"1px 3px",borderRadius:3,background:"#f3f4f6"}}>
                                  <span style={{fontSize:9,fontWeight:700,color:"#6b7280"}}>{"Out " + outHrs + "h"}</span>
                                </div>
                              </div>
                            );
                          }
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
                        // Normal working day: hours + team + location side by side
                        return (
                          <div key={si} style={{display:"flex",alignItems:"center",gap:0,borderRadius:5,overflow:"hidden",border:"1.5px solid "+(tc?.dot||"#3b82f6"),background:tc?.bg||"#f0f7ff"}}>
                            {/* Hours + team pill */}
                            <div style={{display:"flex",alignItems:"center",gap:3,padding:"2px 5px",flexShrink:0}}>
                              <span style={{fontSize:11,fontWeight:800,color:tc?.text||"#1e40af"}}>{hrs}h</span>
                              <span style={{fontSize:9,fontWeight:700,color:tc?.text||"#1e40af",whiteSpace:"nowrap"}}>{e.team||s.team}</span>
                            </div>
                            {/* Location badge — solid team colour divider */}
                            {e.location && <>
                              <div style={{width:1,alignSelf:"stretch",background:tc?.dot||"#3b82f6",opacity:0.4}} />
                              <div style={{padding:"2px 5px",background:tc?.dot||"#3b82f6",display:"flex",alignItems:"center"}}>
                                <span style={{fontSize:8,fontWeight:800,color:"#fff",whiteSpace:"nowrap",letterSpacing:"0.03em"}}>{e.location}</span>
                              </div>
                            </>}
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
function YearView({ year, staff, getEntry, getDayFTE, nwMap, setWeekStart, setActiveTab, setDrillDay, getDayAlerts }) {
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
                  const ds = fmt(date);
                  const isToday = ds === today;
                  const fte = getDayFTE(ds);
                  const alerts = getDayAlerts ? getDayAlerts(ds) : [];
                  const alertColor = alerts.length ? (alerts[0].severity==="red" ? "#ef4444" : "#f59e0b") : null;
                  return (
                    <div key={ds}
                      onMouseEnter={()=>setHovered({date,ds,fte,alerts})}
                      onMouseLeave={()=>setHovered(null)}
                      onClick={()=>{
                        if(date.getDay()===0){setWeekStart(new Date(date));setActiveTab("grid");}
                        else {setDrillDay(date);}
                      }}
                      style={{
                        aspectRatio:"1",borderRadius:3,cursor:"pointer",
                        background:getDayColor(date),
                        border:isToday?"2px solid #1e3a5f":alertColor?"2px solid "+alertColor:"1px solid transparent",
                        display:"flex",alignItems:"center",justifyContent:"center",position:"relative",
                        fontSize:8,fontWeight:isToday?800:500,color:isToday?"#1e3a5f":"#6b7280",
                        transition:"transform 0.1s",transform:hovered?.ds===ds?"scale(1.2)":"scale(1)"
                      }}
                    >
                      {date.getDate()}
                      {alertColor && (
                        <div style={{position:"absolute",top:0,right:0,width:4,height:4,borderRadius:"50%",background:alertColor}} />
                      )}
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
function CellEditor({ staffId, dateStr, staff, getEntry, setEntrySegments, nwMap, nonWorkTypes, onClose, getDailyStats, locations=[] }) {
  const s = staff.find(x=>x.id===staffId);
  const isHoliday = getDailyStats ? getDailyStats(dateStr)?.holiday : false;
  const [segs, setSegs] = useState(() => {
    const raw = getEntry(staffId, dateStr);
    return raw.length ? raw.map(r=>({...r})) : [{ hours:"", team: s?.team||TEAMS[0], nonWork: isHoliday?"HOL":"", nonWorkHours: isHoliday?"8":"", comment:"", swap:false, extraComp:false }];
  });

  const updateSeg = (i, field, value) => setSegs(prev => prev.map((sg, idx) => {
    if (idx !== i) return sg;
    const updated = { ...sg, [field]: value };
    // Use actual scheduled hours for this day of week from defaultSchedule
    const dow = new Date(dateStr + "T12:00:00").getDay();
    const schedEntry = s?.defaultSchedule?.find(d => Number(d.day) === dow);
    const staffDefaultHrs = schedEntry ? (Number(schedEntry.hours) || 0) : 8;
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
  const addSeg = () => setSegs(prev=>[...prev,{ hours:"", team: s?.team||TEAMS[0], nonWork:"", nonWorkHours:"", comment:"", swap:false, extraComp:false }]);
  const removeSeg = i => setSegs(prev=>prev.filter((_,idx)=>idx!==i));

  const save = () => {
    // Keep segments that have hours, a non-work code, OR a comment
    const cleaned = segs.filter(sg => Number(sg.hours) > 0 || sg.nonWork || sg.comment?.trim());
    setEntrySegments(staffId, dateStr, cleaned.length ? cleaned : []);
    onClose();
  };

  const totalHrs = segs.reduce((a,sg)=>a+(Number(sg.hours)||0),0);

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}}>
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
                    {/* Extra Comp toggle */}
                    <button onClick={()=>updateSeg(i,"extraComp",!sg.extraComp)}
                      title="Mark as extra comp shift"
                      style={{fontSize:10,padding:"2px 7px",borderRadius:6,border:"1px solid "+(sg.extraComp?"#f59e0b":"#e5e7eb"),
                        background:sg.extraComp?"#fef9c3":"#f9fafb",color:sg.extraComp?"#92400e":"#9ca3af",fontWeight:700,cursor:"pointer"}}>
                      ⭐ {sg.extraComp?"Extra Comp":"Extra Comp?"}
                    </button>
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

                {/* Location dropdown */}
                {(() => {
                  const teamLocations = locations.filter(l => l.team === (sg.team||s?.team));
                  if (!teamLocations.length) return null;
                  return (
                    <div style={{marginBottom:8}}>
                      <label style={{...lbl,fontSize:10}}>📍 Location</label>
                      <select value={sg.location||""} onChange={e=>updateSeg(i,"location",e.target.value)}
                        style={{...sel,fontSize:12,padding:"5px 8px"}}>
                        <option value="">— No specific location —</option>
                        {teamLocations.map(l=><option key={l.id} value={l.name}>{l.name}</option>)}
                      </select>
                    </div>
                  );
                })()}

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
function DayDrillDown({ date, staff, getEntry, getDailyStats, setDailyStat, setHoliday, getDayFTE, nwMap, onClose, canEdit=false }) {
  const ds = fmt(date); const stats = getDailyStats(ds); const fte = getDayFTE(ds);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:560,maxHeight:"84vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.25)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,flexWrap:"wrap"}}>
          <div style={{fontSize:20,fontWeight:800,color:"#111827"}}>{date.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</div>
          {stats.holiday && <span style={{padding:"3px 10px",borderRadius:99,background:"#ede9fe",color:"#7c3aed",fontSize:12,fontWeight:700}}>⛱ Holiday</span>}
          {canEdit && <HolidayToggleBtn ds={ds} isHoliday={stats.holiday} setHoliday={setHoliday} setDailyStat={setDailyStat} />}
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
                {canEdit ? (
                  <input type="number" min="0" value={stats.census?.[t]||""} onChange={e=>setDailyStat(ds,"census",{...stats.census,[t]:e.target.value===''?0:Number(e.target.value)})} style={{...inp,background:"transparent",border:"1px solid "+tc.dot+"55",color:tc.text,fontWeight:800,fontSize:18}} placeholder="0" />
                ) : (
                  <div style={{fontSize:18,fontWeight:800,color:tc.text,padding:"6px 0"}}>{stats.census?.[t]||0}</div>
                )}
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


// ─── Master Schedule View ─────────────────────────────────────────────────────
// Days across the top, 3 team sub-columns per day (Acute → Rehab → Peds).
// Total FTE shown next to each day label. Per-team FTE in sub-header row.
function MasterScheduleView({ staff, filterTeam }) {
  const DAY_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const MASTER_TEAMS = ["Acute","Rehab","Peds"];
  const [teamFilter, setTeamFilter] = useState("All"); // local override
  const [compact, setCompact] = useState(true);

  const activeStaff = sortByName(staff.filter(s => !s.archived));

  const getSched = (s) => {
    const raw = s.defaultSchedule && s.defaultSchedule.length > 0
      ? s.defaultSchedule
      : DAY_LABELS.map((_,i) => ({day:i, team:s.team, hours:i===0||i===6?0:8}));
    return DAY_LABELS.map((_,i) => {
      const found = raw.find(d=>Number(d.day)===i) || raw[i];
      return found ? {...found, day:i} : {day:i, team:s.team, hours:i===0||i===6?0:8};
    });
  };

  // Get all teams a staff works across their week (for multi-area detection)
  const getStaffTeams = (s) => {
    const sched = getSched(s);
    const teams = new Set();
    sched.forEach(d => { if (Number(d.hours) > 0) teams.add(d.team || s.team); });
    return [...teams];
  };

  // Which teams to show as columns (filtered view = 1 col, All = 3 cols)
  const visibleTeams = teamFilter === "All" ? MASTER_TEAMS : [teamFilter];

  // Staff to show: if team filter active, show staff who work in that team at least 1 day
  const displayStaff = activeStaff.filter(s => {
    if (teamFilter === "All") return true;
    const sched = getSched(s);
    return sched.some(d => Number(d.hours) > 0 && (d.team || s.team) === teamFilter);
  });

  // FTE helpers
  const getDayTeamFTE = (di, team) =>
    activeStaff.reduce((sum, s) => {
      const de = getSched(s)[di] || {};
      const hrs = Number(de.hours) || 0;
      const et = de.team || s.team;
      return sum + (hrs > 0 && et === team ? hrs/8 : 0);
    }, 0);

  const getDayTotalFTE = (di, teamScope) =>
    activeStaff.reduce((sum, s) => {
      const de = getSched(s)[di] || {};
      const hrs = Number(de.hours) || 0;
      const et = de.team || s.team;
      if (teamScope !== "All" && et !== teamScope) return sum;
      return sum + (hrs/8);
    }, 0);

  const fmtFTE = (v) => v > 0 ? (v % 1 === 0 ? v : v.toFixed(1)) : null;

  const R = compact ? 3 : 7;   // row padding vertical
  const FS = compact ? 10 : 12; // font size in cells
  const NH = compact ? 20 : 28; // name col font

  return (
    <div>
      {/* Header + controls */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,marginBottom:12}}>
        <div>
          <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>📋 Master Schedule</div>
          <div style={{fontSize:11,color:"#6b7280",marginTop:1}}>Standard recurring schedule · {displayStaff.length} staff shown</div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {/* Team filter toggle */}
          <div style={{display:"flex",gap:2,background:"#f1f5f9",borderRadius:8,padding:2}}>
            {["All",...MASTER_TEAMS].map(t => {
              const tc = TEAM_COLORS[t];
              const active = teamFilter === t;
              return (
                <button key={t} onClick={()=>setTeamFilter(t)} style={{
                  padding:"4px 10px", borderRadius:6, fontSize:11, fontWeight:700, cursor:"pointer", border:"none",
                  background: active ? (tc?.dot || "#1e3a5f") : "transparent",
                  color: active ? "#fff" : "#6b7280",
                  transition:"all 0.15s"
                }}>{t}</button>
              );
            })}
          </div>
          {/* Compact toggle */}
          <button onClick={()=>setCompact(v=>!v)} style={{
            padding:"4px 10px", borderRadius:7, fontSize:11, fontWeight:700, cursor:"pointer",
            border:"1px solid #e5e7eb", background: compact?"#1e3a5f":"#fff",
            color: compact?"#fff":"#6b7280"
          }}>{compact?"⊞ Compact":"⊟ Spacious"}</button>
        </div>
      </div>

      <div style={{overflowX:"auto"}}>
        <table style={{borderCollapse:"collapse",width:"100%",minWidth: teamFilter==="All"?900:500}}>
          <thead>
            {/* Row 1: day names + total FTE */}
            <tr style={{background:"#f8fafc"}}>
              <th rowSpan={2} style={{
                padding:compact?"6px 10px":"10px 14px",
                textAlign:"left",fontSize:10,fontWeight:700,color:"#6b7280",
                borderBottom:"2px solid #e5e7eb",whiteSpace:"nowrap",
                minWidth:compact?100:130,verticalAlign:"bottom",
                position:"sticky",left:0,background:"#f8fafc",zIndex:2
              }}>Name</th>
              {DAY_LABELS.map((d,di) => {
                const isWE = di===0||di===6;
                const totalFTE = getDayTotalFTE(di, teamFilter);
                const fte = fmtFTE(totalFTE);
                return (
                  <th key={d} colSpan={visibleTeams.length} style={{
                    padding:compact?"4px 2px 2px":"6px 4px 3px", textAlign:"center",
                    color:isWE?"#7c3aed":"#1e3a5f",
                    background:isWE?"#faf5ff":"#f8fafc",
                    borderLeft:"2px solid "+(isWE?"#e9d5ff":"#e5e7eb"),
                    borderBottom:"1px solid "+(isWE?"#e9d5ff":"#e5e7eb"),
                  }}>
                    <div style={{fontSize:compact?10:12,fontWeight:800}}>{d}</div>
                    {fte && <div style={{fontSize:9,fontWeight:600,color:isWE?"#7c3aed":"#64748b",marginTop:1}}>{fte} FTE</div>}
                  </th>
                );
              })}
            </tr>
            {/* Row 2: team sub-headers */}
            <tr style={{background:"#f8fafc"}}>
              {DAY_LABELS.map((d,di) => {
                const isWE = di===0||di===6;
                return visibleTeams.map((team,ti) => {
                  const tc = TEAM_COLORS[team];
                  const fte = fmtFTE(getDayTeamFTE(di, team));
                  return (
                    <th key={d+team} style={{
                      padding:compact?"2px 2px 4px":"3px 3px 6px", textAlign:"center",
                      fontSize:8, fontWeight:700, color:tc?.text||"#374151",
                      background:isWE?(tc?.bg+"bb"):(tc?.bg||"#f9fafb"),
                      borderLeft:ti===0?"2px solid "+(isWE?"#e9d5ff":"#e5e7eb"):"1px solid "+tc?.dot+"22",
                      borderBottom:"2px solid #e5e7eb",
                      minWidth:compact?36:44,
                    }}>
                      {visibleTeams.length > 1 && <div style={{textTransform:"uppercase",letterSpacing:"0.03em"}}>{team.slice(0,3)}</div>}
                      <div style={{fontSize:9,fontWeight:800,color:tc?.text}}>
                        {fte || <span style={{color:"#e5e7eb"}}>—</span>}
                      </div>
                    </th>
                  );
                });
              })}
            </tr>
          </thead>
          <tbody>
            {displayStaff.map(s => {
              const homeTc = TEAM_COLORS[s.team];
              const sched = getSched(s);
              const weekHrs = sched.reduce((a,d)=>a+(Number(d.hours)||0),0);
              const staffTeams = getStaffTeams(s);
              const isMultiTeam = staffTeams.length > 1;
              return (
                <tr key={s.id} style={{borderBottom:"1px solid #f3f4f6", background:"#fff"}}
                  onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                  onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
                  {/* Name cell — sticky */}
                  <td style={{
                    padding:compact?"3px 8px":"6px 10px",
                    whiteSpace:"nowrap", borderRight:"1px solid #f3f4f6",
                    position:"sticky", left:0, background:"inherit", zIndex:1
                  }}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{width:6,height:6,borderRadius:"50%",background:homeTc?.dot,flexShrink:0,display:"inline-block"}} />
                      <span style={{fontSize:compact?10:12,fontWeight:700,color:"#111827"}}>{s.name}</span>
                      {isMultiTeam && (
                        <span title={`Works in: ${staffTeams.join(", ")}`} style={{fontSize:8,padding:"1px 4px",borderRadius:99,background:"#fef9c3",color:"#92400e",fontWeight:700,flexShrink:0}}>multi</span>
                      )}
                    </div>
                    {!compact && (
                      <div style={{display:"flex",gap:4,marginLeft:11,marginTop:1,flexWrap:"wrap"}}>
                        {staffTeams.map(t => {
                          const tc2 = TEAM_COLORS[t];
                          return <span key={t} style={{fontSize:8,color:tc2?.text,fontWeight:600}}>{t}</span>;
                        })}
                        <span style={{fontSize:8,color:"#9ca3af"}}>· {weekHrs}h/wk</span>
                      </div>
                    )}
                  </td>
                  {/* Day × team cells */}
                  {DAY_LABELS.map((d,di) => {
                    const isWE = di===0||di===6;
                    const dayEntry = sched[di] || {};
                    const hrs = Number(dayEntry.hours) || 0;
                    const effectiveTeam = dayEntry.team || s.team;
                    return visibleTeams.map((team,ti) => {
                      const tc2 = TEAM_COLORS[team];
                      const isWorking = hrs > 0 && effectiveTeam === team;
                      const isOff = hrs === 0 && (teamFilter === "All" ? team === s.team : true);
                      return (
                        <td key={d+team} style={{
                          padding:compact?"2px":"4px 3px", textAlign:"center",
                          background: isWE ? (isWorking ? tc2?.bg : "#fdfaff") : (isWorking ? tc2?.bg+"99" : "transparent"),
                          borderLeft:ti===0?"2px solid "+(isWE?"#e9d5ff":"#e5e7eb"):"1px solid #f3f4f6",
                        }}>
                          {isWorking ? (
                            <div style={{
                              display:"inline-flex",alignItems:"center",justifyContent:"center",
                              padding:compact?"1px 3px":"3px 5px",
                              borderRadius:4,
                              border:"1.5px solid "+(tc2?.dot||"#93c5fd"),
                              background:"#fff",
                              minWidth:compact?28:36
                            }}>
                              <span style={{fontSize:FS,fontWeight:800,color:tc2?.text||"#1e3a5f",lineHeight:1}}>{hrs}h</span>
                            </div>
                          ) : isOff ? (
                            <span style={{fontSize:8,color:isWE?"#c4b5fd":"#e5e7eb",fontWeight:600}}>·</span>
                          ) : null}
                        </td>
                      );
                    });
                  })}
                </tr>
              );
            })}
            {displayStaff.length === 0 && (
              <tr><td colSpan={1+7*visibleTeams.length} style={{padding:32,textAlign:"center",color:"#9ca3af",fontSize:13}}>No staff found for this team filter</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div style={{marginTop:8,display:"flex",gap:16,flexWrap:"wrap",fontSize:10,color:"#9ca3af"}}>
        <span>FTE per day shown in headers</span>
        <span>·</span>
        <span><b style={{color:"#92400e"}}>multi</b> badge = works across teams in same week</span>
        {teamFilter !== "All" && <span>· Showing all staff who work in <b style={{color:TEAM_COLORS[teamFilter]?.text}}>{teamFilter}</b> at least 1 day</span>}
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
    let totalDays = 0;   // all calendar days in range
    let staffedDays = 0; // days where FTE > 0 (actually staffed)
    let totalFTE = 0;
    const teamStaffedDays = { Rehab:0, Peds:0, Acute:0 };
    viewWeeks.forEach(({wStart, wEnd, rec}) => {
      TEAMS.forEach(t => {
        byTeam[t].evals  += rec[t]?.evals  || 0;
        byTeam[t].visits += rec[t]?.visits || 0;
        totalEvals  += rec[t]?.evals  || 0;
        totalVisits += rec[t]?.visits || 0;
      });
      // Walk all 7 days — include weekends since dept runs 7-day schedule
      const cur2 = new Date(wStart+"T12:00:00");
      for (let di=0; di<7; di++, cur2.setDate(cur2.getDate()+1)) {
        const ds2 = fmt(cur2);
        if (ds2 < viewStart || ds2 > viewEnd) continue;
        totalDays++;
        const fte = getDayFTE ? getDayFTE(ds2) : null;
        const dayTotal = fte ? (Number(fte.total)||0) : 0;
        if (dayTotal > 0) {
          staffedDays++;
          totalFTE += dayTotal;
          TEAMS.forEach(t => {
            const tf = Number(fte.byTeam?.[t])||0;
            byTeam[t].fte += tf;
            if (tf > 0) teamStaffedDays[t]++;
          });
        }
      }
    });
    // Use staffed days (not total days) so weekends with no entries don't skew averages
    const workDays = staffedDays;
    const avgFTEPerDay = staffedDays > 0 ? totalFTE / staffedDays : 0;
    const avgVisitsPerFTEDay = totalFTE > 0 ? totalVisits / totalFTE : 0;
    const avgVisitsPerDay = staffedDays > 0 ? totalVisits / staffedDays : 0;
    // Per-team visits/FTE/day and forecast
    TEAMS.forEach(t => {
      const tDays = teamStaffedDays[t] || staffedDays || 1;
      byTeam[t].visitsPerFTEDay = byTeam[t].fte > 0 ? byTeam[t].visits / byTeam[t].fte : 0;
      byTeam[t].avgFTEPerDay = tDays > 0 ? byTeam[t].fte / tDays : 0;
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

        {/* Calculation breakdown — helps verify math */}
        <div style={{background:"#fff",borderRadius:14,padding:16,border:"1px solid #e5e7eb",fontSize:11,color:"#374151"}}>
          <div style={{fontSize:12,fontWeight:800,color:"#1e3a5f",marginBottom:10}}>📐 Calculation Breakdown</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
            {[
              {label:"Total visits in range",    value: metrics.totalVisits.toLocaleString()},
              {label:"Staffed days counted",      value: metrics.workDays},
              {label:"Sum of FTE-days",           value: metrics.totalFTE.toFixed(1), note:"FTE summed across all staffed days"},
              {label:"Avg FTE per staffed day",   value: metrics.avgFTEPerDay.toFixed(2)},
              {label:"Visits / FTE-day",          value: metrics.avgVisitsPerFTEDay.toFixed(3), note:"= total visits ÷ FTE-days"},
              {label:"× Annual work days",        value: ANNUAL_WORK_DAYS, note:"adjust this constant if needed"},
              {label:"= Per therapist / year",    value: Math.round(metrics.forecastPerPerson).toLocaleString(), bold:true},
            ].map(({label,value,note,bold})=>(
              <div key={label} style={{padding:"8px 10px",borderRadius:8,background:"#f8fafc",border:"1px solid #f1f5f9"}}>
                <div style={{fontSize:10,color:"#6b7280"}}>{label}{note && <span style={{color:"#9ca3af"}}> — {note}</span>}</div>
                <div style={{fontSize:bold?16:14,fontWeight:bold?800:700,color:bold?"#1e3a5f":"#374151",marginTop:2}}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:10,padding:"8px 12px",background:"#fffbeb",borderRadius:8,border:"1px solid #fde68a",fontSize:10,color:"#92400e"}}>
            <b>Formula:</b> (Total Visits ÷ Sum of FTE-days) × {ANNUAL_WORK_DAYS} annual days = Per Therapist/Year &nbsp;·&nbsp;
            If this number looks high, check: (1) Is <b>ANNUAL_WORK_DAYS = {ANNUAL_WORK_DAYS}</b> correct for your dept? (2) Are weekend FTE entries inflating the FTE-day sum?
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
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}}>
      <div style={{background:"#fff",borderRadius:18,padding:24,width:520,boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:16,fontWeight:800,color:"#1e3a5f"}}>📝 Enter Weekly Visits</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>

        {/* Week picker with arrow nav */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:16,padding:"8px 12px",background:"#f8fafc",borderRadius:9,border:"1px solid #e5e7eb"}}>
          <button onClick={()=>{ const d=new Date(entryWeekStart+"T12:00:00"); d.setDate(d.getDate()-7); setEntryWeekStart(fmt(d)); }}
            style={{background:"#e5e7eb",border:"none",borderRadius:6,width:28,height:28,cursor:"pointer",fontSize:14,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>‹</button>
          <div style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#1e3a5f"}}>
              {new Date(entryWeekStart+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"})} – {new Date(entryWeekEnd+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
            </div>
            <input type="date" value={entryWeekStart}
              onChange={e=>{ if(e.target.value){ const d=new Date(e.target.value+"T12:00:00"); d.setDate(d.getDate()-d.getDay()); setEntryWeekStart(fmt(d)); }}}
              style={{fontSize:10,color:"#9ca3af",border:"none",background:"transparent",cursor:"pointer",textAlign:"center",marginTop:1}} />
          </div>
          <button onClick={()=>{ const d=new Date(entryWeekStart+"T12:00:00"); d.setDate(d.getDate()+7); setEntryWeekStart(fmt(d)); }}
            style={{background:"#e5e7eb",border:"none",borderRadius:6,width:28,height:28,cursor:"pointer",fontSize:14,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>›</button>
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

// ─── Timesheet Tab ────────────────────────────────────────────────────────────
function TimesheetTab({ staff, entries, weekStart, nonWorkTypes }) {
  const today = new Date(); today.setHours(0,0,0,0);
  const [rangeType, setRangeType] = useState("week");
  const [customStart, setCustomStart] = useState(() => {
    const s = new Date(today); s.setDate(today.getDate()-today.getDay()); return fmt(s);
  });
  const [customEnd, setCustomEnd] = useState(fmt(today));
  const [sortCol, setSortCol] = useState("name");
  const [sortDir, setSortDir] = useState(1);
  const [filterTeam, setFilterTeam] = useState("All");
  const [ecOnly, setEcOnly] = useState(false);

  // Compute date range from rangeType
  const { rangeStart, rangeEnd } = useMemo(() => {
    const t = new Date(today);
    const thisSun = new Date(t); thisSun.setDate(t.getDate()-t.getDay());
    const thisSat = new Date(thisSun); thisSat.setDate(thisSun.getDate()+6);
    if (rangeType==="week") return { rangeStart:fmt(thisSun), rangeEnd:fmt(thisSat) };
    if (rangeType==="lastweek") {
      const s=new Date(thisSun); s.setDate(thisSun.getDate()-7);
      const e=new Date(s); e.setDate(s.getDate()+6);
      return { rangeStart:fmt(s), rangeEnd:fmt(e) };
    }
    if (rangeType==="month") { const y=t.getFullYear(),m=t.getMonth(); return { rangeStart:fmt(new Date(y,m,1)), rangeEnd:fmt(new Date(y,m+1,0)) }; }
    if (rangeType==="lastmonth") { const y=t.getFullYear(),m=t.getMonth()-1; const lm=m<0?11:m,ly=m<0?y-1:y; return { rangeStart:fmt(new Date(ly,lm,1)), rangeEnd:fmt(new Date(ly,lm+1,0)) }; }
    if (rangeType==="year") return { rangeStart:`${t.getFullYear()}-01-01`, rangeEnd:`${t.getFullYear()}-12-31` };
    return { rangeStart:customStart, rangeEnd:customEnd };
  }, [rangeType, customStart, customEnd]);

  // Build array of dateStrings in range
  const rangeDays = useMemo(() => {
    const days=[], s=new Date(rangeStart+"T12:00:00"), e=new Date(rangeEnd+"T12:00:00");
    if (isNaN(s)||isNaN(e)||s>e) return days;
    const cur=new Date(s);
    while(cur<=e){ days.push(fmt(cur)); cur.setDate(cur.getDate()+1); }
    return days;
  }, [rangeStart, rangeEnd]);

  // Aggregate hours per staff per team + non-work
  const rows = useMemo(() => {
    // Include ALL staff (active + archived) who have entries in the date range
    // within their employment window (startDate → terminationDate)
    const eligibleStaff = staff.filter(s => {
      if (filterTeam !== "All" && s.team !== filterTeam) return false;
      // For active staff, always include
      if (!s.archived) return true;
      // For archived staff, include only if they have entries in the range
      // that fall within their employment window
      return rangeDays.some(ds => {
        if (s.startDate && ds < s.startDate) return false;
        if (s.terminationDate && ds > s.terminationDate) return false;
        const raw = entries[`${s.id}_${ds}`];
        if (!raw) return false;
        const segs = Array.isArray(raw) ? raw : [raw];
        return segs.some(e => Number(e.hours) > 0 || e.nonWork);
      });
    });
    return eligibleStaff.map(s => {
      const byTeam = {}; TEAMS.forEach(t=>{ byTeam[t]=0; });
      const byNW = {};
      let totalWork=0, totalNW=0, ecHrs=0, ecShifts=0;
      rangeDays.forEach(ds => {
        if (s.startDate && ds < s.startDate) return;
        if (s.terminationDate && ds > s.terminationDate) return;
        const raw = entries[`${s.id}_${ds}`];
        const segs = raw ? (Array.isArray(raw)?raw:[raw]) : [];
        let dayEcHrs = 0;
        segs.forEach(e => {
          const wh = Number(e.hours)||0;
          const nwh = e.nonWork ? (Number(e.nonWorkHours) || Number(e.hours) || 8) : 0;
          const team = e.team||s.team;
          if (wh>0) { byTeam[team]=(byTeam[team]||0)+wh; totalWork+=wh; }
          if (e.nonWork && nwh>0) { byNW[e.nonWork]=(byNW[e.nonWork]||0)+nwh; totalNW+=nwh; }
          if (e.extraComp && wh>0) { dayEcHrs += wh; ecHrs += wh; }
        });
        if (dayEcHrs > 0) ecShifts += dayEcHrs / 8; // fractional shifts
      });
      return { s, byTeam, byNW, totalWork, totalNW, total:totalWork+totalNW, ecHrs, ecShifts };
    }).filter(r => r.total > 0 || !r.s.archived); // hide archived staff with 0 hours in range
  }, [staff, entries, rangeDays, filterTeam]);

  const sorted = useMemo(() => {
    const filtered = ecOnly ? rows.filter(r => (r.ecHrs||0) > 0) : rows;
    return [...filtered].sort((a,b) => {
      let av, bv;
      if (sortCol==="name")  { av=a.s.name; bv=b.s.name; return sortDir*av.localeCompare(bv); }
      if (sortCol==="team")  { av=a.s.team; bv=b.s.team; return sortDir*av.localeCompare(bv); }
      if (sortCol==="work")  { av=a.totalWork; bv=b.totalWork; }
      else if (sortCol==="nw") { av=a.totalNW; bv=b.totalNW; }
      else if (sortCol==="total") { av=a.total; bv=b.total; }
      else { av=a.byTeam[sortCol]||0; bv=b.byTeam[sortCol]||0; }
      return sortDir*(av-bv);
    });
  }, [rows, sortCol, sortDir, ecOnly]);

  const toggleSort = (col) => { if(sortCol===col) setSortDir(d=>-d); else { setSortCol(col); setSortDir(-1); } };
  const SortTh = ({col, children, style={}}) => (
    <th onClick={()=>toggleSort(col)} style={{padding:"8px 10px",fontWeight:700,fontSize:11,cursor:"pointer",userSelect:"none",whiteSpace:"nowrap",
      color:sortCol===col?"#1e3a5f":"#6b7280",background:sortCol===col?"#eff6ff":"#f9fafb",...style}}>
      {children}{sortCol===col?(sortDir>0?" ↑":" ↓"):""}
    </th>
  );

  // Totals row
  const totals = useMemo(() => {
    const byTeam={}; TEAMS.forEach(t=>byTeam[t]=0);
    const byNW={};
    rows.forEach(r => {
      TEAMS.forEach(t=>{ byTeam[t]+=(r.byTeam[t]||0); });
      Object.entries(r.byNW).forEach(([code,h])=>{ byNW[code]=(byNW[code]||0)+h; });
    });
    return { byTeam, byNW, totalWork:rows.reduce((a,r)=>a+r.totalWork,0), totalNW:rows.reduce((a,r)=>a+r.totalNW,0), total:rows.reduce((a,r)=>a+r.total,0),
      ecHrs:rows.reduce((a,r)=>a+(r.ecHrs||0),0), ecShifts:rows.reduce((a,r)=>a+(r.ecShifts||0),0) };
  }, [rows]);

  const nwCodes = useMemo(() => {
    const codes = new Set();
    rows.forEach(r => Object.keys(r.byNW).forEach(c=>codes.add(c)));
    return [...codes].sort();
  }, [rows]);

  const fmtH = h => h===0?"—":`${h}h`;

  return (
    <div style={{display:"grid",gap:14}}>
      {/* Controls */}
      <div style={{background:"#fff",borderRadius:14,padding:14,border:"1px solid #e5e7eb",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <div style={{fontSize:14,fontWeight:800,color:"#1e3a5f",flexShrink:0}}>🕐 Timesheets</div>
        <div style={{display:"flex",gap:3,background:"#f1f5f9",borderRadius:8,padding:3}}>
          {[["week","This Week"],["lastweek","Last Week"],["month","This Month"],["lastmonth","Last Month"],["year","This Year"],["custom","Custom"]].map(([v,l])=>(
            <button key={v} onClick={()=>setRangeType(v)} style={{padding:"4px 10px",borderRadius:6,fontSize:11,fontWeight:600,border:"none",cursor:"pointer",
              background:rangeType===v?"#fff":"transparent",color:rangeType===v?"#1e3a5f":"#6b7280",
              boxShadow:rangeType===v?"0 1px 3px rgba(0,0,0,0.1)":"none"}}>{l}</button>
          ))}
        </div>
        {rangeType==="custom" && <>
          <input type="date" value={customStart} onChange={e=>setCustomStart(e.target.value)} style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12}} />
          <span style={{fontSize:12,color:"#9ca3af"}}>to</span>
          <input type="date" value={customEnd} onChange={e=>setCustomEnd(e.target.value)} style={{padding:"4px 8px",borderRadius:7,border:"1px solid #d1d5db",fontSize:12}} />
        </>}
        <button onClick={()=>setEcOnly(v=>!v)} style={{
          padding:"5px 12px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer",
          background:ecOnly?"#fef9c3":"#f9fafb",color:ecOnly?"#92400e":"#6b7280",
          border:"1px solid "+(ecOnly?"#f59e0b":"#e5e7eb")
        }}>{"⭐ " + (ecOnly?"Extra Comp Only":"All Staff")}</button>
        <select value={filterTeam} onChange={e=>setFilterTeam(e.target.value)} style={{marginLeft:"auto",padding:"5px 10px",borderRadius:8,border:"1px solid #e5e7eb",fontSize:12,fontWeight:600,background:"#fff"}}>
          <option>All</option>
          {TEAMS.map(t=><option key={t}>{t}</option>)}
        </select>
      </div>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
        <div style={{background:"#fff",borderRadius:12,padding:"12px 16px",border:"1px solid #e5e7eb",textAlign:"center"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",textTransform:"uppercase",marginBottom:4}}>Total Work Hours</div>
          <div style={{fontSize:24,fontWeight:800,color:"#1e3a5f"}}>{totals.totalWork}h</div>
          <div style={{fontSize:10,color:"#9ca3af"}}>{sorted.length} staff</div>
        </div>
        <div style={{background:"#fef9c3",borderRadius:12,padding:"12px 16px",border:"1px solid #f59e0b44",textAlign:"center"}}>
          <div style={{fontSize:10,fontWeight:700,color:"#92400e",textTransform:"uppercase",marginBottom:4}}>⭐ Extra Comp</div>
          <div style={{fontSize:24,fontWeight:800,color:"#d97706"}}>{totals.ecHrs||0}h</div>
          <div style={{fontSize:10,color:"#92400e"}}>{((totals.ecShifts||0)%1===0?(totals.ecShifts||0):(totals.ecShifts||0).toFixed(1))} shifts</div>
        </div>
        {TEAMS.map(t => {
          const tc=TEAM_COLORS[t];
          return <div key={t} style={{background:tc.bg,borderRadius:12,padding:"12px 16px",border:"1px solid "+tc.dot+"44",textAlign:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:tc.text,textTransform:"uppercase",marginBottom:4}}>{t}</div>
            <div style={{fontSize:24,fontWeight:800,color:tc.dot}}>{totals.byTeam[t]}h</div>
            <div style={{fontSize:10,color:tc.text+"99"}}>{rangeDays.length} days</div>
          </div>;
        })}
      </div>

      {/* Main table */}
      <div style={{background:"#fff",borderRadius:14,border:"1px solid #e5e7eb",overflow:"hidden"}}>
        <div style={{overflowX:"auto",maxHeight:"calc(100vh - 340px)",overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead style={{position:"sticky",top:0,zIndex:5}}>
              <tr style={{borderBottom:"2px solid #e5e7eb"}}>
                <SortTh col="name" style={{textAlign:"left",paddingLeft:16,position:"sticky",left:0,zIndex:6,background:"#f9fafb"}}>Staff</SortTh>
                <SortTh col="team" style={{textAlign:"left"}}>Team</SortTh>
                {TEAMS.map(t=><SortTh key={t} col={t} style={{textAlign:"center",background:sortCol===t?"#eff6ff":TEAM_COLORS[t].bg,color:TEAM_COLORS[t].text}}>{t}</SortTh>)}
                <SortTh col="work" style={{textAlign:"center"}}>Work Hrs</SortTh>
                {nwCodes.map(c => {
                  const nw=nonWorkTypes.find(n=>n.code===c);
                  return <th key={c} style={{padding:"8px 8px",fontWeight:700,fontSize:11,textAlign:"center",color:nw?.color||"#6b7280",background:(nw?.color||"#6b7280")+"11",whiteSpace:"nowrap"}}>{c}</th>;
                })}
                {nwCodes.length>0 && <SortTh col="nw" style={{textAlign:"center"}}>NW Hrs</SortTh>}
                <SortTh col="ec" style={{textAlign:"center",background:sortCol==="ec"?"#fef9c3":"#fffbeb",color:"#92400e"}}>⭐ EC</SortTh>
                <SortTh col="total" style={{textAlign:"center",background:sortCol==="total"?"#eff6ff":"#f0f7ff",color:"#1e3a5f"}}>Total</SortTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({s, byTeam, byNW, totalWork, totalNW, total, ecHrs, ecShifts}) => {
                const tc=TEAM_COLORS[s.team];
                return (
                  <tr key={s.id} style={{borderBottom:"1px solid #f3f4f6"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
                    onMouseLeave={e=>e.currentTarget.style.background=""}>
                    <td style={{padding:"8px 16px",fontWeight:700,color:s.archived?"#6b7280":"#111827",whiteSpace:"nowrap",position:"sticky",left:0,background:"inherit",zIndex:2}}>
                      <span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:tc?.dot,marginRight:6}} />
                      {s.name}
                      {s.archived && <span style={{marginLeft:5,fontSize:9,padding:"1px 5px",borderRadius:99,background:"#f3f4f6",color:"#9ca3af",fontWeight:700}}>archived</span>}
                    </td>
                    <td style={{padding:"8px 10px"}}>
                      <span style={{padding:"2px 7px",borderRadius:99,background:tc?.bg,color:tc?.text,fontSize:10,fontWeight:700}}>{s.team}</span>
                    </td>
                    {TEAMS.map(t=><td key={t} style={{padding:"8px 10px",textAlign:"center",color:byTeam[t]>0?TEAM_COLORS[t].dot:"#d1d5db",fontWeight:byTeam[t]>0?700:400}}>{fmtH(byTeam[t])}</td>)}
                    <td style={{padding:"8px 10px",textAlign:"center",fontWeight:700,color:"#1e3a5f"}}>{fmtH(totalWork)}</td>
                    {nwCodes.map(c => {
                      const nw=nonWorkTypes.find(n=>n.code===c);
                      const h=byNW[c]||0;
                      return <td key={c} style={{padding:"8px 8px",textAlign:"center",color:h>0?(nw?.color||"#6b7280"):"#d1d5db",fontWeight:h>0?700:400}}>{fmtH(h)}</td>;
                    })}
                    {nwCodes.length>0 && <td style={{padding:"8px 10px",textAlign:"center",color:totalNW>0?"#d97706":"#d1d5db",fontWeight:totalNW>0?700:400}}>{fmtH(totalNW)}</td>}
                    <td style={{padding:"8px 10px",textAlign:"center",fontWeight:700,color:(ecHrs||0)>0?"#d97706":"#d1d5db",background:sortCol==="ec"?"#fffbeb":"inherit"}}>
                      {(ecHrs||0)>0 ? `${ecHrs}h / ${(ecShifts||0)%1===0?(ecShifts||0):(ecShifts||0).toFixed(1)}` : "—"}
                    </td>
                    <td style={{padding:"8px 10px",textAlign:"center",fontWeight:800,color:"#1e3a5f",background:"#f0f7ff"}}>{fmtH(total)}</td>
                  </tr>
                );
              })}
              {/* Totals row */}
              <tr style={{borderTop:"2px solid #e5e7eb",background:"#f8fafc",fontWeight:800}}>
                <td style={{padding:"8px 16px",fontWeight:800,color:"#374151",position:"sticky",left:0,background:"#f8fafc",zIndex:2}}>TOTAL</td>
                <td />
                {TEAMS.map(t=><td key={t} style={{padding:"8px 10px",textAlign:"center",color:TEAM_COLORS[t].dot,fontWeight:800}}>{totals.byTeam[t]>0?`${totals.byTeam[t]}h`:"—"}</td>)}
                <td style={{padding:"8px 10px",textAlign:"center",fontWeight:800,color:"#1e3a5f"}}>{totals.totalWork>0?`${totals.totalWork}h`:"—"}</td>
                {nwCodes.map(c=><td key={c} style={{padding:"8px 8px",textAlign:"center",color:"#d97706",fontWeight:800}}>{totals.byNW[c]>0?`${totals.byNW[c]}h`:"—"}</td>)}
                {nwCodes.length>0 && <td style={{padding:"8px 10px",textAlign:"center",fontWeight:800,color:"#d97706"}}>{totals.totalNW>0?`${totals.totalNW}h`:"—"}</td>}
                <td style={{padding:"8px 10px",textAlign:"center",fontWeight:800,color:"#d97706",background:"#fffbeb"}}>
                  {(totals.ecHrs||0)>0?`${totals.ecHrs}h / ${(totals.ecShifts||0)%1===0?(totals.ecShifts||0):(totals.ecShifts||0).toFixed(1)}`:"—"}
                </td>
                <td style={{padding:"8px 10px",textAlign:"center",fontWeight:800,color:"#1e3a5f",background:"#e0f2fe"}}>{totals.total>0?`${totals.total}h`:"—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {sorted.length===0 && <div style={{padding:40,textAlign:"center",color:"#9ca3af",fontSize:13}}>No schedule data for this period.</div>}
      </div>
    </div>
  );
}

// ─── Staff Tab ────────────────────────────────────────────────────────────────
// defaultSchedule: [{day:0-6, team, hours}]  (day 0=Sun)
function StaffTab({ staff, updateStaff, entries, updateEntries, weekStart, nonWorkTypes, ptoBalances, updatePtoBalances, ptoAlerts, competencies=[] }) {
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
  const confirmRemove = async () => {
    const id = confirmDelete;
    try {
      const sb = await getSB();
      // Delete staff record and all their entries from Supabase
      await sb.from("entries").delete().eq("staff_id", String(id));
      await sb.from("pto_balances").delete().eq("staff_id", String(id));
      await sbDeleteStaff(id);
    } catch(e) { console.error("Delete failed:", e); }
    updateStaff(staff.filter(s => s.id !== id));
    setConfirmDelete(null);
  };
  const update = (id, field, value) => updateStaff(staff.map(s => s.id === id ? { ...s, [field]: value } : s));
  const archiveStaff = (id) => updateStaff(staff.map(s => s.id === id ? { ...s, archived: true } : s));
  const unarchiveStaff = (id) => updateStaff(staff.map(s => s.id === id ? { ...s, archived: false } : s));
  const archivedCount = staff.filter(s => s.archived).length;

  // Always derive weekly hours from defaultSchedule (standard template only, no actual entries)
  const getWeeklyHours = (s) => {
    const sched = s.defaultSchedule || DAYS.map((_,i)=>({day:i,team:s.team,hours:i===0||i===6?0:8}));
    return sched.reduce((a,d) => a + (Number(d.hours)||0), 0);
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
  const [notesOpenId, setNotesOpenId] = useState(null);
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(s => {
          const tc = TEAM_COLORS[s.team];
          const isOpen = editingId === s.id;
          // Always normalize to exactly 7 entries indexed 0-6 by day number
          const rawSched = s.defaultSchedule && s.defaultSchedule.length > 0
            ? s.defaultSchedule
            : DAYS.map((_,i) => ({ day: i, team: s.team, hours: i===0||i===6?0:8 }));
          const sched = DAYS.map((_,i) => {
            const found = rawSched.find(d => Number(d.day) === i) || rawSched[i];
            return found ? { ...found, day: i } : { day: i, team: s.team, hours: i===0||i===6?0:8 };
          });
          const schedHrs = sched.reduce((a, d) => a + (Number(d.hours) || 0), 0);
          const weeklyHrs = schedHrs;
          const autoFTE = +(schedHrs / 40).toFixed(2);

          return (
            <div key={s.id} style={{ background:s.archived?"#f9fafb":"#fff", borderRadius:12, border:"1px solid #e5e7eb", overflow:"visible", boxShadow:"0 1px 3px rgba(0,0,0,0.04)", opacity:s.archived?0.75:1, width:"100%" }}>
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
                  <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase" }}>Std Hrs</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "#1e3a5f" }}>{weeklyHrs}h</div>
                  <div style={{ fontSize: 9, color: "#9ca3af" }}>standard</div>
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
                  <button onClick={() => setNotesOpenId(notesOpenId === s.id ? null : s.id)}
                    title="Staff notes"
                    style={{ background: notesOpenId===s.id?"#f5f3ff":"#f3f4f6", border:"1px solid "+(notesOpenId===s.id?"#c4b5fd":"#e5e7eb"), borderRadius:6, color:notesOpenId===s.id?"#6d28d9":"#6b7280", fontWeight:700, cursor:"pointer", padding:"3px 10px", fontSize:11, whiteSpace:"nowrap" }}>
                    {notesOpenId===s.id?"▲ Hide":"📝 Notes"}{s.notes ? " •" : ""}
                  </button>
                  {s.archived ? (
                    <button onClick={()=>remove(s.id)} title="Permanently delete"
                      style={{background:"#fee2e2",border:"none",borderRadius:6,color:"#dc2626",fontWeight:700,cursor:"pointer",padding:"3px 9px",fontSize:11,whiteSpace:"nowrap"}}>🗑 Delete</button>
                  ) : (
                    <button onClick={()=>archiveStaff(s.id)} title="Archive — hides from scheduling but keeps all history"
                      style={{background:"#f3f4f6",border:"1px solid #e5e7eb",borderRadius:6,color:"#6b7280",fontWeight:700,cursor:"pointer",padding:"3px 9px",fontSize:11,whiteSpace:"nowrap"}}>📦 Archive</button>
                  )}
                </div>
                {/* Competencies */}
                {competencies.length > 0 && (
                  <div style={{marginTop:6,display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                    <span style={{fontSize:10,color:"#9ca3af",fontWeight:600,flexShrink:0}}>🎯 Competencies:</span>
                    {competencies.map(c => {
                      const has = (s.competencies||[]).includes(c.id);
                      return (
                        <button key={c.id} onClick={()=>{
                          const cur = s.competencies||[];
                          const next = has ? cur.filter(x=>x!==c.id) : [...cur, c.id];
                          update(s.id, "competencies", next);
                        }} style={{
                          fontSize:10,padding:"2px 8px",borderRadius:99,fontWeight:700,cursor:"pointer",
                          background:has?c.color:c.color+"15",
                          color:has?"#fff":c.color,
                          border:"1.5px solid "+(has?c.color:c.color+"44"),
                          transition:"all 0.15s"
                        }}>{c.name}</button>
                      );
                    })}
                  </div>
                )}
                {/* Employment dates */}
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginTop:4}}>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{fontSize:10,color:"#9ca3af",fontWeight:600,whiteSpace:"nowrap"}}>Start</span>
                    <input type="date" value={s.startDate||""} onChange={e=>update(s.id,"startDate",e.target.value||null)}
                      style={{fontSize:11,padding:"2px 5px",borderRadius:5,border:"1px solid #e5e7eb",color:"#374151"}} />
                    {s.startDate && <button onClick={()=>update(s.id,"startDate",null)}
                      style={{fontSize:10,color:"#9ca3af",background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>✕</button>}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <span style={{fontSize:10,color:"#9ca3af",fontWeight:600,whiteSpace:"nowrap"}}>End</span>
                    <input type="date" value={s.terminationDate||""} onChange={e=>update(s.id,"terminationDate",e.target.value||null)}
                      style={{fontSize:11,padding:"2px 5px",borderRadius:5,border:"1px solid "+(s.terminationDate?"#fca5a5":"#e5e7eb"),color:s.terminationDate?"#dc2626":"#374151"}} />
                    {s.terminationDate && <button onClick={()=>update(s.id,"terminationDate",null)}
                      style={{fontSize:10,color:"#9ca3af",background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>✕</button>}
                  </div>
                  {s.terminationDate && (
                    <span style={{fontSize:10,padding:"1px 7px",borderRadius:99,background:"#fef2f2",color:"#dc2626",fontWeight:700,border:"1px solid #fca5a5"}}>
                      {"Ends " + new Date(s.terminationDate+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
                    </span>
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

              {/* Staff Notes panel */}
              {notesOpenId === s.id && (
                <div style={{ borderTop:"1px solid #f3f4f6", padding:"14px 16px", background:"#faf5ff" }}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#6d28d9", marginBottom:8 }}>📝 Staff Notes</div>
                  <textarea
                    value={s.notes || ""}
                    onChange={e => update(s.id, "notes", e.target.value)}
                    placeholder="Add notes about this staff member — certifications, accommodations, performance notes, contact info, etc."
                    rows={4}
                    style={{ width:"100%", padding:"8px 10px", borderRadius:8, border:"1px solid #c4b5fd", fontSize:12, color:"#374151", resize:"vertical", fontFamily:"inherit", lineHeight:1.5, outline:"none", background:"#fff" }}
                  />
                  <div style={{ fontSize:10, color:"#9ca3af", marginTop:4 }}>Notes are saved automatically as you type and included in backups.</div>
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
                        {(() => {
                          const SICK_LIMIT = 56;
                          const sickCode = nonWorkTypes.find(n => n.code === "SICK" || n.label?.toLowerCase().includes("sick"))?.code || "SICK";
                          const nw = nonWorkTypes.find(n => n.code === sickCode);
                          if (!nw) return null;
                          const used = summary[sickCode] || 0;
                          const remaining = Math.max(0, SICK_LIMIT - used);
                          const pct = Math.min((used / SICK_LIMIT) * 100, 100);
                          return (
                            <div style={{ padding:"10px 12px", borderRadius:9, background:"#fff", border:"1px solid "+nw.color+"33" }}>
                              <div style={{ fontSize:10, fontWeight:700, color:nw.color, marginBottom:4 }}>{nw.label} Balance (Annual)</div>
                              <div style={{ fontSize:10, color:"#6b7280", marginBottom:6 }}>Limit: <b>56h</b> · resets Jan 1</div>
                              <div style={{ height:5, background:"#f3f4f6", borderRadius:3, marginBottom:4 }}>
                                <div style={{ height:"100%", width:pct+"%", background:pct>=100?"#ef4444":pct>=80?"#f59e0b":nw.color, borderRadius:3, transition:"width 0.3s" }} />
                              </div>
                              <div style={{ fontSize:10, color:"#6b7280" }}>
                                Used: <b style={{ color:nw.color }}>{used}h</b> · Left: <b style={{ color:remaining<8?"#dc2626":"#15803d" }}>{remaining}h</b>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Custom schedule panel */}
              {isOpen && (
                <div style={{ borderTop: "3px solid #3b82f6", padding: "16px 16px", background: "#eff6ff" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#1d4ed8", marginBottom: 12 }}>
                    📅 Default Weekly Schedule
                    <span style={{ fontSize: 11, color: "#6b7280", fontWeight: 400, marginLeft: 8 }}>
                      Set hours and team per day
                    </span>
                  </div>
                  <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(90px, 1fr))", gap: 8, minWidth: 600 }}>
                    {sched.map((dayEntry, di) => {
                      const dayTc = TEAM_COLORS[dayEntry.team || s.team];
                      const isWE = di === 0 || di === 6;
                      const isOff = Number(dayEntry.hours) === 0;
                      return (
                        <div key={di} style={{ borderRadius: 8, border: "2px solid " + (isWE ? "#d8b4fe" : isOff ? "#e5e7eb" : dayTc?.dot||"#3b82f6"), background: isWE ? "#faf5ff" : isOff ? "#f9fafb" : "#fff", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: isWE ? "#7c3aed" : isOff ? "#9ca3af" : "#374151", textAlign: "center", textTransform: "uppercase", letterSpacing: "0.05em" }}>{DAYS[di]}</div>
                          <input type="number" min="0" max="24" step="0.5"
                            value={dayEntry.hours === 0 && isWE ? "" : dayEntry.hours}
                            placeholder={isWE ? "OFF" : "8"}
                            onChange={e => {
                              const newSched = sched.map((d, i) => i === di ? { ...d, hours: e.target.value === "" ? 0 : Number(e.target.value) } : d);
                              update(s.id, "defaultSchedule", newSched);
                            }}
                            style={{ width: "100%", padding: "7px 6px", border: "1px solid " + (isOff?"#e5e7eb":dayTc?.dot+"88"||"#93c5fd"), borderRadius: 6, fontSize: 14, fontWeight: 800, textAlign: "center", boxSizing: "border-box", background: isOff ? "#f3f4f6" : "#fff", color: isOff ? "#9ca3af" : "#1e3a5f" }} />
                          <select
                            value={dayEntry.team || s.team}
                            onChange={e => {
                              const newSched = sched.map((d, i) => i === di ? { ...d, team: e.target.value } : d);
                              update(s.id, "defaultSchedule", newSched);
                            }}
                            style={{ width: "100%", padding: "5px 4px", border: "1px solid " + (dayTc?.dot || "#e5e7eb"), borderRadius: 6, fontSize: 11, fontWeight: 600, background: isOff ? "#f3f4f6" : dayTc?.bg || "#f9fafb", color: isOff ? "#9ca3af" : dayTc?.text || "#374151", boxSizing: "border-box", cursor: "pointer" }}>
                            {TEAMS.map(t => <option key={t}>{t}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11, color: "#6b7280", display: "flex", gap: 16 }}>
                    <span>Standard weekly total: <b style={{ color: "#1e3a5f" }}>{schedHrs}h</b></span>
                    <span>FTE: <b style={{ color: schedHrs/40 >= 1 ? "#15803d" : schedHrs/40 >= 0.5 ? "#d97706" : "#dc2626" }}>{(schedHrs/40).toFixed(2)}</b></span>
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
        if (hasData && !overwrite) return; // skip if overwrite not enabled
        rows.push({ staffId: sid, name: s.name, team: s.team, dateStr: ds, hasExisting: hasData, existing: existing||[], accepted: true });
      });
    });
    setPreview(rows);
    setStep("preview");
  };
  const toggleAccept = (i) => setPreview(prev => prev.map((r,idx) => idx===i ? {...r, accepted:!r.accepted} : r));
  const acceptAll = () => setPreview(prev => prev.map(r => ({...r, accepted:true})));
  const rejectAll = () => setPreview(prev => prev.map(r => ({...r, accepted:false})));
  const rejectExisting = () => setPreview(prev => prev.map(r => ({...r, accepted: !r.hasExisting})));

  const apply = () => {
    const newEntries = { ...entries };
    preview.filter(row => row.accepted).forEach(row => {
      let seg;
      if (entryType === "nonwork") {
        seg = [{ hours: 0, team: row.team, nonWork: nonWorkCode, nonWorkHours: Number(nonWorkHours), comment, swap }];
      } else if (entryType === "schedule") {
        seg = [{ hours: Number(workHours), team: workTeam, nonWork: "", nonWorkHours: 0, comment, swap }];
      } else {
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
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000}}>
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
            {/* Summary + bulk action bar */}
            <div style={{marginBottom:10}}>
              <div style={{fontSize:14,fontWeight:700,color:"#374151",marginBottom:6}}>
                Review Changes — {preview.filter(r=>r.accepted).length} of {preview.length} accepted
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                <button onClick={acceptAll} style={{padding:"4px 12px",borderRadius:7,background:"#f0fdf4",border:"1px solid #86efac",color:"#15803d",fontSize:11,fontWeight:700,cursor:"pointer"}}>✓ Accept All</button>
                <button onClick={rejectExisting} style={{padding:"4px 12px",borderRadius:7,background:"#fffbeb",border:"1px solid #fcd34d",color:"#92400e",fontSize:11,fontWeight:700,cursor:"pointer"}}>⚠ Skip Existing</button>
                <button onClick={rejectAll} style={{padding:"4px 12px",borderRadius:7,background:"#fef2f2",border:"1px solid #fca5a5",color:"#dc2626",fontSize:11,fontWeight:700,cursor:"pointer"}}>✕ Reject All</button>
                <span style={{marginLeft:"auto",fontSize:11,color:"#6b7280",alignSelf:"center"}}>
                  {entryType==="nonwork" && `${nonWorkCode} ${nonWorkHours}h`}
                  {entryType==="schedule" && `${workHours}h ${workTeam}`}
                  {entryType==="off" && "Clear entries"}
                </span>
              </div>
            </div>

            <div style={{maxHeight:320,overflowY:"auto",border:"1px solid #e5e7eb",borderRadius:10,marginBottom:14}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead style={{position:"sticky",top:0,zIndex:2}}>
                  <tr style={{background:"#f9fafb",borderBottom:"1px solid #e5e7eb"}}>
                    <th style={{padding:"7px 10px",textAlign:"left",fontWeight:700,color:"#374151",fontSize:11}}>Staff</th>
                    <th style={{padding:"7px 8px",textAlign:"left",fontWeight:700,color:"#374151",fontSize:11}}>Date</th>
                    <th style={{padding:"7px 8px",textAlign:"left",fontWeight:700,color:"#6b7280",fontSize:11}}>Current</th>
                    <th style={{padding:"7px 8px",textAlign:"left",fontWeight:700,color:"#1e3a5f",fontSize:11}}>New Entry</th>
                    <th style={{padding:"7px 8px",textAlign:"center",fontWeight:700,color:"#374151",fontSize:11}}>Accept?</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0,200).map((row,i) => {
                    const tc = TEAM_COLORS[row.team];
                    const existingSegs = row.existing || [];
                    const existingLabel = existingSegs.length
                      ? existingSegs.map(e => {
                          const parts = [];
                          if (Number(e.hours)>0) parts.push(`${e.hours}h ${e.team||row.team}`);
                          if (e.nonWork) parts.push(`${e.nonWork}${e.nonWorkHours?` ${e.nonWorkHours}h`:""}`);
                          return parts.join(" + ") || "—";
                        }).join(", ")
                      : "—";
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #f3f4f6",background:!row.accepted?"#f9fafb":row.hasExisting?"#fff7ed":"#fff",opacity:row.accepted?1:0.5}}>
                        <td style={{padding:"6px 10px",fontWeight:600,color:"#111827",whiteSpace:"nowrap"}}>
                          <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:tc?.dot,marginRight:5,flexShrink:0}} />
                          {row.name}
                        </td>
                        <td style={{padding:"6px 8px",color:"#374151",whiteSpace:"nowrap"}}>
                          {new Date(row.dateStr+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"})}
                        </td>
                        <td style={{padding:"6px 8px",color:row.hasExisting?"#d97706":"#9ca3af",fontSize:11,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {existingLabel}
                        </td>
                        <td style={{padding:"6px 8px"}}>
                          {entryType==="nonwork" && <span style={{padding:"1px 7px",borderRadius:99,background:(nwInfo?.color||"#6b7280")+"22",color:nwInfo?.color||"#6b7280",fontWeight:700,fontSize:11}}>{nonWorkCode} {nonWorkHours}h</span>}
                          {entryType==="schedule" && <span style={{padding:"1px 7px",borderRadius:99,background:tc?.bg,color:tc?.text,fontWeight:700,fontSize:11}}>{workHours}h {workTeam}</span>}
                          {entryType==="off" && <span style={{fontSize:11,color:"#9ca3af"}}>— clear —</span>}
                        </td>
                        <td style={{padding:"6px 8px",textAlign:"center"}}>
                          <button onClick={()=>toggleAccept(i)} style={{
                            width:26,height:26,borderRadius:6,border:"2px solid "+(row.accepted?"#22c55e":"#d1d5db"),
                            background:row.accepted?"#22c55e":"#fff",color:row.accepted?"#fff":"#9ca3af",
                            cursor:"pointer",fontWeight:800,fontSize:13,display:"inline-flex",alignItems:"center",justifyContent:"center"
                          }}>{row.accepted?"✓":"✕"}</button>
                        </td>
                      </tr>
                    );
                  })}
                  {preview.length > 200 && <tr><td colSpan={5} style={{padding:"8px 12px",textAlign:"center",color:"#9ca3af",fontSize:11}}>...and {preview.length-200} more rows</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setStep("setup")} style={{flex:1,padding:"10px",borderRadius:10,background:"#f3f4f6",border:"none",cursor:"pointer",fontSize:13,fontWeight:600}}>← Back</button>
              <button onClick={apply} disabled={preview.filter(r=>r.accepted).length===0}
                style={{flex:2,padding:"10px",borderRadius:10,background:preview.filter(r=>r.accepted).length===0?"#e5e7eb":"#1e3a5f",color:preview.filter(r=>r.accepted).length===0?"#9ca3af":"#fff",border:"none",cursor:preview.filter(r=>r.accepted).length===0?"not-allowed":"pointer",fontSize:14,fontWeight:700}}>
                Apply {preview.filter(r=>r.accepted).length} Entries →
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
function BackupRestoreModal({ onClose, updateStaff, updateEntries, updateDailyStats, updatePtoBalances, updateNonWorkTypes, updateAlertSettings, updateDayNotes, updateVisitData, updateLocations }) {
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
      // Log any rows being dropped so we can debug missing staff
      const droppedStaff = staffRows.filter(r=>!r[0]||!r[1]||!r[2]);
      if (droppedStaff.length) console.warn("Dropped staff rows:", droppedStaff);
      const newStaff = staffRows.filter(r=>r[1]&&r[2]).map(r => ({
        id: r[0] ? Number(r[0]) : Date.now() + Math.random(),
        name:String(r[1]), team:String(r[2]),
        fte:Number(r[3])||1, defaultHours:Number(r[4])||8,
        shiftStart:r[5]||"08:00", shiftEnd:r[6]||"16:00",
        defaultSchedule:(() => { try { return JSON.parse(r[7]||"[]"); } catch(e) { return []; } })(),
        notes: r[8] ? String(r[8]) : ""
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
      const locRows2 = sheetData("Locations");
      const newLocations = locRows2.filter(r=>r[1]&&r[2]).map(r => ({id:r[0]||Date.now()+Math.random(),team:String(r[1]),name:String(r[2])}));
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
      // Clear existing data first to avoid duplicates, then save fresh
      setStatus({ok:true, msg:"⏳ Clearing existing data..."});
      const sb = await getSB();
      await sb.from("entries").delete().neq("date_str", "___never___");
      await sb.from("staff").delete().neq("id", -1);
      await sb.from("daily_stats").delete().neq("date_str", "___never___");
      await sb.from("pto_balances").delete().neq("staff_id", -1);
      await sb.from("day_notes").delete().neq("date_str", "___never___");
      await sb.from("visit_data").delete().neq("week_key", "___never___");
      setStatus({ok:true, msg:"⏳ Saving staff..."});
      await sbSaveStaff(newStaff);
      setStatus({ok:true, msg:"⏳ Saving schedule entries..."});
      await sbSaveEntries(newEntries);
      setStatus({ok:true, msg:"⏳ Saving stats & PTO..."});
      await sbSaveDailyStats(newDailyStats);
      await sbSavePTO(newPTO);
      setStatus({ok:true, msg:"⏳ Saving notes & visits..."});
      await sbSaveNotes(newNotes);
      await sbSaveVisits(finalVisits);
      if (finalNW)     await sbSaveNonWorkTypes(finalNW);
      if (finalAlerts) await sbSaveAlertSettings(finalAlerts);
      // Update React state AFTER Supabase confirms all writes
      window.__staffplanRestoring = true;
      updateStaff(newStaff);
      updateEntries(newEntries);
      updateDailyStats(newDailyStats);
      updatePtoBalances(newPTO);
      if (finalNW)       updateNonWorkTypes(finalNW);
      if (finalAlerts)   updateAlertSettings(finalAlerts);
      if (newLocations.length) updateLocations(newLocations);
      updateDayNotes(newNotes);
      updateVisitData(finalVisits);
      window.__staffplanRestoring = false;
      const visitWeekCount = Object.keys(finalVisits).length;
      setStatus({ok:true, msg:`✅ Restored & saved to Supabase! ${newStaff.length} staff · ${Object.keys(newEntries).length} schedule entries · ${Object.keys(newDailyStats).length} daily stats${visitWeekCount ? ` · ${visitWeekCount} visit weeks` : ""}. You can safely close and reopen.`});
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

// ─── Analytics Dashboard ──────────────────────────────────────────────────────
function AnalyticsDashboard({ currentUser }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(30); // days to look back
  const [view, setView] = useState("overview"); // overview | logins | tabs | users

  useEffect(() => {
    sbLoadUsageEvents().then(data => { setEvents(data); setLoading(false); });
  }, []);

  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - range);
  const filtered = events.filter(e => new Date(e.created_at) >= cutoff);

  // ── Derived stats ──
  const loginEvents = filtered.filter(e => e.event_type === "login");
  const tabViewEvents = filtered.filter(e => e.event_type === "tab_view");
  const tabExitEvents = filtered.filter(e => e.event_type === "tab_exit");

  // Unique users
  const uniqueUsers = [...new Set(filtered.map(e => e.user_email))];

  // Logins per user
  const loginsByUser = {};
  loginEvents.forEach(e => { loginsByUser[e.user_email] = (loginsByUser[e.user_email] || 0) + 1; });

  // Last seen per user
  const lastSeenByUser = {};
  filtered.forEach(e => {
    if (!lastSeenByUser[e.user_email] || e.created_at > lastSeenByUser[e.user_email]) {
      lastSeenByUser[e.user_email] = e.created_at;
    }
  });

  // Tab views count
  const tabViews = {};
  tabViewEvents.forEach(e => {
    const tab = e.payload?.tab || "unknown";
    tabViews[tab] = (tabViews[tab] || 0) + 1;
  });

  // Tab avg duration (seconds)
  const tabDurations = {};
  const tabDurationCounts = {};
  tabExitEvents.forEach(e => {
    const tab = e.payload?.tab || "unknown";
    const dur = Number(e.payload?.duration_seconds) || 0;
    if (dur > 0 && dur < 7200) { // ignore outliers > 2hrs
      tabDurations[tab] = (tabDurations[tab] || 0) + dur;
      tabDurationCounts[tab] = (tabDurationCounts[tab] || 0) + 1;
    }
  });

  // Logins by day (last N days)
  const loginsByDay = {};
  loginEvents.forEach(e => {
    const day = e.created_at.slice(0, 10);
    loginsByDay[day] = (loginsByDay[day] || 0) + 1;
  });

  // All tabs in order of views
  const TAB_LABELS = { day:"Day", grid:"Week", master:"Master", month:"Month", year:"Year", summary:"Dept Stats", visits:"Visits", timesheet:"Timesheets", analytics:"Analytics" };
  const sortedTabs = Object.entries(tabViews).sort((a, b) => b[1] - a[1]);
  const maxTabViews = sortedTabs[0]?.[1] || 1;

  const fmtDur = (s) => {
    if (!s) return "—";
    if (s < 60) return `${Math.round(s)}s`;
    return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // Days array for sparkline
  const days = Array.from({ length: range }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (range - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  const maxDay = Math.max(...days.map(d => loginsByDay[d] || 0), 1);

  const sectionStyle = { background:"#fff", borderRadius:14, border:"1px solid #e5e7eb", padding:"18px 20px" };
  const hdr = { fontSize:13, fontWeight:800, color:"#1e3a5f", marginBottom:14, display:"flex", alignItems:"center", gap:6 };

  if (loading) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:"#9ca3af",fontSize:14}}>
      ⏳ Loading analytics…
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {/* Header + controls */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:18, fontWeight:800, color:"#1e3a5f" }}>🔍 Usage Analytics</div>
          <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>Login frequency, page views, and time-on-page per user</div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          {[7,30,90].map(d => (
            <button key={d} onClick={() => setRange(d)} style={{
              padding:"5px 14px", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer",
              border:"1px solid "+(range===d?"#3b82f6":"#e5e7eb"),
              background:range===d?"#eff6ff":"#fff",
              color:range===d?"#1d4ed8":"#6b7280"
            }}>Last {d}d</button>
          ))}
          <button onClick={() => sbLoadUsageEvents().then(setEvents)} style={{
            padding:"5px 12px", borderRadius:8, fontSize:12, fontWeight:700, cursor:"pointer",
            border:"1px solid #e5e7eb", background:"#f9fafb", color:"#6b7280"
          }}>↺ Refresh</button>
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(150px,1fr))", gap:10 }}>
        {[
          { label:"Total Logins", value:loginEvents.length, icon:"🔑", color:"#1d4ed8" },
          { label:"Unique Users", value:uniqueUsers.length, icon:"👤", color:"#7c3aed" },
          { label:"Page Views", value:tabViewEvents.length, icon:"📄", color:"#0369a1" },
          { label:"Avg Session Tabs", value: loginEvents.length > 0 ? (tabViewEvents.length / loginEvents.length).toFixed(1) : "—", icon:"🗂", color:"#15803d" },
        ].map(k => (
          <div key={k.label} style={{ background:"#fff", borderRadius:12, border:"1px solid #e5e7eb", padding:"14px 16px" }}>
            <div style={{ fontSize:20 }}>{k.icon}</div>
            <div style={{ fontSize:22, fontWeight:800, color:k.color, marginTop:4 }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#6b7280", fontWeight:600, marginTop:2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Login sparkline */}
      <div style={sectionStyle}>
        <div style={hdr}>📈 Logins per Day</div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:60 }}>
          {days.map(d => {
            const count = loginsByDay[d] || 0;
            const h = maxDay > 0 ? Math.max(3, (count / maxDay) * 56) : 3;
            const isToday = d === new Date().toISOString().slice(0,10);
            return (
              <div key={d} title={`${d}: ${count} login${count!==1?"s":""}`}
                style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <div style={{ width:"100%", height:h, borderRadius:3, background: isToday?"#3b82f6":count>0?"#93c5fd":"#e5e7eb", transition:"height 0.2s" }} />
                {range <= 14 && <div style={{ fontSize:8, color:"#9ca3af", transform:"rotate(-45deg)", transformOrigin:"top center", marginTop:2 }}>{d.slice(5)}</div>}
              </div>
            );
          })}
        </div>
        {range > 14 && (
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:4, fontSize:10, color:"#9ca3af" }}>
            <span>{days[0]}</span><span>Today</span>
          </div>
        )}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        {/* Tab popularity */}
        <div style={sectionStyle}>
          <div style={hdr}>🗂 Page Views by Tab</div>
          {sortedTabs.length === 0 ? (
            <div style={{ color:"#9ca3af", fontSize:12 }}>No tab data yet</div>
          ) : sortedTabs.map(([tab, count]) => (
            <div key={tab} style={{ marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                <span style={{ fontWeight:600, color:"#374151" }}>{TAB_LABELS[tab] || tab}</span>
                <span style={{ color:"#6b7280" }}>{count} view{count!==1?"s":""}</span>
              </div>
              <div style={{ height:6, borderRadius:3, background:"#f1f5f9" }}>
                <div style={{ height:"100%", borderRadius:3, background:"#3b82f6", width:`${(count/maxTabViews)*100}%`, transition:"width 0.3s" }} />
              </div>
            </div>
          ))}
        </div>

        {/* Time on tab */}
        <div style={sectionStyle}>
          <div style={hdr}>⏱ Avg Time per Tab</div>
          {Object.keys(tabDurationCounts).length === 0 ? (
            <div style={{ color:"#9ca3af", fontSize:12 }}>No duration data yet</div>
          ) : Object.entries(tabDurations)
              .map(([tab, total]) => [tab, total / tabDurationCounts[tab]])
              .sort((a,b) => b[1]-a[1])
              .map(([tab, avg]) => (
            <div key={tab} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #f3f4f6", fontSize:12 }}>
              <span style={{ fontWeight:600, color:"#374151" }}>{TAB_LABELS[tab] || tab}</span>
              <span style={{ fontWeight:700, color:"#1e3a5f" }}>{fmtDur(avg)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-user table */}
      <div style={sectionStyle}>
        <div style={hdr}>👥 Activity by User</div>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:"2px solid #e5e7eb" }}>
                {["User", "Role", "Logins", "Page Views", "Most Visited Tab", "Avg Time / Tab", "Last Active"].map(h => (
                  <th key={h} style={{ padding:"6px 10px", textAlign:"left", fontWeight:700, color:"#6b7280", fontSize:11, whiteSpace:"nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {uniqueUsers.sort((a,b) => (loginsByUser[b]||0)-(loginsByUser[a]||0)).map(email => {
                const userEvents = filtered.filter(e => e.user_email === email);
                const userLogins = userEvents.filter(e => e.event_type === "login").length;
                const userTabViews = userEvents.filter(e => e.event_type === "tab_view");
                const userTabCounts = {};
                userTabViews.forEach(e => { const t=e.payload?.tab||"?"; userTabCounts[t]=(userTabCounts[t]||0)+1; });
                const topTab = Object.entries(userTabCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
                const userExits = userEvents.filter(e => e.event_type === "tab_exit");
                const validDurs = userExits.map(e=>Number(e.payload?.duration_seconds)||0).filter(d=>d>0&&d<7200);
                const avgDur = validDurs.length > 0 ? validDurs.reduce((a,b)=>a+b,0)/validDurs.length : 0;
                const role = userEvents.find(e=>e.payload?.role)?.payload?.role || "—";
                return (
                  <tr key={email} style={{ borderBottom:"1px solid #f3f4f6" }}>
                    <td style={{ padding:"8px 10px", fontWeight:600, color:"#111827" }}>{email}</td>
                    <td style={{ padding:"8px 10px" }}>
                      <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, fontWeight:700,
                        background:role==="admin"?"#fef3c7":role==="manager"?"#eff6ff":"#f3f4f6",
                        color:role==="admin"?"#92400e":role==="manager"?"#1d4ed8":"#6b7280" }}>{role}</span>
                    </td>
                    <td style={{ padding:"8px 10px", fontWeight:700, color:"#1e3a5f" }}>{userLogins}</td>
                    <td style={{ padding:"8px 10px", color:"#374151" }}>{userTabViews.length}</td>
                    <td style={{ padding:"8px 10px", color:"#374151" }}>{topTab ? (TAB_LABELS[topTab]||topTab) : "—"}</td>
                    <td style={{ padding:"8px 10px", color:"#374151" }}>{fmtDur(avgDur)}</td>
                    <td style={{ padding:"8px 10px", color:"#6b7280", whiteSpace:"nowrap" }}>{fmtDate(lastSeenByUser[email])}</td>
                  </tr>
                );
              })}
              {uniqueUsers.length === 0 && (
                <tr><td colSpan={7} style={{ padding:24, textAlign:"center", color:"#9ca3af" }}>No activity recorded in this period yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Raw event log */}
      <div style={sectionStyle}>
        <div style={{ ...hdr, justifyContent:"space-between" }}>
          <span>📋 Recent Events</span>
          <span style={{ fontSize:11, fontWeight:400, color:"#9ca3af" }}>{filtered.length} events in last {range} days</span>
        </div>
        <div style={{ maxHeight:240, overflowY:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <thead style={{ position:"sticky", top:0, background:"#fff" }}>
              <tr style={{ borderBottom:"1px solid #e5e7eb" }}>
                {["Time", "User", "Event", "Detail"].map(h => (
                  <th key={h} style={{ padding:"4px 8px", textAlign:"left", fontWeight:700, color:"#9ca3af", fontSize:10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0,200).map((e, i) => (
                <tr key={i} style={{ borderBottom:"1px solid #f9fafb" }}>
                  <td style={{ padding:"4px 8px", color:"#9ca3af", whiteSpace:"nowrap" }}>{fmtDate(e.created_at)}</td>
                  <td style={{ padding:"4px 8px", fontWeight:600, color:"#374151" }}>{e.user_email}</td>
                  <td style={{ padding:"4px 8px" }}>
                    <span style={{ fontSize:10, padding:"1px 6px", borderRadius:99, fontWeight:700,
                      background:e.event_type==="login"?"#fef9c3":e.event_type==="tab_view"?"#eff6ff":"#f0fdf4",
                      color:e.event_type==="login"?"#92400e":e.event_type==="tab_view"?"#1d4ed8":"#15803d" }}>
                      {e.event_type}
                    </span>
                  </td>
                  <td style={{ padding:"4px 8px", color:"#6b7280" }}>
                    {e.event_type==="login" && `role: ${e.payload?.role||"?"}`}
                    {e.event_type==="tab_view" && `→ ${TAB_LABELS[e.payload?.tab]||e.payload?.tab||"?"}`}
                    {e.event_type==="tab_exit" && `← ${TAB_LABELS[e.payload?.tab]||e.payload?.tab||"?"} · ${fmtDur(e.payload?.duration_seconds)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Setup instructions */}
      <div style={{ background:"#fffbeb", borderRadius:12, border:"1px solid #fde68a", padding:"14px 16px" }}>
        <div style={{ fontSize:12, fontWeight:700, color:"#92400e", marginBottom:6 }}>⚙️ Supabase Setup Required</div>
        <div style={{ fontSize:11, color:"#78350f", marginBottom:8 }}>Run this SQL in your Supabase SQL editor to create the usage_events table:</div>
        <pre style={{ fontSize:10, background:"#fff", padding:"10px 12px", borderRadius:8, border:"1px solid #fde68a", overflowX:"auto", color:"#374151", lineHeight:1.6 }}>{`create table if not exists usage_events (
  id bigserial primary key,
  user_id uuid,
  user_email text,
  event_type text,
  payload jsonb,
  created_at timestamptz default now()
);
-- Allow authenticated users to insert their own events
alter table usage_events enable row level security;
create policy "insert own events" on usage_events
  for insert with check (auth.uid() = user_id);
-- Allow all authenticated users to read (admin sees all)
create policy "read all events" on usage_events
  for select using (auth.role() = 'authenticated');`}</pre>
      </div>
    </div>
  );
}

// ─── Holiday Calendar Editor ──────────────────────────────────────────────────
function HolidayCalendarEditor({ holidays, updateHolidays, setHoliday, onClose }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(String(currentYear));
  const [items, setItems] = useState(() => {
    const y = String(currentYear);
    return holidays[y] ? holidays[y].map(h=>({...h})) : [];
  });
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState("");
  const [confirmApply, setConfirmApply] = useState(null);

  const switchYear = (y) => {
    setYear(y);
    setItems(holidays[y] ? holidays[y].map(h=>({...h})) : []);
  };

  const addHoliday = () => {
    if (!newName.trim() || !newDate) return;
    if (items.some(i => i.date === newDate)) return;
    setItems(prev => [...prev, { name: newName.trim(), date: newDate }]);
    setNewName(""); setNewDate("");
  };

  const removeItem = (date) => setItems(prev => prev.filter(i => i.date !== date));

  const save = () => {
    updateHolidays({ ...holidays, [year]: items });
    onClose();
  };

  const applyHoliday = (h) => {
    setHoliday(h.date, true);
    setConfirmApply(null);
  };

  const sorted = [...items].sort((a,b) => a.date.localeCompare(b.date));

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:3000}} onClick={onClose}>
      <div style={{background:"#fff",borderRadius:18,padding:28,width:520,maxHeight:"85vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,0.22)"}} onClick={e=>e.stopPropagation()}>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{fontSize:17,fontWeight:800,color:"#1e3a5f"}}>📅 Holiday Calendar</div>
          <button onClick={onClose} style={{background:"#f3f4f6",border:"none",borderRadius:8,padding:"5px 12px",cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:12,color:"#6b7280",marginBottom:16}}>
          Define holidays per year. Use <b>Apply to Schedule</b> to mark a day as a holiday and clear staff entries for that date.
        </div>

        {/* Year selector */}
        <div style={{display:"flex",gap:6,marginBottom:20,alignItems:"center"}}>
          <span style={{fontSize:12,fontWeight:700,color:"#374151"}}>Year:</span>
          {[currentYear-1, currentYear, currentYear+1].map(y => (
            <button key={y} onClick={()=>switchYear(String(y))} style={{
              padding:"4px 14px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
              background:year===String(y)?"#1e3a5f":"#f3f4f6",
              color:year===String(y)?"#fff":"#6b7280",border:"none"
            }}>{y}</button>
          ))}
        </div>

        {/* Add holiday */}
        <div style={{background:"#f8fafc",borderRadius:10,padding:"14px 16px",marginBottom:16,border:"1px solid #e5e7eb"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:10}}>Add Holiday</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <input value={newName} onChange={e=>setNewName(e.target.value)}
              placeholder="Holiday name (e.g. Thanksgiving)"
              onKeyDown={e=>e.key==="Enter"&&addHoliday()}
              style={{flex:1,border:"1px solid #e5e7eb",borderRadius:8,padding:"7px 10px",fontSize:13}} />
            <input type="date" value={newDate} onChange={e=>setNewDate(e.target.value)}
              style={{border:"1px solid #e5e7eb",borderRadius:8,padding:"7px 8px",fontSize:13}} />
            <button onClick={addHoliday} style={{
              padding:"7px 16px",borderRadius:8,background:"#1e3a5f",color:"#fff",
              border:"none",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"
            }}>+ Add</button>
          </div>
        </div>

        {/* Holiday list */}
        <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8}}>
            {year} Holidays ({items.length})
          </div>
          {sorted.length === 0 ? (
            <div style={{padding:20,textAlign:"center",color:"#9ca3af",fontSize:13,background:"#f9fafb",borderRadius:10,border:"1px solid #f3f4f6"}}>
              No holidays added for {year} yet
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {sorted.map(h => (
                <div key={h.date} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:10,background:"#f9fafb",border:"1px solid #f3f4f6"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:700,color:"#111827"}}>{h.name}</div>
                    <div style={{fontSize:11,color:"#6b7280",marginTop:1}}>
                      {new Date(h.date+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
                    </div>
                  </div>
                  {confirmApply?.date === h.date ? (
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#dc2626",fontWeight:600}}>Mark as holiday + clear entries?</span>
                      <button onClick={()=>applyHoliday(h)} style={{padding:"4px 12px",borderRadius:6,background:"#dc2626",color:"#fff",border:"none",fontSize:11,fontWeight:700,cursor:"pointer"}}>Yes, Apply</button>
                      <button onClick={()=>setConfirmApply(null)} style={{padding:"4px 10px",borderRadius:6,background:"#f3f4f6",border:"none",fontSize:11,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                    </div>
                  ) : (
                    <button onClick={()=>setConfirmApply(h)} style={{
                      padding:"4px 12px",borderRadius:7,background:"#eff6ff",
                      border:"1px solid #bfdbfe",color:"#1d4ed8",
                      fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"
                    }}>Apply to Schedule</button>
                  )}
                  <button onClick={()=>removeItem(h.date)} style={{
                    background:"#fee2e2",border:"none",borderRadius:6,
                    color:"#dc2626",fontWeight:700,cursor:"pointer",padding:"4px 9px",fontSize:11
                  }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{display:"flex",gap:10,justifyContent:"flex-end",borderTop:"1px solid #f3f4f6",paddingTop:14}}>
          <button onClick={onClose} style={{padding:"8px 20px",borderRadius:9,background:"#f3f4f6",border:"none",fontSize:13,fontWeight:600,cursor:"pointer"}}>Cancel</button>
          <button onClick={save} style={{padding:"8px 20px",borderRadius:9,background:"#1e3a5f",color:"#fff",border:"none",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
        </div>
      </div>
    </div>
  );
}
