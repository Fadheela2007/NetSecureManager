import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const ETATS = {
  jamais_connecte: { couleur: "var(--color-mute)", texte: "En attente de la première remontée" },
  muet: { couleur: "var(--color-crit)", texte: "Agent muet" },
  actif: { couleur: "var(--color-ok)", texte: "Agent actif" },
};

function Copiable({ valeur, libelle }) {
  const [copie, setCopie] = useState(false);

  async function copier() {
    try {
      await navigator.clipboard.writeText(valeur);
      setCopie(true);
      setTimeout(() => setCopie(false), 2000);
    } catch {
      // clipboard indisponible (http non sécurisé) : on laisse la sélection manuelle
      setCopie(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] text-[var(--color-mute)]">{libelle}</span>
        <button
          onClick={copier}
          className="text-[11px] px-2 py-0.5 rounded border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
        >
          {copie ? "Copié" : "Copier"}
        </button>
      </div>
      <pre className="bg-[var(--color-abyss)] border border-[var(--color-line)] rounded-lg p-3 text-[12px] font-[var(--font-mono)] overflow-x-auto whitespace-pre text-[var(--color-ink)]">
        {valeur}
      </pre>
    </div>
  );
}

/**
 * Mise en service d'un agent distant.
 *
 * L'écran fait trois choses, dans l'ordre où on en a besoin :
 *   1. donner la commande d'installation, jeton déjà inséré
 *   2. surveiller la remontée en direct
 *   3. confirmer quand elle arrive
 *
 * Le point 2 est le plus important à la démonstration : on lance la
 * commande sur la machine distante et l'écran bascule tout seul en
 * « Agent actif ». C'est ce qui répond à « combien de temps pour
 * ajouter une ville ? ».
 */
export default function MiseEnServiceAgent({ idSite, onFermer }) {
  const [infos, setInfos] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [systeme, setSysteme] = useState("linux");
  const [jetonVisible, setJetonVisible] = useState(false);
  const [regeneration, setRegeneration] = useState(false);

  async function charger(silencieux = false) {
    try {
      const { data } = await axios.get(`${API_URL}/sites/${idSite}/agent`);
      setInfos(data);
      setErreur(null);
    } catch (err) {
      if (!silencieux) setErreur(err.response?.data?.error || "Chargement impossible");
    }
  }

  useEffect(() => {
    charger();
    // Sondage régulier : c'est ce qui fait basculer l'écran tout seul
    // quand l'agent se met à transmettre.
    const t = setInterval(() => charger(true), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  async function regenerer() {
    if (
      !window.confirm(
        "Régénérer le jeton ?\n\nL'agent déjà installé sur ce site sera rejeté " +
          "jusqu'à ce que vous relanciez l'installation avec le nouveau jeton."
      )
    )
      return;
    setRegeneration(true);
    try {
      await axios.post(`${API_URL}/sites/${idSite}/regenerer-token`);
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Régénération impossible");
    } finally {
      setRegeneration(false);
    }
  }

  if (erreur) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <p className="text-sm text-[var(--color-crit)]">{erreur}</p>
      </div>
    );
  }

  if (!infos) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <p className="text-sm text-[var(--color-mute)]">Chargement…</p>
      </div>
    );
  }

  const etat = ETATS[infos.agent.etat] || ETATS.jamais_connecte;
  const enService = infos.agent.etat === "actif";

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl overflow-hidden">
      <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--color-line)]">
        <div>
          <h2 className="font-[var(--font-display)] text-base font-semibold">
            Mettre en service l'agent — {infos.nom}
          </h2>
          <p className="text-xs text-[var(--color-mute)] mt-0.5">
            Trois minutes sur une machine du réseau de {infos.ville}
          </p>
        </div>
        <button
          onClick={onFermer}
          className="text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] transition shrink-0"
        >
          Fermer ✕
        </button>
      </header>

      {/* Bandeau d'état, mis à jour toutes les 5 s */}
      <div
        className="flex items-center gap-3 px-5 py-3 border-b border-[var(--color-line)]"
        style={{ background: enService ? "color-mix(in srgb, var(--color-ok) 8%, transparent)" : undefined }}
      >
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${enService ? "" : "pulse-dot"}`}
          style={{ background: etat.couleur, color: etat.couleur }}
        />
        <div className="min-w-0">
          <p className="text-sm" style={{ color: etat.couleur }}>
            {enService ? "Agent actif" : etat.texte}
          </p>
          <p className="text-[11px] text-[var(--color-mute)]">
            {infos.agent.etat === "jamais_connecte"
              ? "Lancez la commande ci-dessous sur la machine du site — cet écran se met à jour tout seul."
              : `${infos.agent.libelle} · ${infos.equipements_remontes} équipement(s) remonté(s)`}
          </p>
        </div>
      </div>

      <div className="p-5 space-y-5">
        <ol className="space-y-4">
          <li>
            <p className="text-sm font-medium mb-1">
              1. Copiez l'agent sur une machine du réseau de {infos.ville}
            </p>
            <p className="text-xs text-[var(--color-mute)]">
              Un mini-PC, une VM ou un poste allumé en permanence. Node.js 18 ou plus est requis.
            </p>
          </li>

          <li>
            <p className="text-sm font-medium mb-2">2. Lancez la commande d'installation</p>

            <div className="flex gap-2 mb-3">
              {[
                { cle: "linux", label: "Linux" },
                { cle: "windows", label: "Windows" },
                { cle: "manuel", label: "Fichier .env" },
              ].map((s) => (
                <button
                  key={s.cle}
                  onClick={() => setSysteme(s.cle)}
                  className={`px-3 py-1 rounded-lg text-xs transition ${
                    systeme === s.cle
                      ? "bg-[var(--color-signal)]/10 text-[var(--color-signal)] font-medium"
                      : "text-[var(--color-mute)] hover:bg-[var(--color-surface-2)]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {systeme === "linux" && (
              <Copiable
                libelle="Depuis backend/src/agent, en root"
                valeur={infos.commandes.linux}
              />
            )}
            {systeme === "windows" && (
              <Copiable
                libelle="PowerShell en administrateur, depuis backend\src\agent"
                valeur={infos.commandes.windows}
              />
            )}
            {systeme === "manuel" && (
              <Copiable
                libelle="À écrire dans backend/.env puis : node src/agent/agent.js"
                valeur={infos.commandes.envManuel}
              />
            )}

            {!infos.cidr_suggere && (
              <p className="text-[11px] text-[var(--color-warn)] mt-2">
                Aucune plage n'est déclarée pour ce site : la commande utilise
                192.168.1.0/24 par défaut. Ajustez <code>--cidr</code> ou déclarez la
                plage dans « Plages réseau ».
              </p>
            )}
          </li>

          <li>
            <p className="text-sm font-medium mb-1">3. C'est terminé</p>
            <p className="text-xs text-[var(--color-mute)]">
              Le script installe le service, le fait démarrer au boot, et vérifie la
              remontée. Le bandeau ci-dessus passe au vert dès la première transmission.
            </p>
          </li>
        </ol>

        <div className="border-t border-[var(--color-line)] pt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-[11px] text-[var(--color-mute)] mb-1">Jeton du site</p>
              <p className="font-[var(--font-mono)] text-[12px] break-all">
                {jetonVisible ? infos.agent_token : "•".repeat(48)}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => setJetonVisible((v) => !v)}
                className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
              >
                {jetonVisible ? "Masquer" : "Afficher"}
              </button>
              <button
                onClick={regenerer}
                disabled={regeneration}
                className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-crit)] hover:text-[var(--color-crit)] transition disabled:opacity-50"
              >
                {regeneration ? "…" : "Régénérer"}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-[var(--color-mute)] mt-2">
            Ce jeton vaut un mot de passe : il autorise l'envoi de données au nom de ce
            site. Régénérez-le si vous pensez qu'il a fuité — l'agent devra être
            réinstallé.
          </p>
        </div>
      </div>
    </div>
  );
}
