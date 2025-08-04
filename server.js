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

// =======================================================
// ENDPOINT 1: XỬ LÝ TẤT CẢ CÁC SỰ KIỆN THÔNG BÁO
// =======================================================
app.post("/trigger-event-notification", requireApiKey, async (req, res) => {
    const { eventType, data } = req.body;
    if (!eventType || !data) {
        return res.status(400).send("Missing eventType or data");
    }

    const { orderId, userId, customerName, reason } = data;
    const shortOrderId = orderId.substring(0, 6).toUpperCase();

    try {
        switch (eventType) {
            case 'ORDER_CREATED':
                // 1. Gửi cho khách hàng
                await sendAndSaveNotification(userId, 
                    `Đơn hàng #${shortOrderId} đã được tạo thành công`, 
                    'Đơn hàng của bạn đã được ghi nhận vào hệ thống.'
                );
                // 2. Gửi cho tất cả admin
                await notifyAllAdmins(
                    `Yêu cầu xử lý đơn hàng #${shortOrderId}`, 
                    `Đơn hàng mới từ khách hàng ${customerName}.`
                );
                break;

            case 'STATUS_SHIPPING':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} đang được vận chuyển`,
                    'Hãy chú ý điện thoại nhé, đơn vị vận chuyển của chúng tôi sẽ sớm liên lạc với bạn.'
                );
                break;

            case 'STATUS_DELIVERED':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} đã được giao thành công!`,
                    'Cảm ơn bạn đã mua sắm tại BuildMart. Hy vọng bạn hài lòng với sản phẩm.'
                );
                break;

            case 'STATUS_CANCELLED':
                await sendAndSaveNotification(userId,
                    `Đơn hàng #${shortOrderId} của bạn đã bị hủy`,
                    `Lý do: ${reason}. Vui lòng liên hệ BuildMart để được hỗ trợ.`
                );
                break;
        }
        res.status(200).send("Notifications triggered successfully!");
    } catch (error) {
        console.error(`Error triggering notifications for event ${eventType}:`, error);
        res.status(500).send("Failed to trigger notifications");
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
                        properties: {
                            query: { type: "STRING", description: "Từ khóa tìm kiếm" }
                        },
                        required: ["query"]
                    }
                }]
            }],
            systemInstruction: 'Bạn là một chuyên gia tư vấn vật liệu xây dựng cho ứng dụng BuildMart. Hãy trả lời ngắn gọn, thân thiện. Nếu người dùng muốn tìm sản phẩm, hãy dùng công cụ findProducts. QUAN TRỌNG: Không bao giờ được đề cập đến tên hàm "findProducts". Hãy hành động như thể bạn đang tự mình tìm kiếm thông tin.',
        });

        const chat = model.startChat();
        const result1 = await chat.sendMessage(userMessage);
        const response1 = result1.response;

        const functionCall = response1.functionCalls()?.[0];

        if (functionCall) {
            if (functionCall.name === 'findProducts') {
                const searchResult = await _searchProductsInFirestore(functionCall.args.query);
                const result2 = await chat.sendMessage([{ functionResponse: { name: 'findProducts', response: searchResult } }]);
                const response2 = result2.response;
                // Trả về cả text và danh sách sản phẩm
                return res.status(200).json({ response: response2.text(), products: searchResult.products });
            }
        }
        
        // Trả về text nếu không có gọi hàm
        return res.status(200).json({ response: response1.text() });

    } catch (error) {
        console.error("Chatbot Error:", error);
        res.status(500).json({ error: "AI service failed" });
    }
});

// --- HÀM HỖ TRỢ: TÌM KIẾM SẢN PHẨM TRÊN FIRESTORE ---
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

// --- HÀM HỖ TRỢ MỚI ---
// Hàm gửi thông báo và lưu lại
async function sendAndSaveNotification(userId, title, body) {
    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    const fcmToken = userDoc.data()?.fcmToken;

    if (fcmToken) {
        const payload = { notification: { title, body } };
        await admin.messaging().send({ token: fcmToken, notification: payload.notification });
        await admin.firestore().collection('users').doc(userId).collection('notifications').add({
            title, body, timestamp: admin.firestore.FieldValue.serverTimestamp(), isRead: false,
        });
    }
}

// --- KHỞI ĐỘNG SERVER ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});