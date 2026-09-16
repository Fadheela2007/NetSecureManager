import { useEffect, useMemo, useState } from "react";
import axios from "axios";

import { decrireErreur } from "../utils/erreurReseau";
import { nomAffiche } from "./EquipementsPage";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Topologie réseau — deux cartes, et elles ne disent pas la même chose.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE CETTE PAGE FAISAIT, ET POURQUOI ÇA NE SERVAIT À RIEN
 *
 * Elle dessinait une étoile : le centre était l'équipement dont l'adresse
 * se termine par .1, .254 ou .155 — une supposition — et tous les autres
 * y étaient reliés. Ces liens n'existaient nulle part : ni en base, ni sur
 * le réseau. Le dessin était joli et ne disait rien.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA CARTE PHYSIQUE : QUI EST BRANCHÉ SUR QUEL PORT
 *
 * Les liens lus dans la table d'apprentissage des adresses MAC des
 * commutateurs (BRIDGE-MIB). Un lien affiché signifie : cette machine est
 * branchée sur ce port, constaté par le commutateur lui-même. C'est la
 * seule source qui réponde à « si ce commutateur tombe, qui perd le
 * réseau ? ».
 *
 * Elle exige un commutateur administrable interrogeable en SNMP. Sur un
 * parc qui n'en a pas, elle reste vide — et c'est honnête.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA CARTE LOGIQUE : QUI PARTAGE LE MÊME RÉSEAU
 *
 * Mais rester sur un écran entièrement vide était un défaut à son tour.
 * Un parc inventorié à 105 machines n'est pas un parc dont on ne sait
 * rien : on sait quelles machines partagent un même réseau, combien il y
 * en a de chaque sorte, et lesquelles répondent. Ça ne dit pas sur quel
 * port elles sont branchées — et cette page l'écrit noir sur blanc.
 *
 * D'OÙ VIENNENT CES GROUPES. Du plan d'adressage déclaré (table
 * PLAGE_SCAN) croisé avec les adresses des équipements. Deux machines
 * figurent dans le même bloc parce que leurs adresses appartiennent à la
 * même plage déclarée — c'est un fait, pas une déduction. Les machines
 * dont l'adresse ne tombe dans aucune plage sont montrées à part, jamais
 * rattachées d'office à un bloc.
 *
 * LA DIFFÉRENCE EST ÉCRITE, PAS SOUS-ENTENDUE. Les deux cartes portent un
 * titre qui dit ce qu'elle prouve. Confondre « sur le même réseau » et
 * « sur le même commutateur » ferait envoyer un technicien au mauvais
 * endroit, et c'est exactement ce que l'ancienne étoile provoquait.
 */

const COULEUR_STATUT = {
  up: "var(--color-ok)",
  down: "var(--color-crit)",
  inconnu: "var(--color-mute)",
};

/* ── Arithmétique d'adresses, côté écran ──
   Le serveur a la sienne (services/adressesIp.js) ; la recopier ici
   éviterait un aller-retour par équipement. Trois lignes, sans
   dépendance, et le calcul se fait sur des données déjà chargées. */
function ipEnNombre(ip) {
  const parties = String(ip || "").split(".");
  if (parties.length !== 4) return null;
  let n = 0;
  for (const p of parties) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

function plageContient(cidr, ip) {
  const [base, bits] = String(cidr || "").split("/");
  const prefixe = Number(bits);
  const debut = ipEnNombre(base);
  const adresse = ipEnNombre(ip);
  if (debut === null || adresse === null || !Number.isInteger(prefixe)) return false;
  if (prefixe < 0 || prefixe > 32) return false;
  // Décalage en puissance de 2 plutôt qu'en `<<` : au-delà de 31 bits,
  // les opérateurs binaires de JavaScript repassent en 32 bits signés.
  const taille = Math.pow(2, 32 - prefixe);
  const reseau = Math.floor(debut / taille) * taille;
  return adresse >= reseau && adresse < reseau + taille;
}

function compter(liste) {
  return {
    total: liste.length,
    up: liste.filter((e) => e.statut === "up").length,
    down: liste.filter((e) => e.statut === "down").length,
    inconnu: liste.filter((e) => e.statut !== "up" && e.statut !== "down").length,
  };
}

/** Les équipements d'un bloc, regroupés par type, du plus nombreux au moins. */
function parType(liste) {
  const groupes = new Map();
  for (const eq of liste) {
    const cle = eq.type_libelle || "non classé";
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(eq);
  }
  return [...groupes.entries()]
    .map(([type, equipements]) => ({ type, equipements }))
    .sort((a, b) => b.equipements.length - a.equipements.length);
}

function Pastille({ statut }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: COULEUR_STATUT[statut] || COULEUR_STATUT.inconnu }}
    />
  );
}

/** Une branche : un type d'équipement, son effectif, et la liste au clic. */
function Branche({ type, equipements }) {
  const [ouvert, setOuvert] = useState(false);
  const c = compter(equipements);

  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg overflow-hidden">
      <button
        onClick={() => setOuvert((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface)] transition"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-[var(--color-ink)]">{type}</span>
          <span className="font-[var(--font-display)] text-lg font-semibold text-[var(--color-ink)]">
            {c.total}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--color-mute)]">
          {c.up > 0 && (
            <span className="flex items-center gap-1">
              <Pastille statut="up" />
              {c.up}
            </span>
          )}
          {c.down > 0 && (
            <span className="flex items-center gap-1">
              <Pastille statut="down" />
              {c.down}
            </span>
          )}
          {c.inconnu > 0 && (
            <span className="flex items-center gap-1">
              <Pastille statut="inconnu" />
              {c.inconnu}
            </span>
          )}
          <span className="ml-auto">{ouvert ? "▲" : "▼"}</span>
        </div>
      </button>

      {ouvert && (
        <ul className="border-t border-[var(--color-line)] max-h-64 overflow-y-auto">
          {[...equipements]
            .sort((a, b) => (ipEnNombre(a.adresse_ip) || 0) - (ipEnNombre(b.adresse_ip) || 0))
            .map((eq) => (
              <li
                key={eq.id_equipement}
                className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-[var(--color-line)] last:border-0"
              >
                <Pastille statut={eq.statut} />
                <span className="text-[var(--color-ink)] truncate">
                  {nomAffiche(eq) || "—"}
                </span>
                <span className="ml-auto font-[var(--font-mono)] text-[var(--color-mute)] shrink-0">
                  {eq.adresse_ip}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/** Un réseau déclaré, et tout ce qui y vit. */
function Bloc({ titre, sousTitre, equipements }) {
  const c = compter(equipements);
  const branches = parType(equipements);

  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-[var(--font-mono)] text-base text-[var(--color-ink)]">{titre}</h2>
        <span className="text-xs text-[var(--color-mute)]">
          {c.total} équipement(s) — {c.up} en ligne
          {c.down > 0 && `, ${c.down} hors ligne`}
          {c.inconnu > 0 && `, ${c.inconnu} état inconnu`}
        </span>
      </div>
      {sousTitre && (
        <p className="text-[11px] text-[var(--color-mute)] mt-1">{sousTitre}</p>
      )}

      {/* Le trait qui descend du bloc vers ses branches : il porte la
          lecture « tout ceci est dans ce réseau », sans prétendre à un
          câble. */}
      <div className="mt-4 pl-4 border-l-2 border-[var(--color-line)]">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {branches.map((b) => (
            <Branche key={b.type} type={b.type} equipements={b.equipements} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function TopologyPage({ idSite }) {
  const [liens, setLiens] = useState([]);
  const [couverture, setCouverture] = useState(null);
  const [equipements, setEquipements] = useState([]);
  const [plages, setPlages] = useState([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    setErreur(null);
    setChargement(true);

    /* Les trois lectures partent ensemble. La carte logique ne dépend pas
       de la physique : une plateforme qui attend la seconde pour afficher
       la première ferait attendre pour rien. */
    Promise.all([
      axios.get(`${API_URL}/topologie`, { params: { id_site: idSite } }),
      axios.get(`${API_URL}/equipements`, { params: { id_site: idSite } }),
      axios.get(`${API_URL}/plages`, { params: { id_site: idSite } }),
    ])
      .then(([topo, eq, pl]) => {
        setLiens(topo.data?.liens ?? []);
        setCouverture(topo.data?.couverture ?? null);
        setEquipements(Array.isArray(eq.data) ? eq.data : []);
        setPlages(Array.isArray(pl.data) ? pl.data : []);
      })
      .catch((err) => setErreur(decrireErreur(err, "La topologie")))
      .finally(() => setChargement(false));
  }, [idSite]);

  // Un commutateur, ses ports, et ce qui est branché dessus.
  const commutateurs = useMemo(() => {
    const parSwitch = liens.reduce((acc, l) => {
      if (!acc[l.id_switch]) {
        acc[l.id_switch] = {
          id: l.id_switch,
          libelle: l.switch_libelle || l.switch_nom || l.switch_ip,
          ip: l.switch_ip,
          ports: [],
        };
      }
      acc[l.id_switch].ports.push(l);
      return acc;
    }, {});
    return Object.values(parSwitch);
  }, [liens]);

  /* Répartition des équipements dans les plages déclarées. Une machine
     n'est comptée qu'une fois : la première plage qui la contient la
     prend. Des plages qui se recouvrent sont une erreur de saisie, pas
     une machine présente à deux endroits. */
  const blocs = useMemo(() => {
    const pris = new Set();
    const resultat = [];

    for (const p of plages) {
      const dedans = equipements.filter(
        (e) => !pris.has(e.id_equipement) && plageContient(p.cidr, e.adresse_ip)
      );
      dedans.forEach((e) => pris.add(e.id_equipement));
      if (dedans.length > 0) resultat.push({ cidr: p.cidr, equipements: dedans });
    }

    const orphelins = equipements.filter((e) => !pris.has(e.id_equipement));
    return { resultat, orphelins };
  }, [plages, equipements]);

  if (erreur) {
    return (
      <div className="space-y-5">
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
        <p className="text-sm text-[var(--color-crit)]">{erreur.titre}</p>
        <p className="text-sm text-[var(--color-mute)]">{erreur.detail}</p>
      </div>
    );
  }

  if (chargement) {
    return (
      <div className="space-y-5">
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
        <p className="text-sm text-[var(--color-mute)]">Chargement…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Deux lectures du même parc : qui partage le même réseau, et — quand un
          commutateur le déclare — qui est branché sur quel port.
        </p>
      </div>

      {/* ── CARTE PHYSIQUE ── */}
      {commutateurs.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium text-[var(--color-ink)]">
              Raccordements physiques
            </h2>
            <p className="text-xs text-[var(--color-mute)] mt-0.5">
              Constatés par les commutateurs eux-mêmes — quelle machine est
              branchée sur quel port.
            </p>
          </div>

          {couverture && (
            <p className="text-sm text-[var(--color-mute)]">
              <span className="text-[var(--color-ink)] font-medium">
                {couverture.raccordes} équipement(s) localisé(s)
              </span>{" "}
              sur {couverture.equipements}. Les autres sont bien supervisés, mais
              leur point de raccordement n'est pas déclaré par un commutateur.
            </p>
          )}

          <div className="space-y-4">
            {commutateurs.map((sw) => (
              <div
                key={sw.id}
                className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-5"
              >
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <h3 className="font-medium text-[var(--color-ink)]">{sw.libelle}</h3>
                  <span className="text-xs text-[var(--color-mute)] font-[var(--font-mono)]">
                    {sw.ip}
                  </span>
                </div>

                {/* La question à laquelle cette carte doit répondre. */}
                <p className="text-xs text-[var(--color-mute)] mb-3">
                  Si ce commutateur tombe, {sw.ports.length} machine(s) perdent le réseau.
                </p>

                <ul className="space-y-1">
                  {sw.ports.map((p) => (
                    <li
                      key={`${p.id_switch}-${p.port}`}
                      className="flex items-center gap-3 text-xs bg-[var(--color-surface-2)] rounded px-3 py-2"
                    >
                      <span className="font-[var(--font-mono)] text-[var(--color-mute)] w-20 shrink-0">
                        port {p.port}
                      </span>
                      <Pastille statut={p.statut} />
                      <span className="text-[var(--color-ink)] truncate">
                        {p.equipement_nom || p.adresse_ip}
                      </span>
                      <span className="text-[var(--color-mute)] font-[var(--font-mono)] shrink-0">
                        {p.adresse_ip}
                      </span>
                      {p.type_equipement && (
                        <span className="text-[var(--color-mute)] ml-auto shrink-0">
                          {p.type_equipement}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── CARTE LOGIQUE ── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--color-ink)]">
            Vue logique — qui partage le même réseau
          </h2>
          <p className="text-xs text-[var(--color-mute)] mt-0.5 leading-relaxed">
            Établie à partir du plan d'adressage et des adresses relevées. Elle
            dit qui vit sur le même réseau et ce qui s'y trouve —{" "}
            <span className="text-[var(--color-ink)]">
              pas sur quel port chaque machine est branchée
            </span>
            . Cliquez un groupe pour voir les machines.
          </p>
        </div>

        {blocs.resultat.length === 0 && blocs.orphelins.length === 0 ? (
          <p className="text-sm text-[var(--color-mute)]">
            Aucun équipement sur ce site pour le moment. Lancez un scan depuis la
            page Scan pour peupler la carte.
          </p>
        ) : (
          <div className="space-y-4">
            {blocs.resultat.map((b) => (
              <Bloc
                key={b.cidr}
                titre={b.cidr}
                sousTitre="Plage déclarée dans le plan d'adressage."
                equipements={b.equipements}
              />
            ))}

            {blocs.orphelins.length > 0 && (
              <Bloc
                titre="Hors plage déclarée"
                sousTitre={
                  "Ces adresses ne tombent dans aucune plage de scan enregistrée. " +
                  "Elles viennent d'un agent, d'un import, ou d'une plage retirée depuis."
                }
                equipements={blocs.orphelins}
              />
            )}
          </div>
        )}

        {commutateurs.length === 0 && (
          <p className="text-xs text-[var(--color-mute)] leading-relaxed border-t border-[var(--color-line)] pt-3">
            La carte des raccordements physiques n'apparaît pas : elle se lit dans
            la table d'adresses des commutateurs, en SNMP, et aucun commutateur
            administrable n'a encore répondu sur ce site. Un commutateur non
            administrable ne déclare rien — l'inventaire et la supervision
            fonctionnent, la carte des câbles non.
          </p>
        )}
      </section>
    </div>
  );
}
