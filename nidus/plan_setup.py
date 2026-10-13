"""Local-only recommendations for natural-language Plan setup."""
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from .runtime import safe_path

MAX_FILES = 2000
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_SOURCE_CANDIDATES = 20
DEFAULT_SOURCE_SELECTION = 5
STOP_WORDS = {
    '그리고','그런데','대한','대해서','정리','작성','만들','만들어','만들어줘','알려줘',
    '기반','사용','자료','내용','문서','보고서','작성해','해주세요','해줘','에서','으로',
    '에게','관련','있는','위한','위해','이번','지난','주요','다음','the','and','for','from',
    'with','about','into','using','make','create','write','please','this','that','based','on',
}


def _tokens(text):
    text = unicodedata.normalize('NFKC', str(text)).casefold()
    words = [word for word in re.findall(r'[a-z0-9][a-z0-9_.-]*|[가-힣]{2,}', text)
             if word not in STOP_WORDS and len(word) > 1]
    grams = set()
    for word in words:
        if re.fullmatch(r'[가-힣]+', word) and len(word) >= 3:
            grams.update(word[i:i+2] for i in range(len(word)-1))
    return set(words), grams


def suggest_sources(vault, request):
    """Rank safe Markdown/text files without transmitting names or contents."""
    query_words, query_grams = _tokens(request)
    if not query_words and not query_grams:
        return []
    root = Path(vault)
    scored = []
    seen = 0
    total_bytes = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        base = Path(directory)
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not (base / d).is_symlink())
        for filename in sorted(files):
            if filename.startswith('.') or Path(filename).suffix.lower() not in ('.md','.txt'):
                continue
            seen += 1
            if seen > MAX_FILES:
                return _ranked(scored)
            path = (base / filename)
            try:
                relative = path.relative_to(root).as_posix()
                safe = safe_path(root, relative)
                size = safe.stat().st_size
                if size > 1024 * 1024 or total_bytes + size > MAX_TOTAL_BYTES:
                    continue
                raw = safe.read_bytes()
                total_bytes += len(raw)
                content = raw.decode('utf-8')
            except (OSError, UnicodeError, ValueError):
                continue
            path_words, path_grams = _tokens(relative)
            body_words, body_grams = _tokens(content)
            path_hits = query_words & path_words
            body_hits = query_words & body_words
            gram_hits = query_grams & (path_grams | body_grams)
            # Filename/title matches are stronger than broad body mentions.
            score = 5 * len(path_hits) + sum(min(content.casefold().count(term), 3)
                for term in body_hits) + 0.25 * len(gram_hits)
            if score > 0:
                scored.append({'path':relative,'score':score,
                    'matched_terms':sorted(path_hits | body_hits)[:8]})
    return _ranked(scored)


def _ranked(scored):
    return sorted(scored, key=lambda row:(-row['score'],row['path']))[:MAX_SOURCE_CANDIDATES]


def model_candidates(registry, request):
    """List ready catalog entries that passed both Plan-required probe modes."""
    candidates=[]
    for connection in registry.list():
        if connection.get('status') != 'ready':
            continue
        manifest=registry.providers.manifests.get(connection.get('provider'))
        if not manifest or connection.get('connection_kind') != manifest['connection_kind']:
            continue
        for model in registry.catalog(connection['id']):
            if (model.get('availability') != 'available' or
                model.get('capabilities') != {'chat':'verified','structured_output':'verified'}):
                continue
            endpoint=urlsplit(connection['base_url'])
            local=endpoint.hostname in ('localhost','127.0.0.1','::1')
            candidates.append({'connection_id':connection['id'],'provider':connection['provider'],
                'connection_kind':connection['connection_kind'],'connection_name':connection['name'],
                'model_id':model['model_id'],'base_url':connection['base_url'],
                'route_kind':'local' if local else 'paid',
                'latency_ms':model.get('latency_ms'),
                'last_success_at':model.get('last_success_at') or connection.get('last_probe_at') or '',
                'manifest_name':manifest['name']})
    if not candidates:
        return []
    query=unicodedata.normalize('NFKC',request).casefold()
    def preference(candidate):
        labels=(candidate['provider'],candidate['connection_kind'],candidate['connection_name'],
                candidate['manifest_name'],candidate['model_id'])
        explicit=sum(1 for label in labels if label and label.casefold() in query)
        try: recent=datetime.fromisoformat(candidate['last_success_at'].replace('Z','+00:00')).timestamp()
        except (ValueError,AttributeError): recent=0
        return (-explicit, -recent,
                candidate['latency_ms'] if candidate['latency_ms'] is not None else 10**12,
                candidate['provider'],candidate['model_id'],candidate['connection_id'])
    return sorted(candidates,key=preference)


def policy_for(candidate):
    route={'name':(candidate['connection_name']+' / '+candidate['model_id'])[:256],
        'kind':candidate['route_kind'],'provider':candidate['provider'],
        'base_url':candidate['base_url'],'model':candidate['model_id'],
        'connection_id':candidate['connection_id']}
    return {'routes':[route],'allow_paid':candidate['route_kind']=='paid',
        'timeout_seconds':30,'max_tokens':1024}
