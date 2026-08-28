import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

const ROLES = [
  { valeur: "admin", label: "Administrateur" },
  { valeur: "operateur", label: "Opérateur" },
  { valeur: "lecteur", label: "Lecteur" },
];

const AIDE_WHATSAPP = "Format international sans le « + » — ex. 237691234567";

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
  telephone_whatsapp: "",
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

  useEffect(() => {
    charger();
  }, []);

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
      telephone_whatsapp: u.telephone_whatsapp || "",
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
      telephone_whatsapp: formulaire.telephone_whatsapp.trim() || null,
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

          <div>
            <label className={labelClasse}>Numéro WhatsApp (optionnel)</label>
            <input
              value={formulaire.telephone_whatsapp}
              onChange={(e) => majChamp("telephone_whatsapp", e.target.value)}
              placeholder="237691234567"
              inputMode="numeric"
              className={`${champClasse} font-[var(--font-mono)]`}
            />
          </div>

          <button
            type="submit"
            disabled={envoi}
            className="bg-[var(--color-signal)] text-[var(--color-abyss)] font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-110 transition disabled:opacity-50"
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

      {estAdmin && (
        <p className="text-xs text-[var(--color-mute)]">
          Numéro WhatsApp : {AIDE_WHATSAPP}. Un format incorrect fait échouer l'envoi des alertes
          sans message d'erreur visible.
        </p>
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
                <th className="pb-2 font-medium">WhatsApp</th>
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
                    <td className="py-2.5 text-[var(--color-mute)] font-[var(--font-mono)] text-[13px]">
                      {u.telephone_whatsapp || "—"}
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
    </div>
  );
}
