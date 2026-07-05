import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import * as sdk from './sdk-mock';
import { App } from './App';

const MARTS = [{ id: '1', title: 'Orders', slug: 'orders', type: 'VIEW', storage: 'GOOGLE_BIGQUERY' }];

/** storage.get stub: marts + summary + one doc + remembered push repo. */
function stubStorage() {
  return vi.spyOn(sdk.storage, 'get').mockImplementation(async (k: string) =>
    k === 'marts' ? MARTS
      : k === 'summary' ? { count: 1, pushed: false, at: 'now' }
      : k === 'doc:orders' ? '# Orders\n\nsome markdown'
      : k === 'github-repo' ? 'acme/catalog'
      : undefined,
  );
}

describe('App (OKF Export UI)', () => {
  it('shows the empty state before any export', async () => {
    vi.spyOn(sdk.storage, 'get').mockResolvedValue(undefined);
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no exported marts yet/i)).toBeInTheDocument());
  });

  it('runs the export, toasts, and lists marts from storage', async () => {
    stubStorage();
    const call = vi.spyOn(sdk.backend, 'call').mockResolvedValue({ ok: true, count: 1, pushed: false });
    const toast = vi.spyOn(sdk.ui, 'toast');

    render(<App />);
    await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /run export/i }));

    expect(call).toHaveBeenCalledWith('exportMarts', { push: false, repo: 'acme/catalog' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Exported 1 mart(s)'));
  });

  it('opens a mart doc from storage when its title is clicked', async () => {
    stubStorage();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(screen.getByText(/some markdown/)).toBeInTheDocument());
  });

  it('passes push:true to the backend when the push box is checked', async () => {
    stubStorage();
    const call = vi.spyOn(sdk.backend, 'call').mockResolvedValue({ ok: true, count: 1, pushed: true });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /run export/i }));

    await waitFor(() => expect(call).toHaveBeenCalledWith('exportMarts', { push: true, repo: 'acme/catalog' }));
  });
});
