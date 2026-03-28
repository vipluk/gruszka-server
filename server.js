const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- KONFIGURACJA GOOGLE ---
const GOOGLE_CLIENT_ID = "864552426279-tuo24v2lft4c6tiqpl63uaj0fo73gkth.apps.googleusercontent.com";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const users = {}; // socket.id -> { username, avatar, rooms: Set, mic: bool, deaf: bool }

// --- TRWAŁA HISTORIA CZATU W PLIKU JSON ---
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');
let messageBuffer = [];

// Ładowanie historii z dysku przy starcie serwera
if (fs.existsSync(HISTORY_FILE)) {
  try {
    const data = fs.readFileSync(HISTORY_FILE, 'utf8');
    messageBuffer = JSON.parse(data);
    console.log(`Pomyślnie załadowano ${messageBuffer.length} wiadomości z dysku globalnego!`);
  } catch (err) {
    console.error('Błąd czytania chat-history.json:', err);
  }
}

const saveHistory = () => {
  try {
    // Trzymamy tylko najnowsze 10 000 wiadomości w ogóle pliku
    if (messageBuffer.length > 10000) messageBuffer = messageBuffer.slice(-10000);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageBuffer, null, 2));
  } catch (err) {
    console.error('Błąd zapisu chat-history.json:', err);
  }
};

const fileOwners = {};

// --- METERED TURN SERVER ---
const METERED_APP_NAME = "gruszka";
const METERED_API_KEY = "3z13KRDPzT92C9aWTSOsYNdjlHBOB2Fwy40kRgMWIkLYhprx";

app.get('/api/turn-credentials', async (req, res) => {
  try {
    const response = await fetch(
      `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (error) {
    console.error("Błąd pobierania TURN credentials:", error);
    res.status(500).json({ error: "Nie udało się pobrać TURN credentials" });
  }
});

const updateAllRoomStates = () => {
  const roomsData = {};
  const allRooms = Array.from(io.sockets.adapter.rooms.keys());
  
  allRooms.forEach(roomId => {
    const usersInRoom = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .map(id => ({
        username: users[id]?.username,
        avatar: users[id]?.avatar,
        mic: users[id]?.mic || false,
        deaf: users[id]?.deaf || false
      }))
      .filter(u => u.username !== null);
    roomsData[roomId] = usersInRoom;
  });

  io.emit('global-room-update', roomsData);
};

io.on('connection', (socket) => {
  users[socket.id] = { username: null, avatar: null, rooms: new Set(), mic: false, deaf: false };

  // Logowanie przez Google
  socket.on('google-login', async ({ credential, roomId }) => {
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      
      users[socket.id].username = payload.name;
      users[socket.id].avatar = payload.picture;
      
      socket.join(roomId);
      users[socket.id].rooms.add(roomId);

      socket.emit('login-success', { 
        username: payload.name, 
        avatar: payload.picture 
      });

      socket.emit('chat-buffer', messageBuffer.filter(m => m.channel === roomId));
      updateAllRoomStates();
      
      if (roomId.startsWith('voice-')) {
        socket.to(roomId).emit('user-connected', socket.id);
      }
    } catch (e) {
      console.error("Błąd weryfikacji Google:", e);
    }
  });

  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    users[socket.id].username = username;
    users[socket.id].rooms.add(roomId);
    socket.emit('chat-buffer', messageBuffer.filter(m => m.channel === roomId));
    updateAllRoomStates();
    if (roomId.startsWith('voice-')) socket.to(roomId).emit('user-connected', socket.id);
  });

  socket.on('update-mute-status', ({ mic, deaf }) => {
    if (users[socket.id]) {
      users[socket.id].mic = mic;
      users[socket.id].deaf = deaf;
      updateAllRoomStates();
    }
  });

  socket.on('chat-message', (payload) => {
    messageBuffer.push(payload);
    // Zachowuje maksymalnie 10000 wiadomości globalnych w pliku!
    if (messageBuffer.length > 10000) messageBuffer.shift();
    saveHistory();

    socket.to(payload.roomId).emit('chat-message', payload);
  });

  socket.on('register-file-owner', ({ fileHash }) => {
    if (!fileOwners[fileHash]) fileOwners[fileHash] = new Set();
    fileOwners[fileHash].add(socket.id);
  });

  socket.on('request-file-sources', ({ fileHash }) => {
    socket.emit('file-sources', { fileHash, sources: Array.from(fileOwners[fileHash] || []) });
  });

  socket.on('speaking', ({ roomId, speaking }) => {
    socket.to(roomId).emit('user-speaking', { username: users[socket.id].username, speaking });
  });

  socket.on('offer', (p) => io.to(p.target).emit('offer', p));
  socket.on('answer', (p) => io.to(p.target).emit('answer', p));
  socket.on('ice-candidate', (i) => io.to(i.target).emit('ice-candidate', i));

  socket.on('leave-room', ({ roomId }) => {
    socket.leave(roomId);
    if (users[socket.id]) {
      users[socket.id].rooms.delete(roomId);
    }
    updateAllRoomStates();
  });

  socket.on('request-room-state', () => {
    updateAllRoomStates();
  });

  socket.on('disconnect', () => {
    for (const hash in fileOwners) {
      if (fileOwners[hash]) fileOwners[hash].delete(socket.id);
    }
    delete users[socket.id];
    updateAllRoomStates();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Serwer Gruszki z Google Auth działa na porcie ${PORT}!`));