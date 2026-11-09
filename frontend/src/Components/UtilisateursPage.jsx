import { useEffect, useState } from "react";
import axios from "axios";
import MatricePermissions from "./MatricePermissions";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const ROLES = [
  { valeur: "admin", label: "Administrateur" },
  { valeur: "operateur", label: "Opérateur" },
  { valeur: "lecteur", label: "Lecteur" },
];


const champClasse =
  "bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--color-signal)] transition";
const labelClasse = "block text-[11px] text-[var(--color-mute)] mb-1.5";
const boutonDiscret =
  "text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] transition disabled:opacity-50";

const FORMULAIRE_VIDE = {
  nom: "",
  email: "",
  mot_de_passe: "",
  role: "lecteur",
  id_site: "",
};

/**
 * Gestion des comptes.
 *
 * Le droit de modifier une ligne est calculé PAR LE SERVEUR (champ `gerable`
 * renvoyé par GET /api/utilisateurs) : cette page ne réimplémente pas la règle
 * de cloisonnement, elle se contente de masquer les boutons. Toute action
 * reste revalidée côté serveur.
 */
export default function UtilisateursPage() {
  const [utilisateurs, setUtilisateurs] = useState([]);
  const [sites, setSites] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);
  const [message, setMessage] = useState(null);
  const [envoi, setEnvoi] = useState(false);

  const [formulaire, setFormulaire] = useState(FORMULAIRE_VIDE);
  const [edition, setEdition] = useState(null); // compte en cours de modification

  const [moi, setMoi] = useState({ id: null, role: null, id_site: null });

  /* ── DEMANDES D'ACCÈS EN ATTENTE ──
     `null` = pas encore lues ou fonction absente ; un tableau vide = lues,
     et il n'y en a aucune. La distinction évite d'afficher un bloc vide
     pendant le chargement, et de laisser croire qu'il n'y a pas de
     demande alors qu'on n'a pas encore demandé. */
  const [demandes, setDemandes] = useState(null);
  const [traitement, setTraitement] = useState(null);
  const [attribution, setAttribution] = useState({});

  useEffect(() => {
    try {
      const brut = localStorage.getItem("utilisateur");
      if (brut) {
        const u = JSON.parse(brut);
        setMoi({ id: u.id, role: u.role, id_site: u.id_site ?? null });
      }
    } catch {
      setMoi({ id: null, role: null, id_site: null });
    }
  }, []);

  const estAdmin = moi.role === "admin";
  const estAdminGlobal = estAdmin && moi.id_site === null;

  async function charger() {
    setChargement(true);
    try {
      const [uRes, sRes] = await Promise.all([
        axios.get(`${API_URL}/utilisateurs`),
        axios.get(`${API_URL}/sites`),
      ]);
      setUtilisateurs(uRes.data);
      setSites(sRes.data);
      setErreur(null);
    } catch (err) {
      setErreur(err.response?.data?.error || "Impossible de charger les comptes");
    } finally {
      setChargement(false);
    }
  }

  /* Lecture à part, et facultative : sur une installation dont la
     migration des demandes n'est pas appliquée, la route répond 503 et la
     section se retire simplement de l'écran. Le reste de la page — la
     gestion des comptes, qui est l'essentiel — ne doit pas en dépendre. */
  async function chargerDemandes() {
    if (moi.role !== "admin") return;
    try {
      const { data } = await axios.get(`${API_URL}/utilisateurs/demandes`);
      setDemandes(Array.isArray(data) ? data : []);
    } catch {
      setDemandes(null);
    }
  }

  async function traiterDemande(demande, action) {
    setTraitement(demande.id_demande);
    setMessage(null);
    setErreur(null);
    try {
      if (action === "accepter") {
        const choix = attribution[demande.id_demande] || {};
        await axios.post(`${API_URL}/utilisateurs/demandes/${demande.id_demande}/accepter`, {
          role: choix.role || "lecteur",
          id_site: choix.id_site === "" ? null : choix.id_site ?? moi.id_site ?? null,
        });
        setMessage(`Accès accordé à ${demande.email}.`);
      } else {
        await axios.post(`${API_URL}/utilisateurs/demandes/${demande.id_demande}/refuser`);
        setMessage(`Demande de ${demande.email} refusée.`);
      }
      await Promise.all([charger(), chargerDemandes()]);
    } catch (err) {
      setErreur(
        err.response?.data?.aide || err.response?.data?.error || "Traitement impossible"
      );
    } finally {
      setTraitement(null);
    }
  }

  useEffect(() => {
    charger();
  }, []);

  useEffect(() => {
    chargerDemandes();
    // Relue quand le rôle est connu : au premier rendu, `moi` est encore vide.
  }, [moi.role]);

  function majChamp(cle, valeur) {
    setFormulaire((f) => ({ ...f, [cle]: valeur }));
  }

  function commencerEdition(u) {
    setEdition(u);
    setFormulaire({
      nom: u.nom || "",
      email: u.email || "",
      mot_de_passe: "",
      role: u.role || "lecteur",
      id_site: u.id_site ?? "",
    });
    setErreur(null);
    setMessage(null);
  }

  function annulerEdition() {
    setEdition(null);
    setFormulaire(FORMULAIRE_VIDE);
    setErreur(null);
  }

  async function soumettre(e) {
    e.preventDefault();
    setErreur(null);
    setMessage(null);
    setEnvoi(true);

    const corps = {
      nom: formulaire.nom.trim(),
      email: formulaire.email.trim(),
      role: formulaire.role,
      id_site: formulaire.id_site === "" ? null : Number(formulaire.id_site),
    };
    // Mot de passe : envoyé seulement s'il est renseigné. Un champ laissé vide
    // en modification conserve le mot de passe existant.
    if (formulaire.mot_de_passe) corps.mot_de_passe = formulaire.mot_de_passe;

    try {
      if (edition) {
        await axios.patch(`${API_URL}/utilisateurs/${edition.id_utilisateur}`, corps);
        setMessage(`Compte « ${corps.nom} » mis à jour.`);
        setEdition(null);
      } else {
        await axios.post(`${API_URL}/utilisateurs`, corps);
        setMessage(`Compte « ${corps.nom} » créé.`);
      }
      setFormulaire(FORMULAIRE_VIDE);
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "L'opération a échoué");
    } finally {
      setEnvoi(false);
    }
  }

  async function supprimer(u) {
    if (!window.confirm(`Supprimer définitivement le compte « ${u.nom} » (${u.email}) ?`)) return;
    setErreur(null);
    setMessage(null);
    try {
      const { data } = await axios.delete(`${API_URL}/utilisateurs/${u.id_utilisateur}`);
      setMessage(data.message);
      if (edition?.id_utilisateur === u.id_utilisateur) annulerEdition();
      await charger();
    } catch (err) {
      setErreur(err.response?.data?.error || "Suppression impossible");
    }
  }

  function libelleSite(u) {
    if (u.id_site === null || u.id_site === undefined) return "Global";
    return u.site_nom || `Site ${u.id_site}`;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Utilisateurs</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Comptes autorisés à accéder à la plateforme
        </p>
      </div>

      {/* ══ DEMANDES D'ACCÈS ══

          Placées AVANT le formulaire de création : ce sont des gens qui
          attendent une réponse. Les mettre en bas de page, sous la liste
          des comptes, reviendrait à les faire attendre plus longtemps.

          La section n'existe pas quand il n'y a rien à traiter — un
          encadré « aucune demande » occuperait la place sans rien dire. */}
      {estAdmin && demandes && demandes.length > 0 && (
        <section className="bg-[var(--color-surface)] border rounded-xl p-5"
                 style={{ borderColor: "var(--color-warn)" }}>
          <h2 className="font-[var(--font-display)] text-sm font-semibold">
            {demandes.length} demande{demandes.length > 1 ? "s" : ""} d'accès en attente
          </h2>
          <p className="text-xs text-[var(--color-mute)] mt-0.5 mb-3">
            Ces personnes ont choisi leur mot de passe : vous ne le verrez pas et
            n'avez rien à leur transmettre. Il vous reste à décider du rôle et du site.
          </p>

          <div className="space-y-3">
            {demandes.map((d) => {
              const choix = attribution[d.id_demande] || {};
              const majChoix = (cle, valeur) =>
                setAttribution((a) => ({
                  ...a,
                  [d.id_demande]: { ...a[d.id_demande], [cle]: valeur },
                }));
              return (
                <div
                  key={d.id_demande}
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm text-[var(--color-ink)]">{d.nom}</span>
                    <span className="text-xs text-[var(--color-mute)]">{d.email}</span>
                    <span className="text-[11px] text-[var(--color-mute)] ml-auto">
                      {new Date(d.date_demande).toLocaleString("fr-FR")}
                      {d.adresse_ip && ` · depuis ${d.adresse_ip}`}
                    </span>
                  </div>

                  {/* Le motif est écrit par une personne : c'est la seule
                      chose qui permette de rattacher une adresse à
                      quelqu'un de réel. Il se lit en entier. */}
                  <p className="text-xs text-[var(--color-ink)] mt-1 italic">« {d.motif} »</p>

                  <div className="flex flex-wrap items-end gap-2 mt-2.5">
                    <div>
                      <label className={labelClasse}>Rôle</label>
                      <select
                        value={choix.role || "lecteur"}
                        onChange={(e) => majChoix("role", e.target.value)}
                        className={champClasse}
                      >
                        <option value="lecteur">Lecteur</option>
                        <option value="operateur">Opérateur</option>
                        <option value="admin">Administrateur</option>
                      </select>
                    </div>

                    <div>
                      <label className={labelClasse}>Site</label>
                      <select
                        value={choix.id_site ?? (moi.id_site ?? "")}
                        onChange={(e) => majChoix("id_site", e.target.value)}
                        className={champClasse}
                        disabled={!estAdminGlobal}
                      >
                        {estAdminGlobal && <option value="">Global — tous les sites</option>}
                        {sites.map((s) => (
                          <option key={s.id_site} value={s.id_site}>
                            {s.nom}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      onClick={() => traiterDemande(d, "accepter")}
                      disabled={traitement === d.id_demande}
                      className="text-xs px-3 py-1.5 rounded-lg border transition cible-tactile disabled:opacity-60"
                      style={{ borderColor: "var(--color-ok)", color: "var(--color-ok)" }}
                    >
                      {traitement === d.id_demande ? "…" : "Accorder l'accès"}
                    </button>

                    <button
                      onClick={() => traiterDemande(d, "refuser")}
                      disabled={traitement === d.id_demande}
                      className="text-xs px-3 py-1.5 rounded-lg text-[var(--color-mute)] hover:text-[var(--color-crit)] transition cible-tactile disabled:opacity-60"
                    >
                      Refuser
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {estAdmin && (
        <form
          onSubmit={soumettre}
          className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5 flex flex-wrap items-end gap-3"
        >
          <div>
            <label className={labelClasse}>Nom</label>
            <input
              value={formulaire.nom}
              onChange={(e) => majChamp("nom", e.target.value)}
              required
              className={champClasse}
            />
          </div>

          <div>
            <label className={labelClasse}>E-mail</label>
            <input
              type="email"
              value={formulaire.email}
              onChange={(e) => majChamp("email", e.target.value)}
              placeholder="prenom.nom@entreprise.com"
              required
              className={champClasse}
            />
          </div>

          <div>
            <label className={labelClasse}>
              {edition ? "Nouveau mot de passe (optionnel)" : "Mot de passe"}
            </label>
            <input
              type="password"
              value={formulaire.mot_de_passe}
              onChange={(e) => majChamp("mot_de_passe", e.target.value)}
              placeholder={edition ? "laisser vide pour conserver" : "8 caractères minimum"}
              autoComplete="new-password"
              required={!edition}
              minLength={formulaire.mot_de_passe ? 8 : undefined}
              className={champClasse}
            />
          </div>

          <div>
            <label className={labelClasse}>Rôle</label>
            <select
              value={formulaire.role}
              onChange={(e) => majChamp("role", e.target.value)}
              className={champClasse}
            >
              {ROLES.map((r) => (
                <option key={r.valeur} value={r.valeur}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClasse}>Site de rattachement</label>
            <select
              value={formulaire.id_site}
              onChange={(e) => majChamp("id_site", e.target.value)}
              className={champClasse}
            >
              {/* Un admin rattaché ne peut pas créer de compte global :
                  l'option n'est proposée qu'aux admins globaux, et le serveur
                  refuse de toute façon la tentative. */}
              {estAdminGlobal && <option value="">Global — tous les sites</option>}
              {sites.map((s) => (
                <option key={s.id_site} value={s.id_site}>
                  {s.nom}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={envoi}
            className="bg-[var(--color-signal)] text-[var(--color-sur-accent)] font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 transition disabled:opacity-50"
          >
            {envoi ? "Enregistrement…" : edition ? "Enregistrer les modifications" : "Créer le compte"}
          </button>

          {edition && (
            <button
              type="button"
              onClick={annulerEdition}
              className={`${boutonDiscret} hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]`}
            >
              Annuler
            </button>
          )}
        </form>
      )}

      {erreur && <p className="text-sm text-[var(--color-crit)]">{erreur}</p>}
      {message && <p className="text-sm text-[var(--color-ok)]">{message}</p>}

      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        {chargement ? (
          <p className="text-sm text-[var(--color-mute)]">Chargement des comptes…</p>
        ) : utilisateurs.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">Aucun compte à afficher.</p>
        ) : (
          <div className="table-scroll"><table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-mute)] border-b border-[var(--color-line)]">
                <th className="pb-2 font-medium">Nom</th>
                <th className="pb-2 font-medium">E-mail</th>
                <th className="pb-2 font-medium">Rôle</th>
                <th className="pb-2 font-medium">Site</th>
                {estAdmin && <th className="pb-2 font-medium text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {utilisateurs.map((u) => {
                const cestMoi = u.id_utilisateur === moi.id;
                return (
                  <tr key={u.id_utilisateur}>
                    <td className="py-2.5">
                      {u.nom}
                      {cestMoi && (
                        <span className="ml-2 text-[11px] text-[var(--color-signal)]">vous</span>
                      )}
                    </td>
                    <td className="py-2.5 text-[var(--color-mute)]">{u.email}</td>
                    <td className="py-2.5 text-[var(--color-mute)]">
                      {ROLES.find((r) => r.valeur === u.role)?.label || u.role}
                    </td>
                    <td className="py-2.5">
                      <span
                        className={
                          u.id_site === null
                            ? "text-[var(--color-signal)] text-xs"
                            : "text-[var(--color-mute)] text-xs"
                        }
                      >
                        {libelleSite(u)}
                      </span>
                    </td>
                    {estAdmin && (
                      <td className="py-2.5">
                        <div className="flex gap-2 justify-end">
                          {u.gerable ? (
                            <>
                              <button
                                onClick={() => commencerEdition(u)}
                                className={`${boutonDiscret} hover:border-[var(--color-signal)] hover:text-[var(--color-signal)]`}
                              >
                                Modifier
                              </button>
                              <button
                                onClick={() => supprimer(u)}
                                disabled={cestMoi}
                                title={
                                  cestMoi ? "Vous ne pouvez pas supprimer votre propre compte" : undefined
                                }
                                className={`${boutonDiscret} hover:border-[var(--color-crit)] hover:text-[var(--color-crit)]`}
                              >
                                Supprimer
                              </button>
                            </>
                          ) : (
                            <span className="text-[11px] text-[var(--color-mute)]">
                              hors de votre périmètre
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </div>

      {/* ══ PERMISSIONS ══
          Après la liste des comptes, et pas avant : on crée d'abord les
          gens, on règle ensuite ce qu'ils ont le droit de faire.
          Réservée aux administrateurs — le serveur refuse aussi. */}
      {estAdmin && <MatricePermissions />}
    </div>
  );
}
