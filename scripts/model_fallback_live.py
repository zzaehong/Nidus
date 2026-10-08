"""Opt-in real downstream inference after an explicitly injected transport fault.

The loopback fixture never forwards or logs headers/body. This proves Gateway
fallback, not a genuine Gemini/NVIDIA upstream outage or account failover.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-synthetic-transmission', action='store_true', required=True)
    parser.add_argument('--scenario', choices=['fallback', 'fallback-two', 'fallback-auth'], required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    destination = Path(args.evidence)
    if destination.exists():
        parser.error('Evidence already exists; choose a new path')
    status = 401 if args.scenario == 'fallback-auth' else 503

    class Fault(BaseHTTPRequestHandler):
        calls = 0

        def do_POST(self):
            type(self).calls += 1
            self.send_response(status)
            self.send_header('Content-Length', '0')
            self.end_headers()
            self.close_connection = True

        def log_message(self, *unused):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Fault)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fault_url = 'http://127.0.0.1:%s/v1' % server.server_port
    routes = []
    for provider, model in [('gemini', 'gemini/gemini-3.5-flash'),
                            ('nvidia', 'nvidia/nvidia/nemotron-nano-3-30b-a3b'),
                            ('copilot', 'gh/gpt-4o-mini')]:
        injected = provider == 'gemini' or (provider == 'nvidia' and args.scenario == 'fallback-two')
        routes.append({'name': provider + ('-injected-fault' if injected else '-live'),
            'kind': 'paid', 'provider': 'omniroute/' + provider, 'model': model,
            'base_url': fault_url if injected else 'http://127.0.0.1:20128/v1',
            **({} if injected else {'api_key_env': 'NIDUS_VALIDATION_API_KEY'})})
    try:
        with tempfile.TemporaryDirectory(prefix='nidus-fallback-policy-') as directory:
            policy = Path(directory) / 'policy.json'
            policy.write_text(json.dumps({'routes': routes, 'allow_paid': True,
                'timeout_seconds': 60, 'max_tokens': 1024}), encoding='utf-8')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('model_live.py')),
                '--allow-synthetic-transmission', '--policy', str(policy), '--evidence', str(destination)])
        evidence = json.loads(destination.read_text(encoding='utf-8'))
        evidence['fault_injection'] = {'scope': 'local transport fixture; no upstream call for injected routes',
            'http_status': status, 'request_count': Fault.calls,
            'routes': [r['name'] for r in routes if r['base_url'] == fault_url],
            'credentials_forwarded_to_fixture': False}
        attempts = [e for e in evidence['model_events'] if e['kind'] == 'model_attempt_started']
        sequence = [e['data']['route'] for e in attempts]
        expected = [[r['name'] for r in routes[:1]]] if args.scenario == 'fallback-auth' else (
            [[r['name'] for r in routes]] if args.scenario == 'fallback-two' else
            [[r['name'] for r in routes[:2]], [r['name'] for r in routes]])
        evidence['fallback_sequence'] = sequence
        evidence['scenario_checks'] = {'expected_sequence': sequence in expected,
            'expected_state': evidence['status'] == ('blocked' if status == 401 else 'completed'),
            'expected_archive': evidence['archive_count'] == (0 if status == 401 else 1)}
        destination.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return 0 if all(evidence['scenario_checks'].values()) else result.returncode or 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    sys.exit(main())
