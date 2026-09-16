import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import StatusDot from "./StatusDot";
import Fabricant from "./Fabricant";
import EtatVide from "./EtatVide";
import { decrireErreur } from "../utils/erreurReseau";
import EquipementDetail from "./EquipementDetail";

import { brancherRafraichissement } from "../utils/tempsReel";

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
  /* Non triable, et c'est délibéré : trier des listes de ports par ordre
     alphabétique de leur chaîne n'aurait aucun sens utile. Pour chercher
     un port précis, le champ de filtre au-dessus du tableau le trouve. */
  { cle: "ports", libelle: "Ports ouverts", triable: false },
  { cle: "derniere_decouverte", libelle: "Dernière découverte", triable: true },
];

/**
 * Les ports d'un équipement, dans une case de tableau.
 *
 * LE NUMÉRO EST AFFICHÉ, LE NOM EST EN INFOBULLE. Écrire « 443/HTTPS »
 * cent fois remplirait la colonne d'une information que celui qui la lit
 * connaît déjà ; le numéro seul se compare d'une ligne à l'autre d'un
 * coup d'œil, et le nom reste à portée de souris pour les ports qu'on ne
 * reconnaît pas.
 *
 * Cinq ports affichés, le reste compté. Une machine qui en expose vingt
 * déborderait sur toute la largeur de l'écran — et le fait qu'elle en
 * expose vingt est, à lui seul, l'information à voir.
 *
 * Un tiret, enfin, veut dire « aucun port ouvert détecté », pas
 * « inconnu » : le scan a bien regardé.
 */
function Ports({ valeur }) {
  const liste = String(valeur || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [port, ...reste] = p.split("/");
      const nom = reste.join("/");
      return { port, nom: nom && nom !== "?" ? nom : null };
    });

  if (liste.length === 0) return <span className="text-[var(--color-mute)]">—</span>;

  const montres = liste.slice(0, 5);
  const resume = liste.map((s) => (s.nom ? `${s.port} ${s.nom}` : s.port)).join(" · ");

  return (
    <span className="flex flex-wrap gap-1 items-center">
      {montres.map((s) => (
        <span
          key={s.port}
          title={s.nom ? `${s.nom} — port ${s.port}` : `port ${s.port}`}
          className="font-[var(--font-mono)] text-[11px] px-1.5 py-0.5 rounded border border-[var(--color-line)] text-[var(--color-mute)]"
        >
          {s.port}
        </span>
      ))}
      {liste.length > montres.length && (
        <span className="text-[11px] text-[var(--color-mute)]" title={resume}>
          +{liste.length - montres.length}
        </span>
      )}
    </span>
  );
}

export default function EquipementsPage({ idSite }) {
  const [equipements, setEquipements] = useState([]);
  const [filtre, setFiltre] = useState("");
  const [statutChoisi, setStatutChoisi] = useState("tous");
  const [tri, setTri] = useState({ colonne: "adresse_ip", sens: "asc" });
  const [selection, setSelection] = useState(null);
  const [resolution, setResolution] = useState({ enCours: false, message: null });
  // Provenance du registre des fabricants (GET /oui/etat).
  const [etatOui, setEtatOui] = useState(null);

  /**
   * Échec de chargement.
   *
   * Sans cet état, `charger().catch(() => {})` laissait la liste vide et
   * l'écran affichait « Aucun équipement — lancez un scan ». Un serveur
   * arrêté produisait donc le même message qu'un parc jamais scanné, et
   * l'utilisateur partait lancer un scan qui ne pouvait pas aboutir.
   */
  const [erreur, setErreur] = useState(null);
  const [chargement, setChargement] = useState(true);

  async function charger() {
    const { data } = await axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } });
    setEquipements(data);
  }

  function rafraichir() {
    setChargement(true);
    setErreur(null);
    charger()
      .catch((err) => setErreur(decrireErreur(err, "La liste des équipements")))
      .finally(() => setChargement(false));
  }

  // Rafraîchissement automatique : événements du serveur, plus une
  // scrutation de secours si le temps réel n'est pas activé côté serveur.
  // Silencieux — pas d'indicateur de chargement, l'écran garde ses données.
  // SILENCIEUX : on appelle `charger` et non `rafraichir`. `rafraichir`
  // repasse par « Chargement… », ce qui ferait clignoter la liste toutes
  // les minutes et donnerait l'impression d'une plateforme instable. Une
  // erreur de rafraîchissement est ignorée : garder à l'écran la liste
  // d'il y a une minute vaut mieux que la remplacer par un message
  // d'erreur alors que rien n'est perdu.
  useEffect(
    () =>
      brancherRafraichissement(
        () => charger().catch(() => {}),
        ["cycle", "scan", "equipement"]
      ),
    []
  );

  useEffect(() => {
    rafraichir();
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
        (eq.type_libelle || "").toLowerCase().includes(recherche) ||
        /* Les ports sont cherchés aussi, par numéro comme par nom :
           taper « 445 » donne toutes les machines qui l'exposent, taper
           « rdp » toutes celles qui laissent le bureau à distance
           ouvert. C'est la question qu'on se pose vraiment devant un
           parc, et elle n'avait pas de réponse en un geste. */
        (eq.ports || "").toLowerCase().includes(recherche)
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

  /* ÉTAT DU REGISTRE DES FABRICANTS.

     Quand des équipements restent « sans fabricant », la question suivante
     est toujours la même : le registre est-il chargé, et d'où vient-il ?
     La réponse existait — GET /oui/etat — et n'était affichée nulle part.

     Chargé seulement quand il manque des fabricants : sur un parc complet,
     ce détail n'apprend rien et n'a pas à occuper l'écran. */
  useEffect(() => {
    if (sansFabricant === 0) { setEtatOui(null); return; }
    axios
      .get(`${API_URL}/oui/etat`)
      .then(({ data }) => setEtatOui(data))
      // Diagnostic facultatif : son absence ne doit pas être signalée
      // comme une panne de la page.
      .catch(() => setEtatOui(null));
  }, [sansFabricant]);

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

      {/* D'OÙ VIENNENT LES FABRICANTS.
          « Graine embarquée » signifie que la table OUI_FABRICANT est vide :
          le registre fonctionne, mais avec la liste livrée avec le produit,
          plus ancienne que celle de l'IEEE. C'est la première chose à
          vérifier quand des fabricants restent inconnus — et la réponse
          était disponible sans être affichée. */}
      {etatOui && (
        <p className="text-xs text-[var(--color-mute)]">
          Registre des fabricants : {Number(etatOui.entrees || 0).toLocaleString("fr-FR")}{" "}
          entrées — {etatOui.origine}
          {String(etatOui.origine || "").includes("graine") && (
            <span className="block mt-0.5">
              Pour une liste à jour : <span className="font-[var(--font-mono)]">node tools/importer-oui.js</span> côté serveur.
            </span>
          )}
        </p>
      )}

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
        {chargement ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement…</p>
        ) : erreur ? (
          /* TROISIÈME vide, celui qui manquait : « je ne sais pas ».
             Sans lui, un serveur arrêté affichait « Le parc est vide —
             lancez un scan », et l'utilisateur allait lancer un scan qui
             ne pouvait pas aboutir. */
          <EtatVide
            titre={erreur.titre}
            ton="etape"
            explication={erreur.detail}
            action={{ libelle: "Réessayer", onClick: rafraichir }}
          />
        ) : visibles.length === 0 ? (
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
                {/* LE FOND VA SUR LES CELLULES, PAS SUR <thead>.

                    Un tableau se rend avec `border-collapse: collapse`
                    (c'est ce que pose la base de Tailwind). Dans ce mode,
                    plusieurs navigateurs — Firefox, et Chrome avant la
                    version 91 — NE PEIGNENT PAS le fond déclaré sur
                    <thead> ni sur <tr>. La règle est écrite, elle est
                    même lue par les outils de développement, et rien ne
                    s'affiche.

                    Combiné à `position: sticky`, le résultat est
                    exactement le symptôme observé : l'en-tête reste en
                    place, transparent, et les lignes du tableau défilent
                    DERRIÈRE les titres. Les deux textes se superposent et
                    l'en-tête devient illisible — on croit que les
                    colonnes ont disparu.

                    Le fond posé sur chaque <th> est peint partout, sans
                    exception. C'est le contournement habituel des
                    en-têtes collants, et il ne coûte rien. */}
                <thead className="sticky top-0 z-10">
                  <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                    {/* `pr-4` : sans espacement horizontal, les libellés se
                        touchent et se lisent comme un seul mot — l'en-tête
                        affichait « STATUTNOM ». Le padding vertical seul ne
                        suffit pas, une cellule de tableau n'a pas de marge
                        par défaut. */}
                    {COLONNES.map((c) => (
                      <th
                        key={c.cle}
                        className="bg-[var(--color-surface)] pb-2 pt-1 pr-4 font-medium whitespace-nowrap"
                      >
                        {/* Une colonne non triable ne porte pas de bouton :
                            un en-tête qui a l'air cliquable et ne fait rien
                            est pire qu'un en-tête inerte. */}
                        {c.triable === false ? (
                          <span className="uppercase">{c.libelle}</span>
                        ) : (
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
                        )}
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
                        ) : eq.fabricant ? (
                          /* PAS DE NOM ? ON MONTRE CE QU'ON SAIT.

                             Sur un réseau d'entreprise, la plupart des
                             machines ont un nom : SNMP, DNS inverse ou
                             NetBIOS en fournissent un. Sur un réseau où
                             ces trois-là sont absents — un wifi domestique,
                             un VLAN invité, un parc de téléphones — la
                             colonne se remplissait de tirets, et l'écran
                             donnait l'impression que le scan avait échoué
                             alors qu'il avait tout trouvé.

                             Le fabricant, lui, est connu : il vient de
                             l'adresse matérielle, qu'aucun appareil ne peut
                             cacher. « Appareil Samsung » ne dit pas QUI
                             c'est, mais dit CE QUE c'est — et c'est déjà ce
                             qu'on cherche en parcourant une liste.

                             ÉCRIT EN GRIS ET EN ITALIQUE, DÉLIBÉRÉMENT.
                             Ce n'est pas un nom de machine : c'est un
                             repère. La distinction doit rester visible à
                             l'œil, sinon on croit que l'appareil s'appelle
                             ainsi. Et rien n'est écrit en base — la colonne
                             `nom` reste vide, la recherche et le tri
                             continuent de porter sur les vrais noms. */
                          <span className="italic text-[var(--color-mute)]">
                            Appareil {eq.fabricant}
                          </span>
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
                      <td className="py-2.5 pr-4">
                        <Ports valeur={eq.ports} />
                      </td>
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
