import httpx
import pytest

from nidus_router.catalog import model_status, quote
from nidus_router.errors import RouterError
from nidus_router.router import Router
from nidus_router.schemas import Generate
from test_discovery import connection, rows


@pytest.mark.parametrize('name', ['gemini-2.5-flash-lite', 'gemini-2.5-flash',
                                  'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'])
async def test_known_prices_require_account_confirmation(store, credentials, name):
    c = connection(store, credentials, 'gemini')
    store.apply_discovery(c, rows(name))
    model = next(iter(store.snapshot()['models'].values()))
    assert model['input_per_million'] is not None
    assert model_status(model, c, store.snapshot()['settings']) == 'billing_required'
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: pytest.fail('must not call'))) as client:
        router = Router(store, credentials, client)
        for selected in ('auto', model['id']):
            with pytest.raises(RouterError, match='billing_required'):
                router.prepare(Generate(input='test', model=selected))


def test_billing_confirmation_applies_to_all_catalog_models_only(store, credentials):
    c = connection(store, credentials, 'gemini')
    discovered = rows('gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'future-model')
    store.apply_discovery(c, discovered)
    before = set(store.snapshot()['models'])
    c = store.save_connection(c | {'billing_tier': 'free'}, c['id'])
    store.apply_discovery(c, discovered)
    snapshot = store.snapshot()
    assert set(snapshot['models']) == before
    for model in snapshot['models'].values():
        expected = 'unknown_pricing' if model['upstream_model'] == 'future-model' else 'available'
        assert model_status(model, c, snapshot['settings']) == expected
    assert snapshot['settings']['approved_model_ids'] == []
    assert snapshot['settings']['monthly_budget_usd'] == 0
    c = store.save_connection(c | {'billing_tier': 'paid'}, c['id'])
    store.apply_discovery(c, discovered)
    for model in store.snapshot()['models'].values():
        if model['upstream_model'] != 'future-model':
            assert model_status(model, c, snapshot['settings']) == 'approval_required'


def test_custom_endpoint_and_manual_override_are_not_account_unknown(store, credentials):
    c = connection(store, credentials, 'gemini')
    custom = c | {'base_url': 'https://custom.invalid/v1'}
    assert quote(custom, 'gemini-3.1-flash-lite') is None
    store.apply_discovery(c, rows('gemini-3.1-flash-lite'))
    m = next(iter(store.snapshot()['models'].values()))
    manual = store.save_model(m | {'pricing': 'free'}, m['id'])
    assert model_status(manual, c, store.snapshot()['settings']) == 'available'


async def test_admin_billing_fix_preserves_key_and_allows_generation(store, credentials):
    from nidus_router.app import create_app
    import secrets
    tokens = store.initialize_tokens()
    provider_key = secrets.token_urlsafe(24)
    calls = []
    def upstream(req):
        calls.append(req.method)
        assert req.headers['x-goog-api-key'] == provider_key
        if req.method == 'GET':
            return httpx.Response(200, json={'models': [
                {'name': 'models/gemini-3.1-flash-lite', 'supportedGenerationMethods': ['generateContent']}]})
        return httpx.Response(200, json={'candidates': [{'content': {'parts': [{'text': 'NIDUS_OK'}]}, 'finishReason': 'STOP'}],
            'usageMetadata': {'promptTokenCount': 8, 'candidatesTokenCount': 4}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as provider:
        app = create_app(store=store, secrets=credentials, client=provider)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8787',
                                     headers={'Origin': 'http://127.0.0.1:8787'}) as client:
            await client.post('/admin/login', json={'token': tokens['admin']})
            data = {'name': 'Gemini', 'provider': 'gemini', 'base_url': 'https://generativelanguage.googleapis.com/v1beta'}
            saved = (await client.post('/admin/connections', json=data | {'api_key': provider_key})).json()
            failed = await client.post('/admin/test', json={'input': 'test'})
            assert failed.status_code == 422 and failed.json()['error']['code'] == 'billing_required'
            updated = await client.put('/admin/connections/' + saved['id'], json=data | {'billing_tier': 'free'})
            assert updated.status_code == 200 and provider_key not in updated.text
            models = (await client.get('/admin/state')).json()['models']
            assert models[0]['status'] == 'available'
            result = (await client.post('/admin/test', json={'input': 'test', 'model': models[0]['id']})).json()
            assert result['output'] == 'NIDUS_OK' and result['usage']['estimated_cost_usd'] == 0
    assert calls == ['GET', 'GET', 'POST']
    assert store.budget()['used_and_reserved_usd'] == 0
