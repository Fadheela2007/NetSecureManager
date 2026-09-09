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

  const duree = (s) =>
    s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;

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
            placeholder="192.168.1.0/24"
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            required
          />
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
        <p className="success">
          {result.nb_equipements} équipement(s) découvert(s) et ajouté(s)
          automatiquement.
        </p>
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
