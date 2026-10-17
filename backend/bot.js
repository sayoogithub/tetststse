// bot.js : version JavaScript complète (discord.js v14.19+ et driver mongodb v6+)
// npm install discord.js@latest mongodb
// package.json : "type": "module"
//
// Variables d'environnement : MONGO_URL, DB_NAME, DISCORD_TOKEN (facultatif si le token est dans la config en base)
//
// NOTE : l'auto-start en bas de fichier est désactivé car c'est server.js qui pilote
// startBot()/stopBot(). Si tu utilises bot.js seul, décommente la dernière section.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SeparatorBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  parseEmoji,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

// ---------- Logger (équivalent de logging.getLogger("bot")) ----------
export const log = {
  info: (...a) => console.log("[bot][INFO]", ...a),
  warn: (...a) => console.warn("[bot][WARN]", ...a),
  error: (...a) => console.error("[bot][ERROR]", ...a),
};

// ---------- Constantes ----------
// Les IDs Discord sont des chaînes : ils dépassent la précision d'un Number JS (2^53).
export const FREEZE_EMOJI = "<:ban:1542637913630838825>";
export const SEARCH_EMOJI = "<:search:1542638128463089826>";
export const WORLD_EMOJI = "<:world:1542638077133193296>";
export const ALERT_EMOJI = "<a:Alert:1537938372822040716>";
export const FLASH_EMOJI = "<a:Flash:1542636354192805888>";
export const SHOP_EMOJI = "<a:shopping:1537938659716894731>";
export const CALL_EMOJI = "<:call:1543572200643240016>";
export const BELL_EMOJI = "<:bell:1542637989908320277>";
export const BAN_EMOJI = "<:ban:1542637913630838825>";
export const EDIT_EMOJI = "<:edit:1542638029309616128>";
export const PLUS_EMOJI = "<:plus:1543572780136792134>";
export const WARN_EMOJI = "⚠️"; // WARN_EMOJI n'était pas dans l'extrait (seulement WARN_EMOJI2)

// ----- Système de tickets -----
export const TICKET_PANEL_CHANNEL_ID = "1560726846461448202";
export const TICKET_SUPPORT_CATEGORY_ID = "1560726802022793226";
export const TICKET_PURCHASE_CATEGORY_ID = "1560726814756970516";
export const TICKET_EMOJI = "<:ticket:1542791337785425991>";
export const MONEY_EMOJI2 = "<:money:1542638222029361212>";
export const GUIDE_EMOJI = "<:guide:1542638280858669156>";
export const SHOP_EMOJI2 = "<a:shopping:1537938659716894731>";
export const WARN_EMOJI2 = "<a:warnings:1537938330946240612>";
export const LTC_ADDRESS = "Lf5iRNRbxKjB9bLFgk6cuTS4To6Pzs37iz";

export const TICKET_PLANS = [
  { key: "12h", label: "12h", usd: 5 },
  { key: "24h", label: "24h", usd: 10 },
  { key: "48h", label: "48h", usd: 20 },
  { key: "life", label: "Lifetime", usd: 450 },
];

export const STAFF_ROLE_ID = "1558233114269061200"; // seul ce rôle peut utiliser /timer et /add
export const BUYER_ROLE_ID = "1538144743505268748"; // attribué automatiquement à la cible de /timer et /add

// ----- Files d'attente par pays -----
export const QUEUE_COUNTRY_NAMES = { FR: "France", BE: "Belgium", BG: "Bulgaria" };
export const QUEUE_COUNTRY_CODES = ["FR", "BE", "BG"];

// ---------- État global (singleton) ----------
// `loop` n'existe plus : Node a une seule boucle d'événements.
export const state = {
  bot: null,
  task: null,
  status: "stopped", // stopped | starting | online | error
  lastError: null,
  db: null,
  mongo: null,
};

// ---------- Base de données ----------
export async function connectDb() {
  state.mongo = new MongoClient(process.env.MONGO_URL);
  await state.mongo.connect();
  state.db = state.mongo.db(process.env.DB_NAME);
}

// ---------- Config (stockée en base) ----------
const DEFAULT_CONFIG = {
  token: "",
  notify_channel_id: "", // salon partagé : Number non routés + Number routés depuis la file (bouton claim)
  logs_channel_id: "",
  leaderboard_channel_id: "",
  leaderboard_message_id: "",
  leaderboard_title: "",
  leaderboard_desc: "",
  leaderboard_color: 0xfacc15,
  broadcast_channel_id: "",
  broadcast_title: "",
  broadcast_desc: "",
  broadcast_color: 0xfacc15,
  footer_text: "",
  maintenance_mode: false,
  maintenance_title: "🛠 Maintenance in progress",
  maintenance_desc:
    "The bot is temporarily down for maintenance. All requests are paused.",
  back_online_title: "✅ We're back",
  back_online_desc: "Maintenance is over. Everything is operational again.",
  ping_role_ids: [], // rôles à ping sur nouveau numéro
  ok_role_id: "", // rôle autorisé à appuyer sur OK
  embed_color: 0xfacc15,
  embed_title: "",
  embed_desc: "",
  ok_button_label: "OK",
  ok_button_style: "success", // primary/secondary/success/danger
  ok_button_emoji: "✅",
  hh_button_label: "",
  hh_button_style: "primary",
  hh_button_emoji: "",
  // ----- Timer role (!timer) -----
  timer_channel_id: "",
  timer_role_id: "",
  timer_role_label: "", // ligne tronquée dans le code d'origine
};

export async function getConfig() {
  const doc = await state.db
    .collection("settings")
    .findOne({ key: "bot_config" });
  const defaults = structuredClone(DEFAULT_CONFIG);
  if (!doc) return defaults;
  return { ...defaults, ...(doc.value ?? {}) };
}

export async function saveConfig(patch = {}) {
  const current = { ...(await getConfig()), ...patch };
  await state.db
    .collection("settings")
    .updateOne(
      { key: "bot_config" },
      { $set: { value: current } },
      { upsert: true }
    );
  return current;
}

// ---------- Helpers ----------
export function styleMap(name) {
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
  };
  return styles[name] ?? ButtonStyle.Success;
}

// Format équivalent à datetime.now(timezone.utc).isoformat() ("+00:00" au lieu de "Z"),
// pour que Python (fromisoformat avant 3.11) puisse encore relire ces dates.
export function nowIso() {
  return new Date().toISOString().replace("Z", "+00:00");
}

// Parse une date ISO ; sans fuseau explicite, on la considère en UTC (comme le code Python)
export function parseIsoUtc(s) {
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s) : new Date(`${s}Z`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Views (Components V2) ----------
// Remplace la classe NumberView. Usage : channel.send(buildNumberView(user, cfg))
// Un message Components V2 ne peut contenir ni `content` ni `embeds`.
export function buildNumberView(user, cfg, claimedBy = null) {
  const desc =
    cfg.embed_desc || "A new Number just came in. Press the button to claim it.";
  const accent = claimedBy ? 0x22c55e : cfg.embed_color ?? 0xfacc15;

  const nick = user.nickname ?? "?";
  const geo = user.geo ?? {};
  const country = geo.country ?? "?";
  const city = geo.city ?? "?";

  let body =
    `# ${ALERT_EMOJI} New Number received\n` +
    `${desc}\n\n` +
    `**Nickname**\u2003\`${nick}\`\n` +
    `**Country**\u2003${country}\n` +
    `**City**\u2003${city}`;

  if (claimedBy) body += `\n\n${FLASH_EMOJI} Claimed by ${claimedBy}`;

  const ft = (cfg.footer_text ?? "").trim();
  if (ft) body += `\n\n-# ${ft}`;

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder());

  let button;
  if (!claimedBy) {
    button = new ButtonBuilder()
      .setCustomId(`snap_ok:${user.id}`)
      .setLabel(cfg.ok_button_label || "OK")
      .setStyle(styleMap(cfg.ok_button_style ?? "success"));

    const emoji = (cfg.ok_button_emoji ?? "").trim();
    if (emoji) {
      try {
        button.setEmoji(emoji);
      } catch {
        /* emoji invalide : ignoré comme en Python */
      }
    }
  } else {
    button = new ButtonBuilder()
      .setCustomId("snap_claimed_done")
      .setLabel("Claimed")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(FLASH_EMOJI)
      .setDisabled(true);
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(button)
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ---------- DM "Number claimed" (Components V2) ----------
function claimedBody(u, cfg, asked = false) {
  const geo = u.geo ?? {};
  let body =
    `# ${SHOP_EMOJI} Number claimed\n` +
    `**Nickname**\u2003\`${u.nickname ?? "?"}\`\n` +
    `**phone**\u2003\`${u.phone ?? "?"}\`\n` +
    `**Location**\u2003${geo.city ?? "?"}, ${geo.country ?? "?"}`;

  if (asked) {
    body += `\n\n${CALL_EMOJI} otp requested \u2014 waiting for the user to type the username.`;
  }
  const ft = (cfg.footer_text ?? "").trim();
  if (ft) body += `\n\n-# ${ft}`;
  return body;
}

// Remplace la classe ClaimedView (+ otpButton).
// Usage : user.send(ClaimedView(u, cfg)) ou interaction.editReply(ClaimedView(u, cfg, true))
export function ClaimedView(u, cfg, asked = false) {
  const container = new ContainerBuilder()
    .setAccentColor(cfg.embed_color ?? 0xfacc15)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(claimedBody(u, cfg, asked))
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const button = asked
    ? new ButtonBuilder()
        .setCustomId("snap_otp_done")
        .setLabel("Asked for otp")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(CALL_EMOJI)
        .setDisabled(true)
    : new ButtonBuilder()
        .setCustomId(`snap_otp:${u.id}`)
        .setLabel("Ask otp")
        .setStyle(ButtonStyle.Primary)
        .setEmoji(CALL_EMOJI);

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(button)
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// ---------- Helpers salons ----------
// get_channel + fetch_channel en un seul appel (discord.js utilise le cache d'abord)
async function getChannel(id) {
  try {
    return await state.bot.channels.fetch(String(id));
  } catch {
    return null;
  }
}

// ---------- Logs ----------
export async function logAction(text) {
  const cfg = await getConfig();
  const chId = (cfg.logs_channel_id ?? "").trim();
  if (!chId || !state.bot) return;
  try {
    const ch = await getChannel(chId);
    await ch.send(text);
  } catch (e) {
    log.warn(`logAction failed: ${e}`);
  }
}

// ---------- Routage d'un Number vers la file d'attente ----------
// Modifié : l'Number "claim" du premier de la file n'est plus posté dans son salon privé,
// mais dans le salon PARTAGÉ (cfg.notify_channel_id), visible par tout le monde, où tout
// le monde peut cliquer "OK" (premier clic gagnant, réservation atomique en base).
async function routeNumberToQueue(user, cfg) {
  const db = state.db;
  const country = (user.country_code ?? "").toUpperCase();
  if (!Object.hasOwn(QUEUE_COUNTRY_NAMES, country)) return false;

  // premier de la file pour ce pays
  const [entry] = await db
    .collection("queue_entries")
    .find({ country, status: "pending" })
    .sort({ joined_at: 1 })
    .limit(1)
    .toArray();
  if (!entry) return false;
  const uid = entry.user_id;

  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  if (!sub) {
    // la personne n'a plus de panel : on supprime l'entrée périmée
    await db.collection("queue_entries").deleteOne({ _id: entry._id });
    return false;
  }

  // Salon partagé où TOUS les Number avec bouton claim apparaissent
  const claimChanId = (cfg.notify_channel_id ?? "").trim();
  if (!claimChanId) return false;
  const claimCh = await getChannel(claimChanId);
  if (!claimCh) return false;

  // Poste le panel "New Number" dans le salon partagé
  try {
    await claimCh.send(buildNumberView(user, cfg));
  } catch (e) {
    log.warn(`route_Number send failed: ${e}`);
    return false;
  }

  // DM : un Number est prêt, à claim dans le salon partagé
  try {
    const uDisc = await state.bot.users.fetch(String(uid));
    const name = QUEUE_COUNTRY_NAMES[country] ?? country;
    const container = new ContainerBuilder()
      .setAccentColor(0x22c55e)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${ALERT_EMOJI} A Number is ready \u2014 ${name}\n` +
            `Head to <#${claimChanId}> and claim it now.`
        )
      );
    await uDisc.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    log.warn(`route_Number DM failed: ${e}`);
  }

  // Retire la personne de la file et fait avancer les suivants
  await db.collection("queue_entries").deleteOne({ _id: entry._id });
  await advanceQueue(country);

  // Remet son panel "file d'attente" sur Join Queue (elle n'attend plus)
  try {
    const qmid = sub.queue_panel_message_id;
    const cmid = sub.panel_channel_id;
    if (qmid && cmid) {
      const ch = await getChannel(cmid);
      if (ch) {
        const qmsg = await ch.messages.fetch(String(qmid));
        await qmsg.edit(buildJoinQueueView(Boolean(sub.frozen)));
      }
    }
  } catch (e) {
    log.warn(`queue panel reset failed: ${e}`);
  }

  await logAction(`\u{1F3AF} Number routed to shared channel for <@${uid}> (${country})`);
  return true;
}

// ---------- Appelé par votre API HTTP après une inscription ----------
// Retourne { ok, message } (en Python : un tuple (bool, str)).
export async function notifyNewRegistration(user) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "bot offline" };
  }
  const cfg = await getConfig();

  // Essaie d'abord de router l'Number vers le premier de la file du pays
  try {
    if (await routeNumberToQueue(user, cfg)) {
      return { ok: true, message: "routed to queue" };
    }
  } catch (e) {
    log.warn(`route_Number_to_queue error: ${e}`);
  }

  const chId = (cfg.notify_channel_id ?? "").trim();
  if (!chId) return { ok: false, message: "no channel" };

  try {
    const ch = await getChannel(chId);
    const roleIds = (cfg.ping_role_ids ?? []).filter(Boolean);
    if (roleIds.length) {
      const mentions = roleIds.map((rid) => `<@&${rid}>`).join(" ");
      await ch.send({
        content: `||${mentions}||`,
        allowedMentions: { parse: ["roles"] },
      });
    }
    await ch.send(buildNumberView(user, cfg));
    return { ok: true, message: "sent" };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

// ---------- Appelé par votre API HTTP quand le code otp est soumis ----------
export async function notifyCodeSubmitted(user, code) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "bot offline" };
  }
  const cfg = await getConfig();
  const presserId = user.discord_presser_id;

  try {
    if (presserId) {
      const uDisc = await state.bot.users.fetch(String(presserId));
      const embed = new EmbedBuilder()
        .setTitle("🎯 otp received")
        .setDescription(`**User:** \`${user.nickname}\`\n**phone:** \`${user.phone}\``)
        .setColor(0x22c55e)
        .addFields({ name: "Code", value: `\`\`\`${code}\`\`\``, inline: false });

      const ft = (cfg.footer_text ?? "").trim();
      if (ft) embed.setFooter({ text: ft });

      await uDisc.send({ embeds: [embed] });
    }

    await logAction(
      `📨 Code \`${code}\` received for \`${user.nickname}\`` +
        (presserId ? ` — DM sent to <@${presserId}>` : "")
    );
    return { ok: true, message: "sent" };
  } catch (e) {
    log.warn(`notify_code_submitted failed: ${e}`);
    return { ok: false, message: String(e) };
  }
}

// ---------- Callback du bouton OK ----------
export async function handleOkButton(interaction, userId) {
  // On accuse réception tout de suite (Discord exige une réponse sous 3 s).
  // La suite répond avec followUp (éphoneémère) ou editReply (message d'origine).
  await interaction.deferUpdate();

  const ephoneemeral = { flags: MessageFlags.Ephoneemeral };
  const cfg = await getConfig();
  const db = state.db;

  // maintenance
  if (cfg.maintenance_mode) {
    return interaction.followUp({
      content: "🛠 The bot is in maintenance mode. Please try again later.",
      ...ephoneemeral,
    });
  }

  // vérification du rôle
  const okRole = (cfg.ok_role_id ?? "").trim();
  if (okRole) {
    const hasRole = interaction.member?.roles?.cache?.has(okRole);
    if (!hasRole) {
      return interaction.followUp({
        content: "❌ You don't have permission to claim this ticket.",
        ...ephoneemeral,
      });
    }
  }

  // CLAIM ATOMIQUE : seul le premier clic gagne
  const claimed = await db.collection("users").findOneAndUpdate(
    { id: userId, discord_presser_id: { $in: [null, ""] } },
    {
      $set: {
        discord_presser_id: interaction.user.id,
        updated_at: nowIso(),
      },
    },
    { returnDocument: "after" }
  );

  if (!claimed) {
    const existing = await db
      .collection("users")
      .findOne({ id: userId }, { projection: { _id: 0, discord_presser_id: 1 } });
    const other = existing?.discord_presser_id;
    return interaction.followUp({
      content: other
        ? `⚠️ Already claimed by <@${other}>.`
        : "⚠️ Already claimed.",
      ...ephoneemeral,
    });
  }

  const u = claimed;

  // DM : si impossible, on libère le claim
  try {
    await interaction.user.send(ClaimedView(u, cfg));
  } catch (err) {
    if (err.code === 50007) {
      await db
        .collection("users")
        .updateOne({ id: userId }, { $set: { discord_presser_id: null } });
      return interaction.followUp({
        content:
          "⚠️ I can't DM you. Enable DMs from server members. Claim released.",
        ...ephoneemeral,
      });
    }
    throw err;
  }

  // incrément du leaderboard (après le DM réussi, pour ne pas fausser le classement)
  await db.collection("presser_stats").updateOne(
    { discord_id: interaction.user.id },
    {
      $inc: { ok_count: 1 },
      $set: { username: interaction.user.username, last_at: nowIso() },
    },
    { upsert: true }
  );

  // log
  await logAction(
    `✅ <@${interaction.user.id}> pressed **OK** for \`${u.nickname}\``
  );

  // édition du message d'origine
  try {
    await interaction.editReply(
      buildNumberView(u, cfg, `<@${interaction.user.id}>`)
    );
  } catch (e) {
    log.warn(`editReply failed: ${e}`);
    await interaction
      .followUp({ content: "claimed.", ...ephoneemeral })
      .catch(() => {});
  }

  // refresh du leaderboard sans attendre (équivalent de asyncio.create_task)
  refreshLeaderboard().catch((e) => log.error(e));
}

// ---------- Callback du bouton "Ask otp" (dans le DM) ----------
export async function handleotpButton(interaction, userId) {
  await interaction.deferUpdate();

  const cfg = await getConfig();
  if (cfg.maintenance_mode) {
    return interaction.followUp({
      content: "🛠 The bot is in maintenance mode. Please try again later.",
      flags: MessageFlags.Ephoneemeral,
    });
  }

  const db = state.db;
  const u = await db.collection("users").findOne({ id: userId });
  if (!u) {
    return interaction.followUp({
      content: "User not found.",
      flags: MessageFlags.Ephoneemeral,
    });
  }

  await db
    .collection("users")
    .updateOne(
      { id: userId },
      { $set: { state: "code", updated_at: nowIso() } }
    );

  try {
    await interaction.editReply(ClaimedView(u, cfg, true));
  } catch (e) {
    log.warn(`editReply (otp) failed: ${e}`);
  }

  await logAction(
    `🔑 <@${interaction.user.id}> pressed **otp** for \`${u.nickname}\``
  );
}

// ---------- otp : panel de vérification (DM à l'admin) ----------
function otpBody(nickname, phone, code, cfg) {
  let body =
    `# ${BELL_EMOJI} otp received\n` +
    `**User**\u2003\`${nickname}\`\n` +
    `**phone**\u2003\`${phone}\`\n\n` +
    `**Code**\n\`\`\`${code}\`\`\``;
  const ft = (cfg.footer_text ?? "").trim();
  if (ft) body += `\n-# ${ft}`;
  return body;
}

function otpResultBody(title, nickname, phone, extra = "") {
  let body =
    `# ${title}\n` +
    `**User**\u2003\`${nickname}\`\n` +
    `**phone**\u2003\`${phone}\``;
  if (extra) body += `\n\n${extra}`;
  return body;
}

// Remplace otpResultView : état final après DECLINE / RETRY / SUCCESS (sans boutons)
export function buildotpResultView(title, nickname, phone, accent, extra = "") {
  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        otpResultBody(title, nickname, phone, extra)
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Remplace otpVerificationView : 3 boutons dans le container.
// L'id de l'utilisateur est mis dans le customId (snap_decline:<id>, etc.) car il
// n'y a plus d'instance de classe pour le mémoriser. Le nickname et le phone sont
// relus en base au clic : les boutons marchent aussi après un redémarrage du bot.
export function buildotpVerificationView(userId, nickname, phone, code = "", cfg = {}) {
  const declineBtn = new ButtonBuilder()
    .setCustomId(`snap_decline:${userId}`)
    .setLabel("DECLINE")
    .setStyle(ButtonStyle.Danger)
    .setEmoji(BAN_EMOJI);
  const retryBtn = new ButtonBuilder()
    .setCustomId(`snap_retry:${userId}`)
    .setLabel("RETRY")
    .setStyle(ButtonStyle.Primary)
    .setEmoji(EDIT_EMOJI);
  const successBtn = new ButtonBuilder()
    .setCustomId(`snap_success:${userId}`)
    .setLabel("SUCCESS")
    .setStyle(ButtonStyle.Success)
    .setEmoji(PLUS_EMOJI);

  const container = new ContainerBuilder()
    .setAccentColor(0x22c55e)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(otpBody(nickname, phone, code, cfg))
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(declineBtn, retryBtn, successBtn)
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Relit l'utilisateur en base ; répond en éphoneémère s'il n'existe pas
async function loadotpUser(interaction, userId) {
  const u = await state.db.collection("users").findOne({ id: userId });
  if (!u) {
    await interaction.followUp({
      content: "User not found.",
      flags: MessageFlags.Ephoneemeral,
    });
  }
  return u;
}

// DECLINE : ouvre le modal (showModal doit être la toute première réponse, pas de defer avant)
export async function handleDeclineButton(interaction, userId) {
  const modal = new ModalBuilder()
    .setCustomId(`snap_decline_modal:${userId}`)
    .setTitle("Decline Number")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Write a comment (optional)")
          .setPlaceholder("Why are you declining this Number?")
          .setStyle(TextInputStyle.Paragraphone)
          .setMaxLength(500)
          .setRequired(false)
      )
    );
  await interaction.showModal(modal);
}

// Soumission du modal (DeclineReasonModal.on_submit)
export async function handleDeclineModal(interaction, userId) {
  await interaction.deferUpdate();

  const db = state.db;
  const u = await loadotpUser(interaction, userId);
  if (!u) return;

  const comment = (interaction.fields.getTextInputValue("reason") ?? "").trim();

  await db.collection("users").updateOne(
    { id: userId },
    {
      $set: {
        state: "declined",
        decline_reason: comment,
        declined_by_id: interaction.user.id,
        updated_at: nowIso(),
      },
    }
  );
  await db.collection("action_logs").insertOne({
    id: randomUUID(),
    action: "USER_DECLINED",
    user_id: userId,
    username: u.nickname,
    phone: u.phone,
    reason: comment,
    discord_user_id: interaction.user.id,
    discord_username: interaction.user.username,
    created_at: nowIso(),
  });
  await logAction(
    `USER_DECLINED, <@${interaction.user.id}>, (${comment || "no comment"}) — \`${u.nickname}\``
  );

  try {
    const extra = comment ? `Comment: ${comment}` : "";
    await interaction.editReply(
      buildotpResultView(`${BAN_EMOJI} Declined`, u.nickname, u.phone, 0xef4444, extra)
    );
  } catch {
    await interaction
      .followUp({ content: "❌ Declined.", flags: MessageFlags.Ephoneemeral })
      .catch(() => {});
  }
}

// RETRY
export async function handleRetryButton(interaction, userId) {
  await interaction.deferUpdate();

  const db = state.db;
  const u = await loadotpUser(interaction, userId);
  if (!u) return;

  await db.collection("users").updateOne(
    { id: userId },
    {
      $set: {
        state: "code",
        code_submitted: null,
        error_message: "Wrong",
        updated_at: nowIso(),
      },
    }
  );
  await db.collection("action_logs").insertOne({
    id: randomUUID(),
    action: "RETRY_CODE",
    user_id: userId,
    username: u.nickname,
    phone: u.phone,
    discord_user_id: interaction.user.id,
    created_at: nowIso(),
  });
  await logAction(
    `RETRY_CODE, <@${interaction.user.id}> \u2014 \`${u.nickname}\``
  );

  try {
    await interaction.editReply(
      buildotpResultView(
        `${EDIT_EMOJI} Retry requested`,
        u.nickname,
        u.phone,
        0x3b82f6,
        "The user has been sent back to the code form. No new code was generated \u2014 they re-enter the one they already got."
      )
    );
  } catch (e) {
    log.warn(`retry editReply failed: ${e}`);
  }
}

// SUCCESS
export async function handleSuccessButton(interaction, userId) {
  await interaction.deferUpdate();

  const db = state.db;
  const u = await loadotpUser(interaction, userId);
  if (!u) return;

  await db.collection("users").updateOne(
    { id: userId },
    {
      $set: {
        state: "success",
        approved_by_admin: interaction.user.username,
        approved_by_id: interaction.user.id,
        verified_at: nowIso(),
        updated_at: nowIso(),
      },
    }
  );
  await db.collection("action_logs").insertOne({
    id: randomUUID(),
    action: "ADMIN_APPROVED",
    user_id: userId,
    username: u.nickname,
    phone: u.phone,
    approved_by: interaction.user.username,
    discord_user_id: interaction.user.id,
    created_at: nowIso(),
  });
  await logAction(
    `ADMIN_APPROVED, <@${interaction.user.id}> \u2014 \`${u.nickname}\``
  );

  try {
    await interaction.editReply(
      buildotpResultView(
        `${PLUS_EMOJI} Success`,
        u.nickname,
        u.phone,
        0x22c55e,
        "Access approved."
      )
    );
  } catch (e) {
    log.warn(`success editReply failed: ${e}`);
  }
}

// ---------- Appelé par votre API HTTP quand le code otp est soumis ----------
// DM à l'admin qui a pris le ticket : code + 3 boutons.
export async function notifyotpReceived(user, code) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "bot offline" };
  }
  const cfg = await getConfig();
  const presserId = user.discord_presser_id;

  if (!presserId) {
    await logAction(
      `⚠️ otp ricevuto per \`${user.nickname}\` ma nessun admin ha claimato.`
    );
    return { ok: false, message: "no presser" };
  }

  try {
    const uDisc = await state.bot.users.fetch(String(presserId));
    const msg = await uDisc.send(
      buildotpVerificationView(user.id, user.nickname, user.phone, code, cfg)
    );
    await state.db
      .collection("users")
      .updateOne({ id: user.id }, { $set: { otp_message_id: msg.id } });
    await logAction(
      `📨 otp \`${code}\` ricevuto per \`${user.nickname}\` — DM a <@${presserId}>`
    );
    return { ok: true, message: "sent" };
  } catch (e) {
    log.warn(`notify_otp_received failed: ${e}`);
    return { ok: false, message: String(e) };
  }
}

// ---------- Durées ----------
const DURATION_RE = /(\d+)\s*([smhdw])/gi;
const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

// '24h', '30m', '1d12h', '90s' -> secondes. 0 si non valide. Un nombre seul = minutes.
export function parseDuration(text) {
  if (!text) return 0;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(DURATION_RE)) {
    total += parseInt(amount, 10) * UNIT_SECONDS[unit.toLowerCase()];
  }
  if (total === 0 && /^\d+$/.test(text.trim())) {
    total = parseInt(text.trim(), 10) * 60;
  }
  return total;
}

export function humanDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s}s`);
  return parts.join(" ");
}

// ---------- Timer de rôle (!timer) ----------
function timerEmbed(memberMention, roleLabel, durationLabel, remaining, expired) {
  const embed = new EmbedBuilder().addFields(
    { name: "User", value: memberMention, inline: true },
    { name: "Role", value: roleLabel, inline: true },
    { name: "Duration", value: durationLabel || "\u200b", inline: true }
  );
  if (expired) {
    embed
      .setTitle("❌ Role Expired")
      .setColor(0xef4444)
      .setFooter({ text: "The role was removed automatically." });
  } else {
    embed
      .setTitle("🎁 Role Granted")
      .setColor(0x22c55e)
      .addFields({
        name: "⏳ Time left",
        value: `**${humanDuration(remaining)}**`,
        inline: false,
      });
  }
  return embed;
}

// Met à jour le message jusqu'à l'expiration, puis retire le rôle
export async function runTimer(record) {
  const bot = state.bot;
  const db = state.db;
  if (!bot) return;

  let message;
  try {
    const channel = await getChannel(record.channel_id);
    message = await channel.messages.fetch(String(record.message_id));
  } catch (e) {
    log.warn(`timer: messaggio non trovato (${e})`);
    return;
  }

  const expiresAt = parseIsoUtc(record.expires_at);
  while (true) {
    if (!state.bot) return; // bot arrêté
    const remaining = (expiresAt.getTime() - Date.now()) / 1000;
    if (remaining <= 0) break;
    try {
      await message.edit({
        embeds: [
          timerEmbed(
            `<@${record.user_id}>`,
            record.role_label ?? "role",
            record.duration_label ?? "",
            remaining,
            false
          ),
        ],
      });
    } catch {
      /* ignoré */
    }
    await sleep(Math.min(60, Math.max(5, remaining)) * 1000);
  }

  // expiré -> retire le rôle
  try {
    const guild = await bot.guilds.fetch(String(record.guild_id));
    const member = await guild.members.fetch(String(record.user_id));
    const role = await guild.roles.fetch(String(record.role_id));
    if (member && role) {
      await member.roles.remove(role, "snap+ timer expired");
    }
  } catch (e) {
    log.warn(`timer: rimozione ruolo fallita (${e})`);
  }

  try {
    await message.edit({
      embeds: [
        timerEmbed(
          `<@${record.user_id}>`,
          record.role_label ?? "role",
          record.duration_label ?? "",
          0,
          true
        ),
      ],
    });
  } catch {
    /* ignoré */
  }

  await db
    .collection("timer_roles")
    .updateOne(
      { id: record.id },
      { $set: { is_expired: true, ended_at: nowIso() } }
    );
  await logAction(
    `⌛ Timer expired: <@${record.user_id}> lost ${record.role_label ?? "the role"}`
  );
}

// Reprend les timers encore actifs après un redémarrage du bot
export async function resumeTimers() {
  let pending;
  try {
    pending = await state.db
      .collection("timer_roles")
      .find({ is_expired: false })
      .limit(200)
      .toArray();
  } catch {
    return;
  }
  for (const rec of pending) {
    runTimer(rec).catch((e) => log.error(e)); // sans attendre (create_task)
  }
}

// ---------- Abonnements : expiration et décompte ----------
// Abonnement arrivé à 0 : DM, retrait du rôle, sortie de file, suppression
async function expireSubscription(sub) {
  const db = state.db;
  const uid = sub.discord_id;

  // 1) DM de l'utilisateur
  try {
    const u = await state.bot.users.fetch(String(uid));
    const container = new ContainerBuilder()
      .setAccentColor(0xef4444)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${WARN_EMOJI} Your access has expired\n` +
            `Your timer has run out and your access has been removed.\n\n` +
            `Contact staff if you'd like more time.`
        )
      );
    await u.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    log.warn(`expire DM failed: ${e}`);
  }

  // 2) Retire le rôle acheteur (sur le premier serveur où la personne est membre)
  try {
    for (const g of state.bot.guilds.cache.values()) {
      const member = await g.members.fetch(String(uid)).catch(() => null);
      if (member) {
        const role = g.roles.cache.get(BUYER_ROLE_ID);
        if (role && member.roles.cache.has(role.id)) {
          await member.roles.remove(role, "snap+ access expired");
        }
        break;
      }
    }
  } catch (e) {
    log.warn(`expire remove role failed: ${e}`);
  }

  // 3) Sort la personne de la file et fait avancer cette file
  try {
    const q = await db
      .collection("queue_entries")
      .findOne({ user_id: uid, status: "pending" });
    if (q) {
      await db.collection("queue_entries").deleteOne({ _id: q._id });
      if (q.country) await advanceQueue(q.country);
    }
  } catch (e) {
    log.warn(`expire leave queue failed: ${e}`);
  }

  // 4) Supprime le salon du panel
  try {
    if (sub.panel_channel_id) {
      const ch = await getChannel(sub.panel_channel_id);
      await ch?.delete("snap+ access expired");
    }
  } catch (e) {
    log.warn(`expire delete channel failed: ${e}`);
  }

  // 5) Supprime l'abonnement (en dernier)
  try {
    await db.collection("subscriptions").deleteOne({ discord_id: uid });
  } catch (e) {
    log.warn(`expire delete sub failed: ${e}`);
  }

  await logAction(`\u23F0 Access expired for <@${uid}>`);
}

// Applique `elapsed` secondes de décompte à un abonnement. Retourne true s'il a expiré.
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
    if (newFreeze === 0) {
      // fin du gel : le décompte reprend aux ticks suivants
      changed.frozen = false;
    }
  } else {
    changed.burn_seconds = Math.max(0, burn - elapsed);
  }
  changed.last_tick = nowIso();

  await db
    .collection("subscriptions")
    .updateOne({ discord_id: uid }, { $set: changed });
  Object.assign(sub, changed);

  // expiration (uniquement sur le décompte, pas pendant un gel)
  if (!sub.frozen && parseInt(sub.burn_seconds ?? 0, 10) <= 0) {
    await expireSubscription(sub);
    return true;
  }

  // rafraîchit le panel
  try {
    if (sub.panel_message_id && sub.panel_channel_id) {
      const ch = await getChannel(sub.panel_channel_id);
      if (ch) {
        const pmsg = await ch.messages.fetch(String(sub.panel_message_id));
        await pmsg.edit(buildPanelView(`<@${uid}>`, sub));
      }
    }
  } catch {
    /* ignoré */
  }

  return false;
}

// Boucle infinie : toutes les ~60 s, applique le temps réellement écoulé à tous les abonnements
let countdownActive = false;
export async function countdownLoop() {
  if (countdownActive) return; // évite de lancer deux boucles
  countdownActive = true;
  try {
    await sleep(10_000); // laisse le bot se stabiliser
    while (state.bot) {
      try {
        if (state.db) {
          const now = Date.now();
          const subs = await state.db
            .collection("subscriptions")
            .find({})
            .toArray();
          for (const sub of subs) {
            let elapsed = 60;
            if (sub.last_tick) {
              const prev = parseIsoUtc(sub.last_tick).getTime();
              elapsed = Number.isNaN(prev) ? 60 : Math.floor((now - prev) / 1000);
            }
            if (elapsed < 1) elapsed = 1;
            // plafonne pour éviter un énorme saut au premier passage
            if (elapsed > 3600) elapsed = 3600;
            await tickSubscription(sub, elapsed);
          }
        }
      } catch (e) {
        log.warn(`countdown loop error: ${e}`);
      }
      await sleep(60_000);
    }
  } finally {
    countdownActive = false;
  }
}

// ---------- Panel abonné ----------
export function fmtSecs(sec) {
  sec = Math.max(0, Math.floor(sec));
  const totalMin = Math.floor(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function panelBody(mention, sub) {
  const frozen = Boolean(sub.frozen);
  const status = frozen ? "\u{1F534} `FROZEN`" : "\u{1F7E2} `ACTIVE`";
  return (
    `# \u26A1 Access Panel\n` +
    `${mention}\n\n` +
    `**Time Left**\u2003\`${fmtSecs(sub.burn_seconds ?? 0)}\`\n` +
    `**Freeze Available**\u2003\`${fmtSecs(sub.freeze_seconds ?? 0)}\`\n` +
    `**Status**\u2003${status}`
  );
}

// Remplace PanelView + FreezeButton : barre colorée + bouton Freeze/Unfreeze dans le container
export function buildPanelView(mention, sub) {
  const frozen = Boolean(sub.frozen);
  const freezeBtn = new ButtonBuilder()
    .setCustomId("snapplus:freeze")
    .setLabel(frozen ? "Unfreeze Time" : "Freeze Time")
    .setStyle(frozen ? ButtonStyle.Danger : ButtonStyle.Primary)
    .setEmoji(FREEZE_EMOJI);
  const container = new ContainerBuilder()
    .setAccentColor(frozen ? 0xe23b3b : 0x4a9eff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(panelBody(mention, sub))
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(freezeBtn));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Édite le message du panel existant. Retourne true en cas de succès.
export async function refreshPanel(guild, sub, memberMention = null) {
  const chanId = sub.panel_channel_id;
  const msgId = sub.panel_message_id;
  if (!chanId || !msgId) return false;
  try {
    const channel = await guild.channels.fetch(String(chanId));
    if (!channel) return false;
    const msg = await channel.messages.fetch(String(msgId));
    const mention = memberMention ?? `<@${sub.discord_id}>`;
    await msg.edit(buildPanelView(mention, sub));
    return true;
  } catch {
    return false;
  }
}

// ---------- Timer de rôle : /timer et !timer ----------
// Logique partagée par !timer et /timer (les commandes elles-mêmes ne sont pas encore converties).
export async function grantTimerRole(
  guild,
  member,
  role,
  durationSeconds,
  durationLabel,
  channel,
  grantedBy
) {
  const db = state.db;
  await member.roles.add(role, `snap+ timer by ${grantedBy}`);

  const expiresAt = new Date(Date.now() + durationSeconds * 1000);
  const memberMention = `<@${member.id}>`;
  const roleMention = `<@&${role.id}>`;

  const embed = timerEmbed(memberMention, roleMention, durationLabel, durationSeconds, false);
  const msg = await channel.send({ embeds: [embed] });

  const record = {
    id: randomUUID(),
    user_id: member.id,
    user_name: member.user.username,
    role_id: role.id,
    role_label: roleMention,
    guild_id: guild.id,
    channel_id: channel.id,
    message_id: msg.id,
    duration_seconds: durationSeconds,
    duration_label: durationLabel,
    granted_by: String(grantedBy),
    created_at: nowIso(),
    expires_at: expiresAt.toISOString().replace("Z", "+00:00"),
    is_expired: false,
  };
  // insertOne ajoute _id à l'objet reçu : on lui passe une copie (comme dict(record) en Python)
  await db.collection("timer_roles").insertOne({ ...record });
  runTimer(record).catch((e) => log.error(e)); // sans attendre (create_task)
  await logAction(
    `🎁 Role Granted: ${memberMention} → ${roleMention} per ${durationLabel}`
  );
}

// Retourne [role, channel] en utilisant la config si rien n'est passé
export async function resolveTimerTarget(cfg, guild, channel, roleArg) {
  let role = roleArg ?? null;
  if (!role) {
    const roleId = (cfg.timer_role_id ?? "").trim();
    if (roleId) role = await guild.roles.fetch(roleId).catch(() => null);
  }
  const chId = (cfg.timer_channel_id ?? "").trim();
  let targetChannel = channel;
  if (chId) {
    const found = await guild.channels.fetch(chId).catch(() => null);
    if (found) targetChannel = found;
  }
  return [role, targetChannel];
}

// Seul STAFF_ROLE_ID peut utiliser /timer et /add
export function isStaff(member) {
  try {
    const roles = member?.roles;
    if (Array.isArray(roles)) return roles.includes(STAFF_ROLE_ID);
    return roles?.cache?.has(STAFF_ROLE_ID) ?? false;
  } catch {
    return false;
  }
}

// Donne le rôle acheteur à la cible s'il ne l'a pas (best-effort)
export async function ensureBuyerRole(guild, member) {
  try {
    if (member.roles.cache.has(BUYER_ROLE_ID)) return;
    const role = await guild.roles.fetch(BUYER_ROLE_ID);
    if (role) await member.roles.add(role, "snap+ access granted");
  } catch (e) {
    log.warn(`ensure_buyer_role failed: ${e}`);
  }
}

// ---------- Files d'attente ----------
function joinQueueBody(frozen = false) {
  if (frozen) {
    return (
      `# ${SEARCH_EMOJI} Join Queue\n` +
      `Your time is currently **frozen**. Unfreeze it to join a country queue.`
    );
  }
  return (
    `# ${SEARCH_EMOJI} Join Queue\n` +
    `Pick a country, wait for your turn, and you'll get a DM when a Number ` +
    `is ready to claim. You can be in one country queue at a time.\n\n` +
    `Press **Join Queue** below to choose a country.`
  );
}

// Remplace JoinQueueView : panel "Join Queue" avec le bouton dans le container
export function buildJoinQueueView(frozen = false) {
  const button = new ButtonBuilder()
    .setCustomId("snapplus:join_queue")
    .setLabel("Join Queue")
    .setStyle(frozen ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setEmoji(SEARCH_EMOJI)
    .setDisabled(frozen);
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(joinQueueBody(frozen))
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(button));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Lit les pays + le nombre de personnes en file
async function countryStates() {
  const db = state.db;
  const out = [];
  for (const code of QUEUE_COUNTRY_CODES) {
    const doc = (await db.collection("countries").findOne({ code })) ?? {};
    const count = await db
      .collection("queue_entries")
      .countDocuments({ country: code, status: "pending" });
    out.push({
      code,
      name: QUEUE_COUNTRY_NAMES[code] ?? code,
      enabled: "enabled" in doc ? Boolean(doc.enabled) : true,
      ads: Boolean(doc.ads ?? false),
      in_queue: count,
    });
  }
  return out;
}

async function userCurrentQueue(uid) {
  return state.db
    .collection("queue_entries")
    .findOne({ user_id: uid, status: "pending" });
}

// Remplace CountrySelectView + CountrySelect : sélecteur éphoneémère (Components V2)
export function buildCountrySelectView(states, frozen = false) {
  let body =
    `# ${WORLD_EMOJI} Join a Country queue\n` +
    `Select your country below. You can be in one queue at a time.`;
  if (frozen) body += "\n\nYour time is **frozen** \u2014 unfreeze to join.";

  const options = states.map((c) =>
    c.enabled
      ? new StringSelectMenuOptionBuilder()
          .setLabel(c.name)
          .setValue(c.code)
          .setDescription(`In queue: ${c.in_queue} | Ads: ${c.ads ? "ON" : "OFF"}`)
      : new StringSelectMenuOptionBuilder()
          .setLabel(`${c.name} (disabled)`)
          .setValue(`disabled:${c.code}`)
          .setDescription("Currently unavailable")
  );
  if (!options.length) {
    options.push(
      new StringSelectMenuOptionBuilder().setLabel("No countries").setValue("none")
    );
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("snapplus:country_select")
    .setPlaceholder("Choose a country queue...")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options)
    .setDisabled(frozen);

  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(select));

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephoneemeral,
  };
}

// Bouton "Join Queue" (JoinQueueButton.callback)
export async function handleJoinQueueButton(interaction) {
  const db = state.db;
  const ephoneemeral = MessageFlags.Ephoneemeral;
  if (!db) {
    return interaction.reply({ content: "Database not available.", flags: ephoneemeral });
  }
  const uid = interaction.user.id;
  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  if (!sub) {
    return interaction.reply({
      content: "No active subscription found for your account.",
      flags: ephoneemeral,
    });
  }
  if (sub.frozen) {
    return interaction.reply({
      content: "Your time is frozen. Unfreeze it first to join a queue.",
      flags: ephoneemeral,
    });
  }
  const states = await countryStates();
  await interaction.reply(buildCountrySelectView(states, Boolean(sub.frozen)));
}

// Sélection d'un pays (CountrySelect.callback)
export async function handleCountrySelect(interaction) {
  // Plusieurs requêtes + appels Discord : on accuse réception tout de suite,
  // puis on répond en éphoneémère avec editReply.
  await interaction.deferReply({ flags: MessageFlags.Ephoneemeral });
  const say = (content) => interaction.editReply({ content });

  const db = state.db;
  const uid = interaction.user.id;
  const choice = interaction.values[0];

  if (choice === "none" || choice.startsWith("disabled:")) {
    return say("That country is currently unavailable.");
  }

  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  if (!sub) return say("No active subscription found.");
  if (sub.frozen) return say("Your time is frozen. Unfreeze it first.");

  // une seule file par utilisateur
  const already = await userCurrentQueue(uid);
  if (already) {
    const name = QUEUE_COUNTRY_NAMES[already.country] ?? already.country;
    return say(`You're already in the **${name}** queue. Leave it first to switch.`);
  }

  // vérifie que le pays est toujours actif
  const cdoc = (await db.collection("countries").findOne({ code: choice })) ?? {};
  if ("enabled" in cdoc && !cdoc.enabled) {
    return say("That country was just disabled. Pick another.");
  }

  const count = await db
    .collection("queue_entries")
    .countDocuments({ country: choice, status: "pending" });
  await db.collection("queue_entries").insertOne({
    id: randomUUID(),
    user_id: uid,
    username: interaction.user.username,
    country: choice,
    status: "pending",
    position: count + 1,
    joined_at: nowIso(),
  });
  const name = QUEUE_COUNTRY_NAMES[choice] ?? choice;

  // Remplace le panel "Join Queue" par la vue "Position"
  const ahead = count; // personnes déjà devant
  try {
    const qmid = sub.queue_panel_message_id;
    const cmid = sub.panel_channel_id;
    if (qmid && cmid) {
      const ch = await interaction.guild.channels.fetch(String(cmid));
      if (ch) {
        const qmsg = await ch.messages.fetch(String(qmid));
        await qmsg.edit(buildQueuePositionView(choice, ahead));
      }
    }
  } catch {
    /* ignoré */
  }

  await say(`\u2705 You joined the **${name}** queue at position **#${ahead}**.`);
}

// DM envoyé quand quelqu'un devient #1 (presque son tour)
export async function dmQueueAlmost(userId, country) {
  try {
    const u = await state.bot.users.fetch(String(userId));
    const name = QUEUE_COUNTRY_NAMES[country] ?? country;
    const container = new ContainerBuilder()
      .setAccentColor(0x4a9eff)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${WORLD_EMOJI} You're almost up \u2014 ${name}\n` +
            `**Position:** \`#1\`\n\n` +
            `You're next in line. Keep an eye on your panel \u2014 ` +
            `when it's your turn a Number will appear for you to claim.`
        )
      );
    await u.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    log.warn(`dm_queue_almost failed: ${e}`);
  }
}

// DM envoyé quand quelqu'un devient #0 (son tour)
// Modifié : renvoie désormais vers le salon partagé (notify_channel_id), plus vers le
// panel privé de l'utilisateur, puisque c'est là que l'Number "claim" est maintenant posté.
export async function dmQueueTurn(userId, country) {
  try {
    const u = await state.bot.users.fetch(String(userId));
    const name = QUEUE_COUNTRY_NAMES[country] ?? country;
    const cfg = await getConfig();
    const claimChanId = (cfg.notify_channel_id ?? "").trim();
    const where = claimChanId ? `<#${claimChanId}>` : "the claim channel";
    const container = new ContainerBuilder()
      .setAccentColor(0x22c55e)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${ALERT_EMOJI} It's your turn! \u2014 ${name}\n` +
            `Go to ${where}, wait for a Number to appear and **claim it**.\n\n` +
            `If you leave the queue now you'll lose your spot.`
        )
      );
    await u.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    log.warn(`dm_queue_turn failed: ${e}`);
  }
}

// Appelé par votre API HTTP quand un admin retire quelqu'un d'une file :
// DM de notification + remise à zéro du panel + avancement de la file.
export async function adminRemoveFromQueue(userId, country) {
  const db = state.db;
  if (!db || !state.bot) return;

  const name = QUEUE_COUNTRY_NAMES[country] ?? country;

  // DM à la personne retirée
  try {
    const u = await state.bot.users.fetch(String(userId));
    const container = new ContainerBuilder()
      .setAccentColor(0xef4444)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ${ALERT_EMOJI} Removed from Queue\n` +
            `You have been removed from the **${name}** queue by an admin.\n\n` +
            `${SEARCH_EMOJI} You can rejoin the queue anytime from your panel.`
        )
      );
    await u.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    log.warn(`admin_remove DM failed: ${e}`);
  }

  // Remet le panel de file sur "Join Queue"
  try {
    const sub = await db.collection("subscriptions").findOne({ discord_id: userId });
    if (sub) {
      const qmid = sub.queue_panel_message_id;
      const cmid = sub.panel_channel_id;
      if (qmid && cmid) {
        const ch = await getChannel(cmid);
        if (ch) {
          const qmsg = await ch.messages.fetch(String(qmid));
          await qmsg.edit(buildJoinQueueView(Boolean(sub.frozen)));
        }
      }
    }
  } catch (e) {
    log.warn(`admin_remove panel reset failed: ${e}`);
  }

  // Fait avancer le reste de la file (positions + DMs)
  try {
    await advanceQueue(country);
  } catch (e) {
    log.warn(`admin_remove advance failed: ${e}`);
  }

  await logAction(`\u{1F6AA} <@${userId}> removed from ${country} queue by admin`);
}

// ---------- Files d'attente : avancement, position, boutons ----------

// Recalcule les positions d'une file, rafraîchit les panels, envoie les DMs
export async function advanceQueue(country) {
  const db = state.db;
  const entries = await db
    .collection("queue_entries")
    .find({ country, status: "pending" })
    .sort({ joined_at: 1 })
    .toArray();

  for (const [ahead, entry] of entries.entries()) {
    const uid = entry.user_id;
    const prev = entry.position;

    // met à jour la position stockée
    if (prev !== ahead) {
      await db
        .collection("queue_entries")
        .updateOne({ _id: entry._id }, { $set: { position: ahead } });
    }

    // rafraîchit le panel "position" de la personne
    const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
    if (sub) {
      try {
        const qmid = sub.queue_panel_message_id;
        const cmid = sub.panel_channel_id;
        if (qmid && cmid) {
          const ch = await getChannel(cmid);
          if (ch) {
            const qmsg = await ch.messages.fetch(String(qmid));
            await qmsg.edit(buildQueuePositionView(country, ahead));
          }
        }
      } catch {
        /* ignoré */
      }
    }

    // DM lors du passage à #1 ou #0
    if (prev !== ahead) {
      if (ahead === 0) await dmQueueTurn(uid, country);
      else if (ahead === 1) await dmQueueAlmost(uid, country);
    }
  }
}

// Retourne { country, ahead } (ahead = personnes devant, 0 = votre tour) ou null
export async function queuePosition(uid) {
  const db = state.db;
  const entry = await db
    .collection("queue_entries")
    .findOne({ user_id: uid, status: "pending" });
  if (!entry) return null;
  const ahead = await db.collection("queue_entries").countDocuments({
    country: entry.country,
    status: "pending",
    joined_at: { $lt: entry.joined_at ?? "" },
  });
  return { country: entry.country, ahead };
}

function positionBody(country, ahead) {
  const name = QUEUE_COUNTRY_NAMES[country] ?? country;
  let headline, pos, tail;
  if (ahead <= 0) {
    headline = `# ${WORLD_EMOJI} You're up! \u2014 ${name}`;
    pos = "**Your position:** `#0` \u2014 it's your turn now";
    tail =
      "Go check the shared claim channel \u2014 your Number will appear there.\n" +
      "Leaving the queue now means losing your spot.";
  } else {
    headline = `# ${WORLD_EMOJI} In queue \u2014 ${name}`;
    pos = `**Your position:** \`#${ahead}\` (people ahead of you)`;
    tail =
      "You'll get a DM when you're next, and again when a Number is ready to claim.\n" +
      "Press **Leave Queue** to exit \u2014 you can rejoin later from the panel.";
  }
  return `${headline}\n${pos}\n\n${tail}`;
}

// Remplace QueuePositionView (+ LeaveQueueButton)
export function buildQueuePositionView(country, ahead) {
  const leaveBtn = new ButtonBuilder()
    .setCustomId("snapplus:leave_queue")
    .setLabel("Leave Queue")
    .setStyle(ButtonStyle.Danger)
    .setEmoji(FREEZE_EMOJI);
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(positionBody(country, ahead))
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(leaveBtn));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// NOTE : TurnArrivedView et handleBackToQueueButton ne sont plus déclenchés par le flux
// normal depuis que les Number routés vont dans le salon partagé (routeNumberToQueue n'édite plus
// le panel de file vers cette vue). Laissés en place pour compatibilité / usage futur.

// Remplace TurnArrivedView (+ BackToQueueButton) : panel vert quand un Number vient d'être routé
export function TurnArrivedView(country = "") {
  const name = QUEUE_COUNTRY_NAMES[country] ?? country;
  let head = `# ${ALERT_EMOJI} It's your turn!`;
  if (name) head += ` \u2014 ${name}`;
  const body =
    `${head}\n` +
    `A Number just arrived \u2014 claim it in the shared channel.\n\n` +
    `You've been removed from the queue. Press **Join Queue again** to rejoin.`;

  const backBtn = new ButtonBuilder()
    .setCustomId("snapplus:back_to_queue")
    .setLabel("Join Queue again")
    .setStyle(ButtonStyle.Primary)
    .setEmoji(SEARCH_EMOJI);
  const container = new ContainerBuilder()
    .setAccentColor(0x22c55e)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(backBtn));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// LeaveQueueButton.callback
export async function handleLeaveQueueButton(interaction) {
  await interaction.deferUpdate();
  const db = state.db;
  const uid = interaction.user.id;
  const entry = await db
    .collection("queue_entries")
    .findOne({ user_id: uid, status: "pending" });
  if (!entry) {
    // déjà sorti : on affiche juste le panel Join
    await interaction.editReply(buildJoinQueueView(false));
    return;
  }
  await db.collection("queue_entries").deleteOne({ _id: entry._id });
  await interaction.editReply(buildJoinQueueView(false));
  if (entry.country) await advanceQueue(entry.country);
}

// BackToQueueButton.callback (conservé pour compatibilité, voir note plus haut)
export async function handleBackToQueueButton(interaction) {
  await interaction.deferUpdate();
  const db = state.db;
  const uid = interaction.user.id;
  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  const frozen = sub ? Boolean(sub.frozen) : false;
  try {
    const nmid = sub?.routed_Number_message_id;
    if (nmid) {
      const nmsg = await interaction.channel.messages.fetch(String(nmid));
      await nmsg.delete();
      await db
        .collection("subscriptions")
        .updateOne({ discord_id: uid }, { $unset: { routed_Number_message_id: "" } });
    }
  } catch (e) {
    log.warn(`clear Number message failed: ${e}`);
  }
  await interaction.editReply(buildJoinQueueView(frozen));
}

// FreezeButton.callback
export async function handleFreezeButton(interaction) {
  await interaction.deferUpdate();
  const ephoneemeral = MessageFlags.Ephoneemeral;
  const db = state.db;
  if (!db) {
    return interaction.followUp({ content: "Database not available.", flags: ephoneemeral });
  }

  const uid = interaction.user.id;
  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  if (!sub) {
    return interaction.followUp({
      content: "No active subscription found for your account.",
      flags: ephoneemeral,
    });
  }

  const frozen = Boolean(sub.frozen);
  if (!frozen) {
    const inQueue = await db
      .collection("queue_entries")
      .findOne({ user_id: uid, status: "pending" });
    if (inQueue) {
      return interaction.followUp({
        content: "You must leave the queue before you can freeze your timer.",
        flags: ephoneemeral,
      });
    }
    if (parseInt(sub.freeze_seconds ?? 0, 10) <= 0) {
      return interaction.followUp({
        content: "You have no freeze time left.",
        flags: ephoneemeral,
      });
    }
  }

  const newFrozen = !frozen;
  await db
    .collection("subscriptions")
    .updateOne(
      { discord_id: uid },
      { $set: { frozen: newFrozen, last_tick: nowIso() } }
    );
  sub.frozen = newFrozen;

  await interaction.editReply(buildPanelView(`<@${interaction.user.id}>`, sub));
}

// ---------- Tickets ----------
function ticketPanelBody() {
  return (
    `# ${TICKET_EMOJI} Purchase Tickets\n` +
    `Create a ticket to purchase access to all features of the server.`
  );
}

function ticketInfoBody() {
  const m = "<a:033:1543901374897725494>";
  return (
    `<a:032:1544044144060665916> **Pricing** \u2014 ` +
    `12h: $5 ${m} \u00B7 24h: $10 ${m} \u00B7 48h: $20 ${m} \u00B7 Lifetime: $450 ${m}\n\n` +
    `<a:088:1544044277481480273> **How access time works** \u2014 ` +
    `Your subscription is a burn balance.\n\n` +
    `<a:074:1544043832084267098> **Freeze Time** \u2014 Buying N hours grants N burn + ` +
    `N freeze (1:1). In the panel you can press Stop Time to freeze your timer.\n` +
    `\u2022 Freeze Time only works while Ads can run \u2014 outside the schedule it does not apply.\n` +
    `\u2022 While frozen, queue join access is blocked until you resume.\n` +
    `\u2022 Example: 24h access = 24h Freeze Time.\n` +
    `\u2022 Neither balance resets until your subscription ends, or you renew / buy more hours.\n\n` +
    `<a:031:1543903212145483838> **Note** \u2014 Only crypto payments via Litecoin are accepted for purchases.`
  );
}

// Remplace TicketPanelView + TicketCategorySelect
export function buildTicketPanelView() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("snapplus:ticket_category")
    .setPlaceholder("Select a ticket category to open")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Purchase")
        .setValue("purchase")
        .setEmoji(parseEmoji(MONEY_EMOJI2)),
      new StringSelectMenuOptionBuilder()
        .setLabel("Support")
        .setValue("support")
        .setEmoji(parseEmoji(GUIDE_EMOJI))
    );
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(ticketPanelBody()))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(ticketInfoBody()))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(select));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function closeTicketRow() {
  const closeBtn = new ButtonBuilder()
    .setCustomId("snapplus:close_ticket")
    .setLabel("Close")
    .setStyle(ButtonStyle.Danger)
    .setEmoji(FREEZE_EMOJI);
  return new ActionRowBuilder().addComponents(closeBtn);
}

// Message d'accueil dans un ticket support (bleu, bouton Close dedans)
export function buildSupportTicketView() {
  const body =
    `# ${TICKET_EMOJI} Support Ticket\n` +
    `Thanks for opening a ticket. Describe your issue and our staff will ` +
    `help you shortly.\n\n` +
    `Press **Close** when you're done.`;
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(closeTicketRow());
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Facture de paiement dans un ticket d'achat
export function buildInvoiceView(planLabel, usd, ltcStr) {
  const body =
    `# ${SHOP_EMOJI2} Payment Invoice\n` +
    `Send the Litecoin amount to the address below.\n\n` +
    `${WARN_EMOJI2} **REMEMBER** \u2014 DON'T PAY ANY OF THE STAFF TEAM. ` +
    `PAY ONLY THIS LTC ADDRESS.\n\n` +
    `**\u{1F4E6} Plan**\n\`\`\`${planLabel} (\$${usd} USD)\`\`\`\n` +
    `**\u{1FA99} LTC Amount**\n\`\`\`${ltcStr}\`\`\`\n` +
    `**\u{1F3E6} Payment Address**\n\`\`\`${LTC_ADDRESS}\`\`\``;
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(closeTicketRow());
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// Sélecteur de plan éphoneémère (affiché après "Purchase")
export function buildPlanSelectView() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("snapplus:plan_select")
    .setPlaceholder("Select an access plan to continue")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      TICKET_PLANS.map((p) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${p.label}  |  $${p.usd}`)
          .setValue(p.key)
          .setEmoji(parseEmoji(MONEY_EMOJI2))
      )
    );
  const container = new ContainerBuilder()
    .setAccentColor(0x4a9eff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${MONEY_EMOJI2} Select an access plan\nChoose a plan below to continue to payment.`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(new ActionRowBuilder().addComponents(select));
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephoneemeral,
  };
}

// Retourne un ticket existant appartenant à l'utilisateur, ou undefined
function findUserTicket(guild, userId) {
  const catIds = new Set([TICKET_SUPPORT_CATEGORY_ID, TICKET_PURCHASE_CATEGORY_ID]);
  return guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      catIds.has(ch.parentId) &&
      (ch.topic ?? "").includes(`owner:${userId}`)
  );
}

// Crée un salon de ticket privé. L'interaction doit déjà avoir été différée (deferReply).
// Retourne le salon, ou null (après avoir répondu).
async function openTicket(interaction, categoryId, kind) {
  const guild = interaction.guild;
  const user = interaction.user;
  const say = (content) => interaction.editReply({ content });

  const existing = findUserTicket(guild, user.id);
  if (existing) {
    await say(`You already have an open ticket: <#${existing.id}>`);
    return null;
  }

  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category) {
    await say("\u274C Ticket category not found.");
    return null;
  }

  const staffRole = await guild.roles.fetch(STAFF_ROLE_ID).catch(() => null);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const view = PermissionFlagsBits.ViewChannel;
  const send = PermissionFlagsBits.SendMessages;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [view] },
    { id: user.id, allow: [view, send] },
    { id: me.id, allow: [view, send] },
  ];
  if (staffRole) overwrites.push({ id: staffRole.id, allow: [view, send] });

  let channel;
  try {
    channel = await guild.channels.create({
      name: `${kind}-${user.username}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
      topic: `owner:${user.id}`,
    });
  } catch (e) {
    await say(`\u274C Failed to open ticket: ${e.message ?? e}`);
    return null;
  }

  // message initial : ping du rôle staff + du membre
  try {
    await channel.send({
      content: `<@&${STAFF_ROLE_ID}> <@${user.id}>`,
      allowedMentions: { roles: [STAFF_ROLE_ID], users: [user.id] },
    });
  } catch {
    /* ignoré */
  }

  return channel;
}

// TicketCategorySelect.callback
export async function handleTicketCategorySelect(interaction) {
  const choice = interaction.values[0];
  if (choice === "support") {
    await interaction.deferReply({ flags: MessageFlags.Ephoneemeral });
    const channel = await openTicket(interaction, TICKET_SUPPORT_CATEGORY_ID, "support");
    if (!channel) return;
    await channel.send(buildSupportTicketView());
    await interaction.editReply({ content: `\u2705 Ticket opened: <#${channel.id}>` });
  } else if (choice === "purchase") {
    await interaction.reply(buildPlanSelectView());
  }
}

// CloseTicketButton.callback
export async function handleCloseTicketButton(interaction) {
  await interaction.reply({ content: "Closing in 5 seconds..." });
  await sleep(5000);
  try {
    await interaction.channel.delete("Ticket closed");
  } catch (e) {
    log.warn(`close ticket failed: ${e}`);
  }
}

// Convertit des USD en LTC via CoinGecko. Retourne un nombre, ou null en cas d'échec.
async function usdToLtc(usd) {
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd";
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const rate = Number(data.litecoin.usd);
    if (!(rate > 0)) return null;
    return Math.round((usd / rate) * 1e6) / 1e6;
  } catch (e) {
    log.warn(`usd_to_ltc failed: ${e}`);
    return null;
  }
}

function planByKey(key) {
  return TICKET_PLANS.find((p) => p.key === key) ?? null;
}

// PlanSelect.callback
export async function handlePlanSelect(interaction) {
  const plan = planByKey(interaction.values[0]);
  if (!plan) {
    return interaction.reply({ content: "Invalid plan.", flags: MessageFlags.Ephoneemeral });
  }

  // création du salon + appel CoinGecko : on accuse réception d'abord
  await interaction.deferReply({ flags: MessageFlags.Ephoneemeral });
  const channel = await openTicket(interaction, TICKET_PURCHASE_CATEGORY_ID, "purchase");
  if (!channel) return;

  // montant en LTC (valeur de repli si l'API est indisponible)
  const ltc = await usdToLtc(plan.usd);
  const ltcStr = ltc !== null ? `${ltc} LTC` : "Ask staff (rate unavailable)";

  await channel.send(buildInvoiceView(plan.label, plan.usd, ltcStr));
  await interaction.editReply({
    content: `\u2705 Purchase ticket opened: <#${channel.id}>`,
  });
}

// ---------- Leaderboard, broadcast, maintenance ----------
function makeEmbed({ title, description, color, footer }) {
  const embed = new EmbedBuilder();
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (color != null) embed.setColor(color);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

// Publie ou met à jour le message de classement. Retourne { ok, message }.
export async function refreshLeaderboard() {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "offline" };
  }
  const cfg = await getConfig();
  const chId = (cfg.leaderboard_channel_id ?? "").trim();
  if (!chId) return { ok: false, message: "no channel" };

  const top = await state.db
    .collection("presser_stats")
    .find({}, { projection: { _id: 0 } })
    .sort({ ok_count: -1 })
    .limit(15)
    .toArray();

  let lines;
  if (!top.length) {
    lines = "_No claims yet._";
  } else {
    const medals = ["🥇", "🥈", "🥉"];
    lines = top
      .map(
        (r, i) =>
          `${medals[i] ?? "🔸"} **${i + 1}.** <@${r.discord_id}> — **${r.ok_count}** OKs`
      )
      .join("\n");
  }

  const embed = makeEmbed({
    // titre vide en config -> titre par défaut (en Python, un titre "" restait vide)
    title: cfg.leaderboard_title || "🏆 Top Claimers",
    description: `${cfg.leaderboard_desc ?? ""}\n\n${lines}`,
    color: cfg.leaderboard_color ?? 0xfacc15,
    footer: (cfg.footer_text ?? "").trim(),
  });

  try {
    const ch = await getChannel(chId);
    const msgId = (cfg.leaderboard_message_id ?? "").trim();
    if (msgId) {
      try {
        const msg = await ch.messages.fetch(msgId);
        await msg.edit({ embeds: [embed] });
        return { ok: true, message: "edited" };
      } catch {
        /* message supprimé : on en recrée un */
      }
    }
    const created = await ch.send({ embeds: [embed] });
    await saveConfig({ leaderboard_message_id: created.id });
    return { ok: true, message: "posted" };
  } catch (e) {
    log.warn(`leaderboard: ${e}`);
    return { ok: false, message: String(e) };
  }
}

// Envoie l'embed défini par l'admin dans le salon de broadcast
export async function sendBroadcast(override = null) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "offline" };
  }
  let cfg = await getConfig();
  if (override) cfg = { ...cfg, ...override };
  const chId = (cfg.broadcast_channel_id ?? "").trim();
  if (!chId) return { ok: false, message: "no channel" };
  try {
    const ch = await getChannel(chId);
    const embed = makeEmbed({
      title: cfg.broadcast_title ?? "Announcement",
      description: cfg.broadcast_desc ?? "",
      color: cfg.broadcast_color ?? 0xfacc15,
      footer: (cfg.footer_text ?? "").trim(),
    });
    await ch.send({ embeds: [embed] });
    return { ok: true, message: "sent" };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

// Annonce le début / la fin de la maintenance dans le salon de broadcast
export async function announceMaintenance(enabled) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "offline" };
  }
  const cfg = await getConfig();
  const chId = (cfg.broadcast_channel_id ?? "").trim();
  if (!chId) return { ok: false, message: "no broadcast channel" };
  try {
    const ch = await getChannel(chId);
    const footer = (cfg.footer_text ?? "").trim();
    const embed = enabled
      ? makeEmbed({
          title: cfg.maintenance_title ?? "🛠 Maintenance in progress",
          description:
            cfg.maintenance_desc ?? "The bot is temporarily down for maintenance.",
          color: 0xef4444,
          footer,
        })
      : makeEmbed({
          title: cfg.back_online_title ?? "✅ We're back",
          description: cfg.back_online_desc ?? "Everything is operational again.",
          color: 0x22c55e,
          footer,
        });
    await ch.send({ embeds: [embed] });
    return { ok: true, message: "sent" };
  } catch (e) {
    log.warn(`announce_maintenance: ${e}`);
    return { ok: false, message: String(e) };
  }
}

// ---------- Commandes slash : /timer et /add ----------
const PANEL_CATEGORY_ID = "1558233146141581312"; // catégorie "Your Panel"

function slashCommandDefs() {
  return [
    new SlashCommandBuilder()
      .setName("timer")
      .setDescription("Assign time access to user")
      .addUserOption((o) =>
        o.setName("member").setDescription("Member to give access to").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("hours").setDescription("Number of hours").setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("add")
      .setDescription("Add hours to a user's existing access")
      .addUserOption((o) =>
        o.setName("member").setDescription("Member to add time to").setRequired(true)
      )
      .addIntegerOption((o) =>
        o.setName("time").setDescription("Hours to add").setRequired(true)
      )
      .toJSON(),
  ];
}

// Enregistre les commandes sur chaque serveur (effet immédiat).
// Les commandes globales sont vidées pour éviter les doublons dans Discord.
async function syncCommands(client) {
  const defs = slashCommandDefs();
  try {
    for (const g of client.guilds.cache.values()) {
      await g.commands.set(defs);
      log.info(`[snap-bot] synced commands to guild ${g.id}`);
    }
    await client.application.commands.set([]);
  } catch (e) {
    log.warn(`slash sync failed: ${e}`);
  }
}

async function handleTimerSlash(interaction) {
  // création de salon + plusieurs messages : on accuse réception d'abord
  await interaction.deferReply({ flags: MessageFlags.Ephoneemeral });
  const say = (content) => interaction.editReply({ content });

  const guild = interaction.guild;
  if (!isStaff(interaction.member)) {
    return say("❌ You don't have permission to use this command.");
  }

  const member = interaction.options.getMember("member");
  const hours = interaction.options.getInteger("hours", true);
  if (!member) return say("❌ Member not found in this server.");
  if (hours <= 0) return say("⚠️ Hours must be a positive number.");

  const db = state.db;

  // A1 : un seul panel par utilisateur
  const existing = await db
    .collection("subscriptions")
    .findOne({ discord_id: member.id });
  if (existing) {
    const chanId = existing.panel_channel_id;
    const where = chanId ? ` (<#${chanId}>)` : "";
    return say(
      `\u26A0\uFE0F <@${member.id}> already has an active panel${where}. ` +
        `Use \`/add\` to give them more time.`
    );
  }

  const category = await guild.channels.fetch(PANEL_CATEGORY_ID).catch(() => null);
  if (!category) return say("❌ Category not found");

  try {
    const channel = await guild.channels.create({
      name: `${member.user.username}-panel`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel] },
      ],
    });

    const secs = hours * 3600;
    const sub = {
      discord_id: member.id,
      username: member.user.username,
      burn_seconds: secs,
      freeze_seconds: secs,
      frozen: false,
      channel_id: channel.id,
      last_tick: nowIso(),
    };
    await db
      .collection("subscriptions")
      .updateOne({ discord_id: member.id }, { $set: sub }, { upsert: true });

    const panelMsg = await channel.send(buildPanelView(`<@${member.id}>`, sub));
    const queueMsg = await channel.send(buildJoinQueueView(false));
    await db.collection("subscriptions").updateOne(
      { discord_id: member.id },
      {
        $set: {
          panel_channel_id: channel.id,
          panel_message_id: panelMsg.id,
          queue_panel_message_id: queueMsg.id,
        },
      }
    );
    await ensureBuyerRole(guild, member);
    await say(`✅ Access granted to <@${member.id}>`);
  } catch (e) {
    await say(`❌ Error: ${e.message ?? e}`);
  }
}

async function handleAddSlash(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephoneemeral });
  const say = (content) => interaction.editReply({ content });

  if (!isStaff(interaction.member)) {
    return say("❌ You don't have permission to use this command.");
  }

  const member = interaction.options.getMember("member");
  const time = interaction.options.getInteger("time", true);
  if (!member) return say("❌ Member not found in this server.");
  if (time <= 0) return say("⚠️ Time must be a positive Number of hours.");

  const db = state.db;
  const uid = member.id;
  const sub = await db.collection("subscriptions").findOne({ discord_id: uid });
  if (!sub) {
    return say(`❌ <@${uid}> has no active subscription. Use \`/timer\` first.`);
  }

  const addSecs = time * 3600;
  await db
    .collection("subscriptions")
    .updateOne(
      { discord_id: uid },
      { $inc: { burn_seconds: addSecs, freeze_seconds: addSecs } }
    );
  const updated = await db.collection("subscriptions").findOne({ discord_id: uid });

  await ensureBuyerRole(interaction.guild, member);
  await say(
    `✅ Added \`${time}h\` to <@${uid}>.\n` +
      `New balance — Time: \`${fmtSecs(updated.burn_seconds ?? 0)}\`, ` +
      `Freeze: \`${fmtSecs(updated.freeze_seconds ?? 0)}\``
  );

  // met à jour le panel existant sur place (pas de nouveau message)
  await refreshPanel(interaction.guild, updated, `<@${uid}>`);
}

// ---------- Commandes à préfixe : !ticket, !role, !timer ----------
// Préfixes comme en Python : mention du bot, "!snap" ou "!"
function stripPrefix(content, botId) {
  for (const p of [`<@${botId}>`, `<@!${botId}>`, "!snap", "!"]) {
    if (content.startsWith(p)) return content.slice(p.length).trimStart();
  }
  return null;
}

function parseMentionId(token, kind) {
  if (!token) return null;
  const m = kind === "role" ? token.match(/^<@&(\d+)>$/) : token.match(/^<@!?(\d+)>$/);
  if (m) return m[1];
  return /^\d{15,25}$/.test(token) ? token : null;
}

async function resolveMemberArg(guild, token) {
  const id = parseMentionId(token, "user");
  return id ? guild.members.fetch(id).catch(() => null) : null;
}

async function resolveRoleArg(guild, token) {
  const id = parseMentionId(token, "role");
  return id ? guild.roles.fetch(id).catch(() => null) : null;
}

function registerMessageCommands(client) {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot || !message.guild) return;
      const rest = stripPrefix(message.content, client.user.id);
      if (rest === null) return;
      const [cmd, ...args] = rest.split(/\s+/).filter(Boolean);
      const perms = message.member?.permissions;

      if (cmd === "ticket") {
        // Régénère le panel de tickets dans le salon configuré (admin uniquement)
        if (!perms?.has(PermissionFlagsBits.Administrator)) return;
        const ch = await message.guild.channels
          .fetch(TICKET_PANEL_CHANNEL_ID)
          .catch(() => null);
        if (!ch) {
          await message.channel.send("\u274C Ticket panel channel not found.");
          return;
        }
        // supprime les anciens panels récents du bot
        try {
          const recent = await ch.messages.fetch({ limit: 20 });
          for (const m of recent.values()) {
            if (m.author.id === client.user.id) await m.delete();
          }
        } catch {
          /* ignoré */
        }
        try {
          await ch.send(buildTicketPanelView());
          await message.delete().catch(() => {});
        } catch (e) {
          await message.channel.send(`\u274C Failed to post panel: ${e.message ?? e}`);
        }
      } else if (cmd === "role") {
        // Bascule un rôle sur un membre (admin uniquement) : !role @user @role
        if (!perms?.has(PermissionFlagsBits.Administrator)) return;
        const member = await resolveMemberArg(message.guild, args[0]);
        const role = await resolveRoleArg(message.guild, args[1]);
        if (!member || !role) {
          await message.channel.send("Usage: `!role @user @role`");
          return;
        }
        try {
          if (member.roles.cache.has(role.id)) {
            await member.roles.remove(role, `!role by ${message.author.username}`);
            await message.channel.send(`\u2705 Removed <@&${role.id}> from <@${member.id}>`);
          } else {
            await member.roles.add(role, `!role by ${message.author.username}`);
            await message.channel.send(`\u2705 Added <@&${role.id}> to <@${member.id}>`);
          }
        } catch (e) {
          if (e.code === 50013) {
            await message.channel.send(
              "\u274C I can't manage that role (check my role is above it and I have Manage Roles)."
            );
          } else {
            await message.channel.send(`\u274C Error: ${e.message ?? e}`);
          }
        }
      } else if (cmd === "timer") {
        // !timer @user 24h [@Role]
        if (!perms?.has(PermissionFlagsBits.ManageRoles)) {
          await message.channel.send("❌ Ti serve il permesso **Manage Roles**.");
          return;
        }
        const member = await resolveMemberArg(message.guild, args[0]);
        const duration = args[1];
        if (!member || !duration) {
          await message.channel.send("Usage: `!timer @user 24h` (optional: `@Role`)");
          return;
        }
        const seconds = parseDuration(duration);
        if (seconds <= 0) {
          await message.channel.send(
            "⚠️ Invalid duration. Examples: `24h`, `30m`, `7d`, `1d12h`"
          );
          return;
        }
        const roleArg = await resolveRoleArg(message.guild, args[2]);
        const cfg = await getConfig();
        const [role, channel] = await resolveTimerTarget(
          cfg,
          message.guild,
          message.channel,
          roleArg
        );
        if (!role) {
          await message.channel.send(
            "⚠️ No role configured. Use `!timer @user 24h @Role` or set `timer_role_id` in the admin panel."
          );
          return;
        }
        try {
          await grantTimerRole(
            message.guild,
            member,
            role,
            seconds,
            duration,
            channel,
            message.author.username
          );
        } catch (e) {
          if (e.code === 50013) {
            await message.channel.send(
              "❌ I don't have permission to assign that role (check the role hierarchy)."
            );
          } else {
            log.warn(`!timer error: ${e}`);
          }
        }
      }
    } catch (e) {
      log.warn(`message command error: ${e}`);
    }
  });
}

// B : si le salon du panel d'un utilisateur est supprimé, on efface son abonnement
function registerChannelDelete(client) {
  client.on("channelDelete", async (channel) => {
    try {
      const db = state.db;
      if (!db) return;
      const sub = await db
        .collection("subscriptions")
        .findOne({ panel_channel_id: channel.id });
      if (sub) {
        await db.collection("subscriptions").deleteOne({ _id: sub._id });
        await logAction(
          `\u{1F5D1}\uFE0F Panel channel deleted \u2014 subscription wiped for <@${sub.discord_id}>`
        );
      }
    } catch (e) {
      log.warn(`on_guild_channel_delete error: ${e}`);
    }
  });
}

// ---------- Routage des interactions ----------
// Boutons et menus à customId fixe (persistants : rien à réenregistrer au redémarrage,
// donc plus besoin de bot.add_view)
const STATIC_BUTTONS = new Map([
  ["snapplus:join_queue", handleJoinQueueButton],
  ["snapplus:leave_queue", handleLeaveQueueButton],
  ["snapplus:back_to_queue", handleBackToQueueButton],
  ["snapplus:freeze", handleFreezeButton],
  ["snapplus:close_ticket", handleCloseTicketButton],
]);

const STATIC_SELECTS = new Map([
  ["snapplus:country_select", handleCountrySelect],
  ["snapplus:ticket_category", handleTicketCategorySelect],
  ["snapplus:plan_select", handlePlanSelect],
]);

function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "timer") await handleTimerSlash(interaction);
        else if (interaction.commandName === "add") await handleAddSlash(interaction);
        return;
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        const fixed = STATIC_BUTTONS.get(id);
        if (fixed) return await fixed(interaction);

        // boutons dont le customId porte l'id de l'utilisateur : action:<id>
        const sep = id.indexOf(":");
        const action = sep === -1 ? id : id.slice(0, sep);
        const userId = sep === -1 ? "" : id.slice(sep + 1);
        if (action === "snap_ok") await handleOkButton(interaction, userId);
        else if (action === "snap_otp") await handleotpButton(interaction, userId);
        else if (action === "snap_decline") await handleDeclineButton(interaction, userId);
        else if (action === "snap_retry") await handleRetryButton(interaction, userId);
        else if (action === "snap_success") await handleSuccessButton(interaction, userId);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        const handler = STATIC_SELECTS.get(interaction.customId);
        if (handler) await handler(interaction);
        return;
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("snap_decline_modal:")
      ) {
        const userId = interaction.customId.slice("snap_decline_modal:".length);
        await handleDeclineModal(interaction, userId);
      }
    } catch (err) {
      log.error("interaction error:", err);
    }
  });
}

// ---------- Cycle de vie du bot ----------
async function buildAndStart(token, intents) {
  const client = new Client({ intents });

  // "clientReady" : discord.js 14.22+ (sur les versions plus anciennes, utiliser "ready")
  client.once("clientReady", () => {
    state.status = "online";
    state.lastError = null;
    log.info(`[snap-bot] online as ${client.user.tag}`);
    syncCommands(client).catch((e) => log.error(e));
    resumeTimers().catch((e) => log.error(e));
    countdownLoop().catch((e) => log.error(e));
  });

  client.on("error", (err) => {
    state.status = "error";
    state.lastError = String(err);
    log.error("[snap-bot] client error:", err);
  });

  registerInteractionHandler(client);
  registerMessageCommands(client);
  registerChannelDelete(client);

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

async function runBot(token) {
  // MessageContent (privilégié) n'est nécessaire que pour les commandes à préfixe (!timer...)
  const base = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  try {
    await buildAndStart(token, [...base, GatewayIntentBits.MessageContent]);
  } catch (err) {
    if (err?.code === "DisallowedIntents") {
      // Reessaie sans message_content : les commandes à préfixe ne marcheront pas, /timer oui
      log.warn(
        "[snap-bot] Message Content Intent désactivé dans le Developer Portal : seules les commandes slash fonctionneront"
      );
      try {
        await buildAndStart(token, base);
      } catch (e) {
        state.status = "error";
        state.lastError = String(e);
        log.error(e);
      }
    } else if (err?.code === "TokenInvalid") {
      state.status = "error";
      state.lastError = "Invalid bot token";
    } else {
      state.status = "error";
      state.lastError = String(err);
      log.error(err);
    }
  }
}

// Retourne { ok, message } (en Python : un tuple (bool, str))
export async function startBot() {
  try {
    if (!state.db) await connectDb();
    const cfg = await getConfig();
    const token = (cfg.token || process.env.DISCORD_TOKEN || "").trim();
    if (!token) return { ok: false, message: "No token configured" };
    if (state.status === "online" || state.status === "starting") {
      return { ok: false, message: `Bot already ${state.status}` };
    }
    state.status = "starting";
    state.lastError = null;
    state.task = runBot(token); // sans attendre (create_task)
    return { ok: true, message: "starting" };
  } catch (err) {
    state.status = "error";
    state.lastError = String(err);
    log.error(err);
    return { ok: false, message: String(err) };
  }
}

export async function stopBot() {
  if (state.bot) {
    try {
      await state.bot.destroy();
    } catch (e) {
      log.warn(`close failed: ${e}`);
    }
  }
  state.bot = null;
  state.task = null;
  state.status = "stopped";
  return true;
}

export function status() {
  const b = state.bot;
  return {
    status: state.status,
    last_error: state.lastError,
    bot_user: b?.user?.tag ?? null,
    guilds: b ? b.guilds.cache.size : 0,
  };
}

export function setDb(db) {
  state.db = db;
}

// ---------- Point d'entrée (désactivé : server.js pilote le cycle de vie) ----------
// Si tu utilises bot.js seul (sans server.js), décommente ces lignes :
//
// startBot().then((r) => log.info(`startBot: ${r.message}`));
//
// process.on("SIGINT", async () => {
//   await stopBot();
//   await state.mongo?.close();
//   process.exit(0);
// });
