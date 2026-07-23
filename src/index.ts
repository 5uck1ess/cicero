#!/usr/bin/env bun
import { Command } from "commander";
import { loadConfig, ensureConfigDir } from "./config";
import { CiceroDaemon, type DaemonOptions } from "./daemon";
import { logBanner } from "./logger";
import { registerVoiceCommand } from "./cli/voice";
import { ciceroPath } from "./platform/paths";
import { createAudioPlayer } from "./platform/audio";
import { writeSecureTempAudio } from "./platform/secure-temp-audio";
import { SystemSpeaker } from "./platform/system-tts";
import { runUntilShutdown } from "./process-lifecycle";
import { resolve } from "node:path";
import { inspectDaemonPidFile, stopDaemonFromPidFile } from "./daemon-pid";
import {
  describeSpeechError,
  preserveSpeechSignalTermination,
  renderConfiguredSpeech,
  SpeechInterruptedError,
} from "./cli/speak";
import { sendWebVoiceNotification } from "./cli/notify";
import { commandText } from "./cli/text-input";
import { unlink } from "node:fs/promises";
import { requestRuntimeSwap, type SwapRole } from "./runtime-control";
import { SUPPORTED_STT_BACKENDS, SUPPORTED_TTS_BACKENDS } from "./backends/supported-backends";
import {
  MAX_NOTIFY_JSON_BYTES,
  MAX_NOTIFY_TEXT_CHARS,
  MAX_CHAT_TEXT_CHARS,
  MAX_WS_TEXT_BYTES,
} from "./web-voice/protocol";

const program = new Command();
const SPEAK_TEXT_LIMIT = {
  label: "speech text",
  maxBytes: MAX_WS_TEXT_BYTES,
  maxChars: MAX_CHAT_TEXT_CHARS,
} as const;
const NOTIFY_TEXT_LIMIT = {
  label: "notification text",
  maxBytes: MAX_NOTIFY_JSON_BYTES,
  maxChars: MAX_NOTIFY_TEXT_CHARS,
} as const;

program
  .name("cicero")
  .description("Voice-controlled terminal assistant")
  .version("0.1.0");

program
  .command("start")
  .description("Start the Cicero daemon")
  .option("--tts", "Enable TTS")
  .option("--no-tts", "Disable TTS")
  .option("--wake-word", "Enable wake word detection")
  .option("--no-wake-word", "Disable wake word detection")
  .option("--brain <backend>", "Override brain backend")
  .option("--brain-mode <mode>", "Brain mode: subprocess or tab-inject")
  .option("--brain-tab <tab>", "Target tab for tab-inject mode")
  .option("--turn", "Enable Smart-Turn semantic end-of-turn detection (snappier turn-taking)")
  .option("--no-turn", "Disable Smart-Turn end-of-turn detection")
  .option("--agent-first", "Route every conversational turn to the brain/agent (not just 'ask claude…')")
  .option("--no-agent-first", "Keep conversation on the local model; agent only on brain phrases")
  .option("--no-servers", "Skip starting model servers (use fallback router)")
  .action(async (opts) => {
    let daemon: CiceroDaemon | undefined;
    try {
      logBanner();
      ensureConfigDir();
      const config = loadConfig({
        tts: opts.tts,
        wakeWord: opts.wakeWord,
        brain: opts.brain,
        brainMode: opts.brainMode,
        brainTab: opts.brainTab,
        turn: opts.turn,
        agentFirst: opts.agentFirst,
      });
      daemon = new CiceroDaemon(config, {
        skipServers: opts.servers === false,
      });
      // Own SIGINT/SIGTERM before provider startup. A signal during a long model
      // load now calls stop(), which coordinates with the in-flight start.
      await runUntilShutdown(daemon);
    } catch (error) {
      await daemon?.stop().catch(() => { /* start() already attempted rollback */ });
      throw error;
    }
  });

program
  .command("doctor")
  .description("Check the configured setup end-to-end (engines, venvs, brain binaries, web voice) with fix hints")
  .action(async () => {
    const { runDoctor } = await import("./cli/doctor");
    process.exit(await runDoctor());
  });

const hookCmd = program
  .command("hook")
  .description("Sidecar hook mode commands");

hookCmd
  .command("start", { isDefault: true })
  .description("Run Cicero in sidecar hook mode — receives speak events via HTTP")
  .action(async () => {
    logBanner();
    ensureConfigDir();
    const config = loadConfig();
    const { runHookMode } = await import("./sidecar/run-hook");
    await runHookMode(config);
  });

hookCmd
  .command("install <target>")
  .description("Install hook into a coding agent's settings (target: claude-code or codex)")
  .action(async (target: string) => {
    if (target !== "claude-code" && target !== "codex") {
      console.error(
        "Supported targets: claude-code, codex. Usage: cicero hook install <target>"
      );
      process.exit(1);
    }
    ensureConfigDir();
    const config = loadConfig();
    const port =
      config.sidecar?.backend === "claude-code-hook"
        ? config.sidecar.port
        : 8084;
    const { installClaudeCodeHook, installCodexHook } = await import(
      "./sidecar/install-claude-code-hook"
    );
    const { loadOrCreateHookToken } = await import("./sidecar/hook-auth");
    const token = await loadOrCreateHookToken();
    if (target === "codex") await installCodexHook();
    else await installClaudeCodeHook({ port, token });
    console.log(
      `Cicero ${target} hook installed. Run 'cicero hook' in another terminal to start the receiver.`
    );
  });

hookCmd
  .command("forward <target>")
  .description("Internal bridge from a native agent command hook to the receiver")
  .action(async (target: string) => {
    try {
      if (target !== "codex") return;
      ensureConfigDir();
      const config = loadConfig();
      const port = config.sidecar?.backend === "claude-code-hook"
        ? config.sidecar.port
        : 8084;
      const { loadOrCreateHookToken } = await import("./sidecar/hook-auth");
      const { forwardCodexStopHook } = await import("./sidecar/codex-hook");
      const token = await loadOrCreateHookToken();
      await forwardCodexStopHook({ port, token });
    } catch {
      // Hook delivery is best-effort and must never fail the Codex turn.
    }
  });

program
  .command("scrape <tab>")
  .description("Run Cicero in sidecar scrape mode — watches a terminal tab and speaks new output")
  .action(async (tab: string) => {
    logBanner();
    ensureConfigDir();
    const config = loadConfig();
    const { runScrapeMode } = await import("./sidecar/run-scrape");
    await runScrapeMode(config, tab);
  });

program
  .command("stop")
  .description("Stop the Cicero daemon")
  .action(async () => {
    try {
      const result = await stopDaemonFromPidFile(ciceroPath("cicero.pid"));
      if (result.kind === "signaled") {
        console.log(`Cicero stop requested (pid ${result.pid}).`);
      } else if (result.kind === "not-running") {
        console.log(`No running Cicero instance found${result.reason ? `: ${result.reason}` : "."}`);
      } else {
        console.error(`Refusing to stop from an unsafe daemon marker: ${result.reason}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Could not stop Cicero: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show configured Cicero components and bounded health checks")
  .action(async () => {
    try {
      const config = loadConfig();
      const { collectStatus, renderStatus } = await import("./cli/status");
      process.stdout.write(renderStatus(await collectStatus(config)));
    } catch (error: unknown) {
      console.error(`Could not collect Cicero status: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("swap")
  .description("Hot-swap a running STT or TTS provider; persist only after readiness succeeds")
  .argument("<role>", "stt or tts")
  .argument("<backend>", "registered backend name")
  .argument("[model]", "optional model override")
  .action(async (roleInput: string, backend: string, model?: string) => {
    try {
      if (roleInput !== "stt" && roleInput !== "tts") {
        throw new Error("role must be stt or tts. Usage: cicero swap stt|tts <backend> [model]");
      }
      const role: SwapRole = roleInput;
      const supported: readonly string[] = role === "stt" ? SUPPORTED_STT_BACKENDS : SUPPORTED_TTS_BACKENDS;
      if (!supported.includes(backend)) {
        throw new Error(`unsupported ${role.toUpperCase()} backend '${backend}'. Valid: ${supported.join(", ")}`);
      }
      const result = await requestRuntimeSwap({ role, backend, ...(model ? { model } : {}) });
      console.log(`${result.role.toUpperCase()} active: ${result.backend}${result.model ? ` (${result.model})` : ""}. Config persisted.`);
    } catch (error) {
      console.error(`[cicero] swap failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

program
  .command("pair")
  .description("Pair a phone with web voice using a stable token and terminal QR code")
  .option("--no-token-in-qr", "Omit the credential from the QR and print it separately")
  .action(async (opts: { tokenInQr: boolean }) => {
    try {
      const { runPair } = await import("./cli/pair");
      await runPair({ tokenInQr: opts.tokenInQr });
    } catch (error: unknown) {
      console.error(`Could not pair phone: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// The health lane's record: log by voice (through the health lane, which runs
// these), read trends, feed the morning briefing. Plain-text output on
// purpose — it's consumed by an agent and often spoken.
const healthCmd = program
  .command("health")
  .description("Health record — log metrics and read trends (~/.cicero/health/metrics.jsonl)");

healthCmd
  .command("log")
  .description("Append one entry: value + optional unit and note, or a pure note")
  .argument("<metric>", "metric slug, e.g. weight, calories, sleep, mood")
  .argument("[words...]", "[value] [unit] [note…] — no number means it's all note")
  .action(async (metric: string, words: string[]) => {
    const { healthLog } = await import("./cli/health");
    try {
      console.log(await healthLog(metric, words ?? []));
    } catch (err: unknown) {
      console.error(`health log failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

healthCmd
  .command("recent")
  .description("The most recent entries, oldest first")
  .option("-n, --count <n>", "how many", "20")
  .action(async (opts: { count: string }) => {
    const { healthRecent } = await import("./cli/health");
    console.log(await healthRecent(Math.max(1, Number(opts.count) || 20)));
  });

healthCmd
  .command("trend")
  .description("Plain-text trend for one metric over a window")
  .argument("<metric>", "metric slug, e.g. weight")
  .option("--days <n>", "window in days", "30")
  .action(async (metric: string, opts: { days: string }) => {
    const { healthTrend } = await import("./cli/health");
    console.log(await healthTrend(metric, Math.max(1, Number(opts.days) || 30)));
  });

program
  .command("tts")
  .description("Explain how to change TTS for a running or restarted daemon")
  .argument("<state>", "on or off")
  .action((state: string) => {
    if (state !== "on" && state !== "off") {
      console.error(`Invalid TTS state ${JSON.stringify(state)}. Usage: cicero tts on|off`);
      process.exitCode = 1;
      return;
    }
    const startFlag = state === "on" ? "--tts" : "--no-tts";
    console.error(
      `Cannot change TTS from this CLI: Cicero has no authenticated runtime control channel. `
      + `Use the spoken command "tts ${state}" through a connected Cicero surface, or stop the daemon and run "cicero start ${startFlag}".`,
    );
    process.exitCode = 1;
  });

program
  .command("restart-brain")
  .description("Explain how to reset the Brain LLM session")
  .action(() => {
    console.error(
      "Cannot restart the brain from this CLI: Cicero has no authenticated runtime control channel. "
      + "Use the spoken command \"restart brain\" through a connected Cicero surface, or stop and restart the daemon.",
    );
    process.exitCode = 1;
  });

program
  .command("speak")
  .description("Speak text via TTS (injectable — use from any script or pipe)")
  .argument("[text...]", "Text to speak (or pipe from stdin)")
  .option("--voice <voice>", "Voice preset name (e.g. Ryan, Alloy)")
  .option("--ref-audio <path>", "Path to reference audio file for voice cloning")
  .option("--ref-text <text>", "Transcript of the reference audio")
  .action(async (
    textParts: string[],
    opts: { voice?: string; refAudio?: string; refText?: string },
  ) => {
    const text = await commandText(
      textParts,
      Bun.stdin.stream(),
      SPEAK_TEXT_LIMIT,
    ).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`${detail}. Usage: cicero speak 'hello' or echo 'hello' | cicero speak`);
      process.exit(1);
    });

    const config = loadConfig();

    const configuredTts = config.ttsBackend;
    const voice = opts.voice ?? configuredTts.voice ?? config.voice;
    try {
      const { audio, providerName } = await renderConfiguredSpeech(config, text, {
        voice: opts.voice,
        refAudio: opts.refAudio,
        refText: opts.refText,
        signalSource: process,
      });
      console.error(`[cicero] Spoke via ${providerName} — voice ${voice}, ${audio.byteLength} bytes`);
      let tmpFile: string | undefined;
      try {
        tmpFile = await writeSecureTempAudio(audio, { prefix: "cicero-speak" });
        await createAudioPlayer().play(tmpFile);
      } finally {
        if (tmpFile) await unlink(tmpFile).catch(() => { /* best-effort cleanup */ });
      }
      return;
    } catch (error: unknown) {
      if (error instanceof SpeechInterruptedError) {
        if (error.cleanupError) console.error(`[cicero] TTS interrupt cleanup error: ${error.cleanupError.message}`);
        // Removing our handlers before returning prevents listener accumulation.
        // Re-raise after cleanup so shells and supervisors observe a real signal;
        // exitCode preserves the conventional 130/143 status if re-raise fails.
        try {
          preserveSpeechSignalTermination(error.signal, process);
        } catch (signalError: unknown) {
          console.error(`[cicero] could not re-raise ${error.signal}: ${describeSpeechError(signalError)}`);
        }
        return;
      }
      const detail = describeSpeechError(error);
      console.error(`[cicero] TTS error: ${detail}`);
    }

    // Fallback to the OS system voice (say / PowerShell System.Speech / spd-say)
    console.error(`[cicero] ${configuredTts.backend ?? "TTS"} unavailable, falling back to the system voice`);
    await new SystemSpeaker().speak(text);
  });

program
  .command("notify")
  .description("Speak a notification through connected web-voice clients (proactive voice-back — use from kanban hooks, cron, CI)")
  .argument("[text...]", "Notification text (or pipe from stdin)")
  .action(async (textParts: string[]) => {
    const text = await commandText(
      textParts,
      Bun.stdin.stream(),
      NOTIFY_TEXT_LIMIT,
    ).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`${detail}. Usage: cicero notify 'PR 142 is up' or echo '…' | cicero notify`);
      process.exit(1);
    });

    const config = loadConfig();
    const wv = config.web_voice;
    if (!wv?.enabled) {
      console.error("web_voice is not enabled in config — notifications need a running web-voice server.");
      process.exit(1);
    }
    if (!wv.token) {
      console.error("web_voice.token is not set in config — a fixed token is required to call the daemon.");
      process.exit(1);
    }
    try {
      const result = await sendWebVoiceNotification({
        scheme: wv.tls?.enabled === false ? "http" : "https",
        port: wv.port ?? 8090,
        token: wv.token,
        text,
        timeoutMs: config.ttsBackend.timeout_ms,
      });
      if (result.delivered === 0) {
        const suffix = result.parked ? " It was parked for the next client." : "";
        console.error(`[cicero] notify rendered, but no voice client is connected right now.${suffix}`);
      } else {
        console.error(`[cicero] notified ${result.delivered} voice client(s)`);
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[cicero] notify error (is the daemon running?): ${detail}`);
      process.exit(1);
    }
  });

program
  .command("do")
  .description("Take actions on your computer to accomplish a goal (experimental)")
  .argument("<goal...>", 'What you want done, e.g. "open my Downloads folder"')
  .option("-y, --yes", "Auto-approve every action (skip confirmation prompts)")
  .option("--web", "Enable the browser tool (Playwright)")
  .option("--root <path>", "Limit file tools to this workspace (default: current directory)")
  .option("--allow-cloud-data", "Allow goals and tool observations to be sent to a public/cloud LLM")
  .option("--max-steps <n>", "Maximum number of actions to attempt", "12")
  .action(async (goalParts: string[], opts) => {
    const goal = goalParts.join(" ").trim();
    if (!goal) {
      console.error('No goal provided. Usage: cicero do "open my Downloads folder"');
      process.exit(1);
    }

    ensureConfigDir();
    const config = loadConfig();
    const { createLLMProvider } = await import("./backends/registry");
    const { runDo, isLocalComputeTarget, describeActionForConfirmation } = await import("./compute");
    const llmConfig = config.llmBackend;
    const allowCloud = opts.allowCloudData === true || config.compute.allowCloud;
    if (!isLocalComputeTarget(llmConfig) && !allowCloud) {
      console.error(
        "[cicero] computer use may send file contents and command output to the configured cloud LLM. " +
        "Re-run with --allow-cloud-data or set compute.allow_cloud: true to opt in.",
      );
      process.exit(1);
    }
    const llm = createLLMProvider(config);
    try {
      await llm.start?.();
    } catch (err: unknown) {
      console.error(`[cicero] could not reach the LLM backend: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const maxSteps = Number.parseInt(opts.maxSteps, 10) || 12;
    const autoYes = opts.yes === true;

    const result = await runDo(goal, {
      llm,
      maxSteps,
      web: opts.web === true,
      workspaceRoot: resolve(opts.root ?? config.compute.root ?? process.cwd()),
      maxReadBytes: config.compute.maxReadBytes,
      log: (msg) => console.error(`[cicero] ${msg}`),
      confirm: async (action) => {
        if (autoYes) return true;
        // Fail closed when there is no interactive terminal to ask: never let a
        // mutating action through on an undefined non-TTY prompt answer.
        if (!process.stdin.isTTY) {
          console.error(`[cicero] refusing ${action.tool} — no interactive terminal to confirm. Re-run with --yes to auto-approve.`);
          return false;
        }
        // Bun provides a synchronous confirm() global for TTY prompts.
        return confirm(`Allow ${describeActionForConfirmation(action)}?`);
      },
    });

    console.log(result.summary || (result.ok ? "Done." : "Could not complete the goal."));
    process.exit(result.ok ? 0 : 1);
  });

registerVoiceCommand(program);

try {
  await program.parseAsync();
} catch (error) {
  // Startup-policy failures (including headless web-voice misconfiguration or
  // bind failure) are operator errors: print one actionable line, never a raw
  // stack trace from Commander’s async action boundary.
  console.error(`[cicero] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
