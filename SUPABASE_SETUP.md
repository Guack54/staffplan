# StaffPlan — Supabase Setup Documentation

Everything you need to know about the Supabase configuration. Keep this file safe.

---

## Project Details

- **Project URL:** https://ouwertzfrcytkbvypmda.supabase.co
- **Anon Key:** eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91d2VydHpmcmN5dGtidnlwbWRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNzE1NzcsImV4cCI6MjA4ODg0NzU3N30.It7k5LvnUzHf5pQWngg6N_Hg1bN0oVX9ZnGkUOrhXMA
- **Region:** (check Supabase dashboard)
- **Auth:** Email/Password enabled, email confirmation disabled

---

## Tables

### `staff`
Stores all staff members (active and archived).

| Column | Type | Notes |
|--------|------|-------|
| id | text | Primary key (numeric string) |
| name | text | Display name |
| team | text | Home team (Rehab/Peds/Acute) |
| fte | float | e.g. 1.0, 0.8 |
| default_hours | int | Hours per day (usually 8) |
| shift_start | text | e.g. "08:00" |
| shift_end | text | e.g. "16:00" |
| default_schedule | jsonb | Array of {day, team, hours} |
| notes | text | Free text notes |
| archived | boolean | Soft delete |
| competencies | jsonb | Array of competency IDs |
| start_date | date | Employment start (nullable) |
| termination_date | date | Employment end (nullable) |
| updated_at | timestamptz | |

### `entries`
One row per staff member per date. Segments array holds the actual schedule.

| Column | Type | Notes |
|--------|------|-------|
| staff_id | text | References staff.id |
| date_str | text | Format: YYYY-MM-DD |
| segments | jsonb | Array of segment objects |
| updated_at | timestamptz | |

**Segment object shape:**
```json
{
  "hours": 8,
  "team": "Acute",
  "nonWork": "VAC",
  "nonWorkHours": 0,
  "comment": "covering for Jane",
  "swap": false,
  "extraComp": false,
  "location": "Main Campus"
}
```

### `daily_stats`
One row per date. Stores census, holiday flag, and other daily metadata.

| Column | Type | Notes |
|--------|------|-------|
| date_str | text | Primary key, format: YYYY-MM-DD |
| data | jsonb | {holiday: bool, census: {Rehab, Peds, Acute}} |
| updated_at | timestamptz | |

### `pto_balances`
Per-staff PTO tracking. Currently only SICK is actively used (56h fixed annual limit).

| Column | Type | Notes |
|--------|------|-------|
| staff_id | text | References staff.id |
| data | jsonb | {SICK: 56, VAC: 80} etc. |
| updated_at | timestamptz | |

### `day_notes`
Free text notes per date (shown in day view).

| Column | Type | Notes |
|--------|------|-------|
| date_str | text | Primary key |
| note | text | |
| updated_at | timestamptz | |

### `visit_data`
Weekly visit/eval counts per team.

| Column | Type | Notes |
|--------|------|-------|
| week_start | text | Sunday date YYYY-MM-DD |
| data | jsonb | Per-team visit and eval counts |
| updated_at | timestamptz | |

### `non_work_types`
Custom non-work codes (VAC, SICK, PFL etc.).

| Column | Type | Notes |
|--------|------|-------|
| code | text | Primary key, e.g. "VAC" |
| label | text | Display name, e.g. "Vacation" |
| color | text | Hex color, e.g. "#3b82f6" |
| sort_order | int | Display order |

### `alert_settings`
Key-value store for app-wide settings.

| Column | Type | Notes |
|--------|------|-------|
| key | text | Primary key |
| data | jsonb | Value (structure varies by key) |

**Known keys:**
- `fteTargets` — per-team FTE targets by day of week
- `censusTargets` — per-team census targets
- `competencies` — array of {id, name, color} objects
- `holidays` — {year: [{name, date}]} per calendar year

### `user_profiles`
One row per authenticated user. Controls access roles.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Matches auth.users.id |
| email | text | NOT NULL |
| display_name | text | NOT NULL |
| role | text | CHECK: admin/manager/viewer/staff |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### `audit_log`
Tracks significant events (logins, exports etc.).

### `usage_events`
Tracks tab views and session durations.

---

## Row Level Security (RLS) Policies

### `user_profiles` table
All policies are enabled. Run these if you need to recreate them:

```sql
-- Users can read/write their own row
create policy "authenticated full access own row"
on user_profiles for all
using (auth.uid() = id)
with check (auth.uid() = id);

-- All authenticated users can read all profiles (for presence/display)
create policy "authenticated can read all"
on user_profiles for select
using (auth.role() = 'authenticated');

-- Admins can update any profile (for role changes)
create policy "admin can update profiles"
on user_profiles for update
using (
  exists (
    select 1 from user_profiles up
    where up.id = auth.uid() and up.role = 'admin'
  )
)
with check (
  exists (
    select 1 from user_profiles up
    where up.id = auth.uid() and up.role = 'admin'
  )
);

-- Admins can delete profiles (for user removal)
create policy "admin can delete profiles"
on user_profiles for delete
using (
  exists (
    select 1 from user_profiles up
    where up.id = auth.uid() and up.role = 'admin'
  )
);
```

### Other tables
All other tables (staff, entries, daily_stats etc.) use open RLS policies allowing authenticated users full access. This is acceptable since the app handles its own role-based restrictions in the frontend.

---

## Role Definitions

| Role | Access |
|------|--------|
| **admin** | Full access — edit schedules, manage users, manage settings, view all tabs |
| **manager** | Edit schedules, census, visit data — no user management |
| **viewer** | Read-only — all tabs visible, no editing |
| **staff** | Day, Week, Master tabs only — non-work codes shown as "Out", no menu |

---

## Manual SQL You've Had to Run

Keep a record of any SQL run manually in the Supabase SQL editor:

```sql
-- Add new columns to staff table (run April 2026)
alter table staff
  add column if not exists competencies jsonb default '[]',
  add column if not exists start_date date,
  add column if not exists termination_date date;

-- Add 'staff' role to user_profiles CHECK constraint (run April 2026)
alter table user_profiles
  drop constraint user_profiles_role_check;
alter table user_profiles
  add constraint user_profiles_role_check
  check (role in ('admin', 'manager', 'viewer', 'staff'));

-- Clean up entries for holiday dates (run as needed)
-- DELETE FROM entries WHERE date_str IN ('2026-01-01', '2026-05-25', ...);
```

---

## Auth Configuration

- **Email confirmation:** Disabled (users can log in immediately after creation)
- **Password recovery:** Uses Supabase default email
- **Session:** JWT, managed by Supabase client library

**Important:** Deleting a user from the app only removes their `user_profiles` row (blocking login). To fully remove them and free up their email for re-registration, go to:
**Supabase Dashboard → Authentication → Users → find user → Delete**

---

## Realtime Configuration

Two realtime channels are used:

1. **`staffplan-realtime`** — listens to postgres_changes on staff, entries, daily_stats, visit_data tables. Used to sync changes between logged-in users.

2. **`staffplan-presence`** — presence channel. Tracks who is online and which tab they're viewing. Presence data: `{userId, name, initials, role, tab, color}`.

---

## Backups

The app has a built-in backup/restore feature (Menu → 💾 Backup & Restore) that exports all data to an Excel file. **Run a backup before any significant changes.**

Backup includes: staff, entries, daily_stats, PTO balances, non-work types, alert settings, day notes, visit data, locations.
