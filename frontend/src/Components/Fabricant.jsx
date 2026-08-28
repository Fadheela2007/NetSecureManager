/**
 * Affichage du fabricant, avec sa provenance.
 *
 * La nuance compte face à un administrateur réseau : un fabricant obtenu
 * par SNMP est le constructeur déclaré de l'équipement, alors qu'un
 * fabricant obtenu par OUI est celui de la CARTE réseau. Un serveur Dell
 * équipé d'une carte Intel remontera « Intel ».
 *
 * Le parti pris est de rester discret : un point médian et un mot en gris,
 * pas de badge coloré. Sur une liste de 150 équipements, un marqueur
 * voyant sur presque chaque ligne deviendrait du bruit. L'infobulle porte
 * l'explication complète pour qui veut la lire.
 */

const LIBELLES = {
  snmp: {
    court: null, // source la plus fiable : rien à signaler
    aide: "Fabricant déclaré par l'équipement lui-même (SNMP).",
  },
  oui: {
    court: "carte réseau",
    aide:
      "Déduit de l'adresse MAC (registre OUI de l'IEEE). Désigne le fabricant " +
      "de la carte réseau, qui peut différer de celui de l'équipement.",
  },
  nmap: {
    court: "d'après l'OS",
    aide: "Déduit du système d'exploitation détecté par nmap. Désigne l'éditeur, pas le constructeur.",
  },
  mac_aleatoire: {
    court: null,
    aide:
      "Adresse MAC aléatoire (confidentialité). Elle ne correspond à aucun " +
      "fabricant réel : fréquent sur les smartphones récents.",
  },
};

export default function Fabricant({ nom, source }) {
  if (source === "mac_aleatoire") {
    return (
      <span className="text-[var(--color-mute)]" title={LIBELLES.mac_aleatoire.aide}>
        MAC aléatoire
      </span>
    );
  }

  if (!nom) {
    return <span className="text-[var(--color-mute)]">inconnu</span>;
  }

  const info = LIBELLES[source];

  return (
    <span title={info?.aide}>
      {nom}
      {info?.court && (
        <span className="text-[var(--color-mute)] text-[11px]"> · {info.court}</span>
      )}
    </span>
  );
}
