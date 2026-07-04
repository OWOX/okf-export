import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import * as sdk from './sdk-mock';
import { App } from './App';

const MARTS = [{ id: '1', title: 'Orders', slug: 'orders', type: 'VIEW', storage: 'GOOGLE_BIGQUERY' }];

/** storage.get stub: marts + summary + one doc. */
function stubStorage() {
  return vi.spyOn(sdk.storage, 'get').mockImplementation(async (k: string) =>
    k === 'marts' ? MARTS
      : k === 'summary' ? { count: 1, pushed: null, at: 'now' }
      : k === 'doc:orders' ? '# Orders\n\nsome markdown'
      : undefined,
  );
}

describe('App (OKF Export UI)', () => {
  it('shows the configured github-repo from settings', async () => {
    vi.spyOn(sdk.settings, 'get').mockResolvedValue('acme/catalog');
    vi.spyOn(sdk.storage, 'get').mockResolvedValue(undefined);
    render(<App />);
    await waitFor(() => expect(screen.getByText('acme/catalog')).toBeInTheDocument());
  });

  it('runs the export, toasts, and lists marts from storage', async () => {
    vi.spyOn(sdk.settings, 'get').mockResolvedValue('acme/catalog');
    stubStorage();
    const call = vi.spyOn(sdk.backend, 'call').mockResolvedValue({ ok: true, count: 1, pushed: null });
    const toast = vi.spyOn(sdk.ui, 'toast');

    render(<App />);
    await waitFor(() => expect(screen.getByText('acme/catalog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /run export/i }));

    await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());
    expect(call).toHaveBeenCalledWith('exportMarts', { push: false });
    expect(toast).toHaveBeenCalledWith('Exported 1 mart(s)');
  });

  it('opens a mart doc from storage when its title is clicked', async () => {
    vi.spyOn(sdk.settings, 'get').mockResolvedValue('acme/catalog');
    stubStorage();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(screen.getByText(/some markdown/)).toBeInTheDocument());
  });

  it('passes push:true to the backend when the push box is checked', async () => {
    vi.spyOn(sdk.settings, 'get').mockResolvedValue('acme/catalog'); // repo set → checkbox visible
    stubStorage();
    const call = vi.spyOn(sdk.backend, 'call').mockResolvedValue({ ok: true, count: 1, pushed: 'acme/catalog' });

    render(<App />);
    await waitFor(() => expect(screen.getByText('acme/catalog')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /run export/i }));

    await waitFor(() => expect(call).toHaveBeenCalledWith('exportMarts', { push: true }));
  });
});
