import type { RequestPermissionResponse } from "@zed-industries/agent-client-protocol";

/** Maximum ACP permission requests retained by one unadopted turn. */
export const MAX_HELD_PERMISSIONS = 32;

const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });
const decideSafely = (decide: () => RequestPermissionResponse): RequestPermissionResponse => {
  try { return decide(); } catch { return cancelled(); }
};

/** A speculative turn owns this hold; adoption or abort settles every waiter. */
export class SpeculativePermissionHold {
  private state: "pending" | "adopted" | "cancelled" = "pending";
  private pending = new Set<(adopted: boolean) => void>();

  defer(decide: () => RequestPermissionResponse): Promise<RequestPermissionResponse> {
    if (this.state === "cancelled") return Promise.resolve(cancelled());
    if (this.state === "adopted") return Promise.resolve(decideSafely(decide));
    if (this.pending.size >= MAX_HELD_PERMISSIONS) {
      this.cancel();
      return Promise.resolve(cancelled());
    }
    return new Promise((resolve) => {
      const settle = (adopted: boolean): void => {
        this.pending.delete(settle);
        resolve(adopted ? decideSafely(decide) : cancelled());
      };
      this.pending.add(settle);
    });
  }

  adopt(): void { this.settle(true); }
  cancel(): void { this.settle(false); }

  private settle(adopted: boolean): void {
    if (this.state !== "pending") return;
    this.state = adopted ? "adopted" : "cancelled";
    for (const resolve of this.pending) resolve(adopted);
    this.pending.clear();
  }
}
