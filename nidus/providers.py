"""Small manifest registry and a shared OpenAI-compatible protocol adapter."""
import json
import urllib.request
from .gateway import ChatCompletions, ModelError, MAX_RESPONSE, request_bytes, validate_policy


def endpoint(value):
    if not isinstance(value, str) or not value or value != value.strip():
        raise ModelError('invalid_endpoint')
    try:
        validate_policy({'routes':[{'name':'probe','kind':'paid','provider':'probe','base_url':value,'model':'probe'}], 'allow_paid':True})
    except (ValueError, TypeError) as error:
        if isinstance(error, ModelError): raise
        raise ModelError('invalid_endpoint') from None
    return value.rstrip('/')


class ProviderRegistry:
    def __init__(self, manifests=None):
        self.manifests = {}
        for value in manifests if manifests is not None else [
            {'id':'omniroute','name':'OmniRoute','auth_type':'api_key',
             'default_base_url':'http://127.0.0.1:20128/v1','endpoint_editable':True,
             'credential_label':'Endpoint Key','protocol':'openai_chat_completions','supports_model_discovery':True},
            {'id':'openai-compatible','name':'OpenAI-compatible API','auth_type':'api_key',
             'default_base_url':'','endpoint_editable':True,'credential_label':'API Key',
             'protocol':'openai_chat_completions','supports_model_discovery':True}]:
            required={'id','name','auth_type','default_base_url','endpoint_editable','credential_label','protocol','supports_model_discovery'}
            if (not isinstance(value,dict) or set(value)!=required or
                any(not isinstance(value[k],str) or not value[k] or len(value[k])>128 for k in ('id','name','credential_label')) or
                value['id'] in self.manifests or value['auth_type']!='api_key' or
                value['protocol']!='openai_chat_completions' or type(value['endpoint_editable']) is not bool or
                type(value['supports_model_discovery']) is not bool or not isinstance(value['default_base_url'],str)):
                raise ModelError('invalid_provider_manifest')
            if value['default_base_url']: endpoint(value['default_base_url'])
            self.manifests[value['id']]=dict(value)

    def get(self, provider):
        if provider not in self.manifests: raise ModelError('unsupported_provider')
        return dict(self.manifests[provider])

    def list(self):
        return [dict(value) for value in self.manifests.values()]


class OpenAICompatibleAdapter:
    def discover_models(self, connection, secret):
        headers={'User-Agent':'Nidus/0.2'}
        if secret: headers['Authorization']='Bearer '+secret
        raw=request_bytes(urllib.request.Request(connection['base_url']+'/models',headers=headers),10)
        if len(raw)>MAX_RESPONSE: raise ModelError('response_too_large')
        try:
            value=json.loads(raw)
            if not isinstance(value,dict) or not isinstance(value.get('data'),list): raise ValueError()
            models=[]
            for row in value['data']:
                name=row.get('id') if isinstance(row,dict) else None
                if not isinstance(name,str) or not name or len(name)>256 or any(ord(c)<32 for c in name): raise ValueError()
                if secret and secret in name: raise ModelError('credential_in_content')
                if name not in models: models.append(name)
            if len(models)>1000: raise ModelError('response_too_large')
            return models
        except (ValueError, TypeError) as error:
            if isinstance(error,ModelError): raise
            raise ModelError('invalid_response') from None

    def generate(self, connection, model, secret, structured=False):
        route={'base_url':connection['base_url'],'model':model}
        policy={'timeout_seconds':10,'max_tokens':64}
        if structured: policy['response_format']='json_object'
        return ChatCompletions().generate(route,[{'role':'user','content':
            'Return a JSON object with exactly one field: {"status":"READY"}.' if structured else 'Return exactly the word READY.'}],policy,secret=secret)
