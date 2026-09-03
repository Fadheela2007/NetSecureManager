/**
 * EtatVide — ce qu'on affiche quand il n'y a rien à afficher.
 *
 * « Aucun équipement trouvé », « aucun relevé disponible » : des constats
 * exacts et inutiles, qui ne disent ni pourquoi ni quoi faire. Un écran
 * vide sans explication est indistinguable d'une panne.
 *
 * Le composant sépare deux vides qui n'ont rien à voir : « rien parce que
 * tout va bien » (aucune alerte, aucun incident) et « rien parce qu'il
 * manque quelque chose » (pas encore de scan, pas de SNMP, migration en
 * attente). Les confondre revient soit à alarmer sans raison, soit à
 * laisser croire que tout va bien alors que rien n'est mesuré.
 *
 * @param {string} titre        le constat, en une ligne
 * @param {string} explication  pourquoi c'est vide — le cœur du composant
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
