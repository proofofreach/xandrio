# Governance

## Roles

The project owner sets release scope, approves releases, licence changes, feature removals, and any project-operated service. Maintainers review changes in their areas and may merge approved pull requests. Provider and TTS maintainers keep compatibility, disclosure, and failure-state documentation current.

## Merges and releases

Changes need passing required checks and maintainer review. Security, provider, TTS, packaging, legal, and release-workflow changes require review from the relevant code owner. Release authority remains with the project owner. Once public, the repository should protect the default branch, disallow force pushes and tag deletion, and restrict release-workflow changes.

The GitHub `release` environment must require project-owner approval. Release
tags must be signed and the evidence checklist in
`docs/RELEASE_APPROVALS.md` must be complete before the environment is approved.

Release images are immutable. The project does not rebuild an existing version tag in place. Dependabot and CI check dependencies each week. Maintainers review base-image and dependency updates at least monthly and publish a new patch release when an update changes the shipped image. A known critical vulnerability triggers an out-of-cycle review and either a patched release or a documented mitigation.

## Deprecation and removal

Xandrio does not silently remove or permanently disable existing functionality. A proposed removal must be announced publicly, explain the reason and affected operators, provide a migration or equivalent path where feasible, and receive explicit project-owner approval. Legal, licensing, security, or provider concerns create a review gate; they do not alone authorize removal.

## Provider maintenance

Provider integrations remain operator-controlled. Maintainers may document outages, revise status labels, require an acknowledgement, improve safety controls, or propose an equivalent path. They must not claim that a source or use is lawful or unlawful worldwide.
