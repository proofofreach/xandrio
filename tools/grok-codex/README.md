# grok-codex

Run [Grok Build](https://github.com/xai-org/grok-build) as the agent harness
while model inference uses the ChatGPT Codex models available to your account.
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) handles ChatGPT
OAuth, token refresh, and Responses API translation. Grok receives only a
loopback URL and a randomly generated local proxy key.

> [!WARNING]
> This is an unofficial community project. It is not affiliated with, endorsed
> by, or supported by OpenAI or xAI. It depends on CLIProxyAPI behavior and an
> undocumented ChatGPT service interface. OpenAI does not document ChatGPT
> OAuth as a general-purpose credential for arbitrary model clients. The
> integration may stop working, and its use may be restricted by the terms
> governing your accounts. Read [Disclaimer and terms](#disclaimer-and-terms)
> before installing it.

## What it does

`grok-codex` configures and supervises a local bridge:

```text
Grok Build
    |  OpenAI Responses requests + local proxy key
    v
CLIProxyAPI on 127.0.0.1
    |  ChatGPT OAuth owned by CLIProxyAPI
    v
ChatGPT Codex backend
```

Grok Build remains the harness. It owns prompts, sessions, tools, approvals,
memory, repository access, and the terminal interface. This project does not
turn Grok Build into the ChatGPT app or the official Codex CLI.

The command:

- creates a loopback-only CLIProxyAPI configuration;
- starts and stops only the proxy process it owns;
- launches CLIProxyAPI's Codex OAuth flow;
- discovers the models currently visible to the signed-in account;
- adds an isolated `grok-codex` model entry to Grok's configuration;
- passes the local proxy key to Grok only for the launched process; and
- validates configuration, file permissions, model discovery, and tool calls.

It does not bundle CLIProxyAPI, Grok Build, OpenAI code, OAuth credentials, or
model access. Each user must install the dependencies and authenticate their
own account.

## Requirements

- Python 3.11 or later on macOS or Linux
- [Grok Build](https://github.com/xai-org/grok-build), available as `grok`
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), available as
  `cliproxyapi`, with `-codex-login` and `-codex-device-login` support
- A ChatGPT account with Codex access

Install Grok Build using its published installer:

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
```

Install CLIProxyAPI by following its
[official installation guide](https://help.router-for.me/). Confirm that both
commands are on `PATH`:

```sh
command -v grok
command -v cliproxyapi
```

Review downloaded installers before executing them. This project does not
control either dependency or its release process.

## Installation

`pipx` is recommended because it gives the command an isolated Python
environment:

```sh
cd tools/grok-codex
pipx install .
grok-codex --help
```

To install into the current Python environment instead:

```sh
python3 -m pip install .
```

## First-time setup

Run the browser-based OAuth flow:

```sh
grok-codex setup
```

On a headless machine, use CLIProxyAPI's device-code flow:

```sh
grok-codex setup --device
```

Setup creates an integration-owned configuration under
`~/.config/grok-codex`, authenticates through CLIProxyAPI, starts the local
proxy, discovers the current model catalog, and adds `[model.grok-codex]` to
`~/.grok/config.toml`.

Setup does not change Grok's default model unless requested:

```sh
grok-codex setup --set-default
```

Select an exact model ID when the account exposes more than one:

```sh
grok-codex setup --model MODEL_ID
```

Reuse an existing CLIProxyAPI Codex login without opening OAuth again:

```sh
grok-codex setup --skip-login
```

If CLIProxyAPI keeps credentials in another directory, place the global option
before the subcommand:

```sh
grok-codex --auth-dir /absolute/path/to/auth setup --skip-login
```

## Usage

Launch Grok Build with the configured model:

```sh
grok-codex run
grok-codex run -- "inspect this repository"
grok-codex run -- -p "return only the word ready"
```

Arguments after `run --` pass directly to Grok. `grok-codex` always selects
the `grok-codex` model alias for that process, even when another Grok model is
the global default.

Check the local configuration and connection without making an inference
request:

```sh
grok-codex doctor
```

Perform the same checks plus a minimal Responses tool-call request:

```sh
grok-codex doctor --live
```

`doctor --live` consumes a small amount of account quota.

Manage the integration-owned proxy process explicitly:

```sh
grok-codex start
grok-codex stop
```

`run` starts the proxy automatically when necessary. `stop` verifies the
recorded process command before sending a signal; it will not stop an unrelated
CLIProxyAPI process.

## Command reference

| Command | Purpose |
| --- | --- |
| `setup` | Authenticate, discover models, and update Grok configuration |
| `start` | Start the integration-owned CLIProxyAPI process |
| `stop` | Stop only the recorded integration-owned process |
| `run` | Launch Grok with the `grok-codex` model alias |
| `doctor` | Check dependencies, configuration, permissions, and connectivity |
| `uninstall` | Remove integration-owned configuration and state |

Useful global options must appear before the command:

| Option | Default | Purpose |
| --- | --- | --- |
| `--state-dir PATH` | `~/.config/grok-codex` | Integration state directory |
| `--grok-config PATH` | `~/.grok/config.toml` | Grok configuration to edit |
| `--proxy-url URL` | `http://127.0.0.1:18317` | Loopback proxy address |
| `--api-key VALUE` | generated state secret | Override the local proxy key; command-line use is discouraged |
| `--proxy-bin PATH` | `cliproxyapi` | CLIProxyAPI executable |
| `--grok-bin PATH` | `grok` | Grok Build executable |
| `--auth-dir PATH` | `~/.cli-proxy-api` | CLIProxyAPI OAuth directory |

Run `grok-codex COMMAND --help` for all command-specific options.

## Files and credentials

By default, the integration owns these files:

| Path | Contents |
| --- | --- |
| `~/.config/grok-codex/cliproxy.yaml` | Loopback CLIProxyAPI configuration |
| `~/.config/grok-codex/secret` | Random local proxy key, mode `0600` |
| `~/.config/grok-codex/cliproxy.pid` | Recorded proxy PID |
| `~/.config/grok-codex/cliproxy.log` | Proxy stdout and stderr |
| `~/.config/grok-codex/metadata.json` | Installed model and edit metadata |
| `~/.config/grok-codex/config.toml.backup` | First pre-edit Grok config backup |
| `~/.grok/config.toml` | Grok model entry managed by this tool |

CLIProxyAPI owns OAuth credentials under `~/.cli-proxy-api` by default.
`grok-codex` neither parses those credentials nor places them in Grok's
configuration or environment. The `GROK_CODEX_PROXY_KEY` value is a local
proxy credential, not an OpenAI token.

## Security boundaries

- Non-loopback proxy URLs are rejected.
- The generated proxy listens on `127.0.0.1` by default.
- ChatGPT OAuth credentials remain in CLIProxyAPI's credential directory.
- Grok receives only the random local proxy key.
- Secret-bearing files use mode `0600`; state directories use mode `0700`.
- Configuration writes are atomic and validated as TOML before replacement.
- Existing Grok settings are preserved unless setup must populate a missing
  auxiliary model field or `--set-default` is used.
- Uninstall removes only named integration-owned files.

Loopback isolation protects against remote connections, not every local
process. Other software running as your user may be able to read your files or
connect to local services. Treat the machine account as part of the trust
boundary.

Grok may send repository content, prompts, tool definitions, and tool results
through CLIProxyAPI to OpenAI. Review Grok's sandbox, approvals, MCP servers,
plugins, and selected working directory before running it around confidential
material.

## Current Grok warning

When Grok has no xAI login or `XAI_API_KEY`, Grok Build may print a non-fatal
`No auth credentials for cli-chat-proxy` warning while refreshing xAI's model
catalog. The explicitly configured `grok-codex` model does not depend on that
refresh. This integration does not override Grok's global model endpoint or
disable unrelated remote features merely to suppress the warning.

## Troubleshooting

Start with:

```sh
grok-codex doctor
```

### Executable not found

Confirm `grok` and `cliproxyapi` are on the same `PATH` used to launch
`grok-codex`. Otherwise pass absolute paths:

```sh
grok-codex \
  --grok-bin /absolute/path/to/grok \
  --proxy-bin /absolute/path/to/cliproxyapi \
  setup
```

### OAuth succeeds but no models appear

Confirm that the signed-in ChatGPT account has Codex access. Then retry setup
with `--skip-login`. Inspect `~/.config/grok-codex/cliproxy.log` for upstream
errors, but do not publish logs without checking them for account information.

### Port already in use

Choose another loopback port during setup. The selected URL is saved in
integration metadata and reused by later commands:

```sh
grok-codex --proxy-url http://127.0.0.1:18318 setup --skip-login
```

### Proxy process is running but not ready

Inspect the owned log, stop the process, and restart it:

```sh
tail -n 100 ~/.config/grok-codex/cliproxy.log
grok-codex stop
grok-codex start
```

### Grok configuration is invalid

The tool refuses to edit invalid TOML. Repair `~/.grok/config.toml` first. On
the first successful setup, the tool saves the previous file as
`~/.config/grok-codex/config.toml.backup`.

### Upstream changes break the bridge

Upgrade Grok Build and CLIProxyAPI, rerun `setup --skip-login`, and run
`doctor --live`. If the problem persists, report dependency versions, redacted
logs, operating system, and the failing command. Never attach OAuth files or
the local proxy secret.

## Uninstall

Remove the Grok model entry and integration-owned files:

```sh
grok-codex uninstall
```

This intentionally preserves CLIProxyAPI's OAuth directory. Use CLIProxyAPI's
account-management controls if you also want to remove its stored login.

Keep integration state while removing the Grok entry:

```sh
grok-codex uninstall --keep-state
```

## Disclaimer and terms

This software is an independent interoperability utility. Open source licenses
cover the software; they do not grant access to third-party services or waive
service terms.

The ChatGPT OAuth bridge depends on CLIProxyAPI and an undocumented ChatGPT
service interface. OpenAI's published Codex documentation does not establish
that arbitrary third-party harnesses may use ChatGPT OAuth as a raw model
provider. Use may fail, change without notice, consume subscription quota, or
lead a provider to limit or suspend an account.

You are responsible for determining whether your use complies with the terms,
policies, laws, organizational rules, and license conditions that apply to
you. Do not use this project to share credentials, pool or resell accounts,
circumvent limits or safeguards, or provide a public relay service.

Read [DISCLAIMER.md](DISCLAIMER.md) before use. Also review the current
[OpenAI Terms of Use](https://openai.com/policies/terms-of-use/), OpenAI usage
policies, ChatGPT plan terms, and the terms governing Grok Build and any xAI
account you use. This notice is informational and is not legal advice.

OpenAI, ChatGPT, and Codex are trademarks of OpenAI. Grok and Grok Build are
trademarks of their respective owner. Their names identify compatibility only.

## Development and packaging

Run the test suite:

```sh
cd tools/grok-codex
python3 -m unittest discover -v
```

Build a wheel and source archive without third-party build dependencies:

```sh
python3 -m pip wheel --no-deps --no-build-isolation -w dist .
python3 -c 'import grok_codex_build as b; b.build_sdist("dist")'
```

Install the built wheel into a temporary environment and run its help command
before publishing it.

## Third-party projects

This distribution does not vendor Grok Build or CLIProxyAPI. They remain
separate projects under their own licenses and terms. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

`grok-codex` is distributed under the [MIT License](LICENSE).
