// Two small schedulers of the Workspace Service: the one VM goes to one Worker at a time, and a
// tool call can wait until the user has answered every pending network approval.

/** Who holds the VM now (a board task id), and the queue of those waiting for it. */
export function vmTurns() {
  let queue: Promise<unknown> = Promise.resolve();
  const turns = {
    holder: null as string | null,
    /** Runs `action` once the VM is free; a turn that was stopped while waiting never starts. */
    take<T>(holder: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
      const turn = queue.then(async () => {
        if (signal.aborted) throw new Error('stopped');
        turns.holder = holder;
        try { return await action(); } finally { turns.holder = null; }
      });
      queue = turn.catch(() => {});
      return turn;
    },
  };
  return turns;
}

/** `pending()` counts the approvals waiting for the user; `settled()` is called whenever one is answered. */
export function approvalGate(pending: () => number) {
  const waiters: (() => void)[] = [];
  return {
    settled(): void { if (!pending()) for (const wake of waiters.splice(0)) wake(); },
    /** Resolves once nothing is pending: true if it had to wait (or was stopped), false if nothing was. */
    wait(signal?: AbortSignal): Promise<boolean> {
      if (!pending()) return Promise.resolve(false);
      return new Promise(resolve => {
        waiters.push(() => resolve(true));
        signal?.addEventListener('abort', () => resolve(true), { once: true });
      });
    },
  };
}
