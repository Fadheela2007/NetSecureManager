import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { ecouter } from "../utils/tempsReel";
import axios from "axios";
import PreuvesParc from "./PreuvesParc";
import Jauge from "./Jauge";
import VueSite from "./VueSite";
import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * CE QUE CE TABLEAU DE BORD A CESSÉ DE FAIRE
 *
 * Il affichait la liste complète des équipements et la liste complète
 * des alertes — c'est-à-dire une copie moins bonne des pages Équipements
 * et Alertes, qui font la même chose avec des filtres et du tri.
 *
 * Il rendait aussi TOUTES les lignes du parc : acceptable à 44
 * équipements, injouable à 500.
 *
 * Et surtout, il alignait des compteurs sans verdict. « 44 équipements,
 * 40 en ligne » ne dit pas si la situation est normale. L'opérateur
 * devait interpréter lui-même, chaque matin, des chiffres bruts.
 *
 * CE QU'IL FAIT MAINTENANT : répondre en trois secondes à « dois-je
 * m'inquiéter, et de quoi ». Le détail vit dans les pages dédiées, où
 * il est mieux traité.
 */

/**
 * Retire du message d'alerte le préambule qui nomme l'équipement.
 *
 * Le message est rédigé pour être lu SEUL — dans un e-mail de
 * notification, il doit dire de quelle machine il parle. Sur le tableau
 * de bord, l'identité figure déjà sur la ligne au-dessus, et la répéter
 * pousse le diagnostic — la seule information utile — hors de l'écran.
 *
 * On ne touche qu'à un préambule reconnu et suivi d'une vraie phrase :
 * en cas de doute, le message reste intact. Mieux vaut une redondance
 * qu'un message tronqué de travers.
 */
function alleger(message, nom, ip) {
  if (!message) return message;
  let texte = String(message);

  for (const identite of [nom, ip].filter(Boolean)) {
    const echappe = identite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixe = new RegExp(`^L['’]équipement\\s+${echappe}\\s+`, "i");
    if (prefixe.test(texte)) {
      const reste = texte.replace(prefixe, "").trim();
      if (reste.length > 10) {
        return reste.charAt(0).toUpperCase() + reste.slice(1);
      }
    }
  }
  return texte;
}

const NIVEAU_COULEUR = {
  critical: "var(--color-crit)",
  warning: "var(--color-warn)",
  info: "var(--color-mute)",
};

function Signal({ libelle, valeur, unite, ton = "neutre", note }) {
  const couleur = {
    neutre: "var(--color-ink)",
    ok: "var(--color-ok)",
    attention: "var(--color-warn)",
    critique: "var(--color-crit)",
  }[ton];

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
        {libelle}
      </p>
      <p
        className="font-[var(--font-display)] text-2xl font-semibold tabular-nums"
        style={{ color: couleur }}
      >
        {valeur}
        {unite && <span className="text-base font-normal ml-0.5">{unite}</span>}
      </p>
      {/* La note évite le chiffre orphelin : « 91 % » ne veut rien dire
          sans « 40 équipements sur 44 ». */}
      {note && <p className="text-xs text-[var(--color-mute)] mt-1">{note}</p>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   LARGEUR MESURÉE À LA MAIN.

   `ResponsiveContainer` de recharts mesure son parent au montage. Quand
   ce parent apparaît en même temps que lui, la mesure vaut zéro et n'est
   jamais révisée : un cadre vide, sans erreur ni trace en console. Le
   même piège a déjà coûté une heure sur deux autres écrans.

   Recopié depuis BandePassantePage plutôt que partagé : la première
   tentative de mise en commun avait cassé le composant, et un tableau de
   bord n'est pas l'endroit où prendre ce risque. À mutualiser plus tard,
   d'un seul geste, sur les trois écrans.
   ═══════════════════════════════════════════════════════════════════════ */
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

/** Cadre commun : titre, phrase de méthode, et le graphique dedans. */
function Cadre({ titre, methode, enfants, vide }) {
  const [conteneur, largeur] = useLargeurObservee();
  return (
    <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
      <h2 className="font-[var(--font-display)] text-sm font-semibold">{titre}</h2>
      {/* LA MÉTHODE EST ÉCRITE SOUS CHAQUE TITRE. Un graphique sans sa
          portée se lit de travers : « 12 machines » ne veut rien dire
          sans « sur 90 », et une courbe de latence ne porte que sur les
          machines qui répondent au ping. */}
      {methode && (
        <p className="text-[11px] text-[var(--color-mute)] mt-0.5 mb-3">{methode}</p>
      )}
      <div ref={conteneur} className="w-full" style={{ minHeight: 180 }}>
        {vide ? (
          <p className="text-xs text-[var(--color-mute)] py-8">{vide}</p>
        ) : (
          largeur > 0 && enfants(largeur)
        )}
      </div>
    </section>
  );
}

/* Styles communs : grille discrète, axes sans ligne, infobulle sur la
   surface haute. Les marques restent fines — 2 px — et l'animation est
   coupée : React en mode strict interrompt l'animation d'apparition et
   laisse le tracé figé dans son état initial, donc invisible. */
const GRILLE = { stroke: "var(--color-line)", strokeDasharray: "3 3", vertical: false };
const AXE = { tick: { fontSize: 11, fill: "var(--color-mute)" }, tickLine: false, axisLine: false };
const BULLE = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-line)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-ink)",
};
const LEGENDE = { fontSize: 11, color: "var(--color-mute)" };

const heureCourte = (d) =>
  new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const jourCourt = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });

export default function Dashboard({ idSite = 1, nomSite }) {
  const [equipements, setEquipements] = useState([]);
  const [alertes, setAlertes] = useState([]);
  // Totaux agrégés côté serveur. `alertes` ne contient plus que les cinq
  // affichées : compter dessus donnerait « 5 alertes » sur un parc qui en
  // a deux cents.
  const [resumeAlertes, setResumeAlertes] = useState(null);
  const [couverture, setCouverture] = useState(null);
  const [chargement, setChargement] = useState(true);
  /* Heure de la dernière lecture réussie. Elle remplace le clignotement :
     l'écran ne se vide plus pour dire qu'il travaille, il dit quand il a
     regardé pour la dernière fois. */
  const [derniereMaj, setDerniereMaj] = useState(null);

  /* Les trois séries du tableau de bord. `null` = pas encore lu, et ce
     n'est pas « aucune donnée » : les écrans doivent dire lequel des
     deux. */
  const [supervision, setSupervision] = useState(null);
  const [qualite, setQualite] = useState(null);
  const [alertesParJour, setAlertesParJour] = useState(null);
  const [exportEnCours, setExportEnCours] = useState(null);
  const [erreurExport, setErreurExport] = useState(null);

  /* ── LE RAPPORT PARTE QUAND ON LE DEMANDE, PAS TOUT SEUL ──

     L'envoi automatique existait déjà, réglable par la table de
     configuration. Il a un défaut d'usage : un courriel qui arrive de
     lui-même chaque semaine finit dans un dossier qu'on n'ouvre plus, et
     le jour où le rapport dit quelque chose d'important, personne ne le
     lit.

     Un bouton fait l'inverse : le rapport arrive parce qu'on l'a demandé,
     donc il est attendu, donc il est lu. La planification reste possible
     pour qui la veut — elle est simplement désactivée par défaut. */
  const [envoiCourriel, setEnvoiCourriel] = useState(false);
  const [vueSite, setVueSite] = useState(false);
  const [charge, setCharge] = useState(null);
  const [envoiPerso, setEnvoiPerso] = useState(false);
  const [messageCourriel, setMessageCourriel] = useState(null);

  /* Le rôle ne sert qu'à masquer un bouton ; la vraie protection est
     côté serveur — requireRole("admin") sur la route d'envoi. */
  const [role, setRole] = useState(null);
  useEffect(() => {
    try {
      const brut = localStorage.getItem("utilisateur");
      if (brut) setRole(JSON.parse(brut).role);
    } catch {
      setRole(null);
    }
  }, []);

  /**
   * Échec de chargement.
   *
   * LE DÉFAUT QUE CET ÉTAT CORRIGE — le plus grave de l'interface.
   *
   * Sans lui, une requête échouée laissait les listes vides et le
   * chargement terminé. Le tableau de bord affichait alors « Tout le
   * parc répond », EN VERT, alors qu'il ne voyait plus rien du tout.
   *
   * Backend arrêté, session expirée, réseau coupé : dans les trois cas,
   * l'outil dont le métier est de signaler les pannes annonçait que tout
   * allait bien. Un écran vide doit dire « je ne sais pas », jamais
   * « tout va bien ».
   */
  const [erreur, setErreur] = useState(null);

  /* ── POURQUOI UN RAFRAÎCHISSEMENT « SILENCIEUX » ──

     Le temps réel émet un événement PAR ÉQUIPEMENT dont l'état change.
     Pendant un scan qui découvre soixante-dix machines, cet écran
     repassait donc soixante-dix fois par `chargement = true` : les cartes
     disparaissaient et revenaient, le verdict s'effaçait, et quatre
     requêtes partaient à chaque fois vers un serveur déjà occupé à
     scanner.

     Un rafraîchissement n'est pas un premier chargement. Le premier
     affichage — et lui seul — a le droit de vider l'écran, parce qu'il
     n'y a rien à montrer. Ensuite, les chiffres se remplacent en place. */
  async function chargerDonnees({ silencieux = false } = {}) {
    if (!silencieux) setChargement(true);
    setErreur(null);
    try {
      // Le jeton est porté par axios.defaults (défini dans App.jsx).
      const [eqRes, alRes, resumeRes, bpRes] = await Promise.all([
        axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } }),
        // Seules les alertes NON acquittées comptent comme « à traiter » :
        // c'est ce qui vide le tableau de bord quand l'opérateur a fait
        // son tri, sans rien supprimer de l'historique.
        //
        // LIMITE À 5 : cet écran n'en affiche que cinq. On téléchargeait
        // le parc entier d'alertes pour en montrer cinq et compter le
        // reste — supportable à dix alertes, pas à mille lors d'une
        // coupure générale, et le temps réel relance à chaque événement.
        /* `id_site` sur TOUS les appels de cet écran, pas seulement sur
           celui des équipements. Sans lui, la carte annonçait « 44
           équipements » pour le site choisi pendant que les alertes et les
           courbes juste à côté comptaient tout le parc. */
        axios.get(`${API_URL}/alertes`, {
          params: { statut: "active", limite: 5, id_site: idSite || undefined },
        }),
        // Les totaux viennent du résumé, agrégé côté serveur. C'est
        // exactement ce pour quoi cette route existait — elle n'était
        // appelée par personne.
        axios
          .get(`${API_URL}/alertes/resume`, { params: { id_site: idSite || undefined } })
          .catch(() => ({ data: null })),
        // Couverture de la mesure : combien d'équipements sont réellement
        // mesurables. Sans ce chiffre, un écran vide passe pour une panne.
        axios
          .get(`${API_URL}/bande-passante/classement`, { params: { heures: 24, limite: 1 } })
          .catch(() => ({ data: null })),
      ]);

      setEquipements(eqRes.data);
      setAlertes(alRes.data);
      setResumeAlertes(resumeRes.data?.active ?? null);
      setCouverture(bpRes.data?.couverture ?? null);

      /* Les courbes sont chargées À PART, et leur échec ne fait pas
         échouer le tableau de bord : un graphe manquant se dit par son
         propre message, il ne doit pas effacer les chiffres au-dessus.
         Une base sans la route répond 404 ou 500 — l'écran le supporte. */
      axios
        .get(`${API_URL}/supervision/historique`, { params: { heures: 24, id_site: idSite } })
        .then(({ data }) => setSupervision(data))
        .catch(() => setSupervision({ points: [], total_parc: 0 }));
      axios
        .get(`${API_URL}/reseau/qualite`, { params: { heures: 24, id_site: idSite } })
        .then(({ data }) => setQualite(data))
        .catch(() => setQualite({ points: [] }));
      axios
        .get(`${API_URL}/alertes/par-jour`, { params: { jours: 7, id_site: idSite || undefined } })
        .then(({ data }) => setAlertesParJour(data))
        .catch(() => setAlertesParJour({ points: [] }));
      setDerniereMaj(new Date());
    } catch (err) {
      console.error("Chargement du tableau de bord impossible", err);
      setErreur(decrireErreur(err, "Les données du tableau de bord"));
    } finally {
      setChargement(false);
    }
  }

  useEffect(() => {
    chargerDonnees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  /* Rafraîchissement sans rechargement.
     L'événement ne porte aucune donnée : il dit qu'il y a du neuf, et on
     relit par les routes normales — celles qui appliquent déjà le
     cloisonnement et les rôles. Sans temps réel côté serveur, `ecouter`
     ne fait rien et l'écran se comporte comme avant. */
  /* ── LES ÉVÉNEMENTS SONT REGROUPÉS ──

     Un scan produit une rafale d'événements. Les suivre un par un ferait
     autant de lectures complètes du tableau de bord, pour un écran qui
     n'affiche que des totaux : le dernier chiffre est le seul qui compte.

     On note donc qu'il y a du neuf et on relit une fois, au plus toutes
     les REGROUPEMENT_MS. Une alerte reste visible en quelques secondes —
     le délai humain de lecture est bien plus long — et le serveur n'est
     plus interrogé quatre fois par machine découverte. */
  const minuterie = useRef(null);
  useEffect(() => {
    const REGROUPEMENT_MS = 3000;

    const signaler = () => {
      if (minuterie.current) return; // une relecture est déjà programmée
      minuterie.current = setTimeout(() => {
        minuterie.current = null;
        chargerDonnees({ silencieux: true });
      }, REGROUPEMENT_MS);
    };

    const arreterAlerte = ecouter("alerte", signaler);
    const arreterEquipement = ecouter("equipement", signaler);
    return () => {
      arreterAlerte();
      arreterEquipement();
      if (minuterie.current) {
        clearTimeout(minuterie.current);
        minuterie.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  /**
   * Envoie le rapport par courriel, maintenant.
   *
   * Le document est exactement celui du bouton « Export PDF » : une seule
   * mise en page, un seul endroit qui décide de ce qu'un rapport contient.
   * Les destinataires sont les comptes administrateur et opérateur du
   * périmètre, ceux qui ont une adresse renseignée.
   *
   * ON DIT COMBIEN DE COURRIELS SONT PARTIS, PAS « ENVOYÉ ». Sans serveur
   * de messagerie configuré, la route répond correctement et n'envoie
   * rien : afficher « envoyé » serait faux, et l'utilisateur attendrait un
   * message qui n'arrivera jamais.
   */
  async function envoyerParCourriel() {
    setEnvoiCourriel(true);
    setMessageCourriel(null);
    setErreurExport(null);
    try {
      const { data } = await axios.post(`${API_URL}/rapport/envoyer-maintenant`);
      const partis = Number(data?.total_envoyes || 0);

      if (partis > 0) {
        setMessageCourriel(`Rapport envoyé — ${partis} courriel(s) partis.`);
      } else {
        /* Zéro envoi a des causes très différentes, et la route les
           distingue : parc vide, aucune adresse renseignée, messagerie
           non configurée. On répète la raison du serveur plutôt que
           d'inventer la nôtre. */
        const raison = data?.perimetres?.find((p) => p.ignore)?.ignore;
        setMessageCourriel(
          raison
            ? `Aucun courriel envoyé : ${raison}.`
            : "Aucun courriel envoyé. Vérifiez qu'un serveur de messagerie est configuré (SMTP_HOST) et que votre compte a une adresse."
        );
      }
    } catch (err) {
      setErreurExport(
        err.response?.status === 403
          ? "L'envoi par courriel est réservé aux comptes administrateur."
          : err.response?.data?.error || "L'envoi du rapport a échoué."
      );
    } finally {
      setEnvoiCourriel(false);
    }
  }

  /**
   * Le même rapport, mais pour soi seul.
   *
   * ── LA DIFFÉRENCE AVEC LE BOUTON D'À CÔTÉ ──
   *
   * « Rapport par courriel » écrit à TOUS les destinataires du périmètre.
   * Celui-ci n'écrit qu'à la personne connectée, à l'adresse que porte
   * son compte — qu'elle ne saisit nulle part et ne peut pas changer ici.
   *
   * C'est ce qui permet de l'ouvrir aux opérateurs : recevoir par
   * courrier ce qu'on peut déjà télécharger d'un clic n'ajoute aucun
   * pouvoir. Écrire à tout le monde, si.
   */
  async function menvoyerLeRapport() {
    setEnvoiPerso(true);
    setMessageCourriel(null);
    setErreurExport(null);
    try {
      const { data } = await axios.post(`${API_URL}/rapport/m-envoyer`);

      /* ON RÉPÈTE LA RAISON DU SERVEUR, ON N'INVENTE PAS LA NÔTRE.
         Sans messagerie configurée, la route répond correctement et
         n'envoie rien : afficher « envoyé » serait faux, et on
         attendrait un message qui n'arrivera jamais. */
      if (data?.envoye) {
        setMessageCourriel(`Rapport envoyé à ${data.email} — vous seul l'avez reçu.`);
      } else {
        setMessageCourriel(`Aucun courriel envoyé : ${data?.raison || "raison inconnue"}.`);
      }
    } catch (err) {
      setErreurExport(
        err.response?.data?.aide ||
          err.response?.data?.error ||
          "L'envoi du rapport a échoué."
      );
    } finally {
      setEnvoiPerso(false);
    }
  }

  async function telechargerRapport(format) {
    setExportEnCours(format);
    setErreurExport(null);
    try {
      const response = await axios.get(`${API_URL}/rapport/${format}`, {
        params: { id_site: idSite },
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const lien = document.createElement("a");
      lien.href = url;
      lien.download = `rapport_netsecuremanager.${format === "pdf" ? "pdf" : "xlsx"}`;
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // L'ÉCHEC ÉTAIT MUET.
      //
      // L'erreur ne partait qu'en console : l'utilisateur cliquait, le
      // bouton tournait, s'arrêtait, et rien ne se passait. Aucun fichier,
      // aucun message. C'est le même défaut que les écrans vides sans
      // explication — une panne qui ressemble à un produit qui ne fait rien.
      //
      // La cause la plus fréquente est un parc sans données sur la période,
      // ou une génération PDF en échec côté serveur. On le dit.
      console.error("Téléchargement du rapport impossible", err);
      setErreurExport(
        err.response?.data?.error ||
          "Le rapport n'a pas pu être produit. Vérifiez qu'il existe des relevés sur la période, puis réessayez."
      );
    } finally {
      setExportEnCours(null);
    }
  }

  /* ── LA CHARGE DU PARC, POUR LES JAUGES ──

     Une lecture à part, et légère : une moyenne sur la dernière heure.
     L'ajouter au chargement principal aurait retardé TOUT l'écran pour
     deux nombres qui ne commandent rien. Son échec ne doit rien casser :
     les jauges affichent alors « — ». */
  useEffect(() => {
    let annule = false;
    axios
      .get(`${API_URL}/supervision/charge`, { params: { id_site: idSite || undefined } })
      .then(({ data }) => { if (!annule) setCharge(data); })
      .catch(() => { if (!annule) setCharge(null); });
    return () => { annule = true; };
  }, [idSite, derniereMaj]);

  const bilan = useMemo(() => {
    const up = equipements.filter((e) => e.statut === "up").length;
    const down = equipements.filter((e) => e.statut === "down").length;
    // Équipements dont l'état n'est plus observable : agent muet, site
    // jamais scanné. Les fondre dans « hors ligne » serait faux — on ne
    // sait pas, ce n'est pas pareil que « on sait que c'est tombé ».
    const inconnus = equipements.filter((e) => e.statut === "inconnu").length;
    const total = equipements.length;

    // Totaux : le résumé serveur s'il a répondu, sinon la liste — qui est
    // limitée à cinq et sous-estimerait. Le repli reste préférable à un
    // écran vide, et le cas ne se produit que si /alertes/resume échoue.
    const totalAlertes = resumeAlertes?.total ?? alertes.length;
    const critiques = resumeAlertes?.critical ?? alertes.filter((a) => a.niveau === "critical").length;
    const observables = up + down;

    return {
      up,
      down,
      inconnus,
      total,
      critiques,
      totalAlertes,
      // Disponibilité calculée sur les seuls équipements OBSERVABLES.
      // Compter les « inconnu » comme hors ligne ferait chuter le taux
      // pour une raison qui n'est pas une panne.
      disponibilite: observables > 0 ? Math.round((up / observables) * 100) : null,
      derniereDecouverte: equipements.reduce((max, e) => {
        const d = e.derniere_decouverte ? new Date(e.derniere_decouverte) : null;
        return d && (!max || d > max) ? d : max;
      }, null),
    };
  }, [equipements, alertes, resumeAlertes]);

  /**
   * Le verdict, en une phrase.
   *
   * C'est la seule chose que beaucoup d'utilisateurs liront. Il énonce
   * un fait et une conséquence, jamais un chiffre isolé — et il ne crie
   * que lorsqu'il y a lieu de crier : un bandeau rouge permanent cesse
   * d'être lu au bout de trois jours.
   */
  const verdict = useMemo(() => {
    if (chargement) return null;

    // L'échec passe AVANT tout le reste. C'est ce qui empêche le
    // verdict de conclure « tout va bien » à partir de listes vides
    // qu'aucune requête n'a jamais remplies.
    if (erreur) {
      return { ton: "critique", titre: erreur.titre, detail: erreur.detail };
    }

    if (bilan.total === 0) {
      return {
        ton: "neutre",
        titre: "Aucun équipement dans le parc",
        detail: "Lancez un premier scan pour découvrir le réseau.",
      };
    }
    if (bilan.critiques > 0) {
      return {
        ton: "critique",
        titre: `${bilan.critiques} alerte${bilan.critiques > 1 ? "s" : ""} critique${
          bilan.critiques > 1 ? "s" : ""
        } à traiter`,
        detail:
          bilan.down > 0
            ? `${bilan.down} équipement${bilan.down > 1 ? "s ne répondent" : " ne répond"} plus.`
            : "Consultez la page Alertes pour le détail.",
      };
    }
    if (bilan.down > 0) {
      return {
        ton: "attention",
        titre: `${bilan.down} équipement${bilan.down > 1 ? "s" : ""} hors ligne`,
        detail: "Aucune alerte critique ouverte — la situation est connue et suivie.",
      };
    }
    if (bilan.inconnus > 0) {
      return {
        ton: "attention",
        titre: `${bilan.inconnus} équipement${bilan.inconnus > 1 ? "s" : ""} sans état connu`,
        detail: "Leur site n'a pas transmis récemment. Vérifiez l'agent dans Sites.",
      };
    }
    return {
      ton: "ok",
      titre: "Tout le parc répond",
      detail: `${bilan.up} équipement${bilan.up > 1 ? "s" : ""} en ligne, aucune alerte à traiter.`,
    };
  }, [bilan, chargement, erreur]);

  const couleurVerdict = {
    ok: "var(--color-ok)",
    attention: "var(--color-warn)",
    critique: "var(--color-crit)",
    neutre: "var(--color-mute)",
  };

  // Les cinq alertes les plus graves, et rien de plus : le tableau de
  // bord oriente, la page Alertes traite.
  const prioritaires = useMemo(
    () =>
      [...alertes]
        .sort((a, b) => {
          const rang = { critical: 0, warning: 1, info: 2 };
          return (rang[a.niveau] ?? 3) - (rang[b.niveau] ?? 3);
        })
        .slice(0, 5),
    [alertes]
  );

  /* ── LES TROIS SÉRIES, MISES EN FORME POUR LE TRACÉ ──
     Le serveur rend des dates ; l'axe veut des étiquettes courtes. La
     conversion vit ici, une fois, plutôt que dans le corps du rendu qui
     la referait à chaque rafraîchissement. */
  const courbeSupervision = useMemo(
    () =>
      (supervision?.points || []).map((p) => ({
        t: heureCourte(p.instant),
        repondants: p.repondants,
      })),
    [supervision]
  );

  const courbeQualite = useMemo(
    () =>
      (qualite?.points || []).map((p) => ({
        t: heureCourte(p.instant),
        moyenne: p.moyenne === null ? null : Math.round(p.moyenne * 10) / 10,
        pire: p.pic === null ? null : Math.round(p.pic * 10) / 10,
      })),
    [qualite]
  );

  const barresAlertes = useMemo(
    () =>
      (alertesParJour?.points || []).map((p) => ({
        t: jourCourt(p.jour),
        critiques: p.critiques,
        autres: p.autres,
      })),
    [alertesParJour]
  );

  const aucuneAlerteSurLaPeriode =
    barresAlertes.length > 0 && barresAlertes.every((b) => b.critiques + b.autres === 0);

  /* ── LA VUE DU SITE PREND TOUT L'ÉCRAN ──

     Et pas une fenêtre par-dessus : ce qu'elle montre est une page
     entière, pas un détail. Une vue de cette taille dans une boîte
     flottante se lit mal et se ferme par accident. */
  if (vueSite && idSite) {
    return <VueSite idSite={idSite} onFermer={() => setVueSite(false)} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">Tableau de bord</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            {bilan.derniereDecouverte
              ? `Dernière découverte : ${bilan.derniereDecouverte.toLocaleString("fr-FR")}`
              : "Vue d'ensemble du réseau supervisé"}
          </p>
          {/* Ce que le clignotement disait autrefois, en une ligne qui ne
              bouge pas : l'écran est vivant, et voici quand il a regardé. */}
          {derniereMaj && !erreur && (
            <p className="text-xs text-[var(--color-mute)] mt-0.5">
              Mis à jour à {derniereMaj.toLocaleTimeString("fr-FR")} — cet écran se rafraîchit tout seul.
            </p>
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          {["pdf", "excel"].map((f) => (
            <button
              key={f}
              onClick={() => telechargerRapport(f)}
              disabled={exportEnCours === f}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
            >
              {exportEnCours === f ? "Génération…" : `Export ${f === "pdf" ? "PDF" : "Excel"}`}
            </button>
          ))}

          {/* ── À MOI SEUL ──
              Ouvert aux opérateurs : le rapport ne part qu'à l'adresse du
              compte connecté, lue en base. Aucun champ destinataire —
              l'inscription est ouverte, un destinataire saisissable ferait
              de la plateforme un relais pour écrire aux autres. */}
          <button
            onClick={menvoyerLeRapport}
            disabled={envoiPerso}
            title="Envoie le rapport PDF à votre seule adresse"
            className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
          >
            {envoiPerso ? "Envoi…" : "Me l'envoyer"}
          </button>

          {/* Le même rapport, mais dans la boîte de réception. Réservé à
              l'administrateur : c'est lui qui décide qu'un document part
              de la plateforme vers l'extérieur. */}
          {role === "admin" && (
            <button
              onClick={envoyerParCourriel}
              disabled={envoiCourriel}
              title="Envoie le rapport PDF par courriel aux comptes administrateur et opérateur qui ont une adresse renseignée"
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
            >
              {envoiCourriel ? "Envoi…" : "Rapport par courriel"}
            </button>
          )}
        </div>
      </div>

      {erreurExport && (
        <p className="text-sm" style={{ color: "var(--color-crit)" }}>
          {erreurExport}
        </p>
      )}

      {messageCourriel && (
        <p className="text-sm text-[var(--color-ok)]">{messageCourriel}</p>
      )}

      {/* ── LE VERDICT ── */}
      {verdict && (
        <div
          className="rounded-xl border bg-[var(--color-surface)] px-5 py-4 flex items-start gap-3"
          style={{ borderColor: `color-mix(in srgb, ${couleurVerdict[verdict.ton]} 40%, transparent)` }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
            style={{ background: couleurVerdict[verdict.ton] }}
          />
          <div>
            <p
              className="font-[var(--font-display)] text-base font-semibold"
              style={{ color: couleurVerdict[verdict.ton] }}
            >
              {verdict.titre}
            </p>
            <p className="text-sm text-[var(--color-mute)]">{verdict.detail}</p>
          </div>
        </div>
      )}

      {/* ── LES SIGNAUX ──
          Masqués quand le chargement a échoué. Le verdict a déjà dit ce
          qui ne va pas ; afficher en dessous « Hors ligne : 0 » et
          « Disponibilité : — » à partir de listes qu'aucune requête n'a
          remplies reviendrait à présenter l'absence de données comme une
          mesure. C'est ce que fait un compteur cassé, et c'est ce qu'on
          reproche à tout outil de supervision. */}
      {!erreur && (
      <>
      {/* ══ LES CHIFFRES, EN GRILLE ══

          Une grille régulière et non une rangée qui déborde : tous les
          indicateurs ont la même taille, donc le même poids, et l'œil
          les parcourt sans se demander lequel compte le plus. Ce qui
          hiérarchise, c'est la COULEUR d'un chiffre qui sort de
          l'ordinaire, pas la place qu'il occupe. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Signal
          libelle="Machines"
          valeur={bilan.total}
          note="dans l'inventaire"
        />
        <Signal
          libelle="Disponibilité"
          valeur={bilan.disponibilite === null ? "—" : bilan.disponibilite}
          unite={bilan.disponibilite === null ? "" : " %"}
          ton={
            bilan.disponibilite === null
              ? "neutre"
              : bilan.disponibilite >= 95
              ? "ok"
              : bilan.disponibilite >= 80
              ? "attention"
              : "critique"
          }
          note={
            bilan.disponibilite === null
              ? "aucun état observable"
              : `${bilan.up} sur ${bilan.up + bilan.down} joignables`
          }
        />
        <Signal
          libelle="En ligne"
          valeur={bilan.up}
          ton="ok"
          note="ont répondu au dernier cycle"
        />
        {/* La note dit la PROPORTION, pas l'absence d'un autre problème.
            « 15 » surmonté de « aucun équipement muet » se lisait comme
            une contradiction : le chiffre alarme, la note rassure. */}
        <Signal
          libelle="Hors ligne"
          valeur={bilan.down}
          ton={bilan.down > 0 ? "critique" : "ok"}
          note={bilan.down > 0 ? `sur ${bilan.total} du parc` : "tout le parc répond"}
        />
        {/* « SANS ÉTAT CONNU » A SA PROPRE CASE, et ce n'est pas un
            détail : le fondre dans « hors ligne » ferait annoncer des
            pannes qui n'existent pas. On ne sait pas, ce n'est pas
            pareil que « on sait que c'est tombé ». */}
        <Signal
          libelle="Sans état connu"
          valeur={bilan.inconnus}
          ton={bilan.inconnus > 0 ? "attention" : "ok"}
          note={bilan.inconnus > 0 ? "leur site n'a rien transmis" : "aucun angle mort"}
        />
        <Signal
          libelle="Alertes à traiter"
          valeur={bilan.totalAlertes}
          ton={bilan.critiques > 0 ? "critique" : bilan.totalAlertes > 0 ? "attention" : "ok"}
          note={bilan.critiques > 0 ? `dont ${bilan.critiques} critique(s)` : "acquittées exclues"}
        />
      </div>

      {/* ══ JAUGES ET PROBLÈMES ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-4">
          <h2 className="text-sm font-medium text-[var(--color-ink)]">Charge du parc</h2>
          {/* LE NOMBRE DE MACHINES MESURÉES EST DIT, et il le faut :
              moyenner sur tout le parc ferait baisser le chiffre à
              proportion des muettes. Trois serveurs qui saturent
              paraîtraient tranquilles derrière quatre-vingt-dix-huit
              machines qui ne disent rien. */}
          <p className="text-[11px] text-[var(--color-mute)] mt-0.5">
            {charge?.machines > 0
              ? `moyenne sur ${charge.machines} machine(s) qui ont répondu, dernière heure`
              : "aucune machine n'a remonté sa charge"}
          </p>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <Jauge valeur={charge?.cpu} libelle="Processeur" />
            <Jauge valeur={charge?.ram} libelle="Mémoire" />
            <Jauge
              valeur={couverture && couverture.equipements > 0
                ? Math.round((couverture.avec_mesure / couverture.equipements) * 100)
                : null}
              libelle="Parc mesuré"
              note="exposent un compteur"
            />
          </div>
        </section>

        {/* ══ PROBLÈMES EN COURS ══
            Un compteur d'alertes ne dit pas quoi faire. La liste, si. */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-4 lg:col-span-2">
          <h2 className="text-sm font-medium text-[var(--color-ink)]">Problèmes en cours</h2>
          <p className="text-[11px] text-[var(--color-mute)] mt-0.5">
            Les plus graves d'abord — acquittées exclues.
          </p>

          {alertes.length === 0 ? (
            <p className="text-sm text-[var(--color-mute)] py-8 text-center">
              Rien à traiter. Les alertes acquittées restent consultables sur la
              page Alertes.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)] mt-2">
              {/* Le serveur trie DÉJÀ par gravité puis par dernière
                  occurrence (FIELD(a.niveau,...)). Retrier ici ferait
                  deux règles pour une seule, et celle de l'écran
                  finirait par contredire celle de la page Alertes. */}
              {alertes
                .slice(0, 6)
                .map((a) => (
                  <li key={a.id_alerte} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-[var(--color-ink)]">
                        {/* Une alerte peut porter sur un SITE et non sur
                            une machine — agent muet. Elle n'a alors ni
                            nom ni adresse : son site la nomme. */}
                        {a.nom || a.adresse_ip || a.site_nom || "Équipement"}
                        {/* Le niveau est ÉCRIT, pas seulement teinté :
                            une pastille de couleur seule ne se lit ni
                            sans distinguer les couleurs, ni à
                            l'impression. */}
                        <span
                          className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border align-middle"
                          style={{
                            borderColor: NIVEAU_COULEUR[a.niveau] || "var(--color-line)",
                            color: NIVEAU_COULEUR[a.niveau] || "var(--color-mute)",
                          }}
                        >
                          {a.niveau === "critical"
                            ? "critique"
                            : a.niveau === "warning"
                            ? "avertissement"
                            : "info"}
                        </span>
                      </span>
                      <span className="text-[11px] text-[var(--color-mute)] whitespace-nowrap">
                        {a.date_creation
                          ? new Date(a.date_creation).toLocaleString("fr-FR")
                          : ""}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--color-mute)] mt-0.5">
                      {a.message || a.type_alerte}
                    </p>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
      </>
      )}

      {/* Bouton de reprise : sur une coupure passagère, recharger la
          page entière ferait perdre le site sélectionné et le contexte. */}
      {erreur && (
        <button
          onClick={() => chargerDonnees()}
          className="text-sm px-4 py-2 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
        >
          Réessayer
        </button>
      )}

      {/* ══ LE SITE EXPLORÉ, ET SA VUE COMPLÈTE ══

          Le nom du réseau dont tout cet écran parle. Il restait
          implicite — repris du sélecteur de l'en-tête, qu'on ne regarde
          plus au bout de dix minutes.

          Cliquer dessus ouvre une vue assemblée toute seule. Ailleurs,
          un tel écran se construit tuile par tuile ; ici il découle de
          ce que le scan a trouvé. */}
      {!erreur && idSite && nomSite && (
        <button
          onClick={() => setVueSite(true)}
          className="w-full text-left bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl px-5 py-4 hover:border-[var(--color-signal)] transition cible-tactile"
        >
          <span className="text-[11px] text-[var(--color-mute)] uppercase tracking-wide">
            Réseau exploré
          </span>
          <span className="block font-[var(--font-display)] text-lg font-semibold text-[var(--color-ink)] mt-0.5">
            {nomSite}
          </span>
          <span className="block text-xs mt-1" style={{ color: "var(--color-signal)" }}>
            Voir la vue complète de ce site →
          </span>
        </button>
      )}


      {/* ══ SUR QUOI NOUS NOUS FONDONS ══

          Collé au lanceur de scan, et pas ailleurs : un scan est ce qui
          FABRIQUE ces preuves. On lit ce qu'il a établi juste sous le
          bouton qui le déclenche — la boucle se ferme à l'œil, sans
          changer d'écran.

          Après et non avant : le bouton est une action, ce bloc en est
          le résultat. Les mettre dans l'autre ordre ferait lire le
          bilan d'un scan avant de savoir qu'on peut en lancer un.

          Il disparaît de lui-même quand il n'a rien à dire — parc vide,
          ou migration des preuves non passée. */}
      {!erreur && <PreuvesParc idSite={idSite} />}

      {/* ══════════════════════════════════════════════════════════════
          LES TROIS COURBES DU PARC

          Les cartes du haut disent l'ÉTAT, à l'instant où on regarde.
          Ces trois-là disent la TENDANCE : à quelle heure des machines
          sont tombées, si le réseau s'alourdit, si la semaine s'améliore.
          C'est la différence entre un inventaire et une supervision.

          CE QU'ON N'AFFICHE PAS ICI : le débit du parc. Il ne couvre que
          les sept machines qui exposent un compteur, et sa courbe a un
          défaut de comptage connu. Un graphe faux sur le tableau de bord
          vaut moins que pas de graphe du tout.
          ══════════════════════════════════════════════════════════════ */}
      {!erreur && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Cadre
            titre="Machines qui répondent — 24 h"
            methode={
              supervision?.total_parc
                ? `Un point toutes les ${supervision.pas_minutes || 7} min. Le trait montre la taille du parc : ${supervision.total_parc} équipements.`
                : "Compte les machines ayant réellement répondu au ping sur la période."
            }
            vide={
              supervision && courbeSupervision.length === 0
                ? "Aucun relevé sur les 24 dernières heures. La supervision n'a pas tourné, ou le serveur était arrêté."
                : null
            }
            enfants={(largeur) => (
              <AreaChart
                data={courbeSupervision}
                width={largeur}
                height={190}
                margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="grad-repondants" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-signal)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-signal)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...GRILLE} />
                <XAxis dataKey="t" {...AXE} minTickGap={28} />
                <YAxis {...AXE} width={38} allowDecimals={false} />
                <Tooltip contentStyle={BULLE} formatter={(v) => [`${v} machines`, "Ont répondu"]} />
                {/* Le repère du parc est DIRECTEMENT étiqueté : un trait
                    sans son chiffre obligerait à deviner ce qu'il marque. */}
                {supervision?.total_parc > 0 && (
                  <ReferenceLine
                    y={supervision.total_parc}
                    stroke="var(--color-mute)"
                    strokeDasharray="4 4"
                    label={{
                      value: `parc : ${supervision.total_parc}`,
                      position: "right",
                      fill: "var(--color-mute)",
                      fontSize: 11,
                    }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="repondants"
                  stroke="var(--color-signal)"
                  strokeWidth={2}
                  fill="url(#grad-repondants)"
                  connectNulls={false}
                  dot={courbeSupervision.length <= 8}
                  isAnimationActive={false}
                />
              </AreaChart>
            )}
          />

          <Cadre
            titre="Temps de réponse du parc — 24 h"
            methode={
              qualite?.couverture
                ? `${qualite.couverture.avec_latence} des ${qualite.couverture.equipements} machines répondent au ping et alimentent cette courbe.`
                : "Latence moyenne et pire mesure, sur les machines qui répondent au ping."
            }
            vide={
              qualite && courbeQualite.length === 0
                ? "Aucune mesure de latence sur la période."
                : null
            }
            enfants={(largeur) => (
              <LineChart
                data={courbeQualite}
                width={largeur}
                height={190}
                margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid {...GRILLE} />
                <XAxis dataKey="t" {...AXE} minTickGap={28} />
                {/* L'unité est collée à la graduation plutôt que passée
                    en `unit` : recharts la renvoyait à la ligne, et « 45 »
                    au-dessus de « ms » se lit deux fois plus lentement. */}
                <YAxis {...AXE} width={52} tickFormatter={(v) => `${v} ms`} />
                <Tooltip contentStyle={BULLE} formatter={(v, nom) => [`${v} ms`, nom]} />
                <Legend wrapperStyle={LEGENDE} iconType="plainline" />
                <Line
                  type="monotone"
                  dataKey="moyenne"
                  name="Moyenne"
                  stroke="var(--color-signal)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {/* Deuxième teinte mesurée, pas choisie à l'œil : laiton
                    et corail se ressemblent trop pour un daltonien. */}
                <Line
                  type="monotone"
                  dataKey="pire"
                  name="Pire mesure"
                  stroke="var(--color-serie-2)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            )}
          />
        </div>
      )}

      {!erreur && (
        <Cadre
          titre="Alertes créées — 7 derniers jours"
          methode="Une barre par jour. Les jours sans alerte apparaissent à zéro : ce sont des jours calmes, pas des jours manquants."
          vide={
            aucuneAlerteSurLaPeriode
              ? "Aucune alerte sur les sept derniers jours."
              : alertesParJour && barresAlertes.length === 0
              ? "Pas encore d'historique d'alertes."
              : null
          }
          enfants={(largeur) => (
            <BarChart
              data={barresAlertes}
              width={largeur}
              height={190}
              margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid {...GRILLE} />
              <XAxis dataKey="t" {...AXE} />
              <YAxis {...AXE} width={38} allowDecimals={false} />
              <Tooltip contentStyle={BULLE} cursor={{ fill: "var(--color-surface-2)" }} />
              <Legend wrapperStyle={LEGENDE} />
              {/* Empilées, avec un filet de surface entre les deux
                  segments : deux aplats qui se touchent se lisent comme
                  un seul bloc. */}
              <Bar
                dataKey="critiques"
                name="Critiques"
                stackId="a"
                fill="var(--color-crit)"
                stroke="var(--color-surface)"
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Bar
                dataKey="autres"
                name="Autres"
                stackId="a"
                fill="var(--color-serie-2)"
                stroke="var(--color-surface)"
                strokeWidth={2}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          )}
        />
      )}
    </div>
  );
}