const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

let waitingPlayer = null;
let rooms = {};
let zombieRooms = {};

let brQueue = [];
let brMatchTimer = null;

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // --- 1v1 オンライン ---
  socket.on('join_matchmaking', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      const roomId = `room_${waitingPlayer.id}_${socket.id}`;
      socket.join(roomId);
      waitingPlayer.join(roomId);

      rooms[roomId] = {
        players: [waitingPlayer.id, socket.id],
        scores: { [waitingPlayer.id]: 0, [socket.id]: 0 },
        round: 1,
        roundEnding: false
      };

      waitingPlayer.emit('match_found', {
        roomId: roomId,
        role: 'player1',
        opponentName: socket.playerName,
        opponentWeapon: socket.equippedWeapon,
        startPos: { x: 0, y: 0, z: 30 }
      });

      socket.emit('match_found', {
        roomId: roomId,
        role: 'player2',
        opponentName: waitingPlayer.playerName,
        opponentWeapon: waitingPlayer.equippedWeapon,
        startPos: { x: 0, y: 0, z: -30 }
      });

      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_opponent');
    }
  });

  // --- BR オンライン ---
  socket.on('join_br_matchmaking', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    if (!brQueue.some(p => p.id === socket.id)) {
      brQueue.push(socket);
    }

    if (brQueue.length === 1 && !brMatchTimer) {
      brMatchTimer = setTimeout(() => {
        startBRMatch();
      }, 4000);
    }

    if (brQueue.length >= 8) {
      if (brMatchTimer) { clearTimeout(brMatchTimer); brMatchTimer = null; }
      startBRMatch();
    }
  });

  function startBRMatch() {
    if (brMatchTimer) {
      clearTimeout(brMatchTimer);
      brMatchTimer = null;
    }

    if (brQueue.length === 0) return;

    const roomId = `br_room_${Date.now()}`;
    const humanPlayers = brQueue.splice(0, 8);
    const humanCount = humanPlayers.length;
    const botCount = 8 - humanCount;

    const spawnPoints = [
      { x: -220, y: 120, z: -220 }, { x: 220, y: 120, z: -220 },
      { x: -220, y: 120, z: 220 },  { x: 220, y: 120, z: 220 },
      { x: 0, y: 120, z: -280 },    { x: 0, y: 120, z: 280 },
      { x: -280, y: 120, z: 0 },     { x: 280, y: 120, z: 0 }
    ];

    spawnPoints.sort(() => Math.random() - 0.5);

    const matchData = {
      roomId: roomId,
      players: [],
      bots: []
    };

    humanPlayers.forEach((s, idx) => {
      s.join(roomId);
      matchData.players.push({
        id: s.id,
        name: s.playerName,
        weapon: s.equippedWeapon,
        startPos: spawnPoints[idx]
      });
    });

    for (let i = 0; i < botCount; i++) {
      matchData.bots.push({
        id: `bot_${i+1}`,
        name: `BOT_${Math.floor(1000 + Math.random() * 9000)}`,
        startPos: spawnPoints[humanCount + i]
      });
    }

    rooms[roomId] = { players: humanPlayers.map(p => p.id), active: true };

    io.in(roomId).emit('br_match_start', matchData);
  }

  // --- ゾンビモード オンライン処理 ---
  socket.on('create_zombie_room', (data) => {
    const roomId = 'Z-' + Math.floor(1000 + Math.random() * 9000);
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';
    socket.join(roomId);

    zombieRooms[roomId] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon }],
      started: false
    };

    socket.emit('zombie_room_created', { roomId: roomId, isHost: true, players: zombieRooms[roomId].players });
  });

  socket.on('join_zombie_room', (data) => {
    const roomId = data.roomId ? data.roomId.toUpperCase().trim() : '';
    const room = zombieRooms[roomId];
    if (room && !room.started) {
      socket.playerName = data.name || 'Player';
      socket.equippedWeapon = data.weapon || 'laser';
      socket.join(roomId);

      room.players.push({ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon });

      socket.emit('zombie_room_joined', { roomId: roomId, isHost: false, players: room.players });
      io.in(roomId).emit('zombie_player_joined', { players: room.players });
    } else {
      socket.emit('zombie_room_error', { message: '部屋が見つからないか、すでにゲームが開始されています。' });
    }
  });

  socket.on('start_zombie_game', (data) => {
    const room = zombieRooms[data.roomId];
    if (room && room.hostId === socket.id) {
      room.started = true;
      io.in(data.roomId).emit('zombie_game_start', { players: room.players });
    }
  });

  socket.on('zombie_player_update', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_opponent_update', data);
    }
  });

  socket.on('zombie_spawn_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_spawned', data.zombie);
    }
  });

  socket.on('zombie_positions_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_positions_update', data.zombies);
    }
  });

  socket.on('zombie_hit', (data) => {
    if (data.roomId) {
      io.in(data.roomId).emit('zombie_damaged', data);
    }
  });

  socket.on('zombie_wave_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_wave_start_sync', data);
    }
  });

  // 汎用通信
  socket.on('player_update', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('opponent_update', data);
    }
  });

  socket.on('player_shoot', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('opponent_shoot', data);
    }
  });

  socket.on('player_hit', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('take_damage', data);
    }
  });

  socket.on('building_damage', (data) => {
    if (data.roomId) {
      io.in(data.roomId).emit('building_damaged', data);
    }
  });

  socket.on('chest_open', (data) => {
    if (data.roomId) {
      io.in(data.roomId).emit('chest_opened', data);
    }
  });

  socket.on('round_win', (data) => {
    const room = rooms[data.roomId];
    if (room && !room.roundEnding) {
      room.roundEnding = true;
      room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
      
      io.in(data.roomId).emit('round_complete', {
        winnerId: socket.id,
        nextRound: room.round + 1
      });
      room.round++;
      setTimeout(() => { room.roundEnding = false; }, 2000);
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    brQueue = brQueue.filter(p => p.id !== socket.id);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    brQueue = brQueue.filter(p => p.id !== socket.id);
    
    for (let rId in zombieRooms) {
      let r = zombieRooms[rId];
      r.players = r.players.filter(p => p.id !== socket.id);
      if (r.players.length === 0) {
        delete zombieRooms[rId];
      } else if (r.hostId === socket.id) {
        r.hostId = r.players[0].id;
      }
    }
    
    io.emit('opponent_disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
