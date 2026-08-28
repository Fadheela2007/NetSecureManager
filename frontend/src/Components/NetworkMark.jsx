/**
 * NetworkMark — la marque de NetSecureManager.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUE LE SYMBOLE RACONTE
 *
 * Un nœud central relié à trois satellites, entouré d'un anneau dont un
 * quart est plein : c'est littéralement l'architecture du produit — un
 * serveur central qui surveille des équipements — et l'arc en cours de
 * parcours évoque le balayage périodique.
 *
 * Le choix s'est fait contre trois autres pistes. Le bouclier, immédiat
 * mais employé par tous les produits de sécurité, aurait rendu la marque
 * indistinguable. Le tracé de battement cardiaque appartient autant aux
 * applications de santé qu'à la métrologie.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TROIS CONTRAINTES QUI ONT DICTÉ LE DESSIN
 *
 * 1. LISIBLE À 24 PIXELS. Un logo se voit surtout en favicon d'onglet et
 *    en icône d'application, pas en grand. D'où trois satellites et non
 *    six : au-delà, la couronne devient une bouillie de points.
 *
 * 2. MONOCHROME. Une seule couleur, celle de l'accent. Le logo doit
 *    fonctionner en noir sur une facture imprimée et en blanc sur un
 *    fond sombre. Un dégradé aurait interdit les deux.
 *
 * 3. TRAITS ÉPAIS ET ESPACÉS. Un trait fin disparaît au rendu réduit,
 *    et deux éléments trop proches fusionnent. Les rayons du dessin
 *    précédent, pointillés et fins, s'effaçaient complètement en favicon.
 * ─────────────────────────────────────────────────────────────────────
 */
export default function NetworkMark({ size = 40, animated = true, couleur }) {
  // `currentColor` par défaut : la marque hérite de la couleur du texte
  // parent. C'est ce qui lui permet d'apparaître en clair sur fond sombre
  // et l'inverse, sans code conditionnel ni variante de fichier.
  const teinte = couleur || "currentColor";

  // Satellites régulièrement répartis, décalés pour qu'aucun ne se place
  // exactement sur la pointe de l'arc ouvert — la superposition rendait
  // les deux formes illisibles en petit.
  const satellites = [
    { x: 24, y: 5 },
    { x: 42, y: 36 },
    { x: 6, y: 36 },
  ];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="NetSecureManager"
    >
      {/* Anneau de fond, discret : il porte le mouvement sans le crier. */}
      <circle cx="24" cy="24" r="19" stroke={teinte} strokeWidth="3" strokeOpacity="0.28" />

      {/* Quart plein — le balayage en cours. C'est lui qui distingue la
          marque d'un simple cercle, et il reste visible à 24 px. */}
      <path
        d="M24 5 A19 19 0 0 1 40.5 14.5"
        stroke={teinte}
        strokeWidth="3"
        strokeLinecap="round"
        className={animated ? "marque-balayage" : ""}
      />

      {satellites.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={s.y}
          r="4"
          fill={teinte}
          className={animated ? "marque-pouls" : ""}
          style={animated ? { animationDelay: `${i * 0.45}s` } : undefined}
        />
      ))}

      <circle cx="24" cy="24" r="6.5" fill={teinte} />
    </svg>
  );
}
