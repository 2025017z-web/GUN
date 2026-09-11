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

  // --- 1v1 Matchmaking ---
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

  socket.on('cancel_matchmaking', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    brQueue = brQueue.filter(p => p.id !== socket.id);
  });

  // --- BR Matchmaking ---
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

    io.to(roomId).emit('br_match_start', matchData);
  }

  // --- Zombie Online Mode ---
  socket.on('create_zombie_room', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    const roomId = 'ZMB-' + Math.floor(1000 + Math.random() * 9000);
    socket.join(roomId);

    zombieRooms[roomId] = {
      hostId: socket.id,
      players: [{ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon }],
      started: false
    };

    socket.emit('zombie_room_created', {
      roomId: roomId,
      players: zombieRooms[roomId].players
    });
  });

  socket.on('join_zombie_room', (data) => {
    const roomId = (data.roomId || '').toUpperCase().trim();
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    if (zombieRooms[roomId] && !zombieRooms[roomId].started) {
      socket.join(roomId);
      zombieRooms[roomId].players.push({ id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon });

      socket.emit('zombie_room_joined', {
        roomId: roomId,
        players: zombieRooms[roomId].players,
        hostId: zombieRooms[roomId].hostId
      });

      io.to(roomId).emit('zombie_room_updated', {
        players: zombieRooms[roomId].players
      });
    } else {
      socket.emit('zombie_room_error', { message: '部屋が存在しないか、既に開始されています。' });
    }
  });

  socket.on('start_zombie_online_game', (data) => {
    const roomId = data.roomId;
    if (zombieRooms[roomId] && zombieRooms[roomId].hostId === socket.id) {
      zombieRooms[roomId].started = true;
      io.to(roomId).emit('zombie_online_start', {
        players: zombieRooms[roomId].players,
        hostId: zombieRooms[roomId].hostId
      });
    }
  });

  // --- Game Sync Events ---
  socket.on('player_update', (data) => {
    socket.to(data.roomId).emit('opponent_update', data);
  });

  socket.on('player_shoot', (data) => {
    socket.to(data.roomId).emit('opponent_shoot', data);
  });

  socket.on('player_hit', (data) => {
    socket.to(data.roomId).emit('take_damage', { dmg: data.dmg });
  });

  socket.on('round_win', (data) => {
    const room = rooms[data.roomId];
    if (room && !room.roundEnding) {
      room.roundEnding = true;
      room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
      room.round++;

      setTimeout(() => {
        room.roundEnding = false;
        io.to(data.roomId).emit('round_complete', {
          winnerId: socket.id,
          scores: room.scores,
          nextRound: room.round
        });
      }, 1000);
    }
  });

  socket.on('building_damage', (data) => {
    socket.to(data.roomId).emit('building_damaged', data);
  });

  socket.on('chest_open', (data) => {
    socket.to(data.roomId).emit('chest_opened', data);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    brQueue = brQueue.filter(p => p.id !== socket.id);

    for (let rId in zombieRooms) {
      let zRoom = zombieRooms[rId];
      zRoom.players = zRoom.players.filter(p => p.id !== socket.id);
      if (zRoom.players.length === 0) {
        delete zombieRooms[rId];
      } else {
        if (zRoom.hostId === socket.id) {
          zRoom.hostId = zRoom.players[0].id;
        }
        io.to(rId).emit('zombie_room_updated', { players: zRoom.players, hostId: zRoom.hostId });
      }
    }

    for (let rId in rooms) {
      if (rooms[rId].players.includes(socket.id)) {
        socket.to(rId).emit('opponent_disconnected');
        delete rooms[rId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
