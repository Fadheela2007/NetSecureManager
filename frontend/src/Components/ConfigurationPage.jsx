import Reinitialisation from "./Reinitialisation";
import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

export default function ConfigurationPage() {
  const [config, setConfig] = useState([]);
  const [modifs, setModifs] = useState({});
  const [message, setMessage] = useState(null);

  async function charger() {
    // Token porté par axios.defaults (App.jsx) — pas d'en-tête manuel.
    const { data } = await axios.get(`${API_URL}/configuration`);
    setConfig(data);
  }

  useEffect(() => { charger().catch(() => {}); }, []);

  async function sauvegarder(cle) {
    const valeur = modifs[cle];
    if (valeur === undefined) return;
    try {
      await axios.patch(`${API_URL}/configuration/${cle}`, { valeur });
      setMessage({ type: "ok", texte: "Paramètre mis à jour." });
      charger();
    } catch (err) {
      setMessage({ type: "erreur", texte: err.response?.data?.error || "Échec de la mise à jour" });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Configuration</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Seuils de détection et d'escalade des alertes
        </p>
      </div>

      {message && (
        <p className={`text-sm ${message.type === "ok" ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}`}>
          {message.texte}
        </p>
      )}

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 space-y-4">
        {config.map((c) => (
          <div key={c.cle} className="flex items-center justify-between gap-4 pb-3 border-b border-[var(--color-line)] last:border-0 last:pb-0">
            <div className="min-w-0">
              <p className="text-sm text-[var(--color-ink)]">{c.description}</p>
              <p className="text-[11px] text-[var(--color-mute)] font-[var(--font-mono)]">{c.cle}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                defaultValue={c.valeur}
                onChange={(e) => setModifs((m) => ({ ...m, [c.cle]: e.target.value }))}
                className="w-20 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-2 py-1.5 text-sm text-center outline-none focus:border-[var(--color-signal)] transition"
              />
              <button
                onClick={() => sauvegarder(c.cle)}
                className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
              >
                Enregistrer
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* La réinitialisation vit tout en bas, et repliée. Elle n'a rien à
          faire près des réglages courants : on ne veut pas qu'un clic
          destiné à « Enregistrer » atterrisse dessus. */}
      <div className="mt-8 pt-6 border-t border-[var(--color-line)]">
        <Reinitialisation />
      </div>
    </div>
  );
}