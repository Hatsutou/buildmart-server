const express = require("express");
const admin = require("firebase-admin");
const bodyParser = require("body-parser");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
const projectId = serviceAccount.project_id;

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

    // Đã xóa dòng "sound: 'default'" khỏi đây
    const payload = {
      notification: {
        title: `Cập nhật đơn hàng #${orderId.substring(0, 6).toUpperCase()}`,
        body: `Đơn hàng của bạn đã chuyển sang trạng thái: ${newStatus}`,
      },
    };

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