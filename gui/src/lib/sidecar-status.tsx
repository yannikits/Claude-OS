import { createContext, type ReactNode, useContext } from 'react';
import type { SidecarFailedPayload } from './rpc';

export interface SidecarStatus {
  ok: boolean;
  failure: SidecarFailedPayload | null;
}

const SidecarStatusContext = createContext<SidecarStatus>({ ok: true, failure: null });

export function SidecarStatusProvider({
  failure,
  children,
}: {
  failure: SidecarFailedPayload | null;
  children: ReactNode;
}) {
  const value: SidecarStatus = { ok: failure === null, failure };
  return <SidecarStatusContext.Provider value={value}>{children}</SidecarStatusContext.Provider>;
}

export function useSidecarStatus(): SidecarStatus {
  return useContext(SidecarStatusContext);
}

export function useSidecarOk(): boolean {
  return useContext(SidecarStatusContext).ok;
}
