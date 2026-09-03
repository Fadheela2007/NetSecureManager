import React from "react";
import NetworkMark from "./NetworkMark";

/**
 * Page publique affichée avant la connexion.
 *
 * Structure inspirée d'un gabarit de page d'atterrissage classique
 * (problème/solution, fonctionnalités, preuves, appel à l'action,
 * inclus) — mais chaque contenu a été vérifié avant d'être écrit ici.
 *
 * Trois choses du gabarit d'origine ont été volontairement retirées, et
 * pas simplement adaptées :
 *
 *   • témoignages et logos de clients — il n'y en a pas encore. Un faux
 *     témoignage se retourne contre soi le jour où un prospect demande
 *     à parler à ce client.
 *   • essai gratuit de 14 jours sans carte — ce n'est pas un produit en
 *     libre-service : il s'installe chez le client, sur son matériel.
 *     Rien n'existe pour soutenir un essai automatisé.
 *   • alertes SMS et intégration Slack — non développées. Seul le
 *     courriel est réellement câblé (notificationService.js).
 *
 * Les statistiques affichées (72 s, 101 équipements) viennent d'un scan
 * réel documenté, pas d'un chiffre de gabarit — voir
 * tools/mesurer-phases-scan.js. « 99,9 % de disponibilité garantie » et
 * « 40 % de réduction du temps de résolution » ont été retirés pour la
 * même raison : rien ne les mesure aujourd'hui.
 */

const DEFIS = [
  "Vous ne savez pas combien d'appareils sont réellement connectés à votre réseau.",
  "Une panne se découvre quand un employé vient la signaler — parfois des heures plus tard.",
  "Un appareil qui n'est pas à vous pourrait se brancher sans que personne ne le remarque.",
];

const REPONSES = [
  "Inventaire automatique de tout le parc, sans configuration préalable des équipements.",
  "Détection des pannes en continu, avec une seule alerte par problème — pas une rafale.",
  "Tout nouvel appareil apparaît dans la liste au passage suivant.",
];

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

const INCLUS = [
  "Installation et mise en service sur votre réseau",
  "Deux heures de formation pour votre équipe",
  "Support inclus pendant la première année",
  "Licence par site, sans facturation par appareil ajouté",
];

function Puce({ couleur }) {
  return (
    <span
      className="mt-1 flex-none w-4 h-4 rounded-full flex items-center justify-center"
      style={{ background: `color-mix(in srgb, ${couleur} 18%, transparent)` }}
      aria-hidden="true"
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: couleur }} />
    </span>
  );
}

function StatCarte({ chiffre, legende }) {
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 text-center">
      <div className="text-3xl font-semibold tracking-tight text-[var(--color-signal)]">
        {chiffre}
      </div>
      <p className="mt-2 text-sm text-[var(--color-mute)] leading-relaxed">{legende}</p>
    </div>
  );
}

export default function Accueil({ onConnexion }) {
  return (
    <div className="min-h-screen bg-[var(--color-abyss)] text-[var(--color-ink)]">
      <header className="border-b border-[var(--color-line)]">
        <div className="flex items-center justify-between px-6 py-4 max-w-5xl mx-auto">
          <div className="flex items-center gap-2.5">
            <NetworkMark size={28} />
            <span className="font-semibold tracking-tight">NetSecureManager</span>
          </div>
          <button
            type="button"
            onClick={onConnexion}
            className="px-4 py-1.5 rounded-md border border-[var(--color-line)] text-sm
                       hover:border-[var(--color-signal)] transition-colors"
          >
            Se connecter
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6">
        {/* ── En-tête / promesse ─────────────────────────────────── */}
        <section className="py-16 sm:py-24 text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
            Gardez le contrôle de votre réseau,
            <br />
            sans avoir à le surveiller vous-même.
          </h1>
          <p className="mt-5 text-[var(--color-mute)] leading-relaxed">
            NetSecureManager inventorie votre parc, surveille sa disponibilité
            et signale les incidents avant que vos employés ne vous les
            rapportent. Installée sur vos serveurs, vos données ne les
            quittent jamais.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <button
              type="button"
              onClick={onConnexion}
              className="px-5 py-2.5 rounded-md bg-[var(--color-signal)]
                         text-[var(--color-sur-accent)] font-medium
                         hover:opacity-90 transition-opacity"
            >
              Demander une démonstration
            </button>
            <a
              href="#fonctionnalites"
              className="text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] transition-colors"
            >
              Voir ce qu'elle fait ↓
            </a>
          </div>
        </section>

        {/* ── Défis / réponse ────────────────────────────────────── */}
        <section className="grid gap-8 sm:grid-cols-2 py-12 border-t border-[var(--color-line)]">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-mute)]">
              Ce qui se passe aujourd'hui
            </h2>
            <ul className="mt-4 space-y-3">
              {DEFIS.map((d) => (
                <li key={d} className="flex items-start gap-3 text-sm leading-relaxed">
                  <Puce couleur="var(--color-crit)" />
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-mute)]">
              Ce que la plateforme change
            </h2>
            <ul className="mt-4 space-y-3">
              {REPONSES.map((r) => (
                <li key={r} className="flex items-start gap-3 text-sm leading-relaxed">
                  <Puce couleur="var(--color-ok)" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Fonctionnalités ────────────────────────────────────── */}
        <section id="fonctionnalites" className="py-16 border-t border-[var(--color-line)]">
          <h2 className="text-xl font-semibold tracking-tight text-center">
            Ce que la plateforme fait
          </h2>
          <div
            className="mt-8 grid gap-px sm:grid-cols-2 lg:grid-cols-3
                       bg-[var(--color-line)] rounded-lg overflow-hidden"
          >
            {CAPACITES.map((c) => (
              <article key={c.titre} className="bg-[var(--color-surface)] p-6">
                <h3 className="font-medium">{c.titre}</h3>
                <p className="mt-2 text-sm text-[var(--color-mute)] leading-relaxed">
                  {c.texte}
                </p>
              </article>
            ))}
          </div>
        </section>

        {/* ── Chiffres mesurés — pas d'estimations marketing ─────── */}
        <section className="py-16 border-t border-[var(--color-line)]">
          <h2 className="text-xl font-semibold tracking-tight text-center">
            Mesuré, pas estimé
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <StatCarte chiffre="72 s" legende="pour scanner un réseau de 500 adresses et identifier ce qui y répond" />
            <StatCarte chiffre="101" legende="équipements identifiés automatiquement sur ce même réseau, sans saisie manuelle" />
            <StatCarte chiffre="0" legende="donnée qui quitte votre réseau : l'installation reste chez vous" />
          </div>
        </section>

        {/* ── Ce qui est inclus ──────────────────────────────────── */}
        <section className="py-16 border-t border-[var(--color-line)] max-w-2xl mx-auto">
          <h2 className="text-xl font-semibold tracking-tight text-center">
            Ce qui est inclus à l'installation
          </h2>
          <ul className="mt-8 space-y-3">
            {INCLUS.map((i) => (
              <li key={i} className="flex items-start gap-3 text-sm leading-relaxed">
                <Puce couleur="var(--color-signal)" />
                <span>{i}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Appel à l'action, répété en bas comme en haut ──────── */}
        <section className="py-16 border-t border-[var(--color-line)] text-center">
          <h2 className="text-xl font-semibold tracking-tight">
            Voir votre propre parc en une démonstration
          </h2>
          <p className="mt-3 text-[var(--color-mute)] max-w-md mx-auto leading-relaxed">
            Une visite sur place suffit à évaluer votre réseau et à vous
            montrer ce qu'il contient réellement.
          </p>
          <button
            type="button"
            onClick={onConnexion}
            className="mt-6 px-5 py-2.5 rounded-md bg-[var(--color-signal)]
                       text-[var(--color-sur-accent)] font-medium
                       hover:opacity-90 transition-opacity"
          >
            Demander une démonstration
          </button>
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
