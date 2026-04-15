# StaffPlan — Changelog & Feature History

A complete record of everything built, in order. Use this to understand what exists and why.

---

## Stack
- **Frontend:** React (single file `src/App.jsx`), deployed via GitHub → Netlify
- **Backend:** Supabase (PostgreSQL + Auth + Realtime)
- **Build:** react-scripts (Create React App)
- **Fonts:** DM Sans (Google Fonts)
- **Excel export:** SheetJS (XLSX)

---

## Sessions 1–9 (March 2026) — Initial Build & Local Prototype

### Core App
- Weekly grid view with inline cell editing
- Staff list with team assignments (Rehab, Peds, Acute)
- Non-work codes (VAC, SICK, PFL etc.) with custom colors
- FTE calculation (hours / 8 per day)
- Day view with horizontal timeline (6am–10pm)
- Month view calendar
- Year-at-a-glance view

### Features Added
- Bulk CSV upload for year-wide schedule entry
- Excel export (week view + year summary + roster)
- Custom per-person schedules (defaultSchedule)
- Multi-segment days (split shifts, cross-team coverage)
- Undo/redo (20-step history, Ctrl+Z)
- NaN display bug fixes
- Today highlighting in week/month/year views
- Comments and swap markers on cells
- Holiday marking (marks day, clears entries)
- Batch schedule entry modal
- Day notes (free text per day)
- PTO balance tracking per staff member
- Census tracking per team per day
- FTE alerts when below targets
- Compact grid mode
- Per-day-of-week FTE targets
- Current time red line on day timeline

---

## Sessions 10–20 (March 2026) — Views & Polish

### Features Added
- Archive/restore staff (keeps historical data)
- Summary tab with date range selector (visits + FTE metrics)
- Visits tab with productivity metrics (visits/FTE, per-team goals)
- Weekly grid sticky header
- Staff notes field
- Backup/restore via Excel file
- Menu reorganization
- Auto-calculated FTE from weekly hours
- NW hours auto-calculation when setting non-work codes

---

## Sessions 21–30 (March 2026) — Timesheets & Supabase Migration

### Features Added
- **Timesheets tab** — date range (week/month/year/custom), per-team breakdown, NW codes, sortable
- Visit week navigation arrows
- Batch accept/reject schedule entries

### Supabase Migration
- Full migration from localStorage to Supabase PostgreSQL
- Tables created: `staff`, `entries`, `daily_stats`, `pto_balances`, `day_notes`, `visit_data`, `non_work_types`, `alert_settings`, `user_profiles`, `audit_log`, `usage_events`
- Auth login screen with email/password
- Realtime sync (multiple users see changes live)
- Role-based access: admin, manager, viewer
- User management modal (create/delete users)

---

## Sessions 31–40 (March 2026) — Deployment & RLS Fixes

### Deployment
- Deployed to Netlify via GitHub auto-deploy
- `netlify.toml` configured with react-scripts build

### Bug Fixes
- RLS policy fixes for `user_profiles` table
- Row limit pagination for large datasets (1000 row pages)
- Staff ID type mismatch (string vs integer) resolved
- Save race condition: `isSavingRef` blocks realtime reloads during saves
- triggerSave uses always-current refs to prevent stale closure saves

---

## Sessions 41–50 (March 2026) — Locations & Master Schedule

### Features Added
- **Locations** — define per-team location options, show in week grid cells and day timeline
- **Master Schedule tab** — shows recurring schedule pattern for all staff in a grid
- Staff manager schedule display fixed (shows defaultSchedule not actual entries)
- Backup/restore includes locations data

---

## Sessions 51–70 (March/April 2026) — Major Feature Expansion

### Competencies
- Admin can define competency/specialty areas with colors (Menu → 🎯 Competencies)
- Staff cards show toggleable competency pills
- Week view has competency filter dropdown (AND logic)
- Competencies stored in Supabase `alert_settings` table (key="competencies")

### Holiday Calendar
- Menu → 📅 Holiday Calendar (admin only)
- Per-year management (previous/current/next year)
- Add holidays by name + date
- "Apply to Schedule" with confirmation — marks day as holiday AND deletes entries from Supabase
- Holidays stored in Supabase `alert_settings` (key="holidays")
- **Critical fix:** `sbDeleteEntriesForDate()` explicitly DELETEs from entries table — upsert alone doesn't remove rows

### Staff Role (4th role)
- `role='staff'` added to `user_profiles` CHECK constraint
- Sees: Day, Week, Master tabs only
- Non-work codes shown as "Out" (full day) or "Out Xh" (partial)
- Comments/swap indicators hidden
- Metrics strip hidden
- No menu button

### Presence Indicators
- Supabase realtime presence channel "staffplan-presence"
- Colored circle avatars with initials in header
- Hover shows name, role, and current tab
- Updates when tab changes

### Person Filter
- Week view toolbar: "👤 People ▼" dropdown
- Multiselect with search, uses full unfiltered staff list (not filteredStaff)
- Works alongside team and competency filters

### Extra Comp Tracking
- "⭐ Extra Comp?" toggle on each cell editor segment
- ⭐ badge appears on week grid cells with EC hours
- Timesheet: EC summary card, EC column (hours + fractional shifts), "⭐ All Staff" filter toggle
- 4h EC shift = 0.5 shifts

### Hour Mismatch Check
- Compares weekly TOTAL hours only (not per-day)
- Prevents false positives for staff who shift work days

### Other Features
- Last Month added to timesheet range selector
- Total census in Day view white box (sum of all 3 teams)
- NW cells have diagonal hash texture pattern
- Default compact mode in week view
- Comment bubble shows even on days with no hours/NW code
- Comment-only segments now save correctly (filter fixed)
- "Out Xh" label for mixed days (part work + part NW) for staff role

### Bug Fixes
- Holiday save race condition: single atomic save for stats + entries
- Deleted staff permanently removed from Supabase (plus entries + PTO)
- Competencies moved from localStorage to Supabase (viewers now see them)
- `React.useRef` → `useRef` (white screen fix)
- User creation: waits for DB trigger then updates all NOT NULL fields
- User deletion: deletes from `user_profiles` (blocks login); note auth.users requires Supabase dashboard
- `user_profiles` CHECK constraint updated to include 'staff' role
- `admin can update profiles` RLS policy recreated with `with_check` clause

### Mobile & PWA
- `useWindowWidth()` hook for responsive layout
- Day view: stacked layout on mobile (<640px), simplified timeline list, larger tap targets, no maxHeight clipping on roster panels
- `public/index.html`: viewport meta tag added
- `public/manifest.json`: PWA manifest (name, colors, icons)
- `public/service-worker.js`: network-first caching, enables "Install app" on Android

---

## Known Limitations

1. **User deletion** — deleting a user removes them from `user_profiles` (blocking login) but their `auth.users` record remains. Re-registering that email will fail. To fully delete, go to Supabase dashboard → Authentication → Users and delete manually.

2. **Staff role own-schedule view** — staff users see everyone's schedule but not their own non-work codes. Linking auth accounts to staff records was deferred as complex.

3. **Single file** — entire app is in `src/App.jsx` (~6500 lines). Works fine but makes navigation harder as it grows.

4. **Holiday entries** — holidays marked before the `sbDeleteEntriesForDate` fix (April 2026) may still have entries in Supabase. Run `DELETE FROM entries WHERE date_str IN ('your-holiday-dates')` to clean up.
