import React, { useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Composant permettant de déclencher un scan réseau sur un site donné.
 * L'utilisateur saisit uniquement le CIDR (ex: 192.168.1.0/24) — aucune
 * configuration manuelle des équipements n'est requise, tout est découvert
 * automatiquement côté backend.
 */
export default function ScanLauncher({ idSite }) {
  const [cidr, setCidr] = useState("");
  const [snmpCommunity, setSnmpCommunity] = useState("public");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function lancerScan(e) {
  e.preventDefault();
  setLoading(true);
  setError(null);
  setResult(null);
  try {
    const { data } = await axios.post(`${API_URL}/scan`, {
      id_site: idSite,
      cidr,
      snmp_community: snmpCommunity,
    });
    setResult(data);
  } catch (err) {
    setError(err.response?.data?.error || "Erreur lors du scan");
  } finally {
    setLoading(false);
  }
}

  return (
    <div className="scan-launcher">
      <h2>Lancer un scan réseau</h2>
      <form onSubmit={lancerScan}>
        <label>
          Plage réseau (CIDR)
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
        <button type="submit" disabled={loading}>
          {loading ? "Scan en cours..." : "Scanner le réseau"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {result && (
        <p className="success">
          {result.nb_equipements} équipement(s) découvert(s) et ajouté(s) automatiquement.
        </p>
      )}
    </div>
  );
}
