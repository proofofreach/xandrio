# Xandrio Product Notes

## Operating model

Xandrio is a self-hosted personal reading server. Each operator runs an independent instance and controls its books, providers, credentials, generated narration, cache, and retention. The project distributes software; it does not operate a book, catalog, credential, or TTS service.

## Audience

An operator who wants an iPhone-first PWA audiobook library from files they may use or from sources they choose and enable. The operator decides whether content access, narration, voice references, and retention are permitted in their circumstances.

## Feature inventory

- Direct EPUB, MOBI, AZW, AZW3, PRC, and PDF import.
- Provider search/import: Anna's Archive, Z-Library, Project Gutenberg, Internet Archive, Standard Ebooks, and operator-configured OPDS.
- Provider visibility: upload, reported rights metadata, unverified rights status, and operator-configured catalog labels.
- Edge narration, local Kokoro, local Chatterbox, saved voices, and operator-authorized voice references.
- Chunked audio generation and caching, resumable playback, seeking, speed, sleep timer, bookmarks, offline use, and sync state.
- Library management, source credential controls, provider health state, deletion, and cache management.

## Non-goals

- Hosted SaaS operation or a project-operated proxy.
- A claim that a source, work, or use is lawful worldwide.
- Social sharing, public catalog hosting, recommendation feeds, or audiobook publishing.
- Silent removal of providers, engines, import paths, or other existing features.

## Product boundaries

The first-run acknowledgement and provider enablement controls help the operator make deliberate choices; they do not confer rights or guarantee provider availability. Edge is an unofficial consumer-endpoint integration that sends narration text to Microsoft. Local engines process narration on the operator's configured host. See [LEGAL-NOTICE.md](LEGAL-NOTICE.md) and [docs/PRIVACY.md](docs/PRIVACY.md).
