import React from 'react';
import NetworkMark from "./NetworkMark";

const NAV = [
  { key: "dashboard", label: "Tableau de bord" },
  { key: "equipements", label: "Équipements" },
  { key: "plages", label: "Plages réseau" },
  { key: "topologie", label: "Topologie" },
  { key: "bande-passante", label: "Bande passante" },
  { key: "acces-web", label: "Accès web" },
  { key: "alertes", label: "Alertes" },
  { key: "incidents", label: "Incidents" },
  { key: "sites", label: "Sites" },
  { key: "utilisateurs", label: "Utilisateurs" },
  { key: "configuration", label: "Configuration" },
  { key: "journal", label: "Journal" },
];

export default function Sidebar({ active, onNavigate, user, onLogout, ouvert = false, onFermer }) {
  // Sous 768 px, la barre sort du flux et se superpose au contenu.
  // Au-dessus, elle reprend sa place normale (translate-x-0 + relative).
  return (
    <aside
      className={`w-60 shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-line)] flex flex-col
        fixed inset-y-0 left-0 z-50 transition-transform duration-200
        md:relative md:translate-x-0
        ${ouvert ? "translate-x-0" : "-translate-x-full"}`}
    >
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[var(--color-line)]">
        <NetworkMark size={28} animated={false} />
        <span className="font-[var(--font-display)] font-semibold text-sm tracking-tight">
          NetSecureManager
        </span>
        {/* Fermeture du tiroir : visible seulement sur petit écran. */}
        <button
          type="button"
          onClick={onFermer}
          aria-label="Fermer le menu"
          className="md:hidden ml-auto text-[var(--color-mute)] hover:text-[var(--color-ink)] transition cible-tactile"
        >
          ✕
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map((item) => (
          <button
            key={item.key}
            onClick={() => { onNavigate(item.key); if (onFermer) onFermer(); }}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition cible-tactile ${
              active === item.key
                ? "bg-[var(--color-signal)]/10 text-[var(--color-signal)] font-medium"
                : "text-[var(--color-mute)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="px-4 py-4 border-t border-[var(--color-line)]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--color-ink)] truncate">
              {user?.email}
            </p>
            <p className="text-[11px] text-[var(--color-mute)]">{user?.role || "—"}</p>
          </div>
          <button
            onClick={onLogout}
            className="text-[11px] text-[var(--color-mute)] hover:text-[var(--color-crit)] transition shrink-0"
          >
            Déconnexion
          </button>
        </div>
      </div>
    </aside>
  );
}
