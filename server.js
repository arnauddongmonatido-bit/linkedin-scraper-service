/**
 * Service de scraping "navigateur automatisé" pour le LinkedIn Ad Library.
 *
 * Rôle : reproduire exactement ce que fait un utilisateur qui va sur
 * https://www.linkedin.com/ad-library/search?accountOwner=<entreprise>&countries=<pays>
 * en pilotant un vrai navigateur Chrome distant via Browserbase + Playwright,
 * puis en extrayant les annonces affichées sur la page.
 *
 * Ce service NE PEUT PAS tourner dans Lovable/Supabase Edge Functions (pas de
 * Chromium disponible dans cet environnement). Il doit être déployé à part,
 * par exemple sur Render ou Railway, comme un petit serveur Node classique.
 *
 * Lovable (frontend + edge function proxy) et le Custom GPT (Action) appellent
 * TOUS LES DEUX ce service via son URL publique, protégée par APP_SECRET.
 *
 * ATTENTION : les sélecteurs CSS utilisés ci-dessous pour lire la page sont
 * une base de départ raisonnable, mais LinkedIn peut changer la structure de
 * sa page sans préavis. Si l'extraction ne renvoie rien, ouvre la page
 * manuellement dans Chrome, fais un clic droit > Inspecter sur une carte de
 * publicité, et ajuste les sélecteurs dans la fonction extractAdsFromPage().
 */

import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET; // clé que toi seul connais, vérifiée sur chaque requête
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;

if (!BROWSERBASE_API_KEY) {
  console.warn("⚠️  BROWSERBASE_API_KEY manquant dans les variables d'environnement.");
}

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });

// --- Middleware d'authentification simple ---
function requireAppSecret(req, res, next) {
  const provided = req.header("x-app-key");
  if (!APP_SECRET || provided !== APP_SECRET) {
    return res.status(401).json({ error: "Non autorisé." });
  }
  next();
}

/**
 * Construit l'URL de recherche publique de l'Ad Library, exactement comme
 * si un utilisateur avait tapé le nom de l'entreprise dans le champ de recherche.
 */
function buildAdLibraryUrl(company, country) {
  const params = new URLSearchParams();
  params.set("accountOwner", company);
  if (country) params.set("countries", country);
  return `https://www.linkedin.com/ad-library/search?${params.toString()}`;
}

/**
 * Ouvre la page dans le navigateur distant Browserbase, attend le chargement
 * des résultats, scrolle pour déclencher le lazy-loading, puis extrait les
 * données des cartes d'annonces affichées.
 */
async function scrapeAdLibrary(company, country, maxScrolls = 6) {
  const session = await bb.sessions.create();
  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const url = buildAdLibraryUrl(company, country);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Laisse le temps au JS de charger les premiers résultats.
    await page.waitForTimeout(3000);

    // Ferme une éventuelle bannière de cookies si elle apparaît (best-effort).
    try {
      const cookieButton = page.locator('button:has-text("Accept"), button:has-text("Accepter")').first();
      if (await cookieButton.isVisible({ timeout: 2000 })) {
        await cookieButton.click();
      }
    } catch {
      // pas de bannière, on continue
    }

    // Scrolle plusieurs fois pour charger davantage de résultats (infinite scroll).
    for (let i = 0; i < maxScrolls; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(1500);
    }

    const ads = await extractAdsFromPage(page);

    return { ads, sourceUrl: url };
  } finally {
    await browser.close();
  }
}

/**
 * Extrait les annonces visibles sur la page. À AJUSTER si LinkedIn change sa
 * structure : ouvre la page dans un vrai navigateur, inspecte une carte de
 * pub, et adapte les sélecteurs ci-dessous.
 */
async function extractAdsFromPage(page) {
  return page.evaluate(() => {
    // Sélecteur de base : les cartes d'annonces de l'Ad Library. À vérifier/adapter.
    const cards = Array.from(document.querySelectorAll('[data-testid*="ad-library"], .ad-library-card, article'));

    return cards
      .map((card, index) => {
        const advertiserName =
          card.querySelector('[data-testid*="advertiser"], .advertiser-name, h3, h4')?.textContent?.trim() || null;

        const img = card.querySelector("img");
        const video = card.querySelector("video");
        const link = card.querySelector('a[href*="/ad-library/detail/"]');

        const headline = card.querySelector('p, [data-testid*="headline"]')?.textContent?.trim() || null;

        return {
          id: link?.getAttribute("href")?.split("/").pop() || `ad-${index}`,
          advertiserName,
          headline,
          mediaUrl: img?.getAttribute("src") || video?.getAttribute("poster") || null,
          sourceLink: link ? new URL(link.getAttribute("href"), location.origin).toString() : null,
        };
      })
      .filter((ad) => ad.advertiserName || ad.mediaUrl);
  });
}

// --- Endpoint principal : recherche des annonces d'une entreprise ---
app.get("/search-ads", requireAppSecret, async (req, res) => {
  const { company, country } = req.query;

  if (!company) {
    return res.status(400).json({ error: "Le paramètre 'company' est requis." });
  }

  try {
    const result = await scrapeAdLibrary(company, country);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Échec de la récupération des annonces.", detail: String(err) });
  }
});

// --- Endpoint de téléchargement : proxy pour éviter les soucis de CORS ---
app.get("/download-asset", requireAppSecret, async (req, res) => {
  const { url } = req.query;
  if (!url || !url.startsWith("https://media.licdn.com/")) {
    return res.status(400).json({ error: "URL de média invalide." });
  }

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) throw new Error(`Statut upstream ${upstream.status}`);

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=\"visuel-linkedin-ads.jpg\"");

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Échec du téléchargement du visuel.", detail: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Service de scraping LinkedIn Ad Library démarré sur le port ${PORT}`);
});
