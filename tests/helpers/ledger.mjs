import { UsageLedger } from '../../dist/ledger.js';
export function fundedLedger() {
  const ledger = new UsageLedger(':memory:');
  ledger.setBudget('total', '100'); ledger.setBudget('request', '10');
  return ledger;
}
