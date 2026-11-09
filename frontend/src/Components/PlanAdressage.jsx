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
  /* Les réservations déclarées par l'entreprise. Rechargées avec le plan,
     puisqu'elles le changent : une zone déclarée retire des adresses des
     « libres », et l'écran doit montrer les deux ensemble ou aucun. */
  const [reservations, setReservations] = useState([]);
  const [versionReservations, setVersionReservations] = useState(0);

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
  }, [idSite, rafraichir, versionReservations]);

  useEffect(() => {
    if (!idSite) return;
    axios
      .get(`${API_URL}/reservations`, { params: { id_site: idSite } })
      .then(({ data }) => setReservations(data))
      // Migration du 28/09 non passée : la section ne s'affiche pas, le
      // plan reste juste — il ne connaît alors que la norme.
      .catch(() => setReservations([]));
  }, [idSite, versionReservations]);

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

      <Reservations
        idSite={idSite}
        reservations={reservations}
        surChangement={() => setVersionReservations((v) => v + 1)}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CE QUE L'ENTREPRISE A DÉJÀ PROMIS

   La norme réserve trois adresses ; l'entreprise en réserve des dizaines,
   et pour des raisons que la norme ignore. La plus coûteuse est le pool
   du serveur DHCP : une adresse prise dedans fonctionne quelques jours,
   puis le DHCP l'attribue à son tour, et la panne qui suit se cherche du
   côté du câble.

   LE MOTIF EST OBLIGATOIRE, et ce n'est pas de la paperasse : une zone
   réservée sans raison écrite devient, six mois plus tard, une zone que
   personne n'ose toucher et que personne ne sait justifier.
   ══════════════════════════════════════════════════════════════════════ */
const CATEGORIES = [
  { cle: "dhcp", libelle: "Pool DHCP" },
  { cle: "reseau", libelle: "Équipements réseau" },
  { cle: "serveurs", libelle: "Serveurs" },
  { cle: "imprimantes", libelle: "Imprimantes" },
  { cle: "autre", libelle: "Autre" },
];

function Reservations({ idSite, reservations, surChangement }) {
  const [ouvert, setOuvert] = useState(false);
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const [motif, setMotif] = useState("");
  const [categorie, setCategorie] = useState("dhcp");
  const [exclure, setExclure] = useState(false);
  const [erreur, setErreur] = useState(null);
  const [envoi, setEnvoi] = useState(false);

  async function ajouter(e) {
    e.preventDefault();
    setEnvoi(true);
    setErreur(null);
    try {
      await axios.post(`${API_URL}/reservations`, {
        id_site: idSite,
        debut: debut.trim(),
        fin: fin.trim(),
        motif: motif.trim(),
        categorie,
        exclure_du_scan: exclure,
      });
      setDebut("");
      setFin("");
      setMotif("");
      setExclure(false);
      surChangement();
      setOuvert(false);
    } catch (err) {
      setErreur(err.response?.data?.error || "Enregistrement refusé.");
    } finally {
      setEnvoi(false);
    }
  }

  async function supprimer(id) {
    setErreur(null);
    try {
      await axios.delete(`${API_URL}/reservations/${id}`);
      surChangement();
    } catch (err) {
      setErreur(err.response?.data?.error || "Suppression impossible.");
    }
  }

  const libelleCategorie = (cle) =>
    CATEGORIES.find((c) => c.cle === cle)?.libelle || "Autre";

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">Adresses réservées par l'entreprise</h3>
          <p className="text-xs text-[var(--color-mute)] mt-0.5">
            Déclarées ici, elles sortent des adresses « libres » : la plateforme
            ne proposera plus une adresse du pool DHCP pour un serveur.
          </p>
        </div>
        <button
          onClick={() => setOuvert((o) => !o)}
          className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition cible-tactile"
        >
          {ouvert ? "Annuler" : "Déclarer une zone"}
        </button>
      </div>

      {ouvert && (
        <form onSubmit={ajouter} className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-[var(--color-mute)]">
            De
            <input
              value={debut}
              onChange={(e) => setDebut(e.target.value)}
              placeholder="192.168.0.100"
              required
              className="block w-36 mt-0.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[var(--color-ink)] font-[var(--font-mono)] text-[12px]"
            />
          </label>
          <label className="text-[11px] text-[var(--color-mute)]">
            à
            <input
              value={fin}
              onChange={(e) => setFin(e.target.value)}
              placeholder="192.168.0.200"
              required
              className="block w-36 mt-0.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[var(--color-ink)] font-[var(--font-mono)] text-[12px]"
            />
          </label>
          <label className="text-[11px] text-[var(--color-mute)]">
            Usage
            <select
              value={categorie}
              onChange={(e) => setCategorie(e.target.value)}
              className="block mt-0.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[var(--color-ink)] text-[12px]"
            >
              {CATEGORIES.map((c) => (
                <option key={c.cle} value={c.cle}>
                  {c.libelle}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-mute)] flex-1 min-w-[200px]">
            Pourquoi
            <input
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Distribué par le serveur DHCP"
              required
              className="block w-full mt-0.5 px-2 py-1 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[var(--color-ink)] text-[12px]"
            />
          </label>
          {/* CE QUE CETTE CASE FAIT VRAIMENT : le balayage n'envoie plus
              rien à ces adresses. nmap reçoit `--exclude`, et notre propre
              balayage ne les énumère pas. Pour un automate ou un
              équipement médical, filtrer les résultats après coup ne
              suffirait pas — les paquets seraient déjà partis. */}
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-mute)]">
            <input
              type="checkbox"
              checked={exclure}
              onChange={(e) => setExclure(e.target.checked)}
              className="accent-[var(--color-signal)]"
            />
            ne pas scanner ces adresses
          </label>
          <button
            type="submit"
            disabled={envoi}
            className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium disabled:opacity-60 cible-tactile"
          >
            {envoi ? "…" : "Enregistrer"}
          </button>
        </form>
      )}

      {erreur && <p className="text-xs text-[var(--color-crit)]">{erreur}</p>}

      {reservations.length === 0 ? (
        <p className="text-xs text-[var(--color-mute)]">
          Aucune zone déclarée. Le plan ne connaît donc que les adresses que la
          norme réserve — réseau, diffusion, et les .0/.255 internes.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {reservations.map((r) => (
            <li key={r.id_reservation} className="py-2 flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="font-[var(--font-mono)] text-[12px] text-[var(--color-ink)]">
                  {r.debut} → {r.fin}
                </p>
                <p className="text-[11px] text-[var(--color-mute)]">
                  {libelleCategorie(r.categorie)} — {r.motif}
                  {r.exclure_du_scan && " · non scannée"}
                  {r.cree_par_nom && ` · déclaré par ${r.cree_par_nom}`}
                </p>
              </div>
              <button
                onClick={() => supprimer(r.id_reservation)}
                className="text-[11px] text-[var(--color-mute)] hover:text-[var(--color-crit)] underline shrink-0 cible-tactile"
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      )}
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
        {/* « DONT N D'AFFILÉE » — le chiffre qui manquait.

            200 adresses libres éparpillées une par une et 200 adresses
            libres d'un seul tenant s'affichaient exactement pareil. Or
            le réseau est PLEIN dans le premier cas pour qui veut poser
            dix serveurs consécutifs, et largement ouvert dans le second. */}
        <Chiffre
          valeur={plan.nb_libres}
          libelle="libres"
          detail={
            plan.plus_grand_bloc_libre
              ? `dont ${plan.plus_grand_bloc_libre.toLocaleString("fr-FR")} d'affilée`
              : "disponibles"
          }
        />
      </div>

      <button
        onClick={basculer}
        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
      >
        {/* L'intitulé dit ce qu'on va VOIR, pas qu'on va « voir plus ».
            « Détail des adresses » ne laissait pas deviner que la
            réponse à « où poser la prochaine machine » était derrière. */}
        {ouverte ? "Masquer les adresses libres" : "Voir les adresses libres"}
      </button>

      {ouverte && (
        <div className="space-y-5 pt-1">
          {/* ── OÙ IL RESTE DE LA PLACE — EN PREMIER, ET C'EST LE SUJET ──

              Le détail s'ouvrait sur le tableau des adresses ATTRIBUÉES.
              Sur un site de cent onze machines, il fallait donc faire
              défiler cent onze lignes pour atteindre ce qu'on était venu
              chercher : les adresses encore disponibles.

              L'ordre disait la mauvaise chose. Cet écran s'appelle « plan
              d'adressage » : on l'ouvre pour savoir où poser la
              prochaine machine, pas pour relire l'inventaire — qui a son
              propre écran, fait pour ça.

              Les intervalles passent donc devant, et le tableau des
              attribuées descend derrière son propre bouton. */}
          <div>
            <p className="text-xs mb-2">Où il reste de la place</p>

            {plan.libres_intervalles === null ? (
              /* Pas de calcul n'est pas « pas de place » : la nuance
                 doit être écrite, sinon une plage démesurée se lirait
                 comme un réseau plein. */
              <p className="text-xs text-[var(--color-mute)]">
                Plage trop large pour être cartographiée adresse par adresse.
                Découpez-la en plages plus petites — un /24 par VLAN est l'usage.
              </p>
            ) : plan.libres_intervalles?.length > 0 ? (
              <>
                <ul className="space-y-1">
                  {plan.libres_intervalles.map((i) => {
                    const leMeilleur = i.nb === plan.plus_grand_bloc_libre;
                    return (
                      <li
                        key={i.debut}
                        className={`flex flex-wrap items-baseline justify-between gap-2 rounded-lg px-2.5 py-1.5 border ${
                          leMeilleur
                            ? "border-[var(--color-signal)]/40 bg-[var(--color-signal)]/5"
                            : "border-[var(--color-line)]"
                        }`}
                      >
                        <span className="font-[var(--font-mono)] text-[13px]">
                          {/* Un intervalle d'une seule adresse ne s'écrit
                              pas « x → x » : c'est une adresse, et
                              l'écrire deux fois fait douter du calcul. */}
                          {i.nb === 1 ? i.debut : `${i.debut} → ${i.fin}`}
                        </span>
                        <span
                          className={`text-xs tabular-nums ${
                            leMeilleur
                              ? "text-[var(--color-signal)]"
                              : "text-[var(--color-mute)]"
                          }`}
                        >
                          {i.nb.toLocaleString("fr-FR")} adresse{i.nb > 1 ? "s" : ""}
                          {leMeilleur && plan.libres_intervalles.length > 1
                            ? " — le plus grand bloc"
                            : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {plan.libres_intervalles_tronques > 0 && (
                  <p className="text-[11px] text-[var(--color-mute)] mt-1.5">
                    … et {plan.libres_intervalles_tronques.toLocaleString("fr-FR")} autre(s)
                    intervalle(s) non listé(s).
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--color-mute)]">
                Aucune adresse libre dans cette plage — elle est pleine.
              </p>
            )}
          </div>

          {/* La liste plate répond à une AUTRE question que les
              intervalles : « laquelle je donne à cette imprimante, là,
              maintenant ». Elle reste donc, juste en dessous, et elle est
              copiable telle quelle. */}
          {plan.libres_exemples?.length > 0 && (
            <div>
              <p className="text-xs text-[var(--color-mute)] mb-1.5">
                Prochaines adresses libres, à prendre telles quelles
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

          {/* CE QUI EST POSÉ SUR UNE ZONE RÉSERVÉE. Ce n'est pas encore
              une panne, c'est une panne qui attend son tour : une adresse
              fixe donnée à la main dans le pool DHCP fonctionne jusqu'au
              jour où le DHCP la distribue à son tour. */}
          {plan.occupants_de_zones_reservees?.length > 0 && (
            <div>
              <p className="text-xs mb-1.5" style={{ color: "var(--color-warn)" }}>
                Machines posées sur une zone réservée
              </p>
              <ul className="text-xs text-[var(--color-mute)] space-y-1">
                {plan.occupants_de_zones_reservees.map((o) => (
                  <li key={o.adresse}>
                    <span className="font-[var(--font-mono)] text-[12px]">{o.adresse}</span>
                    {o.nom ? ` — ${o.nom}` : ""} — dans « {o.motif} »
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.reservations_declarees?.length > 0 && (
            <div>
              <p className="text-xs text-[var(--color-mute)] mb-1.5">
                Zones réservées par l'entreprise
              </p>
              <ul className="text-xs text-[var(--color-mute)] space-y-1">
                {plan.reservations_declarees.map((r) => (
                  <li key={r.id_reservation}>
                    <span className="font-[var(--font-mono)] text-[12px]">
                      {r.debut_effectif} → {r.fin_effectif}
                    </span>{" "}
                    — {r.motif} ({r.nb_adresses} adresses
                    {r.occupees?.length > 0 ? `, dont ${r.occupees.length} déjà occupée(s)` : ""})
                  </li>
                ))}
              </ul>
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

          {/* Les attribuées EN DERNIER, et repliées. L'information reste
              accessible — avec sa colonne de preuve, qui est ce que ce
              produit a de plus défendable — mais elle ne fait plus écran
              à ce qu'on vient chercher ici. */}
          {plan.occupees.length > 0 && <Attribuees occupees={plan.occupees} />}
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

/**
 * Le tableau des adresses attribuées, replié par défaut.
 *
 * Son propre état d'ouverture, et non celui du détail : on ouvre le
 * détail pour voir la place disponible, pas pour relire l'inventaire. Les
 * deux gestes sont distincts, les deux boutons aussi.
 */
function Attribuees({ occupees }) {
  const [ouvert, setOuvert] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOuvert((o) => !o)}
        className="text-xs text-[var(--color-mute)] hover:text-[var(--color-ink)] transition"
      >
        {ouvert ? "▾" : "▸"} Adresses attribuées ({occupees.length.toLocaleString("fr-FR")})
      </button>

      {ouvert && (
        <div className="table-scroll mt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                <th className="pb-2 pr-4 font-medium">Adresse</th>
                <th className="pb-2 pr-4 font-medium">Équipement</th>
                <th className="pb-2 pr-4 font-medium">Type</th>
                <th className="pb-2 font-medium">Pourquoi elle est occupée</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {occupees.map((e) => (
                <tr key={e.id_equipement}>
                  <td className="py-2 pr-4 font-[var(--font-mono)] text-[13px]">
                    {e.adresse_ip}
                  </td>
                  <td className="py-2 pr-4">
                    {e.nom || (
                      <span className="text-[var(--color-mute)]">
                        {e.fabricant ? `Appareil ${e.fabricant}` : "sans nom"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-[var(--color-mute)]">{e.type || "inconnu"}</td>
                  {/* LA COLONNE QUI FAIT LA DIFFÉRENCE.

                      Les autres plateformes montrent un inventaire.
                      Celle-ci montre l'inventaire ET sa justification :
                      une ligne contestée se défend en la lisant, au lieu
                      de se discuter. */}
                  <td className="py-2 text-[var(--color-mute)] text-xs">
                    {e.preuve_detail || e.preuve_existence || "preuve antérieure au suivi"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
