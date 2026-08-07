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
 * sa page sans préavis. Utilise la route /debug-html pour inspecter le HTML
 * réellement rendu et ajuster extractAdsFromPage() en conséquence.
 */

import express from "express";
import cors from "cors";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SECRET;
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;

if (!BROWSERBASE_API_KEY) {
  console.warn("⚠️  BROWSERBASE_API_KEY manquant dans les variables d'environnement.");
}

const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });

function requireAppSecret(req, res, next) {
  // Accepte la clé soit dans le header x-app-key (utilisé par Lovable/GPT),
  // soit en paramètre ?key= (pratique pour un test rapide depuis un navigateur/outil).
  const provided = req.header("x-app-key") || req.query.key;
  if (!APP_SECRET || provided !== APP_SECRET) {
    return res.status(401).json({ error: "Non autorisé." });
  }
  next();
}

function buildAdLibraryUrl(company, country) {
  const params = new URLSearchParams();
  params.set("accountOwner", company);
  if (country) params.set("countries", country);
  return `https://www.linkedin.com/ad-library/search?${params.toString()}`;
}

async function scrapeAdLibrary(company, country, maxScrolls = 6) {
  const session = await bb.sessions.create();
  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const url = buildAdLibraryUrl(company, country);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    try {
      const cookieButton = page.locator('button:has-text("Accept"), button:has-text("Accepter")').first();
      if (await cookieButton.isVisible({ timeout: 2000 })) {
        await cookieButton.click();
      }
    } catch {
      // pas de bannière, on continue
    }

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

async function extractAdsFromPage(page) {
  return page.evaluate(() => {
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

// --- Endpoint de diagnostic temporaire : renvoie le HTML brut rendu par le navigateur ---
// Sert uniquement à identifier les bons sélecteurs CSS. À retirer une fois le scraping stabilisé.
app.get("/debug-html", requireAppSecret, async (req, res) => {
  const { company, country } = req.query;
  if (!company) {
    return res.status(400).json({ error: "Le paramètre 'company' est requis." });
  }

  const session = await bb.sessions.create();
  const browser = await chromium.connectOverCDP(session.connectUrl);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    const url = buildAdLibraryUrl(company, country);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);

    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(1000);
    }

    const html = await page.content();
    const title = await page.title();

    res.json({ url, title, htmlLength: html.length, html });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  } finally {
    await browser.close();
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Service de scraping LinkedIn Ad Library démarré sur le port ${PORT}`);
});
