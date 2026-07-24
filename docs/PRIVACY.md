# Privacy and Data Flow

Xandrio runs on hardware chosen by its operator. The project does not operate a proxy, content store, account service, catalog, credential store, or TTS service for operators. Network behavior depends on the providers and engines the operator enables.

## Local storage and retention

`data/` holds library metadata, source configuration and credentials, settings, sync state, bookmarks, positions, custom-voice metadata, and provider sessions where applicable. `cache/` holds imported source files or extracted playback artifacts, covers, search covers, voice samples, and generated audio chunks. Browser storage can hold the PWA shell, downloaded offline material, playback settings, and local sync identifiers.

Generated narration is cached for reuse and offline playback. Xandrio has no social-sharing or audiobook-publishing feature. Deleting a book removes its tracked local artifacts; operators should also clear browser offline storage and delete backups when they want complete removal. Source-file retention varies by format and configuration: EPUBs remain as source files, while extracted MOBI, Kindle, and PDF source files may be deleted after Xandrio writes a playback artifact when `XBOOK_DELETE_SOURCE_AFTER_EXTRACT=true`.

## Outbound services

| Destination | Data sent | Purpose | Credential | Xandrio-controlled storage and retention | Disablement |
| --- | --- | --- | --- | --- | --- |
| Selected book provider | Search terms; download request and provider item identifiers; provider sees network metadata | Search and import | Provider-specific key, account, or none | Provider configuration/session data in `data/`; imported content and provenance in local storage | Exclude the provider or remove its configuration |
| Anna's Archive | Search terms and requested items; separately permitted fallback may load provider pages in Chromium | Search and import | Optional configured secret key | Key/configuration locally; imported content locally | Leave unconfigured, disable in provider controls, and leave `ANNAS_BROWSER_SEARCH_MODE` unset |
| Z-Library | Search terms; account/session traffic when connected | Search; downloads after connection | Account credentials at connection time; saved session tokens | Session/configuration locally; password is not retained after connection | Disconnect or exclude it |
| Project Gutenberg, Standard Ebooks, Internet Archive, OPDS | Search terms and requested item/download URLs | Search and import | Usually none; OPDS may be operator-configured | Search/cache/import data locally | Exclude or leave unconfigured |
| Open Library | Title, author, ISBN, or work/edition key | Metadata and cover enrichment | None | Returned metadata/covers cached locally | Do not refresh metadata; remove cached covers; network controls may disable the service |
| English Wikipedia search API | A query for which healthy selected providers returned no results | Bounded spelling-suggestion discovery before Open Library validation and one provider retry | None | Suggestion is used in the current response; Xandrio does not persist a query history | Block the endpoint at the host/network layer; the original empty result is preserved when unavailable |
| Cover URLs from provider results | Cover URL and network metadata | Display and cache cover art | Usually none | Cover cache in `cache/` | Disable the source or delete cached covers |
| Microsoft Edge TTS | Narration text and selected voice/settings | Cloud narration | No operator key for the current unofficial consumer-endpoint integration | Generated MP3 cache locally | Select a local engine or do not generate with Edge |
| Local Kokoro or Chatterbox host | Narration text; Chatterbox may receive a local voice reference | Local narration | Operator-configured local host | Audio cache and voice references locally | Select another engine, stop its host, or remove its configuration |

Provider terms, rate limits, availability, and rights metadata belong to the provider. A result marked as having rights metadata still requires operator review; a result with unverified status carries no rights conclusion.

## Voice references

Chatterbox voice references are local operator files. Use them only with authority and required consent. Delete the reference from `data/voice-references/`, its related settings, generated audio, and backups to remove it from storage under the operator's control.

## Operator controls

The first-run acknowledgement and provider controls are per instance. Operators can leave providers unconfigured, remove provider credentials, choose local narration, delete books and cached artifacts, clear browser site data, and manage their own backup retention. Xandrio cannot erase data retained by an external provider after a request has reached that provider.
