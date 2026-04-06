import { useContext } from 'react';
import { BimFacadeContext } from './bimContexts';
import type { BimFacade } from './BimFacade';

export function useBimFacade(): BimFacade {
  const ctx = useContext(BimFacadeContext);
  if (!ctx) {
    throw new Error('useBimFacade must be used within BimApplicationProvider');
  }
  return ctx;
}
