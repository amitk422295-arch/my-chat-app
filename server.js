const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'chat-app', time: new Date().toISOString() }));

app.get('/api/config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBR96s32sM1BvzNtJD4KtGk4B6Io9-_dWA",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "mychat01-aa2e4.firebaseapp.com",
    projectId: process.env.FIREBASE_PROJECT_ID || "mychat01-aa2e4",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "mychat01-aa2e4.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "899727602335",
    appId: process.env.FIREBASE_APP_ID || "1:899727602335:web:0ca859e6e818adac4ae8aa"
  });
});

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat-app';
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000
}).then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err.message));

const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  mobile: { type: String, default: '' },
  avatar: { type: String, default: '' },
  dateOfBirth: { type: String, default: '' },
  blockedByMe: { type: Map, of: Boolean, default: {} },
  contacts: { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ id: String, media: String, type: String, time: String, viewers: [viewerSchema] }, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

const messageSchema = new mongoose.Schema({
  messageId: { type: String, unique: true, index: true },
  senderCode: { type: String, required: true, index: true, lowercase: true },
  receiverCode: { type: String, required: true, index: true, lowercase: true },
  text: { type: String, default: '' },
  media: { type: String, default: '' },
  messageType: { type: String, enum: ['text','audio'], default: 'text' },
  duration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true },
  deletedForEveryone: { type: Boolean, default: false },
  deletedFor: { type: [String], default: [] }
});
messageSchema.index({ senderCode: 1, receiverCode: 1, createdAt: 1 });
const Message = mongoose.model('Message', messageSchema);

io.on('connection', (socket) => {
  let currentUserCode = null;

  socket.on('register-custom', async ({ userCode, password, fullName, mobile, avatar }, callback) => {
    const rawId = String(userCode || '').trim().toLowerCase();
    const passStr = String(password || '').trim();

    try {
      if (!rawId.startsWith('@') || rawId.length < 5) {
        return callback({ success: false, error: 'User ID must start with @ and have at least 4 characters after it.' });
      }

      if (passStr.length !== 8) {
        return callback({ success: false, error: 'Password must be strictly 8 digits.' });
      }

      const existingUser = await User.findOne({ userCode: rawId });
      if (existingUser) {
        return callback({ success: false, error: 'This User ID is already taken.' });
      }

      const existingMobile = await User.findOne({ mobile: String(mobile || '').trim() });
      if (existingMobile) {
        return callback({ success: false, error: 'Mobile number already registered.' });
      }

      const newUser = await User.create({
        userCode: rawId,
        password: passStr,
        fullName: fullName || 'User',
        mobile: String(mobile || '').trim(),
        avatar: avatar || '',
        blockedByMe: {}
      });

      currentUserCode = rawId;
      socket.join(rawId);
      io.emit('user-online-status', { targetCode: rawId, isOnline: true });

      callback({ success: true, user: newUser });
    } catch (e) {
      callback({ success: false, error: 'Registration error: ' + e.message });
    }
  });

  socket.on('auth-user', async ({ userCode, password }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();

    try {
      const isMobileQuery = /^\d{10,13}$/.test(query);
      const normalizedId = isMobileQuery ? null : (query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase());

      const userObj = await User.findOne({
        $or: [
          ...(normalizedId ? [{ userCode: normalizedId }] : []),
          ...(isMobileQuery ? [{ mobile: query }] : [])
        ]
      });

      if (!userObj) return callback({ success: false, error: 'Account not found by ID or mobile.' });
      if (userObj.password !== passStr) return callback({ success: false, error: 'Incorrect password.' });

      currentUserCode = userObj.userCode;
      socket.join(currentUserCode);
      io.emit('user-online-status', { targetCode: currentUserCode, isOnline: true });
      return callback({ success: true, user: userObj });
    } catch (err) {
      return callback({ success: false, error: 'Auth error: ' + err.message });
    }
  });

  socket.on('get-statuses', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      let myStatusDoc = await Status.findOne({ userCode: currentUserCode });
      const myStatus = myStatusDoc ? myStatusDoc.toObject() : { userCode: currentUserCode, name: me?.fullName, avatar: me?.avatar, items: [] };
      const allowedContacts = Array.isArray(me?.contacts) ? me.contacts : [];
      const contactsListDocs = allowedContacts.length ? await Status.find({ userCode: { $in: allowedContacts } }) : [];
      socket.emit('status-data', { myStatus, contactStatuses: contactsListDocs.map(s => s.toObject()) });
    } catch (e) {}
  });

  socket.on('post-status', async (statusItem, callback) => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      const newItem = { ...statusItem, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), viewers: [] };
      await Status.findOneAndUpdate({ userCode: currentUserCode }, { $setOnInsert: { name: me?.fullName || 'User', avatar: me?.avatar || '' }, $set: { name: me?.fullName || 'User', avatar: me?.avatar || '' }, $push: { items: newItem } }, { upsert: true, new: true });
      callback && callback({ success: true });
    } catch (e) { callback && callback({ success: false, error: e.message }); }
  });

  socket.on('delete-status', async ({ statusId }, cb) => {
    if (!currentUserCode) return cb && cb({ success: false });
    try { await Status.updateOne({ userCode: currentUserCode }, { $pull: { items: { id: statusId } } }); cb && cb({ success: true }); }
    catch (e) { cb && cb({ success: false }); }
  });

  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const ids = Array.isArray(me?.contacts) ? me.contacts : [];
      const allUsers = ids.length ? await User.find({ userCode: { $in: ids } }) : [];
      socket.emit('contact-list-data', { contacts: allUsers.map(u => ({ userCode: u.userCode, name: u.fullName, avatar: u.avatar })) });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    if (!currentUserCode) return cb({ success:false, error:'Not authenticated.' });
    try {
      const raw = String(query || targetCode || '').trim().toLowerCase();
      if (!raw) return cb({ success:false, error:'Enter a User ID or mobile number.' });
      
      const clean = raw.startsWith('@') ? raw : '@' + raw;
      const targetUser = /^\d{10,13}$/.test(raw)
        ? await User.findOne({ mobile: raw })
        : await User.findOne({ userCode: clean });

      if (!targetUser) return cb({ success:false, error:'User not found.' });
      if (targetUser.userCode === currentUserCode) return cb({ success:false, error:'You cannot add yourself.' });

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: targetUser.userCode } });
      await User.updateOne({ userCode: targetUser.userCode }, { $addToSet: { contacts: currentUserCode } });
      cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar } });
    } catch (e) { cb({ success: false, error: 'Error finding user.' }); }
  });

  socket.on('update-profile', async ({ fullName, avatar, dateOfBirth }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      const update = {};
      if (typeof fullName === 'string' && fullName.trim()) update.fullName = fullName.trim().slice(0, 80);
      if (typeof avatar === 'string') update.avatar = avatar;
      if (typeof dateOfBirth === 'string') update.dateOfBirth = dateOfBirth.slice(0, 20);
      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      if (!user) return callback && callback({ success: false, error: 'User not found.' });
      callback && callback({ success: true, user: user.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Profile update failed.' }); }
  });

  socket.on('get-messages', async ({ targetCode }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      const clean = String(targetCode || '').toLowerCase();
      const messages = await Message.find({
        $or: [
          { senderCode: currentUserCode, receiverCode: clean },
          { senderCode: clean, receiverCode: currentUserCode }
        ],
        deletedFor: { $ne: currentUserCode }
      }).sort({ createdAt: 1 }).limit(500).lean();
      callback && callback({ success: true, messages });
    } catch (e) { callback && callback({ success: false, error: 'Could not load messages.' }); }
  });

  socket.on('send-message', async ({ targetCode, text, media, messageType, duration, clientMessageId }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    const receiverCode = String(targetCode || '').trim().toLowerCase();
    const messageText = String(text || '').trim();
    const type = messageType === 'audio' ? 'audio' : 'text';
    if (!receiverCode || (type === 'text' && !messageText) || (type === 'audio' && !media)) return callback && callback({ success: false, error: 'Empty message.' });
    try {
      const other = await User.findOne({ userCode: receiverCode }).lean();
      if (!other) return callback && callback({ success: false, error: 'User not found.' });
      
      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: receiverCode } });
      await User.updateOne({ userCode: receiverCode }, { $addToSet: { contacts: currentUserCode } });

      const msg = await Message.create({
        messageId: String(clientMessageId || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'))),
        senderCode: currentUserCode, receiverCode, text: messageText, media: type === 'audio' ? String(media) : '', messageType: type, duration: Number(duration || 0)
      });
      io.to(currentUserCode).to(receiverCode).emit('new-message', msg.toObject());
      callback && callback({ success: true, message: msg.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Message failed.' }); }
  });

  socket.on('disconnect', () => {
    if (currentUserCode) io.emit('user-online-status', { targetCode: currentUserCode, isOnline: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
