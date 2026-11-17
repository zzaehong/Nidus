// Meeting Room (CONCEPT 7): what the AI must not decide alone is put to the user as an agenda —
// the matter, its background, the reasoning, the options with their impact, and the team's own
// recommendation. The Task it holds up waits; the rest of the project goes on. The user picks an
// option, gives other instructions, or says not to do it; the decision goes into the Task and its
// Desk, and into the Library when the user marks it as one to keep.
// Agendas are part of the project (Task Board), so they survive a restart.
import { PlanError } from './plan.js';

export interface AgendaOption { label: string; impact: string }

export interface Decision {
  kind: 'option' | 'instruct' | 'reject';
  /** The option picked (0-based), for kind "option". */
  option?: number;
  /** The user's words: a change to the option, or the instructions. */
  note: string;
  /** Write it into the Library as a decision. */
  remember: boolean;
  at: string;
}

export interface Agenda {
  id: string;
  /** Who put it to the user. */
  from: 'manager' | 'red-team' | 'lead-manager';
  /** The Task it holds up, if any. */
  taskId: string | null;
  title: string;
  background: string;
  reasoning: string;
  options: AgendaOption[];
  /** What the team would do, and why. */
  recommendation: string;
  at: string;
  decision?: Decision;
  /** The decision has been handed to the work. */
  applied?: boolean;
}

const text = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/** An agenda as a model wrote it, checked; throws PlanError when it is not usable. */
export function parseAgenda(raw: any): Pick<Agenda, 'title' | 'background' | 'reasoning' | 'options' | 'recommendation'> {
  const title = text(raw?.title, 200);
  if (!title) throw new PlanError('agenda.title: say what is to be decided');
  const options = (Array.isArray(raw?.options) ? raw.options : []).map((o: any) => typeof o === 'string' ? { label: text(o, 300), impact: '' } : { label: text(o?.label, 300), impact: text(o?.impact, 800) })
    .filter((o: AgendaOption) => o.label).slice(0, 5);
  if (options.length < 2) throw new PlanError('agenda.options: give at least two options, each with its impact');
  return { title, background: text(raw?.background, 3000), reasoning: text(raw?.reasoning, 3000), options, recommendation: text(raw?.recommendation, 1500) };
}

/** The format a model is asked for, inside its JSON answer. */
export const AGENDA_FORMAT = '"agenda": {"title": "what is to be decided", "background": "what the user needs to know", "reasoning": "what the decision depends on", "options": [{"label": "...", "impact": "what follows, cost, risk"}], "recommendation": "what you would do and why"}';

/** The decision in words, for the team that goes on with the work. */
export function decisionText(agenda: Agenda): string {
  const d = agenda.decision;
  if (!d) return 'Not decided yet.';
  const note = d.note ? ` The user adds: ${d.note}` : '';
  if (d.kind === 'reject') return `The user decided not to do this.${note}`;
  if (d.kind === 'instruct') return `The user chose none of the options and instructs: ${d.note}`;
  const option = agenda.options[d.option ?? -1];
  return `The user chose: ${option ? `${option.label}${option.impact ? ` (${option.impact})` : ''}` : '(unknown option)'}.${note}`;
}

/** Checks the user's decision against the agenda. */
export function checkDecision(agenda: Agenda, input: { kind: unknown; option?: unknown; note?: unknown; remember?: unknown }, now = new Date()): Decision {
  if (agenda.decision) throw new Error('이미 결정한 안건입니다');
  const kind = input.kind;
  if (kind !== 'option' && kind !== 'instruct' && kind !== 'reject') throw new Error('결정 종류가 올바르지 않습니다');
  const note = text(input.note, 4000);
  const option = Number(input.option);
  if (kind === 'option' && !(Number.isInteger(option) && option >= 0 && option < agenda.options.length)) throw new Error('고른 선택지가 없습니다');
  if (kind === 'instruct' && !note) throw new Error('지시를 적어 주세요');
  return { kind, ...(kind === 'option' ? { option } : {}), note, remember: input.remember === true, at: now.toISOString() };
}

/** The agenda as a Library decision note (when the user marks it as one to keep). */
export function decisionNote(agenda: Agenda): { title: string; text: string } {
  return {
    title: agenda.title,
    text: [agenda.background, '', `결정: ${agenda.decision?.kind === 'option' ? agenda.options[agenda.decision.option!]?.label : agenda.decision?.kind === 'reject' ? '하지 않음' : '다른 지시'}`, agenda.decision?.note ? `사용자: ${agenda.decision.note}` : '', '', '검토한 선택지:', ...agenda.options.map(o => `- ${o.label}${o.impact ? ` — ${o.impact}` : ''}`)].filter((line, i, all) => line || all[i - 1]).join('\n').trim(),
  };
}
