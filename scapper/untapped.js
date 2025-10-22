// api/untappd.js
const axios = require('axios');
const cheerio = require('cheerio');
const { searchDuckDuckGo } = require('./duckduckgo');

const UNTAPPD_API = 'https://9wbo4rq3ho-dsn.algolia.net/1/indexes/beer/query';
const HEADERS = {
    'x-algolia-agent': 'Algolia for vanilla JavaScript 3.24.8',
    'x-algolia-application-id': '9WBO4RQ3HO',
    'x-algolia-api-key': '1d347324d67ec472bb7132c66aead485',
    'Content-Type': 'application/json',
};

// ------------------------------
// 🔧 UTILITAIRES
// ------------------------------
function normalize(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
function tokens(str) {
    return normalize(str).split(' ').filter(Boolean);
}
function tokenSet(str) {
    return new Set(tokens(str));
}
function overlapRatio(aSet, bSet) {
    if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return 0;
    let inter = 0;
    for (const t of aSet) if (bSet.has(t)) inter++;
    return inter / aSet.size; // ratio par rapport à l'input
}
function isGenericName(name) {
    const generic = new Set(['blonde', 'lager', 'ipa', 'ale', 'saison', 'stout', 'pale', 'amber', 'noire', 'biere', 'beer', 'microbrasserie']);
    const toks = tokens(name);
    return toks.length <= 2 && toks.some(w => generic.has(w));
}
function uniq(arr) {
    const seen = new Set();
    const out = [];
    for (const s of arr) {
        const n = s.trim();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

// Stopwords pour les noms de brasseries
const PRODUCER_STOPWORDS = new Set([
    'brasserie', 'microbrasserie', 'artisanal', 'artisanale', 'brasseurs', 'brasseur',
    'inc', 'ltd', 'ltée', 'ltee', 'compagnie', 'company', 'co', 'brewing', 'brewery', 'microbrewery'
]);
function significantTokens(str) {
    return tokens(str).filter(t => t.length > 2 && !PRODUCER_STOPWORDS.has(t));
}

// si on a (producer, product) on génère plusieurs candidats de requête
// incluant les variantes sans alcool
function buildQueryCandidates(producer, product) {
    const cand = [];
    const alcoholFreeVariants = ['sans alcool', 'NA', 'alcohol free', 'non-alcoholic'];

    if (producer && product) {
        cand.push(`${producer} ${product}`);
        cand.push(`${product} ${producer}`);
        cand.push(product);

        // Ajouter des variantes sans alcool
        for (const variant of alcoholFreeVariants) {
            cand.push(`${producer} ${product} ${variant}`);
            cand.push(`${product} ${variant}`);
        }
    } else {
        const base = (product || producer || '').trim();
        cand.push(base);

        // Ajouter des variantes sans alcool
        for (const variant of alcoholFreeVariants) {
            cand.push(`${base} ${variant}`);
        }
    }
    return uniq(cand);
}

function generateQueryFallbacks(query) {
    const ws = tokens(query);
    const fallbacks = [];
    for (let i = ws.length - 1; i >= 0; i--) {
        const slice = ws.slice(i).join(' ');
        if (slice.length >= 3) fallbacks.push(slice);
    }
    return uniq(fallbacks);
}

// ------------------------------
// 🔍 RECHERCHE API (Algolia publique Untappd)
// ------------------------------
async function searchUntappd(query) {
    try {
        await new Promise(r => setTimeout(r, 350));
        const { data } = await axios.post(UNTAPPD_API, { query, hitsPerPage: 12 }, { headers: HEADERS });
        return data?.hits || [];
    } catch (error) {
        console.error('❌ Erreur API Untappd:', error.message);
        return [];
    }
}

// ------------------------------
// 🧠 SÉLECTION DU MEILLEUR HIT
// ------------------------------
function pickBestHit({ hits, producer, product, originalQuery }) {
    if (!hits?.length) return null;

    // Prépare tokens significatifs pour le producteur
    const prodSig = producer ? significantTokens(producer) : [];
    const prodSet = new Set(prodSig);
    const prodMinOverlap = producer ? 0.6 : 0;
    const prodMinTokens = producer ? Math.max(1, Math.ceil((prodSig.length || 0) * prodMinOverlap)) : 0;
    const effectiveMinHits = prodSig.length <= 1 ? 1 : prodMinTokens;

    const prodFilter = (breweryName) => {
        if (!producer) return true;
        const bSig = significantTokens(breweryName || '');
        let hits = 0;
        for (const t of prodSet) if (bSig.includes(t)) hits++;
        return hits >= effectiveMinHits;
    };

    const prodNameSet = product ? tokenSet(product) : null;

    let best = { hit: null, score: -Infinity };

    for (const hit of hits) {
        if (!hit.beer_name) continue;

        const rc = Number(hit.rating_count || 0);
        if (rc < 5) continue; // évite les fiches quasi vides

        const hitBeer = hit.beer_name || '';
        const hitBrewery = hit.brewery_name || '';

        // 1) filtre producteur si fourni
        if (!prodFilter(hitBrewery)) continue;

        // 2) filtre nom trop générique
        if (isGenericName(hitBeer)) continue;

        // 3) overlap nom produit
        let nameOverlap = 0;
        if (product) {
            nameOverlap = overlapRatio(prodNameSet, tokenSet(hitBeer));
            if (nameOverlap < 0.5) continue; // ≥50% des tokens input présents
        } else if (originalQuery) {
            nameOverlap = overlapRatio(tokenSet(originalQuery), tokenSet(`${hitBrewery} ${hitBeer}`));
            if (nameOverlap < 0.5) continue;
        }

        // 4) overlap producteur (score)
        const prodOverlap = producer ? overlapRatio(new Set(prodSig), tokenSet(hitBrewery + ' ' + hitBrewery)) : 0;

        // 5) score final
        const score = (nameOverlap * 10) + (prodOverlap * 10) + Math.log10(rc + 1);

        if (score > best.score) best = { hit, score };
    }

    return best.hit || null;
}

// ------------------------------
// 🌐 SCRAPING HTML (URL à partir des slugs)
// ------------------------------
function safeSlug(s) {
    return (s || '')
        .toString()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

async function fetchHtmlAndEnrichFromUrl(url) {
    try {
        await new Promise(resolve => setTimeout(resolve, 400));
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(data);

        const ldRaw = $('script[type="application/ld+json"]').first().html() || '{}';
        let jsonLd = {};
        try { jsonLd = JSON.parse(ldRaw); } catch { jsonLd = {}; }

        const beer_name = $('h1').first().text().trim();
        const brewery_name = $('p.brewery a').text().trim();
        const type_name = $('p.style').text().trim();

        const abvText = $('p.abv').text().trim(); // ex "6.5% ABV"
        const ibuText = $('p.ibu').text().trim(); // ex "IBU 35" ou "N/A"
        const ratingText = $('.details .num').text(); // ex "# Ratings (3.84)"
        const ratingCountText = $('p.raters').text();
        const totalCheckinsText = $('div.stats p').eq(0).find('.count').text();

        const beer_abv = abvText ? (parseFloat(abvText.replace(/[^\d.,]/g, '').replace(',', '.')) || null) : null;
        const beer_ibu = /N\/A/i.test(ibuText) ? null : (parseInt(ibuText.replace(/[^0-9]/g, ''), 10) || null);

        const rating_score = (() => {
            // essaye "(3.84)" d'abord puis prise brute des nombres flottants
            const m1 = ratingText.match(/\(([\d.]+)\)/);
            if (m1) return parseFloat(m1[1]);
            const m2 = ratingText.match(/[\d.]+/);
            return m2 ? parseFloat(m2[0]) : null;
        })();
        const rating_count = parseInt((ratingCountText || '').replace(/[^0-9]/g, ''), 10) || null;
        const total_checkins = parseInt((totalCheckinsText || '').replace(/[^0-9]/g, ''), 10) || null;

        const image_url = $('.label.image-big img').attr('src')
            || jsonLd.image?.contentUrl
            || null;
        const brewery_brand = jsonLd.brand?.name || null;

        let description =
            $('.beer-descrption-read-less').text().trim() ||
            $('.beer-descrption-read-more').text().trim();
        if (description) description = description.replace(/(Show More|Show Less)/gi, '').trim();

        return {
            source: 'untappd.com',
            url,
            beer_name,
            brewery_name,
            type_name,
            beer_abv,
            beer_ibu,
            rating_score,
            rating_count,
            total_checkins,
            description,
            image_url,
            brewery_brand,
        };
    } catch (err) {
        return null;
    }
}

/** hit -> essaie plusieurs URLs stables */
async function fetchHtmlAndEnrich(hit) {
    const bid = hit?.bid;
    if (!bid) return null;

    const beerSlug = hit?.beer_slug ? safeSlug(hit.beer_slug) : safeSlug(hit.beer_name);
    const brewerySlug = hit?.brewery_slug ? safeSlug(hit.brewery_slug) : safeSlug(hit.brewery_name);

    const candidates = [
        brewerySlug && beerSlug ? `https://untappd.com/b/${brewerySlug}-${beerSlug}/${bid}` : null,
        beerSlug ? `https://untappd.com/b/${beerSlug}/${bid}` : null,
        `https://untappd.com/b/_/${bid}`, // legacy fallback
    ].filter(Boolean);

    for (const url of candidates) {
        const enriched = await fetchHtmlAndEnrichFromUrl(url);
        if (enriched) return { bid, ...enriched };
    }
    return null;
}

// ------------------------------
// 🦆 Fallback DuckDuckGo (Puppeteer) avec /b/ et opts
// ------------------------------
async function fetchFromDuckDuckGoUntappd(query, producer, product) {
    console.log(`🔁 Fallback DuckDuckGo pour "${query}" sur untappd.com`);
    try {
        const url = await searchDuckDuckGo(
            query,
            'untappd.com',
            '/b/',
            { producer, product } // ⬅️ passe les hints
        );
        if (!url || !/\/b\/.+\/\d+/.test(url)) {
            console.log('❌ DuckDuckGo: pas d’URL pertinente.');
            return null;
        }
        const bidMatch = url.match(/\/b\/.*?\/(\d+)/);
        if (!bidMatch) {
            console.log('❌ BID introuvable dans l’URL:', url);
            return null;
        }
        const pseudoHit = { bid: bidMatch[1], beer_name: '', brewery_name: '' };
        return await fetchHtmlAndEnrich(pseudoHit);
    } catch (error) {
        console.error('❌ Erreur DuckDuckGo fallback:', error.message);
        return null;
    }
}

// ------------------------------
// 🚀 EXPORT PRINCIPAL
// ------------------------------
/**
 * getUntappdData
 * - Appel flexible:
 *   - getUntappdData("Menaud Camerise")        // rétro-compatible (query unique)
 *   - getUntappdData("Menaud", "Camerise")     // recommandé (producer + product)
 *
 * Retourne l’objet enrichi ou null.
 */
async function getUntappdData(arg1, arg2) {
    let producer = null;
    let product = null;
    let originalQuery = null;

    if (typeof arg2 === 'string') {
        producer = arg1 || null;
        product = arg2 || null;
    } else {
        originalQuery = (arg1 || '').trim();
    }

    // 1) Construire les requêtes candidates
    const candidates = producer || product
        ? buildQueryCandidates(producer, product)
        : uniq([originalQuery, ...generateQueryFallbacks(originalQuery)]);

    // 2) Tenter chaque candidate jusqu’à un match plausible
    let bestMatch = null;
    for (const q of candidates) {
        if (!q) continue;
        const hits = await searchUntappd(q);
        bestMatch = pickBestHit({
            hits,
            producer,
            product,
            originalQuery: originalQuery || q,
        });
        if (bestMatch) break;
    }

    if (!bestMatch) {
        // Dernier recours: DuckDuckGo (avec /b/)
        const ddq = product || originalQuery || candidates[0];
        if (!ddq) return null;
        console.log('❌ Aucune correspondance API; fallback DuckDuckGo…');
        return await fetchFromDuckDuckGoUntappd(ddq, producer, product);
    }

    // 3) Enrichir depuis la page Untappd
    const enriched = await fetchHtmlAndEnrich(bestMatch);
    if (enriched) return enriched;

    // 4) Enrichissement KO → essai DuckDuckGo
    const ddq = product || originalQuery || bestMatch.beer_name;
    return await fetchFromDuckDuckGoUntappd(ddq, producer, product);
}

module.exports = { getUntappdData };

// ------------------------------
// 🧪 CLI
// ------------------------------
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node api/untappd.js "Menaud Camerise"');
        console.log('  node api/untappd.js "Menaud" "Camerise"');
        process.exit(1);
    }

    const run = async () => {
        let res = null;
        if (args.length >= 2) {
            res = await getUntappdData(args[0], args.slice(1).join(' '));
        } else {
            res = await getUntappdData(args[0]);
        }
        if (!res) {
            console.error('❌ Aucune donnée trouvée.');
            process.exit(1);
        }
        console.log(JSON.stringify(res, null, 2));
    };

    run();
}