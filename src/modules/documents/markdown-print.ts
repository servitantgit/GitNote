/** Prints Markdown through a sanitized, format-specific HTML rendering. */
export async function printMarkdownDocument(content: string, title: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1000px;height:800px;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new Error('Не вдалося створити документ для друку.');
  }

  try {
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
    doc.close();
    doc.title = title;

    const [{ renderMarkdown }, { default: DOMPurify }] = await Promise.all([
      import('../editor/markdown-preview'),
      import('dompurify'),
    ]);
    const html = await renderMarkdown(content);
    const style = doc.createElement('style');
    style.textContent =
      '@page { margin: 18mm; }' +
      'html,body{margin:0;padding:0;background:#fff;color:#111;}' +
      "body{font:11pt/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;}" +
      'img{max-width:100%;height:auto;}pre{white-space:pre-wrap;overflow-wrap:anywhere;}' +
      'table{border-collapse:collapse;max-width:100%;}' +
      'th,td{border:1px solid #999;padding:4px 7px;}' +
      'blockquote{margin-left:0;padding-left:1em;border-left:3px solid #999;color:#444;}' +
      'a{color:inherit;text-decoration:underline;}';
    doc.head.appendChild(style);
    doc.body.innerHTML = DOMPurify.sanitize(html);
    await Promise.race([
      Promise.all(Array.from(doc.images).map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
      }))),
      new Promise(resolve => window.setTimeout(resolve, 5000)),
    ]);
    await Promise.race([doc.fonts?.ready, new Promise(resolve => window.setTimeout(resolve, 1500))]);

    const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
    frame.contentWindow?.addEventListener('afterprint', cleanup, { once: true });
    window.setTimeout(() => frame.remove(), 60_000);
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch (error) {
    frame.remove();
    throw error;
  }
}
