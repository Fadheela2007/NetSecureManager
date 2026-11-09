import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   LA CARTE DU RÉSEAU, QUE PERSONNE N'A DESSINÉE

   Dans les outils du marché, cet écran est un éditeur : on pose les
   icônes, on tire les traits, et les positions sont enregistrées en
   base. Ici il n'y a rien à poser. Le graphe arrive construit du
   serveur, et les positions sont recalculées à chaque affichage —
   personne n'a choisi où va quoi, donc personne n'a à le maintenir.

   ── POURQUOI PAS UN NUAGE DE POINTS QUI S'AUTO-ORGANISE ──

   Un placement par forces donnerait une pelote animée, impressionnante
   et illisible : sur un parc réel, un seul segment porte des dizaines de
   machines. La structure vraie est une ÉTOILE par segment, et c'est
   celle qu'on dessine. Le placement est déterministe : deux affichages
   du même relevé donnent la même image, ce qui permet de comparer deux
   captures à une semaine d'intervalle.

   ── CE QUE L'ÉCRAN DIT DE SES PROPRES MANQUES ──

   La couverture est en haut, avant la carte, et non en note de bas de
   page. Une carte muette sur ce qu'elle ignore laisse croire que le
   réseau est ce qu'elle montre ; sur un parc sans commutateur
   administrable, ce serait faux de beaucoup.
   ══════════════════════════════════════════════════════════════════════ */

/* Deux teintes seulement, et elles encodent la seule distinction qui
   demande une décision : cette adresse est-elle à l'inventaire, oui ou
   non. Le niveau de preuve est porté par le TRAIT (plein ou pointillé)
   et écrit dans la légende — jamais par la couleur seule. */
const COULEUR_CONNU = "var(--color-serie-2)";
const COULEUR_INCONNU = "var(--color-signal)";

const LIBELLE_PREUVE = {
  interface: "porte une adresse de ce segment",
  passerelle: "déclarée comme passerelle",
  voisinage: "jointe depuis ce segment",
  sans_fil: "associée à cette borne",
};

/* Nommer ce qui est arrivé, en une ligne. Afficher la réponse entière
   remplirait l'écran d'un contenu que personne ne lira ; ses clés, ou son
   début, suffisent à reconnaître une page HTML ou un objet d'erreur. */
function decrire(data) {
  if (data === null || data === undefined) return "réponse vide";
  if (typeof data === "string") {
    const debut = data.trim().slice(0, 80).replace(/\s+/g, " ");
    return `réponse en texte : « ${debut}… »`;
  }
  if (typeof data !== "object") return `réponse de type ${typeof data}`;
  const cles = Object.keys(data);
  return cles.length
    ? `objet reçu, champs : ${cles.slice(0, 8).join(", ")}`
    : "objet vide";
}

function Tuile({ libelle, valeur, note, ton }) {
  const couleur =
    ton === "alerte" ? "var(--color-warn)" : ton === "ok" ? "var(--color-ok)" : "var(--color-ink)";
  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-[var(--color-mute)]">{libelle}</p>
      <p className="text-2xl font-semibold leading-tight" style={{ color: couleur }}>
        {valeur}
      </p>
      {note && <p className="text-xs text-[var(--color-mute)] mt-0.5">{note}</p>}
    </div>
  );
}

/* ── LE PLACEMENT ──
   Un segment au centre, ses rattachements sur un cercle. Le rayon suit
   le NOMBRE de machines : à écart angulaire constant, deux points ne se
   chevauchent jamais, qu'il y en ait huit ou deux cents. */
function disposer(graphe) {
  /* Valeurs par défaut : cette fonction est appelée pendant le rendu, et
     une réponse inattendue du serveur ne doit pas faire tomber l'écran
     entier. Le contrôle de forme a lieu à la réception ; ici on se
     contente de ne jamais lever. */
  const tous = Array.isArray(graphe?.noeuds) ? graphe.noeuds : [];
  const aretes = Array.isArray(graphe?.liens) ? graphe.liens : [];
  const segments = tous.filter((n) => n.type === "segment");
  const parId = new Map(tous.map((n) => [n.id, n]));

  const grappes = segments.map((segment) => {
    const attaches = aretes
      .filter((l) => l.vers === segment.id)
      .map((l) => ({ lien: l, noeud: parId.get(l.de) }))
      .filter((x) => x.noeud);

    /* L'ordre n'est pas cosmétique : la passerelle d'abord, puis les
       postes qui ont parlé, puis le certain, puis le déduit. L'œil
       parcourt le cercle du plus sûr au moins sûr. */
    const rang = (x) =>
      x.lien.preuve === "passerelle" ? 0 :
      x.lien.preuve === "interface" ? 1 :
      x.lien.niveau === "certain" ? 2 : 3;
    attaches.sort((a, b) => rang(a) - rang(b) || String(a.noeud.libelle).localeCompare(String(b.noeud.libelle)));

    /* ── LES POINTS NOMMÉS SONT ÉCARTÉS LES UNS DES AUTRES ──
       La passerelle et les postes équipés sont les seuls à porter une
       étiquette. Rangés par ordre de sûreté, ils se retrouvaient côte à
       côte en haut du cercle et leurs deux noms se superposaient —
       visible du premier coup d'œil sur le premier rendu.

       On les répartit donc sur des positions régulièrement espacées, et
       le reste comble les places libres dans l'ordre. L'ordre de lecture
       — certain avant déduit — est préservé pour tout le reste, et la
       disposition reste déterministe. */
    const nommes = new Set(
      attaches.filter((a) => a.lien.preuve === "passerelle" || a.lien.preuve === "interface")
    );
    if (nommes.size > 0 && nommes.size < attaches.length) {
      const total = attaches.length;
      const places = new Array(total).fill(null);
      [...nommes].forEach((m, j) => {
        let place = Math.round((j * total) / nommes.size) % total;
        while (places[place]) place = (place + 1) % total;
        places[place] = m;
      });
      const reste = attaches.filter((a) => !nommes.has(a));
      let k = 0;
      for (let i = 0; i < total; i++) if (!places[i]) places[i] = reste[k++];
      attaches.splice(0, total, ...places);
    }

    const rayon = Math.max(100, Math.round((16 * attaches.length) / (2 * Math.PI)));
    return { segment, attaches, rayon, taille: 2 * (rayon + 46) };
  });

  /* Mise en page des grappes : une rangée, repliée quand elle déborde. */
  const LARGEUR_MAX = 1120;
  let x = 0, y = 0, hauteurRangee = 0, largeurMax = 0;
  for (const g of grappes) {
    if (x > 0 && x + g.taille > LARGEUR_MAX) {
      x = 0;
      y += hauteurRangee;
      hauteurRangee = 0;
    }
    g.cx = x + g.taille / 2;
    g.cy = y + g.taille / 2;
    x += g.taille;
    hauteurRangee = Math.max(hauteurRangee, g.taille);
    largeurMax = Math.max(largeurMax, x);
  }

  return { grappes, largeur: Math.max(largeurMax, 320), hauteur: y + hauteurRangee };
}

export default function TopologiePage({ idSite }) {
  const [graphe, setGraphe] = useState(null);
  const [etat, setEtat] = useState("chargement");
  const [survol, setSurvol] = useState(null);
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    let annule = false;
    setEtat("chargement");
    axios
      .get(`${API_URL}/topologie`, { params: { id_site: idSite || undefined } })
      .then(({ data }) => {
        if (annule) return;
        /* ON NE FAIT PAS CONFIANCE À LA FORME DE LA RÉPONSE.
           Un serveur resté sur une version antérieure, un intermédiaire
           qui renvoie une page, une route qui a changé d'adresse : tous
           répondent « 200 » avec autre chose qu'un graphe. L'écran doit
           alors nommer ce qu'il a reçu, pas s'effondrer sur un champ
           absent — un écran blanc n'apprend rien à personne. */
        if (!data || !Array.isArray(data.noeuds) || !Array.isArray(data.liens) || !data.couverture) {
          setDetail(decrire(data));
          setEtat("forme");
          return;
        }
        setGraphe(data);
        setEtat("pret");
      })
      .catch((err) => {
        if (annule) return;
        setDetail(
          err?.response?.data?.error ||
            (err?.response ? `le serveur a répondu ${err.response.status}` : "aucune réponse du serveur")
        );
        setEtat("erreur");
      });
    return () => { annule = true; };
  }, [idSite]);

  const plan = useMemo(() => (graphe ? disposer(graphe) : null), [graphe]);

  if (etat === "chargement") {
    return <p className="text-[var(--color-mute)]">Lecture des relevés…</p>;
  }
  if (etat === "erreur" || etat === "forme") {
    return (
      <div className="space-y-3 max-w-2xl">
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie</h1>
        <p className="text-[var(--color-crit)]">
          {etat === "forme"
            ? "Le serveur a répondu, mais pas un graphe."
            : "La carte n'a pas pu être lue."}
        </p>
        {detail && (
          <p className="text-sm text-[var(--color-mute)] font-[var(--font-mono)]">{detail}</p>
        )}
        <p className="text-sm text-[var(--color-mute)]">
          La cause la plus fréquente est un serveur resté sur la version
          précédente : la route de la carte a changé d'adresse le 2 octobre
          2026. Redémarrez le backend, puis rechargez cette page.
        </p>
      </div>
    );
  }

  const c = graphe.couverture;
  const inconnues = graphe.noeuds.filter((n) => n.type === "inconnu");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie</h1>
        <p className="text-sm text-[var(--color-mute)] mt-1">
          Reconstruite à chaque affichage à partir de ce que les postes équipés
          rapportent. Aucune position n'est enregistrée : personne n'a dessiné
          cette carte, et personne n'a à la tenir à jour.
        </p>
      </header>

      {/* ── RIEN À MONTRER : ON DIT QUOI FAIRE, PAS « AUCUNE DONNÉE » ──
          Une toile vide laisse l'utilisateur chercher la panne. */}
      {c.postes_ayant_repondu === 0 ? (
        <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
          <h2 className="font-semibold">Aucun poste n'a encore transmis sa vue du réseau</h2>
          <p className="text-sm text-[var(--color-mute)] mt-2 max-w-2xl">
            La carte se construit à partir des agents de poste. Un seul suffit à
            placer toutes les machines de son segment : il rapporte ses
            interfaces, sa passerelle et les adresses qu'il a réellement
            jointes.
          </p>
          <p className="text-sm text-[var(--color-mute)] mt-2">
            Installez l'agent sur un poste du réseau à cartographier, puis
            revenez ici.
          </p>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <Tuile libelle="Segments" valeur={c.segments} note="réseaux distincts" />
            <Tuile libelle="Équipements placés" valeur={c.equipements_rattaches} note="connus de l'inventaire" />
            <Tuile
              libelle="Adresses inconnues"
              valeur={c.adresses_inconnues}
              note="vues sur le fil, jamais inventoriées"
              ton={c.adresses_inconnues > 0 ? "alerte" : undefined}
            />
            <Tuile libelle="Postes ayant répondu" valeur={c.postes_ayant_repondu} note="sources de la carte" />
            <Tuile
              libelle="Interfaces écartées"
              valeur={c.interfaces_ecartees}
              note="virtuelles ou sans portée"
            />
          </section>

          {/* ── LÉGENDE : TOUJOURS PRÉSENTE ──
              Deux couleurs et deux styles de trait se lisent mal de mémoire,
              et pas du tout à l'impression en noir et blanc. */}
          <section className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[var(--color-mute)]">
            <span className="flex items-center gap-2">
              <svg width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="5" style={{ fill: COULEUR_CONNU }} />
              </svg>
              à l'inventaire
            </span>
            <span className="flex items-center gap-2">
              <svg width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" style={{ fill: "none", stroke: COULEUR_INCONNU, strokeWidth: 2 }} />
              </svg>
              adresse inconnue
            </span>
            <span className="flex items-center gap-2">
              <svg width="26" height="10" aria-hidden="true">
                <line x1="1" y1="5" x2="25" y2="5" style={{ stroke: "var(--color-mute)", strokeWidth: 2 }} />
              </svg>
              lien certain — mesuré
            </span>
            <span className="flex items-center gap-2">
              <svg width="26" height="10" aria-hidden="true">
                <line x1="1" y1="5" x2="25" y2="5" strokeDasharray="4 3"
                      style={{ stroke: "var(--color-mute)", strokeWidth: 2 }} />
              </svg>
              lien déduit — vu, non revérifié
            </span>
          </section>

          {/* La ligne de survol reste à la même place : avec des points de
              cinq pixels, une bulle qui suit la souris se lit plus mal
              qu'un texte dont on sait d'avance où il s'affiche. */}
          <p className="text-sm min-h-[1.5rem]">
            {survol ? (
              <>
                <span className="text-[var(--color-ink)] font-medium">{survol.noeud.libelle}</span>
                <span className="text-[var(--color-mute)]">
                  {survol.noeud.adresse_ip && survol.noeud.adresse_ip !== survol.noeud.libelle
                    ? ` — ${survol.noeud.adresse_ip}`
                    : ""}
                  {" · "}
                  {LIBELLE_PREUVE[survol.lien.preuve] || survol.lien.preuve}
                  {" · "}
                  {survol.lien.niveau === "certain" ? "certain" : "déduit"}
                  {survol.lien.detail ? ` (${survol.lien.detail})` : ""}
                </span>
              </>
            ) : (
              <span className="text-[var(--color-mute)]">
                Survolez un point pour savoir ce qui le rattache.
              </span>
            )}
          </p>

          {/* DES POSTES ONT PARLÉ, MAIS AUCUN SEGMENT N'EN RESSORT.
              Le cas est rare et il est réel : il suffit que les seules
              cartes d'un poste soient virtuelles, ou qu'aucune n'ait de
              passerelle. Un cadre vide de hauteur nulle laisserait
              croire à un défaut d'affichage. */}
          {plan.grappes.length === 0 ? (
            <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <h2 className="font-semibold">Aucun segment exploitable dans les relevés</h2>
              <p className="text-sm text-[var(--color-mute)] mt-2 max-w-2xl">
                {c.postes_ayant_repondu} poste(s) ont transmis, mais toutes leurs
                interfaces ont été écartées : cartes virtuelles, boucle locale ou
                adresses auto-attribuées. Le détail carte par carte est donné par{" "}
                <span className="font-[var(--font-mono)]">tools/diagnostic-topologie.js</span>.
              </p>
            </section>
          ) : (
          <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 overflow-x-auto">
            <svg
              viewBox={`0 0 ${plan.largeur} ${plan.hauteur}`}
              className="w-full h-auto"
              role="img"
              aria-label={`Carte du réseau : ${c.segments} segment(s), ${c.equipements_rattaches + c.adresses_inconnues} adresses placées`}
            >
              {plan.grappes.map((g) => (
                <g key={g.segment.id}>
                  {g.attaches.map((a, i) => {
                    const angle = (i / g.attaches.length) * 2 * Math.PI - Math.PI / 2;
                    const x = g.cx + g.rayon * Math.cos(angle);
                    const y = g.cy + g.rayon * Math.sin(angle);
                    const certain = a.lien.niveau === "certain";
                    const connu = a.noeud.type === "equipement";
                    const majeur = a.lien.preuve === "passerelle" || a.lien.preuve === "interface";
                    const actif = survol && survol.noeud.id === a.noeud.id;

                    return (
                      <g key={a.noeud.id + a.lien.preuve}>
                        <line
                          x1={g.cx} y1={g.cy} x2={x} y2={y}
                          strokeDasharray={certain ? undefined : "4 3"}
                          style={{
                            stroke: "var(--color-line)",
                            strokeWidth: majeur ? 2 : 1,
                            opacity: actif ? 1 : certain ? 0.6 : 0.4,
                          }}
                        />
                        <circle
                          cx={x} cy={y}
                          r={majeur ? 7 : actif ? 6 : 4.5}
                          style={{
                            fill: connu ? COULEUR_CONNU : "none",
                            stroke: connu ? "var(--color-surface)" : COULEUR_INCONNU,
                            strokeWidth: 2,
                            cursor: "pointer",
                          }}
                          onMouseEnter={() => setSurvol(a)}
                          onMouseLeave={() => setSurvol(null)}
                        >
                          <title>{`${a.noeud.libelle} — ${certain ? "certain" : "déduit"}`}</title>
                        </circle>
                        {majeur && (
                          <text
                            x={x} y={y - 12}
                            textAnchor="middle"
                            style={{ fill: "var(--color-ink)", fontSize: 11 }}
                          >
                            {a.noeud.libelle}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Le segment, au centre. */}
                  <rect
                    x={g.cx - 78} y={g.cy - 17} width={156} height={34} rx={8}
                    style={{ fill: "var(--color-surface-2)", stroke: "var(--color-line)", strokeWidth: 1 }}
                  />
                  <text
                    x={g.cx} y={g.cy + 5}
                    textAnchor="middle"
                    style={{ fill: "var(--color-ink)", fontSize: 14, fontWeight: 600 }}
                  >
                    {g.segment.libelle}
                  </text>
                </g>
              ))}
            </svg>
          </section>
          )}

          {/* ── LA LISTE QUI SE LIT VRAIMENT ──
              Dix-neuf points sur un cercle ne se recopient pas. Ici elles
              s'énumèrent, et c'est la seule partie de l'écran sur laquelle
              on peut agir aujourd'hui. */}
          {inconnues.length > 0 && (
            <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <h2 className="font-semibold">
                {inconnues.length} adresse(s) vues sur le réseau, absentes de l'inventaire
              </h2>
              <p className="text-sm text-[var(--color-mute)] mt-1 max-w-3xl">
                Ces adresses ont réellement échangé des trames avec un poste
                équipé. Qu'aucun scan ne les ait enregistrées veut dire que la
                plage n'est pas déclarée, que le scan n'a pas été relancé, ou que
                la machine ne répond qu'à ses voisins.
              </p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {inconnues.map((n) => (
                  <li
                    key={n.id}
                    className="font-[var(--font-mono)] text-xs px-2 py-1 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)]"
                  >
                    {n.adresse_ip}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ── CE QUE LA CARTE NE DIT PAS ──
              À l'écran, pas en annexe : c'est la phrase qui empêche de lire
              un segment comme une armoire de brassage. */}
          <section className="text-xs text-[var(--color-mute)] max-w-3xl leading-relaxed">
            Cette carte montre des <strong className="font-medium">segments</strong> et
            des rattachements, pas des câbles. Le port physique d'un commutateur
            ne peut être connu que si ce commutateur répond en SNMP ; un
            commutateur non administrable n'apparaît pas du tout, et les
            machines placées derrière lui semblent raccordées au reste du
            segment. {c.interfaces_ecartees > 0 && (
              <>Sur ce relevé, {c.interfaces_ecartees} interface(s) ont été écartées
              (cartes virtuelles, boucle locale, adresses auto-attribuées) ; le détail
              est donné par <span className="font-[var(--font-mono)]">tools/diagnostic-topologie.js</span>.</>
            )}
          </section>
        </>
      )}
    </div>
  );
}
