# StaffPlan — Claude Handoff Prompt

Copy and paste this entire message at the start of a new Claude session when you need to make changes to StaffPlan.

---

## PASTE THIS INTO A NEW CLAUDE SESSION:

---

I need help maintaining and modifying a web app called StaffPlan — a healthcare department staffing and scheduling tool I built with Claude over many sessions. Here's everything you need to know:

## What it is
A React single-page app for managing ~40 OT department staff (Rehab, Peds, Acute teams) across Day, Week, Month, Year, Master Schedule, Timesheets, and Dept Stats views. It uses Supabase for the database and auth, and is deployed on Netlify via GitHub.

## Tech stack
- **Frontend:** React, single file at `src/App.jsx` (~6500 lines)
- **Database:** Supabase (PostgreSQL + Auth + Realtime)
- **Deployment:** GitHub → Netlify (react-scripts build)
- **Supabase URL:** https://ouwertzfrcytkbvypmda.supabase.co
- **Anon key:** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91d2VydHpmcmN5dGtidnlwbWRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzE1NzcsImV4cCI6MjA4ODg0NzU3N30.It7k5LvnUzHf5pQWngg6N_Hg1bN0oVX9ZnGkUOrhXMA

## How to make changes
1. I upload the current `App.jsx` file to you
2. You make changes and output a new `App.jsx`
3. I replace `src/App.jsx` in my GitHub repo
4. Netlify auto-deploys in ~60 seconds

## Supabase tables
- `staff` — id, name, team, fte, default_hours, shift_start, shift_end, default_schedule(jsonb), notes, archived, competencies(jsonb), start_date, termination_date
- `entries` — staff_id, date_str, segments(jsonb array of {hours, team, nonWork, nonWorkHours, comment, swap, extraComp, location})
- `daily_stats` — date_str, data(jsonb: {holiday, census:{Rehab,Peds,Acute}})
- `pto_balances` — staff_id, data(jsonb)
- `day_notes` — date_str, note
- `visit_data` — week_start, data(jsonb)
- `non_work_types` — code, label, color, sort_order
- `alert_settings` — key, data(jsonb) [keys: fteTargets, censusTargets, competencies, holidays]
- `user_profiles` — id(uuid), email, display_name, role(admin/manager/viewer/staff)

## User roles
- **admin** — full access, manage users and settings
- **manager** — edit schedules, census, visits
- **viewer** — read-only, all tabs
- **staff** — Day/Week/Master only, NW codes shown as "Out"

## Key components (approximate line numbers may shift)
- `StaffingApp` — main component, all state lives here
- `DayView` — day timeline + roster panels, mobile-responsive
- `WeekGrid` — weekly schedule grid with filters
- `MasterScheduleView` — recurring schedule grid
- `TimesheetTab` — hours report with EC tracking
- `CellEditor` — modal for editing a single staff/day entry
- `HolidayCalendarEditor` — manage holidays per year
- `CompetencyFilterDropdown` — week view filter
- `PersonFilterDropdown` — week view filter
- `PresenceAvatar` — online user indicators in header
- `UserManager` — admin user management modal
- `StaffTab` — staff management

## Important patterns to know
- `triggerSave()` uses a 1200ms debounce and reads from always-current refs (staffRef, entriesRef, etc.) — don't break this pattern
- `isSavingRef` blocks realtime reloads during saves — critical for preventing save races
- `setHoliday()` does an atomic save of both stats and entries, plus calls `sbDeleteEntriesForDate()` — don't separate these
- `filteredStaff` applies team + competency + person filters — used by WeekGrid but NOT by DayView
- All saves go through `triggerSave()` → `sbSaveEntries()` which uses upsert — deletions must be explicit

## Known issues / things to be careful about
- Deleting a user removes `user_profiles` row only — `auth.users` record stays, email can't be reused without Supabase dashboard cleanup
- Holiday entries from before April 2026 may need manual SQL cleanup: `DELETE FROM entries WHERE date_str IN (...)`
- The `user_profiles` CHECK constraint allows: admin, manager, viewer, staff — adding new roles requires an ALTER TABLE in Supabase SQL editor
- `sbSaveEntries` only upserts — if you need to delete entries, call `sb.from("entries").delete()` explicitly

## Documentation files in the repo
- `CHANGELOG.md` — full history of every feature built
- `SUPABASE_SETUP.md` — database schema, RLS policies, and manual SQL history

## My request for this session
[DESCRIBE WHAT YOU WANT TO CHANGE HERE]

Please start by asking me to upload the current App.jsx file before making any changes.

---

## TIPS FOR THE SESSION:
- Always upload your current `App.jsx` before asking for changes — Claude needs to see the actual current file
- Run a backup first (Menu → 💾 Backup & Restore) before deploying any significant change
- If Claude asks to run SQL in Supabase, go to: supabase.com → your project → SQL Editor
- If something breaks after deploy, you can revert in GitHub (go to the file → History → find last working version → restore)
- The app takes ~60 seconds to deploy after pushing to GitHub
