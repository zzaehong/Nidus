from contextlib import aclosing
import json

import httpx
import pytest

from nidus_router.errors import RouterError
from nidus_router.providers import Provider
from nidus_router.router import Router
from nidus_router.schemas import Generate


class SplitStream(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data, self.closed = data, False

    async def __aiter__(self):
        for offset in range(0, len(self.data), 7):
            yield self.data[offset:offset + 7]

    async def aclose(self):
        self.closed = True


def fixtures(kind, stream):
    if kind in ("openai", "compatible"):
        if stream:
            return [{"choices": [{"delta": {"content": "안녕"}, "finish_reason": None}]},
                    {"choices": [{"delta": {}, "finish_reason": "stop"}]},
                    {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 3}}]
        return {"choices": [{"message": {"content": "안녕"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3}}
    if kind == "anthropic":
        if stream:
            return [{"type": "message_start", "message": {"usage": {"input_tokens": 10, "output_tokens": 0}}},
                    {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "안녕"}},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}]
        return {"content": [{"type": "text", "text": "안녕"}], "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 3}}
    body = {"candidates": [{"content": {"parts": [{"text": "안녕"}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3}}
    return [body] if stream else body


@pytest.mark.parametrize("kind", ["openai", "compatible", "anthropic", "gemini"])
@pytest.mark.parametrize("stream", [False, True])
async def test_native_protocols(store, credentials, add_model, kind, stream):
    model = add_model(provider=kind, pricing="free")
    snapshot = store.snapshot()
    connection = snapshot["connections"][model["connection_id"]]
    payload = fixtures(kind, stream)
    wire = SplitStream(b"".join(("data: " + json.dumps(p, ensure_ascii=False) + "\r\n\r\n").encode()
                               for p in payload)) if stream else None
    captured = []
    def handler(req):
        captured.append(req)
        return httpx.Response(200, stream=wire) if stream else httpx.Response(200, json=payload)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        events = [e async for e in Provider(client).events(connection, model, credentials.get(connection["credential_ref"]),
                    "system instructions", "user input", snapshot["settings"], stream)]
    body = json.loads(captured[0].content)
    assert "system instructions" in captured[0].content.decode()
    assert "user input" in captured[0].content.decode()
    assert credentials.get(connection["credential_ref"]) not in captured[0].content.decode()
    assert "".join(e["text"] for e in events if e["type"] == "text") == "안녕"
    assert any(e.get("ok") for e in events)
    usage = {k: v for e in events if e["type"] == "usage" for k, v in e.items() if v is not None}
    assert usage["input_tokens"] == 10 and usage["output_tokens"] == 3
    if stream:
        assert wire.closed
    if kind == "gemini":
        assert "x-goog-api-key" in captured[0].headers
    elif kind == "anthropic":
        assert body["system"] == "system instructions"
        assert captured[0].headers["anthropic-version"] == "2023-06-01"
    else:
        assert body["messages"][0]["role"] == "system"


async def test_stream_failure_after_delta_does_not_fallback(store, credentials, add_model):
    add_model(pricing="free")
    add_model(pricing="free")
    calls = []
    wire = SplitStream(b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    def handler(req):
        calls.append(req)
        return httpx.Response(200, stream=wire)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        router = Router(store, credentials, client)
        request = Generate(input="x", stream=True)
        events = router.run(request, "partial", router.prepare(request))
        assert (await anext(events))["event"] == "delta"
        with pytest.raises(RouterError, match="invalid_output"):
            await anext(events)
    assert len(calls) == 1 and wire.closed


async def test_closing_stream_closes_upstream_and_audits(store, credentials, add_model):
    add_model(pricing="free")
    wire = SplitStream(b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=wire))) as client:
        router = Router(store, credentials, client)
        request = Generate(input="x", stream=True)
        async with aclosing(router.run(request, "cancel", router.prepare(request))) as events:
            await anext(events)
    assert wire.closed
    assert store.records()[0]["error"] == "cancelled"
