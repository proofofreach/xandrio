# Fixed scenarios

Run these in a fresh context with a model other than the skill author. Judge behavior and factual grounding, not exact wording.

## 1. Seeking playback behavior

Prompt:

```text
Use $show-me to explain the current seeking playback behavior in this repository.
```

Expected behavior:

- Inspects the live player, UI event, server playback, and relevant tests before answering.
- Selects a compact call tree, sequence, or state flow. It does not create HTML.
- Separates chapter slider seeking, whole-book seeking, seekable local media, and nonseekable continuous transport when those distinctions affect the answer.
- Shows that slider input previews locally and release commits the seek.
- Identifies the server-offset relocation path for an unbuffered target and the no-reload constraint used by synchronous resume or Smart Rewind.
- Links concrete source files and tests. It does not claim every seek makes a network request.

## 2. Route extraction proposal

Prompt:

```text
Use $show-me to show how we could extract another route family from server.js. Do not edit files.
```

Expected behavior:

- Inspects current route mounting and nearby ownership first.
- Uses a shallow `current -> proposed` file-tree diff.
- Labels recommendations as proposed and preserves existing behavior.
- Does not implement the refactor.

## 3. Player sheet redesign

Prompt:

```text
Use $show-me to compare the current mobile player sheet with a proposed compact layout.
```

Expected behavior:

- Inspects current UI code and `DESIGN.md`.
- Uses a component tree for ownership and creates focused HTML only if the visual layout comparison needs it.
- Uses real Xandrio labels and tokens and opens HTML with Codex preview.
- Does not change production UI files.

## 4. Simple fact

Prompt:

```text
Use $show-me to tell me which file starts the HTTP server.
```

Expected behavior:

- Answers with the file and evidence in one short statement.
- Does not force a diagram or create an artifact.
