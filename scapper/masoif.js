// ============================================================================
// Masoif.com Scraper - Architecture 2 phases
// ============================================================================
// Phase 1: COLLECTE (permissive) - rassemble tous les candidats possibles
// Phase 2: VALIDATION (stricte) - sélectionne le meilleur ou retourne null
// ============================================================================

const axios = require('axios');
const cheerio = require('cheerio');
const { searchDuckDuckGo } = require('./duckduckgo');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    MAX_REQUESTS: 50,
    RETRY_ATTEMPTS: 2,
    TIMEOUT_MS: 20000,
    MIN_SCORE_THRESHOLD: 0.55, // 55% minimum pour accepter
    PRODUCT_WEIGHT: 0.6,
    PRODUCER_WEIGHT: 0.4,
};

let requestCounter = 0;
const resultsCache = new Map();

// ============================================================================
// UTILITAIRES
// ============================================================================

function getRandomUserAgent() {
    const uas = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

            // Délai pour éviter le rate limiting
            await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 200));

            const { data } = await axios.get(url, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept-Language': 'fr-FR,fr;q=0.9',
                    // Cookie pour accepter la vérification d'âge (18+)
                    'Cookie': 'age_verified=true; age_gate_passed=yes',
                },
                timeout: CONFIG.TIMEOUT_MS,
                maxRedirects: 5, // Suivre les redirections
            });

            // Vérifier si c'est une page de vérification d'âge
            if (data.includes('As-tu au moins 18 ans') || data.includes('age-verification') || data.includes('age_gate')) {
                // Si on détecte la page d'âge, on essaie de la contourner
                // En général, ces sites utilisent un cookie ou un paramètre GET
                console.log('  ⚠️  Page de vérification d\'âge détectée');

                // Essayer avec le paramètre age_verified dans l'URL
                const separator = url.includes('?') ? '&' : '?';
                const urlWithAge = `${url}${separator}age_verified=yes`;

                const { data: retryData } = await axios.get(urlWithAge, {
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept-Language': 'fr-FR,fr;q=0.9',
                        'Cookie': 'age_verified=true; age_gate_passed=yes',
                    },
                    timeout: CONFIG.TIMEOUT_MS,
                    maxRedirects: 5,
                });

                return retryData;
            }

            return data;
        } catch (error) {
            if (attempt === maxRetries - 1) return null;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    return null;
}

// ============================================================================
// PARSING HTML
// ============================================================================

function parseProductPage(html, url) {
    if (!html) return null;

    try {
        const $ = cheerio.load(html);

        // Patterns de sélecteurs pour masoif.com
        // Ces sélecteurs seront ajustés une fois qu'on connaît la structure exacte
        const beer_name =
            $('h1.product-title').text().trim() ||
            $('h1.product__title').text().trim() ||
            $('h1[itemprop="name"]').text().trim() ||
            $('h1').first().text().trim();

        const brewery_name =
            $('.product-vendor').text().trim() ||
            $('.product__vendor').text().trim() ||
            $('[itemprop="brand"]').text().trim() ||
            $('.vendor').text().trim();

        // ABV - chercher dans différents formats
        let abv = null;
        const abvPatterns = [
            /(\d+(?:[.,]\d+)?)\s*%\s*alc/i,
            /alc[:\s]*(\d+(?:[.,]\d+)?)\s*%/i,
            /(\d+(?:[.,]\d+)?)\s*%/i,
        ];

        const bodyText = $('body').text();
        for (const pattern of abvPatterns) {
            const match = bodyText.match(pattern);
            if (match) {
                abv = parseFloat(match[1].replace(',', '.'));
                break;
            }
        }

        // IBU
        let ibu = null;
        const ibuMatch = bodyText.match(/(\d+)\s*IBU/i);
        if (ibuMatch) {
            ibu = parseInt(ibuMatch[1]);
        }

        // Style
        const style =
            $('.product-type').text().trim() ||
            $('.product__type').text().trim() ||
            $('[itemprop="category"]').text().trim() ||
            null;

        // Description
        const description =
            $('.product-description').text().trim() ||
            $('.product__description').text().trim() ||
            $('[itemprop="description"]').text().trim() ||
            $('.description').text().trim() ||
            null;

        // Image
        const image_url =
            $('img.product-image').attr('src') ||
            $('img.product__image').attr('src') ||
            $('[itemprop="image"]').attr('src') ||
            $('img').first().attr('src') ||
            null;

        // Format
        const format =
            $('.product-format').text().trim() ||
            $('.format').text().trim() ||
            null;

        if (!beer_name) return null;

        return {
            source: 'masoif.com',
            url: url,
            beer_name: beer_name,
            brewery_name: brewery_name || null,
            abv: abv,
            ibu: ibu,
            style: style,
            description: description,
            image_url: image_url,
            format: format,
        };
    } catch (error) {
        console.error('Erreur parsing masoif:', error.message);
        return null;
    }
}

async function fetchProductPage(url) {
    const html = await fetchWithRetry(url);
    if (!html) return null;
    return parseProductPage(html, url);
}

// ============================================================================
// PHASE 1: COLLECTE DES CANDIDATS
// ============================================================================

function generateSlugCandidates(text) {
    if (!text) return [];

    const normalized = text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // Enlever accents

    const baseSlug = normalized
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const slugs = [];

    // Base
    slugs.push(baseSlug);

    // Avec numéro (variant 1, 2, 3)
    for (let i = 1; i <= 3; i++) {
        slugs.push(`${baseSlug}-${i}`);
    }

    // Variante sans 's' final
    if (baseSlug.endsWith('s')) {
        const withoutS = baseSlug.slice(0, -1);
        slugs.push(withoutS);
        slugs.push(`${withoutS}-1`);
        slugs.push(`${withoutS}-2`);
    }

    return [...new Set(slugs)];
}

async function collectCandidatesFromSlugs(product) {
    console.log('🔍 Collecte via slugs...');
    const candidates = [];
    const MAX_CANDIDATES = 5;

    // Générer des requêtes de fallback (ex: "Blanche Poirée" → ["Poirée", "Blanche Poirée"])
    const words = (product || '').split(' ').filter(Boolean);
    const queryVariants = [];

    // Tester les mots de droite à gauche
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

            const url = `https://masoif.com/produit/${slug}/`;
            const parsed = await fetchProductPage(url);
            if (parsed) {
                console.log(`  ✓ Trouvé: ${parsed.beer_name} (${slug})`);
                candidates.push(parsed);
            }
        }
    }

    return candidates;
}

async function collectCandidatesFromDuckDuckGo(producer, product) {
    console.log('🔍 Collecte via DuckDuckGo...');
    const candidates = [];

    // Construire les requêtes de recherche
    const queries = [];
    if (producer && product) {
        queries.push(`${producer} ${product}`);
        queries.push(product);
    } else if (product) {
        queries.push(product);
    } else if (producer) {
        queries.push(producer);
    }

    for (const query of queries) {
        try {
            // Corriger l'appel: 3e paramètre = requiredPathPrefix (string), pas un objet
            const results = await searchDuckDuckGo(
                query,
                'masoif.com',
                '/produit/'  // <- Chemin correct pour masoif.com
            );

            if (!results || !Array.isArray(results)) {
                console.log('  ⚠️  Pas de résultats DuckDuckGo');
                continue;
            }

            for (const result of results) {
                if (result && result.url) {
                    // DuckDuckGo peut retourner des résultats déjà parsés
                    if (result.beer_name) {
                        candidates.push(result);
                    } else {
                        // Sinon, fetch et parse la page
                        const parsed = await fetchProductPage(result.url);
                        if (parsed) {
                            console.log(`  ✓ Trouvé: ${parsed.beer_name}`);
                            candidates.push(parsed);
                        }
                    }
                }
            }

            if (candidates.length >= 5) break; // Limite pour éviter trop de requêtes
        } catch (error) {
            console.log(`  ✗ Erreur DuckDuckGo:`, error.message);
        }
    }

    return candidates;
}

async function collectAllCandidates(producer, product) {
    console.log('\n============================================================');
    console.log(`🔎 Recherche masoif.com: "${producer || ''}" - "${product || ''}"`);
    console.log('============================================================\n');

    console.log('📦 PHASE 1: COLLECTE DES CANDIDATS');

    // Vérifier le cache
    const cacheKey = `${producer || 'null'}:${product || 'null'}`;
    if (resultsCache.has(cacheKey)) {
        console.log('💾 Résultat en cache');
        return resultsCache.get(cacheKey);
    }

    const allCandidates = [];

    // Collecte via DuckDuckGo
    const ddgCandidates = await collectCandidatesFromDuckDuckGo(producer, product);
    allCandidates.push(...ddgCandidates);

    // Si pas assez de candidats via DuckDuckGo, essayer les slugs
    if (allCandidates.length < 3 && product) {
        const slugCandidates = await collectCandidatesFromSlugs(product);
        allCandidates.push(...slugCandidates);
    }

    // Dédupliquer par URL
    const unique = [];
    const seenUrls = new Set();
    for (const candidate of allCandidates) {
        if (!seenUrls.has(candidate.url)) {
            seenUrls.add(candidate.url);
            unique.push(candidate);
        }
    }

    console.log(`\n📋 Total candidats collectés: ${unique.length}`);
    return unique;
}

// ============================================================================
// PHASE 2: VALIDATION & SCORING (STRICTE)
// ============================================================================

function tokenize(text) {
    if (!text) return [];
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 0);
}

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

            // Match avec pluriel
            const t1 = token1.replace(/s$/, '');
            const t2 = token2.replace(/s$/, '');
            if (t1 === t2 && t1.length >= 3) {
                bestMatch = Math.max(bestMatch, 0.95);
                continue;
            }

            // Match substring
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

    console.log('\n📊 Scoring des candidats:');

    const scored = candidates.map(candidate => {
        const scores = scoreCandidate(candidate, producer, product);
        return {
            ...candidate,
            score: scores.total,
            scoreDetails: scores,
        };
    });

    // Trier par score décroissant
    scored.sort((a, b) => b.score - a.score);

    // Afficher le top 3
    scored.slice(0, 3).forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.beer_name} (${c.brewery_name || 'N/A'})`);
        console.log(`     Score: ${(c.score * 100).toFixed(0)}% (produit: ${(c.scoreDetails.product * 100).toFixed(0)}%, producteur: ${(c.scoreDetails.producer * 100).toFixed(0)}%)`);
    });

    const best = scored[0];

    if (best.score >= CONFIG.MIN_SCORE_THRESHOLD) {
        console.log(`\n✅ Meilleur candidat sélectionné: "${best.beer_name}" (${(best.score * 100).toFixed(0)}%)`);
        const { score, scoreDetails, ...result } = best;
        return result;
    } else {
        console.log(`\n⚠️ Meilleur score: ${(best.score * 100).toFixed(0)}% < ${(CONFIG.MIN_SCORE_THRESHOLD * 100).toFixed(0)}% (seuil)`);
        console.log(`   → Retourne null (préfère pas de données que de mauvaises données)`);
        return null;
    }
}

// ============================================================================
// API PUBLIQUE
// ============================================================================

async function fetchFromMasoif(producer, product) {
    // Reset compteur pour chaque recherche
    requestCounter = 0;

    // Vérifier cache
    const cacheKey = `${producer || 'null'}:${product || 'null'}`;
    if (resultsCache.has(cacheKey)) {
        console.log('💾 Résultat en cache');
        return resultsCache.get(cacheKey);
    }

    try {
        // Phase 1: Collecte
        const candidates = await collectAllCandidates(producer, product);

        // Phase 2: Sélection
        console.log('\n🎯 PHASE 2: VALIDATION & SCORING\n');
        const result = selectBestCandidate(candidates, producer, product);

        console.log('============================================================\n');

        // Cache le résultat
        resultsCache.set(cacheKey, result);

        return result;
    } catch (error) {
        console.error('❌ Erreur masoif:', error.message);
        return null;
    }
}

// ============================================================================
// MODE CLI POUR TESTS
// ============================================================================

if (require.main === module) {
    (async () => {
        const producer = process.argv[2] || null;
        const product = process.argv[3] || null;

        if (!producer && !product) {
            console.log('Usage: node masoif.js "Producer" "Product"');
            console.log('   ou: node masoif.js "Product"');
            process.exit(1);
        }

        console.log('🍺 Test du scraper masoif.com\n');
        const result = await fetchFromMasoif(producer, product);

        if (result) {
            console.log('\n✅ Résultat:');
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log('\n❌ Aucun résultat trouvé');
        }

        process.exit(0);
    })();
}

module.exports = { fetchFromMasoif };
