import { LanguageDescription } from '@codemirror/language';

/**
 * Syntax highlighters available inside Markdown fenced code blocks.
 * These are deliberately limited to language parsing/highlighting, not IDE features.
 */
export const codeLanguages = [
  LanguageDescription.of({
    name: 'Java',
    alias: ['java'],
    extensions: ['java'],
    load: async () => (await import('@codemirror/lang-java')).java(),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['python', 'py', 'python3'],
    extensions: ['py', 'pyw'],
    load: async () => (await import('@codemirror/lang-python')).python(),
  }),
];
