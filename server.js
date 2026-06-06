'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const httpServer = http.createServer(app);
const wss        = new WebSocket.Server({ server: httpServer });
const rooms      = new Map();

function send(socket, obj) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(obj));
}

function broadcastPeer(roomId, senderSocket, obj) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(obj);
  room.forEach(ws => {
    if (ws !== senderSocket && ws.readyState === WebSocket.OPEN)
      ws.send(payload);
  });
}

function leaveRoom(socket) {
  const roomId = socket._roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    room.delete(socket);
    if (room.size === 0) rooms.delete(roomId);
  }
  socket._roomId = null;
}

wss.on('connection', socket => {
  socket._roomId = null;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, roomId, payload } = msg;

    switch (type) {
      case 'join': {
        if (!roomId) return send(socket, { type: 'error', payload: { message: 'roomId required' } });
        if (socket._roomId) leaveRoom(socket);
        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        const room = rooms.get(roomId);
        if (room.size >= 2) return send(socket, { type: 'room-full', payload: { roomId } });
        room.add(socket);
        socket._roomId = roomId;
        const isInitiator = room.size === 1;
        send(socket, { type: 'joined', payload: { roomId, isInitiator } });
        if (!isInitiator) broadcastPeer(roomId, socket, { type: 'peer-joined', payload: {} });
        break;
      }
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (socket._roomId) broadcastPeer(socket._roomId, socket, { type, payload });
        break;
      }
      case 'leave': {
        if (socket._roomId) {
          broadcastPeer(socket._roomId, socket, { type: 'peer-left', payload: {} });
          leaveRoom(socket);
        }
        break;
      }
    }
  });

  socket.on('close', () => {
    if (socket._roomId) {
      broadcastPeer(socket._roomId, socket, { type: 'peer-left', payload: {} });
      leaveRoom(socket);
    }
  });

  socket.on('error', err => console.error('[WS] socket error:', err.message));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () =>
  console.log(`[adiconnect] Signaling server running on http://localhost:${PORT}`)
);