import json
import secrets

import httpx
import pytest

from nidus_router.app import create_app
from nidus_router.schemas import Connection
from nidus_router.secrets import OSSecrets
from conftest import response
from test_providers import SplitStream

ORIGIN = "http://127.0.0.1:8787"


@pytest.fixture
async def api_client(store, credentials):
    tokens = store.initialize_tokens()
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: response()))
    app = create_app(store=store, secrets=credentials, client=upstream)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 1234)),
                                base_url=ORIGIN) as client:
        client.tokens = tokens
        client.upstream = upstream
        client.app = app
        yield client
    await upstream.aclose()


async def login(client):
    result = await client.post("/admin/login", json={"token": client.tokens["admin"]}, headers={"Origin": ORIGIN})
    assert result.status_code == 200


async def test_auth_boundaries_host_origin_and_token_separation(api_client):
    client = api_client
    assert (await client.get("/admin/state")).status_code == 401
    assert (await client.get("/api/v1/models", headers={"Authorization": "Bearer " + client.tokens["admin"]})).status_code == 401
    assert (await client.post("/admin/login", json={"token": client.tokens["admin"]})).status_code == 403
    assert (await client.post("/admin/login", json={"token": client.tokens["api"]}, headers={"Origin": ORIGIN})).status_code == 401
    assert (await client.get("/", headers={"Host": "attacker.example"})).status_code == 403
    assert (await client.get("/admin/state", headers={"Origin": "https://attacker.example"})).status_code == 403
    await login(client)
    assert (await client.get("/admin/state")).status_code == 200
    result = await client.get("/api/v1/models", headers={"Authorization": "Bearer " + client.tokens["api"]})
    assert result.status_code == 200
    assert (await client.post("/admin/logout", headers={"Origin": ORIGIN})).status_code == 200
    assert (await client.get("/admin/state")).status_code == 401


async def test_nonlocal_admin_rejected(store, credentials):
    app = create_app(store=store, secrets=credentials)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.0.2.4", 1)), base_url=ORIGIN) as client:
        assert (await client.get("/")).status_code == 403
    await app.state.router.provider.client.aclose()


async def test_dashboard_registration_prompt_request_and_record(api_client, store, credentials):
    client = api_client
    await login(client)
    client.headers["Origin"] = ORIGIN
    key = secrets.token_urlsafe(24)
    created = await client.post("/admin/connections", json={"name": "Local test", "provider": "compatible",
                                "base_url": "https://provider.invalid/v1", "api_key": key})
    assert created.status_code == 201
    connection = created.json()
    assert key not in created.text and "credential_ref" not in connection
    assert key not in store.path.read_bytes().decode("utf-8", errors="replace")
    assert key in credentials.values.values()
    created = await client.post("/admin/models", json={"name": "Test", "connection_id": connection["id"],
                              "upstream_model": "model", "pricing": "free"})
    assert created.status_code == 201
    model = created.json()
    config = (await client.get("/admin/state")).json()["settings"]
    config["system_prompt"] = "Respond briefly"
    config["store_bodies"] = True
    assert (await client.put("/admin/settings", json=config)).status_code == 200
    state = (await client.get("/admin/state")).json()
    assert state["models"][0]["effective_prompt"] == "Respond briefly"
    generated = await client.post("/api/v1/generate", json={"input": "hello"},
                                  headers={"Authorization": "Bearer " + client.tokens["api"]})
    assert generated.status_code == 200, generated.text
    assert generated.json()["output"] == "hello"
    assert generated.json()["model"] == model["id"]
    logs = (await client.get("/admin/records")).json()["records"]
    assert logs[0]["input"] == "hello" and logs[0]["status"] == "success"
    assert key not in json.dumps(state) and key not in json.dumps(logs)
    assert (await client.delete("/admin/connections/" + connection["id"])).status_code == 409
    assert (await client.delete("/admin/models/" + model["id"])).status_code == 200
    assert (await client.delete("/admin/connections/" + connection["id"])).status_code == 200
    assert not credentials.values


async def test_validation_never_echoes_secret_and_limits_input(api_client):
    await login(api_client)
    secret = secrets.token_urlsafe(24)
    result = await api_client.post("/admin/connections", json={"api_key": secret, "provider": "bad"}, headers={"Origin": ORIGIN})
    assert result.status_code == 422 and secret not in result.text
    result = await api_client.post("/api/v1/generate", content=b"x" * (513 * 1024))
    assert result.status_code == 413


async def test_api_key_rotation_revokes_previous(api_client):
    await login(api_client)
    created = await api_client.post("/admin/api-key/rotate", headers={"Origin": ORIGIN})
    assert created.status_code == 200
    assert (await api_client.get("/api/v1/models", headers={"Authorization": "Bearer " + api_client.tokens["api"]})).status_code == 401
    assert (await api_client.get("/api/v1/models", headers={"Authorization": "Bearer " + created.json()["api_key"]})).status_code == 200


async def test_paid_approval_is_explicit_and_stale_prices_cannot_be_approved(api_client, add_model, store):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=2)
    await login(api_client)
    api_client.headers["Origin"] = ORIGIN
    snapshot = (await api_client.get("/admin/state")).json()
    settings = snapshot["settings"] | {"approved_model_ids": [model["id"]], "monthly_budget_usd": 1}
    assert (await api_client.put("/admin/settings", json=settings)).status_code == 409
    approval = {"approved_model_ids": [model["id"]], "monthly_budget_usd": 1,
                "terms": {model["id"]: snapshot["models"][0]["approval_terms"]}}
    assert (await api_client.put("/admin/budget", json=approval)).status_code == 200
    result = await api_client.post("/admin/test", json={"input": "x"})
    assert result.status_code == 200
    assert store.budget()["used_and_reserved_usd"] > 0
    store.save_model(model | {"output_per_million": 10}, model["id"])
    assert (await api_client.put("/admin/budget", json=approval)).status_code == 409
    assert (await api_client.put("/admin/settings", json=settings)).status_code == 409
    assert (await api_client.post("/admin/test", json={"input": "x"})).status_code == 403


async def test_static_assets_and_security_headers(api_client):
    for path in ("/", "/static/app.js", "/static/style.css"):
        result = await api_client.get(path)
        assert result.status_code == 200
        assert "frame-ancestors 'none'" in result.headers["content-security-policy"]
        assert result.headers["cache-control"] == "no-store"
    assert (await api_client.get("/static/secrets.py")).status_code == 404


async def test_sse_api_failure_and_complete(store, credentials, add_model):
    add_model(pricing="free")
    key = store.initialize_tokens()["api"]
    for finish in (False, True):
        wire = b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
        if finish:
            wire += b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        upstream = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=SplitStream(wire))))
        app = create_app(store=store, secrets=credentials, client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 4)), base_url=ORIGIN) as client:
            result = await client.post("/api/v1/generate", json={"input": "x", "stream": True}, headers={"Authorization": "Bearer " + key})
            assert result.status_code == 200
            assert "event: delta" in result.text
            assert ("event: done" if finish else "event: error") in result.text
        await upstream.aclose()


def test_insecure_credentials_backend_fails_closed(monkeypatch, tmp_path):
    import keyring
    from nidus_router.errors import RouterError
    monkeypatch.setattr(keyring, "get_keyring", lambda: object())
    with pytest.raises(RouterError, match="credential_unavailable"):
        OSSecrets(tmp_path).set("ref", secrets.token_urlsafe())


@pytest.mark.parametrize("url", ["http://remote.example/v1", "https://user:password@remote.example", "https://remote.example?api_key=value"])
def test_connection_url_rejects_insecure_or_embedded_secrets(url):
    with pytest.raises(ValueError):
        Connection(name="x", provider="compatible", base_url=url)
