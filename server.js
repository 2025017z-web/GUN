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

let brQueue = [];
let brMatchTimer = null;

// ゾンビマルチプレイ用部屋管理
let zombieRooms = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // --- 1v1 DUEL MATCHMAKING ---
  socket.on('join_matchmaking', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = 'laser'; // 1v1は強制初期レーザー

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
        opponentWeapon: 'laser',
        startPos: { x: 0, y: 0, z: 30 }
      });

      socket.emit('match_found', {
        roomId: roomId,
        role: 'player2',
        opponentName: waitingPlayer.playerName,
        opponentWeapon: 'laser',
        startPos: { x: 0, y: 0, z: -30 }
      });

      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waiting_for_opponent');
    }
  });

  // --- BATTLE ROYALE MATCHMAKING ---
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
    brMatchTimer = null;
  }

  // --- ZOMBIE CO-OP MULTIPLAYER ROOMS ---
  socket.on('get_zombie_rooms', () => {
    let list = [];
    for (let rId in zombieRooms) {
      let r = zombieRooms[rId];
      if (r.status === 'WAITING' && r.players.length < 4) {
        list.push({ id: r.id, name: r.name, hostName: r.hostName, playerCount: r.players.length });
      }
    }
    socket.emit('zombie_rooms_list', list);
  });

  socket.on('create_zombie_room', (data) => {
    let roomId = `zb_room_${Date.now()}`;
    socket.playerName = data.playerName || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';
    
    zombieRooms[roomId] = {
      id: roomId,
      name: data.roomName || `${socket.playerName}'s Room`,
      hostId: socket.id,
      hostName: socket.playerName,
      status: 'WAITING',
      players: [{ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon, hp: 100, maxHp: 100, shield: 100, isReady: true }]
    };

    socket.join(roomId);
    socket.currentZombieRoom = roomId;

    socket.emit('zombie_room_joined', { roomId: roomId, room: zombieRooms[roomId], isHost: true });
    io.emit('zombie_rooms_updated');
  });

  socket.on('join_zombie_room', (data) => {
    let roomId = data.roomId;
    let room = zombieRooms[roomId];

    if (room && room.status === 'WAITING' && room.players.length < 4) {
      socket.playerName = data.playerName || 'Player';
      socket.equippedWeapon = data.weapon || 'laser';

      room.players.push({
        id: socket.id,
        name: socket.playerName,
        weapon: socket.equippedWeapon,
        hp: 100, maxHp: 100, shield: 100,
        isReady: true
      });

      socket.join(roomId);
      socket.currentZombieRoom = roomId;

      socket.emit('zombie_room_joined', { roomId: roomId, room: room, isHost: false });
      io.in(roomId).emit('zombie_room_update', room);
      io.emit('zombie_rooms_updated');
    } else {
      socket.emit('zombie_room_error', '部屋に参加できません（満員または開始済みです）。');
    }
  });

  socket.on('leave_zombie_room', () => {
    leaveZombieRoom(socket);
  });

  function leaveZombieRoom(s) {
    let roomId = s.currentZombieRoom;
    if (roomId && zombieRooms[roomId]) {
      let room = zombieRooms[roomId];
      room.players = room.players.filter(p => p.id !== s.id);
      s.leave(roomId);
      s.currentZombieRoom = null;

      if (room.players.length === 0) {
        delete zombieRooms[roomId];
      } else {
        if (room.hostId === s.id) {
          room.hostId = room.players[0].id;
          room.hostName = room.players[0].name;
          io.to(room.hostId).emit('zombie_became_host');
        }
        io.in(roomId).emit('zombie_room_update', room);
      }
      io.emit('zombie_rooms_updated');
    }
  }

  socket.on('start_zombie_multi_game', (data) => {
    let roomId = data.roomId;
    let room = zombieRooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'PLAYING';
      
      const spawnOffsets = [
        { x: 0, y: 0, z: 15 },
        { x: -5, y: 0, z: 18 },
        { x: 5, y: 0, z: 18 },
        { x: 0, y: 0, z: 22 }
      ];

      room.players.forEach((p, idx) => {
        p.startPos = spawnOffsets[idx % spawnOffsets.length];
      });

      io.in(roomId).emit('zombie_multi_start', room);
    }
  });

  // --- ZOMBIE IN-GAME SYNC ---
  socket.on('zombie_player_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_remote_player_update', data);
    }
  });

  socket.on('zombie_player_shoot_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_remote_player_shoot', data);
    }
  });

  socket.on('zombie_host_state_sync', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_client_state_update', data);
    }
  });

  socket.on('zombie_hit_server', (data) => {
    if (data.roomId) {
      io.in(data.roomId).emit('zombie_take_damage', data);
    }
  });

  socket.on('zombie_wave_change', (data) => {
    if (data.roomId) {
      io.in(data.roomId).emit('zombie_new_wave', data);
    }
  });

  // --- GENERAL MATCH EVENTS ---
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
      room.round++;
      
      io.in(data.roomId).emit('round_complete', {
        winnerId: socket.id,
        scores: room.scores,
        nextRound: room.round
      });
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    brQueue = brQueue.filter(p => p.id !== socket.id);
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    brQueue = brQueue.filter(p => p.id !== socket.id);
    leaveZombieRoom(socket);

    for (const roomId in rooms) {
      if (rooms[roomId].players && rooms[roomId].players.includes(socket.id)) {
        socket.to(roomId).emit('opponent_disconnected');
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
