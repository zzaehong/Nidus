import unittest
from pathlib import Path

from nidus.plan_setup import suggest_sources, model_candidates, policy_for
from nidus.testing import temporary_vault
from nidus.store import Store
from nidus.planning import PlanRuntime
from nidus.gateway import default_policy
from nidus.application import Application
from nidus.connections import ConnectionRegistry


class PlanSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = temporary_vault()
        self.vault = Path(self.tmp.name)
        (self.vault / '제품조사.md').write_text('경쟁 제품 기능과 가격을 비교한다', encoding='utf-8')
        (self.vault / 'other.md').write_text('정원 관리 기록', encoding='utf-8')
        (self.vault / '.hidden.md').write_text('경쟁 제품', encoding='utf-8')
        self.store = Store(self.vault)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_recommendation_returns_paths_only_and_skips_hidden_files(self):
        results = suggest_sources(self.vault, '경쟁 제품 기능 비교 보고서')
        self.assertTrue(results)
        self.assertEqual(results[0]['path'], '제품조사.md')
        self.assertNotIn('.hidden.md', [result['path'] for result in results])
        self.assertNotIn('경쟁 제품 기능과 가격을 비교한다', str(results))

    def test_empty_sources_are_allowed_for_natural_language_plan(self):
        plan = PlanRuntime(self.store).submit('Write a short creative story', [], default_policy())
        self.assertEqual(plan['sources'], [])
        self.assertEqual(self.store.get_plan(plan['id'])['sources'], [])

    def test_only_ready_verified_models_are_recommended_and_policy_has_no_secret(self):
        class Registry:
            providers = type('Providers', (), {'manifests': {
                'openai-compatible': {'name': 'Compatible API', 'connection_kind': 'compatible'}}})()
            def list(self):
                return [{'id': 'conn_' + 'a' * 32, 'provider': 'openai-compatible',
                    'connection_kind': 'compatible', 'status': 'ready', 'name': 'My endpoint',
                    'base_url': 'https://example.invalid/v1', 'credential_ref': 'secret-ref'}]
            def catalog(self, _):
                return [{'model_id': 'model-1', 'availability': 'available',
                    'capabilities': {'chat': 'verified', 'structured_output': 'verified'},
                    'latency_ms': 42}]
        candidates = model_candidates(Registry(), '요약')
        self.assertEqual(len(candidates), 1)
        policy = policy_for(candidates[0])
        self.assertEqual(policy['routes'][0]['connection_id'], 'conn_' + 'a' * 32)
        self.assertNotIn('secret-ref', str(policy))

    def test_application_rebuilds_policy_from_live_model_selection(self):
        registry = ConnectionRegistry(self.store, credentials=object())
        connection_id = 'conn_' + 'b' * 32
        registry._save({'id':connection_id, 'provider':'openai-compatible',
            'connection_kind':'compatible', 'status':'ready', 'name':'Test endpoint',
            'base_url':'https://example.invalid/v1', 'credential_ref':'cred_private',
            'last_probe_at':'2026-10-13T00:00:00+00:00'})
        registry._catalog_save({'connection_id':connection_id,'model_id':'verified-model',
            'availability':'available','capabilities':{'chat':'verified','structured_output':'verified'},
            'latency_ms':20,'last_success_at':'2026-10-13T00:00:00+00:00'})
        app = Application(self.store, credentials=object())
        suggestion = app.suggest_plan_setup('Write a short overview')
        self.assertEqual(suggestion['model_selection'],
            {'connection_id':connection_id,'model_id':'verified-model'})
        plan = app.create_plan({'request':'Write a short overview','sources':[],
            'model_selection':suggestion['model_selection']})
        route = plan['policy']['routes'][0]
        self.assertEqual(route['connection_id'],connection_id)
        self.assertEqual(route['model'],'verified-model')
        self.assertNotIn('cred_private',str(plan))

