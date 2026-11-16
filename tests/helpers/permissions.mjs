import {createHash} from 'node:crypto';
import {providerIds} from '../../dist/types.js';
const fingerprints = new WeakMap();
export const digest = key => createHash('sha256').update(key).digest('hex');
// Explicit paid-account fixture for tests whose subject is not authorization.
export function authorize(ledger, key='fixture-key', providers=providerIds) {
 const hash=digest(key);fingerprints.set(ledger,hash);
 for(const p of providers)ledger.setAccountPermission(p,'paid_only',true,true,true,hash);
 return ledger;
}
export function recordApproved(ledger, provider, request, task, automatic) {
 let hash=fingerprints.get(ledger);
 if(!hash){authorize(ledger);hash=fingerprints.get(ledger);}
 const account=ledger.accountPermission(provider,hash);
 const context=automatic?{...automatic,accountRevision:account.revision,billingMode:'paid'}:undefined;
 return ledger.recordRequest(provider,request,task,context,hash);
}
