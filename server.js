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

// Media Upload Stream with Chunking for large videos
function uploadBufferToCloudinary(buffer, folder, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'auto', folder, chunk_size: 6000000, ...options }, 
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
}).then(async () => {
  console.log('MongoDB connected successfully');
}).catch(err => console.error('MongoDB connection error:', err.message));

const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><path fill='%239ca3af' d='M256 288c79.5 0 144-64.5 144-144S335.5 0 256 0 112 64.5 112 144s64.5 144 144 144zm128 32h-55.1c-22.2 10.2-47.5 16-72.9 16s-50.6-5.8-72.9-16H128C57.3 320 0 377.3 0 448v16c0 26.5 21.5 48 48 48h416c26.5 0 48-21.5 48-48v-16c0-70.7-57.3-128-128-128z'/></svg>";

const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  mobile: { type: String, required: true },
  avatar: { type: String, default: DEFAULT_AVATAR },
  secQ1: { type: String, default: '' },
  secQ2: { type: String, default: '' },
  secQ3: { type: String, default: '' },
  contacts: { type: [String], default: [] }
});
const User = mongoose.model('User', userSchema);

const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ id: String, media: String, type: String, time: String, expiresAt: Date, viewers: [viewerSchema] }, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

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

io.on('connection', (socket) => {
  let currentUserCode = null;

  socket.on('set-socket-user', ({ userCode }, callback) => {
    if (userCode) {
      currentUserCode = String(userCode).trim().toLowerCase();
      socket.join(currentUserCode);
      const token = makeUploadToken(currentUserCode);
      if (typeof callback === 'function') callback({ success: true, token });
    }
  });

  socket.on('register-custom', async ({ userCode, password, fullName, mobile, avatar, q1, q2 }, callback) => {
    const rawId = String(userCode || '').trim().toLowerCase();
    const passStr = String(password || '').trim();
    const cleanMobile = String(mobile || '').trim();
    try {
      if (!rawId.startsWith('@') || rawId.length < 5) return callback({ success: false, error: 'User ID must start with @ and have 4+ characters.' });
      if (!cleanMobile || cleanMobile.length < 10) return callback({ success: false, error: 'Valid mobile number required.' });
      if (passStr.length !== 8) return callback({ success: false, error: 'Password must be strictly 8 digits.' });

      let avatarUrl = avatar || DEFAULT_AVATAR;
      if (avatar && avatar.startsWith('data:image') && !avatar.includes('<svg')) {
        // High quality auto-compression for DPs
        const uploadRes = await cloudinary.uploader.upload(avatar, { folder: 'chat_app_avatars', width: 500, crop: "scale", quality: "auto" });
        avatarUrl = uploadRes.secure_url;
      }

      const existingUser = await User.findOne({ userCode: rawId });
      if (existingUser) return callback({ success: false, error: 'User ID already taken.' });

      const newUser = await User.create({
        userCode: rawId, password: passStr, fullName: fullName?.trim() || 'User',
        mobile: cleanMobile, avatar: avatarUrl, secQ1: q1?.trim().toLowerCase() || '',
        secQ2: q2?.trim().toLowerCase() || ''
      });

      currentUserCode = rawId; socket.join(rawId);
      callback({ success: true, user: newUser });
    } catch (e) { callback({ success: false, error: 'Registration error: ' + e.message }); }
  });

  socket.on('auth-user', async ({ userCode, password }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();
    try {
      const isMobileQuery = /^\d{10,13}$/.test(query);
      const normalizedId = isMobileQuery ? null : (query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase());
      const userObj = await User.findOne({ $or: [ ...(normalizedId ? [{ userCode: normalizedId }] : []), ...(isMobileQuery ? [{ mobile: query }] : []) ] });
      if (!userObj || userObj.password !== passStr) return callback({ success: false, error: 'Invalid ID or password.' });

      currentUserCode = userObj.userCode; socket.join(currentUserCode);
      return callback({ success: true, user: userObj });
    } catch (err) { return callback({ success: false, error: 'Auth error: ' + err.message }); }
  });

  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      // Sorting conceptually handles recently added, but dynamic reordering is handled via frontend updates
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const ids = Array.isArray(me?.contacts) ? me.contacts : [];
      const allUsers = ids.length ? await User.find({ userCode: { $in: ids } }) : [];
      socket.emit('contact-list-data', { contacts: allUsers.map(u => ({ userCode: u.userCode, name: u.fullName, avatar: u.avatar || DEFAULT_AVATAR, mobile: u.mobile })) });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    if (!currentUserCode) return cb({ success:false, error:'Not authenticated.' });
    try {
      const raw = String(query || targetCode || '').trim().toLowerCase();
      if (!raw) return cb({ success:false, error:'Enter User ID or mobile.' });
      const clean = raw.startsWith('@') ? raw : '@' + raw;
      const targetUser = /^\d{10,13}$/.test(raw) ? await User.findOne({ mobile: raw }) : await User.findOne({ userCode: clean });

      if (!targetUser) return cb({ success:false, error:'User not found.' });
      if (targetUser.userCode === currentUserCode) return cb({ success:false, error:'Cannot add yourself.' });

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: targetUser.userCode } });
      await User.updateOne({ userCode: targetUser.userCode }, { $addToSet: { contacts: currentUserCode } });
      cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar || DEFAULT_AVATAR } });
    } catch (e) { cb({ success: false, error: 'Error finding user.' }); }
  });

  // Profile Edit
  socket.on('update-profile', async ({ fullName, avatar, secQ1, secQ2 }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      let avatarUrl = avatar;
      if (avatar && avatar.startsWith('data:image') && !avatar.includes('<svg')) {
        // High quality auto-compression when changing DP
        const uploadRes = await cloudinary.uploader.upload(avatar, { folder: 'chat_app_avatars', width: 500, crop: "scale", quality: "auto" });
        avatarUrl = uploadRes.secure_url;
      }
      const update = {};
      if (typeof fullName === 'string') update.fullName = fullName.trim() || 'User';
      if (typeof avatarUrl === 'string') update.avatar = avatarUrl;
      if (typeof secQ1 === 'string') update.secQ1 = secQ1.trim().toLowerCase();
      if (typeof secQ2 === 'string') update.secQ2 = secQ2.trim().toLowerCase();
      
      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      callback && callback({ success: true, user: user.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Update failed.' }); }
  });

  socket.on('get-messages', async ({ targetCode, after }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      const clean = String(targetCode || '').toLowerCase();
      const base = { $or: [{ senderCode: currentUserCode, receiverCode: clean }, { senderCode: clean, receiverCode: currentUserCode }], deletedFor: { $ne: currentUserCode } };
      const messages = await Message.find(after ? { $and: [base, { createdAt: { $gt: new Date(after) } }] } : base).sort({ createdAt: 1 }).limit(500).lean();
      callback && callback({ success: true, messages, full: !after });
    } catch (e) { callback && callback({ success: false, error: 'Could not load messages.' }); }
  });

  socket.on('send-message', async ({ targetCode, text, media, messageType, fileName, clientMessageId }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    const receiverCode = String(targetCode || '').trim().toLowerCase();
    const type = ['image', 'video', 'audio', 'document'].includes(messageType) ? messageType : 'text';
    if (!receiverCode || (type === 'text' && !text) || (type !== 'text' && !media)) return callback && callback({ success: false, error: 'Empty content.' });

    try {
      let mediaUrl = media;
      if (mediaUrl && mediaUrl.startsWith('data:')) {
        const uploadRes = await cloudinary.uploader.upload(mediaUrl, { resource_type: 'auto', folder: 'chat_app_media', chunk_size: 6000000 });
        mediaUrl = uploadRes.secure_url;
      }
      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: receiverCode } });
      await User.updateOne({ userCode: receiverCode }, { $addToSet: { contacts: currentUserCode } });

      const uniqueMsgId = String(clientMessageId || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')));
      const msg = await Message.create({
        messageId: uniqueMsgId, senderCode: currentUserCode, receiverCode, 
        text: String(text || ''), media: type !== 'text' ? String(mediaUrl) : '', 
        messageType: type, fileName: String(fileName || ''), status: 'sent'
      });
      
      io.to(receiverCode).emit('new-message', msg.toObject());
      callback && callback({ success: true, message: msg.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Message failed: ' + e.message }); }
  });

  socket.on('mark-message-read', async ({ messageId, senderCode }) => {
    try {
      await Message.updateOne({ messageId }, { status: 'delivered' });
      io.to(senderCode).emit('message-status-update', { messageId, status: 'delivered' });
    } catch (e) {}
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
