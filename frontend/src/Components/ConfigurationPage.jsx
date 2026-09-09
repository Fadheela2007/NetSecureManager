import Reinitialisation from "./Reinitialisation";
import { useEffect, useState } from "react";
import axios from "axios";

import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * État des rapports planifiés.
 *
 * La planification était pilotable — les clés `rapport_planifie_*`
 * apparaissent dans la liste ci-dessous — mais illisible : un champ libre
 * à côté de « rapport_planifie_frequence », sans indication des valeurs
 * acceptées ni moyen de savoir si un envoi aurait lieu. Un service qui
 * tourne toutes les heures et que personne ne peut consulter revient à ne
 * pas l'avoir.
 *
 * Ce panneau ne remplace pas les réglages : il les explique, dit ce qui
 * se passera, et permet d'essayer sans attendre le jour prévu.
 */
function RapportsPlanifies() {
  const [etat, setEtat] = useState(null);
  const [envoi, setEnvoi] = useState(false);
  const [bilan, setBilan] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    axios
      .get(`${API_URL}/rapport/planification`)
      .then(({ data }) => setEtat(data))
      .catch(() => setEtat({ indisponible: true }));
  }, []);

  async function envoyerMaintenant() {
    setEnvoi(true);
    setErreur(null);
    setBilan(null);
    try {
      const { data } = await axios.post(`${API_URL}/rapport/envoyer-maintenant`);
      setBilan(data);
    } catch (err) {
      setErreur(
        err.response?.data?.error ||
          "Envoi impossible. Vérifiez les paramètres SMTP dans le .env du serveur."
      );
    } finally {
      setEnvoi(false);
    }
  }

  if (!etat) return null;

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
      <h2 className="text-sm font-medium text-[var(--color-ink)]">Rapports planifiés</h2>

      {etat.indisponible ? (
        <p className="text-sm text-[var(--color-mute)] mt-2">
          État de la planification indisponible.
        </p>
      ) : (
        <p className="text-sm text-[var(--color-mute)] mt-2">
          {etat.doitEnvoyer
            ? "Un envoi aurait lieu maintenant."
            : /* `raison` dit POURQUOI rien ne part : « planification
                 désactivée », « ce n'est pas le jour », « ce n'est pas
                 l'heure ». Sans elle, on ne peut pas distinguer un
                 réglage volontaire d'une panne. */
              `Aucun envoi pour l'instant — ${etat.raison}.`}
        </p>
      )}

      <p className="text-[11px] text-[var(--color-mute)] mt-3 leading-relaxed">
        Se règle plus bas :{" "}
        <span className="font-[var(--font-mono)]">rapport_planifie_frequence</span>{" "}
        (desactive, hebdomadaire ou mensuel),{" "}
        <span className="font-[var(--font-mono)]">rapport_planifie_jour</span> (1 à 7
        pour un envoi hebdomadaire, 1 à 28 pour un envoi mensuel) et{" "}
        <span className="font-[var(--font-mono)]">rapport_planifie_heure</span> (0 à 23).
      </p>

      <button
        type="button"
        onClick={envoyerMaintenant}
        disabled={envoi}
        className="mt-4 text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50"
      >
        {envoi ? "Envoi en cours…" : "Envoyer un rapport de test maintenant"}
      </button>
      <p className="text-[11px] text-[var(--color-mute)] mt-2">
        Un envoi de test ne décale pas l'envoi automatique du jour.
      </p>

      {erreur && (
        <p className="text-sm mt-3" style={{ color: "var(--color-crit)" }}>
          {erreur}
        </p>
      )}

      {bilan && (
        <p className="text-sm mt-3" style={{ color: "var(--color-ok)" }}>
          {bilan.envoyes ?? 0} envoi(s) effectué(s)
          {bilan.ignores ? `, ${bilan.ignores} périmètre(s) ignoré(s) faute d'équipements` : ""}.
        </p>
      )}
    </div>
  );
}

export default function ConfigurationPage() {
  const [config, setConfig] = useState([]);
  const [modifs, setModifs] = useState({});
  const [message, setMessage] = useState(null);
  // Sans cet état, une lecture échouée affichait une page de
  // configuration VIDE : l'utilisateur croyait ses réglages perdus.
  const [erreurChargement, setErreurChargement] = useState(null);

  async function charger() {
    // Token porté par axios.defaults (App.jsx) — pas d'en-tête manuel.
    const { data } = await axios.get(`${API_URL}/configuration`);
    setConfig(data);
  }

  function rafraichir() {
    setErreurChargement(null);
    charger().catch((err) =>
      setErreurChargement(decrireErreur(err, "Les paramètres"))
    );
  }

  useEffect(() => { rafraichir(); }, []);

  async function sauvegarder(cle) {
    const valeur = modifs[cle];
    if (valeur === undefined) return;
    try {
      await axios.patch(`${API_URL}/configuration/${cle}`, { valeur });
      setMessage({ type: "ok", texte: "Paramètre mis à jour." });
      charger();
    } catch (err) {
      setMessage({ type: "erreur", texte: err.response?.data?.error || "Échec de la mise à jour" });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Configuration</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Seuils de détection et d'escalade des alertes
        </p>
      </div>

      {erreurChargement && (
        <div className="bg-[var(--color-surface)] border rounded-xl p-4"
             style={{ borderColor: "var(--color-crit)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--color-crit)" }}>
            {erreurChargement.titre}
          </p>
          <p className="text-sm text-[var(--color-mute)] mt-1">{erreurChargement.detail}</p>
          <button
            onClick={rafraichir}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
          >
            Réessayer
          </button>
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.type === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}`}>
          {message.texte}
        </p>
      )}

      <RapportsPlanifies />

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 space-y-4">
        {config.map((c) => (
          <div key={c.cle} className="flex items-center justify-between gap-4 pb-3 border-b border-[var(--color-line)] last:border-0 last:pb-0">
            <div className="min-w-0">
              <p className="text-sm text-[var(--color-ink)]">{c.description}</p>
              <p className="text-[11px] text-[var(--color-mute)] font-[var(--font-mono)]">{c.cle}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                defaultValue={c.valeur}
                onChange={(e) => setModifs((m) => ({ ...m, [c.cle]: e.target.value }))}
                className="w-20 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-[var(--color-signal)] transition"
              />
              <button
                onClick={() => sauvegarder(c.cle)}
                className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
              >
                Enregistrer
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* La réinitialisation vit tout en bas, et repliée. Elle n'a rien à
          faire près des réglages courants : on ne veut pas qu'un clic
          destiné à « Enregistrer » atterrisse dessus. */}
      <div className="mt-8 pt-6 border-t border-[var(--color-line)]">
        <Reinitialisation />
      </div>
    </div>
  );
}