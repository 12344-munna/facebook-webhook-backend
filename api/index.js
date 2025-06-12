const admin = require('firebase-admin');

// Securely Initialize Firebase Admin SDK
// This only runs once and uses the secure key from Vercel's environment variables
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

// Helper function to parse your specific message format
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


// This is the main function Vercel will run for any request to /api
module.exports = async (req, res) => {
  // --- Part 1: Handle Facebook's Verification Request (GET) ---
  if (req.method === "GET") {
    const VERIFY_TOKEN = "munna12345"; // Your secret token
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("WEBHOOK_VERIFIED_SUCCESSFULLY");
      res.status(200).send(challenge);
    } else {
      console.error("Webhook verification failed. Token mismatch.");
      res.status(403).send("Forbidden");
    }
    return;
  }

  // --- Part 2: Handle Admin's Order Message (POST) ---
  if (req.method === "POST") {
    const body = req.body;
    if (body.object === "page") {
      for (const entry of body.entry) {
        const webhookEvent = entry.messaging[0];
        const messageText = webhookEvent.message ? webhookEvent.message.text : "";

        if (messageText && messageText.toLowerCase().includes("/confirmation")) {
          console.log("Admin confirmation command detected. Processing order...");
          try {
            const orderData = parseOrderDetails(messageText);

            await db.runTransaction(async (transaction) => {
              const inventoryUpdates = [];
              const orderItems = [];
              let totalCostOfGoods = 0;

              for (const code of orderData.productCodes) {
                const [productCode, size] = code.split("-");
                if (!productCode || !size) throw new Error(`Invalid code format: ${code}`);

                const inventoryQuery = db.collection("inventory")
                  .where("productCode", "==", productCode.trim())
                  .limit(1);

                const productSnapshot = await transaction.get(inventoryQuery);
                if (productSnapshot.empty) throw new Error(`Product not found for code: ${productCode}`);
                
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

                totalCostOfGoods += productData.buyingPrice || 0;

                orderItems.push({
                  productId: productDoc.id,
                  productName: productData.name,
                  selectedSizesAndQuantities: { [sizeKey]: 1 },
                  unitSellingPrice: productData.sellingPrice,
                  itemTotalSellingPrice: productData.sellingPrice,
                  unitBuyingPrice: productData.buyingPrice,
                });
              }

              const profit = orderData.cod + orderData.paidInAdvance - totalCostOfGoods - orderData.deliveryCharge;

              for (const update of inventoryUpdates) {
                transaction.update(update.ref, update.update);
              }

              const newOrderRef = db.collection("pendingOrders").doc();
              transaction.set(newOrderRef, {
                customerName: orderData.name,
                customerAddress: orderData.address,
                phone: orderData.phone,
                items: orderItems,
                deliveryCharge: orderData.deliveryCharge,
                advancePaid: orderData.paidInAdvance,
                codAmount: orderData.cod,
                totalOrderPrice: orderData.cod,
                profit: profit,
                status: "pending",
                source: "Facebook-Admin",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                orderDate: admin.firestore.FieldValue.serverTimestamp(),
                userId: webhookEvent.recipient.id,
              });
            });
            console.log("Transaction successful. Order created.");
          } catch (error) {
            console.error("Error processing admin order:", error.message);
          }
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
    return;
  }

  // If the request is not GET or POST, send an error
  res.status(405).send("Method Not Allowed");
};
