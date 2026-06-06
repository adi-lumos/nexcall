'use strict';

import { openDB, logCallStart, logCallEnd } from './db.js';

// ── ICE / TURN config ─────────────────────────────
const TURN_HOST = location.hostname;
const TURN_USERNAME = 'nexcall';
const TURN_CREDENTIAL = 'nexcall-pass';

const ICE_SERVERS = [
  { urls: `stun:${TURN_HOST}:3478` },
  {
    urls: [`turn:${TURN_HOST}:3478`, `turns:${TURN_HOST}:5349`],
    username: TURN_USERNAME,
    credential: TURN_CREDENTIAL,
  },
];

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const $ = id => document.getElementById(id);

// UI refs
const lobbyScreen = $('lobby-screen');
const callScreen = $('call-screen');
const roomInput = $('room-input');
const btnCreate = $('btn-create');
const btnJoin = $('btn-join');
const btnRandom = $('btn-random');
const statusMsg = $('status-msg');
const localVideo = $('local-video');
const remoteVideo = $('remote-video');
const remotePlaceholder = $('remote-placeholder');
const callRoomLabel = $('call-room-label');
const callTimer = $('call-timer');
const btnMic = $('btn-mic');
const btnCam = $('btn-cam');
const btnHangup = $('btn-hangup');
const iconMicOn = $('icon-mic-on');
const iconMicOff = $('icon-mic-off');
const iconCamOn = $('icon-cam-on');
const iconCamOff = $('icon-cam-off');
const permOverlay = $('permission-overlay');
const localWrapper = $('local-video-wrapper');

let socket = null;
let peerConnection = null;
let localStream = null;

let isInitiator = false;
let currentRoomId = null;
let currentHistoryId = null;
let pendingCandidates = [];

let timerInterval = null;
let timerSeconds = 0;

let isMicMuted = false;
let isCamOff = false;

openDB().then(() => console.log('[DB] Ready'));

function showToast(msg, type = 'info') {
  const wrap = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setStatus(text, cls = '') {
  statusMsg.textContent = text;
  statusMsg.className = cls;
}

function showScreen(name) {
  lobbyScreen.classList.toggle('active', name === 'lobby');
  callScreen.classList.toggle('active', name === 'call');
}

function generateRoomId() {
  const w = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india'];
  const pick = () => w[Math.floor(Math.random() * w.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 900) + 100}`;
}

// ─────────────────────────────────────────────
// SAFE MEDIA (NO CRASH VERSION)
// ─────────────────────────────────────────────
async function acquireLocalMedia() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasVideo = devices.some(d => d.kind === 'videoinput');
    const hasAudio = devices.some(d => d.kind === 'audioinput');

    // If NOTHING exists → fail cleanly
    if (!hasVideo && !hasAudio) {
      showToast('No camera or microphone found on this device.', 'error');
      return false;
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: hasAudio,
      video: hasVideo ? { width: 640, height: 480 } : false
    });

    // IMPORTANT: handle missing tracks safely
    if (localStream.getVideoTracks().length === 0) {
      console.log('[Media] No video track — audio-only mode');
    }

    localVideo.srcObject = localStream;
    permOverlay.classList.remove('visible');
    return true;

  } catch (err) {
    console.error('[Media error]', err);

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      permOverlay.classList.add('visible');
    } else {
      showToast(`Media error: ${err.message}`, 'error');
    }

    return false;
  }
}

// ─────────────────────────────────────────────
// SIGNALING
// ─────────────────────────────────────────────
function connectSignaling() {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('Signaling server unreachable'));

    socket.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg);
    };
  });
}

function signal(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type,
      roomId: currentRoomId,
      payload
    }));
  }
}

// ─────────────────────────────────────────────
// PEER CONNECTION
// ─────────────────────────────────────────────
function createPC() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate) signal('ice-candidate', e.candidate.toJSON());
  };

  pc.ontrack = e => {
    if (e.streams?.[0]) {
      remoteVideo.srcObject = e.streams[0];
      remotePlaceholder.style.display = 'none';
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ICE]', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      setStatus('ICE failed, retry or check TURN settings', 'error');
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('Connected', 'success');
    }
  };

  return pc;
}

function resetCall() {
  pendingCandidates = [];
  peerConnection?.close();
  peerConnection = null;

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  localStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remotePlaceholder.style.display = 'flex';
  callRoomLabel.textContent = '';
  isInitiator = false;
}

function addPendingCandidates() {
  if (!peerConnection) return;
  pendingCandidates.forEach(candidate => {
    peerConnection.addIceCandidate(candidate).catch(console.warn);
  });
  pendingCandidates = [];
}

// ─────────────────────────────────────────────
async function startCall() {
  peerConnection = createPC();

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    signal('offer', peerConnection.localDescription.toJSON());
  } catch (e) {
    console.error(e);
  }
}

async function handleOffer(sdp) {
  peerConnection = createPC();

  try {
    await peerConnection.setRemoteDescription(sdp);
    addPendingCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    signal('answer', peerConnection.localDescription.toJSON());
  } catch (e) {
    console.error(e);
  }
}

// ─────────────────────────────────────────────
function hangUp() {
  if (socket?.readyState === WebSocket.OPEN) {
    signal('leave');
  }
  resetCall();
  setStatus('Call ended');
  showScreen('lobby');
}

// ─────────────────────────────────────────────
async function joinRoom(roomId) {
  if (!roomId) {
    showToast('Room ID is required', 'error');
    return;
  }

  currentRoomId = roomId;
  callRoomLabel.textContent = `Room: ${roomId}`;

  setStatus('Connecting media…');
  const gotMedia = await acquireLocalMedia();
  if (!gotMedia) return;

  setStatus('Connecting server…');

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await connectSignaling();
  }

  showScreen('call');
  signal('join');
}

// ─────────────────────────────────────────────
function handleSignal({ type, payload }) {
  switch (type) {
    case 'joined':
      isInitiator = payload.isInitiator;
      setStatus(isInitiator ? 'Waiting for peer…' : 'Joining call…');
      if (!isInitiator) callRoomLabel.textContent = `Room: ${payload.roomId || currentRoomId}`;
      break;

    case 'peer-joined':
      if (isInitiator) {
        setStatus('Peer joined, creating offer…');
        startCall();
      }
      break;

    case 'offer':
      setStatus('Received offer, answering…');
      handleOffer(payload);
      break;

    case 'answer':
      if (peerConnection) {
        peerConnection.setRemoteDescription(payload).catch(console.error);
      }
      break;

    case 'ice-candidate':
      if (peerConnection) {
        peerConnection.addIceCandidate(payload).catch(console.warn);
      } else {
        pendingCandidates.push(payload);
      }
      break;
  }
}

// ─────────────────────────────────────────────
// EVENTS
btnCreate.onclick = () => {
  const id = roomInput.value.trim() || generateRoomId();
  roomInput.value = id;
  joinRoom(id);
};

btnJoin.onclick = () => joinRoom(roomInput.value.trim());
btnRandom.onclick = () => {
  const id = generateRoomId();
  roomInput.value = id;
  joinRoom(id);
};

btnMic.onclick = () => {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(track => track.enabled = !isMicMuted);
  btnMic.classList.toggle('muted', isMicMuted);
  iconMicOn.style.display = isMicMuted ? 'none' : 'block';
  iconMicOff.style.display = isMicMuted ? 'block' : 'none';
};

btnCam.onclick = () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(track => track.enabled = !isCamOff);
  btnCam.classList.toggle('muted', isCamOff);
  iconCamOn.style.display = isCamOff ? 'none' : 'block';
  iconCamOff.style.display = isCamOff ? 'block' : 'none';
};

btnHangup.onclick = hangUp;

// INIT SW
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .catch(console.warn);
}

console.log('[NexCall] loaded');