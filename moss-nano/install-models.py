"""Explicit, pinned model installation. Playback never invokes this program."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

LOCK = json.loads((Path(__file__).parent / 'models.lock.json').read_text())


def valid(path, spec):
    if not path.is_file() or path.stat().st_size != spec['bytes']:
        return False
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest() == spec['sha256']


def verify(directory):
    missing = [spec['path'] for spec in LOCK['files'] if not valid(directory / spec['path'], spec)]
    if missing:
        raise FileNotFoundError('Missing or invalid Nano model files: ' + ', '.join(missing))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    if not args.verify_only:
        for spec in LOCK['files']:
            target = args.directory / spec['path']
            if valid(target, spec):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_suffix(target.suffix + '.part')
            try:
                request = urllib.request.Request(spec['url'], headers={'User-Agent': 'ChatGPT-User/1.0'})
                with urllib.request.urlopen(request, timeout=120) as response, temp.open('wb') as file:
                    for block in iter(lambda: response.read(1024 * 1024), b''):
                        file.write(block)
                if not valid(temp, spec):
                    raise ValueError('Model checksum mismatch: ' + spec['path'])
                temp.replace(target)
                print(spec['path'], flush=True)
            finally:
                temp.unlink(missing_ok=True)
    verify(args.directory)
    print('Pinned Nano models verified')


if __name__ == '__main__':
    main()
