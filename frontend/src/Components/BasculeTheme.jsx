import { useEffect, useState } from "react";
import { themeInitial, appliquerTheme, memoriserTheme, choixMemorise } from "../theme";

/**
 * Bouton de bascule clair / sombre.
 *
 * Toute la logique vit dans src/theme.js : ce fichier n'exporte qu'un
 * composant, ce qui préserve le rafraîchissement à chaud de Vite.
 */
export default function BasculeTheme() {
  const [theme, setTheme] = useState(themeInitial);

  useEffect(() => {
    appliquerTheme(theme);
    memoriserTheme(theme);
  }, [theme]);

  // Suit la préférence système tant que l'utilisateur n'a pas choisi lui-même.
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const surChangement = (e) => {
      if (!choixMemorise()) setTheme(e.matches ? "light" : "dark");
    };
    mq.addEventListener("change", surChangement);
    return () => mq.removeEventListener("change", surChangement);
  }, []);

  const clair = theme === "light";
  const libelle = clair ? "Passer en thème sombre" : "Passer en thème clair";

  return (
    <button
      type="button"
      onClick={() => setTheme(clair ? "dark" : "light")}
      title={libelle}
      aria-label={libelle}
      className="cible-tactile shrink-0 flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
    >
      {clair ? (
        // Lune : proposée en thème clair, donc pour aller vers le sombre.
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
