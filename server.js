const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- KONFIGURACJA GOOGLE ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "864552426279-tuo24v2lft4c6tiqpl63uaj0fo73gkth.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
if (GOOGLE_REFRESH_TOKEN) {
  googleClient.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}

const drive = google.drive({ version: 'v3', auth: googleClient });
let pearServerFolderId = null;

const users = {}; // socket.id -> { username, avatar, rooms: Set, mic: bool, deaf: bool, status: string }

// --- TRWAŁA HISTORIA CZATU W PLIKU JSON ---
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');
let messageBuffer = [];

// --- TRWAŁA KONFIGURACJA GILDII W PLIKU JSON ---
const GUILDS_FILE = path.join(__dirname, 'guilds.json');
const USERS_FILE = path.join(__dirname, 'users.json');
let guilds = {};
let allSeenUsers = {};

// Domyślna gildia Lobby jeśli pusto
const ensureLobby = () => {
  const lobbyId = 'lobby-default';
  if (!guilds[lobbyId]) {
    guilds[lobbyId] = {
      id: lobbyId,
      name: 'Pierwsza gildia',
      icon: null,
      owner: 'system',
      channels: [
        { id: 'Ogólny', name: 'Ogólny', type: 'text' },
        { id: 'Lobby', name: 'Lobby', type: 'voice' }
      ]
    };
    saveGuilds();
  } else {
    // Migracja nazw
    guilds[lobbyId].name = 'Pierwsza gildia';
    guilds[lobbyId].channels = [
      { id: 'Ogólny', name: 'Ogólny', type: 'text' },
      { id: 'Lobby', name: 'Lobby', type: 'voice' }
    ];
    saveGuilds();
  }
};

const saveUsers = () => {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(allSeenUsers, null, 2));
    syncFileToDrive(USERS_FILE, 'users.json');
  } catch (err) {
    console.error('Błąd zapisu users.json:', err);
  }
};

// --- LOGIKA SYNCHRONIZACJI Z DRIVE (/pear/server) ---
async function ensureServerFolder() {
  if (!GOOGLE_REFRESH_TOKEN) return null;
  try {
    // 1. Szukaj folderu 'pear'
    const qPear = "name='pear' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    const resPear = await drive.files.list({ q: qPear, fields: 'files(id)' });
    let pearId = resPear.data.files?.[0]?.id;

    if (!pearId) {
      const createPear = await drive.files.create({
        requestBody: { name: 'pear', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      pearId = createPear.data.id;
    }

    // 2. Szukaj folderu 'server' w 'pear'
    const qSrv = `name='server' and '${pearId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resSrv = await drive.files.list({ q: qSrv, fields: 'files(id)' });
    let srvId = resSrv.data.files?.[0]?.id;

    if (!srvId) {
      const createSrv = await drive.files.create({
        requestBody: { name: 'server', parents: [pearId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      srvId = createSrv.data.id;
    }
    pearServerFolderId = srvId;
    console.log("✅ Połączono z folderem Drive: /pear/server (ID:", pearServerFolderId, ")");
    return pearServerFolderId;
  } catch (e) {
    console.error("❌ Błąd folderów Drive:", e.message);
    return null;
  }
}

async function syncFileToDrive(localPath, driveFileName) {
  if (!pearServerFolderId || !fs.existsSync(localPath)) return;
  try {
    // Sprawdź czy plik istnieje
    const q = `name='${driveFileName}' and '${pearServerFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    const fileId = res.data.files?.[0]?.id;

    const media = { mimeType: 'application/json', body: fs.createReadStream(localPath) };

    if (fileId) {
      await drive.files.update({ fileId, media });
    } else {
      await drive.files.create({
        requestBody: { name: driveFileName, parents: [pearServerFolderId] },
        media
      });
    }
  } catch (e) {
    console.error(`❌ Błąd uploadu ${driveFileName} do Drive:`, e.message);
  }
}

async function downloadFromDrive(fileName, localPath) {
  if (!pearServerFolderId) return;
  try {
    const q = `name='${fileName}' and '${pearServerFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    const fileId = res.data.files?.[0]?.id;
    if (!fileId) return;

    const dest = fs.createWriteStream(localPath);
    const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    
    return new Promise((resolve, reject) => {
      driveRes.data
        .on('end', () => { console.log(`💾 Pomyślnie pobrano ${fileName} z Drive.`); resolve(); })
        .on('error', (err) => reject(err))
        .pipe(dest);
    });
  } catch (e) {
    console.error(`❌ Błąd pobierania ${fileName} z Drive:`, e.message);
  }
}

// Inicjalizacja chmury przy starcie
async function initCloud() {
  await ensureServerFolder();
  if (pearServerFolderId) {
    await downloadFromDrive('guilds.json', GUILDS_FILE);
    await downloadFromDrive('chat-history.json', HISTORY_FILE);
    await downloadFromDrive('users.json', USERS_FILE);
    
    // Przeładowanie danych po pobraniu (jeśli pliki się zmieniły)
    loadAllData();
  }
}

function loadAllData() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      messageBuffer = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`Załadowano ${messageBuffer.length} wiadomości.`);
    } catch (e) { }
  }
  if (fs.existsSync(GUILDS_FILE)) {
    try {
      guilds = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
      console.log(`Załadowano ${Object.keys(guilds).length} gildi.`);
    } catch (e) { }
  }
  if (fs.existsSync(USERS_FILE)) {
    try {
      allSeenUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      console.log(`Załadowano ${Object.keys(allSeenUsers).length} użytkowników.`);
    } catch (e) { }
  }
  ensureLobby();
}

const saveHistory = () => {
  try {
    if (messageBuffer.length > 10000) messageBuffer = messageBuffer.slice(-10000);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageBuffer, null, 2));
    syncFileToDrive(HISTORY_FILE, 'chat-history.json');
  } catch (err) {
    console.error('Błąd zapisu chat-history.json:', err);
  }
};

const saveGuilds = () => {
  try {
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(guilds, null, 2));
    syncFileToDrive(GUILDS_FILE, 'guilds.json');
  } catch (err) {
    console.error('Błąd zapisu guilds.json:', err);
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

  // Lista wszystkich zalogowanych nazw użytkowników (każdy socket z username)
  const onlineUsernames = Array.from(io.sockets.sockets.values())
    .map(s => users[s.id]?.username)
    .filter(u => u != null);

  allRooms.forEach(roomId => {
    const usersInRoom = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .map(id => ({
        username: users[id]?.username,
        avatar: users[id]?.avatar,
        mic: users[id]?.mic || false,
        deaf: users[id]?.deaf || false,
        status: users[id]?.status || 'online',
        customText: users[id]?.customText || ''
      }))
      .filter(u => u.username != null);
    roomsData[roomId] = usersInRoom;
  });

  io.emit('global-room-update', { rooms: roomsData, users: allSeenUsers, guilds, onlineUsernames });
};

io.on('connection', (socket) => {
  users[socket.id] = { username: null, avatar: null, rooms: new Set(), mic: false, deaf: false, status: 'online' };

  // Logowanie przez Google
  socket.on('google-login', async ({ credential, roomId, status, customText }) => {
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();

      users[socket.id].username = payload.name;
      users[socket.id].avatar = payload.picture;
      users[socket.id].status = status || 'online';
      if (customText) users[socket.id].customText = customText.substring(0, 32);

      let existing = allSeenUsers[payload.name];
      allSeenUsers[payload.name] = {
        username: payload.name,
        avatar: payload.picture,
        status: status || (existing ? existing.status : 'online'),
        customText: customText || (existing ? existing.customText : ''),
        lastSeen: Date.now()
      };
      saveUsers();

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

  socket.on('update-status', ({ status, customText }) => {
    if (users[socket.id] && (['online', 'dnd', 'away'].includes(status) || status === 'offline')) {
      users[socket.id].status = status;
      if (customText !== undefined) users[socket.id].customText = customText.substring(0, 32);

      if (users[socket.id].username) {
        const username = users[socket.id].username;
        if (!allSeenUsers[username]) {
          allSeenUsers[username] = { username, avatar: users[socket.id].avatar };
        }
        allSeenUsers[username].status = status;
        if (customText !== undefined) allSeenUsers[username].customText = customText.substring(0, 32);
        allSeenUsers[username].lastSeen = Date.now();
      }
      updateAllRoomStates();
      saveUsers();
    }
  });

  socket.on('get-guilds', () => {
    socket.emit('guilds-list', guilds);
  });

  socket.on('create-guild', ({ name, icon }) => {
    const user = users[socket.id];
    if (!user || !user.username) return;

    const guildId = `guild-${Date.now()}`;
    guilds[guildId] = {
      id: guildId,
      name,
      icon,
      owner: user.username,
      members: [user.username],
      channels: [
        { id: `${guildId}-ogolny`, name: 'ogólny', type: 'text' },
        { id: `${guildId}-voice`, name: 'Głosowy', type: 'voice' }
      ]
    };
    saveGuilds();
    updateAllRoomStates();
  });

  socket.on('delete-guild', ({ guildId }) => {
    const user = users[socket.id];
    if (!user || guilds[guildId]?.owner !== user.username) return;
    delete guilds[guildId];
    saveGuilds();
    updateAllRoomStates();
  });

  socket.on('update-channel', ({ guildId, channelId, newName, deleteChannel }) => {
    const user = users[socket.id];
    if (!user || guilds[guildId]?.owner !== user.username) return;

    const guild = guilds[guildId];
    if (deleteChannel) {
      guild.channels = guild.channels.filter(c => c.id !== channelId);
    } else {
      const channel = guild.channels.find(c => c.id === channelId);
      if (channel) channel.name = newName;
    }
    saveGuilds();
    updateAllRoomStates();
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

  socket.on('ping-server', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('disconnect', () => {
    for (const hash in fileOwners) {
      if (fileOwners[hash]) fileOwners[hash].delete(socket.id);
    }
    const user = users[socket.id];
    if (user && user.username) {
      allSeenUsers[user.username].status = 'offline';
      allSeenUsers[user.username].lastSeen = Date.now();
    }
    delete users[socket.id];
    updateAllRoomStates();
    saveUsers();
  });
});

// Pierwsze ładowanie lokalne (jeśli istnieje)
loadAllData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serwer Gruszki z Google Auth działa na porcie ${PORT}!`);
  initCloud();
});