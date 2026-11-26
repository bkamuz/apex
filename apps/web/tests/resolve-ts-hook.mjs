const HAS_EXT = /\.(?:[cm]?js|json|ts|tsx|css|wasm|svg)$/;

/** Resolve relative imports that omit the `.ts` Vite allows. */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return nextResolve(specifier, context);
  }
  if (HAS_EXT.test(specifier)) return nextResolve(specifier, context);
  try {
    return await nextResolve(`${specifier}.ts`, context);
  } catch {
    return nextResolve(`${specifier}/index.ts`, context);
  }
}
