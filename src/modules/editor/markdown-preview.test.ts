import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown-preview';

describe('rendered Markdown code highlighting', () => {
  const fence = String.fromCharCode(96).repeat(3);

  it('highlights multiline Python and Java fences with Lezer token classes', async () => {
    const html = await renderMarkdown([
      fence + 'python',
      'def greet(name):',
      '    return "Hello " + name',
      fence,
      '',
      fence + 'java',
      'public class Demo {',
      '  public static void main(String[] args) {',
      '    System.out.println("hello");',
      '  }',
      '}',
      fence,
    ].join('\n'));

    expect(html).toContain('<code class="language-python">');
    expect(html).toContain('<code class="language-java">');
    expect(html).toContain('class="tok-keyword"');
    expect(html).toContain('class="tok-string"');
    expect(html).toContain('def');
    expect(html).toContain('public');
  });

  it.each(['py', 'python3'])('recognizes the %s alias in rendered Preview', async alias => {
    const markdown = fence + alias + '\ndef greet():\n    return 1\n' + fence;
    const html = await renderMarkdown(markdown);
    expect(html).toContain('class="tok-keyword"');
  });

  it('leaves unknown languages unhighlighted and escapes their code', async () => {
    const html = await renderMarkdown(fence + 'unknown\n<script>alert(1)</script>\n' + fence);
    expect(html).toContain('<code class="language-unknown">&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('tok-keyword');
  });
});
