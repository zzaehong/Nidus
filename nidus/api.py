"""Loopback-only, dependency-free JSON API server."""
import json
import logging
import secrets
from http.server import BaseHTTPRequestHandler, HTTPServer
from .application import Application
from .store import Store
from .connections import ConnectionRegistry
from .gateway import ModelError
from .paths import validate_vault_location


class APIServer(HTTPServer):
    def __init__(self, vault, port=8765, host='127.0.0.1'):
        if host != '127.0.0.1':
            raise ValueError('API must bind to 127.0.0.1')
        self.vault = str(validate_vault_location(vault))
        self.token = secrets.token_urlsafe(32)
        super().__init__((host, port), Handler)
        self.origin = 'http://127.0.0.1:' + str(self.server_port)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def log_message(self, format, *args):
        # Do not log request bodies, URLs, session tokens or model material.
        pass

    def reply(self, status, payload, content_type='application/json; charset=utf-8'):
        body = json.dumps(payload, ensure_ascii=False).encode() if isinstance(payload, (dict,list)) else payload
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def trusted(self, mutation=False):
        if self.headers.get('Host') != self.server.origin.removeprefix('http://'):
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != self.server.origin:
            return False
        if self.headers.get('Sec-Fetch-Site') in ('cross-site',):
            return False
        return not mutation or (origin == self.server.origin and
            secrets.compare_digest(self.headers.get('X-Nidus-Token',''), self.server.token))

    def do_GET(self):
        self.handle_request(False)

    def do_POST(self):
        self.handle_request(True)

    def handle_request(self, mutation):
        if not self.trusted(mutation):
            return self.reply(403, {'error':'PERMISSION_DENIED','message':'Local origin and session token required','details':{}})
        if not mutation:
            if self.path == '/api/session':
                return self.reply(200, {'token':self.server.token})
        store = None
        try:
            data = {}
            if mutation:
                if self.headers.get('Content-Type') != 'application/json':
                    raise ValueError('INVALID_REQUEST: JSON content required')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 262144:
                    raise ValueError('INVALID_REQUEST: Request size invalid')
                raw = self.rfile.read(length)
                if self.server.token.encode() in raw:
                    raise ValueError('INVALID_REQUEST: Session material cannot enter Runtime data')
                data = json.loads(raw)
                if self.server.token in json.dumps(data):
                    raise ValueError('INVALID_REQUEST: Session material cannot enter Runtime data')
                if not isinstance(data, dict):
                    raise ValueError('INVALID_REQUEST: JSON object required')
            parts = self.path.strip('/').split('/')
            # Each request owns its SQLite connection. No autonomous worker/scheduler.
            store = Store(self.server.vault)
            if parts[:2] == ['api', 'connections']:
                return self.connection_request(store, parts, mutation, data)
            app = Application(store,getattr(self.server,'credential_store',None))
            if not mutation and self.path == '/api/overview':
                result = app.overview()
            elif not mutation and len(parts)==3 and parts[:2] in (['api','plans'], ['api','tasks']):
                result = app.detail(parts[1], parts[2])
            elif mutation and self.path == '/api/plan-setup' and set(data)=={'request'}:
                result = app.suggest_plan_setup(data['request'])
            elif mutation and self.path == '/api/plans':
                result = app.create_plan(data)
            elif mutation and len(parts)==4 and parts[:2] in (['api','plans'], ['api','tasks']):
                result = app.command(parts[1], parts[2], parts[3], data)
            else:
                return self.reply(404, {'error':'NOT_FOUND','message':'Unknown endpoint','details':{}})
            self.reply(200, result)
        except (ValueError, KeyError, TypeError, OSError) as error:
            message = str(error)
            code = message.split(':',1)[0] if ':' in message and message.split(':',1)[0].isupper() else 'INVALID_REQUEST'
            if mutation and self.path.endswith(('/decision','/quality')) and code == 'INVALID_REQUEST':
                code = 'INVALID_DECISION'
            logging.getLogger(__name__).debug('API request failed', exc_info=True)
            self.reply(409 if code == 'STALE_STATE' else 400, {'error':code,'message':message,'details':{}})
        except Exception:
            logging.getLogger(__name__).exception('API runtime failure')
            self.reply(500, {'error':'RUNTIME_ERROR','message':'Runtime could not complete the request. Check local diagnostics.','details':{}})
        finally:
            if store:
                store.close()

    def connection_request(self, store, parts, mutation, data):
        # Never reflect arbitrary input/backend diagnostics to the client or logs.
        try:
            registry = ConnectionRegistry(store, getattr(self.server, 'credential_store', None))
            if not mutation and len(parts) == 2:
                result = {'providers': registry.providers.list(), 'connections': [
                    dict(c, models=registry.catalog(c['id'])) for c in registry.list()]}
            elif mutation and len(parts) == 2 and set(data) <= {'provider','base_url','secret','name'}:
                result = registry.create(**data)
            elif mutation and len(parts) == 4:
                ident, action = parts[2:]
                if action == 'probe' and not data:
                    result = registry.probe(ident)
                elif action == 'update' and set(data) <= {'base_url','secret'} and data:
                    result = registry.update(ident, **data)
                elif action == 'delete' and not data:
                    result = registry.delete(ident)
                else:
                    raise ModelError('invalid_request')
            else:
                raise ModelError('invalid_request')
            self.reply(200, result)
        except ModelError as error:
            self.reply(400, {'error':error.code,'message':'연결 설정 또는 상태를 확인해 주세요.','details':{}})
        except Exception:
            self.reply(400, {'error':'connection_operation_failed','message':'연결 작업을 완료하지 못했습니다.','details':{}})


def serve(vault, port=8765):
    server = APIServer(vault, port)
    print('Nidus API: ' + server.origin, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
