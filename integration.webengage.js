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
    
    try {
        const db = dbConnection.db(
            under === "super_admin"
                ? process.env.SUPER_ADMIN_DB
                : under + process.env.RESELLER_DB
        );
        if (!isValidObjectId(id)) {      
            console.log("Not a valid userId");
            return {
                error: {
                    code: "UNAUTHORIZED",
                    message: "User not found",
                    timestamp,
                    messageId
                }
            };
        };
        // Parallelize initial queries
        const [savedTemplate, user] = await Promise.all([
            db.collection(id + process.env.TEMPLATES_COLLECTION)
            .findOne({ name: data?.whatsAppData?.templateData?.templateName || "" }),
            db.collection("users")
            .findOne({ _id: ObjectId.createFromHexString(id) })
        ]);
        
        // Validation checks
        if (!savedTemplate) {
            console.log("Template not found");
            return {
                error: {
                    code: "TEMPLATE_NOT_FOUND",
                    message: "Template not found in collection",
                    timestamp,
                    messageId
                }
            };
        };
        if (!user) {
            console.log("User not found");
            return {
                error: {
                    code: "UNAUTHORIZED",
                    message: "User not found",
                    timestamp,
                    messageId
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
                error: {
                    code: "INSUFFICIENT_BALANCE",
                    message: "User has insufficient balance",
                    timestamp,
                    messageId
                }
            };
        }

        // Process message
        const apiMessage = buildApiMessage(savedTemplate.templateId, data, user);
        const chatMessage = buildChatMessage(savedTemplate, data);
        console.log("chat message converted!");
        
        
        let messageRequestId, error;
        try {
            const response = await axios.post(process.env.SEND_MESSAGE_API, apiMessage, {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Basic ${Buffer.from(`${process.env.API_USERNAME}:${process.env.API_PASSWORD}`).toString("base64")}`
                },
                // timeout: 5000
            });
            messageRequestId = response.data?.messageRequestId;
        } catch (err) {
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
        console.log("Airtel api processed sucessfully, error:", error);
        
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

    // Handle authentication template type
    if (templateData.type === 'AUTHENTICATION') {
        if (templateData.templateVariables && templateData.templateVariables.length > 0) {
            apiMessage.message.suffix = [templateData.templateVariables[0]];
        }
    }

    console.log(JSON.stringify(apiMessage, null, 2), "converted apiMessage");
    return apiMessage;
};

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