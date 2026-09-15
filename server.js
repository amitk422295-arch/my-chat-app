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
  blockedByMe: { type: Map, of: Boolean, default: {} }
});
const User = mongoose.model('User', userSchema);

const viewerSchema = new mongoose.Schema({ userCode: String, name: String, avatar: String }, { _id: false });
const statusItemSchema = new mongoose.Schema({ id: String, media: String, type: String, time: String, viewers: [viewerSchema] }, { _id: false });
const statusSchema = new mongoose.Schema({ userCode: { type: String, unique: true, lowercase: true }, name: String, avatar: String, items: [statusItemSchema] });
const Status = mongoose.model('Status', statusSchema);

const callSchema = new mongoose.Schema({ callerCode: String, otherUser: String, otherName: String, otherAvatar: String, status: String, timestamp: { type: Date, default: Date.now } });
const Call = mongoose.model('Call', callSchema);

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
      const contactsListDocs = await Status.find({ userCode: { $ne: currentUserCode } });
      socket.emit('status-data', { myStatus, contactStatuses: contactsListDocs.map(s => s.toObject()) });
    } catch (e) {}
  });

  socket.on('post-status', async (statusItem) => {
    if (!currentUserCode) return;
    try {
      const me = await User.findOne({ userCode: currentUserCode });
      const newItem = { ...statusItem, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), viewers: [] };
      await Status.findOneAndUpdate({ userCode: currentUserCode }, { $setOnInsert: { name: me?.fullName || 'User', avatar: me?.avatar || '' }, $push: { items: newItem } }, { upsert: true, new: true });
    } catch (e) {}
  });

  socket.on('delete-status', async ({ statusId }, cb) => {
    if (!currentUserCode) return cb && cb({ success: false });
    try { await Status.updateOne({ userCode: currentUserCode }, { $pull: { items: { id: statusId } } }); cb && cb({ success: true }); }
    catch (e) { cb && cb({ success: false }); }
  });

  socket.on('get-contacts', async () => {
    if (!currentUserCode) return;
    try {
      const allUsers = await User.find({ userCode: { $ne: currentUserCode } });
      socket.emit('contact-list-data', { contacts: allUsers.map(u => ({ userCode: u.userCode, name: u.fullName, avatar: u.avatar, lastMessage: '' })) });
    } catch (e) {}
  });

  socket.on('open-direct-chat', async ({ targetCode, query }, cb) => {
    try {
      const clean = targetCode.startsWith('@') ? targetCode.toLowerCase() : '@' + targetCode.toLowerCase();
      let targetUser = await User.findOne({ $or: [{ userCode: clean }, { mobile: query }] });
      if (targetUser) cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar } });
      else cb({ success: false, error: 'User not found.' });
    } catch (e) { cb({ success: false, error: 'Error finding user.' }); }
  });

  socket.on('disconnect', () => {
    if (currentUserCode) io.emit('user-online-status', { targetCode: currentUserCode, isOnline: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
