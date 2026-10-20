import { DEFAULT_RACE } from './checks';
import type { RaceParameters } from './checks';

function positiveInt(
  settings: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = settings[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Race parameters from `OBSY_RACE_*` settings (for example `process.env`),
 * with `defaults` for unset ones. See docs/runbooks/storage-conformance.md.
 */
export function raceFromSettings(
  settings: Readonly<Record<string, string | undefined>>,
  defaults: RaceParameters = DEFAULT_RACE,
): RaceParameters {
  return {
    createWriters: positiveInt(settings, 'OBSY_RACE_CREATE_WRITERS', defaults.createWriters),
    createRounds: positiveInt(settings, 'OBSY_RACE_CREATE_ROUNDS', defaults.createRounds),
    logWriters: positiveInt(settings, 'OBSY_RACE_LOG_WRITERS', defaults.logWriters),
    commitsPerWriter: positiveInt(
      settings,
      'OBSY_RACE_COMMITS_PER_WRITER',
      defaults.commitsPerWriter,
    ),
    listLimit: positiveInt(settings, 'OBSY_RACE_LIST_LIMIT', defaults.listLimit),
  };
}
