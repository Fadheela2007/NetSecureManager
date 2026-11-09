/* ══════════════════════════════════════════════════════════════════════
   UNE JAUGE EN DEMI-CERCLE

   ── LE CHIFFRE EST ÉCRIT AU CENTRE, TOUJOURS ──

   L'arc donne l'ordre de grandeur d'un coup d'œil ; seul le nombre dit
   la valeur. Une jauge sans son chiffre oblige à estimer une position
   sur un arc, ce que personne ne fait correctement.

   ── « AUCUNE MESURE » N'EST PAS « ZÉRO » ──

   Sans valeur, l'arc reste vide et le centre affiche « — ». Un arc à
   zéro se lirait « machine au repos », c'est-à-dire une affirmation
   qu'on n'a pas.

   ── LE SEUIL EST ÉCRIT, PAS SEULEMENT TEINTÉ ──

   La couleur distingue, elle ne nomme pas : elle disparaît à
   l'impression et pour qui ne distingue pas le rouge du vert. Le niveau
   est donc aussi écrit sous le libellé.
   ══════════════════════════════════════════════════════════════════════ */

const RAYON = 52;

export default function Jauge({ valeur, libelle, note }) {
  const connu =
    valeur !== null && valeur !== undefined && Number.isFinite(Number(valeur));
  const pct = connu ? Math.min(100, Math.max(0, Number(valeur))) : 0;

  // Demi-cercle : la longueur utile de l'arc vaut π × r.
  const longueur = Math.PI * RAYON;
  const rempli = (pct / 100) * longueur;

  const niveau = !connu ? null : pct >= 90 ? "saturé" : pct >= 70 ? "chargé" : "normal";
  const couleur = !connu
    ? "var(--color-line)"
    : pct >= 90
    ? "var(--color-crit)"
    : pct >= 70
    ? "var(--color-warn)"
    : "var(--color-ok)";

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox="0 0 128 72"
        className="w-full max-w-[150px]"
        role="img"
        aria-label={`${libelle} : ${connu ? `${pct} %` : "non mesuré"}`}
      >
        <path
          d={`M 12 64 A ${RAYON} ${RAYON} 0 0 1 116 64`}
          fill="none"
          stroke="var(--color-surface-2)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {connu && (
          <path
            d={`M 12 64 A ${RAYON} ${RAYON} 0 0 1 116 64`}
            fill="none"
            stroke={couleur}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${rempli} ${longueur}`}
          />
        )}
        <text
          x="64"
          y="60"
          textAnchor="middle"
          style={{ fill: couleur, fontSize: 24, fontWeight: 600 }}
          className="tabular-nums"
        >
          {connu ? `${pct}%` : "—"}
        </text>
      </svg>

      <p className="text-xs text-[var(--color-ink)] mt-1">{libelle}</p>
      {niveau && (
        <p className="text-[10px]" style={{ color: couleur }}>
          {niveau}
        </p>
      )}
      {note && <p className="text-[10px] text-[var(--color-mute)] mt-0.5">{note}</p>}
    </div>
  );
}
