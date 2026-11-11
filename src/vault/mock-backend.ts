import { randomUUID } from 'node:crypto';
import { VaultError } from './types.js';
import type { StopEvidence, VMInstance } from './execution-types.js';

/** Trusted Host port. Never pass a model-supplied implementation or evidence into this interface. */
export interface VMBackend {
  readonly kind: 'mock';
  start(instance: Readonly<VMInstance>): Promise<{ vmInstanceId: string; generation: number; backendRef: string; state: 'RUNNING' }>;
  stop(instance: Readonly<VMInstance>): Promise<StopEvidence>;
  verifyStop(instance: Readonly<VMInstance>, evidence: StopEvidence): boolean;
}
export interface MockBehavior {
  start?: 'success' | 'fail' | 'hang';
  stop?: 'success' | 'fail' | 'hang';
  startDelayMs?: number; stopDelayMs?: number;
}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export class MockVMBackend implements VMBackend {
  readonly kind = 'mock' as const;
  readonly events: { operation: string; vmInstanceId: string }[] = [];
  private instances = new Map<string, { generation: number; backendRef: string; state: string }>();
  private receipts = new WeakSet<StopEvidence>();
  private lost = false;
  constructor(readonly behavior: MockBehavior = {}) {}
  loseControl() { this.lost = true; }
  async start(v: Readonly<VMInstance>) {
    if (this.lost) throw new VaultError('mock_control_lost');
    if (this.instances.has(v.vmInstanceId)) throw new VaultError('mock_duplicate_start');
    const record = { generation: v.generation, backendRef: v.backendRef, state: 'STARTING' };
    this.instances.set(v.vmInstanceId, record); this.events.push({ operation: 'start', vmInstanceId: v.vmInstanceId });
    if (this.behavior.start === 'hang') await new Promise(() => {});
    await delay(this.behavior.startDelayMs ?? 0);
    if (this.lost) throw new VaultError('mock_control_lost');
    if (this.behavior.start === 'fail') { record.state = 'FAILED'; throw new VaultError('mock_start_failed'); }
    record.state = 'RUNNING';
    return { vmInstanceId: v.vmInstanceId, generation: v.generation, backendRef: v.backendRef, state: 'RUNNING' as const };
  }
  async stop(v: Readonly<VMInstance>): Promise<StopEvidence> {
    if (this.lost) throw new VaultError('mock_control_lost');
    const record = this.instances.get(v.vmInstanceId);
    if (!record || record.generation !== v.generation || record.backendRef !== v.backendRef) throw new VaultError('mock_unknown_instance');
    if (record.state === 'STOPPING' || record.state === 'STOPPED') throw new VaultError('mock_duplicate_stop');
    record.state = 'STOPPING'; this.events.push({ operation: 'stop', vmInstanceId: v.vmInstanceId });
    if (this.behavior.stop === 'hang') await new Promise(() => {});
    await delay(this.behavior.stopDelayMs ?? 0);
    if (this.lost || this.behavior.stop === 'fail') throw new VaultError('mock_stop_unconfirmed');
    // A delayed start may still run: never certify a hung start as stopped.
    if (this.behavior.start === 'hang') throw new VaultError('mock_start_unconfirmed');
    record.state = 'STOPPED';
    const evidence: StopEvidence = { evidenceId: randomUUID(), source: 'mock', vmInstanceId: v.vmInstanceId,
      generation: v.generation, backendRef: v.backendRef, state: 'STOPPED', observedAt: new Date().toISOString() };
    this.receipts.add(evidence); return evidence;
  }
  verifyStop(v: Readonly<VMInstance>, e: StopEvidence) {
    return this.receipts.has(e) && !this.lost && this.instances.get(v.vmInstanceId)?.state === 'STOPPED' &&
      e.vmInstanceId === v.vmInstanceId && e.generation === v.generation && e.backendRef === v.backendRef;
  }
}
