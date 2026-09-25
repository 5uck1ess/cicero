import { dlopen, read } from "bun:ffi";

/** A kernel-owned process reference; a recycled numeric PID cannot retarget it. */
export interface LinuxPidfdApi {
  open(pid: number): number;
  signal(fd: number): void;
  close(fd: number): void;
}

/** Narrow FFI seam, also used by tests without requiring a Linux host. */
export interface LinuxPidfdSyscalls {
  syscall(number: number, arg1: number, arg2: number, arg3: number, arg4: number): bigint;
  errno(): number;
  close(fd: number): number;
}

export class LinuxPidfdUnavailableError extends Error {
  readonly code = "ENOSYS";

  constructor() {
    super("Linux pidfd API is unavailable");
    this.name = "LinuxPidfdUnavailableError";
  }
}

class LinuxPidfdCallError extends Error {
  readonly code: string;

  constructor(operation: string, errno: number) {
    super(`${operation} failed (errno ${errno})`);
    this.name = "LinuxPidfdCallError";
    this.code = errno === 3 ? "ESRCH" : `ERRNO_${errno}`;
  }
}

const PIDFD_OPEN_SYSCALL = 434;
const PIDFD_SEND_SIGNAL_SYSCALL = 424;
const SIGTERM = 15;
const ENOSYS = 38;
const resolveLibcPidfd = createLinuxPidfdResolver(loadLibcSyscalls);

export function linuxPidfdApi(): LinuxPidfdApi {
  if (process.platform !== "linux") throw new Error("pidfd requires Linux");
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new LinuxPidfdUnavailableError();
  }
  return resolveLibcPidfd();
}

/** Cache both symbol-resolution failure and a kernel ENOSYS response. */
export function createLinuxPidfdResolver(loader: () => LinuxPidfdSyscalls): () => LinuxPidfdApi {
  let cached: LinuxPidfdApi | LinuxPidfdUnavailableError | undefined;
  return () => {
    if (cached instanceof LinuxPidfdUnavailableError) throw cached;
    if (cached) return cached;
    try {
      cached = createLinuxPidfdApi(loader(), () => {
        cached = new LinuxPidfdUnavailableError();
      });
      return cached;
    } catch {
      cached = new LinuxPidfdUnavailableError();
      throw cached;
    }
  };
}

/** libc's syscall() returns -1 and sets errno; raw negative errno is accepted by the seam too. */
export function createLinuxPidfdApi(
  native: LinuxPidfdSyscalls,
  onUnavailable?: () => void,
): LinuxPidfdApi {
  const checked = (operation: string, result: bigint): number => {
    if (result >= 0n && result <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(result);
    const errno = result === -1n ? native.errno() : Number(-result);
    if (errno === ENOSYS) {
      onUnavailable?.();
      throw new LinuxPidfdUnavailableError();
    }
    throw new LinuxPidfdCallError(operation, errno);
  };
  return {
    open(pid): number {
      return checked("pidfd_open", native.syscall(PIDFD_OPEN_SYSCALL, pid, 0, 0, 0));
    },
    signal(fd): void {
      checked("pidfd_send_signal", native.syscall(PIDFD_SEND_SIGNAL_SYSCALL, fd, SIGTERM, 0, 0));
    },
    close(fd): void {
      if (native.close(fd) !== 0) throw new Error("pidfd close failed");
    },
  };
}

function loadLibcSyscalls(): LinuxPidfdSyscalls {
  const muslArch = process.arch === "x64" ? "x86_64" : "aarch64";
  const candidates = [
    "libc.so.6",
    `libc.musl-${muslArch}.so.1`,
    `/lib/ld-musl-${muslArch}.so.1`,
    "libc.so",
  ];
  for (const name of candidates) {
    try {
      const library = dlopen(name, {
        syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" },
        __errno_location: { args: [], returns: "ptr" },
        close: { args: ["i32"], returns: "i32" },
      });
      return {
        syscall: (number, arg1, arg2, arg3, arg4) =>
          library.symbols.syscall(number, arg1, arg2, arg3, arg4),
        errno: () => {
          const location = library.symbols.__errno_location();
          if (!location) throw new Error("libc errno location is unavailable");
          return read.i32(location);
        },
        close: (fd) => library.symbols.close(fd),
      };
    } catch { /* Try the next libc name or classify the API as unavailable. */ }
  }
  throw new LinuxPidfdUnavailableError();
}
