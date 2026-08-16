import json
import mimetypes
import os
import shutil
import tempfile
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


class XandrioRequestError(Exception):
    pass


def normalize_server_url(value):
    url = str(value or '').strip().rstrip('/')
    if not (url.startswith('https://') or url.startswith('http://')):
        raise XandrioRequestError('Enter a complete http:// or https:// Xandrio address.')
    return url


def _response_json(response):
    raw = response.read()
    if not raw:
        return {}
    try:
        return json.loads(raw.decode('utf-8'))
    except Exception as error:
        raise XandrioRequestError('Xandrio returned an unreadable response.') from error


def request_json(server_url, path, token='', method='GET', payload=None, timeout=30):
    url = urljoin(normalize_server_url(server_url) + '/', path.lstrip('/'))
    body = None
    headers = {'Accept': 'application/json', 'User-Agent': 'Xandrio-Calibre/1.0'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if payload is not None:
        body = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            return _response_json(response)
    except HTTPError as error:
        try:
            detail = _response_json(error).get('error')
        except Exception:
            detail = None
        raise XandrioRequestError(detail or 'Xandrio rejected the request (HTTP %s).' % error.code) from error
    except (URLError, OSError) as error:
        raise XandrioRequestError('Could not reach Xandrio: %s' % getattr(error, 'reason', error)) from error


def _write_file_header(payload, boundary, name, filename, content_type):
    payload.write(('--' + boundary + '\r\n').encode('ascii'))
    payload.write(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (name, filename)).encode('utf-8'))
    payload.write(('Content-Type: %s\r\n\r\n' % content_type).encode('ascii'))


def _multipart_payload(fields, file_path, cover_bytes=None):
    boundary = '----xandrio-calibre-' + uuid.uuid4().hex
    payload = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode='w+b')
    for name, value in fields.items():
        payload.write(('--' + boundary + '\r\n').encode('ascii'))
        payload.write(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode('utf-8'))
        payload.write(str(value).encode('utf-8'))
        payload.write(b'\r\n')
    filename = os.path.basename(file_path).replace('"', '')
    content_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    _write_file_header(payload, boundary, 'book', filename, content_type)
    with open(file_path, 'rb') as book_file:
        shutil.copyfileobj(book_file, payload, length=1024 * 1024)
    payload.write(b'\r\n')
    if cover_bytes:
        _write_file_header(payload, boundary, 'cover', 'cover.jpg', 'image/jpeg')
        payload.write(cover_bytes)
        payload.write(b'\r\n')
    payload.write(('--' + boundary + '--\r\n').encode('ascii'))
    length = payload.tell()
    payload.seek(0)
    return boundary, payload, length


def upload_book(server_url, token, metadata, file_path, cover_bytes=None, timeout=300):
    boundary, body, content_length = _multipart_payload({'metadata': json.dumps(metadata)}, file_path, cover_bytes)
    url = urljoin(normalize_server_url(server_url) + '/', 'api/integrations/calibre/import')
    headers = {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': str(content_length),
        'User-Agent': 'Xandrio-Calibre/1.0'
    }
    try:
        for attempt in range(3):
            body.seek(0)
            request = Request(url, data=body, headers=headers, method='POST')
            try:
                with urlopen(request, timeout=timeout) as response:
                    return _response_json(response)
            except HTTPError as error:
                retryable = error.code in (429, 503) and attempt < 2
                if retryable:
                    time.sleep(1 + attempt)
                    continue
                try:
                    detail = _response_json(error).get('error')
                except Exception:
                    detail = None
                raise XandrioRequestError(detail or 'Import failed (HTTP %s).' % error.code) from error
            except (URLError, OSError) as error:
                if attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                raise XandrioRequestError('Upload failed: %s' % getattr(error, 'reason', error)) from error
    finally:
        body.close()
