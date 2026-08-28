import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initialiserTheme } from './theme.js'

// Avant le premier rendu : évite l'éclair de thème sombre pour qui a choisi
// le thème clair.
initialiserTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
