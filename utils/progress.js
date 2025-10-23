/**
 * Clean Progress Display for Batch Processing
 *
 * Shows:
 * - Progress bar with percentage
 * - Beers being processed
 * - Time elapsed and estimated remaining
 * - Processing speed
 */

const readline = require('readline');

class ProgressBar {
    constructor(total, options = {}) {
        this.total = total;
        this.completed = 0;
        this.failed = 0;
        this.startTime = Date.now();
        this.lastUpdateTime = Date.now();

        this.workers = options.workers || 1;
        this.currentBeers = new Map(); // workerId -> beer name

        this.updateInterval = options.updateInterval || 100; // Update every 100ms max

        // For terminal clearing
        this.lastLineCount = 0;
    }

    start() {
        this.startTime = Date.now();
        this.render();
    }

    updateWorker(workerId, beerName) {
        if (beerName) {
            this.currentBeers.set(workerId, beerName);
        } else {
            this.currentBeers.delete(workerId);
        }
        this.render();
    }

    increment(success = true) {
        if (success) {
            this.completed++;
        } else {
            this.failed++;
        }
        this.render();
    }

    render() {
        // Throttle updates
        const now = Date.now();
        if (now - this.lastUpdateTime < this.updateInterval && this.completed < this.total) {
            return;
        }
        this.lastUpdateTime = now;

        // Clear previous lines
        if (this.lastLineCount > 0) {
            for (let i = 0; i < this.lastLineCount; i++) {
                readline.moveCursor(process.stdout, 0, -1);
                readline.clearLine(process.stdout, 0);
            }
        }

        const totalProcessed = this.completed + this.failed;
        const percentage = Math.round((totalProcessed / this.total) * 100);

        // Calculate time
        const elapsed = now - this.startTime;
        const elapsedSec = Math.floor(elapsed / 1000);
        const elapsedMin = Math.floor(elapsedSec / 60);
        const elapsedSecRem = elapsedSec % 60;

        // Estimate remaining time
        let remainingStr = 'Calcul...';
        if (totalProcessed > 0) {
            const avgTimePerBeer = elapsed / totalProcessed;
            const remaining = avgTimePerBeer * (this.total - totalProcessed);
            const remainingSec = Math.floor(remaining / 1000);
            const remainingMin = Math.floor(remainingSec / 60);
            const remainingSecRem = remainingSec % 60;
            remainingStr = `${remainingMin}m ${remainingSecRem}s`;
        }

        // Progress bar
        const barLength = 30;
        const filled = Math.round((totalProcessed / this.total) * barLength);
        const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

        // Speed
        const speed = totalProcessed > 0 ? (totalProcessed / (elapsed / 1000)).toFixed(1) : '0.0';

        // Build output
        const lines = [];

        lines.push('');
        lines.push(`🍺 Analyse de Bières - ${this.workers} worker${this.workers > 1 ? 's' : ''}`);
        lines.push(`${'─'.repeat(60)}`);
        lines.push(`[${bar}] ${percentage}%`);
        lines.push(`Complétées: ${this.completed}/${this.total}  Échecs: ${this.failed}`);
        lines.push(`Temps: ${elapsedMin}m ${elapsedSecRem}s  Restant: ${remainingStr}  Vitesse: ${speed} bières/s`);

        if (this.currentBeers.size > 0) {
            lines.push('');
            lines.push('En cours de traitement:');
            const sortedWorkers = Array.from(this.currentBeers.entries()).sort((a, b) => a[0] - b[0]);
            sortedWorkers.forEach(([workerId, beerName]) => {
                const truncated = beerName.length > 50 ? beerName.substring(0, 47) + '...' : beerName;
                lines.push(`  Worker ${workerId}: ${truncated}`);
            });
        }

        lines.push('');

        // Print all lines
        console.log(lines.join('\n'));
        this.lastLineCount = lines.length;
    }

    finish() {
        // Final render
        this.render();

        const elapsed = Date.now() - this.startTime;
        const elapsedSec = Math.floor(elapsed / 1000);
        const elapsedMin = Math.floor(elapsedSec / 60);
        const elapsedSecRem = elapsedSec % 60;

        console.log(`✅ Terminé en ${elapsedMin}m ${elapsedSecRem}s\n`);
    }
}

// Global quiet mode flag
let quietMode = false;

function setQuietMode(quiet) {
    quietMode = quiet;
    // Set environment variable so scrapers can check it
    if (quiet) {
        process.env.QUIET_MODE = 'true';
    } else {
        delete process.env.QUIET_MODE;
    }
}

function isQuietMode() {
    return quietMode || process.env.QUIET_MODE === 'true';
}

/**
 * Conditional console.log - only logs if NOT in quiet mode
 */
function quietLog(...args) {
    if (!isQuietMode()) {
        console.log(...args);
    }
}

/**
 * Conditional console.error - always logs (errors are important)
 */
function quietError(...args) {
    console.error(...args);
}

module.exports = {
    ProgressBar,
    setQuietMode,
    isQuietMode,
    quietLog,
    quietError
};
