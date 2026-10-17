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
//   !check-time [@member]    (tout le monde) affiche le temps restant
//   !freeze-time             gèle / dégèle son propre temps (bascule)
// Nécessite "Message Content Intent" activé dans le portail développeur Discord.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
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
export const ACCESS_CONFIG_KEYS = ["token", "prefix", "access_role_id", "staff_role_id", "panel_channel_id"];

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

// ---------- Vue du panel (temps restant + bouton Freeze) ----------
// L'ID du propriétaire est encodé dans le customId du bouton : seul lui peut
// l'actionner, même si tous les panels sont dans le même salon partagé.
function panelBody(mention, sub) {
  const frozen = Boolean(sub.frozen);
  const statusLine = frozen ? "\u{1F534} `FROZEN`" : "\u{1F7E2} `ACTIVE`";
  return (
    `# \u26A1 Access Panel\n` +
    `${mention}\n\n` +
    `**Time Left**\u2003\`${fmtSecs(sub.burn_seconds ?? 0)}\`\n` +
    `**Freeze Available**\u2003\`${fmtSecs(sub.freeze_seconds ?? 0)}\`\n` +
    `**Status**\u2003${statusLine}`
  );
}

function buildPanelView(discordId, sub) {
  const frozen = Boolean(sub.frozen);
  const mention = `<@${discordId}>`;
  const freezeBtn = new ButtonBuilder()
    .setCustomId(`accessbot:freeze:${discordId}`)
    .setLabel(frozen ? "Unfreeze Time" : "Freeze Time")
    .setStyle(frozen ? ButtonStyle.Danger : ButtonStyle.Primary);
  const container = new ContainerBuilder()
    .setAccentColor(frozen ? 0xe23b3b : 0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(panelBody(mention, sub)))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(freezeBtn));
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

// Réponse à un message sans pinguer personne
const replyTo = (message) => (content) =>
  message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });

async function handleAddTime(message, args, cfg) {
  const say = replyTo(message);

  if (!isStaff(message.member, cfg.staff_role_id)) {
    return say("❌ You don't have permission to use this command.");
  }

  const member = await fetchMember(message.guild, args[0]);
  const hours = parseInt(args[1], 10);
  if (!member || !Number.isInteger(hours) || String(hours) !== String(args[1])) {
    return say(`⚠️ Usage: \`${cfg.prefix}add-time @member hours\``);
  }
  if (hours <= 0) return say("⚠️ Hours must be a positive number.");

  const db = state.db;
  const addSecs = hours * 3600;
  const existing = await db.collection("subscriptions").findOne({ discord_id: member.id });

  try {
    // Donne le rôle access (idempotent : rien ne se passe s'il l'a déjà)
    const role = await message.guild.roles.fetch(cfg.access_role_id).catch(() => null);
    if (role) await member.roles.add(role, `access granted by ${message.author.username}`);

    if (!existing) {
      // Premier octroi : crée l'abonnement (aucun panel n'est posté)
      await db.collection("subscriptions").insertOne({
        discord_id: member.id,
        username: member.user.username,
        burn_seconds: addSecs,
        freeze_seconds: addSecs,
        frozen: false,
        last_tick: nowIso(),
      });
      await say(`✅ Access granted to <@${member.id}> (${hours}h)`);
    } else {
      // Déjà abonné : ajoute les heures (1:1 sur le temps et le freeze disponible)
      await db.collection("subscriptions").updateOne(
        { discord_id: member.id },
        { $inc: { burn_seconds: addSecs, freeze_seconds: addSecs } }
      );
      const updated = await db.collection("subscriptions").findOne({ discord_id: member.id });
      await refreshPanel(updated); // met à jour un ancien panel s'il existe encore, sinon rien
      await say(
        `✅ Added \`${hours}h\` to <@${member.id}>.\n` +
          `New balance — Time: \`${fmtSecs(updated.burn_seconds ?? 0)}\`, ` +
          `Freeze: \`${fmtSecs(updated.freeze_seconds ?? 0)}\``
      );
    }
  } catch (e) {
    log.error(`add-time failed: ${e}`);
    await say(`❌ Error: ${e.message ?? e}`);
  }
}

async function handleCheckTime(message, args) {
  const say = replyTo(message);
  const targetId = parseUserId(args[0]) ?? message.author.id;
  const sub = await state.db.collection("subscriptions").findOne({ discord_id: targetId });

  if (!sub) return say(`No active access found for <@${targetId}>.`);

  const frozen = Boolean(sub.frozen);
  await say(
    `**<@${targetId}>**\n` +
      `Time left: \`${fmtSecs(sub.burn_seconds ?? 0)}\`\n` +
      `Freeze available: \`${fmtSecs(sub.freeze_seconds ?? 0)}\`\n` +
      `Status: ${frozen ? "🔴 FROZEN" : "🟢 ACTIVE"}`
  );
}

// !freeze-time : gèle / dégèle SON propre temps (bascule)
async function handleFreezeTime(message) {
  const say = replyTo(message);
  const db = state.db;
  const ownerId = message.author.id;
  const sub = await db.collection("subscriptions").findOne({ discord_id: ownerId });
  if (!sub) return say("No active access found.");

  const frozen = Boolean(sub.frozen);
  if (!frozen && parseInt(sub.freeze_seconds ?? 0, 10) <= 0) {
    return say("You have no freeze time left.");
  }

  const newFrozen = !frozen;
  await db
    .collection("subscriptions")
    .updateOne({ discord_id: ownerId }, { $set: { frozen: newFrozen, last_tick: nowIso() } });
  sub.frozen = newFrozen;
  await refreshPanel(sub); // met à jour un ancien panel s'il existe encore

  await say(
    newFrozen
      ? `🔴 Your time is now **frozen**. Freeze available: \`${fmtSecs(sub.freeze_seconds ?? 0)}\`. Use the same command again to unfreeze.`
      : `🟢 Your time is **active** again. Time left: \`${fmtSecs(sub.burn_seconds ?? 0)}\`.`
  );
}

// ---------- Bouton Freeze ----------
async function handleFreezeButton(interaction, ownerId) {
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ This isn't your panel — you can only freeze your own time.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();
  const db = state.db;
  const sub = await db.collection("subscriptions").findOne({ discord_id: ownerId });
  if (!sub) {
    return interaction.followUp({
      content: "No active access found.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const frozen = Boolean(sub.frozen);
  if (!frozen && parseInt(sub.freeze_seconds ?? 0, 10) <= 0) {
    return interaction.followUp({
      content: "You have no freeze time left.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const newFrozen = !frozen;
  await db
    .collection("subscriptions")
    .updateOne({ discord_id: ownerId }, { $set: { frozen: newFrozen, last_tick: nowIso() } });
  sub.frozen = newFrozen;

  try {
    await interaction.editReply(buildPanelView(ownerId, sub));
  } catch (e) {
    log.warn(`freeze editReply failed: ${e}`);
  }
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
  const freeze = parseInt(sub.freeze_seconds ?? 0, 10);

  const changed = {};
  if (frozen) {
    const newFreeze = Math.max(0, freeze - elapsed);
    changed.freeze_seconds = newFreeze;
    if (newFreeze === 0) changed.frozen = false; // fin du gel : le décompte reprend
  } else {
    changed.burn_seconds = Math.max(0, burn - elapsed);
  }
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
      else if (cmd === "checktime") await handleCheckTime(message, args);
      else if (cmd === "freezetime") await handleFreezeTime(message);
    } catch (err) {
      log.error("message handler error:", err);
    }
  });
}

// Boutons Freeze des anciens panels déjà postés (plus créés par le bot)
function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isButton()) {
        const parts = interaction.customId.split(":");
        if (parts[0] === "accessbot" && parts[1] === "freeze") {
          await handleFreezeButton(interaction, parts[2]);
        }
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
