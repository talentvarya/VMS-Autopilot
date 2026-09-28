'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { calendarDate, dateLabel, dayKey, monthGrid, monthLabel, postsByDay, timeLabel, WEEKDAYS } from '@/lib/social/calendar';
import { NETWORK_LABELS, POST_STATUS_LABELS, type Channel, type SocialPost } from '@/lib/social/types';
import { Title } from '../dashboard/parts';

const snippet = (text: string, n = 34) => (Array.from(text).length > n ? Array.from(text).slice(0, n - 1).join('') + '…' : text);

export default function CalendarView({
  posts, channels, year, month0, today, narrow, selectedId, onSelect, onMonth,
}: {
  posts: SocialPost[];
  channels: Channel[];
  year: number;
  month0: number;
  today: string;
  narrow: boolean;
  selectedId: string | null;
  onSelect: (postId: string) => void;
  onMonth: (by: number) => void;
}) {
  const byDay = postsByDay(posts, year, month0);
  const netOf = (p: SocialPost) => NETWORK_LABELS[channels.find((c) => c.id === p.channelId)!.network];
  // A short text marker so status is never shown by colour alone (published/scheduled/publishing
  // are the only statuses that ever reach the calendar - see calendarDate()).
  const STATUS_MARK: Record<string, string> = { published: 'Pub', scheduled: 'Sch', publishing: 'Live' };
  const mark = (p: SocialPost) => STATUS_MARK[p.status] ?? p.status;
  const visibleLabel = (p: SocialPost) => `${mark(p)} ${timeLabel(calendarDate(p)!).slice(0, 5)} ${netOf(p)}`;
  const describe = (p: SocialPost) => `${visibleLabel(p)} post, ${POST_STATUS_LABELS[p.status]}: ${snippet(p.body, 60)}`;
  const days = [...byDay.keys()].sort();

  const chip = (p: SocialPost) => (
    <li key={p.id}>
      <button type="button" className={'soc-cal-post ' + p.status + (p.id === selectedId ? ' selected' : '')} aria-label={describe(p)} aria-pressed={p.id === selectedId} onClick={() => onSelect(p.id)}>
        <span className="soc-cal-mark">{mark(p)}</span> <span className="soc-cal-time">{timeLabel(calendarDate(p)!).slice(0, 5)}</span> {netOf(p)}
      </button>
    </li>
  );

  return (
    <section className="card">
      <Title
        text="Calendar"
        right={
          <div className="soc-monthnav">
            <button type="button" className="outline soc-btn" onClick={() => onMonth(-1)} aria-label="Previous month"><ChevronLeft size={16} aria-hidden="true" /></button>
            <strong>{monthLabel(year, month0)}</strong>
            <button type="button" className="outline soc-btn" onClick={() => onMonth(1)} aria-label="Next month"><ChevronRight size={16} aria-hidden="true" /></button>
          </div>
        }
      />
      <p className="sr-only" aria-live="polite">{monthLabel(year, month0)}</p>
      <p className="soc-hint">Shows posts that are scheduled or published. Drafts and posts waiting for approval have no date yet; find them in the list below.</p>

      {narrow ? (
        days.length === 0 ? (
          <p className="soc-empty-note">Nothing scheduled or published in {monthLabel(year, month0)}.</p>
        ) : (
          <div className="soc-agenda">
            {days.map((k) => (
              <div key={k}>
                <h4>{dateLabel(k + 'T00:00:00Z')}</h4>
                <ul>{byDay.get(k)!.map(chip)}</ul>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="soc-cal-wrap">
          <table className="soc-cal">
            <caption className="sr-only">Posts in {monthLabel(year, month0)}</caption>
            <thead>
              <tr>{WEEKDAYS.map((d) => <th key={d} scope="col" abbr={d}>{d.slice(0, 3)}</th>)}</tr>
            </thead>
            <tbody>
              {monthGrid(year, month0).map((week, i) => (
                <tr key={i}>
                  {week.map((d, j) =>
                    d ? (
                      <td key={j} className={dayKey(d) === today ? 'today' : ''}>
                        <span className="soc-day">{d.getUTCDate()}{dayKey(d) === today && <span className="sr-only"> (today)</span>}</span>
                        {byDay.get(dayKey(d)) && <ul>{byDay.get(dayKey(d))!.map(chip)}</ul>}
                      </td>
                    ) : (
                      <td key={j} className="soc-blank" />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
