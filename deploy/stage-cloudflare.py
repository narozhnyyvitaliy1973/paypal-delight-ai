#!/usr/bin/env python3
"""Read an allowlisted configuration via SSH stdin. Stage only; never call an API."""
import json
import os
import re
import sys
from pathlib import Path

def prepare(runtime, payload):
    patterns = {
        'AI_PROVIDER': r'cloudflare', 'AI_ENABLED': r'true',
        'CLOUDFLARE_ACCOUNT_ID': r'[a-fA-F0-9]{32}', 'CLOUDFLARE_API_TOKEN': r'[A-Za-z0-9_-]{20,256}',
        'CLOUDFLARE_MODEL': r'@cf/black-forest-labs/flux-2-klein-4b',
        'AI_LAB_ENABLED': r'true', 'AI_LAB_PROXY_TOKEN': r'[a-f0-9]{64}',
        'AI_TIMEOUT_MS': r'\d+', 'AI_MAX_CONCURRENT': r'\d+', 'AI_DAILY_REQUEST_LIMIT': r'\d+',
        'AI_SESSION_DAILY_REQUEST_LIMIT': r'\d+', 'AI_DAILY_NEURON_LIMIT': r'\d+',
        'DATABASE_PATH': r'/var/www/paypal-delight-ai/shared/delight-stage5\.sqlite',
    }
    if set(payload) != set(patterns) or any(not isinstance(payload[k], str) or not re.fullmatch(p, payload[k]) for k, p in patterns.items()):
        raise ValueError('Invalid configuration')
    for key, maximum in [('AI_TIMEOUT_MS', 240000), ('AI_MAX_CONCURRENT', 4), ('AI_DAILY_REQUEST_LIMIT', 100), ('AI_SESSION_DAILY_REQUEST_LIMIT', 100), ('AI_DAILY_NEURON_LIMIT', 9000)]:
        if not 1 <= int(payload[key]) <= maximum:
            raise ValueError('Invalid limit')
    # Keep PayPal/origin settings; use a separate Stage 5 DB without migrating Stage 4.
    lines = [line for line in runtime.splitlines() if not any(re.match(r'^\s*(?:export\s+)?' + key + r'\s*=', line) for key in patterns)]
    lines.extend(key + '=' + value for key, value in payload.items())
    return '\n'.join(lines) + '\n', 'set $delight_lab_token "' + payload['AI_LAB_PROXY_TOKEN'] + '";\n'

def stage(release_id, payload, root=Path('/etc/paypal-delight-ai')):
    if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{7,40}', release_id):
        raise ValueError('Invalid release')
    runtime, nginx = prepare((root / 'runtime.env').read_text(), payload)
    os.umask(0o077)
    # Distinct files: a failed upload never overwrites the active configuration.
    for suffix, text in [('env', runtime), ('conf', nginx)]:
        path = root / ('next-' + release_id + '.' + suffix)
        with path.open('x', encoding='utf-8', newline='\n') as output:
            output.write(text)

if __name__ == '__main__':
    try:
        stage(sys.argv[1], json.loads(sys.stdin.read(16384)))
    except Exception:
        print('Private configuration staging failed.', file=sys.stderr)
        sys.exit(1)
    print('Configuration staged; no service changes.')
