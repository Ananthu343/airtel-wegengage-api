const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { handleWebengage } = require('./integration.webengage');
const { createClient } = require('redis');
const os = require('os');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const axios = require('axios');
const { notifyWebengageError, processDbUpdates } = require('./utils');
require('dotenv').config();

const PORT = 3000;
const WORKER_ID = process.env.HOSTNAME || `worker-${os.hostname()}-${process.pid}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DB_UPDATE_BATCH_SIZE = 70;
const DB_UPDATE_INTERVAL_MS = 1000;
const QUEUE_NAME = `webengage_requests`;
const PROCESSING_QUEUE_NAME = `processing_${WORKER_ID}`;

// Initialize Redis client
function createRedisClient() {
    const client = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
        }
    });
    
    client.on('error', (err) => console.error('Redis error:', err));
    client.on('ready', () => console.log('Redis connected'));
    
    return client;
}

// Validation function for incoming requests
function validateWebengageRequest(req) {
    const { id, under } = req.params
    const body = req.body;

    if (!id || !under) {
        return { valid: false, error: 'Required params not found' };
    }

    if (!body) {
        return { valid: false, error: 'Request body is missing' };
    }

    if (!body.whatsAppData || !body.whatsAppData.toNumber) {
        return { valid: false, error: 'Recipient phone number is required' };
    }

    if (!body.whatsAppData.templateData || !body.whatsAppData.templateData.templateName) {
        return { valid: false, error: 'Template name is required' };
    }

    return { valid: true };
}

// Worker function to process queue items
async function processQueueItem(item, dbConnection) {
    try {
        const result = await handleWebengage(item, dbConnection);

        if (result?.error) {
            await notifyWebengageError(item, result.error, dbConnection);
            return { success: true };
        }

        // Process DB updates directly (no longer using separate queue)
        if (result.dbOps) {
            await processDbUpdates([result.dbOps], dbConnection, WORKER_ID);
        }

        // If there was an error during message sending, notify WebEngage
        if (result?.savedError) {
            await notifyWebengageError(item, result.savedError, dbConnection);
        }

        return { success: true };
    } catch (error) {
        console.error('Error processing queue item:', error);
        return { success: false, error };
    }
}

// Worker process function
// Worker process function
async function workerProcess() {
    try {
        const workerRedis = createRedisClient();
        await workerRedis.connect();

        const mongoClient = new MongoClient(process.env.MONGO_URL, {
            maxPoolSize: 50,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 60000,
            retryWrites: true,
            retryReads: true,
            serverSelectionTimeoutMS: 5000
        });

        const dbConnection = await mongoClient.connect();
        console.log(`Worker ${WORKER_ID} connected to DB`);

        // Process batch of items from the queue atomically
        async function processBatch() {
            try {
                const batch = [];
                let item;
                
                // Collect up to 50 items using RPOP
                while (batch.length < DB_UPDATE_BATCH_SIZE) {
                    item = await workerRedis.rPop(QUEUE_NAME);
                    if (!item) break; // Queue is empty
                    batch.push(item);
                }

                if (batch.length === 0) {
                    // Queue is empty, wait before checking again
                    setTimeout(processBatch, 1000);
                    return;
                }

                console.log(`${WORKER_ID} processing batch of ${batch.length} items`);

                // Process items with limited concurrency
                const processingResults = await Promise.allSettled(
                    batch.map(item => {
                        try {
                            const parsedItem = JSON.parse(item);
                            return processQueueItem(parsedItem, dbConnection);
                        } catch (parseErr) {
                            console.error('Error parsing queue item:', parseErr);
                            return { success: false };
                        }
                    })
                );

                // Log batch processing results
                const successes = processingResults.filter(r => r.value?.success).length;
                console.log(`Batch processed - ${successes}/${batch.length} successful`);

                // Process next batch immediately if we got a full batch
                if (batch.length === DB_UPDATE_BATCH_SIZE) {
                    setImmediate(processBatch);
                } else {
                    setTimeout(processBatch, 1000);
                }

            } catch (err) {
                console.error('Error in batch processing:', err);
                setTimeout(processBatch, 5000);
            }
        }

        // Start batch processing
        processBatch();

    } catch (err) {
        console.error("Worker startup failed:", err);
        process.exit(1);
    }
}

// Master process function
async function masterProcess() {
    const masterRedis = createRedisClient();
    await masterRedis.connect();
    
    const app = express();

    app.use(express.json({ limit: '100kb' }));
    app.use(express.urlencoded({ extended: true, limit: '100kb' }));

    app.post('/webhook/webengage/:under/:id', async (req, res) => {
        try {
            
            // Validate request
            const validation = validateWebengageRequest(req);
            if (!validation.valid) {
                return res.status(400).json({
                    status: "whatsapp_rejected",
                    statusCode: 2019,
                    message: validation.error
                });
            }
            
            const { under, id } = req.params;
            // Create queue item
            const content = {
                under,
                id,
                data: req.body,
                timestamp: new Date().toISOString()
            };

            // Add to queue
            await masterRedis.rPush(QUEUE_NAME, JSON.stringify(content));

            // Respond immediately that request was accepted
            return res.status(202).json({
                status: "whatsapp_accepted",
                statusCode: 0,
                message: "Request queued for processing"
            });

        } catch (err) {
            console.error('Webhook processing error:', err);
            res.status(400).json({
                status: "whatsapp_rejected",
                statusCode: 2019,
                message: "The message format is invalid"
            });
        }
    });

    app.get('/health', async (req, res) => {
        try {
            await masterRedis.ping();
            res.status(200).json({
                status: 'healthy',
                workers: numCPUs,
                redis: 'connected'
            });
        } catch (err) {
            res.status(500).json({
                status: 'unhealthy',
                error: err.message
            });
        }
    });

    const server = app.listen(PORT, () => {
        console.log(`🚀 Master server listening on port ${PORT}`);
    });

    process.on('SIGTERM', () => gracefulShutdown(server, masterRedis));
    process.on('SIGINT', () => gracefulShutdown(server, masterRedis));
}

async function gracefulShutdown(server, redisClient) {
    console.log('Received shutdown signal, closing gracefully...');
    try {
        await new Promise(resolve => server.close(resolve));
        await redisClient.quit();
        console.log('All connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

// Start the appropriate process
if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);
    console.log("Number of workers: ", numCPUs);
    
    // Fork workers
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        // Restart worker
        cluster.fork();
    });

    // Start master process
    masterProcess().catch(err => {
        console.error('Master process failed:', err);
        process.exit(1);
    });
} else {
    // Start worker process
    workerProcess().catch(err => {
        console.error('Worker process failed:', err);
        process.exit(1);
    });
}