import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createDocument } from '../core/document';
import { PluginHost, demoPlugin } from '../plugin';
import { BimFacade } from './BimFacade';
import { BimFacadeContext, PluginHostContext } from './bimContexts';

const BUILT_IN_PLUGINS = [demoPlugin] as const;

export function BimApplicationProvider({ children }: { children: ReactNode }) {
  const [document] = useState(() => createDocument());
  const facade = useMemo(() => new BimFacade(document), [document]);
  const pluginHost = useMemo(
    () => new PluginHost(facade, BUILT_IN_PLUGINS),
    [facade]
  );

  useEffect(() => {
    void pluginHost.activateAll();
    return () => {
      pluginHost.deactivateAll();
    };
  }, [pluginHost]);

  return (
    <BimFacadeContext.Provider value={facade}>
      <PluginHostContext.Provider value={pluginHost}>
        {children}
      </PluginHostContext.Provider>
    </BimFacadeContext.Provider>
  );
}
