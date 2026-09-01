import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Réinitialisation des données de supervision.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PARTI PRIS : CET ÉCRAN DOIT ÊTRE ENNUYEUX.
 *
 * C'est la seule fonction de la plateforme qui détruit des données. Tout
 * ce qui la rendrait agréable à utiliser — un gros bouton, une couleur
 * franche, une confirmation en un clic — augmente la probabilité d'un
 * accident.
 *
 * D'où trois frictions volontaires :
 *   1. rien n'est coché au départ ;
 *   2. l'écran annonce les VOLUMES réels avant d'agir, pas des libellés
 *      abstraits — « 1 247 alertes » arrête la main, « les alertes » non ;
 *   3. il faut recopier un mot à la main.
 *
 * La liste de ce qui n'est jamais touché vient du SERVEUR et non du
 * code de cette page : une promesse d'interface que le serveur ne
 * garantit pas n'est qu'un affichage rassurant.
 * ─────────────────────────────────────────────────────────────────────
 */
export default function Reinitialisation() {
  const [apercu, setApercu] = useState(null);
  const [choisies, setChoisies] = useState(new Set());
  const [phrase, setPhrase] = useState("");
  const [enCours, setEnCours] = useState(false);
  const [resultat, setResultat] = useState(null);
  const [erreur, setErreur] = useState(null);
  const [ouvert, setOuvert] = useState(false);
  // "" = tous les sites autorisés ; sinon l'identifiant d'un site précis.
  const [siteVise, setSiteVise] = useState("");

  const charger = (site = siteVise) => {
    axios
      .get(`${API_URL}/reinitialisation/apercu`, {
        params: site === "" ? {} : { id_site: site },
      })
      .then(({ data }) => setApercu(data))
      .catch((e) => setErreur(e.response?.data?.error || "Aperçu indisponible"));
  };

  useEffect(() => {
    if (ouvert) charger();
    // Les volumes affichés dépendent du site visé : changer de site sans
    // recharger l'aperçu ferait valider des chiffres qui ne correspondent
    // plus à ce qui sera effacé.
  }, [ouvert, siteVise]);

  const CIBLES = [
    {
      cle: "alertes",
      libelle: "Alertes",
      detail: "Toutes les alertes, y compris résolues et acquittées.",
      consequence: "Le taux de disponibilité historique repart de zéro.",
    },
    {
      cle: "incidents",
      libelle: "Incidents",
      detail: "Les incidents ouverts et fermés.",
      consequence: "Les incidents sont liés aux alertes : effacez les deux ensemble.",
    },
    {
      cle: "releves",
      libelle: "Relevés de performance",
      detail: "Processeur, mémoire, latence, débit.",
      consequence: "Les graphiques et la page Bande passante se vident.",
    },
    {
      cle: "equipements",
      libelle: "Équipements découverts",
      detail: "Le parc entier, avec ses ports et ses interfaces.",
      consequence: "Efface aussi les relevés, alertes et incidents rattachés.",
    },
    {
      cle: "journal",
      libelle: "Journal d'activité",
      detail: "L'historique des connexions et des actions.",
      consequence: "Réservé à un administrateur global.",
    },
  ];

  function basculer(cle) {
    const s = new Set(choisies);
    if (s.has(cle)) s.delete(cle);
    else s.add(cle);

    // Effacer les équipements emporte forcément le reste : on coche les
    // dépendances plutôt que de laisser croire qu'on peut garder des
    // alertes rattachées à des équipements supprimés.
    if (cle === "equipements" && s.has("equipements")) {
      s.add("alertes");
      s.add("incidents");
      s.add("releves");
    }
    setChoisies(s);
  }

  async function executer() {
    setEnCours(true);
    setErreur(null);
    try {
      const { data } = await axios.post(`${API_URL}/reinitialisation`, {
        confirmation: phrase.trim(),
        cibles: [...choisies],
        // Omis quand aucun site n'est visé : le serveur retombe alors sur
        // la portée du compte. Envoyer null signifierait « tous », ce qui
        // n'est pas la même chose pour un administrateur rattaché.
        ...(siteVise === "" ? {} : { id_site: Number(siteVise) }),
      });
      setResultat(data);
      setChoisies(new Set());
      setPhrase("");
      charger();
    } catch (e) {
      setErreur(e.response?.data?.aide || e.response?.data?.error || "Échec de la réinitialisation");
    } finally {
      setEnCours(false);
    }
  }

  const total = apercu
    ? [...choisies].reduce((s, c) => s + (Number(apercu.apercu?.[c]) || 0), 0)
    : 0;
  const pretAValider = choisies.size > 0 && phrase.trim() === (apercu?.phrase_attendue || "REINITIALISER");

  if (!ouvert) {
    return (
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 md:p-5">
        <h2 className="text-sm font-medium text-[var(--color-ink)]">
          Réinitialiser les données de supervision
        </h2>
        <p className="text-sm text-[var(--color-mute)] mt-1 max-w-2xl">
          Repart d'un parc vide pour relancer un scan propre. Utile après un essai :
          sans cela, les équipements disparus et les alertes accumulées restent
          affichés et brouillent la lecture.
        </p>
        <button
          onClick={() => setOuvert(true)}
          className="mt-3 px-4 py-2 rounded-lg border border-[var(--color-line)] text-sm text-[var(--color-mute)] hover:border-[var(--color-crit)] hover:text-[var(--color-crit)] transition cible-tactile"
        >
          Ouvrir la réinitialisation
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-crit)]/40 bg-[var(--color-surface)] p-4 md:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--color-crit)]">
            Réinitialisation — action irréversible
          </h2>
          <p className="text-xs text-[var(--color-mute)] mt-0.5">
            Portée : {apercu?.portee || "…"}
          </p>
        </div>
        <button
          onClick={() => {
            setOuvert(false);
            setChoisies(new Set());
            setPhrase("");
            setResultat(null);
          }}
          className="text-sm text-[var(--color-mute)] hover:text-[var(--color-ink)] transition"
        >
          Fermer
        </button>
      </div>

      {resultat && (
        <div className="rounded-lg border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 px-4 py-3 text-sm">
          <p className="text-[var(--color-ok)] font-medium">Réinitialisation effectuée.</p>
          <ul className="text-[var(--color-mute)] mt-1 space-y-0.5">
            {Object.entries(resultat.supprime).map(([cle, n]) => (
              <li key={cle}>
                {n.toLocaleString("fr-FR")} {cle} supprimé(s)
              </li>
            ))}
          </ul>
          <p className="text-[var(--color-ink)] mt-2">{resultat.suite}</p>
        </div>
      )}

      {erreur && (
        <div className="rounded-lg border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 px-4 py-3 text-sm text-[var(--color-crit)]">
          {erreur}
        </div>
      )}

      {/* Ce qui est protégé — annoncé AVANT les cases à cocher. C'est la
          première inquiétude de quelqu'un qui découvre ce bouton : « est-ce
          que je vais perdre mes comptes et devoir tout réinstaller ? » */}
      {apercu?.jamais_efface && (
        <div className="rounded-lg bg-[var(--color-surface-2)] px-4 py-3">
          <p className="text-xs text-[var(--color-ink)] font-medium mb-1">
            Jamais touché, quelles que soient vos cases :
          </p>
          <ul className="text-xs text-[var(--color-mute)] space-y-0.5">
            {apercu.jamais_efface.map((x) => (
              <li key={x}>· {x}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Choix du site — AVANT les cases, parce qu'il change les volumes
          affichés en dessous. Le proposer après reviendrait à faire lire
          des chiffres qui ne correspondent pas à ce qui sera effacé.

          N'apparaît qu'à partir de deux sites : sur une installation
          mono-site, ce menu n'aurait qu'une entrée et n'ajouterait qu'une
          décision inutile à l'écran le plus dangereux de la plateforme. */}
      {(apercu?.sites?.length || 0) > 1 && (
        <label className="block rounded-lg bg-[var(--color-surface-2)] px-4 py-3">
          <span className="block text-xs text-[var(--color-ink)] font-medium mb-1.5">
            Sur quel site ?
          </span>
          <select
            value={siteVise}
            onChange={(e) => {
              setSiteVise(e.target.value);
              // Changer de cible remet les cases et la phrase à zéro : une
              // confirmation déjà saisie ne doit jamais s'appliquer à un
              // site qu'on vient de choisir.
              setChoisies(new Set());
              setPhrase("");
              setResultat(null);
            }}
            className="w-full sm:w-80 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-crit)] transition"
          >
            <option value="">
              Tous les sites ({apercu.sites.reduce((s, x) => s + x.equipements, 0)} équipements)
            </option>
            {apercu.sites.map((s) => (
              <option key={s.id_site} value={s.id_site}>
                {s.nom} — {s.ville} ({s.equipements} équipements)
              </option>
            ))}
          </select>
          <span className="block text-xs text-[var(--color-mute)] mt-1.5">
            Les autres sites ne sont pas touchés.
          </span>
        </label>
      )}

      <div className="space-y-2">
        {CIBLES.map((c) => {
          const n = apercu?.apercu?.[c.cle];
          const indisponible = n === null || n === undefined;
          return (
            <label
              key={c.cle}
              className={`flex gap-2.5 items-start p-3 rounded-lg border transition ${
                indisponible
                  ? "border-[var(--color-line)] opacity-40"
                  : choisies.has(c.cle)
                  ? "border-[var(--color-crit)]/50 bg-[var(--color-crit)]/5 cursor-pointer"
                  : "border-[var(--color-line)] hover:border-[var(--color-crit)]/40 cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                disabled={indisponible}
                checked={choisies.has(c.cle)}
                onChange={() => basculer(c.cle)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-[var(--color-ink)]">{c.libelle}</span>
                  {/* Le VOLUME, pas le libellé. « 1 247 alertes » arrête la
                      main d'une façon que « les alertes » n'obtient jamais. */}
                  <span className="text-sm tabular-nums text-[var(--color-crit)] shrink-0">
                    {indisponible ? "—" : `${Number(n).toLocaleString("fr-FR")} ligne(s)`}
                  </span>
                </span>
                <span className="block text-xs text-[var(--color-mute)]">{c.detail}</span>
                <span className="block text-xs text-[var(--color-warn)] mt-0.5">
                  {c.consequence}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="pt-1 space-y-2">
        <label className="block">
          <span className="block text-xs text-[var(--color-mute)] mb-1">
            Pour confirmer, recopiez{" "}
            <code className="text-[var(--color-ink)]">{apercu?.phrase_attendue || "REINITIALISER"}</code>
          </span>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={apercu?.phrase_attendue || "REINITIALISER"}
            className="w-full sm:w-72 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-crit)] transition"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={executer}
            disabled={!pretAValider || enCours}
            className="px-4 py-2 rounded-lg bg-[var(--color-crit)] text-[var(--color-sur-accent)] text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition cible-tactile"
          >
            {enCours ? "Suppression…" : "Supprimer définitivement"}
          </button>
          {choisies.size > 0 && (
            <span className="text-sm text-[var(--color-mute)]">
              {total.toLocaleString("fr-FR")} ligne(s) seront supprimées.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
