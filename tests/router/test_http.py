"""Real loopback HTTP fixtures, never a live external provider."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import asyncio
import json
import socket
import threading

import httpx
import pytest
import uvicorn

from nidus_router.app import create_app
from nidus_router.providers import Provider
from test_providers import fixtures


@pytest.mark.parametrize("kind", ["openai", "anthropic", "gemini", "compatible"])
@pytest.mark.parametrize("stream", [False, True])
async def test_loopback_native_http(store, credentials, add_model, kind, stream):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
            self.end_headers()
            payload = fixtures(kind, stream)
            if stream:
                wire = b"".join(("data: " + json.dumps(e, ensure_ascii=False) + "\n\n").encode() for e in payload)
            else:
                wire = json.dumps(payload, ensure_ascii=False).encode()
            for start in range(0, len(wire), 5):
                self.wfile.write(wire[start:start + 5])
                self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        model = add_model(provider=kind, pricing="free")
        snapshot = store.snapshot()
        connection = snapshot["connections"][model["connection_id"]]
        connection["base_url"] = f"http://127.0.0.1:{server.server_port}/v1"
        async with httpx.AsyncClient(trust_env=False) as client:
            events = [e async for e in Provider(client).events(connection, model,
                credentials.get(connection["credential_ref"]), "instructions", "test input", snapshot["settings"], stream)]
        assert "".join(e["text"] for e in events if e["type"] == "text") == "안녕"
        assert requests and "instructions" in json.dumps(requests[0][1])
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("stream", [False, True])
async def test_disconnect_cancels_upstream_and_keeps_uncertain_budget(store, credentials, add_model, stream):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    store.save_settings(store.snapshot()["settings"] | {"monthly_budget_usd": 1, "approved_model_ids": [model["id"]]})
    api_key = store.initialize_tokens()["api"]
    closed = threading.Event()

    class BlockingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' if stream else b'{'
            await asyncio.sleep(30)

        async def aclose(self):
            closed.set()

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=BlockingStream())))
    app = create_app(store=store, secrets=credentials, client=upstream, port=port)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.02)
        assert server.started
        async with httpx.AsyncClient(trust_env=False, timeout=2) as client:
            if stream:
                async with client.stream("POST", f"http://127.0.0.1:{port}/api/v1/generate",
                        headers={"Authorization": "Bearer " + api_key}, json={"input": "x", "stream": True}) as result:
                    assert result.status_code == 200
                    async for line in result.aiter_lines():
                        if line.startswith("data:"):
                            break
            else:
                with pytest.raises(httpx.ReadTimeout):
                    await client.post(f"http://127.0.0.1:{port}/api/v1/generate", timeout=0.3,
                        headers={"Authorization": "Bearer " + api_key}, json={"input": "x"})
        for _ in range(100):
            if closed.is_set() and store.records():
                break
            await asyncio.sleep(0.02)
        assert closed.is_set(), "upstream was not cancelled on disconnect"
        assert store.records()[0]["error"] == "cancelled"
        assert store.budget()["used_and_reserved_usd"] > 0
    finally:
        server.should_exit = True
        await asyncio.to_thread(thread.join, 3)
        sock.close()
        await upstream.aclose()


@pytest.mark.parametrize("kind", ["openai", "anthropic", "gemini", "compatible"])
async def test_loopback_model_discovery(store, credentials, kind):
    from nidus_router.discovery import Discovery
    from test_discovery import connection
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            requests.append(self.path)
            body = {"models": [{"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]}]} if kind == "gemini" else {"data": [{"id": "gpt-4.1-mini", "type": "model"}]}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            wire = json.dumps(body).encode()
            for i in range(0, len(wire), 3):
                self.wfile.write(wire[i:i+3])
                self.wfile.flush()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        c = connection(store, credentials, kind)
        c = store.save_connection(c | {"base_url": f"http://127.0.0.1:{server.server_port}/v1"}, c["id"])
        async with httpx.AsyncClient(trust_env=False) as client:
            result = await Discovery(store, credentials, client).refresh(c["id"])
        assert result["status"] == "success" and len(requests) == 1
        model = next(iter(store.snapshot()["models"].values()))
        assert model["pricing"] == "unknown"  # Official rates never apply to custom URLs.
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
