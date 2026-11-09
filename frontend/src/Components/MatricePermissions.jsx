import { useCallback, useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   QUI A LE DROIT DE QUOI

   Les écrans en lignes, les rôles en colonnes. On change une case, c'est
   enregistré, et ça prend effet tout de suite.

   ── CE QUI DIFFÈRE DE CE QUE FONT LES AUTRES OUTILS ──

   Ailleurs, un droit qu'on n'a pas se manifeste par une entrée de menu
   qui a disparu, ou par « Access denied ». On ne sait ni ce qu'on rate,
   ni à qui demander — et on se demande d'abord si c'est une panne.

   Ici, chaque niveau est écrit en toutes lettres à côté de son nom, et
   le refus, côté serveur, nomme l'écran, le niveau qu'il faudrait, et
   dit qu'un administrateur peut l'accorder depuis cette page. Rien ne
   disparaît sans explication.

   ── LA CASE QUI NE SE DÉCOCHE PAS ──

   « admin » × « Utilisateurs » reste à « administrer ». La retirer
   fermerait cette page à tout le monde, y compris à celui qui voudrait
   annuler le geste : il faudrait ouvrir la base à la main. Le serveur
   refuse aussi, parce qu'une case grisée n'a jamais empêché personne
   d'appeler la route.
   ══════════════════════════════════════════════════════════════════════ */

const ROLES = [
  { code: "admin", libelle: "Administrateur" },
  { code: "operateur", libelle: "Opérateur" },
  { code: "lecteur", libelle: "Lecteur" },
];

/** Ce que chaque niveau autorise — en infobulle sur le menu. */
const EXPLICATIONS = {
  rien: "l'écran n'apparaît pas",
  voir: "consultation seule",
  modifier: "le travail courant — acquitter, renommer, lancer un scan",
  administrer: "ce qui engage l'installation — supprimer, configurer",
};

const COULEURS = {
  rien: "var(--color-mute)",
  voir: "var(--color-ink)",
  modifier: "var(--color-signal)",
  administrer: "var(--color-warn)",
};

/** Le seul droit que la plateforme se refuse à elle-même de retirer. */
function estProtegee(role, ecran) {
  return role === "admin" && ecran === "utilisateurs";
}

export default function MatricePermissions() {
  const [matrice, setMatrice] = useState(null);
  const [erreur, setErreur] = useState(null);
  /* Par case : "envoi" | "ok" | un message d'erreur. Par case et non
     globalement — un échec sur une ligne ne doit pas faire croire que
     tout le tableau a échoué. */
  const [etats, setEtats] = useState({});

  const charger = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/permissions`);
      setMatrice(data);
      setErreur(null);
    } catch (err) {
      setErreur(
        err.response?.data?.aide ||
          err.response?.data?.error ||
          "Impossible de lire les permissions."
      );
    }
  }, []);

  useEffect(() => {
    charger();
  }, [charger]);

  async function changer(role, ecran, niveau) {
    const cle = `${role}:${ecran}`;
    const ancien = matrice.permissions[role][ecran];

    /* On affiche le nouveau niveau tout de suite, et on le REMET en
       place si le serveur refuse. Attendre l'aller-retour pour bouger
       donnerait l'impression que le clic n'a pas été pris. */
    setMatrice((m) => ({
      ...m,
      permissions: {
        ...m.permissions,
        [role]: { ...m.permissions[role], [ecran]: niveau },
      },
    }));
    setEtats((e) => ({ ...e, [cle]: "envoi" }));

    try {
      await axios.put(`${API_URL}/permissions`, { role, ecran, niveau });
      setEtats((e) => ({ ...e, [cle]: "ok" }));
      setTimeout(
        () => setEtats((e) => ({ ...e, [cle]: undefined })),
        1500
      );
    } catch (err) {
      setMatrice((m) => ({
        ...m,
        permissions: {
          ...m.permissions,
          [role]: { ...m.permissions[role], [ecran]: ancien },
        },
      }));
      setEtats((e) => ({
        ...e,
        [cle]:
          err.response?.data?.aide ||
          err.response?.data?.error ||
          "Enregistrement impossible",
      }));
    }
  }

  if (erreur) {
    return (
      <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <h2 className="font-[var(--font-display)] text-sm font-semibold">Permissions</h2>
        <p className="text-sm mt-1.5" style={{ color: "var(--color-crit)" }}>
          {erreur}
        </p>
      </section>
    );
  }

  if (!matrice) return null;

  return (
    <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
      <h2 className="font-[var(--font-display)] text-sm font-semibold">
        Permissions
      </h2>
      <p className="text-xs text-[var(--color-mute)] mt-0.5 mb-3 max-w-3xl">
        Ce que chaque rôle peut faire, écran par écran. Un changement prend
        effet immédiatement, pour tout le monde, et laisse une ligne au journal.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-[var(--color-mute)] border-b border-[var(--color-line)]">
              <th className="py-2 pr-3 font-normal">Écran</th>
              {ROLES.map((r) => (
                <th key={r.code} className="py-2 px-3 font-normal">
                  {r.libelle}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrice.ecrans.map((ecran) => (
              <tr key={ecran.code} className="border-b border-[var(--color-line)]">
                <td className="py-2 pr-3 text-[var(--color-ink)]">{ecran.libelle}</td>

                {ROLES.map((r) => {
                  const cle = `${r.code}:${ecran.code}`;
                  const niveau = matrice.permissions[r.code][ecran.code] || "rien";
                  const etat = etats[cle];
                  const protegee = estProtegee(r.code, ecran.code);

                  return (
                    <td key={r.code} className="py-2 px-3 align-top">
                      <select
                        value={niveau}
                        disabled={protegee || etat === "envoi"}
                        onChange={(e) => changer(r.code, ecran.code, e.target.value)}
                        title={
                          protegee
                            ? "Ce droit ne peut pas être retiré : sans lui, plus personne ne pourrait modifier les permissions."
                            : `${niveau} — ${EXPLICATIONS[niveau]}`
                        }
                        className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-md px-2 py-1 text-[12px] cible-tactile disabled:opacity-60"
                        style={{ color: COULEURS[niveau] }}
                      >
                        {matrice.niveaux.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>

                      {etat === "ok" && (
                        <span
                          className="block text-[10px] mt-0.5"
                          style={{ color: "var(--color-ok)" }}
                        >
                          enregistré
                        </span>
                      )}
                      {etat && etat !== "ok" && etat !== "envoi" && (
                        <span
                          className="block text-[10px] mt-0.5 max-w-[14rem]"
                          style={{ color: "var(--color-crit)" }}
                        >
                          {etat}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* CE QUE LA PERSONNE REFUSÉE VERRA, dit ici — pour que celui qui
          retire un droit sache ce qu'il inflige. */}
      <p className="text-[11px] text-[var(--color-mute)] border-t border-[var(--color-line)] mt-4 pt-3 max-w-3xl">
        Quelqu'un à qui il manque un droit ne tombe pas sur un écran vide : il
        lit quel niveau lui manque, sur quel écran, et qu'un administrateur peut
        le lui donner ici.
      </p>
    </section>
  );
}
