/**
 * Global Request Queue Manager
 *
 * Prevents rate limiting by controlling concurrent requests globally
 * across all workers and scrapers.
 *
 * Features:
 * - Limits concurrent DuckDuckGo requests (max 2-3 at a time)
 * - Adds delays between requests
 * - Shared Puppeteer browser instance
 * - Automatic retry with exponential backoff
 */

const EventEmitter = require('events');

class RequestQueue extends EventEmitter {
    constructor(options = {}) {
        super();

        this.maxConcurrent = options.maxConcurrent || 2; // Max 2 concurrent DDG requests
        this.minDelay = options.minDelay || 1000; // 1s minimum between requests
        this.maxDelay = options.maxDelay || 2000; // 2s maximum delay

        this.queue = [];
        this.running = 0;
        this.lastRequestTime = 0;

        this.stats = {
            total: 0,
            completed: 0,
            failed: 0,
            queued: 0,
            avgWaitTime: 0
        };
    }

    /**
     * Add a request to the queue
     * @param {Function} requestFn - Async function that performs the request
     * @param {Object} options - Request options (priority, timeout, etc.)
     * @returns {Promise} - Resolves with request result
     */
    async enqueue(requestFn, options = {}) {
        const {
            priority = 0,
            timeout = 60000,
            retries = 2,
            label = 'Request'
        } = options;

        return new Promise((resolve, reject) => {
            const task = {
                fn: requestFn,
                resolve,
                reject,
                priority,
                timeout,
                retries,
                label,
                enqueuedAt: Date.now(),
                attempts: 0
            };

            // Insert by priority (higher priority first)
            const insertIndex = this.queue.findIndex(t => t.priority < priority);
            if (insertIndex === -1) {
                this.queue.push(task);
            } else {
                this.queue.splice(insertIndex, 0, task);
            }

            this.stats.total++;
            this.stats.queued = this.queue.length;

            this.emit('enqueued', { label, queueLength: this.queue.length });
            this.processQueue();
        });
    }

    async processQueue() {
        // Don't exceed max concurrent requests
        if (this.running >= this.maxConcurrent) {
            return;
        }

        // No tasks to process
        if (this.queue.length === 0) {
            return;
        }

        // Enforce delay between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        const requiredDelay = this.minDelay + Math.random() * (this.maxDelay - this.minDelay);

        if (timeSinceLastRequest < requiredDelay && this.lastRequestTime > 0) {
            const waitTime = requiredDelay - timeSinceLastRequest;
            setTimeout(() => this.processQueue(), waitTime);
            return;
        }

        // Get next task
        const task = this.queue.shift();
        if (!task) return;

        this.stats.queued = this.queue.length;
        this.running++;
        this.lastRequestTime = Date.now();

        const waitTime = this.lastRequestTime - task.enqueuedAt;
        this.stats.avgWaitTime = (this.stats.avgWaitTime * this.stats.completed + waitTime) / (this.stats.completed + 1);

        this.emit('processing', {
            label: task.label,
            running: this.running,
            queued: this.queue.length,
            waitTime
        });

        try {
            // Execute with timeout
            const result = await this.executeWithTimeout(task);

            this.stats.completed++;
            task.resolve(result);

            this.emit('completed', {
                label: task.label,
                success: true
            });
        } catch (error) {
            // Retry logic
            if (task.attempts < task.retries) {
                task.attempts++;

                this.emit('retry', {
                    label: task.label,
                    attempt: task.attempts,
                    maxRetries: task.retries,
                    error: error.message
                });

                // Re-enqueue with exponential backoff
                const backoffDelay = Math.min(5000, 1000 * Math.pow(2, task.attempts - 1));
                setTimeout(() => {
                    this.queue.unshift(task); // Add to front of queue
                    this.processQueue();
                }, backoffDelay);
            } else {
                this.stats.failed++;
                task.reject(error);

                this.emit('failed', {
                    label: task.label,
                    error: error.message
                });
            }
        } finally {
            this.running--;

            // Process next task
            setImmediate(() => this.processQueue());
        }
    }

    async executeWithTimeout(task) {
        return new Promise(async (resolve, reject) => {
            const timeoutId = setTimeout(() => {
                reject(new Error(`Request timeout after ${task.timeout}ms: ${task.label}`));
            }, task.timeout);

            try {
                const result = await task.fn();
                clearTimeout(timeoutId);
                resolve(result);
            } catch (error) {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    }

    getStats() {
        return {
            ...this.stats,
            running: this.running,
            queued: this.queue.length
        };
    }

    clear() {
        this.queue = [];
        this.stats.queued = 0;
    }
}

// Global singleton instance for DuckDuckGo requests
const duckDuckGoQueue = new RequestQueue({
    maxConcurrent: 2,  // Only 2 concurrent DDG requests at a time
    minDelay: 1500,    // 1.5s minimum between requests
    maxDelay: 2500     // 2.5s maximum delay
});

// Shared Puppeteer browser instance
let sharedBrowser = null;
let browserRefCount = 0;

async function getSharedBrowser() {
    if (sharedBrowser) {
        browserRefCount++;
        return sharedBrowser;
    }

    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

    puppeteer.use(StealthPlugin());
    puppeteer.use(AnonymizeUAPlugin({ stripHeadless: true, makeWindows: true }));

    const HEADLESS = process.env.HEADLESS !== 'false';

    sharedBrowser = await puppeteer.launch({
        headless: HEADLESS ? 'new' : false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,800',
        ],
        defaultViewport: { width: 1280, height: 800 },
    });

    browserRefCount = 1;

    // Handle browser crashes
    sharedBrowser.on('disconnected', () => {
        console.log('⚠️  Shared browser disconnected');
        sharedBrowser = null;
        browserRefCount = 0;
    });

    return sharedBrowser;
}

async function releaseSharedBrowser() {
    browserRefCount--;

    // Don't close browser if still in use
    if (browserRefCount > 0) {
        return;
    }

    if (sharedBrowser) {
        try {
            await sharedBrowser.close();
        } catch (err) {
            // Ignore close errors
        }
        sharedBrowser = null;
    }
}

// Log queue stats periodically in development
if (process.env.DEBUG_QUEUE === 'true') {
    setInterval(() => {
        const stats = duckDuckGoQueue.getStats();
        if (stats.total > 0) {
            console.log('\n📊 DuckDuckGo Queue Stats:', {
                running: stats.running,
                queued: stats.queued,
                completed: stats.completed,
                failed: stats.failed,
                avgWaitTime: `${Math.round(stats.avgWaitTime)}ms`
            });
        }
    }, 10000); // Every 10 seconds
}

module.exports = {
    RequestQueue,
    duckDuckGoQueue,
    getSharedBrowser,
    releaseSharedBrowser
};
