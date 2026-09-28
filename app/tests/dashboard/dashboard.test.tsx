// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/components/Dashboard';

afterEach(cleanup);

const setup = () => ({ user: userEvent.setup(), ...render(<Dashboard />) });

// The four scenarios from interface/tests/tests.json --------------------------------------

describe('navigate through agency modules', () => {
  it('opens a module and returns to Overview', async () => {
    const { user } = setup();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agency Overview');
    await user.click(screen.getByRole('button', { name: 'SEO / GEO Audit' }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('SEO / GEO Audit');
    expect(screen.getByRole('button', { name: 'SEO / GEO Audit' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    await user.click(screen.getByRole('button', { name: 'Overview' }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agency Overview');
  });
});

describe('approve an Admin queue item', () => {
  it('marks the item approved and confirms it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Approve: Meta campaign budget change/ }));
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Approval completed and logged');
    expect(screen.queryByRole('button', { name: /Approve: Meta campaign budget change/ })).toBeNull();
  });

  it('opens a review (does not approve) for the LinkedIn post', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Review: LinkedIn post/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Review opened for Admin');
    expect(screen.getByRole('button', { name: /Review: LinkedIn post/ })).toBeInTheDocument();
  });
});

describe('create a client workspace', () => {
  it('adds a New Client row each time, with no duplicate-key warnings', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user } = setup();
    const rows = () => within(screen.getByRole('table', { name: 'Client workspaces' })).getAllByRole('row');
    expect(rows()).toHaveLength(1 + 3); // header + Nova, Bright, Urban
    await user.click(screen.getByRole('button', { name: /Add client/ }));
    await user.click(screen.getByRole('button', { name: /Add client/ }));
    expect(rows()).toHaveLength(1 + 5);
    expect(screen.getAllByText('New Client')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('New client workspace created');
    expect(errors.mock.calls.filter(([m]) => String(m).includes('same key'))).toEqual([]);
    errors.mockRestore();
  });
});

describe('switch agency workspace', () => {
  it('changes the workspace name in the header and closes the menu', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: /Acme Marketing/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'VMS Demo Agency' }));
    expect(screen.getByRole('button', { name: /VMS Demo Agency/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Choose workspace' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes with Escape and returns focus to the trigger', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: /Acme Marketing/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Choose workspace' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks the chosen workspace as current', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Acme Marketing/ }));
    const group = screen.getByRole('group', { name: 'Choose workspace' });
    expect(within(group).getByRole('button', { name: 'Acme Marketing' })).toHaveAttribute('aria-current', 'true');
    expect(within(group).getByRole('button', { name: 'Client Sandbox' })).not.toHaveAttribute('aria-current');
  });
});

// Mobile navigation drawer -----------------------------------------------------------------

describe('small-screen navigation drawer', () => {
  it('opens from the top bar, closes with Escape, and returns focus', async () => {
    const { user, container } = setup();
    const toggle = screen.getByRole('button', { name: /open navigation menu/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.shell')).not.toHaveClass('nav-open');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.shell')).toHaveClass('nav-open');
    expect(screen.getByRole('button', { name: 'Close navigation menu' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(container.querySelector('.shell')).not.toHaveClass('nav-open');
    expect(toggle).toHaveFocus();
  });

  it('closes when a module is chosen and moves focus to the page content', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    await user.click(screen.getByRole('button', { name: 'Paid Ads' }));
    expect(container.querySelector('.shell')).not.toHaveClass('nav-open');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Paid Ads');
    expect(document.getElementById('main-content')).toHaveFocus();
  });

  it('closes when the dimmed background is clicked', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    await user.click(container.querySelector('.scrim') as HTMLElement);
    expect(container.querySelector('.shell')).not.toHaveClass('nav-open');
  });
});

// Accessibility -----------------------------------------------------------------------------

describe('accessibility', () => {
  const audit = async (node: Element) =>
    (
      await axe.run(node as HTMLElement, {
        // jsdom cannot compute colours; contrast is checked in a real browser instead.
        rules: { 'color-contrast': { enabled: false } },
      })
    ).violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

  it('has no automated violations on Overview', async () => {
    const { container } = setup();
    expect(await audit(container)).toEqual([]);
  });

  it('has no automated violations on a module page, with the workspace menu and drawer open', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: 'Domains' }));
    await user.click(screen.getByRole('button', { name: /Acme Marketing/ }));
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    expect(await audit(container)).toEqual([]);
  });

  it('offers a skip link to the main content', () => {
    setup();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(document.getElementById('main-content')).toBeTruthy();
  });

  it('labels icon-only controls', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Admin, online' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Chart of daily leads/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'AI working for your success 24/7' })).toBeInTheDocument();
  });

  it('exposes the client list as a table with named channels and scores', () => {
    setup();
    const table = screen.getByRole('table', { name: 'Client workspaces' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Client', 'Channels', 'SEO/GEO Score', 'Ads Status', 'Permission', 'Health',
    ]);
    const nova = within(table).getAllByRole('row')[1];
    expect(within(nova).getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual([
      'Facebook', 'Instagram', 'LinkedIn', 'YouTube',
    ]);
    expect(within(nova).getByLabelText('SEO/GEO score 92')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Client workspaces table/ })).toHaveAttribute('tabindex', '0');
  });

  it('lets the visible toast be dismissed and announces messages politely', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Add client/ }));
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('New client workspace created');
    expect(screen.getAllByText('New client workspace created')).toHaveLength(2); // visual + announcement
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.getAllByText('New client workspace created')).toHaveLength(1); // visual toast gone
    expect(document.getElementById('main-content')).toHaveFocus(); // focus did not fall into the void
  });

  it('announces an identical message again (the text changes invisibly each time)', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Add client/ }));
    const first = screen.getByRole('status').textContent;
    await user.click(screen.getByRole('button', { name: /Add client/ }));
    expect(screen.getByRole('status').textContent).not.toBe(first);
    expect(screen.getByRole('status')).toHaveTextContent('New client workspace created');
  });

  it('keeps the toast on screen while it is hovered, then removes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Dashboard />);
      await user.click(screen.getByRole('button', { name: /Add client/ }));
      const toast = document.querySelector('.toast') as HTMLElement;
      await user.hover(toast);
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(document.querySelector('.toast')).not.toBeNull();
      fireEvent.mouseLeave(toast); // pointer leaves the toast
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
      expect(document.querySelector('.toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps keyboard focus on the result after Approve replaces its button', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Approve: Meta campaign budget change/ }));
    expect(screen.getByText('Approved')).toHaveFocus();
  });

  it('keeps focus on the page when "View all clients" swaps the view', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /View all clients/ }));
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Clients');
    expect(document.getElementById('main-content')).toHaveFocus();
  });

  it('tells screen readers and the browser tab which page they are on', async () => {
    const { user } = setup();
    expect(document.title).toBe('VMS Autopilot — AI-Powered Marketing Automation Platform');
    await user.click(screen.getByRole('button', { name: 'Reports' }));
    expect(document.title).toBe('Reports · VMS Autopilot');
    expect(document.querySelector('[aria-live="polite"]:not([role])')).toHaveTextContent('Reports page');
  });

  it('makes the rest of the page inert while the drawer is open', async () => {
    const { user } = setup();
    const main = document.getElementById('main-content')!;
    expect(main).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));
    expect(main).toHaveAttribute('inert');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(main).not.toHaveAttribute('inert');
  });

  it('closes the workspace menu when keyboard focus moves elsewhere', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: /Acme Marketing/ }));
    expect(screen.getByRole('group', { name: 'Choose workspace' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Overview' })); // focus moves outside the menu
    expect(screen.queryByRole('group', { name: 'Choose workspace' })).toBeNull();
  });

  it('every button declares type="button" so none can accidentally submit a form', () => {
    const { container } = setup();
    const untyped = Array.from(container.querySelectorAll('button')).filter((b) => b.getAttribute('type') !== 'button');
    expect(untyped).toEqual([]);
  });
});
