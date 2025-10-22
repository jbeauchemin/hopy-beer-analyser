// api/veuxtuunebiere.js
const axios = require('axios');
const cheerio = require('cheerio');
const { searchDuckDuckGo } = require('./duckduckgo'); // ← même import que chez toi

/** Slug SEO-friendly */
function generateSlug(name) {
    return (name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[''"]/g, '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
}

/** Fallback queries en enlevant les mots de gauche */
function generateQueryFallbacks(query) {
    const words = (query || '').split(' ').filter(Boolean);
    const fallbacks = [];
    for (let i = 0; i < words.length; i++) {
        const slice = words.slice(i).join(' ').trim();
        if (slice.length >= 3) fallbacks.push(slice);
    }
    return fallbacks;
}

/** Construire des candidates de recherche (producer+product, puis product seul + fallbacks) */
function buildSearchCandidates(producer, product) {
    const list = [];
    const p = (producer || '').trim();
    const b = (product || '').trim();

    if (p && b) {
        list.push(`${p} ${b}`);   // requête la plus informative
        list.push(b);             // produit seul
    } else {
        list.push(b || p);
    }
    if (b) list.push(...generateQueryFallbacks(b));

    // dédoublonne
    const seen = new Set();
    return list.filter((q) => {
        const k = q.toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** User-Agent random + headers réalistes */
function getRandomUserAgent() {
    const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
}
function getRealisticHeaders(referrer = null) {
    return {
        'User-Agent': getRandomUserAgent(),
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Referer': referrer || 'https://duckduckgo.com/',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        'Connection': 'keep-alive',
    };
}

/** Limiteur très simple */
let requestCounter = 0;
const MAX_REQUESTS_PER_SESSION = 25;

/** GET avec retries */
async function fetchWithRetry(url, maxRetries = 3, referrer = null) {
    if (requestCounter >= MAX_REQUESTS_PER_SESSION) {
        console.warn('⚠️ Limite de requêtes atteinte pour cette session');
        return null;
    }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            console.log(`🌐 GET ${url}${attempt ? ` (tentative ${attempt + 1}/${maxRetries})` : ''}`);
            requestCounter++;
            const res = await axios.get(url, {
                headers: getRealisticHeaders(referrer),
                timeout: 20000,
                maxRedirects: 5,
            });
            return res.data;
        } catch (error) {
            if (attempt === maxRetries - 1) {
                console.error(`❌ Échec après ${maxRetries} tentatives pour ${url}`);
                return null;
            }
        }
    }
    return null;
}

/** Parser d’une page produit VTUB */
function parseBeerPage($, fallbackName, source = 'veuxtuunebiere.com') {
    try {
        const metaDescription = $('meta[name="description"]').attr('content');
        if (!metaDescription) {
            console.warn('⚠️ Pas de meta description trouvée');
            return null;
        }

        // image: og:image:secure_url puis og:image en fallback
        const ogSecure = $('meta[property="og:image:secure_url"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content');
        const image_url = (ogSecure || ogImage || '')
            .replace(/^\/\//, 'https://') || null;

        const description = metaDescription
            .replace(/&#39;/g, "'")
            .replace(/&ndash;/g, '–')
            .trim() || null;

        let abv = null, style = null, subStyle = null, producer = null, volume = null;

        $('#wrapper-details li').each((_, el) => {
            const label = $(el).find('span').first().text().trim().toLowerCase();
            const rawValue =
                $(el).find('a').text().trim() || $(el).find('span').last().text().trim();

            if (label.includes('alcool')) {
                abv = parseFloat(
                    rawValue.replace('%', '').replace(',', '.')
                ) || null;
            }
            if (label.includes('style') && !label.includes('sous')) style = rawValue?.trim() || null;
            if (label.includes('sous-style')) subStyle = rawValue?.trim() || null;
            if (label.includes('producteur'))
                producer = rawValue.replace(/^Producteur\s*/i, '').trim();
            if (label.includes('volume')) {
                const match = rawValue.match(/([0-9]+)\s*ml/i);
                if (match) volume = parseInt(match[1], 10);
            }
        });

        // ABV aussi via la description (ex: "4%" ou "4,5%")
        if (!abv && description) {
            const abvMatch = description.match(/(\d+(?:[,.]\d+)?)\s*%/);
            if (abvMatch) abv = parseFloat(abvMatch[1].replace(',', '.'));
        }

        const result = {
            source,
            beer_name: $('h1.product-single__title').text().trim() || fallbackName,
            brewery_name: producer || null,
            type_name: subStyle || null,
            style: style || null,
            abv,
            volume_ml: volume,
            description,
            image_url,
        };

        console.log(`✅ Informations extraites pour "${result.beer_name}"`);
        return result;
    } catch (error) {
        console.error('❌ Erreur lors du parsing de la page:', error.message);
        return null;
    }
}

/** Essayer de parser une URL VTUB */
async function tryParseProductUrl(url, fallbackName, sourceLabel) {
    const html = await fetchWithRetry(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    if ($('h1.product-single__title').length === 0) {
        console.log('❌ Page non reconnue comme page produit');
        return null;
    }
    return parseBeerPage($, fallbackName, sourceLabel);
}

/** Validation stricte du résultat pour éviter les faux positifs */
function validateBeerMatch(beerResult, product) {
    if (!beerResult || !product) return true; // Si pas de contrainte, accepter

    const normalize = (s) => (s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const beerName = normalize(beerResult.beer_name || '');
    const searchProduct = normalize(product);

    // Tokenizer
    const tokens = (s) => s.split(' ').filter(t => t.length > 2);
    const beerTokens = new Set(tokens(beerName));
    const productTokens = tokens(searchProduct);

    // Compter combien de tokens du produit sont dans le nom de la bière
    let matches = 0;
    for (const token of productTokens) {
        if (beerTokens.has(token)) matches++;
    }

    // Ratio de correspondance (au moins 40% des tokens doivent matcher)
    const ratio = productTokens.length > 0 ? matches / productTokens.length : 1;

    if (ratio < 0.4) {
        console.log(`⚠️ Validation échouée: "${beerResult.beer_name}" ne correspond pas à "${product}" (${Math.round(ratio * 100)}% match)`);
        return false;
    }

    console.log(`✅ Validation réussie: "${beerResult.beer_name}" (${Math.round(ratio * 100)}% match)`);
    return true;
}

/** 🔎 Recherche DuckDuckGo (prioritaire) — avec opts producer/product */
async function fetchViaDuckDuckGo(producer, product, query) {
    console.log(`🔁 Recherche DuckDuckGo pour "${query}" (site: veuxtuunebiere.com)`);
    try {
        const duckUrl = await searchDuckDuckGo(
            query,
            'veuxtuunebiere.com',
            '/products/',
            { producer, product } // ← passe le contexte pour validation stricte
        );
        if (!duckUrl) {
            console.log('❌ Aucune URL trouvée via DuckDuckGo');
            return null;
        }
        if (duckUrl.includes('/products/')) {
            const result = await tryParseProductUrl(
                duckUrl,
                query,
                'veuxtuunebiere.com (via DuckDuckGo)'
            );

            // VALIDATION STRICTE : rejeter si ne correspond pas au produit
            if (result && !validateBeerMatch(result, product)) {
                return null; // Rejeter ce résultat → passera au fallback slugs
            }

            return result;
        }
        console.log('❌ URL non-produit détectée via DuckDuckGo');
        return null;
    } catch (err) {
        console.error('❌ Erreur recherche DuckDuckGo:', err.message);
        return null;
    }
}

/** Cache local pour éviter de refaire les mêmes requêtes */
const resultsCache = new Map();

/**
 * 💡 API principale
 * - Appel flexible:
 *   fetchFromVeuxTuUneBiere("Camerise")
 *   fetchFromVeuxTuUneBiere("Menaud", "Camerise")
 * Flow:
 *   1) DuckDuckGo d’abord (producer+product puis product)
 *   2) Fallback enumeration de slugs si rien trouvé
 */
async function fetchFromVeuxTuUneBiere(arg1, arg2) {
    // Résoudre inputs
    let producer = null;
    let product = null;
    if (typeof arg2 === 'string') {
        producer = (arg1 || '').trim();
        product = (arg2 || '').trim();
    } else {
        product = (arg1 || '').trim();
    }
    const cacheKey = `${(producer || '').toLowerCase()}|${(product || '').toLowerCase().trim()}`;

    // Cache
    if (resultsCache.has(cacheKey)) {
        console.log(`🔄 Résultat trouvé en cache pour "${producer ? producer + ' ' : ''}${product}"`);
        return resultsCache.get(cacheKey);
    }

    // Réinitialiser compteur si trop élevé
    if (requestCounter >= MAX_REQUESTS_PER_SESSION) {
        console.warn('⚠️ Réinitialisation du compteur de requêtes');
        requestCounter = 0;
    }

    // 1) 🔎 Recherche DuckDuckGo en priorité (candidats : "producer product", "product", fallbacks)
    const candidates = buildSearchCandidates(producer, product);
    let result = null;
    for (const q of candidates) {
        result = await fetchViaDuckDuckGo(producer, product, q);
        if (result) break;
    }

    // 2) 🧩 Fallback slugs (si rien trouvé via Duck)
    if (!result) {
        console.log('🔄 Aucun résultat via DuckDuckGo — fallback sur slugs');
        // on énumère uniquement sur le produit (plus stable pour slugs)
        const baseList = generateQueryFallbacks(product || producer || '');
        // INVERSION : tester les queries courtes EN PREMIER (Lesseps avant Pit Caribou IPA de Lesseps)
        baseList.reverse();

        for (const query of baseList) {
            if (result) break;
            const baseSlug = generateSlug(query);

            // Ajouter variation sans 's' final (lesseps → lessep)
            const slugVariants = [baseSlug];
            if (baseSlug.endsWith('s')) {
                slugVariants.push(baseSlug.slice(0, -1));
            }

            console.log(`🔍 Essai slug de base: "${baseSlug}"`);

            for (const slug of slugVariants) {
                if (result) break;
                // Tester: slug, slug-sans-alcool, slug-1, slug-2, slug-3
                for (let i = 0; i <= 3; i++) {
                    if (result) break;
                    const finalSlug = i === 0 ? slug : `${slug}-${i}`;
                    const url = `https://veuxtuunebiere.com/products/${finalSlug}`;
                    console.log(`🔍 Tentative: ${url}`);
                    result = await tryParseProductUrl(url, query);
                    if (result) {
                        console.log(`✅ Correspondance trouvée avec slug "${finalSlug}"`);
                        break;
                    }
                }
                // Tester aussi avec -sans-alcool
                if (!result) {
                    const url = `https://veuxtuunebiere.com/products/${slug}-sans-alcool`;
                    console.log(`🔍 Tentative: ${url}`);
                    result = await tryParseProductUrl(url, query);
                    if (result) {
                        console.log(`✅ Correspondance trouvée avec slug "${slug}-sans-alcool"`);
                        break;
                    }
                }
            }
        }
    }

    // 3) Cache & retour
    if (result) {
        resultsCache.set(cacheKey, result);
    } else {
        console.error(`❌ Aucune donnée trouvée pour "${producer ? producer + ' ' : ''}${product}"`);
    }

    return result;
}

// Nettoyage
process.on('SIGINT', () => {
    console.log('🧹 Nettoyage avant sortie...');
    process.exit(0);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Promesse non gérée:', reason);
});

module.exports = { fetchFromVeuxTuUneBiere };

/** CLI locale */
if (require.main === module) {
    const args = process.argv.slice(2);
    let res;
    const run = async () => {
        if (args.length >= 2) {
            res = await fetchFromVeuxTuUneBiere(args[0], args.slice(1).join(' '));
        } else if (args.length === 1) {
            res = await fetchFromVeuxTuUneBiere(args[0]);
        } else {
            console.log('Usage: node api/veuxtuunebiere.js "Product"');
            console.log('   ou: node api/veuxtuunebiere.js "Producer" "Product"');
            process.exit(1);
        }
        if (res) console.log(JSON.stringify(res, null, 2));
        else process.exit(1);
    };
    run();
}