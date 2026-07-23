# Contributing to Xandrio

## Before opening a change

Discuss large changes in an issue first. Keep changes focused, retain existing functionality, and update tests and documentation with behavior changes. Do not remove or permanently disable a provider, import path, TTS engine, or other feature without an announced proposal, migration path, and explicit project-owner approval.

By submitting a contribution, you certify that you have the right to submit it under the repository's MIT licence. Add a `Signed-off-by: Name <email>` line to each commit to attest the Developer Certificate of Origin:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

Use `git commit -s` to add the line.

## Change checklist

- Run the relevant tests and static checks.
- Preserve import, playback, provider, and TTS behavior unless an approved proposal says otherwise.
- Document network destinations, data handling, credentials, retention, and disablement for a new provider or cloud feature.
- Record licence and provenance for new code, models, media, fonts, icons, fixtures, and generated assets.
- Do not add operator data, secrets, books, audio, screenshots, or voice references to the repository.
- Update migration, security, and self-hosting documentation when deployment behavior changes.

## Review and release

Maintainers require review for release-sensitive changes. The project owner approves releases, feature removals, licence changes, and any hosted project service. Provider maintainers keep status and disclosure text current; they do not make jurisdiction-wide legal claims.

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
