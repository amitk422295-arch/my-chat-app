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

// 👇 यहाँ 50MB लिमिट ऐड की गई है
const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 5e7 
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
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
function uploadBufferToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: 'auto', folder }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

app.post('/api/upload-media', upload.single('media'), async (req, res) => {
  try {
    const userCode = String(req.headers['x-user-code'] || '').trim().toLowerCase();
    const token = String(req.headers['x-upload-token'] || '');
    if (!userCode || !validateUploadToken(token, userCode)) return res.status(401).json({ success:false, error:'Upload session expired. Please reconnect.' });
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
}).then(async () => {
  console.log('MongoDB connected successfully');
  try {
    await mongoose.connection.collection('messages').dropIndex('id_1').catch(() => {});
  } catch(e) {}
}).catch(err => console.error('MongoDB connection error:', err.message));

const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  mobile: { type: String, required: true },
  avatar: { type: String, default: '' },
  secQ1: { type: String, default: '' },
  secQ2: { type: String, default: '' },
  secQ3: { type: String, default: '' },
  blockedByMe: { type: Map, of: Boolean, default: {} },
  contacts: { type: [String], default: [] },
  dateOfBirth: { type: String, default: '' }
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
  messageType: { type: String, enum: ['text', 'image', 'video', 'audio', 'document'], default: 'text' },
  fileName: { type: String, default: '' },
  duration: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, index: true },
  deletedForEveryone: { type: Boolean, default: false },
  deletedFor: { type: [String], default: [] }
});
messageSchema.index({ senderCode: 1, receiverCode: 1, createdAt: 1 });
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

  socket.on('register-custom', async ({ userCode, password, fullName, mobile, avatar, q1, q2, q3 }, callback) => {
    const rawId = String(userCode || '').trim().toLowerCase();
    const passStr = String(password || '').trim();
    const cleanMobile = String(mobile || '').trim();

    try {
      if (!rawId.startsWith('@') || rawId.length < 5) {
        return callback({ success: false, error: 'User ID must start with @ and have at least 4 characters after it.' });
      }
      if (!cleanMobile || cleanMobile.length < 10) {
        return callback({ success: false, error: 'Valid mobile number is compulsory.' });
      }
      if (passStr.length !== 8) {
        return callback({ success: false, error: 'Password must be strictly 8 digits.' });
      }
      const cleanQ1 = String(q1 || '').trim().toLowerCase();
      const cleanQ2 = String(q2 || '').trim().toLowerCase();
      const cleanQ3 = String(q3 || '').trim().toLowerCase();

      if (!cleanQ1 && !cleanQ2 && !cleanQ3) {
        return callback({ success: false, error: 'Minimum one security question answer is required.' });
      }

      let avatarUrl = avatar || '';
      if (avatar && avatar.startsWith('data:image')) {
        const uploadRes = await cloudinary.uploader.upload(avatar, { folder: 'chat_app_avatars' });
        avatarUrl = uploadRes.secure_url;
      }

      const existingUser = await User.findOne({ userCode: rawId });
      if (existingUser) return callback({ success: false, error: 'This User ID is already taken.' });

      const existingMobile = await User.findOne({ mobile: cleanMobile });
      if (existingMobile) return callback({ success: false, error: 'Mobile number already registered.' });

      const newUser = await User.create({
        userCode: rawId,
        password: passStr,
        fullName: fullName && fullName.trim() ? fullName.trim() : 'User',
        mobile: cleanMobile,
        avatar: avatarUrl,
        secQ1: cleanQ1,
        secQ2: cleanQ2,
        secQ3: cleanQ3,
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

  socket.on('recover-account', async ({ mobile, q1, q2, q3, newPassword }, callback) => {
    const cleanMobile = String(mobile || '').trim();
    const ans1 = String(q1 || '').trim().toLowerCase();
    const ans2 = String(q2 || '').trim().toLowerCase();
    const ans3 = String(q3 || '').trim().toLowerCase();
    const newPass = String(newPassword || '').trim();

    try {
      const userObj = await User.findOne({ mobile: cleanMobile });
      if (!userObj) return callback({ success: false, error: 'Mobile number not found in database.' });

      let matchesCount = 0;
      let totalProvided = 0;
      let hasMismatch = false;

      if (ans1) { totalProvided++; if (userObj.secQ1 && userObj.secQ1 === ans1) matchesCount++; else hasMismatch = true; }
      if (ans2) { totalProvided++; if (userObj.secQ2 && userObj.secQ2 === ans2) matchesCount++; else hasMismatch = true; }
      if (ans3) { totalProvided++; if (userObj.secQ3 && userObj.secQ3 === ans3) matchesCount++; else hasMismatch = true; }

      if (totalProvided === 0 || hasMismatch || matchesCount === 0) {
        return callback({ success: false, error: 'Authentication failed! Incorrect security answers.' });
      }

      if (newPass && newPass.length === 8) {
        userObj.password = newPass;
        await userObj.save();
        return callback({ success: true, userCode: userObj.userCode, message: 'Password updated & Account recovered successfully!' });
      } else {
        return callback({ success: true, userCode: userObj.userCode, message: 'Your User ID is: ' + userObj.userCode });
      }
    } catch (e) {
      callback({ success: false, error: 'Recovery failed: ' + e.message });
    }
  });

  socket.on('get-statuses', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      let myStatusDoc = await Status.findOne({ userCode: currentUserCode });
      const myStatus = myStatusDoc ? myStatusDoc.toObject() : { userCode: currentUserCode, name: me?.fullName, avatar: me?.avatar, items: [] };
      const now = new Date();
      await Status.updateMany({}, { $pull: { items: { expiresAt: { $lte: now } } } });
      myStatusDoc = await Status.findOne({ userCode: currentUserCode });
      const refreshedMy = myStatusDoc ? myStatusDoc.toObject() : myStatus;
      const allowedContacts = Array.isArray(me?.contacts) ? me.contacts : [];
      const contactsListDocs = allowedContacts.length ? await Status.find({ userCode: { $in: allowedContacts } }) : [];
      socket.emit('status-data', { myStatus: refreshedMy, contactStatuses: contactsListDocs.map(s => s.toObject()) });
    } catch (e) {}
  });

  socket.on('post-status', async (statusItem, callback) => {
    if (!currentUserCode) return;
    try {
      let mediaUrl = statusItem.media;
      if (mediaUrl && mediaUrl.startsWith('data:')) {
        const uploadRes = await cloudinary.uploader.upload(mediaUrl, { resource_type: 'auto', folder: 'chat_app_statuses' });
        mediaUrl = uploadRes.secure_url;
      }
      const me = await User.findOne({ userCode: currentUserCode });
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const newItem = { ...statusItem, media: mediaUrl, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), expiresAt, viewers: [] };
      await Status.findOneAndUpdate({ userCode: currentUserCode }, { $setOnInsert: { name: me?.fullName || 'User', avatar: me?.avatar || '' }, $set: { name: me?.fullName || 'User', avatar: me?.avatar || '' }, $push: { items: newItem } }, { upsert: true, new: true });
      callback && callback({ success: true, expiresAt });
      for (const c of (me?.contacts || [])) io.to(c).emit('status-updated', { userCode: currentUserCode });
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
      let avatarUrl = avatar;
      if (avatar && avatar.startsWith('data:image')) {
        const uploadRes = await cloudinary.uploader.upload(avatar, { folder: 'chat_app_avatars' });
        avatarUrl = uploadRes.secure_url;
      }
      const update = {};
      if (typeof fullName === 'string') update.fullName = fullName.trim() ? fullName.trim().slice(0, 80) : 'User';
      if (typeof avatarUrl === 'string') update.avatar = avatarUrl;
      if (typeof dateOfBirth === 'string') update.dateOfBirth = dateOfBirth.slice(0, 20);
      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      if (!user) return callback && callback({ success: false, error: 'User not found.' });
      callback && callback({ success: true, user: user.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Profile update failed.' }); }
  });

  socket.on('get-messages', async ({ targetCode, after }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      const clean = String(targetCode || '').toLowerCase();
      const base = {
        $or: [
          { senderCode: currentUserCode, receiverCode: clean },
          { senderCode: clean, receiverCode: currentUserCode }
        ],
        deletedFor: { $ne: currentUserCode }
      };
      let query = base;
      let full = true;
      if (after) {
        const afterDate = new Date(after);
        if (!Number.isNaN(afterDate.getTime())) {
          query = { $and: [base, { createdAt: { $gt: afterDate } }] };
          full = false;
        }
      }
      const messages = await Message.find(query).sort({ createdAt: 1 }).limit(500).lean();
      callback && callback({ success: true, messages, full });
    } catch (e) { callback && callback({ success: false, error: 'Could not load messages.' }); }
  });

  socket.on('send-message', async ({ targetCode, text, media, messageType, fileName, duration, clientMessageId }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    const receiverCode = String(targetCode || '').trim().toLowerCase();
    const messageText = String(text || '').trim();
    const type = ['image', 'video', 'audio', 'document'].includes(messageType) ? messageType : 'text';
    
    if (!receiverCode || (type === 'text' && !messageText) || (type !== 'text' && !media)) {
      return callback && callback({ success: false, error: 'Empty message content.' });
    }

    try {
      let mediaUrl = media;
      if (mediaUrl && mediaUrl.startsWith('data:')) {
        const uploadRes = await cloudinary.uploader.upload(mediaUrl, { resource_type: 'auto', folder: 'chat_app_media' });
        mediaUrl = uploadRes.secure_url;
      }

      const other = await User.findOne({ userCode: receiverCode }).lean();
      if (!other) return callback && callback({ success: false, error: 'User not found.' });
      
      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: receiverCode } });
      await User.updateOne({ userCode: receiverCode }, { $addToSet: { contacts: currentUserCode } });

      const uniqueMsgId = String(clientMessageId || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')));
      const msg = await Message.create({
        messageId: uniqueMsgId,
        senderCode: currentUserCode, 
        receiverCode, 
        text: messageText, 
        media: type !== 'text' ? String(mediaUrl) : '', 
        messageType: type, 
        fileName: String(fileName || ''),
        duration: Number(duration || 0)
      });
      io.to(currentUserCode).to(receiverCode).emit('new-message', msg.toObject());
      callback && callback({ success: true, message: msg.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Message failed: ' + e.message }); }
  });

  socket.on('disconnect', () => {});
});

setInterval(() => {
  const now = Date.now();
  for (const [token, row] of uploadTokens) if (row.expiresAt < now) uploadTokens.delete(token);
}, 10 * 60 * 1000);

setInterval(async () => {
  try { await Status.updateMany({}, { $pull: { items: { expiresAt: { $lte: new Date() } } } }); } catch (e) {}
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setInterval(() => {
    const targetUrl = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}/health`;
    const client = targetUrl.startsWith('https') ? https : http;
    client.get(targetUrl, (res) => {}).on('error', () => {});
  }, 10 * 60 * 1000);
});
