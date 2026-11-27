import { hasMessage, t } from '../i18n/t';

/**
 * Sample document strings (level, room, and view prefixes) are catalog keys
 * so the plan, browser, and inspector follow the active locale.
 * A name that is not a catalog key is shown as stored.
 */
export function localizeDocumentName(name: string): string {
  if (!name.startsWith('sample.')) return name;
  return hasMessage(name) ? t(name) : name;
}
