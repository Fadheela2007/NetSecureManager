import { useEffect, useState } from "react";
import axios from "axios";
import MiseEnServiceAgent from "./MiseEnServiceAgent";

import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

export default function SitesPage() {
  const [sites, setSites] = useState([]);
  const [nom, setNom] = useState("");
  const [ville, setVille] = useState("");
  const [erreur, setErreur] = useState(null);
  const [miseEnService, setMiseEnService] = useState(null);
  // Échec de LECTURE, distinct de `erreur` qui porte les échecs de
  // création. Sans lui, un serveur injoignable affichait « aucun site »,
  // et l'utilisateur en créait un second alors que le premier existait.
  const [erreurChargement, setErreurChargement] = useState(null);

  async function charger() {
    const { data } = await axios.get(`${API_URL}/sites`);
    setSites(data);
  }

  function rafraichir() {
    setErreurChargement(null);
    charger().catch((err) => setErreurChargement(decrireErreur(err, "Les sites")));
  }

  useEffect(() => { rafraichir(); }, []);

  async function ajouter(e) {
    e.preventDefault();
    setErreur(null);
    try {
      const { data } = await axios.post(`${API_URL}/sites`, { nom, ville });
      setMiseEnService(data.id_site);
      setNom(""); setVille("");
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible de créer le site");
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Sites</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">Agences supervisées</p>
      </div>

      {erreurChargement && (
        <div className="bg-[var(--color-surface)] border rounded-xl p-4"
             style={{ borderColor: "var(--color-crit)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--color-crit)" }}>
            {erreurChargement.titre}
          </p>
          <p className="text-sm text-[var(--color-mute)] mt-1">{erreurChargement.detail}</p>
          <button
            onClick={rafraichir}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
          >
            Réessayer
          </button>
        </div>
      )}

      <form onSubmit={ajouter} className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[11px] text-[var(--color-mute)] mb-1.5">Nom du site</label>
          <input value={nom} onChange={(e) => setNom(e.target.value)} required
            className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition" />
        </div>
        <div>
          <label className="block text-[11px] text-[var(--color-mute)] mb-1.5">Ville</label>
          <input value={ville} onChange={(e) => setVille(e.target.value)} required
            className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition" />
        </div>
        <button type="submit" className="bg-[var(--color-signal)] text-[var(--color-abyss)] font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 transition">
          Ajouter le site
        </button>
      </form>

      {erreur && <p className="text-sm text-[var(--color-crit)]">{erreur}</p>}

      {miseEnService && (
        <MiseEnServiceAgent
          idSite={miseEnService}
          onFermer={() => {
            setMiseEnService(null);
            rafraichir();
          }}
        />
      )}

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <div className="table-scroll"><table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
              <th className="pb-2 font-medium">Nom</th>
              <th className="pb-2 font-medium">Ville</th>
              <th className="pb-2 font-medium">Agent</th>
              <th className="pb-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-line)]">
            {sites.map((s) => {
              const etat = s.agent?.etat || "jamais_connecte";
              const couleur =
                etat === "actif"
                  ? "var(--color-ok)"
                  : etat === "muet"
                  ? "var(--color-crit)"
                  : "var(--color-mute)";
              return (
                <tr key={s.id_site}>
                  <td className="py-2.5">{s.nom}</td>
                  <td className="py-2.5 text-[var(--color-mute)]">{s.ville}</td>
                  <td className="py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: couleur }}>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: couleur }}
                      />
                      {s.agent?.libelle || "Jamais connecté"}
                    </span>
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => setMiseEnService(s.id_site)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
                    >
                      {etat === "jamais_connecte" ? "Mettre en service" : "Agent"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}