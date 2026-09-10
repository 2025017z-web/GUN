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

let zombieRooms = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // ---- 1v1 MATCHMAKING ----
  socket.on('join_matchmaking', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    if (waitingPlayer && waitingPlayer.id !== socket.id && waitingPlayer.connected) {
      const roomId = `room_${waitingPlayer.id}_${socket.id}`;
      socket.join(roomId);
      waitingPlayer.join(roomId);

      rooms[roomId] = {
        players: [waitingPlayer.id, socket.id],
        playerDetails: {
          [waitingPlayer.id]: { name: waitingPlayer.playerName, weapon: waitingPlayer.equippedWeapon },
          [socket.id]: { name: socket.playerName, weapon: socket.equippedWeapon }
        },
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

  socket.on('player_died', (data) => {
    const room = rooms[data.roomId];
    if (room && !room.roundEnding) {
      room.roundEnding = true;
      // 死んだソケット以外のプレイヤー（生存者）を勝利判定
      const winnerId = room.players.find(id => id !== socket.id);
      if (winnerId) {
        room.scores[winnerId] = (room.scores[winnerId] || 0) + 1;
      }
      room.round++;

      setTimeout(() => {
        if (rooms[data.roomId]) {
          rooms[data.roomId].roundEnding = false;
        }
      }, 1200);

      io.in(data.roomId).emit('round_complete', {
        winnerId: winnerId,
        scores: room.scores,
        nextRound: room.round,
        playerDetails: room.playerDetails
      });
    }
  });

  socket.on('hp_update', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('opponent_hp_update', {
        id: socket.id,
        hp: data.hp,
        shield: data.shield
      });
    }
  });

  // ---- BR MATCHMAKING ----
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

  // ---- ZOMBIE ONLINE CO-OP ----
  socket.on('create_zombie_room', (data) => {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    const roomId = `zombie_room_${roomCode}`;

    socket.playerName = data.name || 'Host';
    socket.equippedWeapon = data.weapon || 'laser';
    socket.join(roomId);

    zombieRooms[roomCode] = {
      roomId: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon }],
      started: false
    };

    socket.emit('zombie_room_created', {
      roomCode: roomCode,
      roomId: roomId,
      players: zombieRooms[roomCode].players
    });
  });

  socket.on('join_zombie_room', (data) => {
    const roomCode = data.roomCode;
    const room = zombieRooms[roomCode];

    if (!room) {
      socket.emit('zombie_room_error', { message: '部屋が見つかりません！' });
      return;
    }
    if (room.started) {
      socket.emit('zombie_room_error', { message: '既にゲームが開始されています！' });
      return;
    }
    if (room.players.length >= 4) {
      socket.emit('zombie_room_error', { message: '部屋が満員です (最大4人)' });
      return;
    }

    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';
    socket.join(room.roomId);

    room.players.push({ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon });

    io.in(room.roomId).emit('zombie_room_updated', {
      roomCode: roomCode,
      players: room.players,
      hostId: room.hostId
    });
  });

  socket.on('start_zombie_game', (data) => {
    const room = zombieRooms[data.roomCode];
    if (room && room.hostId === socket.id && !room.started) {
      room.started = true;
      // 壁に埋まらない安全なスポーン位置
      const safeSpawns = [
        { x: -6, y: 0, z: -6 },
        { x: 6, y: 0, z: -6 },
        { x: -6, y: 0, z: 6 },
        { x: 6, y: 0, z: 6 }
      ];

      const playerData = room.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        weapon: p.weapon,
        spawnPos: safeSpawns[idx % safeSpawns.length]
      }));

      io.in(room.roomId).emit('zombie_game_started', {
        roomId: room.roomId,
        players: playerData
      });
    }
  });

  socket.on('zombie_sync_spawn', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_spawned_remote', data);
    }
  });

  // ---- COMMON GAME EVENTS ----
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

  socket.on('leave_room', (data) => {
    if (data && data.roomId) {
      socket.leave(data.roomId);
      if (rooms[data.roomId]) delete rooms[data.roomId];
    }
  });

  socket.on('cancel_matchmaking', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    brQueue = brQueue.filter(p => p.id !== socket.id);
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    brQueue = brQueue.filter(p => p.id !== socket.id);

    for (const roomId in rooms) {
      if (rooms[roomId].players.includes(socket.id)) {
        socket.to(roomId).emit('opponent_disconnected');
        delete rooms[roomId];
      }
    }

    for (const code in zombieRooms) {
      const room = zombieRooms[code];
      const pIndex = room.players.findIndex(p => p.id === socket.id);
      if (pIndex !== -1) {
        room.players.splice(pIndex, 1);
        if (room.players.length === 0) {
          delete zombieRooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          io.in(room.roomId).emit('zombie_room_updated', {
            roomCode: code,
            players: room.players,
            hostId: room.hostId
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
