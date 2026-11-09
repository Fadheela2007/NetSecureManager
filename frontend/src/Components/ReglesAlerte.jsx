import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   LES CONDITIONS QUI DÉCLENCHENT UNE ALERTE

   Cet écran ne décrit pas ce que la plateforme fait : il le DÉCIDE. Ce
   qui est affiché ici est exactement ce que le cycle de supervision
   applique, à la minute près — il n'y a pas de règle cachée ailleurs, et
   pas de règle montrée ici qui serait ignorée.

   CE QUI N'EST PAS DANS LA LISTE N'EST PAS SURVEILLÉ. Disque plein,
   antivirus arrêté, certificat expirant : ces conditions sont mesurées
   mais pas encore évaluées en continu. Les afficher éteintes laisserait
   croire qu'il suffit d'un clic ; on les ajoutera quand le moteur saura
   les traiter.
   ══════════════════════════════════════════════════════════════════════ */

const NIVEAUX = [
  { cle: "critical", libelle: "Critique", couleur: "var(--color-crit)" },
  { cle: "warning", libelle: "Avertissement", couleur: "var(--color-warn)" },
  { cle: "info", libelle: "Information", couleur: "var(--color-mute)" },
];

/* L'unité du seuil dépend de la condition. L'écrire à côté du champ évite
   la question « 30 quoi ? » — et la réponse fausse qui s'ensuit. */
const UNITE = {
  cpu: "% d'utilisation",
  memoire: "% d'utilisation",
  agent_muet: "minutes de silence",
  plage_presque_pleine: "% d'adresses libres",
};

const FAMILLE = {
  equipement_down: "Une machine ne répond plus",
  cpu: "Charge de la machine",
  memoire: "Charge de la machine",
  plage_presque_pleine: "Plan d'adressage",
  adresse_sur_zone_reservee: "Plan d'adressage",
  agent_muet: "Supervision d'un site distant",
};

export default function ReglesAlerte({ estAdmin }) {
  const [regles, setRegles] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [enCours, setEnCours] = useState(null);

  useEffect(() => {
    axios
      .get(`${API_URL}/regles-alerte`)
      .then(({ data }) => setRegles(data))
      .catch((err) =>
        setErreur(
          err.response?.data?.error ||
            "Impossible de lire les règles d'alerte."
        )
      );
  }, []);

  async function modifier(regle, changement) {
    setEnCours(regle.id_regle);
    setErreur(null);
    try {
      const { data } = await axios.patch(
        `${API_URL}/regles-alerte/${regle.id_regle}`,
        changement
      );
      setRegles((liste) =>
        liste.map((r) => (r.id_regle === data.id_regle ? data : r))
      );
    } catch (err) {
      setErreur(err.response?.data?.error || "Modification refusée.");
    } finally {
      setEnCours(null);
    }
  }

  if (erreur && !regles) {
    return <p className="text-sm" style={{ color: "var(--color-crit)" }}>{erreur}</p>;
  }
  if (!regles) {
    return <p className="text-sm text-[var(--color-mute)]">Chargement des règles…</p>;
  }

  // Regroupées par famille : trois « ne répond plus » côte à côte se
  // comparent, alors qu'une liste à plat se lit ligne par ligne.
  const familles = [];
  for (const r of regles) {
    const titre = FAMILLE[r.code] || r.code;
    const existante = familles.find((f) => f.titre === titre);
    if (existante) existante.regles.push(r);
    else familles.push({ titre, regles: [r] });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--color-mute)]">
        Ce tableau décide de ce qui déclenche une alerte, et de sa gravité. Le
        cycle de supervision le relit chaque minute.
        {!estAdmin && " Seul un administrateur peut le modifier."}
      </p>

      {erreur && (
        <p className="text-sm" style={{ color: "var(--color-crit)" }}>{erreur}</p>
      )}

      {familles.map((famille) => (
        <section
          key={famille.titre}
          className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5"
        >
          <h2 className="font-[var(--font-display)] text-sm font-semibold mb-3">
            {famille.titre}
          </h2>

          <div className="space-y-3">
            {famille.regles.map((r) => (
              <div
                key={r.id_regle}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5"
                style={{ opacity: r.active ? 1 : 0.6 }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-[240px] flex-1">
                    <p className="text-sm text-[var(--color-ink)]">{r.libelle}</p>
                    {r.aide && (
                      <p className="text-[11px] text-[var(--color-mute)] mt-0.5">{r.aide}</p>
                    )}
                  </div>

                  {/* L'interrupteur d'abord : c'est le geste le plus
                      fréquent, et il rend les autres réglages sans objet. */}
                  <button
                    onClick={() => modifier(r, { active: !r.active })}
                    disabled={!estAdmin || enCours === r.id_regle}
                    className="text-[11px] px-2.5 py-1 rounded-full border transition cible-tactile disabled:opacity-60"
                    style={{
                      borderColor: r.active ? "var(--color-ok)" : "var(--color-line)",
                      color: r.active ? "var(--color-ok)" : "var(--color-mute)",
                    }}
                  >
                    {r.active ? "Active" : "Éteinte"}
                  </button>
                </div>

                {r.active && (
                  <div className="flex flex-wrap items-center gap-4 mt-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-[var(--color-mute)]">Gravité</span>
                      {NIVEAUX.map((niv) => {
                        const choisi = r.niveau === niv.cle;
                        return (
                          <button
                            key={niv.cle}
                            onClick={() => modifier(r, { niveau: niv.cle })}
                            disabled={!estAdmin || choisi || enCours === r.id_regle}
                            className="text-[11px] px-2 py-0.5 rounded-full border transition cible-tactile disabled:opacity-100"
                            style={{
                              borderColor: choisi ? niv.couleur : "var(--color-line)",
                              color: choisi ? niv.couleur : "var(--color-mute)",
                            }}
                          >
                            {niv.libelle}
                          </button>
                        );
                      })}
                    </div>

                    {r.seuil !== null && (
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-mute)]">
                        Seuil
                        <input
                          type="number"
                          defaultValue={r.seuil}
                          min={0}
                          disabled={!estAdmin}
                          /* Enregistré à la SORTIE du champ, pas à chaque
                             frappe : taper « 95 » enverrait sinon un seuil
                             à 9 %, appliqué pendant une seconde. */
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v) && v !== Number(r.seuil)) {
                              modifier(r, { seuil: v });
                            }
                          }}
                          className="w-16 px-2 py-0.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-ink)]"
                        />
                        {UNITE[r.code] || ""}
                      </label>
                    )}

                    {r.releves_requis !== null && (
                      <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-mute)]">
                        Après
                        <input
                          type="number"
                          defaultValue={r.releves_requis}
                          min={1}
                          max={60}
                          disabled={!estAdmin}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v !== Number(r.releves_requis)) {
                              modifier(r, { releves_requis: v });
                            }
                          }}
                          className="w-14 px-2 py-0.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-ink)]"
                        />
                        vérifications consécutives
                      </label>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {/* CE QUI N'EST PAS ENCORE ÉVALUÉ EST DIT, PLUTÔT QUE TU. Un
          exploitant qui croit son disque surveillé alors qu'il ne l'est
          pas découvrira l'erreur le jour où le disque sera plein. */}
      <p className="text-[11px] text-[var(--color-mute)]">
        Pas encore dans cette liste, donc pas surveillés en continu : disque
        presque plein, pare-feu ou antivirus arrêté, machine jamais
        redémarrée, certificat expirant. Ces données sont collectées et
        visibles sur les fiches, mais aucune alerte n'en sort pour l'instant.
      </p>
    </div>
  );
}
