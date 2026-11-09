import React from "react";
import NetworkMark from "./NetworkMark";

/**
 * Page publique affichée avant la connexion.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUI A ÉTÉ VOLONTAIREMENT RETIRÉ DU GABARIT, ET NON ADAPTÉ
 *
 *   • témoignages et logos de clients — il n'y en a pas encore. Un faux
 *     témoignage se retourne contre soi le jour où un prospect demande à
 *     parler à ce client ;
 *   • « essai gratuit 14 jours sans carte » — ce n'est pas un produit en
 *     libre-service : il s'installe chez le client, sur son matériel ;
 *   • alertes SMS et intégration Slack — non développées. Seul le
 *     courriel est réellement câblé (notificationService.js) ;
 *   • « 99,9 % de disponibilité garantie », « 40 % de temps de
 *     résolution en moins » — rien ne les mesure aujourd'hui.
 *
 * Les deux chiffres affichés (72 s, 101 équipements) viennent d'un scan
 * réel documenté — voir tools/mesurer-phases-scan.js. Ils sont les seuls
 * de cette page, et c'est délibéré : une page d'accueil qui n'avance que
 * ce qu'elle peut prouver vaut mieux qu'une page qui promet.
 *
 * ── LA MAQUETTE DU BANDEAU N'EST PAS UNE FAUSSE CAPTURE D'ÉCRAN ──
 *
 * Elle montre UNE ligne d'équipement avec sa preuve d'existence, parce
 * que c'est exactement ce que le produit fait de différent. Les valeurs
 * sont celles du parc de démonstration, pas des chiffres inventés pour
 * faire joli, et rien n'y est présenté comme une mesure du client.
 * ═══════════════════════════════════════════════════════════════════════
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

/* Les icônes sont dessinées ici, en traits simples : une bibliothèque
   d'icônes ajouterait des dizaines de kilooctets pour six dessins, sur
   une page qui doit s'ouvrir vite et sans réseau extérieur. */
const ICONES = {
  radar: "M12 3a9 9 0 1 0 9 9M12 12l6-4M12 12a3 3 0 1 0 3 3",
  pouls: "M3 12h4l2-6 3 12 2.5-7 1.5 3h5",
  cloche: "M6 9a6 6 0 1 1 12 0c0 4 1.5 5 1.5 5H4.5S6 13 6 9M10 19a2 2 0 0 0 4 0",
  debit: "M4 18V9M10 18V5M16 18v-7M22 18h-2M2 18h2",
  bouclier: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z",
  sites: "M4 20V8l5-4 5 4v12M14 20V11l6-3v12M7 20v-4h3v4",
};

function Icone({ trace }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={trace} />
    </svg>
  );
}

const CAPACITES = [
  {
    cle: "radar",
    titre: "Découverte automatique",
    texte:
      "Déclarez vos plages réseau, la plateforme trouve les équipements et les " +
      "classe : postes, serveurs, imprimantes, commutateurs. Aucune saisie " +
      "manuelle d'inventaire.",
  },
  {
    cle: "pouls",
    titre: "Supervision continue",
    texte:
      "Disponibilité, charge processeur, mémoire et état des interfaces, relevés " +
      "en continu. Les pannes sont horodatées et conservées.",
  },
  {
    cle: "cloche",
    titre: "Alertes hiérarchisées",
    texte:
      "Seuils par type d'équipement, escalade par niveau et notification par " +
      "courriel. Les alertes acquittées sortent de la file sans être perdues.",
  },
    {
    cle: "bouclier",
    titre: "Ce que le parc expose",
    texte:
      "Ports ouverts, versions annoncées par les services, et failles publiées " +
      "pour ces versions — avec le numéro officiel, vérifiable en un clic.",
  },
  {
    cle: "sites",
    titre: "Multi-sites cloisonné",
    texte:
      "Un agent par site distant. Chaque compte ne voit que le périmètre qui lui " +
      "est attribué — vérifié côté serveur, pas seulement à l'affichage.",
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

function StatCarte({ chiffre, unite, legende }) {
  return (
    <div className="rounded-[var(--rayon-md)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <div className="flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-tight text-[var(--color-signal)]">
          {chiffre}
        </span>
        {unite && <span className="text-sm text-[var(--color-mute)]">{unite}</span>}
      </div>
      <p className="mt-2.5 text-sm text-[var(--color-mute)] leading-relaxed">{legende}</p>
    </div>
  );
}

/**
 * Le visuel du bandeau : une ligne d'inventaire AVEC sa preuve.
 *
 * C'est la seule chose que cette page montre du produit, et c'est voulu :
 * une capture d'écran complète serait illisible à cette taille, et un
 * dessin abstrait ne dirait rien. Une ligne, sa preuve datée, et la
 * phrase qui va avec — c'est tout l'argument.
 */
function CarteDePreuve() {
  return (
    <div className="relative">
      <div
        className="rounded-[var(--rayon-lg)] border border-[var(--color-line)]
                   bg-[var(--color-surface)] p-5 shadow-[var(--ombre-flottante)]"
      >
        <div className="flex items-center justify-between pb-3 border-b border-[var(--color-line)]">
          <span className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">
            Fiche d'équipement
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-ok)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-ok)] pulse-dot" />
            En ligne
          </span>
        </div>

        <div className="pt-4">
          <p className="font-medium">SVR-SAP</p>
          <p className="font-[var(--font-mono)] text-xs text-[var(--color-mute)] mt-0.5">
            192.168.0.250 · 00:1A:2B:3C:4D:5E
          </p>

          <div className="flex flex-wrap gap-1.5 mt-3">
            {[
              ["FTP", 21],
              ["SMB", 445],
              ["RDP", 3389],
            ].map(([nom, port]) => (
              <span
                key={port}
                className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-line)]
                           text-[var(--color-mute)]"
              >
                {nom}
                <span className="font-[var(--font-mono)] opacity-60 ml-1">{port}</span>
              </span>
            ))}
          </div>

          {/* LA LIGNE QUI RÉSUME LE PRODUIT ENTIER. */}
          <div
            className="mt-4 rounded-[var(--rayon-sm)] border border-[var(--color-line)]
                       bg-[var(--color-surface-2)] px-3 py-2.5"
          >
            <p className="text-[10px] uppercase tracking-wide text-[var(--color-mute)]">
              Preuve d'existence
            </p>
            <p className="text-xs mt-1 leading-relaxed">
              Refus de connexion sur le port 445
              <span className="text-[var(--color-mute)]">, le 9 septembre à 13 h 42.</span>
            </p>
          </div>
        </div>
      </div>

      {/* Badges flottants : faible amplitude, deux durées différentes pour
          qu'ils ne se lisent pas comme un seul bloc. */}
      <div
        className="animate-flotter absolute -top-4 -right-3 rounded-[var(--rayon-sm)]
                   border border-[var(--color-line)] bg-[var(--color-surface)]
                   px-3 py-2 shadow-[var(--ombre-carte)]"
      >
        <p className="text-lg font-semibold leading-none text-[var(--color-signal)]">101</p>
        <p className="text-[10px] text-[var(--color-mute)] mt-1">équipements trouvés</p>
      </div>

      <div
        className="animate-flotter-lent absolute -bottom-6 -left-6 rounded-[var(--rayon-sm)]
                   border border-[var(--color-line)] bg-[var(--color-surface)]
                   px-3 py-2 shadow-[var(--ombre-carte)]"
      >
        <p className="text-lg font-semibold leading-none text-[var(--color-ok)]">0</p>
        <p className="text-[10px] text-[var(--color-mute)] mt-1">donnée qui sort du réseau</p>
      </div>
    </div>
  );
}

export default function Accueil({ onConnexion }) {
  return (
    <div className="min-h-screen bg-[var(--color-abyss)] text-[var(--color-ink)]">
      {/* ── EN-TÊTE COLLANT ──
          Translucide et flouté : le contenu passe dessous sans disparaître,
          et la barre ne coupe pas la page en deux comme le ferait un
          bandeau opaque. */}
      <header
        className="sticky top-0 z-40 border-b border-[var(--color-line)]
                   bg-[color-mix(in_srgb,var(--color-abyss)_82%,transparent)]
                   backdrop-blur-md"
      >
        <div className="flex items-center justify-between gap-4 px-6 py-3.5 max-w-6xl mx-auto">
          <div className="flex items-center gap-2.5">
            <NetworkMark size={28} />
            <span className="font-semibold tracking-tight">NetSecureManager</span>
          </div>

          <nav className="hidden md:flex items-center gap-7 text-sm text-[var(--color-mute)]">
            <a href="#fonctionnalites" className="hover:text-[var(--color-ink)] transition-colors">
              Fonctions
            </a>
            <a href="#mesures" className="hover:text-[var(--color-ink)] transition-colors">
              Mesures
            </a>
            <a href="#installation" className="hover:text-[var(--color-ink)] transition-colors">
              Installation
            </a>
          </nav>

          <button
            type="button"
            onClick={onConnexion}
            className="px-4 py-1.5 rounded-[var(--rayon-sm)] border border-[var(--color-line)]
                       text-sm hover:border-[var(--color-signal)]
                       hover:text-[var(--color-signal)] transition-colors cible-tactile"
          >
            Se connecter
          </button>
        </div>
      </header>

      <main>
        {/* ── BANDEAU ─────────────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pt-12 pb-16 sm:pt-16 sm:pb-20">
          <div className="grid lg:grid-cols-[1fr_1fr] gap-12 lg:gap-14 items-center">
            <div className="apparition">
              <span
                className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide
                           rounded-full border border-[var(--color-line)]
                           bg-[var(--color-surface)] px-3 py-1 text-[var(--color-mute)]"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-signal)]" />
                Supervision réseau pour PME
              </span>

              <h1 className="mt-5 text-3xl sm:text-4xl lg:text-[2.6rem] font-semibold tracking-tight leading-[1.12]">
                Gardez le contrôle de votre réseau,
                <span className="block text-[var(--color-signal)]">
                  sans avoir à le surveiller vous-même.
                </span>
              </h1>

              <p className="mt-5 text-base text-[var(--color-mute)] leading-relaxed max-w-lg">
                NetSecureManager inventorie votre parc, surveille sa disponibilité et
                signale les incidents avant que vos employés ne vous les rapportent.
                Installée sur vos serveurs, vos données ne les quittent jamais.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onConnexion}
                  className="px-5 py-2.5 rounded-[var(--rayon-sm)] bg-[var(--color-signal)]
                             text-[var(--color-sur-accent)] font-medium
                             hover:brightness-110 transition cible-tactile"
                >
                  Demander une démonstration
                </button>
                <a
                  href="#fonctionnalites"
                  className="px-5 py-2.5 rounded-[var(--rayon-sm)] border border-[var(--color-line)]
                             text-sm hover:border-[var(--color-signal)] transition-colors cible-tactile"
                >
                  Voir ce qu'elle fait
                </a>
              </div>

              {/* La phrase qui rassure un responsable informatique, et la
                  seule promesse technique de ce bandeau. */}
              <p className="mt-6 text-xs text-[var(--color-mute)]">
                Installation sur votre serveur · aucun agent obligatoire sur les postes ·
                aucune donnée envoyée à l'extérieur
              </p>
            </div>

            <div className="apparition lg:pl-4">
              <CarteDePreuve />
            </div>
          </div>
        </section>

        {/* ── CE QUI SE PASSE / CE QUI CHANGE ─────────────────────── */}
        <section className="border-y border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="max-w-6xl mx-auto px-6 py-14 grid gap-10 sm:grid-cols-2">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-mute)]">
                Ce qui se passe aujourd'hui
              </h2>
              <ul className="mt-5 space-y-4">
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
              <ul className="mt-5 space-y-4">
                {REPONSES.map((r) => (
                  <li key={r} className="flex items-start gap-3 text-sm leading-relaxed">
                    <Puce couleur="var(--color-ok)" />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── FONCTIONS ───────────────────────────────────────────── */}
        <section id="fonctionnalites" className="max-w-6xl mx-auto px-6 py-20">
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-center">
            Ce que la plateforme fait
          </h2>
          <p className="mt-3 text-sm text-[var(--color-mute)] text-center max-w-xl mx-auto leading-relaxed">
            Six fonctions, toutes développées et utilisées sur un parc réel. Rien
            n'est annoncé ici qui ne tourne pas.
          </p>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {CAPACITES.map((c) => (
              <article
                key={c.titre}
                className="rounded-[var(--rayon-md)] border border-[var(--color-line)]
                           bg-[var(--color-surface)] p-6
                           hover:border-[var(--color-signal)] transition-colors"
              >
                <span
                  className="inline-flex items-center justify-center w-10 h-10 rounded-[var(--rayon-sm)]
                             text-[var(--color-signal)]"
                  style={{ background: "color-mix(in srgb, var(--color-signal) 12%, transparent)" }}
                >
                  <Icone trace={ICONES[c.cle]} />
                </span>
                <h3 className="mt-4 font-medium">{c.titre}</h3>
                <p className="mt-2 text-sm text-[var(--color-mute)] leading-relaxed">{c.texte}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ── MESURÉ, PAS ESTIMÉ ──────────────────────────────────── */}
        <section
          id="mesures"
          className="border-y border-[var(--color-line)] bg-[var(--color-surface-2)]"
        >
          <div className="max-w-6xl mx-auto px-6 py-20">
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-center">
              Mesuré, pas estimé
            </h2>
            <p className="mt-3 text-sm text-[var(--color-mute)] text-center max-w-xl mx-auto leading-relaxed">
              Ces trois chiffres viennent d'un scan réel, documenté et rejouable.
              Vous n'en trouverez pas d'autres sur cette page.
            </p>

            <div className="mt-12 grid gap-5 sm:grid-cols-3">
              <StatCarte
                chiffre="72"
                unite="secondes"
                legende="pour scanner un réseau de 500 adresses et identifier ce qui y répond"
              />
              <StatCarte
                chiffre="101"
                legende="équipements identifiés automatiquement sur ce même réseau, sans saisie manuelle"
              />
              <StatCarte
                chiffre="0"
                legende="donnée qui quitte votre réseau : l'installation reste chez vous"
              />
            </div>
          </div>
        </section>

        {/* ── INSTALLATION ────────────────────────────────────────── */}
        <section id="installation" className="max-w-6xl mx-auto px-6 py-20">
          <div className="grid lg:grid-cols-2 gap-12 items-start">
            <div>
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                Ce qui est inclus à l'installation
              </h2>
              <p className="mt-3 text-sm text-[var(--color-mute)] leading-relaxed max-w-md">
                La plateforme s'installe sur un serveur de votre réseau. Elle n'a
                besoin ni d'un annuaire, ni d'un commutateur particulier, ni d'un
                logiciel sur les postes.
              </p>
            </div>

            <ul className="space-y-4">
              {INCLUS.map((i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 text-sm leading-relaxed
                             rounded-[var(--rayon-sm)] border border-[var(--color-line)]
                             bg-[var(--color-surface)] px-4 py-3"
                >
                  <Puce couleur="var(--color-signal)" />
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── APPEL À L'ACTION ────────────────────────────────────── */}
        <section className="max-w-6xl mx-auto px-6 pb-24">
          <div
            className="rounded-[var(--rayon-lg)] border border-[var(--color-line)]
                       bg-[var(--color-surface)] px-8 py-14 text-center
                       shadow-[var(--ombre-carte)]"
          >
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              Voir votre propre parc en une démonstration
            </h2>
            <p className="mt-4 text-[var(--color-mute)] max-w-lg mx-auto leading-relaxed">
              Une visite sur place suffit à évaluer votre réseau et à vous montrer ce
              qu'il contient réellement.
            </p>
            <button
              type="button"
              onClick={onConnexion}
              className="mt-8 px-6 py-3 rounded-[var(--rayon-sm)] bg-[var(--color-signal)]
                         text-[var(--color-sur-accent)] font-medium
                         hover:brightness-110 transition cible-tactile"
            >
              Demander une démonstration
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--color-line)]">
        <div
          className="max-w-6xl mx-auto px-6 py-8 flex flex-wrap items-center justify-between
                     gap-3 text-sm text-[var(--color-mute)]"
        >
          <span className="flex items-center gap-2.5">
            <NetworkMark size={20} animated={false} />
            NetSecureManager — supervision réseau
          </span>
          <span className="text-xs">Installée chez vous, pas dans un nuage.</span>
        </div>
      </footer>
    </div>
  );
}
