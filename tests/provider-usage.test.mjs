import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountReport, adminCredential, HttpClient, reportedMoney, dollars, UsageLedger } from '../dist/index.js';
test('privileged credentials have a separate session namespace, never fall back to inference credentials', () => {
  assert.throws(() => adminCredential('openai', { NIDUS_OPENAI_API_KEY: 'inference' }), /separate/);
  assert.throws(() => adminCredential('openai', { NIDUS_OPENAI_API_KEY: 'same', NIDUS_OPENAI_ADMIN_API_KEY: 'same' }), /separately/);
  assert.equal(adminCredential('openai', { NIDUS_OPENAI_API_KEY: 'inference', NIDUS_OPENAI_ADMIN_API_KEY: 'admin' }), 'admin');
});
test('reported USD and decimal cents convert using integers, including fractional nano rounding', () => {
  assert.equal(dollars(reportedMoney('123.78912', -2)), '1.237891200');
  assert.equal(dollars(reportedMoney('0.0000000001')), '0.000000001');
  assert.equal(dollars(reportedMoney(1e-7)), '0.000000100');
  for (const value of [null, NaN, Infinity, '-2', '1e999']) assert.throws(() => reportedMoney(value));
});
test('organization pagination, USD vs cents and usage fields; aggregate never changes local exposure', async () => {
  for (const provider of ['openai', 'anthropic']) {
    let calls = 0;
    const http = new HttpClient(async (url, options) => {
      calls++; assert.equal(options.headers.authorization, 'Bearer admin-only');
      assert.equal(options.method, 'GET');
      const u = new URL(url); const cost = u.pathname.includes('cost'); const second = u.searchParams.has('page');
      assert.equal(u.searchParams.get('bucket_width'), '1d');
      return Response.json({ data: [{ results: [cost ? (provider === 'openai' ? { amount: { currency: 'usd', value: 0.1 } } : { currency: 'USD', amount: '10' }) :
        (provider === 'openai' ? { input_tokens: 10, output_tokens: 5 } : { uncached_input_tokens: 7, cache_read_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 1 }, output_tokens: 5 })] }], has_more: !second, next_page: second ? null : 'next' });
    });
    const report = await accountReport(provider, 'admin-only', http, new Date('2026-10-24T01:00:00Z'));
    assert.equal(calls, 4); assert.equal(report.reportedUSD, '0.200000000'); assert.equal(report.inputTokens, '20'); assert.equal(report.outputTokens, '10');
    assert.ok(!JSON.stringify(report).includes('admin-only'));
    const l = new UsageLedger(':memory:', () => new Date('2026-10-24T02:00:00Z')); l.saveAccountReport(report);
    assert.equal(l.snapshot().total.exposureUSD, '0.000000000'); assert.equal(l.snapshot().total.confirmedUSD, null);
    assert.equal(l.snapshot().accountReports[0].reportedUSD, '0.200000000'); assert.equal(l.snapshot().lastProviderSyncAt, report.syncedAt); l.close();
  }
});
test('empty reports are unknown, malformed/repeated pagination and non-USD reports fail without partial persistence', async () => {
  const empty = await accountReport('openai', 'synthetic', new HttpClient(async () => Response.json({ data: [], has_more: false })));
  assert.equal(empty.reportedUSD, null); assert.equal(empty.inputTokens, null);
  await assert.rejects(accountReport('openai', 'synthetic', new HttpClient(async () => Response.json({ data: [], has_more: true, next_page: 'same' }))), /pagination/);
  await assert.rejects(accountReport('openai', 'synthetic', new HttpClient(async () => Response.json({ data: [{ results: [{ amount: { currency: 'EUR', value: 1 } }] }], has_more: false }))), /USD/);
});
