import { createContext } from 'react';
import type { BimFacade } from './BimFacade';
import type { PluginHost } from '../plugin/PluginHost';

export const BimFacadeContext = createContext<BimFacade | null>(null);
export const PluginHostContext = createContext<PluginHost | null>(null);
