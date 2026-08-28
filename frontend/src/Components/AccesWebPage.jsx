import { useEffect, useState, useCallback } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Écran de contrôle des accès web.
 *
 * Trois partis pris d'affichage, chacun destiné à éviter une mauvaise
 * surprise devant un client :
 *
 * 1. Une catégorie cochée mais VIDE est signalée. Sans cela, l'écran
 *    afficherait une case cochée rassurante pour un blocage inexistant.
 * 2. L'état réel remonté par l'agent est affiché à part de l'état
 *    souhaité. « Enregistré » et « appliqué » ne sont pas la même chose.
 * 3. Les règles de pare-feu sont mises en avant, pas cachées dans une
 *    documentation : sans elles, tout se contourne en trente secondes.
 */
export default function AccesWebPage({ idSite }) {
  const [categories, setCategories] = useState([]);
  const [politique, setPolitique] = useState(null);
  const [manuelles, setManuelles] = useState([]);
  const [apercu, setApercu] = useState(null);
  const [choisies, setChoisies] = useState(new Set());
  const [nom, setNom] = useState("Politique par défaut");
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  const [chargement, setChargement] = useState(true);
  const [indisponible, setIndisponible] = useState(null);
  const [retour, setRetour] = useState(null);
  const [nouveauDomaine, setNouveauDomaine] = useState("");
  const [nouvelleAction, setNouvelleAction] = useState("bloquer");
  const [nouveauCommentaire, setNouveauCommentaire] = useState("");
  const [ongletPareFeu, setOngletPareFeu] = useState("iptables");

  const charger = useCallback(async () => {
    setChargement(true);
    setIndisponible(null);
    try {
      const [cats, pol, ap] = await Promise.all([
        axios.get(`${API_URL}/acces-web/categories`),
        axios.get(`${API_URL}/acces-web/politique`, { params: { id_site: idSite } }),
        axios.get(`${API_URL}/acces-web/apercu`, { params: { id_site: idSite } }).catch(() => ({ data: null })),
      ]);

      setCategories(cats.data);
      setApercu(ap.data);

      const p = pol.data.politique;
      setPolitique(p);
      setManuelles(pol.data.manuelles || []);
      setChoisies(new Set((pol.data.categories || []).map((c) => c.id_categorie)));
      if (p) {
        setNom(p.nom);
        setActive(!!p.active);
        setMessage(p.message_blocage || "");
      }
    } catch (err) {
      if (err.response?.status === 503) {
        setIndisponible(err.response.data);
      } else {
        setRetour({ type: "erreur", texte: err.response?.data?.error || "Chargement impossible" });
      }
    } finally {
      setChargement(false);
    }
  }, [idSite]);

  useEffect(() => {
    charger();
  }, [charger]);

  async function enregistrer() {
    try {
      await axios.put(`${API_URL}/acces-web/politique`, {
        id_site: idSite || null,
        nom,
        active,
        message_blocage: message || null,
        categories: [...choisies],
      });
      setRetour({
        type: "ok",
        texte: "Politique enregistrée. Les agents l'appliqueront à leur prochain cycle (5 min).",
      });
      charger();
    } catch (err) {
      setRetour({ type: "erreur", texte: err.response?.data?.error || "Enregistrement impossible" });
    }
  }

  async function ajouterDomaine() {
    if (!politique) {
      setRetour({ type: "erreur", texte: "Enregistrez d'abord la politique." });
      return;
    }
    try {
      await axios.post(`${API_URL}/acces-web/politique/${politique.id_politique}/domaine`, {
        domaine: nouveauDomaine,
        action: nouvelleAction,
        commentaire: nouveauCommentaire || null,
      });
      setNouveauDomaine("");
      setNouveauCommentaire("");
      charger();
    } catch (err) {
      setRetour({
        type: "erreur",
        texte: err.response?.data?.aide || err.response?.data?.error || "Ajout impossible",
      });
    }
  }

  async function supprimerDomaine(idRegle) {
    // L'échec était avalé, puis `charger()` réaffichait la règle
    // toujours présente. L'utilisateur voyait sa suppression annulée
    // sans un mot, cliquait à nouveau, et concluait que le bouton ne
    // marchait pas. Sur une règle de blocage web, croire une règle
    // supprimée alors qu'elle est active n'est pas un détail.
    try {
      await axios.delete(`${API_URL}/acces-web/domaine/${idRegle}`);
    } catch (err) {
      setMessage({
        type: "erreur",
        texte:
          err.response?.data?.error ||
          "Suppression impossible — la règle est toujours active.",
      });
    }
    charger();
  }

  function basculer(id) {
    const s = new Set(choisies);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setChoisies(s);
  }

  if (chargement) {
    return <p className="text-sm text-[var(--color-mute)]">Chargement…</p>;
  }

  if (indisponible) {
    return (
      <div className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-6">
        <h2 className="font-semibold text-[var(--color-ink)]">Fonction non installée</h2>
        <p className="text-sm text-[var(--color-mute)] mt-2">{indisponible.aide}</p>
      </div>
    );
  }

  const totalDomaines = apercu?.total_domaines_categories ?? 0;
  const categoriesVidesChoisies = categories.filter(
    (c) => choisies.has(c.id_categorie) && Number(c.nb_domaines) === 0
  );

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-ink)]">Accès web</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Blocage par DNS, appliqué par l'agent du site.
        </p>
      </div>

      {/*
        Bandeau de confidentialité. Il n'est pas décoratif : c'est la
        première question que pose un acheteur, et la première que pose un
        représentant du personnel. Y répondre avant qu'elle soit posée
        vaut mieux que de chercher ses mots en réunion.
      */}
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-sm">
        <span className="text-[var(--color-ink)] font-medium">
          Aucun historique de navigation n'est conservé.
        </span>{" "}
        <span className="text-[var(--color-mute)]">
          La plateforme ne peut pas dire quels sites une personne a consultés : ni
          l'adresse du poste, ni le domaine demandé ne sont enregistrés. Seul un
          total quotidien de requêtes bloquées est remonté.
        </span>
      </div>

      {retour && (
        <div
          className={`rounded-lg px-4 py-3 text-sm border ${
            retour.type === "ok"
              ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 text-[var(--color-ok)]"
              : "border-[var(--color-crit)]/40 bg-[var(--color-crit)]/10 text-[var(--color-crit)]"
          }`}
        >
          {retour.texte}
        </div>
      )}

      {/* ── État réel remonté par l'agent ─────────────────────────── */}
      {politique && (
        <EtatApplication politique={politique} apercu={apercu} />
      )}

      {/* ── Réglages ──────────────────────────────────────────────── */}
      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex-1 min-w-[14rem]">
            <span className="block text-xs uppercase tracking-wide text-[var(--color-mute)] mb-1">
              Nom de la politique
            </span>
            <input
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)]"
            />
          </label>

          <label className="flex items-center gap-2 cursor-pointer cible-tactile">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span className="text-sm text-[var(--color-ink)]">Politique active</span>
          </label>
        </div>

        <div>
          <h2 className="text-sm font-medium text-[var(--color-ink)] mb-2">Catégories bloquées</h2>
          <div className="grid sm:grid-cols-2 gap-2">
            {categories.map((c) => {
              const vide = Number(c.nb_domaines) === 0;
              return (
                <label
                  key={c.id_categorie}
                  className="flex gap-2.5 items-start p-3 rounded-lg border border-[var(--color-line)] hover:border-[var(--color-signal)]/50 transition cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={choisies.has(c.id_categorie)}
                    onChange={() => basculer(c.id_categorie)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-[var(--color-ink)]">{c.libelle}</span>
                    <span className="block text-xs text-[var(--color-mute)]">{c.description}</span>
                    <span className="block text-xs mt-1">
                      {vide ? (
                        // Le point qui évite de croire qu'on bloque
                        // quelque chose alors qu'on ne bloque rien.
                        <span className="text-[var(--color-warn)]">
                          Aucune liste importée — cette catégorie ne bloque rien
                        </span>
                      ) : (
                        <span className="text-[var(--color-mute)]">
                          {Number(c.nb_domaines).toLocaleString("fr-FR")} domaines
                          {c.date_import &&
                            ` · importés le ${new Date(c.date_import).toLocaleDateString("fr-FR")}`}
                        </span>
                      )}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {categoriesVidesChoisies.length > 0 && (
            <p className="text-xs text-[var(--color-warn)] mt-2">
              {categoriesVidesChoisies.length} catégorie(s) cochée(s) sans liste importée. Pour les
              remplir : <code className="text-[var(--color-ink)]">node tools\importer-listes-web.js &lt;catégorie&gt; &lt;fichier&gt;</code>
            </p>
          )}
        </div>

        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-[var(--color-mute)] mb-1">
            Message affiché à l'utilisateur bloqué
          </span>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ce site est bloqué par la politique de l'entreprise. Contactez le service informatique."
            className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)]"
          />
          <span className="block text-xs text-[var(--color-mute)] mt-1">
            Un message clair évite une bonne partie des tickets « internet ne marche pas ».
          </span>
        </label>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-sm text-[var(--color-mute)]">
            {totalDomaines > 0
              ? `${totalDomaines.toLocaleString("fr-FR")} domaines dans les catégories sélectionnées`
              : "Aucun domaine dans les catégories sélectionnées"}
          </span>
          <button
            onClick={enregistrer}
            className="px-4 py-2 rounded-lg bg-[var(--color-signal)] text-[var(--color-sur-accent)] text-sm font-medium hover:opacity-90 transition cible-tactile"
          >
            Enregistrer
          </button>
        </div>
      </section>

      {/* ── Exceptions et ajouts manuels ──────────────────────────── */}
      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 md:p-5 space-y-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--color-ink)]">Règles manuelles</h2>
          <p className="text-xs text-[var(--color-mute)] mt-0.5">
            Une règle manuelle l'emporte toujours sur une catégorie. La plus précise gagne :
            bloquer <code>exemple.com</code> puis autoriser <code>boutique.exemple.com</code> fonctionne.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            value={nouveauDomaine}
            onChange={(e) => setNouveauDomaine(e.target.value)}
            placeholder="exemple.com"
            className="flex-1 min-w-[12rem] bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)]"
          />
          <select
            value={nouvelleAction}
            onChange={(e) => setNouvelleAction(e.target.value)}
            className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none"
          >
            <option value="bloquer">Bloquer</option>
            <option value="autoriser">Autoriser</option>
          </select>
          <input
            value={nouveauCommentaire}
            onChange={(e) => setNouveauCommentaire(e.target.value)}
            placeholder="Pourquoi ? (utile dans six mois)"
            className="flex-1 min-w-[12rem] bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none"
          />
          <button
            onClick={ajouterDomaine}
            disabled={!nouveauDomaine.trim()}
            className="px-4 py-2 rounded-lg border border-[var(--color-line)] text-sm hover:border-[var(--color-signal)] transition disabled:opacity-40 cible-tactile"
          >
            Ajouter
          </button>
        </div>

        {manuelles.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">Aucune règle manuelle.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-[var(--color-line)]">
              {manuelles.map((m) => (
                <tr key={m.id_regle}>
                  <td className="py-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{
                        color: m.action === "autoriser" ? "var(--color-ok)" : "var(--color-crit)",
                        background:
                          m.action === "autoriser"
                            ? "color-mix(in srgb, var(--color-ok) 12%, transparent)"
                            : "color-mix(in srgb, var(--color-crit) 12%, transparent)",
                      }}
                    >
                      {m.action}
                    </span>
                  </td>
                  <td className="py-2 font-[var(--font-mono)] text-[13px] text-[var(--color-ink)]">
                    {m.domaine}
                  </td>
                  <td className="py-2 text-xs text-[var(--color-mute)]">{m.commentaire || "—"}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => supprimerDomaine(m.id_regle)}
                      className="text-xs text-[var(--color-mute)] hover:text-[var(--color-crit)] transition"
                    >
                      Supprimer
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Anti-contournement ────────────────────────────────────── */}
      {apercu?.pare_feu && <PareFeu apercu={apercu} onglet={ongletPareFeu} setOnglet={setOngletPareFeu} />}
    </div>
  );
}

/**
 * Écart entre ce qui est demandé et ce qui est réellement appliqué.
 *
 * C'est la section la plus importante de l'écran. Sans elle, la
 * plateforme afficherait « politique active » dès l'enregistrement,
 * alors que l'agent ne l'a peut-être jamais reçue. Annoncer un blocage
 * qui n'a pas lieu est le seul défaut de cette fonction qui se découvre
 * en démonstration, quand un site interdit s'ouvre normalement.
 */
function EtatApplication({ politique, apercu }) {
  const attendue = politique.version;
  const appliquee = politique.politique_version_appliquee;
  const erreur = politique.politique_erreur;

  let etat;
  if (!politique.active) {
    etat = { couleur: "var(--color-mute)", titre: "Politique désactivée", detail: "Aucun blocage n'est appliqué." };
  } else if (erreur) {
    etat = {
      couleur: "var(--color-crit)",
      titre: "Non appliquée par l'agent",
      detail: erreur,
    };
  } else if (appliquee === attendue) {
    etat = {
      couleur: "var(--color-ok)",
      titre: `Appliquée (version ${appliquee})`,
      detail: politique.politique_date_application
        ? `Confirmé par l'agent le ${new Date(politique.politique_date_application).toLocaleString("fr-FR")}.`
        : "Confirmé par l'agent.",
    };
  } else {
    etat = {
      couleur: "var(--color-warn)",
      titre: "En attente de l'agent",
      detail: `Version ${attendue} enregistrée, l'agent applique encore la ${appliquee ?? "—"}. Elle sera prise en compte au prochain cycle (5 min).`,
    };
  }

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 flex gap-3 items-start">
      <span className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ background: etat.couleur }} />
      <div className="min-w-0">
        <p className="text-sm font-medium" style={{ color: etat.couleur }}>
          {etat.titre}
        </p>
        <p className="text-sm text-[var(--color-mute)]">{etat.detail}</p>
        {apercu?.regles_rejetees?.length > 0 && (
          <p className="text-xs text-[var(--color-warn)] mt-1">
            Règles ignorées car invalides : {apercu.regles_rejetees.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Règles de pare-feu, affichées au premier plan et non reléguées dans une
 * documentation.
 *
 * Le blocage DNS seul se contourne en trente secondes : il suffit de
 * changer le serveur DNS de sa machine, ou d'activer DNS-over-HTTPS dans
 * le navigateur — souvent actif par défaut. Tant que ces règles ne sont
 * pas appliquées sur le routeur, l'écran ci-dessus décrit une intention,
 * pas un blocage. Le dire ici est plus honnête que de le découvrir en
 * clientèle.
 */
function PareFeu({ apercu, onglet, setOnglet }) {
  const [copie, setCopie] = useState(false);
  const contenu = apercu.pare_feu[onglet] || "";

  const onglets = [
    { cle: "iptables", label: "Linux / iptables" },
    { cle: "mikrotik", label: "MikroTik" },
    { cle: "autre", label: "pfSense, Cisco, autre" },
  ];

  return (
    <section className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-surface)] p-4 md:p-5 space-y-3">
      <div>
        <h2 className="text-sm font-medium text-[var(--color-warn)]">
          Étape indispensable : verrouiller le contournement
        </h2>
        <p className="text-xs text-[var(--color-mute)] mt-1 max-w-2xl">
          Le blocage DNS seul se contourne en trente secondes (changer le DNS de sa
          machine, ou activer DNS-over-HTTPS dans Chrome ou Firefox). Ces règles
          ferment les trois voies connues. Elles s'appliquent sur le{" "}
          <strong className="text-[var(--color-ink)]">routeur du site</strong> — l'agent
          ne peut pas les poser lui-même, il n'est pas sur le chemin du trafic.
        </p>
      </div>

      <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-surface-2)] w-fit">
        {onglets.map((o) => (
          <button
            key={o.cle}
            onClick={() => setOnglet(o.cle)}
            className={`px-3 py-1.5 rounded-md text-xs transition cible-tactile ${
              onglet === o.cle
                ? "bg-[var(--color-signal)] text-[var(--color-sur-accent)]"
                : "text-[var(--color-mute)] hover:text-[var(--color-ink)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <pre className="text-[11px] leading-relaxed bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg p-3 overflow-x-auto text-[var(--color-mute)] max-h-72">
        {contenu}
      </pre>

      <button
        onClick={() => {
          navigator.clipboard?.writeText(contenu);
          setCopie(true);
          setTimeout(() => setCopie(false), 2000);
        }}
        className="px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-xs hover:border-[var(--color-signal)] transition cible-tactile"
      >
        {copie ? "Copié" : "Copier les règles"}
      </button>

      <p className="text-xs text-[var(--color-mute)]">
        Limite à connaître : ces règles couvrent les fournisseurs DNS grand public.
        Un service auto-hébergé sur un domaine quelconque reste indétectable — rien
        ne distingue son trafic d'une visite de site ordinaire. Contre quelqu'un de
        déterminé et compétent, la réponse est un proxy d'entreprise, pas le DNS.
      </p>
    </section>
  );
}
