const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------- Live-reload (только для разработки/дизайна) ----------
// Запусти сервер командой: npm run dev
// Тогда при сохранении файла в /public браузер сам перезагрузится
// на ВСЕХ подключённых устройствах (комп + телефоны), т.к. они смотрят
// на тот же livereload-сервер (порт 35729) на этом же компе.
const LIVERELOAD_ENABLED = process.env.LIVERELOAD === '1';
if (LIVERELOAD_ENABLED) {
  const livereload = require('livereload');
  const lrServer = livereload.createServer({ exts: ['html', 'css', 'js'] });
  lrServer.watch(path.join(__dirname, 'public'));
  console.log('🔁 Live-reload включён: сохраняй файлы в /public — страницы обновятся сами');
}

// Отдаём HTML-страницы вручную (не из кэша), чтобы:
// 1) при LIVERELOAD=1 вставить скрипт автообновления
// 2) изменения в файле сразу были видны при следующей загрузке страницы
function serveHtmlPage(fileName) {
  return (req, res) => {
    const filePath = path.join(__dirname, 'public', fileName);
    let html = fs.readFileSync(filePath, 'utf8');
    if (LIVERELOAD_ENABLED) {
      // Подключаемся к livereload-серверу по тому же хосту, с которого
      // открыта страница (важно для телефона: нельзя хардкодить localhost)
      const snippet = `<script>document.write('<script src="http://' + location.hostname + ':35729/livereload.js"></scr' + 'ipt>')</script>`;
      html = html.replace('</body>', `${snippet}\n</body>`);
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  };
}

app.get('/', serveHtmlPage('player.html'));
app.get('/adm', serveHtmlPage('admin.html'));

// Статика для остальных файлов (иконки, если добавите и т.п.)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Состояние игры ----------
const ADMIN_PASSWORD = '22333';
let teams = {};       // teamId -> { id, name, connected, wins, sockets }
let roundActive = false;
let roundNumber = 0;
let currentWinner = null; // { teamId, name, time }
let clickLog = [];     // { round, teamId, name, time, isWinner }
let sharedTeamsMode = false;

function publicTeams() {
  return Object.values(teams).map(t => ({
    id: t.id,
    name: t.name,
    connected: t.connected,
    wins: t.wins,
  }));
}

function broadcastAdminState() {
  io.to('admins').emit('admin:state', {
    teams: publicTeams(),
    roundActive,
    roundNumber,
    currentWinner,
    clickLog: clickLog.slice().reverse(), // новые сверху
    sharedTeamsMode,
  });
}

function broadcastRoundStateToPlayers() {
  io.to('players').emit('round:state', {
    roundActive,
    winnerName: currentWinner ? currentWinner.name : null,
  });
}

function broadcastLobbyState() {
  io.emit('lobby:state', {
    sharedTeamsMode,
    teams: publicTeams(),
  });
}

io.on('connection', (socket) => {

  // ---------- Получение начального состояния лобби ----------
  socket.on('player:getInitialState', (cb) => {
    cb && cb({
      sharedTeamsMode,
      teams: publicTeams()
    });
  });

  // ---------- Игрок присоединяется ----------
  socket.on('player:join', (data, cb) => {
    const name = (data && data.name || '').trim().slice(0, 40);
    const teamId = data && data.teamId;

    if (teamId) {
      // Присоединение к существующей команде
      const team = teams[teamId];
      if (!team) { cb && cb({ error: 'Команда не найдена' }); return; }

      socket.data.teamId = teamId;
      if (!team.sockets.includes(socket.id)) {
        team.sockets.push(socket.id);
      }
      team.connected = true;
      socket.join('players');
      socket.join(`team:${teamId}`);

      cb && cb({
        teamId,
        name: team.name,
        roundActive,
        winnerName: currentWinner ? currentWinner.name : null,
      });
      broadcastAdminState();
      broadcastLobbyState();
    } else {
      // Создание новой команды
      if (!name) { cb && cb({ error: 'Введите имя команды' }); return; }

      // Проверка на уникальность имени
      const nameExists = Object.values(teams).some(t => t.name.toLowerCase() === name.toLowerCase());
      if (nameExists) { cb && cb({ error: 'Команда с таким именем уже существует' }); return; }

      const newTeamId = crypto.randomBytes(6).toString('hex');
      teams[newTeamId] = { id: newTeamId, name, connected: true, wins: 0, sockets: [socket.id] };
      socket.data.teamId = newTeamId;
      socket.join('players');
      socket.join(`team:${newTeamId}`);

      cb && cb({
        teamId: newTeamId,
        name,
        roundActive,
        winnerName: currentWinner ? currentWinner.name : null,
      });
      broadcastAdminState();
      broadcastLobbyState();
    }
  });

  // ---------- Игрок переподключается (после обновления страницы) ----------
  socket.on('player:rejoin', (data, cb) => {
    const teamId = data && data.teamId;
    const team = teams[teamId];
    if (!team) { cb && cb({ error: 'not_found' }); return; }

    if (!team.sockets.includes(socket.id)) {
      team.sockets.push(socket.id);
    }
    team.connected = true;
    socket.data.teamId = teamId;
    socket.join('players');
    socket.join(`team:${teamId}`);

    cb && cb({
      teamId,
      name: team.name,
      roundActive,
      winnerName: currentWinner ? currentWinner.name : null,
    });
    broadcastAdminState();
    broadcastLobbyState();
  });

  // ---------- Игрок жмёт кнопку ----------
  socket.on('player:buzz', () => {
    const teamId = socket.data.teamId;
    const team = teams[teamId];
    if (!team) return;
    if (!roundActive) return; // раунд не открыт - клик игнорируем

    const time = Date.now();
    const isWinner = !currentWinner;

    clickLog.push({
      round: roundNumber,
      teamId,
      name: team.name,
      time,
      isWinner,
    });

    if (isWinner) {
      currentWinner = { teamId, name: team.name, time };
      team.wins += 1;
      broadcastRoundStateToPlayers();
    }

    broadcastAdminState();
  });

  // ---------- Админ подключается ----------
  socket.on('admin:join', (data, cb) => {
    const password = String((data && data.password) || '');
    if (password !== ADMIN_PASSWORD) {
      cb && cb({ error: 'Неверный пароль' });
      return;
    }
    socket.data.isAdmin = true;
    socket.join('admins');
    broadcastAdminState();
    cb && cb({ ok: true });
  });

  // ---------- Админ: переключить совместный режим ----------
  socket.on('admin:toggleSharedMode', (data) => {
    if (!socket.data.isAdmin) return;
    sharedTeamsMode = !!(data && data.enabled);
    broadcastAdminState();
    broadcastLobbyState();
  });

  // ---------- Админ: переименовать команду ----------
  socket.on('admin:renameTeam', (data, cb) => {
    if (!socket.data.isAdmin) return;
    const teamId = data && data.teamId;
    const newName = String(data && data.name || '').trim().slice(0, 40);

    if (!teamId || !newName) {
      cb && cb({ error: 'Некорректные данные' });
      return;
    }

    const team = teams[teamId];
    if (!team) {
      cb && cb({ error: 'Команда не найдена' });
      return;
    }

    const nameExists = Object.values(teams).some(t => t.id !== teamId && t.name.toLowerCase() === newName.toLowerCase());
    if (nameExists) {
      cb && cb({ error: 'Команда с таким именем уже существует' });
      return;
    }

    team.name = newName;

    clickLog.forEach(c => {
      if (c.teamId === teamId) {
        c.name = newName;
      }
    });

    if (currentWinner && currentWinner.teamId === teamId) {
      currentWinner.name = newName;
      broadcastRoundStateToPlayers();
    }

    io.to(`team:${teamId}`).emit('player:rename', { name: newName });

    broadcastAdminState();
    broadcastLobbyState();
    cb && cb({ ok: true });
  });

  // ---------- Админ: изменить очки команды ----------
  socket.on('admin:adjustScore', (data) => {
    if (!socket.data.isAdmin) return;
    const teamId = data && data.teamId;
    const change = parseInt(data && data.change);
    if (!teamId || isNaN(change)) return;

    const team = teams[teamId];
    if (!team) return;

    team.wins += change;
    broadcastAdminState();
  });

  // ---------- Админ: рестарт раунда ----------
  socket.on('admin:restart', () => {
    if (!socket.data.isAdmin) return;
    roundNumber += 1;
    roundActive = true;
    currentWinner = null;
    broadcastRoundStateToPlayers();
    broadcastAdminState();
  });

  // ---------- Админ: убрать команду ----------
  socket.on('admin:remove', (data) => {
    if (!socket.data.isAdmin) return;
    const teamId = data && data.teamId;
    const team = teams[teamId];
    if (!team) return;
    io.to(`team:${teamId}`).emit('player:kicked');
    delete teams[teamId];
    broadcastAdminState();
    broadcastLobbyState();
  });

  // ---------- Админ: передать ход команде вручную ----------
  socket.on('admin:passTurn', (data) => {
    if (!socket.data.isAdmin) return;
    if (!roundActive || currentWinner) return;

    const teamId = data && data.teamId;
    const team = teams[teamId];
    if (!team) return;

    const time = Date.now();
    clickLog.push({
      round: roundNumber,
      teamId,
      name: team.name,
      time,
      isWinner: true,
      manual: true,
    });

    currentWinner = { teamId, name: team.name, time };
    team.wins += 1;
    broadcastRoundStateToPlayers();
    broadcastAdminState();
  });

  // ---------- Отключение ----------
  socket.on('disconnect', () => {
    const teamId = socket.data.teamId;
    if (teamId && teams[teamId]) {
      const team = teams[teamId];
      team.sockets = team.sockets.filter(sid => sid !== socket.id);
      if (team.sockets.length === 0) {
        team.connected = false;
      }
      broadcastAdminState();
      broadcastLobbyState();
    }
  });
});

const PORT = process.env.PORT || 3000;

function getLocalIp() {
  const nets = os.networkInterfaces();
  const wifiNames = /wi[- ]?fi|wlan|wireless|беспроводн/i;
  const virtualNames = /virtual|vmware|hyper-v|vethernet|docker|wsl|virtualbox|hamachi|radmin|tailscale|npcap|tap|tun|loopback/i;
  const candidates = [];

  for (const [name, addrs] of Object.entries(nets)) {
    for (const net of addrs) {
      const isIPv4 = net.family === 'IPv4' || net.family === 4;
      if (!isIPv4 || net.internal) continue;
      candidates.push({ name, address: net.address });
    }
  }

  const isPrivateLan = (ip) => {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168 && ip !== '192.168.56.1') return true;
    return false;
  };

  const wifi = candidates.find(c => wifiNames.test(c.name));
  if (wifi) return wifi.address;

  const lanPhysical = candidates.find(c => isPrivateLan(c.address) && !virtualNames.test(c.name));
  if (lanPhysical) return lanPhysical.address;

  const anyLan = candidates.find(c => isPrivateLan(c.address));
  if (anyLan) return anyLan.address;

  return candidates[0]?.address || 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Игрок: http://${ip}:${PORT}/`);
  console.log(`Админ: http://${ip}:${PORT}/adm`);
});
