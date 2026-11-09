import React, { useState } from "react";
import NetworkMark from "./NetworkMark";
import "./Login.css";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   UNE PAGE OUVERTE

   « connexion »   — on a déjà un compte.
   « inscription » — on n'en a pas. On remplit, on valide, on est dedans.

   Pas de demande, pas de validation par un administrateur, pas d'attente.

   Le compte créé est un LECTEUR : il consulte, il ne modifie rien. Un
   administrateur lui donne plus depuis la page Utilisateurs quand il
   sait qui c'est. Sur une base encore vide, le premier inscrit est
   administrateur — sinon personne ne pourrait jamais donner de droit à
   personne.
   ══════════════════════════════════════════════════════════════════════ */

export default function Login({ onLogin }) {
  const [vue, setVue] = useState("connexion");

  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function changerDeVue(cible) {
    setVue(cible);
    setError(null);
  }

  async function connexion(e) {
    e.preventDefault();
    if (!email || !password) {
      setError("Renseignez votre e-mail et votre mot de passe.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_URL}/auth/login`, {
        email,
        mot_de_passe: password,
      });
      // La persistance de la session est gérée par App.handleLogin,
      // pour qu'un seul endroit écrive dans localStorage.
      onLogin(data.utilisateur, data.token);
    } catch (err) {
      setError(err.response?.data?.error || "Identifiants invalides");
    } finally {
      setLoading(false);
    }
  }

  async function inscription(e) {
    e.preventDefault();
    if (!nom || !email || !password) {
      setError("Tous les champs sont nécessaires.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_URL}/auth/inscription`, {
        nom,
        email,
        mot_de_passe: password,
      });
      onLogin(data.utilisateur, data.token);
    } catch (err) {
      setError(
        err.response?.data?.aide ||
          err.response?.data?.error ||
          "Création du compte impossible"
      );
      setLoading(false);
    }
  }

  const entete =
    vue === "connexion"
      ? { titre: "NetSecureManager", sous: "Supervision réseau multi-sites" }
      : { titre: "Créer un compte", sous: "Quelques secondes, et vous êtes dedans." };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-mark">
          <NetworkMark size={24} />
        </div>

        <h1 className="login-title">{entete.titre}</h1>
        <p className="login-subtitle">{entete.sous}</p>

        {/* ══ SE CONNECTER ══ */}
        {vue === "connexion" && (
          <form onSubmit={connexion} className="login-form">
            <label className="login-field">
              E-mail
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="prenom.nom@entreprise.com"
                autoComplete="username"
              />
            </label>

            <label className="login-field">
              <span className="login-field-ligne">
                Mot de passe
                {/* Pas un lien vers une réinitialisation qui n'existe pas :
                    aucune réinitialisation en libre-service n'est câblée. Le
                    vrai chemin est humain — un administrateur change le mot
                    de passe depuis la page Utilisateurs. */}
                <span className="login-aide-inline">contactez votre administrateur</span>
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
              />
            </label>

            {error && <p className="login-error">{error}</p>}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? "Connexion..." : "Se connecter"}
            </button>

            <p className="login-footnote">
              Pas encore de compte ?{" "}
              <button
                type="button"
                className="login-lien"
                onClick={() => changerDeVue("inscription")}
              >
                Créer un compte
              </button>
            </p>
          </form>
        )}

        {/* ══ CRÉER UN COMPTE ══ */}
        {vue === "inscription" && (
          <form onSubmit={inscription} className="login-form">
            <label className="login-field">
              Votre nom
              <input
                type="text"
                value={nom}
                onChange={(e) => setNom(e.target.value)}
                placeholder="Prénom Nom"
                autoComplete="name"
              />
            </label>

            <label className="login-field">
              E-mail
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="prenom.nom@entreprise.com"
                autoComplete="username"
              />
            </label>

            <label className="login-field">
              Mot de passe
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="au moins 8 caractères"
                autoComplete="new-password"
              />
            </label>

            {error && <p className="login-error">{error}</p>}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? "Création..." : "Créer mon compte"}
            </button>

            {/* CE QUE LE COMPTE POURRA FAIRE, DIT AVANT DE CLIQUER. */}
            <p className="login-footnote">
              Vous entrez en lecture seule. Un administrateur vous donnera plus
              de droits depuis la page Utilisateurs.{" "}
              <button
                type="button"
                className="login-lien"
                onClick={() => changerDeVue("connexion")}
              >
                J'ai déjà un compte
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
