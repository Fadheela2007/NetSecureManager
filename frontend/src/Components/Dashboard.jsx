import { useEffect, useState, useMemo } from "react";
import axios from "axios";
import ScanLauncher from "./ScanLauncher";
import StatusDot from "./StatusDot";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * ─────────────────────────────────────────────────────────────────────
 * CE QUE CE TABLEAU DE BORD A CESSÉ DE FAIRE
 *
 * Il affichait la liste complète des équipements et la liste complète
 * des alertes — c'est-à-dire une copie moins bonne des pages Équipements
 * et Alertes, qui font la même chose avec des filtres et du tri.
 *
 * Il rendait aussi TOUTES les lignes du parc : acceptable à 44
 * équipements, injouable à 500.
 *
 * Et surtout, il alignait des compteurs sans verdict. « 44 équipements,
 * 40 en ligne » ne dit pas si la situation est normale. L'opérateur
 * devait interpréter lui-même, chaque matin, des chiffres bruts.
 *
 * CE QU'IL FAIT MAINTENANT : répondre en trois secondes à « dois-je
 * m'inquiéter, et de quoi ». Le détail vit dans les pages dédiées, où
 * il est mieux traité.
 * ─────────────────────────────────────────────────────────────────────
 */

/**
 * Retire du message d'alerte le préambule qui nomme l'équipement.
 *
 * Le message est rédigé pour être lu SEUL — dans un e-mail de
 * notification, il doit dire de quelle machine il parle. Sur le tableau
 * de bord, l'identité figure déjà sur la ligne au-dessus, et la répéter
 * pousse le diagnostic — la seule information utile — hors de l'écran.
 *
 * On ne touche qu'à un préambule reconnu et suivi d'une vraie phrase :
 * en cas de doute, le message reste intact. Mieux vaut une redondance
 * qu'un message tronqué de travers.
 */
function alleger(message, nom, ip) {
  if (!message) return message;
  let texte = String(message);

  for (const identite of [nom, ip].filter(Boolean)) {
    const echappe = identite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixe = new RegExp(`^L['’]équipement\\s+${echappe}\\s+`, "i");
    if (prefixe.test(texte)) {
      const reste = texte.replace(prefixe, "").trim();
      if (reste.length > 10) {
        return reste.charAt(0).toUpperCase() + reste.slice(1);
      }
    }
  }
  return texte;
}

function Signal({ libelle, valeur, unite, ton = "neutre", note }) {
  const couleur = {
    neutre: "var(--color-ink)",
    ok: "var(--color-ok)",
    attention: "var(--color-warn)",
    critique: "var(--color-crit)",
  }[ton];

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl px-5 py-4 flex-1 min-w-[150px]">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)] mb-1.5">
        {libelle}
      </p>
      <p
        className="font-[var(--font-display)] text-2xl font-semibold tabular-nums"
        style={{ color: couleur }}
      >
        {valeur}
        {unite && <span className="text-base font-normal ml-0.5">{unite}</span>}
      </p>
      {/* La note évite le chiffre orphelin : « 91 % » ne veut rien dire
          sans « 40 équipements sur 44 ». */}
      {note && <p className="text-xs text-[var(--color-mute)] mt-1">{note}</p>}
    </div>
  );
}

export default function Dashboard({ idSite = 1 }) {
  const [equipements, setEquipements] = useState([]);
  const [alertes, setAlertes] = useState([]);
  const [couverture, setCouverture] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [exportEnCours, setExportEnCours] = useState(null);

  async function chargerDonnees() {
    setChargement(true);
    try {
      // Le jeton est porté par axios.defaults (défini dans App.jsx).
      const [eqRes, alRes, bpRes] = await Promise.all([
        axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } }),
        // Seules les alertes NON acquittées comptent comme « à traiter » :
        // c'est ce qui vide le tableau de bord quand l'opérateur a fait
        // son tri, sans rien supprimer de l'historique.
        axios.get(`${API_URL}/alertes`, { params: { statut: "active" } }),
        // Couverture de la mesure : combien d'équipements sont réellement
        // mesurables. Sans ce chiffre, un écran vide passe pour une panne.
        axios
          .get(`${API_URL}/bande-passante/classement`, { params: { heures: 24, limite: 1 } })
          .catch(() => ({ data: null })),
      ]);

      setEquipements(eqRes.data);
      setAlertes(alRes.data);
      setCouverture(bpRes.data?.couverture ?? null);
    } catch (err) {
      console.error("Chargement du tableau de bord impossible", err);
    } finally {
      setChargement(false);
    }
  }

  useEffect(() => {
    chargerDonnees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSite]);

  async function telechargerRapport(format) {
    setExportEnCours(format);
    try {
      const response = await axios.get(`${API_URL}/rapport/${format}`, {
        params: { id_site: idSite },
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const lien = document.createElement("a");
      lien.href = url;
      lien.download = `rapport_netsecuremanager.${format === "pdf" ? "pdf" : "xlsx"}`;
      document.body.appendChild(lien);
      lien.click();
      lien.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Téléchargement du rapport impossible", err);
    } finally {
      setExportEnCours(null);
    }
  }

  const bilan = useMemo(() => {
    const up = equipements.filter((e) => e.statut === "up").length;
    const down = equipements.filter((e) => e.statut === "down").length;
    // Équipements dont l'état n'est plus observable : agent muet, site
    // jamais scanné. Les fondre dans « hors ligne » serait faux — on ne
    // sait pas, ce n'est pas pareil que « on sait que c'est tombé ».
    const inconnus = equipements.filter((e) => e.statut === "inconnu").length;
    const total = equipements.length;

    const critiques = alertes.filter((a) => a.niveau === "critical").length;
    const observables = up + down;

    return {
      up,
      down,
      inconnus,
      total,
      critiques,
      // Disponibilité calculée sur les seuls équipements OBSERVABLES.
      // Compter les « inconnu » comme hors ligne ferait chuter le taux
      // pour une raison qui n'est pas une panne.
      disponibilite: observables > 0 ? Math.round((up / observables) * 100) : null,
      derniereDecouverte: equipements.reduce((max, e) => {
        const d = e.derniere_decouverte ? new Date(e.derniere_decouverte) : null;
        return d && (!max || d > max) ? d : max;
      }, null),
    };
  }, [equipements, alertes]);

  /**
   * Le verdict, en une phrase.
   *
   * C'est la seule chose que beaucoup d'utilisateurs liront. Il énonce
   * un fait et une conséquence, jamais un chiffre isolé — et il ne crie
   * que lorsqu'il y a lieu de crier : un bandeau rouge permanent cesse
   * d'être lu au bout de trois jours.
   */
  const verdict = useMemo(() => {
    if (chargement) return null;

    if (bilan.total === 0) {
      return {
        ton: "neutre",
        titre: "Aucun équipement dans le parc",
        detail: "Lancez un premier scan pour découvrir le réseau.",
      };
    }
    if (bilan.critiques > 0) {
      return {
        ton: "critique",
        titre: `${bilan.critiques} alerte${bilan.critiques > 1 ? "s" : ""} critique${
          bilan.critiques > 1 ? "s" : ""
        } à traiter`,
        detail:
          bilan.down > 0
            ? `${bilan.down} équipement${bilan.down > 1 ? "s ne répondent" : " ne répond"} plus.`
            : "Consultez la page Alertes pour le détail.",
      };
    }
    if (bilan.down > 0) {
      return {
        ton: "attention",
        titre: `${bilan.down} équipement${bilan.down > 1 ? "s" : ""} hors ligne`,
        detail: "Aucune alerte critique ouverte — la situation est connue et suivie.",
      };
    }
    if (bilan.inconnus > 0) {
      return {
        ton: "attention",
        titre: `${bilan.inconnus} équipement${bilan.inconnus > 1 ? "s" : ""} sans état connu`,
        detail: "Leur site n'a pas transmis récemment. Vérifiez l'agent dans Sites.",
      };
    }
    return {
      ton: "ok",
      titre: "Tout le parc répond",
      detail: `${bilan.up} équipement${bilan.up > 1 ? "s" : ""} en ligne, aucune alerte à traiter.`,
    };
  }, [bilan, chargement]);

  const couleurVerdict = {
    ok: "var(--color-ok)",
    attention: "var(--color-warn)",
    critique: "var(--color-crit)",
    neutre: "var(--color-mute)",
  };

  // Les cinq alertes les plus graves, et rien de plus : le tableau de
  // bord oriente, la page Alertes traite.
  const prioritaires = useMemo(
    () =>
      [...alertes]
        .sort((a, b) => {
          const rang = { critical: 0, warning: 1, info: 2 };
          return (rang[a.niveau] ?? 3) - (rang[b.niveau] ?? 3);
        })
        .slice(0, 5),
    [alertes]
  );

  const recents = useMemo(
    () =>
      [...equipements]
        .filter((e) => e.derniere_decouverte)
        .sort((a, b) => new Date(b.derniere_decouverte) - new Date(a.derniere_decouverte))
        .slice(0, 5),
    [equipements]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">Tableau de bord</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            {bilan.derniereDecouverte
              ? `Dernière découverte : ${bilan.derniereDecouverte.toLocaleString("fr-FR")}`
              : "Vue d'ensemble du réseau supervisé"}
          </p>
        </div>

        <div className="flex gap-2 shrink-0">
          {["pdf", "excel"].map((f) => (
            <button
              key={f}
              onClick={() => telechargerRapport(f)}
              disabled={exportEnCours === f}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition disabled:opacity-50 cible-tactile"
            >
              {exportEnCours === f ? "Génération…" : `Export ${f === "pdf" ? "PDF" : "Excel"}`}
            </button>
          ))}
        </div>
      </div>

      {/* ── LE VERDICT ── */}
      {verdict && (
        <div
          className="rounded-xl border bg-[var(--color-surface)] px-5 py-4 flex items-start gap-3"
          style={{ borderColor: `color-mix(in srgb, ${couleurVerdict[verdict.ton]} 40%, transparent)` }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
            style={{ background: couleurVerdict[verdict.ton] }}
          />
          <div>
            <p
              className="font-[var(--font-display)] text-base font-semibold"
              style={{ color: couleurVerdict[verdict.ton] }}
            >
              {verdict.titre}
            </p>
            <p className="text-sm text-[var(--color-mute)]">{verdict.detail}</p>
          </div>
        </div>
      )}

      {/* ── LES SIGNAUX ── */}
      <div className="flex flex-wrap gap-4">
        <Signal
          libelle="Disponibilité"
          valeur={bilan.disponibilite === null ? "—" : bilan.disponibilite}
          unite={bilan.disponibilite === null ? "" : " %"}
          ton={
            bilan.disponibilite === null
              ? "neutre"
              : bilan.disponibilite >= 95
              ? "ok"
              : bilan.disponibilite >= 80
              ? "attention"
              : "critique"
          }
          note={
            bilan.disponibilite === null
              ? "aucun état observable"
              : `${bilan.up} sur ${bilan.up + bilan.down} joignables`
          }
        />
        {/* La note dit la PROPORTION, pas l'absence d'un autre problème.
            « 15 » surmonté de « aucun équipement muet » se lisait comme
            une contradiction : le chiffre alarme, la note rassure. */}
        <Signal
          libelle="Hors ligne"
          valeur={bilan.down}
          ton={bilan.down > 0 ? "critique" : "ok"}
          note={
            bilan.inconnus > 0
              ? `+ ${bilan.inconnus} sans état connu`
              : bilan.down > 0
              ? `sur ${bilan.total} équipements du parc`
              : "tout le parc répond"
          }
        />
        <Signal
          libelle="Alertes à traiter"
          valeur={alertes.length}
          ton={bilan.critiques > 0 ? "critique" : alertes.length > 0 ? "attention" : "ok"}
          note={bilan.critiques > 0 ? `dont ${bilan.critiques} critique(s)` : "acquittées exclues"}
        />
        {/* ── LE CHIFFRE QUI ÉVITE UN MALENTENDU ──
            La bande passante et les graphiques de charge n'existent que
            pour les équipements exposant SNMP — une minorité sur un parc
            courant. Sans ce signal, l'utilisateur croit à une panne en
            voyant des écrans vides. */}
        {couverture && (
          <Signal
            libelle="Mesurés en SNMP"
            valeur={couverture.avec_mesure ?? 0}
            note={`sur ${couverture.equipements ?? 0} — les autres n'exposent rien`}
            ton="neutre"
          />
        )}
      </div>

      <ScanLauncher idSite={idSite} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── CE QUI DEMANDE UNE ACTION ── */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
          <h2 className="font-[var(--font-display)] text-sm font-semibold mb-4">
            À traiter en priorité
          </h2>

          {alertes.length === 0 ? (
            <p className="text-sm text-[var(--color-mute)]">
              Rien à traiter. Les alertes acquittées restent consultables dans
              l'onglet correspondant de la page Alertes.
            </p>
          ) : (
            <>
              <ul className="space-y-3">
                {prioritaires.map((a) => (
                  <li key={a.id_alerte} className="flex items-start gap-2.5">
                    <span
                      className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        backgroundColor:
                          a.niveau === "critical"
                            ? "var(--color-crit)"
                            : a.niveau === "warning"
                            ? "var(--color-warn)"
                            : "var(--color-mute)",
                      }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm text-[var(--color-ink)] truncate">
                        {a.nom || a.adresse_ip}
                        {a.occurrences > 1 && (
                          <span
                            className="ml-1.5 text-[11px] text-[var(--color-mute)]"
                            title={`Ce problème s'est reproduit ${a.occurrences} fois`}
                          >
                            ×{a.occurrences}
                          </span>
                        )}
                      </p>
                      {/* Le message répète l'identité de l'équipement, déjà
                          affichée juste au-dessus : « 192.168.0.32 » puis
                          « L'équipement 192.168.0.32 ne répond plus… ». On
                          retire ce préambule pour ne garder que ce que la
                          ligne du dessus ne dit pas — le diagnostic. */}
                      <p className="text-xs text-[var(--color-mute)]">
                        {alleger(a.message, a.nom, a.adresse_ip)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {alertes.length > prioritaires.length && (
                <p className="text-xs text-[var(--color-mute)] mt-4 pt-3 border-t border-[var(--color-line)]">
                  {alertes.length - prioritaires.length} autre(s) alerte(s) — voir la page Alertes.
                </p>
              )}
            </>
          )}
        </section>

        {/* ── CE QUI VIENT DE CHANGER ──
            Cinq lignes, pas le parc entier : la liste complète est la
            raison d'être de la page Équipements, et en rendre 500 ici
            ralentissait l'écran d'accueil. */}
        <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
          <h2 className="font-[var(--font-display)] text-sm font-semibold mb-4">
            Vus le plus récemment
          </h2>

          {recents.length === 0 ? (
            <p className="text-sm text-[var(--color-mute)]">
              Aucun équipement découvert — lancez un scan ci-dessus.
            </p>
          ) : (
            <>
              <ul className="space-y-2.5">
                {recents.map((eq) => (
                  // L'adresse n'est répétée à droite QUE si la machine a
                  // un nom. Sans ce test, une machine anonyme affichait
                  // « 192.168.0.184 » deux fois sur la même ligne — la
                  // colonne de droite ayant été pensée pour un cas où le
                  // nom existe, ce qui est rare sur un parc sans DNS.
                  <li key={eq.id_equipement} className="flex items-center gap-3">
                    <StatusDot status={eq.statut} />
                    <span className="text-sm text-[var(--color-ink)] truncate flex-1 min-w-0 font-[var(--font-mono)]">
                      {eq.nom || eq.adresse_ip}
                    </span>
                    {eq.nom && (
                      <span className="text-xs text-[var(--color-mute)] font-[var(--font-mono)] shrink-0">
                        {eq.adresse_ip}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-[var(--color-mute)] mt-4 pt-3 border-t border-[var(--color-line)]">
                {bilan.total} équipement(s) au total — voir la page Équipements.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
