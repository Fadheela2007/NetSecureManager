import { useEffect, useState } from "react";
import axios from "axios";

import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

// Rattachées aux variables de thème : ces trois couleurs étaient codées en
// dur et restaient donc celles du thème sombre même en thème clair, où le
// vert et le rose pâles devenaient illisibles sur fond blanc.
const COULEUR_STATUT = {
  up: "var(--color-ok)",
  down: "var(--color-crit)",
  inconnu: "var(--color-mute)",
};

export default function TopologyPage({ idSite }) {
  const [equipements, setEquipements] = useState([]);
  const [survole, setSurvole] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    setErreur(null);
    axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } })
      .then(({ data }) => setEquipements(data))
      .catch((err) => setErreur(decrireErreur(err, "La topologie")));
  }, [idSite]);

  // Le nœud central : l'équipement dont l'IP se termine par .1, .254 ou .155
  // (heuristique simple pour repérer une passerelle probable), sinon le premier de la liste
  const passerelle =
    equipements.find((e) => /\.(1|254|155)$/.test(e.adresse_ip)) || equipements[0];

  // Ne garder que les équipements vus récemment (24h) pour éviter une vue
  // surchargée par tous les tests accumulés au fil du temps
  const maintenant = Date.now();
  const recents = equipements.filter((e) => {
    if (!e.derniere_decouverte) return false;
    const age = maintenant - new Date(e.derniere_decouverte).getTime();
    return age < 24 * 60 * 60 * 1000;
  });
  const autres = recents.filter((e) => e !== passerelle);

  const largeur = 900;
  const hauteur = 600;
  const centreX = largeur / 2;
  const centreY = hauteur / 2;
  const rayon = Math.min(largeur, hauteur) / 2 - 60;

  const positions = autres.map((eq, i) => {
    const angle = (2 * Math.PI * i) / Math.max(autres.length, 1);
    return {
      eq,
      x: centreX + rayon * Math.cos(angle),
      y: centreY + rayon * Math.sin(angle),
    };
  });

  // L'échec passe avant le test de liste vide : « aucun équipement à
  // afficher — lancez un scan » envoyait lancer un scan qui, serveur
  // arrêté, ne pouvait pas aboutir.
  if (erreur) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
          <p className="text-sm text-[var(--color-crit)] mt-0.5">{erreur.titre}</p>
          <p className="text-sm text-[var(--color-mute)] mt-1">{erreur.detail}</p>
        </div>
      </div>
    );
  }

  if (equipements.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            Aucun équipement à afficher — lancez d'abord un scan depuis le tableau de bord.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Vue schématique des équipements vus dans les dernières 24h, autour de la passerelle détectée
        </p>
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-4 overflow-auto">
        {/* viewBox + largeur 100 % : le schéma se réduit proportionnellement
            au lieu de déborder.

            La hauteur passe par le CSS et NON par l'attribut `height`.
            `height="auto"` n'est pas une valeur SVG valide — un attribut
            SVG attend une longueur — et le navigateur le rejetait :

              Error: <svg> attribute height: Expected length, "auto"

            Le schéma s'affichait quand même, mais la console crachait une
            erreur à chaque rendu. Sur une démonstration où l'on ouvre les
            outils de développement, c'est le genre de détail qui fait
            douter du reste. */}
        {/* UN SEUL attribut `style`. En JSX, deux `style` sur le même
            élément ne fusionnent pas : le second écrase silencieusement
            le premier. La hauteur automatique était donc perdue, et le
            schéma retrouvait la déformation qu'on venait de corriger —
            sans erreur ni avertissement. */}
        <svg
          viewBox={`0 0 ${largeur} ${hauteur}`}
          width="100%"
          preserveAspectRatio="xMidYMid meet"
          className="mx-auto block max-w-full"
          style={{ height: "auto", minWidth: "18rem" }}
        >
          {/* Lignes de connexion */}
          {positions.map(({ eq, x, y }) => (
            <line
              key={`ligne-${eq.id_equipement}`}
              x1={centreX} y1={centreY} x2={x} y2={y}
              stroke="var(--color-line)"
              strokeWidth="1.5"
              strokeDasharray={eq.statut === "down" ? "4 4" : "none"}
            />
          ))}

          {/* Nœud central (passerelle) */}
          {passerelle && (
            <g>
              <circle cx={centreX} cy={centreY} r="26" fill="var(--color-signal)" />
              <text x={centreX} y={centreY + 45} textAnchor="middle" fontSize="12" fill="var(--color-ink)">
                {passerelle.nom || passerelle.adresse_ip}
              </text>
            </g>
          )}

          {/* Équipements autour */}
          {positions.map(({ eq, x, y }) => (
            <g
              key={eq.id_equipement}
              onMouseEnter={() => setSurvole(eq)}
              onMouseLeave={() => setSurvole(null)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={x} cy={y} r="12"
                fill={COULEUR_STATUT[eq.statut] || COULEUR_STATUT.inconnu}
                stroke={survole?.id_equipement === eq.id_equipement ? "var(--color-signal)" : "none"}
                strokeWidth="3"
              />
              {survole?.id_equipement === eq.id_equipement && (
                <text
                  x={x} y={y + 24}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--color-ink)"
                >
                  {(eq.nom || eq.adresse_ip).slice(0, 20)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>

      {survole && (
        <div className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-4 py-3 text-sm">
          <p className="text-[var(--color-ink)] font-medium">{survole.nom || survole.adresse_ip}</p>
          <p className="text-xs text-[var(--color-mute)] font-[var(--font-mono)]">{survole.adresse_ip}</p>
          <p className="text-xs text-[var(--color-mute)]">Fabricant : {survole.fabricant || "inconnu"} — Statut : {survole.statut}</p>
        </div>
      )}

      <div className="flex gap-4 text-xs text-[var(--color-mute)]">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COULEUR_STATUT.up }} /> En ligne</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COULEUR_STATUT.down }} /> Hors ligne</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: COULEUR_STATUT.inconnu }} /> Inconnu</span>
      </div>
    </div>
  );
}