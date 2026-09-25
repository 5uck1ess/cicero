import { dlopen, ptr } from "bun:ffi";

/** Native seam: create() returns a job configured with KILL_ON_JOB_CLOSE. */
export interface WindowsJobApi {
  create(): number;
  open(pid: number): number;
  assign(job: number, child: number): boolean;
  close(handle: number): void;
}

export interface WindowsJobProcess {
  readonly pid: number;
  readonly exitCode: number | null;
}

/** Keep the job open after its root exits so descendants remain owned. */
export class WindowsJobOwner {
  private readonly jobs = new WeakMap<object, number>();

  constructor(private readonly native: WindowsJobApi) {}

  has(proc: object): boolean { return this.jobs.has(proc); }

  attach(proc: WindowsJobProcess): boolean {
    if (proc.exitCode !== null) return false;
    const job = this.native.create();
    if (!job) return false;
    let child = 0;
    try {
      if (proc.exitCode !== null) return false;
      child = this.native.open(proc.pid);
      if (!child || proc.exitCode !== null) return false;
      if (!this.native.assign(job, child)) return false;
      this.jobs.set(proc, job);
      return true;
    } finally {
      if (child) this.native.close(child);
      if (this.jobs.get(proc) !== job) this.native.close(job);
    }
  }

  /** Closing a configured job kills every process assigned to it. */
  close(proc: object): boolean {
    const job = this.jobs.get(proc);
    if (!job) return false;
    this.native.close(job);
    this.jobs.delete(proc);
    return true;
  }
}

let owner: WindowsJobOwner | undefined;

export function windowsJobOwner(): WindowsJobOwner {
  return owner ??= new WindowsJobOwner(createWindowsJobApi());
}

function createWindowsJobApi(): WindowsJobApi {
  if (process.platform !== "win32") throw new Error("Windows jobs require win32");
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Windows job structure layout is available only on 64-bit runtimes");
  }
  const { symbols } = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["ptr"], returns: "i32" },
  });
  const close = (handle: number): void => {
    if (!symbols.CloseHandle(BigInt(handle))) throw new Error("Windows handle close failed");
  };
  return {
    create(): number {
      const job = symbols.CreateJobObjectW(null, null);
      if (!job) return 0;
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows;
      // BasicLimitInformation.LimitFlags starts at offset 16.
      const limits = new Uint8Array(144);
      new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE
      if (!symbols.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)) {
        close(Number(job));
        return 0;
      }
      return Number(job);
    },
    open(pid): number {
      // PROCESS_TERMINATE | PROCESS_SET_QUOTA, required for assignment.
      return Number(symbols.OpenProcess(0x101, 0, pid) ?? 0);
    },
    assign(job, child): boolean { return symbols.AssignProcessToJobObject(BigInt(job), BigInt(child)) !== 0; },
    close,
  };
}
