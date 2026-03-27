import { Arduino } from './arduino.js';

// ─── UI Elements ──────────────────────────────────────────────────────────────

const btnConnect    = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnPing       = document.getElementById('btn-ping');
const btnSendTape   = document.getElementById('btn-send-tape');
const btnRecvTape   = document.getElementById('btn-recv-tape');
const btnDiskDir    = document.getElementById('btn-disk-dir');
const btnCancel     = document.getElementById('btn-cancel');
const chkDebug      = document.getElementById('chk-debug');
const lblDiskDir    = document.getElementById('lbl-disk-dir');
const logEl         = document.getElementById('log');
const statusEl      = document.getElementById('status');

let debugEnabled = false;
let arduino = null;

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  write(text) { appendLog(text, false); },
  writeLine(text = '') { appendLog(text + '\n', false); },
  debugWrite(text) { if (debugEnabled) appendLog(text, true); },
  debugWriteLine(text) { if (debugEnabled) appendLog(text + '\n', true); },
};

function appendLog(text, isDebug) {
  const span = document.createElement('span');
  span.textContent = text;
  if (isDebug) span.className = 'debug';
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── UI State ─────────────────────────────────────────────────────────────────

function updateUI() {
  const connected = arduino?.isConnected ?? false;
  btnConnect.disabled    = connected;
  btnDisconnect.disabled = !connected;
  btnPing.disabled       = !connected;
  btnSendTape.disabled   = !connected;
  btnRecvTape.disabled   = !connected;
  btnDiskDir.disabled    = !connected;
  btnCancel.disabled     = !(arduino?.canCancel ?? false);
  statusEl.textContent   = connected ? 'Connected' : 'Disconnected';
  statusEl.className     = connected ? 'connected' : 'disconnected';
}

function setStatus(text) {
  statusEl.textContent = text;
}

// ─── Button Handlers ──────────────────────────────────────────────────────────

btnConnect.addEventListener('click', async () => {
  try {
    arduino = new Arduino(log);
    arduino.onStateChange = updateUI;
    updateUI();
    await arduino.connect();
  } catch (e) {
    const msg = e?.message ?? String(e);
    // User dismissed the port picker — not an error worth logging
    if (e?.name === 'NotFoundError' || msg.includes('No port selected') || e?.name === 'AbortError') {
      // silent
    } else if (msg.toLowerCase().includes('permission') || msg.includes('128')) {
      log.writeLine('Connection failed: OS permission denied.');
      log.writeLine('  On Arch Linux:  sudo usermod -a -G uucp $USER  (then log out/in)');
      log.writeLine('  On Ubuntu/Debian: sudo usermod -a -G dialout $USER');
      log.writeLine('  Temporary:  sudo chmod a+rw /dev/ttyACM0  (or /dev/ttyUSB0)');
    } else {
      log.writeLine(`Connect error: ${msg}`);
    }
    arduino = null;
    updateUI();
  }
});

btnDisconnect.addEventListener('click', async () => {
  try { await arduino?.disconnect(); }
  catch (e) { log.writeLine(`Disconnect error: ${e.message}`); }
  arduino = null;
  updateUI();
});

btnPing.addEventListener('click', async () => {
  try { await arduino?.ping(); }
  catch (e) { log.writeLine(`Ping error: ${e.message}`); }
});

btnSendTape.addEventListener('click', async () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tap,.bin';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await arduino?.sendTapeFile(data);
    } catch (e) {
      log.writeLine(`Send error: ${e.message}`);
    }
    updateUI();
  };
  input.click();
});

btnRecvTape.addEventListener('click', async () => {
  try {
    updateUI();
    const data = await arduino?.readTapeFile();
    if (!data) return;
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'tape.tap';
    a.click();
    URL.revokeObjectURL(url);
    log.writeLine(`Saved ${data.length} bytes as tape.tap`);
  } catch (e) {
    log.writeLine(`Receive error: ${e.message}`);
  }
  updateUI();
});

btnDiskDir.addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') {
    log.writeLine('Directory picker requires a secure context (https:// or localhost).');
    log.writeLine('  Start a local server:  npx serve web  →  http://localhost:3000');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    arduino?.setDiskDirectory(handle);
    lblDiskDir.textContent = handle.name;
    log.writeLine(`Disk directory: ${handle.name}`);
  } catch (e) {
    if (e?.name !== 'AbortError') log.writeLine(`Directory error: ${e.message}`);
  }
});

btnCancel.addEventListener('click', () => { arduino?.cancel(); updateUI(); });

chkDebug.addEventListener('change', () => { debugEnabled = chkDebug.checked; });

// ─── Web Serial availability check ───────────────────────────────────────────

if (!('serial' in navigator)) {
  logEl.textContent = 'Web Serial API is not supported in this browser.\nUse Chrome or Edge 89+.';
  btnConnect.disabled = true;
}

updateUI();
