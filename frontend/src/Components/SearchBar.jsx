import { useState, useRef, useEffect } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

export default function SearchBar({ onSelectEquipement, onNavigate }) {
  const [terme, setTerme] = useState("");
  const [resultats, setResultats] = useState(null);
  const [ouvert, setOuvert] = useState(false);
  const timeoutRef = useRef(null);
  const boiteRef = useRef(null);

  function onChange(e) {
    const valeur = e.target.value;
    setTerme(valeur);
    clearTimeout(timeoutRef.current);

    if (valeur.trim().length < 2) {
      setResultats(null);
      setOuvert(false);
      return;
    }

    timeoutRef.current = setTimeout(async () => {
      // Sans try/catch, une recherche en échec provoquait un rejet de promesse
      // non géré (le callback de setTimeout n'a pas d'appelant pour l'attraper).
      try {
        const { data } = await axios.get(`${API_URL}/recherche`, {
          params: { q: valeur },
        });
        setResultats(data);
        setOuvert(true);
      } catch {
        setResultats(null);
        setOuvert(false);
      }
    }, 300);
  }

  useEffect(() => {
    function fermerSiExterieur(e) {
      if (boiteRef.current && !boiteRef.current.contains(e.target)) setOuvert(false);
    }
    document.addEventListener("mousedown", fermerSiExterieur);
    return () => document.removeEventListener("mousedown", fermerSiExterieur);
  }, []);

  const total = resultats
    ? resultats.equipements.length + resultats.alertes.length + resultats.incidents.length
    : 0;

  return (
    <div ref={boiteRef} className="relative w-full max-w-xs">
      <input
        type="text"
        value={terme}
        onChange={onChange}
        onFocus={() => resultats && setOuvert(true)}
        placeholder="Rechercher un équipement, une alerte…"
        className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[var(--color-signal)] transition"
      />

      {ouvert && resultats && (
        <div className="absolute mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg shadow-lg z-50 max-h-96 overflow-auto">
          {total === 0 ? (
            <p className="text-xs text-[var(--color-mute)] p-3">Aucun résultat.</p>
          ) : (
            <>
              {resultats.equipements.length > 0 && (
                <div className="p-2">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-mute)] px-2 mb-1">Équipements</p>
                  {resultats.equipements.map((eq) => (
                    <button
                      key={eq.id_equipement}
                      onClick={() => { onSelectEquipement(eq); setOuvert(false); setTerme(""); }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] text-sm"
                    >
                      {eq.nom || eq.adresse_ip} <span className="text-[var(--color-mute)] text-xs">— {eq.adresse_ip}</span>
                    </button>
                  ))}
                </div>
              )}
              {resultats.alertes.length > 0 && (
                <div className="p-2 border-t border-[var(--color-line)]">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-mute)] px-2 mb-1">Alertes</p>
                  {resultats.alertes.map((a) => (
                    <button
                      key={a.id_alerte}
                      onClick={() => { onNavigate("alertes"); setOuvert(false); setTerme(""); }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] text-sm truncate"
                    >
                      {a.nom || a.adresse_ip} <span className="text-[var(--color-mute)] text-xs">— {a.message}</span>
                    </button>
                  ))}
                </div>
              )}
              {resultats.incidents.length > 0 && (
                <div className="p-2 border-t border-[var(--color-line)]">
                  <p className="text-[10px] uppercase tracking-wide text-[var(--color-mute)] px-2 mb-1">Incidents</p>
                  {resultats.incidents.map((i) => (
                    <button
                      key={i.id_incident}
                      onClick={() => { onNavigate("incidents"); setOuvert(false); setTerme(""); }}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--color-surface-2)] text-sm truncate"
                    >
                      {i.titre} <span className="text-[var(--color-mute)] text-xs">— {i.nom || i.adresse_ip}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}