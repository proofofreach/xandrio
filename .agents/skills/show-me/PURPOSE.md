# Purpose

This file records why the skill has its non-obvious rules. It is not loaded at runtime.

| Rule | Motivating pattern |
| --- | --- |
| Inspect code and tests before drawing | A clean diagram can make an invented relationship look authoritative. |
| Label current and proposed behavior | Architecture discussions often mix observed code with a desired design. |
| Choose the smallest useful form | Large diagrams hide the one ownership boundary or state transition under discussion. |
| Show failures when they define the contract | Xandrio playback, offline, and release behavior depends on bounded recovery and explicit stop conditions. |
| Separate durable state, memory, and cache | Many Xandrio bugs occur when those lifetimes are treated as equivalent. |
| Keep artifacts temporary by default | Checked-in diagrams become stale unless they describe a durable contract and receive maintenance. |
| Use Codex preview for HTML | The upstream skill's `Bash(open ...)` instruction is specific to another agent environment. |
