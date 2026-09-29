import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** Fetches `url` (expects `{ rows: T[] }`) once, the first time `active` matches `tab` -
 * shared by every nav tab whose data is just a real read-only list from Supabase. The setter
 * lets a caller append a newly-created row locally instead of refetching the whole list. */
export function useLazyList<T>(
  active: string,
  tab: string,
  url: string,
  notify: (text: string) => void,
  label: string,
): [T[], boolean, Dispatch<SetStateAction<T[]>>] {
  const [rows, setRows] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (active !== tab || loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          notify(body.error || `Could not load ${label}`);
          return;
        }
        setRows((body.rows as T[]) ?? []);
      } catch {
        if (!cancelled) notify(`Could not load ${label} — check your connection`);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tab, url, loaded]);

  return [rows, loaded, setRows];
}
