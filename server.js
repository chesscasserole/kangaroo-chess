const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const gameRooms = new Map();

// Initial chess board
const initialBoard = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
    ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
    ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
];

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createNewGame(roomId) {
    return {
        id: roomId,
        board: JSON.parse(JSON.stringify(initialBoard)),
        currentPlayer: 'white',
        players: {},
        spectators: [],
        gameOver: false,
        moveHistory: [],
        createdAt: Date.now()
    };
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create-room', (playerName) => {
        const roomId = generateRoomId();
        const game = createNewGame(roomId);
        
        // Creator becomes white player
        game.players.white = {
            id: socket.id,
            name: playerName,
            connected: true
        };
        
        gameRooms.set(roomId, game);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.playerColor = 'white';
        
        socket.emit('room-created', {
            roomId: roomId,
            color: 'white',
            game: game
        });
        
        console.log(`Room ${roomId} created by ${playerName}`);
    });

    socket.on('join-room', (data) => {
        const { roomId, playerName } = data;
        const game = gameRooms.get(roomId);
        
        if (!game) {
            socket.emit('error', 'Room not found');
            return;
        }
        
        if (!game.players.black) {
            // Join as black player
            game.players.black = {
                id: socket.id,
                name: playerName,
                connected: true
            };
            
            socket.join(roomId);
            socket.roomId = roomId;
            socket.playerColor = 'black';
            
            socket.emit('room-joined', {
                roomId: roomId,
                color: 'black',
                game: game
            });
            
            // Notify both players that game can start
            io.to(roomId).emit('game-start', game);
            
            console.log(`${playerName} joined room ${roomId} as black`);
        } else {
            // Join as spectator
            game.spectators.push({
                id: socket.id,
                name: playerName,
                connected: true
            });
            
            socket.join(roomId);
            socket.roomId = roomId;
            socket.playerColor = 'spectator';
            
            socket.emit('room-joined', {
                roomId: roomId,
                color: 'spectator',
                game: game
            });
            
            console.log(`${playerName} joined room ${roomId} as spectator`);
        }
    });

    socket.on('make-move', (moveData) => {
        const game = gameRooms.get(socket.roomId);
        if (!game || socket.playerColor === 'spectator') return;
        
        // Verify it's the player's turn
        if (game.currentPlayer !== socket.playerColor) {
            socket.emit('error', 'Not your turn');
            return;
        }
        
        // Update game state
        if (moveData.type === 'move') {
            game.board[moveData.to.row][moveData.to.col] = moveData.piece;
            game.board[moveData.from.row][moveData.from.col] = null;
            
            // Handle pawn promotion
            if (moveData.piece.toLowerCase() === 'p' && (moveData.to.row === 0 || moveData.to.row === 7)) {
                game.board[moveData.to.row][moveData.to.col] = moveData.piece === 'P' ? 'Q' : 'q';
            }
        } else if (moveData.type === 'swap') {
            const temp = game.board[moveData.from.row][moveData.from.col];
            game.board[moveData.from.row][moveData.from.col] = game.board[moveData.to.row][moveData.to.col];
            game.board[moveData.to.row][moveData.to.col] = temp;
        }
        
        // Add to move history
        game.moveHistory.push({
            ...moveData,
            timestamp: Date.now(),
            player: socket.playerColor
        });
        
        // Switch turns
        game.currentPlayer = game.currentPlayer === 'white' ? 'black' : 'white';
        
        // Broadcast move to all players in room
        io.to(socket.roomId).emit('move-made', {
            moveData: moveData,
            game: game
        });
        
        console.log(`Move made in room ${socket.roomId}:`, moveData.type);
    });

    socket.on('game-over', (result) => {
        const game = gameRooms.get(socket.roomId);
        if (!game) return;
        
        game.gameOver = true;
        game.result = result;
        
        io.to(socket.roomId).emit('game-ended', result);
        console.log(`Game in room ${socket.roomId} ended:`, result);
    });

    socket.on('chat-message', (message) => {
        const game = gameRooms.get(socket.roomId);
        if (!game) return;
        
        const playerName = game.players.white?.id === socket.id ? game.players.white.name :
                          game.players.black?.id === socket.id ? game.players.black.name :
                          game.spectators.find(s => s.id === socket.id)?.name || 'Unknown';
        
        io.to(socket.roomId).emit('chat-message', {
            playerName: playerName,
            message: message,
            timestamp: Date.now(),
            color: socket.playerColor
        });
    });

    socket.on('request-rematch', () => {
        const game = gameRooms.get(socket.roomId);
        if (!game || socket.playerColor === 'spectator') return;
        
        socket.to(socket.roomId).emit('rematch-requested', {
            from: socket.playerColor
        });
    });

    socket.on('accept-rematch', () => {
        const game = gameRooms.get(socket.roomId);
        if (!game) return;
        
        // Reset game state
        game.board = JSON.parse(JSON.stringify(initialBoard));
        game.currentPlayer = 'white';
        game.gameOver = false;
        game.moveHistory = [];
        delete game.result;
        
        io.to(socket.roomId).emit('game-reset', game);
        console.log(`Game in room ${socket.roomId} reset for rematch`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const game = gameRooms.get(socket.roomId);
        if (game) {
            // Mark player as disconnected
            if (game.players.white?.id === socket.id) {
                game.players.white.connected = false;
            } else if (game.players.black?.id === socket.id) {
                game.players.black.connected = false;
            } else {
                // Remove from spectators
                game.spectators = game.spectators.filter(s => s.id !== socket.id);
            }
            
            // Notify other players
            socket.to(socket.roomId).emit('player-disconnected', {
                color: socket.playerColor
            });
            
            // Clean up empty rooms after 5 minutes
            setTimeout(() => {
                const currentGame = gameRooms.get(socket.roomId);
                if (currentGame && 
                    (!currentGame.players.white?.connected && !currentGame.players.black?.connected) &&
                    currentGame.spectators.length === 0) {
                    gameRooms.delete(socket.roomId);
                    console.log(`Cleaned up empty room: ${socket.roomId}`);
                }
            }, 5 * 60 * 1000); // 5 minutes
        }
    });
});

// Clean up old rooms periodically (older than 2 hours with no activity)
setInterval(() => {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    
    for (const [roomId, game] of gameRooms.entries()) {
        if (now - game.createdAt > maxAge) {
            gameRooms.delete(roomId);
            console.log(`Cleaned up old room: ${roomId}`);
        }
    }
}, 30 * 60 * 1000); // Check every 30 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to play`);
});
