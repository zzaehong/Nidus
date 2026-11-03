import type {ToolDefinition} from '../tools/contracts.js';
export const webToolsAvailable=(tools:ToolDefinition[])=>tools.some(t=>t.implemented&&t.target==='vm'&&['browser_search','browser_navigate','browser_read_page'].includes(t.name));
export function toolEnvironmentInstructions(tools:ToolDefinition[]):string {
 return webToolsAvailable(tools)
  ? 'Only claim web verification when a provided browser tool actually succeeded in this task. Cite only evidence returned by tools.'
  : 'This runtime has NO web search, internet browsing, or live information retrieval. The VM Shell is OFFLINE and cannot be used as a network workaround. If the user asks for web research or current information, clearly explain that live verification is unavailable. Never claim you searched, opened a URL, or verified current facts. Model knowledge and supplied files are not live web evidence.';
}
