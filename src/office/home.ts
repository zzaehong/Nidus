// Home (CONCEPT: "AI Employee의 정체성, 역할, 원칙, 상태"). The standing staff of a Vault:
// Groups (teams by domain) and Employees with an identity that does not depend on a model.
//   .nidus/office/staff.json     groups and employees        (tracked by Git: moves with the Vault)
//   .nidus/local/home/<id>.json  where each employee is now  (recovery pointer, not tracked)
// A Vault starts with a small default staff. Main may propose more for a request; what the user
// approves as permanent is added here, temporary staff lives only in that project.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Group { id: string; name: string; focus: string }

export interface Employee {
  id: string;
  name: string;
  group: string;
  kind: 'manager' | 'worker';
  /** What the employee is in the team: Researcher, Developer, ... (a Manager: "Manager"). */
  role: string;
  /** Custom principles the user (or a proposal) gave this employee, on top of the role's. */
  principles: string[];
  createdAt?: string;
}

export interface Staff { version: 1; groups: Group[]; employees: Employee[] }

/** Where an employee is now: a pointer for recovery, not the context itself (that is the Desk). */
export interface HomeState { employee: string; project: string | null; task: string | null; status: 'idle' | 'started' | 'working' | 'review' | 'done' | 'blocked'; at: string }

const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function defaultStaff(): Staff {
  const group = (id: string, name: string, focus: string, worker: [string, string, string]): { group: Group; employees: Employee[] } => ({
    group: { id, name, focus },
    employees: [
      { id: `${id}-manager`, name: `${name} 팀장`, group: id, kind: 'manager', role: 'Manager', principles: [] },
      { id: worker[0], name: worker[1], group: id, kind: 'worker', role: worker[2], principles: [] },
    ],
  });
  const all = [
    group('research', '조사', '자료와 웹 조사, 사실 확인, 비교와 분석', ['researcher', '리서처', 'Researcher']),
    group('development', '개발', '코드 작성과 수정, 실행과 테스트, 자동화', ['developer', '개발자', 'Developer']),
    group('writing', '문서', '글쓰기, 정리와 요약, 번역, 문서 구조화', ['writer', '작가', 'Writer']),
  ];
  return { version: 1, groups: all.map(g => g.group), employees: all.flatMap(g => g.employees) };
}

/** Reads a staff file leniently: entries that do not make sense are dropped, not fatal. */
export function parseStaff(value: any): Staff {
  const text = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const groups: Group[] = [];
  for (const g of Array.isArray(value?.groups) ? value.groups : []) {
    if (typeof g?.id === 'string' && idPattern.test(g.id) && text(g.name, 80) && !groups.some(x => x.id === g.id)) groups.push({ id: g.id, name: text(g.name, 80), focus: text(g.focus, 400) });
  }
  const employees: Employee[] = [];
  for (const e of Array.isArray(value?.employees) ? value.employees : []) {
    if (typeof e?.id !== 'string' || !idPattern.test(e.id) || employees.some(x => x.id === e.id)) continue;
    if (!groups.some(g => g.id === e.group) || (e.kind !== 'manager' && e.kind !== 'worker') || !text(e.name, 80)) continue;
    // One Manager per group (CONCEPT): a second one is ignored.
    if (e.kind === 'manager' && employees.some(x => x.group === e.group && x.kind === 'manager')) continue;
    employees.push({ id: e.id, name: text(e.name, 80), group: e.group, kind: e.kind, role: text(e.role, 80) || (e.kind === 'manager' ? 'Manager' : 'Worker'),
      principles: (Array.isArray(e.principles) ? e.principles : []).map((p: unknown) => text(p, 500)).filter(Boolean).slice(0, 12), ...(typeof e.createdAt === 'string' ? { createdAt: e.createdAt } : {}) });
  }
  return { version: 1, groups, employees };
}

export const managerOf = (staff: { employees: Employee[] }, group: string) => staff.employees.find(e => e.group === group && e.kind === 'manager');
export const workersOf = (staff: { employees: Employee[] }, group: string) => staff.employees.filter(e => e.group === group && e.kind === 'worker');

/** The staff as Main sees it when planning. */
export function describeStaff(staff: Staff): string {
  if (!staff.groups.length) return '(no standing teams yet)';
  return staff.groups.map(g => {
    const manager = managerOf(staff, g.id);
    const workers = workersOf(staff, g.id).map(w => `${w.id} (${w.name}, ${w.role})`).join(', ') || '(no workers)';
    return `- team "${g.id}" ${g.name}: ${g.focus}\n  manager: ${manager ? `${manager.id} (${manager.name})` : '(none)'}; workers: ${workers}`;
  }).join('\n');
}

/** Who an employee is, for the top of its system prompt. The model behind it may change; this does not. */
export function identity(employee: Employee, group: Group | undefined): string {
  const lines = [`You are ${employee.name} (id ${employee.id}), ${employee.kind === 'manager' ? 'the Manager' : `a Worker with the role ${employee.role}`} of the ${group?.name ?? employee.group} team${group?.focus ? ` (${group.focus})` : ''}. This identity is yours whatever model runs you.`];
  if (employee.principles.length) lines.push('Your own principles, set by the user:', ...employee.principles.map(p => `- ${p}`));
  return lines.join('\n');
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.pending`;
  await writeFile(pending, JSON.stringify(value, null, 2) + '\n');
  await rename(pending, file);
}

export class HomeStore {
  constructor(private readonly staffFile: string, private readonly stateDirectory: string) {}

  /** The Vault's staff; a Vault without one gets the default staff. */
  async staff(): Promise<Staff> {
    let text: string;
    try { text = await readFile(this.staffFile, 'utf8'); }
    catch {
      const created = defaultStaff();
      await writeJson(this.staffFile, created);
      return created;
    }
    try { return parseStaff(JSON.parse(text)); }
    catch { throw new Error('.nidus/office/staff.json을 읽을 수 없습니다(JSON 형식 오류). 고치거나 지우면 기본 팀으로 다시 만듭니다.'); }
  }

  /** Adds groups and employees the user approved as permanent. Existing ids are left as they are. */
  async add(groups: Group[], employees: Employee[]): Promise<Staff> {
    const staff = await this.staff();
    for (const g of groups) if (!staff.groups.some(x => x.id === g.id)) staff.groups.push({ id: g.id, name: g.name, focus: g.focus });
    const merged = parseStaff({ groups: staff.groups, employees: [...staff.employees, ...employees.filter(e => !staff.employees.some(x => x.id === e.id)).map(e => ({ ...e, createdAt: new Date().toISOString() }))] });
    await writeJson(this.staffFile, merged);
    return merged;
  }

  /** Replaces an employee's own principles (the user's edit). */
  async setPrinciples(employeeId: string, principles: string[]): Promise<Staff> {
    const staff = await this.staff();
    const employee = staff.employees.find(e => e.id === employeeId);
    if (!employee) throw new Error('그런 직원이 없습니다');
    employee.principles = principles.map(p => String(p).trim().slice(0, 500)).filter(Boolean).slice(0, 12);
    await writeJson(this.staffFile, staff);
    return staff;
  }

  async setState(state: Omit<HomeState, 'at'>): Promise<void> {
    if (!idPattern.test(state.employee)) return;
    await writeJson(join(this.stateDirectory, `${state.employee}.json`), { ...state, at: new Date().toISOString() }).catch(() => {});
  }

  async state(employeeId: string): Promise<HomeState | null> {
    if (!idPattern.test(employeeId)) return null;
    try { return JSON.parse(await readFile(join(this.stateDirectory, `${employeeId}.json`), 'utf8')) as HomeState; } catch { return null; }
  }
}
