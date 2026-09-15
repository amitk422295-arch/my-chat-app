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

// Lightweight health endpoint for external uptime monitors.
// NOTE: Render's free tier can still sleep; application code alone cannot guarantee 24/7 uptime.
app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'chat-app', time: new Date().toISOString() }));

// MongoDB Connection (Render environment variable MONGO_URI)
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

const callSchema = new mongoose.Schema({ callerCode: String, otherUser: String, otherName: String, otherAvatar: String, status: String, timestamp: { type: Date, default: Date.now } });
const Call = mongoose.model('Call', callSchema);

// Persistent direct-chat messages
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

// Cloudinary signature
app.post('/api/cloudinary-signature', (req, res) => {
  const timestamp = Math.round(new Date().getTime() / 1000);
  const folder = req.body.folder || 'your-chat-app/status';
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'demo';
  const apiKey = process.env.CLOUDINARY_API_KEY || '123456';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || 'secret';
  const str = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(str).digest('hex');
  res.json({ cloudName, apiKey, timestamp, folder, signature });
});

io.on('connection', (socket) => {
  let currentUserCode = null;

  // 1. AUTHENTICATION (Register & Login)
  socket.on('auth-user', async ({ userCode, password, fullName, mobile, avatar, isRegister }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();

    try {
      if (isRegister) {
        const uCode = query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase();
        if (!/^@[a-z0-9_]{6,}$/.test(uCode)) {
          return callback({ success: false, error: 'User ID must start with @ and have min 6 lowercase letters/numbers/underscore.' });
        }
        if (passStr.length !== 8) {
          return callback({ success: false, error: 'New registration password must be strictly 8 digits.' });
        }
        
        const existing = await User.findOne({ userCode: uCode });
        if (existing) return callback({ success: false, error: 'User ID already exists.' });

        const newUser = await User.create({
          userCode: uCode,
          password: passStr,
          fullName: fullName || 'User',
          mobile: mobile || '',
          avatar: avatar || '',
          blockedByMe: {}
        });
        currentUserCode = uCode;
        socket.join(uCode);
        io.emit('user-online-status', { targetCode: uCode, isOnline: true });
        return callback({ success: true, user: newUser });
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
        if (passStr.length !== 6 && passStr.length !== 8) {
          return callback({ success: false, error: 'Password must be 6 digits (old user) or 8 digits (new user).' });
        }
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

  // 2. RECOVERY VERIFY & UPDATE
  socket.on('verify-recovery', async ({ userCode, mobile }, callback) => {
    const rawId = String(userCode || '').trim().toLowerCase();
    const uCode = rawId.startsWith('@') ? rawId : '@' + rawId;
    const mob = String(mobile || '').trim();
    try {
      const userObj = await User.findOne({ userCode: uCode, mobile: mob });
      if (userObj) return callback({ success: true });
      return callback({ success: false, error: 'User ID and mobile number do not match.' });
    } catch (e) {
      return callback({ success: false, error: 'Verification failed.' });
    }
  });

  socket.on('update-password', async ({ userCode, newPassword }, callback) => {
    const rawId = String(userCode || '').trim().toLowerCase();
    const uCode = rawId.startsWith('@') ? rawId : '@' + rawId;
    const passStr = String(newPassword || '').trim();
    if (passStr.length !== 6 && passStr.length !== 8) {
      return callback({ success: false, error: 'New password must be 6 or 8 digits.' });
    }
    try {
      const userObj = await User.findOneAndUpdate({ userCode: uCode }, { password: passStr });
      if (!userObj) return callback({ success: false, error: 'User not found.' });
      return callback({ success: true });
    } catch (e) {
      return callback({ success: false, error: 'Password update failed.' });
    }
  });

  // 3. STATUSES & CONTACTS
  socket.on('get-statuses', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      let myStatusDoc = await Status.findOne({ userCode: currentUserCode });
      const myStatus = myStatusDoc ? myStatusDoc.toObject() : { userCode: currentUserCode, name: me?.fullName, avatar: me?.avatar, items: [] };
      const meData = await User.findOne({ userCode: currentUserCode }).lean();
      const allowedContacts = Array.isArray(meData?.contacts) ? meData.contacts : [];
      const contactsListDocs = allowedContacts.length
        ? await Status.find({ userCode: { $in: allowedContacts } })
        : [];
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
      socket.emit('status-posted', { success: true });
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
      socket.emit('contact-list-data', { contacts: allUsers.map(u => ({ userCode: u.userCode, name: u.fullName, avatar: u.avatar, lastMessage: '' })) });
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

      // Searching a user creates the private contact relationship. No random user discovery.
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
      currentUserCode && socket.emit('profile-updated', { user: user.toObject() });
      callback && callback({ success: true, user: user.toObject() });
    } catch (e) { callback && callback({ success: false, error: 'Profile update failed.' }); }
  });

  // 4. FAST PERSISTENT CHAT
  socket.on('get-messages', async ({ targetCode }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    try {
      const clean = String(targetCode || '').toLowerCase();
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      if (!Array.isArray(me?.contacts) || !me.contacts.includes(clean)) return callback && callback({ success:false, error:'This user is not in your contacts.' });
      const messages = await Message.find({
        $or: [
          { senderCode: currentUserCode, receiverCode: clean },
          { senderCode: clean, receiverCode: currentUserCode }
        ],
        deletedFor: { $ne: currentUserCode }
      }).sort({ createdAt: 1 }).limit(500).lean();
      const safe = messages.map(m => ({
        messageId: m.messageId, senderCode: m.senderCode, receiverCode: m.receiverCode,
        text: m.deletedForEveryone ? 'This message was deleted' : m.text,
        media: m.deletedForEveryone ? '' : (m.media || ''),
        messageType: m.deletedForEveryone ? 'text' : (m.messageType || 'text'),
        duration: m.duration || 0,
        createdAt: m.createdAt, deletedForEveryone: !!m.deletedForEveryone
      }));
      callback && callback({ success: true, messages: safe });
    } catch (e) { callback && callback({ success: false, error: 'Could not load messages.' }); }
  });

  socket.on('send-message', async ({ targetCode, text, media, messageType, duration, clientMessageId }, callback) => {
    if (!currentUserCode) return callback && callback({ success: false, error: 'Not authenticated.' });
    const receiverCode = String(targetCode || '').trim().toLowerCase();
    const messageText = String(text || '').trim();
    const type = messageType === 'audio' ? 'audio' : 'text';
    if (!receiverCode || (type === 'text' && !messageText) || (type === 'audio' && !media)) return callback && callback({ success: false, error: 'Empty message.' });
    if (messageText.length > 5000) return callback && callback({ success: false, error: 'Message is too long.' });
    if (type === 'audio' && String(media).length > 15000000) return callback && callback({ success: false, error: 'Voice message is too large.' });
    try {
      const me = await User.findOne({ userCode: currentUserCode }).lean();
      const other = await User.findOne({ userCode: receiverCode }).lean();
      if (!other) return callback && callback({ success: false, error: 'User not found.' });
      if (!Array.isArray(me?.contacts) || !me.contacts.includes(receiverCode)) return callback && callback({ success:false, error:'Search and add this user first.' });
      if (me?.blockedByMe?.[receiverCode]) return callback && callback({ success: false, error: 'Unblock this user before sending messages.' });
      if (other?.blockedByMe?.[currentUserCode]) return callback && callback({ success: false, error: 'You cannot message this user.' });
      const msg = await Message.create({
        messageId: String(clientMessageId || ('msg_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'))),
        senderCode: currentUserCode, receiverCode, text: messageText, media: type === 'audio' ? String(media) : '', messageType: type, duration: Number(duration || 0)
      });
      const payload = {
        messageId: msg.messageId, senderCode: msg.senderCode, receiverCode: msg.receiverCode,
        text: msg.text, media: msg.media, messageType: msg.messageType, duration: msg.duration,
        createdAt: msg.createdAt, deletedForEveryone: false
      };
      io.to(currentUserCode).to(receiverCode).emit('new-message', payload);
      callback && callback({ success: true, message: payload });
    } catch (e) { callback && callback({ success: false, error: 'Message could not be sent.' }); }
  });

  socket.on('delete-message', async ({ messageId, mode }, callback) => {
    if (!currentUserCode || !messageId) return callback && callback({ success: false });
    try {
      const msg = await Message.findOne({ messageId });
      if (!msg) return callback && callback({ success: false, error: 'Message not found.' });
      const isParticipant = msg.senderCode === currentUserCode || msg.receiverCode === currentUserCode;
      if (!isParticipant) return callback && callback({ success: false, error: 'Not allowed.' });

      if (mode === 'everyone') {
        if (msg.senderCode !== currentUserCode) return callback && callback({ success: false, error: 'Only the sender can delete for everyone.' });
        msg.deletedForEveryone = true;
        msg.text = '';
        await msg.save();
        io.to(msg.senderCode).to(msg.receiverCode).emit('message-deleted', { messageId, mode: 'everyone' });
      } else {
        if (!msg.deletedFor.includes(currentUserCode)) {
          msg.deletedFor.push(currentUserCode);
          await msg.save();
        }
        socket.emit('message-deleted', { messageId, mode: 'me' });
      }
      callback && callback({ success: true });
    } catch (e) { callback && callback({ success: false, error: 'Delete failed.' }); }
  });

  socket.on('block-user', async ({ targetCode }, callback) => {
    if (!currentUserCode) return callback && callback({ success:false, error:'Not authenticated.' });
    const clean=String(targetCode||'').toLowerCase();
    try { const target=await User.findOne({userCode:clean}); if(!target)return callback&&callback({success:false,error:'User not found.'}); await User.updateOne({userCode:currentUserCode},{ $set: { [`blockedByMe.${clean}`]: true } }); callback&&callback({success:true}); }
    catch(e){ callback&&callback({success:false,error:'Block failed.'}); }
  });
  socket.on('unblock-user', async ({ targetCode }, callback) => {
    if (!currentUserCode) return callback && callback({ success:false, error:'Not authenticated.' });
    const clean=String(targetCode||'').toLowerCase();
    try { await User.updateOne({userCode:currentUserCode},{ $unset: { [`blockedByMe.${clean}`]: '' } }); callback&&callback({success:true}); }
    catch(e){ callback&&callback({success:false,error:'Unblock failed.'}); }
  });
  socket.on('check-blocked', async ({ targetCode }, callback) => {
    if (!currentUserCode) return callback&&callback({success:false});
    const clean=String(targetCode||'').toLowerCase();
    try { const me=await User.findOne({userCode:currentUserCode}).lean(); callback&&callback({success:true,blocked:!!me?.blockedByMe?.[clean]}); }
    catch(e){ callback&&callback({success:false}); }
  });
  socket.on('get-blocked-users', async () => {
    if (!currentUserCode) return;
    try { const me=await User.findOne({userCode:currentUserCode}).lean(); const ids=Object.entries(me?.blockedByMe||{}).filter(([,v])=>v).map(([k])=>k); const users=await User.find({userCode:{$in:ids}}).select('userCode fullName avatar').lean(); socket.emit('blocked-users-data',users); }
    catch(e){ socket.emit('blocked-users-data',[]); }
  });

  socket.on('check-online', ({ targetCode }) => {
    const clean = String(targetCode || '').toLowerCase();
    let online = false;
    for (const s of io.sockets.sockets.values()) {
      if (s.rooms.has(clean)) { online = true; break; }
    }
    socket.emit('online-check-result', { targetCode: clean, isOnline: online });
  });


  // ===== WebRTC call signaling (media stays peer-to-peer) =====
  socket.on('call-offer', ({ targetCode, offer, caller }) => {
    if (!currentUserCode || !targetCode || !offer) return;
    io.to(String(targetCode).toLowerCase()).emit('call-offer', { fromCode: currentUserCode, offer, caller });
  });
  socket.on('call-answer', ({ targetCode, answer }) => {
    if (!currentUserCode || !targetCode || !answer) return;
    io.to(String(targetCode).toLowerCase()).emit('call-answer', { fromCode: currentUserCode, answer });
  });
  socket.on('call-ice', ({ targetCode, candidate }) => {
    if (!currentUserCode || !targetCode || !candidate) return;
    io.to(String(targetCode).toLowerCase()).emit('call-ice', { fromCode: currentUserCode, candidate });
  });
  socket.on('call-reject', async ({ targetCode }) => {
    if (!(await isContactForCurrentUser(targetCode))) return;
    io.to(String(targetCode).toLowerCase()).emit('call-rejected', { fromCode: currentUserCode });
  });
  socket.on('call-busy', async ({ targetCode }) => {
    if (!(await isContactForCurrentUser(targetCode))) return;
    io.to(String(targetCode).toLowerCase()).emit('call-busy', { fromCode: currentUserCode });
  });
  socket.on('call-end', async ({ targetCode }) => {
    if (!(await isContactForCurrentUser(targetCode))) return;
    io.to(String(targetCode).toLowerCase()).emit('call-ended', { fromCode: currentUserCode });
  });

  socket.on('disconnect', () => {
    if (currentUserCode) io.emit('user-online-status', { targetCode: currentUserCode, isOnline: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
