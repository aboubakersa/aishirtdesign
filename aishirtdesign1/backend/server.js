require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;

// 1. INITIALIZE FIREBASE ADMIN SDK 
const serviceAccount = require('./firebase-admin.json'); 

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 2. INITIALIZE CLOUDINARY
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

// 3. GLOBAL MIDDLEWARE
app.use(cors({ origin: '*' })); 
app.use(express.json());

// 4. SECURITY: RATE LIMITING
const generateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { error: "Too many requests. Please try again later." }
});

// 5. SECURITY: FIREBASE AUTHENTICATION MIDDLEWARE
const verifyAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

// --- HELPER FUNCTION: Upload Buffer to Cloudinary ---
const uploadToCloudinary = (buffer, uid) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: `aishirtdesign/users/${uid}` }, 
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        stream.end(buffer);
    });
};

// 6. CORE API ROUTE: GENERATE DESIGN
app.post('/api/generate-design', verifyAuth, generateLimiter, async (req, res) => {
    const { prompt, product, quality, material } = req.body;

    if (!prompt || !product) {
        return res.status(400).json({ error: "Missing required fields (prompt, product)" });
    }

    try {
        // Verify user has generation credits left
        const userRef = db.collection('users').doc(req.user.uid);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists || userDoc.data().generationsLeft <= 0) {
            return res.status(403).json({ error: "No generation credits remaining. Please upgrade." });
        }

        // --- DYNAMIC PROMPT ENGINEERING (SMARTER & TOKEN EFFICIENT) ---
        // We inject specific anatomical details so the AI actually draws the correct garment type
        let productSpecifics = "";
        switch(product.toLowerCase()) {
            case "chemise":
                productSpecifics = "Button-down front, crisp folded collar, cuffed long sleeves, tailored yet relaxed fit shirt.";
                break;
            case "oversized hoodie":
                productSpecifics = "Large relaxed hood with drawstrings, front kangaroo pocket, ribbed cuffs, dropped shoulders, bulky fit.";
                break;
            case "long sleeve":
                productSpecifics = "Extended sleeves with ribbed cuffs, standard crewneck collar, standard fit.";
                break;
            case "premium t-shirt":
            default:
                productSpecifics = "Standard crewneck collar, short sleeves, seamless body flow, premium modern fit.";
                break;
        }

        // Optimized master prompt: Less conversational fluff, more strict technical instructions.
        const masterPrompt = `Design a premium e-commerce mockup of a ${quality} ${material} ${product}.

GARMENT ANATOMY: ${productSpecifics}

DESIGN THEME: "${prompt}" (Adapt cultural/foreign terms into high-fashion streetwear motifs).

STRICT MANDATES:
1. FORMAT: Side-by-side DIPTYCH (Left = Front view, Right = Back view of the exact same garment). Perfect horizontal alignment.
2. STYLE: "Ghost Mannequin" only. NO humans, NO bodies, NO limbs, NO heads, NO hangers.
3. BACKGROUND: Pure white (#FFFFFF) studio backdrop with soft realistic drop shadows underneath the garment.
4. COMPOSITION: Maximalist, cohesive all-over print. Design MUST wrap naturally across seams, sleeves, and edges. Do not just place a basic logo in the center.
5. REALISM: Photorealistic fabric texture, 8k resolution, studio lighting.`;

        // Dense, highly effective negative prompt
        const negativePrompt = "human, person, face, hands, body, neck, hanger, mannequins, plastic, low quality, 3d render, single view, extra garments, busy background, text, watermark, plain, boring, basic centered logo, white unprinted sleeves, misaligned";

        // Call OpenRouter API
// --- DYNAMIC API KEY FALLBACK SYSTEM ---
        const apiKeys = process.env.OPENROUTER_API_KEYS ? process.env.OPENROUTER_API_KEYS.split(',').map(k => k.trim()) : [];
        if (apiKeys.length === 0) {
            throw new Error("No OpenRouter API keys found in environment variables.");
        }

        let openRouterResponse = null;
        let lastError = null;

        for (let i = 0; i < apiKeys.length; i++) {
            const currentKey = apiKeys[i];
            try {
                console.log(`[API] Attempting generation with API Key ${i + 1} of ${apiKeys.length}...`);
                
                openRouterResponse = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
                    model: process.env.AI_MODEL || "google/gemini-2.5-flash-image", 
                    messages: [
                        { role: "system", content: "You are an expert 3D apparel designer generating photorealistic ghost-mannequin mockups." },
                        { role: "user", content: `${masterPrompt}\n\nNEGATIVE PROMPT: ${negativePrompt}` }
                    ]
                }, {
                    headers: {
                        "Authorization": `Bearer ${currentKey}`,
                        "Content-Type": "application/json"
                    }
                });
                
                // If the request succeeds, log it and break out of the loop early
                console.log(`[API] Successfully generated image using API Key ${i + 1}.`);
                break; 
                
            } catch (err) {
                lastError = err;
                const errorMsg = err.response?.data?.error?.message || err.message;
                console.warn(`[API] API Key ${i + 1} failed: ${errorMsg}. Trying next key...`);
                // Loop continues to the next key automatically
            }
        }

        // If we exhausted all keys and still have no response, throw the last error
        if (!openRouterResponse) {
            throw lastError || new Error("All provided OpenRouter API keys failed.");
        }

        const responseData = openRouterResponse.data;
        const message = responseData.choices?.[0]?.message;

        if (!message) {
            console.error("OpenRouter Raw:", JSON.stringify(responseData));
            throw new Error("Invalid response from OpenRouter API.");
        }

        // --- BULLETPROOF IMAGE EXTRACTION ---
        let extractedImageData = null;
        
        if (message.images && message.images.length > 0) {
            extractedImageData = message.images[0].url || message.images[0].image_url?.url;
        } else if (message.content && typeof message.content === 'string') {
            if (message.content.includes('data:image')) {
                const base64Match = message.content.match(/(data:image\/[^;]+;base64,[^\s"']+)/);
                if (base64Match) extractedImageData = base64Match[1];
            } 
            if (!extractedImageData) {
                const markdownMatch = message.content.match(/!\[.*?\]\((.*?)\)/);
                if (markdownMatch) extractedImageData = markdownMatch[1];
            }
            if (!extractedImageData) {
                const urlMatch = message.content.match(/(https?:\/\/[^\s"']+)/);
                if (urlMatch) extractedImageData = urlMatch[1];
            }
        }

        if (!extractedImageData) {
            console.error("AI Response Content:", message.content);
            throw new Error("The AI model returned text, but no image link or base64 data could be found.");
        }

        // --- PROCESS IMAGE (URL OR BASE64) ---
        let imageBuffer;
        
        if (extractedImageData.startsWith('data:image')) {
            const base64Data = extractedImageData.replace(/^data:image\/\w+;base64,/, "");
            imageBuffer = Buffer.from(base64Data, 'base64');
        } else {
            const imageResponse = await axios.get(extractedImageData, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(imageResponse.data, 'binary');
        }

        // Upload to Cloudinary
        const permanentImageUrl = await uploadToCloudinary(imageBuffer, req.user.uid);

        // Deduct Token & Save Chat to Firestore
        await userRef.update({
            generationsLeft: admin.firestore.FieldValue.increment(-1)
        });

        const newChatRef = await db.collection('users').doc(req.user.uid).collection('chats').add({
            prompt: prompt,
            imageUrl: permanentImageUrl, 
            config: { product, quality, material },
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Return Success
        res.status(200).json({
            success: true,
            chatId: newChatRef.id,
            imageUrl: permanentImageUrl,
            generationsLeft: userDoc.data().generationsLeft - 1
        });

    } catch (error) {
        // --- ADVANCED ERROR TRACKING ---
        const actualError = error.response?.data?.error?.message || error.response?.data?.error || error.message || "Unknown Error";
        console.error("🚨 BACKEND CRASH:", actualError);
        
        let friendlyError = actualError;
        if (typeof actualError === 'string' && actualError.toLowerCase().includes("user not found")) {
            friendlyError = "OpenRouter API Key Error: The API key provided belongs to an account that was deleted or not found. Please update your .env file.";
        }

        res.status(500).json({ error: friendlyError });
    }
});

// 7. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 AI SaaS Backend is running on port ${PORT}`);
});