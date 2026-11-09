import { useEffect, useRef, useState } from "react";
import axios from "axios";
import Jauge from "./Jauge";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   LA VUE D'UN SITE — ELLE S'ASSEMBLE TOUTE SEULE

   ── CE QUE CET ÉCRAN FAIT, ET QUE LES AUTRES NE FONT PAS ──

   Ailleurs, un tableau de bord se CONSTRUIT : on crée le tableau, on
   ajoute une tuile, on choisit l'élément à surveiller, on règle l'unité,
   on recommence pour chaque machine. Une demi-journée pour un site, et
   tout est à refaire au suivant.

   Ici il n'y a rien à configurer. Le scan a appris ce qu'il y a sur le
   réseau ; cet écran le met en forme. Ce qu'on lit découle de ce qui a
   été TROUVÉ, pas de ce qu'un administrateur a pensé à déclarer.

   ── UNE UNITÉ, UN GRAPHIQUE ──

   Des machines, des millisecondes et des kilobits ne partagent pas une
   échelle. Les superposer demanderait deux axes verticaux, et un
   graphique à double axe dit ce qu'on veut : il suffit de changer une
   graduation pour qu'une courbe passe au-dessus de l'autre.

   ── CHAQUE TUILE PEUT DIRE « JE NE SAIS PAS » ──

   Et c'est la moitié de l'intérêt. Une tuile qui affiche zéro là où elle
   n'a rien mesuré transforme une absence en constat.
   ══════════════════════════════════════════════════════════════════════ */

const INFOBULLE = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-line)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-ink)",
};

const GRILLE = {
  stroke: "var(--color-line)",
  strokeDasharray: "3 3",
  vertical: false,
};

const AXE = {
  tick: { fontSize: 10, fill: "var(--color-mute)" },
  tickLine: false,
  axisLine: false,
};

function Carte({ titre, aide, children, className = "" }) {
  return (
    <section
      className={`bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-4 ${className}`}
    >
      <h2 className="text-sm font-medium text-[var(--color-ink)]">{titre}</h2>
      {aide && <p className="text-[11px] text-[var(--color-mute)] mt-0.5">{aide}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Tuile({ libelle, valeur, note, ton = "neutre" }) {
  const couleur = {
    ok: "var(--color-ok)",
    attention: "var(--color-warn)",
    critique: "var(--color-crit)",
    neutre: "var(--color-ink)",
  }[ton];

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-4">
      <p className="text-[11px] text-[var(--color-mute)] uppercase tracking-wide">{libelle}</p>
      <p
        className="font-[var(--font-display)] text-3xl font-semibold mt-1 tabular-nums"
        style={{ color: couleur }}
      >
        {valeur}
      </p>
      {note && <p className="text-[11px] text-[var(--color-mute)] mt-1">{note}</p>}
    </div>
  );
}

/** Mesure la largeur disponible : Recharts a besoin d'un nombre. */
function useLargeur() {
  const ref = useRef(null);
  const [largeur, setLargeur] = useState(0);

  useEffect(() => {
    if (!ref.current) return undefined;
    const observateur = new ResizeObserver((entrees) => {
      setLargeur(Math.floor(entrees[0].contentRect.width));
    });
    observateur.observe(ref.current);
    return () => observateur.disconnect();
  }, []);

  return [ref, largeur];
}

function Barre({ valeur, maximum }) {
  const pct = maximum > 0 ? Math.min(100, (valeur / maximum) * 100) : 0;
  return (
    <div className="h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
      <div className="h-full rounded-full"
           style={{ width: `${pct}%`, background: "var(--color-signal)" }} />
    </div>
  );
}

function formaterDebit(kbps) {
  if (kbps === null || kbps === undefined) return "—";
  const n = Number(kbps);
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)} kbit/s`;
  return `${(n / 1000).toFixed(1)} Mbit/s`;
}

function heure(instant) {
  const d = new Date(String(instant).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function quand(valeur) {
  if (!valeur) return null;
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("fr-FR");
}

/** Un graphique de la grille : son titre, ou la raison de son absence. */
function Courbe({ titre, aide, points, clef, couleur, aire, formateur, vide }) {
  const [ref, largeur] = useLargeur();
  const utiles = points.filter((p) => p[clef] !== null && p[clef] !== undefined);

  return (
    <Carte titre={titre} aide={aide}>
      <div ref={ref} className="w-full" style={{ minHeight: 140 }}>
        {utiles.length < 2 ? (
          /* Deux points font une courbe, pas un. Et une grille vide
             ressemble à une panne : on dit la raison. */
          <p className="text-xs text-[var(--color-mute)] py-10 text-center">{vide}</p>
        ) : (
          largeur > 0 &&
          (aire ? (
            <AreaChart data={points} width={largeur} height={140}
                       margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`grad-${clef}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={couleur} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={couleur} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...GRILLE} />
              <XAxis dataKey="t" {...AXE} minTickGap={32} />
              <YAxis {...AXE} width={54} tickFormatter={formateur} />
              <Tooltip contentStyle={INFOBULLE}
                       formatter={(v) => [formateur(v), titre]} />
              <Area type="monotone" dataKey={clef} stroke={couleur} strokeWidth={2}
                    fill={`url(#grad-${clef})`} connectNulls={false}
                    dot={false} isAnimationActive={false} />
            </AreaChart>
          ) : (
            <LineChart data={points} width={largeur} height={140}
                       margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid {...GRILLE} />
              <XAxis dataKey="t" {...AXE} minTickGap={32} />
              <YAxis {...AXE} width={54} tickFormatter={formateur} />
              <Tooltip contentStyle={INFOBULLE}
                       formatter={(v) => [formateur(v), titre]} />
              <Line type="monotone" dataKey={clef} stroke={couleur} strokeWidth={2}
                    connectNulls={false} dot={false} isAnimationActive={false} />
            </LineChart>
          ))
        )}
      </div>
    </Carte>
  );
}

/**
 * Les preuves, et les machines derrière chacune.
 *
 * ── UN CHIFFRE QU'ON PEUT OUVRIR ──
 *
 * « 47 machines vues par ping » est une affirmation. Tant qu'on ne peut
 * pas l'ouvrir, c'est une affirmation qu'il faut croire sur parole — et
 * c'est exactement ce que cette plateforme refuse de demander.
 *
 * Chaque preuve est donc une porte : on clique, on voit les machines
 * concernées, avec le DÉTAIL de ce qui a été constaté sur chacune et la
 * DATE. Une preuve qu'on peut aller vérifier n'est plus une promesse.
 *
 * ── LA LISTE N'EST CHARGÉE QU'AU CLIC ──
 *
 * Huit preuves, huit listes, c'est tout l'inventaire téléchargé pour un
 * encadré que personne n'ouvrira peut-être. Elle reste ensuite en
 * mémoire : rouvrir le même volet ne redemande rien au serveur.
 */
function Preuves({ idSite, preuves }) {
  const [ouverte, setOuverte] = useState(null);
  const [listes, setListes] = useState({});
  const [enCours, setEnCours] = useState(null);

  async function basculer(preuve) {
    if (ouverte === preuve) {
      setOuverte(null);
      return;
    }
    setOuverte(preuve);
    if (listes[preuve]) return;

    setEnCours(preuve);
    try {
      const { data } = await axios.get(`${API_URL}/sites/${idSite}/machines-par-preuve`, {
        params: { preuve },
      });
      setListes((l) => ({ ...l, [preuve]: data.machines }));
    } catch (err) {
      setListes((l) => ({
        ...l,
        [preuve]: { erreur: err.response?.data?.aide || err.response?.data?.error || "Lecture impossible." },
      }));
    } finally {
      setEnCours(null);
    }
  }

  const liste = ouverte ? listes[ouverte] : null;

  return (
    <Carte
      titre="Sur quelle preuve"
      aide="Chaque machine est dans l'inventaire parce que quelque chose l'a prouvé. Cliquez pour voir lesquelles."
    >
      <div className="flex flex-wrap gap-2">
        {preuves.map((p) => {
          const active = ouverte === p.preuve;
          return (
            <button
              key={p.preuve}
              onClick={() => basculer(p.preuve)}
              className="text-xs px-2.5 py-1 rounded-full border transition cible-tactile"
              style={{
                borderColor: active ? "var(--color-signal)" : "var(--color-line)",
                color: active ? "var(--color-signal)" : "var(--color-mute)",
              }}
            >
              {p.preuve.replace(/_/g, " ")}
              <span
                className="tabular-nums"
                style={{ color: active ? "var(--color-signal)" : "var(--color-ink)" }}
              >
                {" "}
                {p.nombre}
              </span>
            </button>
          );
        })}
      </div>

      {ouverte && (
        <div className="mt-4 border-t border-[var(--color-line)] pt-3">
          {enCours === ouverte ? (
            <p className="text-xs text-[var(--color-mute)]">Lecture…</p>
          ) : liste?.erreur ? (
            <p className="text-xs" style={{ color: "var(--color-crit)" }}>{liste.erreur}</p>
          ) : !liste || liste.length === 0 ? (
            <p className="text-xs text-[var(--color-mute)]">Aucune machine dans ce cas.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-[var(--color-mute)] border-b border-[var(--color-line)]">
                      <th className="py-1.5 pr-3 font-normal">Machine</th>
                      <th className="py-1.5 px-3 font-normal">Adresse</th>
                      <th className="py-1.5 px-3 font-normal hidden sm:table-cell">Type</th>
                      {/* LE DÉTAIL EST LA COLONNE QUI COMPTE : c'est lui
                          qui dit ce qui a été constaté, pas seulement
                          qu'il s'est passé quelque chose. */}
                      <th className="py-1.5 px-3 font-normal">Ce qui a été constaté</th>
                      <th className="py-1.5 pl-3 font-normal hidden md:table-cell">Quand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liste.map((m) => (
                      <tr key={m.id_equipement} className="border-b border-[var(--color-line)] last:border-0">
                        <td className="py-1.5 pr-3 text-[var(--color-ink)]">
                          {m.nom || m.adresse_ip}
                        </td>
                        <td className="py-1.5 px-3 text-[var(--color-mute)] tabular-nums whitespace-nowrap">
                          {m.adresse_ip}
                        </td>
                        <td className="py-1.5 px-3 text-[var(--color-mute)] hidden sm:table-cell capitalize">
                          {m.type}
                        </td>
                        <td className="py-1.5 px-3 text-[var(--color-mute)]">
                          {m.detail || "—"}
                        </td>
                        <td className="py-1.5 pl-3 text-[var(--color-mute)] hidden md:table-cell whitespace-nowrap">
                          {quand(m.date_preuve) || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {liste.length >= 200 && (
                <p className="text-[11px] text-[var(--color-mute)] mt-2">
                  200 premières machines — voir la page Équipements pour la suite.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Carte>
  );
}

const COULEUR_NIVEAU = {
  critical: "var(--color-crit)",
  warning: "var(--color-warn)",
  info: "var(--color-mute)",
};

export default function VueSite({ idSite, onFermer }) {
  const [vue, setVue] = useState(null);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    let annule = false;
    setVue(null);
    setErreur(null);

    axios
      .get(`${API_URL}/sites/${idSite}/vue`)
      .then(({ data }) => { if (!annule) setVue(data); })
      .catch((err) => {
        if (!annule) setErreur(err.response?.data?.error || "Lecture impossible.");
      });

    return () => { annule = true; };
  }, [idSite]);

  if (erreur) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <p className="text-sm" style={{ color: "var(--color-crit)" }}>{erreur}</p>
        <button onClick={onFermer} className="text-sm text-[var(--color-mute)] mt-2">Fermer</button>
      </div>
    );
  }

  if (!vue) {
    return (
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
        <p className="text-sm text-[var(--color-mute)]">Assemblage de la vue…</p>
      </div>
    );
  }

  const { site, parc, types, alertes, preuves, consommateurs, plages } = vue;

  /* La disponibilité ne se calcule QUE sur ce dont on connaît l'état.
     Mettre les machines sans nouvelles au dénominateur ferait chuter le
     taux pour une raison qui n'est pas une panne. */
  const observables = parc.en_ligne + parc.hors_ligne;
  const taux = observables > 0 ? Math.round((parc.en_ligne / observables) * 1000) / 10 : null;

  const maxType = types.reduce((m, t) => Math.max(m, t.nombre), 0);
  const maxConso = consommateurs.reduce((m, c) => Math.max(m, c.kbps || 0), 0);

  const points = (vue.historique || []).map((h) => ({ ...h, t: heure(h.instant) }));

  return (
    <div className="space-y-4">
      {/* ══ EN-TÊTE ══ */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-[var(--font-display)] text-xl font-semibold">{site.nom}</h1>
          <p className="text-sm text-[var(--color-mute)] mt-0.5">
            {site.ville}
            {vue.dernier_scan && ` — dernière exploration le ${quand(vue.dernier_scan)}`}
          </p>
          {/* RIEN N'A ÉTÉ CONFIGURÉ POUR PRODUIRE CET ÉCRAN, et le dire
              est le propos : c'est ce qui le sépare d'un tableau de bord
              qu'on assemble tuile par tuile. */}
          <p className="text-[11px] text-[var(--color-mute)] mt-1 max-w-2xl">
            Aucun réglage n'a été nécessaire : tout ce qui suit vient de ce que
            l'exploration du réseau a trouvé.
          </p>
        </div>
        <button
          onClick={onFermer}
          className="text-sm px-3 py-1.5 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:text-[var(--color-ink)] transition shrink-0 cible-tactile"
        >
          Fermer
        </button>
      </div>

      {/* ══ LES CHIFFRES ══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tuile libelle="Machines trouvées" valeur={parc.total}
               note={plages.length > 0 ? `sur ${plages.length} plage(s) déclarée(s)` : "aucune plage déclarée"} />
        <Tuile libelle="Disponibilité" valeur={taux === null ? "—" : `${taux} %`}
               ton={taux === null ? "neutre" : taux >= 95 ? "ok" : taux >= 80 ? "attention" : "critique"}
               note={taux === null ? "aucun état observable" : `${parc.en_ligne} sur ${observables} joignables`} />
        {/* « sans état connu » n'est PAS « hors ligne ». Les confondre
            ferait annoncer des pannes qui n'existent pas. */}
        <Tuile libelle="Hors ligne" valeur={parc.hors_ligne}
               ton={parc.hors_ligne > 0 ? "critique" : "ok"}
               note={parc.inconnu > 0 ? `+ ${parc.inconnu} sans état connu` : "tout le parc répond"} />
        <Tuile libelle="Alertes à traiter" valeur={alertes.actives}
               ton={alertes.critiques > 0 ? "critique" : alertes.actives > 0 ? "attention" : "ok"}
               note={alertes.critiques > 0 ? `dont ${alertes.critiques} critique(s)` : "rien d'urgent"} />
      </div>

      {/* ══ JAUGES ET PROBLÈMES ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Carte
          titre="Charge moyenne"
          aide={
            vue.charge?.machines > 0
              ? `sur ${vue.charge.machines} machine(s) qui ont répondu, dernière heure`
              : "aucune machine n'a remonté sa charge"
          }
        >
          <div className="grid grid-cols-2 gap-2">
            <Jauge valeur={vue.charge?.cpu} libelle="Processeur" />
            <Jauge valeur={vue.charge?.ram} libelle="Mémoire" />
          </div>
        </Carte>

        {/* ══ LES PROBLÈMES, NOMMÉS ══
            Un compteur d'alertes ne dit pas quoi faire. La liste, si. */}
        <Carte titre="Problèmes en cours" aide="Les plus graves d'abord." className="lg:col-span-2">
          {vue.problemes?.length === 0 ? (
            <p className="text-sm text-[var(--color-mute)] py-6 text-center">
              Rien à traiter sur ce site.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {vue.problemes.map((p) => (
                <li key={p.id_alerte} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-[var(--color-ink)]">
                      {p.machine}
                      {/* Le niveau est ÉCRIT, pas seulement teinté : une
                          pastille de couleur seule ne se lit ni sans
                          distinguer les couleurs, ni à l'impression. */}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border align-middle"
                            style={{ borderColor: COULEUR_NIVEAU[p.niveau], color: COULEUR_NIVEAU[p.niveau] }}>
                        {p.niveau === "critical" ? "critique" : p.niveau === "warning" ? "avertissement" : "info"}
                      </span>
                    </span>
                    <span className="text-[11px] text-[var(--color-mute)] whitespace-nowrap">
                      {p.occurrences > 1 ? `×${p.occurrences} · ` : ""}
                      {quand(p.depuis)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--color-mute)] mt-0.5">
                    {p.message || p.type}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Carte>
      </div>

      {/* ══ LES COURBES — UNE UNITÉ PAR GRAPHIQUE ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Courbe
          titre="Machines qui répondent"
          aide="Sur 24 heures, un point par heure."
          points={points}
          clef="repondants"
          couleur="var(--color-ok)"
          formateur={(v) => `${Math.round(v)}`}
          vide="Pas encore assez de relevés pour tracer une courbe."
        />
        <Courbe
          titre="Latence moyenne"
          aide="Temps de réponse au ping."
          points={points}
          clef="latence"
          couleur="var(--color-signal)"
          formateur={(v) => `${Math.round(v)} ms`}
          vide="Aucune latence mesurée sur la période."
        />
        <Courbe
          titre="Débit du parc"
          aide="Somme des machines qui exposent un compteur."
          points={points}
          clef="debit"
          couleur="var(--color-serie-2)"
          aire
          formateur={formaterDebit}
          vide="Aucun débit mesuré — seules les machines qui exposent un compteur en produisent."
        />
      </div>

      {/* ══ INVENTAIRE ET CONSOMMATION ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Carte titre="Ce qu'il y a sur ce réseau" aide="Identifié par le scan — rien n'a été saisi à la main.">
          {types.length === 0 ? (
            <p className="text-sm text-[var(--color-mute)] py-4">Aucune machine trouvée pour l'instant.</p>
          ) : (
            <ul className="space-y-2.5">
              {types.map((t) => (
                <li key={t.libelle}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-[var(--color-ink)] capitalize">{t.libelle}</span>
                    <span className="text-sm tabular-nums text-[var(--color-ink)]">{t.nombre}</span>
                  </div>
                  <div className="mt-1"><Barre valeur={t.nombre} maximum={maxType} /></div>
                </li>
              ))}
            </ul>
          )}
        </Carte>

        <Carte titre="Qui consomme le plus" aide="Moyenne sur les dernières 24 heures.">
          {consommateurs.length === 0 ? (
            /* LE VIDE A UNE CAUSE, et elle n'est pas « personne ne
               consomme rien ». La dire évite de chercher une panne. */
            <p className="text-sm text-[var(--color-mute)] py-4">
              Aucune mesure de débit sur ce site. Seules les machines qui exposent
              un compteur — ou qui portent un agent — en produisent.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {consommateurs.map((c) => (
                <li key={c.id_equipement}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-[var(--color-ink)] break-all">
                      {c.nom || c.adresse_ip}
                      <span className="text-xs text-[var(--color-mute)]"> · {c.adresse_ip}</span>
                    </span>
                    <span className="text-sm tabular-nums text-[var(--color-ink)] whitespace-nowrap">
                      {formaterDebit(c.kbps)}
                    </span>
                  </div>
                  <div className="mt-1"><Barre valeur={c.kbps || 0} maximum={maxConso} /></div>
                </li>
              ))}
            </ul>
          )}
        </Carte>
      </div>

      {/* ══ SUR QUELLE PREUVE ══ */}
      {preuves && preuves.length > 0 && (
        <Preuves idSite={idSite} preuves={preuves} />
      )}
    </div>
  );
}
