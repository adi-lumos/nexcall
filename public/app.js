'use strict';

import { openDB } from './db.js';

// ── ICE / TURN config ─────────────────────────────
const TURN_HOST = "adi-nexcall.up.railway.app";
const TURN_USERNAME = 'adiconnect';
const TURN_CREDENTIAL = 'adiconnect-pass';

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
const connState = $('conn-state');
const btnMic = $('btn-mic');
const btnCam = $('btn-cam');
const btnHangup = $('btn-hangup');
const iconMicOn = $('icon-mic-on');
const iconMicOff = $('icon-mic-off');
const iconCamOn = $('icon-cam-on');
const iconCamOff = $('icon-cam-off');
const permOverlay = $('permission-overlay');

let socket = null;
let peerConnection = null;
let localStream = null;

let isInitiator = false;
let currentRoomId = null;
let pendingCandidates = [];

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
  return `${w[Math.random()*w.length|0]}-${w[Math.random()*w.length|0]}-${Math.floor(Math.random()*900+100)}`;
}

//
// ✅ FIXED MEDIA HANDLING (mobile-safe)
//
async function acquireLocalMedia() {
  try {
    setStatus('Requesting camera/mic...');

    // IMPORTANT: DO NOT enumerateDevices on mobile (breaks Brave / Safari)
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user'
      }
    });

    // fallback safety
    const hasVideo = localStream.getVideoTracks().length > 0;
    const hasAudio = localStream.getAudioTracks().length > 0;

    if (!hasAudio) {
      showToast('Microphone not available', 'error');
    }

    if (!hasVideo) {
      showToast('Camera not available (audio-only mode)', 'info');
    }

    localVideo.srcObject = localStream;
    permOverlay.classList.remove('visible');

    return true;

  } catch (err) {
    console.error('[Media error]', err);

    if (
      err.name === 'NotAllowedError' ||
      err.name === 'PermissionDeniedError'
    ) {
      permOverlay.classList.add('visible');
      showToast('Permission denied. Allow camera/mic.', 'error');
    } else {
      showToast(`Media error: ${err.message}`, 'error');
    }

    return false;
  }
}

// ── SIGNALING ─────────────────────────────
function connectSignaling() {
  return new Promise((resolve, reject) => {
    socket = new WebSocket(WS_URL);

    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('WS failed'));

    socket.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      handleSignal(msg);
    };
  });
}

function signal(type, payload = {}) {
  socket?.send(JSON.stringify({
    type,
    roomId: currentRoomId,
    payload
  }));
}

// ── PEER CONNECTION ─────────────────────────────
function createPC() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onicecandidate = e => {
    if (e.candidate) {
      const c = e.candidate.candidate;

      if (c.includes("relay")) {
        connState.textContent = "🔴 TURN (relay)";
        connState.style.color = "#ff4d6d";
      } 
      else if (c.includes("srflx")) {
        connState.textContent = "🟡 STUN (public NAT)";
        connState.style.color = "#ffc832";
      } 
      else if (c.includes("host")) {
        connState.textContent = "🟢 Direct (local)";
        connState.style.color = "#00e5a0";
      }

      signal('ice-candidate', e.candidate.toJSON());
    }
  };
  

  pc.ontrack = e => {
    remoteVideo.srcObject = e.streams[0];
    remotePlaceholder.style.display = 'none';
  };

  return pc;
}

function resetCall() {
  peerConnection?.close();
  peerConnection = null;

  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remotePlaceholder.style.display = 'flex';

  isInitiator = false;
}

async function startCall() {
  peerConnection = createPC();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  signal('offer', peerConnection.localDescription.toJSON());
}

async function handleOffer(sdp) {
  peerConnection = createPC();
  await peerConnection.setRemoteDescription(sdp);

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  signal('answer', peerConnection.localDescription.toJSON());
}

function hangUp() {
  signal('leave');
  resetCall();
  showScreen('lobby');
}

async function joinRoom(roomId) {
  currentRoomId = roomId;
  callRoomLabel.textContent = roomId;

  const ok = await acquireLocalMedia();
  if (!ok) return;

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await connectSignaling();
  }

  showScreen('call');
  signal('join');
}

// ── SIGNAL HANDLER ─────────────────────────────
function handleSignal({ type, payload }) {
  switch (type) {

    case 'joined':
      isInitiator = payload.isInitiator;
      if (isInitiator) setStatus('Waiting for peer...');
      break;

    case 'peer-joined':
      if (isInitiator) startCall();
      break;

    case 'offer':
      handleOffer(payload);
      break;

    case 'answer':
      peerConnection?.setRemoteDescription(payload);
      break;

    case 'ice-candidate':
      peerConnection
        ? peerConnection.addIceCandidate(payload)
        : pendingCandidates.push(payload);
      break;
  }
}

// ── EVENTS ─────────────────────────────
btnCreate.onclick = () => {
  const id = roomInput.value.trim() || generateRoomId();
  roomInput.value = id;
  joinRoom(id);
};

btnJoin.onclick = () => joinRoom(roomInput.value.trim());
btnRandom.onclick = () => joinRoom(generateRoomId());

btnMic.onclick = () => {
  isMicMuted = !isMicMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
};

btnCam.onclick = () => {
  isCamOff = !isCamOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !isCamOff);
};

btnHangup.onclick = hangUp;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.warn);
}

console.log('[adiconnect] loaded');

pc.onicecandidate = e => {
  if (e.candidate) {
    const c = e.candidate.candidate;

    if (c.includes("relay")) console.log("🔥 TURN WORKING (relay)");
    if (c.includes("srflx")) console.log("⚠️ STUN only");
    if (c.includes("host")) console.log("⚠️ local only");

    signal('ice-candidate', e.candidate.toJSON());
  }
};
