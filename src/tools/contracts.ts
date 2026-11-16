export type Target = 'host' | 'vm' | 'provider';
export type Permission = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type Schema = { type: 'string' | 'integer' | 'boolean' | 'object'; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false; maxLength?: number; minimum?: number; maximum?: number };
export interface ToolDefinition {
  id: string; name: string; version: string; description: string; inputSchema: Schema; outputSchema: Schema;
  target: Target; permissions: string[]; sideEffect: boolean; approval: Permission;
  timeoutMs: number; maxOutputBytes: number; cancellation: 'cooperative' | 'before-dispatch'; implemented: boolean;
}
export interface ToolCall { id: string; name: string; arguments: unknown; providerRef?: string }
export interface ToolResult { callId: string; status: 'succeeded' | 'denied' | 'failed' | 'cancelled' | 'unknown'; code: string; content: { text: string }; untrusted: true }
export interface InvocationContext { vaultId: string; executionId: string; signal: AbortSignal }
export class ToolError extends Error { constructor(readonly code: string) { super(code); } }
export const fail = (code: string): never => { throw new ToolError(code); };
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export const result = (callId: string, status: ToolResult['status'], code: string, text = ''): ToolResult => ({callId,status,code,content:{text},untrusted:true});
