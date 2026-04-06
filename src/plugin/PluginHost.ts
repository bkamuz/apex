import type { BimFacade } from '../api/BimFacade';
import type { ApexPlugin, PluginContext } from './types';

interface ActivatedEntry {
  plugin: ApexPlugin;
  cleanups: (() => void)[];
}

/**
 * Загрузка и изоляция in-process плагинов.
 */
export class PluginHost {
  private readonly commands = new Map<string, () => void>();
  private activated: ActivatedEntry[] = [];
  private readonly facade: BimFacade;
  private readonly plugins: readonly ApexPlugin[];

  constructor(facade: BimFacade, plugins: readonly ApexPlugin[]) {
    this.facade = facade;
    this.plugins = plugins;
  }

  private buildContext(cleanups: (() => void)[]): PluginContext {
    return {
      facade: this.facade,
      subscribeDocument: (listener) => {
        const off = this.facade.subscribe(listener);
        cleanups.push(off);
        return off;
      },
      registerCommand: (id, handler) => {
        this.commands.set(id, handler);
        const off = () => {
          this.commands.delete(id);
        };
        cleanups.push(off);
        return off;
      },
      apiFetch: (input, init) => fetch(input, init),
    };
  }

  async activateAll(): Promise<void> {
    for (const plugin of this.plugins) {
      const cleanups: (() => void)[] = [];
      const ctx = this.buildContext(cleanups);
      try {
        await plugin.activate(ctx);
        this.activated.push({ plugin, cleanups });
      } catch (err) {
        console.error(`[PluginHost] activate ${plugin.id}:`, err);
        cleanups.forEach((fn) => fn());
      }
    }
  }

  deactivateAll(): void {
    for (const { plugin, cleanups } of [...this.activated].reverse()) {
      cleanups.forEach((fn) => fn());
      try {
        void plugin.deactivate?.();
      } catch (err) {
        console.error(`[PluginHost] deactivate ${plugin.id}:`, err);
      }
    }
    this.activated = [];
    this.commands.clear();
  }

  runCommand(id: string): void {
    const fn = this.commands.get(id);
    if (fn) fn();
  }
}
