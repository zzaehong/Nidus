// VM Tasks side by side (STAGE3 "VM Task끼리도 동시에"). The VM runs one Shell session at a time
// and binds its "current" workspace (/run/workspace-current) to /workspace when a session starts:
// that guard is part of its isolation and stays. So each VM Task gets a workspace of its own, and
// every VM call (select that workspace if another is current, then run) waits its turn in one
// line; the browser gets a second line, each Task working in a tab of its own. Calls are seconds
// long while a Worker spends most of its time waiting for the model, so the Tasks really do go on
// together. A long command (a build) holds the line for its length.
import { randomUUID } from 'node:crypto';
import type { BrowserAction, Tab } from './browser.js';
import type { ShellResult, ToolRuntime } from './tools.js';
import { vmTurns } from './turns.js';

/** What this needs of the VM (AppleOfflineBackend). */
export interface WorkspaceVm {
  selectWorkspace(task: string): Promise<boolean>;
  importWorkspace(task: string, bundle: Buffer): Promise<string>;
  exportWorkspace(task: string, base: string): Promise<{ head: string; bundle: Buffer | null }>;
  removeWorkspace(task: string): Promise<void>;
  execute(id: string, command: string, seconds: number, options?: { profile?: 'shell' | 'browser' }): Promise<ShellResult>;
  cancel(id: string): void;
  startService(id: string, command: string): Promise<void>;
  stopService(id: string): Promise<void>;
  readonly runningServices: string[];
}

/** What this needs of the browser (WorkspaceBrowser). */
export interface TabbedBrowser {
  act(action: BrowserAction, signal?: AbortSignal): Promise<any>;
  listTabs(): Tab[];
  readonly activeTab: string | undefined;
}

export class TaskWorkspaces {
  private readonly vmLine = vmTurns();
  private readonly browserLine = vmTurns();
  /** The workspace the VM has as current, as far as this knows (null: unknown, select before the next call). */
  private current: string | null = null;
  private readonly tabs = new Map<string, string>();
  private readonly services = new Map<string, Map<string, string>>();

  constructor(private readonly deps: { vm: () => WorkspaceVm; browser: () => Promise<TabbedBrowser>; waitForApprovals?: (signal?: AbortSignal) => Promise<boolean> }) {}

  /** The VM was restarted or the browser reopened: nothing is known to be current any more. */
  reset(): void { this.current = null; this.tabs.clear(); this.services.clear(); }

  /** Who has the VM now (a workspace), for the log. */
  get holder(): string | null { return this.vmLine.holder; }

  /** One VM call for a workspace, in turn; the workspace is made current first when it is not. */
  inVm<T>(workspace: string, signal: AbortSignal | undefined, call: (vm: WorkspaceVm) => Promise<T>): Promise<T> {
    return this.vmLine.take(workspace, signal ?? new AbortController().signal, async () => {
      const vm = this.deps.vm();
      if (this.current !== workspace) {
        this.current = null;
        if (!await vm.selectWorkspace(workspace)) throw new Error(`작업 공간 ${workspace}이(가) VM에 없습니다`);
        this.current = workspace;
      }
      return call(vm);
    });
  }

  /** Brings a workspace into the VM from a bundle; the VM makes it current. */
  import(workspace: string, bundle: Buffer, signal?: AbortSignal): Promise<string> {
    return this.vmLine.take(workspace, signal ?? new AbortController().signal, async () => {
      this.current = null;
      const head = await this.deps.vm().importWorkspace(workspace, bundle);
      this.current = workspace;
      return head;
    });
  }

  export(workspace: string, base: string, signal?: AbortSignal) {
    return this.vmLine.take(workspace, signal ?? new AbortController().signal, () => this.deps.vm().exportWorkspace(workspace, base));
  }

  async remove(workspace: string): Promise<void> {
    for (const id of this.services.get(workspace)?.values() ?? []) await this.inVm(workspace, undefined, vm => vm.stopService(id)).catch(() => {});
    this.services.delete(workspace);
    this.tabs.delete(workspace);
    await this.vmLine.take(workspace, new AbortController().signal, async () => {
      await this.deps.vm().removeWorkspace(workspace);
      if (this.current === workspace) this.current = null;
    });
  }

  /** A command in the workspace that the service itself needs (not a Worker action). */
  async exec(workspace: string, command: string, seconds = 60, signal?: AbortSignal): Promise<ShellResult> {
    const id = randomUUID();
    const cancel = () => { try { this.deps.vm().cancel(id); } catch {} };
    signal?.addEventListener('abort', cancel, { once: true });
    try { return await this.inVm(workspace, signal, vm => vm.execute(id, command, seconds, { profile: 'shell' })); }
    finally { signal?.removeEventListener('abort', cancel); }
  }

  /** The browser for one workspace's Worker: every action happens in that Worker's own tab. */
  private browserFor(workspace: string): { act: TabbedBrowser['act'] } {
    return {
      act: (action, signal) => this.browserLine.take(workspace, signal ?? new AbortController().signal, async () => {
        const browser = await this.deps.browser();
        const mine = this.tabs.get(workspace);
        if (!mine || !browser.listTabs().some(t => t.id === mine)) {
          // The first action of a Worker (or its tab was closed): a fresh tab, unless the action opens one itself.
          if (action.op !== 'newTab') { await browser.act({ op: 'newTab', url: 'about:blank' }, signal); this.tabs.set(workspace, browser.activeTab!); }
        } else if (browser.activeTab !== mine) {
          await browser.act({ op: 'switchTab', tabId: mine }, signal);
        }
        const page = await browser.act(action, signal);
        // A tab the Worker opened or switched to is its tab from now on.
        if (browser.activeTab) this.tabs.set(workspace, browser.activeTab);
        return page;
      }),
    };
  }

  /** A Worker's tools for one workspace: Shell, services and browser, each in that workspace. */
  runtime(workspace: string): ToolRuntime {
    const named = () => { let m = this.services.get(workspace); if (!m) this.services.set(workspace, m = new Map()); return m; };
    return {
      shell: async (command, seconds, signal) => this.exec(workspace, command, seconds, signal),
      browser: async () => this.browserFor(workspace),
      startService: async (name, command) => {
        const mine = named();
        if (mine.has(name)) await this.inVm(workspace, undefined, vm => vm.stopService(mine.get(name)!)).catch(() => {});
        const id = randomUUID();
        // The service binds the workspace that is current when it starts, and keeps it.
        await this.inVm(workspace, undefined, vm => vm.startService(id, command));
        mine.set(name, id);
      },
      stopService: async name => {
        const mine = named(), id = mine.get(name);
        if (!id) return false;
        mine.delete(name);
        await this.inVm(workspace, undefined, vm => vm.stopService(id));
        return true;
      },
      services: () => { const running = this.deps.vm().runningServices; return [...named()].filter(([, id]) => running.includes(id)).map(([name]) => name); },
      ...(this.deps.waitForApprovals ? { waitForApprovals: this.deps.waitForApprovals } : {}),
    };
  }
}
