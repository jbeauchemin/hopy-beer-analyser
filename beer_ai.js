// beer_ai.js (CommonJS)
// Usage: node beer_ai.js
//        node beer_ai.js --limit=10
//        node beer_ai.js --json  (sortie JSON)

require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');
const { analyzeBeers } = require('./analyze_beers');

// Prisma avec conversion Decimal -> number
const prisma = new PrismaClient().$extends({
    result: {
        beer: {
            rating: {
                needs: { rating: true },
                compute: (b) =>
                    Prisma.Decimal?.isDecimal?.(b.rating) ? Number(b.rating.toString()) : b.rating,
            },
            abv: {
                needs: { abv: true },
                compute: (b) =>
                    Prisma.Decimal?.isDecimal?.(b.abv) ? Number(b.abv.toString()) : b.abv,
            },
            ibu: {
                needs: { ibu: true },
                compute: (b) =>
                    Prisma.Decimal?.isDecimal?.(b.ibu) ? Number(b.ibu.toString()) : b.ibu,
            },
        },
    },
});

// Parse CLI args
function parseArgs(argv) {
    const args = {};
    for (const a of argv.slice(2)) {
        if (a === '--json') args.json = true;
        else if (a.startsWith('--limit=')) args.limit = Number(a.split('=')[1]);
    }
    return args;
}

// Récupérer les bières
async function getBeers({ limit }) {
    return prisma.beer.findMany({
        take: limit || 50, // Par défaut 50
        orderBy: { createdAt: 'desc' },
        include: {
            producer: true,
        },
    });
}

// Comparer les données
function compareData(beer, vtub, untappd) {
    const comparison = {
        beer_id: beer.id,
        query: {
            producer: beer.producer?.name || null,
            product: beer.productName,
        },
        current_db: {
            abv: beer.abv,
            ibu: beer.ibu,
            rating: beer.rating,
            description: beer.description ? '✓' : '✗',
            imageUrl: beer.imageUrl ? '✓' : '✗',
        },
        found: {
            vtub: vtub ? '✓' : '✗',
            untappd: untappd ? '✓' : '✗',
        },
        vtub_data: vtub ? {
            beer_name: vtub.beer_name,
            brewery: vtub.brewery_name,
            abv: vtub.abv,
            style: vtub.style,
            description: vtub.description ? `${vtub.description.substring(0, 80)}...` : null,
            image: vtub.image_url ? '✓' : '✗',
        } : null,
        untappd_data: untappd ? {
            beer_name: untappd.beer_name,
            brewery: untappd.brewery_name,
            abv: untappd.beer_abv,
            ibu: untappd.beer_ibu,
            rating: untappd.rating_score,
            num_ratings: untappd.rating_count,
            description: untappd.description ? `${untappd.description.substring(0, 80)}...` : null,
            image: untappd.image_url ? '✓' : '✗',
        } : null,
        quality_score: calculateQualityScore(vtub, untappd),
    };

    return comparison;
}

// Score de qualité (0-100)
function calculateQualityScore(vtub, untappd) {
    let score = 0;

    // Trouvé sur au moins une source: +30
    if (vtub || untappd) score += 30;

    // Trouvé sur les deux: +20
    if (vtub && untappd) score += 20;

    // ABV trouvé: +15
    if (vtub?.abv || untappd?.beer_abv) score += 15;

    // IBU trouvé: +10
    if (untappd?.beer_ibu) score += 10;

    // Rating trouvé: +10
    if (untappd?.rating_score) score += 10;

    // Description trouvée: +10
    if (vtub?.description || untappd?.description) score += 10;

    // Image trouvée: +5
    if (vtub?.image_url || untappd?.image_url) score += 5;

    return score;
}

// Affichage console lisible
function printComparison(comp) {
    console.log('\n' + '='.repeat(80));
    console.log(`🍺 [${comp.beer_id}] ${comp.query.producer || ''} ${comp.query.product}`.trim());
    console.log('='.repeat(80));

    console.log('\n📊 BASE DE DONNÉES:');
    console.log(`   ABV: ${comp.current_db.abv || 'N/A'} | IBU: ${comp.current_db.ibu || 'N/A'} | Rating: ${comp.current_db.rating || 'N/A'}`);
    console.log(`   Description: ${comp.current_db.description} | Image: ${comp.current_db.imageUrl}`);

    console.log('\n🔍 RECHERCHE:');
    console.log(`   VTUB: ${comp.found.vtub} | Untappd: ${comp.found.untappd}`);
    console.log(`   Score qualité: ${comp.quality_score}/100`);

    if (comp.vtub_data) {
        console.log('\n📦 VEUX-TU-UNE-BIÈRE:');
        console.log(`   Nom: ${comp.vtub_data.beer_name}`);
        console.log(`   Brasserie: ${comp.vtub_data.brewery || 'N/A'}`);
        console.log(`   ABV: ${comp.vtub_data.abv || 'N/A'} | Style: ${comp.vtub_data.style || 'N/A'}`);
        console.log(`   Description: ${comp.vtub_data.description || 'N/A'}`);
        console.log(`   Image: ${comp.vtub_data.image}`);
    }

    if (comp.untappd_data) {
        console.log('\n🍻 UNTAPPD:');
        console.log(`   Nom: ${comp.untappd_data.beer_name}`);
        console.log(`   Brasserie: ${comp.untappd_data.brewery || 'N/A'}`);
        console.log(`   ABV: ${comp.untappd_data.abv || 'N/A'} | IBU: ${comp.untappd_data.ibu || 'N/A'}`);
        console.log(`   Rating: ${comp.untappd_data.rating || 'N/A'} (${comp.untappd_data.num_ratings || 0} ratings)`);
        console.log(`   Description: ${comp.untappd_data.description || 'N/A'}`);
        console.log(`   Image: ${comp.untappd_data.image}`);
    }

    if (!comp.vtub_data && !comp.untappd_data) {
        console.log('\n❌ AUCUNE DONNÉE TROUVÉE');
    }
}

// Main
async function main() {
    const args = parseArgs(process.argv);

    console.log('🍺 Test de qualité du bot de recherche');
    console.log(`📊 Limite: ${args.limit || 50} bières\n`);

    // Récupérer les bières
    const beers = await getBeers({ limit: args.limit });
    console.log(`📋 ${beers.length} bières à tester\n`);

    const results = [];
    const stats = {
        total: beers.length,
        vtub_found: 0,
        untappd_found: 0,
        both_found: 0,
        none_found: 0,
        total_quality: 0,
    };

    // Traiter chaque bière
    for (let i = 0; i < beers.length; i++) {
        const beer = beers[i];
        const producer = beer.producer?.name || null;
        const product = beer.productName;

        try {
            // Recherche
            const { vtub, untappd } = await analyzeBeers(producer, product);

            // Comparer
            const comparison = compareData(beer, vtub, untappd);
            results.push(comparison);

            // Stats
            if (vtub) stats.vtub_found++;
            if (untappd) stats.untappd_found++;
            if (vtub && untappd) stats.both_found++;
            if (!vtub && !untappd) stats.none_found++;
            stats.total_quality += comparison.quality_score;

            // Afficher
            if (!args.json) {
                printComparison(comparison);
            }

            // Délai entre requêtes
            if (i < beers.length - 1) {
                const delay = 2000 + Math.random() * 1000;
                if (!args.json) {
                    console.log(`\n⏱️  Attente ${Math.round(delay / 1000)}s...\n`);
                }
                await new Promise(r => setTimeout(r, delay));
            }
        } catch (err) {
            console.error(`❌ Erreur pour ${product}:`, err.message);
            results.push({
                beer_id: beer.id,
                query: { producer, product },
                error: err.message,
                quality_score: 0,
            });
        }
    }

    // Sortie JSON
    if (args.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
    }

    // Stats finales
    console.log('\n' + '='.repeat(80));
    console.log('📊 STATISTIQUES GLOBALES');
    console.log('='.repeat(80));
    console.log(`Total bières testées: ${stats.total}`);
    console.log(`VTUB trouvé: ${stats.vtub_found} (${Math.round(stats.vtub_found / stats.total * 100)}%)`);
    console.log(`Untappd trouvé: ${stats.untappd_found} (${Math.round(stats.untappd_found / stats.total * 100)}%)`);
    console.log(`Les deux trouvés: ${stats.both_found} (${Math.round(stats.both_found / stats.total * 100)}%)`);
    console.log(`Aucun trouvé: ${stats.none_found} (${Math.round(stats.none_found / stats.total * 100)}%)`);
    console.log(`Score qualité moyen: ${Math.round(stats.total_quality / stats.total)}/100`);
    console.log('='.repeat(80));
}

main()
    .catch((err) => {
        console.error('❌ Erreur fatale:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
