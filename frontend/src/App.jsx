import { useState, useEffect, lazy, Suspense } from "react";
import axios from "axios";
import Login from "./Components/Login";
import Sidebar from "./Components/Sidebar";
import SearchBar from "./Components/SearchBar";
import BasculeTheme from "./Components/BasculeTheme";
import "./App.css";

/* =====================================================================
   CHARGEMENT DES PAGES À LA DEMANDE

   Le build produisait un seul fichier de 717 ko, téléchargé AVANT que
   l'écran de connexion ne s'affiche. L'essentiel de ce poids vient de la
   bibliothèque de graphiques, utilisée par quatre pages sur douze — et
   par aucune avant la connexion.

   Concrètement : l'acheteur qui ouvre la plateforme attendait le
   téléchargement des graphiques de bande passante pour voir un
   formulaire de connexion. Sur une liaison lente — et une démonstration
   se fait rarement sur la fibre du bureau — cela se voit.

   `lazy()` découpe le build en morceaux chargés au moment où l'on ouvre
   la page correspondante. L'écran de connexion ne dépend plus que de
   lui-même.

   Restent chargés immédiatement : Login, la barre latérale, la
   recherche et la bascule de thème — visibles en permanence, les
   différer ne ferait que provoquer un clignotement.
   ===================================================================== */
const Dashboard = lazy(() => import("./Components/Dashboard"));
const EquipementsPage = lazy(() => import("./Components/EquipementsPage"));
const PlagesPage = lazy(() => import("./Components/PlagesPage"));
const UtilisateursPage = lazy(() => import("./Components/UtilisateursPage"));
const AlertesPage = lazy(() => import("./Components/AlertesPage"));
const IncidentsPage = lazy(() => import("./Components/IncidentsPage"));
const SitesPage = lazy(() => import("./Components/SitesPage"));
const TopologyPage = lazy(() => import("./Components/TopologyPage"));
const BandePassantePage = lazy(() => import("./Components/BandePassantePage"));
const AccesWebPage = lazy(() => import("./Components/AccesWebPage"));
const ConfigurationPage = lazy(() => import("./Components/ConfigurationPage"));
const JournalPage = lazy(() => import("./Components/JournalPage"));
const EquipementDetail = lazy(() => import("./Components/EquipementDetail"));

/**
 * Affiché pendant le chargement d'une page.
 *
 * Volontairement discret : un indicateur voyant à chaque changement de
 * page donnerait l'impression d'une application lente, alors que ces
 * morceaux se chargent en quelques dizaines de millisecondes et sont
 * ensuite gardés en cache par le navigateur.
 */
function Attente() {
  return <p className="text-sm text-[var(--color-mute)] py-8">Chargement…</p>;
}

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api";

function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [idSite, setIdSite] = useState(null);
  const [sites, setSites] = useState([]);
  const [ready, setReady] = useState(false);
  const [selectionRecherche, setSelectionRecherche] = useState(null);
  const [menuOuvert, setMenuOuvert] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const savedUser = localStorage.getItem("utilisateur");
    if (token && savedUser) {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      try {
        setUser(JSON.parse(savedUser));
      } catch {
        // Entrée localStorage corrompue : on repart d'une session propre.
        localStorage.removeItem("token");
        localStorage.removeItem("utilisateur");
      }
    }
    setReady(true);
  }, []);

  // Point unique de gestion des 401 : le jeton a expiré ou est invalide,
  // on renvoie l'utilisateur vers l'écran de connexion.
  useEffect(() => {
    const id = axios.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response?.status === 401) {
          handleLogout();
        }
        return Promise.reject(err);
      }
    );
    return () => axios.interceptors.response.eject(id);
  }, []);

  useEffect(() => {
    if (!user) return;
    axios.get(`${API_URL}/sites`).then(({ data }) => {
      setSites(data);
      if (data.length > 0) setIdSite(data[0].id_site);
    }).catch(() => {
      handleLogout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function handleLogin(userData, token) {
    // App.jsx est le seul propriétaire de la session : persistance + en-tête.
    localStorage.setItem("token", token);
    localStorage.setItem("utilisateur", JSON.stringify(userData));
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    setUser(userData);
  }

  function handleLogout() {
    delete axios.defaults.headers.common["Authorization"];
    localStorage.removeItem("token");
    localStorage.removeItem("utilisateur");
    setUser(null);
  }

  if (!ready) return null;

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen flex bg-[var(--color-abyss)]">
      <Sidebar
        active={page}
        onNavigate={setPage}
        user={user}
        onLogout={handleLogout}
        ouvert={menuOuvert}
        onFermer={() => setMenuOuvert(false)}
      />

      {/* Voile de fermeture du tiroir, uniquement sur petit écran. */}
      {menuOuvert && (
        <button
          type="button"
          className="voile-menu"
          aria-label="Fermer le menu"
          onClick={() => setMenuOuvert(false)}
        />
      )}

      <div className="flex-1 flex flex-col zone-contenu">
        <header className="flex flex-wrap items-center gap-3 px-4 md:px-8 py-3 md:py-4 border-b border-[var(--color-line)]">
          {/* Ouverture du menu : remplace la barre latérale sous 768 px. */}
          <button
            type="button"
            onClick={() => setMenuOuvert(true)}
            aria-label="Ouvrir le menu"
            className="md:hidden cible-tactile shrink-0 flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--color-line)] text-[var(--color-mute)] hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] transition"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>

          <div className="flex-1 min-w-[10rem] order-last w-full md:order-none md:w-auto">
            <SearchBar
              onSelectEquipement={(eq) => setSelectionRecherche(eq)}
              onNavigate={(p) => setPage(p)}
            />
          </div>

          <span className="hidden sm:inline text-sm text-[var(--color-mute)] ml-auto md:ml-0">
            Site supervisé
          </span>
          {/* La liste vient de GET /api/sites, déjà filtrée côté serveur selon
              le rattachement de l'utilisateur : aucune décision de visibilité
              n'est prise ici. Un utilisateur rattaché à un seul site n'a pas
              besoin d'un menu déroulant à une entrée. */}
          {sites.length === 0 ? (
            <span className="text-sm text-[var(--color-mute)]">Aucun site accessible</span>
          ) : sites.length === 1 ? (
            <span className="text-sm text-[var(--color-ink)]">{sites[0].nom}</span>
          ) : (
            <select
              value={idSite ?? ""}
              onChange={(e) => setIdSite(Number(e.target.value))}
              className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg px-3 py-1.5 text-sm outline-none focus:border-[var(--color-signal)] transition"
            >
              {sites.map((s) => (
                <option key={s.id_site} value={s.id_site}>
                  {s.nom}
                </option>
              ))}
            </select>
          )}

          <BasculeTheme />
        </header>

        <main className="flex-1 px-4 md:px-8 py-4 md:py-6 overflow-auto">
          {/* Suspense est OBLIGATOIRE autour d'un composant lazy : sans
              lui, React lève au premier affichage et la page reste
              blanche. Une seule frontière suffit ici, une seule page
              étant montée à la fois. */}
          <Suspense fallback={<Attente />}>
            {page === "dashboard" && <Dashboard idSite={idSite} />}
            {page === "equipements" && <EquipementsPage idSite={idSite} />}
            {page === "plages" && <PlagesPage idSite={idSite} />}
            {page === "alertes" && <AlertesPage />}
            {page === "incidents" && <IncidentsPage />}
            {page === "sites" && <SitesPage />}
            {page === "topologie" && <TopologyPage idSite={idSite} />}
            {page === "bande-passante" && <BandePassantePage idSite={idSite} />}
            {page === "acces-web" && <AccesWebPage idSite={idSite} />}
            {page === "utilisateurs" && <UtilisateursPage />}
            {page === "configuration" && <ConfigurationPage />}
            {page === "journal" && <JournalPage />}
          </Suspense>
        </main>
      </div>

      {/* La fiche d'équipement s'ouvre par-dessus le contenu, hors du
          <main> : elle a donc besoin de sa propre frontière Suspense. */}
      {selectionRecherche && (
        <Suspense fallback={null}>
          <EquipementDetail
            equipement={selectionRecherche}
            onClose={() => setSelectionRecherche(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
 