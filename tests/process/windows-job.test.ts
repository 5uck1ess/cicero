import { expect, test } from "bun:test";
import { WindowsJobOwner } from "../../src/process/windows-job";

test("job owner closes the same job after its root exits, including escaped descendants", () => {
  const events: string[] = [];
  const native = {
    create: () => { events.push("create"); return 11; },
    open: (pid: number) => { events.push(`open:${pid}`); return 12; },
    assign: (job: number, child: number) => { events.push(`assign:${job}:${child}`); return true; },
    close: (handle: number) => { events.push(`close:${handle}`); },
  };
  const owner = new WindowsJobOwner(native);
  const proc = { pid: 4242, exitCode: null as number | null };
  expect(owner.attach(proc)).toBe(true);
  proc.exitCode = 0;
  expect(owner.close(proc)).toBe(true);
  expect(owner.close(proc)).toBe(false);
  expect(events).toEqual(["create", "open:4242", "assign:11:12", "close:12", "close:11"]);
});

test("job owner releases an unassigned job without retaining a stale PID", () => {
  const closed: number[] = [];
  const owner = new WindowsJobOwner({
    create: () => 11,
    open: () => 0,
    assign: () => { throw new Error("must not assign"); },
    close: (handle) => { closed.push(handle); },
  });
  const proc = { pid: 4242, exitCode: null };
  expect(owner.attach(proc)).toBe(false);
  expect(owner.close(proc)).toBe(false);
  expect(closed).toEqual([11]);
});

test("root exit during OpenProcess prevents assignment to a reused PID", () => {
  const events: string[] = [];
  const proc = { pid: 4242, exitCode: null as number | null };
  const owner = new WindowsJobOwner({
    create: () => 11,
    open: () => { proc.exitCode = 0; return 12; },
    assign: () => { events.push("assign"); return true; },
    close: (handle) => { events.push(`close:${handle}`); },
  });
  expect(owner.attach(proc)).toBe(false);
  expect(events).toEqual(["close:12", "close:11"]);
});
