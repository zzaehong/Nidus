import asyncio
import json
import secrets

import httpx
import pytest

from nidus_router.catalog import quote, model_status
from nidus_router.discovery import Discovery, list_models
from nidus_router.errors import RouterError
from nidus_router.router import Router
from nidus_router.schemas import Connection, Generate, Model
from nidus_router.store import Store, identifier
from conftest import response


def connection(store, credentials, provider="openai", **changes):
    ref = identifier()
    credentials.set(ref, secrets.token_urlsafe(24))
    base = {"openai": "https://api.openai.com/v1", "anthropic": "https://api.anthropic.com/v1",
            "gemini": "https://generativelanguage.googleapis.com/v1beta",
            "compatible": "https://fixture.invalid/v1"}[provider]
    return store.save_connection(Connection(name=provider, provider=provider, base_url=base,
                                            **changes).model_dump(exclude={"api_key"}) | {"credential_ref": ref})


def rows(*ids):
    return [{"upstream_model": x, "name": x, "support": "supported"} for x in ids]


@pytest.mark.parametrize("kind", ["openai", "anthropic", "gemini", "compatible"])
async def test_paginated_listing_headers_and_filter(store, credentials, kind):
    c = connection(store, credentials, kind)
    key = credentials.get(c["credential_ref"])
    calls = []
    def handler(req):
        calls.append(req)
        assert req.method == "GET" and req.url.path.endswith("/models")
        assert key not in str(req.url)
        assert req.headers.get({"anthropic": "x-api-key", "gemini": "x-goog-api-key"}.get(kind, "authorization")) == (key if kind in ("anthropic", "gemini") else "Bearer " + key)
        if kind == "gemini":
            if len(calls) == 1:
                return httpx.Response(200, json={"models": [
                    {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                    {"name": "models/embedding", "supportedGenerationMethods": ["embedContent"]}], "nextPageToken": "next"})
            assert req.url.params["pageToken"] == "next"
            return httpx.Response(200, json={"models": [{"name": "models/gemini-2.5-flash-lite", "supportedGenerationMethods": ["generateContent"]}]})
        if len(calls) == 1:
            return httpx.Response(200, json={"data": [{"id": "gpt-4o-mini"}, {"id": "text-embedding-3-small"}], "has_more": True, "last_id": "next"})
        assert req.url.params["after_id" if kind == "anthropic" else "after"] == "next"
        return httpx.Response(200, json={"data": [{"id": "new-text"}], "has_more": False})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        found = await list_models(client, c, key)
    assert len(found) == 2 and len(calls) == 2
    assert all("embedding" not in m["upstream_model"] for m in found)


@pytest.mark.parametrize("body", [{"data": {}}, {"data": [{"id": "bad name"}]},
                                   {"data": [], "has_more": True}, {"error": "private upstream body"}])
async def test_invalid_listing_not_empty_success(store, credentials, body):
    c = connection(store, credentials)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))) as client:
        discovery = Discovery(store, credentials, client)
        result = await discovery.refresh(c["id"])
    assert result["status"] == "error"
    assert "private upstream body" not in json.dumps(store.snapshot())


async def test_refresh_preserves_settings_missing_return_and_restart(store, credentials):
    c = connection(store, credentials, "gemini", billing_tier="free")
    store.apply_discovery(c, rows("gemini-2.5-flash", "gemini-2.5-flash-lite"))
    models = list(store.snapshot()["models"].values())
    first = models[0]
    assert first["pricing"] == "free"
    first = store.save_model(first | {"enabled": False, "prompt_override": "mine", "priority": 12,
                                      "fallback_ids": [models[1]["id"]]}, first["id"])
    store.apply_discovery(c, rows("gemini-2.5-flash", "gemini-2.5-flash-lite"))
    assert store.snapshot()["models"][first["id"]] == first
    store.apply_discovery(c, [])
    assert store.snapshot()["models"][first["id"]]["availability"] == "missing"
    store.apply_discovery(c, None, "provider_unavailable")
    assert len(store.snapshot()["models"]) == 2
    store.apply_discovery(c, rows(first["upstream_model"]))
    restored = Store(store.directory).snapshot()["models"][first["id"]]
    assert restored["availability"] == "available" and not restored["enabled"]
    assert restored["prompt_override"] == "mine" and restored["fallback_ids"] == first["fallback_ids"]


def test_prices_account_confirmation_custom_and_approval(store, credentials, monkeypatch):
    c = connection(store, credentials, "gemini")
    store.apply_discovery(c, rows("gemini-2.5-flash"))
    m = next(iter(store.snapshot()["models"].values()))
    assert m["pricing"] == "unknown"
    c = store.save_connection(c | {"billing_tier": "paid"}, c["id"])
    store.apply_discovery(c, rows("gemini-2.5-flash"))
    m = store.snapshot()["models"][m["id"]]
    store.save_settings(store.snapshot()["settings"] | {"approved_model_ids": [m["id"]], "monthly_budget_usd": 1})
    store.apply_discovery(c, rows("gemini-2.5-flash", "gemini-2.5-flash-lite"))
    assert store.snapshot()["settings"]["approved_model_ids"] == [m["id"]]
    from nidus_router.catalog import RATES
    monkeypatch.setitem(RATES["gemini"], "gemini-2.5-flash", (1, 5, True))
    store.apply_discovery(c, rows("gemini-2.5-flash"))
    assert store.snapshot()["settings"]["approved_model_ids"] == []
    manual = store.save_model(m | {"input_per_million": 7}, m["id"])
    store.apply_discovery(c, rows("gemini-2.5-flash"))
    assert store.snapshot()["models"][m["id"]]["input_per_million"] == 7
    assert manual["pricing_origin"] == "manual"
    assert quote(c | {"base_url": "https://custom.invalid/v1"}, "gemini-2.5-flash") is None
    assert quote(c, "gemini-complex-future") is None


async def test_coalescing_throttle_and_cancelled_waiter(store, credentials):
    c = connection(store, credentials)
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def handler(req):
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return httpx.Response(200, json={"data": [{"id": "gpt-4.1-mini"}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        d = Discovery(store, credentials, client)
        first = asyncio.create_task(d.refresh(c["id"], automatic=True))
        await started.wait()
        second = asyncio.create_task(d.refresh(c["id"], automatic=True))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert (await second)["status"] == "success"
        assert (await d.refresh(c["id"], automatic=True))["throttled"]
        assert calls == 1
        await d.refresh(c["id"])
        assert calls == 2
        await d.close()


def test_stale_identity_results_rejected_and_pending(store, credentials):
    c = connection(store, credentials)
    store.apply_discovery(c, rows("gpt-4.1-mini"))
    changed = store.save_connection(c | {"base_url": "https://new.invalid/v1"}, c["id"])
    assert store.apply_discovery(c, rows("gpt-4o-mini"))["status"] == "superseded"
    assert next(iter(store.snapshot()["models"].values()))["availability"] == "pending"
    assert store.apply_discovery(changed, [])["status"] == "success"


async def test_refresh_excludes_missing_but_new_models_wait_for_next_request(store, credentials, add_model):
    c = connection(store, credentials, "gemini", billing_tier="free")
    store.apply_discovery(c, rows("gemini-2.5-flash", "gemini-2.5-flash-lite"))
    models = list(store.snapshot()["models"].values())
    other = add_model(pricing="free", priority=999)
    calls = []
    def handler(req):
        calls.append(req)
        if req.method == "GET":
            return httpx.Response(200, json={"models": [{"name": "models/new-text", "supportedGenerationMethods": ["generateContent"]}]})
        if "googleapis" in req.url.host:
            return httpx.Response(404)
        return response()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r = Router(store, credentials, client)
        request = Generate(input="x", model=models[0]["id"])
        result = [e async for e in r.run(request, "refresh-route", r.prepare(request))]
    assert result[-1]["data"]["model"] == other["id"]
    assert [req.method for req in calls] == ["POST", "GET", "POST"]
    assert store.records()[0]["attempts"][0]["refresh"]["status"] == "success"
    assert len(store.snapshot()["models"]) == 4


@pytest.mark.parametrize("status,refresh", [(401, True), (403, True), (404, True), (500, True), (408, True), (429, False), (400, False)])
async def test_refresh_error_matrix(store, credentials, add_model, status, refresh):
    first = add_model(pricing="free", priority=0)
    second = add_model(pricing="free", priority=1)
    calls = []
    def handler(req):
        calls.append(req.method)
        if req.method == "GET":
            return httpx.Response(503)
        return httpx.Response(status) if calls.count("POST") == 1 else response()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r = Router(store, credentials, client)
        request = Generate(input="x", model=first["id"])
        if status == 400:
            with pytest.raises(RouterError):
                _ = [e async for e in r.run(request, "matrix", r.prepare(request))]
        else:
            result = [e async for e in r.run(request, "matrix", r.prepare(request))]
            assert result[-1]["data"]["model"] == second["id"]
    assert calls.count("GET") == int(refresh)


async def test_connection_refresh_api_auth_no_secret_and_automatic_registration(store, credentials):
    from nidus_router.app import create_app
    tokens = store.initialize_tokens()
    key = secrets.token_urlsafe(24)
    calls = []
    def handler(req):
        calls.append(req.method)
        return httpx.Response(200, json={"data": [{"id": "gpt-4.1-mini"}, {"id": "text-embedding-3-small"}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
        app = create_app(store=store, secrets=credentials, client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8787") as client:
            client.headers["Origin"] = "http://127.0.0.1:8787"
            assert (await client.post("/admin/connections/missing/refresh")).status_code == 401
            await client.post("/admin/login", json={"token": tokens["admin"]})
            saved = await client.post("/admin/connections", json={"name": "test", "provider": "openai",
                "base_url": "https://api.openai.com/v1", "api_key": key})
            assert saved.status_code == 201
            assert key not in saved.text
            state = (await client.get("/admin/state")).json()
            assert len(state["models"]) == 1 and state["models"][0]["status"] == "approval_required"
            assert key not in json.dumps(state) and "credential_ref" not in json.dumps(state)
            client.headers["Authorization"] = "Bearer " + tokens["api"]
            models = (await client.get("/api/v1/models")).json()["models"]
            assert models[0]["status"] == "approval_required"
            await client.post(f'/admin/connections/{saved.json()["id"]}/refresh')
            assert len(store.snapshot()["models"]) == 1
    assert calls == ["GET", "GET"]


async def test_snapshot_fallback_order_once_per_connection_and_no_recursive_expansion(store, credentials):
    c = connection(store, credentials, "compatible")
    def add(name, priority):
        return store.save_model(Model(connection_id=c["id"], name=name, upstream_model=name,
                                      pricing="free", priority=priority).model_dump())
    preferred, explicit, automatic = add("preferred", 2), add("explicit", 9), add("automatic", 0)
    store.save_model(preferred | {"fallback_ids": [explicit["id"]]}, preferred["id"])
    calls = []
    def handler(req):
        if req.method == "GET":
            calls.append("refresh")
            return httpx.Response(200, json={"data": [{"id": "new-model"}]})
        calls.append(json.loads(req.content)["model"])
        return httpx.Response(503)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r = Router(store, credentials, client)
        request = Generate(input="x", model=preferred["id"])
        with pytest.raises(RouterError, match="provider_unavailable"):
            _ = [e async for e in r.run(request, "ordered", r.prepare(request))]
    assert calls == ["preferred", "refresh", "explicit", "automatic"]


async def test_stream_failure_refreshes_without_switching(store, credentials, add_model):
    first = add_model(pricing="free", priority=0)
    add_model(pricing="free", priority=1)
    calls = []
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            raise httpx.ReadError("not exposed")
    def handler(req):
        calls.append(req.method)
        return httpx.Response(200, stream=Broken()) if req.method == "POST" else httpx.Response(200, json={"data": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r = Router(store, credentials, client)
        request = Generate(input="x", stream=True)
        events = r.run(request, "stream-refresh", r.prepare(request))
        assert (await anext(events))["data"]["model"] == first["id"]
        with pytest.raises(RouterError, match="provider_unavailable"):
            await anext(events)
    assert calls == ["POST", "GET"]
    assert store.records()[0]["attempts"][0]["refresh"]["status"] == "success"


async def test_cancel_during_refresh_retains_cancel_record(store, credentials, add_model):
    add_model(pricing="free")
    started, release = asyncio.Event(), asyncio.Event()
    async def handler(req):
        if req.method == "POST":
            return httpx.Response(503)
        started.set()
        await release.wait()
        return httpx.Response(200, json={"data": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        r = Router(store, credentials, client)
        request = Generate(input="x")
        async def run():
            return [e async for e in r.run(request, "cancel-refresh", r.prepare(request))]
        task = asyncio.create_task(run())
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert store.records()[0]["error"] == "cancelled"
        release.set()
        await r.discovery.close()


async def test_listing_loop_and_redirect_preserve_previous_models(store, credentials):
    c = connection(store, credentials)
    store.apply_discovery(c, rows("gpt-4.1-mini"))
    for reply in [httpx.Response(302, headers={"Location": "https://elsewhere.invalid/models"}),
                  httpx.Response(200, json={"data": [], "has_more": True, "last_id": "repeat"})]:
        calls = []
        def handler(req):
            calls.append(req)
            return reply
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
            result = await Discovery(store, credentials, client).refresh(c["id"])
        assert result["status"] == "error"
        assert all(req.url.host == "api.openai.com" for req in calls)
        assert len(calls) <= 2
        assert next(iter(store.snapshot()["models"].values()))["availability"] == "available"


def test_migration_from_v1_preserves_manual_config_and_budget(store, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    store.save_settings(store.snapshot()["settings"] | {"approved_model_ids": [model["id"]], "monthly_budget_usd": 1})
    with store.db(True) as db:
        db.execute("PRAGMA user_version=1")
    before = store.snapshot()
    restored = Store(store.directory)
    assert restored.snapshot() == before
    with restored.db() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2


def test_unknown_support_confirmation_can_be_revoked(store, credentials):
    c = connection(store, credentials, "compatible")
    store.apply_discovery(c, [{"upstream_model": "custom", "name": "custom", "support": "unknown"}])
    model = next(iter(store.snapshot()["models"].values()))
    model = store.save_model(model | {"pricing": "free", "capability_confirmed": True}, model["id"])
    assert model_status(model, c, store.snapshot()["settings"]) == "available"
    model = store.save_model(model | {"capability_confirmed": False}, model["id"])
    assert model_status(model, c, store.snapshot()["settings"]) == "support_required"
