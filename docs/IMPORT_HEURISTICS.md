# Import heuristic policy and inventory

This document is the control surface for import heuristics. The importer may
use generic evidence about a file. It must not contain a rule for a named book,
author, publisher, or provider record.

## User contract

- Import readable, narratable text automatically.
- Do not require a user to review an otherwise listenable import.
- Reject only verified invalid or unnarratable input: unsupported data, DRM,
  unreadable data, no narratable text, or proven destructive corruption.
- Treat uncertain chapter boundaries and low extraction scores as internal,
  typed diagnostics. They do not block import.
- Do not show an empty success warning such as “no specific warnings occurred.”
- Offer **Rebuild chapters** only when the retained source can reproduce the
  narration text. A rebuild preserves the current book if that proof fails.

## Change rule

A new heuristic is incomplete unless the same change:

1. defines a format-independent evidence class and a strict bound;
2. adds its text mutation to `ALLOWED_TEXT_MUTATIONS` when it changes text;
3. adds a synthetic, non-copyrighted characterization fixture;
4. records the fixture source checksum, normalized narration hash, chapter
   structure key, diagnostics, and import decision; and
5. proves the full committed corpus does not regress.

The corpus in `test/fixtures/import-corpus.js` is a ratchet. A baseline may
change only when the new result is intentionally better and the source fixture
still exercises a general evidence class.

## Decision heuristics

| Class | Evidence and bound | Effect | Characterization |
| --- | --- | --- | --- |
| Format dispatch | File extension and validated container/parser result | Selects EPUB, PDF, or Kindle extractor | `test-book-document.js` |
| Compatible acquisition fallback | Canonical work identity, language, format, and provider compatibility | May try another edition; never combines unrelated works | `test-book-importer.js`, `test-search-work-groups.js` |
| Candidate retention | Compatible candidates only; prefer more narratable text. An equally structured candidate may replace one with decode-loss markers only when it retains at least 99% of the text, has the same chapter-structure key, and removes all or at least 75% of those markers. | Chooses one extraction candidate without trading material text or structure for cosmetic cleanup | `test-import-corpus.js`, `test-book-importer.js`, `test-pdf-extraction.js`, `test-kindle-extraction.js` |
| Narration validity | Non-empty readable text and every planned TTS chunk within its engine limit | The only content gate after verified format/DRM failures; short works remain valid | `test-extraction-result.js`, `test-import-corpus.js` |
| Confidence diagnostics | Parser score, structure confidence, replacement characters, OCR indicators | Emits typed diagnostics; meaningful text remains importable | `test-extraction-result.js`, `test-import-corpus.js`, format extractor tests |
| Source recovery proof | Serialize the recovery data, re-extract it in a fresh call, and compare exact narration bytes and length | Original PDF may be removed only after exact recovery proof and a durable deletion intent; otherwise it is retained | `test-extraction-recovery.js`, `test-book-importer.js` |

## Text mutation registry

`lib/extraction-result.js` contains the closed registry. An extraction result
rejects an unregistered mutation code or an activation without a positive
count. PDF normalization emits measured activations from its diagnostic
counters. EPUB and Kindle mutation behavior is also characterized at the pure
transformation and extractor boundaries.

| Mutation code | Generic trigger | Maximum scope | Primary tests |
| --- | --- | --- | --- |
| `mutation.whitespace-normalization` | Line endings, source wrapping, repeated spaces, or punctuation spacing | Whitespace only | `test-pdf-extraction.js`, `test-chapter-utils.js` |
| `mutation.semantic-page-marker-removal` | A semantic EPUB page-break node or a line containing only a page number | The matched marker or line only | `test-chapter-utils.js`, `test-pdf-extraction.js` |
| `mutation.exact-duplicate-removal` | Exact duplicate navigation/content identity | One exact duplicate only | `test-epub-parser.js`, `test-chapter-utils.js` |
| `mutation.invisible-character-removal` | Soft-hyphen and zero-width Unicode format characters | Listed invisible code points only | `test-chapter-utils.js` |
| `mutation.recognized-boilerplate-removal` | Semantic cover/TOC/copyright/auxiliary spine evidence or a characterized boilerplate class | The matched non-narrative section only | `test-epub-parser.js`, `test-chapter-utils.js` |
| `mutation.line-wrap-dehyphenation` | A letter-hyphen-line-break-lowercase-letter sequence | The matched line break only | `test-pdf-extraction.js`, `test-chapter-utils.js` |
| `mutation.ligature-normalization` | One of the listed Unicode presentation ligatures | One code point at a time | `test-pdf-extraction.js` |
| `mutation.spaced-caps-normalization` | Three or more single capital letters separated by whitespace | The matched capital run only | `test-pdf-extraction.js`, `test-chapter-utils.js` |
| `mutation.repeated-header-footer-removal` | The same short edge line on at least three pages | Matched repeated edge lines only | `test-pdf-extraction.js` |
| `mutation.ocr-token-repair` | An allowlisted OCR token in a separately validated prose context | One allowlisted token at a time | `test-pdf-extraction.js` |

## Structure heuristics

| Class | Evidence and bound | Text preservation rule | Characterization |
| --- | --- | --- | --- |
| Authored navigation | EPUB TOC/spine, PDF outline/TOC, or Kindle TOC | Authored order wins when resolvable | `test-epub-parser.js`, format extractor tests |
| Heading recovery | Generic chapter/part/volume headings and layout evidence | Falls back to page groups or content, never rejection | `test-pdf-extraction.js`, `test-epub-parser.js` |
| Auxiliary spine filtering | Verified non-linear EPUB spine items and semantic auxiliary documents | Does not delete linear narrative content | `test-epub-parser.js` |
| Short divider merge | Short un-authored section adjacent to a substantive section | Moves its text forward; does not discard it | `test-epub-parser.js`, `test-chapter-utils.js` |
| Oversized section split | More than 100,000 characters without an authored boundary, or more than 150,000 with one | Splits at punctuation/word boundaries and conserves normalized narration | `test-import-corpus.js`, `test-chapter-utils.js` |
| Sequence/title repair | A complete generic numeric or Roman-numeral series with local structural evidence | Changes display metadata, not narration text | `test-chapter-utils.js`, `test-epub-parser.js` |
| Chapter rebuild | Retained source plus exact continuous normalized narration match | Commits only text-conserving boundary changes | `test-chapter-rebuild.js`, `test-chapter-transition-state.js` |

## Previous-versus-current release benchmark

Run `npm run benchmark:imports -- --candidate HEAD` before releasing an import-policy change. The command binds the comparison to the approved previous-system commit `b2873a24f7bd1c1ecc02c882abfb9321284d7bbd`, the committed candidate at `HEAD`, and exactly the five most recent private imports. It rejects a dirty worktree, a different baseline, an uncommitted candidate, or a different private-corpus size.

Both revisions run through `createBookImporter`, including rejection and compatible-candidate acquisition paths. Real synthetic EPUB/PDF/Kindle adapters feed that importer. A headless browser then performs clean, warning-bearing, and empty-warning successful imports against each revision and counts the post-success actions in the rendered UI. `npm run release:production` reruns the full suite, browser smoke, and this exact paired benchmark before publication can start.

The release gate requires:

- all expected import and rejection decisions to match;
- all required typed diagnostics and candidate selections to match;
- at least one previously rejected listenable class to improve;
- no import, narration, chapter-structure, or content-defect regression;
- exact normalized narration conservation for comparable cases;
- zero unexpected defects in synthetic and format output after accounting for
  defects deliberately present in a characterization source; and
- zero manual actions after either a clean or warning-bearing successful import.

Private results are opaque. The report contains no book metadata, paths, text,
or content hashes. Existing defects in an unrebuildable legacy artifact remain
visible in the aggregate but do not authorize a lossy repair or a title-specific
rule.

## Bounded old-versus-new confirmation

Use `npm run benchmark:imports:bakeoff -- --historical-manifest <path>` when a
small directional check is more useful than another broad release gate. The
private manifest must contain `{"schemaVersion":1,"paths":[...]}` with exactly
four distinct sources already present in the library. Choose sources that
represent known processing problems before running the comparison.

The command runs those four sources and four checksum-pinned, previously unused
public-domain holdouts through the approved previous system and the committed
candidate at `HEAD`. It compares import success, narration validity and length,
chapter structure, content defects, warnings, errors, and post-import user
actions. It fails on any regression or on any candidate that is not listenable.
The report uses opaque case IDs and excludes metadata, paths, text, content
hashes, and source digests.

This check does not add a review step to the product. Unchanged cases need no
manual inspection. Any narration or chapter-structure change stops automatic
confirmation. The report lists only changed case IDs so a developer can inspect
or listen to those outputs before deciding whether the change is an improvement.

## Safe chapter rebuild

Rebuild is a journaled per-book transaction. It backs up the XBook, records the
transition, updates book state, maps positions and bookmarks by character
offset, preserves the approximate flag when the player estimated that offset
from audio time, writes an explicit durable commit point, and then reconciles only
affected audio. Recovery rolls back before that commit point and rolls forward
after it. Only uniquely matching audio with a matching generation fingerprint
(text, voice/model, output settings, and chunking policy) is reusable. Duplicate
narration hashes are intentionally not reused.

The transition store keeps one previous structure version. A write from that
version is mapped forward. An older write is clamped to a valid chapter start
and marked approximate instead of being silently discarded.
