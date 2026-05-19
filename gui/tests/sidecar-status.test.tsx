import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidecarStatusProvider, useSidecarOk, useSidecarStatus } from '../src/lib/sidecar-status';

function Probe() {
  const { ok, failure } = useSidecarStatus();
  const okFromHook = useSidecarOk();
  return (
    <div>
      <span data-testid="ok">{String(ok)}</span>
      <span data-testid="ok-hook">{String(okFromHook)}</span>
      <span data-testid="reason">{failure?.reason ?? '(none)'}</span>
    </div>
  );
}

describe('SidecarStatusProvider', () => {
  it('reports ok=true wenn kein failure', () => {
    render(
      <SidecarStatusProvider failure={null}>
        <Probe />
      </SidecarStatusProvider>,
    );
    expect(screen.getByTestId('ok').textContent).toBe('true');
    expect(screen.getByTestId('ok-hook').textContent).toBe('true');
    expect(screen.getByTestId('reason').textContent).toBe('(none)');
  });

  it('reports ok=false und exposed reason wenn failure gesetzt', () => {
    render(
      <SidecarStatusProvider failure={{ reason: 'spawn EACCES', strikes: 3 }}>
        <Probe />
      </SidecarStatusProvider>,
    );
    expect(screen.getByTestId('ok').textContent).toBe('false');
    expect(screen.getByTestId('ok-hook').textContent).toBe('false');
    expect(screen.getByTestId('reason').textContent).toBe('spawn EACCES');
  });

  it('default-Context (kein Provider) liefert ok=true', () => {
    render(<Probe />);
    expect(screen.getByTestId('ok').textContent).toBe('true');
  });
});
