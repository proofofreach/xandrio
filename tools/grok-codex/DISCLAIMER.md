# Disclaimer

`grok-codex` is an unofficial, independent interoperability project. It is not
affiliated with, endorsed by, sponsored by, or supported by OpenAI, xAI, Grok
Build, or CLIProxyAPI.

## Service access

This software configures Grok Build to send Responses-compatible requests to a
local CLIProxyAPI process. CLIProxyAPI authenticates to a ChatGPT Codex service
using credentials obtained through its OAuth flow. The integration depends on
CLIProxyAPI behavior and an undocumented ChatGPT service interface.

OpenAI does not publicly document ChatGPT OAuth as a general-purpose
credential for arbitrary model clients. Nothing in this repository grants a
right to access OpenAI, xAI, or any other third-party service. An open source
license for client software does not override a service provider's terms.

Providers may change or withdraw interfaces, enforce usage limits, reject
requests, or restrict accounts. The maintainers make no representation that a
particular use complies with any provider's terms or will remain available.

## User responsibility

You are solely responsible for:

- reviewing and complying with all applicable service terms, usage policies,
  account rules, organizational policies, licenses, and laws;
- using only accounts and credentials you are authorized to use;
- protecting credentials, repository content, prompts, outputs, and logs;
- understanding what Grok Build, its tools, plugins, MCP servers, and the
  selected model may read, transmit, modify, or execute; and
- all costs, quota consumption, account restrictions, data loss, and other
  consequences arising from your use.

Do not use this software to share credentials, pool or rotate accounts,
circumvent quotas or safety controls, resell subscription access, expose a
public relay, or access a service without authorization.

## No legal advice or warranty

This notice provides general information, not legal advice. Consult qualified
counsel if you need a legal opinion about your circumstances.

The software is provided under the MIT License, without warranty of any kind.
To the fullest extent permitted by law, the authors and contributors disclaim
liability for claims, damages, account action, service interruption, data
exposure, or other losses arising from the software or its use.

## Trademarks

OpenAI, ChatGPT, and Codex are trademarks of OpenAI. Grok and Grok Build are
trademarks of their respective owner. CLIProxyAPI belongs to its respective
maintainers. Names appear only to describe compatibility and dependencies; no
endorsement is implied.

Review the current terms and policies yourself before every material use. They
may change after this document is published.
