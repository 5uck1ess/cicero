import { expect, test } from "bun:test";
import { createLinuxPidfdApi, createLinuxPidfdResolver, LinuxPidfdUnavailableError } from "../../src/process/linux-pidfd";

test("raw syscall open translates ESRCH from errno", () => {
  const api = createLinuxPidfdApi({
    syscall: () => -1n,
    errno: () => 3,
    close: () => 0,
  });
  expect(() => api.open(42)).toThrow(expect.objectContaining({ code: "ESRCH" }));
});

test("raw syscall signal translates ESRCH from errno", () => {
  const api = createLinuxPidfdApi({
    syscall: (number) => number === 434 ? 17n : -1n,
    errno: () => 3,
    close: () => 0,
  });
  const fd = api.open(42);
  expect(() => api.signal(fd)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  api.close(fd);
});

test("ENOSYS from pidfd_open is classified as unavailable", () => {
  const api = createLinuxPidfdApi({
    syscall: () => -1n,
    errno: () => 38,
    close: () => 0,
  });
  expect(() => api.open(42)).toThrow(LinuxPidfdUnavailableError);
});

test("unavailable libc resolution is cached across stop attempts", () => {
  let loads = 0;
  const resolve = createLinuxPidfdResolver(() => {
    loads++;
    throw new Error("symbol unavailable");
  });
  expect(() => resolve()).toThrow(LinuxPidfdUnavailableError);
  expect(() => resolve()).toThrow(LinuxPidfdUnavailableError);
  expect(loads).toBe(1);
});

test("ENOSYS after loading libc is cached across stop attempts", () => {
  let loads = 0;
  const resolve = createLinuxPidfdResolver(() => {
    loads++;
    return { syscall: () => -1n, errno: () => 38, close: () => 0 };
  });
  const api = resolve();
  expect(() => api.open(42)).toThrow(LinuxPidfdUnavailableError);
  expect(() => resolve()).toThrow(LinuxPidfdUnavailableError);
  expect(loads).toBe(1);
});
