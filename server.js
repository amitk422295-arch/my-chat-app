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

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/chat-app', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas & Models
const userSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, required: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, default: 'User' },
  mobile: { type: String, default: '' },
  avatar: { type: String, default: '' },
  blockedByMe: { type: Map, of: Boolean, default: {} }
});
const User = mongoose.model('User', userSchema);

const viewerSchema = new mongoose.Schema({
  userCode: String,
  name: String,
  avatar: String
}, { _id: false });

const statusItemSchema = new mongoose.Schema({
  id: String,
  media: String,
  type: String,
  time: String,
  viewers: [viewerSchema]
}, { _id: false });

const statusSchema = new mongoose.Schema({
  userCode: { type: String, unique: true, lowercase: true },
  name: String,
  avatar: String,
  items: [statusItemSchema]
});
const Status = mongoose.model('Status', statusSchema);

const callSchema = new mongoose.Schema({
  callerCode: String,
  otherUser: String,
  otherName: String,
  otherAvatar: String,
  status: String,
  timestamp: { type: Date, default: Date.now }
});
const Call = mongoose.model('Call', callSchema);

// Cloudinary signature endpoint
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

  // 1. AUTHENTICATION (Smart lookup + Register/Login)
  socket.on('auth-user', async ({ userCode, password, fullName, mobile, avatar, isRegister }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();

    try {
      if (isRegister) {
        const uCode = query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase();
        if (!/^@[a-z]{6,}$/.test(uCode)) return callback({ success: false, error: 'User ID must start with @ and have min 6 lowercase alphabetic letters.' });
        if (passStr.length !== 8) return callback({ success: false, error: 'New registration password must be strictly 8 digits.' });
        
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
        // स्मार्ट लुकअप: मोबाइल नंबर या यूजर आईडी (@ के साथ या बिना दोनों डिटेक्ट करेगा)
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

  // 2. RECOVERY VERIFICATION
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

  // 3. UPDATE PASSWORD AFTER RECOVERY
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

  // 4. STATUSES
  socket.on('get-statuses', async () => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      let myStatusDoc = await Status.findOne({ userCode: currentUserCode });
      const myStatus = myStatusDoc ? myStatusDoc.toObject() : { userCode: currentUserCode, name: me?.fullName, avatar: me?.avatar, items: [] };
      const contactsListDocs = await Status.find({ userCode: { $ne: currentUserCode } });
      const contactsList = contactsListDocs.map(s => s.toObject());
      socket.emit('status-data', { myStatus, contactStatuses: contactsList });
    } catch (e) {}
  });

  socket.on('post-status', async (statusItem) => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      const newItem = {
        ...statusItem,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        viewers: []
      };
      await Status.findOneAndUpdate(
        { userCode: currentUserCode },
        {
          $setOnInsert: { name: me?.fullName || 'User', avatar: me?.avatar || '' },
          $push: { items: newItem }
        },
        { upsert: true, new: true }
      );
    } catch (e) {}
  });

  socket.on('delete-status', async ({ statusId }, cb) => {
    if (!currentUserCode) return cb && cb({ success: false });
    try {
      await Status.updateOne({ userCode: currentUserCode }, { $pull: { items: { id: statusId } } });
      cb && cb({ success: true });
    } catch (e) {
      cb && cb({ success: false });
    }
  });

  socket.on('mark-status-viewed', async ({ authorCode, statusId }) => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      const doc = await Status.findOne({ userCode: authorCode, 'items.id': statusId });
      if (doc) {
        const item = doc.items.find(i => i.id === statusId);
        if (item && !item.viewers.some(v => v.userCode === currentUserCode)) {
          item.viewers.push({ userCode: currentUserCode, name: me?.fullName || 'User', avatar: me?.avatar || '' });
          await doc.save();
        }
      }
    } catch (e) {}
  });

  // 5. CONTACTS & DIRECT CHAT
  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      const allUsers = await User.find({ userCode: { $ne: currentUserCode } });
      const contacts = allUsers.map(u => ({
        userCode: u.userCode,
        name: u.fullName,
        avatar: u.avatar,
        lastMessage: ''
      }));
      socket.emit('contact-list-data', { contacts });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    try {
      const clean = targetCode.startsWith('@') ? targetCode.toLowerCase() : '@' + targetCode.toLowerCase();
      let targetUser = await User.findOne({ $or: [{ userCode: clean }, { mobile: query }] });
      if (targetUser) {
        cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar } });
      } else {
        cb({ success: false, error: 'User not found.' });
      }
    } catch (e) {
      cb({ success: false, error: 'Error finding user.' });
    }
  });

  socket.on('open-room', () => {});

  // 6. TYPING / ONLINE
  socket.on('typing', ({ targetCode, roomId }) => {
    io.to(targetCode).emit('user-typing', { targetCode: currentUserCode, roomId });
  });
  socket.on('check-online', ({ targetCode }) => {
    const isOnline = io.sockets.adapter.rooms.has(targetCode);
    socket.emit('user-online-status', { targetCode, isOnline });
  });

  // 7. PROFILE & BLOCK
  socket.on('update-profile', async ({ fullName, avatar, newPassword }, cb) => {
    if (!currentUserCode) return cb({ success: false, error: 'Unauthorized' });
    try {
      const updateData = {};
      if (fullName) updateData.fullName = fullName;
      if (avatar) updateData.avatar = avatar;
      if (newPassword && (newPassword.length === 6 || newPassword.length === 8)) updateData.password = newPassword;
      
      const updatedUser = await User.findOneAndUpdate({ userCode: currentUserCode }, updateData, { new: true });
      if (updatedUser) {
        await Status.updateOne({ userCode: currentUserCode }, { $set: { name: updatedUser.fullName, avatar: updatedUser.avatar } });
        cb({ success: true, user: updatedUser });
      } else {
        cb({ success: false, error: 'User not found' });
      }
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  socket.on('get-block-status', async ({ targetCode }, cb) => {
    try {
      const u = await User.findOne({ userCode: currentUserCode });
      const blocked = u && u.blockedByMe && (u.blockedByMe.get ? u.blockedByMe.get(targetCode) : u.blockedByMe[targetCode]);
      cb({ blockedByMe: !!blocked });
    } catch (e) {
      cb({ blockedByMe: false });
    }
  });

  socket.on('toggle-block', async ({ targetCode }, cb) => {
    try {
      const u = await User.findOne({ userCode: currentUserCode });
      if (!u) return cb({ success: false });
      if (!u.blockedByMe) u.blockedByMe = new Map();
      const curr = u.blockedByMe.get ? u.blockedByMe.get(targetCode) : u.blockedByMe[targetCode];
      const nextVal = !curr;
      if (u.blockedByMe.set) {
        u.blockedByMe.set(targetCode, nextVal);
      } else {
        u.blockedByMe[targetCode] = nextVal;
      }
      await u.save();
      cb({ success: true, blockedByMe: nextVal });
    } catch (e) {
      cb({ success: false, error: e.message });
    }
  });

  // 8. AUDIO CALL SIGNALING & HISTORY
  socket.on('call-user', ({ targetCode, signal, callerData }) => {
    io.to(targetCode).emit('incoming-call', { from: currentUserCode, signal, callerData, isVideo: false });
  });
  socket.on('answer-call', ({ targetCode, signal }) => {
    io.to(targetCode).emit('call-accepted', { signal });
  });
  socket.on('ice-candidate', ({ targetCode, candidate }) => {
    io.to(targetCode).emit('ice-candidate', { candidate });
  });
  socket.on('end-call', ({ targetCode }) => {
    io.to(targetCode).emit('call-ended');
  });
  socket.on('get-call-history', async () => {
    try {
      const calls = await Call.find({}).sort({ timestamp: -1 }).limit(50);
      socket.emit('call-history-data', calls);
    } catch (e) {
      socket.emit('call-history-data', []);
    }
  });

  socket.on('disconnect', () => {
    if (currentUserCode) {
      io.emit('user-online-status', { targetCode: currentUserCode, isOnline: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
