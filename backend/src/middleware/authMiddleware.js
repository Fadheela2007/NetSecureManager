/**
 * middleware/authMiddleware.js
 * Vérifie le token JWT envoyé dans l'en-tête Authorization: Bearer <token>.
 */

const jwt = require("jsonwebtoken");

/**
 * AUCUN SECRET DE REPLI.
 *
 * Ce fichier portait `process.env.JWT_SECRET || "change-this-secret-in-.env"`.
 * Une installation où JWT_SECRET est absent signait et vérifiait donc ses
 * jetons avec une chaîne écrite dans le code source — publiquement lisible.
 * N'importe qui pouvait fabriquer un jeton d'administrateur et entrer.
 *
 * Le démarrage échouait déjà par ailleurs (routes/auth.js lève sans
 * JWT_SECRET), ce qui rendait ce repli inatteignable — mais un repli
 * inatteignable reste une bombe à retardement : il suffit qu'un jour ce
 * middleware soit importé par un outil ou un test qui ne passe pas par
 * routes/auth.js pour qu'il redevienne le chemin normal, sans bruit.
 */
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET est absent de backend/.env — chargement refusé. " +
      "Renseignez une chaîne longue et aléatoire, propre à cet environnement."
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentification requise" });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expirée, reconnectez-vous" });
  }
}

module.exports = { requireAuth };
