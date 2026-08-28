/**
 * tools/sonde-mdns.js
 * Demande à TOUT le réseau à la fois : « qui parle mDNS ? »
 *
 *   node tools\sonde-mdns.js
 *   node tools\sonde-mdns.js 15        (écoute 15 secondes)
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL EXISTE
 *
 * Interroger les appareils un par un ne permet pas de distinguer deux
 * situations opposées :
 *
 *   • le réseau ne parle pas mDNS — rien à faire, c'est le parc ;
 *   • notre requête est mal formée — tout est à corriger.
 *
 * Dans les deux cas, le résultat affiché est le même : rien.
 *
 * Cette sonde tranche. Elle envoie une seule requête au groupe de
 * diffusion 224.0.0.251, celle-là même qu'émettent Windows, macOS et
 * les imprimantes en permanence, puis écoute qui répond — sans rien
 * demander à personne en particulier.
 *
 * Si un appareil se manifeste, le protocole fonctionne sur ce réseau.
 * Si le silence est total, le parc ne parle pas mDNS, et aucun code ne
 * peut y changer quoi que ce soit.
 * ─────────────────────────────────────────────────────────────────────
 */
const dgram = require("dgram");
const {
  extraireNomMdns,
  encoderNomDns,
  lireNomDns,
  sauterNom,
} = require("../src/services/nomService");

const GROUPE = "224.0.0.251";
const PORT = 5353;
const V = "\x1b[32m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const secondes = Number(process.argv[2]) || 8;

/**
 * Requête de découverte de services : « quels services existent ici ? »
 * C'est la question la plus large du protocole ; tout appareil qui
 * annonce quoi que ce soit y répond.
 */
function requeteDecouverte() {
  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(0x0001, 4); // une question
  return Buffer.concat([
    entete,
    encoderNomDns("_services._dns-sd._udp.local"),
    Buffer.from([0x00, 0x0c]), // PTR
    Buffer.from([0x00, 0x01]), // classe IN, en diffusion (pas de bit QU)
  ]);
}

/**
 * Relève les types de service annoncés (« _printer », « _ipps »…).
 *
 * Ils ne sont PAS des noms d'appareil — la première version de cette
 * sonde les affichait comme tels, ce qui aurait fini par nommer trois
 * imprimantes « _printer ». Ils restent une information utile pour
 * savoir ce qu'est l'appareil, à condition d'être présentés pour ce
 * qu'ils sont.
 */
function lireServices(tampon) {
  const services = new Set();
  try {
    if (!tampon || tampon.length < 12) return services;
    const nbQuestions = tampon.readUInt16BE(4);
    const nbReponses = tampon.readUInt16BE(6);
    let position = 12;
    for (let i = 0; i < nbQuestions; i++) {
      position = sauterNom(tampon, position);
      position += 4;
    }
    for (let i = 0; i < nbReponses; i++) {
      if (position >= tampon.length) break;
      position = sauterNom(tampon, position);
      if (position + 10 > tampon.length) break;
      const type = tampon.readUInt16BE(position);
      const longueur = tampon.readUInt16BE(position + 8);
      const debut = position + 10;
      if (debut + longueur > tampon.length) break;
      if (type === 0x000c) {
        const valeur = lireNomDns(tampon, debut);
        const etiquette = String(valeur).split(".")[0];
        if (etiquette.startsWith("_")) services.add(etiquette);
      }
      position = debut + longueur;
    }
  } catch {
    /* réponse illisible : on renvoie ce qu'on a pu lire */
  }
  return services;
}

const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
const repondeurs = new Map();

socket.on("message", (message, expediteur) => {
  let nom = null;
  try {
    nom = extraireNomMdns(message);
  } catch {
    /* réponse illisible : on retient quand même l'expéditeur */
  }
  const services = lireServices(message);

  const connu = repondeurs.get(expediteur.address) || {
    nom: null,
    services: new Set(),
    octets: 0,
  };
  if (nom && !connu.nom) connu.nom = nom;
  for (const s of services) connu.services.add(s);
  connu.octets = Math.max(connu.octets, message.length);
  repondeurs.set(expediteur.address, connu);
});

socket.on("error", (err) => {
  console.error(`\nÉcoute impossible : ${err.message}`);
  if (err.code === "EADDRINUSE") {
    console.error("Le port 5353 est déjà pris — probablement par Bonjour");
    console.error("(installé avec iTunes ou Adobe). Ce n'est pas un défaut :");
    console.error("cela prouve même que quelque chose écoute le mDNS ici.");
  }
  process.exit(1);
});

socket.bind(PORT, () => {
  try {
    socket.addMembership(GROUPE);
  } catch (err) {
    console.error(`\nAdhésion au groupe ${GROUPE} refusée : ${err.message}\n`);
    // Trois causes distinctes, trois actions opposées : les confondre
    // enverrait sur une fausse piste.
    if (err.code === "ENODEV" || /ENODEV/.test(err.message)) {
      console.error("Aucune interface réseau ne gère la diffusion multicast.");
      console.error("C'est le cas dans une machine virtuelle ou un conteneur");
      console.error("sans réseau ponté. Lancez cette sonde depuis la machine");
      console.error("directement raccordée au réseau de l'entreprise.");
    } else if (err.code === "EPERM" || err.code === "EACCES") {
      console.error("Permission refusée. Ouvrez PowerShell en administrateur.");
    } else {
      console.error("Le pare-feu bloque peut-être la diffusion multicast.");
    }
    process.exit(1);
  }

  console.log(`\n${G}Sonde mDNS — écoute de ${secondes} secondes sur ${GROUPE}.${F}`);
  console.log(`${G}Une seule question posée à tout le réseau : « qui est là ? »${F}\n`);

  const requete = requeteDecouverte();
  socket.send(requete, 0, requete.length, PORT, GROUPE, (err) => {
    if (err) console.error(`Envoi impossible : ${err.message}`);
  });

  setTimeout(() => {
    socket.close();

    console.log("═══════════════════════════════════════════════════════");
    if (repondeurs.size === 0) {
      console.log(`  ${J}Aucun appareil n'a répondu.${F}\n`);
      console.log("  Conclusion : ce réseau ne parle pas mDNS. Les caméras,");
      console.log("  modules et capteurs de ce parc n'annoncent pas de nom —");
      console.log("  ils n'en ont pas au sens où l'entend le protocole.");
      console.log("\n  La colonne « nom » restera donc vide pour eux, et c'est");
      console.log("  le comportement correct : inventer un nom serait pire.");
    } else {
      console.log(`  ${V}${repondeurs.size} appareil(s) parlent mDNS :${F}\n`);
      console.log(`    ${G}adresse           nom d'appareil        services annoncés${F}`);
      let avecNom = 0;
      for (const [ip, { nom, services }] of repondeurs) {
        if (nom) avecNom++;
        const libelle = nom ? `${V}${nom}${F}` : `${G}—${F}`;
        const listeServices = services.size
          ? `${G}${[...services].join(" ")}${F}`
          : `${G}—${F}`;
        console.log(
          `    ${ip.padEnd(16)}  ${libelle.padEnd(nom ? 30 : 20)}  ${listeServices}`
        );
      }
      console.log(`\n  ${G}Le nom d'appareil et le service annoncé sont deux choses`);
      console.log(`  distinctes : « _printer » dit ce que fait la machine, pas`);
      console.log(`  comment elle s'appelle. Seule la colonne du milieu peut`);
      console.log(`  remplir la liste d'équipements.${F}\n`);
      console.log("  Le mDNS fonctionne sur ce réseau.");
      if (avecNom === 0) {
        console.log("\n  Mais aucun appareil n'a annoncé de nom en réponse à cette");
        console.log("  question générale. C'est normal : elle porte sur les");
        console.log("  services. La requête ciblée par adresse, elle, demande");
        console.log("  bien le nom — vérifiez-la avec :");
        console.log("\n    node tools\\diagnostic-noms.js\n");
      }
    }
    console.log("═══════════════════════════════════════════════════════\n");
    process.exit(0);
  }, secondes * 1000);
});
