const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// इन-मेमोरी डेटाबेस (लाखों यूजर्स के लिए इसे बाद में MongoDB से जोड़ सकते हैं)
const users = {}; // userCode -> { userCode, password, fullName, avatar }
const messages = {}; // roomId -> [ { id, senderCode, text, media, mediaType, time } ]
const statuses = {}; // userCode -> { userCode, name, avatar, items: [...] }
const pendingInvites = {}; // targetCode -> [ { fromCode, fromName, fromAvatar } ]

io.on('connection', (socket) => {
  let currentUserCode = null;

  // रजिस्ट्रेशन या लॉगिन
  socket.on('auth-user', ({ userCode, password, fullName, avatar, isRegister }, callback) => {
    try {
      if (!userCode || !password) {
        return callback({ success: false, error: "User ID and Password required" });
      }

      if (isRegister) {
        if (users[userCode]) {
          return callback({ success: false, error: "User ID already exists! Choose another." });
        }
        users[userCode] = { userCode, password, fullName, avatar };
      } else {
        const existing = users[userCode];
        if (!existing || existing.password !== password) {
          return callback({ success: false, error: "Invalid User ID or 6-digit PIN" });
        }
      }

      currentUserCode = userCode;
      socket.join(userCode);

      callback({
        success: true,
        user: users[userCode]
      });
    } catch (err) {
      callback({ success: false, error: "Server error during auth" });
    }
  });

  // रिफ्रेश होने पर सेशन रिस्टोर करना
  socket.on('restore-session', ({ userCode, password }, callback) => {
    const existing = users[userCode];
    if (existing && existing.password === password) {
      currentUserCode = userCode;
      socket.join(userCode);
      callback({ success: true, user: existing });
    } else {
      callback({ success: false });
    }
  });

  // контакты / चैट्स लिस्ट भेजना
  socket.on('get-contacts', () => {
    if (!currentUserCode) return;
    const userList = [];
    // सभी रजिस्टर्ड यूजर्स को चैट लिस्ट में दिखाना (10 लाख यूजर्स के लिए इसे बाद में ऑप्टिमाइज़ करेंगे)
    for (let code in users) {
      if (code !== currentUserCode) {
        userList.push({
          userCode: code,
          name: users[code].fullName,
          avatar: users[code].avatar,
          lastMessage: "Tap to chat"
        });
      }
    }
    socket.emit('contact-list-data', { contacts: userList, pending: pendingInvites[currentUserCode] || [] });
  });

  // कमरा खोलना और पुरानी चैट लोड करना
  socket.on('open-room', ({ targetCode }) => {
    if (!currentUserCode) return;
    const roomId = [currentUserCode, targetCode].sort().join('_');
    socket.join(roomId);
    socket.emit('load-history', messages[roomId] || []);
  });

  // मैसेज भेजना
  socket.on('send-message', ({ targetCode, text, media, mediaType }) => {
    if (!currentUserCode) return;
    const roomId = [currentUserCode, targetCode].sort().join('_');
    
    if (!messages[roomId]) messages[roomId] = [];
    const msgObj = {
      id: 'msg_' + Date.now() + Math.random().toString(36.substr(2, 5)),
      senderCode: currentUserCode,
      text: text || '',
      media: media || null,
      mediaType: mediaType || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      roomId
    };
    
    messages[roomId].push(msgObj);
    io.to(roomId).emit('chat-message', msgObj);
  });

  // सबके लिए मैसेज डिलीट करना
  socket.on('delete-message-for-everyone', ({ roomId, id }) => {
    if (messages[roomId]) {
      messages[roomId] = messages[roomId].filter(m => m.id !== id);
      io.to(roomId).emit('message-deleted-for-everyone', { id });
    }
  });

  // स्टेटस पोस्ट करना
  socket.on('post-status', ({ id, media, type }) => {
    if (!currentUserCode) return;
    if (!statuses[currentUserCode]) {
      statuses[currentUserCode] = {
        userCode: currentUserCode,
        name: users[currentUserCode].fullName,
        avatar: users[currentUserCode].avatar,
        items: []
      };
    }
    statuses[currentUserCode].items.unshift({
      id,
      media,
      type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      viewers: []
    });
    io.emit('refresh-statuses');
  });

  // स्टेटस फेच करना
  socket.on('get-statuses', () => {
    if (!currentUserCode) return;
    const myStatus = statuses[currentUserCode] || null;
    const contactStatuses = [];
    for (let code in statuses) {
      if (code !== currentUserCode) {
        contactStatuses.push(statuses[code]);
      }
    }
    socket.emit('status-data', { myStatus, contactStatuses });
  });

  // स्टेटस व्यू करना
  socket.on('mark-status-viewed', ({ authorCode, statusId }) => {
    if (!currentUserCode || !statuses[authorCode]) return;
    const item = statuses[authorCode].items.find(s => s.id === statusId);
    if (item) {
      if (!item.viewers.some(v => v.userCode === currentUserCode)) {
        item.viewers.push({
          userCode: currentUserCode,
          name: users[currentUserCode].fullName,
          avatar: users[currentUserCode].avatar,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        io.to(authorCode).emit('status-viewed-updated', { statusId, viewers: item.viewers });
      }
    }
  });

  // WebRTC कॉलिंग सिग्नलिंग
  socket.on('call-user', ({ targetCode, signal, callerData }) => {
    io.to(targetCode).emit('incoming-call', { from: currentUserCode, signal, callerData });
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

  socket.on('disconnect', () => {
    currentUserCode = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
