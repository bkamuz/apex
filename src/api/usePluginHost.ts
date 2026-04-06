import { useContext } from 'react';
import { PluginHostContext } from './bimContexts';
import type { PluginHost } from '../plugin/PluginHost';

export function usePluginHost(): PluginHost {
  const ctx = useContext(PluginHostContext);
  if (!ctx) {
    throw new Error('usePluginHost must be used within BimApplicationProvider');
  }
  return ctx;
}
