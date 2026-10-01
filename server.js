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

// 勝利判定チェック関数
function checkWinCondition(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'playing') return;

  const players = Object.values(room.players);
  const alivePlayers = players.filter(p => !p.isDead && p.hp > 0);

  if (room.mode === 'team_vs') {
    const aliveTeams = new Set(alivePlayers.map(p => p.team));
    if (aliveTeams.size === 1) {
      const winningTeam = [...aliveTeams][0];
      io.to(roomCode).emit('match_over', { winnerTeam: winningTeam });
      room.state = 'finished';
    } else if (aliveTeams.size === 0) {
      io.to(roomCode).emit('match_over', { winnerTeam: null });
      room.state = 'finished';
    }
  } else {
    if (alivePlayers.length === 1) {
      const winner = alivePlayers[0];
      io.to(roomCode).emit('match_over', { winnerId: winner.id, winnerName: winner.name });
      room.state = 'finished';
    } else if (alivePlayers.length === 0) {
      io.to(roomCode).emit('match_over', { winnerId: null, winnerName: "DRAW" });
      room.state = 'finished';
    }
  }
}

// ユーザー離脱処理の共通化
function handleUserLeave(socket) {
  const roomCode = socket.roomCode;
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];
  if (room.players[socket.id]) {
    delete room.players[socket.id];
    socket.leave(roomCode);

    io.to(roomCode).emit('player_left', { id: socket.id });
    io.to(roomCode).emit('room_data_update', room);

    if (room.state === 'playing') {
      checkWinCondition(roomCode);
    }

    if (Object.keys(room.players).length === 0) {
      delete rooms[roomCode];
    }
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. ロビーに参加 / 途中参戦ブロック
  socket.on('join_room', ({ roomCode, name, team, gameMode }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = name;

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        state: 'waiting',
        mode: gameMode || 'solo_vs',
        mapSeed: Math.floor(Math.random() * 1000000), // ★地形固定用のシード値
        players: {},
        nodes: {},
        drops: {},
        teams: { RED: [], BLUE: [] }
      };
    }

    const room = rooms[roomCode];

    // ★途中参戦拒否（観戦へ誘導）
    if (room.state === 'playing') {
      socket.emit('joined_as_spectator', {
        roomCode,
        mode: room.mode,
        mapSeed: room.mapSeed,
        players: room.players,
        nodes: room.nodes,
        drops: room.drops
      });
      return;
    }

    room.players[socket.id] = {
      id: socket.id,
      name: name || "PLAYER",
      team: team || 'RED',
      hp: 100,
      maxHp: 100,
      isDead: false,
      x: 0,
      y: 0,
      ang: 0
    };

    io.to(roomCode).emit('room_data_update', room);
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
        mapSeed: room.mapSeed, // ★全員に同じマップシードを配る
        startTime: room.matchStartTime
      });
    }
  });

  // 5. プレイヤーの位置・ステータス同期
  socket.on('update_player', (playerData) => {
    const room = rooms[socket.roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id] = {
        ...room.players[socket.id],
        ...playerData,
        id: socket.id
      };
      socket.to(socket.roomCode).emit('player_updated', {
        id: socket.id,
        data: room.players[socket.id]
      });
    }
  });

  // 6. ダメージ＆トドメ（死亡判定）
  socket.on('send_damage', ({ targetId, dmg }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.players[targetId]) return;

    const target = room.players[targetId];
    if (target.isDead) return;

    target.hp -= dmg;

    if (target.hp <= 0) {
      target.hp = 0;
      target.isDead = true;

      // ★トドメ通知（全員の画面から削除・キルログ用）
      io.to(socket.roomCode).emit('player_killed', {
        deadId: targetId,
        killerId: socket.id
      });

      checkWinCondition(socket.roomCode);
    } else {
      io.to(socket.roomCode).emit('receive_damage', {
        attackerId: socket.id,
        targetId: targetId,
        dmg: dmg,
        currentHp: target.hp
      });
    }
  });

  // 7. 自発的死亡（エリアダメ/自爆等）
  socket.on('player_died', () => {
    const room = rooms[socket.roomCode];
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id].hp = 0;
    room.players[socket.id].isDead = true;

    io.to(socket.roomCode).emit('player_killed', {
      deadId: socket.id,
      killerId: null
    });

    checkWinCondition(socket.roomCode);
  });

  // ★8. データノード（経験値源）の同期処理
  socket.on('spawn_node', ({ nid, x, y, hp, maxHp }) => {
    const room = rooms[socket.roomCode];
    if (room) {
      room.nodes[nid] = { x, y, hp, maxHp };
      io.to(socket.roomCode).emit('node_spawned', { nid, x, y, hp, maxHp });
    }
  });

  socket.on('update_node_hp', ({ nid, hp }) => {
    const room = rooms[socket.roomCode];
    if (room && room.nodes[nid]) {
      room.nodes[nid].hp = hp;
      socket.to(socket.roomCode).emit('node_hp_updated', { nid, hp });
    }
  });

  socket.on('destroy_node', ({ nid }) => {
    const room = rooms[socket.roomCode];
    if (room && room.nodes[nid]) {
      delete room.nodes[nid];
      io.to(socket.roomCode).emit('node_destroyed', { nid });
    }
  });

  // ★9. ドロップアイテムの同期処理
  socket.on('spawn_drop', ({ type, x, y }) => {
    const room = rooms[socket.roomCode];
    if (room) {
      const did = 'd_' + Math.random().toString(36).substring(2, 9);
      room.drops[did] = { type, x, y };
      io.to(socket.roomCode).emit('drop_spawned', { did, type, x, y });
    }
  });

  socket.on('take_drop', ({ did }) => {
    const room = rooms[socket.roomCode];
    if (room && room.drops[did]) {
      delete room.drops[did];
      io.to(socket.roomCode).emit('drop_taken', { did });
    }
  });

  // 10. チャットメッセージ
  socket.on('send_chat', ({ message }) => {
    io.to(socket.roomCode).emit('receive_chat', {
      sender: socket.playerName || 'UNKNOWN',
      message: message
    });
  });

  // 11. システム退室ボタン
  socket.on('leave_room', () => {
    handleUserLeave(socket);
  });

  // 12. 接続切断（タブ消し・リロード）
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    handleUserLeave(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
