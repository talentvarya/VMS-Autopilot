// @vitest-environment jsdom
import axe from 'axe-core';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/components/Dashboard';
import SocialModule from '@/components/SocialModule';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error -- remove any matchMedia stub a test installed
  delete window.matchMedia;
});

type User = ReturnType<typeof userEvent.setup>;

async function openModule() {
  const user = userEvent.setup();
  render(<Dashboard />);
  await user.click(screen.getByRole('button', { name: 'Social Publishing' }));
  return user;
}
const viewAs = (user: User, label: RegExp) => user.click(screen.getByLabelText(label));
const toggle = (user: User, text: RegExp) => user.click(screen.getByRole('button', { name: text }));
const status = () => screen.getByRole('status');

describe('the Social Publishing page', () => {
  it('replaces the placeholder with a working, clearly-sandboxed page', async () => {
    await openModule();
    expect(screen.getByRole('heading', { level: 2, name: 'Social Publishing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open module' })).toBeNull();
    expect(screen.getByText(/Sandbox: these are invented clients and channels/)).toBeInTheDocument();
    for (const h of ['Channels', 'Calendar', 'Posts']) expect(screen.getByRole('heading', { level: 3, name: h })).toBeInTheDocument();
  });

  it('other modules keep their approved placeholder', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await user.click(screen.getByRole('button', { name: 'Domains' }));
    expect(screen.getByRole('button', { name: 'Open module' })).toBeInTheDocument();
  });

  it('shows the plan and how many channel slots are used, and can switch client', async () => {
    const user = await openModule();
    expect(screen.getByText(/3 of 3 channels used, no free slots left/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '3 of 3 channel slots used' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Client'), 'bright');
    expect(screen.getByText(/4 of 10 channels used, 6 free/)).toBeInTheDocument();
    expect(screen.getByText('Paid plan (sample)')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument(); // the TikTok channel
  });

  it('cannot connect Buffer: the button is inert and explains why', async () => {
    const user = await openModule();
    const connect = screen.getByRole('button', { name: 'Connect Buffer' });
    expect(connect).toHaveAttribute('aria-disabled', 'true');
    expect(connect).toHaveAccessibleDescription(/switched off/);
    await user.click(connect);
    expect(document.querySelector('.toast')).toBeNull(); // nothing happened
  });

  it('never contacts the network, at any point', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const user = await openModule();
    await toggle(user, /Hiring: we are looking/);
    await user.click(screen.getByRole('button', { name: /^Send for approval/ }));
    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, approve/ }));
    await user.click(screen.getByRole('button', { name: /^Publish now/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, publish now/ }));
    expect((await screen.findAllByText(/Published in the sandbox/)).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });
});

describe('the calendar', () => {
  it('shows scheduled and published posts on their day, in an accessible table', async () => {
    await openModule();
    const table = screen.getByRole('table', { name: /Posts in April 2025/ });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7);
    const published = within(table).getByRole('button', { name: /Pub 09:00 Facebook Page post, Published: Our team is back/ });
    expect(published).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: /Sch 10:00 LinkedIn post, Scheduled: We are proud to welcome/ })).toBeInTheDocument();
    // drafts and posts waiting for approval have no date, so they are not on the calendar
    expect(within(table).queryByRole('button', { name: /Hiring/ })).toBeNull();
    expect(within(table).getByText(/\(today\)/)).toBeInTheDocument();
  });

  it('opens a post from the calendar and moves keyboard focus to it', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: /Sch 10:00 LinkedIn post, Scheduled/ }));
    const item = screen.getByRole('button', { name: /LinkedIn.*We are proud to welcome/, expanded: true });
    expect(item).toHaveFocus();
    expect(screen.getByText(/Goes out/)).toBeInTheDocument();
  });

  it('moves between months and announces the month', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('table', { name: /Posts in May 2025/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sch 08:30 Facebook Page post, Scheduled: Reminder/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('table', { name: /Posts in March 2025/ })).toBeInTheDocument();
  });

  it('shows a day-by-day list instead of a grid on a phone-sized screen', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }) as never;
    await openModule();
    expect(screen.queryByRole('table', { name: /Posts in April 2025/ })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 4 }).some((h) => /28 Apr 2025/.test(h.textContent ?? ''))).toBe(true);
    expect(screen.getByRole('button', { name: /Sch 10:00 LinkedIn post, Scheduled/ })).toBeInTheDocument();
  });
});

describe('an Admin looks after a post from start to finish', () => {
  it('draft -> approval -> approved -> scheduled, with a confirmation for the important steps', async () => {
    const user = await openModule();
    await toggle(user, /Hiring: we are looking/);
    await user.click(screen.getByRole('button', { name: /^Send for approval/ }));
    expect(status()).toHaveTextContent('Sent for approval');
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    const group = screen.getByRole('group', { name: /Confirm: Approve/ });
    expect(group).toHaveTextContent(/goes back to draft and needs approving again/);
    expect(within(group).getByRole('button', { name: 'Go back' })).toHaveFocus();
    await user.click(within(group).getByRole('button', { name: /^Yes, approve/ }));
    expect(status()).toHaveTextContent('Approved');

    await user.click(screen.getByRole('button', { name: /^Schedule…:/ }));
    const when = screen.getByLabelText(/Date and time \(UTC\)/) as HTMLInputElement;
    expect(when.value).toBe('2025-04-25T09:12'); // one day after the sample date
    await user.click(screen.getByRole('button', { name: /^Yes, schedule/ }));
    expect(status()).toHaveTextContent('Scheduled');
    expect(screen.getByRole('button', { name: /Hiring.*Scheduled/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sch 09:12 LinkedIn post, Scheduled: Hiring/ })).toBeInTheDocument(); // now on the calendar
  });

  it('"Go back" cancels the confirmation and returns focus to the button that opened it', async () => {
    const user = await openModule();
    await toggle(user, /Five simple habits/);
    const approve = screen.getByRole('button', { name: /^Approve:/ });
    await user.click(approve);
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('group', { name: /Confirm/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Approve:/ })).toHaveFocus();
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0); // nothing changed
  });

  it('keeps keyboard focus on the post after a step with no confirmation (e.g. "Send back to draft")', async () => {
    const user = await openModule();
    await toggle(user, /Five simple habits/);
    await user.click(screen.getByRole('button', { name: /^Send back to draft:/ }));
    expect(status()).toHaveTextContent('Sent back to draft');
    expect(document.getElementById('soc-toggle-sample-7')).toHaveFocus(); // not lost to document.body
  });

  it('publishes an approved post in the sandbox - once - and says nothing was really posted', async () => {
    const user = await openModule();
    await toggle(user, /Behind the scenes/);
    await user.click(screen.getByRole('button', { name: /^Publish now/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, publish now/ }));
    expect((await screen.findAllByText(/Published in the sandbox. Nothing was posted anywhere./)).length).toBeGreaterThan(0);
    expect(screen.getByText(/sandbox: nothing was really posted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish now/ })).toBeNull();
    expect(screen.getByText(/This post is published/)).toBeInTheDocument();
  });

  it('shows why a failed post failed in plain words, and lets the Admin try again', async () => {
    const user = await openModule();
    await toggle(user, /Spring offer/);
    expect(screen.getByRole('note')).toHaveTextContent(/did not accept this post/);
    await user.click(screen.getByRole('button', { name: /^Try again/ }));
    expect(status()).toHaveTextContent('Ready to try again');
    expect(screen.getByRole('button', { name: /Spring offer.*Approved/ })).toBeInTheDocument();
  });

  it('editing an approved post sends it back to draft and says so', async () => {
    const user = await openModule();
    await toggle(user, /Behind the scenes/);
    await user.click(screen.getByRole('button', { name: /^Edit text/ }));
    expect(screen.getByText(/sends this post back to draft/)).toBeInTheDocument();
    const box = screen.getByLabelText('Text');
    await user.clear(box);
    await user.type(box, 'New wording for the instruments post.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(status()).toHaveTextContent(/draft again and needs approving/);
    expect(screen.getByRole('button', { name: /New wording.*Draft/ })).toBeInTheDocument();
  });

  it('pausing a channel stops scheduling to it, and resuming allows it again', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: /^Pause Facebook Page/ }));
    expect(status()).toHaveTextContent(/Channel paused/);
    await toggle(user, /Behind the scenes/); // an Instagram post: still fine
    await toggle(user, /Five simple habits/); // Facebook post, waiting for approval
    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, approve/ }));
    await user.click(screen.getByRole('button', { name: /^Schedule…:/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, schedule/ }));
    expect(status()).toHaveTextContent(/paused/);
    await user.click(screen.getByRole('button', { name: /^Resume Facebook Page/ }));
    expect(status()).toHaveTextContent('Channel resumed');
  });

  it('the sample worker starts posts only when they are due', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: 'Check for posts that are due' }));
    expect(status()).toHaveTextContent('No posts are due yet.');
    for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: /Move the sample date forward one day/ }));
    expect(status()).toHaveTextContent(/Sample date is now 29 Apr 2025/);
    await user.click(screen.getByRole('button', { name: 'Check for posts that are due' }));
    expect(status()).toHaveTextContent(/1 post due: 1 published in the sandbox/);
    expect(screen.getByRole('button', { name: /LinkedIn.*We are proud to welcome.*Published/ })).toBeInTheDocument();
  });

  it('adding a sample channel to a full plan is refused with a clear reason', async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: 'Add a sample channel' }));
    expect(status()).toHaveTextContent(/allows 3 channels and all are in use/);
    expect(screen.getByText(/3 of 3 channels used/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Client'), 'bright');
    await user.click(screen.getByRole('button', { name: 'Add a sample channel' }));
    expect(status()).toHaveTextContent('Sample channel added');
    expect(screen.getByText(/5 of 10 channels used, 5 free/)).toBeInTheDocument();
  });
});

describe('what a Client can do', () => {
  it('a Client who may only look sees everything but has no way to write, approve or publish', async () => {
    const user = await openModule();
    await viewAs(user, /View as Client \(view only\)/);
    expect(screen.queryByRole('button', { name: /New post/ })).toBeNull();
    expect(screen.getByText(/Your agency writes and schedules posts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check for posts that are due/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause|Resume|Add a sample channel/ })).toBeNull();
    for (const text of [/Hiring/, /Five simple habits/, /Behind the scenes/, /Spring offer/]) {
      await toggle(user, text);
      const item = screen.getByRole('button', { name: text, expanded: true }).closest('li')!;
      expect(within(item).queryByRole('button', { name: /^(Send for approval|Approve|Schedule|Publish|Try again|Edit text|Cancel post)/ })).toBeNull();
    }
    expect(screen.getAllByText(/Your agency looks after scheduling and publishing/).length).toBeGreaterThan(0);
  });

  it('a Client who may write and approve can draft, submit and approve someone else’s post - but never schedule or publish', async () => {
    const user = await openModule();
    await viewAs(user, /allowed to write and approve/);
    // approve the agency writer’s post
    await toggle(user, /Five simple habits/);
    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, approve/ }));
    expect(status()).toHaveTextContent('Approved');
    const item = screen.getByRole('button', { name: /Five simple habits/, expanded: true }).closest('li')!;
    expect(within(item).queryByRole('button', { name: /^(Schedule|Publish now)/ })).toBeNull(); // only the agency publishes
    expect(within(item).getByText(/Your agency looks after scheduling and publishing/)).toBeInTheDocument();
  });

  it('cannot approve a post they wrote themselves', async () => {
    const user = await openModule();
    await viewAs(user, /allowed to write and approve/);
    await user.click(screen.getByRole('button', { name: /New post/ }));
    await user.click(screen.getByLabelText(/^Facebook Page: Nova Clinic/));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'A note from the clinic team about opening hours.' } });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(status()).toHaveTextContent('Draft saved');
    await user.click(screen.getByRole('button', { name: /^Send for approval/ }));
    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    await user.click(screen.getByRole('button', { name: /^Yes, approve/ }));
    expect(status()).toHaveTextContent(/second person needs to approve/);
    expect(screen.getByRole('button', { name: /A note from the clinic team.*Waiting for approval/ })).toBeInTheDocument();
  });
});

describe('writing a new post', () => {
  const start = async () => {
    const user = await openModule();
    await user.click(screen.getByRole('button', { name: /New post/ }));
    return user;
  };

  it('moves keyboard focus into the text box and explains what is needed', async () => {
    await start();
    expect(screen.getByLabelText('Text')).toHaveFocus();
    expect(screen.getByText(/Choose a channel to see its length limit/)).toBeInTheDocument();
  });

  it('shows each network’s limit and suggestions in plain words', async () => {
    const user = await start();
    await user.click(screen.getByLabelText(/^Instagram: Nova Clinic/));
    await user.click(screen.getByLabelText(/^LinkedIn: Nova Clinic/));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Hello ' + Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ') } });
    const counts = document.getElementById('soc-counts')!;
    expect(within(counts).getByText(/of 2,200 characters/)).toBeInTheDocument();
    expect(within(counts).getByText(/of 3,000 characters/)).toBeInTheDocument();
    expect(within(counts).getByText(/allows at most 30 hashtags/)).toBeInTheDocument();
    expect(within(counts).getByText(/will not accept this post without a picture/)).toBeInTheDocument();
  });

  it('will not save something that cannot work, and says why', async () => {
    const user = await start();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(expect.arrayContaining(['Choose at least one channel.', 'Write something first.']));
    await user.click(screen.getByLabelText(/^LinkedIn: Nova Clinic/));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'a'.repeat(3001) } });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(within(document.getElementById('soc-counts')!).getByText(/1 too long|is 1 too long|1 character/i)).toBeTruthy();
    expect(screen.queryByText('Draft saved')).toBeNull();
  });

  it('writes one draft per chosen channel', async () => {
    const user = await start();
    await user.click(screen.getByLabelText(/^Facebook Page: Nova Clinic/));
    await user.click(screen.getByLabelText(/^LinkedIn: Nova Clinic/));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Same news for two channels today.' } });
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(status()).toHaveTextContent('2 drafts saved');
    expect(screen.getAllByRole('button', { name: /Same news for two channels.*Draft/ })).toHaveLength(2);
  });
});

describe('accessibility', () => {
  const violations = async () =>
    (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
      (v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    );

  it('has no automated violations with a post open and a confirmation showing', async () => {
    const user = await openModule();
    await toggle(user, /Five simple habits/);
    await user.click(screen.getByRole('button', { name: /^Approve:/ }));
    expect(await violations()).toEqual([]);
  });

  it('has no automated violations with the composer open, in the phone layout, as a Client', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} }) as never;
    const user = await openModule();
    await viewAs(user, /allowed to write and approve/);
    await user.click(screen.getByRole('button', { name: /New post/ }));
    await user.click(screen.getByLabelText(/^Instagram: Nova Clinic/));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'HELLO EVERYONE WE ARE OPEN TODAY COME AND VISIT US' } });
    expect(await violations()).toEqual([]);
  });

  it('names every button, field and control', async () => {
    const user = await openModule();
    await toggle(user, /Hiring/);
    for (const el of [...screen.getAllByRole('button'), ...screen.getAllByRole('combobox'), ...screen.getAllByRole('radio')]) expect(el).toHaveAccessibleName();
  });

  it('each post toggle says whether it is open', async () => {
    const user = await openModule();
    const first = screen.getAllByRole('button', { expanded: false }).find((b) => /Five simple habits/.test(b.textContent ?? ''))!;
    expect(first).toHaveAttribute('aria-controls');
    await user.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
  });

  it('starts as a Client when opened for one', () => {
    render(<SocialModule notify={() => {}} initialPreview="client-view" />);
    expect(screen.queryByRole('button', { name: /New post/ })).toBeNull();
  });

  it('announces status messages politely', async () => {
    const user = await openModule();
    await toggle(user, /Hiring/);
    await user.click(screen.getByRole('button', { name: /^Send for approval/ }));
    await act(async () => {});
    expect(status()).toHaveAttribute('aria-live', 'polite');
  });
});
