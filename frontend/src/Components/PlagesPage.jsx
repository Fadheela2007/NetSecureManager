import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const VERSIONS_SNMP = ["v1", "v2c", "v3"];

/**
 * Gestion des plages réseau à scanner, par site.
 *
 * Les paramètres SNMP enregistrés ici sont repris automatiquement par
 * POST /api/scan quand le CIDR correspond à une plage active — c'est ce qui
 * rend SNMPv3 utilisable, ses identifiants ne pouvant pas être saisis depuis
 * le formulaire de scan du tableau de bord.
 *
 * Sécurité : GET /api/plages ne renvoie jamais snmp_v3_auth_key ni
 * snmp_v3_priv_key. Cette page ne doit donc ni les afficher, ni les
 * pré-remplir. Pour changer une clé, on supprime la plage et on la recrée.
 */
export default function PlagesPage({ idSite }) {
  const [plages, setPlages] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);
  const [message, setMessage] = useState(null);
  const [enCours, setEnCours] = useState(null); // id_plage en cours de scan
  const [envoi, setEnvoi] = useState(false);

  // Le rôle sert uniquement à masquer un bouton : la vraie protection est
  // côté backend (requireRole("admin") sur DELETE /api/plages/:id).
  const [role, setRole] = useState(null);

  const [cidr, setCidr] = useState("");
  const [version, setVersion] = useState("v2c");
  const [communaute, setCommunaute] = useState("public");
  const [v3Username, setV3Username] = useState("");
  const [v3AuthKey, setV3AuthKey] = useState("");
  const [v3PrivKey, setV3PrivKey] = useState("");

  useEffect(() => {
    try {
      const brut = localStorage.getItem("utilisateur");
      if (brut) setRole(JSON.parse(brut).role);
    } catch {
      setRole(null);
    }
  }, []);

  async function charger() {
    setChargement(true);
    try {
      const { data } = await axios.get(`${API_URL}/plages`, { params: { id_site: idSite } });
      setPlages(data);
      setErreur(null);
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible de charger les plages réseau");
    } finally {
      setChargement(false);
    }
  }

  useEffect(() => {
    if (idSite) charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  function reinitialiserFormulaire() {
    setCidr("");
    setVersion("v2c");
    setCommunaute("public");
    setV3Username("");
    setV3AuthKey("");
    setV3PrivKey("");
  }

  async function ajouter(e) {
    e.preventDefault();
    setErreur(null);
    setMessage(null);

    if (version === "v3" && (!v3Username.trim() || !v3AuthKey)) {
      setErreur("En SNMPv3, le nom d'utilisateur et la clé d'authentification sont obligatoires.");
      return;
    }

    const corps = {
      id_site: idSite,
      cidr: cidr.trim(),
      snmp_version: version,
    };

    if (version === "v3") {
      corps.snmp_v3_username = v3Username.trim();
      corps.snmp_v3_auth_key = v3AuthKey;
      if (v3PrivKey) corps.snmp_v3_priv_key = v3PrivKey;
    } else {
      corps.snmp_community = communaute.trim() || "public";
    }

    setEnvoi(true);
    try {
      await axios.post(`${API_URL}/plages`, corps);
      setMessage("Plage enregistrée.");
      reinitialiserFormulaire();
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible d'enregistrer cette plage");
    } finally {
      setEnvoi(false);
    }
  }

  async function supprimer(plage) {
    if (!window.confirm(`Supprimer la plage ${plage.cidr} ? Les identifiants SNMP associés seront perdus.`)) {
      return;
    }
    setErreur(null);
    setMessage(null);
    try {
      await axios.delete(`${API_URL}/plages/${plage.id_plage}`);
      setMessage(`Plage ${plage.cidr} supprimée.`);
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible de supprimer cette plage");
    }
  }

  async function scanner(plage) {
    setErreur(null);
    setMessage(null);
    setEnCours(plage.id_plage);
    try {
      // Le backend retrouve seul les paramètres SNMP de la plage à partir du
      // couple (id_site, cidr) : rien d'autre à transmettre.
      const { data } = await axios.post(`${API_URL}/scan`, {
        id_site: idSite,
        cidr: plage.cidr,
      });
      setMessage(`${data.nb_equipements} équipement(s) découvert(s) sur ${plage.cidr}.`);
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || `Échec du scan de ${plage.cidr}`);
    } finally {
      setEnCours(null);
    }
  }

  const champClasse =
    "bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition";
  const labelClasse = "block text-[11px] text-[var(--color-mute)] mb-1.5";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Plages réseau</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Plages à scanner pour ce site, avec leurs paramètres SNMP
        </p>
      </div>

      <form
        onSubmit={ajouter}
        className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className={labelClasse}>Plage (CIDR)</label>
          <input
            value={cidr}
            onChange={(e) => setCidr(e.target.value)}
            placeholder="192.168.1.0/24"
            required
            className={`${champClasse} font-[var(--font-mono)]`}
          />
        </div>

        <div>
          <label className={labelClasse}>Version SNMP</label>
          <select
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            className={champClasse}
          >
            {VERSIONS_SNMP.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>

        {version === "v3" ? (
          <>
            <div>
              <label className={labelClasse}>Nom d'utilisateur</label>
              <input
                value={v3Username}
                onChange={(e) => setV3Username(e.target.value)}
                className={champClasse}
              />
            </div>
            <div>
              <label className={labelClasse}>Clé d'authentification</label>
              <input
                type="password"
                value={v3AuthKey}
                onChange={(e) => setV3AuthKey(e.target.value)}
                autoComplete="new-password"
                className={champClasse}
              />
            </div>
            <div>
              <label className={labelClasse}>Clé de chiffrement (optionnelle)</label>
              <input
                type="password"
                value={v3PrivKey}
                onChange={(e) => setV3PrivKey(e.target.value)}
                autoComplete="new-password"
                className={champClasse}
              />
            </div>
          </>
        ) : (
          <div>
            <label className={labelClasse}>Communauté SNMP</label>
            <input
              value={communaute}
              onChange={(e) => setCommunaute(e.target.value)}
              placeholder="public"
              className={champClasse}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={envoi}
          className="bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 transition disabled:opacity-50"
        >
          {envoi ? "Enregistrement…" : "Ajouter la plage"}
        </button>
      </form>

      {version === "v3" && (
        <p className="text-xs text-[var(--color-mute)]">
          Les clés SNMPv3 ne sont jamais renvoyées par l'API une fois enregistrées. Pour en changer,
          supprimez la plage et recréez-la.
        </p>
      )}

      {erreur && <p className="text-sm text-[var(--color-crit)]">{erreur}</p>}
      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        {chargement ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement des plages…</p>
        ) : plages.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">
            Aucune plage enregistrée pour ce site — ajoutez-en une ci-dessus.
          </p>
        ) : (
          <div className="table-scroll"><table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                <th className="pb-2 font-medium">CIDR</th>
                <th className="pb-2 font-medium">Communauté SNMP</th>
                <th className="pb-2 font-medium">Version</th>
                <th className="pb-2 font-medium">Dernier scan</th>
                <th className="pb-2 font-medium">Statut</th>
                <th className="pb-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {plages.map((p) => (
                <tr key={p.id_plage}>
                  <td className="py-2.5 font-[var(--font-mono)] text-[13px]">{p.cidr}</td>
                  <td className="py-2.5 text-[var(--color-mute)]">
                    {p.snmp_version === "v3" ? (
                      <span className="text-[var(--color-mute)]">
                        v3 — {p.snmp_v3_username || "utilisateur non défini"}
                      </span>
                    ) : p.snmp_community_masquee ? (
                      // Masquée pour les rôles lecteur et opérateur : la
                      // communauté SNMP est un mot de passe de lecture sur
                      // tout le parc. Le dire, plutôt que d'afficher des
                      // points sans explication — sinon on croit à un bug.
                      <span
                        className="text-[var(--color-mute)]"
                        title="La communauté SNMP donne accès en lecture à tout le parc. Elle n'est visible que par un administrateur."
                      >
                        {p.snmp_community} <span className="text-xs">(réservée aux administrateurs)</span>
                      </span>
                    ) : (
                      p.snmp_community || "public"
                    )}
                  </td>
                  <td className="py-2.5 text-[var(--color-mute)]">{p.snmp_version || "v2c"}</td>
                  <td className="py-2.5 text-[var(--color-mute)] text-xs">
                    {p.dernier_scan ? new Date(p.dernier_scan).toLocaleString("fr-FR") : "—"}
                  </td>
                  <td className="py-2.5">
                    <span
                      className={
                        p.actif
                          ? "text-[var(--color-ok)] text-xs"
                          : "text-[var(--color-mute)] text-xs"
                      }
                    >
                      {p.actif ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="py-2.5">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => scanner(p)}
                        disabled={enCours !== null}
                        className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50"
                      >
                        {enCours === p.id_plage ? "Scan en cours…" : "Scanner"}
                      </button>
                      {role === "admin" && (
                        <button
                          onClick={() => supprimer(p)}
                          disabled={enCours !== null}
                          className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-crit)] hover:text-[var(--color-crit)] transition disabled:opacity-50"
                        >
                          Supprimer
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
