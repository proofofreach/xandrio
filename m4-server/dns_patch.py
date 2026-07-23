"""Conditional DNS-over-HTTPS bypass for OpenDNS-filtered networks.

Some networks resolve huggingface.co to OpenDNS block IPs (146.112.x.x),
which fail the SSL handshake. This patch detects that condition and, only
then, resolves *.huggingface.co / *.hf.co via Cloudflare DoH instead.
On clean networks it is a no-op (unconditional patching stalls downloads).

Usage: import dns_patch; dns_patch.apply()
"""

import json
import logging
import socket
import urllib.request

log = logging.getLogger("dns-patch")

_HF_SUFFIXES = ("huggingface.co", "hf.co")
_applied = False
_orig_getaddrinfo = socket.getaddrinfo


def _system_dns_is_poisoned() -> bool:
    try:
        infos = _orig_getaddrinfo("huggingface.co", 443, proto=socket.IPPROTO_TCP)
        return any(addr[4][0].startswith("146.112.") for addr in infos)
    except socket.gaierror:
        return False


def _doh_resolve(host: str) -> list:
    req = urllib.request.Request(
        f"https://1.1.1.1/dns-query?name={host}&type=A",
        headers={"accept": "application/dns-json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    return [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]


def apply() -> bool:
    """Patch socket.getaddrinfo if the system DNS filters huggingface.co.

    Returns True if the patch was applied.
    """
    global _applied
    if _applied:
        return True
    if not _system_dns_is_poisoned():
        return False

    cache = {}

    def patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        if isinstance(host, str) and any(
            host == s or host.endswith("." + s) for s in _HF_SUFFIXES
        ):
            if host not in cache:
                try:
                    cache[host] = _doh_resolve(host)
                except Exception as err:
                    log.warning("DoH resolution failed for %s: %s", host, err)
                    cache[host] = []
            ips = cache.get(host) or []
            if ips:
                return [
                    (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port))
                    for ip in ips
                ]
        return _orig_getaddrinfo(host, port, family, type, proto, flags)

    socket.getaddrinfo = patched_getaddrinfo
    _applied = True
    log.info("System DNS filters huggingface.co; DoH bypass active for HF hosts")
    return True
