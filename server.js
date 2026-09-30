const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 部屋（ルーム）ごとのデータ管理オブジェクト
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. ロビーに参加
  socket.on('join_room', ({ roomCode, name, team }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = name;

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        state: 'waiting',
        mode: 'solo_vs',
        players: {},
        nodes: {},
        drops: {},
        teams: { RED: [], BLUE: [] }
      };
    }

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: name,
      team: team || 'NONE',
      hp: 100,
      maxHp: 100,
      x: 0,
      y: 0
    };

    // 部屋メンバー全員にロビー更新を通知
    io.to(roomCode).emit('room_data_update', rooms[roomCode]);
  });

  // 2. チーム変更
  socket.on('change_team', ({ team }) => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id].team = team;
      io.to(socket.roomCode).emit('room_data_update', room);
    }
  });

  // 3. ゲームモード変更
  socket.on('change_mode', ({ mode }) => {
    const room = rooms[socket.roomCode];
    if (room) {
      room.mode = mode;
      io.to(socket.roomCode).emit('room_data_update', room);
    }
  });

  // 4. 試合開始
  socket.on('start_match', () => {
    const room = rooms[socket.roomCode];
    if (room) {
      room.state = 'playing';
      room.matchStartTime = Date.now();
      io.to(socket.roomCode).emit('match_started', {
        mode: room.mode,
        startTime: room.matchStartTime
      });
    }
  });

  // 5. プレイヤーの位置・ステータス同期（約30fps送信される）
  socket.on('update_player', (playerData) => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      // 送信されてきたデータを保持
      room.players[socket.id] = {
        ...room.players[socket.id],
        ...playerData,
        id: socket.id
      };
      // 自分以外の同じ部屋のメンバーへ送信
      socket.to(socket.roomCode).emit('player_updated', {
        id: socket.id,
        data: room.players[socket.id]
      });
    }
  });

  // 6. ダメージイベントの伝達
  socket.on('send_damage', ({ targetId, dmg }) => {
    io.to(socket.roomCode).emit('receive_damage', {
      attackerId: socket.id,
      targetId: targetId,
      dmg: dmg
    });
  });

  // 7. チャットメッセージ
  socket.on('send_chat', ({ message }) => {
    io.to(socket.roomCode).emit('receive_chat', {
      sender: socket.playerName || 'UNKNOWN',
      message: message
    });
  });

  // 8. 接続切断（退室）時
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      delete rooms[roomCode].players[socket.id];

      // 部屋に誰もいなくなったら部屋データを削除
      if (Object.keys(rooms[roomCode].players).length === 0) {
        delete rooms[roomCode];
      } else {
        io.to(roomCode).emit('player_left', socket.id);
        io.to(roomCode).emit('room_data_update', rooms[roomCode]);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
