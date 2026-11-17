import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../dist/office/library.js';
import { Dream, applyDream, describeDream, dreamNotes, dreamRequest, parseDream, readNote, DUE_AFTER } from '../dist/office/dream.js';
import { resetCooling } from '../dist/workspace/worker.js';

const note = (kind, title, text, project = '2026-11-13 태그 규칙') => ['---', `type: ${kind}`, 'project: p-1', 'date: 2026-11-13', 'author: Nidus', '---', `# ${title}`, '', text, '', `출처: [[${project}]]`].join('\n');

async function vault(t, lessons = [], decisions = []) {
  const dir = await mkdtemp(join(tmpdir(), 'nidus-dream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await mkdir(join(dir, '.nidus', 'local'), { recursive: true });
  await writeFile(join(dir, '내 노트.md'), '사용자의 글. 예시를 모은다.\n');
  const library = new Library(dir, 'Nidus');
  let at = 1_700_000_000;
  for (const [folder, kind, list] of [['Lessons', 'lesson', lessons], ['Decisions', 'decision', decisions]]) {
    for (const [title, text, project] of list) {
      const path = await library.write(folder, title, note(kind, title, text, project));
      await utimes(join(dir, path), at, at); at += 60;
    }
  }
  return { dir, library };
}
const lessons = [
  ['예시를 먼저 모은다', '글쓰기 전에 예시를 세 개 모은다.', '2026-11-12 메모 글'],
  ['파일 저장 생략', '이번 요청은 파일로 저장하지 않았다.'],
  ['글 전에 예시 수집', '초안을 쓰기 전에 실제 예시부터 찾는다.'],
  ['표는 세 열까지', '표가 넓으면 읽기 어렵다. 세 열까지만.'],
];
const decisions = [['독자는 초보자', '쉬운 말로 쓴다.'], ['독자는 전문가', '용어를 풀어 쓰지 않는다.']];
const plan = { summary: '같은 교훈 둘을 합치고 사소한 하나를 보관했습니다.', merge: [{ sources: ['L1', 'L3'], title: '예시를 먼저 모은다', text: '초안 전에 실제 예시를 세 개 모은다.' }], retire: [{ id: 'L2', reason: '한 요청에만 해당' }], conflicts: [{ ids: ['D1', 'D2'], note: '독자 수준이 서로 다름' }], wiki: [] };

test('a dream reads the team\'s notes without frontmatter, with the projects they came from', async t => {
  const { library } = await vault(t, lessons, decisions);
  const notes = await dreamNotes(library);
  assert.deepEqual(notes.map(n => `${n.id} ${n.title}`), ['L1 예시를 먼저 모은다', 'L2 파일 저장 생략', 'L3 글 전에 예시 수집', 'L4 표는 세 열까지', 'D1 독자는 초보자', 'D2 독자는 전문가']);
  assert.deepEqual([notes[0].body, notes[0].sources, notes[0].date, notes[0].kind], ['글쓰기 전에 예시를 세 개 모은다.', ['2026-11-12 메모 글'], '2026-11-13', 'lesson']);
  const request = dreamRequest(notes);
  assert.match(request, /\[L1\] lesson \(교훈\) "예시를 먼저 모은다" \(2026-11-13\) from 2026-11-12 메모 글\n글쓰기 전에/);
  assert.match(request, /\[D2\] decision/);
  assert.equal(readNote('L9', 'lesson', { path: 'a.md', title: 'a', text: '그냥 글' }).body, '그냥 글');
});

test('parseDream accepts only known notes, each once, and merges of one kind', async t => {
  const { library } = await vault(t, lessons, decisions);
  const notes = await dreamNotes(library);
  assert.deepEqual(parseDream(JSON.stringify(plan), notes), plan);
  assert.deepEqual(parseDream('{"summary": "정리할 것 없음"}', notes), { summary: '정리할 것 없음', merge: [], retire: [], conflicts: [], wiki: [] });
  const bad = change => () => parseDream(JSON.stringify({ ...plan, ...change }), notes);
  assert.throws(bad({ retire: [{ id: 'L9', reason: 'x' }] }), /unknown note id L9/);
  assert.throws(bad({ retire: [{ id: 'L1', reason: 'x' }] }), /L1 appears more than once/);
  assert.throws(bad({ merge: [{ sources: ['L1'], title: 'a', text: 'b' }] }), /two or more/);
  assert.throws(bad({ merge: [{ sources: ['L1', 'D1'], title: 'a', text: 'b' }] }), /cannot be merged/);
  assert.throws(bad({ merge: [{ sources: ['L1', 'L3'], title: '', text: 'b' }] }), /non-empty/);
  assert.deepEqual(parseDream(JSON.stringify({ conflicts: [{ ids: ['D1', 'D9'], note: 'x' }, { ids: ['D1', 'D2'], note: '' }] }), notes).conflicts, [], 'a conflict needs two known notes and a note');
});

test('a dream merges, retires to the archive and reports conflicts; nothing is deleted, the user\'s notes are untouched', async t => {
  const { dir, library } = await vault(t, lessons, decisions);
  const notes = await dreamNotes(library);
  const report = await applyDream(library, notes, plan, new Date(2026, 10, 14));
  assert.deepEqual((await readdir(join(dir, 'Nidus', 'Lessons'))).sort(), ['예시를 먼저 모은다.md', '표는 세 열까지.md']);
  assert.deepEqual((await readdir(join(dir, 'Nidus', 'Archive', 'Lessons'))).sort(), ['글 전에 예시 수집.md', '예시를 먼저 모은다.md', '파일 저장 생략.md']);
  assert.deepEqual((await readdir(join(dir, 'Nidus', 'Decisions'))).sort(), ['독자는 전문가.md', '독자는 초보자.md'], 'contradicting notes stay for the user to decide');
  const merged = await readFile(join(dir, 'Nidus', 'Lessons', '예시를 먼저 모은다.md'), 'utf8');
  assert.match(merged, /^---\ntype: lesson\ndate: 2026-11-14\nmerged: 2\nauthor: Nidus\n---\n# 예시를 먼저 모은다\n\n초안 전에 실제 예시를 세 개 모은다\.\n\n출처: \[\[2026-11-12 메모 글\]\], \[\[2026-11-13 태그 규칙\]\]\n합친 문서: 예시를 먼저 모은다 · 글 전에 예시 수집\n$/);
  const archived = await readFile(join(dir, 'Nidus', 'Archive', 'Lessons', '파일 저장 생략.md'), 'utf8');
  assert.match(archived, /이번 요청은 파일로 저장하지 않았다\.[\s\S]*\n> 보관됨: 한 요청에만 해당 \(2026-11-14\)\n$/);
  assert.match(await readFile(join(dir, 'Nidus', 'Archive', 'Lessons', '글 전에 예시 수집.md'), 'utf8'), /> 보관됨: "예시를 먼저 모은다"\(으\)로 합쳐짐/);
  assert.equal(report.record, 'Nidus/Dream/2026-11-14 Library 정리.md');
  const record = await readFile(join(dir, report.record), 'utf8');
  assert.match(record, /읽은 문서 6개 · 합침 1건 · 보관 1건 · 사용자 확인 필요 1건/);
  assert.match(record, /- \[\[독자는 초보자\]\] ↔ \[\[독자는 전문가\]\]: 독자 수준이 서로 다름/);
  assert.match(record, /- \[\[예시를 먼저 모은다\]\] ← 예시를 먼저 모은다 · 글 전에 예시 수집/);
  assert.equal(await readFile(join(dir, '내 노트.md'), 'utf8'), '사용자의 글. 예시를 모은다.\n');
  // What was put away is no longer found or shown to Main; what is kept is.
  const found = (await library.search('예시')).map(h => h.path);
  assert.ok(found.includes('Nidus/Lessons/예시를 먼저 모은다.md') && !found.some(p => p.includes('/Archive/')), found.join());
  const digest = await library.digest();
  assert.ok(!digest.includes('파일 저장 생략') && digest.includes('표는 세 열까지'));
  const text = describeDream(report);
  assert.match(text, /팀 문서\(교훈·결정·Skill·Wiki\) 6개/); assert.match(text, /\*\*합침 1건\*\*/); assert.match(text, /독자는 초보자 ↔ 독자는 전문가/);
  // Only the AI's own documents can be archived.
  await assert.rejects(library.archive('내 노트.md', 'x'), /not a document of the AI's own folder/);
  await assert.rejects(library.archive('Nidus/Archive/Lessons/파일 저장 생략.md', 'x'), /not a document/);
});

test('Dream: one model call, a malformed plan is asked for again, too few notes need no call, and it is due after enough new notes', async t => {
  resetCooling();
  const { dir, library } = await vault(t, lessons, decisions);
  const requests = [], answers = ['{"retire": [{"id": "L77"}]}', JSON.stringify(plan)];
  const gateway = { async send(target, request) { requests.push({ target, request: structuredClone(request) }); return { response: { provider: 'p', model: 'm', content: [{ type: 'text', text: answers.shift() }], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }, costUSD: null, warnings: [] }; } };
  const stateFile = join(dir, '.nidus', 'local', 'dream.json');
  const dream = new Dream({ gateway, library, stateFile, retryWaits: [] });
  assert.equal(await dream.due(), false, `${lessons.length + decisions.length} new notes are fewer than ${DUE_AFTER}`);
  const report = await dream.run(new AbortController().signal);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].target.role, 'main');
  assert.match(requests[0].request.system, /Library Manager/);
  assert.match(requests[1].request.messages[2].content[0].text, /could not be used: unknown note id L77/);
  assert.deepEqual([report.merged.length, report.retired.length, report.conflicts.length], [1, 1, 1]);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).merged, 1);
  for (let i = 0; i < DUE_AFTER; i++) await library.write('Lessons', `새 교훈 ${i}`, note('lesson', `새 교훈 ${i}`, '내용'));
  assert.equal(await dream.due(), true);
  const small = await vault(t, lessons.slice(0, 2));
  const idle = await new Dream({ gateway, library: small.library, stateFile: join(small.dir, '.nidus', 'local', 'dream.json') }).run(new AbortController().signal);
  assert.equal(requests.length, 2, 'no model call for two notes');
  assert.match(describeDream(idle), /정리할 것이 없었습니다/);
});

test('Wiki: a dream draws notes on one topic into a page that links them (a merged note by its new name), and later rewrites that page in place', async t => {
  const { dir, library } = await vault(t, lessons, decisions);
  await library.write('Skills', '예시 수집 절차', note('skill', '예시 수집 절차', '1. 비슷한 글 세 개를 찾는다\n2. 구조를 표로 비교한다'));
  const notes = await dreamNotes(library);
  assert.deepEqual(notes.filter(n => n.kind === 'skill').map(n => n.id), ['S1']);
  const bad = wiki => () => parseDream(JSON.stringify({ wiki }), notes);
  assert.throws(bad([{ title: '예시', text: 'x', sources: ['L1'] }]), /two or more notes/);
  assert.throws(bad([{ title: '', text: 'x', sources: ['L1', 'S1'] }]), /title and a text/);
  assert.throws(bad([{ page: 'L1', title: 'a', text: 'x', sources: ['L1', 'S1'] }]), /not a Wiki page/);
  assert.throws(() => parseDream(JSON.stringify({ merge: [{ sources: ['L1', 'S1'], title: 'a', text: 'b' }] }), notes), /different kinds/);
  const first = parseDream(JSON.stringify({ summary: 's', merge: [{ sources: ['L1', 'L3'], title: '예시를 먼저 모은다', text: '합친 글' }], wiki: [{ title: '글쓰기 준비', text: '글을 쓰기 전에는 예시부터 모은다. 절차는 Skill을 따른다.', sources: ['L1', 'S1', 'L4'] }] }), notes);
  const report = await applyDream(library, notes, first, new Date(2026, 10, 17));
  assert.deepEqual(report.wiki.map(w => [w.path, w.updated, w.from]), [['Nidus/Wiki/글쓰기 준비.md', false, ['예시를 먼저 모은다', '예시 수집 절차', '표는 세 열까지']]]);
  const page = await readFile(join(dir, 'Nidus', 'Wiki', '글쓰기 준비.md'), 'utf8');
  assert.match(page, /^---\ntype: wiki\ndate: 2026-11-17\nsources: 3\nauthor: Nidus\n---\n# 글쓰기 준비\n\n글을 쓰기 전에는 예시부터 모은다\. 절차는 Skill을 따른다\.\n\n## 근거\n\n- \[\[예시를 먼저 모은다\]\]\n- \[\[예시 수집 절차\]\]\n- \[\[표는 세 열까지\]\]\n$/);
  assert.match(describeDream(report), /\*\*Wiki 1건\*\*\n- 글쓰기 준비 \(새로\)/);
  // The next dream sees the page (W1) and brings it up to date in place; it cannot merge or retire it.
  const again = await dreamNotes(library);
  const w = again.find(n => n.kind === 'wiki');
  assert.equal(w.id, 'W1');
  assert.throws(() => parseDream(JSON.stringify({ retire: [{ id: 'W1', reason: 'x' }] }), again), /rewritten, not retired/);
  const ids = Object.fromEntries(again.map(n => [n.title, n.id]));
  const second = parseDream(JSON.stringify({ wiki: [{ page: 'W1', title: '글쓰기 준비', text: '고친 종합', sources: [ids['예시 수집 절차'], ids['표는 세 열까지']] }] }), again);
  const updated = await applyDream(library, again, second, new Date(2026, 10, 18));
  assert.deepEqual(updated.wiki.map(x => [x.path, x.updated]), [['Nidus/Wiki/글쓰기 준비.md', true]]);
  assert.deepEqual(await readdir(join(dir, 'Nidus', 'Wiki')), ['글쓰기 준비.md'], 'rewritten, not a second page');
  assert.match(await readFile(join(dir, 'Nidus', 'Wiki', '글쓰기 준비.md'), 'utf8'), /고친 종합/);
  await assert.rejects(library.rewriteOwn('내 노트.md', 'x'), /not a document of the AI's own folder/);
  // What Main reads before planning has the Wiki and the Skills first.
  const digest = await library.digest();
  assert.ok(digest.indexOf('Wiki (what the team knows') < digest.indexOf('Skills (procedures') && digest.indexOf('Skills (procedures') < digest.indexOf('Lessons from'));
});
