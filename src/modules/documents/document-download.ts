/** Downloads the supplied original/current Blob without converting its contents. */
export function downloadDocument(content: Blob, fileName: string): void {
  const safeName = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'document';
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
