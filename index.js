const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { handleWebengage } = require('./integration.webengage');
const { createClient } = require('redis');
const os = require('os');
require('dotenv').config();

const PORT = 3000;
const WORKER_ID = process.env.HOSTNAME || `worker-${os.hostname()}`;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DB_UPDATE_BATCH_SIZE = 50;
const DB_UPDATE_INTERVAL_MS = 1000;
const QUEUE_NAME = `db_updates_${WORKER_ID}`;

const redisClient = createClient({
    url: REDIS_URL,
    socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
    }
});

redisClient.on('error', (err) => {
    console.error('Redis error:', err);
});

redisClient.on('ready', () => {
    console.log('Redis connected for DB updates');
});

async function startServer() {
    try {
        await redisClient.connect();

        const mongoClient = new MongoClient(process.env.MONGO_URL, {
            maxPoolSize: 100,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 60000,
            retryWrites: true,
            retryReads: true,
            serverSelectionTimeoutMS: 5000
        });

        const dbConnection = await mongoClient.connect();
        console.log("DB connected");

        const app = express();

        app.use(express.json({ limit: '100kb' }));
        app.use(express.urlencoded({ extended: true, limit: '100kb' }));

        app.post('/webhook/webengage/:under/:id', async (req, res) => {
            try {
                const { under, id } = req.params;
                const content = {
                    under,
                    id,
                    data: req.body,
                    timestamp: new Date().toISOString()
                };

                const result = await handleWebengage(content, dbConnection);
                console.log("Finished processing handlewebengage!");

                if (result?.error) {
                    console.log("Handling error response!");
                    return handleErrorResponse(res, result.error);
                }

                console.log("pushing db operation into redis queue: ", QUEUE_NAME);
                
                await redisClient.rPush(QUEUE_NAME, JSON.stringify(result.dbOps));
                console.log("Pushed !", QUEUE_NAME);

                if (result?.savedError) {
                    console.log("Saved error found !");
                    return res.status(400).send({
                        status: "whatsapp_rejected",
                        statusCode: 2019,
                        message: "The message format is invalid"
                    });
                }

                return res.status(200).send({
                    status: "whatsapp_accepted",
                    statusCode: 0
                });

            } catch (err) {
                console.error('Webhook processing error:', err);
                res.status(400).send({
                    status: "whatsapp_rejected",
                    statusCode: 2019,
                    message: "The message format is invalid"
                });
            }
        });

        app.get('/health', async (req, res) => {
            try {
                await redisClient.ping();
                res.status(200).json({
                    status: 'healthy',
                    worker: WORKER_ID,
                    redis: 'connected',
                    queue_name: QUEUE_NAME
                });
            } catch (err) {
                res.status(500).json({
                    status: 'unhealthy',
                    worker: WORKER_ID,
                    redis: 'disconnected'
                });
            }
        });

        setInterval(() => processDbUpdates(dbConnection), DB_UPDATE_INTERVAL_MS);

        const server = app.listen(PORT, () => {
            console.log(`🚀 Server (Worker ${WORKER_ID}) listening on port ${PORT}`);
        });

        process.on('SIGTERM', () => gracefulShutdown(server, dbConnection));
        process.on('SIGINT', () => gracefulShutdown(server, dbConnection));

    } catch (err) {
        console.error("🔥 Server startup failed:", err);
        process.exit(1);
    }
}

function handleErrorResponse(res, error) {
    console.log("Handling error response: ", error);

    switch (error.code) {
        case "TEMPLATE_NOT_FOUND":
            return res.status(400).send({
                status: "whatsapp_rejected",
                statusCode: 2023,
                message: "Template did not match"
            });
        case "INSUFFICIENT_BALANCE":
            return res.status(200).send({
                status: "whatsapp_rejected",
                statusCode: 2000,
                message: "Insufficient credit balance"
            });
        case "UNAUTHORIZED":
            return res.status(403).send({
                status: "whatsapp_rejected",
                statusCode: 2005,
                message: "Authorization failure - User not found"
            });
        case "INTERNAL_ERROR":
        default:
            return res.status(400).send({
                status: "whatsapp_rejected",
                statusCode: 2019,
                message: "The message format is invalid"
            });
    }
}

async function processDbUpdates(dbConnection) {
    try {
        const updates = await redisClient.lRange(QUEUE_NAME, 0, DB_UPDATE_BATCH_SIZE - 1);
        if (updates.length === 0) return;
        console.log("Processing db updation from queue: ", QUEUE_NAME);
        
        const batchStartTime = Date.now();

        const parsedUpdates = updates.map(update => {
            const obj = JSON.parse(update);
            if (
                obj?.sessionUpdate?.update?.$set?.lastMessageTime &&
                typeof obj.sessionUpdate.update.$set.lastMessageTime === 'string'
            ) {
                obj.sessionUpdate.update.$set.lastMessageTime = new Date(obj.sessionUpdate.update.$set.lastMessageTime);
            }
            return obj;
        });

        const groupedUpdates = parsedUpdates.reduce((acc, update) => {
            const dbName = update.under === "super_admin"
                ? process.env.SUPER_ADMIN_DB
                : update.under + process.env.RESELLER_DB;

            if (!acc[dbName]) acc[dbName] = {
                sessionUpdates: [],
                liveChatInserts: []
            };

            if (update.sessionUpdate) {
                acc[dbName].sessionUpdates.push({
                    updateOne: {
                        filter: update.sessionUpdate.filter,
                        update: update.sessionUpdate.update,
                        upsert: true
                    }
                });
            }

            if (update.liveChatInsert) {
                acc[dbName].liveChatInserts.push(update.liveChatInsert);
            }

            return acc;
        }, {});

        await Promise.all(
            Object.entries(groupedUpdates).map(async ([dbName, { sessionUpdates, liveChatInserts }]) => {
                const db = dbConnection.db(dbName);
                const collectionPrefix = parsedUpdates[0].id;

                if (sessionUpdates.length > 0) {
                    await db.collection(`${collectionPrefix}${process.env.SESSION_COLLECTION}`)
                        .bulkWrite(sessionUpdates);
                }

                if (liveChatInserts.length > 0) {
                    await db.collection(`${collectionPrefix}${process.env.LIVE_CHAT_COLLECTION}`)
                        .insertMany(liveChatInserts);
                }
            })
        );

        await redisClient.lTrim(QUEUE_NAME, updates.length, -1);
        console.log(`${WORKER_ID} processed ${updates.length} DB updates in ${Date.now() - batchStartTime}ms`);
    } catch (err) {
        console.error("DB update processing failed:", err);
    }
}

async function gracefulShutdown(server, dbConnection) {
    console.log('Received shutdown signal, closing gracefully...');
    try {
        await new Promise(resolve => server.close(resolve));
        await dbConnection.close();
        await redisClient.quit();
        console.log('All connections closed');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
    }
}

startServer();
