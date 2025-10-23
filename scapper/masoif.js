// ============================================================================
// Masoif.com Scraper - Architecture 2 phases
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

        // 1. Titre de la bière
        const beer_name =
            $('h1.product_title.entry-title').text().trim() ||
            $('h1.elementor-heading-title').text().trim() ||
            $('h1').first().text().trim();

        if (!beer_name) return null;

        // 2. Attributs de la bière (brasserie, format, ABV)
        // Dans: <ul class="attributs-biere"><li><span class="attribute-value">Le Prospecteur</span></li>...
        const attributs = [];
        $('ul.attributs-biere li span.attribute-value').each((i, el) => {
            const text = $(el).text().trim();
            if (text) attributs.push(text);
        });

        // attributs[0] = Brasserie (ou lien vers brasserie)
        // attributs[1] = Format (ex: "473 ml")
        // attributs[2] = ABV (ex: "5.0%")

        const brewery_name = attributs[0] || null;
        const format = attributs[1] || null;

        let abv = null;
        if (attributs[2]) {
            const abvMatch = attributs[2].match(/(\d+(?:[.,]\d+)?)\s*%/);
            if (abvMatch) {
                abv = parseFloat(abvMatch[1].replace(',', '.'));
            }
        }

        // 3. Image - Chercher dans la galerie produit
        let image_url =
            $('.woocommerce-product-gallery img.wp-post-image').attr('src') ||
            $('.woocommerce-product-gallery img.wp-post-image').attr('data-src') ||
            $('.woocommerce-product-gallery img').first().attr('src') ||
            null;

        // Nettoyer l'URL de l'image (enlever les paramètres de redimensionnement si nécessaire)
        if (image_url && image_url.includes('?')) {
            // Garder l'URL complète avec les paramètres
            image_url = image_url.split('&ssl=')[0] + '&ssl=1';
        }

        // 4. Description - Dans .elementor-shortcode p
        const description =
            $('.single-product-desc .elementor-shortcode p').text().trim() ||
            $('.elementor-shortcode p').first().text().trim() ||
            null;

        // 5. IBU - Extraire de la description
        let ibu = null;
        if (description) {
            // Chercher "IBU : 10 à 11" ou "IBU : 10"
            const ibuMatch = description.match(/IBU\s*:\s*(\d+)(?:\s*(?:à|a)\s*(\d+))?/i);
            if (ibuMatch) {
                // Si plage (ex: "10 à 11"), prendre la moyenne ou le premier
                ibu = parseInt(ibuMatch[1]);
            }
        }

        // 6. Style/Profil - Dans ul.fiche-produit
        let style = null;
        $('ul.fiche-produit li').each((i, el) => {
            const label = $(el).find('.attribute-label').text().trim();
            if (label.includes('Profil')) {
                style = $(el).find('.attribute-value').text().trim();
            }
        });

        // Fallback: chercher dans la description
        if (!style && description) {
            const styleMatch = description.match(/Style\s*:\s*([^\n•]+)/i);
            if (styleMatch) {
                style = styleMatch[1].trim();
            }
        }

        return {
            source: 'masoif.com',
            url: url,
            beer_name: beer_name,
            brewery_name: brewery_name,
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
            // searchDuckDuckGo retourne UNE URL (string), pas un array
            const url = await searchDuckDuckGo(
                query,
                'masoif.com',
                '/produit/',  // <- Chemin correct pour masoif.com
                { product, producer }  // <- IMPORTANT: passer opts pour validation
            );

            if (!url) {
                console.log('  ⚠️  Pas de résultats DuckDuckGo');
                continue;
            }

            // Fetch et parse la page trouvée
            const parsed = await fetchProductPage(url);
            if (parsed) {
                console.log(`  ✓ Trouvé via DuckDuckGo: ${parsed.beer_name}`);
                candidates.push(parsed);
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
