import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import EtatVide from "./EtatVide";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const STATUTS = [
  { cle: "ouvert", libelle: "Ouverts" },
  { cle: "en_cours", libelle: "En cours" },
  { cle: "ferme", libelle: "Fermés" },
];

/**
 * Durée écoulée, en langage courant.
 *
 * CE QUI N'ALLAIT PAS. La page n'affichait qu'une date d'ouverture
 * absolue : « Ouvert le 24/08/2026 09:12 ». Or la question posée devant
 * une liste d'incidents n'est jamais « quand » mais « depuis combien de
 * temps » — un incident ouvert depuis dix minutes et un autre depuis
 * quatre jours n'appellent pas la même réaction. La soustraction était
 * laissée à l'opérateur, sur chaque ligne.
 */
function depuis(date) {
  if (!date) return null;
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `${heures} h`;
  const jours = Math.floor(heures / 24);
  return jours === 1 ? "1 jour" : `${jours} jours`;
}

/**
 * Un incident devient préoccupant avec le temps, indépendamment de son
 * niveau : c'est la définition même d'un incident — une alerte que
 * personne n'a traitée. Le seuil de 24 h correspond à un jour ouvré
 * complet sans prise en charge.
 */
function tonAnciennete(date, statut) {
  if (statut === "ferme" || !date) return "var(--color-mute)";
  const heures = (Date.now() - new Date(date).getTime()) / 3600000;
  if (heures >= 24) return "var(--color-crit)";
  if (heures >= 4) return "var(--color-warn)";
  return "var(--color-mute)";
}

export default function IncidentsPage() {
  const [statut, setStatut] = useState("ouvert");
  const [incidents, setIncidents] = useState([]);
  const [erreur, setErreur] = useState(null);
  const [utilisateurs, setUtilisateurs] = useState([]);
  const [recherche, setRecherche] = useState("");
  const [chargement, setChargement] = useState(true);

  /**
   * Charge TOUS les incidents, sans filtre de statut.
   *
   * Le filtrage se fait ensuite côté navigateur. C'est ce qui permet
   * d'afficher un compteur sur chaque onglet : avec un filtre côté
   * serveur, on ne saurait pas qu'il reste trois incidents ouverts sans
   * cliquer sur l'onglet pour le découvrir.
   */
  async function charger() {
    const { data } = await axios.get(`${API_URL}/incidents`);
    setIncidents(data);
  }

  useEffect(() => {
    setChargement(true);
    charger()
      .catch(() => setIncidents([]))
      .finally(() => setChargement(false));
  }, []);

  // Liste réservée aux rôles admin/opérateur : un lecteur reçoit un 403 et
  // le menu d'assignation ne s'affiche simplement pas.
  useEffect(() => {
    axios
      .get(`${API_URL}/utilisateurs`)
      .then(({ data }) => setUtilisateurs(data))
      .catch(() => setUtilisateurs([]));
  }, []);

  // Compteurs calculés sur la liste COMPLÈTE, jamais sur la liste
  // filtrée : sinon l'onglet actif afficherait son propre total et les
  // autres zéro, ce qui est pire que pas de compteur du tout.
  const compteurs = useMemo(
    () => ({
      ouvert: incidents.filter((i) => i.statut === "ouvert").length,
      en_cours: incidents.filter((i) => i.statut === "en_cours").length,
      ferme: incidents.filter((i) => i.statut === "ferme").length,
    }),
    [incidents]
  );

  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return incidents
      .filter((i) => {
        if (i.statut !== statut) return false;
        if (!q) return true;
        return (
          (i.titre || "").toLowerCase().includes(q) ||
          (i.nom || "").toLowerCase().includes(q) ||
          (i.adresse_ip || "").includes(q) ||
          (i.assigne_nom || "").toLowerCase().includes(q)
        );
      })
      // Le PLUS ANCIEN en premier, et non le plus récent : sur une file
      // à traiter, ce qui traîne depuis quatre jours passe avant ce qui
      // vient d'arriver. Les incidents fermés gardent l'ordre inverse —
      // on y cherche ce qui vient de se clore.
      .sort((a, b) => {
        const da = new Date(a.date_ouverture || 0);
        const db_ = new Date(b.date_ouverture || 0);
        return statut === "ferme" ? db_ - da : da - db_;
      });
  }, [incidents, statut, recherche]);

  async function assigner(id, idUtilisateur) {
    setErreur(null);
    try {
      await axios.patch(`${API_URL}/incidents/${id}/assigner`, {
        id_utilisateur: idUtilisateur === "" ? null : Number(idUtilisateur),
      });
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible d'assigner cet incident");
    }
  }

  async function changerStatut(id, nouveauStatut) {
    setErreur(null);
    try {
      await axios.patch(`${API_URL}/incidents/${id}`, { statut: nouveauStatut });
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible de modifier cet incident");
    }
  }

  const libelleStatut =
    STATUTS.find((s) => s.cle === statut)?.libelle.toLowerCase() ?? "de ce type";
  const filtreMasque = recherche.trim() !== "" && visibles.length === 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Incidents</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Alertes non résolues après 15 minutes, escaladées en incident
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)]">
          {STATUTS.map((s) => (
            <button
              key={s.cle}
              onClick={() => setStatut(s.cle)}
              className={`px-3 py-1.5 rounded-md text-sm transition cible-tactile ${
                statut === s.cle
                  ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium"
                  : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
              }`}
            >
              {s.libelle}
              <span className="ml-1.5 opacity-70">{compteurs[s.cle]}</span>
            </button>
          ))}
        </div>

        <input
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          placeholder="Filtrer par équipement, titre, personne…"
          className="flex-1 min-w-[12rem] bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[var(--color-signal)] transition"
        />
      </div>

      {erreur && <p className="text-sm text-[var(--color-crit)]">{erreur}</p>}

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        {chargement ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement…</p>
        ) : visibles.length === 0 ? (
          /* Un filtre qui ne renvoie rien n'est PAS une bonne nouvelle :
             sans cette distinction, « Aucun incident ouvert » s'afficherait
             en vert alors qu'il en existe, simplement masqués par la
             recherche en cours. */
          filtreMasque ? (
            <EtatVide
              titre="Aucun incident ne correspond"
              ton="neutre"
              explication={`${compteurs[statut]} incident(s) ${libelleStatut} existent, mais aucun ne correspond à « ${recherche.trim()} ».`}
              action={
                <button
                  onClick={() => setRecherche("")}
                  className="text-sm text-[var(--color-signal)] hover:underline"
                >
                  Effacer la recherche
                </button>
              }
            />
          ) : (
            <EtatVide
              titre={`Aucun incident ${libelleStatut}`}
              ton={statut === "ouvert" ? "bien" : "neutre"}
              explication={
                statut === "ouvert"
                  ? "Un incident est créé automatiquement quand une alerte critique reste ouverte trop longtemps. Aucun n'est en cours."
                  : "Les incidents fermés restent consultables ici, avec leur durée et la personne qui les a pris en charge."
              }
            />
          )
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {visibles.map((inc) => {
              const age = depuis(inc.date_ouverture);
              return (
                <li
                  key={inc.id_incident}
                  className="py-3 flex flex-wrap items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm text-[var(--color-ink)]">{inc.titre}</p>
                      {/* L'ancienneté en premier plan, colorée selon sa
                          gravité : c'est l'information qui décide de
                          l'ordre de traitement. */}
                      {age && statut !== "ferme" && (
                        <span
                          className="text-[11px] px-1.5 py-0.5 rounded font-medium"
                          style={{
                            color: tonAnciennete(inc.date_ouverture, inc.statut),
                            border: `1px solid ${tonAnciennete(inc.date_ouverture, inc.statut)}`,
                          }}
                        >
                          depuis {age}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-mute)]">
                      {inc.nom || inc.adresse_ip}
                      {inc.description ? ` — ${inc.description}` : ""}
                    </p>
                    <p className="text-[11px] text-[var(--color-mute)] mt-0.5">
                      Ouvert le {new Date(inc.date_ouverture).toLocaleString("fr-FR")}
                      {inc.assigne_nom ? (
                        <>
                          {" — assigné à "}
                          <span className="text-[var(--color-signal)]">{inc.assigne_nom}</span>
                        </>
                      ) : (
                        " — non assigné"
                      )}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2 flex-wrap">
                    {utilisateurs.length > 0 && (
                      <select
                        value={inc.id_utilisateur_assigne ?? ""}
                        onChange={(e) => assigner(inc.id_incident, e.target.value)}
                        className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[var(--color-signal)] transition max-w-[160px]"
                      >
                        <option value="">Non assigné</option>
                        {utilisateurs.map((u) => (
                          <option key={u.id_utilisateur} value={u.id_utilisateur}>
                            {u.nom}
                          </option>
                        ))}
                      </select>
                    )}
                    {/* Les actions se décident sur le statut de LA LIGNE et
                        non sur l'onglet affiché : les deux se désynchronisent
                        dès qu'un incident change d'état sans rechargement. */}
                    {inc.statut === "ouvert" && (
                      <button
                        onClick={() => changerStatut(inc.id_incident, "en_cours")}
                        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-warn)] hover:text-[var(--color-warn)] transition"
                      >
                        Prendre en charge
                      </button>
                    )}
                    {inc.statut !== "ferme" && (
                      <button
                        onClick={() => changerStatut(inc.id_incident, "ferme")}
                        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-ok)] hover:text-[var(--color-ok)] transition"
                      >
                        Fermer
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
