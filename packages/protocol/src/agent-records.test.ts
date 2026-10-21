import { describe, expect, it } from 'vite-plus/test';

import {
  parsePresenceKey,
  parseProposalKey,
  presenceKey,
  proposalKey,
  resolutionKey,
} from './layout';
import {
  ProtocolError,
  decodePresence,
  decodeProposal,
  decodeResolution,
  encodeRecord,
  type Presence,
  type Proposal,
  type Resolution,
} from './records';
import { encodeUtf8 } from './web';

const H1 = `sha256:${'1'.repeat(64)}` as const;
const H2 = `sha256:${'2'.repeat(64)}` as const;
const PID = 'p_aaaaaaaaaaaaaaaaaaaaaaaa';

const proposal: Proposal = {
  format: 1,
  id: PID,
  createdAt: '2026-10-21T10:00:00.000Z',
  actor: { kind: 'agent', id: 'planner', run: 'r1', toolCall: 't1' },
  path: 'daily/2026-10-21.md',
  fileId: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  baseRev: 4,
  baseHash: H1,
  hash: H2,
  size: 12,
  reason: 'block-edited',
  operation: 'replaceBlock',
  rationale: 'Update the weather block.',
};

function json(value: unknown): Uint8Array {
  return encodeUtf8(JSON.stringify(value));
}

describe('agent record keys', () => {
  it('writes and parses proposal, resolution, and presence keys', () => {
    expect(proposalKey(PID)).toBe(`proposals/${PID}.json`);
    expect(resolutionKey(PID)).toBe(`resolutions/${PID}.json`);
    expect(parseProposalKey(`proposals/${PID}.json`)).toBe(PID);
    expect(parseProposalKey(`resolutions/${PID}.json`)).toBe(PID);
    expect(parseProposalKey(`proposals/${PID}.json.tmp`)).toBeNull();
    expect(presenceKey('mac')).toBe('presence/mac.json');
    expect(parsePresenceKey('presence/mac.json')).toBe('mac');
    expect(parsePresenceKey('presence/a/b.json')).toBeNull();
    expect(() => proposalKey('p_x')).toThrow(ProtocolError);
    expect(() => presenceKey('../x')).toThrow(ProtocolError);
  });
});

describe('proposal records', () => {
  it('round-trips', () => {
    expect(decodeProposal(encodeRecord(proposal), PID)).toEqual(proposal);
  });

  it('accepts a proposal for a new file', () => {
    const fresh = { ...proposal, fileId: null, baseRev: null, baseHash: null };
    expect(decodeProposal(json(fresh))).toEqual(fresh);
  });

  it.each([
    ['an unknown field', { ...proposal, extra: 1 }],
    ['a base without a file', { ...proposal, fileId: null }],
    ['a file without a base', { ...proposal, baseRev: null }],
    ['a bad reason', { ...proposal, reason: 'because' }],
    ['a bad operation', { ...proposal, operation: 'two words' }],
    ['a long rationale', { ...proposal, rationale: 'x'.repeat(4001) }],
    ['a bad path', { ...proposal, path: '../x.md' }],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeProposal(json(value))).toThrow(ProtocolError);
  });

  it('rejects an ID that differs from its key', () => {
    expect(() => decodeProposal(encodeRecord(proposal), 'p_bbbbbbbbbbbbbbbbbbbbbbbb')).toThrow(
      ProtocolError,
    );
  });
});

describe('resolution records', () => {
  const accepted: Resolution = {
    format: 1,
    id: PID,
    resolvedAt: '2026-10-21T10:05:00Z',
    actor: { kind: 'device', id: 'mac' },
    outcome: 'accepted',
    seq: 9,
  };

  it('round-trips', () => {
    expect(decodeResolution(encodeRecord(accepted), PID)).toEqual(accepted);
    const { seq: _seq, ...rejected } = { ...accepted, outcome: 'rejected' as const };
    expect(decodeResolution(json(rejected))).toEqual(rejected);
  });

  it('rejects a rejection with a commit, and a bad outcome', () => {
    expect(() => decodeResolution(json({ ...accepted, outcome: 'rejected' }))).toThrow(
      ProtocolError,
    );
    expect(() => decodeResolution(json({ ...accepted, outcome: 'maybe' }))).toThrow(ProtocolError);
  });
});

describe('presence records', () => {
  const presence: Presence = {
    format: 1,
    device: 'mac',
    time: '2026-10-21T10:00:00Z',
    path: 'daily/2026-10-21.md',
  };

  it('round-trips, also without a path', () => {
    expect(decodePresence(encodeRecord(presence), 'mac')).toEqual(presence);
    expect(decodePresence(json({ ...presence, path: null }))).toEqual({ ...presence, path: null });
  });

  it('rejects another device and a bad time', () => {
    expect(() => decodePresence(encodeRecord(presence), 'phone')).toThrow(ProtocolError);
    expect(() => decodePresence(json({ ...presence, time: 'now' }))).toThrow(ProtocolError);
  });
});
