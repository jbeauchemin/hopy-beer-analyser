// ============================================================================
// VeuxTuUneBiere Scraper v2 - Architecture 2 phases
// ============================================================================
// Phase 1: COLLECTE (permissive) - rassemble tous les candidats possibles
// Phase 2: VALIDATION (stricte) - sélectionne le meilleur ou retourne null
// ============================================================================

const axios = require('axios');
const cheerio = require('cheerio');
const { searchDuckDuckGo } = require('./duckduckgo');
const { findBestMatch, CONFIG: SCORING_CONFIG } = require('../utils/scoring');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    MAX_REQUESTS: 50,
    RETRY_ATTEMPTS: 2,
    TIMEOUT_MS: 20000,
    // Scoring configuration now imported from utils/scoring.js
    ...SCORING_CONFIG,
};

let requestCounter = 0;
const resultsCache = new Map();

// ============================================================================
// UTILITAIRES
// ============================================================================

function normalize(text) {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return normalize(text).split(' ').filter(t => t.length > 2);
}

function generateSlug(name) {
    return (name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[''"]/g, '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase();
}

function getRandomUserAgent() {
    const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
}

async function fetchWithRetry(url, maxRetries = CONFIG.RETRY_ATTEMPTS) {
    if (requestCounter >= CONFIG.MAX_REQUESTS) {
        return null;
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            requestCounter++;

            // Petit délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 200));

            const { data } = await axios.get(url, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept-Language': 'fr-FR,fr;q=0.9',
                },
                timeout: CONFIG.TIMEOUT_MS,
            });
            return data;
        } catch (error) {
            if (attempt === maxRetries - 1) return null;
            await new Promise(resolve => setTimeout(resolve, 500)); // Délai avant retry
        }
    }
    return null;
}

// ============================================================================
// PARSING HTML
// ============================================================================

async function parseProductPage(url) {
    const html = await fetchWithRetry(url);
    if (!html) return null;

    const $ = cheerio.load(html);

    // Vérifier que c'est une page produit valide
    if ($('h1.product-single__title').length === 0) {
        return null;
    }

    const beer_name = $('h1.product-single__title').text().trim();
    if (!beer_name) return null;

    // Extraire les infos
    let brewery_name = null;
    let abv = null;
    let volume_ml = null;
    let style = null;
    let subStyle = null;

    $('#wrapper-details li').each((_, el) => {
        const label = $(el).find('span').first().text().trim().toLowerCase();
        const value = $(el).find('a').text().trim() || $(el).find('span').last().text().trim();

        if (label.includes('producteur')) {
            brewery_name = value.replace(/^Producteur\s*/i, '').trim();
        } else if (label.includes('alcool')) {
            abv = parseFloat(value.replace('%', '').replace(',', '.')) || null;
        } else if (label.includes('style') && !label.includes('sous')) {
            style = value;
        } else if (label.includes('sous-style')) {
            subStyle = value;
        } else if (label.includes('volume')) {
            const match = value.match(/([0-9]+)\s*ml/i);
            if (match) volume_ml = parseInt(match[1], 10);
        }
    });

    const description = $('meta[name="description"]').attr('content') || null;
    const ogImage = $('meta[property="og:image:secure_url"]').attr('content')
                 || $('meta[property="og:image"]').attr('content');
    const image_url = ogImage ? ogImage.replace(/^\/\//, 'https://') : null;

    return {
        url,
        beer_name,
        brewery_name,
        type_name: subStyle,
        style,
        abv,
        volume_ml,
        description,
        image_url,
        source: 'veuxtuunebiere.com',
    };
}

// ============================================================================
// PHASE 1: COLLECTE (PERMISSIVE)
// ============================================================================

function generateSlugCandidates(product) {
    const slugs = [];
    const base = generateSlug(product);

    // Variation base + sans 's' final
    const variations = [base];
    if (base.endsWith('s')) {
        variations.push(base.slice(0, -1));
    }

    // Pour chaque variation : base, base-1, base-2, base-sans-alcool
    for (const slug of variations) {
        slugs.push(slug);
        for (let i = 1; i <= 2; i++) {
            slugs.push(`${slug}-${i}`);
        }
        slugs.push(`${slug}-sans-alcool`);
    }

    return [...new Set(slugs)]; // Dédupliquer
}

async function collectCandidatesFromSlugs(product) {
    console.log('🔍 Collecte via slugs...');
    const candidates = [];
    const MAX_CANDIDATES = 5; // Limite pour éviter trop de requêtes

    // Générer des requêtes de fallback (ex: "IPA de Lesseps" → ["Lesseps", "de Lesseps", "IPA de Lesseps"])
    const words = (product || '').split(' ').filter(Boolean);
    const queryVariants = [];

    // Tester les mots de droite à gauche (Lesseps avant IPA de Lesseps)
    for (let i = words.length - 1; i >= 0; i--) {
        const slice = words.slice(i).join(' ').trim();
        if (slice.length >= 3) queryVariants.push(slice);
    }

    // Pour chaque variant, générer les slugs
    outerLoop: for (const variant of queryVariants) {
        const slugs = generateSlugCandidates(variant);

        for (const slug of slugs) {
            if (candidates.length >= MAX_CANDIDATES) {
                console.log(`  ⏹️  Arrêt après ${MAX_CANDIDATES} candidats trouvés`);
                break outerLoop;
            }

            const url = `https://veuxtuunebiere.com/products/${slug}`;
            const parsed = await parseProductPage(url);
            if (parsed) {
                console.log(`  ✓ Trouvé: ${parsed.beer_name} (${slug})`);
                candidates.push(parsed);
            }
        }
    }

    return candidates;
}

async function collectCandidatesFromDuckDuckGo(producer, product, query) {
    console.log(`🔍 Collecte via DuckDuckGo: "${query}"`);

    try {
        const url = await searchDuckDuckGo(query, 'veuxtuunebiere.com', '/products/', { producer, product });
        if (!url || !url.includes('/products/')) {
            return [];
        }

        const parsed = await parseProductPage(url);
        if (parsed) {
            console.log(`  ✓ Trouvé: ${parsed.beer_name}`);
            return [parsed];
        }
    } catch (error) {
        console.log(`  ✗ Erreur DuckDuckGo: ${error.message}`);
    }

    return [];
}

async function collectAllCandidates(producer, product) {
    const allCandidates = [];

    // 1. DuckDuckGo avec plusieurs queries
    const queries = [
        product,
        producer && product ? `${producer} ${product}` : null,
    ].filter(Boolean);

    for (const query of queries) {
        const candidates = await collectCandidatesFromDuckDuckGo(producer, product, query);
        allCandidates.push(...candidates);
    }

    // 2. Slug enumeration (seulement si < 3 candidats)
    if (allCandidates.length < 3) {
        const slugCandidates = await collectCandidatesFromSlugs(product);
        allCandidates.push(...slugCandidates);
    }

    // Déduplication par URL
    const seen = new Set();
    const unique = [];
    for (const candidate of allCandidates) {
        if (!seen.has(candidate.url)) {
            seen.add(candidate.url);
            unique.push(candidate);
        }
    }

    console.log(`\n📋 Total candidats collectés: ${unique.length}`);
    return unique;
}

// ============================================================================
// PHASE 2: VALIDATION & SCORING (STRICTE)
// ============================================================================

function calculateTokenOverlap(text1, text2) {
    if (!text1 || !text2) return 0;

    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);

    if (tokens2.length === 0) return 0;

    let totalScore = 0;
    for (const token2 of tokens2) {
        let bestMatch = 0;

        for (const token1 of tokens1) {
            // Match exact
            if (token1 === token2) {
                bestMatch = 1.0;
                break;
            }

            // Match avec pluriel (lessep vs lesseps)
            const t1 = token1.replace(/s$/, '');
            const t2 = token2.replace(/s$/, '');
            if (t1 === t2 && t1.length >= 3) {
                bestMatch = Math.max(bestMatch, 0.95);
                continue;
            }

            // Match substring (lessep contenu dans lesseps ou vice-versa)
            if (token1.length >= 4 && token2.length >= 4) {
                if (token1.includes(token2) || token2.includes(token1)) {
                    const ratio = Math.min(token1.length, token2.length) / Math.max(token1.length, token2.length);
                    bestMatch = Math.max(bestMatch, 0.85 * ratio);
                }
            }
        }

        totalScore += bestMatch;
    }

    return totalScore / tokens2.length;
}

function scoreCandidate(candidate, producer, product) {
    // Score produit (60%)
    const productScore = calculateTokenOverlap(candidate.beer_name, product);

    // Score producteur (40%)
    let producerScore = 0;
    if (producer && candidate.brewery_name) {
        producerScore = calculateTokenOverlap(candidate.brewery_name, producer);
    } else if (!producer) {
        producerScore = 1; // Si pas de contrainte producteur, on accepte
    }

    const finalScore = (productScore * CONFIG.PRODUCT_WEIGHT) + (producerScore * CONFIG.PRODUCER_WEIGHT);

    return {
        total: finalScore,
        product: productScore,
        producer: producerScore,
    };
}

function selectBestCandidate(candidates, producer, product) {
    if (!candidates || candidates.length === 0) {
        console.log('\n❌ Aucun candidat à évaluer');
        return null;
    }

    console.log('\n📊 Scoring des candidats avec algorithme avancé (Levenshtein + validation stricte):');

    // Utiliser le module de scoring avancé
    const query = { producer, product };
    const bestMatch = findBestMatch(query, candidates);

    if (!bestMatch) {
        console.log('\n⚠️ Aucun candidat ne passe les seuils de validation');
        console.log(`   → Seuils: Score total ≥ ${(CONFIG.MIN_SCORE_THRESHOLD * 100).toFixed(0)}%, Producteur ≥ ${(CONFIG.MIN_PRODUCER_SCORE * 100).toFixed(0)}%, Produit ≥ ${(CONFIG.MIN_PRODUCT_SCORE * 100).toFixed(0)}%`);
        return null;
    }

    const { scoreResult, ...result } = bestMatch;

    // Affichage détaillé
    console.log(`\n✅ Meilleur candidat sélectionné:`);
    console.log(`   Bière: "${bestMatch.beer_name}"`);
    console.log(`   Brasserie: "${bestMatch.brewery_name || 'N/A'}"`);
    console.log(`   Score final: ${(scoreResult.finalScore * 100).toFixed(0)}%`);
    console.log(`   - Produit: ${(scoreResult.productScore * 100).toFixed(0)}%`);
    console.log(`   - Producteur: ${(scoreResult.producerScore * 100).toFixed(0)}%`);
    console.log(`   Confiance: ${scoreResult.confidence.toUpperCase()}`);

    if (scoreResult.details.producer.warning) {
        console.log(`   ⚠️  ${scoreResult.details.producer.reason}`);
    }

    if (scoreResult.details.product.details?.penaltyReason) {
        console.log(`   ℹ️  ${scoreResult.details.product.details.penaltyReason}`);
    }

    return result;
}

// ============================================================================
// API PRINCIPALE
// ============================================================================

async function fetchFromVeuxTuUneBiere(arg1, arg2) {
    // Parse arguments
    let producer = null;
    let product = null;

    if (typeof arg2 === 'string') {
        producer = (arg1 || '').trim();
        product = (arg2 || '').trim();
    } else {
        product = (arg1 || '').trim();
    }

    if (!product) {
        console.error('❌ Produit requis');
        return null;
    }

    // Cache
    const cacheKey = `${(producer || '').toLowerCase()}|${product.toLowerCase()}`;
    if (resultsCache.has(cacheKey)) {
        console.log(`🔄 Résultat en cache`);
        return resultsCache.get(cacheKey);
    }

    // Reset counter si nécessaire
    if (requestCounter >= CONFIG.MAX_REQUESTS) {
        console.log('⚠️ Reset compteur requêtes');
        requestCounter = 0;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔎 Recherche: "${producer || '(aucun)'}" - "${product}"`);
    console.log('='.repeat(60));

    try {
        // PHASE 1: COLLECTE
        console.log('\n📦 PHASE 1: COLLECTE DES CANDIDATS');
        const candidates = await collectAllCandidates(producer, product);

        // PHASE 2: VALIDATION & SCORING
        console.log('\n🎯 PHASE 2: VALIDATION & SCORING');
        const result = selectBestCandidate(candidates, producer, product);

        // Cache le résultat
        if (result) {
            resultsCache.set(cacheKey, result);
        }

        console.log('='.repeat(60) + '\n');
        return result;

    } catch (error) {
        console.error(`❌ Erreur: ${error.message}`);
        return null;
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { fetchFromVeuxTuUneBiere };

// CLI pour tests
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Usage: node veuxtuunebiere_v2.js "Product"');
        console.log('   ou: node veuxtuunebiere_v2.js "Producer" "Product"');
        process.exit(1);
    }

    (async () => {
        let result;
        if (args.length >= 2) {
            result = await fetchFromVeuxTuUneBiere(args[0], args.slice(1).join(' '));
        } else {
            result = await fetchFromVeuxTuUneBiere(args[0]);
        }

        if (result) {
            console.log('\n📄 RÉSULTAT:');
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log('\n❌ Aucun résultat trouvé');
        }
    })();
}
