import React from "react";
import NetworkMark from "./NetworkMark";

/**
 * Page publique affichée avant la connexion.
 *
 * Ne décrit que des fonctions réellement livrées : un visiteur qui se
 * connecte doit retrouver ce qu'on lui a annoncé.
 */

const CAPACITES = [
  {
    titre: "Découverte automatique",
    texte:
      "Déclarez vos plages réseau, la plateforme trouve les équipements et " +
      "les classe : postes, serveurs, imprimantes, commutateurs. Aucune " +
      "saisie manuelle d'inventaire.",
  },
  {
    titre: "Supervision continue",
    texte:
      "Disponibilité, charge processeur, mémoire et état des interfaces, " +
      "relevés en continu. Les pannes sont horodatées et conservées.",
  },
  {
    titre: "Alertes hiérarchisées",
    texte:
      "Seuils par type d'équipement, escalade par niveau et notification " +
      "par courriel. Les alertes acquittées sortent de la file sans être " +
      "perdues.",
  },
  {
    titre: "Bande passante",
    texte:
      "Consommation par équipement, et attribution au port de commutateur " +
      "quand le matériel le permet. On voit qui consomme, pas seulement " +
      "combien.",
  },
  {
    titre: "Contrôle d'accès web",
    texte:
      "Blocage par catégories appliqué sur la passerelle du site. La " +
      "politique est centralisée, l'application est locale.",
  },
  {
    titre: "Multi-sites cloisonné",
    texte:
      "Un agent par site distant. Chaque compte ne voit que le périmètre " +
      "qui lui est attribué — vérifié côté serveur, pas seulement à " +
      "l'affichage.",
  },
];

export default function Accueil({ onConnexion }) {
  return (
    <div className="min-h-screen bg-[var(--color-abyss)] text-[var(--color-ink)]">
      <header className="flex items-center justify-between px-6 py-5 max-w-5xl mx-auto">
        <div className="flex items-center gap-3">
          <NetworkMark size={32} />
          <span className="font-semibold tracking-tight">NetSecureManager</span>
        </div>
        <button
          type="button"
          onClick={onConnexion}
          className="px-4 py-2 rounded-md border border-[var(--color-line)]
                     hover:border-[var(--color-signal)] transition-colors text-sm"
        >
          Se connecter
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6">
        <section className="py-16 sm:py-24 max-w-2xl">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
            Savoir ce qu'il y a sur votre réseau,
            <br />
            et ce qui s'y passe.
          </h1>
          <p className="mt-5 text-[var(--color-mute)] leading-relaxed">
            NetSecureManager inventorie votre parc informatique, surveille sa
            disponibilité et signale les incidents avant que vos utilisateurs
            ne les remontent. Installation sur vos serveurs, données chez vous.
          </p>
          <button
            type="button"
            onClick={onConnexion}
            className="mt-8 px-5 py-2.5 rounded-md bg-[var(--color-signal)]
                       text-[var(--color-sur-accent)] font-medium
                       hover:opacity-90 transition-opacity"
          >
            Accéder à la plateforme
          </button>
        </section>

        <section className="grid gap-px sm:grid-cols-2 lg:grid-cols-3
                            bg-[var(--color-line)] rounded-lg overflow-hidden">
          {CAPACITES.map((c) => (
            <article key={c.titre} className="bg-[var(--color-surface)] p-6">
              <h2 className="font-medium">{c.titre}</h2>
              <p className="mt-2 text-sm text-[var(--color-mute)] leading-relaxed">
                {c.texte}
              </p>
            </article>
          ))}
        </section>

        <section className="py-16 max-w-2xl">
          <h2 className="text-xl font-semibold tracking-tight">
            Vos données ne sortent pas de chez vous
          </h2>
          <p className="mt-4 text-[var(--color-mute)] leading-relaxed">
            La plateforme s'installe sur vos serveurs. La cartographie de votre
            réseau — adresses, machines, incidents — reste dans votre base de
            données. Aucun service externe n'est interrogé pour superviser vos
            équipements.
          </p>
        </section>
      </main>

      <footer className="border-t border-[var(--color-line)]">
        <div className="max-w-5xl mx-auto px-6 py-6 text-sm text-[var(--color-mute)]">
          NetSecureManager — supervision réseau
        </div>
      </footer>
    </div>
  );
}
