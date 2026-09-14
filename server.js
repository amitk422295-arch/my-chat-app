const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024,
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;

// Environment variables take priority. The fallback values below were supplied by the
// project owner for direct deployment. For a public repository, move these secrets to
// Render Environment Variables and remove the fallback values.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://chatadmin:vVWQkXn2ptXhnlzs@cluster0.pb5by68.mongodb.net/?appName=Cluster0';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'gr8tp1tg';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '668573837891895';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'dTJqlvLUKWLJUt-FH8rpnIPYs';

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true
});

const userSchema = new mongoose.Schema({
  userCode: { type: String, required: true, unique: true, index: true },
  fullName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true },
  mobileNumber: { type: String, required: true, unique: true, index: true },
  avatar: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const connectionSchema = new mongoose.Schema({
  ownerCode: { type: String, required: true, index: true },
  contactCode: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now }
});
connectionSchema.index({ ownerCode: 1, contactCode: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  roomId: { type: String, required: true, index: true },
  senderCode: { type: String, required: true, index: true },
  targetCode: { type: String, required: true, index: true },
  text: { type: String, default: '' },
  media: { type: String, default: null },
  mediaType: { type: String, default: null },
  fileName: { type: String, default: null },
  fileSize: { type: Number, default: null },
  status: { type: String, enum: ['sent', 'delivered', 'seen'], default: 'sent' },
  sentAt: { type: Date, default: Date.now, index: true },
  deliveredAt: { type: Date, default: null },
  seenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
messageSchema.index({ roomId: 1, sentAt: 1 });

const statusSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userCode: { type: String, required: true, index: true },
  media: { type: String, required: true },
  type: { type: String, enum: ['image', 'video'], required: true },
  createdAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  viewers: [{
    userCode: String,
    name: String,
    avatar: String,
    viewedAt: Date
  }]
});
statusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const callSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true, index: true },
  callerCode: { type: String, required: true, index: true },
  receiverCode: { type: String, required: true, index: true },
  startedAt: { type: Date, default: Date.now },
  answeredAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  duration: { type: Number, default: 0 },
  status: { type: String, enum: ['ringing', 'answered', 'missed', 'ended', 'rejected'], default: 'ringing' },
  createdAt: { type: Date, default: Date.now }
});
callSchema.index({ callerCode: 1, createdAt: -1 });
callSchema.index({ receiverCode: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Connection = mongoose.model('Connection', connectionSchema);
const Message = mongoose.model('Message', messageSchema);
const Status = mongoose.model('Status', statusSchema);
const Call = mongoose.model('Call', callSchema);

const userSockets = new Map();
const socketToUser = new Map();
const activeCalls = new Map();

function cleanUserCode(value) {
  let v = String(value || '').trim().toLowerCase().replace(/@/g, '').replace(/[^a-z0-9]/g, '');
  return v ? '@' + v : '';
}

function normalizeMobile(value) {
  let v = String(value || '').replace(/\D/g, '');
  if (v.startsWith('0091')) v = v.slice(4);
  else if (v.startsWith('91') && v.length === 12) v = v.slice(2);
  else if (v.startsWith('0') && v.length === 11) v = v.slice(1);
  return v;
}

function validIndianMobile(value) {
  return /^[6-9]\d{9}$/.test(normalizeMobile(value));
}

function publicUser(user) {
  if (!user) return null;
  return {
    userCode: user.userCode,
    fullName: user.fullName,
    avatar: user.avatar || '',
    mobileNumber: user.mobileNumber
  };
}

function timeText(date) {
  if (!date) return '';
  return new Date(date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function roomIdFor(a, b) {
  return [a, b].sort().join('_');
}

function sendToUser(userCode, event, data) {
  const sockets = userSockets.get(userCode);
  if (!sockets) return;
  for (const socketId of sockets) io.to(socketId).emit(event, data);
}

async function connectUsers(a, b) {
  if (!a || !b || a === b) return;
  await Connection.updateOne({ ownerCode: a, contactCode: b }, { $setOnInsert: { ownerCode: a, contactCode: b } }, { upsert: true });
  await Connection.updateOne({ ownerCode: b, contactCode: a }, { $setOnInsert: { ownerCode: b, contactCode: a } }, { upsert: true });
}

async function contactListFor(userCode) {
  const links = await Connection.find({ ownerCode: userCode }).sort({ createdAt: -1 }).lean();
  const codes = links.map(x => x.contactCode);
  if (!codes.length) return [];
  const users = await User.find({ userCode: { $in: codes } }).lean();
  const map = new Map(users.map(u => [u.userCode, u]));
  const out = [];
  for (const code of codes) {
    const u = map.get(code);
    if (!u) continue;
    const roomId = roomIdFor(userCode, code);
    const last = await Message.findOne({ roomId }).sort({ sentAt: -1 }).lean();
    out.push({
      userCode: code,
      name: u.fullName,
      avatar: u.avatar || '',
      lastMessage: last ? (last.text || (last.mediaType === 'audio' ? '[Voice Note]' : last.mediaType === 'pdf' ? '[PDF Document]' : `[${last.mediaType || 'Media'}]`)) : 'Tap to chat',
      lastMessageAt: last ? last.sentAt : null
    });
  }
  out.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  return out;
}

function serializeMessage(m) {
  return {
    id: m.id,
    roomId: m.roomId,
    senderCode: m.senderCode,
    targetCode: m.targetCode,
    text: m.text || '',
    media: m.media || null,
    mediaType: m.mediaType || null,
    fileName: m.fileName || null,
    fileSize: m.fileSize || null,
    status: m.status,
    time: timeText(m.sentAt),
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    seenAt: m.seenAt
  };
}

app.get('/health', (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 }));

app.post('/api/cloudinary-signature', (req, res) => {
  try {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({ success: false, error: 'Cloudinary environment variables are missing on Render.' });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = String(req.body?.folder || 'your-chat-app/media').replace(/[^a-zA-Z0-9_\/-]/g, '');
    const signature = cloudinary.utils.api_sign_request({ timestamp, folder }, CLOUDINARY_API_SECRET);
    res.json({ success: true, timestamp, folder, signature, apiKey: CLOUDINARY_API_KEY, cloudName: CLOUDINARY_CLOUD_NAME });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Could not create Cloudinary signature.' });
  }
});

io.on('connection', socket => {
  function mapSocket(userCode) {
    if (!userSockets.has(userCode)) userSockets.set(userCode, new Set());
    userSockets.get(userCode).add(socket.id);
    socketToUser.set(socket.id, userCode);
  }

  socket.on('auth-user', async ({ userCode, password, fullName, avatar, mobileNumber, isRegister }, callback = () => {}) => {
    try {
      const cleanCode = cleanUserCode(userCode);
      if (!cleanCode || !/^@[a-z0-9]+$/.test(cleanCode)) return callback({ success: false, error: 'Valid User ID is mandatory!' });
      if (!/^\d{6}$/.test(String(password || ''))) return callback({ success: false, error: 'PIN must be 6 digits!' });

      if (isRegister) {
        if (!fullName || !String(fullName).trim()) return callback({ success: false, error: 'Full Name is mandatory!' });
        if (!validIndianMobile(mobileNumber)) return callback({ success: false, error: 'Enter a valid Indian mobile number.' });
        const mobile = normalizeMobile(mobileNumber);
        const [codeExists, mobileExists] = await Promise.all([
          User.exists({ userCode: cleanCode }),
          User.exists({ mobileNumber: mobile })
        ]);
        if (codeExists) return callback({ success: false, error: 'User ID already exists!' });
        if (mobileExists) return callback({ success: false, error: 'Mobile number is already registered.' });
        const passwordHash = await bcrypt.hash(String(password), 10);
        const user = await User.create({ userCode: cleanCode, fullName: String(fullName).trim(), passwordHash, mobileNumber: mobile, avatar: avatar || '' });
        mapSocket(cleanCode);
        return callback({ success: true, user: publicUser(user) });
      }

      const user = await User.findOne({ userCode: cleanCode });
      if (!user) return callback({ success: false, error: 'User ID not found!' });
      const ok = await bcrypt.compare(String(password), user.passwordHash);
      if (!ok) return callback({ success: false, error: 'Incorrect 6-digit PIN!' });
      mapSocket(cleanCode);
      callback({ success: true, user: publicUser(user) });
    } catch (err) {
      console.error('auth-user', err);
      callback({ success: false, error: 'Server/database error. Please try again.' });
    }
  });

  socket.on('restore-session', async ({ userCode, password }, callback = () => {}) => {
    try {
      const cleanCode = cleanUserCode(userCode);
      const user = await User.findOne({ userCode: cleanCode });
      if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) return callback({ success: false });
      mapSocket(cleanCode);
      callback({ success: true, user: publicUser(user) });
    } catch (err) {
      callback({ success: false });
    }
  });

  socket.on('get-contacts', async () => {
    try {
      const uCode = socketToUser.get(socket.id);
      if (!uCode) return;
      socket.emit('contact-list-data', { contacts: await contactListFor(uCode), pending: [] });
    } catch (err) { console.error('get-contacts', err); }
  });

  socket.on('open-direct-chat', async ({ targetCode, mobileNumber, query }, callback = () => {}) => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me) return callback({ success: false, error: 'Please login again.' });
      let user = null;
      const q = String(query || '').trim();
      const target = cleanUserCode(targetCode || q);
      const mobile = normalizeMobile(mobileNumber || q);
      if (target && /^@[a-z0-9]+$/.test(target)) user = await User.findOne({ userCode: target });
      if (!user && validIndianMobile(mobile)) user = await User.findOne({ mobileNumber: mobile });
      if (!user) return callback({ success: false, notFound: true, error: 'User not found. Check User ID or mobile number.' });
      if (user.userCode === me) return callback({ success: false, error: 'You cannot start a chat with yourself.' });
      await connectUsers(me, user.userCode);
      callback({ success: true, user: publicUser(user) });
      sendToUser(me, 'refresh-contacts');
      sendToUser(user.userCode, 'refresh-contacts');
    } catch (err) {
      console.error('open-direct-chat', err);
      callback({ success: false, error: 'Search failed.' });
    }
  });

  socket.on('direct-chat', async ({ targetCode, mobileNumber, query }, callback) => {
    socket.emit('open-direct-chat', { targetCode, mobileNumber, query }, callback);
  });

  socket.on('open-room', async ({ targetCode }) => {
    try {
      const me = socketToUser.get(socket.id);
      const target = cleanUserCode(targetCode);
      if (!me || !target || me === target) return;
      await connectUsers(me, target);
      const roomId = roomIdFor(me, target);
      socket.join(roomId);
      const msgs = await Message.find({ roomId }).sort({ sentAt: 1 }).limit(500).lean();
      socket.emit('load-history', msgs.map(serializeMessage));
    } catch (err) { console.error('open-room', err); }
  });

  socket.on('send-message', async (data, callback = () => {}) => {
    try {
      const sender = socketToUser.get(socket.id);
      const target = cleanUserCode(data?.targetCode);
      if (!sender || !target || sender === target) return callback({ success: false, error: 'Invalid chat.' });
      const targetUser = await User.findOne({ userCode: target });
      if (!targetUser) return callback({ success: false, error: 'User not found.' });
      await connectUsers(sender, target);
      const roomId = roomIdFor(sender, target);
      const targetOnline = (userSockets.get(target)?.size || 0) > 0;
      const now = new Date();
      const msg = await Message.create({
        id: data.id || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')),
        roomId, senderCode: sender, targetCode: target,
        text: String(data.text || ''), media: data.media || null,
        mediaType: data.mediaType || null, fileName: data.fileName || null,
        fileSize: Number.isFinite(Number(data.fileSize)) ? Number(data.fileSize) : null,
        status: targetOnline ? 'delivered' : 'sent', sentAt: now,
        deliveredAt: targetOnline ? now : null
      });
      const payload = serializeMessage(msg);
      io.to(roomId).emit('chat-message', payload);
      if (!targetOnline) sendToUser(target, 'chat-message', payload);
      if (targetOnline) sendToUser(sender, 'message-delivered', { id: msg.id, deliveredAt: msg.deliveredAt });
      sendToUser(target, 'notify-incoming-msg', { senderName: (await User.findOne({ userCode: sender }).lean())?.fullName || 'New Message', body: data.text || (data.mediaType === 'audio' ? '🎤 Voice Note' : data.mediaType === 'pdf' ? '📄 PDF Document' : `Sent a ${data.mediaType || 'file'}`) });
      sendToUser(sender, 'update-contact-lastmsg', { targetCode: target, lastMsg: payload.text || `[${payload.mediaType || 'Media'}]` });
      sendToUser(target, 'update-contact-lastmsg', { targetCode: sender, lastMsg: payload.text || `[${payload.mediaType || 'Media'}]` });
      callback({ success: true, id: msg.id, delivered: targetOnline });
    } catch (err) {
      console.error('send-message', err);
      callback({ success: false, error: 'Message could not be saved.' });
    }
  });

  socket.on('mark-message-read', async ({ roomId, messageId }) => {
    try {
      const me = socketToUser.get(socket.id);
      const msg = await Message.findOne({ id: messageId, roomId });
      if (!me || !msg || msg.targetCode !== me) return;
      if (msg.status !== 'seen') {
        msg.status = 'seen';
        msg.seenAt = new Date();
        if (!msg.deliveredAt) msg.deliveredAt = msg.seenAt;
        await msg.save();
      }
      const p = { id: msg.id, status: 'seen', deliveredAt: msg.deliveredAt, seenAt: msg.seenAt };
      io.to(roomId).emit('message-status-updated', p);
      sendToUser(msg.senderCode, 'message-status-updated', p);
    } catch (err) { console.error('mark-message-read', err); }
  });

  socket.on('mark-messages-read', async ({ roomId, messageIds = [] }) => {
    for (const id of messageIds) {
      socket.emit('internal-mark-read', { id });
      const me = socketToUser.get(socket.id);
      const msg = await Message.findOne({ id, roomId, targetCode: me });
      if (!msg) continue;
      msg.status = 'seen';
      msg.seenAt = msg.seenAt || new Date();
      msg.deliveredAt = msg.deliveredAt || msg.seenAt;
      await msg.save();
      const p = { id: msg.id, status: 'seen', deliveredAt: msg.deliveredAt, seenAt: msg.seenAt };
      io.to(roomId).emit('message-status-updated', p);
      sendToUser(msg.senderCode, 'message-status-updated', p);
    }
  });

  socket.on('mark-room-read', async ({ roomId }) => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me) return;
      const msgs = await Message.find({ roomId, targetCode: me, status: { $ne: 'seen' } }).limit(500);
      const now = new Date();
      for (const msg of msgs) {
        msg.status = 'seen';
        msg.seenAt = msg.seenAt || now;
        msg.deliveredAt = msg.deliveredAt || msg.seenAt;
        await msg.save();
        const p = { id: msg.id, status: 'seen', deliveredAt: msg.deliveredAt, seenAt: msg.seenAt };
        io.to(roomId).emit('message-status-updated', p);
        sendToUser(msg.senderCode, 'message-status-updated', p);
      }
    } catch (err) { console.error('mark-room-read', err); }
  });

  socket.on('get-message-info', async ({ id }, callback = () => {}) => {
    try {
      const me = socketToUser.get(socket.id);
      const msg = await Message.findOne({ id }).lean();
      if (!me || !msg || (msg.senderCode !== me && msg.targetCode !== me)) return callback({ success: false, error: 'Message not found.' });
      callback({ success: true, info: {
        id: msg.id, type: msg.mediaType || 'text', text: msg.text || '', fileName: msg.fileName || '', fileSize: msg.fileSize || null,
        sentAt: msg.sentAt, deliveredAt: msg.deliveredAt, seenAt: msg.seenAt, status: msg.status,
        senderCode: msg.senderCode, targetCode: msg.targetCode
      }});
    } catch (err) { callback({ success: false, error: 'Could not load message info.' }); }
  });

  socket.on('delete-message-for-everyone', async ({ roomId, id }) => {
    try {
      const me = socketToUser.get(socket.id);
      const msg = await Message.findOne({ id, roomId });
      if (!me || !msg || msg.senderCode !== me) return;
      await Message.deleteOne({ _id: msg._id });
      io.to(roomId).emit('message-deleted-for-everyone', { id });
    } catch (err) { console.error('delete', err); }
  });

  socket.on('post-status', async (statusItem, callback = () => {}) => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me || !statusItem?.media || !['image', 'video'].includes(statusItem.type)) return callback({ success: false, error: 'Invalid status.' });
      const now = new Date();
      await Status.create({ id: statusItem.id || 'st_' + Date.now(), userCode: me, media: statusItem.media, type: statusItem.type, createdAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), viewers: [] });
      const links = await Connection.find({ ownerCode: me }).lean();
      sendToUser(me, 'refresh-statuses');
      links.forEach(x => sendToUser(x.contactCode, 'refresh-statuses'));
      callback({ success: true });
    } catch (err) { console.error('post-status', err); callback({ success: false, error: 'Status could not be saved.' }); }
  });

  socket.on('get-statuses', async () => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me) return;
      const now = new Date();
      const mine = await Status.find({ userCode: me, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).lean();
      const links = await Connection.find({ ownerCode: me }).lean();
      const codes = links.map(x => x.contactCode);
      const [users, statuses] = await Promise.all([
        User.find({ userCode: { $in: codes } }).lean(),
        Status.find({ userCode: { $in: codes }, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).lean()
      ]);
      const umap = new Map(users.map(u => [u.userCode, u]));
      const grouped = new Map();
      statuses.forEach(s => { if (!grouped.has(s.userCode)) grouped.set(s.userCode, []); grouped.get(s.userCode).push({ id: s.id, media: s.media, type: s.type, time: timeText(s.createdAt), createdAt: s.createdAt, viewers: s.viewers.map(v => ({ userCode: v.userCode, name: v.name, avatar: v.avatar, time: timeText(v.viewedAt), viewedAt: v.viewedAt })) }); });
      const myItems = mine.map(s => ({ id: s.id, media: s.media, type: s.type, time: timeText(s.createdAt), createdAt: s.createdAt, viewers: s.viewers.map(v => ({ userCode: v.userCode, name: v.name, avatar: v.avatar, time: timeText(v.viewedAt), viewedAt: v.viewedAt })) }));
      socket.emit('status-data', {
        myStatus: { userCode: me, name: 'My Status', avatar: (await User.findOne({ userCode: me }).lean())?.avatar || '', items: myItems },
        contactStatuses: codes.filter(c => grouped.has(c)).map(c => ({ userCode: c, name: umap.get(c)?.fullName || c, avatar: umap.get(c)?.avatar || '', items: grouped.get(c) }))
      });
    } catch (err) { console.error('get-statuses', err); }
  });

  socket.on('mark-status-viewed', async ({ authorCode, statusId }) => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me || me === authorCode) return;
      const viewer = await User.findOne({ userCode: me }).lean();
      const status = await Status.findOne({ id: statusId, userCode: cleanUserCode(authorCode), expiresAt: { $gt: new Date() } });
      if (!viewer || !status) return;
      const existing = status.viewers.find(v => v.userCode === me);
      if (!existing) {
        status.viewers.push({ userCode: me, name: viewer.fullName, avatar: viewer.avatar || '', viewedAt: new Date() });
        await status.save();
      }
      const viewers = status.viewers.map(v => ({ userCode: v.userCode, name: v.name, avatar: v.avatar, time: timeText(v.viewedAt), viewedAt: v.viewedAt }));
      sendToUser(authorCode, 'status-viewed-updated', { statusId, viewers });
    } catch (err) { console.error('mark-status-viewed', err); }
  });

  socket.on('get-call-history', async () => {
    try {
      const me = socketToUser.get(socket.id);
      if (!me) return;
      const calls = await Call.find({ $or: [{ callerCode: me }, { receiverCode: me }] }).sort({ createdAt: -1 }).limit(100).lean();
      const otherCodes = calls.map(c => c.callerCode === me ? c.receiverCode : c.callerCode);
      const users = await User.find({ userCode: { $in: otherCodes } }).lean();
      const map = new Map(users.map(u => [u.userCode, u]));
      socket.emit('call-history-data', calls.map(c => ({ ...c, time: timeText(c.startedAt), otherUser: c.callerCode === me ? c.receiverCode : c.callerCode, otherName: map.get(c.callerCode === me ? c.receiverCode : c.callerCode)?.fullName || '', otherAvatar: map.get(c.callerCode === me ? c.receiverCode : c.callerCode)?.avatar || '' })));
    } catch (err) { console.error('call history', err); }
  });

  socket.on('call-user', async ({ targetCode, signal, callerData }) => {
    try {
      const from = socketToUser.get(socket.id);
      const target = cleanUserCode(targetCode);
      if (!from || !target) return;
      const callId = 'call_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      await Call.create({ callId, callerCode: from, receiverCode: target, startedAt: new Date(), status: 'ringing' });
      activeCalls.set(callId, { callerCode: from, receiverCode: target, startedAt: Date.now() });
      sendToUser(target, 'incoming-call', { callId, from, callerData, signal });
      sendToUser(from, 'call-record-created', { callId });
    } catch (err) { console.error('call-user', err); }
  });

  socket.on('answer-call', async ({ targetCode, signal, callId }) => {
    try {
      const me = socketToUser.get(socket.id);
      const target = cleanUserCode(targetCode);
      let call = callId ? await Call.findOne({ callId }) : await Call.findOne({ callerCode: target, receiverCode: me, status: 'ringing' }).sort({ createdAt: -1 });
      if (call) { call.answeredAt = call.answeredAt || new Date(); call.status = 'answered'; await call.save(); activeCalls.set(call.callId, { callerCode: call.callerCode, receiverCode: call.receiverCode, startedAt: call.startedAt.getTime(), answeredAt: call.answeredAt.getTime() }); }
      sendToUser(target, 'call-accepted', { signal, callId: call?.callId || callId });
    } catch (err) { console.error('answer-call', err); }
  });

  socket.on('ice-candidate', ({ targetCode, candidate }) => sendToUser(cleanUserCode(targetCode), 'ice-candidate', { candidate }));

  socket.on('end-call', async ({ targetCode, callId, rejected = false }) => {
    try {
      const me = socketToUser.get(socket.id);
      const target = cleanUserCode(targetCode);
      let call = callId ? await Call.findOne({ callId }) : await Call.findOne({ $or: [{ callerCode: me, receiverCode: target }, { callerCode: target, receiverCode: me }] }).sort({ createdAt: -1 });
      if (call && !call.endedAt) {
        call.endedAt = new Date();
        call.duration = call.answeredAt ? Math.max(0, Math.floor((call.endedAt - call.answeredAt) / 1000)) : 0;
        call.status = rejected ? 'rejected' : (call.answeredAt ? 'ended' : 'missed');
        await call.save();
      }
      if (call) activeCalls.delete(call.callId);
      sendToUser(target, 'call-ended', { callId: call?.callId || callId });
      sendToUser(me, 'call-ended', { callId: call?.callId || callId });
      sendToUser(me, 'refresh-call-history');
      sendToUser(target, 'refresh-call-history');
    } catch (err) { console.error('end-call', err); }
  });

  socket.on('disconnect', () => {
    const code = socketToUser.get(socket.id);
    if (code && userSockets.has(code)) {
      userSockets.get(code).delete(socket.id);
      if (!userSockets.get(code).size) userSockets.delete(code);
    }
    socketToUser.delete(socket.id);
  });
});

async function start() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is missing.');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    console.log('✅ MongoDB connected');
    server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

start();
