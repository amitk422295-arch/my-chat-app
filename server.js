const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const messages = {};
const statuses = {};
const pendingInvites = {};

io.on('connection', (socket) => {
  let currentUserCode = null;

  socket.on('auth-user', ({ userCode, password, fullName, avatar, isRegister }, callback) => {
    try {
      if (!userCode || !password) {
        return callback({ success: false, error: "User ID and PIN required" });
      }

      if (isRegister) {
        if (users[userCode]) {
          return callback({ success: false, error: "User ID already exists!" });
        }
        users[userCode] = { userCode, password, fullName, avatar };
      } else {
        const existing = users[userCode];
        if (!existing || existing.password !== password) {
          return callback({ success: false, error: "Invalid ID or PIN" });
        }
      }

      currentUserCode = userCode;
      socket.join(userCode);
      callback({ success: true, user: users[userCode] });
    } catch (err) {
      callback({ success: false, error: "Server error" });
    }
  });

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

  socket.on('get-contacts', () => {
    if (!currentUserCode) return;
    const userList = [];
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

  socket.on('open-room', ({ targetCode }) => {
    if (!currentUserCode) return;
    const roomId = [currentUserCode, targetCode].sort().join('_');
    socket.join(roomId);
    socket.emit('load-history', messages[roomId] || []);
  });

  socket.on('send-message', ({ targetCode, text, media, mediaType }) => {
    if (!currentUserCode) return;
    const roomId = [currentUserCode, targetCode].sort().join('_');
    if (!messages[roomId]) messages[roomId] = [];
    
    const msgObj = {
      id: 'msg_' + Date.now(),
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

  socket.on('delete-message-for-everyone', ({ roomId, id }) => {
    if (messages[roomId]) {
      messages[roomId] = messages[roomId].filter(m => m.id !== id);
      io.to(roomId).emit('message-deleted-for-everyone', { id });
    }
  });

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
      id, media, type,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      viewers: []
    });
    io.emit('refresh-statuses');
  });

  socket.on('get-statuses', () => {
    if (!currentUserCode) return;
    const myStatus = statuses[currentUserCode] || null;
    const contactStatuses = [];
    for (let code in statuses) {
      if (code !== currentUserCode) contactStatuses.push(statuses[code]);
    }
    socket.emit('status-data', { myStatus, contactStatuses });
  });

  socket.on('mark-status-viewed', ({ authorCode, statusId }) => {
    if (!currentUserCode || !statuses[authorCode]) return;
    const item = statuses[authorCode].items.find(s => s.id === statusId);
    if (item && !item.viewers.some(v => v.userCode === currentUserCode)) {
      item.viewers.push({
        userCode: currentUserCode,
        name: users[currentUserCode].fullName,
        avatar: users[currentUserCode].avatar,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
      io.to(authorCode).emit('status-viewed-updated', { statusId, viewers: item.viewers });
    }
  });

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
