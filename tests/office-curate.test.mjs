import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library, libraryRules, setLibraryRules, libraryFolder } from '../dist/office/library.js';
import { Curator, CurationStore, catalogue, curateRequest, parseCuration, linksIn, linkName, relatedAddition, describeCuration } from '../dist/office/curate.js';
import { resetCooling } from '../dist/workspace/worker.js';

const files = {
  '독서/제텔카스텐.md': '---\ntags: [메모]\n---\n# 제텔카스텐\n메모를 연결하는 방법. [[영구 메모]]를 쌓는다.\n',
  '독서/영구 메모.md': '자기 말로 다시 쓴 메모.',
  '회의록 11월.md': '메모 정리 방식을 제텔카스텐으로 정했다.\n\n## 관련 문서\n\n- [[영구 메모|영구]]\n',
  '할 일.md': '- 장보기\n',
  'Nidus/Lessons/예시를 먼저 모은다.md': '# 예시를 먼저 모은다\n글쓰기 전에 예시를 모은다.\n',
  'Nidus/Archive/Lessons/옛 교훈.md': '보관됨\n',
};
async function vault(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-curate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [path, text] of Object.entries(files)) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), text); }
  await mkdir(join(dir, '.nidus', 'office'), { recursive: true });
  await writeFile(join(dir, '.nidus', 'office', 'note.md'), 'hidden');
  return { dir, library: new Library(dir, 'Nidus') };
}
function curator(t, dir, library, answers, rules = '') {
  resetCooling();
  const requests = [], changes = [];
  const gateway = { async send(target, request) { requests.push({ target, request: structuredClone(request) }); return { response: { provider: 'p', model: 'm', content: [{ type: 'text', text: answers.shift() }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }, costUSD: null, warnings: [] }; } };
  const store = new CurationStore(join(dir, '.nidus', 'local', 'curation.json'));
  return { c: new Curator({ gateway, library, store, rules: async () => rules, onChange: c => changes.push(c), retryWaits: [] }), requests, changes, store };
}
const signal = () => new AbortController().signal;

test('the catalogue lists the Library\'s notes with how they begin and what they link to', async t => {
  const { library } = await vault(t);
  const notes = await catalogue(library);
  assert.deepEqual(notes.map(n => `${n.id} ${n.path}${n.own ? ' own' : ''}`), ['N1 Nidus/Lessons/예시를 먼저 모은다.md own', 'N2 독서/영구 메모.md', 'N3 독서/제텔카스텐.md', 'N4 할 일.md', 'N5 회의록 11월.md']);
  assert.deepEqual([notes[2].title, notes[2].links, notes[2].excerpt], ['제텔카스텐', ['영구 메모'], '# 제텔카스텐 메모를 연결하는 방법. [[영구 메모]]를 쌓는다.']);
  assert.deepEqual(linksIn('[[a/b|x]] [[c#d]] [[c]] [e]'), ['b', 'c']);
  const request = curateRequest(notes, '');
  assert.match(request, /\[N3\] 독서\/제텔카스텐\.md \| links to: 영구 메모\n/);
  assert.match(request, /\[N1\] Nidus\/Lessons\/예시를 먼저 모은다\.md \(the team's note\)/);
  assert.match(request, /Folders the user has: 독서\n/);
  assert.match(request, /no filing rules: suggest no moves/);
  assert.match(curateRequest(notes, '독서 메모는 독서/ 폴더에'), /The user's filing rules:\n독서 메모는 독서\/ 폴더에/);
});

test('parseCuration keeps only what can be done: no team note changed, no link that exists, no move into hidden or AI folders', async t => {
  const { library } = await vault(t);
  const notes = await catalogue(library);
  const answer = { links: [
    { from: 'N5', to: 'N3', reason: '회의에서 정한 방식의\n원문' }, { from: 'N5', to: 'N3', reason: '같은 것 다시' },
    { from: 'N3', to: 'N2', reason: '이미 연결됨' }, { from: 'N1', to: 'N3', reason: '팀 문서는 고치지 않음' }, { from: 'N4', to: 'N4', reason: '자기 자신' }, { from: 'N9', to: 'N1', reason: '모르는 문서' },
    { from: 'N3', to: 'N1', reason: '팀의 교훈으로' },
  ], moves: [
    { note: 'N5', folder: '/회의/', reason: '회의록은 회의 폴더' }, { note: 'N5', folder: '다른 곳', reason: '두 번째는 버림' },
    { note: 'N2', folder: '독서', reason: '이미 그 폴더' }, { note: 'N4', folder: 'Nidus/Lessons', reason: 'AI 폴더' }, { note: 'N4', folder: '.obsidian', reason: '숨김' }, { note: 'N4', folder: 'a/../b', reason: '밖' }, { note: 'N1', folder: '독서', reason: '팀 문서' },
  ] };
  assert.deepEqual(parseCuration(JSON.stringify(answer), notes, 'Nidus'), [
    { id: 's1', kind: 'link', path: '회의록 11월.md', target: '독서/제텔카스텐.md', reason: '회의에서 정한 방식의 원문', status: 'pending' },
    { id: 's2', kind: 'link', path: '독서/제텔카스텐.md', target: 'Nidus/Lessons/예시를 먼저 모은다.md', reason: '팀의 교훈으로', status: 'pending' },
    { id: 's3', kind: 'move', path: '회의록 11월.md', target: '회의', reason: '회의록은 회의 폴더', status: 'pending' },
  ]);
  assert.deepEqual(parseCuration(JSON.stringify({ links: [{ from: '회의록 11월.md', to: '독서/제텔카스텐', reason: 'a' }, { from: '[N4]', to: '영구 메모', reason: 'b' }], moves: [{ note: '할 일', folder: '일', reason: 'c' }] }), notes, 'Nidus').map(s => `${s.path} -> ${s.target}`),
    ['회의록 11월.md -> 독서/제텔카스텐.md', '할 일.md -> 독서/영구 메모.md', '할 일.md -> 일'], 'a note named by its path or title is understood too');
  assert.deepEqual(parseCuration('{"links": []}', notes, 'Nidus'), []);
  assert.throws(() => parseCuration('{"summary": "x"}', notes, 'Nidus'), /links/);
});

test('a link is one line under 관련 문서 at the end; the rest of the note is untouched', () => {
  assert.equal(relatedAddition('본문', '제텔카스텐', '원문'), '\n\n## 관련 문서\n\n- [[제텔카스텐]] — 원문\n');
  assert.equal(relatedAddition('본문\n', '제텔카스텐', ''), '\n## 관련 문서\n\n- [[제텔카스텐]]\n');
  assert.equal(relatedAddition('본문\n\n## 관련 문서\n\n- [[a]]\n', '제텔카스텐', '원문'), '- [[제텔카스텐]] — 원문\n');
  assert.equal(relatedAddition('본문\n\n## 관련 문서\n- [[a]]\n\n## 다른 절\n', 'b', ''), '\n## 관련 문서\n\n- [[b]]\n', 'the section is not the last one: a new one at the end');
  assert.equal(relatedAddition('이미 [[제텔카스텐|z]] 있음', '제텔카스텐', '원문'), null);
  assert.equal(relatedAddition('', 'a', ''), '## 관련 문서\n\n- [[a]]\n');
  assert.equal(linkName('독서/제텔카스텐.md', ['독서/제텔카스텐.md', '회의록.md']), '제텔카스텐');
  assert.equal(linkName('독서/메모.md', ['독서/메모.md', '업무/메모.md']), '독서/메모', 'two notes of one name: linked by path');
});

test('Curator: suggestions change nothing; only what the user picks is applied, links before moves', async t => {
  const { dir, library } = await vault(t);
  const answer = JSON.stringify({ links: [{ from: 'N5', to: 'N3', reason: '정한 방식의 원문' }, { from: 'N4', to: 'N2', reason: '억지 연결' }], moves: [{ note: 'N5', folder: '회의/2026', reason: '회의록은 회의 폴더' }, { note: 'N4', folder: '독서', reason: 'x' }] });
  const { c, requests, changes, store } = curator(t, dir, library, ['글로 한 답', answer], '회의록은 회의/<연도>/ 폴더에');
  const before = await readFile(join(dir, '회의록 11월.md'), 'utf8');
  const made = await c.suggest(signal());
  assert.equal(requests.length, 2, 'an answer that is not the JSON is asked for again');
  assert.equal(requests[0].target.role, 'main');
  assert.match(requests[0].request.system, /Library Manager/);
  assert.match(requests[0].request.messages[0].content[0].text, /회의록은 회의\/<연도>\/ 폴더에/);
  assert.deepEqual(made.suggestions.map(s => `${s.id} ${s.kind} ${s.path} -> ${s.target}`), ['s1 link 회의록 11월.md -> 독서/제텔카스텐.md', 's2 link 할 일.md -> 독서/영구 메모.md', 's3 move 회의록 11월.md -> 회의/2026', 's4 move 할 일.md -> 독서']);
  assert.equal(await readFile(join(dir, '회의록 11월.md'), 'utf8'), before, 'nothing changed yet');
  assert.match(describeCuration(made), /노트 5개를 살펴보고 제안을 만들었습니다: 연결 2건, 이동 2건\. 아직 아무것도 바꾸지 않았습니다/);
  assert.deepEqual((await store.load()).suggestions.length, 4, 'suggestions wait across a restart');

  const done = await c.apply(['s3', 's1']);
  assert.deepEqual(done.suggestions.map(s => s.status), ['applied', 'pending', 'applied', 'pending']);
  assert.equal(await readFile(join(dir, '회의', '2026', '회의록 11월.md'), 'utf8'), `${before}- [[제텔카스텐]] — 정한 방식의 원문\n`, 'the link went under the section the note ends with, then the note moved');
  await assert.rejects(stat(join(dir, '회의록 11월.md')));
  assert.equal(await readFile(join(dir, '할 일.md'), 'utf8'), '- 장보기\n', 'what was not picked is untouched');
  assert.equal(changes.at(-1).suggestions[0].status, 'applied');
  // A move that would overwrite fails alone; the other still applies.
  await writeFile(join(dir, '독서', '할 일.md'), '다른 글');
  const second = await c.apply(['s4', 's2']);
  assert.deepEqual(second.suggestions.map(s => s.status), ['applied', 'applied', 'applied', 'failed']);
  assert.match(second.suggestions[3].error, /already exists/);
  assert.equal(await readFile(join(dir, '할 일.md'), 'utf8'), '- 장보기\n\n## 관련 문서\n\n- [[영구 메모]] — 억지 연결\n');
  assert.equal(await readFile(join(dir, '독서', '할 일.md'), 'utf8'), '다른 글');
  await c.discard();
  assert.equal(c.current, null);
  await assert.rejects(c.apply(['s1']), /제안이 없습니다/);
});

test('the user\'s notes are changed only inside the Vault, never the team\'s folder or through a link out', async t => {
  const { dir, library } = await vault(t);
  const outside = await mkdtemp(join(tmpdir(), 'nidus-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, '밖.md'), '밖의 글');
  await symlink(join(outside, '밖.md'), join(dir, '링크.md'));
  await symlink(outside, join(dir, '바깥'));
  await assert.rejects(library.appendToUserNote('링크.md', () => 'x'), /outside the Vault/);
  await assert.rejects(library.appendToUserNote('Nidus/Lessons/예시를 먼저 모은다.md', () => 'x'), /not a note of the user's/);
  await assert.rejects(library.appendToUserNote('../x.md', () => 'x'), /path:/);
  await assert.rejects(library.moveUserNote('할 일.md', '바깥/새 폴더'), /outside the Vault/);
  assert.deepEqual(await readdir(outside), ['밖.md'], 'no folder was made behind the link');
  await assert.rejects(library.moveUserNote('할 일.md', 'Nidus/Lessons'), /AI's own folder/);
  await assert.rejects(library.moveUserNote('할 일.md', '.obsidian'), /hidden/);
  await assert.rejects(library.moveUserNote('독서/영구 메모.md', '독서'), /already in/);
  assert.equal(await readFile(join(outside, '밖.md'), 'utf8'), '밖의 글');
  assert.equal(await library.appendToUserNote('할 일.md', () => null), false);
});

test('filing rules live in library.json beside the folder setting', async t => {
  const { dir } = await vault(t);
  const config = join(dir, '.nidus', 'office', 'library.json');
  assert.equal(await libraryRules(config), '');
  await writeFile(config, '{"folder": "AI"}');
  assert.equal(await setLibraryRules(config, '  회의록은 회의/ 폴더에  '), '회의록은 회의/ 폴더에');
  assert.equal(await libraryRules(config), '회의록은 회의/ 폴더에');
  assert.equal(await libraryFolder(config), 'AI', 'the folder setting is kept');
});
