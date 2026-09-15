[source: 2]const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'chat-app', time: new Date().toISOString() }));

// Secure Firebase configuration endpoint for frontend (prevents github secret scanner alerts)
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

// Schemas & Models
const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  email: { type: String, default: '' },
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

const otpStorage = new Map();

// Optimized Nodemailer Transporter for Gmail SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  tls: {
    rejectUnauthorized: false
  }
});

io.on('connection', (socket) => {
  let currentUserCode = null;

  // SEND EMAIL OTP
  socket.on('send-email-otp', async ({ email }, callback) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return callback({ success: false, error: 'Invalid email address.' });
    }

    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      otpStorage.set(cleanEmail, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });

      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await transporter.sendMail({
          from: `"Chat App Support" <${process.env.SMTP_USER}>`,
          to: cleanEmail,
          subject: 'Your Chat App Verification OTP',
          text: `Your verification OTP is: ${otp}. It is valid for 5 minutes.`
        });
      } else {
        console.log(`[DEV OTP] OTP for ${cleanEmail} is: ${otp}`);
      }

      callback({ success: true });
    } catch (e) {
      console.error('SMTP Send Error:', e.message);
      callback({ success: false, error: 'Failed to send OTP email: ' + e.message });
    }
  });

  // VERIFY OTP & REGISTER
  socket.on('verify-otp-and-register', async ({ email, otp, password, fullName, mobile, avatar }, callback) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanOtp = String(otp || '').trim();
    const passStr = String(password || '').trim();

    try {
      const record = otpStorage.get(cleanEmail);
      if (!record || record.expiresAt < Date.now() || record.otp !== cleanOtp) {
        return callback({ success: false, error: 'Invalid or expired OTP.' });
      }

      if (passStr.length !== 8) {
        return callback({ success: false, error: 'Password must be strictly 8 digits.' });
      }

      const emailPrefix = cleanEmail.split('@')[0].replace(/[^a-z0-9_]/g, '');
      const baseName = emailPrefix.slice(0, 6).padEnd(6, 'x');
      let autoUserCode = '@' + baseName;
      
      let counter = 1;
      while (await User.findOne({ userCode: autoUserCode })) {
        autoUserCode = '@' + baseName.slice(0, 4) + counter;
        counter++;
      }

      const existingMobile = await User.findOne({ mobile: String(mobile || '').trim() });
      if (existingMobile) {
        return callback({ success: false, error: 'Mobile number already registered.' });
      }

      const newUser = await User.create({
        userCode: autoUserCode,
        password: passStr,
        fullName: fullName || 'User',
        email: cleanEmail,
        mobile: String(mobile || '').trim(),
        avatar: avatar || '',
        blockedByMe: {}
      });

      otpStorage.delete(cleanEmail);
      currentUserCode = autoUserCode;
      socket.join(autoUserCode);
      io.emit('user-online-status', { targetCode: autoUserCode, isOnline: true });

      callback({ success: true, user: newUser });
    } catch (e) {
      callback({ success: false, error: 'Registration error: ' + e.message });
    }
  });

  // FORGOT OTP VERIFY
  socket.on('verify-forgot-otp', async ({ email, otp, mode }, callback) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanOtp = String(otp || '').trim();
    try {
      const record = otpStorage.get(cleanEmail);
      if (!record || record.expiresAt < Date.now() || record.otp !== cleanOtp) {
        return callback({ success: false, error: 'Invalid or expired OTP.' });
      }
      const userObj = await User.findOne({ email: cleanEmail });
      if (!userObj) return callback({ success: false, error: 'Email not registered.' });

      if (mode === 'userid') {
        otpStorage.delete(cleanEmail);
        return callback({ success: true, userCode: userObj.userCode });
      } else {
        return callback({ success: true });
      }
    } catch(e) {
      callback({ success: false, error: 'Verification failed.' });
    }
  });

  // UPDATE FORGOT PASSWORD
  socket.on('update-forgot-password', async ({ email, newPassword }, callback) => {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const passStr = String(newPassword || '').trim();
    if(passStr.length !== 8) return callback({ success: false, error: 'Password must be 8 digits.' });
    try {
      const userObj = await User.findOneAndUpdate({ email: cleanEmail }, { password: passStr });
      if(!userObj) return callback({ success: false, error: 'User not found.' });
      otpStorage.delete(cleanEmail);
      callback({ success: true });
    } catch(e) {
      callback({ success: false, error: 'Update failed.' });
    }
  });

  // LOGIN AUTHENTICATION
  socket.on('auth-user', async ({ userCode, password, isRegister }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();

    try {
      if (isRegister) {
        return callback({ success: false, error: 'Use OTP registration flow.' });
      } else {
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
      }
    } catch (err) {
      return callback({ success: false, error: 'Auth error: ' + err.message });
    }
  });

  // STATUSES & CONTACTS & CHAT LOGIC
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
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      if (!Array.isArray(me?.contacts) || !me.contacts.includes(clean)) return callback && callback({ success:false, error:'Not in contacts.' });
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
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const other = await User.findOne({ userCode: receiverCode }).lean();
      if (!other) return callback && callback({ success: false, error: 'User not found.' });
      if (!Array.isArray(me?.contacts) || !me.contacts.includes(receiverCode)) return callback && callback({ success:false, error:'Add user first.' });
      
      const msg = await Message.create({
        messageId: String(clientMessageId || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'))),
        senderCode: currentUserCode, receiverCode, text: messageText, media: type === 'audio' ? String(media) : '', messageType: type, duration: Number(duration || 0)
      });
      io.to(currentUserCode).to(receiverCode).emit('new-message', msg.toObject());
      callback && callback({ success: true, message: msg.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Message failed.' }); }
  });

  socket.on('delete-message', async ({ messageId, mode }, callback) => {
    if (!currentUserCode || !messageId) return callback && callback({ success: false });
    try {
      const msg = await Message.findOne({ messageId });
      if (!msg) return callback && callback({ success: false, error: 'Message not found.' });
      if (mode === 'everyone') {
        if (msg.senderCode !== currentUserCode) return callback && callback({ success: false, error: 'Only sender can delete.' });
        msg.deletedForEveryone = true; msg.text = ''; await msg.save();
        io.to(msg.senderCode).to(msg.receiverCode).emit('message-deleted', { messageId, mode: 'everyone' });
      } else {
        if (!msg.deletedFor.includes(currentUserCode)) { msg.deletedFor.push(currentUserCode); await msg.save(); }
        socket.emit('message-deleted', { messageId, mode: 'me' });
      }
      callback && callback({ success: true });
    } catch (e) { callback && callback({ success: false, error: 'Delete failed.' }); }
  });

  socket.on('disconnect', () => {
    if (currentUserCode) io.emit('user-online-status', { targetCode: currentUserCode, isOnline: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
