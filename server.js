const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
  cors: { origin: '*' },
  maxHttpBufferSize: 5e8 
});

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Disk Storage Queue System (400MB Safe Upload)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

let activeUploadSize = 0;
const MAX_UPLOAD_SIZE = 400 * 1024 * 1024; 
const uploadQueue = [];

function processUploadQueue() {
  if (uploadQueue.length === 0) return;
  const nextUpload = uploadQueue[0];
  if (activeUploadSize > 0 && (activeUploadSize + nextUpload.file.size) > MAX_UPLOAD_SIZE) return; 

  const { file, folder, options, resolve, reject } = uploadQueue.shift();
  activeUploadSize += file.size;

  cloudinary.uploader.upload(file.path, { resource_type: 'auto', folder, quality: 'auto:eco', fetch_format: 'auto', ...options })
    .then(result => {
      activeUploadSize -= file.size; 
      fs.unlink(file.path, () => {}); 
      resolve(result);
      processUploadQueue(); 
    })
    .catch(err => {
      activeUploadSize -= file.size; 
      fs.unlink(file.path, () => {}); 
      reject(err);
      processUploadQueue(); 
    });
}

function queuedCloudinaryUpload(file, folder, options = {}) {
  return new Promise((resolve, reject) => {
    uploadQueue.push({ file, folder, options, resolve, reject });
    processUploadQueue();
  });
}

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

app.post('/api/upload-media', upload.single('media'), async (req, res) => {
  try {
    const userCode = String(req.headers['x-user-code'] || '').trim().toLowerCase();
    const token = String(req.headers['x-upload-token'] || '');
    const isStatus = req.headers['x-is-status'] === 'true'; 
    
    if (!userCode || !validateUploadToken(token, userCode)) {
       if (req.file) fs.unlink(req.file.path, () => {});
       return res.status(401).json({ success:false, error:'Upload session expired.' });
    }
    if (!req.file) return res.status(400).json({ success:false, error:'No media file received.' });
    
    const user = await User.findOne({ userCode }).lean();
    if (!user) {
       fs.unlink(req.file.path, () => {});
       return res.status(401).json({ success:false, error:'User not found.' });
    }

    const uploadOptions = isStatus && req.file.mimetype.startsWith('video/') ? { duration: 30 } : {};

    const result = await queuedCloudinaryUpload(req.file, isStatus ? 'chat_app_status' : 'chat_app_media', uploadOptions);
    
    if (isStatus) {
       await Status.findOneAndUpdate(
         { userCode }, 
         { name: user.fullName, avatar: user.avatar, $push: { items: { id: Date.now().toString(), media: result.secure_url, type: result.resource_type, time: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), viewers: [] } } },
         { upsert: true }
       );
    }
    
    return res.json({ success:true, url:result.secure_url, resourceType:result.resource_type, bytes:req.file.size });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ success:false, error:'Media upload failed.' });
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
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true }).then(() => console.log('MongoDB connected')).catch(e => console.error(e));

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

const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ id: String, media: String, type: String, time: String, expiresAt: Date, viewers: [viewerSchema] }, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

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

  socket.on('typing', ({ targetCode }) => { if(currentUserCode) io.to(targetCode).emit('typing', { senderCode: currentUserCode }); });
  socket.on('stop-typing', ({ targetCode }) => { if(currentUserCode) io.to(targetCode).emit('stop-typing', { senderCode: currentUserCode }); });

  socket.on('check-status', async ({ targetCode }, cb) => {
    const isOnline = userSockets.has(targetCode);
    if (isOnline) return cb({ isOnline: true });
    try { const u = await User.findOne({ userCode: targetCode }, 'lastSeen').lean(); cb({ isOnline: false, lastSeen: u?.lastSeen }); } 
    catch(e) { cb({ isOnline: false }); }
  });

  socket.on('register-custom', async (data, callback) => {
    try {
      const rawId = String(data.userCode || '').trim().toLowerCase();
      const existingUser = await User.findOne({ userCode: rawId });
      if (existingUser) return callback({ success: false, error: 'User ID already taken.' });

      const newUser = await User.create({
        userCode: rawId, password: data.password.trim(), fullName: data.fullName?.trim() || 'User',
        mobile: data.mobile.trim(), avatar: DEFAULT_AVATAR, secQ1: data.q1?.trim().toLowerCase() || '', secQ2: data.q2?.trim().toLowerCase() || ''
      });
      
      currentUserCode = rawId; socket.join(rawId);
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });

      callback({ success: true, user: newUser }); 

      if (data.avatar && data.avatar.startsWith('data:image')) {
        cloudinary.uploader.upload(data.avatar, { folder: 'chat_app_avatars', width: 400, crop: "scale", quality: "auto:eco", fetch_format: "auto" })
          .then(uploadRes => User.updateOne({ userCode: rawId }, { avatar: uploadRes.secure_url }).exec())
          .catch(e => console.error(e));
      }
    } catch (e) { callback({ success: false, error: 'Registration error.' }); }
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

  socket.on('recover-account', async ({ mobile, q1, q2, newPassword }, callback) => {
    try {
      const cleanMobile = String(mobile || '').trim();
      if (!cleanMobile || !newPassword) return callback({ success: false, error: 'Mobile and new password are required.' });
      const user = await User.findOne({ mobile: cleanMobile });
      if (!user) return callback({ success: false, error: 'User not found.' });

      const q1Match = q1 && user.secQ1 === String(q1).trim().toLowerCase();
      const q2Match = q2 && user.secQ2 === String(q2).trim().toLowerCase();

      if (!q1Match && !q2Match) return callback({ success: false, error: 'Security answers do not match.' });

      await User.updateOne({ _id: user._id }, { password: String(newPassword).trim() });
      callback({ success: true, message: `Success! Your User ID is ${user.userCode}` });
    } catch (err) { callback({ success: false, error: 'Recovery failed.' }); }
  });

  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const ids = Array.isArray(me?.contacts) ? me.contacts : [];
      if (!ids.length) return socket.emit('contact-list-data', { contacts: [] });

      const allUsers = await User.find({ userCode: { $in: ids } }).lean();
      
      const contactsWithTime = await Promise.all(allUsers.map(async u => {
        const lastMsg = await Message.findOne({
          $or: [{ senderCode: currentUserCode, receiverCode: u.userCode }, { senderCode: u.userCode, receiverCode: currentUserCode }], deletedFor: { $ne: currentUserCode }
        }).sort({ createdAt: -1 }).lean();
        
        const unreadCount = await Message.countDocuments({ senderCode: u.userCode, receiverCode: currentUserCode, status: 'sent', deletedFor: { $ne: currentUserCode } });
        
        // Active Status Check
        const activeStatus = await Status.findOne({ userCode: u.userCode, 'items.expiresAt': { $gt: new Date() } }).lean();

        return { userCode: u.userCode, name: u.fullName, avatar: u.avatar || DEFAULT_AVATAR, lastMsgTime: lastMsg ? new Date(lastMsg.createdAt).getTime() : 0, unreadCount, hasActiveStatus: !!activeStatus };
      }));

      contactsWithTime.sort((a, b) => b.lastMsgTime - a.lastMsgTime);
      socket.emit('contact-list-data', { contacts: contactsWithTime });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    if (!currentUserCode) return;
    try {
      const raw = String(query || targetCode || '').trim().toLowerCase();
      const clean = raw.startsWith('@') ? raw : '@' + raw;
      const targetUser = /^\d{10,13}$/.test(raw) ? await User.findOne({ mobile: raw }) : await User.findOne({ userCode: clean });
      if (!targetUser || targetUser.userCode === currentUserCode) return cb({ success:false, error:'Invalid user.' });

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: targetUser.userCode } });
      cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar || DEFAULT_AVATAR } });
    } catch (e) { cb({ success: false, error: 'Error finding user.' }); }
  });

  socket.on('update-profile', async (data, callback) => {
    if (!currentUserCode) return callback({ success: false });
    try {
      let avatarUrl = data.avatar;
      const update = { fullName: data.fullName?.trim() || 'User', secQ1: data.secQ1?.trim().toLowerCase(), secQ2: data.secQ2?.trim().toLowerCase() };
      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      callback({ success: true, user: user.toObject() });

      if (avatarUrl && avatarUrl.startsWith('data:image')) {
         cloudinary.uploader.upload(avatarUrl, { folder: 'chat_app_avatars', width: 400, crop: "scale", quality: "auto:eco", fetch_format: "auto" })
          .then(uploadRes => User.updateOne({ userCode: currentUserCode }, { avatar: uploadRes.secure_url }).exec())
          .catch(e => socket.emit('profile-upload-error', { error: 'DP upload failed.' }));
      }
    } catch (e) { callback({ success: false }); }
  });

  socket.on('get-messages', async ({ targetCode, after }, callback) => {
    if (!currentUserCode) return;
    try {
      const clean = String(targetCode || '').toLowerCase();
      const base = { $or: [{ senderCode: currentUserCode, receiverCode: clean }, { senderCode: clean, receiverCode: currentUserCode }], deletedFor: { $ne: currentUserCode } };
      const messages = await Message.find(after ? { $and: [base, { createdAt: { $gt: new Date(after) } }] } : base).sort({ createdAt: 1 }).limit(500).lean();
      callback({ success: true, messages, full: !after });
    } catch (e) { callback({ success: false }); }
  });

  socket.on('send-message', async (data, callback) => {
    if (!currentUserCode) return;
    try {
      const receiver = await User.findOne({ userCode: data.targetCode });
      if (receiver?.blockedUsers?.includes(currentUserCode)) return callback({ success: true, message: { ...data, status: 'sent', senderCode: currentUserCode, receiverCode: data.targetCode } });

      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { contacts: data.targetCode } });
      await User.updateOne({ userCode: data.targetCode }, { $addToSet: { contacts: currentUserCode } });

      const msg = await Message.create({
        messageId: data.clientMessageId || ('msg_' + Date.now()), senderCode: currentUserCode, receiverCode: data.targetCode, 
        text: data.text || '', media: data.media || '', messageType: data.messageType || 'text', fileName: data.fileName || '', status: 'sent'
      });
      
      io.to(data.targetCode).emit('new-message', msg.toObject());
      callback({ success: true, message: msg.toObject() });
    } catch (e) { callback({ success: false }); }
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

  socket.on('mark-all-read', async ({ senderCode }) => {
    if (!currentUserCode) return;
    await Message.updateMany({ senderCode: senderCode, receiverCode: currentUserCode, status: 'sent' }, { status: 'delivered' });
  });

  // --- CALLING FEATURE EVENTS ---
  socket.on('call-user', async (data) => {
    if(!currentUserCode) return;
    const isOnline = userSockets.has(data.targetCode);
    socket.emit('call-status', { status: isOnline ? 'Ringing...' : 'Calling...', targetCode: data.targetCode });
    if(isOnline) {
      const caller = await User.findOne({ userCode: currentUserCode }).lean();
      io.to(data.targetCode).emit('incoming-call', { 
        callerCode: currentUserCode, callerName: caller.fullName, callerAvatar: caller.avatar, offer: data.offer 
      });
    }
  });

  socket.on('answer-call', (data) => { io.to(data.callerCode).emit('call-answered', { answer: data.answer }); });
  socket.on('reject-call', (data) => { io.to(data.callerCode).emit('call-rejected'); });
  socket.on('end-call', (data) => { io.to(data.targetCode).emit('call-ended'); });
  socket.on('ice-candidate', (data) => { io.to(data.targetCode).emit('ice-candidate', { candidate: data.candidate }); });

  // Get active status logic for playback
  socket.on('get-user-status', async ({ targetCode }, cb) => {
    try {
      const statusData = await Status.findOne({ userCode: targetCode, 'items.expiresAt': { $gt: new Date() } }).lean();
      cb({ success: true, items: statusData?.items || [] });
    } catch (e) { cb({ success: false }); }
  });

  socket.on('ping-server', () => {});

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

const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const client = APP_URL.startsWith('https') ? https : http;
  client.get(APP_URL + '/health', () => {}).on("error", () => {});
}, 14 * 60 * 1000); 
