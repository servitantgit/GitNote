import { markdownLanguage } from '@codemirror/lang-markdown';
import { parentWorkspacePath } from '../../core/domain/workspace-file-system';

interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

function resolveLinkTarget(documentPath: string, target: string): { path: string; rootRelative: boolean; suffix: string } | null {
  const value = target.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;

  const suffixIndex = value.search(/[?#]/u);
  const encodedPath = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? '' : value.slice(suffixIndex);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!decodedPath || decodedPath.includes('\0')) return null;

  const rootRelative = decodedPath.startsWith('/');
  const segments = rootRelative ? [] : parentWorkspacePath(documentPath).split('/').filter(Boolean);
  for (const segment of decodedPath.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      if (segment.includes('\0')) return null;
      segments.push(segment);
    }
  }
  return segments.length ? { path: segments.join('/'), rootRelative, suffix } : null;
}

function relativeWorkspacePath(fromDirectory: string, targetPath: string): string {
  const from = fromDirectory ? fromDirectory.split('/') : [];
  const to = targetPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const segments = [
    ...Array(from.length - common).fill('..'),
    ...to.slice(common),
  ];
  return segments.map(segment => encodeURIComponent(segment)).join('/') || '.';
}

/**
 * Rewrites Markdown inline link and image destinations when a workspace path or
 * the Markdown document containing those links is relocated. Lezer identifies
 * actual Markdown link nodes, so examples inside code blocks remain untouched.
 */
export function rewriteWorkspaceMarkdownLinks(
  content: string,
  previousDocumentPath: string,
  nextDocumentPath: string,
  pathChanges: ReadonlyMap<string, string>,
  existingPaths: ReadonlySet<string>,
): string {
  const tree = markdownLanguage.parser.parse(content);
  const edits: TextEdit[] = [];

  tree.iterate({
    enter(node) {
      if (node.name !== 'Link' && node.name !== 'Image') return;
      const destination = node.node.getChild('URL');
      if (!destination) return;

      const rawTarget = content.slice(destination.from, destination.to);
      const resolved = resolveLinkTarget(previousDocumentPath, rawTarget);
      if (!resolved || !existingPaths.has(resolved.path)) return;

      const nextTargetPath = pathChanges.get(resolved.path) ?? resolved.path;
      if (nextTargetPath === resolved.path && previousDocumentPath === nextDocumentPath) return;

      const rewrittenPath = resolved.rootRelative
        ? '/' + nextTargetPath.split('/').map(segment => encodeURIComponent(segment)).join('/')
        : relativeWorkspacePath(parentWorkspacePath(nextDocumentPath), nextTargetPath);
      const rewrittenTarget = rewrittenPath + resolved.suffix;
      if (rewrittenTarget !== rawTarget) {
        edits.push({ from: destination.from, to: destination.to, insert: rewrittenTarget });
      }
    },
  });

  if (edits.length === 0) return content;
  let result = content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  }
  return result;
}
