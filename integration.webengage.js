const { ObjectId } = require("mongodb");
const axios = require('axios');

const simulateMessageSend = async (apiMessage) => {
    return new Promise((resolve, reject) => {
        // Simulate network latency (50-300ms)
        const delay = Math.floor(Math.random() * 250) + 50;

        setTimeout(() => {
            // Simulate 95% success rate
            if (Math.random() > 0.05) {
                resolve({
                    data: {
                        messageRequestId: `sim-${Math.random().toString(36).substring(2, 10)}`,
                        status: "accepted"
                    }
                });
            } else {
                // Simulate 5% failure rate with different error types
                const errors = [
                    { message: "Invalid template", code: 400 },
                    { message: "Recipient blocked", code: 403 },
                    { message: "Service unavailable", code: 503 },
                    { message: "Timeout", code: 504 }
                ];
                const error = errors[Math.floor(Math.random() * errors.length)];
                reject({ response: { data: error } });
            }
        }, delay);
    });
};

function isValidObjectId(id) {
    if (!id) return false;

    if (typeof id === 'string' && id.length === 24) {
        return /^[0-9a-fA-F]{24}$/.test(id) && ObjectId.isValid(id);
    }

    if (id instanceof ObjectId) {
        return true;
    }

    return false;
}

exports.handleWebengage = async function ({ under, id, data }, dbConnection) {
    console.log("Processing handlewebengage");
    const timestamp = data?.metadata?.timestamp;
    const messageId = data?.metadata?.messageId;
    const toNumber = data?.whatsAppData?.toNumber;

    try {
        const db = dbConnection.db(
            under === "super_admin"
                ? process.env.SUPER_ADMIN_DB
                : under + process.env.RESELLER_DB
        );
        const superAdminDb = dbConnection.db(process.env.SUPER_ADMIN_DB);
        const resellerId = under === "super_admin" ? "668f8408d0945a05ce55d861" : under

        if (!isValidObjectId(id)) {
            console.log("Not a valid userId");
            return {
                error: {
                    code: "UNAUTHORIZED",
                    message: "User not found",
                    timestamp,
                    messageId,
                    toNumber
                }
            };
        };
        // Parallelize initial queries
        const [savedTemplate, user, reseller] = await Promise.all([
            db.collection(id + process.env.TEMPLATES_COLLECTION)
                .findOne({ name: data?.whatsAppData?.templateData?.templateName || "" }),
            db.collection("users")
                .findOne({ _id: ObjectId.createFromHexString(id) }),
            superAdminDb.collection("resellers")
                .findOne({ _id: ObjectId.createFromHexString(resellerId) })
        ]);

        if (!user) {
            console.log("User not found");
            return {
                error: {
                    code: "UNAUTHORIZED",
                    message: "User not found",
                    timestamp,
                    messageId,
                    toNumber
                }
            };
        };

        // Validation checks
        if (!savedTemplate) {
            console.log("Template not found");
            return {
                error: {
                    code: "TEMPLATE_NOT_FOUND",
                    message: "Template not found in collection",
                    timestamp,
                    messageId,
                    toNumber
                }
            };
        };


        // Process message
        let apiMessage;
        if (user?.bspModel != "helloAi") {
            apiMessage = buildApiMessage(savedTemplate.templateId, data, user);
        } else {
            apiMessage = buildSendMessage(savedTemplate, data, user);
        }
        const chatMessage = buildChatMessage(savedTemplate, data);
        console.log("chat message converted!");

        if (user?.allowedTemplateTypes) {
            // console.log("yo", savedTemplate, user);

            if (!user?.allowedTemplateTypes.includes(savedTemplate.type?.toLowerCase())) {
                return {
                    savedError: {
                        code: "TEMPLATE_NOT_ALLOWED",
                        message: "Template is not allowed to send",
                        timestamp,
                        messageId,
                        toNumber
                    },
                    dbOps: {
                        under,
                        id,
                        sessionUpdate: {
                            filter: { contactNumber: chatMessage.to },
                            update: {
                                $set: {
                                    sentBy: "system",
                                    lastMessage: chatMessage.template.message,
                                    lastMessageType: chatMessage.template.headerType,
                                    lastMessageTime: new Date(),
                                    isBlocked: false,
                                    intervene: false
                                },
                                $setOnInsert: {
                                    utility: { id: null, expiration: null, cost: 0 },
                                    marketing: { id: null, expiration: null, cost: 0 },
                                    authentication: { id: null, expiration: null, cost: 0 },
                                    service: { id: null, expiration: null, cost: 0 }
                                }
                            }
                        },
                        liveChatInsert: {
                            data: chatMessage,
                            sentBy: "system",
                            messageRequestId: "",
                            messageId: messageId,
                            timestamp: timestamp,
                            wamid: null,
                            status: "failed",
                            error: {
                                title: "Template is not allowed to send!",
                                code: ""
                            },
                            erpType: "webengage",
                            createdAt: new Date()
                        }
                    }
                };
            }
        }

        if (savedTemplate?.status === "PAUSED") {
            console.log("Template is paused");
            return {
                savedError: {
                    code: "TEMPLATE_NOT_FOUND",
                    message: "Template is Paused",
                    timestamp,
                    messageId,
                    toNumber
                },
                dbOps: {
                    under,
                    id,
                    sessionUpdate: {
                        filter: { contactNumber: chatMessage.to },
                        update: {
                            $set: {
                                sentBy: "system",
                                lastMessage: chatMessage.template.message,
                                lastMessageType: chatMessage.template.headerType,
                                lastMessageTime: new Date(),
                                isBlocked: false,
                                intervene: false
                            },
                            $setOnInsert: {
                                utility: { id: null, expiration: null, cost: 0 },
                                marketing: { id: null, expiration: null, cost: 0 },
                                authentication: { id: null, expiration: null, cost: 0 },
                                service: { id: null, expiration: null, cost: 0 }
                            }
                        }
                    },
                    liveChatInsert: {
                        data: chatMessage,
                        sentBy: "system",
                        messageRequestId: "",
                        messageId: messageId,
                        timestamp: timestamp,
                        wamid: null,
                        status: "failed",
                        error: {
                            title: "Template is Paused!",
                            code: ""
                        },
                        erpType: "webengage",
                        createdAt: new Date()
                    }
                }
            };
        };

        const pricing = await db
            .collection(`${id}${process.env.PRICING_COLLECTION}`)
            .findOne({ dial_code: "91" }, {
                projection: { [savedTemplate.type.toLowerCase()]: 1 }
            });

        if (user.balance < pricing[savedTemplate.type.toLowerCase()]) {
            console.log("Insufficient balance!");
            return {
                savedError: {
                    code: "INSUFFICIENT_BALANCE",
                    message: "User has insufficient balance",
                    timestamp,
                    messageId,
                    toNumber
                },
                dbOps: {
                    under,
                    id,
                    sessionUpdate: {
                        filter: { contactNumber: chatMessage.to },
                        update: {
                            $set: {
                                sentBy: "system",
                                lastMessage: chatMessage.template.message,
                                lastMessageType: chatMessage.template.headerType,
                                lastMessageTime: new Date(),
                                isBlocked: false,
                                intervene: false
                            },
                            $setOnInsert: {
                                utility: { id: null, expiration: null, cost: 0 },
                                marketing: { id: null, expiration: null, cost: 0 },
                                authentication: { id: null, expiration: null, cost: 0 },
                                service: { id: null, expiration: null, cost: 0 }
                            }
                        }
                    },
                    liveChatInsert: {
                        data: chatMessage,
                        sentBy: "system",
                        messageRequestId: "",
                        messageId: messageId,
                        timestamp: timestamp,
                        wamid: null,
                        status: "failed",
                        error: {
                            title: "Message failed due to insufficient balance!",
                            code: ""
                        },
                        erpType: "webengage",
                        createdAt: new Date()
                    }
                }
            };
        }



        let messageRequestId, error;
        let apiStartTime, apiEndTime, apiResponseTime;
        try {
            apiStartTime = Date.now();
            let response;
            if (user?.bspModel != "helloAi") {
                response = await axios.post(process.env.SEND_MESSAGE_API, apiMessage, {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Basic ${Buffer.from(`${reseller?.embeddedConfig?.apiUsername || process.env.API_USERNAME}:${reseller?.embeddedConfig?.apiPassword || process.env.API_PASSWORD}`).toString("base64")}`
                    },
                    // timeout: 5000
                });
            } else {
                const token = reseller?.embeddedConfig?.helloAiToken;
                response = await axios.post(process.env.HELLOAI_SEND_MESSAGE_API, apiMessage, {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    // timeout: 5000
                });
            }
            apiEndTime = Date.now();
            apiResponseTime = apiEndTime - apiStartTime;

            messageRequestId = response.data?.messageRequestId || response?.data?.data?.response?.messageId;
            console.log("Message sent successfully, messageRequestId:", messageRequestId);
        } catch (err) {
            apiEndTime = Date.now();
            apiResponseTime = apiEndTime - apiStartTime;
            error = {
                title: err?.response?.data?.message || err?.message || "Message undelivered!",
                code: err?.response?.data?.code || null,
                timestamp,
                messageId
            };
        }

        // let messageRequestId, error;
        // try {
        //     const response = await simulateMessageSend(apiMessage)
        //     messageRequestId = response.data?.messageRequestId;
        // } catch (err) {
        //     error = {
        //         title: err?.response?.data?.message || err?.message || "",
        //         code: err?.response?.data?.code || null,
        //     };
        // }
        console.log("Api processed sucessfully, error:", error, `response time: ${apiResponseTime} ms`);

        return {
            savedError: error,
            messageRequestId,
            dbOps: {
                under,
                id,
                sessionUpdate: {
                    filter: { contactNumber: chatMessage.to },
                    update: {
                        $set: {
                            sentBy: "system",
                            lastMessage: chatMessage.template.message,
                            lastMessageType: chatMessage.template.headerType,
                            lastMessageTime: new Date(),
                            isBlocked: false,
                            intervene: false
                        },
                        $setOnInsert: {
                            utility: { id: null, expiration: null, cost: 0 },
                            marketing: { id: null, expiration: null, cost: 0 },
                            authentication: { id: null, expiration: null, cost: 0 },
                            service: { id: null, expiration: null, cost: 0 }
                        }
                    }
                },
                liveChatInsert: {
                    data: chatMessage,
                    sentBy: "system",
                    messageRequestId,
                    messageId: data?.metadata?.messageId,
                    timestamp: data?.metadata?.timestamp,
                    wamid: "",
                    status: error ? "failed" : "sent",
                    error,
                    erpType: "webengage",
                    createdAt: new Date()
                }
            }
        };

    } catch (err) {
        console.log("Error in handling webengage", err);
        return {
            error: {
                code: "INTERNAL_ERROR",
                message: err.message
            }
        };
    }
};

exports.fetchWhatsAppTemplate = async function ({ under, id, data }, dbConnection) {
    try {
        let url = 'https://iqwhatsapp.airtel.in/gateway/airtel-xchange/whatsapp-content-manager/v1/template';

        const db = dbConnection.db(
            under === "super_admin"
                ? process.env.SUPER_ADMIN_DB
                : under + process.env.RESELLER_DB)

        const superAdminDb = dbConnection.db(process.env.SUPER_ADMIN_DB);
        const resellerId = under === "super_admin" ? "668f8408d0945a05ce55d861" : under

        const [savedTemplate, user, reseller] = await Promise.all([
            db.collection(id + process.env.TEMPLATES_COLLECTION)
                .findOne({ name: data?.whatsAppData?.templateData?.templateName || "" }),
            db.collection("users")
                .findOne({ _id: ObjectId.createFromHexString(id) }),
            superAdminDb.collection("resellers")
                .findOne({ _id: ObjectId.createFromHexString(resellerId) })
        ]);

        let response;
        if (user?.bspModel != "helloAi") {
            const params = {
                customerId: reseller?.embeddedConfig?.customerId || process.env.CUSTOMER_ID,
                subAccountId: reseller?.embeddedConfig?.subAccountId || process.env.SUB_ACCOUNT_ID,
                wabaId: user?.wabaId,
                templateId: savedTemplate?.templateId
            };
            const headers = {
                'Content-Type': 'application/json',
                Authorization: `Basic ${Buffer.from(`${reseller?.embeddedConfig?.apiUsername || process.env.API_USERNAME}:${reseller?.embeddedConfig?.apiPassword || process.env.API_PASSWORD}`).toString("base64")}`
            };
            response = await axios.get(url, {
                params,
                headers
            });
        } else {
            const token = reseller?.embeddedConfig?.helloAiToken;
            headers = {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            }
            url = `${process.env.HELLOAI_TEMPLATE_INFO}/${savedTemplate?.templateId}/${user?.wabaId}`;
            response = await axios.get(url, {
                headers
            });
        }
        const templateData = response?.template
        response = response.data?.template?.status ?? response.data?.data?.details?.lastStatus;

        if (response && response === "INACTIVE") {
            await db.collection(id + process.env.TEMPLATES_COLLECTION)
                .updateOne({ name: data?.whatsAppData?.templateData?.templateName }, { $set: { status: "PAUSED" } })
        } else {
            if (savedTemplate?.status === "PAUSED") {
                await db.collection(id + process.env.TEMPLATES_COLLECTION)
                    .updateOne({ name: data?.whatsAppData?.templateData?.templateName }, { $set: { status: "APPROVED" } })
            }
        }

        // console.log(templateData, savedTemplate, "tempp");
        if (templateData) {
            if (templateData?.category && savedTemplate.type !== templateData?.category) {
                await db
                    .collection(id + process.env.TEMPLATES_COLLECTION)
                    .updateOne({ templateId: savedTemplate.templateId }, { $set: { type: templateData?.category } })

                console.log("updatedd template category");
            }
        }

    } catch (error) {
        console.error('Error fetching WhatsApp template:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Status code:', error.response.status);
        }
    }
}

const buildApiMessage = (templateId, message, user) => {
    const whatsAppData = message.whatsAppData;
    const templateData = whatsAppData.templateData;

    const apiMessage = {
        templateId: templateId || "template_ID",
        to: whatsAppData.toNumber || "recipient_phone_number",
        from: user?.businessWhatsappNumber || whatsAppData?.fromNumber || "business_phone_number",
        message: {
            headerVars: [],
            variables: [],
            payload: [],
            carouselCard: [],
            suffix: [],
        }
    };

    // Handle template variables (body content)
    if (templateData.templateVariables && templateData.templateVariables.length > 0) {
        apiMessage.message.variables = [...templateData.templateVariables];
    }

    // Handle media attachments (IMAGE/VIDEO/DOCUMENT)
    if (templateData.mediaUrl) {
        switch (templateData.type) {
            case 'IMAGE':
                apiMessage.mediaAttachment = {
                    type: "IMAGE",
                    url: templateData.mediaUrl
                };
                break;
            case 'VIDEO':
                apiMessage.mediaAttachment = {
                    type: "VIDEO",
                    url: templateData.mediaUrl
                };
                break;
            case 'DOCUMENT':
                apiMessage.mediaAttachment = {
                    type: "DOCUMENT",
                    url: templateData.mediaUrl,
                    filename: templateData.fileName || templateData.buttonUrlParam || "Document"
                };
                break;
        }
    }

    // Handle button URL parameter if present (for document download/CTA)
    if (templateData.buttonUrlParam) {
        if (templateData.type === 'DOCUMENT' && !templateData.fileName) {
            // For documents, buttonUrlParam might be the filename
            if (!apiMessage.mediaAttachment.filename) {
                apiMessage.mediaAttachment.filename = templateData.buttonUrlParam;
            }
        } else {
            // For other types, add to suffix
            apiMessage.message.suffix.push(templateData.buttonUrlParam);
        }
    }

    if (templateData.type === "CAROUSEL") {
        templateData.carousel.cards.forEach((card, index) => {
            const carouselCard = {
                index: index,
                carouselMediaUrl: card.header?.mediaUrl || "",
                carouselMediaType: card.header?.type?.toUpperCase() || "IMAGE",
                carouselButtons: [],
                carouselBodyVariables: card.placeholders?.map(text => ({ type: "text", text })) || [],
            };

            // Add URL button if buttonUrlParam exists
            if (card.buttonUrlParam) {
                carouselCard.carouselButtons.push({
                    index: "0",
                    type: "URL",
                    payload: card.buttonUrlParam,
                });
            }
            if (card.buttonUrlDynamicParam) {
                carouselCard.carouselButtons.push({
                    index: "1",
                    type: "URL",
                    payload: card.buttonUrlDynamicParam,    
                });
            }

            apiMessage.message.carouselCard.push(carouselCard);
        });

        return apiMessage;
    }

    // Handle authentication template type
    if (templateData.type === 'AUTHENTICATION') {
        if (templateData.templateVariables && templateData.templateVariables.length > 0) {
            apiMessage.message.suffix = [templateData.templateVariables[0]];
        }
    }

    return apiMessage;
};

const buildSendMessage = (template, message, user) => {
    const whatsAppData = message.whatsAppData;
    const templateData = whatsAppData.templateData;
    const components = [];
    const isAuth = templateData.type === 'AUTHENTICATION';

    if (isAuth) {
        if (templateData.templateVariables && templateData.templateVariables.length > 0) {
            const otp = templateData.templateVariables[0];
            components.push(
                {
                    type: "body",
                    parameters: [
                        {
                            type: "text",
                            text: otp,
                        },
                    ],
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    parameters: [
                        {
                            type: "text",
                            text: otp,
                        },
                    ],
                }
            );
        }
    }
    if (!isAuth && templateData) {

        if (templateData.mediaUrl) {
            switch (templateData.type) {
                case 'TEXT':
                    components.push({
                        type: "header",
                        parameters: [
                            {
                                type: "text",
                                text: templateData.mediaUrl || "text",
                            },
                        ],
                    });
                    break;
                case 'IMAGE':
                    components.push({
                        type: "header",
                        parameters: [
                            {
                                type: "image",
                                image: { link: templateData.mediaUrl },
                            },
                        ],
                    });
                    break;
                case 'VIDEO':
                    components.push({
                        type: "header",
                        parameters: [
                            {
                                type: "video",
                                video: { link: templateData.mediaUrl },
                            },
                        ],
                    });
                    break;
                case 'DOCUMENT':
                    components.push({
                        type: "header",
                        parameters: [
                            {
                                type: "document",
                                document: {
                                    link: templateData.mediaUrl,
                                    filename: templateData.fileName || templateData.buttonUrlParam || "Document"
                                },
                            },
                        ],
                    });
                    break;
            }
        }
        if (templateData.templateVariables && templateData.templateVariables.length > 0) {
            components.push({
                type: "body",
                parameters: templateData.templateVariables.map(variable => ({
                    type: "text",
                    text: variable,
                })),
            });
        } else {
            components.push({ type: "body" });
        }
        if (templateData.buttonUrlParam) {
            components.push({
                type: "button",
                sub_type: "url",
                index: "0",
                ...(templateData.buttonUrlParam && {
                    parameters: [
                        {
                            type: "text",
                            text: templateData.buttonUrlParam,
                        },
                    ]
                })
            });
        }
        if (templateData.buttonUrlDynamicParam) {
            components.push({
                type: "button",
                sub_type: "url",
                index: "1",
                ...(templateData.buttonUrlDynamicParam && {
                    parameters: [
                        {
                            type: "text",
                            text: templateData.buttonUrlDynamicParam,
                        },
                    ]
                })
            });
        }
        if (templateData.type === "CAROUSEL") {
            components.push({
                type: "carousel",
                cards: templateData.carousel?.cards?.map((card, cardIndex) => ({
                    card_index: cardIndex,
                    components: [
                        card.header && {
                            type: "header",
                            parameters: [{
                                type: card.header.type?.toLowerCase(),
                                [card.header.type?.toLowerCase()]: { link: card.header.mediaUrl }
                            }]
                        },
                        card.placeholders?.length > 0 && {
                            type: "body",
                            parameters: card.placeholders.map(text => ({ type: "text", text }))
                        },
                        card.buttonUrlParam && {
                            type: "button",
                            sub_type: "url",
                            index: 0,
                            parameters: [{ type: "text", text: card.buttonUrlParam }]
                        },
                        card.buttonUrlDynamicParam && {
                            type: "button",
                            sub_type: "url",
                            index: 1,
                            parameters: [{ type: "text", text: card.buttonUrlDynamicParam }]
                        },
                        // {
                        //     type: "button",
                        //     sub_type: "quick_reply",
                        //     index: 0,
                        //     parameters: [
                        //         {
                        //             type: "payload",
                        //             payload: "CAMP-24546"
                        //         }
                        //     ]
                        // }
                    ].filter(Boolean)
                }))
            });
        }
    }

    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: message.whatsAppData.toNumber,
        type: "template",
        from: user.businessWhatsappNumber,
        check_consent: isAuth ? "true" : "false",
        template: {
            name: templateData.templateName,
            category: template.type?.toUpperCase() || "UTILITY",
            language: {
                code: template.language || "en",
            },
            components: components.length > 0 ? components : [{ type: "body" }],
        },
    };

    if (message.campaignId) {
        payload.campaign_name = message.campaignId;
    }
    return payload;
}


const buildChatMessage = (template, message) => {
    const regex = /{{(.*?)}}/;
    const whatsAppData = message.whatsAppData;
    const templateData = whatsAppData.templateData;

    const chatMessage = {
        name: template.name,
        category: template.category,
        message: template.message
    };

    // Handle body variables
    if (templateData.templateVariables && templateData.templateVariables.length > 0) {
        templateData.templateVariables.forEach((variable, index) => {
            chatMessage.message = chatMessage.message.replace(
                regex,
                variable
            );
        });
    }

    // Handle header based on template type
    switch (templateData.type.toLowerCase()) {
        case 'text':
            chatMessage.header = template.header;
            chatMessage.headerType = 'text';
            break;

        case 'image':
            chatMessage.header = templateData.mediaUrl;
            chatMessage.headerType = 'image';
            if (!chatMessage.header) {
                throw new Error("Link to the image file is absent. Please attach a link to the image file.");
            }
            break;

        case 'video':
            chatMessage.header = templateData.mediaUrl;
            chatMessage.headerType = 'video';
            if (!chatMessage.header) {
                throw new Error("Link to the video file is absent. Please attach a link to the video file.");
            }
            break;

        case 'document':
            chatMessage.header = templateData.mediaUrl;
            chatMessage.headerType = 'file';
            if (!chatMessage.header) {
                throw new Error("Link to the document file is absent. Please attach a link to the document file.");
            }
            break;

        default:
            if (template.headerType && template.headerType !== 'none') {
                throw new Error("Invalid header type. Header types must be one of 'text', 'image', 'video', or 'document'.");
            }
    }

    // Handle footer if present in template
    if (template.footer) {
        chatMessage.footer = template.footer;
    }

    // Handle actions/buttons if present in template
    if (template.actions) {
        chatMessage.actions = template.actions;
    }

    // Handle category/type
    if (template.type) {
        chatMessage.category = template.type;
    }

    // Handle carousel if present (would need specific structure in new format)
    if (template.subType === "carousel") {
        // Note: New format would need to include carousel cards structure
        // This is a placeholder - you'll need to adapt based on actual new format structure
        chatMessage.subType = template.subType;
        chatMessage.cards = template.cards || [];

        if (!chatMessage.cards.length) {
            throw new Error("Carousel cards are absent. Please add carousel cards.");
        }
    }

    return {
        to: whatsAppData.toNumber,
        type: "marketing",
        template: chatMessage
    };
};