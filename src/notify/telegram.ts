import { lstat, mkdtemp, rm } from "node:fs/promises";
import { matchCallMe } from "../call-intent";
export { classifyCallIntent } from "../call-intent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../logger";
import { TELEGRAM_TEXT_MAX_CHARS } from "./briefing";
import { confirmationDecision, isConfirmationNonce } from "../brain/approval";
import type { Brain } from "../types";
import { snapshotSynthesizedWav } from "../platform/wav";
import { BoundedCommandError, runBoundedCommand } from "../process/bounded-command";

/**
 * Telegram voice-note delivery for proactive notifications: the same clip the
 * browser speaks is sent as a voice note to a Telegram chat, so Cicero reaches
 * your phone even when no browser is open. Needs a bot token (BotFather) and
 * the target chat_id; wired through `notify.telegram` in config.
 */

export interface TelegramNotifyConfig {
  token?: string;      // bot token, literal
  token_env?: string;  // …or the env var holding it (preferred; default CICERO_TELEGRAM_TOKEN)
  chat_id?: string | number;
  /** The only Telegram account allowed to drive Cicero. Required for group
   * chats. In a private chat it can be omitted safely: Telegram makes the
   * sender id equal the chat id, which Cicero verifies on every update. */
  sender_user_id?: string | number;
  /** Send notifications as voice notes instead of plain text. Default false:
   * a text you can read at a glance beats a clip you must tap to play. */
  voice_note?: boolean;
}

export function telegramToken(cfg: TelegramNotifyConfig): string | null {
  if (cfg.token) return cfg.token;
  const envVar = cfg.token_env ?? "CICERO_TELEGRAM_TOKEN";
  return process.env[envVar] ?? null;
}

type TelegramUser = { id: string | number };
type TelegramChat = {
  id: string | number;
  type?: "private" | "group" | "supergroup" | "channel";
};
type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
};
type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};
export type TelegramUpdate = { update_id?: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery };

const TELEGRAM_HTTP_TIMEOUT_MS = 10_000;
const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 20;
const TELEGRAM_LONG_POLL_DEADLINE_MS = 25_000;
const TELEGRAM_MAX_ERROR_BYTES = 8 * 1024;
const TELEGRAM_MAX_UPDATE_BYTES = 1024 * 1024;
const TELEGRAM_FFMPEG_TIMEOUT_MS = 60_000;
const TELEGRAM_MAX_WAV_BYTES = 64 * 1024 * 1024;
const TELEGRAM_MAX_OGG_BYTES = 32 * 1024 * 1024;

export interface OggConversionOptions {
  /** Injectable executable/deadline/limits for deterministic command tests. */
  ffmpegBinary?: string;
  timeoutMs?: number;
  inputLimitBytes?: number;
  outputLimitBytes?: number;
}

interface RequestScope {
  signal: AbortSignal;
  cleanup: () => void;
}

function boundedRequestScope(timeoutMs: number, parent?: AbortSignal): RequestScope {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent?.reason ?? new Error("telegram poller stopped"));
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("telegram request deadline exceeded")), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function redactTelegramText(value: string, token: string): string {
  const withoutToken = token ? value.replaceAll(token, "[redacted]") : value;
  return withoutToken.replace(/\/bot[^/\s]+(?=\/)/gi, "/bot[redacted]");
}

function telegramErrorMessage(err: unknown, token: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactTelegramText(message, token).slice(0, 240);
}

async function readBoundedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`telegram response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`telegram response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err: unknown) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  return readBoundedBody(res, maxBytes).then((body) => new TextDecoder().decode(body));
}

async function discardResponse(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best effort: the response has already completed from the caller's view.
  }
}

function botUrl(api: string, token: string, method: string): string {
  return `${api}/bot${token}/${method}`;
}

async function postJson(
  cfg: TelegramNotifyConfig,
  method: string,
  body: Record<string, unknown>,
  api = "https://api.telegram.org",
): Promise<boolean> {
  const token = telegramToken(cfg);
  if (!token) return false;
  const scope = boundedRequestScope(TELEGRAM_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(botUrl(api, token, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: scope.signal,
    });
    if (!res.ok) {
      const text = await readBoundedText(res, TELEGRAM_MAX_ERROR_BYTES);
      log("warn", `telegram ${method} failed (${res.status}): ${redactTelegramText(text, token).slice(0, 160)}`);
      return false;
    }
    await discardResponse(res);
    return true;
  } catch (err: unknown) {
    log("warn", `telegram ${method} error: ${telegramErrorMessage(err, token)}`);
    return false;
  } finally {
    scope.cleanup();
  }
}

function chatMatches(cfg: TelegramNotifyConfig, chatId: string | number | undefined): boolean {
  return cfg.chat_id !== undefined && chatId !== undefined && String(cfg.chat_id) === String(chatId);
}

/**
 * Inbound Telegram is an administrative control surface, not merely a place
 * to deliver notifications. Match both the destination chat and the human
 * sender. Existing one-to-one bot chats migrate safely without another config
 * field because Telegram guarantees that a private chat id is the user's id;
 * groups fail closed unless sender_user_id is explicit.
 */
function inboundSenderMatches(
  cfg: TelegramNotifyConfig,
  chat: TelegramChat | undefined,
  senderId: string | number | undefined,
): boolean {
  if (!chatMatches(cfg, chat?.id) || senderId === undefined) return false;
  if (cfg.sender_user_id !== undefined) {
    return String(cfg.sender_user_id) === String(senderId);
  }
  return chat?.type === "private" && String(chat.id) === String(senderId);
}

const OGG_CAPTURE = [0x4f, 0x67, 0x67, 0x53] as const;
const OPUS_HEAD = new TextEncoder().encode("OpusHead");

/** Validate complete Ogg pages and the first Opus identification packet. */
function isCompleteOggOpus(bytes: Uint8Array): boolean {
  let offset = 0;
  let pages = 0;
  let hasOpusHead = false;

  while (offset < bytes.byteLength) {
    if (offset + 27 > bytes.byteLength) return false;
    if (!OGG_CAPTURE.every((byte, index) => bytes[offset + index] === byte)) return false;
    if (bytes[offset + 4] !== 0) return false;

    const headerType = bytes[offset + 5]!;
    const segmentCount = bytes[offset + 26]!;
    const payloadOffset = offset + 27 + segmentCount;
    if (payloadOffset > bytes.byteLength) return false;

    let payloadBytes = 0;
    for (let index = 0; index < segmentCount; index++) {
      payloadBytes += bytes[offset + 27 + index]!;
    }
    const pageEnd = payloadOffset + payloadBytes;
    if (pageEnd > bytes.byteLength) return false;

    if (pages === 0) {
      // A single audio-only ffmpeg output begins a fresh logical stream whose
      // first packet is the Opus identification header.
      if ((headerType & 0x02) === 0 || (headerType & 0x01) !== 0) return false;
      if (payloadBytes < OPUS_HEAD.byteLength) return false;
      hasOpusHead = OPUS_HEAD.every(
        (byte, index) => bytes[payloadOffset + index] === byte,
      );
    }

    pages += 1;
    offset = pageEnd;
  }

  return pages > 0 && hasOpusHead;
}

/**
 * Telegram voice notes must be OGG/Opus — convert the TTS WAV via bounded
 * stdin into a private temporary output. Throws with bounded diagnostics.
 */
export async function wavToOggOpus(
  wav: ArrayBuffer,
  options: OggConversionOptions = {},
): Promise<Uint8Array> {
  const inputLimitBytes = options.inputLimitBytes ?? TELEGRAM_MAX_WAV_BYTES;
  const outputLimitBytes = options.outputLimitBytes ?? TELEGRAM_MAX_OGG_BYTES;
  if (!Number.isSafeInteger(inputLimitBytes) || inputLimitBytes <= 0) {
    throw new RangeError("inputLimitBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new RangeError("outputLimitBytes must be a positive integer");
  }
  const audio = snapshotSynthesizedWav(wav).audio;

  const directory = await mkdtemp(join(tmpdir(), "cicero-telegram-ogg-"));
  const output = join(directory, "notify.ogg");
  try {
    let result: Awaited<ReturnType<typeof runBoundedCommand>>;
    try {
      result = await runBoundedCommand([
        options.ffmpegBinary ?? "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", "pipe:0",
        "-t", "300",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-f", "ogg",
        "-fs", String(outputLimitBytes),
        output,
      ], {
        stdin: new Uint8Array(audio),
        stdinLimitBytes: inputLimitBytes,
        timeoutMs: options.timeoutMs ?? TELEGRAM_FFMPEG_TIMEOUT_MS,
        stdoutLimitBytes: 0,
        stderrLimitBytes: 16 * 1024,
        totalLimitBytes: 16 * 1024,
        outputLimitBehavior: "error",
        stderrCapture: "tail",
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = error instanceof BoundedCommandError ? error.result.stderr.text.trim() : "";
      throw new Error(`ffmpeg wav→ogg failed: ${stderr ? `${message}: ${stderr}` : message}`, { cause: error });
    }

    if (result.exitCode !== 0) {
      throw new Error(`ffmpeg wav→ogg failed (exit ${result.exitCode}): ${result.stderr.text.trim() || "no diagnostics"}`);
    }
    const generated = await lstat(output).catch(() => null);
    if (!generated?.isFile() || generated.size === 0) {
      throw new Error("ffmpeg wav→ogg failed: no regular output file was produced");
    }
    if (generated.size > outputLimitBytes) {
      throw new Error(`ffmpeg wav→ogg failed: output exceeded ${outputLimitBytes} bytes`);
    }
    const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
    if (!isCompleteOggOpus(bytes)) {
      throw new Error("ffmpeg wav→ogg failed: output is not a complete OGG/Opus stream");
    }
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup of a private random directory after conversion.
    });
  }
}

/**
 * Send a notification as a Telegram voice note (with the text as caption).
 * Best-effort by design — callers fire-and-forget; failures log, never throw.
 * `api` is injectable for tests (default: real Bot API).
 */
export async function sendTelegramVoice(
  cfg: TelegramNotifyConfig,
  text: string,
  wav: ArrayBuffer,
  api = "https://api.telegram.org",
): Promise<boolean> {
  const token = telegramToken(cfg);
  if (!token || !cfg.chat_id) return false;
  let scope: RequestScope | null = null;
  try {
    const ogg = await wavToOggOpus(wav);
    const form = new FormData();
    form.append("chat_id", String(cfg.chat_id));
    form.append("caption", text.slice(0, 1024));
    form.append("voice", new Blob([ogg as BlobPart], { type: "audio/ogg" }), "notify.ogg");
    scope = boundedRequestScope(TELEGRAM_HTTP_TIMEOUT_MS);
    const res = await fetch(botUrl(api, token, "sendVoice"), {
      method: "POST",
      body: form,
      signal: scope.signal,
    });
    if (!res.ok) {
      const body = await readBoundedText(res, TELEGRAM_MAX_ERROR_BYTES);
      log("warn", `telegram notify failed (${res.status}): ${redactTelegramText(body, token).slice(0, 160)}`);
      return false;
    }
    await discardResponse(res);
    log("info", `telegram notify sent: "${text.slice(0, 60)}"`);
    return true;
  } catch (err: unknown) {
    log("warn", `telegram notify error: ${telegramErrorMessage(err, token)}`);
    return false;
  } finally {
    scope?.cleanup();
  }
}

/**
 * Send a notification as a plain Telegram text message — readable at a glance,
 * no tap-to-play. The default delivery; set `voice_note: true` for audio.
 * Best-effort like sendTelegramVoice: failures log, never throw.
 */
export async function sendTelegramText(
  cfg: TelegramNotifyConfig,
  text: string,
  api = "https://api.telegram.org",
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<boolean> {
  const token = telegramToken(cfg);
  if (!token || !cfg.chat_id) return false;
  const guardedText = text.slice(0, TELEGRAM_TEXT_MAX_CHARS);
  if (guardedText.length < text.length) {
    log(
      "warn",
      `telegram text transport guard truncated a message from ${text.length} to ${guardedText.length} characters`,
    );
  }
  const scope = boundedRequestScope(TELEGRAM_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(botUrl(api, token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(cfg.chat_id), text: guardedText, ...extra }),
      signal: signal ? AbortSignal.any([scope.signal, signal]) : scope.signal,
    });
    if (!res.ok) {
      const body = await readBoundedText(res, TELEGRAM_MAX_ERROR_BYTES);
      log("warn", `telegram notify failed (${res.status}): ${redactTelegramText(body, token).slice(0, 160)}`);
      return false;
    }
    await discardResponse(res);
    log("info", `telegram notify sent: "${text.slice(0, 60)}"`);
    return true;
  } catch (err: unknown) {
    log("warn", `telegram notify error: ${telegramErrorMessage(err, token)}`);
    return false;
  } finally {
    scope.cleanup();
  }
}

export function confirmationKeyboard(nonce: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  if (!isConfirmationNonce(nonce)) throw new Error("invalid confirmation nonce");
  return {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `cicero:confirm:yes:${nonce}` },
      { text: "❌ Deny", callback_data: `cicero:confirm:no:${nonce}` },
    ]],
  };
}

export async function sendTelegramConfirmation(
  cfg: TelegramNotifyConfig,
  text: string,
  nonce: string,
  api = "https://api.telegram.org",
): Promise<boolean> {
  try {
    return await sendTelegramText(cfg, text, api, { reply_markup: confirmationKeyboard(nonce) });
  } catch (err: unknown) {
    log("warn", `telegram confirmation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function answerTelegramCallback(
  cfg: TelegramNotifyConfig,
  callbackQueryId: string,
  text: string,
  api = "https://api.telegram.org",
): Promise<boolean> {
  return postJson(cfg, "answerCallbackQuery", { callback_query_id: callbackQueryId, text }, api);
}

export async function editTelegramMessageText(
  cfg: TelegramNotifyConfig,
  chatId: string | number,
  messageId: number,
  text: string,
  api = "https://api.telegram.org",
): Promise<boolean> {
  return postJson(cfg, "editMessageText", { chat_id: String(chatId), message_id: messageId, text }, api);
}

/**
 * Typed-input handlers beyond the confirmation gate. Since Jul 10 the Cicero
 * bot IS the office's text surface (the tgcall userbot is calls-only): fast
 * shapes are matched first ("log …" → the health record, "call me" → the
 * dialer), and any other text is a chat turn against the same brain the
 * voice surfaces reach. Without `onChat`, unmatched text is ignored — the
 * pre-Jul-10 non-chat behavior.
 */
export interface TelegramInputHandlers {
  /** "log <metric> [value] [unit] [note…]" → the health lane's record. Returns the ack line. */
  onHealthLog?: (metric: string, words: string[]) => Promise<string>;
  /** "call me" / "have ada call me" → ring the phone, optionally with a
   * specific employee on the line. `who` is the raw typed name (unresolved —
   * the handler owns lane lookup and the unknown-name reply). Returns the ack line. */
  onCallMe?: (who?: string) => Promise<string>;
  /** Any other text: a brain turn; the full reply comes back as text. */
  onChat?: (text: string) => Promise<string>;
}

const HEALTH_LOG_RE = /^log[:,]?\s+(\S+)(?:\s+([\s\S]+))?$/i;

export async function handleTelegramUpdate(
  update: TelegramUpdate,
  brain: Pick<Brain, "hasPendingConfirmation" | "pendingConfirmations" | "resolvePendingConfirmation">,
  cfg: TelegramNotifyConfig,
  api = "https://api.telegram.org",
  handlers?: TelegramInputHandlers,
): Promise<boolean> {
  const cb = update.callback_query;
  if (cb?.data?.startsWith("cicero:confirm:")) {
    const msg = cb.message;
    if (!inboundSenderMatches(cfg, msg?.chat, cb.from?.id)) {
      await answerTelegramCallback(cfg, cb.id, "not authorized", api);
      return true;
    }
    const confirm = /^cicero:confirm:(yes|no):([^:]+)$/.exec(cb.data);
    const nonce = confirm?.[2];
    if (!confirm || !nonce || !isConfirmationNonce(nonce)) {
      await answerTelegramCallback(cfg, cb.id, "invalid approval", api);
      return true;
    }
    const approved = confirm[1] === "yes";
    const resolved = brain.resolvePendingConfirmation?.(approved, nonce) ?? false;
    if (!resolved) {
      await answerTelegramCallback(cfg, cb.id, "nothing pending", api);
      return true;
    }
    await answerTelegramCallback(cfg, cb.id, approved ? "Approved" : "Denied", api);
    if (msg) await editTelegramMessageText(cfg, msg.chat.id, msg.message_id, approved ? "✅ Approved" : "❌ Denied", api);
    return true;
  }

  const msg = update.message;
  if (!msg?.text || !inboundSenderMatches(cfg, msg.chat, msg.from?.id)) return false;
  const text = msg.text.trim();

  // Fast shapes first — deterministic, instant, no brain turn.
  // "log calories 650 chicken bowl": the health record, from anywhere Telegram is.
  // Checked before the confirmation branch so a pending gate can't swallow a
  // log line (and "log …" is never a yes/no).
  if (handlers?.onHealthLog) {
    const m = HEALTH_LOG_RE.exec(text);
    if (m) {
      try {
        const ack = await handlers.onHealthLog(m[1]!, m[2]?.trim().split(/\s+/) ?? []);
        await sendTelegramText(cfg, `🩺 ${ack}`, api);
      } catch (err: unknown) {
        await sendTelegramText(cfg, `health log failed: ${err instanceof Error ? err.message : String(err)}`, api);
      }
      return true;
    }
  }

  // "call me" / "have ada call me": ring the phone — the bot-side twin of
  // the userbot's dial-back, optionally routing who answers.
  if (handlers?.onCallMe) {
    const call = matchCallMe(text);
    if (call) {
      try {
        await sendTelegramText(cfg, await handlers.onCallMe(call.who), api);
      } catch (err: unknown) {
        await sendTelegramText(cfg, `dial-back failed: ${err instanceof Error ? err.message : String(err)}`, api);
      }
      return true;
    }
  }

  // Typed yes/no while an approval gate is pending. Free-form text has no
  // embedded capability, so it may bind only when exactly one nonce is visible.
  const pending = brain.pendingConfirmations?.() ?? [];
  if (pending.length > 0 || (brain.hasPendingConfirmation?.() ?? false)) {
    const typed = confirmationDecision(text);
    if (typed !== null) {
      if (pending.length !== 1) {
        await sendTelegramText(cfg, "⚠️ I can't safely match that response. Use the matching approval button.", api);
        return true;
      }
      const resolved = brain.resolvePendingConfirmation?.(typed, pending[0]!.nonce) ?? false;
      // Typed approvals get a text ack — without it the chat shows no evidence
      // the decision landed (buttons get theirs via the message edit).
      await sendTelegramText(
        cfg,
        resolved ? typed ? "✅ Approved." : "❌ Denied." : "That approval is no longer pending.",
        api,
      );
      return true;
    }
  }

  // Everything else is a chat turn — the same office the voice surfaces reach,
  // reply as text (no TTS, no TLDR gate), split at Telegram's message cap.
  if (handlers?.onChat) {
    let reply: string;
    try {
      reply = (await handlers.onChat(text)).trim() || "(no reply)";
    } catch (err: unknown) {
      reply = `(Cicero unreachable: ${err instanceof Error ? err.message : String(err)})`;
    }
    for (let i = 0; i < reply.length; i += 4000) {
      await sendTelegramText(cfg, reply.slice(i, i + 4000), api);
    }
    return true;
  }
  return false;
}

export interface TelegramPollerOptions {
  /** Test/integration override; production long polls use a 25 second deadline. */
  requestDeadlineMs?: number;
  /** Test/integration override; production update bodies are capped at 1 MiB. */
  maxResponseBytes?: number;
}

type TelegramPollResult =
  | { ok: true; updates: TelegramUpdate[] }
  | { ok: false };

function parseTelegramUpdates(text: string): TelegramUpdate[] {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("telegram response is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.result)) {
    throw new Error("telegram response did not contain an update list");
  }
  const updates: TelegramUpdate[] = [];
  for (const candidate of record.result) {
    if (typeof candidate !== "object" || candidate === null) throw new Error("telegram update is not an object");
    const update = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) {
      throw new Error("telegram update is missing a valid update_id");
    }
    updates.push(candidate as TelegramUpdate);
  }
  return updates;
}

async function fetchTelegramUpdates(
  api: string,
  token: string,
  offset: number | undefined,
  flushPending: boolean,
  lifecycle: AbortSignal,
  options: TelegramPollerOptions,
): Promise<TelegramPollResult> {
  const url = new URL(botUrl(api, token, "getUpdates"));
  if (flushPending) {
    // Telegram's negative offset returns only the newest queued update and
    // forgets everything before it. Discarding this bootstrap response keeps
    // a daemon restart from executing hours-old commands or approvals.
    url.searchParams.set("offset", "-1");
    url.searchParams.set("limit", "1");
    url.searchParams.set("timeout", "0");
  } else {
    if (offset !== undefined) url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "100");
    url.searchParams.set("timeout", String(TELEGRAM_LONG_POLL_TIMEOUT_SECONDS));
  }
  url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));

  const scope = boundedRequestScope(options.requestDeadlineMs ?? TELEGRAM_LONG_POLL_DEADLINE_MS, lifecycle);
  try {
    const res = await fetch(url, { signal: scope.signal });
    if (!res.ok) {
      const body = await readBoundedText(res, TELEGRAM_MAX_ERROR_BYTES);
      log("warn", `telegram getUpdates failed (${res.status}): ${redactTelegramText(body, token).slice(0, 160)}`);
      return { ok: false };
    }
    const text = await readBoundedText(res, options.maxResponseBytes ?? TELEGRAM_MAX_UPDATE_BYTES);
    return { ok: true, updates: parseTelegramUpdates(text) };
  } catch (err: unknown) {
    if (!lifecycle.aborted) {
      log("warn", `telegram poll error: ${telegramErrorMessage(err, token)}`);
    }
    return { ok: false };
  } finally {
    scope.cleanup();
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function startTelegramUpdatePoller(
  cfg: TelegramNotifyConfig,
  brain: Pick<Brain, "hasPendingConfirmation" | "pendingConfirmations" | "resolvePendingConfirmation">,
  api = "https://api.telegram.org",
  pollMs = 2000,
  handlers?: TelegramInputHandlers,
  options: TelegramPollerOptions = {},
): () => void {
  const token = telegramToken(cfg);
  if (!token || !cfg.chat_id) return () => {};
  if (cfg.sender_user_id === undefined) {
    log("info", "telegram sender_user_id is unset; only a verified private chat whose user id equals chat_id can control Cicero");
  }

  const lifecycle = new AbortController();
  const loop = async (): Promise<void> => {
    try {
      let offset: number | undefined;
      let pendingFlushed = false;
      while (!lifecycle.signal.aborted) {
        const result = await fetchTelegramUpdates(
          api,
          token,
          offset,
          !pendingFlushed,
          lifecycle.signal,
          options,
        );
        if (lifecycle.signal.aborted) break;
        if (!result.ok) {
          await abortableDelay(pollMs, lifecycle.signal);
          continue;
        }

        if (!pendingFlushed) {
          pendingFlushed = true;
          if (result.updates.length > 0) {
            offset = Math.max(...result.updates.map((update) => update.update_id!)) + 1;
            log("info", `telegram discarded ${result.updates.length} pending update(s) at startup`);
          }
          continue;
        }

        for (const update of result.updates) {
          if (lifecycle.signal.aborted) break;
          offset = Math.max(offset ?? 0, update.update_id! + 1);
          try {
            await handleTelegramUpdate(update, brain, cfg, api, handlers);
          } catch (err: unknown) {
            log("warn", `telegram update ${update.update_id} failed: ${telegramErrorMessage(err, token)}`);
          }
        }
      }
    } catch (err: unknown) {
      if (!lifecycle.signal.aborted) {
        log("warn", `telegram poller stopped unexpectedly: ${telegramErrorMessage(err, token)}`);
      }
    }
  };
  loop().catch((err: unknown) => {
    if (!lifecycle.signal.aborted) {
      log("warn", `telegram poller failure: ${telegramErrorMessage(err, token)}`);
    }
  });
  return () => {
    if (!lifecycle.signal.aborted) lifecycle.abort(new Error("telegram poller stopped"));
  };
}
