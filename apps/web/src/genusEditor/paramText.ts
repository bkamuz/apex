/** Localized messages for param issues and formula errors. */
import type { ParamIssue } from './params';

type Translate = (key: string, params?: Record<string, string | number>, fallback?: string) => string;

export function formulaMessage(issue: ParamIssue, t: Translate): string {
  if (!issue.formula) return t(`genusEditor.issue.${issue.code}`, issue.detail);
  const f = issue.formula;
  const pos = f.pos !== undefined ? t('genusEditor.formula.at', { pos: f.pos + 1 }) : '';
  return `${t(`genusEditor.formula.err.${f.code}`, f.detail)}${pos}`;
}

export function issueMessage(issue: ParamIssue, t: Translate): string {
  return issue.field === 'formula' ? formulaMessage(issue, t) : t(`genusEditor.issue.${issue.code}`, issue.detail);
}
