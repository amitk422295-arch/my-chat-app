const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: "*" } });

// रेंडर एंटी-स्लीप
app.get('/ping', (req, res) => res.status(200).send('Server Awake'));

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cloudinary Config (आपके क्रेडेंशियल्स)
cloudinary.config({ 
  cloud_name: 'gr8tp1tg', 
  api_key: '668573837891895', 
  api_secret: 'dTJqlvLUKWLJUft-FH8rpnIPlYs' 
});

// MongoDB Connection (आपका chatadmin एक्सेस)
const MONGO_URI = "mongodb+srv://chatadmin:ChatApp12345@cluster0.pb5by68.mongodb.net/chatapp?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB Connected')).catch(err => console.log(err));

// Database Schemas
const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true },
  phone: { type: String, unique: true },
  password: { type: String },
  fullName: String,
  gender: String,
  avatar: { type: String, default: '' },
  dob: { type: String, default: '' },
  contacts: [String],
  blocked: [String]
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  roomId: String,
  senderCode: String,
  targetCode: String,
  text: String,
  mediaUrl: String,
  status: { type: String, default: 'sent' }, // sent, delivered, seen
  time: String
});
const Message = mongoose.model('Message', messageSchema);

const userSockets = new Map();

io.on('connection', (socket) => {
  const mapSocket = (uCode) => {
    if (!userSockets.has(uCode)) userSockets.set(uCode, new Set());
    userSockets.get(uCode).add(socket.id);
  };

  // 2-Step Auth
  socket.on('auth-user', async (data, callback) => {
    let cleanCode = data.userCode.trim().toLowerCase();
    if (!cleanCode.startsWith('@')) cleanCode = '@' + cleanCode;

    if (data.isRegister) {
      const exists = await User.findOne({ $or: [{ userCode: cleanCode }, { phone: data.phone }] });
      if (exists) return callback({ success: false, error: 'User ID or Phone already exists!' });
      
      const newUser = new User({ ...data, userCode: cleanCode });
      await newUser.save();
      mapSocket(cleanCode);
      callback({ success: true, user: newUser });
    } else {
      const user = await User.findOne({ userCode: cleanCode, password: data.password });
      if (!user) return callback({ success: false, error: 'Invalid ID or Password!' });
      mapSocket(cleanCode);
      callback({ success: true, user });
    }
  });

  // Search User by ID or Phone
  socket.on('search-user', async (query, callback) => {
    let cleanQuery = query.trim().toLowerCase();
    if (cleanQuery.startsWith('@')) {
      const user = await User.findOne({ userCode: cleanQuery });
      callback({ success: !!user, user });
    } else {
      const user = await User.findOne({ phone: cleanQuery });
      callback({ success: !!user, user });
    }
  });

  // Chat & Ticks Logic
  socket.on('send-message', async (data) => {
    const roomId = [data.senderCode, data.targetCode].sort().join('_');
    const isOnline = userSockets.has(data.targetCode) && userSockets.get(data.targetCode).size > 0;
    
    let mediaUrl = null;
    if (data.media) {
      const upload = await cloudinary.uploader.upload(data.media, { folder: "chat_media", resource_type: "auto" });
      mediaUrl = upload.secure_url;
    }

    const newMsg = new Message({
      roomId, senderCode: data.senderCode, targetCode: data.targetCode,
      text: data.text, mediaUrl,
      status: isOnline ? 'delivered' : 'sent',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    await newMsg.save();

    io.to(roomId).emit('chat-message', newMsg);
    if (isOnline) {
      userSockets.get(data.targetCode).forEach(s => io.to(s).emit('notify-msg', newMsg));
    }
  });

  socket.on('mark-seen', async ({ id, targetCode }) => {
    await Message.findByIdAndUpdate(id, { status: 'seen' });
    if (userSockets.has(targetCode)) {
      userSockets.get(targetCode).forEach(s => io.to(s).emit('msg-seen', { id }));
    }
  });

  socket.on('typing', ({ targetCode, userCode }) => {
    const sockets = userSockets.get(targetCode);
    if (sockets) sockets.forEach(s => io.to(s).emit('user-typing', { userCode }));
  });

  socket.on('open-room', async ({ myCode, targetCode }) => {
    const roomId = [myCode, targetCode].sort().join('_');
    socket.join(roomId);
    const msgs = await Message.find({ roomId });
    socket.emit('load-history', msgs);
  });

  // Update Profile DP to Cloudinary
  socket.on('update-profile', async (data, callback) => {
    let avatarUrl = data.avatar;
    if (data.avatar && data.avatar.startsWith('data:image')) {
      const upload = await cloudinary.uploader.upload(data.avatar, { folder: "chat_dps" });
      avatarUrl = upload.secure_url;
    }
    await User.findOneAndUpdate({ userCode: data.userCode }, { avatar: avatarUrl, fullName: data.fullName, dob: data.dob });
    callback({ success: true, avatarUrl });
  });

  // WebRTC Calling / Status Passthrough (Preserved from your code)
  socket.on('call-user', data => {
    if (userSockets.has(data.targetCode)) {
      userSockets.get(data.targetCode).forEach(s => io.to(s).emit('incoming-call', data));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server Live on port ${PORT}`));
