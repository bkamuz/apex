import type { ComponentDto } from '../types';

/** User and plugin components. Built-ins are edited by extending them. */
export function isUserAuthoredComponent(component: ComponentDto): boolean {
  return component.source !== 'built_in';
}
