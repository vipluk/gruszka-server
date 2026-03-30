const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');
require('dotenv').config();

// --- ZABEZPIECZENIE PRZED AWARIAMI SERWERA ---
process.on('uncaughtException', (err) => {
  console.error('🔥 KRYTYCZNY BŁĄD (uncaughtException):', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 NIEPRZECHWYCONA OBIETNICA (unhandledRejection):', reason);
});
// ----------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- KONFIGURACJA GOOGLE ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "69113746688-m3bm8hlckp77gqmnmpt58ck68o8s1c3v.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
if (GOOGLE_REFRESH_TOKEN) {
  googleClient.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}

const drive = google.drive({ version: 'v3', auth: googleClient });
let pearServerFolderId = null;

const users = {}; // socket.id -> { username, avatar, rooms: Set, mic: bool, deaf: bool, status: string }
const gracePeriodUsers = new Map(); // username -> setTimeout ID

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
    console.log("[STORAGE] Zapisano users.json i wysłano do chmury.");
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

const syncTimeouts = {};

function syncFileToDrive(localPath, driveFileName) {
  if (syncTimeouts[driveFileName]) {
    clearTimeout(syncTimeouts[driveFileName]);
  }
  
  syncTimeouts[driveFileName] = setTimeout(async () => {
    if (!pearServerFolderId || !fs.existsSync(localPath)) return;
    try {
      // Sprawdź czy plik istnieje
      const q = `name='${driveFileName}' and '${pearServerFolderId}' in parents and trashed=false`;
      const res = await drive.files.list({ q, fields: 'files(id)' });
      const fileId = res.data.files?.[0]?.id;

      // Zamiast createReadStream używamy readFileSync by wyeliminować Stream Crash w Gaxios
      const fileContent = fs.readFileSync(localPath, 'utf8');
      const media = { mimeType: 'application/json', body: fileContent };

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
  }, 2500); // 2.5 sekundy debounce by zapobiec blokadom Google API
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
  console.log("[CLOUD] Rozpoczynam synchronizację z Google Drive...");
  try {
    await ensureServerFolder();
    if (pearServerFolderId) {
      await downloadFromDrive('guilds.json', GUILDS_FILE);
      await downloadFromDrive('chat-history.json', HISTORY_FILE);
      await downloadFromDrive('users.json', USERS_FILE);
      console.log("[CLOUD] Synchronizacja zakończona sukcesem.");
    } else {
      console.warn("[CLOUD] Brak folderu serwera na Drive - działam w trybie lokalnym.");
    }
  } catch (e) {
    console.error("[CLOUD] Krytyczny błąd synchronizacji:", e.message);
  } finally {
    // Zawsze ładujemy dane (chociażby lokalne), aby serwer nie był pusty
    loadAllData();
    // Powiadomienie wszystkich połączonych o nowych danych
    io.emit('chat-buffer', messageBuffer.filter(m => {
      if (!m.channel) return false;
      return m.channel.toLowerCase() === "ogólny";
    }));
    updateAllRoomStates();
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
      
      // MIGRACJA: Dodaj nickname i registeredAt jeśli ich nie ma
      let migrated = false;
      Object.keys(allSeenUsers).forEach(uName => {
        if (!allSeenUsers[uName].nickname) {
          allSeenUsers[uName].nickname = uName;
          migrated = true;
        }
        if (!allSeenUsers[uName].registeredAt) {
          allSeenUsers[uName].registeredAt = Date.now();
          migrated = true;
        }
      });
      if (migrated) {
        console.log("🛠 Wykryto brakujące dane profilowe - przeprowadzono migrację.");
        saveUsers();
      }
    } catch (e) { }
  }

  // MIGRACJA GILDII: Dodaj memberMetadata jeśli go nie ma
  Object.keys(guilds).forEach(gId => {
    if (!guilds[gId].memberMetadata) guilds[gId].memberMetadata = {};
  });

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

  // Wymuszenie przynależności każdego gracza do gildii bazowej The Lobby
  if (guilds['lobby-default']) {
    if (!guilds['lobby-default'].members) guilds['lobby-default'].members = [];
    let lobbyChanged = false;
    Object.keys(allSeenUsers).forEach(username => {
      if (!guilds['lobby-default'].members.includes(username)) {
        guilds['lobby-default'].members.push(username);
        lobbyChanged = true;
      }
    });
    if (lobbyChanged) saveGuilds();
  }

  // Lista wszystkich zalogowanych nazw użytkowników (każdy socket z username)
  const onlineUsernames = Array.from(io.sockets.sockets.values())
    .map(s => users[s.id]?.username)
    .filter(u => u != null);

  // Przygotuj kopię allSeenUsers z nakładką aktualnych statusów ONLINE
  const broadcastUsers = { ...allSeenUsers };
  
  // 1. Dodaj osoby z Grace Period (oczekujące na powrót)
  gracePeriodUsers.forEach((_, username) => {
    if (allSeenUsers[username]) {
      broadcastUsers[username] = {
        ...allSeenUsers[username],
        status: allSeenUsers[username].status === 'offline' ? 'online' : allSeenUsers[username].status,
        nickname: allSeenUsers[username].nickname || username,
        registeredAt: allSeenUsers[username].registeredAt,
        lastSeen: Date.now()
      };
      if (!onlineUsernames.includes(username)) onlineUsernames.push(username);
    }
  });

  // 2. Dodaj osoby z aktywnymi gniazdami
  Array.from(io.sockets.sockets.values()).forEach(s => {
    const u = users[s.id];
    if (u && u.username) {
      broadcastUsers[u.username] = {
        ...allSeenUsers[u.username],
        username: u.username,
        avatar: u.avatar,
        status: u.status || 'online',
        customText: u.customText || '',
        nickname: allSeenUsers[u.username]?.nickname || u.username,
        registeredAt: allSeenUsers[u.username]?.registeredAt,
        lastSeen: Date.now()
      };
      if (!onlineUsernames.includes(u.username)) onlineUsernames.push(u.username);
    }
  });

  allRooms.forEach(roomId => {
    const usersInRoom = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
      .map(id => {
        const uName = users[id]?.username;
        return {
          username: uName,
          nickname: allSeenUsers[uName]?.nickname || uName,
          registeredAt: allSeenUsers[uName]?.registeredAt,
          avatar: users[id]?.avatar,
          mic: users[id]?.mic || false,
          deaf: users[id]?.deaf || false,
          status: users[id]?.status || 'online',
          customText: users[id]?.customText || ''
        };
      })
      .filter(u => u.username != null);
    roomsData[roomId] = usersInRoom;
  });

  io.emit('global-room-update', { rooms: roomsData, users: broadcastUsers, guilds, onlineUsernames });
};

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const accessToken = socket.handshake.auth?.accessToken;

  if (token || accessToken) {
    const foundUser = Object.values(allSeenUsers).find(u => 
      (token && u.sessionToken === token) || 
      (accessToken && u.accessToken === accessToken)
    );

    if (foundUser) {
      socket.preIdentifiedUsername = foundUser.username;
      socket.sessionToken = foundUser.sessionToken;
      
      // Jeśli użytkownik był offline, przywracamy go do online już w handshake
      if (allSeenUsers[foundUser.username].status === 'offline') {
        allSeenUsers[foundUser.username].status = 'online';
      }
      
      console.log(`[AUTH] Rozpoznano socket ${socket.id} jako ${foundUser.username} przez handshake (podwójny).`);
    }
  }
  next();
});

io.on('connection', (socket) => {
  // Jeśli użytkownik został rozpoznany w handshake, ustawiamy go od razu
  const preUser = socket.preIdentifiedUsername ? allSeenUsers[socket.preIdentifiedUsername] : null;
  
  users[socket.id] = { 
    username: socket.preIdentifiedUsername || null, 
    avatar: preUser ? preUser.avatar : null, 
    rooms: new Set(), 
    mic: false, 
    deaf: false, 
    status: preUser ? 'online' : 'online' 
  };

  if (socket.preIdentifiedUsername) {
    updateAllRoomStates();
  }

  // Logowanie przez Kod Autoryzacyjny (do Refresh Tokens)
  socket.on('google-code-login', async ({ code, roomId, status, customText }) => {
    console.log(`[AUTH] Wymiana kodu na tokeny...`);
    try {
      // WAŻNE: redirect_uri musi być identyczne jak w Rust (main.rs)
      const { tokens } = await googleClient.getToken({
        code,
        redirect_uri: "http://localhost:1421"
      });
      // UWAGA: Usunięto błąd - googleClient.setCredentials(tokens) nadpisywało uprawnienia dysku chmury!

      const ticket = await googleClient.verifyIdToken({
        idToken: tokens.id_token,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const sessionToken = crypto.randomUUID();

      let existing = allSeenUsers[payload.name];
      allSeenUsers[payload.name] = {
        username: payload.name,
        avatar: payload.picture,
        status: status || (existing ? existing.status : 'online'),
        customText: customText || (existing ? existing.customText : ''),
        nickname: (existing && existing.nickname) ? existing.nickname : payload.name,
        registeredAt: (existing && existing.registeredAt) ? existing.registeredAt : Date.now(),
        lastSeen: Date.now(),
        sessionToken,
        refreshToken: tokens.refresh_token || (existing ? existing.refreshToken : null),
        accessToken: tokens.access_token
      };
      saveUsers();

      users[socket.id].username = payload.name;
      users[socket.id].avatar = payload.picture;
      users[socket.id].status = allSeenUsers[payload.name].status;
      users[socket.id].customText = allSeenUsers[payload.name].customText;

      socket.join(roomId || "Ogólny");
      users[socket.id].rooms.add(roomId || "Ogólny");

      console.log(`[AUTH] Emituję login-success dla ${payload.name}: Nick=${allSeenUsers[payload.name].nickname}, RegAt=${allSeenUsers[payload.name].registeredAt}`);
      socket.emit('login-success', {
        username: payload.name,
        avatar: payload.picture,
        nickname: allSeenUsers[payload.name].nickname || payload.name,
        registeredAt: allSeenUsers[payload.name].registeredAt || Date.now(),
        status: users[socket.id].status,
        customText: users[socket.id].customText,
        sessionToken,
        accessToken: tokens.access_token
      });

      socket.emit('chat-buffer', messageBuffer.filter(m => m.channel === (roomId || "Ogólny")));
      updateAllRoomStates();
    } catch (e) {
      console.error("[AUTH] Błąd wymiany kodu:", e.message);
      socket.emit('login-error', { error: "Błąd autoryzacji Google (Code Exchange)" });
    }
  });

  // Logowanie przez Google
  socket.on('google-login', async ({ credential, roomId, status, customText }) => {
    console.log(`[LOGIN] Próba logowania. ID Klienta (serwer): ${GOOGLE_CLIENT_ID.substring(0, 15)}...`);
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      console.log(`[LOGIN] Sukces: ${payload.name} (${payload.email})`);

      users[socket.id].username = payload.name;
      users[socket.id].avatar = payload.picture;
      users[socket.id].status = status || 'online';
      if (customText) users[socket.id].customText = customText.substring(0, 32);

      const sessionToken = crypto.randomUUID();
      let existing = allSeenUsers[payload.name];
      allSeenUsers[payload.name] = {
        username: payload.name,
        avatar: payload.picture,
        nickname: existing && existing.nickname ? existing.nickname : payload.name,
        registeredAt: existing && existing.registeredAt ? existing.registeredAt : Date.now(),
        status: status || (existing ? existing.status : 'online'),
        customText: customText || (existing ? existing.customText : ''),
        lastSeen: Date.now(),
        sessionToken: sessionToken
      };
      saveUsers();

      socket.join(roomId);
      users[socket.id].rooms.add(roomId);

      console.log(`[LOGIN] Emituję login-success dla ${payload.name}: Nick=${allSeenUsers[payload.name].nickname}, RegAt=${allSeenUsers[payload.name].registeredAt}`);
      socket.emit('login-success', {
        username: payload.name,
        avatar: payload.picture,
        nickname: allSeenUsers[payload.name].nickname || payload.name,
        registeredAt: allSeenUsers[payload.name].registeredAt || Date.now(),
        status: users[socket.id].status,
        customText: users[socket.id].customText,
        sessionToken: sessionToken
      });

      socket.emit('chat-buffer', messageBuffer.filter(m => m.channel === roomId));
      updateAllRoomStates();

      if (roomId && (roomId.startsWith('voice-') || roomId === 'Lobby')) {
        socket.to(roomId).emit('user-connected', socket.id);
      }
    } catch (e) {
      console.error("[LOGIN] Błąd weryfikacji:", e.message);
      socket.emit('login-error', { error: "Błąd weryfikacji Google" });
    }
  });

  // Logowanie przez Trwałą Sesję (Session Token)
  socket.on('session-login', ({ token, roomId, status, customText }) => {
    console.log(`[SESSION] Próba logowania sesją...`);
    const foundUser = Object.values(allSeenUsers).find(u => u.sessionToken === token);
    
    if (foundUser) {
      console.log(`[SESSION] Sukces: ${foundUser.username}`);
      users[socket.id].username = foundUser.username;
      users[socket.id].avatar = foundUser.avatar;
      
      // Ważne: Nadpisujemy status tym, co wysłał klient (np. 'online')
      // zamiast brać 'offline' z bazy, który mógł się zapisać przy rozłączeniu starego socketu.
      users[socket.id].status = status || 'online';
      users[socket.id].customText = customText || '';

      // Czyścimy Grace Period, ponieważ użytkownik właśnie wrócił
      if (gracePeriodUsers.has(foundUser.username)) {
        clearTimeout(gracePeriodUsers.get(foundUser.username));
        gracePeriodUsers.delete(foundUser.username);
        console.log(`[PRESENCE] ${foundUser.username} wrócił przed upływem Grace Period.`);
      }

      // Migracja / Naprawa brakujących pól dla starych kont
      let needsSave = false;
      if (!allSeenUsers[foundUser.username].nickname) {
        allSeenUsers[foundUser.username].nickname = foundUser.username;
        needsSave = true;
      }
      if (!allSeenUsers[foundUser.username].registeredAt) {
        allSeenUsers[foundUser.username].registeredAt = Date.now();
        needsSave = true;
      }

      // Aktualizujemy bazę danych, aby inni widzieli nas jako Online
      allSeenUsers[foundUser.username].status = users[socket.id].status;
      allSeenUsers[foundUser.username].customText = users[socket.id].customText;
      allSeenUsers[foundUser.username].lastSeen = Date.now();
      if (needsSave || true) saveUsers(); // Zawsze zapisujemy aktywność

      socket.join(roomId || "Ogólny");
      users[socket.id].rooms.add(roomId || "Ogólny");

      console.log(`[SESSION] Emituję login-success dla ${foundUser.username}: Nick=${foundUser.nickname}, RegAt=${foundUser.registeredAt}`);
      socket.emit('login-success', {
        username: foundUser.username,
        avatar: foundUser.avatar,
        nickname: foundUser.nickname || foundUser.username,
        registeredAt: foundUser.registeredAt || Date.now(),
        status: users[socket.id].status,
        customText: users[socket.id].customText,
        sessionToken: token,
        accessToken: foundUser.accessToken
      });

      const targetRoom = roomId || "Ogólny";
      const filteredBuffer = messageBuffer.filter(m => {
        if (!m.channel) return false;
        // Odporność na wielkość liter dla głównego kanału
        if (targetRoom.toLowerCase() === "ogólny") {
          return m.channel.toLowerCase() === "ogólny";
        }
        return m.channel === targetRoom;
      });

      socket.emit('chat-buffer', filteredBuffer);
      console.log(`[SESSION] Wysłano ${filteredBuffer.length} wiadomości do ${foundUser.username} dla kanału ${targetRoom}`);
      updateAllRoomStates();

      if (roomId && (roomId.startsWith('voice-') || roomId === 'Lobby')) {
        socket.to(roomId).emit('user-connected', socket.id);
      }
    } else {
      console.warn(`[AUTH-FAIL] Nieprawidłowy lub wygasły token sesji: ${token?.substring(0, 8)}...`);
      socket.emit('session-login-error', { error: "Sesja wygasła lub jest nieprawidłowa" });
    }
  });

  // Prośba o świeży token Dysku Google
  socket.on('refresh-drive-token', async () => {
    const user = users[socket.id];
    if (!user || !user.username) return;

    const profile = allSeenUsers[user.username];
    if (!profile || !profile.refreshToken) {
        return socket.emit('drive-token-error', { error: "Brak Refresh Tokena. Zaloguj się ponownie." });
    }

    try {
      console.log(`[DRIVE] Odświeżanie tokenu dla ${user.username}...`);
      const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
      client.setCredentials({ refresh_token: profile.refreshToken });
      const { credentials } = await client.refreshAccessToken();
      
      profile.accessToken = credentials.access_token;
      saveUsers();

      socket.emit('drive-token-update', { accessToken: credentials.access_token });
    } catch (e) {
      console.error("[DRIVE] Błąd odświeżania:", e.message);
      socket.emit('drive-token-error', { error: "Nie udało się odświeżyć dostępu do Dysku" });
    }
  });

  socket.on('join-room', ({ roomId, username }) => {
    // Autoryzacja Gildijna Przed Dołączeniem
    let targetGuildId = null;
    if (guilds[roomId]) targetGuildId = roomId;
    else {
      targetGuildId = Object.keys(guilds).find(gid => guilds[gid].channels && guilds[gid].channels.some(c => c.id === roomId));
    }
    
    if (targetGuildId && guilds[targetGuildId]) {
      if (!guilds[targetGuildId].members || !guilds[targetGuildId].members.includes(username)) {
        return socket.emit('chat-message', {
           id: Date.now(),
           author: "System",
           text: "Brak uprawnień do tego pokoju. Prawdopodobnie nie jesteś na liście autoryzowanych członków gildii.",
           channel: roomId,
           type: 'text'
        });
      }
    }

    socket.join(roomId);
    users[socket.id].username = username;
    users[socket.id].rooms.add(roomId);
    socket.emit('chat-buffer', messageBuffer.filter(m => m.channel === roomId));
    
    // Analityka dołączania do gildii

    if (targetGuildId && guilds[targetGuildId]) {
      if (!guilds[targetGuildId].memberMetadata) guilds[targetGuildId].memberMetadata = {};
      const meta = guilds[targetGuildId].memberMetadata;
      if (!meta[username]) {
        meta[username] = { firstJoinedAt: Date.now(), lastJoinedAt: Date.now() };
      } else {
        meta[username].lastJoinedAt = Date.now();
      }
      saveGuilds();
    }

    updateAllRoomStates();
    if (roomId && (roomId.startsWith('voice-') || roomId === 'Lobby')) {
      socket.to(roomId).emit('user-connected', socket.id);
    }
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
          allSeenUsers[username] = { 
            username, 
            avatar: users[socket.id].avatar,
            nickname: username,
            registeredAt: Date.now()
          };
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

    const guildId = `guild-${crypto.randomBytes(4).toString('hex')}-${Date.now()}`;
    guilds[guildId] = {
      id: guildId,
      name,
      icon,
      owner: user.username,
      members: [user.username],
      memberMetadata: {
        [user.username]: { firstJoinedAt: Date.now(), lastJoinedAt: Date.now() }
      },
      channels: [
        { id: `${guildId}-ogolny`, name: 'ogólny', type: 'text' },
        { id: `${guildId}-voice`, name: 'Głosowy', type: 'voice' }
      ]
    };
    saveGuilds();
    updateAllRoomStates();
  });

  socket.on('leave-guild', ({ guildId }) => {
    const user = users[socket.id];
    if (!user || !user.username || guildId === 'lobby-default') return;

    if (guilds[guildId]) {
      const guild = guilds[guildId];
      // Usuń użytkownika z listy członków
      guild.members = guild.members.filter(m => m !== user.username);
      
      // Jeśli właściciel opuszcza serwer, usuwamy cały serwer (lub można przekazać własność, ale tu usuwamy)
      if (guild.owner === user.username) {
        delete guilds[guildId];
      }
      
      saveGuilds();
      updateAllRoomStates();
      console.log(`[GUILD] Użytkownik ${user.username} opuścił gildię ${guildId}`);
    }
  });

  socket.on('update-nickname', ({ nickname }) => {
    const user = users[socket.id];
    if (user && user.username && nickname && nickname.length >= 3) {
      const sanitizedNickname = nickname.substring(0, 32);
      allSeenUsers[user.username].nickname = sanitizedNickname;
      saveUsers();
      updateAllRoomStates();
      console.log(`[PROFILE] Użytkownik ${user.username} zmienił pseudonim na: ${sanitizedNickname}`);
    }
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
    
    // BŁĄD PAMIĘCI - brakowało definicji zmiennej user!
    const user = users[socket.id];
    
    if (user && user.username) {
      // Dajemy użytkownikowi 2.5 sekundy na ponowne połączenie
      console.log(`[PRESENCE] ${user.username} rozłączony - start Grace Period (2.5s).`);
      
      const timeoutId = setTimeout(() => {
        const stillStreaming = Array.from(io.sockets.sockets.values())
          .some(s => users[s.id]?.username === user.username);
        
        if (!stillStreaming) {
          console.log(`[PRESENCE] ${user.username} zniknął ostatecznie po 2.5s.`);
          if (allSeenUsers[user.username]) {
            allSeenUsers[user.username].status = 'offline';
            allSeenUsers[user.username].lastSeen = Date.now();
            saveUsers();
          }
        }
        gracePeriodUsers.delete(user.username);
        updateAllRoomStates();
      }, 2500);

      gracePeriodUsers.set(user.username, timeoutId);
    }

    delete users[socket.id];
    updateAllRoomStates();
  });
});


const PORT = process.env.PORT || 3000;

// Blokujemy start serwera podwójnie
(async () => {
  console.log("📂 Inicjalizacja danych z chmury...");
  await initCloud();
  
  server.listen(PORT, () => {
    console.log(`🚀 Serwer Gruszki z Google Auth działa na porcie ${PORT}!`);
  });
})();