export interface VaultDescriptor {
  schemaVersion: 1;
  vaultId: string;
  displayName: string;
  createdAt: string;
  environmentId: string;
}
export interface FileIdentity { device: string; inode: string; birthtimeNs: string }
export interface VaultRegistration extends VaultDescriptor {
  canonicalRoot: string;
  identity: FileIdentity;
  volumeUuid?: string;
  status: 'registered';
  revision: number;
  lastValidation: { checkedAt: string; result: 'valid' | 'invalid'; code?: string };
}
export interface VaultRegistrySnapshot { schemaVersion: 1; revision: number; vaults: VaultRegistration[] }
export class VaultError extends Error {
  constructor(public readonly code: string) { super(`Vault operation blocked: ${code}`); this.name = 'VaultError'; }
}
