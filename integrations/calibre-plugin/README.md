# Xandrio for Calibre

This Calibre interface-action plugin sends selected books or an entire Calibre
library to a paired Xandrio server. It prefers EPUB, then AZW3, MOBI/PRC/AZW,
and PDF. Repeated sends use Calibre's library and book UUIDs, so unchanged books
are skipped and changed metadata is updated without duplicating the title.

Install the generated `Xandrio-Calibre.zip` through **Calibre → Preferences →
Plugins → Load plugin from file**. Do not extract the ZIP.
