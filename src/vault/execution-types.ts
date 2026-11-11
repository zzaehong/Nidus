export type VMState = 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOP_CONFIRMED' | 'STOP_UNCONFIRMED' | 'FAILED';
export type ExecutionState = 'QUEUED' | 'ACQUIRED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNCONFIRMED';
export interface ExecutionPolicy { maxActiveVMs: number; maxActiveExecutions: number; queue: 'owner-fifo'; stopAfterExecution: true }
export interface VaultEnvironment {
  vaultId: string; environmentId: string; configVersion: number;
  backendKind: 'mock'; enabled: boolean;
  policy: { maxActiveVMs: 1; maxActiveExecutions: 1 };
  generation: number;
}
export interface StopEvidence {
  evidenceId: string; source: 'mock'; vmInstanceId: string; generation: number;
  backendRef: string; observedAt: string; state: 'STOPPED';
}
export interface VMInstance {
  vmInstanceId: string; vaultId: string; environmentId: string; generation: number;
  state: VMState; backendState: 'UNKNOWN' | 'STOPPED' | 'RUNNING';
  createdAt: string; updatedAt: string; backendRef: string;
  stopEvidence: StopEvidence | null;
}
export interface ExecutionRequest { executionId: string; requestedBy: string }
export interface ExecutionCompletion { outcome: 'COMPLETED' | 'FAILED'; resultId: string | null }
export interface ExecutionSession {
  executionId: string; vaultId: string; vmInstanceId: string | null; requestedBy: string;
  sequence: number; createdAt: string; startedAt: string | null; endedAt: string | null;
  state: ExecutionState; cancelRequested: boolean; completion: ExecutionCompletion | null;
}
export interface ExecutionLease {
  leaseId: string; token: string; ownerId: string; executionId: string; vaultId: string;
  environmentId: string; vmInstanceId: string; generation: number;
}
export interface StoredLease extends Omit<ExecutionLease, 'token'> { tokenHash: string; released: boolean }
export interface ExecutionSnapshot {
  schemaVersion: 1; revision: number; ownerId: string | null; policy: ExecutionPolicy;
  environments: VaultEnvironment[]; instances: VMInstance[]; executions: ExecutionSession[]; leases: StoredLease[];
}
export interface EnvironmentStatus {
  environment: VaultEnvironment | null; instances: VMInstance[]; executions: ExecutionSession[];
  owner: 'local' | 'other-or-lost' | 'none'; admissionBlocked: boolean;
  globalPolicy: ExecutionPolicy;
  // Recorded values are preserved; the view above conservatively projects foreign active records as unconfirmed.
  recordedInstances: VMInstance[]; recordedExecutions: ExecutionSession[];
}
export const initialExecutionSnapshot = (): ExecutionSnapshot => ({
  schemaVersion: 1, revision: 0, ownerId: null,
  policy: { maxActiveVMs: 1, maxActiveExecutions: 1, queue: 'owner-fifo', stopAfterExecution: true },
  environments: [], instances: [], executions: [], leases: [],
});
