from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
import tomllib
from typing import Any, NoReturn
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


ALIAS = "grok-codex"
ENV_KEY = "GROK_CODEX_PROXY_KEY"
DEFAULT_CONTEXT_WINDOW = 200_000
TABLE_HEADER = f"[model.{ALIAS}]"
TABLE_RE = re.compile(r"^\s*\[{1,2}[^]]+\]{1,2}\s*(?:#.*)?$")
AUXILIARY_MODEL_FIELDS = ("session_summary", "web_search", "image_description", "prompt_suggestion")


class IntegrationError(RuntimeError):
    pass


def default_state_dir() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    return Path(config_home).expanduser() / "grok-codex" if config_home else Path.home() / ".config" / "grok-codex"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="grok-codex",
        description="Use Grok Build with ChatGPT Codex models through CLIProxyAPI.",
    )
    parser.add_argument("--state-dir", type=Path, default=default_state_dir())
    parser.add_argument("--grok-config", type=Path, default=Path.home() / ".grok" / "config.toml")
    parser.add_argument("--proxy-url", default=os.environ.get("GROK_CODEX_PROXY_URL"))
    parser.add_argument("--api-key", default=None, help=f"Local proxy key; prefer {ENV_KEY} or the secure state file")
    parser.add_argument("--proxy-bin", default=os.environ.get("GROK_CODEX_PROXY_BIN", "cliproxyapi"))
    parser.add_argument("--grok-bin", default=os.environ.get("GROK_CODEX_GROK_BIN", "grok"))
    parser.add_argument(
        "--auth-dir",
        type=Path,
        default=Path.home() / ".cli-proxy-api",
        help="CLIProxyAPI credential directory (preserved by uninstall)",
    )

    sub = parser.add_subparsers(dest="command", required=True)
    setup = sub.add_parser("setup", help="Authenticate, discover models, and configure Grok")
    setup.add_argument("--model", help="Exact model ID; defaults to the proxy's highest-priority visible model")
    setup.add_argument("--device", action="store_true", help="Use CLIProxyAPI's device-code OAuth flow")
    setup.add_argument("--skip-login", action="store_true", help="Reuse an existing CLIProxyAPI Codex login")
    setup.add_argument("--no-start", action="store_true", help="Require an already-running proxy")
    setup.add_argument("--set-default", action="store_true", help="Make grok-codex Grok's default model")

    start = sub.add_parser("start", help="Start the integration-owned CLIProxyAPI process")
    start.add_argument("--wait-seconds", type=float, default=15.0)
    sub.add_parser("stop", help="Stop only the integration-owned CLIProxyAPI process")

    run = sub.add_parser("run", help="Run Grok with the configured Codex model")
    run.add_argument("args", nargs=argparse.REMAINDER, help="Arguments passed to Grok")

    doctor = sub.add_parser("doctor", help="Verify configuration, security, and connectivity")
    doctor.add_argument("--live", action="store_true", help="Also make a minimal model/tool-call request")

    uninstall = sub.add_parser("uninstall", help="Remove only integration-owned configuration and files")
    uninstall.add_argument(
        "--keep-state",
        action="store_true",
        help="Keep the proxy config, local key, and integration metadata",
    )
    return parser.parse_args(argv)


class Integration:
    """Owns the complete Grok-to-CLIProxy integration behind one command interface."""

    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.state_dir = args.state_dir.expanduser().resolve()
        self.grok_config = args.grok_config.expanduser().resolve()
        self.proxy_config = self.state_dir / "cliproxy.yaml"
        self.secret_file = self.state_dir / "secret"
        self.pid_file = self.state_dir / "cliproxy.pid"
        self.log_file = self.state_dir / "cliproxy.log"
        self.metadata_file = self.state_dir / "metadata.json"
        self.ownership_file = self.state_dir / ".grok-codex-owned"
        self.auth_dir = args.auth_dir.expanduser().resolve()
        saved_value = self.load_metadata().get("proxy_root")
        saved_proxy = saved_value if isinstance(saved_value, str) else None
        proxy_url = args.proxy_url or saved_proxy or "http://127.0.0.1:18317"
        self.proxy_root = normalize_proxy_url(proxy_url)

    def execute(self) -> int:
        command = self.args.command
        if command == "setup":
            self.setup()
        elif command == "start":
            self.resolve_api_key(create=False)
            if not self.proxy_config.is_file():
                raise IntegrationError("proxy configuration not found; run setup first")
            self.start_proxy(self.args.wait_seconds)
        elif command == "stop":
            self.stop_proxy()
        elif command == "run":
            return self.run_grok()
        elif command == "doctor":
            self.doctor(live=self.args.live)
        elif command == "uninstall":
            self.uninstall(keep_state=self.args.keep_state)
        else:  # pragma: no cover - argparse prevents this
            raise IntegrationError(f"unknown command: {command}")
        return 0

    def setup(self) -> None:
        require_executable(self.args.proxy_bin, "CLIProxyAPI")
        require_executable(self.args.grok_bin, "Grok Build")
        self.validate_proxy_capabilities()
        api_key = self.resolve_api_key(create=True)
        self.ensure_layout(api_key)

        if not self.args.skip_login:
            login_flag = "-codex-device-login" if self.args.device else "-codex-login"
            result = subprocess.run([self.args.proxy_bin, "-config", str(self.proxy_config), login_flag])
            if result.returncode != 0:
                raise IntegrationError(f"CLIProxyAPI Codex login failed with exit code {result.returncode}")

        if not self.args.no_start:
            self.start_proxy(wait_seconds=15.0)

        models = self.fetch_models(api_key)
        model = select_model(models, self.args.model)
        self.install_grok_config(model, set_default=self.args.set_default)
        print(f"Configured Grok model '{ALIAS}' -> {model['slug']}")
        print(f"Run: grok-codex run -- <grok arguments>")

    def ensure_layout(self, api_key: str) -> None:
        secure_directory(self.state_dir)
        atomic_write(self.ownership_file, "grok-codex state v1\n", 0o600)
        atomic_write(self.secret_file, api_key.rstrip("\n") + "\n", 0o600)

        parsed = urlparse(self.proxy_root)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        config = (
            f"host: {json.dumps(host)}\n"
            f"port: {port}\n"
            f"auth-dir: {json.dumps(str(self.auth_dir))}\n"
            "api-keys:\n"
            f"  - {json.dumps(api_key)}\n"
        )
        atomic_write(self.proxy_config, config, 0o600)

    def resolve_api_key(self, create: bool) -> str:
        candidate = self.args.api_key or os.environ.get(ENV_KEY)
        if not candidate and self.secret_file.exists():
            candidate = self.secret_file.read_text().strip()
        if not candidate and create:
            candidate = "gcp_" + secrets.token_urlsafe(32)
        if not candidate:
            raise IntegrationError(f"local proxy key not found; run setup or set {ENV_KEY}")
        if "\n" in candidate or "\r" in candidate:
            raise IntegrationError("local proxy key must be a single line")
        return candidate

    def start_proxy(self, wait_seconds: float) -> None:
        api_key = self.resolve_api_key(create=False)
        if self.proxy_ready(api_key):
            print(f"CLIProxyAPI already ready at {self.proxy_root}")
            return
        existing_pid = read_pid(self.pid_file)
        if existing_pid and self.is_owned_process(existing_pid):
            raise IntegrationError(
                f"owned CLIProxyAPI process {existing_pid} is running but not ready; inspect {self.log_file}"
            )
        if existing_pid:
            self.pid_file.unlink(missing_ok=True)
        require_executable(self.args.proxy_bin, "CLIProxyAPI")
        secure_directory(self.state_dir)
        log = self.log_file.open("ab")
        try:
            process = subprocess.Popen(
                [self.args.proxy_bin, "-config", str(self.proxy_config)],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log.close()
        atomic_write(self.pid_file, f"{process.pid}\n", 0o600)
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self.pid_file.unlink(missing_ok=True)
                raise IntegrationError(
                    f"CLIProxyAPI exited with code {process.returncode}; inspect {self.log_file}"
                )
            if self.proxy_ready(api_key):
                print(f"Started CLIProxyAPI at {self.proxy_root} (pid {process.pid})")
                return
            time.sleep(0.15)
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
            self.pid_file.unlink(missing_ok=True)
        except subprocess.TimeoutExpired:
            raise IntegrationError(
                f"CLIProxyAPI did not become ready and did not stop after SIGTERM; PID {process.pid} remains recorded"
            )
        raise IntegrationError(f"CLIProxyAPI did not become ready within {wait_seconds:g}s; inspect {self.log_file}")

    def stop_proxy(self) -> None:
        pid = read_pid(self.pid_file)
        if not pid:
            print("No integration-owned CLIProxyAPI process is recorded")
            return
        if not process_exists(pid):
            self.pid_file.unlink(missing_ok=True)
            print("Removed stale CLIProxyAPI PID file")
            return
        if not self.is_owned_process(pid):
            self.pid_file.unlink(missing_ok=True)
            raise IntegrationError(
                f"refusing to signal PID {pid}: it is not the integration-owned CLIProxyAPI command"
            )
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and process_exists(pid):
            time.sleep(0.05)
        if process_exists(pid):
            raise IntegrationError(f"CLIProxyAPI process {pid} did not stop after SIGTERM")
        self.pid_file.unlink(missing_ok=True)
        print(f"Stopped integration-owned CLIProxyAPI process {pid}")

    def is_owned_process(self, pid: int) -> bool:
        command = process_command(pid)
        return command is not None and str(self.proxy_config) in command and "-config" in command

    def validate_proxy_capabilities(self) -> None:
        try:
            result = subprocess.run(
                [self.args.proxy_bin, "--help"],
                text=True,
                capture_output=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise IntegrationError(f"could not inspect CLIProxyAPI capabilities: {error}") from error
        help_text = result.stdout + result.stderr
        missing = [flag for flag in ("-config", "-codex-login", "-codex-device-login") if flag not in help_text]
        if missing:
            raise IntegrationError(
                "CLIProxyAPI lacks required Codex OAuth capabilities: " + ", ".join(missing)
            )

    def proxy_ready(self, api_key: str) -> bool:
        try:
            self.fetch_models(api_key, timeout=1.0)
            return True
        except IntegrationError:
            return False

    def fetch_models(self, api_key: str, timeout: float = 5.0) -> list[dict[str, Any]]:
        payload = http_json(
            "GET",
            f"{self.proxy_root}/v1/models?client_version=grok-codex",
            api_key,
            timeout=timeout,
        )
        raw_models = payload.get("models", payload.get("data"))
        if not isinstance(raw_models, list):
            raise IntegrationError("CLIProxyAPI model response did not contain a models list")
        models: list[dict[str, Any]] = []
        for raw in raw_models:
            if not isinstance(raw, dict):
                continue
            slug = raw.get("slug") or raw.get("id")
            if not isinstance(slug, str) or not slug.strip():
                continue
            model = dict(raw)
            model["slug"] = slug.strip()
            models.append(model)
        if not models:
            raise IntegrationError(
                "CLIProxyAPI returned no models; complete Codex OAuth login and confirm the account has Codex access"
            )
        return models

    def install_grok_config(self, model: dict[str, Any], set_default: bool) -> None:
        existing = self.grok_config.read_text() if self.grok_config.exists() else ""
        if existing.strip():
            try:
                parsed_existing = tomllib.loads(existing)
            except tomllib.TOMLDecodeError as error:
                raise IntegrationError(f"refusing to modify invalid Grok TOML: {error}") from error
        else:
            parsed_existing = {}

        context_window = positive_int(model.get("context_window")) or positive_int(
            model.get("max_context_window")
        ) or DEFAULT_CONTEXT_WINDOW
        name = model.get("display_name") if isinstance(model.get("display_name"), str) else model["slug"]
        block = "\n".join(
            [
                TABLE_HEADER,
                f"model = {toml_string(model['slug'])}",
                f"base_url = {toml_string(self.proxy_root + '/v1')}",
                f"name = {toml_string('OpenAI ' + name + ' via ChatGPT OAuth')}",
                'api_backend = "responses"',
                f"env_key = {toml_string(ENV_KEY)}",
                f"context_window = {context_window}",
                'agent_type = "codex"',
            ]
        )
        updated = replace_table(existing, TABLE_HEADER, block)
        metadata = self.load_metadata()
        parsed_models = parsed_existing.get("models", {})
        injected_fields = set(metadata.get("injected_models_fields", []))
        for field in AUXILIARY_MODEL_FIELDS:
            if field not in parsed_models:
                updated = set_models_value(updated, field, ALIAS)
                injected_fields.add(field)
        metadata["injected_models_fields"] = sorted(injected_fields)
        if set_default:
            current_default = parsed_models.get("default")
            if "previous_default" not in metadata:
                metadata["previous_default"] = current_default
            updated = set_models_value(updated, "default", ALIAS)
            metadata["set_default"] = True
        metadata.update({"alias": ALIAS, "model": model["slug"], "proxy_root": self.proxy_root})
        self.grok_config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.grok_config.exists() and not (self.state_dir / "config.toml.backup").exists():
            atomic_write(self.state_dir / "config.toml.backup", existing, 0o600)
        try:
            tomllib.loads(updated)
        except tomllib.TOMLDecodeError as error:
            raise IntegrationError(f"generated Grok configuration is invalid: {error}") from error
        config_mode = (
            stat.S_IMODE(self.grok_config.stat().st_mode) if self.grok_config.exists() else 0o600
        )
        atomic_write(self.grok_config, updated, config_mode)
        atomic_write(self.metadata_file, json.dumps(metadata, indent=2, sort_keys=True) + "\n", 0o600)

    def run_grok(self) -> NoReturn:
        require_executable(self.args.grok_bin, "Grok Build")
        api_key = self.resolve_api_key(create=False)
        configured_model, config_error = self.configured_model()
        if not configured_model or config_error:
            raise IntegrationError(f"Grok configuration is not ready: {config_error or 'model is missing'}; run setup")
        if not self.proxy_ready(api_key):
            self.start_proxy(wait_seconds=15.0)
        passthrough = list(self.args.args)
        if passthrough[:1] == ["--"]:
            passthrough.pop(0)
        environment = os.environ.copy()
        environment[ENV_KEY] = api_key
        os.execvpe(self.args.grok_bin, [self.args.grok_bin, "-m", ALIAS, *passthrough], environment)

    def doctor(self, live: bool) -> None:
        checks: list[tuple[str, bool, str]] = []
        checks.append(("proxy URL", is_loopback_url(self.proxy_root), self.proxy_root))
        checks.append(("CLIProxyAPI", executable_exists(self.args.proxy_bin), self.args.proxy_bin))
        checks.append(("Grok Build", executable_exists(self.args.grok_bin), self.args.grok_bin))
        checks.append(("Grok config", self.grok_config.exists(), str(self.grok_config)))
        checks.append(("secret permissions", secure_mode(self.secret_file), "0600 required"))
        checks.append(("proxy config permissions", secure_mode(self.proxy_config), "0600 required"))

        api_key: str | None = None
        models: list[dict[str, Any]] = []
        try:
            api_key = self.resolve_api_key(create=False)
            models = self.fetch_models(api_key)
            checks.append(("model discovery", True, f"{len(models)} available"))
        except IntegrationError as error:
            checks.append(("model discovery", False, str(error)))

        configured_model, config_error = self.configured_model()
        checks.append(("model configured", configured_model is not None, configured_model or ALIAS))
        checks.append(("Grok Responses configuration", config_error is None, config_error or "secure local adapter"))
        if configured_model and models:
            available = configured_model in {model["slug"] for model in models}
            checks.append(("configured model available", available, configured_model))

        if live and api_key and configured_model:
            try:
                self.live_probe(api_key, configured_model)
                checks.append(("Responses tool call", True, configured_model))
            except IntegrationError as error:
                checks.append(("Responses tool call", False, str(error)))

        for label, passed, detail in checks:
            print(f"{'PASS' if passed else 'FAIL'}  {label}: {detail}")
        failed = [label for label, passed, _ in checks if not passed]
        if failed:
            raise IntegrationError("doctor failed: " + ", ".join(failed))

    def configured_model(self) -> tuple[str | None, str | None]:
        if not self.grok_config.exists():
            return None, "Grok config is missing"
        try:
            config = tomllib.loads(self.grok_config.read_text())
        except tomllib.TOMLDecodeError as error:
            return None, f"invalid Grok TOML: {error}"
        entry = config.get("model", {}).get(ALIAS, {})
        value = entry.get("model")
        model = value if isinstance(value, str) and value else None
        expected = {
            "base_url": self.proxy_root + "/v1",
            "api_backend": "responses",
            "env_key": ENV_KEY,
            "agent_type": "codex",
        }
        wrong = [f"{key}={entry.get(key)!r}" for key, wanted in expected.items() if entry.get(key) != wanted]
        models = config.get("models", {})
        if not isinstance(models.get("session_summary"), str):
            wrong.append("models.session_summary is unset")
        return model, ("unexpected " + ", ".join(wrong) if wrong else None)

    def live_probe(self, api_key: str, model: str) -> None:
        body = {
            "model": model,
            "input": "Call integration_probe with ok=true. Do not answer with text.",
            "tools": [
                {
                    "type": "function",
                    "name": "integration_probe",
                    "description": "Verify tool calling through the integration",
                    "parameters": {
                        "type": "object",
                        "properties": {"ok": {"type": "boolean"}},
                        "required": ["ok"],
                        "additionalProperties": False,
                    },
                }
            ],
            "tool_choice": "required",
            "stream": False,
        }
        response = http_json("POST", f"{self.proxy_root}/v1/responses", api_key, body, timeout=60.0)
        if not contains_function_call(response, "integration_probe"):
            raise IntegrationError("model response completed without the required integration_probe tool call")

    def uninstall(self, keep_state: bool) -> None:
        self.stop_proxy()
        if self.grok_config.exists():
            existing = self.grok_config.read_text()
            updated = remove_table(existing, TABLE_HEADER)
            metadata = self.load_metadata()
            current = tomllib.loads(updated or "").get("models", {}).get("default") if updated.strip() else None
            if current == ALIAS:
                updated = set_models_value(
                    updated,
                    "default",
                    metadata.get("previous_default"),
                    remove_if_none=True,
                )
            for field in AUXILIARY_MODEL_FIELDS:
                parsed = tomllib.loads(updated or "") if updated.strip() else {}
                if parsed.get("models", {}).get(field) == ALIAS:
                    updated = set_models_value(updated, field, None, remove_if_none=True)
            atomic_write(self.grok_config, updated, stat.S_IMODE(self.grok_config.stat().st_mode))
        if not keep_state and self.state_dir.exists():
            owned_files = (
                self.proxy_config,
                self.secret_file,
                self.pid_file,
                self.log_file,
                self.metadata_file,
                self.state_dir / "config.toml.backup",
                self.ownership_file,
            )
            for child in owned_files:
                child.unlink(missing_ok=True)
            try:
                self.state_dir.rmdir()
            except OSError:
                pass
        print("Removed the Grok Codex integration; CLIProxyAPI OAuth credentials were preserved")

    def load_metadata(self) -> dict[str, Any]:
        if not self.metadata_file.exists():
            return {}
        try:
            value = json.loads(self.metadata_file.read_text())
            return value if isinstance(value, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}


def normalize_proxy_url(raw: str) -> str:
    value = raw.strip().rstrip("/")
    if value.endswith("/v1"):
        value = value[:-3]
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise IntegrationError("proxy URL must be an absolute http(s) URL")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise IntegrationError("proxy URL must contain only scheme, loopback host, and port")
    if not is_loopback_url(value):
        raise IntegrationError("refusing non-loopback proxy URL; CLIProxyAPI must be bound to localhost")
    return value


def is_loopback_url(value: str) -> bool:
    return (urlparse(value).hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}


def secure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def atomic_write(path: Path, content: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def secure_mode(path: Path) -> bool:
    return path.is_file() and stat.S_IMODE(path.stat().st_mode) == 0o600


def executable_exists(command: str) -> bool:
    return bool(shutil.which(command)) if os.sep not in command else os.access(command, os.X_OK)


def require_executable(command: str, name: str) -> None:
    if not executable_exists(command):
        raise IntegrationError(f"{name} executable not found: {command}")


def http_json(
    method: str,
    url: str,
    api_key: str,
    body: dict[str, Any] | None = None,
    timeout: float = 5.0,
) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = Request(
        url,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except HTTPError as error:
        detail = error.read(2048).decode(errors="replace").replace(api_key, "[REDACTED]")
        raise IntegrationError(f"CLIProxyAPI returned HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise IntegrationError(f"cannot reach CLIProxyAPI at {url}: {error}") from error
    except json.JSONDecodeError as error:
        raise IntegrationError("CLIProxyAPI returned invalid JSON") from error
    if not isinstance(value, dict):
        raise IntegrationError("CLIProxyAPI returned a non-object JSON response")
    return value


def select_model(models: list[dict[str, Any]], requested: str | None) -> dict[str, Any]:
    available = {model["slug"]: model for model in models}
    if requested:
        if requested not in available:
            choices = ", ".join(available)
            raise IntegrationError(f"model '{requested}' is unavailable; available models: {choices}")
        return available[requested]
    for model in models:
        if str(model.get("visibility", "")).lower() != "hide" and not any(
            marker in model["slug"].lower() for marker in ("image", "audio", "embedding", "video")
        ):
            return model
    raise IntegrationError("CLIProxyAPI exposed no visible text model")


def toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def table_bounds(text: str, header: str) -> tuple[int, int] | None:
    lines = text.splitlines(keepends=True)
    header_pattern = re.compile(rf"^\s*{re.escape(header)}\s*(?:#.*)?$")
    start = next((i for i, line in enumerate(lines) if header_pattern.match(line)), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if TABLE_RE.match(lines[i])), len(lines))
    return start, end


def remove_table(text: str, header: str) -> str:
    bounds = table_bounds(text, header)
    if bounds is None:
        return text
    lines = text.splitlines(keepends=True)
    start, end = bounds
    del lines[start:end]
    result = "".join(lines)
    return re.sub(r"\n{3,}", "\n\n", result).rstrip() + ("\n" if result.strip() else "")


def replace_table(text: str, header: str, block: str) -> str:
    base = remove_table(text, header).rstrip()
    return (base + "\n\n" if base else "") + block.rstrip() + "\n"


def set_models_value(text: str, key: str, value: str | None, remove_if_none: bool = False) -> str:
    lines = text.splitlines(keepends=True)
    models_header = re.compile(r"^\s*\[models\]\s*(?:#.*)?$")
    models_start = next((i for i, line in enumerate(lines) if models_header.match(line)), None)
    assignment = f"{key} = {toml_string(value)}\n" if value is not None else ""
    if models_start is None:
        if remove_if_none:
            return text
        prefix = text.rstrip()
        return (prefix + "\n\n" if prefix else "") + "[models]\n" + assignment
    end = next((i for i in range(models_start + 1, len(lines)) if TABLE_RE.match(lines[i])), len(lines))
    value_index = next(
        (i for i in range(models_start + 1, end) if re.match(rf"^\s*{re.escape(key)}\s*=", lines[i])),
        None,
    )
    if value_index is not None:
        if value is None and remove_if_none:
            del lines[value_index]
        else:
            lines[value_index] = assignment
    elif value is not None:
        lines.insert(models_start + 1, assignment)
    return "".join(lines)


def read_pid(path: Path) -> int | None:
    try:
        value = int(path.read_text().strip())
        return value if value > 1 else None
    except (OSError, ValueError):
        return None


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_command(pid: int) -> str | None:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            text=True,
            capture_output=True,
            timeout=2,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    command = result.stdout.strip()
    return command if result.returncode == 0 and command else None


def contains_function_call(value: Any, name: str) -> bool:
    if isinstance(value, dict):
        if value.get("type") == "function_call" and value.get("name") == name:
            return True
        return any(contains_function_call(child, name) for child in value.values())
    if isinstance(value, list):
        return any(contains_function_call(child, name) for child in value)
    return False


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        return Integration(args).execute()
    except IntegrationError as error:
        print(f"grok-codex: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"grok-codex: operating-system error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("grok-codex: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
