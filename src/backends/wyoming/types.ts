// Wyoming protocol wire types.
// Spec: https://github.com/rhasspy/wyoming — newline-delimited JSON header,
// optional extra-JSON ("data") chunk, optional binary payload.

/** A parsed Wyoming event: header type + merged data + optional binary payload. */
export interface WyomingEvent {
  type: string;
  data?: Record<string, unknown>;
  payload?: Uint8Array;
  version?: string;
}

/** The JSON header object as it appears on the first line of an event. */
export interface WyomingHeader {
  type: string;
  data?: Record<string, unknown>;
  data_length?: number | null;
  payload_length?: number | null;
  version?: string;
}

/** Known event type strings used across STT / TTS / wake-word pipelines. */
export const WyomingEventType = {
  Describe: "describe",
  Info: "info",
  AudioStart: "audio-start",
  AudioChunk: "audio-chunk",
  AudioStop: "audio-stop",
  Transcribe: "transcribe",
  Transcript: "transcript",
  Synthesize: "synthesize",
  Audio: "audio",
  Detect: "detect",
  Detection: "detection",
  NotDetected: "not-detected",
} as const;
