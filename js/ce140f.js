// CE-140F floppy drive emulator using File System Access API

const MAX_HANDLES = 6;

/** Build a framed response: [0x00, ...data, checksum] */
function toFrame(data) {
  const arr = [0, ...data];
  const cs = arr.reduce((s, b) => (s + b) & 0xFF, 0);
  arr.push(cs);
  return new Uint8Array(arr);
}

/** Simple 1-byte result: 0x00=ok, 0xFF=error */
function result(ok) { return new Uint8Array([ok ? 0 : 0xFF]); }

/** 3-byte little-endian size */
function sizeBytes(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF]; }

/** ASCII string to byte array */
function strBytes(s) { return Array.from(s).map(c => c.charCodeAt(0)); }

/** Read ASCII string from Uint8Array at offset, length */
function readStr(data, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[offset + i]);
  return s.replace(/ /g, '');
}

/** Format filename as "X:NAME    .EXT " (Sharp 8.3 format) */
function formatFileName(name) {
  const dot = name.lastIndexOf('.');
  let base = dot >= 0 ? name.slice(0, dot) : name;
  let ext  = dot >= 0 ? name.slice(dot + 1) : '';
  base = (base.length > 8 ? base.slice(0, 8) : base.padEnd(8, ' '));
  ext  = (ext.length  > 3 ? ext.slice(0, 3)  : ext.padEnd(3, ' '));
  return `X:${base}.${ext} `;
}

export class CE140F {
  constructor(log) {
    this._log = log;
    this._dir = null;       // FileSystemDirectoryHandle
    this._files = [];
    this._fileIdx = 0;
    this._readBuf = null;   // Uint8Array for current LOAD file
    this._readPos = 0;
    this._writeName = null; // filename for current SAVE
    this._writeBuf = [];    // byte[] accumulator
    this._writeSize = 0;    // expected binary size
    this._nextCmd = 'none'; // 'none'|'textSave'|'binarySave'|'print'
    // Numbered file handles: {name, mode, readBuf, readPos, writeBuf}
    this._handles = Array(MAX_HANDLES).fill(null);
    this._printHandle = null; // active handle for PRINT command
  }

  setDirectory(handle) {
    this._dir = handle;
  }

  reset() {
    this._files = [];
    this._fileIdx = 0;
    this._readBuf = null;
    this._readPos = 0;
    this._writeName = null;
    this._writeBuf = [];
    this._writeSize = 0;
    this._nextCmd = 'none';
    this._handles = Array(MAX_HANDLES).fill(null);
    this._printHandle = null;
  }

  async processCommand(data) {
    const responseData = await this._dispatch(data);
    return { data: responseData, capture: this._nextCmd !== 'none' };
  }

  async _dispatch(data) {
    // Handle continuation commands (data packets after setup commands)
    if (this._nextCmd !== 'none') {
      const cmd = this._nextCmd;
      this._nextCmd = 'none';
      if (cmd === 'textSave')   return this._saveWriteLine(data);
      if (cmd === 'binarySave') return this._saveWriteBinary(data);
      if (cmd === 'print')      return this._printWrite(data);
    }

    this._log.debugWrite(`Disk #${data[0].toString(16).padStart(2,'0')} `);

    switch (data[0]) {
      case 0x05: return await this._filesInit();
      case 0x06: return this._filesItem(false);
      case 0x07: return this._filesItem(true);
      case 0x0E: return await this._loadOpen(data);
      case 0x17: return this._loadReadByte();
      case 0x12: return this._loadReadLine();
      case 0x0F: return this._loadBinary();
      case 0x1D: return this._diskFree(data);
      case 0x10: return await this._saveOpen(data);
      case 0x11: return this._saveBinary(data);
      case 0x16: return this._saveText();
      case 0x03: return await this._open(data);
      case 0x04: return await this._close(data);
      case 0x0A: return this._kill(data);
      case 0x13: case 0x14: case 0x20: return this._input(data);
      case 0x15: return this._print(data);
      default:
        this._log.writeLine(`Unknown disk command 0x${data[0].toString(16)}`);
        return new Uint8Array([0xFF, 0]);
    }
  }

  // --- FILES ---

  async _filesInit() {
    this._log.writeLine('FILES');
    this._fileIdx = 0;
    this._files = [];
    if (this._dir) {
      for await (const [name, entry] of this._dir.entries()) {
        if (entry.kind === 'file') this._files.push(name);
      }
    }
    return toFrame([this._files.length]);
  }

  _filesItem(previous) {
    this._log.writeLine('FILES ' + (previous ? '<Prev>' : '<Next>'));
    if (this._files.length === 0) return new Uint8Array([0xFF, 0]);
    const name = formatFileName(this._files[this._fileIdx]);
    const r = strBytes(name);
    this._fileIdx += previous ? -1 : 1;
    this._fileIdx = Math.max(0, Math.min(this._files.length - 1, this._fileIdx));
    return toFrame(r);
  }

  // --- LOAD ---

  async _loadOpen(data) {
    const name = readStr(data, 3, 12);
    this._log.writeLine(`LOAD "${name}"`);
    const r = [...strBytes(' ')];
    if (!this._dir) {
      this._log.writeLine('No disk directory selected.');
      r.push(...sizeBytes(0));
      return toFrame(r);
    }
    try {
      const fh = await this._dir.getFileHandle(name);
      const file = await fh.getFile();
      this._readBuf = new Uint8Array(await file.arrayBuffer());
      this._readPos = 0;
      r.push(...sizeBytes(this._readBuf.length));
    } catch {
      this._log.writeLine(`File not found: ${name}`);
      r.push(...sizeBytes(0));
    }
    return toFrame(r);
  }

  _loadReadByte() {
    if (!this._readBuf || this._readPos >= this._readBuf.length)
      return new Uint8Array([0xFF, 0]);
    return toFrame([this._readBuf[this._readPos++]]);
  }

  _loadReadLine() {
    const line = [];
    if (this._readBuf) {
      while (this._readPos < this._readBuf.length) {
        const b = this._readBuf[this._readPos++];
        if (b === 0x0A) continue;   // skip LF
        line.push(b);
        if (b === 0x0D) break;       // CR ends line
      }
    }
    if (line.length === 0 || this._readPos >= (this._readBuf?.length ?? 0)) {
      line.push(0x1A);  // EOF
      this._readBuf = null;
    }
    // Format: frame(line) + trailing 0
    const framed = [0, ...line];
    const cs = framed.reduce((s, b) => (s + b) & 0xFF, 0);
    framed.push(cs);
    framed.push(0);
    return new Uint8Array(framed);
  }

  _loadBinary() {
    this._log.debugWriteLine('Load binary');
    const r = [0];
    if (this._readBuf) {
      let offset = 0;
      while (offset < this._readBuf.length) {
        const sz = Math.min(256, this._readBuf.length - offset);
        const block = this._readBuf.slice(offset, offset + sz);
        r.push(...block);
        r.push(block.reduce((s, b) => (s + b) & 0xFF, 0));
        offset += sz;
      }
    }
    r.push(0);
    this._readBuf = null;
    return new Uint8Array(r);
  }

  // --- DISK FREE ---

  _diskFree(data) {
    const drive = data[1];
    const free = 65000;
    this._log.writeLine(`DSKF(${drive}) = ${free}`);
    return toFrame(sizeBytes(free));
  }

  // --- SAVE ---

  async _saveOpen(data) {
    const name = readStr(data, 3, 12);
    this._log.writeLine(`SAVE "${name}"`);
    if (!this._dir) { this._log.writeLine('No disk directory selected.'); return result(false); }
    this._writeName = name;
    this._writeBuf = [];
    return result(true);
  }

  _saveBinary(data) {
    this._writeSize = data[2] + (data[3] << 8) + (data[4] << 16);
    this._log.debugWriteLine(`Save binary (size ${this._writeSize})`);
    this._nextCmd = 'binarySave';
    return result(true);
  }

  _saveText() {
    this._log.debugWriteLine('Save text');
    this._nextCmd = 'textSave';
    return result(true);
  }

  async _saveWriteLine(data) {
    if (!this._writeName) return result(false);
    if (data[0] === 0x1A) {
      // EOF
      await this._flushWriteFile(this._writeName, this._writeBuf);
      this._writeName = null;
      this._writeBuf = [];
      return result(true);
    }
    // Append bytes (last byte is checksum, skip it)
    for (let i = 0; i < data.length - 1; i++) this._writeBuf.push(data[i]);
    this._nextCmd = 'textSave';
    return result(true);
  }

  async _saveWriteBinary(data) {
    if (!this._writeName) return result(false);
    for (let i = 0; i < data.length - 1; i++) this._writeBuf.push(data[i]);
    if (this._writeBuf.length >= this._writeSize) {
      await this._flushWriteFile(this._writeName, this._writeBuf);
      this._writeName = null;
      this._writeBuf = [];
    } else {
      this._nextCmd = 'binarySave';
    }
    return result(true);
  }

  async _flushWriteFile(name, buf) {
    if (!this._dir) return;
    try {
      const fh = await this._dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(new Uint8Array(buf));
      await w.close();
      this._log.writeLine('Done.');
    } catch (e) {
      this._log.writeLine(`Write error: ${e.message}`);
    }
  }

  // --- OPEN / CLOSE (numbered file handles) ---

  async _open(data) {
    if (!this._dir) { this._log.writeLine('No disk directory selected.'); return result(false); }
    const name = readStr(data, 3, 12);
    const mode = data[15];   // 1=input, 2=output, 3=append
    const fnum = data[16];
    const idx  = fnum - 2;
    const modeStr = ['','INPUT','OUTPUT','APPEND'][mode] ?? '?';
    this._log.writeLine(`OPEN "${name}" FOR ${modeStr} AS #${fnum}`);
    if (idx < 0 || idx >= MAX_HANDLES) return result(false);
    if (this._handles[idx]) this._handles[idx] = null;
    try {
      let readBuf = null, writeBuf = [];
      if (mode === 1) {
        const fh = await this._dir.getFileHandle(name);
        const file = await fh.getFile();
        readBuf = new Uint8Array(await file.arrayBuffer());
      } else if (mode === 3) {
        // Append: pre-read existing content
        try {
          const fh = await this._dir.getFileHandle(name);
          const file = await fh.getFile();
          writeBuf = Array.from(new Uint8Array(await file.arrayBuffer()));
        } catch {} // file may not exist yet
      }
      this._handles[idx] = { name, mode, readBuf, readPos: 0, writeBuf };
    } catch (e) {
      this._log.writeLine(`Open error: ${e.message}`);
      return result(false);
    }
    return result(true);
  }

  async _close(data) {
    const fnum = data[1];
    if (fnum === 0xFF) {
      this._log.writeLine('CLOSE <All>');
      for (let i = 0; i < MAX_HANDLES; i++) {
        if (this._handles[i]) await this._flushHandle(i);
        this._handles[i] = null;
      }
    } else {
      this._log.writeLine(`CLOSE #${fnum}`);
      const idx = fnum - 2;
      if (idx >= 0 && idx < MAX_HANDLES) {
        await this._flushHandle(idx);
        this._handles[idx] = null;
      }
    }
    return result(true);
  }

  async _flushHandle(idx) {
    const h = this._handles[idx];
    if (!h || h.mode === 1 || !this._dir) return;
    await this._flushWriteFile(h.name, h.writeBuf);
  }

  // --- INPUT ---

  _input(data) {
    const fnum = data[1];
    const idx  = fnum - 2;
    this._log.writeLine(`INPUT #${fnum}`);
    if (idx < 0 || idx >= MAX_HANDLES || !this._handles[idx]) return result(false);
    const h = this._handles[idx];
    if (!h.readBuf) return result(false);
    const line = [];
    while (h.readPos < h.readBuf.length) {
      const b = h.readBuf[h.readPos++];
      line.push(b);
      if (b === 0x0A) break;
    }
    // Format: [line..., 0x00] framed + trailing 0
    line.push(0);
    const framed = [0, ...line];
    const cs = framed.reduce((s, b) => (s + b) & 0xFF, 0);
    framed.push(cs);
    framed.push(0);
    return new Uint8Array(framed);
  }

  // --- PRINT to file ---

  _print(data) {
    const fnum = data[1];
    const idx  = fnum - 2;
    this._log.writeLine(`PRINT #${fnum}`);
    if (idx < 0 || idx >= MAX_HANDLES || !this._handles[idx]) return result(false);
    const h = this._handles[idx];
    if (h.mode === 1) return result(false);
    this._printHandle = h;
    this._nextCmd = 'print';
    return result(true);
  }

  _printWrite(data) {
    if (!this._printHandle) return result(false);
    // Skip CRLF-only messages
    if (data[0] === 0x0D && data[1] === 0x0A) return result(true);
    // Write data, ignore last 2 bytes (null + checksum)
    for (let i = 0; i < data.length - 2; i++) this._printHandle.writeBuf.push(data[i]);
    // Append CRLF if not already present
    if (data[data.length - 3] !== 0x0A) {
      this._printHandle.writeBuf.push(0x0D, 0x0A);
    }
    return result(true);
  }

  // --- KILL ---

  _kill(data) {
    const name = readStr(data, 3, 12);
    this._log.writeLine(`KILL "${name}" (not implemented)`);
    return result(false);
  }
}
