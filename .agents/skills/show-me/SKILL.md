---
name: show-me
description: Explain a project behavior, architecture, proposed change, or UI state with the smallest evidence-backed visual that makes it clear. Use when the user asks to "show me", invokes /show-me or $show-me, or needs to understand a flow involving several components, states, or dependent steps. Skip it for simple facts that prose or one code excerpt explains better.
---

# Show me

Make the current topic easy to inspect. Keep prose brief and place each visual next to the statement it supports.

## Ground the view

Inspect the relevant implementation, tests, configuration, and documentation before drawing. Start at the named action or entry point, follow its direct calls, then inspect the tests for the non-obvious branches. Do not begin with a content search over the repository root. Scope searches to likely entry files or feature directories, then narrow further after finding the entry point. Stop when every node and branch in the visual has evidence.

Include only relationships supported by that evidence. Link named files to exact project paths and add line numbers when they help verification.

Label the view as `current`, `proposed`, or `current -> proposed`. Never mix observed behavior with a recommendation.

If an important branch is uncertain, mark it as unknown and say what evidence is missing. Do not make the diagram look more certain than the code.

## Pick the smallest useful form

- Use pseudocode for local logic or an algorithm.
- Use a call tree for runtime ownership and nested calls.
- Use a component tree for UI ownership, state, and module boundaries.
- Use a shallow file tree for module responsibilities or a broad refactor.
- Use Mermaid for interaction, state, or data flow across several components.
- Use a `diff` block when the surrounding structure exists and the point is what changes.
- Show a full code block only when most of it is new or omitted context would hide ownership or order.

Use one form when one is enough. Remove calls, props, states, and files that do not affect the question.

Before finalizing, identify implementations or states hidden behind a shared interface. Include each variant that changes the behavior, or state why it is outside the question.

## Xandrio conventions

For behavior questions, start at the user action or external request and trace through the browser, server route, service, persistence, and background work only as far as the behavior requires. Show failure and recovery branches when they define the contract.

For playback, offline, import, authentication, or release behavior, distinguish durable state from in-memory state and cached artifacts. Identify the test that protects each non-obvious invariant when one exists.

For seeking and resume behavior, distinguish chunked media, finite single-file media such as an offline chapter, and continuous streams. Separate an explicit user seek, which may relocate a continuous source, from synchronous resume or Smart Rewind, which must not reload a nonseekable source before `play()`.

For a proposed refactor, show current and target ownership before editing. Preserve the constraints in `AGENTS.md`, `DESIGN.md`, and `docs/ARCHITECTURE.md`.

Keep text diagrams and Mermaid in the response by default. Do not write or commit an artifact unless the user asks for one or HTML materially improves a visual UI, layout, or dense state comparison.

## Focused HTML

If HTML is justified, create one responsive file in the current Codex visualization workspace. Use real project labels and data. For Xandrio UI, read `DESIGN.md` and reuse its colors, type, spacing, and components. Open the result with Codex's file preview. Do not use a shell `open` command.

Treat the HTML as temporary unless the user explicitly requests durable project documentation.
