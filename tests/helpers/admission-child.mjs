// Separate OS process for ownership, crash and staging tests; only temporary fixtures are passed in.
import { randomUUID } from 'node:crypto';
import { ExecutionAdmissionController, MockVMBackend, VaultRegistry } from '../../dist/index.js';
import { ExecutionStore } from '../../dist/vault/execution-store.js';
import { readdir } from 'node:fs/promises';
const [host, vaultId, mode] = process.argv.slice(2);
const backend = new MockVMBackend();
const controller = new ExecutionAdmissionController(new VaultRegistry(host), backend, { backendTimeoutMs: 100 });
if (mode === 'crash-staging') {
  // Pause after the real exclusive staging-file write; the parent kills this process.
  const original = ExecutionStore.prototype.save;
  let armed = false;
  ExecutionStore.prototype.save = async function(state) {
    if (!armed && state.instances.length) {
      armed = true;
      const check = this.check.bind(this); let checks = 0;
      this.check = async () => {
        await check();
        if (++checks === 2) {
          const pending = (await readdir(this.directory)).some(n => n.startsWith('state.pending-'));
          process.send?.({ kind: 'staged', pending });
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      };
    }
    return original.call(this, state);
  };
}
try {
  const lease = await controller.acquire(vaultId, { executionId: randomUUID(), requestedBy: 'child:test' });
  process.send?.({ kind: 'acquired', lease });
  process.on('message', async message => {
    if (message === 'release') {
      await controller.release(lease, { outcome: 'COMPLETED', resultId: null }); await controller.close();
      process.send?.({ kind: 'closed' }); process.disconnect();
    }
  });
} catch (e) {
  process.send?.({ kind: 'rejected', code: e.code }); process.disconnect?.();
}
