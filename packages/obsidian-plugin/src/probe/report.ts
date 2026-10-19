// The probe report: one JSON object, schema-versioned, with every measurement.
// It must never contain credentials, endpoints, bucket names, account IDs, or
// vault paths. `serialiseReport` redacts them and then refuses a report that
// still contains one.

export const REPORT_SCHEMA = 'obsy-probe-report';
export const REPORT_SCHEMA_VERSION = 1;

export type SectionId =
  | 'environment'
  | 'storage'
  | 'hashing'
  | 'indexedDb'
  | 'secretStorage'
  | 'vaultIo'
  | 'background'
  | 'markers';

export type SectionStatus = 'passed' | 'failed' | 'error' | 'unavailable' | 'skipped';

export interface SectionResult {
  status: SectionStatus;
  startedAt: string;
  durationMs: number;
  /** Measurements. The shape depends on the section. */
  data: unknown;
  /** Error descriptions. Redacted with the rest of the report. */
  errors: string[];
}

export interface ProbeReport {
  schema: typeof REPORT_SCHEMA;
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  probeVersion: string;
  generatedAt: string;
  /** Random ID of this plugin session. It does not identify the user or device. */
  sessionId: string;
  config: unknown;
  /** What the probe found when the plugin loaded: the restart test. */
  onLoad: unknown;
  lifecycle: unknown;
  sections: Partial<Record<SectionId, SectionResult>>;
  notes: string[];
}

/**
 * A value that must not appear in the report, and its placeholder.
 *
 * `substring` matches anywhere; use it for long random values such as
 * credentials. `token` matches only where the value is not part of a longer
 * name (letters, digits, `.`, `_`, `-` around it); use it for bucket names and
 * hosts, which can look like ordinary words such as `obsy-probe`.
 */
export interface SensitiveValue {
  value: string;
  placeholder: string;
  match: 'substring' | 'token';
}

/** Origins that are safe to keep. They show which WebView origin made a request. */
const SAFE_ORIGINS = new Set(['app://obsidian.md', 'capacitor://localhost', 'http://localhost']);

const GENERIC_PATTERNS: [RegExp, string][] = [
  // Any URL, including app:// and capacitor:// resource URLs that hold vault paths.
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi, '<url>'],
  // Cloudflare account IDs, and MD5 etags.
  [/\b[0-9a-f]{32}\b/gi, '<hex32>'],
  // AWS access key IDs.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<aws-access-key-id>'],
  // AWS account IDs.
  [/\b\d{12}\b/g, '<number12>'],
  // Absolute paths on macOS, iOS, Linux, and Windows.
  [
    /(?:\/Users|\/home|\/private\/var|\/var\/mobile|\/var\/folders|\/Volumes|[A-Za-z]:\\Users)[^\s"'<>`]*/g,
    '<path>',
  ],
];

const NAME_CHARACTER = /[A-Za-z0-9._-]/;

/** Builds the list of sensitive values, longest first, with URL-encoded forms. */
export function sensitiveValues(
  entries: readonly (SensitiveValue | undefined)[],
): SensitiveValue[] {
  const out = new Map<string, SensitiveValue>();
  for (const entry of entries) {
    if (entry === undefined) continue;
    const value = entry.value.trim();
    if (value.length < 3) continue;
    for (const form of [value, encodeURIComponent(value), value.replace(/\/+$/, '')]) {
      const key = form.toLowerCase();
      if (form.length >= 3 && !out.has(key)) out.set(key, { ...entry, value: form });
    }
  }
  return [...out.values()].sort((a, b) => b.value.length - a.value.length);
}

/** Start offsets of `value` in `input`, ignoring case, honouring `match`. */
function occurrences(input: string, entry: SensitiveValue): number[] {
  const lowerInput = input.toLowerCase();
  const lowerValue = entry.value.toLowerCase();
  // Lower-casing can change the length of some characters; then match exactly.
  const caseless = lowerInput.length === input.length && lowerValue.length === entry.value.length;
  const haystack = caseless ? lowerInput : input;
  const needle = caseless ? lowerValue : entry.value;
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (entry.match === 'token') {
      const before = at === 0 ? '' : (input[at - 1] ?? '');
      const after = input[at + needle.length] ?? '';
      if (NAME_CHARACTER.test(before) || NAME_CHARACTER.test(after)) continue;
    }
    if (found.length > 0 && at < (found.at(-1) ?? 0) + needle.length) continue;
    found.push(at);
  }
  return found;
}

/** Redacts one string. */
export function redactString(input: string, sensitive: readonly SensitiveValue[]): string {
  let output = input;
  for (const entry of sensitive) {
    const found = occurrences(output, entry);
    for (const at of found.reverse()) {
      output = output.slice(0, at) + entry.placeholder + output.slice(at + entry.value.length);
    }
  }
  for (const [pattern, placeholder] of GENERIC_PATTERNS) {
    output = output.replace(pattern, (match) => (SAFE_ORIGINS.has(match) ? match : placeholder));
  }
  return output;
}

/** Returns a deep copy with every string and every object key redacted. */
export function redactValue(value: unknown, sensitive: readonly SensitiveValue[]): unknown {
  if (typeof value === 'string') return redactString(value, sensitive);
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, sensitive));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[redactString(key, sensitive)] = redactValue(item, sensitive);
    }
    return out;
  }
  return value;
}

/** Thrown when a report still contains a sensitive value after redaction. */
export class RedactionError extends Error {
  constructor(placeholder: string) {
    super(`The report still contains a value for ${placeholder}, so it was withheld`);
    this.name = 'RedactionError';
  }
}

/** Throws `RedactionError` if `json` contains a sensitive value. */
export function checkRedacted(json: string, sensitive: readonly SensitiveValue[]): void {
  for (const entry of sensitive) {
    // JSON escapes some characters; check the escaped form too.
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    for (const form of new Set([entry.value, escaped])) {
      if (occurrences(json, { ...entry, value: form }).length > 0) {
        throw new RedactionError(entry.placeholder);
      }
    }
  }
}

/** Redacts a report and serialises it. Throws `RedactionError` if the check fails. */
export function serialiseReport(report: ProbeReport, sensitive: readonly SensitiveValue[]): string {
  const json = JSON.stringify(redactValue(report, sensitive), null, 2);
  checkRedacted(json, sensitive);
  return json;
}

export type ProviderGuess = 'r2' | 'aws-s3' | 'other' | 'unset';

/** Guesses the provider from the endpoint host, without keeping the host. */
export function guessProvider(endpoint: string): ProviderGuess {
  const trimmed = endpoint.trim();
  if (trimmed === '') return 'unset';
  const host = endpointHost(trimmed)?.toLowerCase().replace(/:\d+$/, '');
  if (host === undefined) return 'other';
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'r2';
  if (host === 'amazonaws.com' || host.endsWith('.amazonaws.com')) return 'aws-s3';
  return 'other';
}

/** The host (with port) of an endpoint, or `undefined`. */
export function endpointHost(endpoint: string): string | undefined {
  return /^https?:\/\/([^/?#]+)/i.exec(endpoint.trim())?.[1];
}
