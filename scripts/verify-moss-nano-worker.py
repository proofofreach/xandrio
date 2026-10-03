"""Actual-model HTTP smoke checks. Run with the installed Nano Python runtime.

Failure cases: invalid input/seed accepted; recovery seed ignored; health blocked by inference; cancellation
leaks a temp WAV/slot; decoder state leaks between voices; frame exhaustion
publishes truncated success; missing models trigger an implicit download.
Produces a JSON receipt, worker logs and repeatable first-take WAV files.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/moss-nano/worker')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = []
    with tempfile.TemporaryDirectory(prefix='nano-smoke-') as scratch:
        def run(mode, action):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            env = {**os.environ, 'MOSS_NANO_HOST': '127.0.0.1', 'MOSS_NANO_PORT': str(port),
                   'MOSS_NANO_MODEL_DIR': args.models, 'TMPDIR': scratch, 'MOSS_NANO_MAX_FRAMES': '375'}
            if mode == 'exhausted':
                env['MOSS_NANO_MAX_FRAMES'] = '1'
            if mode == 'missing':
                env['MOSS_NANO_MODEL_DIR'] = str(Path(scratch) / 'missing-models')
            with (args.output / f'{mode}.log').open('w') as log:
                child = subprocess.Popen([sys.executable, str(ROOT / 'moss-nano/server.py')], env=env, stdout=log, stderr=log)
                try:
                    url = f'http://127.0.0.1:{port}'

                    def request(route, payload=None):
                        req = urllib.request.Request(url + route, data=None if payload is None else json.dumps(payload).encode(),
                                                     headers={'Content-Type': 'application/json'})
                        try:
                            with urllib.request.urlopen(req, timeout=190) as response:
                                return response.status, response.read()
                        except urllib.error.HTTPError as error:
                            return error.code, error.read()

                    for _ in range(300):
                        try:
                            status = json.loads(request('/health')[1])['status']
                            if status == ('models-uninstalled' if mode == 'missing' else 'online'):
                                break
                        except OSError:
                            pass
                        assert child.poll() is None, 'worker exited during startup'
                        time.sleep(.1)
                    else:
                        raise AssertionError('worker startup timed out')
                    action(request, port)
                finally:
                    child.terminate()
                    child.wait(timeout=10)

        def regular(request, port):
            assert request('/tts', {'text': 'Hello', 'voice': 'unknown'})[0] == 400
            assert request('/tts', {'text': 'Hello', 'voice': 'Nathan', 'format': 'mp3'})[0] == 400
            assert request('/tts', [])[0] == 400
            for seed in (True, 1.5, -1, 4294967296, '1236', None):
                assert request('/tts', {'text': 'Hello', 'voice': 'Nathan', 'seed': seed})[0] == 400
            report.append({'check': 'invalid-input', 'passed': True})
            payload = json.dumps({'text': 'The rain stopped before dawn. Elena opened the window and listened to the quiet street.', 'voice': 'Nathan'}).encode()
            connection = socket.create_connection(('127.0.0.1', port))
            connection.sendall(f'POST /tts HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n'.encode() + payload)
            for _ in range(100):
                if json.loads(request('/health')[1])['busy']:
                    break
                time.sleep(.02)
            else:
                raise AssertionError('synthesis did not start')
            assert request('/tts', {'text': 'Hello', 'voice': 'Bella'})[0] == 503
            connection.close()
            before = time.monotonic()
            for _ in range(100):
                if not json.loads(request('/health')[1])['busy']:
                    break
                time.sleep(.1)
            else:
                raise AssertionError('cancelled worker kept its slot')
            assert not list(Path(scratch).glob('xandrio-nano-*'))
            report.append({'check': 'health-concurrency-cancellation-cleanup', 'passed': True, 'cancelSeconds': time.monotonic() - before})
            hashes = []
            for index, voice in enumerate(['Nathan', 'Bella', 'Nathan']):
                status, audio = request('/tts', {'text': 'She opened the window. A bird sang in the garden.', 'voice': voice})
                assert status == 200 and audio[:4] == b'RIFF' and len(audio) > 1000
                (args.output / f'{index}-{voice}.wav').write_bytes(audio)
                hashes.append(hashlib.sha256(audio).hexdigest())
            assert hashes[0] == hashes[2], 'decoder/RNG state leaked across requests'
            recovery_hashes = []
            for index in range(2):
                status, audio = request('/tts', {'text': 'She opened the window. A bird sang in the garden.',
                                               'voice': 'Nathan', 'seed': 1236})
                assert status == 200 and audio[:4] == b'RIFF'
                (args.output / f'recovery-{index}-Nathan.wav').write_bytes(audio)
                recovery_hashes.append(hashlib.sha256(audio).hexdigest())
            assert recovery_hashes[0] == recovery_hashes[1], 'recovery seed must remain repeatable'
            assert recovery_hashes[0] != hashes[0], 'recovery seed was ignored'
            report.append({'check': 'validated-recovery-seed-and-repeatability', 'passed': True,
                           'sha256': recovery_hashes})
            assert not list(Path(scratch).glob('xandrio-nano-*'))
            report.append({'check': 'voice-isolation-and-repeatability', 'passed': True, 'sha256': hashes})

        def exhausted(request, _port):
            status, body = request('/tts', {'text': 'The library was quiet.', 'voice': 'Nathan'})
            assert status == 422 and b'no audio was published' in body
            assert json.loads(body)['code'] == 'NANO_FRAME_LIMIT', 'frame exhaustion must be distinguishable from other failures'
            # The client can receive the error before the server's finally
            # block releases its slot. Verify bounded cleanup, not that race.
            for _ in range(100):
                if not json.loads(request('/health')[1])['busy']:
                    break
                time.sleep(.01)
            else:
                raise AssertionError('frame-exhausted worker kept its slot')
            assert not list(Path(scratch).glob('xandrio-nano-*'))
            report.append({'check': 'frame-exhaustion-does-not-publish', 'passed': True})

        def missing(request, _port):
            assert request('/tts', {'text': 'Hello', 'voice': 'Nathan'})[0] == 503
            assert not (Path(scratch) / 'missing-models').exists()
            report.append({'check': 'missing-models-no-download', 'passed': True})

        try:
            run('regular', regular)
            run('exhausted', exhausted)
            run('missing', missing)
        finally:
            (args.output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
