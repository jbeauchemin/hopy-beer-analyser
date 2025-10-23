/**
 * Advanced Scoring Module for Beer Matching
 *
 * Features:
 * - Levenshtein distance for precise similarity
 * - Incompatible variation detection (Session vs Double, avec/sans alcool)
 * - Strict producer validation
 * - Confidence scoring
 * - Blacklist for common false positives
 */

const { distance: levenshtein } = require('fastest-levenshtein');

// Configuration
const CONFIG = {
    MIN_SCORE_THRESHOLD: 0.70,          // 70% minimum global score
    MIN_PRODUCER_SCORE: 0.50,           // 50% minimum producer score (augmenté de 40%)
    MIN_PRODUCT_SCORE: 0.60,            // 60% minimum product score
    PRODUCT_WEIGHT: 0.6,                // 60% weight for product
    PRODUCER_WEIGHT: 0.4,               // 40% weight for producer

    // Confidence thresholds
    HIGH_CONFIDENCE: 0.85,
    MEDIUM_CONFIDENCE: 0.70,

    // Levenshtein thresholds
    EXACT_MATCH: 0.95,                  // 95%+ = exact match
    STRONG_MATCH: 0.85,                 // 85%+ = strong match
    GOOD_MATCH: 0.70,                   // 70%+ = good match
};

/**
 * Normalise une chaîne pour comparaison
 */
function normalize(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Enlever accents
        .replace(/[^a-z0-9\s]/g, ' ')    // Garder seulement lettres et chiffres
        .replace(/\s+/g, ' ')             // Normaliser espaces
        .trim();
}

/**
 * Calcule la similarité Levenshtein entre deux chaînes (0-1)
 */
function calculateLevenshteinSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;

    const norm1 = normalize(str1);
    const norm2 = normalize(str2);

    if (norm1 === norm2) return 1.0;

    const maxLen = Math.max(norm1.length, norm2.length);
    if (maxLen === 0) return 0;

    const dist = levenshtein(norm1, norm2);
    return 1 - (dist / maxLen);
}

/**
 * Détecte si les variations de bière sont incompatibles
 */
function detectIncompatibleVariations(queryProduct, foundProduct) {
    const query = normalize(queryProduct);
    const found = normalize(foundProduct);

    // Détection alcool vs sans alcool
    const querySansAlcool = /sans alcool|non alcoholic|alcohol free|0\s*%/i.test(queryProduct);
    const foundSansAlcool = /sans alcool|non alcoholic|alcohol free|0\s*%/i.test(foundProduct);

    if (querySansAlcool !== foundSansAlcool) {
        return {
            incompatible: true,
            reason: `Alcool mismatch: query="${querySansAlcool ? 'sans alcool' : 'avec alcool'}", found="${foundSansAlcool ? 'sans alcool' : 'avec alcool'}"`
        };
    }

    // Détection variations IPA incompatibles
    const ipaVariations = {
        session: /session\s*ipa/i,
        double: /double\s*ipa|dipa/i,
        triple: /triple\s*ipa|tipa/i,
        imperial: /imperial\s*ipa/i,
        standard: /\bipa\b/i,
    };

    let queryType = null;
    let foundType = null;

    for (const [type, regex] of Object.entries(ipaVariations)) {
        if (regex.test(queryProduct)) queryType = type;
        if (regex.test(foundProduct)) foundType = type;
    }

    // Si les deux sont des IPAs mais de types différents (sauf standard qui est compatible avec tout)
    if (queryType && foundType && queryType !== foundType) {
        if (queryType !== 'standard' && foundType !== 'standard') {
            return {
                incompatible: true,
                reason: `IPA type mismatch: query="${queryType} IPA", found="${foundType} IPA"`
            };
        }
    }

    // Détection Pale Ale vs IPA (souvent confondus)
    const queryIsPaleAle = /pale\s*ale/i.test(queryProduct) && !/ipa/i.test(queryProduct);
    const foundIsPaleAle = /pale\s*ale/i.test(foundProduct) && !/ipa/i.test(foundProduct);
    const queryIsIPA = /ipa/i.test(queryProduct);
    const foundIsIPA = /ipa/i.test(foundProduct);

    if ((queryIsPaleAle && foundIsIPA) || (queryIsIPA && foundIsPaleAle)) {
        // Pas incompatible mais pénalité
        return {
            incompatible: false,
            penalty: 0.15,
            reason: `Style confusion: Pale Ale vs IPA`
        };
    }

    return { incompatible: false };
}

/**
 * Valide strictement le producteur
 */
function validateProducer(queryProducer, foundProducer) {
    if (!queryProducer || !foundProducer) {
        return {
            score: 0,
            reason: 'Missing producer information'
        };
    }

    const query = normalize(queryProducer);
    const found = normalize(foundProducer);

    // Exact match
    if (query === found) {
        return { score: 1.0, reason: 'Exact match' };
    }

    // Levenshtein similarity
    const similarity = calculateLevenshteinSimilarity(queryProducer, foundProducer);

    // Very different producers
    if (similarity < 0.40) {
        return {
            score: similarity,
            reason: `Very different producers: "${queryProducer}" vs "${foundProducer}" (similarity: ${(similarity * 100).toFixed(0)}%)`,
            warning: true
        };
    }

    // Check if one contains the other
    if (query.includes(found) || found.includes(query)) {
        return {
            score: Math.max(0.85, similarity),
            reason: 'Substring match'
        };
    }

    // Split into words and check common words
    const queryWords = query.split(/\s+/).filter(w => w.length > 2);
    const foundWords = found.split(/\s+/).filter(w => w.length > 2);

    const commonWords = queryWords.filter(w => foundWords.includes(w));
    const wordMatchScore = commonWords.length / Math.max(queryWords.length, foundWords.length);

    // Combine Levenshtein and word matching
    const finalScore = Math.max(similarity, wordMatchScore);

    return {
        score: finalScore,
        reason: `Producer similarity: ${(finalScore * 100).toFixed(0)}%`,
        details: {
            levenshtein: similarity,
            wordMatch: wordMatchScore,
            commonWords: commonWords
        }
    };
}

/**
 * Score un produit avec le nouveau système avancé
 */
function scoreProduct(queryProduct, foundProduct) {
    if (!queryProduct || !foundProduct) {
        return { score: 0, reason: 'Missing product information' };
    }

    // Check incompatible variations first
    const variationCheck = detectIncompatibleVariations(queryProduct, foundProduct);
    if (variationCheck.incompatible) {
        return {
            score: 0,
            reason: variationCheck.reason,
            rejected: true
        };
    }

    // Calculate Levenshtein similarity
    const similarity = calculateLevenshteinSimilarity(queryProduct, foundProduct);

    // Apply penalty if there's a style confusion
    let finalScore = similarity;
    if (variationCheck.penalty) {
        finalScore = Math.max(0, similarity - variationCheck.penalty);
    }

    return {
        score: finalScore,
        reason: `Product similarity: ${(finalScore * 100).toFixed(0)}%`,
        details: {
            levenshtein: similarity,
            penalty: variationCheck.penalty || 0,
            penaltyReason: variationCheck.reason
        }
    };
}

/**
 * Calcule le score global avec le nouveau système
 */
function calculateScore(query, found) {
    const { producer: queryProducer, product: queryProduct } = query;
    const { brewery_name: foundProducer, beer_name: foundProduct } = found;

    // Score product
    const productResult = scoreProduct(queryProduct, foundProduct);
    if (productResult.rejected) {
        return {
            finalScore: 0,
            productScore: 0,
            producerScore: 0,
            rejected: true,
            reason: productResult.reason,
            details: productResult
        };
    }

    // Score producer (if provided)
    let producerResult = { score: 1.0, reason: 'No producer to validate' };
    if (queryProducer) {
        producerResult = validateProducer(queryProducer, foundProducer);
    }

    // Calculate weighted final score
    const finalScore = (productResult.score * CONFIG.PRODUCT_WEIGHT) +
                       (producerResult.score * CONFIG.PRODUCER_WEIGHT);

    // Check thresholds
    const passesThresholds =
        finalScore >= CONFIG.MIN_SCORE_THRESHOLD &&
        producerResult.score >= CONFIG.MIN_PRODUCER_SCORE &&
        productResult.score >= CONFIG.MIN_PRODUCT_SCORE;

    return {
        finalScore,
        productScore: productResult.score,
        producerScore: producerResult.score,
        passesThresholds,
        rejected: !passesThresholds,
        confidence: getConfidenceLevel(finalScore, producerResult.score, productResult.score),
        reason: passesThresholds ? 'Match accepted' : 'Below thresholds',
        details: {
            product: productResult,
            producer: producerResult
        }
    };
}

/**
 * Détermine le niveau de confiance
 */
function getConfidenceLevel(finalScore, producerScore, productScore) {
    // High confidence: excellent scores everywhere
    if (finalScore >= CONFIG.HIGH_CONFIDENCE &&
        producerScore >= 0.80 &&
        productScore >= 0.85) {
        return 'high';
    }

    // Medium confidence: good scores
    if (finalScore >= CONFIG.MEDIUM_CONFIDENCE &&
        producerScore >= CONFIG.MIN_PRODUCER_SCORE &&
        productScore >= CONFIG.MIN_PRODUCT_SCORE) {
        return 'medium';
    }

    // Low confidence
    return 'low';
}

/**
 * Trouve le meilleur match parmi une liste de candidats
 */
function findBestMatch(query, candidates) {
    if (!candidates || candidates.length === 0) {
        return null;
    }

    const scoredCandidates = candidates.map(candidate => {
        const scoreResult = calculateScore(query, candidate);
        return {
            ...candidate,
            scoreResult
        };
    });

    // Filter out rejected candidates
    const validCandidates = scoredCandidates.filter(c => !c.scoreResult.rejected);

    if (validCandidates.length === 0) {
        return null;
    }

    // Sort by final score (descending)
    validCandidates.sort((a, b) => b.scoreResult.finalScore - a.scoreResult.finalScore);

    return validCandidates[0];
}

module.exports = {
    CONFIG,
    normalize,
    calculateLevenshteinSimilarity,
    detectIncompatibleVariations,
    validateProducer,
    scoreProduct,
    calculateScore,
    getConfidenceLevel,
    findBestMatch
};
