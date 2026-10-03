"""Optional CPU narration worker. Built-in references only; no request downloads."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import sys
import tempfile
import threading
import time
import wave

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'vendor'))
MODEL_DIR = Path(os.environ.get('MOSS_NANO_MODEL_DIR', ROOT / 'models')).expanduser()
VOICES = json.loads((ROOT / 'voices.json').read_text())
MAX_FRAMES = max(1, min(375, int(os.environ.get('MOSS_NANO_MAX_FRAMES', '375'))))
DECODE_BATCH = 8
TIMEOUT = 180
slot = threading.Lock()
state = {'status': 'starting', 'runtime': None, 'tokenizer': None}


class FrameLimitError(ValueError):
    """A sampled take failed to reach EOS; another seed may finish it."""


def load_runtime():
    try:
        spec = importlib.util.spec_from_file_location('model_installer', ROOT / 'install-models.py')
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installer.verify(MODEL_DIR)
    except (FileNotFoundError, ValueError):
        state['status'] = 'models-uninstalled'
        return
    try:
        import numpy as np
        import onnxruntime as ort
        import sentencepiece as spm
        from ort_cpu_runtime import OrtCpuRuntime

        class BuiltinRuntime(OrtCpuRuntime):
            def _session(self, path):
                options = ort.SessionOptions()
                options.intra_op_num_threads = self.thread_count
                options.inter_op_num_threads = 1
                # Multiple ONNX graphs otherwise spin idle thread pools while
                # another graph is running on the same four CPU cores.
                options.add_session_config_entry('session.intra_op.allow_spinning', '0')
                options.add_session_config_entry('session.inter_op.allow_spinning', '0')
                return ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])

            def _create_sessions(self):
                tts = self.tts_meta_path.parent
                codec = self.codec_meta_path.parent
                return {
                    'prefill': self._session(tts / self.tts_meta['files']['prefill']),
                    'decode': self._session(tts / self.tts_meta['files']['decode_step']),
                    'local_fixed_sampled_frame': self._session(tts / self.tts_meta['files']['local_fixed_sampled_frame']),
                    'codec_decode_step': self._session(codec / self.codec_meta['files']['decode_step']),
                }

        state['runtime'] = BuiltinRuntime(MODEL_DIR, thread_count=max(1, min(4, int(os.environ.get('MOSS_NANO_THREADS', '4')))),
                                          max_new_frames=MAX_FRAMES, sample_mode='fixed')
        state['tokenizer'] = spm.SentencePieceProcessor(model_file=str(MODEL_DIR / 'MOSS-TTS-Nano-100M-ONNX/tokenizer.model'))
        state['np'] = np
        state['status'] = 'online'
    except Exception as error:
        print(f'Nano initialization failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
        state['status'] = 'offline'


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            ready = state['status'] == 'online'
            return self.json(200 if ready else 503, {'ok': ready, 'status': state['status'], 'device': 'cpu',
                'busy': slot.locked(), 'voices': [v['id'].split(':')[1] for v in VOICES]})
        if self.path == '/voices':
            return self.json(200, {'voices': VOICES})
        self.json(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/tts':
            return self.json(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('Request size must be between 1 and 16384 bytes')
            body = json.loads(self.rfile.read(length))
            text = body.get('text')
            voice = body.get('voice')
            seed = body.get('seed', 1234)
            if not isinstance(text, str) or not text.strip() or len(text) > 1200:
                raise ValueError('Text must contain 1 to 1200 characters')
            if voice not in [v['id'].split(':')[1] for v in VOICES]:
                raise ValueError('Unknown built-in voice')
            if body.get('format', 'wav') != 'wav':
                raise ValueError('Only WAV output is supported')
            if type(seed) is not int or not 0 <= seed <= 4294967295:
                raise ValueError('Seed must be an unsigned 32-bit integer')
        except (ValueError, TypeError, AttributeError):
            self.close_connection = True
            return self.json(400, {'error': 'Invalid synthesis request'})
        if state['status'] != 'online':
            return self.json(503, {'error': 'Nano is unavailable', 'status': state['status']})
        tokens = state['tokenizer'].encode(text.strip(), out_type=int)
        if len(tokens) > 256:
            return self.json(413, {'error': 'Text exceeds the 256-token limit; split it before synthesis'})
        if not slot.acquire(blocking=False):
            return self.json(503, {'error': 'Nano is busy'})
        temp = None
        runtime = state['runtime']
        np = state['np']
        started = time.monotonic()
        decode_seconds = 0

        def checkpoint():
            if time.monotonic() - started > TIMEOUT:
                raise TimeoutError('Synthesis deadline exceeded')
            if select.select([self.connection], [], [], 0)[0]:
                if self.connection.recv(1, socket.MSG_PEEK) == b'':
                    raise ConnectionAbortedError('Client disconnected')

        try:
            reference = next(v for v in runtime.list_builtin_voices() if v['voice'] == voice)
            rows = runtime.build_voice_clone_request_rows(reference['prompt_audio_codes'], tokens)
            runtime.codec_streaming_session.reset()
            runtime.rng = np.random.default_rng(seed)
            pending = []
            samples = 0
            # Anonymous scratch audio is removed by the OS even if the worker
            # is killed. Nothing is published until synthesis reaches EOS.
            temp = tempfile.TemporaryFile()
            with wave.open(temp, 'wb') as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(int(runtime.codec_meta['codec_config']['sample_rate']))

                def decode():
                    nonlocal samples, decode_seconds
                    if not pending:
                        return
                    checkpoint()
                    before = time.monotonic()
                    audio, length = runtime.codec_streaming_session.run_frames(pending)
                    decode_seconds += time.monotonic() - before
                    pending.clear()
                    pcm = audio[0, :, :length].T
                    if not np.isfinite(pcm).all():
                        raise ValueError('Invalid generated audio')
                    wav.writeframesraw((np.clip(pcm, -1, 1) * 32767).astype('<i2').tobytes())
                    samples += length

                def on_frame(_frames, _index, frame):
                    checkpoint()
                    pending.append(frame)
                    if len(pending) >= DECODE_BATCH:
                        decode()

                frames = runtime.generate_audio_frames(rows, on_frame=on_frame)
                if len(frames) >= MAX_FRAMES:
                    raise FrameLimitError('Generation exhausted the frame limit without natural EOS')
                decode()
                if samples == 0:
                    raise ValueError('Empty generated audio')
            checkpoint()
            duration = time.monotonic() - started
            print(json.dumps({'voice': voice, 'seed': seed, 'frames': len(frames), 'seconds': duration,
                              'decodeSeconds': decode_seconds, 'audioSeconds': samples / wav.getframerate()}), flush=True)
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(temp.seek(0, 2)))
            self.end_headers()
            temp.seek(0)
            for block in iter(lambda: temp.read(65536), b''):
                self.wfile.write(block)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as error:
            print(f'Nano synthesis failed (voice={voice}, seed={seed}): {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            failure = {'error': 'Synthesis failed; no audio was published'}
            if isinstance(error, FrameLimitError):
                failure['code'] = 'NANO_FRAME_LIMIT'
            self.json(504 if isinstance(error, TimeoutError) else 422, failure)
        finally:
            runtime.codec_streaming_session.reset()
            if temp:
                temp.close()
            slot.release()


if __name__ == '__main__':
    # Yield CPU time to the web process and interactive host work. Four ONNX
    # threads can still use idle cores; app TTS jobs also share one queue slot.
    if hasattr(os, 'nice'):
        os.nice(10)
    host = os.environ.get('MOSS_NANO_HOST', '127.0.0.1')
    port = int(os.environ.get('MOSS_NANO_PORT', '8768'))
    threading.Thread(target=load_runtime, daemon=True).start()
    ThreadingHTTPServer((host, port), Handler).serve_forever()
