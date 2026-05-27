import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterPage } from '../src/pages/register';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RegisterPage', () => {
  it('renders the form fields', () => {
    render(<RegisterPage onRegistered={() => {}} onCancel={() => {}} />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
    expect(screen.getByText('Passwort (mindestens 12 Zeichen)')).toBeTruthy();
    expect(screen.getByText('Passwort bestätigen')).toBeTruthy();
  });

  it('rejects mismatching confirm-password before calling fetch', async () => {
    render(<RegisterPage onRegistered={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'alice@example.com' },
    });
    const passwordInputs = screen
      .getAllByLabelText(/Passwort/i)
      .filter((el) => el.tagName === 'INPUT');
    fireEvent.change(passwordInputs[0]!, { target: { value: 'a-strong-passphrase-here' } });
    fireEvent.change(passwordInputs[1]!, { target: { value: 'a-different-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrieren' }));

    await waitFor(() => {
      expect(screen.getByText(/stimmen nicht überein/)).toBeTruthy();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls onRegistered with the normalized email on 201', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ user: { id: 'u-1', email: 'alice@example.com', tenantId: 'user-x' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const onRegistered = vi.fn();
    render(<RegisterPage onRegistered={onRegistered} onCancel={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: '  Alice@Example.COM  ' },
    });
    const passwordInputs = screen
      .getAllByLabelText(/Passwort/i)
      .filter((el) => el.tagName === 'INPUT');
    fireEvent.change(passwordInputs[0]!, { target: { value: 'correct-horse-battery-staple' } });
    fireEvent.change(passwordInputs[1]!, { target: { value: 'correct-horse-battery-staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrieren' }));

    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledWith('alice@example.com');
    });
  });

  it('shows duplicate-email error message when server returns the code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'duplicate-email', message: 'Email already registered' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(<RegisterPage onRegistered={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'alice@example.com' },
    });
    const passwordInputs = screen
      .getAllByLabelText(/Passwort/i)
      .filter((el) => el.tagName === 'INPUT');
    fireEvent.change(passwordInputs[0]!, { target: { value: 'correct-horse-battery-staple' } });
    fireEvent.change(passwordInputs[1]!, { target: { value: 'correct-horse-battery-staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrieren' }));

    await waitFor(() => {
      expect(screen.getByText(/bereits registriert/i)).toBeTruthy();
    });
  });

  it('calls onCancel when "Zurück zum Login" clicked', () => {
    const onCancel = vi.fn();
    render(<RegisterPage onRegistered={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück zum Login' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
