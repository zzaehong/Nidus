import { VaultError } from './types.js';
import type { ExecutionSnapshot } from './execution-types.js';
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const isLabel = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:@/-]{1,160}$/.test(v);
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const number = (n: unknown, min = 0) => Number.isSafeInteger(n) && (n as number) >= min;
export const terminal = (s: string) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s);
export function validateExecutionSnapshot(value: unknown): ExecutionSnapshot {
  try {
    const s = value as ExecutionSnapshot;
    const require = (ok: unknown) => { if (!ok) throw new Error(); };
    require(s.schemaVersion === 1 && number(s.revision) && (s.ownerId === null || isId(s.ownerId)));
    require(s.policy.maxActiveVMs === 1 && s.policy.maxActiveExecutions === 1 && s.policy.queue === 'owner-fifo' && s.policy.stopAfterExecution === true);
    require([s.environments, s.instances, s.executions, s.leases].every(Array.isArray));
    const unique = (ids: string[]) => require(ids.every(isId) && new Set(ids).size === ids.length);
    unique(s.environments.map(e => e.vaultId)); unique(s.environments.map(e => e.environmentId));
    unique(s.instances.map(v => v.vmInstanceId)); unique(s.executions.map(e => e.executionId)); unique(s.leases.map(l => l.leaseId));
    for (const e of s.environments) {
      require(number(e.configVersion, 1) && e.backendKind === 'mock' && typeof e.enabled === 'boolean' && number(e.generation));
      require(e.policy.maxActiveVMs === 1 && e.policy.maxActiveExecutions === 1);
      const instances = s.instances.filter(v => v.vaultId === e.vaultId);
      require(instances.length === e.generation && new Set(instances.map(v => v.generation)).size === instances.length);
      require(instances.filter(v => v.state !== 'STOP_CONFIRMED').length <= 1);
    }
    require(s.instances.filter(v => v.state !== 'STOP_CONFIRMED').length <= s.policy.maxActiveVMs);
    for (const v of s.instances) {
      const env = s.environments.find(e => e.vaultId === v.vaultId);
      require(env && env.environmentId === v.environmentId && number(v.generation, 1) && v.generation <= env.generation);
      require(['STOPPED','STARTING','RUNNING','STOPPING','STOP_CONFIRMED','STOP_UNCONFIRMED','FAILED'].includes(v.state));
      require(['UNKNOWN','STOPPED','RUNNING'].includes(v.backendState) && date(v.createdAt) && date(v.updatedAt) && isId(v.backendRef));
      if (v.state === 'RUNNING') require(v.backendState === 'RUNNING');
      if (v.state === 'STOP_CONFIRMED') {
        const p = v.stopEvidence;
        require(p && isId(p.evidenceId) && p.source === 'mock' && p.state === 'STOPPED' && date(p.observedAt) &&
          p.vmInstanceId === v.vmInstanceId && p.generation === v.generation && p.backendRef === v.backendRef && v.backendState === 'STOPPED');
      } else require(v.stopEvidence === null && v.generation === env!.generation);
      require(s.executions.filter(e => e.vmInstanceId === v.vmInstanceId).length === 1);
    }
    require(new Set(s.executions.map(e => e.sequence)).size === s.executions.length);
    for (const e of s.executions) {
      require(s.environments.some(v => v.vaultId === e.vaultId) && isLabel(e.requestedBy) && number(e.sequence, 1) && e.sequence <= s.executions.length);
      require(date(e.createdAt) && (e.startedAt === null || date(e.startedAt)) && (e.endedAt === null || date(e.endedAt)));
      require(['QUEUED','ACQUIRED','RUNNING','COMPLETED','FAILED','CANCELLED','UNCONFIRMED'].includes(e.state) && typeof e.cancelRequested === 'boolean');
      require(e.completion === null || (['COMPLETED','FAILED'].includes(e.completion.outcome) && (e.completion.resultId === null || isLabel(e.completion.resultId))));
      require(terminal(e.state) === (e.endedAt !== null));
      if (e.vmInstanceId === null) require(['QUEUED','FAILED','CANCELLED'].includes(e.state));
      else {
        const v = s.instances.find(v => v.vmInstanceId === e.vmInstanceId);
        require(v && v.vaultId === e.vaultId && terminal(e.state) === (v.state === 'STOP_CONFIRMED') && e.state !== 'QUEUED');
        require(s.leases.filter(l => l.executionId === e.executionId).length === 1);
      }
      if (e.state === 'RUNNING' || e.state === 'COMPLETED') require(e.startedAt !== null);
    }
    require(s.leases.filter(l => !l.released).length <= s.policy.maxActiveExecutions);
    for (const l of s.leases) {
      const e = s.executions.find(e => e.executionId === l.executionId), v = s.instances.find(v => v.vmInstanceId === l.vmInstanceId);
      require(e && v && e.vmInstanceId === v.vmInstanceId && e.vaultId === l.vaultId && v.environmentId === l.environmentId && v.generation === l.generation);
      require(isId(l.ownerId) && /^[a-f0-9]{64}$/.test(l.tokenHash) && typeof l.released === 'boolean' && l.released === terminal(e!.state));
      if (!l.released) require(l.ownerId === s.ownerId);
    }
    if (s.ownerId === null) require(s.executions.every(e => terminal(e.state)) && s.instances.every(v => v.state === 'STOP_CONFIRMED'));
    return s;
  } catch { throw new VaultError('execution_state_corrupt'); }
}
