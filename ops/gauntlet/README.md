# Xandrio product Gauntlet

This directory holds the bounded mixed-grounding Monkey D Loopy contract. The LoopSpec combines fresh qualitative builders and critics with repository-owned executable gates. Model judgment never masquerades as oracle evidence.

## Prove the contract

```sh
npm run gauntlet:validate
npm run gauntlet:verify
npm run gauntlet:score
npm run gauntlet:compile
```

## Run a bounded wave

Compile first, then run from the repository root so agents inspect the real checkout:

```sh
export LOOPY_CLAUDE_CODE_BIN="$PWD/scripts/loopy-claude-router.mjs"
export LOOPY_AGENT_TIMEOUT_MS=2700000
npx loopc run ops/gauntlet/xandrio.loop.yaml \
  --out . \
  --inputs ops/gauntlet/inputs.json \
  --run-id xandrio-product-wave-01
npx loopc inspect . --run-id xandrio-product-wave-01 --tail 30
```

The checked-in `inputs.json` contains only public references and repository-relative paths. The router uses Sonnet for scoped builder passes and Opus for decomposition, criticism, integration, and the final gate. Each call is a fresh Claude Code process; the runtime records Claude's trusted token and cost envelope.

The executable judge writes raw command logs and its JSON receipt under ignored `logs/gauntlet/`. It updates the tracked progress page at `artifacts/gauntlet/progress.md`. Use `XANDRIO_GAUNTLET_PROFILE=fast` only for development of the contract; completion requires the default `core` profile.

Loopy caps one run at eight iterations, three repeated fingerprints, 300,000 tokens, $12, or four hours. A cap pauses at a breakpoint. Resume only after inspecting the journal and approving a fresh bounded window. Never convert this into an unbounded process.

The standalone compiler currently warns that its artifact exposure contract is soft-enforced. Treat `allowed-tools` and artifact globs as defense in depth, not as a filesystem sandbox. Every prompt therefore repeats the repository scope and prohibition on private data, publishing, deployment, commits, and pushes.
