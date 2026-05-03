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

// --- SZYFROWANIE TOKENÓW UŻYTKOWNIKÓW ---
const SERVER_SECRET_KEY = process.env.SERVER_SECRET_KEY || 'pear-default-secret-key-change-it-in-production';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(SERVER_SECRET_KEY).digest();
const IV_LENGTH = 16;

function encryptToken(text) {
  if (!text) return text;
  // Jeśli już jest zaszyfrowane (ma dwukropek po 32 znakach hex IV), nie szyfruj podwójnie
  if (text.length > 33 && text.charAt(32) === ':') return text;
  try {
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error("Encryption error:", e.message);
    return null;
  }
}

function decryptToken(text) {
  if (!text) return text;
  if (text.indexOf(':') === -1) return text; // Zgodność wsteczna z nieszyfrowanymi tokenami
  try {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    console.error("Decryption error:", e.message);
    return null; // Zwracamy null gdy odszyfrowanie się nie powiedzie
  }
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
if (GOOGLE_REFRESH_TOKEN) {
  googleClient.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}

const drive = google.drive({ version: 'v3', auth: googleClient });

// --- DIAGNOSTYKA STARTOWA DLA RENDERA ---
console.log('--- [DEBUG-GOOGLE] Rozpoczynam sprawdzanie kluczy ---');
console.log('CLIENT_ID:', GOOGLE_CLIENT_ID ? 'DOSTĘPNY' : '❌ BRAK');
if (GOOGLE_CLIENT_SECRET) {
  console.log('CLIENT_SECRET: DOSTĘPNY (Długość: ' + GOOGLE_CLIENT_SECRET.length + ')');
} else {
  console.log('CLIENT_SECRET: ❌ BRAK! (Google API nie będzie mogło odświeżyć tokena)');
}
if (GOOGLE_REFRESH_TOKEN) {
  console.log('REFRESH_TOKEN: DOSTĘPNY (Długość: ' + GOOGLE_REFRESH_TOKEN.length + ')');
} else {
  console.log('REFRESH_TOKEN: ❌ BRAK!');
}
console.log('--- [DEBUG-GOOGLE] Koniec sprawdzania ---');
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

async function ensureTargetFolder(driveClient, type, subName) {
  try {
    const qRoot = "name='pear_cloud' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    let rootRes = await driveClient.files.list({ q: qRoot, fields: 'files(id)' });
    let rootId = rootRes.data.files?.[0]?.id;
    if (!rootId) {
      const cRoot = await driveClient.files.create({ requestBody: { name: 'pear_cloud', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
      rootId = cRoot.data.id;
    }

    const qFiles = `name='files' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let filesRes = await driveClient.files.list({ q: qFiles, fields: 'files(id)' });
    let filesId = filesRes.data.files?.[0]?.id;
    if (!filesId) {
      const cFiles = await driveClient.files.create({ requestBody: { name: 'files', parents: [rootId], mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
      filesId = cFiles.data.id;
    }

    if (type === 'main') return filesId;

    const targetName = type === 'friend' ? `friend_${subName}` : `guild_${subName}`;
    const qSub = `name='${targetName}' and '${filesId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let subRes = await driveClient.files.list({ q: qSub, fields: 'files(id)' });
    let subId = subRes.data.files?.[0]?.id;
    if (!subId) {
      const cSub = await driveClient.files.create({ requestBody: { name: targetName, parents: [filesId], mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
      subId = cSub.data.id;
    }
    return subId;
  } catch (e) {
    console.error("Błąd tworzenia struktury chmury:", e.message);
    return null;
  }
}

 // --- LOGIKA SYNCHRONIZACJI Z DRIVE (/pear/server) ---
async function ensureServerFolder(retryCount = 3) {
  if (!GOOGLE_REFRESH_TOKEN) return null;
  
  for (let attempt = 1; attempt <= retryCount; attempt++) {
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
      console.error(`⚠️ [Próba ${attempt}/${retryCount}] Błąd folderów Drive:`, e.message);
      if (attempt < retryCount) {
        const delay = attempt * 2000;
        console.log(`Zasypiam na ${delay}ms przed kolejną próbą...`);
        await new Promise(res => setTimeout(res, delay));
      } else {
        console.error("❌ Osiągnięto limit prób połączenia z Drive API.");
        return null;
      }
    }
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

    // --- JEDNORAZOWA MIGRACJA KARTY VIPLUKA ---
    const OLD_NAME = 'vipluk VL';
    const NEW_NAME = 'vipluk';
    let needsCloudSync = false;

    if (allSeenUsers[NEW_NAME] && allSeenUsers[OLD_NAME]) {
        console.log(`[MIGRATE] Znaleziono kolizję użytkownika '${NEW_NAME}'. Puste konto zostanie nadpisane zmigrowanym.`);
        allSeenUsers[OLD_NAME].sessionToken = allSeenUsers[NEW_NAME].sessionToken;
        allSeenUsers[OLD_NAME].accessToken = allSeenUsers[NEW_NAME].accessToken;
        allSeenUsers[OLD_NAME].refreshToken = allSeenUsers[NEW_NAME].refreshToken || allSeenUsers[OLD_NAME].refreshToken;
        delete allSeenUsers[NEW_NAME];
    }

    if (allSeenUsers[OLD_NAME]) {
      const userData = allSeenUsers[OLD_NAME];
      userData.username = NEW_NAME;
      userData.nickname = NEW_NAME;
      allSeenUsers[NEW_NAME] = userData;
      delete allSeenUsers[OLD_NAME];
      console.log(`[MIGRATE] Zmigrowano użytkownika ${OLD_NAME} -> ${NEW_NAME}`);
      needsCloudSync = true;
    }

    for (const guildId in guilds) {
      const guild = guilds[guildId];
      if (guild.owner === OLD_NAME) { guild.owner = NEW_NAME; needsCloudSync = true; }
      if (guild.members && guild.members.includes(OLD_NAME)) {
        guild.members = guild.members.map(m => m === OLD_NAME ? NEW_NAME : m);
        guild.members = [...new Set(guild.members)];
        needsCloudSync = true;
      }
      if (guild.memberMetadata && guild.memberMetadata[OLD_NAME]) {
        guild.memberMetadata[NEW_NAME] = guild.memberMetadata[OLD_NAME];
        delete guild.memberMetadata[OLD_NAME];
        needsCloudSync = true;
      }
    }

    for (const userId in friendsData) {
      const profile = friendsData[userId];
      if (profile.friends && profile.friends.includes(OLD_NAME)) {
        profile.friends = profile.friends.map(f => f === OLD_NAME ? NEW_NAME : f);
        profile.friends = [...new Set(profile.friends)];
        needsCloudSync = true;
      }
      if (profile.friendRequests && profile.friendRequests.includes(OLD_NAME)) {
        profile.friendRequests = profile.friendRequests.map(r => r === OLD_NAME ? NEW_NAME : r);
        profile.friendRequests = [...new Set(profile.friendRequests)];
        needsCloudSync = true;
      }
    }
    if (friendsData[OLD_NAME]) {
      friendsData[NEW_NAME] = friendsData[OLD_NAME];
      delete friendsData[OLD_NAME];
      needsCloudSync = true;
    }

    let msgChanged = false;
    for (const msg of messageBuffer) {
      if (msg.author === OLD_NAME) { msg.author = NEW_NAME; msgChanged = true; needsCloudSync = true; }
    }
    let dmChanged = false;
    for (const msg of dmMessageBuffer) {
      if (msg.author === OLD_NAME) { msg.author = NEW_NAME; dmChanged = true; needsCloudSync = true; }
    }

    if (needsCloudSync) {
      console.log(`[MIGRATE] Zapisywanie zmigrowanych danych i wysyłanie do chmury Drive...`);
      saveUsers();
      saveGuilds();
      saveFriends();
      if (msgChanged) saveHistory();
      if (dmChanged) saveDmHistory();
    }
    // --- KONIEC MIGRACJI ---

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
        customText: allSeenUsers[username].customText,
        registeredAt: allSeenUsers[username].registeredAt || Date.now(),
        cloudConfig: allSeenUsers[username].cloudConfig || { sharedWith: {}, sharedGuilds: {} }
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
        lastSeen: Date.now(),
        cloudConfig: allSeenUsers[u.username]?.cloudConfig || { sharedWith: {}, sharedGuilds: {} }
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
      const googleId = payload.sub; // Stałe, niezmienne ID z Google

      // Znajdź użytkownika po googleId lub (legacy) po nazwie
      let internalUsername = payload.name;
      const existingByGoogleId = Object.values(allSeenUsers).find(u => u.googleId === googleId);
      
      if (existingByGoogleId) {
        internalUsername = existingByGoogleId.username;
        console.log(`[AUTH] Użytkownik powrócił! Znaleziono po googleId. Wewnętrzne ID: ${internalUsername}, Nowa nazwa w Google: ${payload.name}`);
      } else if (allSeenUsers[payload.name]) {
        // Fallback dla starych kont przed dodaniem googleId
        internalUsername = payload.name;
      }

      let existing = allSeenUsers[internalUsername] || {};
      allSeenUsers[internalUsername] = {
        ...existing,
        username: internalUsername, // stałe ID
        googleId: googleId, // Zapisujemy na przyszłość
        avatar: payload.picture,
        status: status || existing.status || 'online',
        customText: customText !== undefined ? customText : (existing.customText || ''),
        nickname: payload.name, // Aktualizujemy wyświetlaną nazwę do obecnej z Google!
        registeredAt: existing.registeredAt || Date.now(),
        lastSeen: Date.now(),
        sessionToken,
        refreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token) : (existing.refreshToken || null),
        accessToken: tokens.access_token
      };
      saveUsers();

      users[socket.id].username = internalUsername;
      users[socket.id].avatar = payload.picture;
      users[socket.id].status = allSeenUsers[internalUsername].status;
      users[socket.id].customText = allSeenUsers[internalUsername].customText;

      socket.join(roomId || "Ogólny");
      users[socket.id].rooms.add(roomId || "Ogólny");

      console.log(`[AUTH] Emituję login-success dla ${internalUsername}: Nick=${allSeenUsers[internalUsername].nickname}`);
      socket.emit('login-success', {
        username: internalUsername,
        avatar: payload.picture,
        nickname: allSeenUsers[internalUsername].nickname || internalUsername,
        registeredAt: allSeenUsers[internalUsername].registeredAt || Date.now(),
        status: users[socket.id].status,
        customText: users[socket.id].customText,
        sessionToken,
        accessToken: tokens.access_token,
        settings: allSeenUsers[internalUsername].settings || {},
        cloudConfig: allSeenUsers[internalUsername].cloudConfig || { sharedWith: {}, sharedGuilds: {} }
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
      const googleId = payload.sub; // Stałe, niezmienne ID z Google
      console.log(`[LOGIN] Sukces: ${payload.name} (${payload.email}) [googleId: ${googleId}]`);

      // Znajdź użytkownika po googleId lub (legacy) po nazwie
      let internalUsername = payload.name;
      const existingByGoogleId = Object.values(allSeenUsers).find(u => u.googleId === googleId);
      
      if (existingByGoogleId) {
        internalUsername = existingByGoogleId.username;
        console.log(`[LOGIN] Użytkownik powrócił! Wewnętrzne ID: ${internalUsername}, Nowa nazwa: ${payload.name}`);
      } else if (allSeenUsers[payload.name]) {
        internalUsername = payload.name;
      }

      users[socket.id].username = internalUsername;
      users[socket.id].avatar = payload.picture;
      users[socket.id].status = status || 'online';
      if (customText) users[socket.id].customText = customText.substring(0, 32);

      const sessionToken = crypto.randomUUID();
      let existing = allSeenUsers[internalUsername] || {};
      allSeenUsers[internalUsername] = {
        ...existing,
        username: internalUsername,
        googleId: googleId, // Zapisujemy na przyszłość
        avatar: payload.picture,
        nickname: payload.name, // Aktualizujemy wyświetlaną nazwę
        registeredAt: existing.registeredAt || Date.now(),
        status: status || existing.status || 'online',
        customText: customText !== undefined ? customText : (existing.customText || ''),
        lastSeen: Date.now(),
        sessionToken: sessionToken,
        accessToken: existing.accessToken || undefined,
        refreshToken: existing.refreshToken || undefined
      };
      saveUsers();

      socket.join(roomId);
      users[socket.id].rooms.add(roomId);

      console.log(`[LOGIN] Emituję login-success dla ${internalUsername}: Nick=${allSeenUsers[internalUsername].nickname}`);
      socket.emit('login-success', {
        username: internalUsername,
        avatar: payload.picture,
        nickname: allSeenUsers[internalUsername].nickname || internalUsername,
        registeredAt: allSeenUsers[internalUsername].registeredAt || Date.now(),
        status: users[socket.id].status,
        customText: users[socket.id].customText,
        sessionToken: sessionToken,
        settings: allSeenUsers[internalUsername].settings || {},
        cloudConfig: allSeenUsers[internalUsername].cloudConfig || { sharedWith: {}, sharedGuilds: {} }
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
        voiceRoomId: voiceRoom || null,
        settings: foundUser.settings || {},
        cloudConfig: foundUser.cloudConfig || { sharedWith: {}, sharedGuilds: {} }
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
      const decToken = decryptToken(profile.refreshToken);
      if (!decToken) throw new Error("Błąd deszyfrowania tokenu");
      client.setCredentials({ refresh_token: decToken });
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

  // --- OBSŁUGA CHMURY (SOFT QUOTA & UPLOAD) ---
  socket.on('update-cloud-config', ({ cloudConfig }) => {
    const user = users[socket.id];
    if (user && user.username && allSeenUsers[user.username]) {
      allSeenUsers[user.username].cloudConfig = cloudConfig;
      saveUsers();
    }
  });

  socket.on('request-upload-url', async ({ targetCloud, fileMetadata }, callback) => {
    const user = users[socket.id];
    if (!user || !user.username) return callback({ error: "Brak autoryzacji" });
    const uploaderUsername = user.username;
    
    let ownerUsername = uploaderUsername;
    let targetFolderType = 'main';
    let subfolderName = null;

    if (targetCloud.type === 'personal') {
      ownerUsername = targetCloud.id; // nazwa użytkownika, do którego wgrywamy
      const config = allSeenUsers[ownerUsername]?.cloudConfig?.sharedWith?.[uploaderUsername];
      if (!config || config.enabled === false) return callback({ error: "Brak udostępnionej chmury" });
      if (config.usedBytes + fileMetadata.size > config.quotaBytes) return callback({ error: "Przekroczono limit GB w chmurze znajomego" });
      targetFolderType = 'friend';
      subfolderName = allSeenUsers[uploaderUsername]?.googleId || uploaderUsername; 
    } else if (targetCloud.type === 'guild') {
      const guild = guilds[targetCloud.id];
      if (!guild) return callback({ error: "Gildia nie istnieje" });
      ownerUsername = guild.owner;
      const config = allSeenUsers[ownerUsername]?.cloudConfig?.sharedGuilds?.[targetCloud.id];
      if (!config || config.enabled === false) return callback({ error: "Brak udostępnionej chmury dla gildii" });
      if (config.usedBytes + fileMetadata.size > config.quotaBytes) return callback({ error: "Przekroczono limit GB w chmurze gildii" });
      targetFolderType = 'guild';
      subfolderName = targetCloud.id;
    }

    const profile = allSeenUsers[ownerUsername];
    if (!profile || !profile.refreshToken) return callback({ error: "Właściciel chmury nie ma podpiętego Dysku Google" });

    try {
      const decToken = decryptToken(profile.refreshToken);
      if (!decToken) return callback({ error: "Błąd odszyfrowania tokenu" });
      
      const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
      client.setCredentials({ refresh_token: decToken });
      const targetDrive = google.drive({ version: 'v3', auth: client });

      // 1. Struktura folderów
      let folderId = await ensureTargetFolder(targetDrive, targetFolderType, subfolderName);
      if (!folderId) return callback({ error: "Nie udało się utworzyć struktury folderów" });

      // 2. Pobranie linku resumable
      const tokenRes = await client.getAccessToken();
      const accessToken = tokenRes.token;

      const origin = socket.handshake.headers.origin || "http://localhost:1420";

      const uploadInitRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': fileMetadata.mimeType || 'application/octet-stream',
          'X-Upload-Content-Length': fileMetadata.size.toString(),
          'Origin': origin
        },
        body: JSON.stringify({
          name: fileMetadata.name,
          parents: [folderId]
        })
      });

      if (!uploadInitRes.ok) throw new Error("Google Drive API Error: " + await uploadInitRes.text());
      const uploadUrl = uploadInitRes.headers.get('Location');
      
      // 3. Aktualizacja "Soft Quota"
      if (targetCloud.type === 'personal') {
         allSeenUsers[ownerUsername].cloudConfig.sharedWith[uploaderUsername].usedBytes += fileMetadata.size;
      } else if (targetCloud.type === 'guild') {
         allSeenUsers[ownerUsername].cloudConfig.sharedGuilds[targetCloud.id].usedBytes += fileMetadata.size;
      }
      saveUsers();

      callback({ uploadUrl, targetFolderId: folderId, ownerAccessToken: accessToken });
    } catch (e) {
      console.error("[CLOUD UPLOAD] Błąd przygotowania linku:", e);
      callback({ error: "Nie udało się przygotować sesji wysyłania do chmury." });
    }
  });

  socket.on('make-file-public', async (payload, callback) => {
    try {
      const targetCloud = payload.targetCloud;
      let ownerUsername = targetCloud.id;

      if (targetCloud.type === 'guild') {
        ownerUsername = guilds[targetCloud.id]?.owner;
      }
      if (!ownerUsername) return callback && callback({ error: "Nie znaleziono właściciela." });

      let user = allSeenUsers[ownerUsername];
      if (!user || !user.cloudConfig) return callback && callback({ error: "Brak konfiguracji chmury." });

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        "http://localhost:1420"
      );
      oauth2Client.setCredentials({ refresh_token: user.cloudConfig.refreshToken });
      const tokenRes = await oauth2Client.getAccessToken();

      await fetch(`https://www.googleapis.com/drive/v3/files/${payload.fileId}/permissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenRes.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
      
      if (callback) callback({ success: true });
    } catch(e) {
      console.error("Błąd ustawiania uprawnień na serwerze:", e);
      if (callback) callback({ error: "Błąd serwera" });
    }
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