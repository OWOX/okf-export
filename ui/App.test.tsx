import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import * as sdk from './sdk-mock';
import { App } from './App';

const downloadZip = vi.hoisted(() => vi.fn());
vi.mock('./okf-download', () => ({ downloadZip }));

// Canned (sdk-mock): Orders (reporting, BigQuery, 1 outbound rel) + Ops Log (maintenance, Snowflake).
async function step1() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId('step-marts')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('Orders')).toBeInTheDocument());
}
async function toExport() {
  await step1();
  fireEvent.click(screen.getByTestId('to-step-2'));
  await waitFor(() => expect(screen.getByTestId('step-export')).toBeInTheDocument());
}

describe('App wizard (2 steps)', () => {
  it('filters (dropdown) + search update the list in real time', async () => {
    await step1();
    expect(screen.queryByText('Ops Log')).not.toBeInTheDocument(); // maintenance-only, hidden by default
    fireEvent.click(screen.getByTestId('filters-toggle')); // open the Filters ▾ dropdown
    fireEvent.click(screen.getByLabelText('All'));
    await waitFor(() => expect(screen.getByText('Ops Log')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('filter-text'), { target: { value: 'ops' } });
    await waitFor(() => expect(screen.queryByText('Orders')).not.toBeInTheDocument());
    expect(screen.getByText('Ops Log')).toBeInTheDocument();
  });

  it('all selected by default, relationship count shows, Select-All toggles', async () => {
    await step1();
    expect(screen.getByTestId('selected-count')).toHaveTextContent('1 of 1 selected');
    await waitFor(() => expect(within(screen.getByTestId('mart-row')).getByText('1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('select-all'));
    expect(screen.getByTestId('selected-count')).toHaveTextContent('0 of 1 selected');
    expect(screen.getByTestId('to-step-2')).toBeDisabled();
  });

  it('clicking a row opens the in-plugin detail panel', async () => {
    await step1();
    fireEvent.click(screen.getByTestId('mart-row'));
    const panel = await screen.findByTestId('detail-panel');
    await waitFor(() => expect(within(panel).getByText(/# Orders/)).toBeInTheDocument());
  });

  it('stepper: Export step lets you click back to Data marts', async () => {
    await toExport();
    fireEvent.click(screen.getByTestId('step-1'));
    await waitFor(() => expect(screen.getByTestId('step-marts')).toBeInTheDocument());
  });

  it('save-to-file exports the selected marts as a zip', async () => {
    await toExport();
    fireEvent.click(screen.getByTestId('dest-file'));
    fireEvent.click(screen.getByTestId('run-file'));
    await waitFor(() => expect(downloadZip).toHaveBeenCalledWith('okf-bundle.zip', expect.objectContaining({ 'index.md': expect.any(String) })));
    expect(screen.getByText(/Downloaded okf-bundle.zip/)).toBeInTheDocument();
  });

  it('github: checks write access, then opens a pull request', async () => {
    await toExport();
    fireEvent.click(screen.getByTestId('dest-github'));
    fireEvent.change(await screen.findByTestId('github-url'), { target: { value: 'https://github.com/acme/catalog' } });
    await waitFor(() => expect(screen.getByTestId('run-github')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('run-github'));
    await waitFor(() => expect(screen.getByText(/Opened pull request/)).toBeInTheDocument());
    expect(screen.getByText(/pull\/1/)).toBeInTheDocument();
  });
});
