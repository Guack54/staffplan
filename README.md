# StaffPlan

A healthcare staffing management app for tracking schedules, FTE, census, PTO, and productivity metrics across Rehab, Peds, and Acute care teams.

## Features

- **Week / Month / Year / Day views** — full scheduling grid with today highlighting and sticky header
- **FTE tracking** — per-team and department-wide, with configurable weekday/weekend targets and color-coded alerts
- **Census tracking** — daily patient counts per team with pts/FTE ratios
- **Non-work codes** — VAC, SICK, PFL, and custom codes with auto work-hour adjustment
- **PTO balance tracking** — with over-limit alerts
- **Batch schedule entry** — apply schedules to multiple staff at once
- **Carry-forward scheduling** — apply default schedules up to 52 weeks out
- **Visits & Productivity tab** — weekly eval/visit entry by team, visits/FTE/day metric, annual forecast vs 1,300/person goal with per-team targets
- **Summary tab** — date-range census and leave overview
- **Staff management** — add, edit, archive/restore staff
- **Backup & Restore** — full data export/import via Excel (.xlsx)
- **Password protection** — SHA-256 hashed
- **Undo** — 20-step history (Ctrl+Z)

## Getting Started

### Option A — Run locally with React (recommended for development)

**Prerequisites:** Node.js 16+

```bash
# Install dependencies
npm install

# Start development server
npm start
```

The app will open at `http://localhost:3000`.

### Option B — Deploy to GitHub Pages

```bash
# Install gh-pages
npm install --save-dev gh-pages

# Add to package.json scripts:
# "predeploy": "npm run build",
# "deploy": "gh-pages -d build"
# Also add: "homepage": "https://YOUR-USERNAME.github.io/staffplan"

npm run deploy
```

### Option C — Static HTML (no build step)

Open `standalone/index.html` directly in Chrome. No server needed. Data saves to browser localStorage.

## Data & Backup

All data is stored in browser `localStorage`. To back up or move data between browsers/computers:

1. Open the **☰ Menu** → **💾 Backup All Data** — downloads a `StaffPlan_BACKUP_YYYY-MM-DD.xlsx`
2. To restore: **☰ Menu** → **📂 Restore from Backup** — upload the xlsx file

The backup includes all staff, schedules, census data, PTO balances, visit data, non-work codes, alert settings, and day notes.

## Visit Productivity Goals

| Team | Target Visits/FTE/Day | Annual/Person |
|------|----------------------|---------------|
| Acute | 6.5 | 1,476 |
| Peds | 6.5 | 1,476 |
| Rehab | 4.0 | 908 |
| **Dept (weighted avg)** | **5.73** | **1,300** |

Annual forecast uses **227 expected work days/year**.

## Default Password

The app ships with no password set. On first use you'll be prompted to set one via **☰ Menu → 🔐 Change Password**.

## Tech Stack

- [React 18](https://react.dev/) — UI framework
- [SheetJS (xlsx)](https://sheetjs.com/) — Excel export/import
- No other runtime dependencies — pure React with inline styles

## Project Structure

```
staffplan/
├── public/
│   └── index.html          # HTML shell (loads SheetJS from CDN)
├── src/
│   ├── index.js            # React entry point
│   └── App.jsx             # Entire application (single-file component)
├── standalone/
│   └── index.html          # Self-contained single-file version
├── package.json
└── README.md
```

## License

MIT
