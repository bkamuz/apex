import { CATALOGS } from '../i18n/catalogs';
import { hasMessage, t } from '../i18n/t';

const SAMPLE_KEY = /sample(?:\.[a-z0-9_]+)+/i;
const PLAN_SUFFIX = /^(\s*[—–-]\s*)plan(\s+\d+)?$/i;

let lowerCatalog: Map<string, string> | null = null;

/** Catalog key for a sample token, matching case-insensitively (`upperHall`). */
function canonicalSampleKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (hasMessage(lower)) return lower;
  if (!lowerCatalog) {
    lowerCatalog = new Map();
    for (const key of Object.keys(CATALOGS.en)) lowerCatalog.set(key.toLowerCase(), key);
  }
  const hit = lowerCatalog.get(lower);
  return hit && hasMessage(hit) ? hit : null;
}

/**
 * Sample document strings (level, room, and view prefixes) are catalog keys
 * so the plan, browser, and inspector follow the active locale.
 * Sheet titles uppercase the stored view name (`SAMPLE.LEVEL.GROUND — PLAN`);
 * the key is matched case-insensitively and a trailing Plan word is translated.
 * A name that is not a catalog key is shown as stored.
 */
export function localizeDocumentName(name: string): string {
  const match = SAMPLE_KEY.exec(name);
  if (!match) return name;
  const key = canonicalSampleKey(match[0]);
  if (!key) return name;
  const rest = name.slice(match.index + match[0].length);
  const suffix = PLAN_SUFFIX.exec(rest);
  const tail = suffix
    ? `${suffix[1]}${t('viewName.plan')}${suffix[2] ?? ''}`
    : rest;
  return name.slice(0, match.index) + t(key) + tail;
}
