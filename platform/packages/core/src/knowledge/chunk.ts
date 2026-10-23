// Chunks of a Markdown document (task X04 PR 3a, design/ADR-M89 §2.3): split at headings, then at
// paragraphs, to at most `maxChars` characters; a longer paragraph is cut. A chunk's key is the
// SHA-256 of its model and text, so the same text is embedded once per project and model.
import { createHash } from 'node:crypto';

const HEADING = /^#{1,6}\s/;

/** The sections of a document: each starts at a heading (the first may have none). */
function sections(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (HEADING.test(line) && current.some((l) => l.trim() !== '')) {
      out.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim() !== '')) out.push(current.join('\n'));
  return out;
}

/** Splits a Markdown text into chunks of at most `maxChars` characters, in order. */
export function chunkMarkdown(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (const section of sections(text)) {
    let buffer = '';
    const flush = () => {
      if (buffer.trim() !== '') chunks.push(buffer.trim());
      buffer = '';
    };
    for (const paragraph of section.split(/\n\s*\n/)) {
      const part = paragraph.trim();
      if (part === '') continue;
      if (part.length > maxChars) {
        flush();
        for (let i = 0; i < part.length; i += maxChars) chunks.push(part.slice(i, i + maxChars));
        continue;
      }
      if (buffer.length + part.length + 2 > maxChars) flush();
      buffer = buffer === '' ? part : `${buffer}\n\n${part}`;
    }
    flush();
  }
  return chunks;
}

/** The key of a chunk: SHA-256 (hex) of the model, a newline and the text. */
export function chunkKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}\n${text}`, 'utf8').digest('hex');
}

/** Markdown files the index reads (ADR-M89 §2.3). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}
