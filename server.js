const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- KHỞI TẠO CÁC DỊCH VỤ ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
const projectId = serviceAccount.project_id;
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: projectId,
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- CÀI ĐẶT SERVER EXPRESS ---
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SECRET_API_KEY;

// Middleware để kiểm tra API Key
const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === API_KEY) {
    next();
  } else {
    res.status(401).send("Unauthorized");
  }
};

// --- CÁC HÀM HỖ TRỢ (HELPER FUNCTIONS) ---

// Gửi và lưu thông báo cho một người dùng
async function sendAndSaveNotification(userId, title, body) {
    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    if (!userDoc.exists) {
        console.log(`User ${userId} not found, cannot send notification.`);
        return;
    }
    const fcmToken = userDoc.data()?.fcmToken;

    if (fcmToken) {
        const payload = { notification: { title, body } };
        await admin.messaging().send({ token: fcmToken, notification: payload.notification });
        await admin.firestore().collection('users').doc(userId).collection('notifications').add({
            title, body, timestamp: admin.firestore.FieldValue.serverTimestamp(), isRead: false,
        });
    }
}

// Gửi thông báo cho tất cả người dùng có vai trò 'admin'
async function notifyAllAdmins(title, body) {
    const adminsSnapshot = await admin.firestore().collection('users').where('role', '==', 'admin').get();
    if (adminsSnapshot.empty) {
        console.log('No admins found to notify.');
        return;
    }
    
    const notifications = [];
    adminsSnapshot.forEach(adminDoc => {
        notifications.push(sendAndSaveNotification(adminDoc.id, title, body));
    });
    await Promise.all(notifications);
}

// Tìm kiếm sản phẩm trên Firestore cho Chatbot
async function _searchProductsInFirestore(query) {
    console.log(`AI is searching for: ${query}`);
    const searchQuery = query.toLowerCase();
    try {
        const snapshot = await admin.firestore()
            .collection('products')
            .where('searchableName', '>=', searchQuery)
            .where('searchableName', '<=', searchQuery + '\uf8ff')
            .limit(5)
            .get();
        if (snapshot.docs.isEmpty) {
            return { products: 'Không tìm thấy sản phẩm nào phù hợp.' };
        }
        const products = snapshot.docs.map((doc) => {
            const data = doc.data();
            return { id: doc.id, name: data.name, price: data.price, imageUrl: data.imageUrl };
        });
        return { products: products };
    } catch (e) {
        console.error('Firestore search error:', e);
        return { products: 'Đã có lỗi khi tìm kiếm sản phẩm.' };
    }
}


// =======================================================
// ENDPOINT 1: XỬ LÝ CÁC SỰ KIỆN THÔNG BÁO
// =======================================================
app.post("/trigger-event-notification", requireApiKey, async (req, res) => {
    const { eventType, data } = req.body;
    if (!eventType || !data) {
        return res.status(400).send("Missing eventType or data");
    }

    const { orderId, userId, customerName, reason, products } = data;
    const shortOrderId = orderId.substring(0, 6).toUpperCase();
    const db = admin.firestore();

    try {
        switch (eventType) {

            case 'ORDER_CREATED':
                await sendAndSaveNotification(userId, 
                    `Đơn hàng #${shortOrderId} đã được tạo thành công`, 
                    'Đơn hàng của bạn đã được ghi nhận vào hệ thống.'
                );
                await notifyAllAdmins(
                    `Yêu cầu xử lý đơn hàng #${shortOrderId}`, 
                    `Đơn hàng mới từ khách hàng ${customerName || 'không tên'}.`
                );
                break;

            case 'STATUS_SHIPPING':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} đang được vận chuyển`,
                    'Hãy chú ý điện thoại nhé, đơn vị vận chuyển của chúng tôi sẽ sớm liên lạc với bạn.'
                );
                // ### LOGIC MỚI: Trừ số lượng tồn kho ###
                if (products && Array.isArray(products)) {
                    const batch = db.batch();
                    products.forEach(item => {
                        const productRef = db.collection('products').doc(item.id);
                        const quantityToDecrease = item.quantity;
                        batch.update(productRef, { 
                            stockQuantity: admin.firestore.FieldValue.increment(-quantityToDecrease) 
                        });
                    });
                    await batch.commit();
                }
                break;

            case 'STATUS_DELIVERED':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} đã được giao thành công!`,
                    'Cảm ơn bạn đã mua sắm tại BuildMart. Hy vọng bạn hài lòng với sản phẩm.'
                );
                // ### LOGIC MỚI: Tăng số lượng đã bán ###
                if (products && Array.isArray(products)) {
                    const batch = db.batch();
                    products.forEach(item => {
                        const productRef = db.collection('products').doc(item.id);
                        const quantitySold = item.quantity;
                        batch.update(productRef, { 
                            sold: admin.firestore.FieldValue.increment(quantitySold) 
                        });
                    });
                    await batch.commit();
                }
                break;

            case 'STATUS_CANCELLED':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} của bạn đã bị hủy`,
                    `Lý do: ${reason}. Vui lòng liên hệ BuildMart để được hỗ trợ.`
                );
                break;
                
        }
        res.status(200).send("Notifications and inventory updated successfully!");
    } catch (error) {
        console.error(`Error processing event ${eventType}:`, error);
        res.status(500).send("Failed to process event");
    }
});

// =======================================================
// ENDPOINT 2: XỬ LÝ TIN NHẮN CHO CHATBOT AI
// =======================================================
app.post("/chat", requireApiKey, async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage) {
        return res.status(400).send({ error: "Missing message" });
    }

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            tools: [{
                functionDeclarations: [{
                    name: "findProducts",
                    description: "Tìm kiếm sản phẩm trong cơ sở dữ liệu của cửa hàng.",
                    parameters: {
                        type: "OBJECT",
                        properties: { query: { type: "STRING", description: "Từ khóa tìm kiếm" } },
                        required: ["query"]
                    }
                }]
            }],
            systemInstruction: 'Bạn là một chuyên gia tư vấn vật liệu xây dựng cho ứng dụng BuildMart. Hãy trả lời ngắn gọn, thân thiện. Nếu người dùng muốn tìm sản phẩm, hãy dùng công cụ findProducts. QUAN TRỌTNG: Không bao giờ được đề cập đến tên hàm "findProducts". Hãy hành động như thể bạn đang tự mình tìm kiếm thông tin.',
        });

        const chat = model.startChat();
        const result1 = await chat.sendMessage(userMessage);
        const response1 = result1.response;
        const functionCall = response1.functionCalls()?.[0];

        if (functionCall && functionCall.name === 'findProducts') {
            const searchResult = await _searchProductsInFirestore(functionCall.args.query);
            const result2 = await chat.sendMessage([{ functionResponse: { name: 'findProducts', response: searchResult } }]);
            return res.status(200).json({ response: result2.response.text(), products: searchResult.products });
        }
        
        return res.status(200).json({ response: response1.text() });

    } catch (error) {
        console.error("Chatbot Error:", error);
        res.status(500).json({ error: "AI service failed" });
    }
});

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});