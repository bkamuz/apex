import type { ApexPlugin } from '../types';

/**
 * Демонстрационный плагин: логирует изменения документа в консоль.
 */
export const demoPlugin: ApexPlugin = {
  id: 'apex.demo',
  name: 'Apex Demo Plugin',
  activate(ctx) {
    ctx.subscribeDocument((event) => {
      console.log(
        `[apex.demo] document ${event.type}`,
        'ids:',
        event.ids.length
      );
    });
  },
};
