"""Small Provider manifest registry and Provider adapter implementations."""
import json
import urllib.parse
import urllib.request
from typing import Protocol
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
            {'id':'gemini','name':'Google Gemini','auth_type':'api_key',
             'connection_kind':'direct',
             'default_base_url':'https://generativelanguage.googleapis.com/v1beta','endpoint_editable':False,
             'credential_label':'Gemini API Key','protocol':'gemini_generate_content','adapter':'gemini',
             'supports_model_discovery':True,'api_key_required':True},
            {'id':'omniroute','name':'OmniRoute','auth_type':'api_key','connection_kind':'gateway',
             'default_base_url':'http://127.0.0.1:20128/v1','endpoint_editable':True,
             'credential_label':'Endpoint Key','protocol':'openai_chat_completions','adapter':'openai-compatible',
             'supports_model_discovery':True,'api_key_required':True},
            {'id':'openai-compatible','name':'OpenAI-compatible API','auth_type':'api_key','connection_kind':'compatible',
             'default_base_url':'','endpoint_editable':True,'credential_label':'API Key',
             'protocol':'openai_chat_completions','adapter':'openai-compatible','supports_model_discovery':True,
             'api_key_required':False}]:
            required={'id','name','auth_type','connection_kind','default_base_url','endpoint_editable','credential_label','protocol',
                'adapter','supports_model_discovery','api_key_required'}
            if (not isinstance(value,dict) or set(value)!=required or
                any(not isinstance(value[k],str) or not value[k] or len(value[k])>128 for k in ('id','name','credential_label')) or
                value['id'] in self.manifests or value['auth_type']!='api_key' or
                value['connection_kind'] not in ('direct','gateway','compatible','local') or
                not isinstance(value['protocol'],str) or not value['protocol'] or len(value['protocol'])>128 or
                not isinstance(value['adapter'],str) or
                not value['adapter'] or len(value['adapter'])>128 or type(value['endpoint_editable']) is not bool or
                type(value['supports_model_discovery']) is not bool or type(value['api_key_required']) is not bool or
                not isinstance(value['default_base_url'],str)):
                raise ModelError('invalid_provider_manifest')
            if value['default_base_url']: endpoint(value['default_base_url'])
            self.manifests[value['id']]=dict(value)

    def get(self, provider):
        if provider not in self.manifests: raise ModelError('unsupported_provider')
        return dict(self.manifests[provider])

    def list(self):
        return [dict(value) for value in self.manifests.values()]


class OpenAICompatibleAdapter:
    max_probe_candidates = 3

    def probe_candidates(self, models):
        return sorted(models)[:self.max_probe_candidates]

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

    def generate_messages(self, connection, model, secret, messages, policy):
        return ChatCompletions().generate({'base_url':connection['base_url'],'model':model},
            messages,policy,secret=secret)


class ProviderAdapter(Protocol):
    """Provider-neutral operations required by ConnectionRegistry."""
    def discover_models(self, connection, secret): ...
    def generate(self, connection, model, secret, structured=False): ...
    def probe_candidates(self, models): ...


class GeminiAdapter:
    """Native Gemini GenerateContent REST adapter, with metadata-based discovery."""
    max_probe_candidates = 5
    requires_api_key = True
    max_discovery_pages = 5

    def discover_models(self, connection, secret):
        if not secret: raise ModelError('credential_missing')
        models=[]; page_token=None
        for _ in range(self.max_discovery_pages):
            query={'pageSize':1000}
            if page_token: query['pageToken']=page_token
            url=connection['base_url']+'/models?'+urllib.parse.urlencode(query)
            request=urllib.request.Request(url,headers={'User-Agent':'Nidus/0.2','x-goog-api-key':secret})
            raw=request_bytes(request,10)
            if len(raw)>MAX_RESPONSE: raise ModelError('response_too_large')
            try:
                value=json.loads(raw)
                rows=value.get('models') if isinstance(value,dict) else None
                if not isinstance(rows,list) or len(rows)>1000: raise ValueError()
                for row in rows:
                    if not isinstance(row,dict): raise ValueError()
                    name=row.get('name'); methods=row.get('supportedGenerationMethods')
                    if (not isinstance(name,str) or not name.startswith('models/') or len(name)>256 or
                        any(ord(c)<32 for c in name) or not isinstance(methods,list) or
                        any(not isinstance(item,str) for item in methods)):
                        raise ValueError()
                    if 'generateContent' in methods:
                        model=name[len('models/'):]
                        if secret in model: raise ModelError('credential_in_content')
                        if model not in models: models.append(model)
                page_token=value.get('nextPageToken')
                if page_token is not None and (not isinstance(page_token,str) or not page_token or len(page_token)>512):
                    raise ValueError()
                if page_token and secret in page_token: raise ModelError('credential_in_content')
                if not page_token: break
            except (ValueError,TypeError,AttributeError) as error:
                if isinstance(error,ModelError): raise
                raise ModelError('invalid_response') from None
        return models

    def probe_candidates(self, models):
        return list(models)[:self.max_probe_candidates]

    def generate(self, connection, model, secret, structured=False):
        if not secret: raise ModelError('credential_missing')
        if not isinstance(model,str) or not model or len(model)>256 or any(ord(c)<32 for c in model):
            raise ModelError('invalid_model')
        url=connection['base_url']+'/models/'+urllib.parse.quote(model,safe='-._~')+':generateContent'
        body={'contents':[{'role':'user','parts':[{'text':
            'Return a JSON object with exactly one field: {"status":"READY"}.'
            if structured else 'Return exactly the word READY.'}]}],
            'generationConfig':{'maxOutputTokens':64}}
        if structured:
            body['generationConfig']['responseFormat']={'text':{'mimeType':'APPLICATION_JSON',
                'schema':{'type':'OBJECT','properties':{'status':{'type':'STRING'}},'required':['status']}}}
        request=urllib.request.Request(url,data=json.dumps(body,separators=(',',':')).encode(),
            headers={'User-Agent':'Nidus/0.2','Content-Type':'application/json','x-goog-api-key':secret})
        raw=request_bytes(request,10)
        if len(raw)>MAX_RESPONSE: raise ModelError('response_too_large')
        try:
            value=json.loads(raw)
            candidates=value.get('candidates') if isinstance(value,dict) else None
            if not isinstance(candidates,list) or not candidates: raise ValueError()
            candidate=candidates[0]
            content=candidate.get('content') if isinstance(candidate,dict) else None
            parts=content.get('parts') if isinstance(content,dict) else None
            if not isinstance(parts,list): raise ValueError()
            text=''.join(part.get('text','') for part in parts
                if isinstance(part,dict) and isinstance(part.get('text',''),str))
            finish=candidate.get('finishReason')
            if not text or finish not in ('STOP','FINISH_REASON_UNSPECIFIED'):
                raise ModelError('incomplete_response')
            usage=value.get('usageMetadata',{})
            if not isinstance(usage,dict): usage={}
            tokens={key:usage[source] for key,source in (
                ('prompt_tokens','promptTokenCount'),('completion_tokens','candidatesTokenCount'),
                ('total_tokens','totalTokenCount')) if type(usage.get(source)) is int}
            actual=value.get('modelVersion')
            if not isinstance(actual,str) or not actual: actual=model
            if secret in text or secret in actual: raise ModelError('credential_in_content')
            return {'text':text,'model':actual,'tokens':tokens}
        except (ValueError,TypeError,AttributeError) as error:
            if isinstance(error,ModelError): raise
            raise ModelError('invalid_response') from None

    def generate_messages(self, connection, model, secret, messages, policy):
        if not secret: raise ModelError('credential_missing')
        if not isinstance(model,str) or not model or len(model)>256 or any(ord(c)<32 for c in model):
            raise ModelError('invalid_model')
        system=[]; contents=[]
        for message in messages:
            if not isinstance(message,dict) or message.get('role') not in ('system','user','assistant') or not isinstance(message.get('content'),str):
                raise ModelError('invalid_request')
            if message['role']=='system':
                system.append(message['content'])
            else:
                contents.append({'role':'model' if message['role']=='assistant' else 'user',
                    'parts':[{'text':message['content']}]})
        if not contents: raise ModelError('invalid_request')
        body={'contents':contents,'generationConfig':{'maxOutputTokens':policy['max_tokens']}}
        if system: body['systemInstruction']={'parts':[{'text':'\n\n'.join(system)}]}
        if policy.get('response_format')=='json_object':
            body['generationConfig']['responseMimeType']='application/json'
        url=connection['base_url']+'/models/'+urllib.parse.quote(model,safe='-._~')+':generateContent'
        request=urllib.request.Request(url,data=json.dumps(body,separators=(',',':')).encode(),
            headers={'User-Agent':'Nidus/0.2','Content-Type':'application/json','x-goog-api-key':secret})
        raw=request_bytes(request,policy['timeout_seconds'])
        if len(raw)>MAX_RESPONSE: raise ModelError('response_too_large')
        try:
            value=json.loads(raw)
            candidates=value.get('candidates') if isinstance(value,dict) else None
            if not isinstance(candidates,list) or not candidates: raise ValueError()
            candidate=candidates[0]
            content=candidate.get('content') if isinstance(candidate,dict) else None
            parts=content.get('parts') if isinstance(content,dict) else None
            if not isinstance(parts,list): raise ValueError()
            text=''.join(part.get('text','') for part in parts
                if isinstance(part,dict) and isinstance(part.get('text',''),str))
            if not text or candidate.get('finishReason') not in ('STOP','FINISH_REASON_UNSPECIFIED'):
                raise ModelError('incomplete_response')
            usage=value.get('usageMetadata',{})
            if not isinstance(usage,dict): usage={}
            tokens={key:usage[source] for key,source in (
                ('prompt_tokens','promptTokenCount'),('completion_tokens','candidatesTokenCount'),
                ('total_tokens','totalTokenCount')) if type(usage.get(source)) is int}
            actual=value.get('modelVersion')
            if not isinstance(actual,str) or not actual: actual=model
            if secret in text or secret in actual: raise ModelError('credential_in_content')
            return {'text':text,'finish_reason':'stop','model':actual,'tokens':tokens,
                'estimated_cost_usd':None}
        except (ValueError,TypeError,AttributeError) as error:
            if isinstance(error,ModelError): raise
            raise ModelError('invalid_response') from None
