require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const User = require('./models/User');
const Message = require('./models/Message');
const Conversation = require('./models/Conversation');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e7
});

// Ensure upload directories exist
['uploads/avatars', 'uploads/images'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Database ────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/chatapp';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err); process.exit(1); });

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/messages', require('./routes/messages'));

// ── Page Routes ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public/chat.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public/profile.html')));

// ── Socket.IO ───────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'changeme_secret';
const connectedUsers = new Map(); // userId -> Set of socketIds

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', async (socket) => {
  const userId = socket.userId;

  // Track connected sockets per user (supports multi-tab)
  if (!connectedUsers.has(userId)) connectedUsers.set(userId, new Set());
  connectedUsers.get(userId).add(socket.id);

  // Mark online
  try {
    await User.findByIdAndUpdate(userId, { isOnline: true });
    io.emit('userStatus', { userId, isOnline: true });
  } catch {}

  // ── Join conversation room ──────────────────────────────────────────────
  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
  });

  socket.on('leaveConversation', (conversationId) => {
    socket.leave(conversationId);
  });

  // ── Send message ────────────────────────────────────────────────────────
  socket.on('sendMessage', async ({ conversationId, content, type = 'text', imageUrl }) => {
    try {
      const convo = await Conversation.findById(conversationId);
      if (!convo || !convo.participants.map(p => p.toString()).includes(userId)) return;

      const message = await Message.create({
        conversation: conversationId,
        sender: userId,
        content: content || '',
        type,
        imageUrl: imageUrl || '',
        readBy: [userId]
      });

      await message.populate('sender', 'username avatar');
      await Conversation.findByIdAndUpdate(conversationId, {
        lastMessage: message._id,
        updatedAt: new Date()
      });

      // Broadcast to everyone in room
      io.to(conversationId).emit('newMessage', message);

      // Notify participants not currently viewing this conversation
      convo.participants.forEach(pId => {
        const pid = pId.toString();
        if (pid === userId) return;
        const sids = connectedUsers.get(pid);
        if (sids) {
          sids.forEach(sid => {
            io.to(sid).emit('notification', {
              conversationId,
              senderId: userId,
              senderName: message.sender.username,
              senderAvatar: message.sender.avatar,
              preview: type === 'image' ? '📷 Photo' : (content?.length > 50 ? content.substring(0, 50) + '…' : content),
              isGroup: convo.isGroup,
              groupName: convo.groupName
            });
          });
        }
      });
    } catch (err) {
      console.error('sendMessage socket error:', err);
    }
  });

  // ── Typing indicators ───────────────────────────────────────────────────
  socket.on('typing', ({ conversationId }) => {
    socket.to(conversationId).emit('typing', { userId, conversationId });
  });

  socket.on('stopTyping', ({ conversationId }) => {
    socket.to(conversationId).emit('stopTyping', { userId, conversationId });
  });

  // ── Mark messages as read ───────────────────────────────────────────────
  socket.on('markRead', async ({ conversationId }) => {
    try {
      await Message.updateMany(
        { conversation: conversationId, readBy: { $ne: userId }, sender: { $ne: userId } },
        { $addToSet: { readBy: userId } }
      );
      io.to(conversationId).emit('messagesRead', { conversationId, userId });
    } catch {}
  });

  // ── WebRTC signaling (relay to target user's sockets) ──────────────────
  const relayTo = (targetId, event, payload) => {
    const sids = connectedUsers.get(String(targetId));
    if (sids) sids.forEach(sid => io.to(sid).emit(event, payload));
  };

  socket.on('callUser',    ({ to, from, fromName, fromAvatar, convId, type, offer }) =>
    relayTo(to, 'incomingCall', { from, fromName, fromAvatar, convId, type, offer }));

  socket.on('answerCall',  ({ to, answer }) =>
    relayTo(to, 'callAnswered', { answer }));

  socket.on('rejectCall',  ({ to }) =>
    relayTo(to, 'callRejected', {}));

  socket.on('iceCandidate',({ to, candidate }) =>
    relayTo(to, 'iceCandidate', { candidate }));

  socket.on('endCall',     ({ to }) =>
    relayTo(to, 'callEnded', {}));

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    const sids = connectedUsers.get(userId);
    if (sids) {
      sids.delete(socket.id);
      if (sids.size === 0) {
        connectedUsers.delete(userId);
        try {
          const lastSeen = new Date();
          await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });
          io.emit('userStatus', { userId, isOnline: false, lastSeen });
        } catch {}
      }
    }
  });
});

// Make available to route handlers
app.set('io', io);
app.set('connectedUsers', connectedUsers);

// ── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
