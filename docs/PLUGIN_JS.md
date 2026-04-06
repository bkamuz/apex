# In-process плагины (JavaScript / TypeScript)

Плагины выполняются в той же вкладке, что и вьювер. Точка входа — контракт `ApexPlugin` в `src/plugin/types.ts`.

## Регистрация

Встроенные плагины перечисляются в `src/api/BimApplicationProvider.tsx` (массив `BUILT_IN_PLUGINS`). Добавьте свой модуль:

```ts
import type { ApexPlugin } from '../plugin/types';

export const myPlugin: ApexPlugin = {
  id: 'my.vendor.feature',
  name: 'My feature',
  async activate(ctx) {
    ctx.subscribeDocument((event) => {
      // реакция на изменения Document
    });
    ctx.registerCommand('my.action', () => {
      const els = ctx.facade.listElements();
      console.log(els.length);
    });
  },
  async deactivate() {
    // опционально
  },
};
```

Затем импортируйте плагин и добавьте в `BUILT_IN_PLUGINS`.

## Контекст плагина

- `ctx.facade` — экземпляр `BimFacade`: `listElements()`, `getElement(id)`, `getSnapshot(projectId)`, `subscribe` через `subscribeDocument`, работа с IFC/нативной геометрией через методы фасада.
- `ctx.subscribeDocument` — подписка на события ядра; при деактивации плагина отписки вызываются автоматически.
- `ctx.registerCommand` — именованные команды (для будущего UI или вызова из других плагинов через `usePluginHost().runCommand(id)`).
- `ctx.apiFetch` — обёртка над `fetch` для вызова REST (в dev те же пути `/api/...` проксируются на сервер).

## React

- `useBimFacade()` (`src/api/useBimFacade.ts`) — доступ к фасаду из компонентов внутри `BimApplicationProvider`.
- `usePluginHost()` (`src/api/usePluginHost.ts`) — доступ к хосту плагинов (например, `runCommand`).

## Демо

Плагин `apex.demo` (`src/plugin/plugins/demoPlugin.ts`) пишет в консоль при каждом изменении документа.
