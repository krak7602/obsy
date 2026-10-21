/**
 * The obsy agent SDK: narrow, anchored edits for agents and scripts, and
 * the owner's operations (status, undo, proposals). Free of Node and DOM
 * APIs. See docs/subsystems/agent-sdk.md.
 */
export {
  AgentInputError,
  AgentRateLimited,
  VaultAgent,
  type AgentFile,
  type AgentLimits,
  type ListedFile,
  type PresenceMode,
  type PresenceOptions,
  type VaultAgentOptions,
  type WriteOptions,
  type WriteResult,
} from './agent';
export {
  VaultAdmin,
  type AcceptResult,
  type ProposalDetail,
  type UndoProblem,
  type UndoResult,
  type VaultAdminOptions,
  type VaultStatus,
} from './admin';
export { NoVaultError, VaultReader, type Revision, type RevisionEntry } from './reader';
export { PresenceWriter, proposalIds, readPresence, readProposal, readResolution } from './records';
export {
  appendToSection,
  blockHash,
  findBlock,
  findSection,
  headings,
  insertBlock,
  isBlockId,
  isOwned,
  replaceBlockContent,
  splitLines,
  type Block,
  type BlockLookup,
  type EditResult,
  type Heading,
  type Lines,
  type SectionLookup,
} from './markdown';
