const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple JSON database storage for persistence
const DB_FILE = path.join(__dirname, 'database.json');
let db = { users: {}, statuses: {}, calls: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e){}
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

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

  // 1. AUTHENTICATION (Old users: 6 digits, New users/Register: 8 digits strictly)
  socket.on('auth-user', ({ userCode, password, fullName, mobile, avatar, isRegister }, callback) => {
    const query = String(userCode || '').trim();
    const passStr = String(password || '').trim();

    if (isRegister) {
      const uCode = query.startsWith('@') ? query.toLowerCase() : '@' + query.toLowerCase();
      if (!/^@[a-z]{6,}$/.test(uCode)) return callback({ success: false, error: 'User ID must start with @ and have min 6 lowercase alphabetic letters.' });
      if (passStr.length !== 8) return callback({ success: false, error: 'New registration password must be strictly 8 digits.' });
      if (db.users[uCode]) return callback({ success: false, error: 'User ID already exists.' });

      db.users[uCode] = { userCode: uCode, password: passStr, fullName: fullName || 'User', mobile: mobile || '', avatar: avatar || '', blockedBy: {} };
      saveDB();
      currentUserCode = uCode; socket.join(uCode);
      io.emit('user-online-status', { targetCode: uCode, isOnline: true });
      return callback({ success: true, user: db.users[uCode] });
    } else {
      // Login by userCode (@...) or mobile number
      let userObj = Object.values(db.users).find(u => u.userCode.toLowerCase() === query.toLowerCase() || u.mobile === query);
      if (!userObj) return callback({ success: false, error: 'Account not found by ID or mobile.' });

      // Support old 6-digit or new 8-digit password login
      if (passStr.length !== 6 && passStr.length !== 8) {
        return callback({ success: false, error: 'Password must be 6 digits (old user) or 8 digits (new user).' });
      }
      if (userObj.password !== passStr) return callback({ success: false, error: 'Incorrect password.' });

      currentUserCode = userObj.userCode; socket.join(currentUserCode);
      io.emit('user-online-status', { targetCode: currentUserCode, isOnline: true });
      return callback({ success: true, user: userObj });
    }
  });

  // 2. RECOVERY VERIFICATION (Check User ID + Mobile match)
  socket.on('verify-recovery', ({ userCode, mobile }, callback) => {
    const query = String(userCode || '').trim().toLowerCase();
    const uCode = query.startsWith('@') ? query : '@' + query;
    const mob = String(mobile || '').trim();
    const userObj = Object.values(db.users).find(u => u.userCode.toLowerCase() === uCode.toLowerCase() && u.mobile === mob);
    if (userObj) {
      return callback({ success: true });
    }
    return callback({ success: false, error: 'User ID and mobile number do not match.' });
  });

  // 3. UPDATE PASSWORD AFTER RECOVERY
  socket.on('update-password', ({ userCode, newPassword }, callback) => {
    const query = String(userCode || '').trim().toLowerCase();
    const uCode = query.startsWith('@') ? query : '@' + query;
    const passStr = String(newPassword || '').trim();
    if (passStr.length !== 6 && passStr.length !== 8) {
      return callback({ success: false, error: 'New password must be 6 or 8 digits.' });
    }
    const userObj = db.users[uCode];
    if (!userObj) return callback({ success: false, error: 'User not found.' });
    userObj.password = passStr;
    saveDB();
    return callback({ success: true });
  });

  // 4. STATUSES
  socket.on('get-statuses', () => {
    if (!currentUserCode) return;
    const myStatus = db.statuses[currentUserCode] || { userCode: currentUserCode, name: db.users[currentUserCode]?.fullName, avatar: db.users[currentUserCode]?.avatar, items: [] };
    const contactsList = Object.values(db.statuses).filter(s => s.userCode !== currentUserCode);
    socket.emit('status-data', { myStatus, contactStatuses: contactsList });
  });

  socket.on('post-status', (statusItem) => {
    if (!currentUserCode) return;
    if (!db.statuses[currentUserCode]) {
      db.statuses[currentUserCode] = { userCode: currentUserCode, name: db.users[currentUserCode]?.fullName, avatar: db.users[currentUserCode]?.avatar, items: [] };
    }
    db.statuses[currentUserCode].items.push({ ...statusItem, time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}), viewers: [] });
    saveDB();
  });

  socket.on('delete-status', ({ statusId }, cb) => {
    if (!currentUserCode || !db.statuses[currentUserCode]) return cb && cb({ success: false });
    db.statuses[currentUserCode].items = db.statuses[currentUserCode].items.filter(i => i.id !== statusId);
    saveDB();
    cb && cb({ success: true });
  });

  socket.on('mark-status-viewed', ({ authorCode, statusId }) => {
    if (!currentUserCode || !db.statuses[authorCode]) return;
    const item = db.statuses[authorCode].items.find(i => i.id === statusId);
    if (item && !item.viewers.some(v => v.userCode === currentUserCode)) {
      item.viewers.push({ userCode: currentUserCode, name: db.users[currentUserCode]?.fullName, avatar: db.users[currentUserCode]?.avatar });
      saveDB();
    }
  });

  // 5. CONTACTS & DIRECT CHAT
  socket.on('get-contacts', () => {
    if (!currentUserCode) return;
    const allUsers = Object.values(db.users).filter(u => u.userCode !== currentUserCode).map(u => ({
      userCode: u.userCode,
      name: u.fullName,
      avatar: u.avatar,
      lastMessage: ''
    }));
    socket.emit('contact-list-data', { contacts: allUsers });
  });

  socket.on('open-direct-chat', ({ targetCode, query }, cb) => {
    const clean = targetCode.startsWith('@') ? targetCode.toLowerCase() : '@' + targetCode.toLowerCase();
    let targetUser = db.users[clean] || Object.values(db.users).find(u => u.mobile === query);
    if (targetUser) {
      cb({ success: true, user: { userCode: targetUser.userCode, fullName: targetUser.fullName, avatar: targetUser.avatar } });
    } else {
      cb({ success: false, error: 'User not found.' });
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
  socket.on('update-profile', ({ fullName, avatar, newPassword }, cb) => {
    if (!currentUserCode || !db.users[currentUserCode]) return cb({ success: false, error: 'Unauthorized' });
    const userObj = db.users[currentUserCode];
    if (fullName) userObj.fullName = fullName;
    if (avatar) userObj.avatar = avatar;
    if (newPassword && (newPassword.length === 6 || newPassword.length === 8)) userObj.password = newPassword;
    saveDB();
    cb({ success: true, user: userObj });
  });

  socket.on('get-block-status', ({ targetCode }, cb) => {
    const u = db.users[currentUserCode];
    const blocked = u && u.blockedByMe && u.blockedByMe[targetCode];
    cb({ blockedByMe: !!blocked });
  });

  socket.on('toggle-block', ({ targetCode }, cb) => {
    const u = db.users[currentUserCode];
    if (!u) return cb({ success: false });
    if (!u.blockedByMe) u.blockedByMe = {};
    const curr = u.blockedByMe[targetCode];
    u.blockedByMe[targetCode] = !curr;
    saveDB();
    cb({ success: true, blockedByMe: !curr });
  });

  // 8. AUDIO CALL SIGNALING (Video calls completely removed)
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
  socket.on('get-call-history', () => {
    socket.emit('call-history-data', db.calls || []);
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
