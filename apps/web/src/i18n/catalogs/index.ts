import type { Locale, MessageCatalog } from '../types';
import { en } from './en';
import { ru } from './ru';

export const CATALOGS: Record<Locale, MessageCatalog> = {
  en,
  ru,
};

export { en, ru };
