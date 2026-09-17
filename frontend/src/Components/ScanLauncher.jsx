import React, { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Déclenche un scan réseau sur un site.
 *
 * DEUX ACTIONS, ET LA DIFFÉRENCE COMPTE
 *
 *   « Scanner tout le site » parcourt TOUTES les plages déclarées et
 *   actives. C'est l'action normale : une entreprise sépare ses réseaux
 *   (bureautique, imprimantes, serveurs, wifi), et n'en scanner qu'un
 *   produit un inventaire d'apparence complète avec un trou dedans.
 *
 *   « Scanner une plage » ne prend qu'un CIDR. Utile pour vérifier un
 *   réseau précis ou en essayer un avant de le déclarer, mais ce n'est
 *   pas ainsi qu'on inventorie un parc.
 *
 * Le résultat du scan de site affiche le détail PLAGE PAR PLAGE, et
 * signale en clair celles qui n'ont pas pu être examinées. Une plage en
 * échec et une plage vide donnent toutes deux zéro équipement : sans
 * cette distinction, on ne peut pas savoir si le réseau est vide ou si on
 * ne l'a pas regardé.
 */
export default function ScanLauncher({ idSite }) {
  const [cidr, setCidr] = useState("");
  const [snmpCommunity, setSnmpCommunity] = useState("public");
  const [loading, setLoading] = useState(null); // "site" | "plage" | null
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [reseaux, setReseaux] = useState(null);
  const [detection, setDetection] = useState(false);
  const [plagesDeclarees, setPlagesDeclarees] = useState([]);

  /* ── UN SCAN LONG DOIT DIRE QU'IL TRAVAILLE ──

     Le bouton affichait « Scan en cours... » et rien d'autre. Sur une
     plage /23 avec trois machines analysées à la fois, l'attente dépasse
     dix minutes — pendant lesquelles rien à l'écran ne distingue un scan
     qui avance d'un serveur planté. La première réaction est de recharger
     la page, ce qui abandonne le scan sans l'arrêter côté serveur.

     Le compteur ne mesure pas la progression réelle (il faudrait la faire
     remonter du serveur) mais il prouve que le temps passe et rappelle
     l'ordre de grandeur attendu. C'est ce qui manque pour tenir dix
     minutes sans douter. */
  const [secondes, setSecondes] = useState(0);

  /* ── ET MAINTENANT, L'AVANCEMENT RÉEL ──

     Le compteur de secondes ci-dessus prouve que le temps passe. Il ne
     dit pas OÙ ON EN EST, et c'est ce qui manquait : devant « 4 min 12 »,
     personne ne sait s'il reste dix secondes ou dix minutes.

     Le serveur tient désormais ce compte — nombre de machines analysées
     sur nombre de machines vivantes, plage courante sur nombre de plages
     — et l'expose par GET /scan/progression. On l'interroge pendant le
     scan seulement.

     RIEN N'EST INVENTÉ ICI. Si le serveur ne répond pas (version plus
     ancienne, route absente), la valeur reste nulle et l'écran retombe
     exactement sur ce qu'il affichait avant : le compteur de secondes.
     Une barre qui avancerait toute seule pour faire patienter serait
     pire que pas de barre — elle ferait attendre au lieu de faire
     chercher. */
  const [progression, setProgression] = useState(null);

  /* ── LE CHAMP EST PRÉ-REMPLI AVEC LA VRAIE PLAGE DU SITE ──

     Il ne portait qu'un exemple grisé, « 192.168.1.0/24 ». Recopié tel
     quel — le réflexe naturel devant un champ vide qui montre un
     modèle — il fait scanner un réseau qui n'existe pas chez le client.

     Le scan ne se plaint pas : il balaie consciencieusement 254 adresses
     muettes et rend une liste incohérente. L'utilisateur en conclut que
     le scan « fait n'importe quoi », alors qu'il a fait exactement ce
     qu'on lui a demandé. Constaté en conditions réelles sur un parc en
     192.168.0.0/23, où l'exemple désigne la seconde moitié du réseau.

     La plage déclarée du site est la bonne réponse dans la quasi-
     totalité des cas : c'est elle que « Scanner tout le site » utilise,
     et c'est bien ce bouton-là qui donnait de bons résultats. */
  useEffect(() => {
    if (!idSite) return;
    axios
      .get(`${API_URL}/plages`, { params: { id_site: idSite } })
      .then(({ data }) => {
        const actives = (data || []).filter((p) => p.actif);
        setPlagesDeclarees(actives);
        // On ne remplace jamais une saisie en cours : l'exploitant qui a
        // commencé à taper a une raison de le faire.
        setCidr((actuel) => actuel || (actives[0] ? actives[0].cidr : ""));
      })
      .catch(() => setPlagesDeclarees([]));
  }, [idSite]);

  useEffect(() => {
    if (loading === null) {
      setSecondes(0);
      return;
    }
    const debut = Date.now();
    const minuteur = setInterval(
      () => setSecondes(Math.floor((Date.now() - debut) / 1000)),
      1000
    );
    return () => clearInterval(minuteur);
  }, [loading]);

  /* Interrogation toutes les deux secondes, et seulement pendant le scan.
     Deux secondes : assez court pour que la barre vive, assez long pour
     que trente machines analysées à la minute se voient passer une à une.
     L'appel ne coûte au serveur qu'une lecture en mémoire. */
  useEffect(() => {
    if (loading === null || !idSite) {
      setProgression(null);
      return;
    }
    let annule = false;

    const lire = () =>
      axios
        .get(`${API_URL}/scan/progression`, { params: { id_site: idSite } })
        .then(({ data }) => {
          if (!annule) setProgression(data?.connu ? data : null);
        })
        // Silencieux : l'avancement est un confort. Une erreur ici ne doit
        // ni s'afficher ni interrompre le scan, qui tourne côté serveur.
        .catch(() => {
          if (!annule) setProgression(null);
        });

    lire();
    const minuteur = setInterval(lire, 2000);
    return () => {
      annule = true;
      clearInterval(minuteur);
    };
  }, [loading, idSite]);

  const duree = (s) =>
    s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;

  /**
   * Ce que fait le serveur en ce moment, en une phrase.
   *
   * Chaque étape dit son propre décompte plutôt qu'un « traitement en
   * cours » générique : « 23 machines sur 73 » se vérifie, et donne une
   * idée du temps restant qu'aucun pourcentage seul ne donne.
   */
  const phrasePhase = (p) => {
    if (!p) return null;
    if (p.etape === "balayage") {
      return p.total > 0
        ? `Balayage du réseau — ${p.total} adresses à interroger`
        : "Balayage du réseau";
    }
    if (p.etape === "identification") {
      return `Analyse des machines trouvées — ${p.courant} sur ${p.total}`;
    }
    if (p.etape === "enregistrement") {
      return `Enregistrement — ${p.total} équipement(s)`;
    }
    if (p.etape === "termine") return "Terminé";
    return "Préparation…";
  };

  /**
   * Propose les plages déduites des interfaces du serveur.
   *
   * On PROPOSE, on ne remplit pas d'office : une machine porte souvent
   * plusieurs réseaux — Hyper-V, WSL, VMware — dont un seul est le vrai.
   * Choisir à la place de l'exploitant reviendrait à scanner une plage
   * devinée, et scanner n'est jamais un acte neutre.
   */
  async function detecter() {
    setDetection(true);
    setError(null);
    try {
      const { data } = await axios.get(`${API_URL}/reseaux-detectes`);
      setReseaux(data.reseaux || []);
    } catch (err) {
      setError(err.response?.data?.error || "Détection impossible");
    } finally {
      setDetection(false);
    }
  }

  async function appeler(chemin, corps, quoi) {
    setLoading(quoi);
    setError(null);
    setResult(null);
    try {
      const { data } = await axios.post(`${API_URL}${chemin}`, corps);
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || "Erreur lors du scan");
    } finally {
      setLoading(null);
    }
  }

  const scannerLeSite = () =>
    appeler("/scan/site", { id_site: idSite, snmp_community: snmpCommunity }, "site");

  const scannerUnePlage = (e) => {
    e.preventDefault();
    appeler("/scan", { id_site: idSite, cidr, snmp_community: snmpCommunity }, "plage");
  };

  return (
    <div className="scan-launcher">
      <h2>Lancer un scan réseau</h2>

      <button type="button" onClick={scannerLeSite} disabled={loading !== null}>
        {loading === "site" ? "Scan du site en cours..." : "Scanner tout le site"}
      </button>
      <p className="aide">
        Parcourt toutes les plages déclarées et actives de ce site, l'une après
        l'autre.
      </p>

      <form onSubmit={scannerUnePlage}>
        <label>
          <span className="champ-ligne">
            Scanner une seule plage (CIDR)
            <button
              type="button"
              onClick={detecter}
              disabled={detection || loading !== null}
              className="lien-detecter"
            >
              {detection ? "détection…" : "détecter mon réseau"}
            </button>
          </span>
          <input
            type="text"
            /* Le repère de saisie décrit la FORME attendue au lieu de
               montrer une adresse plausible qu'on recopie sans y penser. */
            placeholder="adresse/masque, ex. 10.0.0.0/24"
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            required
          />
          {plagesDeclarees.length > 1 && (
            <span className="aide">
              Plages déclarées pour ce site :{" "}
              {plagesDeclarees.map((p, i) => (
                <React.Fragment key={p.cidr}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => setCidr(p.cidr)}
                    className="lien-detecter"
                  >
                    {p.cidr}
                  </button>
                </React.Fragment>
              ))}
            </span>
          )}
          {plagesDeclarees.length === 0 && (
            <span className="aide">
              Aucune plage n'est déclarée pour ce site. Déclarez-la dans
              « Plages réseau » : le scan de site s'en servira, et ce champ
              se remplira tout seul.
            </span>
          )}
        </label>
        <label>
          Communauté SNMP
          <input
            type="text"
            value={snmpCommunity}
            onChange={(e) => setSnmpCommunity(e.target.value)}
          />
        </label>
        <button type="submit" disabled={loading !== null}>
          {loading === "plage" ? "Scan en cours..." : "Scanner cette plage"}
        </button>
      </form>

      {/* ══ LA BARRE D'AVANCEMENT ══
          Affichée seulement quand le serveur a répondu. Le pourcentage
          est calculé sur des comptes réels : machines analysées sur
          machines vivantes, pondéré par les plages restantes. Il n'avance
          donc pas pendant qu'il ne se passe rien — et c'est voulu : une
          barre bloquée est une information, elle dit d'aller regarder. */}
      {loading !== null && progression && (
        <div style={{ marginTop: "0.75rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: "0.75rem",
              marginBottom: "0.35rem",
            }}
          >
            <span style={{ fontSize: "0.85rem" }}>{phrasePhase(progression)}</span>
            <strong style={{ fontSize: "0.95rem", fontVariantNumeric: "tabular-nums" }}>
              {progression.pourcentage} %
            </strong>
          </div>

          <div
            role="progressbar"
            aria-valuenow={progression.pourcentage}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              height: "8px",
              borderRadius: "999px",
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-line)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progression.pourcentage}%`,
                height: "100%",
                background: "var(--color-signal)",
                /* La transition lisse le saut entre deux interrogations :
                   sans elle, la barre avance par à-coups de deux secondes
                   et donne l'impression d'un écran qui rame. */
                transition: "width 0.5s ease-out",
              }}
            />
          </div>

          {/* La plage en cours n'est dite que s'il y en a plusieurs : sur
              un scan de plage unique, « plage 1 sur 1 » n'apprend rien. */}
          {progression.plages_total > 1 && (
            <p className="aide" style={{ marginTop: "0.35rem" }}>
              Plage {progression.plage} sur {progression.plages_total}
              {progression.cidr && ` — ${progression.cidr}`}
            </p>
          )}
        </div>
      )}

      {loading !== null && (
        <p className="aide">
          Scan en cours depuis <strong>{duree(secondes)}</strong>. Ne rechargez
          pas la page : le scan continuerait côté serveur sans vous rendre son
          résultat.
          <span style={{ display: "block", marginTop: "0.25rem" }}>
            Une plage /24 demande quelques minutes, un /23 le double. La durée
            dépend surtout du nombre de machines analysées en parallèle
            (réglage <span className="font-[var(--font-mono)]">SCAN_CONCURRENCE</span>).
          </span>
        </p>
      )}

      {/* Réseaux détectés : une ligne par plage, à cliquer pour remplir le
          champ. Les adaptateurs d'hyperviseur sont montrés mais signalés —
          les cacher priverait des essais sur une machine virtuelle, les
          mélanger aux vrais ferait douter de toute la suggestion. */}
      {reseaux && (
        <div className="reseaux-detectes">
          {reseaux.length === 0 ? (
            <p className="aide">
              Aucune plage exploitable détectée sur les interfaces de ce serveur.
            </p>
          ) : (
            <>
              <p className="aide">
                Déduit des cartes réseau du serveur. Cliquez pour remplir le champ.
              </p>
              <ul className="detail-plages">
                {reseaux.map((r) => (
                  <li key={r.cidr}>
                    <button type="button" onClick={() => setCidr(r.cidr)}>
                      <strong>{r.cidr}</strong>
                    </button>{" "}
                    <span className="aide">
                      {r.interface} · {r.nb_adresses} adresses
                      {r.virtuelle && " · réseau virtuel"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {result && !result.plages && (
        <>
          <p className="success">
            {result.nb_equipements} équipement(s) découvert(s) et ajouté(s)
            automatiquement.
          </p>

          {/* CE QUE LE SCAN A ÉCARTÉ, DIT AUSSI CLAIREMENT QUE CE QU'IL A
              TROUVÉ.

              Une adresse qui ne répond à rien n'est pas un équipement : elle
              n'entre pas à l'inventaire, et celles qu'y avaient laissées les
              anciens scans en sortent. Sans cette ligne, l'inventaire
              rétrécirait sans explication — et un chiffre qui baisse sans
              raison est ce qui fait douter de tout le reste. */}
          {(result.ignores_sans_preuve > 0 || result.adresses_retirees > 0) && (
            <p className="aide">
              {result.ignores_sans_preuve > 0 && (
                <>
                  {result.ignores_sans_preuve} adresse(s) sondée(s) sans réponse :
                  ni ping, ni port TCP, ni SNMP, ni empreinte nmap. Elles ne sont
                  pas inscrites à l'inventaire.{" "}
                </>
              )}
              {result.adresses_retirees > 0 && (
                <>
                  {result.adresses_retirees} adresse(s) laissée(s) par un scan
                  précédent ont été retirées pour la même raison.
                </>
              )}
            </p>
          )}
        </>
      )}

      {result && result.plages && (
        <div className="resultat-scan-site">
          {/* Le verdict d'abord, et il dit la vérité même partielle : c'est
              ce chiffre que le client lira pour juger son inventaire. */}
          <p className={result.complet ? "success" : "error"}>
            {result.nb_equipements} équipement(s) sur{" "}
            {result.nb_plages_examinees}/{result.nb_plages} plage(s) examinée(s).
            {result.nb_plages_hors_portee > 0 &&
              ` ${result.nb_plages_hors_portee} hors de portée.`}
            {!result.complet && " Inventaire INCOMPLET."}
          </p>

          <ul className="detail-plages">
            {result.plages.map((p) => (
              <li
                key={p.cidr}
                className={p.examinee && p.joignable !== false ? "" : "echec"}
              >
                <strong>{p.cidr}</strong>{" "}
                {!p.examinee ? (
                  <>— NON EXAMINÉE : {p.erreur}</>
                ) : p.joignable === false ? (
                  // Une plage vide et une plage inatteignable rendent toutes
                  // deux zéro équipement. C'est la distinction qui empêche de
                  // croire un inventaire complet alors qu'un réseau entier
                  // n'a pas été vu.
                  <>— HORS DE PORTÉE : {p.diagnostic}</>
                ) : (
                  <>
                    — {p.nb_equipements} équipement(s)
                    {p.nb_equipements === 0 && p.diagnostic && (
                      <span className="aide"> ({p.diagnostic})</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          {result.conflits_ip > 0 && (
            <p className="error">
              {result.conflits_ip} conflit(s) d'adresse détecté(s) sur ce site.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
