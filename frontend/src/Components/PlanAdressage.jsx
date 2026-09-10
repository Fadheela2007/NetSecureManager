import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Plan d'adressage — ce qui est attribué, ce qui est réservé, ce qui reste.
 *
 * POURQUOI CET ÉCRAN EXISTE.
 *
 * L'inventaire dit ce qu'on a trouvé. Il ne dit jamais ce qu'on n'a PAS
 * trouvé, et sur un réseau c'est la moitié de l'information. « 47
 * équipements » ne répond ni à « mon réseau est-il plein ? », ni à
 * « quelle adresse puis-je donner à la nouvelle imprimante ? ».
 *
 * Il règle aussi, autrement, la question des adresses fantômes. Une
 * adresse derrière laquelle il n'y a personne ne disparaît pas : elle
 * redevient LIBRE. Un inventaire qui rétrécit sans explication inquiète ;
 * un compteur de libres qui augmente d'autant se comprend d'un coup d'œil.
 *
 * Aucun paquet n'est envoyé : cet écran croise la plage déclarée avec les
 * équipements déjà découverts. Il est donc instantané et utilisable devant
 * un client sans rien émettre sur son réseau.
 */
export default function PlanAdressage({ idSite, rafraichir }) {
  const [plans, setPlans] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);
  const [ouvertes, setOuvertes] = useState({});

  useEffect(() => {
    let annule = false;
    if (!idSite) return undefined;

    setChargement(true);
    axios
      .get(`${API_URL}/plan-adressage`, { params: { id_site: idSite } })
      .then(({ data }) => {
        if (annule) return;
        setPlans(data.plages || []);
        setErreur(null);
      })
      .catch((err) => {
        if (annule) return;
        setErreur(
          err.response?.data?.error ||
            "Le serveur ne répond pas — impossible de calculer le plan d'adressage."
        );
      })
      .finally(() => {
        if (!annule) setChargement(false);
      });

    return () => {
      annule = true;
    };
  }, [idSite, rafraichir]);

  if (chargement) {
    return (
      <p className="text-sm text-[var(--color-mute)]">Calcul du plan d'adressage…</p>
    );
  }
  if (erreur) return <p className="text-sm text-[var(--color-crit)]">{erreur}</p>;
  if (plans.length === 0) return null;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Plan d'adressage</h2>
        <p className="text-xs text-[var(--color-mute)] mt-1">
          Ce que contient chaque plage : les adresses attribuées, celles que la
          norme réserve, et celles qui restent disponibles.
        </p>
      </div>

      {plans.map((p) => (
        <PlanDUnePlage
          key={p.id_plage ?? p.cidr}
          plan={p}
          ouverte={Boolean(ouvertes[p.cidr])}
          basculer={() =>
            setOuvertes((o) => ({ ...o, [p.cidr]: !o[p.cidr] }))
          }
        />
      ))}
    </div>
  );
}

function PlanDUnePlage({ plan, ouverte, basculer }) {
  if (plan.erreur) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <p className="font-[var(--font-mono)] text-[13px]">{plan.cidr}</p>
        {/* Une plage illisible et une plage pleine ne doivent jamais se
            ressembler : c'est la distinction qui empêche de croire un plan
            complet alors qu'une plage n'a pas pu être lue. */}
        <p className="text-sm text-[var(--color-crit)] mt-1">
          Plage non calculée — {plan.erreur}
        </p>
      </div>
    );
  }

  const total = plan.total_attribuables || 1;
  const partOccupees = (plan.nb_occupees / total) * 100;
  const partReservees = (plan.nb_reservees / total) * 100;

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-[var(--font-mono)] text-[13px]">{plan.cidr}</p>
        {/* Les bornes ATTRIBUABLES, pas celles du bloc.

            La ligne annonçait « 510 adresses attribuables — 192.168.0.0 à
            192.168.1.255 » : or ces deux bornes-là sont précisément le
            réseau et la diffusion, les seules qu'on ne peut PAS attribuer.
            Le chiffre était juste et l'intervalle le contredisait. */}
        <p className="text-xs text-[var(--color-mute)]">
          {plan.total_attribuables.toLocaleString("fr-FR")} adresses attribuables —{" "}
          {plan.premiere_attribuable} à {plan.derniere_attribuable}
        </p>
      </div>

      {/* La barre porte l'information avant les chiffres : un réseau plein
          à 4 % et un réseau plein à 90 % ne doivent pas demander de lecture. */}
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        role="img"
        aria-label={`${plan.nb_occupees} occupées, ${plan.nb_reservees} réservées, ${plan.nb_libres} libres sur ${plan.total_attribuables}`}
      >
        <div
          className="bg-[var(--color-signal)]"
          style={{ width: `${partOccupees}%` }}
        />
        <div
          className="bg-[var(--color-mute)] opacity-60"
          style={{ width: `${partReservees}%` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Chiffre
          valeur={plan.nb_occupees}
          libelle="attribuées"
          detail={`${plan.taux_occupation} % de la plage`}
        />
        <Chiffre valeur={plan.nb_reservees} libelle="réservées" detail="non attribuables" />
        <Chiffre valeur={plan.nb_libres} libelle="libres" detail="disponibles" />
      </div>

      {plan.libres_exemples?.length > 0 && (
        <div>
          <p className="text-xs text-[var(--color-mute)] mb-1.5">
            Prochaines adresses libres
          </p>
          <div className="flex flex-wrap gap-1.5">
            {plan.libres_exemples.map((a) => (
              <span
                key={a}
                className="font-[var(--font-mono)] text-[12px] px-2 py-0.5 rounded border border-[var(--color-line)] text-[var(--color-mute)]"
              >
                {a}
              </span>
            ))}
            {plan.libres_tronquees && (
              <span className="text-[12px] text-[var(--color-mute)] px-1 py-0.5">
                … et {(plan.nb_libres - plan.libres_exemples.length).toLocaleString("fr-FR")} autres
              </span>
            )}
          </div>
        </div>
      )}

      <button
        onClick={basculer}
        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
      >
        {ouverte ? "Masquer le détail" : "Voir le détail des adresses"}
      </button>

      {ouverte && (
        <div className="space-y-4 pt-1">
          {plan.occupees.length > 0 && (
            <div className="table-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                    <th className="pb-2 font-medium">Adresse</th>
                    <th className="pb-2 font-medium">Équipement</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Pourquoi elle est occupée</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {plan.occupees.map((e) => (
                    <tr key={e.id_equipement}>
                      <td className="py-2 font-[var(--font-mono)] text-[13px]">
                        {e.adresse_ip}
                      </td>
                      <td className="py-2">
                        {e.nom || (
                          <span className="text-[var(--color-mute)]">
                            {e.fabricant ? `Appareil ${e.fabricant}` : "sans nom"}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-[var(--color-mute)]">{e.type || "inconnu"}</td>
                      {/* LA COLONNE QUI FAIT LA DIFFÉRENCE.

                          Les autres plateformes montrent un inventaire.
                          Celle-ci montre l'inventaire ET sa justification :
                          une ligne contestée se défend en la lisant, au
                          lieu de se discuter. */}
                      <td className="py-2 text-[var(--color-mute)] text-xs">
                        {e.preuve_detail || e.preuve_existence || "preuve antérieure au suivi"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {plan.reservees?.length > 0 && (
            <div>
              <p className="text-xs text-[var(--color-mute)] mb-1.5">Adresses réservées</p>
              <ul className="text-xs text-[var(--color-mute)] space-y-1">
                {plan.reservees.map((r) => (
                  <li key={r.adresse}>
                    <span className="font-[var(--font-mono)] text-[12px]">{r.adresse}</span>{" "}
                    — {r.role}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* La limite est écrite sous le tableau, pas reléguée à une note :
          c'est elle qui empêche de lire ce plan pour ce qu'il n'est pas. */}
      <p className="text-[11px] text-[var(--color-mute)] leading-relaxed border-t border-[var(--color-line)] pt-3">
        {plan.avertissement}
      </p>
    </div>
  );
}

function Chiffre({ valeur, libelle, detail }) {
  return (
    <div>
      <p className="text-xl font-semibold tabular-nums">
        {Number(valeur || 0).toLocaleString("fr-FR")}
      </p>
      <p className="text-xs">{libelle}</p>
      <p className="text-[11px] text-[var(--color-mute)]">{detail}</p>
    </div>
  );
}
