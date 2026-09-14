const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: "*" } });

app.get('/ping', (req, res) => res.status(200).send('Server Awake'));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

cloudinary.config({ 
  cloud_name: 'gr8tp1tg', 
  api_key: '668573837891895', 
  api_secret: 'dTJqlvLUKWLJUft-FH8rpnIPlYs' 
});

const MONGO_URI = "mongodb+srv://chatadmin:ChatApp12345@cluster0.pb5by68.mongodb.net/chatapp?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB Connected'));

const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true },
  phone: { type: String, unique: true },
  password: String,
  fullName: String,
  avatar: { type: String, default: '' },
  contacts: [{ userCode: String, name: String }]
});
const User = mongoose.model('User', userSchema);

const statusSchema = new mongoose.Schema({
  userCode: String,
  text: String,
  createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const Status = mongoose.model('Status', statusSchema);

const messageSchema = new mongoose.Schema({
  roomId: String,
  senderCode: String,
  targetCode: String,
  text: String,
  status: { type: String, default: 'sent' },
  time: String,
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

const callLogSchema = new mongoose.Schema({
  caller: String,
  receiver: String,
  time: String,
  createdAt: { type: Date, default: Date.now }
});
const CallLog = mongoose.model('CallLog', callLogSchema);

const userSockets = new Map();

io.on('connection', (socket) => {
  const mapSocket = (uCode) => {
    if (!userSockets.has(uCode)) userSockets.set(uCode, new Set());
    userSockets.get(uCode).add(socket.id);
  };

  socket.on('auth-user', async (data, cb) => {
    let cleanCode = data.userCode.trim().toLowerCase();
    if (!cleanCode.startsWith('@')) cleanCode = '@' + cleanCode;
    if (data.isRegister) {
      const exists = await User.findOne({ $or: [{ userCode: cleanCode }, { phone: data.phone }] });
      if (exists) return cb({ success: false, error: 'User/Phone already exists' });
      const user = new User({ ...data, userCode: cleanCode, fullName: data.fullName || cleanCode });
      await user.save();
      mapSocket(cleanCode);
      cb({ success: true, user });
    } else {
      const user = await User.findOne({ userCode: cleanCode, password: data.password });
      if (!user) return cb({ success: false, error: 'Invalid ID or Password' });
      mapSocket(cleanCode);
      cb({ success: true, user });
    }
  });

  socket.on('add-contact', async ({ myCode, targetCode }, cb) => {
    let cleanTarget = targetCode.trim().toLowerCase();
    if (!cleanTarget.startsWith('@')) cleanTarget = '@' + cleanTarget;
    if (cleanTarget === myCode) return cb({ success: false, error: 'Cannot add yourself' });
    const targetUser = await User.findOne({ userCode: cleanTarget });
    if (!targetUser) return cb({ success: false, error: 'User not found in system' });
    
    await User.findOneAndUpdate(
      { userCode: myCode }, 
      { $addToSet: { contacts: { userCode: cleanTarget, name: targetUser.fullName || cleanTarget } } }
    );
    cb({ success: true, contact: { userCode: cleanTarget, name: targetUser.fullName || cleanTarget } });
  });

  socket.on('get-contacts', async ({ myCode }, cb) => {
    const user = await User.findOne({ userCode: myCode });
    cb({ contacts: user ? user.contacts : [] });
  });

  socket.on('post-status', async ({ userCode, text }, cb) => {
    if(!text) return;
    const st = new Status({ userCode, text });
    await st.save();
    cb({ success: true });
  });

  socket.on('get-statuses', async (cb) => {
    const list = await Status.find().sort({ createdAt: -1 });
    cb({ statuses: list });
  });

  socket.on('send-message', async (data) => {
    const roomId = [data.senderCode, data.targetCode].sort().join('_');
    const isOnline = userSockets.has(data.targetCode) && userSockets.get(data.targetCode).size > 0;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const newMsg = new Message({
      roomId, senderCode: data.senderCode, targetCode: data.targetCode,
      text: data.text, status: isOnline ? 'delivered' : 'sent', time: timeStr
    });
    await newMsg.save();
    io.to(roomId).emit('chat-message', newMsg);
    if (isOnline) userSockets.get(data.targetCode).forEach(s => io.to(s).emit('notify-msg', newMsg));
  });

  socket.on('open-room', async ({ myCode, targetCode }, cb) => {
    const roomId = [myCode, targetCode].sort().join('_');
    socket.join(roomId);
    const msgs = await Message.find({ roomId }).sort({ createdAt: 1 });
    cb({ msgs });
  });

  socket.on('make-call', async ({ caller, receiver }) => {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await new CallLog({ caller, receiver, time: timeStr }).save();
    if (userSockets.has(receiver)) {
      userSockets.get(receiver).forEach(s => io.to(s).emit('incoming-call', { caller, time: timeStr }));
    }
  });

  socket.on('get-calls', async ({ myCode }, cb) => {
    const logs = await CallLog.find({ $or: [{ caller: myCode }, { receiver: myCode }] }).sort({ createdAt: -1 }).limit(30);
    cb({ logs });
  });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Server Live'));
