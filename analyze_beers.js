const { getUntappdData } = require('./scapper/untapped');
const { fetchFromVeuxTuUneBiere } = require('./scapper/veuxtuunebiere');
const { fetchFromMasoif } = require('./scapper/masoif');
const { fetchFromEspaceHoublon } = require('./scapper/espacehoublon');
const fs = require('fs');
const path = require('path');

/** Parse args: supporte flags (--producer=, --product=, --save) et positionnels ("Prod" "Beer") */
function parseArgs(argv) {
    let producer = null;
    let product = null;
    let save = false;

    // Flags explicites
    for (const a of argv.slice(2)) {
        if (a.startsWith('--producer=')) {
            producer = a.slice('--producer='.length).trim().replace(/^"|"$/g, '');
        } else if (a.startsWith('--product=')) {
            product = a.slice('--product='.length).trim().replace(/^"|"$/g, '');
        } else if (a === '--save' || a === '--json') {
            save = true;
        }
    }

    // Positionnel (si pas de flags)
    const positional = argv.slice(2).filter(a => !a.startsWith('--'));
    if (positional.length === 1 && !product && !producer) {
        product = positional[0].trim();
    } else if (positional.length >= 2 && !product && !producer) {
        producer = positional[0].trim();
        product = positional.slice(1).join(' ').trim();
    }

    // Nettoyage
    if (producer === '') producer = null;
    if (product === '') product = null;

    return { producer, product, save };
}

/**
 * analyzeBeers(producer, product)
 * - Utilise la nouvelle API v2 avec scoring 2-phases
 * - Passe producer et product séparément pour un meilleur matching
 * - Retourne les données brutes des quatre sources
 *
 * @param {string|null} producer
 * @param {string|null} product
 * @returns {Promise<{ input:{producer:string|null,product:string|null}, combined:string, vtub:any, masoif:any, espacehoublon:any, untappd:any }>}
 */
async function analyzeBeers(producer, product) {
    if (!producer && !product) {
        throw new Error('analyzeBeers(producer, product) requiert au moins un des deux paramètres.');
    }

    const combined = producer && product ? `${producer} ${product}` : (product || producer);

    // Appels en parallèle avec producer et product séparés - 4 sources
    const [untappdData, vtubData, masoifData, espacehoublonData] = await Promise.all([
        getUntappdData(producer, product),
        fetchFromVeuxTuUneBiere(producer, product),
        fetchFromMasoif(producer, product),
        fetchFromEspaceHoublon(producer, product),
    ]);

    return {
        input: { producer: producer || null, product: product || null },
        combined,
        vtub: vtubData || null,
        masoif: masoifData || null,
        espacehoublon: espacehoublonData || null,
        untappd: untappdData || null,
    };
}

/**
 * Génère un nom de fichier pour la sauvegarde JSON
 * @param {string|null} producer
 * @param {string|null} product
 * @returns {string}
 */
function generateFilename(producer, product) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // 2025-01-15T14-30-45

    // Créer un slug du nom
    const slug = (producer && product)
        ? `${producer}-${product}`
        : (product || producer || 'query');

    const cleanSlug = slug
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Enlever accents
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50); // Limiter la longueur

    return `${timestamp}_${cleanSlug}.json`;
}

/**
 * Sauvegarde les résultats dans un fichier JSON
 * @param {object} result
 * @param {string|null} producer
 * @param {string|null} product
 * @returns {string} Le chemin du fichier sauvegardé
 */
function saveResults(result, producer, product) {
    const resultsDir = path.join(__dirname, 'results');

    // Créer le dossier results/ s'il n'existe pas
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
    }

    const filename = generateFilename(producer, product);
    const filepath = path.join(resultsDir, filename);

    // Ajouter metadata
    const output = {
        timestamp: new Date().toISOString(),
        query: {
            producer: producer || null,
            product: product || null,
            combined: result.combined,
        },
        results: {
            veuxtuunebiere: result.vtub || null,
            masoif: result.masoif || null,
            espacehoublon: result.espacehoublon || null,
            untappd: result.untappd || null,
        },
        summary: {
            sources_found: [
                result.vtub ? 'veuxtuunebiere' : null,
                result.masoif ? 'masoif' : null,
                result.espacehoublon ? 'espacehoublon' : null,
                result.untappd ? 'untappd' : null,
            ].filter(Boolean),
            total_sources: [result.vtub, result.masoif, result.espacehoublon, result.untappd].filter(Boolean).length,
        }
    };

    fs.writeFileSync(filepath, JSON.stringify(output, null, 2), 'utf-8');

    return filepath;
}

// === Export pour usage depuis un autre fichier ===
module.exports = { analyzeBeers, parseArgs, saveResults };

// === Mode CLI pour tests rapides ===
if (require.main === module) {
    (async () => {
        const { producer, product, save } = parseArgs(process.argv);

        if (!producer && !product) {
            console.log('Usage:');
            console.log('  node analyze_beers.js --producer="Menaud" --product="SMASH"');
            console.log('  node analyze_beers.js "Menaud" "SMASH"');
            console.log('  node analyze_beers.js --product="SMASH"');
            console.log('  node analyze_beers.js --producer="Menaud" --product="SMASH" --save');
            console.log('');
            console.log('Options:');
            console.log('  --save, --json    Sauvegarder les résultats dans results/');
            process.exit(1);
        }

        const combined = producer && product ? `${producer} ${product}` : (product || producer);

        console.log('🔎 Requête combinée:', JSON.stringify(combined));
        if (product && producer) console.log('  • Producer =', JSON.stringify(producer));
        if (product) console.log('  • Product  =', JSON.stringify(product));
        if (save) console.log('  • Sauvegarde: activée');

        try {
            const result = await analyzeBeers(producer, product);

            console.log('\n--- Veux-tu une bière ---');
            console.log(result.vtub);

            console.log('\n--- Masoif ---');
            console.log(result.masoif);

            console.log('\n--- EspaceHoublon ---');
            console.log(result.espacehoublon);

            console.log('\n--- Untappd ---');
            console.log(result.untappd);

            // Sauvegarder si demandé
            if (save) {
                const filepath = saveResults(result, producer, product);
                console.log('\n💾 Résultats sauvegardés:', filepath);
            }

            process.exit(0);
        } catch (error) {
            console.error('\n❌ Erreur:', error.message || error);
            process.exit(1);
        }
    })();
}