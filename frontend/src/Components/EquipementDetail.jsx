import { useEffect, useRef, useState } from "react";
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

export default function EquipementDetail({ equipement, onClose, onRenomme }) {
  const [releves, setReleves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reveilEnCours, setReveilEnCours] = useState(false);
  const [reveilMessage, setReveilMessage] = useState(null);
  const [vulnerabilites, setVulnerabilites] = useState([]);
  const [vulnErreur, setVulnErreur] = useState(false);
  const [interfaces, setInterfaces] = useState([]);
  const [services, setServices] = useState([]);
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
  const conteneurGraphique = useRef(null);
  const [largeurGraphique, setLargeurGraphique] = useState(0);

  useEffect(() => {
    function mesurer() {
      const el = conteneurGraphique.current;
      if (!el) return;
      const l = el.getBoundingClientRect().width;
      if (l > 0) setLargeurGraphique(Math.round(l));
    }
    mesurer();
    const differee = setTimeout(mesurer, 60);
    window.addEventListener("resize", mesurer);
    return () => {
      clearTimeout(differee);
      window.removeEventListener("resize", mesurer);
    };
  }, [loading]);

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

  useEffect(() => {
    setLoading(true);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/releves`, { params: { heures: 24 } })
      .then(({ data }) => setReleves(data))
      .catch(() => setReleves([]))
      .finally(() => setLoading(false));
  }, [equipement.id_equipement]);

  // Vulnérabilités connues.
  //
  // L'échec était muet, et la section disparaissait simplement. Sur un
  // produit de sécurité, « aucune vulnérabilité affichée » se lit comme
  // « aucune vulnérabilité » — alors que la vérification n'avait pas eu
  // lieu. Silence et absence de risque ne sont pas la même chose, et
  // c'est le genre de confusion qui se paie devant un client.
  useEffect(() => {
    setVulnErreur(false);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/vulnerabilites`)
      .then(({ data }) => setVulnerabilites(data))
      .catch(() => {
        setVulnerabilites([]);
        setVulnErreur(true);
      });
  }, [equipement.id_equipement]);

  useEffect(() => {
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/interfaces`)
      .then(({ data }) => setInterfaces(data))
      .catch(() => setInterfaces([]));
  }, [equipement.id_equipement]);

  // Ports ouverts. La route existait déjà côté serveur mais n'était
  // appelée par personne : les services détectés n'apparaissaient donc
  // sur aucun écran. C'est pourtant l'information la plus parlante d'une
  // fiche sur un produit de supervision — un port 23 ou 3389 ouvert se
  // commente tout seul devant un client.
  useEffect(() => {
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/services`)
      .then(({ data }) => setServices(data))
      .catch(() => setServices([]));
  }, [equipement.id_equipement]);

  useEffect(() => {
    setDispo(null);
    axios.get(`${API_URL}/equipements/${equipement.id_equipement}/disponibilite`, {
      params: { jours: periodeDispo },
    })
      .then(({ data }) => setDispo(data))
      .catch(() => setDispo(null));
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

        {vulnerabilites.length > 0 && (
          <div className="mb-5 bg-[var(--color-crit)]/5 border border-[var(--color-crit)]/30 rounded-lg p-4">
            <h3 className="text-xs uppercase tracking-wide text-[var(--color-crit)] mb-2 font-medium">
              ⚠ Vulnérabilités potentielles détectées ({vulnerabilites.length})
            </h3>
            <ul className="space-y-2">
              {vulnerabilites.map((v) => (
                <li key={v.id_vuln} className="text-xs">
                  <span className="font-[var(--font-mono)] text-[var(--color-crit)]">{v.cve_id}</span>
                  {" — "}
                  <span className="text-[var(--color-ink)]">{v.service} (port {v.port})</span>
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
                Taux de disponibilité
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
                  color: !dispo.fiable
                    ? "var(--color-mute)"
                    : dispo.taux_disponibilite >= 99
                    ? "var(--color-ok)"
                    : dispo.taux_disponibilite >= 95
                    ? "var(--color-warn)"
                    : "var(--color-crit)",
                }}
              >
                {dispo.taux_indicatif !== null ? `${dispo.taux_indicatif.toFixed(2)} %` : "—"}
              </span>
              {!dispo.fiable && (
                <span className="text-xs text-[var(--color-warn)]">indicatif</span>
              )}
              <span className="text-xs text-[var(--color-mute)]">
                {dispo.nb_pannes} panne(s) — {dispo.minutes_indisponible} min d'indisponibilité sur{" "}
                {Math.round(dispo.heures_observables)} h observées
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
                    <Line type="monotone" dataKey="latence" stroke="var(--color-signal)" dot={false} strokeWidth={2} isAnimationActive={false} />
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
                      <Line type="monotone" dataKey="cpu" name="CPU" stroke="var(--color-warn)" dot={false} strokeWidth={2} isAnimationActive={false} />
                      <Line type="monotone" dataKey="ram" name="RAM" stroke="var(--color-ok)" dot={false} strokeWidth={2} isAnimationActive={false} />
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