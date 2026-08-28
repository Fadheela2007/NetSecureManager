/**
 * api.js
 *
 * ⚠ Fichier conservé mais NON UTILISÉ par l'application.
 *
 * L'authentification de l'application passe par `axios.defaults.headers.common`,
 * défini une seule fois dans App.jsx (au démarrage et à la connexion).
 * Tous les composants utilisent donc `axios` directement.
 *
 * Ce module utilisait auparavant les clés localStorage "nsm_token" / "nsm_user",
 * alors que le reste de l'application écrit "token" / "utilisateur" : toute
 * requête passant par ici partait sans jeton et renvoyait un 401.
 * Les clés sont désormais alignées, mais tant qu'une seule approche est en
 * vigueur, ne pas mélanger `api` et `axios` dans un même composant.
 */

import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("utilisateur");
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

export default api;
