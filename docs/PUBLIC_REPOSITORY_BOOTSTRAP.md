# Public repository bootstrap

The legacy private repository contains a non-rotatable historical credential.
Never change its visibility. The public repository must begin with the one-commit
root created by `npm run release:prepare-public-root` after all source gates pass.

## Before creating the remote

1. Complete `docs/ASSET_PROVENANCE.md` and `docs/RELEASE_APPROVALS.md` with dated evidence.
2. Configure working DNS and test delivery for the published security and conduct addresses.
3. Run `npm run release:prepare-public-root -- --output /absolute/path/outside-this-repository`.
4. Review the exported tree, the one-commit log, and the successful full-ref Gitleaks result.
5. Record the private source commit and sanitized root commit in the private release record.

The preparation command does not create or modify a GitHub repository.

Use a public repository name that is distinct from the legacy private remote.
`ProofOfReach/xandrio` is the recommended canonical name. Do not rename the
legacy repository and immediately reuse `ProofOfReach/alexandrio`: existing
private clones still point at that path and could accidentally push the secret-
bearing history into the new public repository. After the owner chooses the
public name, update package metadata, documentation, workflow image names, and
Umbrel references together before creating the release tag.

## Required GitHub controls

Configure these controls on the new public repository before pushing a release tag:

- Default branch: `main`.
- Default Actions token permissions: read-only; Actions cannot approve pull requests.
- Protect `main`, including administrators.
- Require the `verify` and `dependency-review` checks on an up-to-date branch.
- Require at least one approving review, CODEOWNER review, dismissal of stale approvals,
  and resolution of review conversations.
- Disable force pushes and branch deletion.
- Create a `release` environment with at least one required reviewer and prevent self-review.
- Keep GHCR private until the immutable candidate passes; make the package public only for
  the logged-out exact-digest pull gate.

Verify the resulting configuration with:

```sh
GH_TOKEN=... npm run check:public-repository -- --repo OWNER/REPOSITORY
```

The release workflow performs the same check and will not build a candidate in an
unprotected or private release repository.
