import { register } from 'node:module';

// Unit tests import source modules written for Vite (extensionless relative
// specifiers). Node's type-stripping loader does not resolve those.
register('./resolve-ts-hook.mjs', import.meta.url);
