/**
 * EtatVide — ce qu'on affiche quand il n'y a rien à afficher.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI UN COMPOSANT DÉDIÉ
 *
 * La plateforme disait « Aucun équipement trouvé. », « Aucun relevé
 * disponible pour les dernières 24h. », « Aucune mesure sur cette
 * période. » — des constats exacts et inutiles. Aucun ne dit POURQUOI,
 * ni ce qu'il faut faire.
 *
 * C'est le principal responsable de l'impression « le produit ne marche
 * pas ». Un écran vide sans explication est indistinguable d'une panne :
 * on a passé des heures à chercher un défaut derrière « aucun relevé »
 * alors que la cause tenait en une phrase.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LA DISTINCTION QUI COMPTE
 *
 * Deux vides n'ont rien à voir :
 *
 *   • « il n'y a rien parce que TOUT VA BIEN » — aucune alerte à
 *     traiter, aucun incident ouvert. C'est une bonne nouvelle et elle
 *     doit se lire comme telle.
 *
 *   • « il n'y a rien parce qu'IL MANQUE QUELQUE CHOSE » — pas encore de
 *     scan, pas de SNMP sur le parc, une migration en attente. C'est une
 *     étape à franchir, et l'écran doit dire laquelle.
 *
 * Les confondre, c'est soit alarmer sans raison, soit laisser croire que
 * tout va bien alors que rien n'est mesuré.
 * ─────────────────────────────────────────────────────────────────────
 *
 * @param {string} titre        le constat, en une ligne
 * @param {string} explication  POURQUOI c'est vide — le cœur du composant
 * @param {"bien"|"etape"|"neutre"} ton
 * @param {{libelle:string, onClick:function}} [action]  bouton facultatif
 * @param {string} [aide]       précision technique, plus discrète
 */
export default function EtatVide({ titre, explication, ton = "neutre", action, aide }) {
  const couleur = {
    bien: "var(--color-ok)",
    etape: "var(--color-signal)",
    neutre: "var(--color-mute)",
  }[ton];

  return (
    <div className="py-10 px-6 text-center">
      {/* Un point coloré plutôt qu'une illustration : discret, cohérent
          avec les pastilles d'état du reste de l'interface, et sans
          image à charger. */}
      <span
        className="inline-block w-2.5 h-2.5 rounded-full mb-4"
        style={{ background: couleur, opacity: ton === "neutre" ? 0.5 : 1 }}
      />

      <p className="text-sm font-medium text-[var(--color-ink)]">{titre}</p>

      {explication && (
        <p className="text-sm text-[var(--color-mute)] mt-1.5 max-w-md mx-auto">{explication}</p>
      )}

      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-2 rounded-lg bg-[var(--color-signal)] text-[var(--color-sur-accent)] text-sm font-medium hover:opacity-90 transition cible-tactile"
        >
          {action.libelle}
        </button>
      )}

      {/* L'aide technique vit sous l'action, en plus petit : elle sert à
          celui qui creuse, pas à celui qui découvre. */}
      {aide && (
        <p className="text-xs text-[var(--color-mute)] mt-4 max-w-md mx-auto opacity-80">{aide}</p>
      )}
    </div>
  );
}
