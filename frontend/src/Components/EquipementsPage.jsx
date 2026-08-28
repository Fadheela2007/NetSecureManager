import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import StatusDot from "./StatusDot";
import Fabricant from "./Fabricant";
import EtatVide from "./EtatVide";
import EquipementDetail from "./EquipementDetail";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Convertit une adresse IPv4 en nombre, pour le tri.
 *
 * Trier des adresses comme du texte donne un ordre absurde :
 * 192.168.0.10 arrive avant 192.168.0.9, et 192.168.1.x s'intercale au
 * milieu de 192.168.10.x. Sur un parc rangé par plages, cet ordre-là
 * rend la liste inutilisable — or c'est précisément le tri qu'on
 * attend d'un outil réseau.
 */
function ipEnNombre(ip) {
  const parties = String(ip || "").split(".");
  if (parties.length !== 4) return -1;
  return parties.reduce((total, p) => total * 256 + (Number(p) || 0), 0);
}

/**
 * Filtres rapides par statut.
 *
 * « Que faut-il regarder maintenant » est la question posée neuf fois
 * sur dix en ouvrant cette page. Y répondre demandait de parcourir la
 * liste à l'œil ; c'est faisable à 44 lignes, pas à 500.
 */
const FILTRES_STATUT = [
  { cle: "tous", libelle: "Tous" },
  { cle: "down", libelle: "Hors ligne" },
  { cle: "up", libelle: "En ligne" },
  { cle: "inconnu", libelle: "État inconnu" },
];

/**
 * Nom à afficher, dans l'ordre de priorité.
 *
 * Le nom personnalisé prime sur tout, y compris sur SNMP : c'est une
 * décision humaine, elle l'emporte sur une découverte automatique.
 * À défaut, le nom découvert ; à défaut encore, rien — l'adresse IP est
 * déjà dans la colonne voisine, la répéter n'apprendrait rien.
 */
export function nomAffiche(eq) {
  if (!eq) return "";
  const perso = (eq.nom_personnalise || "").trim();
  if (perso) return perso;
  return (eq.nom || "").trim();
}

const COLONNES = [
  { cle: "statut", libelle: "Statut", triable: true },
  { cle: "nom", libelle: "Nom", triable: true },
  { cle: "adresse_ip", libelle: "Adresse IP", triable: true },
  { cle: "fabricant", libelle: "Fabricant", triable: true },
  { cle: "type_libelle", libelle: "Type", triable: true },
  { cle: "derniere_decouverte", libelle: "Dernière découverte", triable: true },
];

export default function EquipementsPage({ idSite }) {
  const [equipements, setEquipements] = useState([]);
  const [filtre, setFiltre] = useState("");
  const [statutChoisi, setStatutChoisi] = useState("tous");
  const [tri, setTri] = useState({ colonne: "adresse_ip", sens: "asc" });
  const [selection, setSelection] = useState(null);
  const [resolution, setResolution] = useState({ enCours: false, message: null });

  async function charger() {
    const { data } = await axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } });
    setEquipements(data);
  }

  useEffect(() => {
    charger().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  const compteurs = useMemo(
    () => ({
      tous: equipements.length,
      up: equipements.filter((e) => e.statut === "up").length,
      down: equipements.filter((e) => e.statut === "down").length,
      inconnu: equipements.filter((e) => e.statut === "inconnu").length,
    }),
    [equipements]
  );

  const visibles = useMemo(() => {
    const recherche = filtre.trim().toLowerCase();

    let liste = equipements.filter((eq) => {
      if (statutChoisi !== "tous" && eq.statut !== statutChoisi) return false;
      if (!recherche) return true;
      return (
        // Le nom personnalisé est cherché AUSSI : c'est celui que
        // l'utilisateur a écrit, donc celui qu'il tapera pour retrouver
        // sa machine — pas « KMBFD6FC ».
        (eq.nom_personnalise || "").toLowerCase().includes(recherche) ||
        (eq.nom || "").toLowerCase().includes(recherche) ||
        eq.adresse_ip.includes(recherche) ||
        (eq.fabricant || "").toLowerCase().includes(recherche) ||
        (eq.type_libelle || "").toLowerCase().includes(recherche)
      );
    });

    const { colonne, sens } = tri;
    const signe = sens === "asc" ? 1 : -1;

    liste = [...liste].sort((a, b) => {
      if (colonne === "adresse_ip") {
        return (ipEnNombre(a.adresse_ip) - ipEnNombre(b.adresse_ip)) * signe;
      }
      if (colonne === "derniere_decouverte") {
        return (
          (new Date(a.derniere_decouverte || 0) - new Date(b.derniere_decouverte || 0)) * signe
        );
      }
      if (colonne === "statut") {
        // Ordre par URGENCE, pas alphabétique : « down » avant
        // « inconnu » avant « up ». Un tri alphabétique placerait
        // « down » en premier par hasard, et « inconnu » avant « up »
        // sans raison — ici c'est voulu et stable.
        const rang = { down: 0, inconnu: 1, up: 2 };
        return ((rang[a.statut] ?? 3) - (rang[b.statut] ?? 3)) * signe;
      }
      // Les valeurs absentes finissent toujours EN BAS, quel que soit le
      // sens : une colonne vide n'est pas « plus petite », elle est
      // simplement sans information.
      //
      // La colonne « nom » se trie sur le nom AFFICHÉ, pas sur le champ
      // brut : trier sur `nom` alors que la ligne montre le nom
      // personnalisé donnerait un ordre sans rapport visible avec la
      // liste — le défaut le plus déroutant qui soit sur un tableau.
      const lire = (eq) =>
        (colonne === "nom" ? nomAffiche(eq) : eq[colonne] || "").toString().toLowerCase();
      const va = lire(a);
      const vb = lire(b);
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;
      return va.localeCompare(vb, "fr") * signe;
    });

    return liste;
  }, [equipements, filtre, statutChoisi, tri]);

  function basculerTri(colonne) {
    setTri((t) =>
      t.colonne === colonne
        ? { colonne, sens: t.sens === "asc" ? "desc" : "asc" }
        : { colonne, sens: "asc" }
    );
  }

  const sansFabricant = equipements.filter((e) => !e.fabricant).length;

  async function resoudreFabricants() {
    setResolution({ enCours: true, message: null });
    try {
      const { data } = await axios.post(`${API_URL}/equipements/resoudre-fabricants`);
      const details = [
        `${data.resolus} fabricant(s) identifié(s) sur ${data.examines} équipement(s)`,
        data.types_enrichis > 0 ? `${data.types_enrichis} type(s) précisé(s)` : null,
        data.mac_aleatoires > 0 ? `${data.mac_aleatoires} adresse(s) MAC aléatoire(s)` : null,
        data.oui_inconnus > 0 ? `${data.oui_inconnus} OUI absent(s) du registre` : null,
      ].filter(Boolean);
      setResolution({ enCours: false, message: details.join(" · ") });
      await charger();
    } catch (err) {
      setResolution({
        enCours: false,
        message: err.response?.data?.error || "Résolution impossible",
      });
    }
  }

  async function reclasserTypes() {
    setResolution({ enCours: true, message: null });
    try {
      const { data } = await axios.post(`${API_URL}/equipements/reclasser-types`);
      const details = [
        `${data.modifies} type(s) corrigé(s) sur ${data.examines} équipement(s)`,
        data.passes_en_inconnu > 0
          ? `${data.passes_en_inconnu} repassé(s) en « inconnu » (catégorie précédente non justifiée)`
          : null,
        data.sans_port_scanne > 0
          ? `${data.sans_port_scanne} sans port scanné — un nouveau scan les affinerait`
          : null,
      ].filter(Boolean);
      setResolution({ enCours: false, message: details.join(" · ") });
      await charger();
    } catch (err) {
      setResolution({
        enCours: false,
        message: err.response?.data?.error || "Reclassement impossible",
      });
    }
  }

  const filtreActif = filtre.trim() !== "" || statutChoisi !== "tous";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">Équipements</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            {equipements.length} équipement(s) sur ce site
            {sansFabricant > 0 && ` — ${sansFabricant} sans fabricant identifié`}
          </p>
        </div>

        <div className="flex gap-2 shrink-0 flex-wrap">
          {sansFabricant > 0 && (
            <button
              onClick={resoudreFabricants}
              disabled={resolution.enCours}
              title="Identifie les fabricants à partir des adresses MAC déjà connues, sans relancer de scan"
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
            >
              {resolution.enCours ? "Identification…" : "Identifier les fabricants"}
            </button>
          )}
          <button
            onClick={reclasserTypes}
            disabled={resolution.enCours}
            title="Recalcule la catégorie de chaque équipement à partir des données déjà collectées, sans relancer de scan"
            className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
          >
            {resolution.enCours ? "Reclassement…" : "Reclasser les types"}
          </button>
        </div>
      </div>

      {resolution.message && <p className="text-sm text-[var(--color-ok)]">{resolution.message}</p>}

      {/* ── FILTRES ──
          Les onglets de statut portent leur compteur : on voit d'un coup
          d'œil qu'il y a 15 machines hors ligne, sans avoir à cliquer
          pour le découvrir. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)]">
          {FILTRES_STATUT.map((f) => (
            <button
              key={f.cle}
              onClick={() => setStatutChoisi(f.cle)}
              className={`px-3 py-1.5 rounded-md text-sm transition cible-tactile ${
                statutChoisi === f.cle
                  ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-medium"
                  : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
              }`}
            >
              {f.libelle}
              <span className="ml-1.5 tabular-nums opacity-70">{compteurs[f.cle]}</span>
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Filtrer par nom, IP, fabricant ou type…"
          value={filtre}
          onChange={(e) => setFiltre(e.target.value)}
          className="flex-1 min-w-[14rem] max-w-sm bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition"
        />

        {filtreActif && (
          <button
            onClick={() => {
              setFiltre("");
              setStatutChoisi("tous");
            }}
            className="text-xs text-[var(--color-mute)] hover:text-[var(--color-ink)] transition cible-tactile"
          >
            Tout afficher
          </button>
        )}
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        {visibles.length === 0 ? (
          // Deux vides très différents : « le filtre ne rend rien » se
          // corrige en effaçant le filtre, « le parc est vide » demande
          // un scan. Les confondre envoyait l'utilisateur au mauvais
          // endroit.
          equipements.length > 0 ? (
            <EtatVide
              titre="Aucun équipement ne correspond au filtre"
              explication={`Le parc en compte ${equipements.length}, mais aucun ne correspond à votre recherche.`}
              action={{
                libelle: "Effacer le filtre",
                onClick: () => {
                  setFiltre("");
                  setStatutChoisi("tous");
                },
              }}
            />
          ) : (
            <EtatVide
              titre="Le parc est vide"
              ton="etape"
              explication="Aucun équipement n'a encore été découvert sur ce site. Un scan réseau les trouvera automatiquement."
              aide="Le scan se lance depuis le tableau de bord. Comptez une minute pour une plage /24."
            />
          )
        ) : (
          <>
            {filtreActif && (
              <p className="text-xs text-[var(--color-mute)] mb-3">
                {visibles.length} sur {equipements.length} affiché(s)
              </p>
            )}

            <div className="table-scroll max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                {/* En-tête collant : sur 500 lignes, on perd sinon le nom
                    des colonnes dès le premier défilement, et on ne sait
                    plus ce qu'on regarde. */}
                <thead className="sticky top-0 bg-[var(--color-surface)] z-10">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                    {/* `pr-4` : sans espacement horizontal, les libellés se
                        touchent et se lisent comme un seul mot — l'en-tête
                        affichait « STATUTNOM ». Le padding vertical seul ne
                        suffit pas, une cellule de tableau n'a pas de marge
                        par défaut. */}
                    {COLONNES.map((c) => (
                      <th key={c.cle} className="pb-2 pt-1 pr-4 font-medium whitespace-nowrap">
                        <button
                          onClick={() => basculerTri(c.cle)}
                          className="flex items-center gap-1 hover:text-[var(--color-ink)] transition uppercase"
                        >
                          {c.libelle}
                          {/* La flèche n'apparaît que sur la colonne
                              triée : six flèches grises en permanence
                              deviennent du bruit. */}
                          {tri.colonne === c.cle && (
                            <span className="text-[var(--color-signal)]">
                              {tri.sens === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {visibles.map((eq) => (
                    <tr
                      key={eq.id_equipement}
                      onClick={() => setSelection(eq)}
                      className="cursor-pointer hover:bg-[var(--color-surface-2)] transition"
                    >
                      <td className="py-2.5 pr-4">
                        <StatusDot status={eq.statut} />
                      </td>
                      {/* Le nom technique est conservé en second quand un
                          nom personnalisé le masque : pour diagnostiquer,
                          c'est « KMBFD6FC » qui compte, pas « Imprimante
                          comptabilité ». Les deux informations sont
                          utiles, à des moments différents. */}
                      <td className="py-2.5 pr-4">
                        {nomAffiche(eq) ? (
                          <>
                            <span>{nomAffiche(eq)}</span>
                            {eq.nom_personnalise && eq.nom && (
                              <span className="block text-xs text-[var(--color-mute)] font-[var(--font-mono)]">
                                {eq.nom}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2.5 pr-4 font-[var(--font-mono)] text-[13px] whitespace-nowrap">
                        {eq.adresse_ip}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-mute)]">
                        <Fabricant nom={eq.fabricant} source={eq.fabricant_source} />
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-mute)]">{eq.type_libelle || "—"}</td>
                      <td className="py-2.5 text-[var(--color-mute)] text-xs whitespace-nowrap">
                        {eq.derniere_decouverte
                          ? new Date(eq.derniere_decouverte).toLocaleString("fr-FR")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {selection && (
        <EquipementDetail
          equipement={selection}
          onClose={() => setSelection(null)}
          /* La liste est mise à jour sur place plutôt que rechargée
             depuis le serveur : recharger tout le parc pour un seul nom
             modifié ferait clignoter la page et perdrait le tri et le
             défilement en cours. */
          onRenomme={(id, nom) => {
            setEquipements((liste) =>
              liste.map((eq) =>
                eq.id_equipement === id ? { ...eq, nom_personnalise: nom } : eq
              )
            );
            setSelection((eq) => (eq ? { ...eq, nom_personnalise: nom } : eq));
          }}
        />
      )}
    </div>
  );
}
