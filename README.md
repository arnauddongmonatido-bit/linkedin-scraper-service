# Service de scraping LinkedIn Ad Library

Petit serveur Node/Express qui pilote un navigateur distant (Browserbase +
Playwright) pour reproduire une recherche manuelle sur le LinkedIn Ad Library
et en extraire les annonces.

## Pourquoi ce service est séparé de Lovable

Lovable héberge le frontend et des Edge Functions Supabase (environnement
Deno, sans Chromium). Ce service a besoin d'un vrai runtime Node pour piloter
un navigateur via le SDK Browserbase — il doit donc être déployé à part.

## Déploiement sur Render (gratuit pour démarrer)

1. Crée un compte sur render.com et un compte sur browserbase.com (récupère
   ta clé API dans le dashboard Browserbase).
2. Pousse ce dossier dans un repo GitHub.
3. Sur Render : "New +" > "Web Service" > connecte le repo.
   - Build command : `npm install`
   - Start command : `npm start`
4. Dans "Environment", ajoute les variables :
   - `BROWSERBASE_API_KEY` (ta clé Browserbase)
   - `APP_SECRET` (une chaîne aléatoire que tu inventes, ex: générée avec
     `openssl rand -hex 32`)
5. Déploie. Render te donne une URL du type
   `https://linkedin-ad-scraper.onrender.com`.
6. Teste : 
   `curl -H "x-app-key: TA_CLE" "https://TON_URL/search-ads?company=Thomson%20Reuters&country=FR"`

## Si l'extraction ne renvoie rien

Les sélecteurs dans `extractAdsFromPage()` (server.js) sont une base de
départ, pas une garantie — LinkedIn ne documente pas la structure de sa page
et peut la changer sans préavis. Pour ajuster :

1. Ouvre manuellement `https://www.linkedin.com/ad-library/search?accountOwner=Nike`
   dans Chrome.
2. Clic droit sur une carte de publicité > "Inspecter".
3. Repère la classe ou l'attribut qui identifie la carte, le nom de
   l'annonceur, l'image, le lien vers le détail de l'annonce.
4. Mets à jour les sélecteurs CSS dans `extractAdsFromPage()`.

Alternative plus robuste sur le long terme : au lieu de lire le DOM, ouvrir
l'onglet Réseau des DevTools, repérer l'appel XHR/fetch interne que la page
déclenche pour charger les annonces (il renvoie du JSON structuré), et
intercepter cette réponse dans le script Playwright avec
`page.on('response', ...)` plutôt que de parser le HTML. Plus stable, mais
demande cette étape de reconnaissance manuelle en amont.

## Limites

- Usage personnel / prototype uniquement (cf. avertissement CGU LinkedIn).
- Pas de gestion de CAPTCHA avancée : en cas d'usage répété et intensif,
  LinkedIn peut présenter un défi anti-bot que ce script ne résout pas.
- Aucune garantie de disponibilité si LinkedIn change la structure de sa page.
