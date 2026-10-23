// The index of a project's documents (task X04 PR 3a, design/ADR-M89).
export { chunkKey, chunkMarkdown, isMarkdownPath } from './chunk.js';
export {
  buildProjectIndex,
  type BuildIndexInput,
  type BuiltIndex,
  type KnowledgeDeps,
} from './indexer.js';
