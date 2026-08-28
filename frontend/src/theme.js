/**
 * theme.js
 * Logique de thème, séparée du composant de bascule pour que ce dernier
 * n'exporte qu'un composant (contrainte du rafraîchissement à chaud de Vite).
 *
 * Le thème est porté par l'attribut `data-theme` sur <html>. index.css
 * redéfinit les variables de couleur en fonction de cet attribut : aucun
 * composant n'a donc à connaître le thème courant.
 */

export const CLE_STOCKAGE = "theme";

/** Lit le choix mémorisé, ou null s'il n'y en a pas. */
export function choixMemorise() {
  try {
    const v = localStorage.getItem(CLE_STOCKAGE);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // localStorage indisponible (navigation privée stricte).
    return null;
  }
}

/**
 * Thème initial, dans cet ordre :
 *   1. le choix explicite de l'utilisateur, mémorisé
 *   2. à défaut, la préférence du système (prefers-color-scheme)
 *   3. à défaut, le thème sombre — celui d'origine de l'application
 */
export function themeInitial() {
  const memorise = choixMemorise();
  if (memorise) return memorise;

  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

export function appliquerTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function memoriserTheme(theme) {
  try {
    localStorage.setItem(CLE_STOCKAGE, theme);
  } catch {
    // Sans persistance, le thème reste valable pour la session en cours.
  }
}

/** Applique le thème avant le premier rendu, pour éviter un éclair de couleur. */
export function initialiserTheme() {
  appliquerTheme(themeInitial());
}
