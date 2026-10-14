"""Isolated UI fixture server; no real keys, keychain entries or provider calls.

Usage: python tests/router/preview.py /tmp/nidus-router-preview-info.json
"""
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import httpx
import uvicorn

from nidus_router.app import create_app
from nidus_router.store import Store
from conftest import MemorySecrets, response


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="nidus-router-ui-") as directory:
        store = Store(directory)
        tokens = store.initialize_tokens()
        info = Path(sys.argv[1])
        fd = os.open(info, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(tokens, file)

        def upstream(request):
            if request.method == "GET":
                return httpx.Response(200, json={"models": [
                    {"name": "models/" + name, "supportedGenerationMethods": ["generateContent"]}
                    for name in ("gemini-2.5-flash", "gemini-2.5-flash-lite")]})
            payload = json.loads(request.content)
            if "systemInstruction" in payload:
                prompt = payload["systemInstruction"]["parts"][0]["text"]
                text = '{"category":"positive"}' if "JSON" in prompt else "로컬 테스트 응답입니다."
                if "연결 오류" in json.dumps(payload, ensure_ascii=False) and "flash-lite:" in request.url.path:
                    return httpx.Response(503)
                return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
                    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3}})
            prompt = payload.get("messages", [{}])[0].get("content", "")
            return response('{"category":"positive"}' if "JSON" in prompt else "로컬 테스트 응답입니다.")

        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        app = create_app(store=store, secrets=MemorySecrets(), client=client, port=18787)
        try:
            uvicorn.run(app, host="127.0.0.1", port=18787, access_log=False, proxy_headers=False)
        finally:
            info.unlink(missing_ok=True)
