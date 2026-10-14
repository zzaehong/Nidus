from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json

import httpx
import pytest

from nidus_router.errors import RouterError
from nidus_router.router import Router
from nidus_router.schemas import Generate
from nidus_router.store import Store, money
from conftest import response


async def execute(store, credentials, handler, request=None):
    request = request or Generate(input="question")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        router = Router(store, credentials, client)
        return [event async for event in router.run(request, "request-id", router.prepare(request))]


def settings(store, **changes):
    return store.save_settings(store.snapshot()["settings"] | changes)


async def test_free_first_fallback_and_prompt_override(store, credentials, add_model):
    paid = add_model(pricing="paid", priority=0, input_per_million=1, output_per_million=2)
    first = add_model(pricing="free", priority=1)
    second = add_model(pricing="free", priority=2, prompt_override="special")
    settings(store, system_prompt="global", approved_model_ids=[paid["id"]], monthly_budget_usd=1)
    payloads = []

    def handler(req):
        payloads.append(json.loads(req.content))
        return httpx.Response(503) if len(payloads) == 1 else response()

    result = await execute(store, credentials, handler)
    assert result[-1]["data"]["model"] == second["id"]
    assert [p["messages"][0]["content"] for p in payloads] == ["global", "special"]
    record = store.records()[0]
    assert [a["model"] for a in record["attempts"]] == [first["id"], second["id"]]
    assert "input" not in record and "output" not in record


async def test_explicit_fallback_then_auto_non_recursive(store, credentials, add_model):
    unrelated = add_model(pricing="free")
    fallback = add_model(pricing="free", fallback_ids=[unrelated["id"]])
    first = add_model(pricing="free", fallback_ids=[fallback["id"]])
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(503)
    with pytest.raises(RouterError, match="provider_unavailable"):
        await execute(store, credentials, handler, Generate(input="x", model=first["id"]))
    assert len([r for r in calls if r.method == "POST"]) == 3
    assert len([r for r in calls if r.method == "GET"]) == 3


@pytest.mark.parametrize("status,fallback", [(401, True), (403, True), (402, True), (429, True),
                                              (500, True), (408, True), (400, False), (302, False)])
async def test_error_fallback_policy(store, credentials, add_model, status, fallback):
    add_model(pricing="free", priority=0)
    add_model(pricing="free", priority=1)
    calls = []
    def handler(req):
        if req.method == "GET":
            return httpx.Response(200, json={"data": []})
        calls.append(req)
        return httpx.Response(status) if len(calls) == 1 else response()
    if fallback:
        await execute(store, credentials, handler)
    else:
        with pytest.raises(RouterError):
            await execute(store, credentials, handler)
    assert len(calls) == (2 if fallback else 1)


async def test_unknown_and_unapproved_never_called(store, credentials, add_model):
    unknown = add_model()
    paid = add_model(pricing="paid", input_per_million=1, output_per_million=2)
    def forbidden(req):
        pytest.fail("unapproved upstream call")
    with pytest.raises(RouterError, match="paid_not_approved"):
        await execute(store, credentials, forbidden)
    with pytest.raises(RouterError, match="unknown_pricing"):
        await execute(store, credentials, forbidden, Generate(input="x", model=unknown["id"]))
    with pytest.raises(RouterError, match="paid_not_approved"):
        await execute(store, credentials, forbidden, Generate(input="x", model=paid["id"]))


@pytest.mark.parametrize("bad", ['```json\n{}\n```', '{} explanation', '{"a":}', 'NaN', '1e999', '{"x":1,"x":2}'])
async def test_json_invalid_no_retry(store, credentials, add_model, bad):
    add_model(pricing="free")
    add_model(pricing="free")
    settings(store, output_format="json")
    calls = []
    def handler(req):
        calls.append(req)
        return response(bad)
    with pytest.raises(RouterError, match="invalid_output"):
        await execute(store, credentials, handler)
    assert len(calls) == 1


async def test_valid_json_and_snapshot(store, credentials, add_model):
    add_model(pricing="free")
    settings(store, output_format="json", system_prompt="original", store_bodies=True)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: response('{"ok":true}'))) as client:
        router = Router(store, credentials, client)
        request = Generate(input="x")
        prepared = router.prepare(request)
        settings(store, output_format="text", system_prompt="changed", store_bodies=False)
        events = [e async for e in router.run(request, "snapshot", prepared)]
    assert events[-1]["data"]["output"] == {"ok": True}
    assert store.records()[0]["input"] == "x"


async def test_json_stream_rejected_before_call(store, credentials, add_model):
    add_model(pricing="free")
    settings(store, output_format="json")
    with pytest.raises(RouterError, match="json_stream_not_supported"):
        await execute(store, credentials, lambda req: pytest.fail("called"), Generate(input="x", stream=True))


async def test_truncated_output_rejected(store, credentials, add_model):
    add_model(pricing="free")
    with pytest.raises(RouterError, match="invalid_output"):
        await execute(store, credentials, lambda req: response("hello", "length"))


async def test_paid_settlement_and_missing_usage(store, credentials, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=2)
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    await execute(store, credentials, lambda req: response())
    assert store.budget()["used_and_reserved_usd"] == 0.000016
    await execute(store, credentials, lambda req: response(usage=False))
    assert store.budget()["used_and_reserved_usd"] > 0.002
    store.clear_records()
    assert store.budget()["used_and_reserved_usd"] > 0.002


def test_concurrent_budget_reservations_and_restart(store, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    def reserve(i):
        try:
            return store.reserve(str(i), model, money(0.6), 1)
        except RouterError as error:
            return error.code
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(reserve, [1, 2]))
    assert results.count("budget_exceeded") == 1
    restored = Store(store.directory)
    assert restored.budget()["used_and_reserved_usd"] == 0.6
    assert restored.snapshot() == store.snapshot()


def test_month_boundary_uses_seoul_and_settles_original_month(store, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    store.clock = lambda: datetime(2026, 10, 31, 14, 59, tzinfo=timezone.utc)
    reservation = store.reserve("old", model, money(0.6), 1)
    store.clock = lambda: datetime(2026, 10, 31, 15, 0, tzinfo=timezone.utc)
    assert store.budget()["month"] == "2026-11"
    assert store.budget()["used_and_reserved_usd"] == 0
    store.settle(reservation, money(0.2))
    assert store.budget()["used_and_reserved_usd"] == 0


def test_reapproval_required_after_rate_change(store, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    store.save_model(model | {"input_per_million": 10}, model["id"])
    with pytest.raises(RouterError, match="paid_not_approved"):
        store.reserve("changed", model, money(0.1), 1)


def test_retention_keeps_budget_and_deletes_body(store, add_model):
    store.clock = lambda: datetime(2026, 1, 1, tzinfo=timezone.utc)
    store.record({"request_id": "old", "input": "private"})
    store.clock = lambda: datetime(2026, 2, 2, tzinfo=timezone.utc)
    assert store.records() == []


def test_connection_change_invalidates_inflight_approval(store, add_model):
    model = add_model(pricing="paid", input_per_million=1, output_per_million=1)
    connection = store.snapshot()["connections"][model["connection_id"]]
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    store.save_connection(connection | {"base_url": "https://new.invalid/v1"}, connection["id"])
    settings(store, approved_model_ids=[model["id"]], monthly_budget_usd=1)
    with pytest.raises(RouterError, match="paid_not_approved"):
        store.reserve("old-snapshot", model, money(0.1), 1, connection)


def test_future_database_schema_is_not_overwritten(store):
    with store.db(True) as db:
        db.execute("PRAGMA user_version=999")
    with pytest.raises(RouterError, match="configuration_conflict"):
        Store(store.directory)
    with store.db() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 999
