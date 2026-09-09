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

// ゾンビモードオンライン用ルーム管理
let zombieRooms = {};

function generateRoomId() {
  return 'ZMB_' + Math.floor(1000 + Math.random() * 9000);
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // ===== 1v1 MATCHMAKING =====
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

  // 1v1での死亡通知ハンドラ（死亡したプレイヤーからの送信）
  socket.on('player_died', (data) => {
    const room = rooms[data.roomId];
    if (room && !room.roundEnding) {
      room.roundEnding = true;
      // 生き残った側（相手）にスコアを加算
      const winnerId = room.players.find(id => id !== socket.id);
      if (winnerId) {
        room.scores[winnerId] = (room.scores[winnerId] || 0) + 1;
      }
      room.round++;
      
      io.in(data.roomId).emit('round_complete', {
        winnerId: winnerId,
        scores: room.scores,
        nextRound: room.round
      });

      setTimeout(() => {
        if (rooms[data.roomId]) {
          rooms[data.roomId].roundEnding = false;
        }
      }, 1500);
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

      setTimeout(() => {
        if (rooms[data.roomId]) {
          rooms[data.roomId].roundEnding = false;
        }
      }, 1500);
    }
  });

  // ===== BR MATCHMAKING =====
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

  // ===== リアルタイム同期通信 =====
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

  // ===== ゾンビモード オンラインルーム =====
  socket.on('create_zombie_room', (data) => {
    const roomId = generateRoomId();
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';
    socket.join(roomId);

    zombieRooms[roomId] = {
      id: roomId,
      hostId: socket.id,
      started: false,
      players: [
        { id: socket.id, name: socket.playerName, weapon: socket.equippedWeapon, isHost: true }
      ]
    };

    socket.emit('zombie_room_created', {
      roomId: roomId,
      isHost: true,
      players: zombieRooms[roomId].players
    });
  });

  socket.on('join_zombie_room', (data) => {
    const roomId = (data.roomId || '').trim().toUpperCase();
    const room = zombieRooms[roomId];

    if (!room) {
      socket.emit('zombie_room_error', { message: '部屋が見つかりません。' });
      return;
    }
    if (room.started) {
      socket.emit('zombie_room_error', { message: 'この部屋のゲームは既に開始されています。' });
      return;
    }
    if (room.players.length >= 4) {
      socket.emit('zombie_room_error', { message: '部屋が満員です。(最大4人)' });
      return;
    }

    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';
    socket.join(roomId);

    room.players.push({
      id: socket.id,
      name: socket.playerName,
      weapon: socket.equippedWeapon,
      isHost: false
    });

    io.in(roomId).emit('zombie_room_updated', {
      roomId: roomId,
      hostId: room.hostId,
      players: room.players
    });
  });

  socket.on('start_zombie_game', (data) => {
    const room = zombieRooms[data.roomId];
    if (room && room.hostId === socket.id && !room.started) {
      room.started = true;

      // 埋まり防止の安全スポーン位置（ゾンビマップ壁 x: ±18, z: ±18 を避けた広場 z: 20 付近）
      const totalPlayers = room.players.length;
      const startPositions = room.players.map((p, idx) => {
        const offset = (idx - (totalPlayers - 1) / 2) * 4.5;
        return { id: p.id, pos: { x: offset, y: 0, z: 20 } };
      });

      io.in(data.roomId).emit('zombie_game_started', {
        roomId: room.id,
        players: room.players,
        startPositions: startPositions
      });
    }
  });

  socket.on('zombie_action', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('zombie_action_sync', data);
    }
  });

  socket.on('leave_room', (data) => {
    if (data && data.roomId) {
      socket.leave(data.roomId);
      if (rooms[data.roomId]) {
        socket.to(data.roomId).emit('opponent_disconnected');
        delete rooms[data.roomId];
      }
      if (zombieRooms[data.roomId]) {
        const zRoom = zombieRooms[data.roomId];
        zRoom.players = zRoom.players.filter(p => p.id !== socket.id);
        if (zRoom.players.length === 0) {
          delete zombieRooms[data.roomId];
        } else {
          if (zRoom.hostId === socket.id) {
            zRoom.hostId = zRoom.players[0].id;
            zRoom.players[0].isHost = true;
          }
          io.in(data.roomId).emit('zombie_room_updated', {
            roomId: zRoom.id,
            hostId: zRoom.hostId,
            players: zRoom.players
          });
        }
      }
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

    for (const zId in zombieRooms) {
      const zRoom = zombieRooms[zId];
      if (zRoom.players.some(p => p.id === socket.id)) {
        zRoom.players = zRoom.players.filter(p => p.id !== socket.id);
        if (zRoom.players.length === 0) {
          delete zombieRooms[zId];
        } else {
          if (zRoom.hostId === socket.id) {
            zRoom.hostId = zRoom.players[0].id;
            zRoom.players[0].isHost = true;
          }
          io.in(zId).emit('zombie_room_updated', {
            roomId: zRoom.id,
            hostId: zRoom.hostId,
            players: zRoom.players
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
