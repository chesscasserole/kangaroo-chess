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

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Game rooms storage
const rooms = new Map();

// Generate random room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Initialize chess board
function initializeBoard() {
    return [
        ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
        ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
        ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
    ];
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            board: initializeBoard(),
            currentPlayer: 'white',
            players: {
                [socket.id]: {
                    name: data.playerName,
                    color: 'white'
                }
            },
            gameOver: false,
            winner: null
        };

        rooms.set(roomCode, room);
        socket.join(roomCode);

        socket.emit('roomJoined', {
            roomCode,
            playerColor: 'white',
            players: room.players
        });

        socket.emit('gameState', room);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (Object.keys(room.players).length >= 2) {
            socket.emit('error', 'Room is full');
            return;
        }

        const playerColor = Object.keys(room.players).length === 0 ? 'white' : 'black';
        room.players[socket.id] = {
            name: data.playerName,
            color: playerColor
        };

        socket.join(data.roomCode);

        socket.emit('roomJoined', {
            roomCode: data.roomCode,
            playerColor,
            players: room.players
        });

        io.to(data.roomCode).emit('gameState', room);
    });

    socket.on('makeMove', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.gameOver) return;

        const player = room.players[socket.id];
        if (!player || player.color !== room.currentPlayer) return;

        const {from, to} = data;
        
        // Basic move validation
        if (room.board[from.row][from.col] && 
            from.row >= 0 && from.row < 8 && from.col >= 0 && from.col < 8 &&
            to.row >= 0 && to.row < 8 && to.col >= 0 && to.col < 8) {
            
            // Make the move
            const piece = room.board[from.row][from.col];
            room.board[to.row][to.col] = piece;
            room.board[from.row][from.col] = null;

            // Switch turns
            room.currentPlayer = room.currentPlayer === 'white' ? 'black' : 'white';

            const moveNotation = `${String.fromCharCode(97 + from.col)}${8 - from.row}-${String.fromCharCode(97 + to.col)}${8 - to.row}`;
            
            io.to(data.roomCode).emit('gameState', room);
            io.to(data.roomCode).emit('moveMade', {
                move: moveNotation,
                player: player.name
            });
        }
    });

    socket.on('makeSwap', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.gameOver) return;

        const player = room.players[socket.id];
        if (!player || player.color !== room.currentPlayer) return;

        const {from, to} = data;
        
        // Validate swap
        if (room.board[from.row][from.col] && room.board[to.row][to.col]) {
            const piece1 = room.board[from.row][from.col];
            const piece2 = room.board[to.row][to.col];
            
            // Check if both pieces belong to the current player
            const isWhite = player.color === 'white';
            const piece1IsPlayer = isWhite ? piece1 === piece1.toUpperCase() : piece1 === piece1.toLowerCase();
            const piece2IsPlayer = isWhite ? piece2 === piece2.toUpperCase() : piece2 === piece2.toLowerCase();
            
            if (piece1IsPlayer && piece2IsPlayer) {
                // Perform swap
                room.board[from.row][from.col] = piece2;
                room.board[to.row][to.col] = piece1;

                // Switch turns
                room.currentPlayer = room.currentPlayer === 'white' ? 'black' : 'white';

                const swapNotation = `SWAP ${String.fromCharCode(97 + from.col)}${8 - from.row}↔${String.fromCharCode(97 + to.col)}${8 - to.row}`;
                
                io.to(data.roomCode).emit('gameState', room);
                io.to(data.roomCode).emit('moveMade', {
                    move: swapNotation,
                    player: player.name
                });
            }
        }
    });

    socket.on('newGame', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;

        room.board = initializeBoard();
        room.currentPlayer = 'white';
        room.gameOver = false;
        room.winner = null;

        io.to(data.roomCode).emit('gameState', room);
    });

    socket.on('leaveRoom', (data) => {
        socket.leave(data.roomCode);
        const room = rooms.get(data.roomCode);
        if (room) {
            delete room.players[socket.id];
            if (Object.keys(room.players).length === 0) {
                rooms.delete(data.roomCode);
            } else {
                io.to(data.roomCode).emit('gameState', room);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove player from all rooms
        for (const [roomCode, room] of rooms.entries()) {
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                if (Object.keys(room.players).length === 0) {
                    rooms.delete(roomCode);
                } else {
                    io.to(roomCode).emit('gameState', room);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Kangaroo Chess server running on port ${PORT}`);
});
