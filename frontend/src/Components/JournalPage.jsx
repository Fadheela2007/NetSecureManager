import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import EtatVide from "./EtatVide";
import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Catalogue des actions journalisées.
 *
 * CE QUI N'ALLAIT PAS. Les 200 dernières lignes défilaient d'un bloc,
 * toutes de la même couleur : un scan de routine et une réinitialisation
 * de la base se ressemblaient trait pour trait. Or c'est exactement
 * l'inverse de ce qu'on attend d'un journal — il existe pour retrouver
 * l'événement rare au milieu du bruit courant.
 *
 * Les actions sont donc classées par ENJEU :
 *
 *   sensible — touche aux comptes ou détruit des données. C'est ce qu'un
 *              auditeur vient chercher, et ce qui doit sauter aux yeux.
 *   action   — modifie l'état de la supervision.
 *   routine  — activité normale, la majorité des lignes.
 */
const ACTIONS = {
  connexion: { libelle: "Connexion", enjeu: "sensible" },
  amorcage: { libelle: "Création du premier compte", enjeu: "sensible" },
  reinitialisation: { libelle: "Réinitialisation", enjeu: "sensible" },
  scan_lance: { libelle: "Scan réseau", enjeu: "routine" },
  alertes_acquittees: { libelle: "Acquittement", enjeu: "action" },
  alerte_resolue: { libelle: "Alerte résolue", enjeu: "action" },
  incident_modifie: { libelle: "Incident modifié", enjeu: "action" },
  equipement_renomme: { libelle: "Équipement renommé", enjeu: "action" },
};

const COULEUR_ENJEU = {
  sensible: "var(--color-crit)",
  action: "var(--color-signal)",
  routine: "var(--color-mute)",
};

const FILTRES = [
  { cle: "tout", libelle: "Tout" },
  { cle: "sensible", libelle: "Sensible" },
  { cle: "action", libelle: "Actions" },
  { cle: "routine", libelle: "Routine" },
];

/**
 * Une action inconnue du catalogue est traitée comme une action, pas
 * ignorée : une version ultérieure du backend peut journaliser un type
 * que cette page ne connaît pas encore, et le faire disparaître de
 * l'affichage serait bien pire que de l'afficher sans étiquette.
 */
function decrire(action) {
  return ACTIONS[action] || { libelle: action || "Action", enjeu: "action" };
}

/** Regroupe par jour, en conservant l'ordre reçu (du plus récent au plus ancien). */
function grouperParJour(lignes) {
  const groupes = [];
  let courant = null;
  for (const l of lignes) {
    const jour = new Date(l.date_log).toDateString();
    if (!courant || courant.jour !== jour) {
      courant = { jour, date: l.date_log, lignes: [] };
      groupes.push(courant);
    }
    courant.lignes.push(l);
  }
  return groupes;
}

/** « Aujourd'hui », « Hier », sinon la date en toutes lettres. */
function titreDeJour(date) {
  const d = new Date(date);
  const aujourdhui = new Date();
  const hier = new Date();
  hier.setDate(hier.getDate() - 1);

  if (d.toDateString() === aujourdhui.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === hier.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === aujourdhui.getFullYear() ? undefined : "numeric",
  });
}

export default function JournalPage() {
  const [logs, setLogs] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);
  const [filtre, setFiltre] = useState("tout");
  const [recherche, setRecherche] = useState("");

  function rafraichir() {
    setChargement(true);
    setErreur(null);
    axios
      .get(`${API_URL}/logs`)
      .then(({ data }) => setLogs(data))
      .catch((err) => setErreur(decrireErreur(err, "Le journal")))
      .finally(() => setChargement(false));
  }

  useEffect(() => {
    rafraichir();
  }, []);

  // Compteurs sur la liste COMPLÈTE : un compteur qui change quand on
  // filtre ne renseigne plus sur rien.
  const compteurs = useMemo(() => {
    const c = { tout: logs.length, sensible: 0, action: 0, routine: 0 };
    for (const l of logs) c[decrire(l.action).enjeu]++;
    return c;
  }, [logs]);

  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return logs.filter((l) => {
      if (filtre !== "tout" && decrire(l.action).enjeu !== filtre) return false;
      if (!q) return true;
      return (
        (l.description || "").toLowerCase().includes(q) ||
        (l.nom || "").toLowerCase().includes(q) ||
        (l.email || "").toLowerCase().includes(q) ||
        decrire(l.action).libelle.toLowerCase().includes(q) ||
        (l.adresse_ip_utilisateur || "").includes(q)
      );
    });
  }, [logs, filtre, recherche]);

  const groupes = useMemo(() => grouperParJour(visibles), [visibles]);
  const filtreActif = filtre !== "tout" || recherche.trim() !== "";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Journal d'activité</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Actions récentes sur la plateforme (200 dernières)
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)]">
          {FILTRES.map((f) => (
            <button
              key={f.cle}
              onClick={() => setFiltre(f.cle)}
              className={`px-3 py-1.5 rounded-md text-sm transition cible-tactile ${
                filtre === f.cle
                  ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium"
                  : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
              }`}
            >
              {f.libelle}
              <span className="ml-1.5 opacity-70">{compteurs[f.cle]}</span>
            </button>
          ))}
        </div>

        <input
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          placeholder="Filtrer par personne, adresse, description…"
          className="flex-1 min-w-[12rem] bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[var(--color-signal)] transition"
        />
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        {chargement ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement…</p>
        ) : erreur ? (
          /* Un journal vide et un journal illisible ne s'expliquent pas
             pareil : le premier attend une première action, le second
             attend qu'on répare la liaison. */
          <EtatVide
            titre={erreur.titre}
            ton="etape"
            explication={erreur.detail}
            action={{ libelle: "Réessayer", onClick: rafraichir }}
          />
        ) : logs.length === 0 ? (
          <EtatVide
            titre="Aucune activité enregistrée"
            explication="Le journal retient les connexions, les scans, les acquittements et les changements de configuration. Il se remplira dès la première action."
          />
        ) : visibles.length === 0 ? (
          /* Le journal n'est PAS vide — c'est le filtre qui masque tout.
             Confondre les deux ferait croire à une perte de données. */
          <EtatVide
            titre="Aucune ligne ne correspond"
            ton="neutre"
            explication={`Le journal contient ${logs.length} ligne(s), mais aucune ne correspond aux critères en cours.`}
            /* Objet { libelle, onClick } et non du JSX : voir EtatVide. */
            action={{
              libelle: "Réinitialiser les filtres",
              onClick: () => {
                setFiltre("tout");
                setRecherche("");
              },
            }}
          />
        ) : (
          <>
            {filtreActif && (
              <p className="text-xs text-[var(--color-mute)] mb-3">
                {visibles.length} sur {logs.length} affichée(s)
              </p>
            )}

            <div className="space-y-5">
              {groupes.map((groupe) => (
                <section key={groupe.jour}>
                  {/* Le regroupement par jour donne le repère que 200
                      horodatages complets à la suite ne donnent pas :
                      chaque ligne portait la date, donc aucune ne la
                      signalait. */}
                  <h2 className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-2 pb-1 border-b border-[var(--color-line)]">
                    {titreDeJour(groupe.date)}
                  </h2>
                  <ul className="divide-y divide-[var(--color-line)]">
                    {groupe.lignes.map((l) => {
                      const { libelle, enjeu } = decrire(l.action);
                      return (
                        <li key={l.id_log} className="py-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                          <span className="text-[var(--color-mute)] text-xs font-[var(--font-mono)] shrink-0">
                            {new Date(l.date_log).toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          <span
                            className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                            style={{
                              color: COULEUR_ENJEU[enjeu],
                              border: `1px solid ${COULEUR_ENJEU[enjeu]}`,
                            }}
                          >
                            {libelle}
                          </span>
                          <span className="text-[var(--color-ink)]">{l.nom || "Système"}</span>
                          <span className="text-[var(--color-mute)] min-w-0">
                            {l.description}
                          </span>
                          {/* L'adresse d'où vient l'action : sans elle, un
                              journal ne permet pas de dire d'où quelqu'un
                              s'est connecté — la première question posée
                              après un incident de sécurité. */}
                          {l.adresse_ip_utilisateur && enjeu === "sensible" && (
                            <span className="text-[11px] text-[var(--color-mute)] font-[var(--font-mono)]">
                              depuis {l.adresse_ip_utilisateur}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
