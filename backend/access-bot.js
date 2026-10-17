// access-bot.js : second bot Discord (gestion de l'accès / du temps), piloté par server.js
// comme le bot principal (bot.js). Adapté de deuxieme_bot.js.
//
// Ce qui change par rapport à deuxieme_bot.js :
//  - plus de main() ni de process.exit : le cycle de vie passe par startAccessBot() /
//    stopAccessBot() / accessStatus(), appelés depuis le panel admin (server.js)
//  - la connexion MongoDB est PARTAGÉE : server.js appelle setDb(state.db)
//  - la config (token, salon, rôles) est stockée en base (settings, clé "access_bot_config")
//    et modifiable depuis le panel ; les variables d'environnement servent de secours
//  - le token vient de ACCESS_BOT_TOKEN (et non DISCORD_TOKEN, déjà utilisé par le bot principal)
//
// Variables d'environnement (toutes facultatives si tout est réglé depuis le panel) :
//   ACCESS_BOT_TOKEN   token de CE bot (nouvelle application Discord)
//   PANEL_CHANNEL_ID   salon PARTAGÉ où tous les panels d'accès sont postés
//   ACCESS_ROLE_ID     rôle donné par /add-time (défaut : BUYER_ROLE_ID de bot.js, pour que le
//                      bouton OK du bot principal reconnaisse les gens qui ont de l'accès ici)
//   STAFF_ROLE_ID      rôle autorisé à utiliser /add-time (défaut : STAFF_ROLE_ID de bot.js)
//
// Commandes (à préfixe, "!" par défaut, modifiable depuis le panel) :
//   !add-time @member hours  (staff) crée ou ajoute des heures et donne le rôle d'accès
//   !add-time all hours      (staff) ajoute des heures à TOUS les abonnés + DM
//   !check-time [@member]    (tout le monde) affiche le temps restant
//   !check-time all          (staff) liste le temps restant de tous les abonnés
//   !freeze-time @member     (staff) gèle le temps d'un membre (maintenance, durée illimitée)
//   !freeze-time all         (staff) gèle TOUS les abonnés + DM
//   !unfreeze-time @member   (staff) dégèle le temps d'un membre
//   !unfreeze-time all       (staff) dégèle TOUS les abonnés + DM
//   !help                    affiche la liste des commandes
// Nécessite "Message Content Intent" activé dans le portail développeur Discord.

import {
  Client,
  ContainerBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import {
  BUYER_ROLE_ID,
  STAFF_ROLE_ID,
  getConfig as getMainBotConfig,
  nowIso,
  parseIsoUtc,
} from "./bot.js";

// ---------- Logger ----------
const log = {
  info: (...a) => console.log("[access-bot][INFO]", ...a),
  warn: (...a) => console.warn("[access-bot][WARN]", ...a),
  error: (...a) => console.error("[access-bot][ERROR]", ...a),
};

// ---------- État du bot (indépendant de celui de bot.js) ----------
const state = {
  bot: null,
  task: null,
  status: "stopped", // stopped | starting | online | error
  lastError: null,
  db: null,
  countdownActive: false,
};

// Reçoit la connexion MongoDB déjà ouverte par server.js (connectDb de bot.js)
export function setDb(db) {
  state.db = db;
}

// ---------- Config (stockée en base, clé "access_bot_config") ----------
const CONFIG_KEY = "access_bot_config";
export const ACCESS_CONFIG_KEYS = ["token", "prefix", "footer_text", "access_role_id", "staff_role_id", "panel_channel_id"];

// Valeurs enregistrées en base (vides = "utiliser la variable d'environnement / le défaut")
// Petit cache : le handler de messages lit la config à chaque message du serveur
const cfgCache = { at: 0, value: null };
async function getCachedConfig() {
  if (cfgCache.value && Date.now() - cfgCache.at < 15_000) return cfgCache.value;
  cfgCache.value = await getAccessEffectiveConfig();
  cfgCache.at = Date.now();
  return cfgCache.value;
}

export async function getAccessConfig() {
  const doc = await state.db.collection("settings").findOne({ key: CONFIG_KEY });
  return {
    token: "",
    prefix: "",
    footer_text: "",
    panel_channel_id: "",
    access_role_id: "",
    staff_role_id: "",
    ...(doc?.value ?? {}),
  };
}

export async function saveAccessConfig(patch = {}) {
  const current = { ...(await getAccessConfig()), ...patch };
  await state.db
    .collection("settings")
    .updateOne({ key: CONFIG_KEY }, { $set: { value: current } }, { upsert: true });
  cfgCache.at = 0; // force la relecture de la config
  return current;
}

// Valeurs réellement utilisées : base > variable d'environnement > défaut
export async function getAccessEffectiveConfig() {
  const c = await getAccessConfig();
  return {
    token: (c.token || process.env.ACCESS_BOT_TOKEN || "").trim(),
    prefix: (c.prefix || process.env.ACCESS_BOT_PREFIX || "!").trim() || "!",
    footer_text: (c.footer_text || process.env.ACCESS_BOT_FOOTER || "").trim(),
    panel_channel_id: (c.panel_channel_id || process.env.PANEL_CHANNEL_ID || "").trim(),
    access_role_id: (c.access_role_id || process.env.ACCESS_ROLE_ID || BUYER_ROLE_ID).trim(),
    staff_role_id: (c.staff_role_id || process.env.STAFF_ROLE_ID || STAFF_ROLE_ID).trim(),
  };
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fmtSecs(sec) {
  sec = Math.max(0, Math.floor(sec));
  const totalMin = Math.floor(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

async function getChannel(id) {
  try {
    return await state.bot.channels.fetch(String(id));
  } catch {
    return null;
  }
}

function isStaff(member, staffRoleId) {
  try {
    return member?.roles?.cache?.has(staffRoleId) ?? false;
  } catch {
    return false;
  }
}

// ---------- Vue du panel (anciens panels déjà postés ; le bot n'en crée plus) ----------
// Ils continuent d'être mis à jour, mais sans bouton Freeze : le gel est réservé au staff.
function panelBody(mention, sub) {
  const frozen = Boolean(sub.frozen);
  const statusLine = frozen ? "\u{1F534} `FROZEN`" : "\u{1F7E2} `ACTIVE`";
  return (
    `# \u26A1 Access Panel\n` +
    `${mention}\n\n` +
    `**Time Left**\u2003\`${fmtSecs(sub.burn_seconds ?? 0)}\`\n` +
    `**Status**\u2003${statusLine}`
  );
}

function buildPanelView(discordId, sub) {
  const frozen = Boolean(sub.frozen);
  const container = new ContainerBuilder()
    .setAccentColor(frozen ? 0xe23b3b : 0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(panelBody(`<@${discordId}>`, sub)));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function expiredView(discordId) {
  const container = new ContainerBuilder()
    .setAccentColor(0x6b7280)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# \u23F0 Access Expired\n<@${discordId}>\n\nThis access has run out. Ask staff to add more time.`
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Édite le panel existant d'un utilisateur, ou ne fait rien s'il n'y en a pas
async function refreshPanel(sub) {
  if (!sub.panel_channel_id || !sub.panel_message_id) return false;
  try {
    const ch = await getChannel(sub.panel_channel_id);
    if (!ch) return false;
    const msg = await ch.messages.fetch(String(sub.panel_message_id));
    await msg.edit(buildPanelView(sub.discord_id, sub));
    return true;
  } catch {
    return false;
  }
}

// ---------- Commandes à préfixe ----------
// Les anciennes slash commands de ce bot sont supprimées du serveur (si GUILD_ID est défini)
async function clearOldSlashCommands(client) {
  const guildId = process.env.GUILD_ID?.trim();
  if (!guildId) return;
  try {
    const rest = new REST({ version: "10" }).setToken(client.token);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] });
    log.info("anciennes slash commands supprimées du serveur");
  } catch (e) {
    log.warn(`clear slash commands failed: ${e}`);
  }
}

// Extrait un ID utilisateur depuis "<@123>", "<@!123>" ou "123"
function parseUserId(arg) {
  if (!arg) return null;
  const m = arg.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  return /^\d{15,25}$/.test(arg) ? arg : null;
}

async function fetchMember(guild, arg) {
  const id = parseUserId(arg);
  if (!id) return null;
  return guild.members.fetch(id).catch(() => null);
}

// ---------- Embeds ----------
const COLOR_BLUE = 0x4a9eff;
const COLOR_GREEN = 0x22c55e;
const COLOR_RED = 0xe23b3b;

function baseEmbed(cfg, color, title, description) {
  const e = new EmbedBuilder().setColor(color).setTitle(title);
  if (description) e.setDescription(description);
  e.setFooter({ text: cfg.footer_text || `⚡ ${state.bot?.user?.username ?? "Access Bot"}` });
  return e;
}

// Envoie l'embed dans le salon (sans "répondre" au message de la commande), sans pinguer personne
const sendEmbed = (message) => (embed) =>
  message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

// Temps réellement restant, en tenant compte du temps écoulé depuis le dernier tick (≤ 60 s).
// Gelé : le temps ne bouge pas (gel illimité, réservé au staff).
function liveSeconds(sub) {
  let elapsed = 0;
  if (sub.last_tick) {
    const prev = parseIsoUtc(sub.last_tick).getTime();
    if (!Number.isNaN(prev)) elapsed = Math.max(0, Math.floor((Date.now() - prev) / 1000));
  }
  const burn = parseInt(sub.burn_seconds ?? 0, 10);
  return { burn: sub.frozen ? burn : Math.max(0, burn - elapsed) };
}

// Champs communs : temps restant / expiration exacte (timestamps Discord)
function timeFields(sub) {
  const { burn } = liveSeconds(sub);
  const fields = [{ name: "⏳ Time remaining", value: `**${fmtSecs(burn)}**` }];
  if (sub.frozen) {
    fields.push({ name: "📅 Exact expiration", value: "Paused — time is frozen (maintenance)" });
  } else {
    const ts = Math.floor(Date.now() / 1000) + burn;
    fields.push({ name: "📅 Exact expiration", value: `<t:${ts}:F> (<t:${ts}:R>)` });
  }
  return fields;
}

const errorEmbed = (cfg, title, description) => baseEmbed(cfg, COLOR_RED, title, description);

// Change l'état gelé d'un abonnement en "soldant" d'abord le temps écoulé depuis le dernier tick
// (sinon jusqu'à 60 s de décompte seraient gagnées ou perdues à chaque bascule).
async function setFrozenState(sub, newFrozen) {
  const live = liveSeconds(sub);
  const set = { frozen: newFrozen, last_tick: nowIso(), burn_seconds: live.burn };
  await state.db.collection("subscriptions").updateOne({ discord_id: sub.discord_id }, { $set: set });
  Object.assign(sub, set);
}

// ---------- Commandes ----------
// !add-time all <hours> : ajoute des heures à TOUS les abonnés et leur envoie un DM
async function handleAddTimeAll(message, args, cfg) {
  const send = sendEmbed(message);
  const hours = parseInt(args[1], 10);
  if (!Number.isInteger(hours) || String(hours) !== String(args[1])) {
    return send(errorEmbed(cfg, "⚠️ Usage", `\`${cfg.prefix}add-time all hours\``));
  }
  if (hours <= 0) return send(errorEmbed(cfg, "⚠️ Invalid hours", "Hours must be a positive number."));

  const col = state.db.collection("subscriptions");
  if ((await col.countDocuments({})) === 0) {
    return send(errorEmbed(cfg, "❌ No active access", "There are no active subscriptions."));
  }

  const addSecs = hours * 3600;
  await col.updateMany({}, { $inc: { burn_seconds: addSecs } });
  const subs = await col.find({}).toArray();

  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    await refreshPanel(sub); // met à jour un ancien panel s'il existe encore
    try {
      const user = await state.bot.users.fetch(sub.discord_id);
      const dm = baseEmbed(
        cfg,
        COLOR_GREEN,
        "➕ Time added",
        `**+${hours} hour(s)** of access were added to your account.`
      )
        .addFields(timeFields(sub))
        .setThumbnail(user.displayAvatarURL({ size: 256 }));
      await user.send({ embeds: [dm] });
      sent++;
    } catch {
      failed++; // DMs fermés, utilisateur introuvable...
    }
    await sleep(250); // évite de saturer l'API Discord
  }

  let text = `✅ **+${hours} hour(s)** added and DM notification sent to: **${sent} user${sent === 1 ? "" : "s"}**`;
  if (failed) text += `\n⚠️ ${failed} DM(s) could not be delivered (DMs closed or user not found). Their time was still added.`;
  await send(new EmbedBuilder().setColor(COLOR_GREEN).setDescription(text));
}

async function handleAddTime(message, args, cfg) {
  const send = sendEmbed(message);

  if (!isStaff(message.member, cfg.staff_role_id)) {
    return send(errorEmbed(cfg, "❌ Permission denied", "You don't have permission to use this command."));
  }

  if ((args[0] ?? "").toLowerCase() === "all") return handleAddTimeAll(message, args, cfg);

  const member = await fetchMember(message.guild, args[0]);
  const hours = parseInt(args[1], 10);
  if (!member || !Number.isInteger(hours) || String(hours) !== String(args[1])) {
    return send(
      errorEmbed(cfg, "⚠️ Usage", `\`${cfg.prefix}add-time @member hours\`\n\`${cfg.prefix}add-time all hours\``)
    );
  }
  if (hours <= 0) return send(errorEmbed(cfg, "⚠️ Invalid hours", "Hours must be a positive number."));

  const db = state.db;
  const addSecs = hours * 3600;
  const existing = await db.collection("subscriptions").findOne({ discord_id: member.id });

  try {
    // Donne le rôle access (idempotent : rien ne se passe s'il l'a déjà)
    const role = await message.guild.roles.fetch(cfg.access_role_id).catch(() => null);
    if (role) await member.roles.add(role, `access granted by ${message.author.username}`);

    if (!existing) {
      // Premier octroi : crée l'abonnement (aucun panel n'est posté)
      const sub = {
        discord_id: member.id,
        username: member.user.username,
        burn_seconds: addSecs,
        frozen: false,
        last_tick: nowIso(),
      };
      await db.collection("subscriptions").insertOne({ ...sub });
      const e = baseEmbed(cfg, COLOR_GREEN, "✅ Access granted", `<@${member.id}> received **${hours}h** of access.`)
        .addFields(timeFields(sub))
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
      await send(e);
    } else {
      // Déjà abonné : ajoute les heures
      await db.collection("subscriptions").updateOne(
        { discord_id: member.id },
        { $inc: { burn_seconds: addSecs } }
      );
      const updated = await db.collection("subscriptions").findOne({ discord_id: member.id });
      await refreshPanel(updated); // met à jour un ancien panel s'il existe encore, sinon rien
      const e = baseEmbed(cfg, COLOR_GREEN, "➕ Time added", `Added **${hours}h** to <@${member.id}>.`)
        .addFields(timeFields(updated))
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }));
      await send(e);
    }
  } catch (e) {
    log.error(`add-time failed: ${e}`);
    const hint =
      e?.code === 50013
        ? "\nThe bot's role must be **above** the access role and have the *Manage Roles* permission."
        : "";
    await send(errorEmbed(cfg, "❌ Error", `${e.message ?? e}${hint}`));
  }
}

// !check-time all : liste de tous les abonnés (staff), triés par temps restant croissant
async function handleCheckTimeAll(message, cfg) {
  const send = sendEmbed(message);
  if (!isStaff(message.member, cfg.staff_role_id)) {
    return send(errorEmbed(cfg, "❌ Permission denied", "You don't have permission to use this command."));
  }

  const subs = await state.db.collection("subscriptions").find({}).toArray();
  if (!subs.length) {
    return send(errorEmbed(cfg, "❌ No active access", "There are no active subscriptions."));
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const rows = subs
    .map((sub) => ({ sub, live: liveSeconds(sub) }))
    .sort((a, b) => a.live.burn - b.live.burn)
    .map(({ sub, live }, i) => {
      const status = sub.frozen
        ? `🔴 frozen — **${fmtSecs(live.burn)}** paused`
        : `⏳ **${fmtSecs(live.burn)}** (<t:${nowTs + live.burn}:R>)`;
      return `**${i + 1}.** <@${sub.discord_id}> — ${status}`;
    });

  // Pagination : une page par embed (limite Discord ~4096 caractères), 5 pages max
  const pages = [];
  let cur = "";
  for (const line of rows) {
    if (cur && cur.length + line.length + 1 > 3500) {
      pages.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) pages.push(cur);

  const MAX_PAGES = 5;
  const shown = pages.slice(0, MAX_PAGES);
  for (let i = 0; i < shown.length; i++) {
    const e = baseEmbed(
      cfg,
      COLOR_BLUE,
      i === 0 ? `⏱️ Remaining time — ${subs.length} member${subs.length === 1 ? "" : "s"}` : "⏱️ Remaining time (continued)",
      shown[i]
    );
    if (i === shown.length - 1 && pages.length > MAX_PAGES) {
      e.addFields({ name: "…", value: "List truncated (too many members)." });
    }
    await send(e);
  }
}

async function handleCheckTime(message, args, cfg) {
  if ((args[0] ?? "").toLowerCase() === "all") return handleCheckTimeAll(message, cfg);
  const send = sendEmbed(message);
  const targetId = parseUserId(args[0]) ?? message.author.id;
  const sub = await state.db.collection("subscriptions").findOne({ discord_id: targetId });

  if (!sub) {
    return send(errorEmbed(cfg, "❌ No active access", `No active access found for <@${targetId}>.`));
  }

  const user = await state.bot.users.fetch(targetId).catch(() => null);
  const e = baseEmbed(
    cfg,
    sub.frozen ? COLOR_RED : COLOR_BLUE,
    "⏱️ Remaining VIP Time",
    `Here is the remaining access time for <@${targetId}> :`
  ).addFields(timeFields(sub));
  if (user) e.setThumbnail(user.displayAvatarURL({ size: 256 }));
  await send(e);
}

// !freeze-time all / !unfreeze-time all : gèle ou dégèle TOUS les abonnés (staff, déjà vérifié) + DM
async function handleFreezeAll(message, cfg, freeze) {
  const send = sendEmbed(message);

  const subs = await state.db.collection("subscriptions").find({}).toArray();
  if (!subs.length) {
    return send(errorEmbed(cfg, "❌ No active access", "There are no active subscriptions."));
  }

  // Gel : seulement ceux qui ne sont pas déjà gelés. Dégel : seulement ceux qui sont gelés.
  const targets = [];
  let skipped = 0;
  for (const sub of subs) {
    if (Boolean(sub.frozen) === freeze) {
      skipped++;
      continue;
    }
    await setFrozenState(sub, freeze);
    await refreshPanel(sub); // met à jour un ancien panel s'il existe encore
    targets.push(sub);
  }

  const skipReason = freeze ? "already frozen" : "not frozen";
  if (!targets.length) {
    return send(
      baseEmbed(cfg, COLOR_BLUE, freeze ? "🧊 Nothing to freeze" : "🟢 Nothing to unfreeze", `${skipped} member(s) skipped (${skipReason}).`)
    );
  }

  let sent = 0;
  let failed = 0;
  for (const sub of targets) {
    try {
      const user = await state.bot.users.fetch(sub.discord_id);
      const dm = (freeze
        ? baseEmbed(
            cfg,
            COLOR_RED,
            "🔴 Time frozen",
            "Staff froze your countdown (maintenance). Your time is paused and will resume when staff unfreezes it."
          )
        : baseEmbed(cfg, COLOR_GREEN, "🟢 Time resumed", "Staff resumed your countdown.")
      )
        .addFields(timeFields(sub))
        .setThumbnail(user.displayAvatarURL({ size: 256 }));
      await user.send({ embeds: [dm] });
      sent++;
    } catch {
      failed++; // DMs fermés, utilisateur introuvable...
    }
    await sleep(250); // évite de saturer l'API Discord
  }

  const n = targets.length;
  let text =
    `✅ Time **${freeze ? "frozen" : "unfrozen"}** for **${n} user${n === 1 ? "" : "s"}** ` +
    `and DM notification sent to: **${sent} user${sent === 1 ? "" : "s"}**`;
  if (failed) text += `\n⚠️ ${failed} DM(s) could not be delivered (DMs closed or user not found). Their state was still changed.`;
  if (skipped) text += `\nℹ️ ${skipped} skipped (${skipReason}).`;
  await send(new EmbedBuilder().setColor(COLOR_GREEN).setDescription(text));
}

// !freeze-time <@member|all> et !unfreeze-time <@member|all> : STAFF uniquement (maintenance).
// Le gel est illimité : pendant le gel, le temps restant ne bouge pas.
async function handleFreezeCommand(message, args, cfg, freeze) {
  const send = sendEmbed(message);
  const cmdName = freeze ? "freeze-time" : "unfreeze-time";

  if (!isStaff(message.member, cfg.staff_role_id)) {
    return send(errorEmbed(cfg, "❌ Permission denied", "Only staff can freeze or unfreeze time."));
  }
  if ((args[0] ?? "").toLowerCase() === "all") return handleFreezeAll(message, cfg, freeze);

  const targetId = parseUserId(args[0]);
  if (!targetId) {
    return send(
      errorEmbed(cfg, "⚠️ Usage", `\`${cfg.prefix}${cmdName} @member\`\n\`${cfg.prefix}${cmdName} all\``)
    );
  }

  const sub = await state.db.collection("subscriptions").findOne({ discord_id: targetId });
  if (!sub) return send(errorEmbed(cfg, "❌ No active access", `No active access found for <@${targetId}>.`));
  if (Boolean(sub.frozen) === freeze) {
    return send(
      baseEmbed(
        cfg,
        COLOR_BLUE,
        freeze ? "🔴 Already frozen" : "🟢 Not frozen",
        freeze ? `<@${targetId}>'s time is already frozen.` : `<@${targetId}>'s time is not frozen.`
      )
    );
  }

  await setFrozenState(sub, freeze);
  await refreshPanel(sub); // met à jour un ancien panel s'il existe encore

  const user = await state.bot.users.fetch(targetId).catch(() => null);
  const e = (freeze
    ? baseEmbed(cfg, COLOR_RED, "🔴 Time frozen", `<@${targetId}>'s countdown is paused.`)
    : baseEmbed(cfg, COLOR_GREEN, "🟢 Time resumed", `<@${targetId}>'s countdown is running again.`)
  ).addFields(timeFields(sub));
  if (user) e.setThumbnail(user.displayAvatarURL({ size: 256 }));
  await send(e);
}

// !help : liste des commandes
async function handleHelp(message, cfg) {
  const p = cfg.prefix;
  const e = baseEmbed(cfg, COLOR_BLUE, "📖 Access Bot — Commands", `Prefix: \`${p}\``).addFields(
    {
      name: `⏱️ \`${p}check-time [@member]\``,
      value: "Shows the remaining access time (yours by default).",
    },
    {
      name: `⏱️ \`${p}check-time all\` (staff only)`,
      value: "Lists the remaining time of every member.",
    },
    {
      name: `🧊 \`${p}freeze-time @member\` (staff only)`,
      value: "Freezes a member's countdown (maintenance, unlimited).",
    },
    {
      name: `🧊 \`${p}freeze-time all\` (staff only)`,
      value: "Freezes every member's countdown and sends them a DM.",
    },
    {
      name: `🟢 \`${p}unfreeze-time @member\` (staff only)`,
      value: "Resumes a member's countdown.",
    },
    {
      name: `🟢 \`${p}unfreeze-time all\` (staff only)`,
      value: "Resumes every member's countdown and sends them a DM.",
    },
    {
      name: `➕ \`${p}add-time @member hours\` (staff only)`,
      value: "Grants access or adds hours to a member.",
    },
    {
      name: `➕ \`${p}add-time all hours\` (staff only)`,
      value: "Adds hours to every member and sends them a DM.",
    }
  );
  if (state.bot?.user) e.setThumbnail(state.bot.user.displayAvatarURL({ size: 256 }));
  await sendEmbed(message)(e);
}

// ---------- Expiration ----------
async function expireSubscription(sub) {
  const db = state.db;
  const uid = sub.discord_id;
  const cfg = await getAccessEffectiveConfig();

  // DM
  try {
    const u = await state.bot.users.fetch(String(uid));
    await u.send(
      "⏰ Your access has expired. Your timer has run out and your access has been removed.\n" +
        "Contact staff if you'd like more time."
    );
  } catch (e) {
    log.warn(`expire DM failed: ${e}`);
  }

  // Retire le rôle access (sur le premier serveur où la personne est membre)
  try {
    for (const g of state.bot.guilds.cache.values()) {
      const member = await g.members.fetch(String(uid)).catch(() => null);
      if (member) {
        const role = g.roles.cache.get(cfg.access_role_id);
        if (role && member.roles.cache.has(role.id)) {
          await member.roles.remove(role, "access expired");
        }
        break;
      }
    }
  } catch (e) {
    log.warn(`expire remove role failed: ${e}`);
  }

  // Marque le panel comme expiré (sans supprimer le salon partagé)
  try {
    if (sub.panel_channel_id && sub.panel_message_id) {
      const ch = await getChannel(sub.panel_channel_id);
      if (ch) {
        const msg = await ch.messages.fetch(String(sub.panel_message_id));
        await msg.edit(expiredView(uid));
      }
    }
  } catch (e) {
    log.warn(`expire panel update failed: ${e}`);
  }

  await db.collection("subscriptions").deleteOne({ discord_id: uid });
  log.info(`access expired for ${uid}`);
}

// Applique `elapsed` secondes de décompte. Retourne true si expiré.
async function tickSubscription(sub, elapsed) {
  const db = state.db;
  const uid = sub.discord_id;
  const frozen = Boolean(sub.frozen);
  const burn = parseInt(sub.burn_seconds ?? 0, 10);

  // Gelé (par le staff, durée illimitée) : le temps ne bouge pas ; sinon on décompte
  const changed = {};
  if (!frozen) changed.burn_seconds = Math.max(0, burn - elapsed);
  changed.last_tick = nowIso();

  await db.collection("subscriptions").updateOne({ discord_id: uid }, { $set: changed });
  Object.assign(sub, changed);

  if (!sub.frozen && parseInt(sub.burn_seconds ?? 0, 10) <= 0) {
    await expireSubscription(sub);
    return true;
  }

  await refreshPanel(sub);
  return false;
}

async function countdownLoop() {
  if (state.countdownActive) return; // évite de lancer deux boucles
  state.countdownActive = true;
  try {
    await sleep(10_000);
    while (state.bot) {
      try {
        const now = Date.now();
        const subs = await state.db.collection("subscriptions").find({}).toArray();
        for (const sub of subs) {
          let elapsed = 60;
          if (sub.last_tick) {
            const prev = parseIsoUtc(sub.last_tick).getTime();
            elapsed = Number.isNaN(prev) ? 60 : Math.floor((now - prev) / 1000);
          }
          elapsed = Math.min(3600, Math.max(1, elapsed));
          await tickSubscription(sub, elapsed);
        }
      } catch (e) {
        log.warn(`countdown loop error: ${e}`);
      }
      await sleep(60_000);
    }
  } finally {
    state.countdownActive = false;
  }
}

// ---------- Routage ----------
function registerMessageHandler(client) {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot || !message.guild || !message.content) return;
      const cfg = await getCachedConfig();
      if (!message.content.startsWith(cfg.prefix)) return;

      const [cmdRaw, ...args] = message.content.slice(cfg.prefix.length).trim().split(/\s+/);
      const cmd = (cmdRaw ?? "").toLowerCase().replace(/-/g, "");

      if (cmd === "addtime") await handleAddTime(message, args, cfg);
      else if (cmd === "checktime") await handleCheckTime(message, args, cfg);
      else if (cmd === "freezetime") await handleFreezeCommand(message, args, cfg, true);
      else if (cmd === "unfreezetime") await handleFreezeCommand(message, args, cfg, false);
      else if (cmd === "help") await handleHelp(message, cfg);
    } catch (err) {
      log.error("message handler error:", err);
    }
  });
}

// Anciens panels : le bouton Freeze n'existe plus (gel réservé au staff). Un vieux bouton encore
// affiché renvoie un message explicatif, puis le panel est remis à jour sans bouton à la minute suivante.
function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith("accessbot:freeze")) {
        await interaction.reply({
          content: "🧊 Freezing time is now reserved to staff (maintenance only).",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      log.error("interaction error:", err);
    }
  });
}

// ---------- Cycle de vie (piloté par le panel admin) ----------
async function buildAndStart(token) {
  // Commandes à préfixe : il faut lire le contenu des messages.
  // => activer "Message Content Intent" dans le portail développeur Discord (Bot > Privileged Gateway Intents)
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // "clientReady" : discord.js 14.22+ (sur les versions plus anciennes, utiliser "ready")
  client.once("clientReady", () => {
    state.status = "online";
    state.lastError = null;
    log.info(`online as ${client.user.tag}`);
    clearOldSlashCommands(client).catch((e) => log.error(e));
    countdownLoop().catch((e) => log.error(e));
  });

  client.on("error", (err) => {
    state.status = "error";
    state.lastError = String(err);
    log.error("client error:", err);
  });

  registerMessageHandler(client);
  registerInteractionHandler(client);

  state.bot = client;
  try {
    await client.login(token);
  } catch (err) {
    try {
      await client.destroy();
    } catch {
      /* ignoré */
    }
    state.bot = null;
    throw err;
  }
}

async function runAccessBot(token) {
  try {
    await buildAndStart(token);
  } catch (err) {
    state.status = "error";
    if (err?.code === "TokenInvalid") {
      state.lastError = "Invalid bot token";
    } else {
      state.lastError = String(err);
      log.error(err);
    }
  }
}

// Retourne { ok, message }
export async function startAccessBot() {
  try {
    if (!state.db) return { ok: false, message: "Database not available" };

    const cfg = await getAccessEffectiveConfig();
    if (!cfg.token) return { ok: false, message: "No token configured" };

    // Sécurité : ne jamais connecter les deux bots avec le même token
    const mainCfg = await getMainBotConfig();
    const mainToken = (mainCfg.token || process.env.DISCORD_TOKEN || "").trim();
    if (mainToken && mainToken === cfg.token) {
      return { ok: false, message: "This is the main bot's token — use a separate Discord application" };
    }

    if (state.status === "online" || state.status === "starting") {
      return { ok: false, message: `Bot already ${state.status}` };
    }
    state.status = "starting";
    state.lastError = null;
    state.task = runAccessBot(cfg.token); // sans attendre
    return { ok: true, message: "starting" };
  } catch (err) {
    state.status = "error";
    state.lastError = String(err);
    log.error(err);
    return { ok: false, message: String(err) };
  }
}

export async function stopAccessBot() {
  if (state.bot) {
    try {
      await state.bot.destroy();
    } catch (e) {
      log.warn(`close failed: ${e}`);
    }
  }
  state.bot = null; // arrête aussi la boucle de décompte
  state.task = null;
  state.status = "stopped";
  return true;
}

export function accessStatus() {
  const b = state.bot;
  return {
    status: state.status,
    last_error: state.lastError,
    bot_user: b?.user?.tag ?? null,
    guilds: b ? b.guilds.cache.size : 0,
  };
}
