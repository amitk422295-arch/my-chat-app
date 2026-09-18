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
    .then(result => { activeUploadSize -= file.size; resolve(result); processUploadQueue(); })
    .catch(err => { activeUploadSize -= file.size; reject(err); processUploadQueue(); });
}

function queuedCloudinaryUpload(file, folder, options = {}) {
  return new Promise((resolve, reject) => { uploadQueue.push({ file, folder, options, resolve, reject }); processUploadQueue(); });
}

function getCloudinaryPublicId(url) {
   try { const parts = url.split('/'); const file = parts.pop(); const folder = parts.pop(); return folder + '/' + file.split('.')[0]; } 
   catch(e) { return null; }
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'gr8tp1tg',
  api_key: process.env.CLOUDINARY_API_KEY || '668573837891895',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'dTJqIvLUKWLJUft-FH8rpnIPlYs'
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

// --- SECURE DUAL-ENGINE UPLOAD LOGIC ---
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

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8508652075:AAGawPn9vXzEZrehneHrcOVcJ7g6ZHHe5io';
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1004408463319';
    
    let finalUrl = '';
    let uploadSuccess = false;
    let resourceType = req.file.mimetype.startsWith('video/') ? 'video' : (req.file.mimetype.startsWith('image/') ? 'image' : 'raw');

    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
            const fileBuffer = fs.readFileSync(req.file.path);
            const blob = new Blob([fileBuffer], { type: req.file.mimetype });
            const tgForm = new FormData();
            tgForm.append('chat_id', TELEGRAM_CHAT_ID);

            let endpoint = 'sendDocument'; let field = 'document';
            if (resourceType === 'image') { endpoint = 'sendPhoto'; field = 'photo'; }
            else if (resourceType === 'video') { endpoint = 'sendVideo'; field = 'video'; }

            tgForm.append(field, blob, req.file.originalname);
            console.log(`[Telegram Debug] Attempting ${endpoint} for file size: ${req.file.size} bytes...`);
            
            const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, { method: 'POST', body: tgForm });
            const tgData = await tgRes.json();
            console.log("[Telegram Debug] Response:", JSON.stringify(tgData));

            if (tgData.ok) {
                let fileId = resourceType === 'image' ? tgData.result.photo[tgData.result.photo.length - 1].file_id : (resourceType === 'video' ? tgData.result.video.file_id : tgData.result.document.file_id);
                const getFileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
                const getFileData = await getFileRes.json();
                if (getFileData.ok) {
                    finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${getFileData.result.file_path}`;
                    uploadSuccess = true;
                    console.log("[Telegram Debug] File URL fetched successfully:", finalUrl);
                }
            } else {
                console.error("[Telegram API Error Description]:", tgData.description);
            }
        } catch(e) { console.error("Telegram Upload Exception:", e); }
    }

    if (!uploadSuccess) {
        console.log("[Telegram Fallback] Switching to Cloudinary...");
        try {
            const uploadOptions = isStatus && resourceType === 'video' ? { duration: 30 } : {};
            const result = await queuedCloudinaryUpload(req.file, isStatus ? 'chat_app_status' : 'chat_app_media', uploadOptions);
            finalUrl = result.secure_url;
            resourceType = result.resource_type;
            uploadSuccess = true;
        } catch(e) { console.error("Cloudinary Fallback Error:", e); }
    }

    fs.unlink(req.file.path, () => {});
    if (!uploadSuccess) return res.status(500).json({ success:false, error:'Media upload failed.' });
    
    if (isStatus) {
       await Status.findOneAndUpdate(
         { userCode }, 
         { name: user.fullName, avatar: user.avatar, $push: { items: { id: Date.now().toString(), media: finalUrl, type: resourceType, time: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), viewers: [], likes: [], comments: [], caption: '', privacy: 'all' } } },
         { upsert: true }
       );
    }
    
    return res.json({ success:true, url: finalUrl, resourceType: resourceType, bytes: req.file.size });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ success:false, error:'Media upload failed.' });
  }
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, time: new Date().toISOString() }));

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat-app';
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => console.error(e));

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
  reelBlockedUsers: { type: [String], default: [] }, // Reel block tab
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

// Comments & Reels Schema
const commentSchema = new mongoose.Schema({
  id: String,
  userCode: String,
  name: String,
  avatar: String,
  text: String,
  time: String
}, { _id: false });

const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ 
    id: String, media: String, type: String, time: String, expiresAt: Date, 
    viewers: [viewerSchema], likes: { type: [String], default: [] }, comments: [commentSchema], caption: { type: String, default: '' }, privacy: { type: String, default: 'all' } 
}, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

// --- DEEP CLEAN CRON / INTERVAL (24 Hours Cleanup & Orphan File Purge) ---
setInterval(async () => {
  try {
    const expiredStatuses = await Status.find({ 'items.expiresAt': { $lt: new Date() } });
    for (const st of expiredStatuses) {
      for (const item of st.items) {
        if (new Date(item.expiresAt) < new Date()) {
          // Purge Cloudinary if media belongs to cloudinary
          if (item.media && item.media.includes('cloudinary')) {
            const pubId = getCloudinaryPublicId(item.media);
            if (pubId) cloudinary.uploader.destroy(pubId).catch(()=>{});
          }
        }
      }
      // Remove expired items
      st.items = st.items.filter(i => new Date(i.expiresAt) > new Date());
      if (st.items.length === 0) {
        await Status.deleteOne({ _id: st._id });
      } else {
        await st.save();
      }
    }
  } catch (e) { console.error('Deep clean cron error:', e); }
}, 60 * 60 * 1000); // Run hourly

const callLogSchema = new mongoose.Schema({
  callerCode: { type: String, required: true, lowercase: true },
  callerName: String,
  receiverCode: { type: String, required: true, lowercase: true },
  receiverName: String,
  status: String, 
  duration: String, 
  timestamp: { type: Date, default: Date.now }
});
const CallLog = mongoose.model('CallLog', callLogSchema);

const userSockets = new Map();
const pendingCalls = new Map(); 

io.on('connection', (socket) => {
  let currentUserCode = null;

  socket.on('set-socket-user', async ({ userCode }, callback) => {
    if (userCode) {
      currentUserCode = String(userCode).trim().toLowerCase();
      socket.join(currentUserCode);
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      User.updateOne({ userCode: currentUserCode }, { lastSeen: new Date() }).exec();
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });

      // Offline tick sync check when user comes online
      const unreadSent = await Message.find({ receiverCode: currentUserCode, status: { $in: ['sent', 'delivered'] } });
      for (const m of unreadSent) {
        m.status = 'delivered';
        await m.save();
        io.to(m.senderCode).emit('message-status-update', { messageId: m.messageId, status: 'delivered' });
      }

      const pending = pendingCalls.get(currentUserCode);
      if(pending && pending.expiry > Date.now()) {
          const caller = await User.findOne({ userCode: pending.callerCode }).lean();
          if(caller) {
              io.to(currentUserCode).emit('incoming-call', { callerCode: pending.callerCode, callerName: caller.fullName, callerAvatar: caller.avatar, offer: pending.offer });
              io.to(pending.callerCode).emit('call-status', { status: 'Ringing...', targetCode: currentUserCode });
          }
          pendingCalls.delete(currentUserCode);
      }

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
      const existingUser = await User.findOne({ $or: [{ userCode: rawId }, { mobile: data.mobile.trim() }] });
      if (existingUser) return callback({ success: false, error: 'User ID or Mobile is already registered.' });

      const finalAvatar = (data.avatar && data.avatar.startsWith('data:image')) ? data.avatar : DEFAULT_AVATAR;

      const newUser = await User.create({
        userCode: rawId, password: data.password.trim(), fullName: data.fullName?.trim() || 'User',
        mobile: data.mobile.trim(), avatar: finalAvatar, secQ1: data.q1?.trim().toLowerCase() || '', secQ2: data.q2?.trim().toLowerCase() || ''
      });
      currentUserCode = rawId; socket.join(rawId);
      if (!userSockets.has(currentUserCode)) userSockets.set(currentUserCode, new Set());
      userSockets.get(currentUserCode).add(socket.id);
      io.emit('user-status-changed', { userCode: currentUserCode, isOnline: true });
      callback({ success: true, user: newUser }); 
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
          $or: [{ senderCode: currentUserCode, receiverCode: u.userCode }, { senderCode: u.userCode, receiverCode: currentUserCode }], deletedFor: {$ne: currentUserCode }
        }).sort({ createdAt: -1 }).lean();
        
        const unreadCount = await Message.countDocuments({ senderCode: u.userCode, receiverCode: currentUserCode, status: { $in: ['sent', 'delivered'] }, deletedFor: {$ne: currentUserCode } });
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
      if (avatarUrl && avatarUrl.startsWith('data:image')) update.avatar = avatarUrl;
      const user = await User.findOneAndUpdate({ userCode: currentUserCode }, { $set: update }, { new: true });
      callback({ success: true, user: user.toObject() });
    } catch (e) { callback({ success: false }); }
  });

  socket.on('get-messages', async ({ targetCode, after }, callback) => {
    if (!currentUserCode) return;
    try {
      const clean = String(targetCode || '').toLowerCase();
      const base = { $or: [{ senderCode: currentUserCode, receiverCode: clean }, { senderCode: clean, receiverCode: currentUserCode }], deletedFor: {$ne: currentUserCode } };
      const messages = await Message.find(after ? { $and: [base, { createdAt: {$gt: new Date(after) } }] } : base).sort({ createdAt: 1 }).limit(500).lean();
      
      // Mark received unread as read/delivered
      for (const m of messages) {
        if (m.receiverCode === currentUserCode && m.status === 'sent') {
          m.status = 'delivered';
          await Message.updateOne({ messageId: m.messageId }, { status: 'delivered' });
          io.to(m.senderCode).emit('message-status-update', { messageId: m.messageId, status: 'delivered' });
        }
      }
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

      const isReceiverOnline = userSockets.has(data.targetCode);
      const initialStatus = isReceiverOnline ? 'delivered' : 'sent';

      const msg = await Message.create({
        messageId: data.clientMessageId || ('msg_' + Date.now()), senderCode: currentUserCode, receiverCode: data.targetCode, 
        text: data.text || '', media: data.media || '', messageType: data.messageType || 'text', fileName: data.fileName || '', status: initialStatus
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
        if(msg.media && msg.media.includes('cloudinary')) {
           const publicId = getCloudinaryPublicId(msg.media);
           if(publicId) cloudinary.uploader.destroy(publicId).catch(()=>{});
        }
        io.to(msg.senderCode).emit('message-deleted-ui', { messageId });
        io.to(msg.receiverCode).emit('message-deleted-ui', { messageId });
      } else {
        await Message.updateOne({ messageId }, { $addToSet: { deletedFor: currentUserCode } });
        socket.emit('message-deleted-ui', { messageId });
      }
      cb({ success: true });
    } catch(e) { cb({ success: false }); }
  });

  // --- BLOCKS MANAGEMENT (Chat vs Reel blocks) ---
  socket.on('get-blocked-users', async (data, cb) => {
    if(!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const blocked = await User.find({ userCode: { $in: me.blockedUsers || [] } }).lean();
      const reelBlocked = await User.find({ userCode: { $in: me.reelBlockedUsers || [] } }).lean();
      cb({
        success: true, 
        users: blocked.map(u => ({userCode: u.userCode, name: u.fullName, avatar: u.avatar})),
        reelUsers: reelBlocked.map(u => ({userCode: u.userCode, name: u.fullName, avatar: u.avatar}))
      });
    } catch(e) { cb({success:false}); }
  });

  socket.on('unblock-user', async ({ targetCode, type }, cb) => {
    if(!currentUserCode) return;
    if (type === 'reel') {
      await User.updateOne({ userCode: currentUserCode }, { $pull: { reelBlockedUsers: targetCode } });
    } else {
      await User.updateOne({ userCode: currentUserCode }, { $pull: { blockedUsers: targetCode } });
    }
    cb({ success: true });
  });

  socket.on('block-user', async ({ targetCode, type }, cb) => {
    if (!currentUserCode) return;
    if (type === 'reel') {
      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { reelBlockedUsers: targetCode } });
    } else {
      await User.updateOne({ userCode: currentUserCode }, { $addToSet: { blockedUsers: targetCode },$pull: { contacts: targetCode } });
    }
    cb({ success: true });
  });

  socket.on('delete-contact', async ({ targetCode }, cb) => {
    if (!currentUserCode) return;
    await User.updateOne({ userCode: currentUserCode }, { $pull: { contacts: targetCode, blockedUsers: targetCode, reelBlockedUsers: targetCode } }); 
    await Message.updateMany(
        { $or: [{senderCode: currentUserCode, receiverCode: targetCode}, {senderCode: targetCode, receiverCode: currentUserCode}] },
        { $addToSet: { deletedFor: currentUserCode } }
    );
    cb({ success: true });
  });

  socket.on('mark-message-delivered', async ({ messageId, senderCode }) => {
    await Message.updateOne({ messageId }, { status: 'delivered' });
    io.to(senderCode).emit('message-status-update', { messageId, status: 'delivered' });
  });

  socket.on('mark-message-read', async ({ messageId, senderCode }) => {
    await Message.updateOne({ messageId }, { status: 'read' });
    io.to(senderCode).emit('message-status-update', { messageId, status: 'read' });
  });

  socket.on('mark-all-read', async ({ senderCode }) => {
    if (!currentUserCode) return;
    await Message.updateMany({ senderCode: senderCode, receiverCode: currentUserCode, status: { $in: ['sent', 'delivered'] } }, { status: 'read' });
    io.to(senderCode).emit('all-messages-read-by-receiver', { readerCode: currentUserCode });
  });

  // --- CALL LOGS ---
  socket.on('call-user', async (data) => {
    if(!currentUserCode) return;
    const isOnline = userSockets.has(data.targetCode);
    socket.emit('call-status', { status: isOnline ? 'Ringing...' : 'Calling...', targetCode: data.targetCode });
    if(isOnline) {
      const caller = await User.findOne({ userCode: currentUserCode }).lean();
      io.to(data.targetCode).emit('incoming-call', { callerCode: currentUserCode, callerName: caller.fullName, callerAvatar: caller.avatar, offer: data.offer });
    } else {
      pendingCalls.set(data.targetCode, { callerCode: currentUserCode, offer: data.offer, expiry: Date.now() + 30000 });
    }
  });

  socket.on('answer-call', (data) => { io.to(data.callerCode).emit('call-answered', { answer: data.answer }); });
  socket.on('reject-call', (data) => { io.to(data.callerCode).emit('call-rejected'); });
  socket.on('end-call', (data) => { io.to(data.targetCode).emit('call-ended'); });
  socket.on('ice-candidate', (data) => { io.to(data.targetCode).emit('ice-candidate', { candidate: data.candidate }); });

  socket.on('save-call-log', async (data) => {
    try {
      await CallLog.create({
        callerCode: data.callerCode, callerName: data.callerName,
        receiverCode: data.receiverCode, receiverName: data.receiverName,
        status: data.status, duration: data.duration
      });
    } catch(e) {}
  });

  socket.on('get-calls', async (data, cb) => {
    if(!currentUserCode) return;
    try {
       const calls = await CallLog.find({ $or: [{callerCode: currentUserCode}, {receiverCode: currentUserCode}] })
                                  .sort({ timestamp: -1 }).limit(50).lean();
       cb({ success: true, calls });
    } catch(e) { cb({ success: false }); }
  });

  // --- REELS & COMMENTS LOGIC ---
  socket.on('upload-status-reel', async ({ url, type }, cb) => {
    if (!currentUserCode || !url) return cb({ success: false });
    try {
      const user = await User.findOne({ userCode: currentUserCode }).lean();
      if (!user) return cb({ success: false });

      await Status.findOneAndUpdate(
        { userCode: currentUserCode },
        { 
          name: user.fullName, 
          avatar: user.avatar, 
          $push: { 
            items: { 
              id: Date.now().toString(), 
              media: url, 
              type: type || 'video', 
              time: new Date().toISOString(), 
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), 
              viewers: [], likes: [], comments: [], caption: '', privacy: 'all' 
            } 
          } 
        },
        { upsert: true }
      );
      cb({ success: true, url });
    } catch (e) { cb({ success: false }); }
  });

  socket.on('get-all-active-reels', async (data, cb) => {
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const reelBlockedByMe = me?.reelBlockedUsers || [];

      const allStatuses = await Status.find({'items.expiresAt': {$gt: new Date()}}).lean();
      let reels = [];
      const myContacts = data.myContacts || [];
      
      allStatuses.forEach(s => {
         if (reelBlockedByMe.includes(s.userCode)) return; // Exclude reel-blocked users
         s.items.forEach(item => {
            if(item.expiresAt > new Date()) {
                if(item.privacy === 'contacts' && s.userCode !== currentUserCode && !myContacts.includes(s.userCode)) return;
                reels.push({ 
                    id: item.id, userCode: s.userCode, name: s.name, avatar: s.avatar, 
                    media: item.media, type: item.type, likes: item.likes || [], comments: item.comments || [], caption: item.caption || '', privacy: item.privacy || 'all' 
                });
            }
         });
      });
      reels.sort((a,b) => parseInt(b.id) - parseInt(a.id));
      cb({ success: true, reels });
    } catch (e) { cb({ success: false }); }
  });

  socket.on('like-reel', async ({ userCode, reelId }) => {
      if(!currentUserCode) return;
      try {
          const statusDoc = await Status.findOne({ userCode });
          if(statusDoc) {
             const item = statusDoc.items.find(i => i.id === reelId);
             if(item) {
                 const hasLiked = item.likes.includes(currentUserCode);
                 if(hasLiked) { item.likes = item.likes.filter(u => u !== currentUserCode); } 
                 else { item.likes.push(currentUserCode); }
                 await statusDoc.save();
                 io.emit('reel-like-updated', { reelId, likes: item.likes });
             }
          }
      } catch(e) {}
  });

  // Comments handlers
  socket.on('add-reel-comment', async ({ ownerUserCode, reelId, text }, cb) => {
    if (!currentUserCode || !text) return cb({ success: false });
    try {
      const user = await User.findOne({ userCode: currentUserCode }).lean();
      const statusDoc = await Status.findOne({ userCode: ownerUserCode });
      if (!statusDoc) return cb({ success: false });
      const item = statusDoc.items.find(i => i.id === reelId);
      if (!item) return cb({ success: false });

      const newComment = {
        id: 'c_' + Date.now(),
        userCode: currentUserCode,
        name: user?.fullName || 'User',
        avatar: user?.avatar || DEFAULT_AVATAR,
        text: text.trim(),
        time: new Date().toISOString()
      };
      item.comments.push(newComment);
      await statusDoc.save();
      io.emit('reel-comment-updated', { reelId, comments: item.comments });
      cb({ success: true, comment: newComment });
    } catch(e) { cb({ success: false }); }
  });

  socket.on('delete-reel-comment', async ({ ownerUserCode, reelId, commentId }, cb) => {
    if (!currentUserCode) return cb({ success: false });
    try {
      const statusDoc = await Status.findOne({ userCode: ownerUserCode });
      if (!statusDoc) return cb({ success: false });
      const item = statusDoc.items.find(i => i.id === reelId);
      if (!item) return cb({ success: false });

      const comment = item.comments.find(c => c.id === commentId);
      if (!comment) return cb({ success: false });

      // Owner can delete any comment on their reel, commenter can delete their own
      if (ownerUserCode === currentUserCode || comment.userCode === currentUserCode) {
        item.comments = item.comments.filter(c => c.id !== commentId);
        await statusDoc.save();
        io.emit('reel-comment-updated', { reelId, comments: item.comments });
        cb({ success: true });
      } else {
        cb({ success: false, error: 'Unauthorized delete' });
      }
    } catch(e) { cb({ success: false }); }
  });

  socket.on('repost-reel', async ({ media, type }, cb) => {
      if(!currentUserCode) return cb({success:false});
      try {
          const user = await User.findOne({ userCode: currentUserCode }).lean();
          await Status.findOneAndUpdate(
             { userCode: currentUserCode }, 
             { name: user.fullName, avatar: user.avatar, $push: { items: { id: Date.now().toString(), media, type, time: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), viewers: [], likes: [], comments: [], caption: 'Reposted', privacy: 'all' } } },
             { upsert: true }
          );
          cb({success:true});
      } catch(e) { cb({success:false}); }
  });

  socket.on('edit-reel', async ({ reelId, caption, privacy }, cb) => {
      if(!currentUserCode) return cb({success:false});
      try {
          await Status.updateOne(
              { userCode: currentUserCode, "items.id": reelId },
              { $set: { "items.$.caption": caption, "items.$.privacy": privacy } }
          );
          cb({success:true});
      } catch(e) { cb({success:false}); }
  });

  socket.on('delete-my-media', async ({ type, url, id }, cb) => {
    if(!currentUserCode) return cb({success:false});
    try {
       if(url && url.includes('cloudinary')) {
           const publicId = getCloudinaryPublicId(url);
           if(publicId) cloudinary.uploader.destroy(publicId).catch(()=>{});
       }

       if(type === 'dp') {
          await User.updateOne({ userCode: currentUserCode }, { avatar: DEFAULT_AVATAR });
          cb({success:true, avatar: DEFAULT_AVATAR});
       } else if(type === 'reel') {
          // deep purge from cloudinary if matches
          const st = await Status.findOne({ userCode: currentUserCode });
          if (st) {
            const item = st.items.find(i => i.id === id);
            if (item && item.media && item.media.includes('cloudinary')) {
              const pubId = getCloudinaryPublicId(item.media);
              if (pubId) cloudinary.uploader.destroy(pubId).catch(()=>{});
            }
          }
          await Status.updateOne({ userCode: currentUserCode }, { $pull: { items: { id: id } } });
          cb({success:true});
       }
    } catch(e) { cb({success:false}); }
  });

  socket.on('ask-mc-ai', ({ prompt, context }, cb) => {
    try {
      const rawKey = process.env.GROQ_API_KEY || "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";
      const apiKey = String(rawKey).trim();
      let systemInstruction = "You are MC AI, official AI assistant for My Chat App. Answer strictly in Hindi/English mix. Features: Chat, Call, 24h Reels with comments & deep delete, Block types.";

      const postData = JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: prompt }
        ]
      });

      const options = {
        hostname: 'api.groq.com',
        port: 443,
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(postData) }
      };

      const req = https.request(options, (resAPI) => {
        let body = ''; resAPI.on('data', (chunk) => body += chunk);
        resAPI.on('end', () => {
           try {
              const data = JSON.parse(body);
              if(data.error) return cb({ success: false, error: "AI API Error: " + (data.error.message || "Unknown error") });
              if(data.choices && data.choices.length > 0) cb({ success: true, text: data.choices[0].message.content });
              else cb({ success: false, error: 'AI gave no response' });
           } catch(err) { cb({ success: false, error: 'JSON Parse error' }); }
        });
      });
      req.on('error', (e) => cb({ success: false, error: 'Connection Error: ' + e.message })); req.write(postData); req.end();
    } catch (e) { cb({ success: false, error: 'Internal AI Error' }); }
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
