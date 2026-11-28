const MAX_SIDE = 1920;
const JPEG_QUALITY = 0.85;
const RECODE_TYPES = new Set(['image/png', 'image/bmp', 'image/jpeg', 'image/jpg']);

export function fitWithin(width: number, height: number, maxSide = MAX_SIDE) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: w, height: h };
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function chooseImageOutput(type: string, hasAlpha: boolean, scaled: boolean): { mime: string; quality?: number } | null {
  const normalized = type.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return scaled ? { mime: 'image/jpeg', quality: JPEG_QUALITY } : null;
  }
  if (normalized === 'image/png' || normalized === 'image/bmp') {
    if (!hasAlpha) return { mime: 'image/jpeg', quality: JPEG_QUALITY };
    return scaled ? { mime: 'image/png' } : null;
  }
  return null;
}

function hasTransparency(data: Uint8ClampedArray): boolean {
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) return true;
  }
  return false;
}

/** Compresses supported raster images; any browser/canvas failure preserves the original. */
export async function compressImage(file: File): Promise<File> {
  try {
    if (!RECODE_TYPES.has(file.type.toLowerCase()) || typeof createImageBitmap !== 'function') return file;
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = fitWithin(bitmap.width, bitmap.height);
      const scaled = width !== bitmap.width || height !== bitmap.height;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      const output = chooseImageOutput(file.type, hasTransparency(context.getImageData(0, 0, width, height).data), scaled);
      if (!output) return file;
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, output.mime, output.quality));
      if (!blob || blob.size >= file.size) return file;
      const extension = output.mime === 'image/png' ? '.png' : '.jpg';
      const name = (file.name.replace(/\.[^./\\]*$/, '') || 'image') + extension;
      return new File([blob], name, { type: output.mime, lastModified: file.lastModified });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
