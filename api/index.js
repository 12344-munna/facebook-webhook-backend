// This tells Vercel to allow a larger request body for Facebook's complex messages
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb',
    },
  },
};

// Import the Firebase Admin SDK
const admin = require('firebase-admin');

// --- Securely Initialize Firebase Admin ---
// This code checks if the app is already initialized.
// It reads the secure key you will store in Vercel's environment variables.
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY))
    });
  } catch (error) {
    console.error('Firebase admin initialization error', error.stack);
  }
}
const db = admin.firestore();


// --- Main Handler for All Incoming Requests ---
export default async function handler(req, res) {
  // --- Part 1: Handle Facebook's Verification Request ---
  if (req.method === "GET") {
    const VERIFY_TOKEN = "YOUR_SECRET_VERIFY_TOKEN"; // Must match what you put in Facebook's dashboard
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("VERCEL WEBHOOK_VERIFIED");
      res.status(200).send(challenge);
    } else {
      res.status(403).send("Forbidden");
    }
    return;
  }

  // --- Part 2: Handle Your Admin Confirmation Message ---
  if (req.method === "POST") {
    const body = req.body;
    if (body.object === "page") {
      try {
        for (const entry of body.entry) {
          const webhookEvent = entry.messaging[0];
          const messageText = webhookEvent.message ? webhookEvent.message.text : "";

          // The trigger for your command
          if (messageText && messageText.toLowerCase().includes("/confirmation")) {
            console.log("Admin confirmation command detected. Processing order...");

            const orderDetails = parseOrderDetails(messageText);

            // The rest of this is the same Firestore transaction logic
            await db.runTransaction(async (transaction) => {
                // ... (This is the same transaction code from the previous Cloud Function)
                // It will find products, update inventory, and create the order.
                const inventoryUpdates = [];
                const orderItems = [];
                let totalCostOfGoods = 0;

                for (const code of orderDetails.productCodes) {
                    const [productId, size] = code.split("-");
                    if (!productId || !size) throw new Error(`Invalid code: ${code}`);

                    const productQuery = db.collection("inventory")
                        .where("product_id", "==", productId.trim())
                        .limit(1);

                    const productSnapshot = await transaction.get(productQuery);
                    if (productSnapshot.empty) throw new Error(`Product not found for code: ${productId}`);
                    
                    const productDoc = productSnapshot.docs[0];
                    const productData = productDoc.data();
                    const currentSizes = productData.sizes || {};
                    const sizeKey = size.trim().toUpperCase();

                    if (!currentSizes[sizeKey] || currentSizes[sizeKey] <= 0) {
                        throw new Error(`Product ${productData.name} (Size: ${sizeKey}) is out of stock.`);
                    }

                    currentSizes[sizeKey] -= 1;
                    const newTotalStock = Object.values(currentSizes).reduce((a, b) => a + b, 0);

                    inventoryUpdates.push({
                        ref: productDoc.ref,
                        update: { sizes: currentSizes, availableAmount: newTotalStock },
                    });

                    totalCostOfGoods += productData.price || 0; // Assuming buying price is 'price'

                    orderItems.push({
                        productId: productDoc.id,
                        productName: productData.name,
                        selectedSizesAndQuantities: { [sizeKey]: 1 },
                        unitSellingPrice: productData.sellingPrice,
                        itemTotalSellingPrice: productData.sellingPrice,
                        unitBuyingPrice: productData.price,
                    });
                }

                const profit = orderDetails.cod - (totalCostOfGoods - orderDetails.advancePaid);

                for (const update of inventoryUpdates) {
                    transaction.update(update.ref, update.update);
                }

                const newOrderRef = db.collection("orders").doc();
                transaction.set(newOrderRef, {
                    customerName: orderDetails.name,
                    customerAddress: orderDetails.address,
                    customerPhoneNumber: orderDetails.phone,
                    items: orderItems,
                    deliveryCharge: orderDetails.deliveryCharge,
                    advancePaid: orderDetails.paidInAdvance,

                    // Your Flutter model expects these field names
                    totalOrderPrice: orderDetails.cod, 
                    codAmount: orderDetails.cod,
                    
                    profit: profit,
                    status: "confirmed", // Changed to confirmed as per your logic
                    source: "Facebook-Admin",
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    orderDate: admin.firestore.FieldValue.serverTimestamp(),
                    userId: webhookEvent.recipient.id,
                });
            });
            console.log("Successfully processed admin order on Vercel.");
          }
        }
        res.status(200).send("EVENT_RECEIVED");
      } catch (error) {
        console.error("Error processing webhook:", error);
        res.status(500).send("Internal Server Error");
      }
    } else {
      res.status(404).send("Not Found");
    }
  }
}

// Helper function to parse your message (same as before)
function parseOrderDetails(text) {
  const details = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length < 2) continue;
    const key = parts[0].trim().toLowerCase();
    const value = parts.slice(1).join(":").trim();
    if (key === "name") details.name = value;
    if (key === "address") details.address = value;
    if (key === "phone") details.phone = value;
    if (key === "product code") {
      details.productCodes = value.split(",").map(code => code.trim());
    }
    if (key === "delivery charge") details.deliveryCharge = parseFloat(value) || 0;
    if (key === "paid in advance") details.paidInAdvance = parseFloat(value) || 0;
    if (key === "cod") details.cod = parseFloat(value) || 0;
  }
  return details;
}
