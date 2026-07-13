/** True when a path commonly contains credentials, tokens, or private keys. */
export function isSensitiveReadPath(value: unknown): boolean {
  const path = String(value ?? "").replace(/\\/g, "/").toLowerCase();
  const filename = path.split("/").at(-1) ?? "";
  return /(?:^|\/)\.env(?:$|[./])/.test(path)
    || /(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json)$/.test(path)
    || /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?(?:\.[^/]*)?)$/.test(path)
    || /(?:^|[._-])(?:auth|credentials?|secrets?|tokens?|api[-_]?keys?|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[._-])/.test(filename)
    || /\.(?:pem|key|p12|pfx|kdbx)$/.test(path)
    || /(?:^|\/)\.git\/config$/.test(path)
    || /(?:^|\/)\.(?:ssh|kube|docker)\/config(?:\.json)?$/.test(path);
}
