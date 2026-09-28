// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/components/Dashboard';
import SeoAuditModule from '@/components/SeoAuditModule';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/download', () => ({ downloadText: download }));

beforeEach(() => download.mockClear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Open the SEO / GEO Audit page from the real dashboard. */
async function openModule() {
  const user = userEvent.setup();
  render(<Dashboard />);
  await user.click(screen.getByRole('button', { name: 'SEO / GEO Audit' }));
  return user;
}
const chooseSite = async (user: ReturnType<typeof userEvent.setup>, label: RegExp) =>
  user.selectOptions(screen.getByLabelText('Website'), screen.getByRole('option', { name: label }));
const viewAsClient = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByLabelText('View as Client'));

describe('SEO / GEO Audit page', () => {
  it('replaces the placeholder with a real report for a sample website', async () => {
    await openModule();
    expect(screen.getByRole('heading', { level: 2, name: 'SEO / GEO Audit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open module' })).toBeNull();
    expect(screen.getByText(/Sample data: these are invented websites/)).toBeInTheDocument();
    expect(screen.getByLabelText('Website')).toHaveValue('nova-clinic');
    expect(screen.getByText('Overall score')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Scores by area' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /: (Good|Needs work|Poor)$/ })).toHaveLength(6); // one bar per area
  });

  it('other modules keep their approved placeholder', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: 'Domains' }));
    expect(screen.getByRole('button', { name: 'Open module' })).toBeInTheDocument();
  });

  it('shows each sample site\'s problems, worst first, and explains a blocked page', async () => {
    const user = await openModule();
    await chooseSite(user, /Urban Eats/);
    expect(screen.getByRole('note')).toHaveTextContent(/cannot be higher than 40/);
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Critical/);
    expect(screen.getByText(/stay out of search results \(noindex\)/i)).toBeInTheDocument();
    await chooseSite(user, /Nova Clinic/);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('filters by severity and area, and can reveal the passed checks', async () => {
    const user = await openModule();
    await chooseSite(user, /Bright Homes/);
    const shown = () => Number(screen.getByText(/findings? shown/).textContent!.match(/\d+/)![0]);
    const all = shown();
    await user.selectOptions(screen.getByLabelText('Severity'), 'medium');
    expect(shown()).toBeLessThan(all);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([expect.stringMatching(/^Medium/)]);
    await user.selectOptions(screen.getByLabelText('Severity'), 'all');
    await user.selectOptions(screen.getByLabelText('Area'), 'geo');
    expect(shown()).toBeGreaterThan(0);
    expect(shown()).toBeLessThan(all);
    await user.selectOptions(screen.getByLabelText('Area'), 'all');
    expect(screen.queryByRole('heading', { level: 4, name: /^Passed/ })).toBeNull();
    await user.click(screen.getByLabelText('Show passed checks'));
    expect(screen.getByRole('heading', { level: 4, name: /^Passed/ })).toBeInTheDocument();
  });
});

describe('who can do what', () => {
  it('an Admin can run audits, download reports and record that a fix was applied - after a confirmation', async () => {
    const user = await openModule();
    expect(screen.getByRole('button', { name: /Run audit/ })).toBeEnabled();
    const mark = screen.getAllByRole('button', { name: /^Mark as applied:/ })[0];
    await user.click(mark);
    const confirm = screen.getByRole('group', { name: /^Confirm applying:/ });
    expect(confirm).toHaveTextContent(/does not change the website/);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Fix applied')).toBeNull(); // cancelled: nothing recorded
    await user.click(screen.getAllByRole('button', { name: /^Mark as applied:/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Yes, record it' }));
    expect(screen.getByText('Fix applied')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Fix recorded and logged');
    await user.click(screen.getAllByRole('button', { name: /^Reopen:/ })[0]);
    expect(screen.queryByText('Fix applied')).toBeNull();
  });

  it('a Client can view, run audits and download - but has no way to apply a fix', async () => {
    const user = await openModule();
    await viewAsClient(user);
    expect(screen.getByRole('button', { name: /Run audit/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Mark as applied/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reopen/ })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Confirm applying/ })).toBeNull();
    expect(screen.getByText(/Only your agency can apply fixes/)).toBeInTheDocument();
  });

  it('a Client who was mid-confirmation loses the ability the moment they are a Client', async () => {
    const user = await openModule();
    await user.click(screen.getAllByRole('button', { name: /^Mark as applied:/ })[0]);
    await viewAsClient(user);
    expect(screen.queryByRole('button', { name: 'Yes, record it' })).toBeNull();
  });

  it('starts as Client when opened for a Client', () => {
    render(<SeoAuditModule notify={() => {}} initialRole="client" />);
    expect(screen.queryByRole('button', { name: /Mark as applied/ })).toBeNull();
    expect(screen.getByText(/Only your agency can apply fixes/)).toBeInTheDocument();
  });
});

describe('running an audit (sample websites only)', () => {
  it('queues, runs and finishes, adding to the history', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: 'SEO / GEO Audit' }));
    const history = () => within(screen.getByRole('heading', { level: 3, name: 'Audit history' }).closest('section')!).getAllByRole('listitem');
    expect(history()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^Run audit/ }));
    expect(screen.getByRole('button', { name: /Audit running/ })).toHaveAttribute('aria-disabled', 'true');
    expect(history()[0]).toHaveTextContent(/Queued/);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(history()[0]).toHaveTextContent(/Running/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(history()).toHaveLength(2);
    expect(history()[0]).toHaveTextContent(/Completed/);
    expect(screen.getByRole('button', { name: /^Run audit/ })).toBeEnabled();
  });

  it('stops at the daily limit, like the database', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: 'SEO / GEO Audit' }));
    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole('button', { name: /^Run audit/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    }
    expect(screen.getByRole('button', { name: /^Run audit/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/Daily limit reached for this website/)).toBeInTheDocument();
  });

  it('never contacts the network, at any point', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const user = await openModule();
    await chooseSite(user, /Bright Homes/);
    await user.click(screen.getByRole('button', { name: /^Run audit/ }));
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    xhr.mockRestore();
  });
});

describe('exporting the report', () => {
  it('downloads a CSV containing the findings, with formula-safe cells', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, csv] = download.mock.calls[0] as [string, string];
    expect(filename).toBe('seo-geo-audit-nova-clinic-sample-2025-04-24.csv');
    expect(csv).toContain('Site,Address,Audited at,Category,Severity,Code,Finding');
    expect(csv).toContain('Nova Clinic (sample)');
    expect(csv).toContain('images.alt_missing');
    expect(csv).not.toMatch(/(^|,)[=+\-@]/m);
    expect(screen.getByRole('status')).toHaveTextContent('CSV report downloaded');
  });

  it('includes the fix status an Admin recorded', async () => {
    const user = await openModule();
    await user.click(screen.getAllByRole('button', { name: /^Mark as applied:/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Yes, record it' }));
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    expect((download.mock.calls[0] as [string, string])[1]).toMatch(/,applied\r\n/);
  });

  it('prints (Save as PDF) through the browser', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: /Print \/ Save as PDF/ }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});

describe('accessibility', () => {
  const violations = async (node: Element) =>
    (await axe.run(node as HTMLElement, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
      (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );

  it('has no automated violations as an Admin, mid-confirmation, with everything shown', async () => {
    const user = await openModule();
    await user.click(screen.getByLabelText('Show passed checks'));
    await user.click(screen.getAllByRole('button', { name: /^Mark as applied:/ })[0]);
    expect(await violations(document.body)).toEqual([]);
  });

  it('has no automated violations as a Client on the worst sample site', async () => {
    const user = await openModule();
    await viewAsClient(user);
    await chooseSite(user, /Urban Eats/);
    expect(await violations(document.body)).toEqual([]);
  });

  it('gives every score bar and control a name', async () => {
    await openModule();
    for (const bar of screen.getAllByRole('img', { name: /Good|Needs work|Poor|not measured/ })) expect(bar).toHaveAccessibleName();
    for (const select of screen.getAllByRole('combobox')) expect(select).toHaveAccessibleName();
  });
});

describe('keyboard focus and announcements (from the accessibility review)', () => {
  it('moves focus into the confirmation, and back to the button that opened it', async () => {
    const user = await openModule();
    const first = screen.getAllByRole('button', { name: /^Mark as applied:/ })[0];
    await user.click(first);
    const group = screen.getByRole('group', { name: /^Confirm applying:/ });
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus(); // focus is not lost to the page top
    await user.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /^Confirm applying:/ })).toBeNull();
    expect(document.getElementById(first.id)).toHaveFocus();
  });

  it('keeps focus on the finding after a fix is recorded, and after reopening', async () => {
    const user = await openModule();
    await user.click(screen.getAllByRole('button', { name: /^Mark as applied:/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Yes, record it' }));
    const reopen = screen.getAllByRole('button', { name: /^Reopen:/ })[0];
    expect(reopen).toHaveFocus();
    await user.click(reopen);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('keeps the Run button focusable while an audit runs (aria-disabled, not disabled)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: 'SEO / GEO Audit' }));
    const run = screen.getByRole('button', { name: /^Run audit/ });
    await user.click(run);
    const running = screen.getByRole('button', { name: /Audit running/ });
    expect(running).toHaveAttribute('aria-disabled', 'true');
    expect(running).not.toBeDisabled();
    expect(running).toHaveFocus();
    await user.click(running); // pressing it again does nothing
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(within(screen.getByRole('heading', { level: 3, name: 'Audit history' }).closest('section')!).getAllByRole('listitem')).toHaveLength(2);
  });

  it('labels every score in the history', async () => {
    await openModule();
    const history = within(screen.getByRole('heading', { level: 3, name: 'Audit history' }).closest('section')!);
    expect(history.getAllByRole('listitem')[0]).toHaveTextContent(/Score: \d+/);
  });

  it('announces which website the findings belong to', async () => {
    const user = await openModule();
    await chooseSite(user, /Urban Eats/);
    expect(screen.getByText(/findings? shown for Urban Eats/)).toBeInTheDocument();
  });

  it('shows "Show passed checks" as ticked when only passed checks are shown', async () => {
    const user = await openModule();
    await user.selectOptions(screen.getByLabelText('Severity'), 'pass');
    const box = screen.getByLabelText('Show passed checks');
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
  });
});
