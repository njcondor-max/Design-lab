# Design Lab: rules for any Claude session

The Lab is live for Jenna (and Nathan) at iloveyou.njc-labs.com (Render service `design-lab-mt03`).
A push to `main` deploys to her within minutes. Treat `main` as production.

## How to change things
1. Work on the `preview` branch. Pushing it deploys the free preview copy (test data only, sleeps when idle).
2. Test locally first: `npm install`, then run with `OWNER_PASSWORD=a JENNA_PASSWORD=b DEMO_PASSWORD=c npm start`.
   For AI features, point `ANTHROPIC_BASE_URL` at a local fake that streams SSE, so tests spend nothing.
   Check the browser console is clean and the changed flow works end to end, including after a reload.
3. Only after Nathan has tried it on the preview copy: merge `preview` into `main` and push.
4. Never push untested code to `main`. Never force-push `main`.

## Data safety (do not break)
- The database is Claire's Job Lab database (`job-lab-db`), shared. This app may only create and use the schema `design_lab`.
  Never read, write, alter or drop anything outside it. Never run migrations that touch other schemas.
- Data shapes only gain fields. Never rename or remove a field the page already saves; old records must keep working.
- Nothing is deleted outright: records get `trashedAt`. Uploaded files stay on the disk.
- Images live on the service's disk (`/var/data/assets`), not in the database.

## Money
- Hosting is capped at about $10/month (Starter + 1 GB disk today). Ask Nathan before anything that adds cost.
- AI spend is capped by `MONTHLY_CAP_USD` (20). Don't raise it without Nathan.

## Secrets
- API keys and passwords live only in Render's environment settings. Never commit them, print them, or ask for them in chat.

## Where things are
- `server.js`: logins (nathan = owner/admin, jenna, demo), storage API, uploads, Claude endpoint with spend tracking, /admin.
- `public/lab.html`: the whole Lab page (plans, focus mode, projects, brief, inspiration, kit, library).
- `public/runtime.js`: stands in for claude.ai page features (`claude.use("db" | "user" | "assets" | "sample" | "downloads")`).
- Workspaces: Nathan and Jenna share "main"; the demo login has its own "demo" workspace.

## Working with Nathan
- Plain language, no file paths or jargon in summaries. Short multiple-choice questions first when a decision is his.
- Pair every risk you raise with a fix.
