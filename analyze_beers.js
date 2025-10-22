const { getUntappdData } = require('./scapper/untapped');
const { fetchFromVeuxTuUneBiere } = require('./scapper/veuxtuunebiere');

/** Parse args: supporte flags (--producer=, --product=) et positionnels ("Prod" "Beer") */
function parseArgs(argv) {
    let producer = null;
    let product = null;

    // Flags explicites
    for (const a of argv.slice(2)) {
        if (a.startsWith('--producer=')) {
            producer = a.slice('--producer='.length).trim().replace(/^"|"$/g, '');
        } else if (a.startsWith('--product=')) {
            product = a.slice('--product='.length).trim().replace(/^"|"$/g, '');
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

    return { producer, product };
}

/**
 * analyzeBeers(producer, product)
 * - Fait la recherche avec "producer + product"
 * - Fallback VtUB: si rien avec la requête combinée, réessaie avec product seul (si fourni)
 * - Retourne les bruts pour récolter un max de données (pas de merge ici)
 *
 * @param {string|null} producer
 * @param {string|null} product
 * @returns {Promise<{ input:{producer:string|null,product:string|null}, combined:string, vtub:any, untappd:any }>}
 */
async function analyzeBeers(producer, product) {
    if (!producer && !product) {
        throw new Error('analyzeBeers(producer, product) requiert au moins un des deux paramètres.');
    }

    const combined = producer && product ? `${producer} ${product}` : (product || producer);

    // 1) Appels en parallèle sur la requête combinée
    const [untappdData, vtubCombined] = await Promise.all([
        getUntappdData(producer, product),
        fetchFromVeuxTuUneBiere(combined),
    ]);

    // 2) Fallback VtUB: si rien trouvé avec "producer + product", on essaie "product" seul (si dispo)
    let vtubFinal = vtubCombined;
    if (!vtubFinal && product) {
        vtubFinal = await fetchFromVeuxTuUneBiere(product);
    }

    return {
        input: { producer: producer || null, product: product || null },
        combined,
        vtub: vtubFinal || null,
        untappd: untappdData || null,
    };
}

// === Export pour usage depuis un autre fichier ===
module.exports = { analyzeBeers, parseArgs };

// === Mode CLI pour tests rapides ===
if (require.main === module) {
    (async () => {
        const { producer, product } = parseArgs(process.argv);

        if (!producer && !product) {
            console.log('Usage:');
            console.log('  node analyze_beers.js --producer="Menaud" --product="SMASH"');
            console.log('  node analyze_beers.js "Menaud" "SMASH"');
            console.log('  node analyze_beers.js --product="SMASH"');
            process.exit(1);
        }

        const combined = producer && product ? `${producer} ${product}` : (product || producer);

        console.log('🔎 Requête combinée:', JSON.stringify(combined));
        if (product && producer) console.log('  • Producer =', JSON.stringify(producer));
        if (product) console.log('  • Product  =', JSON.stringify(product));

        try {
            const result = await analyzeBeers(producer, product);

            console.log('\n--- Veux-tu une bière ---');
            console.log(result.vtub);

            console.log('\n--- Untappd ---');
            console.log(result.untappd);

            process.exit(0);
        } catch (error) {
            console.error('\n❌ Erreur:', error.message || error);
            process.exit(1);
        }
    })();
}