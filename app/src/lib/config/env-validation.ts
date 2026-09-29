/**
 * Phase F.1 - environment-variable validation WITHOUT reading or exposing real secret values.
 *
 * Every check here answers two questions only: is the variable present, and is its SHAPE
 * plausible (a URL looks like a URL, a key has the prefix its provider always uses)? A report
 * produced by this module is always safe to print, log or paste into chat - it never contains
 * an actual value, valid or not, only the variable's NAME and what's wrong with it.
 */

export type EnvVarShape =
  | { kind: 'url' }
  | { kind: 'nonEmpty' }
  | { kind: 'pattern'; pattern: RegExp; description: string };

export interface EnvVarSpec {
  name: string;
  required: boolean;
  shape: EnvVarShape;
  /** Human description for a report - never the value itself. */
  purpose: string;
}

export interface EnvVarCheckResult {
  name: string;
  present: boolean;
  /** null when the variable is absent, so its shape was never checked. */
  validShape: boolean | null;
  /** Never contains the variable's value. */
  problem: string | null;
}

export interface EnvValidationReport {
  ok: boolean;
  results: EnvVarCheckResult[];
}

function checkShape(value: string, shape: EnvVarShape): { valid: boolean; problem: string | null } {
  if (shape.kind === 'nonEmpty') {
    return value.trim().length > 0 ? { valid: true, problem: null } : { valid: false, problem: 'is set but empty' };
  }
  if (shape.kind === 'url') {
    try {
      new URL(value);
      return { valid: true, problem: null };
    } catch {
      return { valid: false, problem: 'is not a valid URL' };
    }
  }
  return shape.pattern.test(value) ? { valid: true, problem: null } : { valid: false, problem: `does not match the expected shape (${shape.description})` };
}

/**
 * Checks each spec against `env` (defaults to `process.env`, but a test - or a future startup
 * script - can pass its own object instead). `ok` is true only when every REQUIRED variable is
 * present with a valid shape, and every PRESENT optional variable also has a valid shape (an
 * absent optional variable is fine - it just hasn't been turned on yet).
 */
export function validateEnvironment(specs: readonly EnvVarSpec[], env: NodeJS.ProcessEnv = process.env): EnvValidationReport {
  const results: EnvVarCheckResult[] = specs.map((spec) => {
    const raw = env[spec.name];
    const present = typeof raw === 'string' && raw.length > 0;
    if (!present) {
      return { name: spec.name, present: false, validShape: null, problem: spec.required ? 'is required but not set' : null };
    }
    const { valid, problem } = checkShape(raw, spec.shape);
    return { name: spec.name, present: true, validShape: valid, problem };
  });
  return { ok: results.every((r) => r.problem === null), results };
}
