#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const output = resolve(process.argv[2] || 'release/import-fixture.epub');
const fixture = mkdtempSync(resolve(tmpdir(), 'xandrio-release-epub-'));
const metaInf = resolve(fixture, 'META-INF');
const oebps = resolve(fixture, 'OEBPS');

function chapter(title, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>
<h1>${title}</h1>${body}
</body></html>\n`;
}

try {
  mkdirSync(metaInf, { recursive: true });
  mkdirSync(oebps, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });

  writeFileSync(resolve(fixture, 'mimetype'), 'application/epub+zip');
  writeFileSync(resolve(metaInf, 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>\n`);
  writeFileSync(resolve(oebps, 'content.opf'), `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">xandrio-release-import</dc:identifier>
    <dc:title>Release import and narration fixture</dc:title>
    <dc:creator>Xandrio</dc:creator><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="toc"><itemref idref="chapter1"/><itemref idref="chapter2"/><itemref idref="chapter3"/></spine>
</package>\n`);
  writeFileSync(resolve(oebps, 'toc.ncx'), `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="xandrio-release-import"/></head>
  <docTitle><text>Release import and narration fixture</text></docTitle>
  <navMap>
    <navPoint id="chapter1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="chapter2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="chapter2.xhtml"/></navPoint>
    <navPoint id="chapter3" playOrder="3"><navLabel><text>Chapter Three</text></navLabel><content src="chapter3.xhtml"/></navPoint>
  </navMap>
</ncx>\n`);

  const narration = 'This is a short release verification chapter. Xandrio imports this EPUB through its public upload API, generates narration through the default speech engine, and serves playable audio with byte range support. The check runs inside each supported container architecture. It deliberately uses ordinary prose, complete sentences, and enough material to exercise extraction and speech without depending on a bundled copyrighted work. The resulting audio is decoded and requested again with a byte range, proving that the tested image supports the complete self-hosted import and listening path.';
  writeFileSync(resolve(oebps, 'chapter1.xhtml'), chapter('Chapter One', `<p>${narration}</p>`));

  const second = [];
  const third = [];
  for (let index = 1; index <= 260; index += 1) {
    second.push(`<p>Release fixture paragraph ${index} contains synthetic text used only to validate complete-book extraction. It records no user data and includes no third-party literary content. The sentences vary by paragraph number so the archive remains a realistic input for import validation.</p>`);
    third.push(`<p>Architecture fixture paragraph ${index} confirms that library metadata, chapter text, and navigation survive parsing in the release container. This synthetic material exists only during CI and is never included in the published source archive or image.</p>`);
  }
  writeFileSync(resolve(oebps, 'chapter2.xhtml'), chapter('Chapter Two', second.join('\n')));
  writeFileSync(resolve(oebps, 'chapter3.xhtml'), chapter('Chapter Three', third.join('\n')));

  // Keep the synthetic archive above the source-size sanity threshold without
  // making the narrated chapter longer or committing a binary fixture.
  writeFileSync(resolve(oebps, 'release-padding.bin'), randomBytes(16 * 1024));

  execFileSync('zip', ['-q', '-X0', output, 'mimetype'], { cwd: fixture });
  execFileSync('zip', ['-q', '-Xr9', output, 'META-INF', 'OEBPS'], { cwd: fixture });
  console.log(`Wrote ${output}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
