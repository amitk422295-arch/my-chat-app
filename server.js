const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e7 // 50 MB
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({
  limit: '50mb',
  extended: true
}));

app.use(express.static(path.join(__dirname, 'public')));


// =====================================================
// IN-MEMORY DATABASE
// =====================================================

const users = {};
const messages = {};
const statuses = {};


// =====================================================
// HELPERS
// =====================================================

function normalizeUserCode(value) {
  if (value === undefined || value === null) {
    return '';
  }

  let code = String(value)
    .trim()
    .toLowerCase();

  if (!code) {
    return '';
  }

  if (!code.startsWith('@')) {
    code = '@' + code;
  }

  // केवल letters + numbers रहने दें
  const username = code
    .substring(1)
    .replace(/[^a-z0-9]/g, '');

  if (!username) {
    return '';
  }

  return '@' + username;
}


function normalizeFullName(value) {
  if (value === undefined || value === null) {
    return '';
  }

  // शुरुआत/अंत के spaces हटेंगे,
  // बीच के extra spaces रहने दिए जा सकते हैं।
  return String(value).trim();
}


function isValidUserCode(code) {
  return /^@[a-z0-9]+$/.test(code);
}


function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin || ''));
}


function makeRoomId(userA, userB) {
  return [userA, userB]
    .sort()
    .join('_');
}


function makeMessageId() {
  return (
    'msg_' +
    Date.now() +
    '_' +
    Math.random().toString(36).substring(2, 10)
  );
}


function getTime() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}


async function isUserOnline(userCode) {
  try {
    const sockets = await io.in(userCode).fetchSockets();
    return sockets.length > 0;
  } catch (err) {
    return false;
  }
}


function publicUser(user) {
  if (!user) return null;

  return {
    userCode: user.userCode,
    fullName: user.fullName,
    name: user.fullName,
    avatar: user.avatar || null
  };
}


// =====================================================
// SOCKET CONNECTION
// =====================================================

io.on('connection', (socket) => {

  let currentUserCode = null;


  // ===================================================
  // AUTH
  // ===================================================

  socket.on(
    'auth-user',
    (
      {
        userCode,
        password,
        fullName,
        avatar,
        isRegister
      } = {},
      callback
    ) => {

      callback = typeof callback === 'function'
        ? callback
        : () => {};

      try {

        const normalizedCode = normalizeUserCode(userCode);
        const normalizedName = normalizeFullName(fullName);
        const pin = String(password || '');

        // -------------------------------
        // BASIC VALIDATION
        // -------------------------------

        if (!normalizedCode) {
          return callback({
            success: false,
            error: 'User ID required'
          });
        }

        if (!isValidUserCode(normalizedCode)) {
          return callback({
            success: false,
            error: 'Invalid User ID'
          });
        }

        if (!isValidPin(pin)) {
          return callback({
            success: false,
            error: 'PIN must be exactly 6 digits'
          });
        }


        // =================================================
        // REGISTER
        // =================================================

        if (isRegister) {

          if (!normalizedName) {
            return callback({
              success: false,
              error: 'Full name required'
            });
          }


          if (users[normalizedCode]) {
            return callback({
              success: false,
              error: 'User ID already exists!'
            });
          }


          users[normalizedCode] = {
            userCode: normalizedCode,
            password: pin,
            fullName: normalizedName,
            avatar: avatar || null,
            createdAt: Date.now()
          };

        }


        // =================================================
        // LOGIN
        // =================================================

        else {

          const existing = users[normalizedCode];

          if (!existing) {
            return callback({
              success: false,
              error: 'User ID not found'
            });
          }

          if (existing.password !== pin) {
            return callback({
              success: false,
              error: 'Invalid ID or 6-digit PIN'
            });
          }
        }


        // =================================================
        // SOCKET LOGIN
        // =================================================

        currentUserCode = normalizedCode;

        socket.join(normalizedCode);


        callback({
          success: true,
          user: publicUser(users[normalizedCode])
        });


        // Refresh contacts/statuses
        socket.emit('refresh-statuses');

      } catch (err) {

        console.error('AUTH ERROR:', err);

        callback({
          success: false,
          error: 'Server error during authentication'
        });
      }
    }
  );


  // ===================================================
  // RESTORE SESSION
  // ===================================================

  socket.on(
    'restore-session',
    ({ userCode, password } = {}, callback) => {

      callback = typeof callback === 'function'
        ? callback
        : () => {};

      const normalizedCode = normalizeUserCode(userCode);
      const pin = String(password || '');

      const existing = users[normalizedCode];

      if (
        existing &&
        existing.password === pin
      ) {

        currentUserCode = normalizedCode;

        socket.join(normalizedCode);

        callback({
          success: true,
          user: publicUser(existing)
        });

      } else {

        callback({
          success: false
        });
      }
    }
  );


  // ===================================================
  // GET CONTACTS
  // ===================================================

  socket.on('get-contacts', () => {

    if (!currentUserCode) return;

    const userList = [];

    for (const code in users) {

      if (code === currentUserCode) {
        continue;
      }

      userList.push({
        userCode: code,
        name: users[code].fullName,
        fullName: users[code].fullName,
        avatar: users[code].avatar || null,
        lastMessage: 'Tap to chat'
      });
    }


    socket.emit('contact-list-data', {
      contacts: userList,
      pending: []
    });
  });


  // ===================================================
  // DIRECT CHAT
  // ===================================================

  socket.on(
    'open-direct-chat',
    ({ targetCode } = {}, callback) => {

      callback = typeof callback === 'function'
        ? callback
        : () => {};

      if (!currentUserCode) {
        return callback({
          success: false,
          error: 'Not authenticated'
        });
      }


      const normalizedTarget = normalizeUserCode(targetCode);


      if (!normalizedTarget) {
        return callback({
          success: false,
          error: 'Enter a User ID'
        });
      }


      if (!isValidUserCode(normalizedTarget)) {
        return callback({
          success: false,
          error: 'Invalid User ID'
        });
      }


      if (normalizedTarget === currentUserCode) {
        return callback({
          success: false,
          error: 'You cannot chat with yourself'
        });
      }


      const targetUser = users[normalizedTarget];


      if (!targetUser) {
        return callback({
          success: false,
          error: 'User ID not found!'
        });
      }


      const roomId = makeRoomId(
        currentUserCode,
        normalizedTarget
      );


      socket.join(roomId);


      callback({
        success: true,

        roomId,

        user: publicUser(targetUser)
      });


      // Existing messages
      socket.emit(
        'load-history',
        messages[roomId] || []
      );
    }
  );


  // ===================================================
  // OPEN ROOM
  // ===================================================

  socket.on(
    'open-room',
    ({ targetCode } = {}) => {

      if (!currentUserCode) return;

      const normalizedTarget = normalizeUserCode(targetCode);

      if (!users[normalizedTarget]) return;

      const roomId = makeRoomId(
        currentUserCode,
        normalizedTarget
      );


      socket.join(roomId);


      socket.emit(
        'load-history',
        messages[roomId] || []
      );


      // पुराने unread messages को read करने की
      // frontend अलग से सूचना देगा।
    }
  );


  // ===================================================
  // SEND MESSAGE
  // ===================================================

  socket.on(
    'send-message',
    async (
      {
        targetCode,
        text,
        media,
        mediaType,
        clientMsgId
      } = {},
      callback
    ) => {

      callback = typeof callback === 'function'
        ? callback
        : () => {};


      if (!currentUserCode) {

        return callback({
          success: false,
          error: 'Not authenticated'
        });
      }


      const normalizedTarget = normalizeUserCode(targetCode);


      if (!normalizedTarget) {

        return callback({
          success: false,
          error: 'Target User ID required'
        });
      }


      if (!users[normalizedTarget]) {

        return callback({
          success: false,
          error: 'User ID not found'
        });
      }


      if (normalizedTarget === currentUserCode) {

        return callback({
          success: false,
          error: 'Cannot send message to yourself'
        });
      }


      const cleanText =
        typeof text === 'string'
          ? text
          : '';


      if (
        !cleanText &&
        !media
      ) {

        return callback({
          success: false,
          error: 'Empty message'
        });
      }


      const roomId = makeRoomId(
        currentUserCode,
        normalizedTarget
      );


      if (!messages[roomId]) {
        messages[roomId] = [];
      }


      // =================================================
      // CREATE MESSAGE
      // =================================================

      const msgObj = {

        id: makeMessageId(),

        clientMsgId:
          clientMsgId ||
          null,

        senderCode:
          currentUserCode,

        targetCode:
          normalizedTarget,

        text:
          cleanText,

        media:
          media || null,

        mediaType:
          mediaType || null,

        time:
          getTime(),

        timestamp:
          Date.now(),

        roomId,

        // WhatsApp-like state
        status:
          'sent'
      };


      messages[roomId].push(msgObj);


      // =================================================
      // FIRST ACK = SENT ✓
      // =================================================

      callback({
        success: true,

        message: msgObj,

        status: 'sent'
      });


      // =================================================
      // SEND TO SENDER
      // =================================================

      io.to(currentUserCode).emit(
        'chat-message',
        msgObj
      );


      // =================================================
      // CHECK RECIPIENT ONLINE
      // =================================================

      const targetOnline =
        await isUserOnline(normalizedTarget);


      if (targetOnline) {

        // Message reached recipient's socket
        msgObj.status = 'delivered';


        // Send message to recipient
        io.to(normalizedTarget).emit(
          'chat-message',
          msgObj
        );


        // Sender gets ✓✓
        io.to(currentUserCode).emit(
          'message-status-updated',
          {
            id: msgObj.id,
            clientMsgId: msgObj.clientMsgId,
            status: 'delivered'
          }
        );

      } else {

        // Recipient offline.
        // Message remains sent ✓
        io.to(currentUserCode).emit(
          'message-status-updated',
          {
            id: msgObj.id,
            clientMsgId: msgObj.clientMsgId,
            status: 'sent'
          }
        );
      }

    }
  );


  // ===================================================
  // MESSAGE DELIVERED
  // ===================================================

  socket.on(
    'message-delivered',
    ({ messageId, clientMsgId, roomId } = {}) => {

      if (!currentUserCode) return;

      let foundMessage = null;


      // Find message
      if (roomId && messages[roomId]) {

        foundMessage =
          messages[roomId].find(
            m =>
              (
                messageId &&
                m.id === messageId
              ) ||
              (
                clientMsgId &&
                m.clientMsgId === clientMsgId
              )
          );
      }


      if (!foundMessage) {

        // Search all rooms if roomId not provided
        for (const id in messages) {

          const found =
            messages[id].find(
              m =>
                (
                  messageId &&
                  m.id === messageId
                ) ||
                (
                  clientMsgId &&
                  m.clientMsgId === clientMsgId
                )
            );

          if (found) {
            foundMessage = found;
            break;
          }
        }
      }


      if (!foundMessage) return;


      // Only recipient can mark it delivered
      if (
        foundMessage.targetCode !==
        currentUserCode
      ) {
        return;
      }


      if (
        foundMessage.status === 'sent'
      ) {

        foundMessage.status =
          'delivered';
      }


      // Notify sender
      io.to(foundMessage.senderCode).emit(
        'message-status-updated',
        {
          id: foundMessage.id,
          clientMsgId:
            foundMessage.clientMsgId,
          status: 'delivered'
        }
      );
    }
  );


  // ===================================================
  // MESSAGE READ
  // ===================================================

  socket.on(
    'message-read',
    ({ messageId, clientMsgId, roomId } = {}) => {

      if (!currentUserCode) return;

      let foundMessage = null;


      // First use room
      if (roomId && messages[roomId]) {

        foundMessage =
          messages[roomId].find(
            m =>
              (
                messageId &&
                m.id === messageId
              ) ||
              (
                clientMsgId &&
                m.clientMsgId === clientMsgId
              )
          );
      }


      // Fallback search
      if (!foundMessage) {

        for (const id in messages) {

          const found =
            messages[id].find(
              m =>
                (
                  messageId &&
                  m.id === messageId
                ) ||
                (
                  clientMsgId &&
                  m.clientMsgId === clientMsgId
                )
            );

          if (found) {
            foundMessage = found;
            break;
          }
        }
      }


      if (!foundMessage) return;


      // Only recipient can mark as read
      if (
        foundMessage.targetCode !==
        currentUserCode
      ) {
        return;
      }


      foundMessage.status = 'read';


      // Sender receives BLUE ✓✓
      io.to(foundMessage.senderCode).emit(
        'message-status-updated',
        {
          id: foundMessage.id,
          clientMsgId:
            foundMessage.clientMsgId,
          status: 'read'
        }
      );
    }
  );


  // ===================================================
  // MARK MULTIPLE MESSAGES READ
  // ===================================================

  socket.on(
    'mark-messages-read',
    ({ roomId, ids = [] } = {}) => {

      if (!currentUserCode) return;

      if (
        !roomId ||
        !messages[roomId]
      ) {
        return;
      }


      const idList =
        Array.isArray(ids)
          ? ids
          : [];


      for (const message of messages[roomId]) {

        if (
          !idList.includes(message.id)
        ) {
          continue;
        }


        // Only messages sent TO current user
        if (
          message.targetCode !==
          currentUserCode
        ) {
          continue;
        }


        message.status = 'read';


        io.to(message.senderCode).emit(
          'message-status-updated',
          {
            id: message.id,
            clientMsgId:
              message.clientMsgId,
            status: 'read'
          }
        );
      }
    }
  );


  // ===================================================
  // DELETE MESSAGE FOR EVERYONE
  // ===================================================

  socket.on(
    'delete-message-for-everyone',
    ({ roomId, id } = {}) => {

      if (!currentUserCode) return;

      if (
        !roomId ||
        !messages[roomId]
      ) {
        return;
      }


      const message =
        messages[roomId].find(
          m => m.id === id
        );


      if (!message) return;


      // Only sender can delete for everyone
      if (
        message.senderCode !==
        currentUserCode
      ) {
        return;
      }


      messages[roomId] =
        messages[roomId].filter(
          m => m.id !== id
        );


      io.to(roomId).emit(
        'message-deleted-for-everyone',
        {
          id
        }
      );
    }
  );


  // ===================================================
  // POST STATUS
  // ===================================================

  socket.on(
    'post-status',
    ({ id, media, type } = {}) => {

      if (!currentUserCode) return;


      if (!media) return;


      if (!statuses[currentUserCode]) {

        statuses[currentUserCode] = {

          userCode:
            currentUserCode,

          name:
            users[currentUserCode].fullName,

          avatar:
            users[currentUserCode].avatar || null,

          items: []
        };
      }


      statuses[currentUserCode].items.unshift({

        id:
          id ||
          'status_' +
          Date.now() +
          '_' +
          Math.random()
            .toString(36)
            .substring(2, 7),

        media,

        type:
          type || 'image',

        time:
          getTime(),

        timestamp:
          Date.now(),

        viewers: []
      });


      io.emit('refresh-statuses');
    }
  );


  // ===================================================
  // GET STATUSES
  // ===================================================

  socket.on(
    'get-statuses',
    () => {

      if (!currentUserCode) return;


      const myStatus =
        statuses[currentUserCode] ||
        null;


      const contactStatuses = [];


      for (const code in statuses) {

        if (code === currentUserCode) {
          continue;
        }


        contactStatuses.push(
          statuses[code]
        );
      }


      socket.emit(
        'status-data',
        {
          myStatus,
          contactStatuses
        }
      );
    }
  );


  // ===================================================
  // VIEW STATUS
  // ===================================================

  socket.on(
    'mark-status-viewed',
    ({ authorCode, statusId } = {}) => {

      if (!currentUserCode) return;


      const normalizedAuthor =
        normalizeUserCode(authorCode);


      if (
        !statuses[normalizedAuthor]
      ) {
        return;
      }


      const item =
        statuses[normalizedAuthor]
          .items
          .find(
            s => s.id === statusId
          );


      if (!item) return;


      // Already viewed?
      const alreadyViewed =
        item.viewers.some(
          v =>
            v.userCode ===
            currentUserCode
        );


      if (alreadyViewed) {

        // Still send current viewer list
        socket.emit(
          'status-viewed-updated',
          {
            statusId,
            authorCode:
              normalizedAuthor,
            viewers:
              item.viewers
          }
        );

        return;
      }


      item.viewers.push({

        userCode:
          currentUserCode,

        name:
          users[currentUserCode].fullName,

        avatar:
          users[currentUserCode].avatar || null,

        time:
          getTime(),

        timestamp:
          Date.now()
      });


      // Notify status owner
      io.to(normalizedAuthor).emit(
        'status-viewed-updated',
        {
          statusId,
          authorCode:
            normalizedAuthor,
          viewers:
            item.viewers
        }
      );


      // Also send to viewer
      socket.emit(
        'status-viewed-updated',
        {
          statusId,
          authorCode:
            normalizedAuthor,
          viewers:
            item.viewers
        }
      );
    }
  );


  // ===================================================
  // CALL USER
  // ===================================================

  socket.on(
    'call-user',
    ({ targetCode, signal, callerData } = {}) => {

      if (!currentUserCode) return;


      const normalizedTarget =
        normalizeUserCode(targetCode);


      if (
        !normalizedTarget ||
        !users[normalizedTarget]
      ) {
        socket.emit(
          'call-error',
          {
            error:
              'User ID not found'
          }
        );

        return;
      }


      io.to(normalizedTarget).emit(
        'incoming-call',
        {
          from:
            currentUserCode,

          signal,

          callerData:
            callerData || {
              userCode:
                currentUserCode,

              fullName:
                users[currentUserCode]
                  .fullName,

              avatar:
                users[currentUserCode]
                  .avatar || null
            }
        }
      );
    }
  );


  // ===================================================
  // ANSWER CALL
  // ===================================================

  socket.on(
    'answer-call',
    ({ targetCode, signal } = {}) => {

      if (!currentUserCode) return;


      const normalizedTarget =
        normalizeUserCode(targetCode);


      if (!users[normalizedTarget]) {
        return;
      }


      io.to(normalizedTarget).emit(
        'call-accepted',
        {
          signal
        }
      );
    }
  );


  // ===================================================
  // ICE CANDIDATE
  // ===================================================

  socket.on(
    'ice-candidate',
    ({ targetCode, candidate } = {}) => {

      if (!currentUserCode) return;


      const normalizedTarget =
        normalizeUserCode(targetCode);


      if (!users[normalizedTarget]) {
        return;
      }


      io.to(normalizedTarget).emit(
        'ice-candidate',
        {
          candidate
        }
      );
    }
  );


  // ===================================================
  // END CALL
  // ===================================================

  socket.on(
    'end-call',
    ({ targetCode } = {}) => {

      if (!currentUserCode) return;


      const normalizedTarget =
        normalizeUserCode(targetCode);


      if (!users[normalizedTarget]) {
        return;
      }


      io.to(normalizedTarget).emit(
        'call-ended'
      );
    }
  );


  // ===================================================
  // DISCONNECT
  // ===================================================

  socket.on(
    'disconnect',
    () => {

      console.log(
        'Socket disconnected:',
        currentUserCode
      );

      currentUserCode = null;
    }
  );

});


// =====================================================
// SERVER START
// =====================================================

const PORT =
  process.env.PORT || 3000;


server.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `http://localhost:${PORT}`
    );
  }
);
