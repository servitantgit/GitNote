import { describe, expect, it } from 'vitest';
import { LanguageDescription } from '@codemirror/language';
import { codeLanguages } from './code-languages';

describe('Markdown fenced-code language highlighting', () => {
  it.each([
    ['java', 'Java'],
    ['python', 'Python'],
    ['py', 'Python'],
    ['python3', 'Python'],
  ])('recognizes the %s fence tag as %s', (tag, expectedName) => {
    const language = LanguageDescription.matchLanguageName(codeLanguages, tag);
    expect(language?.name).toBe(expectedName);
  });

  it('loads Java and Python language highlighters without IDE completion features', async () => {
    const java = codeLanguages.find(language => language.name === 'Java');
    const python = codeLanguages.find(language => language.name === 'Python');
    expect(java).toBeDefined();
    expect(python).toBeDefined();

    const [javaSupport, pythonSupport] = await Promise.all([java!.load(), python!.load()]);
    expect(javaSupport.language.parser.parse('public class Demo {}').length).toBeGreaterThan(0);
    expect(pythonSupport.language.parser.parse('def greet(name):\\n    return name').length).toBeGreaterThan(0);
  });
});
