import React, { useState } from "react";
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
          Scanner une seule plage (CIDR)
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
            {!result.complet && " Inventaire INCOMPLET."}
          </p>

          <ul className="detail-plages">
            {result.plages.map((p) => (
              <li key={p.cidr} className={p.examinee ? "" : "echec"}>
                <strong>{p.cidr}</strong>{" "}
                {p.examinee ? (
                  <>— {p.nb_equipements} équipement(s)</>
                ) : (
                  <>— NON EXAMINÉE : {p.erreur}</>
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
