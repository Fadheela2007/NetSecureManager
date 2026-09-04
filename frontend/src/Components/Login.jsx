import React, { useState } from 'react';
import NetworkMark from "./NetworkMark";
import './Login.css';
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

export default function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
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
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-mark">
          <NetworkMark size={24} />
        </div>

        <h1 className="login-title">NetSecureManager</h1>
        <p className="login-subtitle">Supervision réseau multi-sites</p>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-field">
            E-mail professionnel
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="prenom.nom@entreprise.com"
            />
          </label>

          <label className="login-field">
            <span className="login-field-ligne">
              Mot de passe
              {/* Pas un lien vers une réinitialisation qui n'existe pas :
                  aucune réinitialisation en libre-service n'est câblée. Le
                  vrai chemin est humain — un administrateur change le mot
                  de passe depuis la page Utilisateurs — donc c'est ce qui
                  est dit, en texte et non en lien cliquable. */}
              <span className="login-aide-inline">contactez votre administrateur</span>
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
           />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? "Connexion..." : "Se connecter"}
          </button>

          <p className="login-footnote">
            Accès réservé aux équipes autorisées à superviser leur réseau.
          </p>
        </form>
      </div>
    </div>
  );
}