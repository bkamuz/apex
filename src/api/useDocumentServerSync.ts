import { useEffect } from 'react';
import type { BimFacade } from './BimFacade';

const DEBOUNCE_MS = 500;

/**
 * Debounced синхронизация снимка элементов на REST API (для внешних плагинов и Swagger).
 */
export function useDocumentServerSync(
  facade: BimFacade,
  projectId: string
): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const push = () => {
      const snapshot = facade.getSnapshot(projectId);
      void fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/elements`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        }
      ).catch(() => {
        /* API может быть выключен */
      });
    };

    const unsubscribe = facade.subscribe(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(push, DEBOUNCE_MS);
    });

    push();

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, [facade, projectId]);
}
