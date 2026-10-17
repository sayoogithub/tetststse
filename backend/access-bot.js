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
// Commandes :
//   /add-time member hours   (staff) crée ou ajoute des heures, donne le rôle d'accès,
//                            poste/édite le panel dans le salon partagé
//   /check-time [member]     (tout le monde) affiche le temps restant, en éphémère
//   bouton "Freeze Time"     sur chaque panel : chacun ne peut geler/dégeler que SON temps

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  GatewayIntentBits,
  MessageFlags,
  SeparatorBuilder,
  SlashCommandBuilder,
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
export const ACCESS_CONFIG_KEYS = ["token", "panel_channel_id", "access_role_id", "staff_role_id"];

// Valeurs enregistrées en base (vides = "utiliser la variable d'environnement / le défaut")
export async function getAccessConfig() {
  const doc = await state.db.collection("settings").findOne({ key: CONFIG_KEY });
  return {
    token: "",
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
  return current;
}

// Valeurs réellement utilisées : base > variable d'environnement > défaut
export async function getAccessEffectiveConfig() {
  const c = await getAccessConfig();
  return {
    token: (c.token || process.env.ACCESS_BOT_TOKEN || "").trim(),
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
        `# \u23F0 Access Expired\n<@${discordId}>\n\nThis access has run out. Use \`/add-time\` to grant more.`
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

// ---------- /add-time et /check-time ----------
function slashCommandDefs() {
  return [
    new SlashCommandBuilder()
      .setName("add-time")
      .setDescription("Grant or add access time to a user")
      .addUserOption((o) => o.setName("member").setDescription("Target user").setRequired(true))
      .addIntegerOption((o) => o.setName("hours").setDescription("Hours to grant/add").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("check-time")
      .setDescription("Check remaining access time")
      .addUserOption((o) => o.setName("member").setDescription("User to check (default: you)").setRequired(false))
      .toJSON(),
  ];
}

async function syncCommands(client) {
  const defs = slashCommandDefs();
  try {
    for (const g of client.guilds.cache.values()) {
      await g.commands.set(defs);
      log.info(`synced commands to guild ${g.id}`);
    }
    await client.application.commands.set([]); // vide les commandes globales pour éviter les doublons
  } catch (e) {
    log.warn(`slash sync failed: ${e}`);
  }
}

async function handleAddTime(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const say = (content) => interaction.editReply({ content });

  const cfg = await getAccessEffectiveConfig();
  if (!isStaff(interaction.member, cfg.staff_role_id)) {
    return say("❌ You don't have permission to use this command.");
  }

  const guild = interaction.guild;
  const member = interaction.options.getMember("member");
  const hours = interaction.options.getInteger("hours", true);
  if (!member) return say("❌ Member not found in this server.");
  if (hours <= 0) return say("⚠️ Hours must be a positive number.");

  if (!cfg.panel_channel_id) {
    return say("❌ The shared panel channel is not configured (admin panel → Access bot).");
  }
  const channel = await getChannel(cfg.panel_channel_id);
  if (!channel) return say("❌ Shared panel channel not found.");

  const db = state.db;
  const addSecs = hours * 3600;
  const existing = await db.collection("subscriptions").findOne({ discord_id: member.id });

  try {
    // Donne le rôle access (idempotent : rien ne se passe s'il l'a déjà)
    const role = await guild.roles.fetch(cfg.access_role_id).catch(() => null);
    if (role) await member.roles.add(role, `access granted by ${interaction.user.username}`);

    if (!existing) {
      // Premier octroi : crée l'abonnement + poste le panel
      const sub = {
        discord_id: member.id,
        username: member.user.username,
        burn_seconds: addSecs,
        freeze_seconds: addSecs,
        frozen: false,
        panel_channel_id: channel.id,
        last_tick: nowIso(),
      };
      const msg = await channel.send(buildPanelView(member.id, sub));
      sub.panel_message_id = msg.id;
      await db.collection("subscriptions").insertOne({ ...sub });
      await say(`✅ Access granted to <@${member.id}> (${hours}h) in <#${channel.id}>`);
    } else {
      // Déjà abonné : ajoute les heures (1:1 sur le temps et le freeze disponible)
      await db.collection("subscriptions").updateOne(
        { discord_id: member.id },
        { $inc: { burn_seconds: addSecs, freeze_seconds: addSecs } }
      );
      const updated = await db.collection("subscriptions").findOne({ discord_id: member.id });
      const refreshed = await refreshPanel(updated);
      if (!refreshed) {
        // le panel a disparu (supprimé à la main) : on en repost un
        const msg = await channel.send(buildPanelView(member.id, updated));
        await db.collection("subscriptions").updateOne(
          { discord_id: member.id },
          { $set: { panel_channel_id: channel.id, panel_message_id: msg.id } }
        );
      }
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

async function handleCheckTime(interaction) {
  const target = interaction.options.getUser("member") ?? interaction.user;
  const sub = await state.db.collection("subscriptions").findOne({ discord_id: target.id });

  if (!sub) {
    return interaction.reply({
      content: `No active access found for <@${target.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const frozen = Boolean(sub.frozen);
  await interaction.reply({
    content:
      `**<@${target.id}>**\n` +
      `Time left: \`${fmtSecs(sub.burn_seconds ?? 0)}\`\n` +
      `Freeze available: \`${fmtSecs(sub.freeze_seconds ?? 0)}\`\n` +
      `Status: ${frozen ? "🔴 FROZEN" : "🟢 ACTIVE"}`,
    flags: MessageFlags.Ephemeral,
  });
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

// ---------- Routage des interactions ----------
function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "add-time") await handleAddTime(interaction);
        else if (interaction.commandName === "check-time") await handleCheckTime(interaction);
        return;
      }

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
  // Seul l'intent Guilds est nécessaire (slash commands + boutons, pas de commandes à préfixe)
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // "clientReady" : discord.js 14.22+ (sur les versions plus anciennes, utiliser "ready")
  client.once("clientReady", () => {
    state.status = "online";
    state.lastError = null;
    log.info(`online as ${client.user.tag}`);
    syncCommands(client).catch((e) => log.error(e));
    countdownLoop().catch((e) => log.error(e));
  });

  client.on("error", (err) => {
    state.status = "error";
    state.lastError = String(err);
    log.error("client error:", err);
  });

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
