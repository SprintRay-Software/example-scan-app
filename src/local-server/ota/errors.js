// The two ways an OTA call goes wrong, kept apart because the contract reports them differently:
//
//   OtaRequestError  the POST itself is refused — HTTP 4xx/503 with { error: { code, message } },
//                    and the last /update/status is left as it was.
//   OtaFailure       the step was accepted and later failed — /update/status turns `failed` with
//                    `error: { code, message }`; the POST had already answered 200.

export class OtaRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'OtaRequestError';
    this.status = status;
    this.code = code;
  }
}

export class OtaFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OtaFailure';
    this.code = code;
  }
}

// The step was abandoned because the simulated process went away (close / restart), not because
// it failed. Nothing is written: the next service finds whatever was persisted last, as after a kill.
export class OtaAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'OtaAborted';
  }
}
