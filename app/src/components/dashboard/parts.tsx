import { useEffect, useRef, type ReactNode } from 'react';
import { Check, FileText, Globe2, Megaphone, MoreHorizontal } from 'lucide-react';

/** A minimal real-data table, reusing the same table-grid/client-row styling as the Clients
 * table so Paid Ads, Leads, Domains and AI Monitor don't need their own CSS. */
export function SimpleTable<T>({
  label,
  columns,
  rows,
  rowKey,
  loaded,
  emptyMessage,
}: {
  label: string;
  columns: ReadonlyArray<{ header: string; render: (row: T) => ReactNode }>;
  rows: T[];
  rowKey: (row: T) => string;
  loaded: boolean;
  emptyMessage: string;
}) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      <div className="table-grid" role="table" aria-label={label}>
        <div className="table-head" role="row">
          {columns.map(c => (
            <span role="columnheader" key={c.header}>
              {c.header}
            </span>
          ))}
        </div>
        {loaded && rows.length === 0 && (
          <div className="client-row" role="row">
            <span role="cell">{emptyMessage}</span>
          </div>
        )}
        {rows.map(row => (
          <div className="client-row" key={rowKey(row)} role="row">
            {columns.map(c => (
              <div role="cell" key={c.header}>
                {c.render(row)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Stat({
  icon,
  tone,
  label,
  value,
  change,
}: {
  icon: ReactNode;
  tone: string;
  label: string;
  value: string;
  /** Omit or leave empty when there's no real month-over-month comparison to show yet. */
  change?: string;
}) {
  return (
    <div className="stat">
      <div className={'stat-icon ' + tone}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {change && (
          <em>
            ↗ {change} <small>vs last month</small>
          </em>
        )}
      </div>
    </div>
  );
}

export function Title({ text, right }: { text: string; right?: ReactNode }) {
  return (
    <div className="title">
      <h3>{text}</h3>
      {right}
    </div>
  );
}

export function Timeline({ text, meta }: { text: string; meta: string }) {
  return (
    <div className="timeline-item" role="listitem">
      <i aria-hidden="true" />
      <div>
        <strong>{text}</strong>
        <p>{meta}</p>
      </div>
    </div>
  );
}

export function Approval({
  title,
  client,
  age,
  kind,
  done,
  onApprove,
}: {
  title: string;
  client: string;
  age: string;
  kind: string;
  done: boolean;
  onApprove: () => void;
}) {
  const verb = kind === 'post' ? 'Review' : 'Approve';
  // The Approve button turns into "Approved": keep keyboard focus on the result.
  const doneRef = useRef<HTMLSpanElement>(null);
  const wasDone = useRef(done);
  useEffect(() => {
    if (done && !wasDone.current) doneRef.current?.focus();
    wasDone.current = done;
  }, [done]);
  return (
    <div className="approval">
      <span className={'approval-icon ' + kind} aria-hidden="true">
        {kind === 'ads' ? (
          <Megaphone size={16} />
        ) : kind === 'post' ? (
          <FileText size={16} />
        ) : (
          <Globe2 size={16} />
        )}
      </span>
      <div>
        <strong>{title}</strong>
        <small>
          {client} • {age}
        </small>
      </div>
      {done ? (
        <span className="done" ref={doneRef} tabIndex={-1}>
          <Check size={13} aria-hidden="true" /> Approved
        </span>
      ) : (
        <button
          type="button"
          className={kind === 'post' ? 'review' : 'approve'}
          aria-label={`${verb}: ${title} for ${client}`}
          onClick={onApprove}
        >
          {verb}
        </button>
      )}
      <MoreHorizontal size={17} className="more" aria-hidden="true" />
    </div>
  );
}
