const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 5e7 // 50MB तक फोटो/वीडियो सपोर्ट
});

// JSON बॉडी साइज 50MB तक सपोर्ट
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// इन-मेमोरी डेटा स्टोरेज
let users = {};          // socketId -> userData
let statuses = [];       // स्टेटस लिस्ट
let messages = [];       // चैट हिस्ट्री

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. यूज़र जॉइन होना
  socket.on('user_join', (userData) => {
    users[socket.id] = { id: socket.id, ...userData };
    io.emit('active_users', Object.values(users));
    // पुराने स्टेटस भेजें
    socket.emit('initial_statuses', statuses);
  });

  // 2. फ़ास्ट ऑटो-सिंक चैट (WhatsApp स्पीड)
  socket.on('send_message', (data) => {
    const messageData = {
      id: 'msg_' + Date.now(),
      senderId: socket.id,
      senderName: users[socket.id]?.name || 'Unknown',
      text: data.text || '',
      media: data.media || null, // Base64 फोटो या ऑडियो
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    messages.push(messageData);
    io.emit('new_message', messageData); // तुरंत सबको लाइव डिलीवर
  });

  // 3. स्टेटस अपलोड (फोटो / वीडियो / टेक्स्ट)
  socket.on('upload_status', (statusData) => {
    const newStatus = {
      id: 'status_' + Date.now(),
      authorId: socket.id,
      authorName: users[socket.id]?.name || 'User',
      authorAvatar: users[socket.id]?.avatar || '',
      text: statusData.text || '',
      media: statusData.media || null,       // Base64 इमेज/वीडियो
      mediaType: statusData.mediaType || '', // 'image' या 'video'
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      viewers: [] // स्टेटस देखने वालों की लिस्ट
    };

    statuses.unshift(newStatus);
    io.emit('status_published', newStatus); // सभी यूज़र्स को तुरंत लाइव दिखाओ
  });

  // 4. "किस-किस ने देखा" (Status Seen Logic)
  socket.on('view_status', ({ statusId, viewerName }) => {
    const targetStatus = statuses.find(s => s.id === statusId);
    if (targetStatus) {
      if (!targetStatus.viewers.includes(viewerName)) {
        targetStatus.viewers.push(viewerName);
        io.emit('status_viewed_update', {
          statusId,
          viewers: targetStatus.viewers
        });
      }
    }
  });

  // 5. कॉलिंग सिग्नलिंग (WebRTC Audio/Video Call)
  socket.on('call_user', (data) => {
    socket.to(data.userToCall).emit('incoming_call', {
      signal: data.signalData,
      from: socket.id,
      callerName: users[socket.id]?.name || 'Unknown',
      callType: data.callType // 'audio' या 'video'
    });
  });

  socket.on('answer_call', (data) => {
    socket.to(data.to).emit('call_accepted', data.signal);
  });

  socket.on('reject_call', (data) => {
    socket.to(data.to).emit('call_rejected');
  });

  socket.on('end_call', (data) => {
    socket.to(data.to).emit('call_ended');
  });

  // 6. डिस्कनेक्ट होना
  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('active_users', Object.values(users));
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
