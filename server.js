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
    // Structure identifiée via /debug-scan le 2026-08-07 : chaque annonce est un
    // <li class="search-result-item">, contenant un .ad-preview[data-creative-type]
    // et un .base-ad-preview-card[aria-label="Nom annonceur, Type Ad, View details"].
    const cards = Array.from(document.querySelectorAll("li.search-result-item"));

    return cards
      .map((card, index) => {
        const preview = card.querySelector(".ad-preview");
        const adType = preview?.getAttribute("data-creative-type") || null;

        const previewCard = card.querySelector(".base-ad-preview-card");
        const ariaLabel = previewCard?.getAttribute("aria-label") || "";
        const advertiserName =
          ariaLabel.split(",")[0]?.trim() ||
          card.querySelector(".font-bold")?.textContent?.trim() ||
          null;

        // Le logo de l'annonceur a alt="advertiser logo" ; l'image du visuel de
        // la pub (ou la miniature vidéo) est une autre <img> de la carte.
        const images = Array.from(card.querySelectorAll("img"));
        const creativeImg =
          images.find((img) => img.getAttribute("alt") !== "advertiser logo") ||
          images[images.length - 1];
        const mediaUrl = creativeImg?.getAttribute("src") || null;

        const link = card.querySelector('a[href*="/ad-library/detail/"]');
        const href = link?.getAttribute("href") || null;
        const id = href ? href.split("/").filter(Boolean).pop().split("?")[0] : `ad-${index}`;

        const headline =
          card.querySelector('[class*="commentary"], [class*="headline"], p')?.textContent?.trim() || null;

        return {
          id,
          advertiserName,
          adType,
          headline,
          mediaUrl,
          sourceLink: href ? new URL(href, "https://www.linkedin.com").toString() : null,
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

// --- Endpoint de diagnostic temporaire : scanne la page pour trouver la vraie structure ---
// Sert uniquement à identifier les bons sélecteurs CSS. À retirer une fois le scraping stabilisé.
app.get("/debug-scan", requireAppSecret, async (req, res) => {
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

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);

    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(600);
    }

    const scan = await page.evaluate(() => {
      const truncate = (s, n = 400) => (s || "").slice(0, n);

      const adDetailLinks = Array.from(document.querySelectorAll('a[href*="/ad-library/detail/"]'));
      const images = Array.from(document.querySelectorAll("img"));
      const videos = Array.from(document.querySelectorAll("video"));
      const licdnImages = images.filter((img) => (img.getAttribute("src") || "").includes("licdn.com"));

      // Cherche des éléments qui contiennent un texte du type "X results" / "résultats"
      const textMatches = Array.from(document.querySelectorAll("body *"))
        .filter((el) => el.children.length === 0)
        .map((el) => el.textContent.trim())
        .filter((t) => /result|résultat|no ads|aucune/i.test(t))
        .slice(0, 10);

      // Remonte de 4 niveaux de parents depuis le premier lien d'annonce trouvé, pour voir la structure de la carte
      let cardHtmlSample = null;
      if (adDetailLinks[0]) {
        let el = adDetailLinks[0];
        for (let i = 0; i < 4 && el.parentElement; i++) el = el.parentElement;
        cardHtmlSample = truncate(el.outerHTML, 1500);
      }

      return {
        adDetailLinksCount: adDetailLinks.length,
        totalImages: images.length,
        licdnImagesCount: licdnImages.length,
        videosCount: videos.length,
        sampleLicdnImageSrcs: licdnImages.slice(0, 3).map((img) => img.getAttribute("src")),
        sampleAdDetailHrefs: adDetailLinks.slice(0, 3).map((a) => a.getAttribute("href")),
        resultTextMatches: textMatches,
        cardHtmlSample,
        bodyChildCount: document.body.children.length,
        mainRootId: document.querySelector("[id]")?.id || null,
      };
    });

    res.json({ url, ...scan });
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
