const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');

const app = express();
const server = http.createServer(app);

// Large File Upload Limit for Socket.io (Up to 500MB)
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 5e8 
});

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

const uploadTokens = new Map();
function makeUploadToken(userCode) {
  const token = crypto.randomBytes(32).toString('hex');
  uploadTokens.set(token, { userCode: String(userCode).toLowerCase(), expiresAt: Date.now() + 30 * 60 * 1000 });
  return token;
}
function validateUploadToken(token, userCode) {
  const row = uploadTokens.get(String(token || ''));
  if (!row || row.expiresAt < Date.now() || row.userCode !== String(userCode || '').toLowerCase()) return false;
  return true;
}

// Media Upload Stream with Chunking & Aggressive Compression for Chat Media
function uploadBufferToCloudinary(buffer, folder, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder, chunk_size: 6000000, quality: 'auto:eco', fetch_format: 'auto', ...options }, 
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

app.post('/api/upload-media', upload.single('media'), async (req, res) => {
  try {
    const userCode = String(req.headers['x-user-code'] || '').trim().toLowerCase();
    const token = String(req.headers['x-upload-token'] || '');
    if (!userCode || !validateUploadToken(token, userCode)) return res.status(401).json({ success:false, error:'Upload session expired.' });
    if (!req.file) return res.status(400).json({ success:false, error:'No media file received.' });
    const user = await User.findOne({ userCode }).lean();
    if (!user) return res.status(401).json({ success:false, error:'User not found.' });
    const result = await uploadBufferToCloudinary(req.file.buffer, 'chat_app_media');
    return res.json({ success:true, url:result.secure_url, resourceType:result.resource_type, bytes:req.file.size });
  } catch (e) {
    return res.status(500).json({ success:false, error:'Media upload failed: ' + e.message });
  }
});

// CLOUDINARY CREDENTIALS
cloudinary.config({
  cloud_name: 'gr8tp1tg',
  api_key: '668573837891895',
  api_secret: 'dTJqIvLUKWLJUft-FH8rpnIPlYs'
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, time: new Date().toISOString() }));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat-app';
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000
}).then(async () => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err.message));

const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><path fill='%239ca3af' d='M256 288c79.5 0 144-64.5 144-144S335.5 0 256 0 112 64.5 112 144s64.5 144 144 144zm128 32h-55.1c-22.2 10.2-47.5 16-72.9 16s-50.6-5.8-72.9-16H128C57.3 320 0 377.3 0 448v16c0 26.5 21.5 48 48 48h416c26.5 0 48-21.5 48-48v-16c0-70.7-57.3-128-128-128z'/></svg>";

const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  mobile: { type: String, required: true },
  avatar: { type: String, default: DEFAULT_AVATAR },
  secQ1: { type: String, default: '' },
  secQ2: { type: String, default: '' },
  contacts: { type: [String], default: [] },
  blockedUsers: { type: [String], default: [] },
  lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  messageId: { type: String, unique: true, required: true, index: true },
  senderCode: { type: String, required: true, index: true, lowercase: true },
  receiverCode: { type: String, required: true, index: true, lowercase: true },
  text: { type: String, default: '' },
  media: { type: String, default: '' },
  messageType: { type: String, default: 'text' },
  fileName: { type: String, default: '' },
  status: { type: String, default: 'sent' },
  createdAt: { type: Date, default: Date.now, index: true },
  deletedFor: { type: [String], default: [] } 
});
const Message = mongoose.model('Message', messageSchema);

// Additional schemas for Reels (Status)
const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ id: String, media: String, type: String, time: String, expiresAt: Date, viewers: [viewerSchema] }, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

// Tracking online users
const userSockets = new Map();

io.on('connection', (socket) => {
  let currentUserCode = null;

  socket.on('set-socket-user', ({ userCode }, callback) => {
    if (userCode) {
      currentUserCode = String(userCode).trim().toLowerCase();
      socket.join(currentUserCode);
      
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      User.updateOne({ userCode: currentUserCode }, { lastSeen: new Date() }).exec();
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });

      const token = makeUploadToken(currentUserCode);
      if (typeof callback === 'function') callback({ success: true, token });
    }
  });

  socket.on('typing', ({ targetCode }) => {
    if(currentUserCode) io.to(targetCode).emit('typing', { senderCode: currentUserCode });
  });
  socket.on('stop-typing', ({ targetCode }) => {
    if(currentUserCode) io.to(targetCode).emit('stop-typing', { senderCode: currentUserCode });
  });

  socket.on('check-status', async ({ targetCode }, cb) => {
    const isOnline = userSockets.has(targetCode);
    if (isOnline) return cb({ isOnline: true });
    try {
      const u = await User.findOne({ userCode: targetCode }, 'lastSeen').lean();
      cb({ isOnline: false, lastSeen: u?.lastSeen });
    } catch(e) { cb({ isOnline: false }); }
  });

  socket.on('register-custom', async (data, callback) => {
    try {
      const rawId = String(data.userCode || '').trim().toLowerCase();
      const rawAvatarUrl = data.avatar;
      
      const existingUser = await User.findOne({ userCode: rawId });
      if (existingUser) return callback({ success: false, error: 'User ID already taken.' });

      // Create user immediately (Non-Blocking for UI)
      const newUser = await User.create({
        userCode: rawId, password: data.password.trim(), fullName: data.fullName?.trim() || 'User',
        mobile: data.mobile.trim(), avatar: DEFAULT_AVATAR, secQ1: data.q1?.trim().toLowerCase() || '',
        secQ2: data.q2?.trim().toLowerCase() || ''
      });
      
      currentUserCode = rawId; socket.join(rawId);
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });

      callback({ success: true, user: newUser }); // Send success instantly

      // Process and compress DP in Background (Shrink 70%)
      if (rawAvatarUrl && rawAvatarUrl.startsWith('data:image') && !rawAvatarUrl.includes('<svg')) {
        cloudinary.uploader.upload(rawAvatarUrl, { folder: 'chat_app_avatars', width: 400, crop: "scale", quality: "auto:eco", fetch_format: "auto" })
          .then(uploadRes => User.updateOne({ userCode: rawId }, { avatar: uploadRes.secure_url }).exec())
          .catch(e => console.error('Avatar bg upload error:', e.message));
      }
    } catch (e) { callback({ success: false, error: 'Registration error: ' + e.message }); }
  });

  socket.on('auth-user', async ({ userCode, password }, callback) => {
    try {
      const query = String(userCode || '').trim();
      const isMobileQuery = /^\d{10,13}$/.test(query);
      const normalizedId = isMobileQuery ? null : (query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase());
      const userObj = await User.findOne({ $or: [ ...(normalizedId ? [{ userCode: normalizedId }] : []), ...(isMobileQuery ? [{ mobile: query }] : []) ] });
      if (!userObj || userObj.password !== String(password || '').trim()) return callback({ success: false, error: 'Invalid ID or password.' });
      
      currentUserCode = userObj.userCode; socket.join(currentUserCode);
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      User.updateOne({ userCode: currentUserCode }, { lastSeen: new Date() }).exec();
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });

      callback({ success: true, user: userObj });
    } catch (err) { callback({ success: false, error: 'Auth error.' }); }
  });

  // Updated: Recover Account Logic
  socket.on('recover-account', async ({ mobile, q1, q2, newPassword }, callback) => {
    try {
      const cleanMobile = String(mobile || '').trim();
      const cleanQ1 = String(q1 || '').trim().toLowerCase();
      const cleanQ2 = String(q2 || '').trim().toLowerCase();
      const cleanPass = String(newPassword || '').trim();

      if (!cleanMobile || !cleanPass) return callback({ success: false, error: 'Mobile and new password are required.' });
      if (cleanPass.length !== 8) return callback({ success: false, error: 'Password must be exactly 8 digits.' });

      const user = await User.findOne({ mobile: cleanMobile });
      if (!user) return callback({ success: false, error: 'User not found with this mobile number.' });

      const q1Match = cleanQ1 && user.secQ1 === cleanQ1;
      const q2Match = cleanQ2 && user.secQ2 === cleanQ2;

      if (!q1Match && !q2Match) return callback({ success: false, error: 'Security answers do not match.' });

      await User.updateOne({ _id: user._id }, { password: cleanPass });
      callback({ success: true, message: `Success! Your User ID is ${user.userCode}` });
    } catch (err) { callback({ success: false, error: 'Recovery failed. Please try again.' }); }
  });

  // Updated: Get Contacts (Sorted by latest message)
  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const ids = Array.isArray(me?.contacts) ? me.contacts : [];
      if (!ids.length) return socket.emit('contact-list-data', { contacts: [] });

      const allUsers = await User.find({ userCode: { $in: ids } }).lean();
      
      const contactsWithTime = await Promise.all(allUsers.map(async u => {
        const lastMsg = await Message.findOne({
          $or: [{ senderCode: currentUserCode, receiverCode: u.userCode }, { senderCode: u.userCode, receiverCode: currentUserCode }],
          deletedFor: { $ne: currentUserCode }
        }).sort({ createdAt: -1 }).lean();
        return { userCode: u.userCode, name: u.fullName, avatar: u.avatar || DEFAULT_AVATAR, lastMsgTime: lastMsg ? new Date(lastMsg.createdAt).getTime() : 0 };
      }));

      contactsWithTime.sort((a, b) => b.lastMsgTime - a.lastMsgTime);
      socket.emit('contact-list-data', { contacts: contactsWithTime.map(c => ({ userCode: c.userCode, name: c.name, avatar: c.avatar })) });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    if (!currentUserCode) return cb({ success:false, error:'Not authenticated.' });
    try {
      const raw = String(query || targetCode || '').trim().toLowerCase();
      const clean = raw.startsWith('@') ? raw : '@' + raw;
      const targetUser = /^\d{10,13}$/.test(raw) ? await User.findOne({ mobile: raw }) : await User.findOne({ userCode: clean });
      if (!targetUser) return cb({ success:false, error:'User not found.' });
      if (targetUser.userCode === currentUserCode) return cb({ success:false, error:'Cannot add yourself.' });

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: targetUser.userCode } });
      cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar || DEFAULT_AVATAR } });
    } catch (e) { cb({ success: false, error: 'Error finding user.' }); }
  });

  socket.on('update-profile', async (data, callback) => {
    if (!currentUserCode) return callback({ success: false });
    try {
      let avatarUrl = data.avatar;
      const update = { fullName: data.fullName?.trim() || 'User', secQ1: data.secQ1?.trim().toLowerCase(), secQ2: data.secQ2?.trim().toLowerCase() };
      
      // Update immediately, compress avatar in background
      if (avatarUrl && avatarUrl.startsWith('data:image') && !avatarUrl.includes('<svg')) {
         cloudinary.uploader.upload(avatarUrl, { folder: 'chat_app_avatars', width: 400, crop: "scale", quality: "auto:eco", fetch_format: "auto" })
          .then(uploadRes => User.updateOne({ userCode: currentUserCode }, { avatar: uploadRes.secure_url }).exec())
          .catch(e => console.log(e));
      } else if (avatarUrl) {
         update.avatar = avatarUrl;
      }

      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      callback({ success: true, user: user.toObject() });
    } catch (e) { callback({ success: false }); }
  });

  socket.on('get-messages', async ({ targetCode, after }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false });
    try {
      const clean = String(targetCode || '').toLowerCase();
      const base = { $or: [{ senderCode: currentUserCode, receiverCode: clean }, { senderCode: clean, receiverCode: currentUserCode }], deletedFor: { $ne: currentUserCode } };
      const messages = await Message.find(after ? { $and: [base, { createdAt: { $gt: new Date(after) } }] } : base).sort({ createdAt: 1 }).limit(500).lean();
      callback && callback({ success: true, messages, full: !after });
    } catch (e) { callback && callback({ success: false }); }
  });

  socket.on('send-message', async (data, callback) => {
    if (!currentUserCode) return callback && callback({ success: false });
    try {
      const receiver = await User.findOne({ userCode: data.targetCode });
      if (receiver?.blockedUsers?.includes(currentUserCode)) {
         return callback({ success: true, message: { ...data, status: 'sent', senderCode: currentUserCode, receiverCode: data.targetCode } });
      }

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: data.targetCode } });
      await User.updateOne({ userCode: data.targetCode }, { $addToSet: { contacts: currentUserCode } });

      const msg = await Message.create({
        messageId: data.clientMessageId || ('msg_' + Date.now()), senderCode: currentUserCode, receiverCode: data.targetCode, 
        text: data.text || '', media: data.media || '', messageType: data.messageType || 'text', fileName: data.fileName || '', status: 'sent'
      });
      
      io.to(data.targetCode).emit('new-message', msg.toObject());
      callback && callback({ success: true, message: msg.toObject() });
    } catch (e) { callback && callback({ success: false }); }
  });

  socket.on('clear-chat', async ({ targetCode }, cb) => {
    if (!currentUserCode) return;
    try {
      await Message.updateMany(
        { $or: [{senderCode: currentUserCode, receiverCode: targetCode}, {senderCode: targetCode, receiverCode: currentUserCode}] },
        { $addToSet: { deletedFor: currentUserCode } }
      );
      cb({ success: true });
    } catch(e) { cb({ success: false }); }
  });

  // Updated: Delete Single Message (For Me / Everyone)
  socket.on('delete-message', async ({ messageId, type }, cb) => {
    if (!currentUserCode) return;
    try {
      const msg = await Message.findOne({ messageId });
      if (!msg) return cb({ success: false });

      if (type === 'everyone' && msg.senderCode === currentUserCode) {
        await Message.deleteOne({ messageId }); 
        io.to(msg.senderCode).emit('message-deleted-ui', { messageId });
        io.to(msg.receiverCode).emit('message-deleted-ui', { messageId });
      } else {
        await Message.updateOne({ messageId }, { $addToSet: { deletedFor: currentUserCode } });
        socket.emit('message-deleted-ui', { messageId });
      }
      cb({ success: true });
    } catch(e) { cb({ success: false }); }
  });

  socket.on('block-user', async ({ targetCode }, cb) => {
    if (!currentUserCode) return;
    await User.updateOne({ userCode: currentUserCode }, { $addToSet: { blockedUsers: targetCode }, $pull: { contacts: targetCode } });
    cb({ success: true });
  });

  socket.on('delete-contact', async ({ targetCode }, cb) => {
    if (!currentUserCode) return;
    await User.updateOne({ userCode: currentUserCode }, { $pull: { contacts: targetCode } });
    await Message.updateMany(
        { $or: [{senderCode: currentUserCode, receiverCode: targetCode}, {senderCode: targetCode, receiverCode: currentUserCode}] },
        { $addToSet: { deletedFor: currentUserCode } }
    );
    cb({ success: true });
  });

  socket.on('mark-message-read', async ({ messageId, senderCode }) => {
    await Message.updateOne({ messageId }, { status: 'delivered' });
    io.to(senderCode).emit('message-status-update', { messageId, status: 'delivered' });
  });

  socket.on('ping-server', () => {
    // Lightweight keep-alive for background anti-sleep
  });

  socket.on('disconnect', () => {
    if (currentUserCode && userSockets.has(currentUserCode)) {
      userSockets.get(currentUserCode).delete(socket.id);
      if (userSockets.get(currentUserCode).size === 0) {
        userSockets.delete(currentUserCode);
        const now = new Date();
        User.updateOne({ userCode: currentUserCode }, { lastSeen: now }).exec();
        io.emit('user-status-changed', { userCode: currentUserCode, isOnline: false, lastSeen: now });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// AUTOMATIC SELF-PING TO PREVENT RENDER SLEEP (Every 14 minutes)
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const client = APP_URL.startsWith('https') ? https : http;
  client.get(APP_URL + '/health', (resp) => {
    console.log('Keep-alive ping sent successfully.');
  }).on("error", (err) => {
    console.log("Ping error: " + err.message);
  });
}, 14 * 60 * 1000); 
