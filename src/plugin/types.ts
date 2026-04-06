import type { BimFacade } from '../api/BimFacade';
import type { DocumentChangeEvent } from '../core/document';

export interface PluginContext {
  facade: BimFacade;
  subscribeDocument(listener: (event: DocumentChangeEvent) => void): () => void;
  /** Регистрация именованной команды; возвращает отписку. */
  registerCommand(id: string, handler: () => void): () => void;
  /** Обертка над fetch (для вызова REST API приложения / внешних сервисов). */
  apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ApexPlugin {
  id: string;
  name: string;
  activate(context: PluginContext): void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}
