// beer_ai.js (CommonJS)
// Usage: node beer_ai.js
//        node beer_ai.js --limit=10
//        node beer_ai.js --json  (sortie JSON sur stdout)
//        node beer_ai.js --save  (sauvegarder dans results/)

require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');
const { analyzeBeers } = require('./analyze_beers');
const fs = require('fs');
const path = require('path');

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
        else if (a === '--save') args.save = true;
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
function compareData(beer, vtub, masoif, espacehoublon, untappd) {
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
            masoif: masoif ? '✓' : '✗',
            espacehoublon: espacehoublon ? '✓' : '✗',
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
        masoif_data: masoif ? {
            beer_name: masoif.beer_name,
            brewery: masoif.brewery_name,
            abv: masoif.abv,
            style: masoif.style,
            ibu: masoif.ibu,
            format: masoif.format,
            description: masoif.description ? `${masoif.description.substring(0, 80)}...` : null,
            image: masoif.image_url ? '✓' : '✗',
        } : null,
        espacehoublon_data: espacehoublon ? {
            beer_name: espacehoublon.beer_name,
            brewery: espacehoublon.brewery_name,
            abv: espacehoublon.abv,
            style: espacehoublon.style,
            ibu: espacehoublon.ibu,
            format: espacehoublon.format,
            description: espacehoublon.description ? `${espacehoublon.description.substring(0, 80)}...` : null,
            image: espacehoublon.image_url ? '✓' : '✗',
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
        quality_score: calculateQualityScore(vtub, masoif, espacehoublon, untappd),
    };

    return comparison;
}

// Score de qualité (0-100)
function calculateQualityScore(vtub, masoif, espacehoublon, untappd) {
    let score = 0;

    // Trouvé sur au moins une source: +20
    if (vtub || masoif || espacehoublon || untappd) score += 20;

    // Trouvé sur 2 sources: +10
    const foundCount = [vtub, masoif, espacehoublon, untappd].filter(Boolean).length;
    if (foundCount === 2) score += 10;

    // Trouvé sur 3 sources: +15
    if (foundCount === 3) score += 15;

    // Trouvé sur les 4 sources: +25
    if (foundCount === 4) score += 25;

    // ABV trouvé: +15
    if (vtub?.abv || masoif?.abv || espacehoublon?.abv || untappd?.beer_abv) score += 15;

    // IBU trouvé: +10
    if (masoif?.ibu || espacehoublon?.ibu || untappd?.beer_ibu) score += 10;

    // Rating trouvé: +10
    if (untappd?.rating_score) score += 10;

    // Description trouvée: +10
    if (vtub?.description || masoif?.description || espacehoublon?.description || untappd?.description) score += 10;

    // Image trouvée: +5
    if (vtub?.image_url || masoif?.image_url || espacehoublon?.image_url || untappd?.image_url) score += 5;

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
    console.log(`   VTUB: ${comp.found.vtub} | Masoif: ${comp.found.masoif} | EspaceHoublon: ${comp.found.espacehoublon} | Untappd: ${comp.found.untappd}`);
    console.log(`   Score qualité: ${comp.quality_score}/100`);

    if (comp.vtub_data) {
        console.log('\n📦 VEUX-TU-UNE-BIÈRE:');
        console.log(`   Nom: ${comp.vtub_data.beer_name}`);
        console.log(`   Brasserie: ${comp.vtub_data.brewery || 'N/A'}`);
        console.log(`   ABV: ${comp.vtub_data.abv || 'N/A'} | Style: ${comp.vtub_data.style || 'N/A'}`);
        console.log(`   Description: ${comp.vtub_data.description || 'N/A'}`);
        console.log(`   Image: ${comp.vtub_data.image}`);
    }

    if (comp.masoif_data) {
        console.log('\n🍷 MASOIF:');
        console.log(`   Nom: ${comp.masoif_data.beer_name}`);
        console.log(`   Brasserie: ${comp.masoif_data.brewery || 'N/A'}`);
        console.log(`   ABV: ${comp.masoif_data.abv || 'N/A'} | IBU: ${comp.masoif_data.ibu || 'N/A'} | Style: ${comp.masoif_data.style || 'N/A'}`);
        console.log(`   Format: ${comp.masoif_data.format || 'N/A'}`);
        console.log(`   Description: ${comp.masoif_data.description || 'N/A'}`);
        console.log(`   Image: ${comp.masoif_data.image}`);
    }

    if (comp.espacehoublon_data) {
        console.log('\n🥃 ESPACEHOUBLON:');
        console.log(`   Nom: ${comp.espacehoublon_data.beer_name}`);
        console.log(`   Brasserie: ${comp.espacehoublon_data.brewery || 'N/A'}`);
        console.log(`   ABV: ${comp.espacehoublon_data.abv || 'N/A'} | IBU: ${comp.espacehoublon_data.ibu || 'N/A'} | Style: ${comp.espacehoublon_data.style || 'N/A'}`);
        console.log(`   Format: ${comp.espacehoublon_data.format || 'N/A'}`);
        console.log(`   Description: ${comp.espacehoublon_data.description || 'N/A'}`);
        console.log(`   Image: ${comp.espacehoublon_data.image}`);
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

    if (!comp.vtub_data && !comp.masoif_data && !comp.espacehoublon_data && !comp.untappd_data) {
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
        masoif_found: 0,
        espacehoublon_found: 0,
        untappd_found: 0,
        all_found: 0,
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
            const { vtub, masoif, espacehoublon, untappd } = await analyzeBeers(producer, product);

            // Comparer
            const comparison = compareData(beer, vtub, masoif, espacehoublon, untappd);
            results.push(comparison);

            // Stats
            if (vtub) stats.vtub_found++;
            if (masoif) stats.masoif_found++;
            if (espacehoublon) stats.espacehoublon_found++;
            if (untappd) stats.untappd_found++;
            if (vtub && masoif && espacehoublon && untappd) stats.all_found++;
            if (!vtub && !masoif && !espacehoublon && !untappd) stats.none_found++;
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

    // Sortie JSON sur stdout
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
    console.log(`Masoif trouvé: ${stats.masoif_found} (${Math.round(stats.masoif_found / stats.total * 100)}%)`);
    console.log(`EspaceHoublon trouvé: ${stats.espacehoublon_found} (${Math.round(stats.espacehoublon_found / stats.total * 100)}%)`);
    console.log(`Untappd trouvé: ${stats.untappd_found} (${Math.round(stats.untappd_found / stats.total * 100)}%)`);
    console.log(`Les 4 trouvés: ${stats.all_found} (${Math.round(stats.all_found / stats.total * 100)}%)`);
    console.log(`Aucun trouvé: ${stats.none_found} (${Math.round(stats.none_found / stats.total * 100)}%)`);
    console.log(`Score qualité moyen: ${Math.round(stats.total_quality / stats.total)}/100`);
    console.log('='.repeat(80));

    // Sauvegarder si demandé
    if (args.save) {
        const resultsDir = path.join(__dirname, 'results');
        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `${timestamp}_beer-ai-batch_${stats.total}-beers.json`;
        const filepath = path.join(resultsDir, filename);

        const output = {
            timestamp: new Date().toISOString(),
            batch_info: {
                total_beers: stats.total,
                limit: args.limit || 50,
            },
            statistics: {
                vtub_found: stats.vtub_found,
                masoif_found: stats.masoif_found,
                espacehoublon_found: stats.espacehoublon_found,
                untappd_found: stats.untappd_found,
                all_sources_found: stats.all_found,
                no_sources_found: stats.none_found,
                average_quality_score: Math.round(stats.total_quality / stats.total),
            },
            results: results,
        };

        fs.writeFileSync(filepath, JSON.stringify(output, null, 2), 'utf-8');
        console.log(`\n💾 Résultats sauvegardés: ${filepath}`);
    }
}

main()
    .catch((err) => {
        console.error('❌ Erreur fatale:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
