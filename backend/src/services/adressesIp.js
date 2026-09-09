/**
 * services/adressesIp.js
 * Arithmétique d'adresses IPv4 — le strict nécessaire, écrit ici.
 *
 * POURQUOI CE MODULE REMPLACE UNE BIBLIOTHÈQUE.
 *
 * Le projet dépendait du paquet « ip ». Il est signalé vulnérable par
 * l'outil d'audit standard (SSRF dans `isPublic`), **sans correctif
 * publié**, et n'est plus maintenu.
 *
 * Le risque réel était nul : la fonction fautive n'est jamais appelée ici.
 * Mais un acheteur qui lance `npm audit` sur une plateforme de SÉCURITÉ
 * réseau voit « high severity », et cette conversation part mal — sans
 * qu'on puisse répondre « corrigez la dépendance », puisqu'il n'existe
 * pas de correctif.
 *
 * Trois fonctions étaient utilisées, plus `contains` sur le résultat.
 * L'arithmétique IPv4 tient en quelques dizaines de lignes, se teste
 * exhaustivement, et ne dépend plus de personne.
 *
 * PORTÉE : IPv4 uniquement, comme l'usage qui en est fait — découverte de
 * plages, appartenance à un sous-réseau. IPv6 demanderait une autre
 * représentation (les entiers 32 bits n'y suffisent pas) et n'est pas
 * couvert par le produit aujourd'hui.
 */

const MOTIF_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Adresse IPv4 en entier non signé.
 *
 * `>>> 0` n'est pas décoratif : en JavaScript les opérateurs binaires
 * travaillent sur des entiers SIGNÉS 32 bits. Sans lui, toute adresse
 * dont le premier octet dépasse 127 — soit tout le réseau 192.168.x.x —
 * ressortirait négative, et les comparaisons de plage seraient fausses.
 */
function toLong(ip) {
  const m = MOTIF_IPV4.exec(String(ip).trim());
  if (!m) throw new Error(`Adresse IPv4 invalide : « ${ip} »`);

  let valeur = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Adresse IPv4 invalide : « ${ip} »`);
    }
    valeur = (valeur << 8) | octet;
  }
  return valeur >>> 0;
}

/** Entier non signé en adresse IPv4 pointée. */
function fromLong(valeur) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`Entier hors du domaine IPv4 : ${valeur}`);
  }
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * Décrit le sous-réseau désigné par une notation CIDR.
 *
 * LES CAS /31 ET /32 SONT PARTICULIERS, ET C'EST VOULU.
 *
 * Dans un sous-réseau ordinaire, la première adresse désigne le réseau et
 * la dernière la diffusion : aucune des deux n'est attribuable à une
 * machine, d'où le +1 / -1. Un /31 ne contient que ces deux-là (liaison
 * point à point, RFC 3021) et un /32 une seule adresse. Leur retirer les
 * bornes ne laisserait rien, et le balayage d'une adresse unique — cas
 * courant pour vérifier une machine précise — ne rendrait aucun hôte.
 *
 * @returns {{networkAddress:string, broadcastAddress:string,
 *            firstAddress:string, lastAddress:string,
 *            subnetMaskLength:number, contains:(ip:string)=>boolean}}
 */
function cidrSubnet(cidr) {
  const brut = String(cidr).trim();
  const barre = brut.indexOf("/");
  if (barre === -1) throw new Error(`Notation CIDR invalide : « ${cidr} »`);

  const adresse = brut.slice(0, barre);
  const longueur = Number(brut.slice(barre + 1));
  if (!Number.isInteger(longueur) || longueur < 0 || longueur > 32) {
    throw new Error(`Longueur de préfixe invalide : « ${cidr} »`);
  }

  const adresseLong = toLong(adresse);
  // `longueur === 0` : décaler de 32 bits est un décalage de 0 en
  // JavaScript (l'opérande est pris modulo 32). Le masque vaudrait donc
  // 0xffffffff au lieu de 0 — le cas est traité à part.
  const masque = longueur === 0 ? 0 : (0xffffffff << (32 - longueur)) >>> 0;

  const reseau = (adresseLong & masque) >>> 0;
  const diffusion = (reseau | (~masque >>> 0)) >>> 0;

  const bornesConfondues = longueur >= 31;

  return {
    networkAddress: fromLong(reseau),
    broadcastAddress: fromLong(diffusion),
    firstAddress: fromLong(bornesConfondues ? reseau : (reseau + 1) >>> 0),
    lastAddress: fromLong(bornesConfondues ? diffusion : (diffusion - 1) >>> 0),
    subnetMaskLength: longueur,
    /** L'adresse appartient-elle à ce sous-réseau ? */
    contains(autre) {
      try {
        return ((toLong(autre) & masque) >>> 0) === reseau;
      } catch {
        // Une adresse illisible n'appartient à aucun sous-réseau. On ne
        // lève pas : l'appelant balaie souvent une liste hétérogène.
        return false;
      }
    },
  };
}

module.exports = { toLong, fromLong, cidrSubnet };
