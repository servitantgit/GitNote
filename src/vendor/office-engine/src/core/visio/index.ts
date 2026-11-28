/**
 * Microsoft Visio drawings (.vsdx, and the macro-enabled, template and stencil variants of the same package),
 * opened read-only: each page is converted to a slide of a PPTX file.
 */
import { BlobSource } from '../source'
import { ZipArchive } from '../zip'
import { visioToPptx } from './convert'

export { visioToPptx } from './convert'

/** extensions of Visio packages: drawing, template, stencil, and their macro-enabled variants */
export const VISIO_EXT = ['vsdx', 'vsdm', 'vstx', 'vstm', 'vssx', 'vssm']

/** the ZIP is a Visio package: its document part is where every Visio version writes it */
export const isVisioZip = (zip: ZipArchive): boolean => zip.has('visio/document.xml')

/** Converts a Visio package to the PowerPoint archive it is shown as. */
export async function openVisio(zip: ZipArchive): Promise<{ zip: ZipArchive; from: 'visio' }> {
  return { zip: await ZipArchive.open(new BlobSource(await visioToPptx(zip))), from: 'visio' }
}
