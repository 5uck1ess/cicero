const [mode, keyPath, certPath, markerPath = "", delayText = "0"] = process.argv.slice(2);

if (!mode || !keyPath || !certPath) {
  throw new Error("usage: fake-openssl.ts <mode> <key-path> <cert-path> [marker-path] [delay-ms]");
}

if (markerPath) await Bun.write(markerPath, "started\n");

if (mode === "hang-flood") {
  // A real command can both block and keep stderr busy. Ignoring SIGTERM makes
  // the fixture verify that the caller enforces an absolute, non-cooperative
  // deadline without buffering this stream indefinitely.
  process.on("SIGTERM", () => {});
  const block = "openssl diagnostic flood ".repeat(2048);
  while (true) {
    process.stderr.write(block);
    await Bun.sleep(0);
  }
}

const delayMs = Number(delayText);
if (Number.isFinite(delayMs) && delayMs > 0) await Bun.sleep(delayMs);

if (mode !== "valid") {
  process.stderr.write(`unknown fake openssl mode: ${mode}\n`);
  process.exit(2);
}

await Bun.write(keyPath, "-----BEGIN PRIVATE KEY-----\nfixture key\n-----END PRIVATE KEY-----\n");
await Bun.write(certPath, "-----BEGIN CERTIFICATE-----\nfixture cert\n-----END CERTIFICATE-----\n");
