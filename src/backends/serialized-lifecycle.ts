export type LifecycleOperation = "start" | "stop" | "warmup";

interface PendingLifecycleOperation {
  kind: LifecycleOperation;
  task: Promise<void>;
}

/**
 * Serialize provider lifecycle calls in invocation order while coalescing only
 * adjacent duplicates. Coalescing by a single global `startTask`/`stopTask`
 * loses later intent: start -> stop -> start -> stop must finish stopped, even
 * when every call is made before the first launch settles.
 */
export class SerializedLifecycle {
  private tail: Promise<void> = Promise.resolve();
  private last: PendingLifecycleOperation | null = null;

  run(kind: LifecycleOperation, operation: () => Promise<void>): Promise<void> {
    if (this.last?.kind === kind) return this.last.task;

    const ready = this.tail.catch(() => { /* a failed operation must not poison cleanup/retry */ });
    const task = ready.then(operation);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );

    const pending: PendingLifecycleOperation = { kind, task };
    this.last = pending;
    const clear = (): void => {
      if (this.last === pending) this.last = null;
    };
    void task.then(clear, clear);
    return task;
  }
}
