const { default: axios } = require("axios");
const { ObjectId } = require("mongodb");

function getErrorResponse(error) {
    console.log("Handling error response: ", error);
    
    const baseResponse = {
        version: "1.0",
        status: "whatsapp_rejected",
        statusCode: 2019,
        message: error.message || "The message format is invalid",
        timestamp: error.timestamp || new Date().toISOString(),
        messageId: error.messageId || null
    };
    
    switch (error.code) {
        case "TEMPLATE_NOT_FOUND":
            return {
                ...baseResponse,
                statusCode: 2023,
                // message: "Template did not match"
            };
        case "INSUFFICIENT_BALANCE":
            return {
                ...baseResponse,
                statusCode: 2000,
                message: "Insufficient credit balance"
            };
        case "UNAUTHORIZED":
            return {
                ...baseResponse,
                statusCode: 2005,
                message: "Authorization failure - User not found"
            };
        case "INTERNAL_ERROR":
        default:
            return baseResponse;
    }
}


async function notifyWebengageError(item, error, dbConnection) {
    try {
        const db = dbConnection.db(
            item.under === "super_admin"
                ? process.env.SUPER_ADMIN_DB
                : item.under + process.env.RESELLER_DB
        );

        const userData = await db.collection("users").findOne({
            _id: ObjectId.createFromHexString(item.id)
        });

        if (!userData) {
            console.error('User not found for error notification');
            return;
        }

        const webEngageEndpoint = userData?.webEngageConfig?.endpoint || process.env.WEBENGAGE_RESPONSE_ENDPOINT;
        const authToken = userData?.webEngageConfig?.authToken;

        if (!webEngageEndpoint) {
            console.error('WebEngage endpoint not configured');
            return;
        }

        const responseToSent = getErrorResponse(error);

        await axios.post(webEngageEndpoint, responseToSent, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            }
        });
    } catch (err) {
        console.error('Failed to notify WebEngage about error:', err);
    }
}

async function processDbUpdates(updates, dbConnection, WORKER_ID) {
    try {
        const batchStartTime = Date.now();

        const parsedUpdates = updates.map(update => {
            const obj = update; // Already parsed when added to queue
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

        console.log(`${WORKER_ID} processed ${parsedUpdates.length} DB updates in ${Date.now() - batchStartTime}ms`);
    } catch (err) {
        console.error("DB update processing failed:", err);
    }
}

module.exports = {
    notifyWebengageError,
    processDbUpdates
}