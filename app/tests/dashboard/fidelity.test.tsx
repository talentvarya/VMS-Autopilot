// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Dashboard from '@/components/Dashboard';

/**
 * "Keep the approved dashboard design exactly the same."
 *
 * 1. interface/ is byte-for-byte what was approved (hash manifest from Phase 0).
 * 2. The app's stylesheet begins with the approved CSS, unchanged.
 * 3. The app's dashboard renders the same structure - same elements, same class names, same
 *    inline styles, same text - as the approved interface/src/App.tsx, at every step of the
 *    same interactions. Only invisible additions (accessibility attributes, the small-screen
 *    drawer controls, table scroll wrappers) are allowed to differ, and they are stripped
 *    before comparing.
 */

const packageRoot = resolve(__dirname, '..', '..', '..');
const appRoot = resolve(__dirname, '..', '..');

describe('the approved interface/ folder is untouched', () => {
  it('matches the Phase 0 hash manifest exactly', () => {
    const manifest = readFileSync(join(packageRoot, 'backups', 'interface-baseline-2026-09-28.sha256.txt'), 'utf8')
      .replace(/^﻿/, '') // the manifest was written by PowerShell, which adds a byte-order mark
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, file] = line.split(/\s{2}/);
        return `${hash.toUpperCase()}  ${file}`;
      });

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
    const current = walk(join(packageRoot, 'interface')).map((file) => {
      const hash = createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
      return `${hash}  ${relative(packageRoot, file).replace(/\\/g, '/')}`;
    });
    expect(current.sort()).toEqual(manifest.sort());
  });
});

describe('stylesheet and assets', () => {
  it('starts with the approved index.css, byte for byte', () => {
    const approved = readFileSync(join(packageRoot, 'interface', 'src', 'index.css'), 'utf8');
    const ours = readFileSync(join(appRoot, 'src', 'app', 'globals.css'), 'utf8');
    expect(ours.startsWith(approved)).toBe(true);
  });

  it('serves the approved image unchanged', () => {
    const a = readFileSync(join(packageRoot, 'interface', 'public', 'resources', 'ai-working-247.png'));
    const b = readFileSync(join(appRoot, 'public', 'resources', 'ai-working-247.png'));
    expect(b.equals(a)).toBe(true);
  });

  it('only changes layout below 1100px (every added rule is inside a max-width media query or is invisible)', () => {
    const approved = readFileSync(join(packageRoot, 'interface', 'src', 'index.css'), 'utf8');
    const added = readFileSync(join(appRoot, 'src', 'app', 'globals.css'), 'utf8').slice(approved.length);
    // Strip every @media block and comments; what remains must be only the invisible helpers.
    const withoutMedia = added
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    // Rules for the new SEO / GEO module are scoped to .seo* elements, which do not exist on any
    // approved screen, so they cannot change how those look.
    const selectors = [...withoutMedia.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim().replace(/\s+/g, ' '))
      .filter((sel) => !sel.startsWith('.seo') && !sel.startsWith('.soc'));
    expect(selectors.sort()).toEqual(
      [
        '.sr-only',
        '.skip-link',
        '.skip-link:focus',
        ':where(button, a, [tabindex]):focus-visible',
        '.sidebar :focus-visible, .topbar :focus-visible, .toast :focus-visible',
        '.workspace-menu :focus-visible',
        'main:focus',
        '.menu-toggle, .sidebar-close, .scrim',
      ].sort(),
    );
    // The always-on rules that could affect the look (focus ring) must be keyboard-only.
    expect(withoutMedia).toContain(':focus-visible');
    // And every media query we added is a max-width (small-screen) one or reduced-motion.
    const queries = [...added.matchAll(/@media\s*([^{]+)\{/g)].map((m) => m[1].trim());
    expect([...new Set(queries)].sort()).toEqual(
      ['(max-width: 1099px)', '(max-width: 520px)', '(max-width: 900px)', '(prefers-reduced-motion: reduce)', 'print'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------
// Structural comparison against the approved App.tsx
// ---------------------------------------------------------------------------------------

let ReferenceApp: () => React.ReactElement;
beforeAll(async () => {
  // Resolved by a test-only alias (see vitest.config.mts) and deliberately invisible to
  // TypeScript: the untouched reference source has a type error we did not "fix" in interface/.
  // @ts-expect-error -- module path exists only in the test runner's alias table
  ReferenceApp = (await import('@approved-interface/App')).default;
});
afterEach(cleanup);

/** Elements added for accessibility / small screens - invisible on desktop. */
const ADDED_ELEMENTS = '.skip-link, .sidebar-close, .scrim, .menu-toggle, .sr-only';
/** Wrappers added around the client table so it can scroll on phones - no styles on desktop. */
const ADDED_WRAPPERS = '.table-scroll, .table-grid';

function signature(root: HTMLElement) {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(ADDED_ELEMENTS).forEach((el) => el.remove());
  clone.querySelectorAll(ADDED_WRAPPERS).forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
  const elements = Array.from(clone.querySelectorAll('*')).map((el) => {
    const cls = el.getAttribute('class');
    const style = el.getAttribute('style');
    const src = el.tagName === 'IMG' ? el.getAttribute('src') : null;
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).filter(Boolean).join('.') : ''}${
      style ? `[${style}]` : ''
    }${src ? `<${src}>` : ''}`;
  });
  return { elements, text: (clone.textContent ?? '').replace(/\s+/g, ' ').trim() };
}


type Step = string | RegExp;

/**
 * Mount one dashboard on its own, perform the steps, and record what it looks like
 * (structure + text) before the first step and after each one.
 */
async function recordRun(Component: () => React.ReactElement, steps: Step[]) {
  const user = userEvent.setup();
  const { container, unmount } = render(<Component />);
  const buttonFor = (name: Step) => {
    const found = Array.from(container.querySelectorAll('button')).find((b) =>
      typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''),
    );
    if (!found) throw new Error('no button ' + String(name));
    return found;
  };
  const frames = [signature(container)];
  for (const step of steps) {
    await user.click(buttonFor(step));
    frames.push(signature(container));
  }
  unmount();
  return frames;
}

const compareRuns = async (steps: Step[]) => {
  // The original reuses a React key when "Add client" is clicked twice; that only logs a
  // warning in the reference (and is fixed in the port), so keep the output quiet.
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  const approved = await recordRun(ReferenceApp, steps);
  const ported = await recordRun(Dashboard, steps);
  quiet.mockRestore();
  return { approved, ported };
};

describe('the ported dashboard renders exactly like the approved App.tsx', () => {
  it('has the same structure, classes, styles and text on first load', async () => {
    const { approved, ported } = await compareRuns([]);
    expect(ported[0].elements.length).toBeGreaterThan(150);
    expect(ported[0].elements).toEqual(approved[0].elements);
    expect(ported[0].text).toBe(approved[0].text);
  });

  it('stays identical through the same interactions', async () => {
    const steps: Step[] = [
      'Approve', //            Meta campaign budget change -> Approved + toast
      'Review', //             LinkedIn post -> toast only
      /Add client/, //         first new row + toast
      /Add client/, //         second new row
      'Approve', //            Domain DNS update
      'Domains', //            module placeholder
      /Open module/, //        toast
      'Overview', //           back to the dashboard (approved state and new rows are gone / kept the same way)
      /Acme Marketing/, //     open the workspace selector
      'VMS Demo Agency', //    choose one
    ];
    const { approved, ported } = await compareRuns(steps);
    steps.forEach((step, i) => {
      expect(ported[i + 1], `after step ${i + 1}: ${String(step)}`).toEqual(approved[i + 1]);
    });
  });

  it('shows the same placeholder for every other module', async () => {
    const modules = ['Clients', 'Paid Ads', 'Domains', 'Leads & CRM', 'AI Monitor', 'Reports', 'Settings'];
    const { approved, ported } = await compareRuns(modules);
    modules.forEach((label, i) => {
      expect(ported[i + 1], label).toEqual(approved[i + 1]);
    });
    expect(ported[modules.length].text).toContain('Settings');
  });
});
