/*
 * Design Lab runtime (adapted from Artifact Host's shim).
 *
 * Stands in for the claude.ai artifact runtime so an exported artifact runs unchanged
 * on this host. It provides `window.claude.use(name)` (contract 0.2.x):
 *   - "sample"     -> your server's /api/sample, which calls the Anthropic API with your key
 *   - "downloads"  -> a normal browser download
 *   - "db"         -> this server's shared storage (/api/db), polled every few seconds
 *   - "user"       -> who is signed in (/api/me)
 *   - "assets"     -> image uploads (/api/assets, served at /_blob/<id>)
 *   - anything else resolves null, which every artifact is written to handle
 * It also gives each app its own slice of localStorage/sessionStorage, so apps that
 * share this host can't read or clobber each other's saved data.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var APP = (script && script.getAttribute("data-app")) || "app";
  var API = (script && script.getAttribute("data-api")) || "/api/sample";

  /* ---------------- per-app storage ---------------- */
  function scopedStorage(real, prefix) {
    function keys() {
      var out = [];
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i);
        if (k != null && k.indexOf(prefix) === 0) out.push(k.slice(prefix.length));
      }
      return out;
    }
    var api = {
      getItem: function (k) { return real.getItem(prefix + String(k)); },
      setItem: function (k, v) { real.setItem(prefix + String(k), String(v)); },
      removeItem: function (k) { real.removeItem(prefix + String(k)); },
      clear: function () { keys().forEach(function (k) { real.removeItem(prefix + k); }); },
      key: function (i) { var ks = keys(); return i >= 0 && i < ks.length ? ks[i] : null; },
    };
    Object.defineProperty(api, "length", { get: function () { return keys().length; }, configurable: true });
    return new Proxy(api, {
      get: function (t, p) {
        if (p in t || typeof p === "symbol") return t[p];
        var v = real.getItem(prefix + p);
        return v === null ? undefined : v;
      },
      set: function (t, p, v) { if (p in t) return false; real.setItem(prefix + String(p), String(v)); return true; },
      deleteProperty: function (t, p) { real.removeItem(prefix + String(p)); return true; },
      has: function (t, p) { return p in t || real.getItem(prefix + String(p)) !== null; },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) {
        var v = real.getItem(prefix + String(p));
        return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
      },
    });
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try {
      var real = window[name];
      if (!real) return;
      var scoped = scopedStorage(real, "app:" + APP + ":");
      Object.defineProperty(window, name, { configurable: true, get: function () { return scoped; } });
    } catch (e) { /* storage blocked: artifacts already guard every read and write */ }
  });

  /* ---------------- helpers ---------------- */
  function fail(code, message, text) {
    var e = { code: code, message: message };
    if (typeof text === "string" && text.length) e.text = text;
    return e;
  }
  function isPlain(o) { return o !== null && typeof o === "object" && Object.getPrototypeOf(o) === Object.prototype; }
  var TIERS = { quick: 1, default: 1, complex: 1 };
  var IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  var IMG_MAX_COUNT = 5, IMG_MAX_BYTES = 20 * 1024 * 1024, MAX_PROMPT = 262144;

  function validate(input, opts) {
    if (typeof input === "string") {
      if (!input.trim()) return "input is empty";
    } else if (Array.isArray(input)) {
      if (!input.length) return "input is empty";
      for (var i = 0; i < input.length; i++) {
        var t = input[i];
        if (!t || (t.role !== "user" && t.role !== "assistant")) return "turn " + i + " has an unknown role";
        if (typeof t.content !== "string" || !t.content.trim()) return "turn " + i + " has empty content";
      }
      if (input[0].role !== "user" || input[input.length - 1].role !== "user") return "turns must start and end with a user turn";
    } else {
      return "input must be a string or a list of turns (the prompt goes first)";
    }
    if (opts !== undefined && !isPlain(opts)) return "options must be a plain object";
    opts = opts || {};
    if (opts.onText !== undefined && typeof opts.onText !== "function") return "onText must be a function";
    if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) return "signal must be an AbortSignal (pass ctl.signal)";
    if (opts.modelTier !== undefined && !TIERS[opts.modelTier]) return "unknown modelTier";
    var c = opts.cache;
    if (c !== undefined && c !== true && c !== false && !(isPlain(c) && (c.gcTime === undefined || (typeof c.gcTime === "number" && c.gcTime > 0)))) return "cache must be true, false or {gcTime, refresh}";
    return null;
  }
  function byteLen(input) {
    var s = typeof input === "string" ? input : input.map(function (t) { return t.content; }).join("");
    return new TextEncoder().encode(s).length;
  }
  function toList(images) {
    if (!images) return [];
    if (images instanceof Blob) return [images];
    return Array.prototype.slice.call(images);
  }
  // Downsize to ~1.2 MP and re-encode, as the claude.ai runtime does, then base64.
  function prepImage(blob) {
    if (!(blob instanceof Blob)) return Promise.reject(fail("invalid_request", "images must be Blobs or Files"));
    if (IMAGE_TYPES.indexOf(blob.type) < 0 && blob.type) return Promise.reject(fail("image_rejected", "unsupported image type " + blob.type));
    if (blob.size > IMG_MAX_BYTES) return Promise.reject(fail("image_rejected", "image is over 20 MB"));
    return createImageBitmap(blob, { imageOrientation: "from-image" }).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      if (w > 10000 || h > 10000 || w * h > 64e6) throw fail("image_rejected", "image is too large");
      var s = Math.min(1, Math.sqrt(1.2e6 / (w * h)));
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      var cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      cv.getContext("2d").drawImage(bmp, 0, 0, cw, ch);
      var type = blob.type === "image/png" ? "image/png" : "image/jpeg";
      return new Promise(function (res) { cv.toBlob(res, type, 0.88); }).then(function (b) {
        return b.arrayBuffer().then(function (buf) {
          var bytes = new Uint8Array(buf), bin = "";
          for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { media_type: type, data: btoa(bin) };
        });
      });
    }, function (e) { throw e && e.code ? e : fail("image_rejected", "image could not be decoded"); });
  }
  function parseJsonLoose(text) {
    var t = text.trim();
    try { return { ok: true, value: JSON.parse(t) }; } catch (e) {}
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { return { ok: true, value: JSON.parse(fence[1].trim()) }; } catch (e) {} }
    var first = t.search(/[\[{]/), last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (first >= 0 && last > first) { try { return { ok: true, value: JSON.parse(t.slice(first, last + 1)) }; } catch (e) {} }
    return { ok: false };
  }

  /* ---------------- answer cache (per app, per tab) ---------------- */
  var CACHE = new Map(), INFLIGHT = new Map();
  function cacheKey(input, opts, verb, imgs) {
    return JSON.stringify([verb, input, opts.modelTier || "default", opts.model || "", opts.effort || "", imgs.map(function (i) { return i.data.length + ":" + i.data.slice(0, 64) + i.data.slice(-64); })]);
  }

  /* ---------------- concurrency: two at a time, a few waiting ---------------- */
  var running = 0, waiting = [];
  function acquire() {
    if (running < 2) { running++; return Promise.resolve(); }
    if (waiting.length >= 8) return Promise.reject(fail("rate_limited", "too many calls at once"));
    return new Promise(function (r) { waiting.push(r); });
  }
  function release() { var n = waiting.shift(); if (n) n(); else running--; }

  /* ---------------- the network call ---------------- */
  function stream(body, signal, onDelta) {
    return fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app": APP },
      body: JSON.stringify(body),
      signal: signal,
    }).then(function (res) {
      if (!res.ok && !(res.headers.get("content-type") || "").includes("text/event-stream")) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw fail(j.code || (res.status === 429 ? "rate_limited" : "upstream_error"), j.message || ("HTTP " + res.status));
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", meta = null, errObj = null;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split("\n\n");
          buf = parts.pop();
          parts.forEach(function (chunk) {
            var line = chunk.split("\n").filter(function (l) { return l.indexOf("data:") === 0; }).map(function (l) { return l.slice(5).trim(); }).join("");
            if (!line) return;
            var ev; try { ev = JSON.parse(line); } catch (e) { return; }
            if (ev.type === "delta" && ev.text) onDelta(ev.text);
            else if (ev.type === "done") meta = ev;
            else if (ev.type === "error") errObj = ev;
          });
          if (errObj) return;
          return pump();
        });
      }
      return pump().then(function () {
        if (errObj) throw fail(errObj.code || "upstream_error", errObj.message || "upstream error");
        if (!meta) throw fail("upstream_error", "the answer stream ended early");
        return meta;
      });
    }, function (e) {
      if (e && e.name === "AbortError") throw fail("cancelled", "cancelled");
      throw fail("upstream_error", "network error");
    });
  }

  function run(input, opts, verb) {
    return new Promise(function (resolve, reject) {
      var bad = validate(input, opts);
      if (bad) return reject(fail("invalid_request", bad));
      opts = opts || {};
      if (opts.tools !== undefined) return reject(fail("tools_unavailable", "page tools are not available on this host yet"));
      if (byteLen(input) > MAX_PROMPT) return reject(fail("prompt_too_large", "input is over 256 KiB"));
      var turns = typeof input === "string" ? input : input.map(function (t) { return { role: t.role, content: t.content }; });
      var imgsIn = toList(opts.images);
      if (imgsIn.length > IMG_MAX_COUNT) return reject(fail("image_rejected", "too many images"));
      var signal = opts.signal;
      if (signal && signal.aborted) return reject(fail("cancelled", "signal was already aborted"));
      var text = "";
      var onText = opts.onText;
      function emit(delta) {
        text += delta;
        if (onText && !(signal && signal.aborted)) { try { onText({ text: text, delta: delta }); } catch (e) { console.error(e); } }
      }
      Promise.resolve()
        .then(function () { return Promise.all(imgsIn.map(prepImage)); })
        .then(function (imgs) {
          if (signal && signal.aborted) throw fail("cancelled", "cancelled");
          var useCache = opts.cache !== false;
          var gc = isPlain(opts.cache) && opts.cache.gcTime ? Math.min(opts.cache.gcTime, 864e5) : 3e5;
          var key = cacheKey(turns, opts, verb, imgs);
          if (useCache && !(isPlain(opts.cache) && opts.cache.refresh)) {
            var hit = CACHE.get(key);
            if (hit && Date.now() - hit.at < gc) {
              return new Promise(function (r) { setTimeout(r, 0); }).then(function () { emit(hit.result.text); return hit.result; });
            }
          }
          return acquire().then(function () {
            var ctl = new AbortController();
            if (signal) signal.addEventListener("abort", function () { ctl.abort(); }, { once: true });
            var body = { input: turns, verb: verb, modelTier: opts.modelTier || "default", model: opts.model, effort: opts.effort, images: imgs };
            return stream(body, ctl.signal, emit).then(function (meta) {
              release();
              if (!text.trim()) throw fail("empty_completion", "Claude produced no text");
              var result = { text: text, truncated: !!meta.truncated, modelTierApplied: meta.modelTierApplied || opts.modelTier || "default" };
              if (opts.model && meta.modelApplied === opts.model) result.modelApplied = opts.model;
              if (useCache) CACHE.set(key, { at: Date.now(), result: result });
              return result;
            }, function (e) { release(); throw e; });
          });
        })
        .then(function (result) {
          if (verb !== "json") return resolve(result);
          if (result.truncated) return reject(fail("invalid_json", "the answer was cut short before the JSON was complete", result.text));
          var p = parseJsonLoose(result.text);
          if (!p.ok) return reject(fail("invalid_json", "no JSON value could be parsed from the reply", result.text));
          resolve(p.value);
        })
        .catch(function (e) {
          if (signal && signal.aborted) e = fail("cancelled", "cancelled");
          if (!e || !e.code) e = fail("upstream_error", String((e && e.message) || e));
          if (text && e.code !== "refused" && !e.text) e.text = text;
          reject(e);
        });
    });
  }

  var sample = function (input, opts) { return run(input, opts, "text"); };
  sample.json = function (input, opts) { return run(input, opts, "json"); };
  sample.limits = function () {
    return Promise.resolve({
      maxPromptBytes: MAX_PROMPT,
      images: { maxCount: IMG_MAX_COUNT, maxInputBytes: IMG_MAX_BYTES, mediaTypes: IMAGE_TYPES.slice() },
    });
  };
  Object.freeze(sample);

  /* ---------------- downloads ---------------- */
  var ALLOWED_EXT = "gif png jpg jpeg webp mp4 webm mov txt json md docx pptx epub csv ttf html svg pdf xlsx zip ics".split(" ");
  var MIME = { txt: "text/plain", json: "application/json", md: "text/markdown", csv: "text/csv", html: "text/html", svg: "image/svg+xml", pdf: "application/pdf", ics: "text/calendar", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", zip: "application/zip" };
  var saving = false;
  var downloads = Object.freeze({
    save: function (req) {
      return new Promise(function (resolve, reject) {
        if (!req || typeof req.filename !== "string" || !req.filename || req.filename.length > 512) return reject(fail("bad_request", "filename must be a non-empty string"));
        var name = req.filename.replace(/[\u0000-\u001f​-‏‪-‮]/g, "").replace(/\s+/g, " ").trim();
        var ext = (name.split(".").pop() || "").toLowerCase();
        if (name.indexOf(".") < 0 || ALLOWED_EXT.indexOf(ext) < 0) return reject(fail("rejected_extension", "extension ." + ext + " is not allowed"));
        if (req.request) return reject(fail("request_unknown", "exports are not supported on this host"));
        var d = req.data, blob;
        if (typeof d === "string") blob = new Blob([d], { type: MIME[ext] || "application/octet-stream" });
        else if (d instanceof Blob) blob = new Blob([d], { type: MIME[ext] || "application/octet-stream" });
        else if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) blob = new Blob([d], { type: MIME[ext] || "application/octet-stream" });
        else return reject(fail("bad_request", "data must be a string, Blob or ArrayBuffer"));
        if (!blob.size) return reject(fail("bad_request", "data is empty"));
        if (saving) return reject(fail("rate_limited", "a save is already in progress"));
        saving = true;
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = name; a.style.display = "none";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); saving = false; }, 1000);
        resolve({ status: "saved" });
      });
    },
  });


  /* ---------------- who is signed in ---------------- */
  var mePromise = fetch("/api/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  function dbErr(code, message) { var e = new Error(message); e.code = code; e.message = message; return e; }
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; throw dbErr("revoked", "signed out"); }
        return r.json().then(function (j) { if (!r.ok) throw dbErr(j.code || "unavailable", j.message || "storage error"); return j; }, function () { if (!r.ok) throw dbErr("unavailable", "storage error"); return {}; });
      }, function () { throw dbErr("unavailable", "network error"); });
  }
  var userNs = Object.freeze({
    id: function () { return mePromise.then(function (m) { return m ? m.id : null; }); },
    me: function () { return mePromise.then(function (m) { return m ? { id: m.id, name: m.name } : { id: "", name: "" }; }); },
    isOwner: function () { return false; },
    canEdit: function () { return true; },
    can: function () { return true; },
    profiles: function (ids) { return mePromise.then(function (m) { var o = {}; (ids || []).forEach(function (id) { o[id] = { id: id, name: id === (m && m.id) ? m.name : (id === "nathan" ? "Nathan" : id === "jenna" ? "Jenna" : "") }; }); return o; }); },
    search: function () { return Promise.resolve([]); },
  });
  mePromise.then(function (m) { if (m && m.role === "owner") userNs = Object.freeze(Object.assign({}, userNs, { isOwner: function () { return true; } })); SERVED.user = userNs; });

  /* ---------------- shared storage ---------------- */
  var SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  function checkPath(p, wantDoc) {
    if (typeof p !== "string") throw new TypeError("path must be a string");
    var segs = p.split("/");
    if (segs.some(function (s) { return !SEG.test(s) || s === "." || s === ".."; })) throw new TypeError("bad path segment in " + p);
    if (wantDoc && segs.length % 2) throw new TypeError("document paths need an even number of segments: " + p);
    if (!wantDoc && !(segs.length % 2)) throw new TypeError("collection paths need an odd number of segments: " + p);
  }
  var META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  function docSnap(id, row) { var data = row && row.data ? Object.freeze(row.data) : undefined; return Object.freeze({ id: id, exists: !!row, data: function () { return data; }, metadata: META, version: row ? row.version : undefined }); }
  var subs = [];
  var POLL_MS = 3000, timer = null;
  function tick() {
    if (document.hidden) return;
    subs.forEach(pollOne);
  }
  function kick() { setTimeout(tick, 60); }
  function pollOne(s) {
    if (s.dead || s.busy) return;
    s.busy = true;
    var url = s.kind === "doc" ? "/api/db/doc?path=" + encodeURIComponent(s.path) : "/api/db/coll?path=" + encodeURIComponent(s.path);
    var headers = s.etag ? { "if-none-match": s.etag } : {};
    fetch(url, { credentials: "same-origin", headers: headers }).then(function (r) {
      if (r.status === 401) { location.href = "/login"; return; }
      if (r.status === 304) return;
      if (!r.ok) return;
      s.etag = r.headers.get("etag") || null;
      return r.json().then(function (j) {
        if (s.dead) return;
        if (s.kind === "doc") {
          var sig = j.exists ? j.version : -1;
          if (sig === s.last) return; s.last = sig;
          s.next(docSnap(s.path.split("/").pop(), j.exists ? j : null));
        } else {
          var docs = (j.docs || []).map(function (d) { return docSnap(d.id, d); });
          s.next(querySnap(applyQuery(docs, s.q)));
        }
      });
    }).catch(function () {}).then(function () { s.busy = false; });
  }
  function startTimer() { if (!timer) { timer = setInterval(tick, POLL_MS); document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); }); } }
  function subscribe(s) { s.last = undefined; subs.push(s); startTimer(); setTimeout(function () { pollOne(s); }, 0); return function () { s.dead = true; subs = subs.filter(function (x) { return x !== s; }); }; }
  function querySnap(docs) { return Object.freeze({ docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return docs.map(function (d, i) { return { type: "added", doc: d, oldIndex: -1, newIndex: i }; }); }, metadata: META }); }
  function cmp(op, a, b) {
    switch (op) {
      case "==": return a === b; case "!=": return a !== b; case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
      case "in": return Array.isArray(b) && b.indexOf(a) >= 0; case "not-in": return Array.isArray(b) && b.indexOf(a) < 0;
      case "array-contains": return Array.isArray(a) && a.indexOf(b) >= 0; default: return true;
    }
  }
  function applyQuery(docs, q) {
    var out = docs.filter(function (d) { var x = d.data() || {}; return q.filters.every(function (f) { return cmp(f[1], x[f[0]], f[2]); }); });
    if (q.order) out.sort(function (a, b) { var x = (a.data() || {})[q.order[0]], y = (b.data() || {})[q.order[0]]; if (x === undefined) return 1; if (y === undefined) return -1; var r = x < y ? -1 : x > y ? 1 : 0; return q.order[1] === "desc" ? -r : r; });
    else out.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    if (q.limit) out = out.slice(0, q.limit);
    return out;
  }
  function newId() { var a = new Uint8Array(10); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(36)).slice(-2); }).join("").slice(0, 20); }
  function docRef(p) {
    checkPath(p, true);
    var id = p.split("/").pop();
    return Object.freeze({
      id: id, path: p,
      get: function () { return api("GET", "/api/db/doc?path=" + encodeURIComponent(p)).then(function (j) { return docSnap(id, j.exists ? j : null); }); },
      set: function (data) { if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.reject(dbErr("invalid_argument", "data must be an object")); return api("PUT", "/api/db/doc", { path: p, data: data, mode: "set" }).then(function () { kick(); }); },
      update: function (data) { return api("PUT", "/api/db/doc", { path: p, data: data, mode: "update" }).then(function () { kick(); }); },
      delete: function () { return api("DELETE", "/api/db/doc?path=" + encodeURIComponent(p)).then(function () { kick(); }); },
      acquire: function () { return Promise.resolve({ acquired: true }); },
      onSnapshot: function (next, error) { return subscribe({ kind: "doc", path: p, next: next, error: error }); },
      collection: function (c) { return collRef(p + "/" + c); },
    });
  }
  function makeQuery(p, q) {
    return {
      where: function (f, op, v) { return Object.freeze(makeQuery(p, { filters: q.filters.concat([[f, op, v]]), order: q.order, limit: q.limit })); },
      orderBy: function (f, dir) { return Object.freeze(makeQuery(p, { filters: q.filters, order: [f, dir || "asc"], limit: q.limit })); },
      limit: function (n) { return Object.freeze(makeQuery(p, { filters: q.filters, order: q.order, limit: n })); },
      get: function () { return api("GET", "/api/db/coll?path=" + encodeURIComponent(p)).then(function (j) { return querySnap(applyQuery((j.docs || []).map(function (d) { return docSnap(d.id, d); }), q)); }); },
      onSnapshot: function (next, error) { return subscribe({ kind: "coll", path: p, q: q, next: next, error: error }); },
    };
  }
  function collRef(p) {
    checkPath(p, false);
    var base = makeQuery(p, { filters: [], order: null, limit: null });
    base.path = p;
    base.doc = function (id) { return docRef(p + "/" + (id || newId())); };
    base.add = function (data) { var r = docRef(p + "/" + newId()); return r.set(data).then(function () { return r; }); };
    return Object.freeze(base);
  }
  var db = Object.freeze({ doc: docRef, collection: collRef });

  /* ---------------- image uploads ---------------- */
  var ASSET_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "text/plain", "text/markdown", "application/octet-stream"];
  var assets = Object.freeze({
    upload: function (blob, opts) {
      if (!(blob instanceof Blob) || !blob.size) return Promise.reject(fail("invalid_request", "upload needs a non-empty Blob"));
      var type = (opts && opts.type) || blob.type;
      if (ASSET_TYPES.indexOf(type) < 0) return Promise.reject(fail("unsupported_type", "Images, PDFs, Word documents and text files only"));
      if (blob.size > 20 * 1048576) return Promise.reject(fail("too_large", "over 20 MB"));
      return fetch("/api/assets", { method: "POST", credentials: "same-origin", headers: { "content-type": type }, body: blob }).then(function (r) {
        return r.json().then(function (j) { if (!r.ok) throw fail(j.code || "upstream_error", j.message || "upload failed"); return j; });
      });
    },
    list: function () { return Promise.resolve({ assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }); },
    delete: function () { return Promise.resolve({ deleted: false }); },
  });

  /* ---------------- claude.use ---------------- */
  var SERVED = { sample: sample, downloads: downloads, db: db, user: userNs, assets: assets };
  var promises = {};
  var claude = Object.freeze({
    use: function (name) {
      if (!Object.prototype.hasOwnProperty.call(SERVED, name)) return Promise.resolve(null);
      if (!promises[name]) promises[name] = new Promise(function (r) { setTimeout(function () { r(SERVED[name]); }, 0); });
      return promises[name];
    },
  });
  Object.defineProperty(window, "claude", { value: claude, writable: false, configurable: false });
})();
