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

/**
 * Un temps de réponse, à l'échelle qui se lit.
 *
 * Trois décimales sur un réseau local seraient du bruit : la mesure vient
 * d'un ping, dont la précision est de l'ordre de la milliseconde. En
 * dessous de 10 ms on garde deux décimales — c'est là que se lit la
 * différence entre un poste filaire et un poste en Wi-Fi.
 */
function formaterLatence(ms) {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return `${Math.round(n)} ms`;
  if (n >= 10) return `${n.toFixed(1)} ms`;
  return `${n.toFixed(2)} ms`;
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

/* ═══════════════════════════════════════════════════════════════════════
   LA COUVERTURE DE LA MESURE

   CE QUE CE BLOC REMPLACE. Une phrase : « 12 équipements mesurés sur
   182 ». Elle était exacte et laissait la question entière — pourquoi
   pas les 170 autres, et lesquels ?

   LES OMETTRE EN SILENCE ET LEUR AFFICHER UN ZÉRO SONT DEUX FAUTES
   SYMÉTRIQUES. Un zéro se lit « cette machine ne consomme rien » ; la
   vérité est « rien n'a pu être mesuré ». Ces appareils sont donc
   NOMMÉS, avec la raison, et sans aucune valeur en face.

   C'est aussi ce qui protège le produit : un client qui connaît son
   réseau voit d'abord ce qui manque. Qu'il trouve la réponse à l'écran
   plutôt qu'un vide fait la différence entre « l'outil ne sait pas les
   voir » et « mon parc ne les expose pas ».
   ═══════════════════════════════════════════════════════════════════════ */

const RAISONS = {
  port_partage: {
    court: "port partagé",
    long:
      "plusieurs machines vues sur le même port du commutateur — un switch " +
      "non administrable, un répéteur ou une borne WiFi s'interpose. Le " +
      "compteur du port existe mais mélange plusieurs machines.",
  },
  aucune_source: {
    court: "aucune source",
    long:
      "ni compteur SNMP sur l'appareil, ni port de commutateur administrable " +
      "connu. WiFi, ou branché derrière du matériel qui ne déclare rien.",
  },
};

function LigneCategorie({ couleur, libelle, valeur, total, precision }) {
  if (!valeur) return null;
  const part = total > 0 ? Math.round((valeur / total) * 100) : 0;
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: couleur }} />
      <span className="text-[var(--color-ink)] tabular-nums font-medium">{valeur}</span>
      <span className="text-[var(--color-mute)]">{libelle}</span>
      <span className="text-[var(--color-mute)] text-xs">({part} %)</span>
      {precision && (
        <span className="text-[var(--color-mute)] text-xs hidden md:inline">
          — {precision}
        </span>
      )}
    </div>
  );
}

function Couverture({ couverture }) {
  const [voirListe, setVoirListe] = useState(false);
  const c = couverture.categories;
  const total = couverture.equipements || 0;
  const liste = couverture.non_mesurables || [];

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
      <p className="text-sm text-[var(--color-mute)]">
        <span className="text-[var(--color-ink)] font-medium">
          {couverture.avec_mesure} équipement{couverture.avec_mesure > 1 ? "s" : ""} mesuré
          {couverture.avec_mesure > 1 ? "s" : ""} sur {total}.
        </span>{" "}
        Le total et la courbe ci-dessus ne portent que sur ceux-là.
      </p>

      {c && (
        <div className="mt-3 space-y-1.5">
          <LigneCategorie
            couleur="var(--color-ok)"
            valeur={c.direct}
            total={total}
            libelle="mesurés en direct"
            precision="compteur SNMP de l'appareil lui-même"
          />
          <LigneCategorie
            couleur="var(--color-signal)"
            valeur={c.par_port}
            total={total}
            libelle="mesurés par le port de leur commutateur"
            precision="seuls sur leur port, le compteur leur appartient"
          />
          <LigneCategorie
            couleur="var(--color-warn)"
            valeur={c.port_partage}
            total={total}
            libelle="sur un port partagé"
            precision={RAISONS.port_partage.court}
          />
          <LigneCategorie
            couleur="var(--color-mute)"
            valeur={c.aucune_source}
            total={total}
            libelle="sans aucune source de mesure"
            precision="ni SNMP, ni port de commutateur connu"
          />
        </div>
      )}

      {liste.length > 0 && (
        <>
          <button
            onClick={() => setVoirListe((v) => !v)}
            className="mt-3 text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] transition cible-tactile"
          >
            {voirListe
              ? "Masquer le détail"
              : `Voir les ${liste.length} appareil${liste.length > 1 ? "s" : ""} non mesurable${
                  liste.length > 1 ? "s" : ""
                }`}
          </button>

          {voirListe && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              {/* La phrase qui empêche la mauvaise lecture. Elle est
                  écrite ici, au-dessus de la liste, et pas en note de bas
                  de page : c'est au moment de lire les noms qu'on risque
                  de croire à un défaut de l'outil. */}
              <p className="text-xs text-[var(--color-mute)] mb-2 leading-relaxed">
                Ces appareils sont supervisés — état, alertes, disponibilité —
                mais leur débit n'est mesurable par aucune source connue. Aucune
                valeur ne leur est attribuée : un zéro se lirait « aucun trafic »,
                ce qui serait faux.
              </p>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {liste.map((eq) => (
                      <tr
                        key={eq.id_equipement}
                        className="border-b border-[var(--color-line)] last:border-0"
                      >
                        <td className="py-1.5 pr-3 text-[var(--color-ink)] truncate max-w-[14rem]">
                          {eq.nom || "—"}
                        </td>
                        <td className="py-1.5 pr-3 font-[var(--font-mono)] text-[var(--color-mute)] whitespace-nowrap">
                          {eq.adresse_ip}
                        </td>
                        <td className="py-1.5 pr-3 text-[var(--color-mute)] hidden sm:table-cell">
                          {eq.type_equipement || "non classé"}
                        </td>
                        <td
                          className="py-1.5 text-[var(--color-mute)] text-right"
                          title={RAISONS[eq.raison]?.long}
                        >
                          {RAISONS[eq.raison]?.court || eq.raison}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
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

  /* Le palmarès complet est replié par défaut — voir la note plus bas,
     à l'endroit où il est coupé. */
  const [toutLeClassement, setToutLeClassement] = useState(false);

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

  /* ── QUALITÉ DU RÉSEAU ──
     La latence est la seule mesure que ce parc produise pour presque
     toutes ses machines : elle ne demande ni SNMP, ni commutateur
     administrable, ni NetFlow. Elle vit sur cette page parce qu'elle
     répond à la question voisine — non pas « combien ça consomme »,
     mais « est-ce que ça répond bien ». */
  const [conteneurQualite, largeurQualite] = useLargeurObservee();
  const [qualite, setQualite] = useState(null);

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
        /* Troisième appel, facultatif au même titre que l'historique : sur
           une version du serveur qui n'a pas encore cette route, on reçoit
           un 404, la section de qualité ne s'affiche pas, et le reste de
           la page fonctionne exactement comme avant. */
        axios.get(`${API_URL}/reseau/qualite`, { params: { heures } }).catch(() => null),
      ])
        .then(([reponseClassement, reponseHistorique, reponseQualite]) => {
          const data = reponseClassement.data;
          setHistorique(reponseHistorique?.data ?? null);
          setQualite(reponseQualite?.data ?? null);
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

  /* ── LE PARC D'ABORD, LE PALMARÈS ENSUITE ──

     La page déroulait les vingt premiers consommateurs. Sur un parc où
     seules les imprimantes exposent SNMP, ça donnait une liste de vingt
     imprimantes : l'écran répondait à « laquelle de mes imprimantes
     consomme le plus », une question que personne ne pose, et il
     repoussait tout en bas le chiffre qui compte — combien consomme le
     parc, et quand.

     Cinq lignes suffisent à répondre à « qui consomme le plus ». Le
     reste se déplie pour qui veut la liste complète. Le total et la
     courbe, eux, portent sur TOUTES les machines mesurées et non sur
     ces cinq-là : couper l'affichage ne change aucun calcul. */
  const TETE_CLASSEMENT = 5;
  const classementVisible = toutLeClassement
    ? classement
    : classement.slice(0, TETE_CLASSEMENT);

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

  /* Deux séries : la moyenne du parc, et la plus mauvaise mesure de la
     tranche. La moyenne seule lisse tout — un poste à 400 ms noyé dans
     soixante-dix postes à 2 ms ne se voit pas. Le pic, lui, le montre :
     c'est l'écart entre les deux courbes qui se lit, pas leur niveau. */
  const courbeQualite = useMemo(() => {
    if (!qualite?.points) return [];
    return qualite.points.map((p) => ({
      t: dateCourte(p.instant, heures),
      moyenne: p.moyenne === null ? null : Number(p.moyenne),
      pic: p.pic === null ? null : Number(p.pic),
      equipements: Number(p.equipements || 0),
    }));
  }, [qualite, heures]);

  const selectionne = classement.find((r) => r.id_equipement === selection);
  const couverture = donnees?.couverture;
  const total = donnees?.total;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-ink)]">Bande passante</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            Ce que consomme le parc dans le temps, et les machines qui en
            consomment le plus.
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
                    dot={courbeGlobale.length <= 8}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="sortant"
                    stroke="var(--color-ok)"
                    strokeWidth={2}
                    fill="url(#grad-global-sortant)"
                    connectNulls={false}
                    dot={courbeGlobale.length <= 8}
                    isAnimationActive={false}
                  />
                </AreaChart>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          QUALITÉ DU RÉSEAU — LE GRAPHE QUI, LUI, EST PLEIN

          Le débit dépend du SNMP, et sur ce parc douze machines y
          répondent : la courbe du dessus est vraie, mais étroite, et le
          bloc de couverture le dit sans détour.

          Le temps de réponse, lui, est mesuré à chaque cycle pour chaque
          machine qui répond au ping — sans rien installer, sans
          commutateur administrable, sans communauté SNMP à demander. Il
          ne dit pas combien de données circulent ; il dit si le réseau
          répond bien, ce qui est la première question qu'on se pose en
          ouvrant une supervision.

          L'EFFECTIF EST AFFICHÉ À CÔTÉ DE LA MOYENNE, TOUJOURS. Les
          postes qui bloquent l'ICMP — Windows le fait par défaut —
          n'entrent pas dans ce calcul, même en étant parfaitement en
          ligne. Écrire « 12 ms » sans dire sur combien de machines
          laisserait croire à une mesure du parc entier.
          ══════════════════════════════════════════════════════════════ */}
      {qualite && (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
            <h2 className="text-sm font-medium text-[var(--color-ink)]">
              Qualité du réseau — temps de réponse
            </h2>
            <span className="text-xs text-[var(--color-mute)]">
              {qualite.couverture.avec_latence} des {qualite.couverture.equipements}{" "}
              machines répondent au ping et alimentent cette courbe
              {qualite.pas_minutes > 1 && ` — un point toutes les ${qualite.pas_minutes} min`}
            </span>
          </div>

          <p className="text-xs text-[var(--color-mute)] mb-3">
            Les autres ne sont pas absentes : elles bloquent l'ICMP, et leur
            présence est prouvée autrement (port TCP, table ARP).
          </p>

          {courbeQualite.length < 2 ? (
            <p className="text-xs text-[var(--color-mute)]">
              Pas encore assez de mesures sur cette période. La latence est
              enregistrée à chaque cycle de supervision : la courbe démarre
              après quelques minutes de fonctionnement du serveur.
            </p>
          ) : (
            <>
              {/* Trois chiffres, et pas un de plus. La moyenne pondérée par
                  le nombre de mesures — une tranche de nuit à deux relevés
                  ne pèse pas autant qu'une tranche de journée à trois
                  cents —, la pire mesure de la période avec son heure, et
                  le nombre de machines qui répondaient au même moment. */}
              <div className="flex flex-wrap gap-6 mb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
                    Moyenne
                  </p>
                  <p className="text-lg font-semibold text-[var(--color-ink)] tabular-nums">
                    {formaterLatence(qualite.resume.moyenne)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
                    Pire mesure
                  </p>
                  <p className="text-lg font-semibold text-[var(--color-warn)] tabular-nums">
                    {formaterLatence(qualite.resume.pic)}
                    {qualite.resume.instant_pic && (
                      <span className="text-xs font-normal text-[var(--color-mute)] ml-1.5">
                        à {dateCourte(qualite.resume.instant_pic, heures)}
                      </span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
                    Machines mesurées en même temps
                  </p>
                  <p className="text-lg font-semibold text-[var(--color-ink)] tabular-nums">
                    {qualite.couverture.simultanees_max}
                  </p>
                </div>
              </div>

              <div ref={conteneurQualite} className="w-full" style={{ minHeight: 200 }}>
                {largeurQualite > 0 && (
                  <AreaChart
                    data={courbeQualite}
                    width={largeurQualite}
                    height={200}
                    margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                  >
                    <defs>
                      <linearGradient id="grad-qualite-moyenne" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="grad-qualite-pic" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-warn)" stopOpacity={0.18} />
                        <stop offset="100%" stopColor="var(--color-warn)" stopOpacity={0} />
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
                      tickFormatter={formaterLatence}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-surface-2)",
                        border: "1px solid var(--color-line)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "var(--color-ink)",
                      }}
                      formatter={(v, n, entree) => {
                        if (n === "moyenne") {
                          const nb = entree?.payload?.equipements;
                          return [
                            `${formaterLatence(v)}${nb ? ` sur ${nb} machine(s)` : ""}`,
                            "Moyenne",
                          ];
                        }
                        return [formaterLatence(v), "Pire mesure"];
                      }}
                    />
                    {/* Le pic est tracé EN PREMIER, donc dessous : la
                        moyenne, qui est la lecture principale, ne doit pas
                        disparaître sous l'aplat de l'autre série. */}
                    <Area
                      type="monotone"
                      dataKey="pic"
                      stroke="var(--color-warn)"
                      strokeWidth={1}
                      strokeDasharray="4 3"
                      fill="url(#grad-qualite-pic)"
                      connectNulls={false}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="moyenne"
                      stroke="var(--color-signal)"
                      strokeWidth={2}
                      fill="url(#grad-qualite-moyenne)"
                      connectNulls={false}
                      dot={courbeQualite.length <= 8}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                )}
              </div>

              {/* LES PLUS LENTES, ET CE QUE ÇA VEUT DIRE.
                  Une latence élevée n'est pas une panne : un portable en
                  Wi-Fi au fond du bâtiment répond en 80 ms sans que rien
                  ne soit cassé. Ce qui se lit ici, c'est un ÉCART — une
                  machine dix fois plus lente que ses voisines filaires,
                  ou une machine habituellement rapide qui ne l'est plus. */}
              {qualite.pires.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[var(--color-line)]">
                  <p className="text-xs font-medium text-[var(--color-ink)] mb-2">
                    Les plus lentes à répondre
                  </p>
                  <div className="space-y-1">
                    {qualite.pires.slice(0, 5).map((m) => (
                      <div
                        key={m.id_equipement}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span className="truncate text-[var(--color-mute)]">
                          {(m.nom_personnalise || "").trim() ||
                            (m.nom || "").trim() ||
                            m.adresse_ip}
                          <span className="font-[var(--font-mono)] opacity-60 ml-1.5">
                            {m.adresse_ip}
                          </span>
                        </span>
                        <span className="tabular-nums whitespace-nowrap text-[var(--color-ink)]">
                          {formaterLatence(m.moyenne)}
                          <span className="text-[var(--color-mute)] ml-1.5">
                            pic {formaterLatence(m.pic)} · {m.mesures} mesures
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-[var(--color-mute)] mt-2">
                    Une latence élevée n'est pas une panne : un poste en Wi-Fi
                    répond plus lentement qu'un poste filaire, normalement. Ce
                    qui se regarde, c'est l'écart avec les autres — et son
                    évolution.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {couverture && couverture.avec_mesure < couverture.equipements && (
        <Couverture couverture={couverture} />
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
          {/* Un titre, parce que ce tableau n'est plus le sujet de la page
              mais sa réponse secondaire : le parc d'abord, le palmarès
              ensuite. */}
          <div className="px-4 pt-4 pb-1">
            <h2 className="text-sm font-medium text-[var(--color-ink)]">
              Qui consomme le plus
            </h2>
            <p className="text-xs text-[var(--color-mute)] mt-0.5">
              Parmi les machines qui exposent un compteur — classées sur la
              moyenne de la période.
            </p>
          </div>
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
                {classementVisible.map((r, index) => {
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

          {classement.length > TETE_CLASSEMENT && (
            <button
              onClick={() => setToutLeClassement((v) => !v)}
              className="w-full px-4 py-3 text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] border-t border-[var(--color-line)] transition cible-tactile"
            >
              {toutLeClassement
                ? "Réduire"
                : `Voir les ${classement.length - TETE_CLASSEMENT} autres équipements mesurés`}
            </button>
          )}
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
                  <Area type="monotone" dataKey="entrant" stroke="var(--color-signal)" strokeWidth={2} fill="url(#grad-entrant)" connectNulls={false} dot={courbe.length <= 8} isAnimationActive={false} />
                  <Area type="monotone" dataKey="sortant" stroke="var(--color-ok)" strokeWidth={2} fill="url(#grad-sortant)" connectNulls={false} dot={courbe.length <= 8} isAnimationActive={false} />
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
