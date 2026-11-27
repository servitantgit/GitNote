import { Text } from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';

export interface OutlineHeading {
  line: number;
  level: number;
  text: string;
}

/** Extract structural Markdown headings from the Lezer syntax tree. */
export function parseDocumentOutline(content: string): OutlineHeading[] {
  const document = Text.of(content.split('\n'));
  const tree = markdownLanguage.parser.parse(content);
  const headings: OutlineHeading[] = [];

  tree.iterate({
    enter(node) {
      const match = /Heading([1-6])$/.exec(node.name);
      if (!match) return;

      const line = document.lineAt(node.from);
      let text = line.text.trim();
      if (node.name.startsWith('ATX')) {
        text = text.replace(/^ {0,3}#{1,6}[ \t]*/, '');
        text = text.replace(/[ \t]+#+[ \t]*$/, '').trim();
      }
      if (!text) return;

      headings.push({ line: line.number - 1, level: Number(match[1]), text });
    },
  });

  return headings;
}