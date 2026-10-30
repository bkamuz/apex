import type { Tool, ToolMode } from '../tools/Tool';
import type { Exporter } from '../plugins/types';
import { t } from './t';

/** Toolbar / tooltip label for a tool (catalog by id, else tool.label). */
export function toolDisplayLabel(tool: Tool): string {
  if (tool.id.startsWith('place:')) {
    const componentId = tool.id.slice('place:'.length);
    return t(`component.${componentId}`, undefined, tool.label);
  }
  return t(`tool.${tool.id}.label`, undefined, tool.label);
}

/** Draw-mode button label. */
export function modeDisplayLabel(mode: ToolMode): string {
  return t(`mode.${mode.id}`, undefined, mode.label);
}

/** Toolbar tab chip label (catalog tab ids). */
export function tabDisplayLabel(tabId: string, fallback: string): string {
  return t(`tab.${tabId}`, undefined, fallback);
}

/** Exporter button label / title. */
export function exporterDisplayLabel(exporter: Exporter): string {
  return t(`exporter.${exporter.id}.label`, undefined, exporter.label);
}

export function exporterDisplayTitle(exporter: Exporter): string {
  return t(`exporter.${exporter.id}.title`, undefined, exporter.title ?? exporter.label);
}

/** Component display name overlay for inspector / browser. */
export function componentDisplayName(componentId: string, fallback: string): string {
  return t(`component.${componentId}`, undefined, fallback);
}
