// The "site" a host belongs to: its registrable domain under the Public Suffix List.
// Network approvals are per site, so www.naver.com, search.naver.com and nlog.naver.com
// are one question ("naver.com"). Public suffixes keep their meaning: approving
// alice.github.io does not approve bob.github.io, and nothing ever approves "co.kr".
import { isIP } from 'node:net';
import { PUBLIC_SUFFIX_RULES } from './public-suffix-list.js';

const rules = new Set(PUBLIC_SUFFIX_RULES.split(' '));

/**
 * Number of labels in the host's public suffix. Per the list's algorithm: an exception rule
 * ("!www.ck") wins, otherwise the longest matching rule ("*.ck" matches any one label
 * before "ck"), otherwise the last label alone ("*").
 */
function suffixLength(labels: string[]): number {
  let best = 1;
  for (let i = 0; i < labels.length; i++) {
    const count = labels.length - i;
    const name = labels.slice(i).join('.');
    if (rules.has(`!${name}`)) return count - 1;
    const parent = labels.slice(i + 1).join('.');
    if (count > best && (rules.has(name) || (parent !== '' && rules.has(`*.${parent}`)))) best = count;
  }
  return best;
}

/** Whether the host is itself a public suffix, such as "co.kr" or "github.io". */
export function isPublicSuffix(host: string): boolean {
  if (isIP(host)) return false;
  const labels = host.split('.');
  return suffixLength(labels) >= labels.length;
}

/** The registrable domain of a normalized host; IP addresses and public suffixes are their own site. */
export function siteOf(host: string): string {
  if (isIP(host)) return host;
  const labels = host.split('.');
  const suffix = suffixLength(labels);
  return suffix >= labels.length ? host : labels.slice(-(suffix + 1)).join('.');
}
