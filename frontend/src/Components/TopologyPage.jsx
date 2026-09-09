import { useEffect, useState } from "react";
import axios from "axios";
import EtatVide from "./EtatVide";

import { decrireErreur } from "../utils/erreurReseau";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

/**
 * Topologie réseau — les raccordements RÉELLEMENT établis.
 *
 * CE QUE CETTE PAGE FAISAIT, ET POURQUOI ÇA NE SERVAIT À RIEN
 *
 * Elle dessinait une étoile : le centre était l'équipement dont l'adresse
 * se termine par .1, .254 ou .155 — une supposition — et tous les autres
 * y étaient reliés. Ces liens n'existaient nulle part : ni en base, ni sur
 * le réseau. Le dessin était joli et ne disait rien.
 *
 * Il ne pouvait donc pas répondre à la seule question qui justifie une
 * carte réseau : « si ce commutateur tombe, qui perd le réseau ? »
 *
 * CE QU'ELLE MONTRE MAINTENANT
 *
 * Les liens lus dans la table d'apprentissage des adresses MAC des
 * commutateurs (BRIDGE-MIB) — la même source que la bande passante par
 * machine. Un lien affiché signifie : cette machine est branchée sur ce
 * port, constaté par le commutateur lui-même.
 *
 * Ce qui n'est pas connu est compté et laissé de côté, jamais rattaché
 * d'office à un nœud. Un lien inventé est pire qu'un lien absent, parce
 * qu'on s'en sert pour décider d'une intervention.
 */

const COULEUR_STATUT = {
  up: "var(--color-ok)",
  down: "var(--color-crit)",
  inconnu: "var(--color-mute)",
};

export default function TopologyPage({ idSite }) {
  const [liens, setLiens] = useState([]);
  const [couverture, setCouverture] = useState(null);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState(null);

  useEffect(() => {
    setErreur(null);
    setChargement(true);
    axios
      .get(`${API_URL}/topologie`, { params: { id_site: idSite } })
      .then(({ data }) => {
        setLiens(data?.liens ?? []);
        setCouverture(data?.couverture ?? null);
      })
      .catch((err) => setErreur(decrireErreur(err, "La topologie")))
      .finally(() => setChargement(false));
  }, [idSite]);

  // Un commutateur, ses ports, et ce qui est branché dessus.
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
  const commutateurs = Object.values(parSwitch);

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
    <div className="space-y-5">
      <div>
        <h1 className="font-[var(--font-display)] text-xl font-semibold">Topologie réseau</h1>
        <p className="text-sm text-[var(--color-mute)] mt-0.5">
          Raccordements constatés par les commutateurs eux-mêmes — quelle machine
          est branchée sur quel port.
        </p>
      </div>

      {commutateurs.length === 0 ? (
        /* PAS DE DESSIN PLUTÔT QU'UN DESSIN FAUX.
           Sans commutateur administrable, aucun raccordement n'est
           connaissable : le réseau ne le déclare nulle part. On dit ce
           qui manque et pourquoi, au lieu d'inventer une étoile. */
        <EtatVide
          titre="Aucun raccordement connu"
          ton="etape"
          /* DIRE CE QU'ON SAIT, PAS SEULEMENT CE QU'ON IGNORE.

             L'écran annonçait « aucun raccordement connu » sans rappeler
             que le parc, lui, est parfaitement inventorié et supervisé.
             Un utilisateur qui arrive là conclut que la plateforme ne
             fonctionne pas, alors qu'il lui manque un équipement réseau —
             ce qui n'est pas la même conversation. */
          explication={
            (couverture
              ? `Les ${couverture.equipements} équipement(s) de ce site sont bien ` +
                "inventoriés et supervisés ; c'est leur emplacement physique qui " +
                "reste inconnu. "
              : "") +
            "Les liens entre machines se lisent dans la table d'adresses des " +
            "commutateurs, en SNMP. Aucun commutateur administrable n'a encore " +
            "été interrogé sur ce site."
          }
          aide={
            "Un commutateur non administrable ne déclare rien : l'inventaire et " +
            "les pannes continuent de fonctionner, la carte des liens non."
          }
        />
      ) : (
        <>
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
                  <h2 className="font-medium text-[var(--color-ink)]">{sw.libelle}</h2>
                  <span className="text-xs text-[var(--color-mute)] font-[var(--font-mono)]">
                    {sw.ip}
                  </span>
                </div>

                {/* La question à laquelle cette page doit répondre. */}
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
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: COULEUR_STATUT[p.statut] || COULEUR_STATUT.inconnu }}
                      />
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
        </>
      )}
    </div>
  );
}
