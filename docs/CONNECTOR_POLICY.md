# Acquisition Connector Policy

This policy describes how Xandrio ships optional acquisition connectors. It is a project and product policy, not legal advice or a representation that a provider is lawful in any jurisdiction.

## Product boundaries

- Xandrio is self-hosted. Provider requests originate from the operator's server; the project does not relay requests, host user libraries, index user activity, or distribute imported files.
- Sources whose rights status is unverified are disabled on a new instance. First-run acknowledgement does not enable them. The operator must enable them separately and may exclude each source from searches.
- A connector being available or enabled is not a legal determination. Xandrio does not geolocate operators or claim that use is permitted because of country, ownership, accessibility needs, or personal-use intent.
- Xandrio does not supply project accounts, shared credentials, provider proxies, or mirrors. Credentials and sessions are supplied by and stored on the operator's instance.
- Xandrio does not include ebook DRM removal. Known DRM-protected Kindle imports are rejected. Browser fallbacks are disabled by default and do not solve interactive challenges or bypass authentication, paywalls, or ebook DRM. The Anna fallback changes automation fingerprints and requires a separate operator setting and a prior determination that the provider permits automated access.
- Imported books, provenance, and generated playback data remain local. Xandrio has no cross-user sharing, public catalog publishing, or audiobook publishing feature.

## Connector requirements

Every shipped connector must:

1. identify its provider on search results, download progress, stored provenance, and errors;
2. expose whether it is configured and enabled without returning credentials or session secrets;
3. allow its local configuration or session to be replaced and removed;
4. fail independently so one unavailable provider does not silently change the selected source;
5. enforce public-origin and download-safety controls before fetching content;
6. avoid logging credentials, session tokens, token-bearing URLs, or upstream response bodies that may contain them; and
7. document outbound data, local retention, disablement, and any unsupported browser or consumer endpoint.

## Release review

Before a release, maintainers must review connector code, UI copy, default settings, provider compatibility, and provider terms. Live tests use only an operator-owned account or key and must not download a work unless the tester has documented authority for that test. Counsel review remains a release gate for the target distribution jurisdictions.

Complaints about alleged infringement or a provider integration require a documented, provider-specific review. Maintainers may issue a compatibility or safety patch while that review is open. Permanent feature removal still follows the project's announced removal and owner-approval process.
