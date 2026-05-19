import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StderrDrawer } from '../src/lib/stderr-drawer';

type Handler = (payload: { line: string }) => void;

function makeSubscribe() {
  let captured: Handler | null = null;
  const subscribe = vi.fn(async (handler: Handler) => {
    captured = handler;
    return () => {
      captured = null;
    };
  });
  return {
    subscribe,
    emit: (line: string) => {
      if (!captured) throw new Error('subscriber not registered yet');
      captured({ line });
    },
  };
}

describe('StderrDrawer', () => {
  it('rendert nur den Toggle-Button bevor er aufgeklappt wird', () => {
    const { subscribe } = makeSubscribe();
    render(<StderrDrawer subscribe={subscribe} />);
    expect(
      screen.getByRole('button', { name: /sidecar stderr drawer toggle/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('complementary', { name: /sidecar stderr log/i }),
    ).not.toBeInTheDocument();
  });

  it('öffnet das Drawer und zeigt eingehende stderr-Lines an', async () => {
    const { subscribe, emit } = makeSubscribe();
    render(<StderrDrawer subscribe={subscribe} />);

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    emit('[sidecar.stderr] hello');
    await waitFor(() => {
      const counter = screen.getByRole('button', { name: /sidecar stderr drawer toggle/i });
      expect(counter.textContent).toContain('1');
    });

    fireEvent.click(screen.getByRole('button', { name: /sidecar stderr drawer toggle/i }));

    const log = await screen.findByTestId('stderr-drawer-log');
    expect(log.textContent).toContain('[sidecar.stderr] hello');

    emit('[sidecar.stderr] world');
    await waitFor(() => expect(log.textContent).toContain('[sidecar.stderr] world'));
  });

  it('Leeren-Button löscht den Ring-Buffer', async () => {
    const { subscribe, emit } = makeSubscribe();
    render(<StderrDrawer subscribe={subscribe} />);
    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    emit('line one');
    emit('line two');
    fireEvent.click(screen.getByRole('button', { name: /sidecar stderr drawer toggle/i }));

    const log = await screen.findByTestId('stderr-drawer-log');
    expect(log.textContent).toContain('line one');
    expect(log.textContent).toContain('line two');

    fireEvent.click(screen.getByRole('button', { name: /leeren/i }));

    await waitFor(() => {
      expect(log.textContent).not.toContain('line one');
      expect(log.textContent).not.toContain('line two');
    });
    expect(log.textContent).toMatch(/Noch keine Stderr-Lines/);
  });
});
