import test from 'node:test';
import assert from 'node:assert/strict';
import { siteOf, isPublicSuffix } from '../dist/workspace/site.js';

test('hosts of one site share a site; public suffixes separate sites', () => {
  for (const host of ['naver.com', 'www.naver.com', 'nlog.naver.com', 'nam.veta.naver.com']) assert.equal(siteOf(host), 'naver.com');
  assert.equal(siteOf('ssl.pstatic.net'), 'pstatic.net');
  assert.equal(siteOf('www.daum.co.kr'), 'daum.co.kr');
  assert.equal(siteOf('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteOf('www.seoul.go.kr'), 'seoul.go.kr');
  // Private suffixes: each user's page is its own site.
  assert.equal(siteOf('alice.github.io'), 'alice.github.io');
  assert.equal(siteOf('docs.alice.github.io'), 'alice.github.io');
  assert.notEqual(siteOf('alice.github.io'), siteOf('bob.github.io'));
  assert.equal(siteOf('my-app.vercel.app'), 'my-app.vercel.app');
});

test('suffixes, wildcard and exception rules, addresses and unknown endings', () => {
  for (const suffix of ['com', 'co.kr', 'github.io', 'kr']) assert.equal(isPublicSuffix(suffix), true, suffix);
  assert.equal(isPublicSuffix('naver.com'), false);
  assert.equal(siteOf('co.kr'), 'co.kr', 'a suffix is only itself');
  // *.ck is a wildcard rule with the exception !www.ck.
  assert.equal(siteOf('shop.foo.ck'), 'shop.foo.ck');
  assert.equal(siteOf('a.www.ck'), 'www.ck');
  assert.equal(siteOf('93.184.216.34'), '93.184.216.34');
  assert.equal(siteOf('a.b.unknownending'), 'b.unknownending', 'no rule: the last label is the suffix');
  // Hangul domains arrive in punycode.
  assert.equal(siteOf('www.xn--3e0b707e'), 'www.xn--3e0b707e', '.한국 is a suffix');
});
