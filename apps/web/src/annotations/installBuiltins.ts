import { annotationKinds } from './registry';
import { builtinLinearDimensionKind } from './builtinLinearDimension';
import { builtinTextNoteKind } from './builtinTextNote';

/** First-party annotation kinds (also registered for third parties via the same API). */
export function installBuiltinAnnotationKinds(): void {
  annotationKinds.register(builtinLinearDimensionKind());
  annotationKinds.register(builtinTextNoteKind());
}
