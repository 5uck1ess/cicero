import { join } from "node:path";
// @ts-expect-error qrcode 1.5.4 does not ship TypeScript declarations.
import QRCode from "qrcode";
import { loadConfig, setWebVoiceToken } from "../config";
import { ciceroHome } from "../platform/paths";
import { readPairingState, webVoicePairingStatePath, type PairingState } from "../web-voice/pairing-state";
import { webVoiceTokenProblem } from "../web-voice/startup-policy";

export interface PairOptions {
  tokenInQr?: boolean;
}

interface PairFallback {
  scheme: "http" | "https";
  port: number;
}

export interface PairingUrlSelection {
  baseUrl: string;
  note?: string;
}

export interface PairDependencies {
  home?: string;
  generateToken?: () => string;
  readState?: (path: string) => PairingState | null;
  renderQr?: (value: string, options: { type: "terminal"; small: true }) => Promise<string>;
}

export interface PairResult {
  output: string;
  qrValue: string;
  tokenGenerated: boolean;
}

/** Public origin precedence shared by the CLI and focused URL-selection tests. */
export function selectPairingUrl(
  state: PairingState | null,
  fallback: PairFallback = { scheme: "https", port: 8090 },
): PairingUrlSelection {
  if (state?.tunnelUrl) return { baseUrl: `${state.tunnelUrl.replace(/\/$/, "")}/` };
  if (state?.lanHost) return { baseUrl: `${state.scheme}://${state.lanHost}:${state.port}/` };
  return {
    baseUrl: `${fallback.scheme}://<this-box-ip>:${fallback.port}/`,
    note: "No live pairing state is available; replace <this-box-ip> with this machine's LAN IP after the daemon starts.",
  };
}

function withToken(baseUrl: string, token: string): string {
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

/** Build one complete, testable phone-pairing transcript. */
export async function pairPhone(
  options: PairOptions = {},
  dependencies: PairDependencies = {},
): Promise<PairResult> {
  const home = dependencies.home ?? ciceroHome();
  const configPath = join(home, "config.yaml");
  const config = loadConfig({}, { home, allowInvalidWebVoiceToken: true });
  const webVoice = config.web_voice;
  if (!webVoice?.enabled) {
    throw new Error("Web voice is disabled. Set web_voice.enabled: true in ~/.cicero/config.yaml, then retry cicero pair.");
  }

  const configuredToken = webVoice.token;
  const tokenNeedsWrite = webVoiceTokenProblem(configuredToken) !== null;
  const token = tokenNeedsWrite
    ? (dependencies.generateToken ?? (() => crypto.randomUUID()))()
    : configuredToken!.trim();
  if (tokenNeedsWrite) setWebVoiceToken(token, configPath);

  let state: PairingState | null = null;
  let stateNote: string | undefined;
  try {
    state = (dependencies.readState ?? readPairingState)(webVoicePairingStatePath(home));
  } catch (error: unknown) {
    stateNote = `Published pairing state could not be used: ${error instanceof Error ? error.message : String(error)}.`;
  }
  const selection = selectPairingUrl(state, {
    scheme: webVoice.tls?.enabled === false ? "http" : "https",
    port: webVoice.port ?? 8090,
  });
  const tokenInQr = options.tokenInQr !== false;
  const qrValue = tokenInQr ? withToken(selection.baseUrl, token) : selection.baseUrl;
  const renderQr = dependencies.renderQr
    ?? ((value: string, qrOptions: { type: "terminal"; small: true }) => QRCode.toString(value, qrOptions));
  const qr = await renderQr(qrValue, { type: "terminal", small: true });

  const lines = ["", "Cicero phone pairing", ""];
  if (tokenNeedsWrite) {
    lines.push("Generated a stable web token and saved it to ~/.cicero/config.yaml.");
    lines.push("Restart the Cicero daemon to load the new stable token.", "");
  }
  lines.push(`Pairing URL: ${qrValue}`, "", qr.trimEnd(), "");
  if (tokenInQr) {
    lines.push("Warning: this QR contains a live credential. Treat it like a password.");
  } else {
    lines.push(`Token (type this on the phone): ${token}`);
    lines.push("The QR omits the credential. Treat the token like a password.");
  }
  if (selection.note) lines.push(selection.note);
  if (stateNote) lines.push(stateNote);
  if (state?.tunnelProvider === "cloudflared") {
    lines.push("Cloudflared quick-tunnel URLs change each daemon run; re-run cicero pair after a restart.");
  } else if (state?.tunnelProvider === "tailscale") {
    lines.push("Tailscale hostnames are stable across daemon restarts.");
  }
  if (!webVoice.tunnel) {
    lines.push("", "Add this line under web_voice: for a daemon-owned tunnel:", "  tunnel: { provider: auto }");
  }
  lines.push("");
  return { output: lines.join("\n"), qrValue, tokenGenerated: tokenNeedsWrite };
}

export async function runPair(options: PairOptions = {}): Promise<void> {
  const result = await pairPhone(options);
  process.stdout.write(result.output);
}
