// Integer nano-USD: one USD = 1,000,000,000 units. JSON uses decimal strings.
import { NidusError } from './errors.js';
export const USD = 1_000_000_000n;
export const MAX_MONEY = 1_000_000n * USD;
export function money(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,9})?$/.test(value))
    throw new NidusError('invalid_request', 'USD must be a nonnegative decimal string with at most 9 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole!) * USD + BigInt(fraction.padEnd(9, '0'));
  if (result > MAX_MONEY) throw new NidusError('invalid_request', 'USD exceeds the supported limit of 1000000.');
  return result;
}
export function dollars(value: bigint): string {
  const sign = value < 0n ? '-' : ''; const n = value < 0n ? -value : value;
  return `${sign}${n / USD}.${(n % USD).toString().padStart(9, '0')}`;
}
export function tokenCost(tokens: number, ratePerMillion: number): bigint {
  const numerator = BigInt(tokens) * money(String(ratePerMillion));
  return (numerator + 999_999n) / 1_000_000n; // Round up only at the nano-USD boundary.
}

// Provider decimals may exceed our precision or use scientific notation. Convert and
// round up using integers, including Anthropic's decimal cents (decimalShift=-2).
export function reportedMoney(value: unknown, decimalShift = 0): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new NidusError('invalid_response', 'Missing reported cost.');
  const match = /^(\d{1,30})(?:\.(\d{1,30}))?(?:e([+-]?\d{1,2}))?$/i.exec(String(value));
  if (!match) throw new NidusError('invalid_response', 'Invalid reported cost.');
  const fraction = match[2] ?? '', exponent = Number(match[3] ?? 0) + decimalShift + 9 - fraction.length;
  const digits = BigInt(match[1]! + fraction);
  const result = exponent >= 0 ? digits * 10n ** BigInt(exponent) : (digits + 10n ** BigInt(-exponent) - 1n) / 10n ** BigInt(-exponent);
  if (result > MAX_MONEY) throw new NidusError('invalid_response', 'Reported cost exceeds supported range.');
  return result;
}
