/**
 * middleware/requireRole.js
 * À utiliser après requireAuth. Bloque l'accès si le rôle de l'utilisateur
 * connecté n'est pas dans la liste des rôles autorisés pour cette route.
 */

function requireRole(...rolesAutorises) {
  return (req, res, next) => {
    if (!req.user || !rolesAutorises.includes(req.user.role)) {
      return res.status(403).json({ error: "Action non autorisée pour votre rôle" });
    }
    next();
  };
}

module.exports = { requireRole };