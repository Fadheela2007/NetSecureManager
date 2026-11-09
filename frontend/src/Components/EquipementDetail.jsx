import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import EtatVide from "./EtatVide";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/** Débit abrégé pour une colonne étroite : « 12 M », « 340 k ». */
function debitCourt(kbps) {
  if (kbps === null || kbps === undefined) return "—";
  const n = Number(kbps);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} G`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} M`;
  return `${Math.round(n)} k`;
}

/**
 * Ports qui méritent d'être signalés, et pourquoi.
 *
 * Ce n'est PAS une liste de failles : un port ouvert n'est pas une
 * vulnérabilité, c'est un service qui tourne. Mais ces quatre-là
 * transportent des identifiants ou donnent la main sur la machine, et
 * leur présence sur un poste ordinaire mérite au moins une question.
 *
 * La formulation reste prudente — « à vérifier », jamais « faille ». Un
 * outil qui crie au loup sur un port 3389 parfaitement légitime perd la
 * confiance de son utilisateur, et avec elle toute capacité à signaler
 * ce qui compte vraiment.
 */
const PORTS_A_SURVEILLER = {
  23: "Telnet transmet les mots de passe en clair — SSH est son remplaçant.",
  21: "FTP transmet les mots de passe en clair — SFTP est son remplaçant.",
  3389: "Bureau à distance : à n'exposer qu'aux postes qui en ont besoin.",
  445: "Partage de fichiers Windows : à ne jamais laisser joignable depuis Internet.",
};

/**
 * Taux d'occupation du lien, en %.
 *
 * Maximum des deux sens et non somme : un lien full-duplex fait sa vitesse
 * nominale dans chaque sens indépendamment. Renvoie null si la vitesse du
 * lien est inconnue — supposer 100 Mbit/s afficherait « 5 % » sur un lien
 * 10 Mbit/s réellement à moitié saturé.
 */
function tauxLien(i) {
  if (!i.vitesse_mbps || i.vitesse_mbps <= 0) return null;
  if (i.trafic_entrant_kbps === null && i.trafic_sortant_kbps === null) return null;
  const max = Math.max(i.trafic_entrant_kbps ?? 0, i.trafic_sortant_kbps ?? 0);
  return Math.min(100, (max / (i.vitesse_mbps * 1000)) * 100);
}

/* ══════════════════════════════════════════════════════════════════════
   LA SANTÉ D'UN POSTE, EN QUATRE LIGNES

   Mémoire, disques, ancienneté du démarrage, services de protection.
   Ces quatre-là suffisent à dire si une machine va bien ; le reste de
   l'inventaire dit ce qu'elle contient, ce qui est une autre question.

   RÈGLE DE COULEUR, ET ELLE EST STRICTE. Le rouge et l'orange ne sortent
   que sur un SEUIL FRANCHI, jamais sur une valeur simplement basse :
   un disque à 12 % libre est normal sur un poste de travail, à 4 % il ne
   l'est plus. Un écran qui alarme en permanence n'alarme plus.

   CE QU'ON N'AFFIRME PAS : « ce poste est protégé ». On affiche le nom de
   l'antivirus déclaré et l'état des services, et le lecteur conclut. La
   plateforme ne dit que ce qu'elle a observé.
   ══════════════════════════════════════════════════════════════════════ */
function SantePoste({ sante }) {
  const go = (v) => (v === null || v === undefined ? null : Number(v));
  const mo = (v) => (v === null || v === undefined ? null : Number(v));

  const memTotale = mo(sante.memoire_totale_mo);
  const memLibre = mo(sante.memoire_libre_mo);
  const memPct =
    memTotale && memLibre !== null ? Math.round((memLibre / memTotale) * 100) : null;

  /* Jours écoulés depuis le dernier démarrage. Au-delà de trente jours,
     un poste Windows n'a pas appliqué ses mises à jour — c'est la raison
     pour laquelle ce chiffre est affiché, et le seuil vient de là. */
  const jours =
    sante.dernier_demarrage
      ? Math.floor((Date.now() - new Date(sante.dernier_demarrage).getTime()) / 86400000)
      : null;

  const disques = Array.isArray(sante.disques) ? sante.disques : [];
  const services = Array.isArray(sante.services) ? sante.services : [];
  const antivirus = Array.isArray(sante.antivirus) ? sante.antivirus : [];

  const ton = (mauvais, moyen) =>
    mauvais ? "var(--color-crit)" : moyen ? "var(--color-warn)" : "var(--color-ink)";

  const Case = ({ titre, valeur, note, couleur }) => (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-mute)]">{titre}</p>
      <p className="text-sm font-semibold mt-0.5" style={{ color: couleur }}>
        {valeur}
      </p>
      {note && <p className="text-[10px] text-[var(--color-mute)] mt-0.5">{note}</p>}
    </div>
  );

  const arretes = services.filter((s) => s.etat && s.etat !== "Running");

  return (
    <div className="mb-4">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
        Santé du poste
        {sante.date_releve && (
          <span className="normal-case tracking-normal">
            {" "}
            — relevé le {new Date(sante.date_releve).toLocaleString("fr-FR")}
          </span>
        )}
      </p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {memPct !== null && (
          <Case
            titre="Mémoire libre"
            valeur={`${memPct} %`}
            note={`${Math.round(memLibre / 1024)} Go libres sur ${Math.round(memTotale / 1024)}`}
            couleur={ton(memPct < 10, memPct < 20)}
          />
        )}

        {disques.map((d) => {
          const total = go(d.total_go);
          const libre = go(d.libre_go);
          const pct = total ? Math.round((libre / total) * 100) : null;
          return (
            <Case
              key={d.lettre}
              titre={`Disque ${d.lettre}`}
              valeur={pct === null ? "—" : `${pct} % libre`}
              note={total ? `${libre} Go sur ${total}` : null}
              couleur={ton(pct !== null && pct < 5, pct !== null && pct < 15)}
            />
          );
        })}

        {jours !== null && (
          <Case
            titre="Dernier démarrage"
            valeur={jours === 0 ? "aujourd'hui" : `il y a ${jours} j`}
            note={new Date(sante.dernier_demarrage).toLocaleString("fr-FR")}
            couleur={ton(jours > 60, jours > 30)}
          />
        )}
      </div>

      {/* ── LES SERVICES DE PROTECTION ──
          C'est la ligne que personne d'autre n'affiche, et c'est celle qui
          compte : un pare-feu arrêté ou des mises à jour désactivées sont
          l'état dans lequel un poste se fait prendre. */}
      {services.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {services.map((s) => {
            const actif = s.etat === "Running";
            return (
              <span
                key={s.nom}
                title={`${s.nom} — démarrage ${s.demarrage || "inconnu"}`}
                className="text-[11px] px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: actif
                    ? "var(--color-line)"
                    : "color-mix(in srgb, var(--color-crit) 45%, transparent)",
                  color: actif ? "var(--color-mute)" : "var(--color-crit)",
                }}
              >
                {s.libelle || s.nom} : {actif ? "actif" : "arrêté"}
              </span>
            );
          })}
          {antivirus.map((a) => (
            <span
              key={a}
              className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-line)] text-[var(--color-mute)]"
            >
              antivirus déclaré : {a}
            </span>
          ))}
        </div>
      )}

      {arretes.length > 0 && (
        <p className="text-[11px] mt-1.5" style={{ color: "var(--color-crit)" }}>
          {arretes.length === 1
            ? `${arretes[0].libelle || arretes[0].nom} est arrêté sur ce poste.`
            : `${arretes.length} services de protection sont arrêtés sur ce poste.`}{" "}
          Constaté au dernier relevé, pas déduit.
        </p>
      )}
    </div>
  );
}

export default function EquipementDetail({ equipement, onClose, onRenomme }) {
  const [releves, setReleves] = useState([]);
  // État de la supervision, renseigné seulement quand il n'y a aucun
  // relevé : sert à ne pas accuser SNMP quand le cycle est à l'arrêt.
  const [supervision, setSupervision] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reveilEnCours, setReveilEnCours] = useState(false);
  const [reveilMessage, setReveilMessage] = useState(null);
  const [vulnerabilites, setVulnerabilites] = useState([]);
  const [vulnErreur, setVulnErreur] = useState(false);
  const [interfaces, setInterfaces] = useState([]);
  const [services, setServices] = useState([]);
  const [failles, setFailles] = useState(null);
  const [certificats, setCertificats] = useState([]);
  const [domainesDns, setDomainesDns] = useState(null);

  /* L'intérieur de la machine — remis le 17/09, après avoir été retiré le
     16/09. La collecte n'avait jamais cessé de fonctionner : seule la
     fenêtre avait disparu. */
  const [interieur, setInterieur] = useState(null);
  const [tousLesLogiciels, setTousLesLogiciels] = useState(false);
  const [tousLesProcessus, setTousLesProcessus] = useState(false);
  const [dispo, setDispo] = useState(null);
  const [periodeDispo, setPeriodeDispo] = useState(30);

  /* ------------------------------------------------------------------
     LARGEUR DES GRAPHIQUES, MESUREE PAR NOUS.

     Le composant de mise a l'echelle de la bibliotheque rendait ici un
     graphique de largeur NULLE : sept graduations et une courbe aux
     bonnes coordonnees, dessinees dans un espace de zero pixel de
     large. Invisible, et indiscernable d'une absence de donnees -- ce
     symptome a resiste a quatre corrections portant sur les donnees.

     On mesure donc le conteneur nous-memes. Deux occasions : au
     montage, puis apres un court delai qui laisse la fenetre finir sa
     mise en page. Une largeur nulle n'est jamais retenue : elle
     survient pendant les transitions et ferait clignoter le graphique.
     ------------------------------------------------------------------ */
  /* ── ON N'ESSAIE PLUS DE DEVINER QUAND MESURER : ON OBSERVE ──

     LE DÉFAUT, ET IL ÉTAIT INVISIBLE.

     La mesure vivait dans un effet déclenché par `loading`. Elle supposait
     donc que le conteneur du graphique existe au moment précis où le
     chargement se termine. Il suffisait que l'état des relevés soit posé
     dans un rendu et `loading` dans un autre — deux `.then` successifs
     d'une même promesse — pour que l'effet s'exécute alors que la branche
     affichée était encore l'écran « aucun relevé ». Le conteneur n'existait
     pas, la mesure ne donnait rien, et l'effet ne se rejouait JAMAIS
     puisque `loading` ne rebougeait plus.

     Résultat à l'écran : `largeurGraphique` restait à 0, la condition
     `largeurGraphique > 0` empêchait le graphique d'être construit, et
     l'utilisateur voyait un titre suivi de RIEN. Pas un graphique vide —
     un graphique absent. Indiscernable d'une absence de données, alors
     que la base contenait quatre relevés parfaitement valides.

     LA CORRECTION. Une référence de rappel : React l'appelle au moment
     exact où il attache le nœud au document, quel que soit l'ordre des
     états. On mesure là, puis on confie la suite à un ResizeObserver, qui
     signale tout changement de taille — ouverture de la fiche, rotation
     d'un téléphone, fenêtre redimensionnée. Plus aucun instant à deviner. */
  const observateur = useRef(null);
  const [largeurGraphique, setLargeurGraphique] = useState(0);

  const conteneurGraphique = useCallback((el) => {
    if (observateur.current) {
      observateur.current.disconnect();
      observateur.current = null;
    }
    if (!el) return;

    const mesurer = () => {
      const l = el.getBoundingClientRect().width;
      // Une largeur nulle n'est jamais retenue : elle survient pendant les
      // transitions d'ouverture et ferait clignoter le graphique.
      if (l > 0) setLargeurGraphique(Math.round(l));
    };

    mesurer();
    if (typeof ResizeObserver !== "undefined") {
      observateur.current = new ResizeObserver(mesurer);
      observateur.current.observe(el);
    }
  }, []);

  // Nom personnalisé. Gardé en état local plutôt que relu depuis la
  // liste : après enregistrement, la fiche doit se mettre à jour
  // immédiatement, sans attendre un rechargement complet du parc.
  const [nomPersonnalise, setNomPersonnalise] = useState(equipement.nom_personnalise || "");
  const [edition, setEdition] = useState(false);
  const [nomSaisi, setNomSaisi] = useState("");
  const [enregistrement, setEnregistrement] = useState(false);
  const [erreurNom, setErreurNom] = useState(null);

  // La fiche est réutilisée d'un équipement à l'autre sans être
  // démontée : sans cette remise à zéro, le nom du précédent resterait
  // affiché sur le suivant.
  useEffect(() => {
    setNomPersonnalise(equipement.nom_personnalise || "");
    setEdition(false);
    setErreurNom(null);
  }, [equipement.id_equipement, equipement.nom_personnalise]);

  function annulerEdition() {
    setEdition(false);
    setErreurNom(null);
  }

  /**
   * Enregistre le nom saisi.
   *
   * `valeur` sert au bouton « Effacer », qui force la chaîne vide sans
   * passer par le champ.
   *
   * LE PIÈGE, ET POURQUOI CE CONTRÔLE DE TYPE EXISTE.
   *
   * Cette fonction était câblée directement sur un bouton :
   * `onClick={enregistrerNom}`. React passe alors l'ÉVÉNEMENT DE CLIC
   * en premier argument. Comme il n'est pas `undefined`, il devenait le
   * nom à enregistrer — et axios échouait en tentant de sérialiser un
   * objet circulaire, AVANT même d'émettre la requête.
   *
   * Symptôme : « Enregistrement impossible », et aucune trace dans
   * l'onglet Réseau du navigateur. Une erreur invisible là où on la
   * cherche.
   *
   * Deux corrections, volontairement redondantes : les appels passent
   * désormais par une lambda, ET la fonction refuse tout ce qui n'est
   * pas une chaîne. La première suffit aujourd'hui ; la seconde protège
   * du prochain qui recâblera un bouton sans y penser.
   */
  async function enregistrerNom(valeur) {
    const nom = typeof valeur === "string" ? valeur : nomSaisi;
    setEnregistrement(true);
    setErreurNom(null);
    try {
      const { data } = await axios.patch(
        `${API_URL}/equipements/${equipement.id_equipement}/nom`,
        { nom_personnalise: nom }
      );
      const enregistre = data.nom_personnalise || "";
      setNomPersonnalise(enregistre);
      setEdition(false);
      // La liste derrière doit refléter le changement : sans cela, le
      // nouveau nom disparaît dès qu'on ferme la fiche.
      if (onRenomme) onRenomme(equipement.id_equipement, enregistre);
    } catch (err) {
      setErreurNom(err.response?.data?.error || "Enregistrement impossible");
    } finally {
      setEnregistrement(false);
    }
  }

  /* ── POURQUOI CETTE ANNULATION ──

     Cette fiche n'est PAS démontée quand on passe d'une machine à l'autre :
     le composant reste monté et seul `selection` change. Les neuf requêtes
     de la machine précédente sont donc toujours en vol.

     Sans garde, la réponse lente de la machine A arrivait APRÈS celles de
     la machine B et écrasait l'état : la fiche affichait le nom de B avec
     les certificats, les services ou les FAILLES de A. Sur un produit de
     sécurité, attribuer une faille à la mauvaise machine est le pire
     résultat possible — et rien à l'écran ne l'aurait signalé.

     `annule` empêche l'écriture ; `abort()` coupe la requête devenue
     inutile, ce qui évite neuf requêtes par clic quand on parcourt une
     liste. */
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setLoading(true);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/releves`, { params: { heures: 24 }, signal: controleur.signal })
      .then(({ data }) => {
        if (annule) return;
        // La route renvoyait un tableau nu ; elle renvoie désormais
        // { releves, supervision }. On accepte les deux formes : un
        // frontend à jour ne doit pas casser face à un serveur qui ne
        // l'est pas encore — le cas se produit à chaque déploiement.
        if (Array.isArray(data)) {
          setReleves(data);
          setSupervision(null);
        } else {
          setReleves(data?.releves ?? []);
          setSupervision(data?.supervision ?? null);
        }
      })
      .catch(() => { if (!annule) { setReleves([]); setSupervision(null); } })
      .finally(() => { if (!annule) setLoading(false); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  // Vulnérabilités connues.
  //
  // L'échec était muet, et la section disparaissait simplement. Sur un
  // produit de sécurité, « aucune vulnérabilité affichée » se lit comme
  // « aucune vulnérabilité » — alors que la vérification n'avait pas eu
  // lieu. Silence et absence de risque ne sont pas la même chose, et
  // c'est le genre de confusion qui se paie devant un client.
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setVulnErreur(false);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/vulnerabilites`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setVulnerabilites(data); })
      .catch(() => {
        if (annule) return;
        setVulnerabilites([]);
        setVulnErreur(true);
      });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/interfaces`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setInterfaces(data); })
      .catch(() => { if (!annule) setInterfaces([]); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  // Ports ouverts. La route existait déjà côté serveur mais n'était
  // appelée par personne : les services détectés n'apparaissaient donc
  // sur aucun écran. C'est pourtant l'information la plus parlante d'une
  // fiche sur un produit de supervision — un port 23 ou 3389 ouvert se
  // commente tout seul devant un client.
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/services`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setServices(data); })
      .catch(() => { if (!annule) setServices([]); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  /* Failles publiées pour les versions annoncées.
     `null` tant que la réponse n'est pas là, et `false` si le suivi n'est
     pas installé : trois états distincts, parce qu'une liste vide et une
     absence d'information ne doivent jamais s'afficher pareil. */
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setFailles(null);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/failles`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setFailles(data); })
      .catch(() => { if (!annule) setFailles(false); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  /* L'intérieur de la machine : logiciels installés et programmes qui
     tournent. Seul un agent installé dessus peut le savoir — aucun scan
     réseau, d'aucune plateforme, ne voit à travers un poste.

     La route répond TOUJOURS, même sans agent : elle rend alors
     `agent_installe: false` avec l'explication. C'est ce qui permet à
     l'écran de dire « cette machine n'a pas d'agent » au lieu d'afficher
     une liste vide, qui se lirait « cette machine ne fait tourner aucun
     logiciel ». */
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setInterieur(null);
    setTousLesLogiciels(false);
    setTousLesProcessus(false);
    axios
      .get(`${API_URL}/equipements/${equipement.id_equipement}/inventaire-poste`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setInterieur(data); })
      // 503 si la migration du 10/09 n'est pas passée, 403 pour un
      // lecteur : dans les deux cas la section ne s'affiche pas, et le
      // reste de la fiche fonctionne.
      .catch(() => { if (!annule) setInterieur(null); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  /* Certificats des services chiffrés. Le nombre de jours restants est
     calculé par le serveur à chaque lecture, jamais stocké : figé, il
     serait faux dès le lendemain. */
  /* Domaines contactés. Éteint par défaut sur un site : la réponse porte
     `active`, et l'écran doit dire « personne n'écoute » plutôt que de
     laisser croire que la machine ne contacte rien. */
  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setDomainesDns(null);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/observations-dns`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setDomainesDns(data); })
      .catch(() => { if (!annule) setDomainesDns(null); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setCertificats([]);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/certificats`, { signal: controleur.signal })
      .then(({ data }) => { if (!annule) setCertificats(Array.isArray(data) ? data : []); })
      .catch(() => { if (!annule) setCertificats([]); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement]);

  useEffect(() => {
    const controleur = new AbortController();
    let annule = false;
    setDispo(null);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/disponibilite`, {
      params: { jours: periodeDispo },
      signal: controleur.signal,
    })
      .then(({ data }) => { if (!annule) setDispo(data); })
      .catch(() => { if (!annule) setDispo(null); });
    return () => { annule = true; controleur.abort(); };
  }, [equipement.id_equipement, periodeDispo]);

  async function reveiller() {
    setReveilEnCours(true);
    setReveilMessage(null);
    try {
      const { data } = await axios.post(`${API_URL}/equipements/${equipement.id_equipement}/reveiller`);
      setReveilMessage({ type: "ok", texte: data.message });
    } catch (err) {
      setReveilMessage({ type: "erreur", texte: err.response?.data?.error || "Échec de l'envoi" });
    } finally {
      setReveilEnCours(false);
    }
  }

  const donnees = releves.map((r) => ({
    heure: new Date(r.date_releve).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    cpu: r.cpu_pourcent,
    ram: r.ram_pourcent,
    latence: r.latence_ms,
  }));

  const aDesMetriques = donnees.some((d) => d.cpu !== null || d.ram !== null);

  return (
    // Sur mobile la fenêtre occupe tout l'écran (marges nulles, hauteur pleine) ;
    // à partir de sm: elle redevient une boîte centrée.
    <div
      className="fixed inset-0 flex items-stretch sm:items-center justify-center z-50 p-0 sm:p-4"
      style={{ background: "var(--voile-modale)" }}
    >
      <div className="bg-[var(--color-surface)] border-0 sm:border border-[var(--color-line)] rounded-none sm:rounded-xl p-4 sm:p-6 max-w-2xl w-full h-full sm:h-auto sm:max-h-[85vh] overflow-auto">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0 flex-1">
            {edition ? (
              <div className="space-y-2">
                <label className="block text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
                  Nom de cet équipement
                </label>
                <input
                  autoFocus
                  value={nomSaisi}
                  onChange={(e) => setNomSaisi(e.target.value)}
                  onKeyDown={(e) => {
                    // Entrée valide, Échap annule : sur un champ unique,
                    // atteindre le bouton à la souris est une manœuvre
                    // inutile.
                    if (e.key === "Enter") enregistrerNom();
                    if (e.key === "Escape") annulerEdition();
                  }}
                  maxLength={150}
                  placeholder={equipement.nom || equipement.adresse_ip}
                  className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)]"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    /* Lambda et non `onClick={enregistrerNom}` : React
                       passerait l'événement de clic en argument. */
                    onClick={() => enregistrerNom()}
                    disabled={enregistrement}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium disabled:opacity-50"
                  >
                    {enregistrement ? "Enregistrement…" : "Enregistrer"}
                  </button>
                  <button
                    onClick={annulerEdition}
                    className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:text-[var(--color-ink)] transition"
                  >
                    Annuler
                  </button>
                  {/* Effacer ne s'affiche que s'il y a quelque chose à
                      effacer, et dit ce qui se passera ensuite : sans
                      cela, on croit supprimer l'équipement. */}
                  {nomPersonnalise && (
                    <button
                      onClick={() => enregistrerNom("")}
                      disabled={enregistrement}
                      className="text-xs text-[var(--color-mute)] hover:text-[var(--color-crit)] transition disabled:opacity-50"
                    >
                      Effacer — revenir à « {equipement.nom || equipement.adresse_ip} »
                    </button>
                  )}
                </div>
                {erreurNom && (
                  <p className="text-xs text-[var(--color-crit)]">{erreurNom}</p>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-[var(--font-display)] text-lg font-semibold">
                    {nomPersonnalise || equipement.nom || equipement.adresse_ip}
                  </h2>
                  <button
                    onClick={() => {
                      setNomSaisi(nomPersonnalise || "");
                      setErreurNom(null);
                      setEdition(true);
                    }}
                    className="text-xs px-2 py-1 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
                  >
                    {nomPersonnalise ? "Renommer" : "Nommer"}
                  </button>
                </div>
                {/* Le nom découvert reste visible quand un nom
                    personnalisé le masque : pour diagnostiquer, c'est
                    « KMBFD6FC » qui compte, pas « Imprimante
                    comptabilité ». */}
                {nomPersonnalise && equipement.nom && (
                  <p className="text-xs text-[var(--color-mute)]">
                    nom réseau : <span className="font-[var(--font-mono)]">{equipement.nom}</span>
                  </p>
                )}
              </>
            )}
            <p className="text-xs text-[var(--color-mute)] font-[var(--font-mono)]">{equipement.adresse_ip}</p>

            <button
              onClick={reveiller}
              disabled={reveilEnCours}
              className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50"
            >
              {reveilEnCours ? "Envoi…" : "Réveiller (Wake-on-LAN)"}
            </button>
            {reveilMessage && (
              <p className={`text-xs mt-1 ${reveilMessage.type === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}`}>
                {reveilMessage.texte}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Fermer"
            className="cible-tactile shrink-0 text-[var(--color-mute)] hover:text-[var(--color-ink)] text-sm"
          >
            Fermer ✕
          </button>
        </div>

        {/* ── IDENTITÉ ──
            Ces informations existaient toutes en base et n'étaient
            affichées nulle part : la fiche passait directement de son
            titre aux graphiques. Or « quelle est cette machine » précède
            toujours « comment se porte-t-elle ». */}
        <dl className="mb-5 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">État</dt>
            <dd
              style={{
                color:
                  equipement.statut === "up"
                    ? "var(--color-ok)"
                    : equipement.statut === "down"
                    ? "var(--color-crit)"
                    : "var(--color-mute)",
              }}
            >
              {equipement.statut === "up"
                ? "En ligne"
                : equipement.statut === "down"
                ? "Hors ligne"
                : "Inconnu"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">Type</dt>
            <dd>{equipement.type_libelle || "Inconnu"}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
              Fabricant
            </dt>
            <dd className="break-words">
              {equipement.fabricant || "Inconnu"}
              {/* L'origine du fabricant est dite, parce qu'elle change ce
                  qu'on peut en conclure : l'adresse matérielle identifie
                  la CARTE réseau, pas la machine. Un serveur Dell avec
                  une carte Intel remonte « Intel », et sans cette
                  mention on croirait à une erreur. */}
              {equipement.fabricant_source === "oui" && (
                <span className="block text-[11px] text-[var(--color-mute)]">
                  d'après la carte réseau
                </span>
              )}
              {equipement.fabricant_source === "nmap" && (
                <span className="block text-[11px] text-[var(--color-mute)]">
                  d'après le système
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
              Adresse matérielle
            </dt>
            <dd className="font-[var(--font-mono)] text-[13px]">
              {equipement.adresse_mac || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
              Système détecté
            </dt>
            <dd className="break-words text-[13px]">{equipement.os_detecte || "—"}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
              Vu pour la dernière fois
            </dt>
            <dd className="text-[13px]">
              {equipement.derniere_decouverte
                ? new Date(equipement.derniere_decouverte).toLocaleString("fr-FR")
                : "—"}
            </dd>
          </div>
        </dl>

        {/* ── POURQUOI CETTE MACHINE EST À L'INVENTAIRE ──

            La ligne qu'aucun autre outil n'affiche. Zabbix, Nagios,
            Centreon et Checkmk montrent un hôte et son état ; aucun ne
            dit sur quelle PREUVE cet hôte figure dans la liste.

            C'est par ce trou qu'une adresse fantôme entre : le balayage
            lisait le cache ARP du système — un souvenir des machines
            vues il y a quelques minutes — et l'inscrivait comme un
            équipement. Checkmk connaît encore ce défaut, forum à l'appui.

            Ici, chaque machine porte sa preuve et sa date. Un client qui
            conteste une ligne a sa réponse en une phrase. */}
        {equipement.preuve_detail && (
          <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
              Pourquoi cette machine est à l'inventaire
            </div>
            <div className="text-[13px] text-[var(--color-ink)] mt-1">
              {equipement.preuve_detail}
            </div>
            {equipement.date_preuve && (
              <div className="text-[11px] text-[var(--color-mute)] mt-1">
                Constaté le{" "}
                {new Date(equipement.date_preuve).toLocaleString("fr-FR")}
              </div>
            )}
          </div>
        )}

        {/* Dit explicitement que le contrôle n'a pas eu lieu, plutôt que
            de laisser une absence passer pour un feu vert. */}
        {vulnErreur && (
          <div className="mb-5 border border-[var(--color-warn)]/40 rounded-lg p-3">
            <p className="text-xs text-[var(--color-warn)]">
              Vulnérabilités connues : vérification impossible. L'absence
              d'anomalie affichée ne signifie pas qu'il n'y en a pas.
            </p>
          </div>
        )}

        {/* SERVICES EXPOSÉS, ET NON « VULNÉRABILITÉS ».
            Le titre disait « vulnérabilités potentielles détectées ». Un
            scan de ports ne détecte pas de vulnérabilité : il constate
            qu'un service répond. Telnet n'a pas de faille, il transmet
            les mots de passe en clair par conception — c'est un risque
            d'exposition, pas une CVE. Annoncer l'un pour l'autre devant
            un responsable informatique ferait douter de tout le reste. */}
        {vulnerabilites.length > 0 && (
          <div className="mb-5 bg-[var(--color-crit)]/5 border border-[var(--color-crit)]/30 rounded-lg p-4">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-crit)] mb-1 font-medium">
              Services exposés à risque ({vulnerabilites.length})
            </h3>
            <p className="text-[11px] text-[var(--color-mute)] mb-3">
              Constaté depuis les ports ouverts. Ce sont des risques liés au
              protocole lui-même, pas des failles logicielles : aucune
              version n'a été testée.
            </p>
            <ul className="space-y-2">
              {vulnerabilites.map((v) => (
                <li key={v.id_vuln} className="text-xs">
                  <span className="text-[var(--color-ink)] font-medium">
                    {v.service}
                  </span>{" "}
                  <span className="text-[var(--color-mute)]">port {v.port}</span>
                  <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase bg-[var(--color-crit)]/20 text-[var(--color-crit)]">
                    {v.severite}
                  </span>
                  <p className="text-[var(--color-mute)] mt-0.5">{v.description}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {dispo && (
          <div className="mb-5 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg p-4">
            <div className="flex items-start justify-between gap-4 mb-2">
              <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)]">
                {dispo.nature === "presence" ? "Taux de présence" : "Taux de disponibilité"}
              </h3>
              <select
                value={periodeDispo}
                onChange={(e) => setPeriodeDispo(Number(e.target.value))}
                className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg px-2 py-1 text-xs outline-none focus:border-[var(--color-signal)] transition"
              >
                <option value={7}>7 jours</option>
                <option value={30}>30 jours</option>
                <option value={90}>90 jours</option>
              </select>
            </div>

            <div className="flex items-baseline gap-3 flex-wrap">
              {/* Un taux non fiable n'est jamais présenté comme un chiffre ferme :
                  il est grisé et suffixé « indicatif ». */}
              <span
                className="font-[var(--font-display)] text-2xl font-semibold"
                style={{
                  /* Un taux de PRÉSENCE ne se juge pas : 40 % sur un poste
                     de travail décrit quelqu'un qui éteint son ordinateur
                     le soir. Le colorer en rouge ferait chercher une panne
                     qui n'existe pas. Il s'affiche donc en encre neutre,
                     sans verdict. */
                  color:
                    !dispo.fiable || dispo.nature === "presence"
                      ? "var(--color-ink)"
                      : dispo.taux_disponibilite >= 99
                      ? "var(--color-ok)"
                      : dispo.taux_disponibilite >= 95
                      ? "var(--color-warn)"
                      : "var(--color-crit)",
                  opacity: dispo.fiable ? 1 : 0.55,
                }}
              >
                {dispo.taux_indicatif !== null ? `${dispo.taux_indicatif.toFixed(2)} %` : "—"}
              </span>
              {!dispo.fiable && (
                <span className="text-xs text-[var(--color-warn)]">indicatif</span>
              )}
              <span className="text-xs text-[var(--color-mute)]">
                {/* « 25 200 min d'indisponibilité » sur un poste éteint le
                    soir est exact et absurde : on dit « hors tension », qui
                    décrit la même mesure sans l'accuser. */}
                {dispo.nature === "presence" ? (
                  <>
                    {Math.round(dispo.minutes_indisponible / 60)} h hors tension sur{" "}
                    {Math.round(dispo.heures_observables)} h observées
                  </>
                ) : (
                  <>
                    {dispo.nb_pannes} panne(s) — {dispo.minutes_indisponible} min
                    d'indisponibilité sur {Math.round(dispo.heures_observables)} h observées
                  </>
                )}
                {dispo.cycles_observes > 0 && (
                  <span className="ml-1">
                    ({dispo.cycles_repondus} cycles sur {dispo.cycles_observes})
                  </span>
                )}
              </span>
            </div>

            {dispo.avertissements.length > 0 && (
              <ul className="mt-2 space-y-1">
                {dispo.avertissements.map((a, i) => (
                  <li key={i} className="text-[11px] text-[var(--color-mute)] flex gap-1.5">
                    <span className="text-[var(--color-warn)] shrink-0">!</span>
                    {a}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── CERTIFICATS DES SERVICES CHIFFRÉS ──

            Placé HAUT dans la fiche, avant les ports : c'est la seule
            information de cet écran qui annonce une panne AVANT qu'elle
            arrive. Un certificat qui expire ne se dégrade pas, il coupe.

            Le jour où il expire est connu à la seconde près, des mois à
            l'avance, et écrit dans l'équipement lui-même. L'enterrer en
            bas de page reviendrait à laisser tomber un service dont on
            tenait la date de panne. */}
        {certificats.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
              Certificats
            </h3>
            <div className="space-y-2">
              {certificats.map((c) => {
                const jours = c.jours_restants === null ? null : Number(c.jours_restants);
                const couleur =
                  jours === null
                    ? "var(--color-mute)"
                    : jours < 0
                      ? "var(--color-crit)"
                      : jours <= 30
                        ? "var(--color-warn)"
                        : "var(--color-ok)";

                return (
                  <div
                    key={c.port}
                    className="border rounded-lg p-3"
                    style={{ borderColor: couleur }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm">
                        <span className="font-[var(--font-mono)] text-[var(--color-mute)]">
                          {c.port}
                        </span>{" "}
                        {c.sujet || "certificat sans nom"}
                      </p>
                      <p className="text-xs" style={{ color: couleur }}>
                        {jours === null
                          ? "date d'expiration illisible"
                          : jours < 0
                            ? `EXPIRÉ depuis ${Math.abs(jours)} jour(s)`
                            : `expire dans ${jours} jour(s)`}
                      </p>
                    </div>

                    <p className="text-[11px] text-[var(--color-mute)] mt-1">
                      Émis par {c.emetteur || "émetteur inconnu"}
                      {c.auto_signe ? " — auto-signé" : ""}
                      {c.taille_cle ? ` · clé ${c.taille_cle} bits` : ""}
                      {c.courbe ? ` · courbe ${c.courbe}` : ""}
                      {c.protocole ? ` · ${c.protocole}` : ""}
                    </p>

                    {/* TROIS ÉTATS, PAS DEUX. Un refus de connexion
                        ancienne peut venir de NOTRE bibliothèque avant le
                        serveur : écrire « n'accepte pas TLS 1.0 » sur
                        cette base serait une affirmation de sécurité non
                        vérifiée. On ne dit donc que la preuve. */}
                    {c.tls_ancien_accepte === 1 && (
                      <p className="text-[11px] text-[var(--color-warn)] mt-1">
                        Accepte encore TLS 1.0 ou 1.1, retirés des navigateurs depuis 2020.
                      </p>
                    )}

                    {c.auto_signe === 1 && (
                      <p className="text-[11px] text-[var(--color-mute)] mt-1">
                        Un certificat auto-signé est courant sur un équipement interne.
                        Il n'est un défaut que sur un service accessible depuis l'extérieur.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-[var(--color-mute)] mt-2 leading-relaxed">
              Lu pendant le scan, dans la carte d'identité que chaque service chiffré
              présente à la connexion — comme le fait un navigateur. Rien n'a été envoyé.
            </p>
          </div>
        )}

        {/* ── CE QUE CETTE MACHINE CHERCHE À JOINDRE ──

            Le seul écran de la fiche qui ne dépend NI d'un agent installé,
            NI d'un port ouvert. Il vaut pour un téléphone, une imprimante,
            une caméra, une machine de passage — tout ce sur quoi on ne
            posera jamais de logiciel.

            Les signaux d'abord, la liste ensuite : une machine contacte
            couramment plusieurs centaines de domaines dont aucun ne pose
            question. Montrer la liste en premier noierait les deux lignes
            qui comptent. */}
        {domainesDns && domainesDns.active === false && (
          <div className="mb-5">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
              Domaines contactés
            </h3>
            <p className="text-xs text-[var(--color-mute)] leading-relaxed">
              {domainesDns.explication}.
            </p>
          </div>
        )}

        {domainesDns && domainesDns.active && (
          <div className="mb-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
              <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)]">
                Domaines contactés
              </h3>
              <span className="text-[11px] text-[var(--color-mute)]">
                {domainesDns.total_domaines} domaine(s)
                {domainesDns.depuis
                  ? ` — depuis le ${new Date(domainesDns.depuis).toLocaleDateString("fr-FR")}`
                  : ""}
              </span>
            </div>

            {domainesDns.signaux?.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {domainesDns.signaux.map((s) => (
                  <div
                    key={`${s.code}-${s.domaine}`}
                    className="border rounded-lg p-2.5"
                    style={{
                      borderColor:
                        s.gravite === "critique"
                          ? "var(--color-crit)"
                          : "var(--color-warn)",
                    }}
                  >
                    <p
                      className="text-xs"
                      style={{
                        color:
                          s.gravite === "critique"
                            ? "var(--color-crit)"
                            : "var(--color-warn)",
                      }}
                    >
                      <span className="font-[var(--font-mono)]">{s.domaine}</span>
                      {s.occurrences > 1 ? ` · vu ${s.occurrences} fois` : ""}
                    </p>
                    {/* Le POURQUOI, toujours affiché. Ces signaux se
                        trompent parfois ; un constat qu'on ne peut pas
                        contester est un constat qu'on finit par ignorer. */}
                    <p className="text-[11px] text-[var(--color-mute)] mt-0.5 leading-relaxed">
                      {s.detail}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {domainesDns.domaines?.length > 0 && (
              <div className="table-scroll max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                      <th className="pb-1.5 font-medium">Domaine</th>
                      <th className="pb-1.5 font-medium">Catégorie</th>
                      <th className="pb-1.5 font-medium text-right">Requêtes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]">
                    {domainesDns.domaines.map((d) => (
                      <tr key={d.domaine}>
                        <td className="py-1.5 font-[var(--font-mono)] text-[12px]">
                          {d.domaine}
                        </td>
                        <td className="py-1.5 text-[var(--color-mute)]">
                          {d.categorie || "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums text-[var(--color-mute)]">
                          {Number(d.compteur).toLocaleString("fr-FR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-[11px] text-[var(--color-mute)] mt-2 leading-relaxed">
              Relevé par le résolveur du site. Seul le domaine est conservé, jamais
              l'adresse complète, et aucune heure de requête n'est enregistrée : c'est
              un relevé d'usage, pas un historique de navigation.
            </p>
          </div>
        )}

        {services.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
              Services ouverts ({services.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {services.map((s) => {
                const remarque = PORTS_A_SURVEILLER[s.port];
                return (
                  <span
                    /* Le port suffit comme clé : la route ne renvoie pas
                       d'identifiant, et un même port ne peut apparaître
                       deux fois pour un même équipement. */
                    key={s.port}
                    title={remarque || undefined}
                    className="text-xs px-2 py-1 rounded-lg border"
                    style={{
                      borderColor: remarque ? "var(--color-warn)" : "var(--color-line)",
                      color: remarque ? "var(--color-warn)" : "var(--color-mute)",
                    }}
                  >
                    <span className="font-[var(--font-mono)]">{s.port}</span>
                    {s.nom_service ? ` ${s.nom_service}` : ""}
                  </span>
                );
              })}
            </div>

            {/* ── QUEL LOGICIEL, ET DANS QUELLE VERSION ──

                « Le port 22 est ouvert » ne permet de rattacher aucune
                faille connue sans mentir. « OpenSSH 8.2p1 » est d'une
                autre nature : c'est une version précise d'un logiciel
                précis. C'est cette ligne qui rend l'inventaire
                exploitable en sécurité.

                La bannière brute est gardée en infobulle : une version
                contestée se vérifie en lisant ce que la machine a
                réellement annoncé. */}
            {services.some((s) => s.produit) && (
              <div className="mt-3">
                <p className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
                  Logiciels déclarés
                </p>
                <ul className="space-y-1">
                  {services
                    .filter((s) => s.produit)
                    .map((s) => (
                      <li key={`v-${s.port}`} className="text-xs flex flex-wrap gap-x-2">
                        <span className="font-[var(--font-mono)] text-[var(--color-mute)]">
                          {s.port}
                        </span>
                        <span>
                          {s.produit}
                          {s.version ? ` ${s.version}` : ""}
                        </span>
                        {!s.version && (
                          <span className="text-[var(--color-mute)]">
                            — version non annoncée
                          </span>
                        )}
                        {s.banniere && (
                          <span
                            className="text-[var(--color-mute)] italic truncate max-w-full"
                            title={s.banniere}
                          >
                            « {s.banniere} »
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
                <p className="text-[11px] text-[var(--color-mute)] mt-1.5 leading-relaxed">
                  Lu dans ce que le service annonce de lui-même à la connexion —
                  aucune sonde n'a été envoyée. Une bannière peut être personnalisée
                  ou masquée : le texte reçu est conservé pour vérification.
                </p>
              </div>
            )}

            {/* ── FAILLES PUBLIÉES POUR CES VERSIONS ──

                Ce bloc dit trois choses différentes, et ne les confond
                jamais : ce qui a été trouvé, ce qui a été cherché sans
                rien trouver, et ce qui n'a pas été cherché du tout.

                Un outil de sécurité qui affiche une liste vide sans dire
                s'il a regardé rassure sans avoir regardé. C'est le pire
                défaut qu'il puisse avoir, et c'est celui qui a déjà coûté
                111 machines supervisées par personne sur ce parc. */}
            {Array.isArray(failles) && failles.length > 0 && (
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
                  Failles publiées pour ces versions
                </p>

                {failles.map((s) => (
                  <div key={`f-${s.port}`} className="mb-3">
                    <p className="text-xs">
                      <span className="font-[var(--font-mono)] text-[var(--color-mute)]">
                        {s.port}
                      </span>{" "}
                      {s.produit}
                      {s.version ? ` ${s.version}` : ""}
                      {s.failles.length > 0 && (
                        <span className="text-[var(--color-warn)]">
                          {" "}— {s.failles.length} faille(s) à vérifier
                        </span>
                      )}
                    </p>

                    {s.explication && (
                      <p className="text-[11px] text-[var(--color-mute)] mt-0.5 leading-relaxed">
                        {s.statut === "jamais_interroge" || s.statut === "erreur" ? "⚠ " : ""}
                        {s.explication}
                      </p>
                    )}

                    {s.failles.length > 0 && (
                      <ul className="mt-1 space-y-1">
                        {s.failles.slice(0, 8).map((f) => (
                          <li key={f.cve_id} className="text-[11px] flex flex-wrap gap-x-2">
                            {/* Le lien vers la source est indispensable :
                                une référence qu'on ne peut pas vérifier
                                ne vaut rien, et la première vérification
                                d'un technicien décide s'il croit le reste
                                du produit. */}
                            <a
                              href={`https://nvd.nist.gov/vuln/detail/${f.cve_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-[var(--font-mono)] text-[var(--color-signal)] hover:underline shrink-0"
                            >
                              {f.cve_id}
                            </a>
                            {f.score !== null && f.score !== undefined && (
                              <span className="text-[var(--color-mute)] shrink-0">
                                {f.severite} {f.score}
                              </span>
                            )}
                            <span className="text-[var(--color-mute)] truncate max-w-full">
                              {f.description}
                            </span>
                          </li>
                        ))}
                        {s.failles.length > 8 && (
                          <li className="text-[11px] text-[var(--color-mute)]">
                            … et {s.failles.length - 8} autres
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}

                <p className="text-[11px] text-[var(--color-mute)] leading-relaxed border-t border-[var(--color-line)] pt-2">
                  Source : NVD (NIST). Le rapprochement se fait sur la version
                  numérique annoncée — un correctif de distribution corrige souvent
                  une faille sans changer ce numéro. C'est une liste à vérifier,
                  pas un verdict sur cette machine.
                </p>
              </div>
            )}

            {failles === false && services.some((s) => s.produit) && (
              <p className="text-[11px] text-[var(--color-mute)] mt-3 leading-relaxed">
                ⚠ Le suivi des failles connues n'est pas installé sur cette base.
                Les versions ci-dessus n'ont donc été comparées à rien — ce n'est
                pas une absence de faille.
              </p>
            )}

            {/* La remarque est écrite EN TOUTES LETTRES sous la liste, et
                pas seulement en infobulle : une information de sécurité
                qui exige de survoler avec une souris n'existe pas sur un
                écran tactile, et ne se voit pas sur une capture. */}
            {services.some((s) => PORTS_A_SURVEILLER[s.port]) && (
              <ul className="mt-2 space-y-1">
                {services
                  .filter((s) => PORTS_A_SURVEILLER[s.port])
                  .map((s) => (
                    <li
                      key={`note-${s.port}`}
                      className="text-[11px] text-[var(--color-mute)] flex gap-1.5"
                    >
                      <span className="text-[var(--color-warn)] shrink-0">!</span>
                      <span>
                        <span className="font-[var(--font-mono)]">{s.port}</span>{" "}
                        {PORTS_A_SURVEILLER[s.port]}
                      </span>
                    </li>
                  ))}
                <li className="text-[11px] text-[var(--color-mute)] italic pt-1">
                  Un port ouvert n'est pas une faille : c'est un service qui tourne. Ces
                  points sont à vérifier, pas à corriger d'office.
                </li>
              </ul>
            )}
          </div>
        )}

        {interfaces.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
              Interfaces réseau ({interfaces.length})
            </h3>
            <div className="table-scroll"><table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                  <th className="pb-2 font-medium">Interface</th>
                  <th className="pb-2 font-medium">Débit</th>
                  <th className="pb-2 font-medium">Lien</th>
                  <th className="pb-2 font-medium">VLAN</th>
                  <th className="pb-2 font-medium">Admin</th>
                  <th className="pb-2 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {interfaces.map((i) => (
                  // Atténuée quand elle est exclue du total : la même
                  // convention que sur la page Bande passante. Deux écrans
                  // qui montrent la même interface doivent en dire la même
                  // chose, sinon c'est l'outil qu'on cesse de croire.
                  <tr key={i.id_interface} className={i.ignoree_du_total ? "opacity-50" : ""}>
                    <td className="py-2 font-[var(--font-mono)] text-[13px]">
                      {i.nom}
                      {i.ignoree_du_total && (
                        <span
                          className="ml-2 text-[11px] text-[var(--color-mute)]"
                          title="Boucle locale : elle voit passer le trafic interne de la machine. La compter doublerait la consommation apparente."
                        >
                          (hors total)
                        </span>
                      )}
                      {i.adresse_mac && (
                        <span className="ml-2 text-[11px] text-[var(--color-mute)]">{i.adresse_mac}</span>
                      )}
                    </td>
                    {/* Débit du port. « — » signifie « pas encore mesuré »
                        (il faut deux relevés SNMP pour une différence),
                        « 0 » signifie « mesuré, aucun trafic ». Les deux
                        ne doivent pas se confondre. */}
                    <td className="py-2 text-[var(--color-mute)] text-xs whitespace-nowrap tabular-nums">
                      {i.trafic_entrant_kbps === null || i.trafic_entrant_kbps === undefined ? (
                        <span title="Aucune mesure : le débit se calcule entre deux relevés SNMP.">—</span>
                      ) : (
                        <>
                          ↓ {debitCourt(i.trafic_entrant_kbps)}
                          <br />↑ {debitCourt(i.trafic_sortant_kbps)}
                        </>
                      )}
                    </td>
                    <td className="py-2 text-xs whitespace-nowrap">
                      {tauxLien(i) === null ? (
                        <span className="text-[var(--color-mute)]">
                          {i.vitesse_mbps ? `${i.vitesse_mbps} Mbit/s` : "—"}
                        </span>
                      ) : (
                        <span
                          style={{
                            color:
                              tauxLien(i) >= 80
                                ? "var(--color-crit)"
                                : tauxLien(i) >= 50
                                ? "var(--color-warn)"
                                : "var(--color-mute)",
                          }}
                          title={`${i.vitesse_mbps} Mbit/s nominal`}
                        >
                          {tauxLien(i).toFixed(1)} %
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-[var(--color-mute)]">{i.vlan || "—"}</td>
                    <td className="py-2 text-[var(--color-mute)] text-xs">{i.etat_admin || "—"}</td>
                    <td className="py-2">
                      <span
                        className="text-xs"
                        style={{
                          color:
                            i.etat_operationnel === "up"
                              ? "var(--color-ok)"
                              : i.etat_operationnel === "down"
                              ? "var(--color-crit)"
                              : "var(--color-mute)",
                        }}
                      >
                        {i.etat_operationnel || "inconnu"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            L'INTÉRIEUR DE LA MACHINE

            Tout le reste de cette fiche vient du RÉSEAU : des ports qui
            répondent, des noms annoncés, des relevés SNMP. Cette
            section-ci vient d'ailleurs — d'un script exécuté SUR le
            poste, qui a envoyé ce qu'il y a vu.

            La distinction n'est pas un détail de vocabulaire : aucun
            scan, d'aucune plateforme au monde, ne voit à travers une
            machine. Ce qui est écrit ici n'a pas été deviné, il a été
            DÉCLARÉ par la machine elle-même — et la section le dit, avec
            la date et la version de l'agent.

            CE QUI N'EST PAS AFFICHÉ, ET C'EST VOULU : ni le nom de
            l'utilisateur, ni les lignes de commande. Le script ne les
            collecte pas — les lignes de commande contiennent
            régulièrement des mots de passe et des chemins personnels.
            Un inventaire de parc n'a pas besoin de savoir QUI est
            devant la machine.
            ══════════════════════════════════════════════════════════ */}
        {interieur && (
          <div className="mb-5">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
              Intérieur de la machine
            </h3>

            {/* LE TEST PORTAIT SUR `agent_installe`, ET C'ÉTAIT UN DÉFAUT.

                Depuis que le scan lit l'intérieur des machines par SNMP
                et par WMI — sans rien installer — un relevé parfaitement
                valide arrive avec `agent_installe: false`. Cette section
                affichait alors un paragraphe VIDE à la place des
                logiciels et des programmes qu'elle venait de recevoir :
                le serveur savait, l'interface se taisait.

                Le bon test est `observe` : « ai-je quelque chose à
                montrer ? ». D'où ça vient est dit juste en dessous. */}
            {!interieur.observe ? (
              /* Dire pourquoi c'est vide. Une liste vide sans un mot se
                 lirait « cette machine ne fait tourner aucun logiciel »,
                 ce qui est absurde — et c'est pourtant ce qu'affichent
                 la plupart des inventaires. */
              <p className="text-xs text-[var(--color-mute)]">
                {interieur.explication}
              </p>
            ) : (
              <>
                {/* TROIS VOIES, TROIS PHRASES DIFFÉRENTES. Dire « déclaré
                    par la machine elle-même » d'un relevé WMI serait faux :
                    c'est le serveur qui a demandé, et la machine a répondu
                    sans que rien n'y soit installé. C'est précisément
                    l'argument du produit — il doit être exact. */}
                <p className="text-[11px] text-[var(--color-mute)] mb-3">
                  {interieur.source === "agent"
                    ? "Déclaré par la machine elle-même"
                    : interieur.source === "wmi"
                    ? "Lu à distance par WMI, sans rien installer sur le poste"
                    : "Lu à distance par SNMP, sans rien installer sur le poste"}
                  {interieur.agent_version && ` (agent ${interieur.agent_version})`}
                  {interieur.dernier_inventaire &&
                    ` le ${new Date(interieur.dernier_inventaire).toLocaleString("fr-FR")}`}
                  . Ni nom d'utilisateur, ni ligne de commande : ils ne sont pas
                  collectés.
                </p>

                {/* ══════════════════════════════════════════════════════
                    LA SANTÉ DU POSTE

                    Un inventaire dit ce qui est installé. Il ne dit pas si
                    la machine va bien. Ces quatre chiffres-là, oui — et ce
                    sont ceux qu'un responsable informatique regarde en
                    premier.

                    Chaque valeur absente reste absente : une machine lue
                    par DCOM donne sa mémoire sans ses disques. On n'écrit
                    pas « 0 » à la place, ce serait une alerte, et fausse.
                    ══════════════════════════════════════════════════════ */}
                {interieur.sante && <SantePoste sante={interieur.sante} />}

                <div className="grid gap-5 md:grid-cols-2">
                  {/* ── LOGICIELS INSTALLÉS ── */}
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
                      Logiciels installés ({interieur.logiciels.length})
                    </p>
                    {interieur.logiciels.length === 0 ? (
                      <p className="text-xs text-[var(--color-mute)]">
                        Aucun logiciel remonté.
                      </p>
                    ) : (
                      <>
                        <ul className="space-y-1">
                          {(tousLesLogiciels
                            ? interieur.logiciels
                            : interieur.logiciels.slice(0, 12)
                          ).map((l, i) => (
                            <li
                              key={`${l.nom}-${l.version || i}`}
                              className="text-xs flex items-baseline justify-between gap-2"
                            >
                              <span className="truncate" title={l.editeur || undefined}>
                                {l.nom}
                              </span>
                              <span className="text-[var(--color-mute)] font-[var(--font-mono)] text-[11px] whitespace-nowrap">
                                {l.version || "—"}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {interieur.logiciels.length > 12 && (
                          <button
                            onClick={() => setTousLesLogiciels((v) => !v)}
                            className="text-[11px] text-[var(--color-signal)] hover:underline mt-1.5 cible-tactile"
                          >
                            {tousLesLogiciels
                              ? "Réduire"
                              : `Afficher les ${interieur.logiciels.length - 12} autres`}
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* ── PROGRAMMES EN COURS ──
                      Triés par mémoire décroissante côté serveur : ce qui
                      pèse se lit en premier. Le nombre d'occurrences est
                      montré parce qu'un navigateur ouvre trente processus
                      du même nom — les compter séparément donnerait une
                      liste illisible. */}
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
                      Programmes en cours ({interieur.processus.length})
                    </p>
                    {interieur.processus.length === 0 ? (
                      <p className="text-xs text-[var(--color-mute)]">
                        Aucun programme remonté.
                      </p>
                    ) : (
                      <>
                        <ul className="space-y-1">
                          {(tousLesProcessus
                            ? interieur.processus
                            : interieur.processus.slice(0, 12)
                          ).map((pr, i) => (
                            <li
                              key={`${pr.nom}-${i}`}
                              className="text-xs flex items-baseline justify-between gap-2"
                            >
                              <span className="truncate">
                                {pr.nom}
                                {pr.occurrences > 1 && (
                                  <span className="text-[var(--color-mute)] ml-1">
                                    ×{pr.occurrences}
                                  </span>
                                )}
                              </span>
                              <span className="text-[var(--color-mute)] font-[var(--font-mono)] text-[11px] whitespace-nowrap">
                                {pr.memoire_ko
                                  ? `${Math.round(pr.memoire_ko / 1024)} Mo`
                                  : "—"}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {interieur.processus.length > 12 && (
                          <button
                            onClick={() => setTousLesProcessus((v) => !v)}
                            className="text-[11px] text-[var(--color-signal)] hover:underline mt-1.5 cible-tactile"
                          >
                            {tousLesProcessus
                              ? "Réduire"
                              : `Afficher les ${interieur.processus.length - 12} autres`}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* L'instantané est daté, et il ne se met pas à jour tout
                    seul : le script s'exécute à l'ouverture de session ou
                    par tâche planifiée. Écrire « programmes en cours »
                    sans dire de QUAND laisserait croire à du temps réel. */}
                <p className="text-[11px] text-[var(--color-mute)] mt-3">
                  Instantané du dernier envoi, pas une vue en temps réel.
                </p>
              </>
            )}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement de l'historique…</p>
        ) : donnees.length === 0 ? (
          // Cet écran vide a fait chercher une panne pendant des heures.
          // La cause est presque toujours l'absence de SNMP sur la
          // machine — ce n'est pas un défaut de la plateforme, et le dire
          // évite d'aller creuser ailleurs.
          /* `expose_snmp` remplace `sys_descr`, dont seule l'EXISTENCE
             importait ici. La liste transportait un texte de plusieurs
             centaines de caractères par équipement pour un simple oui/non.

             MySQL renvoie 1 ou 0 pour un booléen, jamais true/false :
             `Boolean()` évite qu'un 0 soit lu comme vrai le jour où la
             condition serait écrite autrement. */
          /* DEUX CAUSES POSSIBLES, ET IL FAUT LES SÉPARER.
             Ce message accusait toujours SNMP. C'est vrai la plupart du
             temps, et faux précisément quand ça coûte cher : si le cycle
             de supervision est arrêté, AUCUN équipement n'a de relevé —
             y compris ceux qui exposent parfaitement SNMP. On envoyait
             alors chercher un problème d'équipement là où toute la
             plateforme était à l'arrêt. Le serveur tranche désormais. */
          supervision && supervision.active === false ? (
            <EtatVide
              titre="La supervision ne tourne pas"
              ton="etape"
              explication={
                supervision.dernier_releve_parc
                  ? `Aucun relevé sur l'ensemble du parc depuis le ${new Date(
                      supervision.dernier_releve_parc
                    ).toLocaleString("fr-FR")}. Ce n'est pas propre à cet équipement.`
                  : "Aucun relevé n'a jamais été enregistré sur ce parc. Ce n'est pas propre à cet équipement."
              }
              aide="Vérifiez le message affiché au démarrage du serveur : un site marqué « pris en charge par un agent » est exclu du cycle central."
            />
          ) : (
            <EtatVide
              titre="Aucun relevé sur les dernières 24 heures"
              ton={Boolean(equipement.expose_snmp) ? "neutre" : "etape"}
              explication={
                equipement.expose_snmp
                  ? "Cet équipement répond en SNMP mais n'a pas encore été mesuré. Les relevés arrivent au prochain cycle de supervision, dans une minute."
                  : "Cet équipement n'expose pas SNMP. Processeur, mémoire et débit ne peuvent donc pas être lus — un poste Windows ne l'active pas par défaut."
              }
              aide={
                equipement.expose_snmp
                  ? undefined
                  : "Sa disponibilité reste surveillée par ping : seules les mesures de charge manquent."
              }
            />
          )
        ) : (
          <div className="space-y-6">
            <div>
              <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
                Latence (ms)
              </h3>
              <div ref={conteneurGraphique} className="w-full" style={{ minHeight: 180 }}>
                {largeurGraphique > 0 && (
                  <LineChart data={donnees} width={largeurGraphique} height={180}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                    <XAxis dataKey="heure" stroke="var(--color-mute)" fontSize={11} />
                    <YAxis stroke="var(--color-mute)" fontSize={11} />
                    <Tooltip contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)" }} />
                    <Line type="monotone" dataKey="latence" stroke="var(--color-signal)" dot={donnees.length <= 8} strokeWidth={2} isAnimationActive={false} />
                  </LineChart>
                )}
              </div>
            </div>

            {aDesMetriques && (
              <div>
                <h3 className="text-xs uppercase tracking-wide text-[var(--color-mute)] mb-2">
                  CPU / RAM (%)
                </h3>
                <div className="w-full" style={{ minHeight: 180 }}>
                  {largeurGraphique > 0 && (
                    <LineChart data={donnees} width={largeurGraphique} height={180}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
                      <XAxis dataKey="heure" stroke="var(--color-mute)" fontSize={11} />
                      <YAxis stroke="var(--color-mute)" fontSize={11} domain={[0, 100]} />
                      <Tooltip contentStyle={{ background: "var(--color-surface-2)", border: "1px solid var(--color-line)" }} />
                      <Line type="monotone" dataKey="cpu" name="CPU" stroke="var(--color-warn)" dot={donnees.length <= 8} strokeWidth={2} isAnimationActive={false} />
                      <Line type="monotone" dataKey="ram" name="RAM" stroke="var(--color-ok)" dot={donnees.length <= 8} strokeWidth={2} isAnimationActive={false} />
                    </LineChart>
                  )}
                </div>
              </div>
            )}

            {/* CE MESSAGE NE DOIT PAS INVENTER DE CAUSE.

                Il affirmait « cet équipement n'expose pas SNMP
                HOST-RESOURCES-MIB ». C'est faux au moins une fois sur ce
                parc : une imprimante Canon expose parfaitement cette
                table — quatre lignes, tailles renseignées — mais laisse
                TOUS ses compteurs d'occupation à zéro. Nous refusons donc
                ses valeurs, ce qui est le bon choix ; mais le motif
                annoncé, lui, était inexact.

                Un opérateur qui lit « n'expose pas SNMP » ira vérifier la
                configuration SNMP de l'appareil et n'y trouvera rien à
                corriger. Une phrase qui envoie chercher au mauvais
                endroit coûte plus cher qu'une phrase vague. */}
            {!aDesMetriques && (
              <p className="text-xs text-[var(--color-mute)]">
                Aucune donnée processeur ni mémoire pour cet équipement. Soit
                il ne publie pas ces mesures, soit il les déclare sans les
                renseigner — dans les deux cas, aucune valeur fiable n'existe.
                Le reste de la supervision n'est pas affecté.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}