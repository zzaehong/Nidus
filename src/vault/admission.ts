import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { VaultRegistry } from './registry.js';
import { VaultError } from './types.js';
import { ExecutionStore } from './execution-store.js';
import { isId, isLabel, terminal } from './execution-state.js';
import type { VMBackend } from './mock-backend.js';
import type { EnvironmentStatus, ExecutionCompletion, ExecutionLease, ExecutionRequest, ExecutionSession,
  ExecutionSnapshot, StopEvidence, VaultEnvironment, VMInstance } from './execution-types.js';
const now = () => new Date().toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const error = (code: string) => new VaultError(code);
interface Waiter { resolve: (lease: ExecutionLease) => void; reject: (reason: unknown) => void }
/** FIFO is local to this exclusive Host owner. Other processes receive admission_busy. */
export class ExecutionAdmissionController {
  readonly ownerId = randomUUID();
  private readonly store: ExecutionStore;
  private state: ExecutionSnapshot | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private waiters = new Map<string, Waiter>();
  private blocked = false;
  private closed = false;
  private readonly timeoutMs: number;
  constructor(private readonly registry: VaultRegistry, private readonly backend: VMBackend, options: { backendTimeoutMs?: number } = {}) {
    if (backend.kind !== 'mock') throw error('backend_not_enabled');
    this.timeoutMs = options.backendTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw error('invalid_timeout');
    // A single canonical store per Registry, no per-controller override that could bypass the global slot.
    this.store = new ExecutionStore(join(registry.directory, 'execution'), this.ownerId);
  }
  private command<T>(f: () => Promise<T>): Promise<T> {
    const result = this.tail.then(f); this.tail = result.catch(() => {}); return result;
  }
  private rejectWaiting(reason: unknown) {
    for (const w of this.waiters.values()) w.reject(reason); this.waiters.clear();
  }
  private async owned(): Promise<ExecutionSnapshot> {
    if (this.closed) throw error('admission_closed');
    if (this.blocked) throw error('admission_quarantined');
    try {
      if (!this.state) this.state = await this.store.claim();
      await this.store.assertCurrent(); return this.state;
    } catch (e) {
      if (!(e instanceof VaultError && e.code === 'admission_busy')) { this.blocked = true; this.rejectWaiting(e); }
      throw e;
    }
  }
  private async persist() {
    try { await this.store.save(this.state!); }
    catch (e) { this.blocked = true; this.rejectWaiting(e); throw e; }
  }
  private async environment(vaultId: string): Promise<VaultEnvironment> {
    const s = await this.owned(), v = await this.registry.resolveVault(vaultId);
    let env = s.environments.find(e => e.vaultId === vaultId);
    if (env && env.environmentId !== v.environmentId) throw error('environment_mismatch');
    if (!env) {
      env = { vaultId, environmentId: v.environmentId, configVersion: 1, backendKind: 'mock', enabled: true,
        policy: { maxActiveVMs: 1, maxActiveExecutions: 1 }, generation: 0 };
      s.environments.push(env); await this.persist();
    }
    return env;
  }
  getEnvironment(vaultId: string): Promise<VaultEnvironment> {
    return this.command(async () => structuredClone(await this.environment(vaultId)));
  }
  configureEnvironment(vaultId: string, config: { expectedVersion: number; enabled: boolean }): Promise<VaultEnvironment> {
    return this.command(async () => {
      const env = await this.environment(vaultId), s = this.state!;
      if (env.configVersion !== config.expectedVersion || typeof config.enabled !== 'boolean') throw error('environment_revision_conflict');
      if (s.executions.some(e => e.vaultId === vaultId && !terminal(e.state))) throw error('environment_busy');
      env.enabled = config.enabled; env.configVersion++; await this.persist(); return structuredClone(env);
    });
  }
  acquire(vaultId: string, request: ExecutionRequest): Promise<ExecutionLease> {
    if (!isId(vaultId) || !isId(request?.executionId) || !isLabel(request?.requestedBy)) return Promise.reject(error('invalid_execution_request'));
    // Copy caller input before asynchronous validation/queueing.
    const input = { executionId: request.executionId, requestedBy: request.requestedBy };
    return new Promise<ExecutionLease>((resolve, reject) => {
      void this.command(async () => {
        const env = await this.environment(vaultId), s = this.state!;
        if (!env.enabled) throw error('environment_disabled');
        if (s.executions.some(e => e.executionId === input.executionId)) throw error('duplicate_execution');
        s.executions.push({ ...input, vaultId, vmInstanceId: null, sequence: s.executions.length + 1,
          createdAt: now(), startedAt: null, endedAt: null, state: 'QUEUED', cancelRequested: false, completion: null });
        await this.persist(); this.waiters.set(input.executionId, { resolve, reject }); this.schedulePump();
      }).catch(reject);
    });
  }
  private schedulePump() {
    if (this.closed || this.blocked || !this.state?.executions.some(e => e.state === 'QUEUED')) return;
    void this.command(() => this.pump()).catch(e => { this.blocked = true; this.rejectWaiting(e); });
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error('backend_timeout')), this.timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async pump(): Promise<void> {
    const s = await this.owned();
    if (s.leases.some(l => !l.released)) return;
    const session = s.executions.find(e => e.state === 'QUEUED'); if (!session) return;
    let env: VaultEnvironment;
    try {
      env = await this.environment(session.vaultId);
      if (!env.enabled) throw error('environment_disabled');
    } catch (e) {
      session.state = 'FAILED'; session.endedAt = now(); await this.persist();
      this.waiters.get(session.executionId)?.reject(e); this.waiters.delete(session.executionId); this.schedulePump(); return;
    }
    const v: VMInstance = { vmInstanceId: randomUUID(), vaultId: session.vaultId, environmentId: env.environmentId,
      generation: ++env.generation, state: 'STOPPED', backendState: 'UNKNOWN', createdAt: now(), updatedAt: now(), backendRef: randomUUID(), stopEvidence: null };
    const lease: ExecutionLease = { leaseId: randomUUID(), token: randomBytes(32).toString('hex'), ownerId: this.ownerId,
      executionId: session.executionId, vaultId: session.vaultId, environmentId: env.environmentId, vmInstanceId: v.vmInstanceId, generation: v.generation };
    const { token, ...fields } = lease;
    s.instances.push(v); s.leases.push({ ...fields, tokenHash: hash(token), released: false });
    session.vmInstanceId = v.vmInstanceId; session.state = 'ACQUIRED'; await this.persist();
    v.state = 'STARTING'; v.updatedAt = now(); await this.persist();
    try {
      const observed = await this.bounded(this.backend.start(structuredClone(v)));
      if (observed.vmInstanceId !== v.vmInstanceId || observed.generation !== v.generation || observed.backendRef !== v.backendRef || observed.state !== 'RUNNING') throw error('backend_identity_mismatch');
      v.backendState = 'RUNNING';
      // No lease reaches the requester if registration changed while starting.
      await this.environment(session.vaultId);
      v.state = 'RUNNING'; v.updatedAt = now(); session.state = 'RUNNING'; session.startedAt = now(); await this.persist();
      this.waiters.get(session.executionId)?.resolve(lease); this.waiters.delete(session.executionId);
    } catch (e) {
      if (this.blocked) throw e;
      const w = this.waiters.get(session.executionId); this.waiters.delete(session.executionId);
      try {
        if (e instanceof VaultError && ['backend_timeout', 'backend_identity_mismatch'].includes(e.code)) {
          await this.quarantine(session, v); return;
        }
        v.state = 'FAILED'; v.updatedAt = now(); await this.persist();
        session.completion = { outcome: 'FAILED', resultId: null };
        await this.stop(session, v);
      } finally { w?.reject(e); this.waiters.delete(session.executionId); }
    }
  }
  private async quarantine(session: ExecutionSession, v: VMInstance) {
    v.state = 'STOP_UNCONFIRMED'; v.backendState = 'UNKNOWN'; v.updatedAt = now(); session.state = 'UNCONFIRMED';
    await this.persist(); this.blocked = true; this.rejectWaiting(error('execution_unconfirmed'));
  }
  private async stop(session: ExecutionSession, v: VMInstance) {
    v.state = 'STOPPING'; v.updatedAt = now(); await this.persist();
    let evidence: StopEvidence;
    try {
      evidence = await this.bounded(this.backend.stop(structuredClone(v)));
      if (!this.backend.verifyStop(v, evidence) || evidence.source !== 'mock' || evidence.state !== 'STOPPED' ||
          evidence.vmInstanceId !== v.vmInstanceId || evidence.generation !== v.generation || evidence.backendRef !== v.backendRef) throw error('stop_evidence_invalid');
    } catch {
      await this.quarantine(session, v); throw error('execution_unconfirmed');
    }
    v.state = 'STOP_CONFIRMED'; v.backendState = 'STOPPED'; v.updatedAt = now(); v.stopEvidence = structuredClone(evidence);
    session.state = session.cancelRequested ? 'CANCELLED' : (session.completion?.outcome ?? 'FAILED'); session.endedAt = now();
    this.state!.leases.find(l => l.executionId === session.executionId)!.released = true;
    await this.persist(); this.schedulePump();
  }
  private async checkedLease(lease: ExecutionLease) {
    const s = await this.owned();
    const stored = s.leases.find(l => l.leaseId === lease?.leaseId);
    if (!stored || stored.released || typeof lease.token !== 'string' || hash(lease.token) !== stored.tokenHash ||
        (['ownerId','executionId','vaultId','environmentId','vmInstanceId','generation'] as const).some(k => stored[k] !== lease[k]) || stored.ownerId !== this.ownerId) throw error('invalid_lease');
    const v = s.instances.find(v => v.vmInstanceId === stored.vmInstanceId)!;
    if (s.environments.find(e => e.vaultId === stored.vaultId)!.generation !== lease.generation || v.state !== 'RUNNING') throw error('stale_lease');
    return { session: s.executions.find(e => e.executionId === stored.executionId)!, instance: v };
  }
  release(lease: ExecutionLease, completion: ExecutionCompletion): Promise<void> {
    const inputLease = structuredClone(lease), input = structuredClone(completion);
    return this.command(async () => {
      if (!input || !['COMPLETED','FAILED'].includes(input.outcome) || (input.resultId !== null && !isLabel(input.resultId)) || Object.keys(input).sort().join() !== 'outcome,resultId') throw error('invalid_completion');
      const { session, instance } = await this.checkedLease(inputLease);
      session.completion = input; await this.persist(); await this.stop(session, instance);
    });
  }
  cancel(executionId: string): Promise<void> {
    return this.command(async () => {
      const s = await this.owned(), session = s.executions.find(e => e.executionId === executionId);
      if (!session) throw error('execution_not_found');
      if (terminal(session.state)) throw error('execution_already_finished');
      session.cancelRequested = true;
      if (session.state === 'QUEUED') {
        session.state = 'CANCELLED'; session.endedAt = now(); await this.persist();
        this.waiters.get(executionId)?.reject(error('execution_cancelled')); this.waiters.delete(executionId); this.schedulePump(); return;
      }
      await this.persist();
      await this.stop(session, s.instances.find(v => v.vmInstanceId === session.vmInstanceId)!);
    });
  }
  getStatus(vaultId: string): Promise<EnvironmentStatus> {
    return this.command(async () => {
      const registration = await this.registry.resolveVault(vaultId), s = await this.store.read();
      const env = s.environments.find(e => e.vaultId === vaultId) ?? null;
      if (env && env.environmentId !== registration.environmentId) throw error('environment_mismatch');
      const local = s.ownerId === this.ownerId && !this.blocked && !this.closed;
      if (local) await this.store.assertCurrent();
      const hasOwner = await this.store.hasOwner();
      const recordedInstances = s.instances.filter(v => v.vaultId === vaultId), recordedExecutions = s.executions.filter(e => e.vaultId === vaultId);
      const instances = structuredClone(recordedInstances), executions = structuredClone(recordedExecutions);
      if (!local) {
        for (const v of instances) if (v.state !== 'STOP_CONFIRMED') { v.state = 'STOP_UNCONFIRMED'; v.backendState = 'UNKNOWN'; }
        for (const e of executions) if (!terminal(e.state)) e.state = 'UNCONFIRMED';
      }
      return { environment: env, instances, executions, recordedInstances, recordedExecutions,
        owner: local ? 'local' : (s.ownerId || hasOwner ? 'other-or-lost' : 'none'),
        admissionBlocked: this.blocked || (!local && (hasOwner || s.ownerId !== null)) || s.leases.some(l => !l.released), globalPolicy: s.policy };
    });
  }
  close(): Promise<void> {
    return this.command(async () => {
      if (this.closed) throw error('admission_closed');
      if (this.state) { await this.owned(); await this.store.release(this.state); }
      this.closed = true;
    });
  }
}
