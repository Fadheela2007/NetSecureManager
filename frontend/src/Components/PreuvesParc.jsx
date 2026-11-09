import { useEffect, useState } from "react";
import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/* ══════════════════════════════════════════════════════════════════════
   SUR QUOI NOUS NOUS FONDONS

   ── CE QUE LES AUTRES OUTILS NE DISENT PAS ──

   Tous affichent un état : en ligne, hors ligne. Aucun ne dit D'OÙ il le
   tient. Et la différence est énorme :

     • une réponse au ping, c'est une machine qui a parlé il y a une
       minute ;
     • un voisinage ARP, c'est un switch qui se SOUVIENT d'une adresse —
       la machine peut être éteinte depuis une heure ;
     • un port ouvert sur une machine muette au ping, c'est un pare-feu
       qui filtre, pas une panne.

   Les trois se présentent identiquement sur un écran ordinaire. Ici,
   chaque machine porte déjà sa preuve et sa date sur sa fiche : ce bloc
   les additionne pour le parc entier.

   ── POURQUOI SOUS LE LANCEUR DE SCAN ──

   Parce qu'un scan est ce qui FABRIQUE ces preuves. Lire ce qu'il a
   établi juste sous le bouton qui le déclenche ferme la boucle : on
   voit ce que la dernière exploration a réellement démontré, pas
   seulement combien de machines elle a trouvées.

   ── UNE SEULE COULEUR, ET C'EST VOULU ──

   Les barres comparent des GRANDEURS, pas des catégories : c'est le
   libellé à gauche qui porte l'identité, pas la teinte. Sept couleurs
   auraient obligé à une légende, et donné à l'œil sept choses à relier
   là où il n'y a qu'une quantité à lire.
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Ce que chaque preuve vaut RÉELLEMENT.
 *
 * La deuxième ligne est la plus importante du bloc : c'est elle qui
 * distingue « la machine a parlé » de « quelque chose se souvient
 * d'elle ».
 */
const PREUVES = {
  ping: {
    libelle: "Réponse au ping",
    sens: "la machine a répondu elle-même",
    force: "forte",
  },
  snmp: {
    libelle: "Réponse SNMP",
    sens: "la machine a répondu et s'est décrite",
    force: "forte",
  },
  agent_poste: {
    libelle: "Agent installé",
    sens: "un programme tourne dessus et transmet",
    force: "forte",
  },
  port_ouvert: {
    libelle: "Port ouvert",
    sens: "muette au ping, mais un service répond — un pare-feu filtre",
    force: "moyenne",
  },
  refus_tcp: {
    libelle: "Refus TCP",
    sens: "elle a refusé une connexion : quelqu'un est là pour refuser",
    force: "moyenne",
  },
  nmap: {
    libelle: "Empreinte nmap",
    sens: "reconnue à sa façon de répondre",
    force: "moyenne",
  },
  voisinage_arp: {
    libelle: "Voisinage ARP",
    sens: "un équipement se souvient d'elle — elle peut être éteinte",
    force: "faible",
  },
  inconnue: {
    libelle: "Aucune preuve datée",
    sens: "inscrite avant que les preuves ne soient enregistrées",
    force: "faible",
  },
};

const COULEUR_FORCE = {
  forte: "var(--color-ok)",
  moyenne: "var(--color-signal)",
  faible: "var(--color-mute)",
};

/** « il y a 3 jours », à partir d'une date. */
function depuis(valeur) {
  if (!valeur) return null;
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) return null;

  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 2) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.round(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.round(heures / 24);
  return `il y a ${jours} jour${jours > 1 ? "s" : ""}`;
}

export default function PreuvesParc({ idSite }) {
  const [donnees, setDonnees] = useState(null);

  useEffect(() => {
    let annule = false;
    axios
      .get(`${API_URL}/supervision/preuves`, {
        params: { id_site: idSite || undefined },
      })
      .then(({ data }) => {
        if (!annule) setDonnees(data);
      })
      .catch(() => {
        // Ce bloc est un complément : son échec ne doit rien afficher,
        // surtout pas une erreur au milieu d'un tableau de bord qui, lui,
        // fonctionne.
        if (!annule) setDonnees(null);
      });
    return () => {
      annule = true;
    };
  }, [idSite]);

  if (!donnees || donnees.indisponible || donnees.total === 0) return null;

  const maximum = donnees.preuves.reduce((m, p) => Math.max(m, p.nombre), 0);

  return (
    <section className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
      <h2 className="font-[var(--font-display)] text-sm font-semibold">
        Sur quoi nous nous fondons
      </h2>
      <p className="text-xs text-[var(--color-mute)] mt-0.5 mb-4 max-w-2xl">
        Chacune des {donnees.total} machines de l'inventaire y est parce que
        quelque chose l'a prouvé. Voici quoi, et depuis quand.
      </p>

      <ul className="space-y-3">
        {donnees.preuves.map((p) => {
          const info = PREUVES[p.preuve] || {
            libelle: p.preuve,
            sens: "",
            force: "faible",
          };
          const part = donnees.total > 0 ? (p.nombre / donnees.total) * 100 : 0;
          const anciennete = depuis(p.plus_ancienne);

          return (
            <li key={p.preuve}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-[var(--color-ink)]">
                  {info.libelle}
                  {/* LA FORCE DE LA PREUVE EST ÉCRITE, pas seulement
                      teintée : une pastille de couleur seule ne se lit
                      ni sans distinguer les couleurs, ni à l'impression. */}
                  <span
                    className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border align-middle"
                    style={{
                      borderColor: COULEUR_FORCE[info.force],
                      color: COULEUR_FORCE[info.force],
                    }}
                  >
                    preuve {info.force}
                  </span>
                </span>
                <span className="text-sm tabular-nums text-[var(--color-ink)] whitespace-nowrap">
                  {p.nombre}
                  <span className="text-[var(--color-mute)] text-xs">
                    {" "}
                    · {Math.round(part)} %
                  </span>
                </span>
              </div>

              <div className="h-1 rounded-full bg-[var(--color-surface-2)] overflow-hidden mt-1.5">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${maximum > 0 ? (p.nombre / maximum) * 100 : 0}%`,
                    background: "var(--color-signal)",
                  }}
                />
              </div>

              <p className="text-[11px] text-[var(--color-mute)] mt-1">
                {info.sens}
                {/* LA DATE COMPTE AUTANT QUE LA PREUVE. « 12 machines vues
                    par ARP » ne dit rien ; « la plus ancienne il y a trois
                    semaines » dit qu'un tiers de l'inventaire est peut-être
                    fantôme. */}
                {anciennete && ` — la plus ancienne ${anciennete}`}
              </p>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-[var(--color-mute)] border-t border-[var(--color-line)] mt-4 pt-3 max-w-2xl">
        Un outil de supervision ordinaire affiche « en ligne » sans dire d'où il
        le tient. Une machine vue par le souvenir d'un switch et une machine qui
        vient de répondre n'ont pourtant rien à voir.
      </p>
    </section>
  );
}
