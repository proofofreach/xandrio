# Codebase Cleanup Report
Date: 2026-02-05

## Summary
- **68 files** moved to `_archive/`
- **0 files** deleted (all preserved in archive)
- **5 dead functions** identified in active files (documented below, not removed)
- Root directory reduced from ~80 files to ~25 (including docs/, lib/, test/, public/)

## Files Archived

### Dead JavaScript (Root) — 16 files
| File | Reason |
|------|--------|
| `analyze_chapters.js` | Debug/analysis script, not used by server |
| `chapter_filter_patch.js` | One-time patch, not imported |
| `debug_parse.js` | Debug script |
| `fix-chapter-issues.js` | One-time fix script |
| `improved_chapter_filter.js` | Old patch file |
| `performance-profiler.js` | Debug profiling tool |
| `quick-performance-test.js` | Debug test |
| `server-refactored.js` | Old refactor attempt, unused |
| `server-relevance-fix.js` | Old server version |
| `startup.js` | Unused startup wrapper (systemd runs server.js directly) |
| `test-chunked.js` | Old test (replaced by test/test-chunked-tts.js) |
| `test-tts.js` | Old TTS test |
| `test-relevance.js` | Old relevance test |
| `test_improved_filter.js` | Old filter test |
| `test_updated_server.js` | Old server test |
| `verify_fix.js` | One-time verification script |

### Server Backups & Config — 4 files
| File | Reason |
|------|--------|
| `server.js.backup` | Old backup |
| `server.js.backup-20260204` | Dated backup |
| `package-updated.json` | Duplicate/old package.json |
| `bookvoice-refactored.service` | Unused systemd service (points to server-refactored.js) |

### Shell Scripts — 2 files
| File | Reason |
|------|--------|
| `test-click.sh` | Old click test script |
| `test-relevance-curl.sh` | Old curl test script |

### HTML Test Files — 1 file
| File | Reason |
|------|--------|
| `test-swipe.html` | Root-level test page |

### Runtime Artifacts — 1 file
| File | Reason |
|------|--------|
| `server.log` | Runtime log (should be in .gitignore) |

### Dead Public Files — 12 files
| File | Reason |
|------|--------|
| `public/app-refactored.js` | Old refactored UI, not loaded by index.html |
| `public/app-relevance-ui.js` | Old relevance UI, not loaded by index.html |
| `public/debug.html` | Debug test page |
| `public/final-test.html` | Test page |
| `public/index-refactored.html` | Old refactored HTML |
| `public/minimal-test.html` | Test page |
| `public/test.html` | Test page |
| `public/test-progress.html` | Test page |
| `public/verify-fix.html` | Test page |
| `public/style.css` | Old CSS (index.html uses style-v2.css) |
| `public/style-v1-backup.css` | Backup of old CSS |
| `public/icon.png.txt` | Text file alongside icon, not used |

### Dead Public JS Modules — 4 files
| File | Reason |
|------|--------|
| `public/js/player.js` | Not loaded by index.html or app.js |
| `public/js/state.js` | Not loaded by index.html or app.js |
| `public/js/ui.js` | Not loaded by index.html or app.js |
| `public/js/api.js` | Not loaded by index.html or app.js |

### Entire `src/` Directory — 10 files
| File | Reason |
|------|--------|
| `src/config/index.js` | server.js doesn't require anything from src/ |
| `src/middleware/errorHandler.js` | Not imported |
| `src/middleware/validation.js` | Not imported |
| `src/routes/bookRoutes.js` | Not imported |
| `src/routes/healthRoutes.js` | Not imported |
| `src/routes/searchRoutes.js` | Not imported |
| `src/services/audioService.js` | Not imported |
| `src/services/bookService.js` | Not imported |
| `src/services/searchService.js` | Not imported |
| `src/utils/logger.js` | Not imported |

### Old Markdown Documentation — 18 files
Moved to `_archive/docs-old/`. These were scattered in the root directory and have been superseded by the `docs/` directory:

| File | Topic |
|------|-------|
| `ANNA_ARCHIVE_FIX.md` | Anna's Archive integration fix |
| `API_DOCUMENTATION.md` | Old API docs (replaced by docs/API.md) |
| `audio-pregeneration-test.md` | Pregeneration test notes |
| `BOOK-COVER-FEATURE.md` | Cover feature implementation |
| `BUG_FIX_SUMMARY.md` | Bug fix log |
| `CHAPTER_FILTER_SOLUTION.md` | Chapter filter solution |
| `CLICK-FIX-SUMMARY.md` | Click handler fix |
| `COMPACT-LAYOUT-UPDATE.md` | Layout update notes |
| `DASHBOARD-IMPROVEMENTS.md` | Dashboard improvement notes |
| `IMPLEMENTATION_COMPLETE.md` | Implementation completion notes |
| `METADATA-FEATURE.md` | Metadata feature notes |
| `MIGRATION_GUIDE.md` | Migration guide |
| `REFACTORING_PLAN.md` | Refactoring plan |
| `REFACTORING_SUMMARY.md` | Refactoring summary |
| `RELEVANCE_SCORING.md` | Relevance scoring notes |
| `SSL-SETUP.md` | SSL setup guide |
| `SWIPE-DELETE-IMPLEMENTATION.md` | Swipe delete notes |
| `UI-UX-IMPROVEMENTS.md` | UI/UX improvement notes |

---

## Files Kept

### Core Application
| File | Purpose |
|------|---------|
| `server.js` | Main Express server (all routes, TTS, EPUB handling) |
| `lib/chunked-tts.js` | Chunked TTS engine |
| `lib/tts-queue.js` | TTS request queue manager |
| `public/index.html` | Main web UI |
| `public/app.js` | Frontend application logic |
| `public/js/chunk-player.js` | Chunked audio player |
| `public/style-v2.css` | Active stylesheet |

### Assets & Config
| File | Purpose |
|------|---------|
| `public/favicon.ico` | Browser favicon |
| `public/icon.png` | App icon/logo |
| `public/mkcert-ca.pem` | CA cert for HTTPS clients |
| `certs/localhost+3-key.pem` | HTTPS private key |
| `certs/localhost+3.pem` | HTTPS certificate |
| `.env.template` | Environment variable template |
| `.gitignore` | Git ignore rules |
| `package.json` | NPM package definition |
| `package-lock.json` | NPM dependency lock |
| `bookvoice.service` | Active systemd service file |

### Tests (New Modules)
| File | Purpose |
|------|---------|
| `test/test-chunked-tts.js` | Tests for chunked TTS |
| `test/test-queue.js` | Tests for TTS queue |
| `test/test-hobbit.js` | Integration test (Hobbit playback) |
| `test/test-suite.js` | Full API test suite |

### Documentation
| File | Purpose |
|------|---------|
| `README.md` | Project readme |
| `docs/API.md` | API documentation |
| `docs/ARCHITECTURE.md` | Architecture overview |
| `docs/CHANGELOG.md` | Change log |
| `docs/PRD.md` | Product requirements document |

### Runtime Directories (not in repo)
| Directory | Purpose |
|-----------|---------|
| `data/` | books.json, positions.json |
| `cache/` | Generated audio files |

---

## Dead Code in Active Files

### server.js
| Function | Line | Issue |
|----------|------|-------|
| `selectBestResult(results)` | 1055 | Defined but never called. Selects best result from array — logic may have been inlined or replaced. |
| `shouldFilterChapter(chapter)` | 1171 | Defined but never called. Chapter filtering logic — may have been superseded by `analyzeChapterContent()`. |
| `generateAudio(text, outputPath, language)` | 1531 | Defined but never called. Standalone TTS generation — replaced by ChunkedTTS/TTSQueue system. |

### public/app.js
| Function | Line | Issue |
|----------|------|-------|
| `preloadNextChapter()` | 305 | Defined but never called. Preloading logic — may have been replaced by chunk-player.js. |
| `getQualityDescription(score, format)` | 490 | Defined but never called. Quality description helper — unused in UI. |

> **Note:** These dead functions were documented only — no active files were modified per cleanup rules.
