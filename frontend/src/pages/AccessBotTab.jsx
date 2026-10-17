import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Bot, Play, Square, RefreshCw } from "lucide-react";
import {
    adminAccessBotConfig, adminAccessBotSave, adminAccessBotStatus,
    adminAccessBotStart, adminAccessBotStop,
} from "../lib/api";

export default function AccessBotTab({ token }) {
    const [cfg, setCfg] = useState(null);
    const [status, setStatus] = useState({ status: "stopped" });
    const [newToken, setNewToken] = useState("");
    const [saving, setSaving] = useState(false);
    const [busy, setBusy] = useState(false);

    const loadStatus = useCallback(async () => {
        try { setStatus(await adminAccessBotStatus(token)); } catch {}
    }, [token]);

    const loadConfig = useCallback(async () => {
        try { setCfg(await adminAccessBotConfig(token)); }
        catch { toast.error("Failed to load Access Bot config"); }
    }, [token]);

    useEffect(() => { loadConfig(); }, [loadConfig]);
    useEffect(() => {
        loadStatus();
        const iv = setInterval(loadStatus, 5000);
        return () => clearInterval(iv);
    }, [loadStatus]);

    const patch = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

    const save = async () => {
        setSaving(true);
        try {
            const payload = {
                prefix: cfg.prefix || "",
                access_role_id: cfg.access_role_id || "",
                staff_role_id: cfg.staff_role_id || "",
            };
            if (newToken.trim()) payload.token = newToken.trim();
            await adminAccessBotSave(token, payload);
            setNewToken("");
            await loadConfig(); // récupère le token masqué à jour
            toast.success("Access Bot config saved");
        } catch (e) {
            toast.error(e?.response?.data?.detail || "Failed");
        } finally {
            setSaving(false);
        }
    };

    const start = async () => {
        setBusy(true);
        try {
            const r = await adminAccessBotStart(token);
            if (r.ok) toast.success(r.message || "starting");
            else toast.error(r.message || "Failed");
            loadStatus();
        } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
        finally { setBusy(false); }
    };

    const stop = async () => {
        setBusy(true);
        try { await adminAccessBotStop(token); toast.success("Access Bot stopped"); loadStatus(); }
        catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
        finally { setBusy(false); }
    };

    if (!cfg) return <div style={{ padding: 30, color: "#8a8a8a" }}>Loading Access Bot config...</div>;

    const statusColor = status.status === "online" ? "#22c55e"
        : status.status === "error" ? "#ef4444"
        : status.status === "starting" ? "#FACC15" : "#8a8a8a";

    const inp = (label, k, placeholder = "") => (
        <div>
            <div className="admin-label" style={{ marginBottom: 6 }}>{label}</div>
            <input className="snap-input" placeholder={placeholder} value={cfg[k] || ""}
                onChange={(e) => patch(k, e.target.value)} data-testid={`access-bot-${k}`} />
        </div>
    );

    return (
        <div style={{ padding: 22 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 22 }} className="admin-grid">
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="admin-card">
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                            <Bot size={20} color="#FACC15" />
                            <div style={{ fontSize: 20, fontWeight: 700 }}>Access Bot (2nd bot)</div>
                        </div>
                        <p style={{ color: "#8a8a8a", fontSize: 13, margin: "4px 0 16px" }}>
                            Gestion de l'accès / du temps avec des commandes à préfixe : add-time, check-time et freeze-time.
                            Utilise une application Discord différente de celle du bot principal.
                        </p>

                        <div className="admin-label" style={{ marginBottom: 6 }}>Bot token</div>
                        <input className="snap-input" type="password"
                            placeholder={cfg.token_masked || "Paste the 2nd bot's Discord token"}
                            value={newToken} onChange={(e) => setNewToken(e.target.value)}
                            data-testid="access-bot-token-input" />
                        <p style={{ color: "#6a6a6a", fontSize: 11, marginTop: 6 }}>
                            {cfg.token_masked ? `Current: ${cfg.token_masked}` : "No token yet (ACCESS_BOT_TOKEN env var used if set)"} · Leave empty to keep current
                        </p>
                    </div>

                    <div className="admin-card">
                        <div className="admin-label" style={{ marginBottom: 10 }}>Prefix & roles</div>
                        <p style={{ color: "#8a8a8a", fontSize: 12, margin: "0 0 10px" }}>
                            Laisse vide pour utiliser la valeur par défaut (préfixe « ! », rôles du bot principal).
                        </p>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                            {inp("Command prefix", "prefix", "! (default)")}
                            {inp("Access role ID", "access_role_id", "role given by add-time")}
                            {inp("Staff role ID", "staff_role_id", "role allowed to use add-time")}
                        </div>
                    </div>

                    <button className="snap-btn" onClick={save} disabled={saving} data-testid="access-bot-save-btn">
                        {saving ? "Saving..." : "Save configuration"}
                    </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="admin-card">
                        <div className="admin-label">Access Bot control</div>
                        <div style={{ marginTop: 12, padding: 14, background: "#0d0d0d", borderRadius: 14, border: "1px solid #1a1a1a" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                <span style={{ width: 12, height: 12, borderRadius: 999, background: statusColor, boxShadow: `0 0 12px ${statusColor}` }} />
                                <b style={{ color: statusColor, textTransform: "uppercase", fontSize: 13, letterSpacing: 1.5 }}>{status.status}</b>
                            </div>
                            {status.bot_user && <div style={{ marginTop: 8, color: "#c0c0c0", fontSize: 13 }}>{status.bot_user}</div>}
                            {status.guilds !== undefined && <div style={{ color: "#8a8a8a", fontSize: 12 }}>Guilds: {status.guilds}</div>}
                            {status.last_error && <div style={{ marginTop: 8, color: "#ef4444", fontSize: 12 }}>{status.last_error}</div>}
                        </div>

                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                            <button className="snap-btn" style={{ padding: "12px 18px", fontSize: 14 }} onClick={start}
                                disabled={busy || status.status === "online" || status.status === "starting"} data-testid="access-bot-start-btn">
                                <Play size={14} /> Start
                            </button>
                            <button className="snap-btn-ghost" style={{ padding: "12px 18px", borderColor: "rgba(239,68,68,0.4)", color: "#ef4444" }}
                                onClick={stop} disabled={busy || status.status === "stopped"} data-testid="access-bot-stop-btn">
                                <Square size={14} /> Stop
                            </button>
                        </div>
                        <button className="snap-btn-ghost" style={{ marginTop: 8, width: "100%" }} onClick={loadConfig} data-testid="access-bot-reload-cfg">
                            <RefreshCw size={14} /> Reload config from server
                        </button>
                    </div>

                    <div className="admin-card">
                        <div className="admin-label">Commands</div>
                        <ul style={{ marginTop: 10, paddingLeft: 20, color: "#c0c0c0", fontSize: 12, lineHeight: 1.7 }}>
                            <li><code>{(cfg.prefix || "!") + "add-time @member hours"}</code> (staff) : crée / ajoute des heures</li>
                            <li><code>{(cfg.prefix || "!") + "check-time [@member]"}</code> : temps restant</li>
                            <li><code>{(cfg.prefix || "!") + "freeze-time"}</code> : gèle / dégèle son propre temps</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}
