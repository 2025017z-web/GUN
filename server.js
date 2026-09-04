const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1v1 マッチング処理
  socket.on('join_matchmaking', (data) => {
    socket.playerName = data.name || 'Player';
    socket.equippedWeapon = data.weapon || 'laser';

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      // 部屋の作成
      const roomId = `room_${waitingPlayer.id}_${socket.id}`;
      socket.join(roomId);
      waitingPlayer.join(roomId);

      rooms[roomId] = {
        players: [waitingPlayer.id, socket.id],
        scores: { [waitingPlayer.id]: 0, [socket.id]: 0 },
        round: 1
      };

      // それぞれに相手の情報を通達
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

  // プレイヤー状態の同期（位置・回転・アニメーションなど）
  socket.on('player_update', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('opponent_update', data);
    }
  });

  // 射撃データの同期
  socket.on('player_shoot', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('opponent_shoot', data);
    }
  });

  // ヒット判定＆ダメージの同期
  socket.on('player_hit', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('take_damage', data);
    }
  });

  // ラウンド勝利報告
  socket.on('round_win', (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
      room.round++;
      io.in(data.roomId).emit('round_complete', {
        winnerId: socket.id,
        scores: room.scores,
        nextRound: room.round
      });
    }
  });

  // 検索キャンセル・切断処理
  socket.on('cancel_matchmaking', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
  });

  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }
    // 相手が切断した場合の通知
    for (const roomId in rooms) {
      if (rooms[roomId].players.includes(socket.id)) {
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