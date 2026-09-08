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

let onlineUsers = {}; // socket.id -> { id, name }
let waitingPlayer = null;
let rooms = {};

let brQueue = [];
let brMatchTimer = null;

let zombieRooms = {}; // roomId -> { id, name, hostId, state, players: { socketId: { id, name, ready, weapon } } }

function broadcastOnlineUsers() {
  io.emit('online_users_update', Object.values(onlineUsers));
}

function getZombieRoomList() {
  return Object.values(zombieRooms).map(r => ({
    id: r.id,
    name: r.name,
    hostId: r.hostId,
    playerCount: Object.keys(r.players).length,
    state: r.state
  }));
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  onlineUsers[socket.id] = { id: socket.id, name: 'Player' };
  broadcastOnlineUsers();

  socket.on('set_player_name', (name) => {
    const formattedName = name || 'Player';
    socket.playerName = formattedName;
    if (onlineUsers[socket.id]) {
      onlineUsers[socket.id].name = formattedName;
      broadcastOnlineUsers();
    }
  });

  // --- テキストチャット ---
  socket.on('send_chat_msg', (data) => {
    io.emit('receive_chat_msg', {
      sender: socket.playerName || 'Player',
      msg: data.msg,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // --- WebRTC ボイスチャット シグナリング ---
  socket.on('voice_offer', ({ targetId, offer }) => {
    io.to(targetId).emit('voice_offer', { senderId: socket.id, offer });
  });

  socket.on('voice_answer', ({ targetId, answer }) => {
    io.to(targetId).emit('voice_answer', { senderId: socket.id, answer });
  });

  socket.on('voice_candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('voice_candidate', { senderId: socket.id, candidate });
  });

  // --- ゾンビモード：ルーム＆マッチメイキング ---
  socket.on('get_zombie_rooms', () => {
    socket.emit('zombie_room_list', getZombieRoomList());
  });

  socket.on('create_zombie_room', (data) => {
    const roomId = `zombie_${socket.id}_${Date.now()}`;
    socket.join(roomId);
    socket.zombieRoomId = roomId;

    zombieRooms[roomId] = {
      id: roomId,
      name: `${socket.playerName || 'Player'}の部屋`,
      hostId: socket.id,
      state: 'waiting',
      players: {
        [socket.id]: { id: socket.id, name: socket.playerName || 'Player', ready: false, weapon: data.weapon || 'laser' }
      }
    };

    socket.emit('zombie_room_joined', { roomId, room: zombieRooms[roomId] });
    io.emit('zombie_room_list', getZombieRoomList());
  });

  socket.on('join_zombie_room', (data) => {
    const room = zombieRooms[data.roomId];
    if (room && room.state === 'waiting') {
      socket.join(data.roomId);
      socket.zombieRoomId = data.roomId;
      room.players[socket.id] = {
        id: socket.id,
        name: socket.playerName || 'Player',
        ready: false,
        weapon: data.weapon || 'laser'
      };

      socket.emit('zombie_room_joined', { roomId: data.roomId, room: room });
      io.in(data.roomId).emit('zombie_room_updated', room);
      io.emit('zombie_room_list', getZombieRoomList());
    } else {
      socket.emit('zombie_error', '部屋が存在しないか既にゲームが開始されています。');
    }
  });

  socket.on('toggle_zombie_ready', () => {
    const roomId = socket.zombieRoomId;
    const room = zombieRooms[roomId];
    if (room && room.players[socket.id]) {
      room.players[socket.id].ready = !room.players[socket.id].ready;
      io.in(roomId).emit('zombie_room_updated', room);

      const playersList = Object.values(room.players);
      const allReady = playersList.every(p => p.ready);

      if (allReady && playersList.length > 0) {
        room.state = 'playing';
        io.in(roomId).emit('zombie_game_start', {
          roomId: roomId,
          hostId: room.hostId,
          players: playersList
        });
        io.emit('zombie_room_list', getZombieRoomList());
      }
    }
  });

  socket.on('leave_zombie_room', () => {
    leaveZombieRoom(socket);
  });

  function leaveZombieRoom(s) {
    const roomId = s.zombieRoomId;
    if (roomId && zombieRooms[roomId]) {
      const room = zombieRooms[roomId];
      delete room.players[s.id];
      s.leave(roomId);
      s.zombieRoomId = null;

      if (Object.keys(room.players).length === 0) {
        delete zombieRooms[roomId];
      } else {
        if (room.hostId === s.id) {
          room.hostId = Object.keys(room.players)[0];
        }
        io.in(roomId).emit('zombie_room_updated', room);
      }
      io.emit('zombie_room_list', getZombieRoomList());
    }
  }

  // ゾンビマルチ同期
  socket.on('zombie_spawn_sync', (data) => {
    if (data.roomId) socket.to(data.roomId).emit('zombie_spawn_sync', data);
  });

  socket.on('zombie_damage_sync', (data) => {
    if (data.roomId) io.in(data.roomId).emit('zombie_damage_sync', data);
  });

  socket.on('zombie_wave_start_sync', (data) => {
    if (data.roomId) io.in(data.roomId).emit('zombie_wave_start_sync', data);
  });

  // --- 1v1 マッチメイキング ---
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

  // --- BR マッチメイキング ---
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

  // --- 共通アクション同期 ---
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
    console.log(`Player disconnected: ${socket.id}`);
    delete onlineUsers[socket.id];
    broadcastOnlineUsers();

    leaveZombieRoom(socket);

    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
    brQueue = brQueue.filter(p => p.id !== socket.id);

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
