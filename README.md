# Design Lab

Jenna's Design Lab at **designlab.njc-labs.com**: step-by-step plans, project inspiration, kits and the Library.

## How it runs
- `server.js` serves the Lab page (`public/lab.html`) behind three logins, plus `public/runtime.js`, which stands in for the claude.ai page features the Lab uses:
  - **Storage**: Postgres, schema `design_lab` only (safe to share a database with another app). Without `DATABASE_URL` it uses a local JSON file.
  - **Images**: written to `DATA_DIR/assets` (a Render disk), served only to signed-in people in the same workspace.
  - **Claude**: `/api/sample` calls the Anthropic API with `ANTHROPIC_API_KEY`, with a monthly spend cap.
- Nathan and Jenna share the "main" workspace. The demo login has its own, separate workspace.
- `/admin` (Nathan only): AI spend this month, image storage, record counts, JSON export, demo reset.

## Environment
| Variable | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection (internal URL). The app only creates and uses the `design_lab` schema. |
| `ANTHROPIC_API_KEY` | Pays for AI features. AI is off when unset. |
| `OWNER_PASSWORD`, `JENNA_PASSWORD`, `DEMO_PASSWORD` | One per login. A login with no password is disabled. |
| `SESSION_SECRET` | Signs login cookies. Render generates it. |
| `MONTHLY_CAP_USD` | AI spend cap per calendar month (default 20). |
| `DEMO_DAILY_AI` | AI calls per day for the demo login (default 25). |
| `IMAGE_QUOTA_MB` | Image storage limit (default 900, for a 1 GB disk). |
| `DATA_DIR` | Where images live (`/var/data` on Render). |

## Run locally
```
npm install
OWNER_PASSWORD=a JENNA_PASSWORD=b DEMO_PASSWORD=c npm start
```
