const ERROR_NAMES = {
  0: 'Ok', 1: 'Timeout', 2: 'Cancelled',
  3: 'Unexpected', 4: 'Overflow', 5: 'SyncError', 255: 'End',
};

export class ArduinoError extends Error {
  constructor(codeOrMessage) {
    super(typeof codeOrMessage === 'number'
      ? (ERROR_NAMES[codeOrMessage] ?? `ErrorCode(${codeOrMessage})`)
      : codeOrMessage);
    this.name = 'ArduinoError';
  }
}

export class TimeoutError extends Error {
  constructor(msg = 'Timed out') { super(msg); this.name = 'TimeoutError'; }
}
