import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";

import { brancherRafraichissement } from "../utils/tempsReel";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const PERIODES = [
  { heures: 1, label: "1 h" },
  { heures: 6, label: "6 h" },
  { heures: 24, label: "24 h" },
  { heures: 24 * 7, label: "7 j" },
];

/**
 * Met un débit en kbit/s à l'échelle qui se lit.
 *
 * « 1 048 576 kbit/s » est techniquement exact et humainement inutilisable.
 * On bascule en Mbit/s puis Gbit/s, avec une décimale : la précision au
 * kilobit près n'a aucun sens sur une mesure calculée par différence de
 * compteurs sur cinq minutes.
 */
function formaterDebit(kbps) {
  if (kbps === null || kbps === undefined) return "—";
  const n = Number(kbps);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} Gbit/s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} Mbit/s`;
  if (n >= 10) return `${Math.round(n)} kbit/s`;
  return `${n.toFixed(1)} kbit/s`;
}

/** Total entrant + sortant, en tolérant qu'un des deux sens soit NULL. */
function cumul(a, b) {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function dateCourte(valeur, heures) {
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return "";
  return heures > 48
    ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })
    : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Barre de proportion du classement.
 *
 * Elle est relative au PREMIER du classement, pas à la capacité du lien :
 * on répond ici à « qui consomme le plus », pas à « qui sature ». Le taux
 * d'utilisation, lui, s'affiche par interface sur la fiche de
 * l'équipement, où la vitesse du lien est connue.
 */
function BarreProportion({ valeur, maximum }) {
  const pct = !maximum || !valeur ? 0 : Math.max(2, (valeur / maximum) * 100);
  return (
    <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-2)] overflow-hidden">
      <div
        className="h-full rounded-full bg-[var(--color-signal)] transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── LA LARGEUR EST OBSERVÉE, PLUS DEVINÉE ──

   Les deux graphiques de cet écran mesuraient leur conteneur dans un
   effet déclenché par des états choisis à la main — le panneau de
   détail, la période, les données. Cela revenait à parier sur l'instant
   où le conteneur existe. Le pari a été perdu sur la fiche d'un
   équipement : l'effet s'exécutait pendant que l'écran affichait encore
   « aucun relevé », le conteneur n'existait pas, et comme les états
   surveillés ne rebougeaient plus, la mesure n'avait jamais lieu. La
   largeur restait à zéro, le graphique n'était pas construit, et
   l'utilisateur voyait un titre suivi de rien.

   Une référence de rappel supprime le pari : React l'appelle au moment
   exact où il attache le nœud au document. Le ResizeObserver prend
   ensuite le relais pour tout changement de taille. Aucune liste de
   dépendances à tenir à jour, donc aucune à oublier. */
function useLargeurObservee() {
  const observateur = useRef(null);
  const [largeur, setLargeur] = useState(0);

  const attacher = useCallback((el) => {
    if (observateur.current) {
      observateur.current.disconnect();
      observateur.current = null;
    }
    if (!el) return;

    const mesurer = () => {
      const l = el.getBoundingClientRect().width;
      // Une largeur nulle n'est jamais retenue : elle survient pendant
      // les transitions et ferait clignoter le graphique.
      if (l > 0) setLargeur(Math.round(l));
    };

    mesurer();
    if (typeof ResizeObserver !== "undefined") {
      observateur.current = new ResizeObserver(mesurer);
      observateur.current.observe(el);
    }
  }, []);

  return [attacher, largeur];
}

export default function BandePassantePage({ idSite }) {
  const [heures, setHeures] = useState(24);
  // Horodatage du dernier rafraîchissement réussi : sur un écran qui se
  // met à jour tout seul, savoir DE QUAND datent les chiffres vaut autant
  // que les chiffres.
  const [maj, setMaj] = useState(null);
  const [donnees, setDonnees] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);

  // Équipement dont on affiche l'historique. Le détail vit sous le
  // classement plutôt que dans une fenêtre : on compare le graphique aux
  // autres lignes sans perdre le contexte.
  const [selection, setSelection] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailEnCours, setDetailEnCours] = useState(false);

  /* ─────────────────────────────────────────────────────────────────
     LARGEUR DU GRAPHIQUE, MESURÉE À LA MAIN

     `ResponsiveContainer` de recharts observe son parent pour se
     dimensionner. Quand ce parent apparaît en même temps que lui — ici,
     le panneau de détail qui se déplie au clic — la mesure a lieu avant
     que la mise en page ne soit calculée. Le conteneur retient alors
     une largeur de ZÉRO et ne la révise jamais.

     Le résultat à l'écran : un cadre vide de la bonne hauteur. Aucune
     erreur, aucune trace en console. La courbe existe dans le document,
     à la bonne couleur, dans un dessin large de 0 pixel.

     Le même défaut s'est produit sur la fiche d'un équipement. On avait
     alors cherché du côté des couleurs, du format des nombres et de
     l'animation avant de simplement MESURER le conteneur — qui faisait
     « 0 x 180 ».

     Cette logique est volontairement recopiée depuis EquipementDetail
     plutôt que partagée : une première tentative d'extraction en hook
     avait cassé le composant. À mutualiser quand le protocole de test
     sera terminé, pas au milieu.
     ───────────────────────────────────────────────────────────────── */
  const [conteneurGraphique, largeurGraphique] = useLargeurObservee();
  const [conteneurGlobal, largeurGlobale] = useLargeurObservee();
  const [historique, setHistorique] = useState(null);

  /* ── CHARGEMENT, PUIS RAFRAÎCHISSEMENT SILENCIEUX ──

     Le premier chargement affiche « Chargement… » : l'écran est vide, il
     faut dire qu'il travaille. Les rafraîchissements suivants ne le font
     PAS. Un écran qui clignote « Chargement… » toutes les minutes est
     illisible, et l'utilisateur finit par croire à une instabilité alors
     que la plateforme fait exactement son travail.

     Même raison pour l'erreur : une requête de rafraîchissement qui
     échoue n'efface pas les chiffres déjà affichés. Des données d'il y a
     une minute valent mieux qu'un écran vide, tant qu'on ne prétend pas
     qu'elles sont fraîches — c'est ce que dit l'horodatage plus bas. */
  const chargerClassement = useCallback(
    (silencieux = false) => {
      if (!silencieux) {
        setChargement(true);
        setErreur(null);
      }
      /* LES DEUX APPELS PARTENT ENSEMBLE.

         L'historique suit exactement le même cycle de vie que le
         classement : même période, même rafraîchissement, même
         cloisonnement côté serveur. Les enchaîner ferait attendre le
         second que le premier revienne, pour rien.

         L'historique est facultatif : s'il échoue, le classement et les
         totaux restent affichés. Un graphique manquant vaut mieux qu'un
         écran vide. */
      return Promise.all([
        axios.get(`${API_URL}/bande-passante/classement`, { params: { heures, limite: 20 } }),
        axios
          .get(`${API_URL}/bande-passante/historique`, { params: { heures } })
          .catch(() => null),
      ])
        .then(([reponseClassement, reponseHistorique]) => {
          const data = reponseClassement.data;
          setHistorique(reponseHistorique?.data ?? null);
          setDonnees(data);
          setMaj(new Date());
          setErreur(null);
        })
        .catch((err) => {
          if (!silencieux) setErreur(err.response?.data?.error || "Classement indisponible");
        })
        .finally(() => {
          if (!silencieux) setChargement(false);
        });
    },
    [heures]
  );

  useEffect(() => {
    chargerClassement(false);
  }, [chargerClassement, idSite]);

  /* ── CE QUI REND CET ÉCRAN VIVANT ──

     « cycle » est l'événement de fin de cycle de supervision : c'est lui
     qui annonce de nouvelles mesures. Les événements « equipement » ne
     partent que sur un changement d'état — une machine qui tombe — et ne
     couvrent donc jamais le cas normal, celui où cent relevés sont écrits
     sans que rien ne change d'état.

     « scan » est ajouté parce qu'un scan peut faire apparaître des
     équipements qui n'étaient pas au classement. */
  useEffect(
    () => brancherRafraichissement(() => chargerClassement(true), ["cycle", "scan"]),
    [chargerClassement]
  );

  useEffect(() => {
    if (!selection) { setDetail(null); return; }
    let annule = false;
    setDetailEnCours(true);

    axios
      .get(`${API_URL}/equipements/${selection}/bande-passante`, { params: { heures } })
      .then(({ data }) => { if (!annule) setDetail(data); })
      .catch(() => { if (!annule) setDetail({ historique: [], interfaces: [] }); })
      .finally(() => { if (!annule) setDetailEnCours(false); });

    return () => { annule = true; };
  }, [selection, heures]);

  const classement = donnees?.classement ?? [];

  const maximum = useMemo(() => {
    let m = 0;
    for (const r of classement) {
      const t = cumul(r.moy_entrant, r.moy_sortant);
      if (t !== null && t > m) m = t;
    }
    return m;
  }, [classement]);

  const courbe = useMemo(() => {
    if (!detail?.historique) return [];
    return detail.historique.map((p) => ({
      t: dateCourte(p.date_releve, heures),
      entrant: p.trafic_entrant_kbps === null ? null : Number(p.trafic_entrant_kbps),
      sortant: p.trafic_sortant_kbps === null ? null : Number(p.trafic_sortant_kbps),
    }));
  }, [detail, heures]);

  /* La courbe globale : un point par tranche de temps, débit du parc
     entier. `dateCourte` prend la période en compte — sur 24 h on lit une
     heure, sur 30 jours une date ; afficher l'heure sur un mois donnerait
     deux cents étiquettes illisibles. */
  const courbeGlobale = useMemo(() => {
    if (!historique?.points) return [];
    return historique.points.map((p) => ({
      t: dateCourte(p.instant, heures),
      entrant: p.entrant === null ? null : Number(p.entrant),
      sortant: p.sortant === null ? null : Number(p.sortant),
    }));
  }, [historique, heures]);

  const selectionne = classement.find((r) => r.id_equipement === selection);
  const couverture = donnees?.couverture;
  const total = donnees?.total;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-ink)]">Bande passante</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            Les plus gros consommateurs du parc, classés sur la moyenne de la période.
          </p>
        </div>

        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)]">
          {PERIODES.map((p) => (
            <button
              key={p.heures}
              onClick={() => setHeures(p.heures)}
              className={`px-3 py-1.5 rounded-md text-sm transition cible-tactile ${
                heures === p.heures
                  ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium"
                  : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/*
        Un classement vide ressemble à une panne. Ce bandeau dit ce qui se
        passe réellement : la mesure du débit exige SNMP, que la majorité
        des postes de travail n'activent pas. Sans cette phrase, la
        plateforme a l'air cassée alors qu'elle est simplement honnête.
      */}
      {/* TOTAL GLOBAL.
          Placé avant le classement : la première question est « combien
          consomme-t-on », la seconde « qui ». Les équipements de transit
          (routeurs, switches, pare-feu) sont exclus du calcul côté
          serveur — leur compteur est la somme des machines branchées
          dessus, les additionner compterait deux fois le même trafic.
          Le mot « mesuré » est délibéré : ce n'est pas la consommation du
          site tant que tout le parc n'expose pas de compteur. */}
      {/* DE QUAND DATENT CES CHIFFRES.
          Sur un écran qui se met à jour tout seul, c'est la question qui
          vient juste après « combien ». Sans horodatage, l'utilisateur ne
          sait pas s'il regarde la mesure de l'instant ou celle d'avant la
          coupure réseau — et il rechargera la page pour en avoir le cœur
          net, ce que le rafraîchissement automatique était censé éviter. */}
      {maj && (
        <p className="text-xs text-[var(--color-mute)]">
          Mis à jour à {maj.toLocaleTimeString("fr-FR")} — cet écran se rafraîchit tout seul.
        </p>
      )}

      {total && total.equipements_comptes > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
            <div className="text-xs text-[var(--color-mute)]">
              Descendant — total du parc
            </div>
            <div className="text-xl font-semibold text-[var(--color-ink)] mt-1">
              {formaterDebit(total.moy_entrant)}
            </div>
            {/* « simultané » n'est pas un détail de vocabulaire : le
                serveur regroupe désormais les relevés par minute avant de
                sommer, donc ce pic correspond à un instant qui a
                réellement eu lieu. La somme de pics isolés donnerait un
                chiffre que le parc n'a jamais atteint. */}
            <div className="text-xs text-[var(--color-mute)] mt-0.5">
              pic simultané {formaterDebit(total.pic_entrant)}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
            <div className="text-xs text-[var(--color-mute)]">
              Montant — total du parc
            </div>
            <div className="text-xl font-semibold text-[var(--color-ink)] mt-1">
              {formaterDebit(total.moy_sortant)}
            </div>
            <div className="text-xs text-[var(--color-mute)] mt-0.5">
              pic simultané {formaterDebit(total.pic_sortant)}
            </div>
          </div>

          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
            <div className="text-xs text-[var(--color-mute)]">Calculé sur</div>
            <div className="text-xl font-semibold text-[var(--color-ink)] mt-1">
              {total.equipements_comptes} équipement
              {total.equipements_comptes > 1 ? "s" : ""}
            </div>
            <div className="text-xs text-[var(--color-mute)] mt-0.5">
              {total.partiel
                ? "hors équipements de transit — total partiel"
                : "hors équipements de transit"}
            </div>
          </div>
        </div>
      )}

      {/* ── LE DÉBIT DU PARC DANS LE TEMPS ──

          Trois chiffres ne disent pas QUAND ça sature. Une moyenne sur
          24 h noie la demi-heure de sauvegarde qui met le lien à genoux
          tous les soirs — et c'est exactement celle-là qu'un exploitant
          cherche. La courbe la montre ; la moyenne la cache.

          Elle se rafraîchit avec le reste de l'écran : à chaque fin de
          cycle de supervision, et au pire toutes les minutes. */}
      {courbeGlobale.length > 0 && (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h2 className="text-sm font-medium text-[var(--color-ink)]">
              Débit du parc dans le temps
            </h2>
            <span className="text-xs text-[var(--color-mute)]">
              somme de toutes les machines mesurées, hors équipements de transit
              {historique?.pas_minutes > 1 && ` — un point toutes les ${historique.pas_minutes} min`}
            </span>
          </div>

          {/* Un seul point ne fait pas une courbe : le tracé serait vide
              et l'utilisateur conclurait à une panne. On dit plutôt ce
              qu'il manque et pourquoi. */}
          {courbeGlobale.length < 2 ? (
            <p className="text-xs text-[var(--color-mute)]">
              Un seul point de mesure pour l'instant. Le débit se calcule par
              différence entre deux relevés : il faut deux cycles de supervision
              avant que la courbe démarre.
            </p>
          ) : (
            <div ref={conteneurGlobal} className="w-full" style={{ minHeight: 200 }}>
              {largeurGlobale > 0 && (
                <AreaChart
                  data={courbeGlobale}
                  width={largeurGlobale}
                  height={200}
                  margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="grad-global-entrant" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="grad-global-sortant" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-ok)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-ok)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="t"
                    tick={{ fontSize: 11, fill: "var(--color-mute)" }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--color-mute)" }}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                    tickFormatter={formaterDebit}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-line)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "var(--color-ink)",
                    }}
                    formatter={(v, n) => [formaterDebit(v), n === "entrant" ? "Entrant" : "Sortant"]}
                  />
                  {/* Mêmes choix que la courbe d'un équipement :
                      `connectNulls={false}` pour qu'un trou de mesure se
                      voie comme un trou, et animation coupée — React
                      StrictMode interrompt l'animation d'apparition et
                      laisse le tracé figé dans son état initial, donc
                      invisible. */}
                  <Area
                    type="monotone"
                    dataKey="entrant"
                    stroke="var(--color-signal)"
                    strokeWidth={2}
                    fill="url(#grad-global-entrant)"
                    connectNulls={false}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="sortant"
                    stroke="var(--color-ok)"
                    strokeWidth={2}
                    fill="url(#grad-global-sortant)"
                    connectNulls={false}
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              )}
            </div>
          )}
        </div>
      )}

      {couverture && couverture.avec_mesure < couverture.equipements && (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-mute)]">
          <span className="text-[var(--color-ink)] font-medium">
            {couverture.avec_mesure} équipement{couverture.avec_mesure > 1 ? "s" : ""} mesuré
            {couverture.avec_mesure > 1 ? "s" : ""} sur {couverture.equipements}.
          </span>{" "}
          Le débit se lit en SNMP : les équipements qui ne l'exposent pas
          (postes Windows par défaut, matériel grand public) ne peuvent pas
          être classés. Ils restent supervisés par ailleurs.
        </div>
      )}

      {erreur && (
        <div className="rounded-lg border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-4 py-3 text-sm text-[var(--color-crit)]">
          {erreur}
        </div>
      )}

      {chargement ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-mute)]">
          Chargement…
        </div>
      ) : classement.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center">
          <p className="text-sm text-[var(--color-ink)]">Aucune mesure sur cette période.</p>
          <p className="text-sm text-[var(--color-mute)] mt-1 max-w-lg mx-auto">
            Le débit se calcule par différence entre deux relevés SNMP : il
            faut donc deux cycles de supervision avant le premier chiffre.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--color-mute)] border-b border-[var(--color-line)]">
                  <th className="px-4 py-3 font-medium w-10">#</th>
                  <th className="px-4 py-3 font-medium">Équipement</th>
                  <th className="px-4 py-3 font-medium">Moyenne</th>
                  <th className="px-4 py-3 font-medium hidden md:table-cell">Pic</th>
                  <th className="px-4 py-3 font-medium hidden lg:table-cell w-48">Répartition</th>
                </tr>
              </thead>
              <tbody>
                {classement.map((r, index) => {
                  const moyenne = cumul(r.moy_entrant, r.moy_sortant);
                  const pic = cumul(r.pic_entrant, r.pic_sortant);
                  const actif = selection === r.id_equipement;
                  return (
                    <tr
                      key={r.id_equipement}
                      onClick={() => setSelection(actif ? null : r.id_equipement)}
                      className={`border-b border-[var(--color-line)] last:border-0 cursor-pointer transition ${
                        actif ? "bg-[var(--color-signal)]/10" : "hover:bg-[var(--color-surface-2)]"
                      }`}
                    >
                      <td className="px-4 py-3 text-[var(--color-mute)] tabular-nums">{index + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--color-ink)]">
                          {r.nom || r.adresse_ip}
                        </div>
                        <div className="text-xs text-[var(--color-mute)] flex flex-wrap items-center gap-x-2">
                          <span>{r.adresse_ip}</span>
                          {r.type_equipement && <span>· {r.type_equipement}</span>}
                          {r.site_nom && <span>· {r.site_nom}</span>}
                          {/*
                            Sur un switch, la somme des ports n'est pas le
                            débit de transit : une trame entrée par le port 3
                            et sortie par le port 7 est comptée deux fois.
                            Le chiffre reste utile — c'est l'activité cumulée
                            des ports — mais le dire évite de le surinterpréter.
                          */}
                          {r.total_cumule_ports && (
                            <span
                              className="text-[var(--color-warn)]"
                              title="Somme de l'activité de tous les ports, et non débit de transit : le trafic traversant l'équipement est compté deux fois (entrée + sortie)."
                            >
                              · cumul des ports
                            </span>
                          )}
                          {/* D'où vient le chiffre. Deux machines mesurées
                              différemment donneraient sinon l'impression
                              d'une incohérence — alors que les deux valeurs
                              sont justes, simplement obtenues ailleurs. */}
                          {r.source === "port" && (
                            <span
                              className="text-[var(--color-signal)]"
                              title={`Mesuré sur le port ${r.port_nom || ""} du switch ${
                                r.switch_nom || ""
                              }. Cette machine n'expose pas SNMP : c'est le switch qui compte pour elle. Valeur instantanée, non moyennée sur la période.`}
                            >
                              · via {r.switch_nom || "le switch"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-[var(--color-ink)] whitespace-nowrap">
                        {formaterDebit(moyenne)}
                        <div className="text-xs text-[var(--color-mute)]">
                          ↓ {formaterDebit(r.moy_entrant)} · ↑ {formaterDebit(r.moy_sortant)}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-[var(--color-mute)] hidden md:table-cell whitespace-nowrap">
                        {formaterDebit(pic)}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <BarreProportion valeur={moyenne} maximum={maximum} />
                        <div className="text-[11px] text-[var(--color-mute)] mt-1">
                          {r.releves} relevé{r.releves > 1 ? "s" : ""}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selection && (
        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 md:p-5 space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-[var(--color-ink)]">
                {selectionne?.nom || selectionne?.adresse_ip || "Équipement"}
              </h2>
              <p className="text-sm text-[var(--color-mute)]">
                Historique sur {PERIODES.find((p) => p.heures === heures)?.label}
              </p>
            </div>
            <button
              onClick={() => setSelection(null)}
              className="text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] transition cible-tactile"
            >
              Fermer
            </button>
          </div>

          {detailEnCours ? (
            <p className="text-sm text-[var(--color-mute)] py-8 text-center">Chargement…</p>
          ) : courbe.length < 2 ? (
            <p className="text-sm text-[var(--color-mute)] py-8 text-center">
              Pas assez de points pour tracer une courbe sur cette période.
            </p>
          ) : (
            <div ref={conteneurGraphique} className="w-full" style={{ minHeight: 224 }}>
              {largeurGraphique > 0 && (
                <AreaChart data={courbe} width={largeurGraphique} height={224} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="grad-entrant" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="grad-sortant" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-ok)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--color-ok)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="t" tick={{ fontSize: 11, fill: "var(--color-mute)" }} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--color-mute)" }} tickLine={false} axisLine={false} width={70} tickFormatter={formaterDebit} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-surface-2)",
                      border: "1px solid var(--color-line)",
                      borderRadius: 8,
                      fontSize: 12,
                      color: "var(--color-ink)",
                    }}
                    formatter={(v, n) => [formaterDebit(v), n === "entrant" ? "Entrant" : "Sortant"]}
                  />
                  {/* connectNulls={false} : un trou dans la mesure (agent
                      redémarré, équipement injoignable) doit se voir comme
                      un trou. Relier les points masquerait la panne. */}
                  {/* ANIMATION DÉSACTIVÉE — deux raisons.

                      1. LE DÉFAUT. React StrictMode monte, démonte puis
                         remonte chaque composant en développement, pour
                         débusquer les effets mal nettoyés. L'animation
                         d'apparition de la courbe est interrompue par ce
                         cycle et reste figée dans son état INITIAL :
                         un tracé entièrement masqué. Le graphique
                         paraissait vide alors que la courbe existait
                         bien dans le document, à la bonne couleur.

                      2. LE PRODUIT. Même sans ce défaut, animer
                         l'apparition d'une mesure n'a pas de sens ici.
                         Un opérateur qui ouvre une fiche veut lire une
                         valeur, pas attendre qu'elle se dessine. */}
                  <Area type="monotone" dataKey="entrant" stroke="var(--color-signal)" strokeWidth={2} fill="url(#grad-entrant)" connectNulls={false} dot={false} isAnimationActive={false} />
                  <Area type="monotone" dataKey="sortant" stroke="var(--color-ok)" strokeWidth={2} fill="url(#grad-sortant)" connectNulls={false} dot={false} isAnimationActive={false} />
                </AreaChart>
              )}
            </div>
          )}

          {detail?.interfaces?.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-[var(--color-ink)] mb-2">
                Détail par port
              </h3>
              <p className="text-xs text-[var(--color-mute)] mb-3">
                Dernière mesure connue de chaque interface. C'est ici qu'on
                identifie le port responsable.
                {detail.interfaces.some((i) => i.ignoree_du_total) && (
                  <>
                    {" "}
                    Les lignes grisées sont mesurées mais exclues du total de
                    l'équipement — la somme de cette colonne ne correspond
                    donc pas au chiffre du classement.
                  </>
                )}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[var(--color-mute)] border-b border-[var(--color-line)]">
                      <th className="px-3 py-2 font-medium">Interface</th>
                      <th className="px-3 py-2 font-medium">Entrant</th>
                      <th className="px-3 py-2 font-medium">Sortant</th>
                      <th className="px-3 py-2 font-medium">Lien</th>
                      <th className="px-3 py-2 font-medium hidden sm:table-cell">Mesuré</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.interfaces]
                      .sort((a, b) => (b.trafic_entrant_kbps ?? -1) - (a.trafic_entrant_kbps ?? -1))
                      .map((i) => {
                        // Le taux d'utilisation est le seul indicateur
                        // interprétable sans connaître le réseau : sur un
                        // lien full-duplex les deux sens ne se cumulent
                        // pas, d'où le maximum et non la somme.
                        const max = Math.max(i.trafic_entrant_kbps ?? 0, i.trafic_sortant_kbps ?? 0);
                        const taux = i.vitesse_mbps > 0 ? Math.min(100, (max / (i.vitesse_mbps * 1000)) * 100) : null;
                        return (
                          <tr
                            key={i.index_snmp}
                            className={`border-b border-[var(--color-line)] last:border-0 ${
                              // Atténuée, pas masquée : la boucle locale est
                              // une vraie mesure, et la cacher ferait croire
                              // à une interface oubliée par l'inventaire.
                              i.ignoree_du_total ? "opacity-50" : ""
                            }`}
                          >
                            <td className="px-3 py-2">
                              <span className="text-[var(--color-ink)]">{i.nom}</span>
                              {i.ignoree_du_total && (
                                <span
                                  className="ml-2 text-xs text-[var(--color-mute)]"
                                  title="Boucle locale : elle voit passer le trafic interne de la machine. La compter doublerait la consommation apparente."
                                >
                                  (hors total)
                                </span>
                              )}
                              {i.etat_operationnel === "down" && (
                                <span className="ml-2 text-xs text-[var(--color-mute)]">(hors service)</span>
                              )}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-[var(--color-mute)] whitespace-nowrap">
                              {formaterDebit(i.trafic_entrant_kbps)}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-[var(--color-mute)] whitespace-nowrap">
                              {formaterDebit(i.trafic_sortant_kbps)}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {i.vitesse_mbps ? (
                                <span className={taux >= 80 ? "text-[var(--color-crit)]" : taux >= 50 ? "text-[var(--color-warn)]" : "text-[var(--color-mute)]"}>
                                  {taux === null ? "—" : `${taux.toFixed(1)} %`}
                                  <span className="text-[var(--color-mute)]"> de {i.vitesse_mbps} Mbit/s</span>
                                </span>
                              ) : (
                                <span className="text-[var(--color-mute)]" title="L'équipement n'expose pas la vitesse du lien (ifSpeed).">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-[var(--color-mute)] hidden sm:table-cell whitespace-nowrap">
                              {i.date_trafic ? new Date(i.date_trafic).toLocaleString("fr-FR") : "—"}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
