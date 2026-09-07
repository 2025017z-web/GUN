const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// 静的ファイルの提供（ルートおよびpublicディレクトリ）
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) res.sendFile(path.join(__dirname, 'index.html'));
    });
});

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    socket.on('join_game', () => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = `room_${waitingPlayer.id}_${socket.id}`;
            const room = {
                id: roomId,
                players: {
                    [waitingPlayer.id]: { id: waitingPlayer.id, hp: 100, isDead: false, score: 0, pos: { x: 0, y: 1.6, z: 12 }, rot: { x: 0, y: 0 } },
                    [socket.id]: { id: socket.id, hp: 100, isDead: false, score: 0, pos: { x: 0, y: 1.6, z: -12 }, rot: { x: 0, y: Math.PI } }
                }
            };
            rooms[roomId] = room;

            waitingPlayer.join(roomId);
            socket.join(roomId);

            waitingPlayer.roomId = roomId;
            socket.roomId = roomId;

            io.to(roomId).emit('match_found', {
                roomId: roomId,
                players: room.players
            });

            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
            socket.emit('waiting_for_match');
        }
    });

    socket.on('player_update', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];
        if (room.players[socket.id]) {
            room.players[socket.id].pos = data.pos;
            room.players[socket.id].rot = data.rot;
            socket.to(socket.roomId).emit('opponent_update', data);
        }
    });

    // ダメージ処理（重複撃破カウントバグ対策済み）
    socket.on('deal_damage', (data) => {
        if (!socket.roomId || !rooms[socket.roomId]) return;
        const room = rooms[socket.roomId];
        const targetId = data.targetId;
        const damage = data.damage || 20;

        const target = room.players[targetId];
        const attacker = room.players[socket.id];

        // 相手が既に死亡状態（isDead === true）の場合は追撃ダメージ・撃破判定を完全に遮断
        if (!target || target.isDead || !attacker) return;

        target.hp -= damage;
        if (target.hp <= 0) {
            target.hp = 0;
            target.isDead = true; // 即時ロック
            attacker.score += 1;

            io.to(socket.roomId).emit('player_killed', {
                attackerId: socket.id,
                victimId: targetId,
                scores: {
                    [socket.id]: attacker.score,
                    [targetId]: target.score
                }
            });

            // 2秒後にリスポーン
            setTimeout(() => {
                if (rooms[socket.roomId] && rooms[socket.roomId].players[targetId]) {
                    const p = rooms[socket.roomId].players[targetId];
                    p.hp = 100;
                    p.isDead = false;
                    const spawnPos = targetId === Object.keys(room.players)[0] ? { x: 0, y: 1.6, z: 12 } : { x: 0, y: 1.6, z: -12 };
                    io.to(socket.roomId).emit('player_respawn', {
                        playerId: targetId,
                        pos: spawnPos,
                        hp: 100
                    });
                }
            }, 2000);
        } else {
            io.to(socket.roomId).emit('hp_update', {
                playerId: targetId,
                hp: target.hp
            });
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        if (socket.roomId && rooms[socket.roomId]) {
            io.to(socket.roomId).emit('opponent_disconnected');
            delete rooms[socket.roomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
