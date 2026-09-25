import whisperCodes from "../../../servers/whisper_language_codes.json";

// Deliberately a small BCP-47 subset: primary language, optional script, and
// optional region. The tag is preserved for audio.cpp; Whisper takes the code.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?$/;
const WHISPER_CODES = new Set<string>(whisperCodes);

export function isSttLanguageTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && LANGUAGE_TAG.test(value);
}

export function whisperLanguageCode(tag: string): string {
  return tag.split("-", 1)[0]!.toLowerCase();
}

export function isWhisperLanguageCode(code: string): boolean {
  return WHISPER_CODES.has(code);
}
