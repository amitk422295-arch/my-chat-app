const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 1e8,
  pingInterval: 5000, 
  pingTimeout: 3000,
  cors: { origin: "*" }
});

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const users = new Map(); 
const userSockets = new Map(); 
const socketToUser = new Map(); 
const roomMessages = new Map(); 
const globalStatuses = new Map(); 

function getTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit' });
}

function sendToUser(userCode, event, data) {
  const sockets = userSockets.get(userCode);
  if (sockets) {
    sockets.forEach(sId => io.to(sId).emit(event, data));
  }
}

console.log("==========================================");
console.log("🔥 FULL POPUP & LIVE AUTO-SYNC ENGINE 🔥");
console.log("==========================================");

io.on('connection', (socket) => {
  function mapSocket(uCode) {
    if (!userSockets.has(uCode)) userSockets.set(uCode, new Set());
    userSockets.get(uCode).add(socket.id);
    socketToUser.set(socket.id, uCode);
  }

  socket.on('auth-user', ({ userCode, password, fullName, avatar, isRegister }, callback) => {
    let cleanCode = userCode.trim().toLowerCase();
    if (!cleanCode.startsWith('@')) cleanCode = '@' + cleanCode;

    if (isRegister) {
      if (!avatar) return callback({ success: false, error: 'Profile Photo is mandatory!' });
      if (!fullName || !fullName.trim()) return callback({ success: false, error: 'Full Name is mandatory!' });
      if (!cleanCode || cleanCode.length < 3) return callback({ success: false, error: 'Valid User ID is mandatory!' });
      if (!/^\d{6}$/.test(password)) return callback({ success: false, error: 'PIN must be 6 digits!' });

      if (users.has(cleanCode)) return callback({ success: false, error: 'User ID already exists!' });

      const newUser = { userCode: cleanCode, password, fullName: fullName.trim(), avatar, contacts: [], pendingRequests: [] };
      users.set(cleanCode, newUser);
      mapSocket(cleanCode);
      callback({ success: true, user: newUser });
    } else {
      const existingUser = users.get(cleanCode);
      if (!existingUser) return callback({ success: false, error: 'User ID not found!' });
      if (existingUser.password !== password) return callback({ success: false, error: 'Incorrect 6-digit PIN!' });

      mapSocket(cleanCode);
      callback({ success: true, user: existingUser });
    }
  });

  socket.on('restore-session', ({ userCode, password }, callback) => {
    let cleanCode = (userCode || '').trim().toLowerCase();
    const existingUser = users.get(cleanCode);
    if (existingUser && existingUser.password === password) {
      mapSocket(cleanCode);
      callback({ success: true, user: existingUser });
    } else {
      callback({ success: false });
    }
  });

  socket.on('get-contacts', () => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode || !users.has(uCode)) return;
    const me = users.get(uCode);

    const contactList = me.contacts.map(cCode => {
      const u = users.get(cCode);
      const roomId = [uCode, cCode].sort().join('_');
      const msgs = roomMessages.get(roomId) || [];
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      return {
        userCode: cCode,
        name: u ? u.fullName : cCode,
        avatar: u ? u.avatar : '',
        lastMessage: lastMsg ? (lastMsg.text || `[${lastMsg.mediaType === 'pdf' ? 'PDF Document' : (lastMsg.mediaType || 'Media')}]`) : 'Tap to chat'
      };
    });

    const pendingList = me.pendingRequests.map(cCode => {
      const u = users.get(cCode);
      return { userCode: cCode, name: u ? u.fullName : cCode, avatar: u ? u.avatar : '' };
    });

    socket.emit('contact-list-data', { contacts: contactList, pending: pendingList });
  });

  // Invitation with Accurate Response Popups
  socket.on('send-invitation', ({ targetCode }, callback) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode) return;
    let cleanTarget = targetCode.trim().toLowerCase();
    if (!cleanTarget.startsWith('@')) cleanTarget = '@' + cleanTarget;

    if (cleanTarget === uCode) {
      return callback({ success: false, msg: 'You cannot invite yourself!' });
    }
    if (!users.has(cleanTarget)) {
      return callback({ success: false, notFound: true, msg: 'This User ID does not exist!' });
    }

    const me = users.get(uCode);
    const target = users.get(cleanTarget);

    if (me.contacts.includes(cleanTarget)) {
      return callback({ success: false, msg: 'User is already in your chat list!' });
    }
    if (!target.pendingRequests.includes(uCode)) {
      target.pendingRequests.push(uCode);
    }

    callback({ success: true, msg: `Invitation sent successfully to ${cleanTarget}!` });

    // Live popup to target
    sendToUser(cleanTarget, 'incoming-invite-popup', { fromCode: uCode, fromName: me.fullName, fromAvatar: me.avatar });
    sendToUser(cleanTarget, 'refresh-contacts');
  });

  socket.on('respond-invitation', ({ fromCode, confirm }) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode) return;
    const me = users.get(uCode);
    const sender = users.get(fromCode);

    me.pendingRequests = me.pendingRequests.filter(c => c !== fromCode);

    if (confirm && sender) {
      if (!me.contacts.includes(fromCode)) me.contacts.push(fromCode);
      if (!sender.contacts.includes(uCode)) sender.contacts.push(uCode);

      sendToUser(uCode, 'refresh-contacts');
      sendToUser(fromCode, 'refresh-contacts');
      sendToUser(fromCode, 'invite-accepted-popup', { byName: me.fullName, byCode: uCode });
    } else {
      // DENY Action: notify the sender immediately with a popup
      sendToUser(uCode, 'refresh-contacts');
      sendToUser(fromCode, 'invite-denied-popup', { byName: me.fullName, byCode: uCode });
    }
  });

  // Real-Time Chat Engine
  socket.on('open-room', ({ targetCode }) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode) return;
    let cleanTarget = targetCode.trim().toLowerCase();
    const roomId = [uCode, cleanTarget].sort().join('_');
    socket.join(roomId);

    if (!roomMessages.has(roomId)) roomMessages.set(roomId, []);
    socket.emit('load-history', roomMessages.get(roomId));
  });

  socket.on('send-message', (data) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode) return;
    const { targetCode, text, media, mediaType, fileName, fileSize } = data;
    let cleanTarget = targetCode.trim().toLowerCase();
    const roomId = [uCode, cleanTarget].sort().join('_');

    const targetSockets = userSockets.get(cleanTarget);
    const isOnline = targetSockets && targetSockets.size > 0;

    const msgPayload = {
      id: 'msg_' + Date.now(),
      roomId,
      senderCode: uCode,
      targetCode: cleanTarget,
      text: text || '',
      media: media || null,
      mediaType: mediaType || null,
      fileName: fileName || null,
      fileSize: fileSize || null,
      status: isOnline ? 'delivered' : 'sent',
      time: getTimestamp()
    };

    if (!roomMessages.has(roomId)) roomMessages.set(roomId, []);
    roomMessages.get(roomId).push(msgPayload);

    io.to(roomId).emit('chat-message', msgPayload);
    sendToUser(uCode, 'chat-message', msgPayload);
    sendToUser(cleanTarget, 'chat-message', msgPayload);

    sendToUser(cleanTarget, 'notify-incoming-msg', {
      senderName: users.get(uCode)?.fullName || 'New Message',
      body: text || (mediaType === 'pdf' ? '📄 PDF Document' : (mediaType === 'audio' ? '🎤 Voice Note' : `Sent a ${mediaType || 'file'}`))
    });

    sendToUser(uCode, 'update-contact-lastmsg', { targetCode: cleanTarget, lastMsg: text || `[${mediaType === 'pdf' ? 'PDF' : (mediaType || 'Media')}]` });
    sendToUser(cleanTarget, 'update-contact-lastmsg', { targetCode: uCode, lastMsg: text || `[${mediaType === 'pdf' ? 'PDF' : (mediaType || 'Media')}]` });
  });

  socket.on('mark-seen', ({ roomId, id }) => {
    const msgs = roomMessages.get(roomId) || [];
    const m = msgs.find(msg => msg.id === id);
    if (m) {
      m.status = 'seen';
      io.to(roomId).emit('message-status-updated', { id, status: 'seen' });
      sendToUser(m.senderCode, 'message-status-updated', { id, status: 'seen' });
    }
  });

  socket.on('delete-message-for-everyone', ({ roomId, id }) => {
    const uCode = socketToUser.get(socket.id);
    if (!roomMessages.has(roomId)) return;
    
    let msgs = roomMessages.get(roomId);
    const msg = msgs.find(m => m.id === id);
    if (msg && msg.senderCode === uCode) {
      roomMessages.set(roomId, msgs.filter(m => m.id !== id));
      io.to(roomId).emit('message-deleted-for-everyone', { id });
      
      const parts = roomId.split('_');
      parts.forEach(user => sendToUser(user, 'message-deleted-for-everyone', { id }));
    }
  });

  // Status System
  socket.on('post-status', (statusItem) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode) return;

    if (!globalStatuses.has(uCode)) globalStatuses.set(uCode, []);
    statusItem.time = getTimestamp();
    statusItem.viewers = [];
    globalStatuses.get(uCode).unshift(statusItem);

    const me = users.get(uCode);
    if (me) {
      sendToUser(uCode, 'refresh-statuses');
      me.contacts.forEach(cCode => sendToUser(cCode, 'refresh-statuses'));
    }
    socket.emit('status-posted-success');
  });

  socket.on('get-statuses', () => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode || !users.has(uCode)) return;
    const me = users.get(uCode);

    const myStatus = {
      userCode: uCode,
      name: 'My Status',
      avatar: me.avatar,
      items: globalStatuses.get(uCode) || []
    };

    const contactStatuses = [];
    me.contacts.forEach(cCode => {
      if (globalStatuses.has(cCode) && globalStatuses.get(cCode).length > 0) {
        const u = users.get(cCode);
        contactStatuses.push({
          userCode: cCode,
          name: u ? u.fullName : cCode,
          avatar: u ? u.avatar : '',
          items: globalStatuses.get(cCode)
        });
      }
    });

    socket.emit('status-data', { myStatus, contactStatuses });
  });

  socket.on('mark-status-viewed', ({ authorCode, statusId }) => {
    const uCode = socketToUser.get(socket.id);
    if (!uCode || uCode === authorCode) return;

    const authorStatuses = globalStatuses.get(authorCode);
    if (!authorStatuses) return;

    const statusObj = authorStatuses.find(s => s.id === statusId);
    if (statusObj) {
      const viewerUser = users.get(uCode);
      if (viewerUser && !statusObj.viewers.some(v => v.userCode === uCode)) {
        statusObj.viewers.push({
          userCode: uCode,
          name: viewerUser.fullName,
          avatar: viewerUser.avatar,
          time: getTimestamp()
        });
        sendToUser(authorCode, 'status-viewed-updated', { statusId, viewers: statusObj.viewers });
      }
    }
  });

  // Audio Calling
  socket.on('call-user', ({ targetCode, signal, callerData }) => {
    const uCode = socketToUser.get(socket.id);
    let cleanTarget = targetCode.trim().toLowerCase();
    sendToUser(cleanTarget, 'incoming-call', { from: uCode, callerData, signal });
  });

  socket.on('answer-call', ({ targetCode, signal }) => {
    sendToUser(targetCode, 'call-accepted', { signal });
  });

  socket.on('ice-candidate', ({ targetCode, candidate }) => {
    sendToUser(targetCode, 'ice-candidate', { candidate });
  });

  socket.on('end-call', ({ targetCode }) => {
    sendToUser(targetCode, 'call-ended');
  });

  socket.on('disconnect', () => {
    const uCode = socketToUser.get(socket.id);
    if (uCode && userSockets.has(uCode)) {
      userSockets.get(uCode).delete(socket.id);
      if (userSockets.get(uCode).size === 0) userSockets.delete(uCode);
    }
    socketToUser.delete(socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Fully Synced Engine Online: http://localhost:${PORT}`);
});
