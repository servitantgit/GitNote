import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { marked, type Tokens } from 'marked';
import { codeLanguages } from './code-languages';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function languageForInfo(info: string | undefined) {
  const tag = info?.trim().split(/\s+/, 1)[0];
  return tag ? LanguageDescription.matchLanguageName(codeLanguages, tag) : undefined;
}

function highlightCode(source: string, support: LanguageSupport): string {
  const tree = support.language.parser.parse(source);
  const chunks: string[] = [];
  let position = 0;

  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > position) chunks.push(escapeHtml(source.slice(position, from)));
    chunks.push('<span class="' + classes + '">' + escapeHtml(source.slice(from, to)) + '</span>');
    position = to;
  });

  if (position < source.length) chunks.push(escapeHtml(source.slice(position)));
  return chunks.join('');
}

/**
 * Render Markdown with Lezer highlighting for the language fences registered
 * by the Markdown source editor. Unknown languages remain ordinary code.
 */
export async function renderMarkdown(
  content: string,
  resolveAttachment?: (id: string) => Promise<Blob>,
  onAttachmentUrl?: (placeholder: string, objectUrl: string) => void,
): Promise<string> {
  const tokens = marked.lexer(content, { gfm: true });
  const pending = new Map<string, Promise<LanguageSupport>>();
  const attachmentTokens: Array<{ token: Tokens.Image; id: string }> = [];

  marked.walkTokens(tokens, token => {
    if (token.type !== 'image' || !resolveAttachment || !onAttachmentUrl) return;
    const match = /^attachment:([a-f0-9-]{36})$/i.exec(token.href);
    if (match) attachmentTokens.push({ token, id: match[1] });
  });

  await Promise.all(attachmentTokens.map(async ({ token, id }, index) => {
    try {
      const blob = await resolveAttachment(id);
      const objectUrl = URL.createObjectURL(blob);
      const placeholder = `https://gitnote.invalid/attachment/${index}`;
      token.href = placeholder;
      onAttachmentUrl(placeholder, objectUrl);
    } catch {
      token.href = '';
      token.text = token.text || 'Вкладення не знайдено';
    }
  }));

  marked.walkTokens(tokens, token => {
    if (token.type !== 'code') return;
    const language = languageForInfo(token.lang);
    if (language && !pending.has(language.name)) {
      pending.set(language.name, language.load());
    }
  });

  const loaded = new Map<string, LanguageSupport>();
  await Promise.all([...pending].map(async ([name, promise]) => {
    try {
      loaded.set(name, await promise);
    } catch {
      // Keep Preview available as plain code if an optional language chunk fails.
    }
  }));

  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }) => {
    const language = languageForInfo(lang);
    const support = language ? loaded.get(language.name) : undefined;
    const code = support ? highlightCode(text, support) : escapeHtml(text);
    const languageClass = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    return '<pre><code' + languageClass + '>' + code + '</code></pre>\n';
  };

  return marked.parser(tokens, { gfm: true, renderer }) as string;
}
