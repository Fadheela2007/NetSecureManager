import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import EtatVide from "./EtatVide";
import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const ONGLETS = [
  { cle: "active", label: "À traiter" },
  { cle: "traitee", label: "Acquittées" },
  { cle: "resolue", label: "Résolues" },
];

const COULEUR_NIVEAU = {
  critical: "var(--color-crit)",
  warning: "var(--color-warn)",
  info: "var(--color-mute)",
};

/** « il y a 3 h », plus lisible qu'une date absolue pour un événement récent. */
function depuis(dateIso) {
  if (!dateIso) return "—";
  const ms = Date.now() - new Date(dateIso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.floor(h / 24);
  return `il y a ${j} j`;
}

function dateComplete(dateIso) {
  return dateIso ? new Date(dateIso).toLocaleString("fr-FR") : "—";
}

export default function AlertesPage() {
  const [statut, setStatut] = useState("active");
  const [alertes, setAlertes] = useState([]);
  const [chargement, setChargement] = useState(true);
  // Deux échecs de nature différente, donc deux états.
  //
  //   `erreur`       — le chargement a échoué : la page ne sait rien.
  //                    Elle remplace le contenu.
  //   `erreurAction` — un acquittement a échoué : la page sait, mais
  //                    l'opération n'est pas passée. Elle s'affiche
  //                    au-dessus de la liste, qui reste utilisable.
  //
  // Les confondre faisait disparaître le contenu sur un simple échec
  // d'acquittement, ou masquait l'échec d'action sous une liste intacte.
  const [erreur, setErreur] = useState(null);
  const [erreurAction, setErreurAction] = useState(null);
  const [message, setMessage] = useState(null);
  const [selection, setSelection] = useState(new Set());
  const [deplies, setDeplies] = useState(new Set());
  const [niveauChoisi, setNiveauChoisi] = useState("tous");
  const [recherche, setRecherche] = useState("");

  async function charger() {
    setChargement(true);
    try {
      const { data } = await axios.get(`${API_URL}/alertes`, { params: { statut } });
      setAlertes(data);
      setErreur(null);
    } catch (err) {
      // `decrireErreur` plutôt qu'un message unique : « Impossible de
      // charger les alertes » ne dit pas s'il faut redémarrer le
      // backend, se reconnecter, ou simplement réessayer.
      setErreur(decrireErreur(err, "Les alertes"));
    } finally {
      setChargement(false);
    }
  }

  useEffect(() => {
    setSelection(new Set());
    charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statut]);

  /**
   * Groupement par équipement : un administrateur raisonne par machine,
   * pas par alerte. Trois alertes sur le même serveur, c'est un problème
   * de serveur — pas trois problèmes.
   */
  // Compteurs par niveau, calculés sur la liste COMPLÈTE : ils doivent
  // rester stables quand on filtre, sinon l'onglet « Critiques 15 »
  // afficherait « Critiques 15 » puis « Critiques 15 sur 15 » — un
  // compteur qui change quand on clique dessus n'apprend rien.
  const compteurs = useMemo(
    () => ({
      tous: alertes.length,
      critical: alertes.filter((a) => a.niveau === "critical").length,
      warning: alertes.filter((a) => a.niveau === "warning").length,
      info: alertes.filter((a) => a.niveau === "info").length,
    }),
    [alertes]
  );

  const filtrees = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return alertes.filter((a) => {
      if (niveauChoisi !== "tous" && a.niveau !== niveauChoisi) return false;
      if (!q) return true;
      return (
        (a.nom || "").toLowerCase().includes(q) ||
        (a.adresse_ip || "").includes(q) ||
        (a.message || "").toLowerCase().includes(q) ||
        (a.type_alerte || "").toLowerCase().includes(q) ||
        (a.site_nom || "").toLowerCase().includes(q)
      );
    });
  }, [alertes, niveauChoisi, recherche]);

  const groupes = useMemo(() => {
    const parCle = new Map();
    for (const a of filtrees) {
      // Les alertes de site (agent muet) n'ont pas d'équipement.
      const cle = a.id_equipement ? `eq-${a.id_equipement}` : `site-${a.id_site}`;
      if (!parCle.has(cle)) {
        parCle.set(cle, {
          cle,
          titre: a.nom || a.adresse_ip || a.site_nom || "Site",
          sousTitre: a.id_equipement ? a.adresse_ip : `Site — ${a.site_nom ?? ""}`,
          type: a.type_equipement,
          statutEquipement: a.statut_equipement,
          site: a.site_nom,
          alertes: [],
        });
      }
      parCle.get(cle).alertes.push(a);
    }

    // Les groupes les plus graves d'abord, puis les plus récents.
    const rang = { critical: 0, warning: 1, info: 2 };
    return [...parCle.values()].sort((a, b) => {
      const ra = Math.min(...a.alertes.map((x) => rang[x.niveau] ?? 3));
      const rb = Math.min(...b.alertes.map((x) => rang[x.niveau] ?? 3));
      if (ra !== rb) return ra - rb;
      return b.alertes.length - a.alertes.length;
    });
  }, [filtrees]);

  // La sélection de masse ne porte QUE sur ce qui est affiché. Acquitter
  // « tout » alors qu'un filtre est actif toucherait des alertes que
  // l'opérateur ne voit pas — c'est la façon la plus sûre de faire
  // disparaître un problème sans l'avoir regardé.
  const idsVisibles = filtrees.map((a) => a.id_alerte);
  // On vérifie que CHAQUE alerte visible est cochée, plutôt que de
  // comparer des tailles : après un changement de filtre, la sélection
  // peut contenir des identifiants qui ne sont plus affichés, et la
  // comparaison de tailles cochait alors la case « tout sélectionner »
  // à tort.
  const toutSelectionne =
    idsVisibles.length > 0 && idsVisibles.every((id) => selection.has(id));

  function basculer(id) {
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function basculerGroupe(groupe) {
    const ids = groupe.alertes.map((a) => a.id_alerte);
    const tousDedans = ids.every((i) => selection.has(i));
    setSelection((s) => {
      const n = new Set(s);
      ids.forEach((i) => (tousDedans ? n.delete(i) : n.add(i)));
      return n;
    });
  }

  function basculerRepli(cle) {
    setDeplies((d) => {
      const n = new Set(d);
      if (n.has(cle)) n.delete(cle);
      else n.add(cle);
      return n;
    });
  }

  async function agirEnMasse(action) {
    if (selection.size === 0) return;
    setErreurAction(null);
    setMessage(null);
    try {
      const { data } = await axios.patch(`${API_URL}/alertes/${action}`, {
        ids: [...selection],
      });
      const n = data.acquittees ?? data.reactivees ?? 0;
      setMessage(
        action === "acquitter"
          ? `${n} alerte(s) acquittée(s). Elles restent en base et continuent d'alimenter le taux de disponibilité.`
          : `${n} alerte(s) remise(s) à traiter.`
      );
      setSelection(new Set());
      await charger();
    } catch (err) {
      setErreurAction(err.response?.data?.error || "L'opération a échoué");
    }
  }

  async function resoudre(id) {
    setErreurAction(null);
    try {
      await axios.patch(`${API_URL}/alertes/${id}/resoudre`);
      await charger();
    } catch (err) {
      setErreurAction(err.response?.data?.error || "Impossible de résoudre cette alerte");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Alertes</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Regroupées par équipement — une alerte par problème, pas par cycle de supervision
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {ONGLETS.map((o) => (
          <button
            key={o.cle}
            onClick={() => setStatut(o.cle)}
            className={`px-3 py-1.5 rounded-lg text-sm transition ${
              statut === o.cle
                ? "bg-[var(--color-signal)]/10 text-[var(--color-signal)] font-medium"
                : "text-[var(--color-mute)] hover:bg-[var(--color-surface-2)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* ── FILTRES ──
          Sur un incident réseau, une seule panne produit des dizaines
          d'alertes. Isoler les critiques est le premier geste ; le faire
          à l'œil dans une liste longue ne marche pas. */}
      {alertes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)]">
            {[
              { cle: "tous", libelle: "Tous" },
              { cle: "critical", libelle: "Critiques" },
              { cle: "warning", libelle: "Avertissements" },
              { cle: "info", libelle: "Information" },
            ]
              // Un niveau sans aucune alerte n'a pas d'onglet : trois
              // onglets à zéro occupent la place sans rien apprendre.
              .filter((n) => n.cle === "tous" || compteurs[n.cle] > 0)
              .map((n) => (
                <button
                  key={n.cle}
                  onClick={() => setNiveauChoisi(n.cle)}
                  className={`px-3 py-1.5 rounded-md text-sm transition cible-tactile ${
                    niveauChoisi === n.cle
                      ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium"
                      : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  {n.libelle}
                  <span className="ml-1.5 tabular-nums opacity-70">{compteurs[n.cle]}</span>
                </button>
              ))}
          </div>

          <input
            type="text"
            placeholder="Rechercher un équipement, un message…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            className="flex-1 min-w-[14rem] max-w-sm bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition"
          />

          {(niveauChoisi !== "tous" || recherche.trim()) && (
            <span className="text-xs text-[var(--color-mute)]">
              {filtrees.length} sur {alertes.length}
              <button
                onClick={() => {
                  setNiveauChoisi("tous");
                  setRecherche("");
                }}
                className="ml-2 hover:text-[var(--color-ink)] transition cible-tactile"
              >
                Tout afficher
              </button>
            </span>
          )}
        </div>
      )}

      {/* Barre d'action de masse : n'apparaît que si une sélection existe,
          pour ne pas encombrer l'écran au repos.

          `sticky` : sur une liste longue, elle disparaissait vers le haut
          dès qu'on descendait choisir d'autres alertes — on sélectionnait
          sans plus voir combien ni comment valider. */}
      {selection.size > 0 && (
        <div className="sticky top-2 z-20 flex items-center gap-3 flex-wrap bg-[var(--color-surface-2)] border border-[var(--color-signal)]/30 rounded-lg px-4 py-2.5 shadow-lg">
          <span className="text-sm">
            {selection.size} alerte(s) sélectionnée(s)
          </span>
          {statut === "active" ? (
            <button
              onClick={() => agirEnMasse("acquitter")}
              className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium hover:brightness-110 transition"
            >
              Acquitter la sélection
            </button>
          ) : statut === "traitee" ? (
            <button
              onClick={() => agirEnMasse("reactiver")}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
            >
              Remettre à traiter
            </button>
          ) : null}
          <button
            onClick={() => setSelection(new Set())}
            className="text-xs text-[var(--color-mute)] hover:text-[var(--color-ink)] transition ml-auto"
          >
            Tout désélectionner
          </button>
        </div>
      )}

      {erreurAction && (
        <p className="text-sm text-[var(--color-crit)]">{erreurAction}</p>
      )}
      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}

      {chargement ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
          <p className="text-sm text-[var(--color-mute)]">Chargement des alertes…</p>
        </div>
      ) : erreur ? (
        /* L'échec passe AVANT le test « aucune alerte ». Sans cette
           priorité, un serveur injoignable produisait « Rien à traiter »
           EN VERT — la page dont le rôle est d'énumérer les problèmes
           annonçait qu'il n'y en a aucun, faute d'avoir pu les lire. */
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl">
          <EtatVide
            titre={erreur.titre}
            ton="etape"
            explication={erreur.detail}
            action={{ libelle: "Réessayer", onClick: charger }}
          />
        </div>
      ) : groupes.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl">
          {/* Le filtre ne rend rien ≠ il n'y a rien. Sans ce test, un
              filtre trop étroit affichait « Rien à traiter » EN VERT
              alors que quinze alertes critiques attendaient juste
              derrière — le message le plus dangereux que cette page
              puisse produire. */}
          {/* « Aucune alerte à traiter » est une BONNE nouvelle : elle
              s'affiche en vert. « Aucune alerte acquittée » est un simple
              constat de navigation. Les traiter pareil, c'est priver
              l'utilisateur du seul moment où l'interface peut le
              rassurer. */}
          {niveauChoisi !== "tous" || recherche.trim() ? (
            <EtatVide
              titre="Aucune alerte ne correspond au filtre"
              explication={`${alertes.length} alerte(s) dans cet onglet, mais aucune ne correspond à votre recherche.`}
              action={{
                libelle: "Tout afficher",
                onClick: () => {
                  setNiveauChoisi("tous");
                  setRecherche("");
                },
              }}
            />
          ) : statut === "active" ? (
            <EtatVide
              titre="Rien à traiter"
              ton="bien"
              explication="Tout le parc supervisé répond normalement, et aucun seuil n'est dépassé."
              aide="Les alertes acquittées et résolues restent consultables dans les onglets voisins."
            />
          ) : statut === "traitee" ? (
            <EtatVide
              titre="Aucune alerte acquittée"
              explication="Les alertes que vous marquez « acquittées » apparaîtront ici. Elles sortent de la file à traiter sans être supprimées."
            />
          ) : (
            <EtatVide
              titre="Aucune alerte résolue"
              explication="Une alerte passe ici quand le problème disparaît — automatiquement au retour de l'équipement, ou manuellement."
            />
          )}
        </div>
      ) : (
        <>
          {statut === "active" && idsVisibles.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-[var(--color-mute)] cursor-pointer">
              <input
                type="checkbox"
                checked={toutSelectionne}
                onChange={() =>
                  setSelection(toutSelectionne ? new Set() : new Set(idsVisibles))
                }
              />
              Tout sélectionner ({idsVisibles.length})
            </label>
          )}

          <div className="space-y-3">
            {groupes.map((g) => {
              const replie = !deplies.has(g.cle) && g.alertes.length > 2;
              const visibles = replie ? g.alertes.slice(0, 2) : g.alertes;
              const pireNiveau = g.alertes.some((a) => a.niveau === "critical")
                ? "critical"
                : g.alertes.some((a) => a.niveau === "warning")
                ? "warning"
                : "info";

              return (
                <section
                  key={g.cle}
                  className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl overflow-hidden"
                >
                  {/* En-tête d'équipement */}
                  <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-line)]">
                    {statut !== "resolue" && (
                      <input
                        type="checkbox"
                        checked={g.alertes.every((a) => selection.has(a.id_alerte))}
                        onChange={() => basculerGroupe(g)}
                        title="Sélectionner toutes les alertes de cet équipement"
                      />
                    )}
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: COULEUR_NIVEAU[pireNiveau] }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--color-ink)] truncate">
                        {g.titre}
                      </p>
                      <p className="text-[11px] text-[var(--color-mute)] font-[var(--font-mono)]">
                        {g.sousTitre}
                        {g.type && g.type !== "inconnu" && (
                          <span className="font-[var(--font-display)]"> · {g.type}</span>
                        )}
                      </p>
                    </div>
                    <span className="text-xs text-[var(--color-mute)] shrink-0">
                      {g.alertes.length} alerte{g.alertes.length > 1 ? "s" : ""}
                    </span>
                  </header>

                  <ul className="divide-y divide-[var(--color-line)]">
                    {visibles.map((a) => (
                      <li key={a.id_alerte} className="px-4 py-3 flex gap-3">
                        {statut !== "resolue" && (
                          <input
                            type="checkbox"
                            className="mt-1 shrink-0"
                            checked={selection.has(a.id_alerte)}
                            onChange={() => basculer(a.id_alerte)}
                          />
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2 flex-wrap">
                            <span
                              className="text-[11px] uppercase tracking-wide font-medium shrink-0"
                              style={{ color: COULEUR_NIVEAU[a.niveau] }}
                            >
                              {a.type_alerte}
                            </span>

                            {/* Compteur d'occurrences : c'est lui qui remplace
                                l'empilement d'alertes identiques. */}
                            {a.occurrences > 1 && (
                              <span
                                className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-mute)] shrink-0"
                                title={`Détecté ${a.occurrences} fois depuis le ${dateComplete(
                                  a.premiere_detection
                                )}`}
                              >
                                ×{a.occurrences}
                              </span>
                            )}

                            {a.statut === "traitee" && (
                              <span className="text-[11px] text-[var(--color-mute)] shrink-0">
                                acquittée{a.acquittee_par_nom ? ` par ${a.acquittee_par_nom}` : ""}
                              </span>
                            )}
                          </div>

                          <p className="text-sm text-[var(--color-ink)] mt-1">{a.message}</p>

                          <p className="text-[11px] text-[var(--color-mute)] mt-1">
                            <span title={dateComplete(a.premiere_detection || a.date_creation)}>
                              1<sup>re</sup> détection {depuis(a.premiere_detection || a.date_creation)}
                            </span>
                            {a.occurrences > 1 && a.derniere_occurrence && (
                              <span title={dateComplete(a.derniere_occurrence)}>
                                {" · dernière "}
                                {depuis(a.derniere_occurrence)}
                              </span>
                            )}
                          </p>

                          {/* Cause et suggestions : conservées et lisibles sur
                              l'alerte groupée, elles sont la valeur ajoutée
                              de la plateforme face à un simple ping. */}
                          {a.suggestions?.length > 0 && (
                            <details className="mt-2 group">
                              <summary className="text-[11px] text-[var(--color-signal)] cursor-pointer select-none">
                                {a.suggestions.length} piste{a.suggestions.length > 1 ? "s" : ""} de
                                résolution
                                {a.cause_code && (
                                  <span className="text-[var(--color-mute)]"> · cause : {a.cause_code}</span>
                                )}
                              </summary>
                              <ul className="mt-1.5 space-y-1 pl-1">
                                {a.suggestions.map((s, i) => (
                                  <li
                                    key={i}
                                    className="text-[11px] text-[var(--color-mute)] flex gap-1.5"
                                  >
                                    <span className="text-[var(--color-signal)] shrink-0">→</span>
                                    {s}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>

                        {statut === "active" && (
                          <button
                            onClick={() => resoudre(a.id_alerte)}
                            title="Le problème est corrigé — clôture l'alerte"
                            className="shrink-0 self-start text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-ok)] hover:text-[var(--color-ok)] transition"
                          >
                            Résolue
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  {g.alertes.length > 2 && (
                    <button
                      onClick={() => basculerRepli(g.cle)}
                      className="w-full px-4 py-2 text-[11px] text-[var(--color-mute)] hover:text-[var(--color-signal)] border-t border-[var(--color-line)] transition"
                    >
                      {replie
                        ? `Afficher les ${g.alertes.length - 2} autre(s) alerte(s)`
                        : "Réduire"}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
