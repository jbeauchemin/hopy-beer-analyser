// api/duckduckgo_puppeteer.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');
const { duckDuckGoQueue, getSharedBrowser, releaseSharedBrowser } = require('../utils/request-queue');

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin({ stripHeadless: true, makeWindows: true }));

/**
 * ATTENTION
 * - Utiliser avec modération. Respecter robots.txt, rate-limits et mettre en cache les résultats.
 * - Ne pas tenter de contourner CAPTCHAs / WAFs. En cas de CAPTCHA, arrêter la collecte.
 */

// ---------- Config ----------
const HEADLESS = process.env.HEADLESS !== 'false'; // par défaut true; HEADLESS=false pour voir le navigateur
const MAX_VALIDATIONS = Number(process.env.MAX_VALIDATIONS || 3); // nombre de liens validés en parallèle (petits batches)
const LAUNCH_OPTS = {
    headless: HEADLESS ? 'new' : false,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
};

const UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0 Safari/537.36';

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeHost(host) {
    return (host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

function normalizePrefix(prefix) {
    if (!prefix) return '';
    const p = String(prefix).trim().replace(/^https?:\/\/[^/]+/i, '');
    // force un seul slash début & fin: '/products/' ou '/b/'
    return ('/' + p).replace(/\/+/g, '/').replace(/\/?$/, '/');
}

function stripPunctAndCollapse(s) {
    return (s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokens3(s) {
    return stripPunctAndCollapse(s).toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
}

function ddgUrlFromQuery(humanQ) {
    return `https://duckduckgo.com/?q=${encodeURIComponent(humanQ)}`;
}

function decodeMaybeUddg(href) {
    try {
        if (!href) return null;
        if (href.startsWith('/l/?uddg=')) {
            const m = href.match(/[?&]uddg=([^&]+)/);
            return m && m[1] ? decodeURIComponent(m[1]) : null;
        }
        const m = href.match(/[?&]uddg=([^&]+)/);
        if (m && m[1]) return decodeURIComponent(m[1]);
        return href;
    } catch {
        return null;
    }
}

function isValidProductUrl(urlString, requiredHost, requiredPathPrefix, productTokens = []) {
    try {
        const host = normalizeHost(requiredHost);
        const prefix = normalizePrefix(requiredPathPrefix);

        const u = new URL(urlString);
        if (!u.hostname.endsWith(host)) return false;

        const path = u.pathname || '/';
        const bare = prefix.replace(/^\/+|\/+$/g, ''); // 'products' | 'b'
        if (bare) {
            // tolère i18n: /fr/products/...
            const re = new RegExp(`/(?:[a-z]{2}/)?${bare}/`, 'i');
            if (!re.test(path)) return false;
        }

        // extra: si on a des tokens produit, on exige qu'au moins 1 soit présent dans le slug
        if (productTokens.length) {
            const slug = path.toLowerCase();
            const ok = productTokens.some((t) => slug.includes(t));
            if (!ok) return false;
        }

        // Exclure chemins non-produit Shopify
        if (/\/collections\/|\/search|\/cart|\/account|\/pages\//i.test(path)) return false;

        return true;
    } catch {
        return false;
    }
}

// === Validation stricte de la page ===
// - Si producer + product disponibles: demander chevauchement raisonnable du produit dans H1
//   ET présence d'au moins 1 token producer dans title/H1/corps.
// - Fallback: tous les tokens produit présents dans le corps + présence producer.
async function validateUrlContainsTokens(page, url, context = {}) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(400 + Math.random() * 800);

        const title = (await page.title()) || '';
        const payload = await page.evaluate(() => {
            const h1 = document.querySelector('h1')?.innerText || '';
            return { h1, body: document.body?.innerText || '' };
        });

        const norm = (s) => (s || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();

        const tTitle = norm(title);
        const tH1 = norm(payload.h1);
        const tBody = norm(payload.body);

        const product = norm(context.product || '');
        const producer = norm(context.producer || '');

        const tok = (s) => s.split(/\s+/).filter(w => w.length > 2);

        const prodTokens = tok(product);
        const breweryTokens = tok(producer);

        // helpers
        const jaccard = (a, b) => {
            const A = new Set(a), B = new Set(b);
            const inter = [...A].filter(x => B.has(x)).length;
            const uni = new Set([...A, ...B]).size || 1;
            return inter / uni;
        };

        // 1) product overlap on H1 (preferred)
        const h1Overlap = jaccard(tok(tH1), prodTokens);

        // 2) producer token presence (at least one) in title or body
        const hasProducer = breweryTokens.length === 0
            ? true
            : breweryTokens.some(t => tTitle.includes(t) || tH1.includes(t) || tBody.includes(t));

        // 3) fallback if body strongly contains all product tokens
        const bodyHasAllProduct = prodTokens.length
            ? prodTokens.every(t => tBody.includes(t))
            : true;

        // rules:
        // - Prefer: H1 overlap ≥ 0.4 AND hasProducer
        if (h1Overlap >= 0.4 && hasProducer) return true;

        // - Else accept if body contains all product tokens AND hasProducer
        if (bodyHasAllProduct && hasProducer) return true;

        return false;
    } catch {
        return false;
    }
}

/**
 * Internal search function (with shared browser)
 */
async function _searchDuckDuckGoInternal(query, requiredHost, requiredPathPrefix = '/products/', opts = {}) {
    if (!query || !requiredHost) return null;

    const host = normalizeHost(requiredHost);
    const prefix = normalizePrefix(requiredPathPrefix);
    const qQuoted = `"${query.trim()}"`;
    const qUnquoted = stripPunctAndCollapse(query);

    // De strict -> plus souple
    const humanQueries = [
        `site:${host}${prefix} ${qQuoted}`,
        `site:${host}${prefix} ${qUnquoted}`,
        `site:${host} ${qQuoted}`,
        `site:${host} ${qUnquoted}`,
    ];

    // Use shared browser instead of launching new one
    const browser = await getSharedBrowser();

    try {
        for (const humanQ of humanQueries) {
            const ddgUrl = ddgUrlFromQuery(humanQ);
            console.log('🔍 Recherche sur DuckDuckGo (puppeteer):', ddgUrl);

            const page = await browser.newPage();
            await page.setUserAgent(UA);
            await page.setExtraHTTPHeaders({ 'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' });
            page.setDefaultNavigationTimeout(60000);  // Increased from 30s to 60s
            page.setDefaultTimeout(60000);

            try {
                await sleep(600 + Math.random() * 800);
                await page.goto(ddgUrl, { waitUntil: 'networkidle2', timeout: 60000 });  // Increased timeout

                // IMPORTANT: Attendre que les résultats se chargent (DuckDuckGo charge async via JS)
                try {
                    await page.waitForSelector('article[data-testid="result"], .result, [data-testid="mainline"] a', {
                        timeout: 5000
                    });
                    // Petit délai supplémentaire pour laisser tout se charger
                    await sleep(500);
                } catch (e) {
                    // Continuer même si les résultats n'apparaissent pas (peut-être aucun résultat)
                    console.log('  ⚠️  Timeout en attendant les résultats DuckDuckGo');
                }

                // Récupère tous les liens (y compris proxys uddg)
                const anchors = await page.$$eval('a', (els) =>
                    els.map((a) => a.getAttribute('href')).filter(Boolean)
                );
                const decoded = anchors.map(decodeMaybeUddg).filter(Boolean);

                // Dédupliquer tout en gardant l'ordre
                const seen = new Set();
                const candidates = [];
                for (const d of decoded) {
                    if (seen.has(d)) continue;
                    seen.add(d);
                    try {
                        const url = d.startsWith('http') ? d : new URL(d, 'https://duckduckgo.com').href;
                        candidates.push(url);
                    } catch { /* ignore */ }
                }

                // Filtrer par host/prefix (et au moins 1 token produit dans le slug si disponible)
                const productTokens = tokens3(opts.product || '');
                const productCandidates = candidates.filter((u) =>
                    isValidProductUrl(u, host, prefix, productTokens)
                );

                if (!productCandidates.length) {
                    await page.close();
                    continue; // on essaie la requête suivante
                }

                // Validation light des premiers résultats (anti mismatch)
                const toValidate = productCandidates.slice(0, Math.max(MAX_VALIDATIONS, 5));
                for (let i = 0; i < toValidate.length; i += MAX_VALIDATIONS) {
                    const batch = toValidate.slice(i, i + MAX_VALIDATIONS);
                    const results = await Promise.all(
                        batch.map(async (url) => {
                            const tab = await browser.newPage();
                            await tab.setUserAgent(UA);
                            await tab.setExtraHTTPHeaders({ 'accept-language': 'fr-FR,fr;q=0.9' });
                            tab.setDefaultNavigationTimeout(20000);
                            tab.setDefaultTimeout(20000);
                            try {
                                const ok = await validateUrlContainsTokens(tab, url, opts);
                                await tab.close();
                                return ok ? url : null;
                            } catch {
                                try { await tab.close(); } catch { }
                                return null;
                            }
                        })
                    );

                    const found = results.find(Boolean);
                    if (found) {
                        await page.close();
                        // Don't close shared browser
                        return found;
                    }

                    await sleep(600 + Math.random() * 900);
                }

                // Pas validé ? Renvoie le premier candidat filtré (best-effort)
                const fallback = productCandidates[0] || null;
                await page.close();
                // Don't close shared browser
                return fallback;
            } catch (err) {
                console.error('❌ Erreur puppeteer DDG:', err.message);
            } finally {
                try { await page.close(); } catch { }
            }
        }
    } finally {
        // Don't close shared browser - it's managed globally
    }

    return null;
}

/**
 * Public API - searchDuckDuckGo via global queue
 * Prevents rate limiting by queueing all DDG requests globally
 *
 * @param {string} query              e.g. "Menaud Camerise" (utilisé pour la requête DDG)
 * @param {string} requiredHost       e.g. "veuxtuunebiere.com" | "untappd.com"
 * @param {string} requiredPathPrefix e.g. "/products/" | "/b/"  (défaut "/products/")
 * @param {object} opts               e.g. { producer, product }
 * @returns {Promise<string|null>}
 */
async function searchDuckDuckGo(query, requiredHost, requiredPathPrefix = '/products/', opts = {}) {
    // Enqueue request to prevent rate limiting
    return duckDuckGoQueue.enqueue(
        async () => _searchDuckDuckGoInternal(query, requiredHost, requiredPathPrefix, opts),
        {
            label: `DDG: ${requiredHost} - ${query.substring(0, 30)}...`,
            timeout: 90000,  // 90s timeout (increased from 30s)
            retries: 2,
            priority: 0
        }
    );
}

module.exports = { searchDuckDuckGo };

// CLI debug
if (require.main === module) {
    const args = process.argv.slice(2);
    const q = args.join(' ').trim();
    if (!q) {
        console.log('Usage: node api/duckduckgo_puppeteer.js "Menaud Camerise"');
        process.exit(1);
    }
    (async () => {
        const url = await searchDuckDuckGo(q, 'veuxtuunebiere.com', '/products/', {
            producer: 'Menaud',
            product: 'Camerise',
        });
        console.log('➡️  Result:', url || 'No result');
    })();
}