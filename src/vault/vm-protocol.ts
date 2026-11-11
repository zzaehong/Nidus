/** Host-owned offline backend contract. No network or original Vault mapping. */
export interface SharedVMStatus {
 schemaVersion:1; revision:number; vaultId:string|null; environmentId:string|null;
 vmInstanceId:string|null; generation:number; state:'STOPPED'|'STARTING'|'RUNNING'|'STOPPING'|'STOP_CONFIRMED'|'STOP_UNCONFIRMED';
 policy:{version:1;globalActiveVMs:1;vaultActiveVMs:1;activeSessionsPerVM:1;queue:'host-service-fifo';idleMs:number};
 ready:boolean; activeSession:string|null; queued:number; updatedAt:string;
 backend:'apple-virtualization-offline'; network:'disabled'; originalVaultMounted:false;
 sessions:SessionRecord[];
}
export interface SessionRecord {
 id:string; executionId:string; callId:string; invocationKey:string; commandHash:string; vaultId:string; vmInstanceId:string; generation:number;
 state:'QUEUED'|'RUNNING'|'COMPLETED'|'CANCELLED'|'FAILED'|'UNCONFIRMED';
 createdAt:string; completedAt:string|null; cleanupConfirmed:boolean; resultHash:string|null;
}
export interface ShellResult {browser?:import('./browser.js').BrowserPage;workspaceReview?:import('./workspace.js').WorkspaceReview[];workspaceReviewError?:string;sessionId:string;vmInstanceId:string;generation:number;exitCode:number;stdout:string;stderr:string;cleanupConfirmed:boolean;reason:string;memoryPeakBytes:number}
export const initialVMStatus=():SharedVMStatus=>({schemaVersion:1,revision:0,vaultId:null,environmentId:null,vmInstanceId:null,generation:0,state:'STOPPED',policy:{version:1,globalActiveVMs:1,vaultActiveVMs:1,activeSessionsPerVM:1,queue:'host-service-fifo',idleMs:300000},ready:false,activeSession:null,queued:0,updatedAt:new Date().toISOString(),backend:'apple-virtualization-offline',network:'disabled',originalVaultMounted:false,sessions:[]});

/** Bounded UI projection; full audit history remains in the Host journal. */
export function summarizeVMStatus(state:SharedVMStatus) {
 return structuredClone({...state,sessions:state.sessions.slice(-5),sessionCount:state.sessions.length});
}
