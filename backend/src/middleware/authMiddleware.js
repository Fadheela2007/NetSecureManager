/**
 * middleware/authMiddleware.js
 * Vérifie le token JWT envoyé dans l'en-tête Authorization: Bearer <token>.
 */

const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-.env";

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
