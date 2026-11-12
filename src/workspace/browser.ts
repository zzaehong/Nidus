// The workspace browser: Chromium inside the VM, driven from the host over CDP.
//
// - The AI acts through `act()` (observe, navigate, click, type, ...). No per-action approval:
//   the browser lives inside the VM, and its traffic leaves only through the Egress Proxy.
// - The screen is streamed with Page.startScreencast and emitted as 'frame' events.
// - Control is either the AI's or the user's. While the user has it, AI actions wait and
//   the user's mouse and keyboard input goes straight to the page. A page the AI cannot get
//   past (CAPTCHA, login) hands control to the user instead of failing the task.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { CDPClient, CDPError, type CDPEvent } from './cdp.js';
import { createDOMReader } from './browser-dom.js';
import { pageState } from '../vault/page-state.js';

export type Control = 'ai' | 'user';
export interface Tab { id: string; url: string; title: string; active: boolean }
export interface Frame { data: string; width: number; height: number; tabId: string; at: number }
export interface ControlChange { control: Control; reason?: string; by: 'user' | 'ai' | 'page' }

export type BrowserAction =
  | { op: 'observe' }
  | { op: 'read'; snapshotId: string; offset: number }
  | { op: 'navigate'; url: string }
  | { op: 'back' } | { op: 'forward' } | { op: 'reload' }
  | { op: 'scroll'; delta: number }
  | { op: 'wait'; ms: number }
  | { op: 'click'; snapshotId: string; targetId: string }
  | { op: 'type'; snapshotId: string; targetId: string; text: string }
  | { op: 'press'; snapshotId: string; targetId: string; key: string }
  | { op: 'select'; snapshotId: string; targetId: string; value: string }
  | { op: 'check'; snapshotId: string; targetId: string; checked: boolean }
  | { op: 'newTab'; url: string }
  | { op: 'switchTab'; tabId: string }
  | { op: 'closeTab'; tabId: string }
  | { op: 'askUser'; reason: string };

export type UserInput =
  | { type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: number; /** While moving: buttons held (1 left, 2 right, 4 middle), for dragging. */ buttons?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code?: string; text?: string; modifiers?: number }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'history'; direction: 'back' | 'forward' }
  | { type: 'reload' }
  | { type: 'tab'; tabId: string };

export interface BrowserOptions {
  viewport?: { width: number; height: number };
  /** Upper bound on streamed frames per second. Chromium sends a frame only after the previous is acknowledged. */
  maxFps?: number;
  quality?: number;
  settleMs?: number;
}

const ELEMENTS = 60;
const TEXT_SLICE = 4000;
const KEYS: Record<string, number> = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, ' ': 32, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34,
};
const AI_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** What makes an element the same element, apart from where it is and what it currently holds. */
const identity = (e: any) => JSON.stringify([e.tag, e.type, e.role, e.name, e.href, e.target, e.formAction, e.frameUrl, e.editable]);
const fail = (code: string): never => { throw new CDPError(code); };

/** Schemes a page may be opened with. The VM's own files and servers are the AI's to use. */
export function allowedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return fail('browser_url_invalid');
  if (value === 'about:blank') return value;
  let url: URL;
  try { url = new URL(value); } catch { return fail('browser_url_invalid'); }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) fail('browser_url_invalid');
  return url.href;
}

function keyCode(key: string): number {
  if (key in KEYS) return KEYS[key]!;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z0-9]/.test(upper)) return upper.charCodeAt(0);
  }
  return 0;
}

const finite = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const modifiers = (value: unknown) => (value === undefined ? 0 : Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 15 ? value as number : fail('browser_input_invalid'));

interface TabState { id: string; url: string; title: string; openerId?: string; sessionId?: string }

export class WorkspaceBrowser extends EventEmitter {
  private readonly viewport: { width: number; height: number };
  private readonly frameInterval: number;
  private readonly quality: number;
  private readonly settleMs: number;
  private readonly tabs = new Map<string, TabState>();
  private active: string | undefined;
  private controlState: Control = 'ai';
  private controlReason: string | undefined;
  private waiters: (() => void)[] = [];
  private actions: Promise<unknown> = Promise.resolve();
  private lastFrameAt = 0;
  private readonly inflight = new Set<string>();
  private networkCount = 0;
  // DOM observation state of the active tab.
  private reader: string | undefined;
  private loader: string | undefined;
  private snapshot = '';
  private observedLoader: string | undefined;
  private elements: any[] = [];
  private cachedPage: any;
  private settled = false;
  private closed = false;
  readonly stats = { frames: 0, frameBytes: 0 };

  constructor(private readonly cdp: CDPClient, options: BrowserOptions = {}) {
    super();
    this.viewport = options.viewport ?? { width: 1280, height: 800 };
    this.frameInterval = 1000 / (options.maxFps ?? 15);
    this.quality = options.quality ?? 60;
    this.settleMs = options.settleMs ?? 15_000;
    cdp.on('event', (event: CDPEvent) => this.onEvent(event));
    cdp.on('close', (reason: string) => this.shutdown(reason));
  }

  get control(): Control { return this.controlState; }
  get reason(): string | undefined { return this.controlReason; }
  get activeTab(): string | undefined { return this.active; }

  listTabs(): Tab[] {
    return [...this.tabs.values()].map(t => ({ id: t.id, url: t.url, title: t.title, active: t.id === this.active }));
  }

  async start(): Promise<void> {
    await this.cdp.call('Target.setDiscoverTargets', { discover: true });
    await this.cdp.call('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    const { targetInfos } = await this.cdp.call('Target.getTargets');
    for (const info of targetInfos ?? []) if (info.type === 'page') this.tabs.set(info.targetId, { id: info.targetId, url: info.url, title: info.title });
    if (!this.tabs.size) {
      const { targetId } = await this.cdp.call('Target.createTarget', { url: 'about:blank' });
      if (!this.tabs.has(targetId)) this.tabs.set(targetId, { id: targetId, url: 'about:blank', title: '' });
    }
    await this.activate([...this.tabs.keys()][0]!);
  }

  // --- control -------------------------------------------------------------

  /** The user takes the browser. AI actions wait until `handBack()`. */
  takeOver(reason?: string): void { this.setControl('user', 'user', reason); }

  handBack(): void { this.setControl('ai', 'user'); }

  private setControl(control: Control, by: ControlChange['by'], reason?: string): void {
    if (this.closed || (this.controlState === control && this.controlReason === reason)) return;
    this.controlState = control;
    this.controlReason = control === 'user' ? reason : undefined;
    this.emit('control', { control, reason: this.controlReason, by } satisfies ControlChange);
    if (control === 'ai') for (const wake of this.waiters.splice(0)) wake();
  }

  /** Resolves when the AI may act. */
  private turn(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new CDPError('browser_closed'));
    if (signal?.aborted) return Promise.reject(new CDPError('browser_action_cancelled'));
    if (this.controlState === 'ai') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.waiters = this.waiters.filter(w => w !== wake); reject(new CDPError('browser_action_cancelled')); };
      const wake = () => { signal?.removeEventListener('abort', onAbort); this.closed ? reject(new CDPError('browser_closed')) : resolve(); };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // --- user input ----------------------------------------------------------

  /** Input from the user's view of the screen. Accepted only while the user has control. */
  async input(event: UserInput): Promise<void> {
    if (this.closed) fail('browser_closed');
    if (this.controlState !== 'user') fail('browser_not_user_control');
    const session = this.session();
    const { width, height } = this.viewport;
    switch (event?.type) {
      case 'mouse': {
        if (!finite(event.x, 0, width) || !finite(event.y, 0, height) || !['move', 'down', 'up'].includes(event.action)) fail('browser_input_invalid');
        const button = event.button ?? 'left';
        if (!['left', 'right', 'middle'].includes(button)) fail('browser_input_invalid');
        const clickCount = event.clickCount ?? 1;
        if (!Number.isInteger(clickCount) || clickCount < 0 || clickCount > 3) fail('browser_input_invalid');
        const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[event.action];
        const held = event.buttons ?? 0;
        if (!Number.isInteger(held) || held < 0 || held > 7) fail('browser_input_invalid');
        const dragging = event.action === 'move' && held ? { button: held & 1 ? 'left' : held & 2 ? 'right' : 'middle', buttons: held } : {};
        await this.cdp.call('Input.dispatchMouseEvent', { type, x: event.x, y: event.y, modifiers: modifiers(event.modifiers), ...(event.action === 'move' ? dragging : { button, clickCount }) }, session);
        return;
      }
      case 'wheel':
        if (!finite(event.x, 0, width) || !finite(event.y, 0, height) || !finite(event.deltaX, -5000, 5000) || !finite(event.deltaY, -5000, 5000)) fail('browser_input_invalid');
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event.modifiers) }, session);
        return;
      case 'key': {
        if (typeof event.key !== 'string' || !event.key.length || event.key.length > 32 || !['down', 'up'].includes(event.action)) fail('browser_input_invalid');
        if (event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 8)) fail('browser_input_invalid');
        if (event.code !== undefined && (typeof event.code !== 'string' || event.code.length > 32)) fail('browser_input_invalid');
        const mods = modifiers(event.modifiers);
        // Text is typed only without Ctrl/Meta, so shortcuts do not also insert characters.
        const text = event.action === 'down' && !(mods & 6) ? event.text : undefined;
        await this.cdp.call('Input.dispatchKeyEvent', {
          type: event.action === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
          key: event.key, code: event.code ?? '', windowsVirtualKeyCode: keyCode(event.key), modifiers: mods,
          ...(text ? { text, unmodifiedText: text } : {}),
        }, session);
        return;
      }
      case 'text':
        if (typeof event.text !== 'string' || event.text.length > 4096) fail('browser_input_invalid');
        await this.cdp.call('Input.insertText', { text: event.text }, session);
        return;
      case 'navigate':
        await this.cdp.call('Page.navigate', { url: allowedUrl(event.url) }, session);
        return;
      case 'history':
        if (!['back', 'forward'].includes(event.direction)) fail('browser_input_invalid');
        await this.history(event.direction === 'back' ? -1 : 1);
        return;
      case 'reload':
        await this.cdp.call('Page.reload', {}, session);
        return;
      case 'tab':
        if (!this.tabs.has(event.tabId)) fail('browser_tab_missing');
        await this.activate(event.tabId);
        return;
      default:
        fail('browser_input_invalid');
    }
  }

  // --- AI actions ----------------------------------------------------------

  /** One AI action. Actions run one at a time and wait while the user has control. */
  act(action: BrowserAction, signal?: AbortSignal): Promise<any> {
    const run = this.actions.then(async () => {
      await this.turn(signal);
      return this.perform(action, signal);
    });
    this.actions = run.catch(() => {});
    return run;
  }

  private async perform(a: BrowserAction, signal?: AbortSignal): Promise<any> {
    switch (a?.op) {
      case 'observe': await this.settle(); return this.observe(signal);
      case 'read': {
        if (a.snapshotId !== this.snapshot || !this.cachedPage || !Number.isSafeInteger(a.offset) || a.offset < 0 || a.offset > this.cachedPage.text.length) fail('browser_stale_observation');
        await this.current();
        return this.slice(a.offset);
      }
      case 'navigate': {
        const url = allowedUrl(a.url);
        // Slow sites and proxy approvals take time; the page itself settles below.
        const result = await this.cdp.call('Page.navigate', { url }, this.session(), 180_000);
        this.reader = undefined;
        await this.settle();
        const page = await this.observe(signal);
        return result.errorText ? { ...page, navigationError: String(result.errorText).slice(0, 200) } : page;
      }
      case 'back': case 'forward':
        await this.history(a.op === 'back' ? -1 : 1);
        await this.settle(); return this.observe(signal);
      case 'reload':
        await this.cdp.call('Page.reload', {}, this.session()); this.reader = undefined;
        await this.settle(); return this.observe(signal);
      case 'scroll':
        if (!Number.isSafeInteger(a.delta) || Math.abs(a.delta) > 5000) fail('browser_action_invalid');
        await this.cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.viewport.width / 2, y: this.viewport.height / 2, deltaX: 0, deltaY: a.delta }, this.session());
        await this.settle(); return this.observe(signal);
      case 'wait':
        if (!Number.isSafeInteger(a.ms) || a.ms < 0 || a.ms > 10_000) fail('browser_action_invalid');
        await sleep(a.ms); await this.settle(); return this.observe(signal);
      case 'newTab': {
        const { targetId } = await this.cdp.call('Target.createTarget', { url: allowedUrl(a.url) });
        if (!this.tabs.has(targetId)) this.tabs.set(targetId, { id: targetId, url: a.url, title: '' });
        await this.activate(targetId);
        await this.settle(); return this.observe(signal);
      }
      case 'switchTab':
        if (!this.tabs.has(a.tabId)) fail('browser_tab_missing');
        await this.activate(a.tabId); await this.settle(); return this.observe(signal);
      case 'closeTab':
        if (!this.tabs.has(a.tabId)) fail('browser_tab_missing');
        await this.cdp.call('Target.closeTarget', { targetId: a.tabId });
        await this.waitFor(() => !this.tabs.has(a.tabId) && this.active !== a.tabId, 5000);
        await this.settle(); return this.observe(signal);
      case 'askUser': {
        if (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 500) fail('browser_action_invalid');
        this.setControl('user', 'ai', a.reason);
        await this.turn(signal);
        await this.settle(); return this.observe(signal);
      }
      case 'click': case 'type': case 'press': case 'select': case 'check':
        return this.element(a, signal);
      default:
        return fail('browser_action_invalid');
    }
  }

  private async element(a: Extract<BrowserAction, { targetId: string }>, signal?: AbortSignal): Promise<any> {
    if (a.snapshotId !== this.snapshot) fail('browser_stale_observation');
    await this.current();
    const e = this.elements.find(x => x.id === a.targetId);
    if (!e) fail('browser_element_missing');
    // Live pages (ads, tickers) change all the time; what matters is that this element is still
    // the one observed, still in place to receive the input. It may have moved: use where it is now.
    let fresh: any;
    try { fresh = await this.dom('metadata', [{ objectId: e.objectId }]); } catch { fresh = undefined; }
    if (!fresh || identity(fresh) !== identity(e)) fail('browser_element_gone');
    if (!fresh.visible || !fresh.hit) fail('browser_element_hidden');
    if (e.disabled || fresh.disabled) fail('browser_element_disabled');
    e.x = fresh.x; e.y = fresh.y;
    if (['type', 'select', 'check'].includes(a.op) && e.readonly) fail('browser_readonly');
    const session = this.session();
    this.snapshot = '';
    if (a.op === 'type') {
      if (typeof a.text !== 'string' || a.text.length > 4096) fail('browser_input_limit');
      if (!e.editable && !['INPUT', 'TEXTAREA'].includes(e.tag)) fail('browser_not_text_input');
      await this.cdp.call('DOM.focus', { objectId: e.objectId }, session);
      // Select what is there, then replace it.
      for (const type of ['rawKeyDown', 'keyUp']) await this.cdp.call('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, session);
      await this.cdp.call('Input.insertText', { text: a.text }, session);
    } else if (a.op === 'press') {
      if (!AI_KEYS.includes(a.key)) fail('browser_key_denied');
      await this.cdp.call('DOM.focus', { objectId: e.objectId }, session);
      const key = a.key === 'Space' ? ' ' : a.key, code = a.key === 'Space' ? 'Space' : a.key;
      const text = a.key === 'Enter' ? '\r' : a.key === 'Space' ? ' ' : undefined;
      await this.cdp.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode(a.key), ...(text ? { text } : {}) }, session);
      await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode(a.key) }, session);
    } else if (a.op === 'select') {
      if (typeof a.value !== 'string' || a.value.length > 160) fail('browser_option_unavailable');
      await this.dom('select', [{ objectId: e.objectId }, { value: a.value }]);
    } else {
      if (a.op === 'check' && (!['checkbox', 'radio'].includes(e.role) || typeof a.checked !== 'boolean' || (e.role === 'radio' && !a.checked))) fail('browser_check_unsupported');
      if (a.op === 'click' || e.checked !== (a as any).checked) {
        for (const type of ['mousePressed', 'mouseReleased']) await this.cdp.call('Input.dispatchMouseEvent', { type, x: e.x, y: e.y, button: 'left', clickCount: 1 }, session);
      }
    }
    await this.settle();
    let verified: boolean | undefined;
    if (['type', 'select', 'check'].includes(a.op) && this.tabs.get(this.active!)?.sessionId === session) {
      try { verified = await this.dom('verify', [{ objectId: e.objectId }, { value: a.op }, { value: a.op === 'type' ? (a as any).text : a.op === 'select' ? (a as any).value : (a as any).checked }]); } catch { verified = false; }
    }
    const page = await this.observe(signal);
    return { ...page, actionResult: { operation: a.op, ...(verified === undefined ? { status: 'dispatched' } : { status: verified ? 'verified' : 'unverified' }) } };
  }

  // --- observation ---------------------------------------------------------

  private async evaluateReader(): Promise<void> {
    const session = this.session();
    const { frameTree } = await this.cdp.call('Page.getFrameTree', {}, session);
    if (this.reader && this.loader === frameTree.frame.loaderId) return;
    this.loader = frameTree.frame.loaderId;
    const { executionContextId } = await this.cdp.call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'nidus-dom' }, session);
    const r = await this.cdp.call('Runtime.evaluate', { expression: `(${createDOMReader.toString()})()`, contextId: executionContextId, objectGroup: 'reader' }, session);
    this.reader = r.result?.objectId;
    if (!this.reader) fail('browser_dom_unavailable');
  }

  private async dom(method: string, args: object[] = [], byValue = true): Promise<any> {
    const r = await this.cdp.call('Runtime.callFunctionOn', {
      objectId: this.reader, functionDeclaration: `function(...args){return this[${JSON.stringify(method)}](...args)}`,
      arguments: args, returnByValue: byValue, objectGroup: 'observation',
    }, this.session());
    if (r.exceptionDetails) fail(r.exceptionDetails.exception?.description?.match(/browser_[a-z_]+/)?.[0] ?? 'browser_evaluation_failed');
    return byValue ? r.result.value : r.result;
  }

  /** Waits for the page to stop changing: DOM stable, document ready, network quiet (or given up on). */
  private async settle(): Promise<void> {
    this.settled = false;
    const started = Date.now();
    let last = '', stable = 0;
    while (Date.now() - started < this.settleMs) {
      await sleep(100);
      try {
        await this.evaluateReader();
        const s = await this.dom('state');
        // Long-polling pages never go quiet; after a few seconds only the DOM counts.
        const quiet = !this.inflight.size || Date.now() - started > 3000;
        const key = JSON.stringify([this.networkCount, s]);
        if (quiet && s.ready && !s.busy && key === last) { if (++stable >= 4) { this.settled = true; return; } } else stable = 0;
        // A page that keeps redrawing itself (animation, ticker) is as settled as it gets.
        if (quiet && s.ready && !s.busy && Date.now() - started > 3000) return;
        last = key;
      } catch (error) {
        if (error instanceof CDPError && error.code === 'browser_closed') throw error;
        this.reader = undefined;
      }
    }
  }

  private async observe(signal?: AbortSignal, attempt = 0, askedUser = false): Promise<any> {
    if (signal?.aborted) fail('browser_action_cancelled');
    await this.evaluateReader();
    await this.cdp.call('Runtime.releaseObjectGroup', { objectGroup: 'observation' }, this.session());
    this.elements = [];
    const snapshot = randomUUID();
    const before = await this.dom('state');
    const list = await this.dom('scan', [], false);
    const props = await this.cdp.call('Runtime.getProperties', { objectId: list.objectId, ownProperties: true }, this.session());
    const nodes = props.result.filter((p: any) => /^\d+$/.test(p.name));
    for (const prop of nodes.slice(0, ELEMENTS)) {
      const objectId = prop.value.objectId;
      const value = await this.dom('metadata', [{ objectId }]);
      const fingerprint = await this.dom('fingerprint', [{ objectId }]);
      this.elements.push({ ...value, id: String(this.elements.length + 1), objectId, fingerprint });
    }
    const page = await this.dom('page');
    const after = await this.dom('state');
    if (before.revision !== after.revision && attempt < 2 && this.settled) {
      // The page changed while being read; try again on a calmer page. Pages that never
      // stop (animations, tickers) are returned as they are, marked as changing.
      this.snapshot = '';
      await this.settle();
      return this.observe(signal, attempt + 1, askedUser);
    }
    this.observedLoader = this.loader;
    this.snapshot = snapshot;
    const state = pageState(page);
    this.cachedPage = { ...page, snapshotId: snapshot, settled: this.settled, ready: after.ready, textLength: page.text.length, elementsOmitted: Math.max(0, nodes.length - ELEMENTS), pageState: state, changing: before.revision !== after.revision };
    if (state === 'captcha_required' && this.controlState === 'ai' && !askedUser) {
      // Not a failure: the user solves it and hands the browser back. If it is still there
      // after that, the user chose not to: the AI gets the page as it is and finds another way.
      this.setControl('user', 'page', 'captcha');
      await this.turn(signal);
      await this.settle();
      return this.observe(signal, 0, true);
    }
    return this.slice(0, true);
  }

  private slice(offset: number, controls = false): any {
    const p = this.cachedPage, end = Math.min(offset + TEXT_SLICE, p.text.length);
    return {
      ...p, text: p.text.slice(offset, end), textOffset: offset, nextOffset: end < p.text.length ? end : null,
      elements: controls ? this.elements.map(({ objectId: _o, fingerprint: _f, ...e }) => e) : [],
      tabs: this.listTabs(), untrusted: true,
    };
  }

  /** The observation still belongs to the document on screen. Changes within it are checked per element. */
  private async current(): Promise<void> {
    await this.evaluateReader();
    if (!this.snapshot || this.loader !== this.observedLoader) fail('browser_stale_observation');
  }

  // --- tabs and screencast -------------------------------------------------

  private session(): string {
    const sessionId = this.active ? this.tabs.get(this.active)?.sessionId : undefined;
    if (!sessionId) fail('browser_tab_missing');
    return sessionId!;
  }

  private async history(step: number): Promise<void> {
    const session = this.session();
    const h = await this.cdp.call('Page.getNavigationHistory', {}, session);
    const entry = h.entries?.[h.currentIndex + step];
    if (entry) { await this.cdp.call('Page.navigateToHistoryEntry', { entryId: entry.id }, session); this.reader = undefined; }
  }

  private async activate(targetId: string): Promise<void> {
    const tab = this.tabs.get(targetId);
    if (!tab) fail('browser_tab_missing');
    const previous = this.active ? this.tabs.get(this.active) : undefined;
    if (previous?.sessionId && previous.id !== targetId) await this.cdp.call('Page.stopScreencast', {}, previous.sessionId).catch(() => {});
    if (!tab!.sessionId) {
      const { sessionId } = await this.cdp.call('Target.attachToTarget', { targetId, flatten: true });
      tab!.sessionId = sessionId;
      await this.cdp.call('Page.enable', {}, sessionId);
      await this.cdp.call('Network.enable', {}, sessionId);
      const version = await this.cdp.call('Browser.getVersion');
      // Headless Chromium names itself in the user agent; many sites refuse that.
      await this.cdp.call('Network.setUserAgentOverride', { userAgent: String(version.userAgent ?? '').replace('HeadlessChrome', 'Chrome'), acceptLanguage: 'ko-KR,ko,en-US,en' }, sessionId);
      await this.cdp.call('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false }, sessionId);
    }
    this.active = targetId;
    this.reader = undefined; this.snapshot = ''; this.inflight.clear();
    await this.cdp.call('Target.activateTarget', { targetId }).catch(() => {});
    await this.cdp.call('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 }, tab!.sessionId);
    this.emit('tabs', this.listTabs());
  }

  private async waitFor(predicate: () => boolean, ms: number): Promise<void> {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > ms) fail('browser_action_timeout'); await sleep(50); }
  }

  private onEvent({ method, params, sessionId }: CDPEvent): void {
    const activeSession = this.active ? this.tabs.get(this.active)?.sessionId : undefined;
    switch (method) {
      case 'Page.screencastFrame': {
        if (sessionId !== activeSession || typeof params.data !== 'string') { void this.cdp.call('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {}); return; }
        const frame: Frame = { data: params.data, width: params.metadata?.deviceWidth ?? this.viewport.width, height: params.metadata?.deviceHeight ?? this.viewport.height, tabId: this.active!, at: Date.now() };
        this.stats.frames++; this.stats.frameBytes += Math.floor(params.data.length * 3 / 4);
        this.emit('frame', frame);
        // Acknowledging later slows Chromium down: that is the frame rate cap.
        const wait = Math.max(0, this.lastFrameAt + this.frameInterval - Date.now());
        this.lastFrameAt = Date.now() + wait;
        setTimeout(() => void this.cdp.call('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {}), wait);
        return;
      }
      case 'Network.requestWillBeSent':
        if (sessionId === activeSession) { this.inflight.add(params.requestId); this.networkCount++; }
        return;
      case 'Network.loadingFinished': case 'Network.loadingFailed':
        if (sessionId === activeSession) { this.inflight.delete(params.requestId); this.networkCount++; }
        return;
      case 'Target.targetCreated': case 'Target.targetInfoChanged': {
        const info = params.targetInfo;
        if (info?.type !== 'page') return;
        const known = this.tabs.get(info.targetId);
        if (known) { known.url = info.url; known.title = info.title; }
        else {
          this.tabs.set(info.targetId, { id: info.targetId, url: info.url, title: info.title, openerId: info.openerId });
          // A tab opened by the page in front (a link with target=_blank) comes to the front.
          if (info.openerId && info.openerId === this.active) void this.activate(info.targetId).catch(() => {});
        }
        this.emit('tabs', this.listTabs());
        return;
      }
      case 'Target.targetDestroyed': {
        if (!this.tabs.delete(params.targetId)) return;
        if (this.active === params.targetId) {
          this.active = undefined;
          const next = [...this.tabs.keys()].at(-1);
          if (next) void this.activate(next).catch(() => {});
          else void this.cdp.call('Target.createTarget', { url: 'about:blank' }).then(({ targetId }) => {
            if (!this.tabs.has(targetId)) this.tabs.set(targetId, { id: targetId, url: 'about:blank', title: '' });
            return this.activate(targetId);
          }).catch(() => {});
        }
        this.emit('tabs', this.listTabs());
        return;
      }
      case 'Target.detachedFromTarget':
        for (const tab of this.tabs.values()) if (tab.sessionId === params.sessionId) tab.sessionId = undefined;
        return;
    }
  }

  /** Closes Chromium gracefully first, so the profile (cookies, sign-ins) is written to disk. */
  async close(): Promise<void> {
    if (this.closed) return;
    const gone = new Promise<void>(resolve => { this.cdp.once('close', () => resolve()); });
    await this.cdp.call('Browser.close', {}, undefined, 5000).catch(() => {});
    // Chromium exits on its own after writing the profile; the guest bridge then ends the link.
    await Promise.race([gone, sleep(10_000)]);
    this.cdp.close('closed by host');
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
    this.emit('closed', reason);
  }
}
