import { expect, test } from '@playwright/test';

function createStoredZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  const crc32 = (data: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeDocxFixture(): Buffer {
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return createStoredZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + relationships + '/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + relationships + '/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="' + word + '"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>',
    'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + word + '" xmlns:r="' + relationships + '"><w:body><w:p><w:r><w:t xml:space="preserve">Original Word text</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>',
  });
}

function makeXlsxFixture(): Buffer {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return createStoredZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + officeRel + '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="' + main + '" xmlns:r="' + officeRel + '"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="' + main + '"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Original Excel text</t></is></c></row></sheetData></worksheet>',
  });
}


function makePptxFixture(): Buffer {
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const rel = (id: number, type: string, target: string) =>
    '<Relationship Id="rId' + id + '" Type="' + relationships + '/' + type + '" Target="' + target + '"/>';
  const rels = (...items: string[]) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + packageRelationships + '">' + items.join('') + '</Relationships>';
  const theme = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="' + drawing + '" name="GitNotes test theme"><a:themeElements>' +
    '<a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>';
  const slideShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Editable text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="8000000" cy="1200000"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>Original PPTX text</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
  const ns = 'xmlns:a="' + drawing + '" xmlns:r="' + relationships + '" xmlns:p="' + presentation + '"';
  return createStoredZip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>',
    '_rels/.rels': rels(rel(1, 'officeDocument', 'ppt/presentation.xml')),
    'ppt/presentation.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ' + ns + '>' +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels(
      rel(1, 'slideMaster', 'slideMasters/slideMaster1.xml'),
      rel(2, 'slide', 'slides/slide1.xml'),
      rel(3, 'theme', 'theme/theme1.xml'),
    ),
    'ppt/slideMasters/slideMaster1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ' + ns + '><p:cSld><p:spTree>' + group +
      '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(
      rel(1, 'slideLayout', '../slideLayouts/slideLayout1.xml'),
      rel(2, 'theme', '../theme/theme1.xml'),
    ),
    'ppt/slideLayouts/slideLayout1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ' + ns + ' type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>' +
      group + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(rel(1, 'slideMaster', '../slideMasters/slideMaster1.xml')),
    'ppt/slides/slide1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ' + ns + '><p:cSld><p:spTree>' +
      group + slideShape + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels(rel(1, 'slideLayout', '../slideLayouts/slideLayout1.xml')),
    'ppt/theme/theme1.xml': theme,
  });
}

async function importOfficeFile(page: import('@playwright/test').Page, name: string, mimeType: string, buffer: Buffer) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Імпортувати документ' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType, buffer });
}

async function saveOfficeFile(page: import('@playwright/test').Page) {
  await expect(page.locator('.save-indicator')).toHaveText('Є незбережені зміни');
  // GitNotes disables the Office file menu; the engine's supported host save shortcut remains available.
  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-indicator')).toHaveText('Збережено локально');
}

async function readSpreadsheetCell(page: import('@playwright/test').Page, ref: string): Promise<string> {
  const [, column, row] = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const point = await page.evaluate(({ columnName, rowNumber }) => {
    const findCenter = (selector: string, value: string) => {
      const element = [...document.querySelectorAll<HTMLElement>(selector)]
        .find(item => item.innerText.trim() === value);
      if (!element) throw new Error('Spreadsheet header not found: ' + value);
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    const col = findCenter('.de-head-c', columnName);
    const line = findCenter('.de-head-r', rowNumber);
    return { x: col.x, y: line.y };
  }, { columnName: column, rowNumber: row });
  return page.evaluate(({ x, y }) => {
    for (const element of document.elementsFromPoint(x, y)) {
      const cell = element.closest<HTMLElement>('.de-cell');
      if (cell) return cell.innerText.trim();
    }
    return '';
  }, point);
}

test.beforeEach(async ({ page }) => {
  // Playwright creates a fresh browser context for each test, including a clean IndexedDB.
  await page.goto('/');
  await expect.poll(async () => {
    const alert = page.getByRole('alert');
    if (await alert.count()) return `error: ${await alert.innerText()}`;
    if (await page.getByLabel('Назва нотатки').count()) return 'ready';
    return 'loading';
  }, { message: 'The local workspace should initialize before editor tests run' }).toBe('ready');
});

test('creates a folder and places a new note inside the selected folder', async ({ page }) => {
  page.once('dialog', dialog => dialog.accept('Projects'));
  await page.getByRole('button', { name: 'Створити папку' }).click();
  const tree = page.getByTestId('workspace-file-tree');
  await expect(tree.getByRole('button', { name: 'Projects' })).toBeVisible();
  await tree.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'Створити нотатку' }).click();

  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<boolean>((resolve, reject) => {
      const request = db.transaction('fileNodes', 'readonly').objectStore('fileNodes').getAll();
      request.onsuccess = () => resolve(request.result.some((node: { path: string; kind: string }) => node.kind === 'file' && node.path.startsWith('Projects/')));
      request.onerror = () => reject(request.error);
    });
  })).toBe(true);
});

test('imports a local document, opens it and restores its Blob after reload', async ({ page }) => {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Імпортувати документ' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'Browser import.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('Imported text remains binary-backed'),
  });
  await expect(page.getByRole('button', { name: 'Browser import.md' })).toBeVisible();
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  await expect.poll(() => page.locator('.binary-document-header').evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(50);
  await expect(page.getByRole('alert')).toHaveCount(0);

  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<{ document: { path: string; size: number; contentText: string } | undefined; node: { path: string; documentId?: string } | undefined }>((resolve, reject) => {
      const transaction = db.transaction(['binaryDocuments', 'fileNodes'], 'readonly');
      const documentsRequest = transaction.objectStore('binaryDocuments').getAll();
      const nodesRequest = transaction.objectStore('fileNodes').getAll();
      transaction.oncomplete = () => {
        const document = documentsRequest.result.find((item: { title: string }) => item.title === 'Browser import.md');
        const node = nodesRequest.result.find((item: { path: string }) => item.path === 'Documents/Browser import.md');
        if (!document) {
          resolve({ document: undefined, node });
          return;
        }
        void document.content.text().then((contentText: string) => {
          resolve({ document: { path: document.path, size: document.size, contentText }, node });
        }, reject);
      };
      transaction.onerror = () => reject(transaction.error);
    });
  });
  expect(stored.document?.path).toBe('Documents/Browser import.md');
  expect(stored.document?.size).toBe(Buffer.byteLength('Imported text remains binary-backed'));
  expect(stored.document?.contentText).toBe('Imported text remains binary-backed');
  expect(stored.node?.documentId).toBeTruthy();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Browser import.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Browser import.md' }).click();
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});



test('synchronizes HTML source and rendered document scrolling independently', async ({ page }) => {
  const paragraphs = Array.from({ length: 90 }, (_, index) =>
    '<p>HTML section ' + (index + 1) + ' with enough content to occupy space in the rendered document.</p>',
  ).join('\n');
  const html = ['<!doctype html>', '<html>', '<head>', '<meta charset="utf-8">', '<title>Scroll test</title>', '</head>', '<body>', '<h1>HTML scroll test</h1>', paragraphs, '</body>', '</html>'].join('\n');
  await importOfficeFile(page, 'Scroll-test.html', 'text/html', Buffer.from(html));
  await expect(page.getByTestId('html-document-viewer')).toBeVisible();

  await page.getByTestId('de-code-toggle').click();
  const source = page.locator('.html-document-viewer .de-src-scroll');
  const preview = page.locator('.html-document-viewer .de-main .de-scroll');
  await expect(source).toBeVisible();
  await expect(preview).toBeVisible();
  await expect.poll(() => source.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await expect.poll(() => preview.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);

  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.62;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const sourceBeforeReverse = await source.evaluate(element => element.scrollTop);
  await preview.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.28;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => Math.abs(
    (await source.evaluate(element => element.scrollTop)) - sourceBeforeReverse,
  )).toBeGreaterThan(50);
});

test('imports, edits, saves and restores a DOCX through IndexedDB', async ({ page }) => {
  await importOfficeFile(
    page,
    'Roundtrip.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    makeDocxFixture(),
  );
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  const pages = page.locator('.de-pages');
  await expect(pages).toContainText('Original Word text');

  const selected = await page.evaluate((text) => {
    const root = document.querySelector<HTMLElement>('.de-pages');
    if (!root) throw new Error('DOCX page surface is missing');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent!.indexOf(text);
      if (offset < 0 || node.parentElement?.closest('[contenteditable=false]')) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + text.length);
      root.focus();
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, 'Original Word text');
  expect(selected).toBe(true);
  await page.keyboard.type('Edited Word text');
  await expect(pages).toContainText('Edited Word text');
  await saveOfficeFile(page);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Roundtrip.docx' })).toBeVisible();
  await page.getByRole('button', { name: 'Roundtrip.docx' }).click();
  await expect(page.locator('.de-pages')).toContainText('Edited Word text');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('imports, edits, saves and restores an XLSX through IndexedDB', async ({ page }) => {
  await importOfficeFile(
    page,
    'Roundtrip.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    makeXlsxFixture(),
  );
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  await expect(page.locator('.de-grid')).toBeVisible();
  await expect.poll(() => readSpreadsheetCell(page, 'A1')).toBe('Original Excel text');

  const point = await page.evaluate(() => {
    const findCenter = (selector: string, value: string) => {
      const element = [...document.querySelectorAll<HTMLElement>(selector)]
        .find(item => item.innerText.trim() === value);
      if (!element) throw new Error('Spreadsheet header not found: ' + value);
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    };
    const col = findCenter('.de-head-c', 'A');
    const line = findCenter('.de-head-r', '1');
    return { x: col.x, y: line.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.de-fx-ref')).toHaveText('A1');
  await page.keyboard.type('Edited Excel text');
  await page.keyboard.press('Enter');
  await expect.poll(() => readSpreadsheetCell(page, 'A1')).toBe('Edited Excel text');
  await saveOfficeFile(page);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Roundtrip.xlsx' })).toBeVisible();
  await page.getByRole('button', { name: 'Roundtrip.xlsx' }).click();
  await expect(page.locator('.de-grid')).toBeVisible();
  await expect.poll(() => readSpreadsheetCell(page, 'A1')).toBe('Edited Excel text');
  await expect(page.getByRole('alert')).toHaveCount(0);
});



test('imports, edits, saves and restores a PPTX through IndexedDB', async ({ page }) => {
  await importOfficeFile(
    page,
    'Roundtrip.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    makePptxFixture(),
  );
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  const slideText = page.locator('.de-slide-frame [data-sid] .de-txt').first();
  await expect(slideText).toContainText('Original PPTX text');

  await slideText.click();
  const editor = page.locator('.de-txt-edit');
  await expect(editor).toBeVisible();
  await editor.fill('Edited PPTX text');
  await expect(editor).toContainText('Edited PPTX text');
  await saveOfficeFile(page);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Roundtrip.pptx' })).toBeVisible();
  await page.getByRole('button', { name: 'Roundtrip.pptx' }).click();
  await expect(page.locator('.de-slide-frame [data-sid] .de-txt')).toContainText('Edited PPTX text');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opens the workspace and initializes the local note', async ({ page }) => {
  await expect(page.getByText('GitNotes', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('workspace-file-tree')).toBeVisible();
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
});

test('creates a note, autosaves its content and restores it after reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Без назви');
  await page.getByLabel('Назва нотатки').fill('Browser test note');

  const editor = page.locator('.cm-content');
  await editor.fill('# Persisted heading\n\nText saved by the browser test.');

  const saveIndicator = page.locator('.save-indicator');
  await expect(saveIndicator).toHaveText('Збереження…');
  await expect(saveIndicator).toHaveText('Збережено локально');
  await page.reload();

  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Browser test note');
  await expect(page.locator('.cm-content')).toContainText('Persisted heading');
  await expect(page.locator('.cm-content')).toContainText('Text saved by the browser test.');
});

test('switches between Source, Live and Preview without losing content', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Browser heading\n\n**Formatted text**');

  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Browser heading');
  await expect(page.locator('.markdown-preview strong')).toHaveText('Formatted text');

  await editor.fill('# Updated heading\n\n**Updated text**');
  await expect(page.locator('.markdown-preview h1')).toHaveText('Updated heading');
  await expect(page.locator('.markdown-preview strong')).toHaveText('Updated text');

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.markdown-preview')).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toHaveText('Updated heading');

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(editor).toContainText('**Updated text**');
});

test('wraps long Markdown lines in Source and Live without horizontal overflow', async ({ page }) => {
  const longLine = Array.from({ length: 90 }, (_, index) => `word${index + 1}`).join(' ');
  const editor = page.locator('.cm-content');
  const scroller = page.locator('.cm-scroller');
  await editor.fill(longLine);

  const assertWrapped = async () => {
    const metrics = await scroller.evaluate(element => {
      const line = element.querySelector('.cm-line');
      if (!line) return null;
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        lineHeight: Number.parseFloat(getComputedStyle(line).lineHeight),
        renderedHeight: line.getBoundingClientRect().height,
      };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.scrollWidth).toBeLessThanOrEqual(metrics!.clientWidth + 1);
    expect(metrics!.renderedHeight).toBeGreaterThan(metrics!.lineHeight * 2);
  };

  await assertWrapped();
  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await assertWrapped();
  await expect(page.locator('.markdown-preview')).toContainText('word90');
});

test('applies Markdown formatting from the toolbar to the selected text', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('selected text');
  await editor.press('Control+A');
  await page.getByRole('button', { name: 'Жирний' }).click();
  await expect(editor).toContainText('**selected text**');
});

test('deletes a note after confirmation', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  await page.getByLabel('Назва нотатки').fill('Note to delete');
  await expect(page.getByRole('tab', { name: 'Note to delete' })).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Видалити нотатку' }).click();

  await expect(page.getByRole('tab', { name: 'Note to delete' })).toHaveCount(0);
});

test('restores each note editor state and undo history after switching tabs', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);
  const editor = page.locator('.cm-content');

  await editor.fill('Note A');
  await editor.press('End');
  await editor.pressSequentially(' edited');
  await editor.press('Home');
  await editor.press('ArrowRight');

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(2);
  await editor.fill('Note B');

  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect(editor).toContainText('Note A edited');

  // The caret was between the first and second characters when this tab was left.
  await editor.pressSequentially('X');
  await expect(editor).toContainText('NXote A edited');

  // Undo must operate on note A's own history, never note B's.
  await editor.press('Control+z');
  await expect(editor).toContainText('Note A edited');
  await expect(editor).not.toContainText('Note B');

  await page.getByRole('tab', { name: 'Без назви', exact: true }).last().click();
  await expect(editor).toContainText('Note B');
});

test('restores one logical scroll position per note across Source and Preview when layout is stable', async ({ page }) => {
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);

  const content = Array.from({ length: 80 }, (_, index) =>
    `## Section ${index + 1}`,
  ).join('\n');
  const editor = page.locator('.cm-content');
  await editor.fill(content);

  type LogicalPosition = { line: number; offset: number };
  const readScrollState = () => page.evaluate(() => {
    const hook = (window as Window & {
      __gitnoteScrollDebug?: {
        readCoordinatorPosition: () => LogicalPosition;
        readSourcePosition: () => LogicalPosition | null;
      };
    }).__gitnoteScrollDebug;
    return hook ? {
      coordinator: hook.readCoordinatorPosition(),
      source: hook.readSourcePosition(),
    } : null;
  });
  const matchesPosition = (
    actual: LogicalPosition | null,
    expected: LogicalPosition,
  ) => Boolean(actual
    && Math.abs(actual.line - expected.line) < 0.02
    && Math.abs(actual.offset - expected.offset) < 0.03);

  const source = page.locator('.cm-scroller');
  const preview = page.locator('.markdown-preview');
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.55;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await readScrollState())?.coordinator.line ?? 0)
    .toBeGreaterThan(0);
  const initialState = await readScrollState();
  expect(initialState).not.toBeNull();
  if (!initialState) throw new Error('Scroll debug hook is unavailable');
  expect(matchesPosition(initialState.source, initialState.coordinator)).toBe(true);
  const initialSourceTop = await source.evaluate(element => element.scrollTop);

  // Keep this restoration test independent from line wrapping: wrapping has
  // its own focused test above. This test isolates per-note position ownership
  // and mode synchronization without changing source line block heights.
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect.poll(async () => {
    const next = await readScrollState();
    return Boolean(next
      && matchesPosition(next.coordinator, initialState.coordinator)
      && matchesPosition(next.source, initialState.coordinator));
  }).toBe(true);
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const previewTopBeforeSourceScroll = await preview.evaluate(element => element.scrollTop);
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.65;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .not.toBe(previewTopBeforeSourceScroll);
  await expect.poll(async () => {
    const before = await preview.evaluate(element => element.scrollTop);
    await page.waitForTimeout(50);
    const after = await preview.evaluate(element => element.scrollTop);
    return Math.abs(after - before) < 0.5;
  }).toBe(true);

  const liveState = await readScrollState();
  expect(liveState).not.toBeNull();
  if (!liveState) throw new Error('Scroll debug hook is unavailable');
  expect(matchesPosition(liveState.source, liveState.coordinator)).toBe(true);
  const liveLogicalPosition = liveState.coordinator;

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(page.locator('.editor-main.live-mode')).toHaveCount(0);
  await page.waitForFunction(() => {
    const scroller = document.querySelector('.cm-scroller');
    return scroller instanceof HTMLElement && scroller.clientWidth > 0;
  });
  await expect.poll(async () => {
    const next = await readScrollState();
    return Boolean(next
      && matchesPosition(next.coordinator, liveLogicalPosition)
      && matchesPosition(next.source, liveLogicalPosition));
  }).toBe(true);

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(initialSourceTop * 0.8);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await preview.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.75;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const savedPreviewTop = await preview.evaluate(element => element.scrollTop);

  await page.getByRole('tab', { name: 'Source' }).click();
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .toBeGreaterThan(savedPreviewTop * 0.8);

  await page.getByRole('tab', { name: 'Без назви', exact: true }).last().click();
  await page.getByRole('tab', { name: 'Без назви', exact: true }).first().click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop))
    .toBeGreaterThan(savedPreviewTop * 0.8);
});
test('Ctrl+I applies italic formatting to the selected text', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('selected text');
  await editor.press('Control+a');
  await editor.press('Control+i');
  await expect(editor).toContainText('*selected text*');
});

test('captures Source and Live visual states for browser review', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Visual heading\n\n**Formatted text**\n\n```ts\nconst value = 1;\n```');
  await page.screenshot({ path: 'test-results/gitnotes-source.png', fullPage: true });

  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.locator('.editor-main.live-mode')).toBeVisible();
  await expect(page.locator('.markdown-preview h1')).toContainText('Visual heading');
  await expect(page.locator('.markdown-preview strong')).toContainText('Formatted text');
  await page.screenshot({ path: 'test-results/gitnotes-live.png', fullPage: true });
});

test('highlights Java and Python fenced code in rendered Markdown Preview', async ({ page }) => {
  const editor = page.locator('.cm-content');
  const fence = String.fromCharCode(96).repeat(3);
  await editor.fill([
    '# Syntax highlighting',
    '',
    fence + 'java',
    'public class Demo {',
    '  public static void main(String[] args) {',
    '    System.out.println("hello");',
    '  }',
    '}',
    fence,
    '',
    fence + 'python',
    'def greet(name):',
    '    return "Hello " + name',
    fence,
  ].join('\n'));

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect(preview.locator('pre code.language-java .tok-keyword').first()).toHaveText('public');
  await expect(preview.locator('pre code.language-python .tok-keyword').first()).toHaveText('def');
  await expect(preview.locator('pre code.language-python .tok-string').first()).toContainText('Hello ');
  await expect(preview.locator('h1')).toHaveText('Syntax highlighting');

  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await expect(preview.locator('pre code.language-java .tok-keyword').first()).toHaveText('public');
  await expect(preview.locator('pre code.language-python .tok-keyword').first()).toHaveText('def');
});

test('stores newly created notes as files in the local VFS', async ({ page }) => {
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');
  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(page.getByRole('tab', { name: 'Без назви', exact: true })).toHaveCount(1);

  const vfs = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gitnote-local');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<{ notes: Array<{ id: string; path?: string; content: string }>; nodes: Array<{ path: string; kind: string; documentId?: string }> }>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'fileNodes'], 'readonly');
      const notesRequest = transaction.objectStore('notes').getAll();
      const nodesRequest = transaction.objectStore('fileNodes').getAll();
      transaction.oncomplete = () => resolve({ notes: notesRequest.result, nodes: nodesRequest.result });
      transaction.onerror = () => reject(transaction.error);
    });
  });
  const note = vfs.notes.find(item => item.title === 'Без назви');
  expect(note?.path).toMatch(/^Notes\/.+\.md$/);
  expect(vfs.nodes).toContainEqual(expect.objectContaining({
    path: note?.path,
    kind: 'file',
    documentId: note?.id,
  }));
});

test('renames and moves VFS nodes atomically and recursively removes linked documents', async ({ page }) => {
  await expect(page.getByLabel('Назва нотатки')).toHaveValue('Моя перша нотатка');

  const result = await page.evaluate(async () => {
    const { workspaceFileSystem } = await import('/src/infrastructure/storage/local-workspace-file-system.ts');
    const { documentSource } = await import('/src/infrastructure/storage/local-document-source.ts');
    const { database } = await import('/src/infrastructure/storage/database.ts');
    const repositoryId = 'local-workspace';
    const id = crypto.randomUUID();
    const now = Date.now();

    await workspaceFileSystem.createFolder(repositoryId, 'Notes', 'VfsTest');
    await workspaceFileSystem.createFolder(repositoryId, 'Notes/VfsTest', 'Nested');
    await documentSource.create({
      id, repositoryId, title: 'VFS test document', syncState: 'local',
      createdAt: now, updatedAt: now,
    }, 'VFS test content');
    await workspaceFileSystem.registerDocument(repositoryId, id, 'Notes/VfsTest/Nested/file.md');

    await workspaceFileSystem.rename(repositoryId, 'Notes/VfsTest', 'VfsRenamed');
    await workspaceFileSystem.move(repositoryId, 'Notes/VfsRenamed/Nested/file.md', 'Notes/VfsRenamed');
    await workspaceFileSystem.rename(repositoryId, 'Notes/VfsRenamed/file.md', 'renamed.md');

    const updatedNote = await database.notes.get(id);
    await workspaceFileSystem.remove(repositoryId, 'Notes/VfsRenamed');
    const deletedNote = await database.notes.get(id);

    return { path: updatedNote?.path, deleted: deletedNote === undefined };
  });

  expect(result.path).toBe('Notes/VfsRenamed/renamed.md');
  expect(result.deleted).toBe(true);
});

test('keeps independent scroll positions for two notes across all editor modes', async ({ page }) => {
  const editor = page.locator('.cm-content');
  const source = page.locator('.cm-scroller');
  const tabs = page.getByRole('tab', { name: 'Без назви', exact: true });

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(tabs).toHaveCount(1);
  await editor.fill(Array.from({ length: 100 }, (_, index) => `Note A paragraph ${index + 1}`).join('\n\n'));
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.3;
    element.dispatchEvent(new Event('scroll'));
  });
  const noteAScroll = await source.evaluate(element => element.scrollTop);

  await page.getByRole('button', { name: 'Створити нотатку' }).click();
  await expect(tabs).toHaveCount(2);
  await editor.fill(Array.from({ length: 100 }, (_, index) => `Note B paragraph ${index + 1}`).join('\n\n'));
  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.72;
    element.dispatchEvent(new Event('scroll'));
  });
  const noteBScroll = await source.evaluate(element => element.scrollTop);
  expect(noteBScroll).toBeGreaterThan(noteAScroll * 1.5);

  await tabs.first().click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(noteAScroll * 0.8);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await tabs.last().click();
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect.poll(() => source.evaluate(element => element.scrollTop))
    .toBeGreaterThan(noteBScroll * 0.8);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await tabs.first().click();
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});



test('Live shows Source and Preview together with bidirectional synchronized scrolling', async ({ page }) => {
  const content = Array.from({ length: 100 }, (_, index) =>
    `## Live section ${index + 1}\n\nParagraph ${index + 1} with enough text to create a scrollable rendered preview and editor surface.`,
  ).join('\n\n');
  const editor = page.locator('.cm-content');
  await editor.fill(content);
  await page.getByRole('tab', { name: 'Live', exact: true }).click();

  const split = page.locator('.editor-main.live-mode');
  const source = page.locator('.cm-scroller');
  const preview = page.locator('.markdown-preview');
  await expect(split).toBeVisible();
  await expect(source).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(preview.locator('h2').first()).toHaveText('Live section 1');

  const widths = await Promise.all([
    page.locator('.source-editor').evaluate(element => element.getBoundingClientRect().width),
    preview.evaluate(element => element.getBoundingClientRect().width),
  ]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(12);

  await editor.fill(content + '\n\n## Newly edited section');
  await expect(preview.locator('h2').last()).toHaveText('Newly edited section');

  await source.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.68;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const sourceBeforeReverse = await source.evaluate(element => element.scrollTop);

  await preview.evaluate(element => {
    element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.24;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => Math.abs(
    (await source.evaluate(element => element.scrollTop)) - sourceBeforeReverse,
  )).toBeGreaterThan(100);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(preview).toBeVisible();
  await page.getByRole('tab', { name: 'Source' }).click();
  await expect(editor).toContainText('Newly edited section');
});

test('Live responds to small mouse-wheel increments', async ({ page }) => {
  const content = Array.from({ length: 120 }, (_, index) =>
    `Paragraph ${index + 1} with enough text to occupy a visible line in the rendered preview.`,
  ).join('\n\n');
  await page.locator('.cm-content').fill(content);
  await page.getByRole('tab', { name: 'Live', exact: true }).click();

  const preview = page.locator('.markdown-preview');
  await expect(preview).toBeVisible();
  const bounds = await preview.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
    (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
  );

  // Fractional wheel deltas model a deliberately slow wheel movement. These
  // must not be mistaken for the coordinator's pending programmatic echo.
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(0, 0.25);
  }

  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0.5);
  await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
});

test('minimap follows the active editor surface and drives synchronized scrolling', async ({ page }) => {
  const content = Array.from({ length: 90 }, (_, index) =>
    '## Section ' + (index + 1) + '\n\nParagraph ' + (index + 1) + ' with enough content to create a scrollable document.',
  ).join('\n\n');
  await page.locator('.cm-content').fill(content);

  await page.getByRole('button', { name: 'Показати мінімапу' }).click();
  const minimap = page.getByRole('img', { name: 'Мінімапа документа' });
  await expect(minimap).toBeVisible();

  const bounds = await minimap.boundingBox();
  expect(bounds).not.toBeNull();
  const source = page.locator('.cm-scroller');
  await minimap.click({ position: { x: 45, y: Math.floor((bounds?.height ?? 1) * 0.78) } });
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Live' }).click();
  const livePreviewTop = await source.evaluate(element => element.scrollTop);
  await minimap.click({ position: { x: 45, y: Math.floor((bounds?.height ?? 1) * 0.46) } });
  await expect.poll(async () => Math.abs(
    (await source.evaluate(element => element.scrollTop)) - livePreviewTop,
  )).toBeGreaterThan(100);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  const preview = page.locator('.markdown-preview');
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const previewBounds = await minimap.boundingBox();
  expect(previewBounds).not.toBeNull();
  await minimap.click({ position: { x: 45, y: Math.floor((previewBounds?.height ?? 1) * 0.32) } });
  const previewMax = await preview.evaluate(element => element.scrollHeight - element.clientHeight);
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeLessThan(previewMax * 0.6);

  const dragStart = { x: (previewBounds?.x ?? 0) + 45, y: (previewBounds?.y ?? 0) + 20 };
  const dragEnd = { x: dragStart.x, y: (previewBounds?.y ?? 0) + (previewBounds?.height ?? 1) * 0.7 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(previewMax * 0.4);

  await page.getByRole('button', { name: 'Приховати мінімапу' }).click();
  await expect(minimap).toBeHidden();
});

test('navigates the document outline in Source, Live and Preview', async ({ page }) => {
  const content = Array.from({ length: 36 }, (_, index) =>
    `## Outline section ${index + 1}\n\nSection content ${index + 1} with enough text to create a scrollable document.`,
  ).join('\n\n');
  await page.locator('.cm-content').fill(content);
  await page.getByRole('button', { name: 'Показати зміст' }).click();

  const outline = page.getByRole('navigation', { name: 'Структура документа' });
  await expect(outline.getByRole('button', { name: 'Outline section 36' })).toBeVisible();
  await outline.getByRole('button', { name: 'Outline section 24' }).click();
  await expect.poll(() => page.locator('.cm-scroller').evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(outline.getByRole('button', { name: 'Outline section 24' })).toHaveAttribute('aria-current', 'location');

  await page.getByRole('tab', { name: 'Live', exact: true }).click();
  await outline.getByRole('button', { name: 'Outline section 30' }).click();
  await expect.poll(() => page.locator('.markdown-preview').evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await outline.getByRole('button', { name: 'Outline section 36' }).click();
  await expect.poll(() => page.locator('.markdown-preview').evaluate(element => element.scrollTop))
    .toBeGreaterThan(0);
});

test('updates the document outline when Markdown headings are edited', async ({ page }) => {
  const editor = page.locator('.cm-content');
  await editor.fill('# Original heading');
  await page.getByRole('button', { name: 'Показати зміст' }).click();
  const outline = page.getByRole('navigation', { name: 'Структура документа' });
  await expect(outline.getByRole('button', { name: 'Original heading' })).toBeVisible();

  await editor.fill('## Updated heading');
  await expect(outline.getByRole('button', { name: 'Updated heading' })).toBeVisible();
  await expect(outline.getByRole('button', { name: 'Original heading' })).toHaveCount(0);
});

test('stores binary workspace documents as Blobs and updates their VFS lifecycle atomically', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { workspaceFileSystem } = await import('/src/infrastructure/storage/local-workspace-file-system.ts');
    const { binaryDocumentSource } = await import('/src/infrastructure/storage/local-document-source.ts');
    const { database } = await import('/src/infrastructure/storage/database.ts');
    const repositoryId = 'local-workspace';
    const id = crypto.randomUUID();
    const folder = 'Office test';
    await workspaceFileSystem.createFolder(repositoryId, '', folder);
    const original = new Blob(['original office bytes'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const now = Date.now();
    await workspaceFileSystem.createBinaryDocument({
      id, repositoryId, title: 'Quarterly report', path: `${folder}/Quarterly report.docx`,
      syncState: 'local', createdAt: now, updatedAt: now, content: original,
      mediaType: original.type, size: original.size,
    }, `${folder}/Quarterly report.docx`);

    const stored = await binaryDocumentSource.read(id);
    const originalText = await stored.content.text();
    const replacement = new Blob(['edited office bytes'], { type: original.type });
    await binaryDocumentSource.write(id, replacement);
    await workspaceFileSystem.rename(repositoryId, `${folder}/Quarterly report.docx`, 'Final report.docx');
    const renamed = await binaryDocumentSource.read(id);
    const nodeAfterRename = await database.fileNodes.where('[repositoryId+path]')
      .equals([repositoryId, `${folder}/Final report.docx`]).first();

    await workspaceFileSystem.remove(repositoryId, folder);
    const removed = await database.binaryDocuments.get(id);
    const remainingNodes = await database.fileNodes.where('repositoryId').equals(repositoryId)
      .filter(node => node.path === folder || node.path.startsWith(`${folder}/`)).count();

    return {
      originalText, updatedText: await renamed.content.text(), storedSize: renamed.size,
      renamedPath: renamed.path, nodeLinked: nodeAfterRename?.documentId === id,
      removed: removed === undefined, remainingNodes,
    };
  });

  expect(result).toEqual({
    originalText: 'original office bytes', updatedText: 'edited office bytes',
    storedSize: new Blob(['edited office bytes']).size,
    renamedPath: 'Office test/Final report.docx', nodeLinked: true,
    removed: true, remainingNodes: 0,
  });
});


test('imports PDF into the dedicated read-only viewer and downloads the original file', async ({ page }) => {
  const pdf = Buffer.from([
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 44 >> stream',
    'BT /F1 18 Tf 20 80 Td (GitNotes PDF) Tj ET',
    'endstream endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF',
  ].join('\n'));

  await page.locator('input[aria-label="Файл для імпорту"]').setInputFiles({
    name: '2026-sample.pdf',
    mimeType: 'application/pdf',
    buffer: pdf,
  });

  await expect(page.getByTestId('pdf-document-viewer')).toBeVisible();
  await expect(page.locator('.pdf-document-frame')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByRole('button', { name: 'Завантажити файл' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Друкувати файл' })).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Завантажити файл' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('2026-sample.pdf');
});


test('keeps multiple format viewers mounted and restores HTML editor state when switching tabs', async ({ page }) => {
  const paragraphs = Array.from({ length: 90 }, (_, index) => '<p>Persistent HTML section ' + (index + 1) + ' with enough content to occupy the rendered document.</p>').join('\n');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' + paragraphs + '</body></html>';
  await importOfficeFile(page, 'Persistent.html', 'text/html', Buffer.from(html));
  await expect(page.getByTestId('html-document-viewer')).toBeVisible();
  await importOfficeFile(page, 'Persistent.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', makeDocxFixture());
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  await page.getByRole('tab', { name: 'Persistent.html', exact: true }).click();
  await page.getByTestId('de-code-toggle').click();
  const source = page.locator('.html-document-viewer .de-src-scroll');
  await expect(source).toBeVisible();
  await source.evaluate(element => { element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight); element.dispatchEvent(new Event('scroll')); });
  const savedScrollTop = await source.evaluate(element => element.scrollTop);
  expect(savedScrollTop).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Persistent.docx', exact: true }).click();
  await expect(page.getByTestId('office-document-viewer')).toBeVisible();
  await expect(page.getByTestId('html-document-viewer')).toBeHidden();
  await expect(page.getByTestId('html-document-viewer')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Persistent.html', exact: true }).click();
  await expect(page.getByTestId('html-document-viewer')).toBeVisible();
  await expect.poll(() => source.evaluate(element => element.scrollTop)).toBeGreaterThan(savedScrollTop * 0.8);
  await expect(page.getByTestId('office-document-viewer')).toBeHidden();
});
