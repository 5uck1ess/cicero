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
  private pending = new Set<{ owner?: object; settle: (adopted: boolean) => void }>();

  defer(decide: () => RequestPermissionResponse, owner?: object): Promise<RequestPermissionResponse> {
    if (this.state === "cancelled") return Promise.resolve(cancelled());
    if (this.state === "adopted") return Promise.resolve(decideSafely(decide));
    if (this.pending.size >= MAX_HELD_PERMISSIONS) return Promise.resolve(cancelled());
    return new Promise((resolve) => {
      const entry = { owner, settle: (_adopted: boolean): void => {} };
      const settle = (adopted: boolean): void => {
        this.pending.delete(entry);
        resolve(adopted ? decideSafely(decide) : cancelled());
      };
      entry.settle = settle;
      this.pending.add(entry);
    });
  }

  adopt(): void { this.settle(true); }
  cancel(): void { this.settle(false); }

  /** An ACP child stopped; cancel only requests from that child. */
  cancelOwner(owner: object): void {
    for (const entry of this.pending) {
      if (entry.owner === owner) entry.settle(false);
    }
  }

  private settle(adopted: boolean): void {
    if (this.state !== "pending") return;
    this.state = adopted ? "adopted" : "cancelled";
    for (const entry of this.pending) entry.settle(adopted);
    this.pending.clear();
  }
}
