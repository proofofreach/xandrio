from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest


PROJECT = Path(__file__).resolve().parents[1]


class ProxyHandler(BaseHTTPRequestHandler):
    api_key = "test-local-key"
    requests: list[dict] = []
    forced_error: str | None = None

    def do_GET(self) -> None:  # noqa: N802
        if self.forced_error is not None:
            self._json({"error": self.forced_error}, status=401)
            return
        if self.headers.get("Authorization") != f"Bearer {self.api_key}":
            self.send_error(401)
            return
        if self.path.startswith("/v1/models"):
            self._json(
                {
                    "models": [
                        {
                            "slug": "gpt-test-codex",
                            "display_name": "GPT Test Codex",
                            "context_window": 123456,
                            "supported_reasoning_levels": ["low", "high"],
                        }
                    ]
                }
            )
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if self.headers.get("Authorization") != f"Bearer {self.api_key}":
            self.send_error(401)
            return
        if self.path == "/v1/responses":
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            self.requests.append(body)
            self._json(
                {
                    "id": "resp_test",
                    "output": [
                        {
                            "type": "function_call",
                            "name": "integration_probe",
                            "arguments": '{"ok":true}',
                        }
                    ],
                }
            )
            return
        self.send_error(404)

    def log_message(self, *_args: object) -> None:
        return

    def _json(self, body: dict, status: int = 200) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class RunningProxy:
    def __enter__(self) -> "RunningProxy":
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()


class CliTest(unittest.TestCase):
    def run_cli(self, home: Path, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["HOME"] = str(home)
        env.pop("XDG_CONFIG_HOME", None)
        env["PYTHONPATH"] = str(PROJECT / "src")
        return subprocess.run(
            [sys.executable, "-m", "grok_codex.cli", *args],
            cwd=PROJECT,
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )

    def make_executable(
        self,
        path: Path,
        body: str = '#!/bin/sh\necho "-config -codex-login -codex-device-login"\nexit 0\n',
    ) -> Path:
        path.write_text(body)
        path.chmod(0o755)
        return path

    def command_options(self, home: Path, proxy: RunningProxy) -> tuple[str, ...]:
        fake_proxy = self.make_executable(home / "cliproxyapi")
        fake_grok = self.make_executable(home / "grok")
        return (
            "--proxy-url",
            proxy.url,
            "--api-key",
            ProxyHandler.api_key,
            "--proxy-bin",
            str(fake_proxy),
            "--grok-bin",
            str(fake_grok),
        )

    def test_setup_discovers_model_and_writes_secure_idempotent_config(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            grok_config = home / ".grok" / "config.toml"
            grok_config.parent.mkdir()
            grok_config.parent.chmod(0o755)
            grok_config.write_text('[models] # preserve this comment\ndefault = "existing"\n')

            args = (
                *self.command_options(home, proxy),
                "setup",
                "--skip-login",
                "--no-start",
            )
            first = self.run_cli(home, *args)
            self.assertEqual(first.returncode, 0, first.stderr)
            with grok_config.open("a") as handle:
                handle.write('\n[[custom.items]]\nname = "preserved-array-table"\n')
            second = self.run_cli(home, *args)
            self.assertEqual(second.returncode, 0, second.stderr)

            configured = grok_config.read_text()
            self.assertEqual(configured.count("[model.grok-codex]"), 1)
            self.assertIn('model = "gpt-test-codex"', configured)
            self.assertIn('api_backend = "responses"', configured)
            self.assertIn('env_key = "GROK_CODEX_PROXY_KEY"', configured)
            self.assertIn("context_window = 123456", configured)
            self.assertIn('default = "existing"', configured)
            self.assertIn("[models] # preserve this comment", configured)
            self.assertIn('name = "preserved-array-table"', configured)
            self.assertIn('session_summary = "grok-codex"', configured)
            self.assertIn('web_search = "grok-codex"', configured)
            self.assertNotIn(ProxyHandler.api_key, configured)

            state = home / ".config" / "grok-codex"
            self.assertEqual(stat.S_IMODE((state / "secret").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((state / "cliproxy.yaml").stat().st_mode), 0o600)
            self.assertIn('host: "127.0.0.1"', (state / "cliproxy.yaml").read_text())
            self.assertEqual(stat.S_IMODE(grok_config.parent.stat().st_mode), 0o755)

    def test_doctor_verifies_configuration_and_live_responses_tool_call(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            options = self.command_options(home, proxy)
            setup = self.run_cli(home, *options, "setup", "--skip-login", "--no-start")
            self.assertEqual(setup.returncode, 0, setup.stderr)

            ProxyHandler.requests.clear()
            doctor = self.run_cli(home, *options, "doctor", "--live")
            self.assertEqual(doctor.returncode, 0, doctor.stderr)
            self.assertIn("PASS  model discovery", doctor.stdout)
            self.assertIn("PASS  Responses tool call", doctor.stdout)
            self.assertEqual(ProxyHandler.requests[0]["model"], "gpt-test-codex")
            self.assertEqual(ProxyHandler.requests[0]["tool_choice"], "required")

            persisted_options = (
                "--api-key",
                ProxyHandler.api_key,
                "--proxy-bin",
                options[5],
                "--grok-bin",
                options[7],
            )
            persisted = self.run_cli(home, *persisted_options, "doctor")
            self.assertEqual(persisted.returncode, 0, persisted.stderr)
            self.assertIn(proxy.url, persisted.stdout)

    def test_run_injects_only_local_key_and_forwards_arguments_to_grok(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            capture = home / "grok-invocation.json"
            fake_proxy = self.make_executable(home / "cliproxyapi")
            fake_grok = self.make_executable(
                home / "grok",
                "#!/bin/sh\n"
                "python3 -c 'import json,os,sys; "
                "json.dump({\"args\":sys.argv[2:],"
                "\"key\":os.environ.get(\"GROK_CODEX_PROXY_KEY\"),"
                "\"oauth\":os.environ.get(\"OPENAI_ACCESS_TOKEN\")},"
                "open(sys.argv[1],\"w\"))' "
                f"{capture} \"$@\"\n",
            )
            options = (
                "--proxy-url",
                proxy.url,
                "--api-key",
                ProxyHandler.api_key,
                "--proxy-bin",
                str(fake_proxy),
                "--grok-bin",
                str(fake_grok),
            )
            setup = self.run_cli(home, *options, "setup", "--skip-login", "--no-start")
            self.assertEqual(setup.returncode, 0, setup.stderr)
            run = self.run_cli(home, *options, "run", "--", "-p", "say ready")
            self.assertEqual(run.returncode, 0, run.stderr)
            invocation = json.loads(capture.read_text())
            self.assertEqual(invocation["args"], ["-m", "grok-codex", "-p", "say ready"])
            self.assertEqual(invocation["key"], ProxyHandler.api_key)
            self.assertIsNone(invocation["oauth"])

    def test_uninstall_restores_default_and_preserves_unrelated_config_and_oauth(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            config = home / ".grok" / "config.toml"
            config.parent.mkdir()
            config.write_text('[models]\ndefault = "existing"\n\n[model.other]\nmodel = "other"\n')
            oauth = home / ".cli-proxy-api" / "codex-account.json"
            oauth.parent.mkdir()
            oauth.write_text("oauth-data")
            options = self.command_options(home, proxy)

            setup = self.run_cli(
                home, *options, "setup", "--skip-login", "--no-start", "--set-default"
            )
            self.assertEqual(setup.returncode, 0, setup.stderr)
            self.assertIn('default = "grok-codex"', config.read_text())
            state = home / ".config" / "grok-codex"
            unrelated_state = state / "user-note.txt"
            unrelated_state.write_text("keep")

            uninstall = self.run_cli(home, *options, "uninstall")
            self.assertEqual(uninstall.returncode, 0, uninstall.stderr)
            remaining = config.read_text()
            self.assertNotIn("[model.grok-codex]", remaining)
            self.assertIn('default = "existing"', remaining)
            self.assertIn("[model.other]", remaining)
            self.assertNotIn('session_summary = "grok-codex"', remaining)
            self.assertNotIn('web_search = "grok-codex"', remaining)
            self.assertEqual(oauth.read_text(), "oauth-data")
            self.assertEqual(unrelated_state.read_text(), "keep")

    def test_setup_device_login_starts_and_stop_terminates_only_owned_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home:
            home = Path(raw_home)
            with socket.socket() as candidate:
                candidate.bind(("127.0.0.1", 0))
                port = candidate.getsockname()[1]
            login_marker = home / "login-flow"
            fake_proxy = self.make_executable(
                home / "cliproxyapi",
                f"#!{sys.executable}\n"
                "import json, re, sys\n"
                "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\n"
                "from pathlib import Path\n"
                "if '--help' in sys.argv:\n"
                "    print('-config -codex-login -codex-device-login')\n"
                "    raise SystemExit(0)\n"
                "if '-codex-device-login' in sys.argv:\n"
                f"    Path({str(login_marker)!r}).write_text('device')\n"
                "    raise SystemExit(0)\n"
                "config = Path(sys.argv[sys.argv.index('-config') + 1]).read_text()\n"
                "port = int(re.search(r'^port: (\\d+)$', config, re.M).group(1))\n"
                "key = json.loads(re.search(r'^  - (.+)$', config, re.M).group(1))\n"
                "class Handler(BaseHTTPRequestHandler):\n"
                "    def do_GET(self):\n"
                "        if self.headers.get('Authorization') != 'Bearer ' + key:\n"
                "            self.send_error(401); return\n"
                "        body = json.dumps({'models':[{'slug':'gpt-owned','context_window':200000}]}).encode()\n"
                "        self.send_response(200)\n"
                "        self.send_header('Content-Length', str(len(body)))\n"
                "        self.end_headers()\n"
                "        self.wfile.write(body)\n"
                "    def log_message(self, *args): pass\n"
                "ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()\n",
            )
            fake_grok = self.make_executable(home / "grok")
            options = (
                "--proxy-url",
                f"http://127.0.0.1:{port}",
                "--api-key",
                ProxyHandler.api_key,
                "--proxy-bin",
                str(fake_proxy),
                "--grok-bin",
                str(fake_grok),
            )
            pid_file = home / ".config" / "grok-codex" / "cliproxy.pid"
            try:
                setup = self.run_cli(home, *options, "setup", "--device")
                self.assertEqual(setup.returncode, 0, setup.stderr)
                self.assertEqual(login_marker.read_text(), "device")
                pid = int(pid_file.read_text())
                os.kill(pid, 0)

                stop = self.run_cli(home, *options, "stop")
                self.assertEqual(stop.returncode, 0, stop.stderr)
                self.assertFalse(pid_file.exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if pid_file.exists():
                    try:
                        os.kill(int(pid_file.read_text()), 15)
                    except (OSError, ValueError):
                        pass

    def test_non_loopback_proxy_is_rejected_before_writing_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home:
            home = Path(raw_home)
            result = self.run_cli(home, "--proxy-url", "http://192.0.2.10:8317", "setup")
            self.assertEqual(result.returncode, 1)
            self.assertIn("refusing non-loopback proxy URL", result.stderr)
            self.assertFalse((home / ".config" / "grok-codex").exists())

    def test_invalid_existing_grok_config_is_not_modified(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            config = home / ".grok" / "config.toml"
            config.parent.mkdir()
            original = "[models\ndefault = broken\n"
            config.write_text(original)
            result = self.run_cli(
                home,
                *self.command_options(home, proxy),
                "setup",
                "--skip-login",
                "--no-start",
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("refusing to modify invalid Grok TOML", result.stderr)
            self.assertEqual(config.read_text(), original)

    def test_stop_refuses_to_signal_a_reused_or_foreign_pid(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home:
            home = Path(raw_home)
            state = home / ".config" / "grok-codex"
            state.mkdir(parents=True)
            pid_file = state / "cliproxy.pid"
            pid_file.write_text(f"{os.getpid()}\n")
            result = self.run_cli(home, "stop")
            self.assertEqual(result.returncode, 1)
            self.assertIn("refusing to signal PID", result.stderr)
            self.assertFalse(pid_file.exists())
            os.kill(os.getpid(), 0)

    def test_setup_rejects_a_proxy_without_codex_oauth_support(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home:
            home = Path(raw_home)
            old_proxy = self.make_executable(home / "old-proxy", "#!/bin/sh\necho '-config'\n")
            fake_grok = self.make_executable(home / "grok")
            result = self.run_cli(
                home,
                "--proxy-bin",
                str(old_proxy),
                "--grok-bin",
                str(fake_grok),
                "setup",
                "--skip-login",
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("lacks required Codex OAuth capabilities", result.stderr)
            self.assertIn("-codex-login", result.stderr)
            self.assertFalse((home / ".config" / "grok-codex").exists())

    def test_proxy_errors_redact_the_local_key(self) -> None:
        with tempfile.TemporaryDirectory() as raw_home, RunningProxy() as proxy:
            home = Path(raw_home)
            ProxyHandler.forced_error = f"credential={ProxyHandler.api_key}"
            try:
                result = self.run_cli(
                    home,
                    *self.command_options(home, proxy),
                    "setup",
                    "--skip-login",
                    "--no-start",
                )
            finally:
                ProxyHandler.forced_error = None
            self.assertEqual(result.returncode, 1)
            self.assertIn("[REDACTED]", result.stderr)
            self.assertNotIn(ProxyHandler.api_key, result.stderr)


if __name__ == "__main__":
    unittest.main()
