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
let backupsFolderId = null; // Folder dla rotowanych backupów 24h

let pearFriendsFolderId = null;
let friendsBackupsFolderId = null;

const users = {}; // socket.id -> { username, avatar, rooms: Set, mic: bool, deaf: bool, status: string }
const gracePeriodUsers = new Map(); // username -> setTimeout ID
let isSyncEnabled = true; // Bezpiecznik: Jeśli ładowanie danych zawiedzie, blokujemy wysyłanie pustych danych do chmury!

// --- POMOCNICZE FUNKCJE BEZPIECZEŃSTWA (BACKUPY) ---
function createLocalBackup(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const backupPath = filePath + '.bak';
    fs.copyFileSync(filePath, backupPath);
  } catch (err) {
    console.error(`[SAFETY] Błąd tworzenia kopii zapasowej ${filePath}:`, err.message);
  }
}

// --- TRWAŁA HISTORIA CZATU W PLIKU JSON ---
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');
let messageBuffer = [];

const DM_HISTORY_FILE = path.join(__dirname, 'dm-history.json');
let dmMessageBuffer = [];

// --- TRWAŁA KONFIGURACJA GILDII W PLIKU JSON ---
const GUILDS_FILE = path.join(__dirname, 'guilds.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
const DEVICE_SETTINGS_FILE = path.join(__dirname, 'device-settings.json');

let guilds = {};
let allSeenUsers = {};
let friendsData = {}; // Zastępuje obiekty friends i friendRequests z allSeenUsers
let deviceSettings = {};

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

    // 3. Szukaj folderu 'backups' w 'server'
    const qBak = `name='backups' and '${srvId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resBak = await drive.files.list({ q: qBak, fields: 'files(id)' });
    let bakId = resBak.data.files?.[0]?.id;

    if (!bakId) {
      const createBak = await drive.files.create({
        requestBody: { name: 'backups', parents: [srvId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      bakId = createBak.data.id;
    }
    backupsFolderId = bakId;
    console.log("📁 Folder backupów gotowy (ID:", backupsFolderId, ")");

    // 4. Szukaj folderu 'friends' w 'pear'
    const qFnd = `name='friends' and '${pearId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resFnd = await drive.files.list({ q: qFnd, fields: 'files(id)' });
    let fndId = resFnd.data.files?.[0]?.id;

    if (!fndId) {
      const createFnd = await drive.files.create({
        requestBody: { name: 'friends', parents: [pearId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      fndId = createFnd.data.id;
    }
    pearFriendsFolderId = fndId;
    console.log("✅ Połączono z folderem Drive: /pear/friends (ID:", pearFriendsFolderId, ")");

    // 5. Szukaj folderu 'backups' w 'friends'
    const qFBak = `name='backups' and '${fndId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resFBak = await drive.files.list({ q: qFBak, fields: 'files(id)' });
    let fBakId = resFBak.data.files?.[0]?.id;

    if (!fBakId) {
      const createFBak = await drive.files.create({
        requestBody: { name: 'backups', parents: [fndId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      fBakId = createFBak.data.id;
    }
    friendsBackupsFolderId = fBakId;
    console.log("📁 Folder backupów DM gotowy (ID:", friendsBackupsFolderId, ")");

    return true;
  } catch (e) {
    console.error("❌ Błąd folderów Drive:", e.message);
    return null;
  }
}

const syncTimeouts = {};

// --- AUTOMATYCZNE BACKUPY 24H Z ROTACJĄ (3 wersje na typ pliku) ---
async function runCloudBackup() {
  if (!isSyncEnabled) {
    console.log("⚠️ [BACKUP] Pominięto backup (Sync Lock aktywny).");
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  console.log(`[BACKUP] Rozpoczynam dobową kopię zapasową: ${dateStr}`);

  const filesToBackup = [
    { local: USERS_FILE, driveName: `backup-users-${dateStr}.json`, targetDir: backupsFolderId },
    { local: GUILDS_FILE, driveName: `backup-guilds-${dateStr}.json`, targetDir: backupsFolderId },
    { local: HISTORY_FILE, driveName: `backup-history-${dateStr}.json`, targetDir: backupsFolderId },
    { local: FRIENDS_FILE, driveName: `backup-friends-${dateStr}.json`, targetDir: friendsBackupsFolderId },
    { local: DM_HISTORY_FILE, driveName: `backup-dm-history-${dateStr}.json`, targetDir: friendsBackupsFolderId },
    { local: DEVICE_SETTINGS_FILE, driveName: `backup-device-settings-${dateStr}.json`, targetDir: backupsFolderId }
  ];

  for (const f of filesToBackup) {
    if (!fs.existsSync(f.local) || !f.targetDir) continue;
    try {
      const content = fs.readFileSync(f.local, 'utf8');
      JSON.parse(content); // Weryfikacja przed wysyłką

      await drive.files.create({
        requestBody: { name: f.driveName, parents: [f.targetDir] },
        media: { mimeType: 'application/json', body: content }
      });
      console.log(`✅ [BACKUP] Wysłano: ${f.driveName}`);
    } catch (e) {
      console.error(`❌ [BACKUP] Błąd pliku ${f.local}:`, e.message);
    }
  }

  await rotateFolderBackups(backupsFolderId, ['users', 'guilds', 'history']);
  await rotateFolderBackups(friendsBackupsFolderId, ['friends', 'dm-history']);
}

async function rotateFolderBackups(folderId, categories) {
  if (!folderId) return;
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc'
    });
    const files = res.data.files || [];

    for (const cat of categories) {
      const catFiles = files.filter(f => f.name.includes(`backup-${cat}-`));
      if (catFiles.length > 3) {
        const toDelete = catFiles.slice(3);
        for (const df of toDelete) {
          await drive.files.delete({ fileId: df.id });
          console.log(`🗑️ [ROTATE] Usunięto stary backup: ${df.name}`);
        }
      }
    }
  } catch (e) {
    console.error("❌ [ROTATE] Błąd rotacji backupów:", e.message);
  }
}

function syncFileToDrive(localPath, driveFileName, targetFolderId = pearServerFolderId) {
  if (!isSyncEnabled) {
    console.log(`⚠️ [SAFETY] Synchronizacja ${driveFileName} zablokowana (Sync Lock).`);
    return;
  }

  if (syncTimeouts[driveFileName]) {
    clearTimeout(syncTimeouts[driveFileName]);
  }
  
    syncTimeouts[driveFileName] = setTimeout(async () => {
    if (!targetFolderId || !fs.existsSync(localPath)) return;
    try {
      // Sprawdź czy plik istnieje
      const q = `name='${driveFileName}' and '${targetFolderId}' in parents and trashed=false`;
      const res = await drive.files.list({ q, fields: 'files(id)' });
      const fileId = res.data.files?.[0]?.id;

      const fileContent = fs.readFileSync(localPath, 'utf8');
      const media = { mimeType: 'application/json', body: fileContent };

      if (fileId) {
        await drive.files.update({ fileId, media });
      } else {
        await drive.files.create({
          requestBody: { name: driveFileName, parents: [targetFolderId] },
          media
        });
      }
    } catch (e) {
      console.error(`❌ Błąd uploadu ${driveFileName} do Drive:`, e.message);
    }
  }, 2500); // 2.5 sekundy debounce by zapobiec blokadom Google API
}

async function downloadFromDrive(fileName, localPath, targetFolderId = pearServerFolderId) {
  if (!targetFolderId) return;
  try {
    const q = `name='${fileName}' and '${targetFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    const fileId = res.data.files?.[0]?.id;
    if (!fileId) return;

    const tmpPath = localPath + '.tmp';
    const dest = fs.createWriteStream(tmpPath);
    const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    
    await new Promise((resolve, reject) => {
      dest.on('finish', resolve);
      dest.on('error', reject);
      driveRes.data
        .on('error', reject)
        .pipe(dest);
    });

    // WERYFIKACJA POBRANEGO PLIKU
    try {
      const content = fs.readFileSync(tmpPath, 'utf8');
      if (content.trim().length === 0) throw new Error("Plik jest pusty");
      JSON.parse(content); // Sprawdź czy to poprawny JSON
      
      // Jeśli OK, podmień plik lokalny
      if (fs.existsSync(localPath)) createLocalBackup(localPath);
      fs.renameSync(tmpPath, localPath);
      console.log(`💾 Pomyślnie pobrano i zweryfikowano ${fileName} z Drive.`);
    } catch (e) {
      console.error(`⚠️ [SAFETY] Pobrany ${fileName} jest uszkodzony lub pusty. Ignoruję nadpisanie lokalne.`);
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      isSyncEnabled = false; // LOCK: Nie pozwalamy na sync-back, skoro pobranie się nie udało!
    }
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
      await downloadFromDrive('guilds.json', GUILDS_FILE, pearServerFolderId);
      await downloadFromDrive('chat-history.json', HISTORY_FILE, pearServerFolderId);
      await downloadFromDrive('users.json', USERS_FILE, pearServerFolderId);
      await downloadFromDrive('device-settings.json', DEVICE_SETTINGS_FILE, pearServerFolderId);
      if (pearFriendsFolderId) {
        await downloadFromDrive('friends.json', FRIENDS_FILE, pearFriendsFolderId);
        await downloadFromDrive('dm-history.json', DM_HISTORY_FILE, pearFriendsFolderId);
      }
      console.log("[CLOUD] Synchronizacja zakończona sukcesem.");
    } else {
      console.warn("[CLOUD] Brak folderu serwera na Drive - działam w trybie lokalnym.");
    }
  } catch (e) {
    console.error("[CLOUD] Krytyczny błąd synchronizacji:", e.message);
  } finally {
    // Zawsze ładujemy dane (chociażby lokalne), aby serwer nie był pusty
    loadAllData();
    
    // Zaplanuj backupy 24h
    setInterval(runCloudBackup, 24 * 60 * 60 * 1000);
    // Wykonaj pierwszy backup po 10 sekundach od startu (po pobraniu z chmury)
    setTimeout(runCloudBackup, 10000);

    // Powiadomienie wszystkich połączonych o nowych danych
    io.emit('chat-buffer', messageBuffer.filter(m => {
      if (!m.channel) return false;
      return m.channel.toLowerCase() === "ogólny";
    }));
    updateAllRoomStates();
  }
}

function loadAllData() {
  // HISTORY FILE
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      messageBuffer = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`Załadowano ${messageBuffer.length} wiadomości globalnych.`);
    } catch (e) { 
      console.error("⚠️ [SAFETY] Uszkodzony plik history. Załadowano pusty bufor.");
      isSyncEnabled = false; 
    }
  }
  
  // DM HISTORY FILE
  if (fs.existsSync(DM_HISTORY_FILE)) {
    try {
      dmMessageBuffer = JSON.parse(fs.readFileSync(DM_HISTORY_FILE, 'utf8'));
      console.log(`Załadowano ${dmMessageBuffer.length} wiadomości prywatnych DM.`);
    } catch (e) { 
      console.error("⚠️ [SAFETY] Uszkodzony plik dm-history. Załadowano pusty bufor DM.");
      isSyncEnabled = false; 
    }
  }

  // MIGRACJA WIADOMOŚCI DM ZE STAREGO CHAT-HISTORY W LOCIE
  if (messageBuffer.length > 0) {
    const dmExtract = messageBuffer.filter(m => m.channel && m.channel.startsWith('dm-'));
    if (dmExtract.length > 0) {
      console.log(`🛠 Wykryto zaszłe wiadomości DM (${dmExtract.length}) w głównym pliku. Wykonuję migrację...`);
      const existingDmIds = new Set(dmMessageBuffer.map(m => m.id));
      dmExtract.forEach(dmMsg => {
        if (!existingDmIds.has(dmMsg.id)) dmMessageBuffer.push(dmMsg);
      });
      dmMessageBuffer.sort((a, b) => a.id - b.id);
      messageBuffer = messageBuffer.filter(m => !m.channel || !m.channel.startsWith('dm-'));
      saveDmHistory();
      saveHistory(); // Oczyszcza stary log
    }
  }

  // GUILDS
  if (fs.existsSync(GUILDS_FILE)) {
    try {
      guilds = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf8'));
      console.log(`Załadowano ${Object.keys(guilds).length} gildi.`);
    } catch (e) { 
      console.error("⚠️ [SAFETY] Uszkodzony plik guilds! Blokuję synchronizację Cloud.");
      isSyncEnabled = false; 
    }
  }
  
  // FRIENDS DATA
  if (fs.existsSync(FRIENDS_FILE)) {
    try {
      friendsData = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
      console.log(`Załadowano pulę relacji przyjaciół dla ${Object.keys(friendsData).length} osób.`);
    } catch (e) {
      console.error("⚠️ [SAFETY] Uszkodzony plik friends! Blokuję synchronizację Cloud.");
      isSyncEnabled = false; 
    }
  }

  // USERS DATA
  if (fs.existsSync(USERS_FILE)) {
    try {
      allSeenUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      console.log(`Załadowano ${Object.keys(allSeenUsers).length} użytkowników.`);
      
      let usersMigrated = false;
      let friendsMigrated = false;

      Object.keys(allSeenUsers).forEach(uName => {
        const u = allSeenUsers[uName];
        if (!u.nickname) { u.nickname = uName; usersMigrated = true; }
        if (!u.registeredAt) { u.registeredAt = Date.now(); usersMigrated = true; }
        
        // WYCIĄGANIE LISTY ZNAJOMYCH DO ODSEPAROWANEGO OBIEKTU Z PROFILU
        if (u.friends !== undefined || u.friendRequests !== undefined) {
          friendsMigrated = true;
          if (!friendsData[uName]) friendsData[uName] = { friends: [], friendRequests: [] };
          // Złącz istniejące i te z profilu na wszelki wypadek
          const mergedFriends = new Set([...(friendsData[uName].friends||[]), ...(u.friends||[])]);
          const mergedReq = new Set([...(friendsData[uName].friendRequests||[]), ...(u.friendRequests||[])]);
          friendsData[uName].friends = Array.from(mergedFriends);
          friendsData[uName].friendRequests = Array.from(mergedReq);
          // Usuń z profilu głównego u.
          delete u.friends;
          delete u.friendRequests;
          usersMigrated = true;
        }
      });
      
      if (friendsMigrated) {
        console.log("🛠 Zakończono ekstrakcję relacji do struktury friendsData.");
        saveFriends();
      }
      if (usersMigrated) {
        console.log("🛠 Wyczyszczono profiles i zapisano zrewidowaną konfigurację users.");
        saveUsers();
      }
    } catch (e) { 
      console.error("⚠️ [SAFETY] Uszkodzony plik users! Blokuję synchronizację Cloud.", e);
      isSyncEnabled = false; 
    }
  }

  // MIGRACJA GILDII: Dodaj memberMetadata jeśli go nie ma
  Object.keys(guilds).forEach(gId => {
    if (!guilds[gId].memberMetadata) guilds[gId].memberMetadata = {};
  });

  // DEVICE SETTINGS
  if (fs.existsSync(DEVICE_SETTINGS_FILE)) {
    try {
      deviceSettings = JSON.parse(fs.readFileSync(DEVICE_SETTINGS_FILE, 'utf8'));
      console.log(`Załadowano ustawienia dla ${Object.keys(deviceSettings).length} urządzeń.`);
    } catch (e) {
      console.error("⚠️ [SAFETY] Uszkodzony plik device-settings! Blokuję synchronizację Cloud.");
      isSyncEnabled = false;
    }
  }

  ensureLobby();
}

const saveDeviceSettings = () => {
  try {
    createLocalBackup(DEVICE_SETTINGS_FILE);
    fs.writeFileSync(DEVICE_SETTINGS_FILE, JSON.stringify(deviceSettings, null, 2));
    syncFileToDrive(DEVICE_SETTINGS_FILE, 'device-settings.json', pearServerFolderId);
  } catch (err) {
    console.error('Błąd zapisu device-settings.json:', err);
  }
};

const saveHistory = () => {
  try {
    if (messageBuffer.length > 10000) messageBuffer = messageBuffer.slice(-10000);
    createLocalBackup(HISTORY_FILE);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(messageBuffer, null, 2));
    syncFileToDrive(HISTORY_FILE, 'chat-history.json', pearServerFolderId);
  } catch (err) {
    console.error('Błąd zapisu chat-history.json:', err);
  }
};

const saveDmHistory = () => {
  try {
    if (dmMessageBuffer.length > 10000) dmMessageBuffer = dmMessageBuffer.slice(-10000);
    createLocalBackup(DM_HISTORY_FILE);
    fs.writeFileSync(DM_HISTORY_FILE, JSON.stringify(dmMessageBuffer, null, 2));
    syncFileToDrive(DM_HISTORY_FILE, 'dm-history.json', pearFriendsFolderId);
  } catch (err) {
    console.error('Błąd zapisu dm-history.json:', err);
  }
};

const saveGuilds = () => {
  try {
    createLocalBackup(GUILDS_FILE);
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(guilds, null, 2));
    syncFileToDrive(GUILDS_FILE, 'guilds.json', pearServerFolderId);
  } catch (err) {
    console.error('Błąd zapisu guilds.json:', err);
  }
};

const saveUsers = () => {
  try {
    createLocalBackup(USERS_FILE);
    fs.writeFileSync(USERS_FILE, JSON.stringify(allSeenUsers, null, 2));
    syncFileToDrive(USERS_FILE, 'users.json', pearServerFolderId);
  } catch (err) {
    console.error('Błąd zapisu users.json:', err);
  }
};

const saveFriends = () => {
  try {
    createLocalBackup(FRIENDS_FILE);
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(friendsData, null, 2));
    syncFileToDrive(FRIENDS_FILE, 'friends.json', pearFriendsFolderId);
  } catch (err) {
    console.error('Błąd zapisu friends.json:', err);
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
    let usersInRoom = Array.from(io.sockets.adapter.rooms.get(roomId) || [])
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
    
    // Deduplikacja, aby jeden użytkownik (np. 2 karty lub zatrzaśnięty socket) nie był podwójnie
    const uniqueUsersMap = new Map();
    usersInRoom.forEach(u => {
      uniqueUsersMap.set(u.username, u);
    });
    usersInRoom = Array.from(uniqueUsersMap.values());
    
    // NOWOŚĆ: Dodaj osoby, które są w Grace Period, ale były w tym pokoju głosowym
    if (roomId.startsWith('voice-') || roomId === 'Lobby') {
      gracePeriodUsers.forEach((_, username) => {
        const profile = allSeenUsers[username];
        if (profile && profile.voiceRoomId === roomId) {
          if (!uniqueUsersMap.has(username)) {
            usersInRoom.push({
              username: username,
              nickname: profile.nickname || username,
              registeredAt: profile.registeredAt,
              avatar: profile.avatar,
              mic: profile.lastMicStatus || false,
              deaf: profile.lastDeafStatus || false,
              status: 'away',
              customText: profile.customText || '',
              reconnecting: true
            });
            uniqueUsersMap.set(username, true);
          }
        }
      });
    }

    roomsData[roomId] = usersInRoom;
  });

  // Wzbogać wszystkich o listy znajomych przed wysłaniem stanu
  Object.keys(broadcastUsers).forEach(username => {
    if (friendsData[username]) {
      broadcastUsers[username].friends = friendsData[username].friends || [];
      broadcastUsers[username].friendRequests = friendsData[username].friendRequests || [];
    } else {
      broadcastUsers[username].friends = [];
      broadcastUsers[username].friendRequests = [];
    }
  });

  io.emit('global-room-update', { rooms: roomsData, users: broadcastUsers, guilds, onlineUsernames });
};

function sendChatBuffer(socket, targetRoom) {
  const channel = targetRoom || "Ogólny";
  if (channel.startsWith('dm-')) {
    socket.emit('chat-buffer', dmMessageBuffer.filter(m => m.channel === channel));
  } else {
    socket.emit('chat-buffer', messageBuffer.filter(m => {
      if (!m.channel) return false;
      if (channel.toLowerCase() === "ogólny") return m.channel.toLowerCase() === "ogólny";
      return m.channel === channel;
    }));
  }
}

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
        accessToken: tokens.access_token,
        settings: allSeenUsers[payload.name].settings || {}
      });

      sendChatBuffer(socket, roomId);
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
        sessionToken: sessionToken,
        settings: allSeenUsers[payload.name].settings || {}
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
      
      // Przywracamy mikrofon i słuchawki z bazy jeśli użytkownik wraca
      if (allSeenUsers[foundUser.username].lastMicStatus !== undefined) {
         users[socket.id].mic = allSeenUsers[foundUser.username].lastMicStatus;
      }
      if (allSeenUsers[foundUser.username].lastDeafStatus !== undefined) {
         users[socket.id].deaf = allSeenUsers[foundUser.username].lastDeafStatus;
      }

      if (needsSave || true) saveUsers(); // Zawsze zapisujemy aktywność

      // Automatyczne dołączenie do kanału głosowego jeśli był w nim wcześniej
      const voiceRoom = allSeenUsers[foundUser.username].voiceRoomId;
      if (voiceRoom) {
         socket.join(voiceRoom);
         users[socket.id].rooms.add(voiceRoom);
         console.log(`[VOICE] Przywrócono ${foundUser.username} do kanału głosowego: ${voiceRoom}`);
      }

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
        accessToken: foundUser.accessToken,
        voiceRoomId: voiceRoom || null, // Informujemy klienta, żeby też wiedział że go tam daliśmy
        settings: foundUser.settings || {}
      });

      sendChatBuffer(socket, roomId);
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

  socket.on('join-room', ({ roomId }) => {
    // Autoryzacja Gildijna Przed Dołączeniem
    const user = users[socket.id];
    const username = user ? user.username : null;

    let targetGuildId = null;
    if (guilds[roomId]) targetGuildId = roomId;
    else {
      targetGuildId = Object.keys(guilds).find(gid => guilds[gid].channels && guilds[gid].channels.some(c => c.id === roomId));
    }
    
    if (targetGuildId && guilds[targetGuildId]) {
      if (!username || !guilds[targetGuildId].members || !guilds[targetGuildId].members.includes(username)) {
        console.warn(`[AUTH-GUARD] join-room: Brak uprawnień dla użytkownika ${username} w gildii ${targetGuildId}`);
        return;
      }
    }

    socket.join(roomId);
    users[socket.id].username = username;
    users[socket.id].rooms.add(roomId);
    sendChatBuffer(socket, roomId);
    
    // Zapisywanie kanału głosowego
    if (username && (roomId.startsWith('voice-') || roomId === 'Lobby')) {
      if (allSeenUsers[username]) {
        allSeenUsers[username].voiceRoomId = roomId;
        saveUsers();
        console.log(`[VOICE] Użytkownik ${username} wszedł do pokoju: ${roomId}`);
      }
    }

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
      
      const username = users[socket.id].username;
      if (username && allSeenUsers[username]) {
        allSeenUsers[username].lastMicStatus = mic;
        allSeenUsers[username].lastDeafStatus = deaf;
        saveUsers();
      }
      
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

  socket.on('join-guild', ({ guildId }) => {
    const user = users[socket.id];
    if (!user || !user.username || !guilds[guildId]) return;

    const guild = guilds[guildId];
    if (!guild.members) guild.members = [];
    
    if (!guild.members.includes(user.username)) {
      guild.members.push(user.username);
      if (!guild.memberMetadata) guild.memberMetadata = {};
      guild.memberMetadata[user.username] = { firstJoinedAt: Date.now(), lastJoinedAt: Date.now() };
      
      saveGuilds();
      updateAllRoomStates();
      console.log(`[GUILD] Użytkownik ${user.username} dołączył do gildii: ${guild.name} (${guildId})`);
    }
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

  socket.on('update-settings', ({ settings }) => {
    const user = users[socket.id];
    if (user && user.username && allSeenUsers[user.username]) {
      allSeenUsers[user.username].settings = settings;
      saveUsers();
      
      // Powiadom inne połączenia tego samego użytkownika o zmianie ustawień
      const userSockets = Array.from(io.sockets.sockets.values())
        .filter(s => s.id !== socket.id && users[s.id]?.username === user.username);
      
      userSockets.forEach(s => {
        s.emit('settings-updated', settings);
      });
      
      console.log(`[SETTINGS] Zaktualizowano i rozesłano ustawienia dla ${user.username}`);
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
    if (payload.channel && payload.channel.startsWith('dm-')) {
      dmMessageBuffer.push(payload);
      if (dmMessageBuffer.length > 10000) dmMessageBuffer.shift();
      saveDmHistory();
    } else {
      messageBuffer.push(payload);
      // Zachowuje maksymalnie 10000 wiadomości globalnych w pliku!
      if (messageBuffer.length > 10000) messageBuffer.shift();
      saveHistory();
    }

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
      
      const username = users[socket.id].username;
      if (username && allSeenUsers[username] && (roomId.startsWith('voice-') || roomId === 'Lobby')) {
        if (allSeenUsers[username].voiceRoomId === roomId) {
           allSeenUsers[username].voiceRoomId = null;
           saveUsers();
           console.log(`[VOICE] Użytkownik ${username} opuścił pokój: ${roomId}`);
        }
      }
    }
    updateAllRoomStates();
  });

  socket.on('send-friend-request', ({ targetUsername }) => {
    const user = users[socket.id];
    if (!user || !user.username || user.username === targetUsername) return;
    
    if (!friendsData[targetUsername]) friendsData[targetUsername] = { friends: [], friendRequests: [] };
    if (!friendsData[user.username]) friendsData[user.username] = { friends: [], friendRequests: [] };

    const targetProfile = friendsData[targetUsername];
    const myProfile = friendsData[user.username];

    // Jeśli on już nam wysłał -> automatycznie akceptujemy!
    if (myProfile.friendRequests.includes(targetUsername)) {
      myProfile.friendRequests = myProfile.friendRequests.filter(u => u !== targetUsername);
      if (!myProfile.friends.includes(targetUsername)) myProfile.friends.push(targetUsername);
      if (!targetProfile.friends.includes(user.username)) targetProfile.friends.push(user.username);
    } else {
      // Wyślij zaproszenie (jeśli jeszcze nie ma i nie jesteśmy znajomymi)
      if (!targetProfile.friendRequests.includes(user.username) && !targetProfile.friends.includes(user.username)) {
        targetProfile.friendRequests.push(user.username);
      }
    }
    
    saveFriends();
    updateAllRoomStates();
  });

  socket.on('accept-friend-request', ({ targetUsername }) => {
    const user = users[socket.id];
    if (!user || !user.username) return;

    if (!friendsData[targetUsername]) friendsData[targetUsername] = { friends: [], friendRequests: [] };
    if (!friendsData[user.username]) friendsData[user.username] = { friends: [], friendRequests: [] };

    const targetProfile = friendsData[targetUsername];
    const myProfile = friendsData[user.username];
    
    // Usuń z zaproszeń i dodaj do znajomych
    myProfile.friendRequests = myProfile.friendRequests.filter(u => u !== targetUsername);
    if (!myProfile.friends.includes(targetUsername)) myProfile.friends.push(targetUsername);
    if (!targetProfile.friends.includes(user.username)) targetProfile.friends.push(user.username);

    saveFriends();
    updateAllRoomStates();
  });

  socket.on('remove-friend', ({ targetUsername }) => {
    const user = users[socket.id];
    if (!user || !user.username) return;

    if (!friendsData[targetUsername]) friendsData[targetUsername] = { friends: [], friendRequests: [] };
    if (!friendsData[user.username]) friendsData[user.username] = { friends: [], friendRequests: [] };

    const targetProfile = friendsData[targetUsername];
    const myProfile = friendsData[user.username];

    myProfile.friends = myProfile.friends.filter(u => u !== targetUsername);
    targetProfile.friends = targetProfile.friends.filter(u => u !== user.username);
    
    // Możliwość cofnięcia zaproszenia w ten sam sposób
    targetProfile.friendRequests = targetProfile.friendRequests.filter(u => u !== user.username);
    myProfile.friendRequests = myProfile.friendRequests.filter(u => u !== targetUsername);

    saveFriends();
    updateAllRoomStates();
  });

  socket.on('request-room-state', () => {
    updateAllRoomStates();
  });

  socket.on('device-settings:get', ({ deviceId }) => {
    if (!deviceId) return;
    socket.emit('device-settings:update', deviceSettings[deviceId] || {});
  });

  socket.on('device-settings:save', ({ deviceId, settings }) => {
    if (!deviceId || !settings) return;
    deviceSettings[deviceId] = {
      ...(deviceSettings[deviceId] || {}),
      ...settings
    };
    saveDeviceSettings();
    console.log(`[SETTINGS] Zapisano ustawienia dla urządzenia: ${deviceId}`);
  });

  socket.on('ping-server', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('explicit-logout', () => {
    const user = users[socket.id];
    if (user) user.explicitlyLoggedOut = true;
  });

  socket.on('disconnect', () => {
    for (const hash in fileOwners) {
      if (fileOwners[hash]) fileOwners[hash].delete(socket.id);
    }
    
    // BŁĄD PAMIĘCI - brakowało definicji zmiennej user!
    const user = users[socket.id];
    
    if (user && user.username) {
      const waitTime = user.explicitlyLoggedOut ? 1000 : 30000;
      console.log(`[PRESENCE] ${user.username} rozłączony - start Grace Period (${waitTime/1000}s).`);
      
      const timeoutId = setTimeout(() => {
        const stillStreaming = Array.from(io.sockets.sockets.values())
          .some(s => users[s.id]?.username === user.username);
        
        if (!stillStreaming) {
          console.log(`[PRESENCE] ${user.username} zniknął ostatecznie po ${waitTime/1000}s.`);
          if (allSeenUsers[user.username]) {
            allSeenUsers[user.username].status = 'offline';
            // NIE usuwamy voiceRoomId podczas timeoutu - usuniemy dopiero przy całkowitym logoutcie
            // lub jeśli użytkownik połączy się i wyjdzie ręcznie.
            allSeenUsers[user.username].lastSeen = Date.now();
            saveUsers();
          }
        }
        gracePeriodUsers.delete(user.username);
        updateAllRoomStates();
      }, waitTime);

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