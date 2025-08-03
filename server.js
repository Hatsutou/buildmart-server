const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");

// Lấy service account key từ biến môi trường của Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// LẤY PROJECT ID TỪ SERVICE ACCOUNT
const projectId = serviceAccount.project_id;

// KHỞI TẠO VỚI PROJECT ID TƯỜNG MINH
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: projectId, 
});

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SECRET_API_KEY;

const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === API_KEY) {
    next();
  } else {
    res.status(401).send("Unauthorized");
  }
};

app.post("/send-order-notification", requireApiKey, async (req, res) => {
  const { userId, newStatus, orderId } = req.body;
  if (!userId || !newStatus || !orderId) {
    return res.status(400).send("Missing required data");
  }

  try {
    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    const fcmToken = userDoc.data()?.fcmToken;

    if (!fcmToken) {
      return res.status(200).send("User has no token, notification not sent.");
    }

    const payload = {
      notification: {
        title: `Cập nhật đơn hàng #${orderId.substring(0, 6).toUpperCase()}`,
        body: `Đơn hàng của bạn đã chuyển sang trạng thái: ${newStatus}`,
        sound: "default",
      },
    };

    // Đã sửa lại hàm send để rõ ràng hơn
    await admin.messaging().send({
        token: fcmToken,
        notification: payload.notification,
    });

    res.status(200).send("Notification sent successfully!");
  } catch (error) {
    console.error("Error sending notification:", error);
    res.status(500).send("Failed to send notification");
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});