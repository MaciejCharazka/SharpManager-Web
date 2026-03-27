import { TimeoutError } from './errors.js';

/**
 * Wraps a Web Serial port with an async byte-at-a-time read interface.
 * Bytes are pumped from port.readable into an internal queue.
 */
export class ByteStream {
  /** @param {SerialPort} port */
  constructor(port) {
    this._queue = [];
    this._waiters = []; // {resolve, reject, timer}
    this._closed = false;
    this._reader = port.readable.getReader();
    this._writer = port.writable.getWriter();
    this._readLoop();
  }

  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this._reader.read();
        if (done) break;
        for (const byte of value) this._dispatch(byte);
      }
    } catch {
      // port closed
    } finally {
      this._closed = true;
      const err = new Error('Serial port closed');
      for (const w of this._waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this._waiters = [];
    }
  }

  _dispatch(byte) {
    if (this._waiters.length > 0) {
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.resolve(byte);
    } else {
      this._queue.push(byte);
    }
  }

  /**
   * Read one byte. timeoutMs optional, signal optional.
   * Throws TimeoutError on timeout, DOMException on abort.
   * @param {number|AbortSignal} [timeoutOrSignal]
   * @param {AbortSignal} [signal]
   * @returns {Promise<number>}
   */
  readByte(timeoutOrSignal, signal) {
    let timeoutMs, sig;
    if (typeof timeoutOrSignal === 'number') { timeoutMs = timeoutOrSignal; sig = signal; }
    else { sig = timeoutOrSignal; }

    if (this._queue.length > 0) return Promise.resolve(this._queue.shift());
    if (this._closed) return Promise.reject(new Error('Serial port closed'));

    return new Promise((resolve, reject) => {
      if (sig?.aborted) { reject(sig.reason ?? new DOMException('Aborted', 'AbortError')); return; }

      const entry = { resolve, reject, timer: undefined };
      this._waiters.push(entry);

      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const i = this._waiters.indexOf(entry);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new TimeoutError());
        }, timeoutMs);
      }

      if (sig) {
        const onAbort = () => {
          clearTimeout(entry.timer);
          const i = this._waiters.indexOf(entry);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        sig.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Read byte, return null on timeout instead of throwing. */
  async tryReadByte(timeoutMs, signal) {
    try { return await this.readByte(timeoutMs, signal); }
    catch (e) { if (e instanceof TimeoutError) return null; throw e; }
  }

  /**
   * Put a byte back. If a reader is already waiting, give it directly;
   * otherwise prepend to the queue so it's the next byte returned.
   */
  unreadByte(byte) {
    if (this._waiters.length > 0) {
      const w = this._waiters.shift();
      clearTimeout(w.timer);
      w.resolve(byte);
    } else {
      this._queue.unshift(byte);
    }
  }

  writeByte(value) {
    this._writer.write(new Uint8Array([value & 0xFF]));
  }

  writeWord(value) {
    this._writer.write(new Uint8Array([value & 0xFF, (value >> 8) & 0xFF]));
  }

  clearBuffer() {
    this._queue = [];
  }

  async close() {
    try { await this._reader.cancel(); } catch {}
    try { this._writer.releaseLock(); } catch {}
  }
}
