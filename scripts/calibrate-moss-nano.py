"""Audition every pinned built-in voice and record fixed per-voice mastering gains.

Run against an isolated Nano worker, never the live listening worker. Fail on
HTTP errors, missing/empty audio, inaudible speech or nonfinite measurements.
Writes first takes and a proposed calibration; does not change application code.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = {
    'en': 'The morning sun cast golden light through the library windows, illuminating rows of books. She opened a book and began to read.',
    'zh': '清晨的阳光照进图书馆，照亮了整齐的书架。她打开一本书，开始安静地阅读。窗外传来了鸟儿的歌声。',
    'ja': '朝の光が図書館の窓から差し込みました。彼女は静かに本を開きました。窓の外から鳥の声が聞こえました。'
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:18768')
    parser.add_argument('--output', type=Path, default=ROOT / 'output/moss-nano/calibration')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'renderRevision': 'stream8-fixed-seed1234-v1', 'targetLufs': -18,
              'sources': json.loads((ROOT / 'moss-nano/models.lock.json').read_text())['sources'], 'voices': {}}
    for voice in json.loads((ROOT / 'moss-nano/voices.json').read_text()):
        name = voice['id'].split(':')[1]
        text = SAMPLES[voice['languageCode']]
        request = urllib.request.Request(args.url + '/tts', data=json.dumps({'text': text, 'voice': name, 'format': 'wav'}).encode(),
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=190) as response:
            data = response.read()
        assert len(data) > 1000, name
        source = args.output / f'{name}.wav'
        source.write_bytes(data)
        # Analyze after the same trim, downmix and resampling used in playback.
        filters = 'silenceremove=start_periods=1:start_silence=0.10:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_silence=0.15:start_threshold=-45dB,areverse,aformat=channel_layouts=mono,aresample=24000,loudnorm=I=-18:print_format=json'
        process = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(source), '-af', filters, '-f', 'null', '-'],
                                 capture_output=True, text=True, check=True)
        measurement = json.JSONDecoder().raw_decode(process.stderr[process.stderr.rfind('{'):])[0]
        lufs = float(measurement['input_i'])
        assert math.isfinite(lufs) and lufs > -60, name
        report['voices'][name] = {'text': text, 'rawMonoLufs': lufs, 'gainDb': round(-18 - lufs, 1),
                                  'rawSha256': hashlib.sha256(data).hexdigest()}
        (args.output / 'calibration.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(name, report['voices'][name]['gainDb'], flush=True)


if __name__ == '__main__':
    main()
