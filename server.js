/*
 * Design Lab server (designlab.njc-labs.com)
 *
 *   /                 the Lab (login required)
 *   /login, /logout   three logins: owner (Nathan), Jenna, demo
 *   /admin            owner only: AI spend, storage, export, demo reset
 *   /api/db/*         shared storage for the page (Postgres schema "design_lab", or a JSON file locally)
 *   /api/assets       image uploads (stored on the service's disk)
 *   /_blob/:id        serves an uploaded image
 *   /api/sample       Claude, using ANTHROPIC_API_KEY, with a monthly spend cap
 *
 * Owner and Jenna share one workspace ("main"). The demo login has its own ("demo"),
 * so demos never show client work.
 */
"use strict";
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const DATABASE_URL = process.env.DATABASE_URL || "";
const SCHEMA = "design_lab"; // fixed: this app never touches any other schema in a shared database
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_BASE_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MONTHLY_CAP_USD = Number(process.env.MONTHLY_CAP_USD || 20);
const DEMO_DAILY_AI = Number(process.env.DEMO_DAILY_AI || 25);
const IMAGE_QUOTA_MB = Number(process.env.IMAGE_QUOTA_MB || 900);
const LAB_LABEL = process.env.LAB_LABEL || ""; // e.g. "Preview" on the test copy
/* Nightly feedback email (Google Workspace SMTP with an app password) */
const SMTP_USER = process.env.SMTP_USER || "";            // the sending mailbox, e.g. nathan@desmithstudio.com
const SMTP_PASS = process.env.SMTP_PASS || "";            // a Google app password for that mailbox
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://iloveyou.njc-labs.com").replace(/\/$/, "");
const FEEDBACK_TO = process.env.FEEDBACK_TO || "nathan@desmithstudio.com";
const FEEDBACK_REPLY_TO = process.env.FEEDBACK_REPLY_TO || "Jay@desmithstudio.com";
const FEEDBACK_HOUR = Number(process.env.FEEDBACK_HOUR || 21); // local hour to send
const FEEDBACK_TZ = process.env.FEEDBACK_TZ || "America/Los_Angeles";
const MODELS = {
  quick: process.env.MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.MODEL_COMPLEX || "claude-opus-5-5",
};
const MAX_TOKENS = { quick: 4096, default: 8192, complex: 16000 };
/* USD per million tokens [input, output]. Update if Anthropic changes prices. */
const PRICES = {
  "claude-haiku-5-5": [0.10, 0.50],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
const USERS = {
  nathan: { name: "Nathan", role: "owner", space: "main", pw: process.env.OWNER_PASSWORD },
  jenna: { name: "Jenna", role: "member", space: "main", pw: process.env.JENNA_PASSWORD },
  demo: { name: "Demo", role: "demo", space: "demo", pw: process.env.DEMO_PASSWORD },
};
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "text/plain", "text/markdown",
  "application/octet-stream"]; // any other file (feedback attachments): stored as-is, only ever served as a download

const secret = SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!SESSION_SECRET) console.warn("SESSION_SECRET is not set: logins reset whenever the server restarts.");
fs.mkdirSync(path.join(DATA_DIR, "assets"), { recursive: true });

/* ================= storage ================= */
let store;
if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3, ssl: /render\.com|sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  const q = (sql, args) => pool.query(sql, args);
  store = {
    kind: "postgres",
    async init() {
      await q(`create schema if not exists ${SCHEMA}`);
      await q(`create table if not exists ${SCHEMA}.docs (space text not null, path text not null, coll text not null, data jsonb not null, version integer not null default 1, updated_at timestamptz not null default now(), primary key (space, path))`);
      await q(`create index if not exists docs_coll_idx on ${SCHEMA}.docs (space, coll)`);
      await q(`create table if not exists ${SCHEMA}.assets (id text primary key, space text not null, content_type text not null, size integer not null, by text, created_at timestamptz not null default now())`);
      await q(`create table if not exists ${SCHEMA}.usage (month text primary key, usd numeric not null default 0, calls integer not null default 0)`);
      await q(`create table if not exists ${SCHEMA}.demo_usage (day text primary key, calls integer not null default 0)`);
    },
    async get(space, p) { const r = await q(`select data, version from ${SCHEMA}.docs where space=$1 and path=$2`, [space, p]); return r.rows[0] || null; },
    async list(space, coll) { const r = await q(`select path, data, version, extract(epoch from updated_at)*1000 as t from ${SCHEMA}.docs where space=$1 and coll=$2`, [space, coll]); return r.rows.map((x) => ({ path: x.path, data: x.data, version: x.version, t: Number(x.t) })); },
    async put(space, p, coll, data) {
      const r = await q(`insert into ${SCHEMA}.docs (space, path, coll, data) values ($1,$2,$3,$4) on conflict (space, path) do update set data=excluded.data, version=${SCHEMA}.docs.version+1, updated_at=now() returning version`, [space, p, coll, data]);
      return r.rows[0].version;
    },
    async del(space, p) { await q(`delete from ${SCHEMA}.docs where space=$1 and path=$2`, [space, p]); },
    async addAsset(a) { await q(`insert into ${SCHEMA}.assets (id, space, content_type, size, by) values ($1,$2,$3,$4,$5)`, [a.id, a.space, a.type, a.size, a.by]); },
    async getAsset(id) { const r = await q(`select id, space, content_type as type, size from ${SCHEMA}.assets where id=$1`, [id]); return r.rows[0] || null; },
    async assetBytes() { const r = await q(`select coalesce(sum(size),0) as b, count(*) as n from ${SCHEMA}.assets`); return { bytes: Number(r.rows[0].b), files: Number(r.rows[0].n) }; },
    async addUsage(month, usd) { await q(`insert into ${SCHEMA}.usage (month, usd, calls) values ($1,$2,1) on conflict (month) do update set usd=${SCHEMA}.usage.usd+excluded.usd, calls=${SCHEMA}.usage.calls+1`, [month, usd]); },
    async getUsage(month) { const r = await q(`select usd, calls from ${SCHEMA}.usage where month=$1`, [month]); return r.rows[0] ? { usd: Number(r.rows[0].usd), calls: r.rows[0].calls } : { usd: 0, calls: 0 }; },
    async demoHit(day) { const r = await q(`insert into ${SCHEMA}.demo_usage (day, calls) values ($1,1) on conflict (day) do update set calls=${SCHEMA}.demo_usage.calls+1 returning calls`, [day]); return r.rows[0].calls; },
    async counts() { const r = await q(`select space, coll, count(*) as n from ${SCHEMA}.docs group by space, coll order by space, coll`); return r.rows.map((x) => ({ space: x.space, coll: x.coll, n: Number(x.n) })); },
    async dump(space) { const r = await q(`select path, data from ${SCHEMA}.docs where space=$1 order by path`, [space]); return r.rows; },
    async wipe(space) { await q(`delete from ${SCHEMA}.docs where space=$1`, [space]); },
  };
} else {
  /* Local development: one JSON file. */
  const file = path.join(DATA_DIR, "store.json");
  let mem = { docs: {}, assets: {}, usage: {}, demo: {} };
  try { mem = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  let timer = null;
  const persist = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(mem)), 200); };
  const key = (s, p) => s + "|" + p;
  store = {
    kind: "file",
    async init() {},
    async get(s, p) { const d = mem.docs[key(s, p)]; return d ? { data: d.data, version: d.version } : null; },
    async list(s, coll) { return Object.values(mem.docs).filter((d) => d.space === s && d.coll === coll).map((d) => ({ path: d.path, data: d.data, version: d.version, t: d.t })); },
    async put(s, p, coll, data) { const k = key(s, p), prev = mem.docs[k]; const version = prev ? prev.version + 1 : 1; mem.docs[k] = { space: s, path: p, coll, data, version, t: Date.now() }; persist(); return version; },
    async del(s, p) { delete mem.docs[key(s, p)]; persist(); },
    async addAsset(a) { mem.assets[a.id] = a; persist(); },
    async getAsset(id) { return mem.assets[id] || null; },
    async assetBytes() { const v = Object.values(mem.assets); return { bytes: v.reduce((a, x) => a + x.size, 0), files: v.length }; },
    async addUsage(m, usd) { const u = mem.usage[m] || { usd: 0, calls: 0 }; u.usd += usd; u.calls++; mem.usage[m] = u; persist(); },
    async getUsage(m) { return mem.usage[m] || { usd: 0, calls: 0 }; },
    async demoHit(day) { mem.demo[day] = (mem.demo[day] || 0) + 1; persist(); return mem.demo[day]; },
    async counts() { const c = {}; Object.values(mem.docs).forEach((d) => { const k = d.space + "|" + d.coll; c[k] = (c[k] || 0) + 1; }); return Object.entries(c).map(([k, n]) => ({ space: k.split("|")[0], coll: k.split("|")[1], n })); },
    async dump(s) { return Object.values(mem.docs).filter((d) => d.space === s).map((d) => ({ path: d.path, data: d.data })); },
    async wipe(s) { for (const k of Object.keys(mem.docs)) if (mem.docs[k].space === s) delete mem.docs[k]; persist(); },
  };
}

/* ================= sessions ================= */
function sign(v) { return crypto.createHmac("sha256", secret).update(v).digest("base64url"); }
function makeToken(user) { const exp = Date.now() + 30 * 864e5; const v = `${user}.${exp}`; return `${v}.${sign(v)}`; }
function readToken(t) {
  if (!t) return null;
  const parts = t.split("."); if (parts.length !== 3) return null;
  const v = parts[0] + "." + parts[1];
  const good = sign(v);
  if (good.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(parts[2]))) return null;
  if (Number(parts[1]) < Date.now() || !USERS[parts[0]]) return null;
  return parts[0];
}
function cookies(req) { const out = {}; (req.headers.cookie || "").split(";").forEach((c) => { const i = c.indexOf("="); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return out; }
function who(req) { const id = readToken(cookies(req).dl_session); return id ? { id, ...USERS[id] } : null; }
function needUser(req, res, next) { const u = who(req); if (!u) return res.status(401).json({ code: "signed_out", message: "Sign in again." }); req.user = u; next(); }
function needOwner(req, res, next) { const u = who(req); if (!u || u.role !== "owner") return res.redirect("/login"); req.user = u; next(); }
function pwOk(given, real) {
  if (!real || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ================= app ================= */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => { res.set("X-Content-Type-Options", "nosniff"); res.set("Referrer-Policy", "same-origin"); res.set("X-Frame-Options", "DENY"); next(); });

app.get("/healthz", (req, res) => res.json({ ok: true, ai: !!ANTHROPIC_API_KEY, storage: store.kind }));

/* ---------- login ---------- */
const fails = new Map();
function locked(ip) { const now = Date.now(); const l = (fails.get(ip) || []).filter((t) => now - t < 15 * 60e3); fails.set(ip, l); return l.length >= 10; }
app.get("/login", (req, res) => res.type("html").send(loginPage("")));
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  if (locked(ip)) return res.status(429).type("html").send(loginPage("Too many tries. Wait 15 minutes."));
  const name = String((req.body && req.body.name) || "").toLowerCase().trim();
  const u = USERS[name];
  if (!u || !pwOk(req.body.password, u.pw)) { fails.get(ip).push(Date.now()); return res.status(401).type("html").send(loginPage("That name and password don't match.")); }
  res.set("Set-Cookie", `dl_session=${makeToken(name)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? "; Secure" : ""}`);
  res.redirect("/");
});
app.get("/logout", (req, res) => { res.set("Set-Cookie", "dl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"); res.redirect("/login"); });
app.get("/api/me", needUser, (req, res) => res.json({ id: req.user.id, name: req.user.name, role: req.user.role, space: req.user.space }));

/* ---------- the Lab page ---------- */
const LAB = fs.readFileSync(path.join(__dirname, "public", "lab.html"), "utf8");
function labHtml(u) {
  const bar = `<div id="dl-userbar" style="position:fixed;left:12px;bottom:12px;z-index:30;font:13px system-ui,sans-serif;background:${LAB_LABEL ? "#B4500F" : "rgba(22,24,29,.88)"};color:#fff;border-radius:999px;padding:6px 12px;display:flex;gap:10px;align-items:center">${LAB_LABEL ? `<b>${esc(LAB_LABEL)} copy: test data only</b> · ` : ""}${u.name}${u.role === "demo" ? " (demo)" : ""}${u.role === "owner" ? ' · <a href="/admin" style="color:#9fb0ff">Admin</a>' : ""} · <a href="/logout" style="color:#9fb0ff">Sign out</a></div>`;
  return LAB.replace("<head>", `<head>\n<script src="/runtime.js?v=${BUILD}" data-app="design-lab"></script>`).replace("</body>", bar + "</body>");
}
const BUILD = crypto.createHash("sha1").update(LAB + fs.readFileSync(path.join(__dirname, "public", "runtime.js"))).digest("hex").slice(0, 8);
app.get("/", (req, res) => { const u = who(req); if (!u) return res.redirect("/login"); res.set("Cache-Control", "no-store"); res.type("html").send(labHtml(u)); });
app.get("/runtime.js", (req, res) => { res.set("Cache-Control", "public, max-age=300"); res.sendFile(path.join(__dirname, "public", "runtime.js")); });

/* ---------- shared storage ---------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkPath(p, wantDoc) {
  if (typeof p !== "string" || p.length > 1000) return false;
  const segs = p.split("/");
  if (segs.length > 16 || segs.some((s) => !SEG.test(s) || s === "." || s === "..")) return false;
  return wantDoc ? segs.length % 2 === 0 : segs.length % 2 === 1;
}
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
app.get("/api/db/doc", needUser, async (req, res) => {
  const p = req.query.path; if (!checkPath(p, true)) return res.status(400).json({ code: "invalid_argument", message: "bad document path" });
  try { const d = await store.get(req.user.space, p); res.json(d ? { exists: true, data: d.data, version: d.version } : { exists: false }); }
  catch (e) { console.error("[db] get", e.message); res.status(503).json({ code: "unavailable", message: "storage unavailable" }); }
});
app.get("/api/db/coll", needUser, async (req, res) => {
  const p = req.query.path; if (!checkPath(p, false)) return res.status(400).json({ code: "invalid_argument", message: "bad collection path" });
  try {
    const rows = await store.list(req.user.space, p);
    const tag = '"' + crypto.createHash("sha1").update(rows.map((r) => r.path + ":" + r.version).sort().join("|")).digest("hex").slice(0, 16) + '"';
    res.set("ETag", tag); res.set("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === tag) return res.status(304).end();
    res.json({ docs: rows.map((r) => ({ id: r.path.split("/").pop(), data: r.data, version: r.version })) });
  } catch (e) { console.error("[db] list", e.message); res.status(503).json({ code: "unavailable", message: "storage unavailable" }); }
});
app.put("/api/db/doc", needUser, express.json({ limit: "300kb" }), async (req, res) => {
  const b = req.body || {}; const p = b.path;
  if (!checkPath(p, true) || !b.data || typeof b.data !== "object" || Array.isArray(b.data)) return res.status(400).json({ code: "invalid_argument", message: "bad write" });
  if (JSON.stringify(b.data).length > 256 * 1024) return res.status(400).json({ code: "invalid_argument", message: "document over 256 KiB" });
  try {
    let data = b.data;
    if (b.mode === "update") {
      const prev = await store.get(req.user.space, p);
      if (!prev) return res.status(400).json({ code: "invalid_argument", message: "document does not exist" });
      data = merge(prev.data, b.data);
    }
    data = stripDeletes(data);
    const version = await store.put(req.user.space, p, parentOf(p), data);
    res.json({ ok: true, version });
  } catch (e) { console.error("[db] put", e.message); res.status(503).json({ code: "unavailable", message: "storage unavailable" }); }
});
app.delete("/api/db/doc", needUser, async (req, res) => {
  const p = req.query.path; if (!checkPath(p, true)) return res.status(400).json({ code: "invalid_argument", message: "bad document path" });
  try { await store.del(req.user.space, p); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ code: "unavailable", message: "storage unavailable" }); }
});
function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function merge(a, b) { const out = { ...a }; for (const k of Object.keys(b)) out[k] = isObj(b[k]) && isObj(a[k]) && !b[k].__delete__ ? merge(a[k], b[k]) : b[k]; return out; }
function stripDeletes(o) { if (!isObj(o)) return o; const out = {}; for (const k of Object.keys(o)) { const v = o[k]; if (isObj(v) && v.__delete__ === true) continue; out[k] = isObj(v) ? stripDeletes(v) : v; } return out; }

/* ---------- images ---------- */
app.post("/api/assets", needUser, express.raw({ type: () => true, limit: "20mb" }), async (req, res) => {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(type)) return res.status(415).json({ code: "unsupported_type", message: "Images, PDFs, Word documents and text files only." });
  const buf = req.body; if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ code: "invalid_request", message: "empty file" });
  try {
    const used = await store.assetBytes();
    if (used.bytes + buf.length > IMAGE_QUOTA_MB * 1048576) return res.status(507).json({ code: "quota_or_state", message: "Image storage is full. Nathan can raise the limit." });
    const id = crypto.randomBytes(16).toString("hex");
    const dir = path.join(DATA_DIR, "assets", req.user.space); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), buf);
    await store.addAsset({ id, space: req.user.space, type, size: buf.length, by: req.user.id });
    res.json({ id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
  } catch (e) { console.error("[assets]", e.message); res.status(503).json({ code: "store_unavailable", message: "Couldn't store the file." }); }
});
app.get("/_blob/:id", async (req, res) => {
  const u = who(req); if (!u) return res.status(401).end();
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
  try {
    const a = await store.getAsset(req.params.id);
    if (!a || a.space !== u.space) return res.status(404).end();
    const f = path.join(DATA_DIR, "assets", a.space, a.id);
    if (!fs.existsSync(f)) return res.status(404).end();
    res.set("Content-Type", a.type); res.set("Cache-Control", "private, max-age=31536000, immutable");
    if (a.type === "application/pdf" || a.type.startsWith("image/")) res.set("Content-Disposition", "inline");
    else { const nm = String(req.query.name || "").replace(/[^\w .()\-]/g, "_").slice(0, 120); res.set("Content-Disposition", nm ? `attachment; filename="${nm}"` : "attachment"); }
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.status(503).end(); }
});

/* ---------- Claude ---------- */
const FRAMING = "You are answering a request sent by a web app on behalf of the person using it. Follow the instructions in the user's message. You cannot browse and you remember nothing between requests.";
const JSON_FRAMING = " Your reply will be parsed by a program as one JSON value: reply with only that JSON value and no other text.";
const month = () => new Date().toISOString().slice(0, 7);
function toMessages(input, images) {
  const turns = typeof input === "string" ? [{ role: "user", content: input }] : input;
  const merged = [];
  for (const t of turns) { const last = merged[merged.length - 1]; if (last && last.role === t.role) last.text += "\n\n" + t.content; else merged.push({ role: t.role, text: t.content }); }
  return merged.map((m, i) => (i === merged.length - 1 && images && images.length)
    ? { role: m.role, content: [...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), { type: "text", text: m.text }] }
    : { role: m.role, content: m.text });
}
app.post("/api/sample", needUser, express.json({ limit: "40mb" }), async (req, res) => {
  const b = req.body || {};
  const tier = MODELS[b.modelTier] ? b.modelTier : "default";
  const sendErr = (status, code, message) => res.status(status).json({ code, message });
  if (!ANTHROPIC_API_KEY) return sendErr(503, "sampling_disabled", "The AI key isn't set up yet.");
  const okInput = typeof b.input === "string" ? b.input.trim() : Array.isArray(b.input) && b.input.length;
  if (!okInput) return sendErr(400, "invalid_request", "input is empty");
  if (Array.isArray(b.input) && b.input.some((t) => !t || !["user", "assistant"].includes(t.role) || typeof t.content !== "string")) return sendErr(400, "invalid_request", "turns must be {role, content}");
  const images = Array.isArray(b.images) ? b.images.slice(0, 6).filter((i) => i && typeof i.data === "string" && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type)) : [];
  try {
    const u = await store.getUsage(month());
    if (u.usd >= MONTHLY_CAP_USD) return sendErr(429, "rate_limited", `This month's AI budget ($${MONTHLY_CAP_USD}) is used up. It resets on the 1st.`);
    if (req.user.role === "demo") { const n = await store.demoHit(new Date().toISOString().slice(0, 10)); if (n > DEMO_DAILY_AI) return sendErr(429, "rate_limited", "The demo's AI limit for today is reached."); }
  } catch (e) { return sendErr(503, "upstream_error", "Couldn't check the AI budget."); }

  const allowed = new Set(Object.values(MODELS));
  const model = b.model && allowed.has(b.model) ? b.model : MODELS[tier];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const ctl = new AbortController();
  res.on("close", () => ctl.abort());
  let inTok = 0, outTok = 0;
  const bill = () => { const p = PRICES[model] || PRICES["claude-sonnet-5-5"]; const usd = (inTok * p[0] + outTok * p[1]) / 1e6; if (inTok || outTok) store.addUsage(month(), usd).catch((e) => console.error("[usage]", e.message)); };

  let upstream;
  try {
    upstream = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS[tier], stream: true, system: FRAMING + (b.verb === "json" ? JSON_FRAMING : ""), messages: toMessages(b.input, images) }),
    });
  } catch (e) { if (!ctl.signal.aborted) { send({ type: "error", code: "upstream_error", message: "Could not reach the AI service." }); res.end(); } return; }
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    const code = upstream.status === 429 ? "rate_limited" : upstream.status === 400 ? "invalid_request" : upstream.status === 401 || upstream.status === 403 ? "sampling_disabled" : "upstream_error";
    console.error("[sample] upstream", upstream.status, t.slice(0, 500));
    send({ type: "error", code, message: `AI service returned ${upstream.status}` });
    return res.end();
  }
  let stop = null, buf = "";
  const dec = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      buf += dec.decode(chunk, { stream: true });
      const events = buf.split("\n\n"); buf = events.pop();
      for (const ev of events) {
        const line = ev.split("\n").find((l) => l.startsWith("data:")); if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (d.type === "message_start" && d.message && d.message.usage) { const u = d.message.usage; inTok += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); outTok += u.output_tokens || 0; }
        else if (d.type === "content_block_delta" && d.delta && d.delta.type === "text_delta" && d.delta.text) send({ type: "delta", text: d.delta.text });
        else if (d.type === "message_delta") { if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason; if (d.usage && d.usage.output_tokens) outTok = d.usage.output_tokens; }
        else if (d.type === "error") { bill(); send({ type: "error", code: "upstream_error", message: (d.error && d.error.message) || "AI error" }); return res.end(); }
      }
    }
  } catch (e) { bill(); if (!ctl.signal.aborted) send({ type: "error", code: "upstream_error", message: "The answer was interrupted." }); return res.end(); }
  bill();
  if (stop === "refusal") send({ type: "error", code: "refused", message: "Claude declined this request." });
  else send({ type: "done", truncated: stop === "max_tokens", modelTierApplied: tier, modelApplied: b.model && model === b.model ? b.model : undefined });
  res.end();
});

/* ---------- nightly feedback email ---------- */
let mailer = null;
function getMailer() {
  if (!SMTP_USER || !SMTP_PASS) return null;
  if (!mailer) {
    const host = process.env.SMTP_HOST || "smtp.gmail.com"; // override only for local testing
    const port = Number(process.env.SMTP_PORT || 465);
    mailer = require("nodemailer").createTransport({ host, port, secure: port === 465, auth: process.env.SMTP_HOST ? undefined : { user: SMTP_USER, pass: SMTP_PASS }, tls: process.env.SMTP_HOST ? { rejectUnauthorized: false } : undefined });
  }
  return mailer;
}
function localParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: FEEDBACK_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d);
  const g = (t) => f.find((x) => x.type === t).value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24 };
}
const fmtTime = (t) => new Date(t).toLocaleString("en-US", { timeZone: FEEDBACK_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const KIND_LABEL = { broken: "Something's broken", confusing: "Confusing", idea: "Idea", love: "Love it" };
let sending = false;
const GMAIL_BLOCKED = new Set("ade adp apk appx appxbundle bat cab chm cmd com cpl diagcab diagcfg diagpack dll dmg ex ex_ exe hta img ins iso isp jar jnlp js jse lib lnk mde mjs msc msi msix msixbundle msp mst nsh pif ps1 scr sct shb sys vb vbe vbs vhd vxd wsc wsf wsh xll zip rar 7z gz tgz tar bz2 xz".split(" "));
async function sendFeedbackDigest(opts = {}) {
  if (sending) return { sent: 0, note: "already sending" };
  const t = getMailer(); if (!t) return { sent: 0, note: "Email isn't set up (SMTP_USER / SMTP_PASS)." };
  sending = true;
  try {
    const rows = (await store.list("main", "feedback")).filter((r) => r.data && !r.data.sentAt && !r.data.trashedAt).sort((a, b) => (a.data.at || 0) - (b.data.at || 0));
    if (!rows.length) return { sent: 0, note: "No new feedback." };
    /* screenshots sit inline in each note (cid images), the way she wrote it.
       Past ~18 MB of pictures the rest become links into the Lab, to stay under Gmail's limit. */
    const attachments = []; let budget = 18 * 1024 * 1024;
    const assetPath = (id) => path.join(DATA_DIR, "assets", "main", String(id).replace(/[^a-f0-9]/g, ""));
    const shot = (id, i, k) => {
      const f = assetPath(id); if (!id || !fs.existsSync(f)) return null;
      const size = fs.statSync(f).size; const link = `${PUBLIC_URL}/_blob/${encodeURIComponent(id)}`;
      if (size > budget) return { link };
      budget -= size; const cid = `fb${i + 1}-${k}@designlab`;
      attachments.push({ filename: `note-${i + 1}-screenshot-${k}.png`, path: f, cid, contentDisposition: "inline" });
      return { cid, link };
    };
    const fileOut = (p, i) => {
      const f = assetPath(p.file); const name = String(p.name || "file").replace(/[\r\n"]/g, "_").slice(0, 200);
      const link = `${PUBLIC_URL}/_blob/${encodeURIComponent(p.file)}?name=${encodeURIComponent(name)}`;
      if (!p.file || !fs.existsSync(f)) return { fileName: name, missing: true };
      const size = fs.statSync(f).size;
      /* Gmail refuses a whole email that carries these (or an archive that might hold them): send a link instead */
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (size > budget || GMAIL_BLOCKED.has(ext)) return { fileName: name, size, link, big: true };
      budget -= size; attachments.push({ filename: name, path: f });
      return { fileName: name, size, link, attached: true };
    };
    const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
    const items = rows.map((r, i) => {
      const d = r.data; const where = [d.screen, d.project, d.task, d.step ? `step “${d.step}”` : ""].filter(Boolean).join(" · ");
      let pieces = Array.isArray(d.body) && d.body.length ? d.body : [{ t: String(d.text || "") }, ...(d.image ? [{ img: d.image, n: 1 }] : [])];
      let k = 0;
      pieces = pieces.map((p) => { if (p && p.file) return fileOut(p, i); if (!p || !p.img) return { t: String((p && p.t) || "") }; k++; return { n: p.n || k, ...(shot(p.img, i, k) || { missing: true }) }; });
      return { n: i + 1, who: d.byName || d.by || "Someone", kind: KIND_LABEL[d.kind] || "Note", when: fmtTime(d.at || Date.now()), where, pieces };
    });
    const pieceText = (p) => (p.fileName ? `\n[file: ${p.fileName}${p.attached ? " (attached)" : p.link ? " " + p.link : " (missing)"}]\n` : "t" in p ? p.t : `\n[screenshot ${p.n}${p.link ? ": " + p.link : ""}]\n`);
    const pieceHtml = (p) => {
      if (p.fileName) return `<div style="margin:10px 0;font-size:14px">📎 <b>${esc(p.fileName)}</b>${p.size ? ` <span style="color:#5E6470">${kb(p.size)}</span>` : ""} ${p.attached ? `<span style="color:#5E6470">(attached to this email)</span>` : p.link ? `<a href="${esc(p.link)}">Download from the Lab</a> <span style="color:#5E6470">(too big or not allowed as an email attachment)</span>` : `<span style="color:#5E6470">(missing)</span>`}</div>`;
      if ("t" in p) return p.t ? `<div style="white-space:pre-wrap;margin:6px 0">${esc(p.t)}</div>` : "";
      if (p.cid) return `<div style="margin:10px 0"><a href="${esc(p.link)}"><img src="cid:${p.cid}" alt="Screenshot ${p.n}" style="display:block;max-width:100%;height:auto;border:1px solid #DADDD5;border-radius:8px"></a></div>`;
      if (p.link) return `<div style="margin:10px 0;font-size:13px"><a href="${esc(p.link)}">Open screenshot ${p.n}</a> (too big to include in the email)</div>`;
      return `<div style="margin:10px 0;font-size:13px;color:#5E6470">[screenshot ${p.n} is missing]</div>`;
    };
    const textBody = items.map((x) => `${x.n}. ${x.kind} from ${x.who} (${x.when})\nWhere: ${x.where || "-"}\n${x.pieces.map(pieceText).join("").replace(/\n{3,}/g, "\n\n").trim()}`).join("\n\n");
    const htmlBody = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#16181D;max-width:680px"><h2 style="margin:0 0 4px">Design Lab feedback</h2><p style="color:#5E6470;margin:0 0 18px">${items.length} new note${items.length === 1 ? "" : "s"}. Reply to answer Jenna directly.</p>${items.map((x) => `<div style="border:1px solid #DADDD5;border-radius:12px;padding:14px 16px;margin:0 0 12px"><div style="font-size:13px;color:#5E6470"><b style="color:#2F4BFF">${esc(x.kind)}</b> · ${esc(x.who)} · ${esc(x.when)}</div>${x.where ? `<div style="font-size:13px;color:#5E6470">Where: ${esc(x.where)}</div>` : ""}<div style="margin-top:6px">${x.pieces.map(pieceHtml).join("")}</div></div>`).join("")}</div>`;
    await t.sendMail({ from: `"Design Lab" <${SMTP_USER}>`, to: FEEDBACK_TO, replyTo: FEEDBACK_REPLY_TO, subject: `Design Lab feedback: ${items.length} new note${items.length === 1 ? "" : "s"} (${localParts().day})`, text: textBody, html: htmlBody, attachments });
    const now = Date.now();
    for (const r of rows) await store.put("main", r.path, "feedback", { ...r.data, sentAt: now });
    return { sent: rows.length };
  } catch (e) { console.error("[feedback] send failed:", e.message); return { sent: 0, note: "Send failed: " + e.message }; }
  finally { sending = false; }
}
async function feedbackTick() {
  try {
    if (!getMailer()) return;
    const { day, hour } = localParts();
    if (hour < FEEDBACK_HOUR) return;
    const mark = await store.get("main", "lab/feedback-mail");
    if (mark && mark.data && mark.data.day === day) return;
    const r = await sendFeedbackDigest();
    if (r.note && r.note.startsWith("Send failed")) return; // try again next tick
    await store.put("main", "lab/feedback-mail", "lab", { day, at: Date.now(), sent: r.sent || 0 });
    if (r.sent) console.log(`[feedback] emailed ${r.sent} note(s) for ${day}`);
  } catch (e) { console.error("[feedback] tick", e.message); }
}

/* ---------- owner admin ---------- */
app.get("/admin", needOwner, async (req, res) => {
  const [u, a, c] = await Promise.all([store.getUsage(month()), store.assetBytes(), store.counts()]).catch(() => [{ usd: 0, calls: 0 }, { bytes: 0, files: 0 }, []]);
  let fb = { pending: 0, last: null };
  try { const rows = await store.list("main", "feedback"); fb.pending = rows.filter((r) => r.data && !r.data.sentAt && !r.data.trashedAt).length; const m = await store.get("main", "lab/feedback-mail"); fb.last = m && m.data; } catch {}
  res.type("html").send(adminPage({ u, a, c, fb, flash: req.query.fb }));
});
app.get("/admin/export", needOwner, async (req, res) => {
  const space = req.query.space === "demo" ? "demo" : "main";
  const rows = await store.dump(space);
  res.set("Content-Disposition", `attachment; filename="design-lab-${space}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), space, docs: rows });
});
app.post("/admin/reset-demo", needOwner, async (req, res) => { await store.wipe("demo"); res.redirect("/admin?reset=1"); });
app.post("/admin/feedback-send", needOwner, async (req, res) => { const r = await sendFeedbackDigest(); res.redirect("/admin?fb=" + encodeURIComponent(r.sent ? `Sent ${r.sent} note(s).` : r.note || "Nothing sent.")); });

/* ---------- pages ---------- */
const PAGE_CSS = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F2F3EF;color:#16181D;font:16px/1.5 "Atkinson Hyperlegible",system-ui,sans-serif}
.box{background:#fff;border:1px solid #DADDD5;border-radius:16px;padding:28px;width:min(380px,92vw);display:flex;flex-direction:column;gap:14px}
h1{font:800 26px/1.1 "Bricolage Grotesque",system-ui,sans-serif;margin:0;display:flex;gap:10px;align-items:center}h1 i{width:12px;height:12px;border-radius:3px;background:#2F4BFF;transform:rotate(45deg);display:inline-block}
label{font-weight:700;font-size:14px}select,input{font:inherit;width:100%;box-sizing:border-box;padding:11px 13px;border-radius:10px;border:1px solid #DADDD5;background:#F2F3EF;margin-top:6px}
button{font:inherit;font-weight:700;padding:12px;border-radius:10px;border:0;background:#2F4BFF;color:#fff;cursor:pointer}.err{color:#B4500F;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:6px;border-bottom:1px solid #DADDD5}a{color:#2F4BFF}
@media (prefers-color-scheme:dark){body{background:#111318;color:#ECEDEF}.box{background:#1A1D24;border-color:#2C313B}select,input{background:#111318;border-color:#2C313B;color:#ECEDEF}td,th{border-color:#2C313B}}`;
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function loginPage(err) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Design Lab</title>${FONTS}<style>${PAGE_CSS}</style></head><body>
<form class="box" method="post" action="/login"><h1><i></i>Design Lab${LAB_LABEL ? ` <span style="font-size:14px;background:#B4500F;color:#fff;border-radius:6px;padding:2px 8px">${esc(LAB_LABEL)}</span>` : ""}</h1>
<div><label for="name">Who's signing in?</label><select id="name" name="name"><option value="jenna">Jenna</option><option value="nathan">Nathan</option><option value="demo">Demo</option></select></div>
<div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus></div>
${err ? `<p class="err">${esc(err)}</p>` : ""}<button type="submit">Sign in</button></form></body></html>`;
}
function adminPage({ u, a, c, fb = { pending: 0 }, flash }) {
  const pct = Math.min(100, Math.round((u.usd / MONTHLY_CAP_USD) * 100));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Design Lab admin</title>${FONTS}<style>${PAGE_CSS} body{align-items:flex-start;padding:40px 0}.box{width:min(640px,92vw)}</style></head><body><div class="box">
<h1><i></i>Design Lab admin</h1><p><a href="/">← Back to the Lab</a></p>
<h3 style="margin:8px 0 0">AI spend this month</h3><p><b>$${u.usd.toFixed(2)}</b> of $${MONTHLY_CAP_USD} (${pct}%) · ${u.calls} calls${ANTHROPIC_API_KEY ? "" : " · <span class=err>AI key not set</span>"}</p>
<div style="height:8px;background:#DADDD5;border-radius:99px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct > 85 ? "#B4500F" : "#2F4BFF"}"></div></div>
<p style="font-size:13px;opacity:.7">Counted from token use at list prices. The demo login is also limited to ${DEMO_DAILY_AI} AI calls a day. Set the same limit in the Anthropic console as a backstop.</p>
<h3 style="margin:8px 0 0">Image storage</h3><p>${(a.bytes / 1048576).toFixed(1)} MB of ${IMAGE_QUOTA_MB} MB · ${a.files} files</p>
<h3 style="margin:8px 0 0">Records</h3><table><tr><th>Workspace</th><th>Kind</th><th>Count</th></tr>${c.map((r) => `<tr><td>${r.space === "main" ? "Jenna & Nathan" : "Demo"}</td><td>${esc(r.coll)}</td><td>${r.n}</td></tr>`).join("") || "<tr><td colspan=3>Nothing yet</td></tr>"}</table>
<p>Storage: ${store.kind === "postgres" ? `Postgres, schema <code>${SCHEMA}</code> only` : "local file"}</p>
<h3 style="margin:8px 0 0">Feedback email</h3>
<p>${SMTP_USER && SMTP_PASS ? `Sends nightly at ${(FEEDBACK_HOUR % 12 || 12) + (FEEDBACK_HOUR >= 12 ? " pm" : " am")} Pacific from ${esc(SMTP_USER)} to ${esc(FEEDBACK_TO)} (replies go to ${esc(FEEDBACK_REPLY_TO)}).` : '<span class="err">Not set up yet: add SMTP_USER and SMTP_PASS in Render.</span>'}<br>${fb.pending} note${fb.pending === 1 ? "" : "s"} waiting${fb.last ? ` · last checked ${esc(fb.last.day)}, ${fb.last.sent} sent` : ""}.</p>
${flash ? `<p><b>${esc(flash)}</b></p>` : ""}
<form method="post" action="/admin/feedback-send"><button type="submit">Send waiting feedback now</button></form>
<h3 style="margin:8px 0 0">Backups</h3><p><a href="/admin/export?space=main">Export Jenna & Nathan's workspace (JSON)</a> · <a href="/admin/export?space=demo">Export demo</a></p>
<form method="post" action="/admin/reset-demo" onsubmit="return confirm('Clear everything in the demo workspace?')"><button type="submit" style="background:#B4500F">Reset the demo workspace</button></form>
</div></body></html>`;
}

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Design Lab on :${PORT} (storage: ${store.kind})`);
    if (!ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: AI features are off.");
    for (const [k, v] of Object.entries(USERS)) if (!v.pw) console.warn(`No password set for ${k}: that login is disabled.`);
    if (!getMailer()) console.warn("SMTP_USER / SMTP_PASS not set: the nightly feedback email is off.");
    setInterval(feedbackTick, 10 * 60 * 1000); setTimeout(feedbackTick, 30 * 1000);
  });
}).catch((e) => { console.error("Storage failed to start:", e.message); process.exit(1); });
