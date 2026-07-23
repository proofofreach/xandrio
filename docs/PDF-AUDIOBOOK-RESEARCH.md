# PDF-to-Audiobook Extraction Notes

Goal: make TTS spend time only on clean, human-ordered prose.

## Findings

- PDF text order is not inherently reading order. PyMuPDF documents this directly: extracted text may follow creator/content-stream order, not the visual order a reader expects. Coordinates and sorted blocks/words are the right raw material for better ordering.
- Poppler is already in the Docker image, so `pdftotext` is the lowest-risk production extractor. Use several modes and score the result instead of betting on one mode:
  - default: good general extraction
  - `-layout`: often better for preserving visual reading structure
  - `-raw`: useful when content-stream order is already correct
- `pdf-parse` remains useful as a pure Node fallback and metadata source, but it is not enough by itself for high-quality audiobook text.
- Image-only/scanned PDFs must be detected by low extracted characters per page and rejected or sent through OCR. Narrating a low-text extraction produces bad audiobooks.
- Chapter quality matters as much as extraction quality. Prefer real heading detection when it validates; otherwise group by page ranges into stable 18k-30k character sections so TTS chunks are listenable.
- OCR should be a separate future tier, not hidden inside normal extraction. It needs page rendering, OCR language selection, confidence scoring, and probably user-visible review because false repairs are audible.

## Current Implementation

- `lib/pdf-extraction.js` runs five extraction candidates: `pdf-parse`, Poppler default, Poppler `-layout`, Poppler `-raw`, and Poppler `-bbox-layout`.
- Candidates are normalized, chapterized, scored, and compared.
- Poppler page count from `pdfinfo` is included in candidate scoring so scanned/image-only PDFs can be detected even when text extractors return little or no page text.
- Header/footer normalization now removes `Page X of Y`, decorated page numbers, and repeated running headers with variable digits.
- Heading-like lines are preserved during PDF soft-line cleanup so `Chapter One` and similar titles do not get merged into body prose before chapter detection.
- Chapter detection now handles `Chapter One`, `Chapter Two: Title`, `Part`, `Book`, prologue, epilogue, preface, introduction, and afterword.
- Poppler `-bbox-layout` gives a coordinate-aware fallback that reconstructs page text from page/line/word boxes while still going through the same normalization and scoring pipeline.
- Extraction reports include `status`: `ready`, `review-needed`, `ocr-required`, or `failed`.
- Low text-per-page is penalized, and near-empty multi-page PDFs are rejected as `ocr-required` before TTS generation.
- When `XANDRIO_PDF_OCR=true`, `ocr-required` imports retry through OCRmyPDF/Tesseract and then re-enter the same candidate scoring, normalization, chaptering, and validation pipeline. OCR is disabled by default because it is CPU-heavy.
- `scripts/benchmark-pdf-extraction.js` can compare extraction modes, page density, status, and warnings before importing or regenerating audio.

## Sources

- PyMuPDF text extraction guide: https://pymupdf.readthedocs.io/en/latest/recipes-text.html
- PyMuPDF text extraction appendix: https://pymupdf.readthedocs.io/en/latest/app1.html
- PyMuPDF CLI extraction modes: https://pymupdf.readthedocs.io/en/latest/module.html
- pdf.js ordering issue discussion: https://github.com/mozilla/pdf.js/issues/17191
