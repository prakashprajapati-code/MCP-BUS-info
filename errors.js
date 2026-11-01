"use strict";

/** Shared error type so both data paths report failures the same way. */
class GsrtcError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "GsrtcError";
    this.hint = hint;
  }
}

/** Only used by the optional `GSRTC_MODE=http` fallback. */
const START_HINT = "Start the wrapper and set GSRTC_API_URL to its address.";

module.exports = { GsrtcError, START_HINT };
