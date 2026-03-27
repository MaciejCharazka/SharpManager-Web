import { Ascii } from './ascii.js';
import { ArduinoError } from './errors.js';
import { ByteStream } from './byte-stream.js';
import { CE140F } from './ce140f.js';

const Command = { Init:1, Ping:2, DeviceSelect:3, Print:4, Data:5, LoadTape:6, SaveTape:7, Disk:8 };

const BUFFER_SIZE  = 64;
const HEADER_SIZE  = 10;
const VERSION_HIGH = 1;
const VERSION_LOW  = 3;
const READ_TIMEOUT = 5000;

function swapNibbles(b) { return ((b & 0x0F) << 4) | ((b & 0xF0) >> 4); }

/**
 * Main protocol handler. Mirrors Arduino.cs.
 * log: { write(s), writeLine(s?), debugWrite(s), debugWriteLine(s) }
 */
export class Arduino {
  constructor(log) {
    this._log = log;
    this._disk = new CE140F(log);
    this._stream = null;
    this._port = null;
    this._loopAbort = null;   // AbortController for the background main loop
    this._loopDone = null;    // Promise that resolves when main loop exits
    this._opAbort = null;     // AbortController for cancellable user ops
    this._cmdActive = false;  // true while a user command is running
    this.isConnected = false;
    this.onStateChange = null; // callback()
  }

  setDiskDirectory(handle) { this._disk.setDirectory(handle); }

  // ─── Connect / Disconnect ─────────────────────────────────────────────────

  async connect() {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    // Mirror C# DtrEnable=false — keeps DTR low so the Arduino doesn't reset on connect
    try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    this._port = port;
    this._stream = new ByteStream(port);
    this.isConnected = true;
    this.onStateChange?.();
    this._log.writeLine('Connected.');

    try { await this._initialize(); }
    catch (e) { await this.disconnect(); throw e; }

    this._startLoop();
  }

  async disconnect() {
    if (!this.isConnected) return;
    this._stopLoop();
    this._opAbort?.abort();
    try { this._stream?.writeByte(Ascii.CAN); } catch {}
    this._disk.reset();
    await this._stream?.close();
    this._stream = null;
    try { await this._port?.close(); } catch {}
    this._port = null;
    this.isConnected = false;
    this.onStateChange?.();
    this._log.writeLine('Disconnected.');
  }

  cancel() {
    this._stream?.writeByte(Ascii.CAN);
    this._opAbort?.abort();
    this._opAbort = null;
    this.onStateChange?.();
  }

  get canCancel() { return !!this._opAbort; }

  // ─── Main Loop ─────────────────────────────────────────────────────────────

  _startLoop() {
    this._loopAbort = new AbortController();
    this._loopDone = this._loopSupervisor(this._loopAbort.signal);
    this._loopDone.catch(() => {});
  }

  _stopLoop() {
    this._loopAbort?.abort();
    this._loopAbort = null;
  }

  async _loopSupervisor(signal) {
    let failures = 0;
    while (!signal.aborted && this._stream) {
      try {
        await this._mainLoop(signal);
        failures = 0;
      } catch (e) {
        if (signal.aborted || e?.name === 'AbortError') return;
        failures++;
        this._log.writeLine(`Loop error: ${e.message}`);
        const ms = failures <= 3 ? 100 : failures <= 10 ? 500 : 1000;
        await new Promise(r => setTimeout(r, ms));
      }
    }
    // Auto-disconnect if loop exits without explicit disconnect
    if (this.isConnected && !signal.aborted) this.disconnect().catch(() => {});
  }

  async _mainLoop(signal) {
    while (!signal.aborted && this._stream) {
      const byte = await this._stream.readByte(signal);

      if (this._cmdActive) {
        // Command is in progress — put byte back and yield until it finishes
        this._stream.unreadByte(byte);
        await new Promise(r => { this._resumeLoop = r; });
        continue;
      }

      if (byte === Ascii.SYN) {
        this._stream.writeByte(Ascii.SYN);
      } else if (byte === Ascii.SOH) {
        await this._processIncoming(signal);
      }
      // Unexpected bytes are silently ignored
    }
  }

  /** Suspend main loop, run fn(), then resume. */
  async _withCommand(fn) {
    if (!this._stream) throw new ArduinoError('Not connected');
    this._cmdActive = true;
    try {
      // Send CAN so the Arduino exits any in-progress tape/disk blocking loop,
      // then give it a moment to process it before we clear the buffer.
      this._stream.writeByte(Ascii.CAN);
      await new Promise(r => setTimeout(r, 100));
      if (!this._stream) throw new ArduinoError('Disconnected during command setup');
      this._stream.clearBuffer();
      return await fn();
    } finally {
      this._cmdActive = false;
      this._resumeLoop?.();
      this._resumeLoop = null;
      this.onStateChange?.();
    }
  }

  // ─── Incoming Commands (Arduino → PC) ─────────────────────────────────────

  async _processIncoming(signal) {
    const cmd = await this._stream.tryReadByte(1000, signal);
    if (cmd === null) return;

    switch (cmd) {
      case Command.Ping:
        this._stream.writeByte(Ascii.ACK);
        break;

      // Drain any stale init response that leaked into the main loop
      case Command.Init: {
        const vh = await this._stream.tryReadByte(500, signal);
        const vl = await this._stream.tryReadByte(500, signal);
        const bs = await this._stream.tryReadByte(500, signal);
        // consume STX + text + ETX
        let b = await this._stream.tryReadByte(500, signal);
        if (b === Ascii.STX) {
          while (true) {
            b = await this._stream.tryReadByte(500, signal);
            if (b === null || b === Ascii.ETX) break;
          }
        }
        this._log.debugWriteLine(`Drained stale init response v${vh}.${vl} buf=${bs}`);
        break;
      }

      case Command.DeviceSelect: {
        const dev = await this._stream.tryReadByte(1000, signal);
        if (dev !== null) this._log.debugWriteLine(`Device Select: 0x${dev.toString(16)}`);
        break;
      }

      case Command.Print: {
        const ch = await this._stream.tryReadByte(1000, signal);
        if (ch !== null) {
          if (ch === 13) this._log.writeLine();
          else this._log.write(String.fromCharCode(ch));
        }
        break;
      }

      case Command.Data: {
        const val = await this._stream.tryReadByte(1000, signal);
        if (val !== null) this._log.writeLine(`Data: 0x${val.toString(16).padStart(2,'0')}`);
        break;
      }

      case Command.Disk: {
        this._log.debugWriteLine('Disk command:');
        const cmdData = await this._readFrame(signal);
        const response = await this._disk.processCommand(cmdData);
        await this._sendDiskResponse(response, signal);
        break;
      }
    }
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  async _initialize() {
    // Wait for _readLoop to pump any bytes already in the hardware RX buffer
    // before we clear them (DTR-low still triggers a brief reset on some Arduinos).
    await new Promise(r => setTimeout(r, 200));
    // Drain any bytes the Arduino sent during reset (mirrors C# ClearReceiveBuffer)
    this._stream.clearBuffer();

    if (!await this._synchronize()) throw new ArduinoError('Synchronization failed');

    // Drain again — Arduino may have echoed extra SYNs or sent startup text
    this._stream.clearBuffer();

    this._stream.writeByte(Ascii.SOH);
    this._stream.writeByte(Command.Init);

    await this._expectByte(Ascii.SOH, 2500);
    const vh = await this._stream.readByte(1000);
    const vl = await this._stream.readByte(1000);
    if (vh !== VERSION_HIGH || vl !== VERSION_LOW)
      throw new ArduinoError(
        `Firmware version mismatch: expected ${VERSION_HIGH}.${VERSION_LOW}, got ${vh}.${vl}.\n` +
        `Please flash the latest Arduino firmware using the desktop app.`
      );
    const bufSize = await this._stream.readByte(1000);
    if (bufSize < 16) throw new ArduinoError(`Buffer size ${bufSize} too small`);

    await this._expectByte(Ascii.STX, 1000);
    while (true) {
      const b = await this._stream.readByte(1000);
      if (b === Ascii.ETX) break;
      this._log.write(String.fromCharCode(b));
    }
    this._log.writeLine();
  }

  // ─── User Commands ─────────────────────────────────────────────────────────

  async ping() {
    return this._withCommand(async () => {
      this._log.debugWriteLine('Synchronizing...');
      if (!await this._synchronize()) { this._log.writeLine('Sync failed.'); return; }
      this._log.write('Pinging... ');
      this._stream.writeByte(Ascii.SOH);
      this._stream.writeByte(Command.Ping);
      const r = await this._stream.tryReadByte(2500);
      if (r === Ascii.ACK) { this._log.writeLine('OK.'); }
      else if (r === Ascii.NAK) {
        const code = await this._stream.tryReadByte(2000);
        this._log.writeLine(`Failure: ${code ?? 'timeout'}`);
      } else { this._log.writeLine('No response.'); }
    });
  }

  /** @param {Uint8Array} fileData */
  async sendTapeFile(fileData) {
    return this._withCommand(async () => {
      const data = this._processTapeFile(new Uint8Array(fileData));
      if (!await this._synchronize()) throw new ArduinoError('Sync failed');
      this._log.writeLine(`Sending tape file; length: ${fileData.length}`);
      this._stream.writeByte(Ascii.SOH);
      this._stream.writeByte(Command.LoadTape);
      this._stream.writeWord(fileData.length);
      this._stream.writeByte(HEADER_SIZE);
      await this._readResponse();
      await this._sendBuffer(data);
      this._log.writeLine('Done.');
    });
  }

  /** @returns {Promise<Uint8Array>} */
  async readTapeFile() {
    return this._withCommand(async () => {
      if (!await this._synchronize()) throw new ArduinoError('Sync failed');
      this._log.writeLine('Waiting for CSAVE on pocket computer...');
      this._stream.writeByte(Ascii.SOH);
      this._stream.writeByte(Command.SaveTape);
      await this._readResponse();

      this._opAbort = new AbortController();
      this.onStateChange?.();
      try {
        const raw = await this._readFrame(this._opAbort.signal);
        return this._processTapeFile(raw);
      } finally {
        this._opAbort = null;
        this.onStateChange?.();
      }
    });
  }

  // ─── Tape Processing ───────────────────────────────────────────────────────

  _processTapeFile(data) {
    if (data.length < 8) return data;
    const out = new Uint8Array(data);
    const fmt = out[0];
    for (let i = 1; i <= 7; i++) out[i] = swapNibbles(out[i]);
    if ((fmt === 0x71 || fmt === 0x73) && data.length >= 18) {
      for (let i = 10; i <= 17; i++) out[i] = swapNibbles(out[i]);
    }
    return out;
  }

  // ─── Protocol Helpers ──────────────────────────────────────────────────────

  async _synchronize() {
    for (let i = 0; i < 10; i++) {
      this._stream.writeByte(Ascii.SYN);
      const r = await this._stream.tryReadByte(1000);
      if (r === Ascii.SYN) {
        // Drain any additional SYN echoes from earlier sends before returning.
        // We read with a short timeout; anything that isn't SYN goes back.
        while (true) {
          const extra = await this._stream.tryReadByte(80);
          if (extra === null) break;            // nothing more — clean
          if (extra !== Ascii.SYN) { this._stream.unreadByte(extra); break; }
        }
        return true;
      }
      if (r === Ascii.NAK) await this._stream.tryReadByte(1000); // consume error code
    }
    return false;
  }

  async _readResponse(timeoutMs = READ_TIMEOUT, signal) {
    const r = await this._stream.readByte(timeoutMs, signal);
    if (r === Ascii.ACK) return;
    if (r === Ascii.NAK) throw new ArduinoError(await this._stream.readByte(1000, signal));
    throw new ArduinoError(`Unexpected response: 0x${r.toString(16)}`);
  }

  async _readFrame(signal) {
    const start = await this._stream.readByte(signal);
    if (start === Ascii.NAK) throw new ArduinoError(await this._stream.readByte(2000, signal));
    if (start !== Ascii.STX) throw new ArduinoError(`Expected STX, got 0x${start.toString(16)}`);

    const buf = [];
    while (true) {
      let b = await this._stream.readByte(1000, signal);
      if (b === Ascii.DLE) {
        b = await this._stream.readByte(1000, signal);
      } else if (b === Ascii.NAK) {
        throw new ArduinoError(await this._stream.readByte(1000, signal));
      } else if (b === Ascii.CAN) {
        throw new ArduinoError(2); // Cancelled
      } else if (b === Ascii.ETX) {
        if (buf.length % 40 !== 0) this._log.writeLine();
        return new Uint8Array(buf);
      }
      buf.push(b);
      this._log.write('.');
      if (buf.length % 80 === 0) this._log.writeLine();
    }
  }

  async _sendBuffer(data, signal) {
    let offset = 0;
    while (offset < data.length) {
      const size = Math.min(BUFFER_SIZE, data.length - offset);
      for (let i = 0; i < size; i++) this._stream.writeByte(data[offset++]);
      await this._readResponse(READ_TIMEOUT, signal);
    }
  }

  async _sendDiskResponse(response, signal) {
    this._stream.writeByte(Ascii.SOH);
    this._stream.writeByte(Command.Disk);
    this._stream.writeByte(response.capture ? 0xFF : 0);
    this._stream.writeWord(response.data.length);
    await this._readResponse(READ_TIMEOUT, signal);
    await this._sendBuffer(response.data, signal);
  }

  async _expectByte(expected, timeoutMs) {
    const b = await this._stream.readByte(timeoutMs);
    if (b !== expected) throw new ArduinoError(`Expected 0x${expected.toString(16)}, got 0x${b.toString(16)}`);
  }
}
