"""Bounded, read-only model discovery and coalesced refreshes."""
import asyncio
import json
import re
import time

import httpx

from .catalog import supported
from .errors import RouterError
from .providers import MAX_RESPONSE_BYTES, status_error

IDENTITY_FIELDS = ("provider", "base_url", "credential_ref", "billing_tier")
REFRESH_ERRORS = {"authentication_failed", "provider_unavailable", "model_unavailable"}


def identity(connection):
    return tuple(connection.get(k, "unconfirmed" if k == "billing_tier" else None) for k in IDENTITY_FIELDS)


async def list_models(client, connection, key):
    kind = connection["provider"]
    headers = ({"x-api-key": key, "anthropic-version": "2023-06-01"} if kind == "anthropic" else
               {"x-goog-api-key": key} if kind == "gemini" else {"Authorization": "Bearer " + key})
    params = {"pageSize": 1000} if kind == "gemini" else {"limit": 1000} if kind == "anthropic" else {}
    result, cursors, total = {}, set(), 0
    try:
        async with asyncio.timeout(15):
            for _ in range(20):
                async with client.stream("GET", connection["base_url"] + "/models", headers=headers,
                                         params=params, timeout=10, follow_redirects=False) as response:
                    if response.status_code != 200:
                        raise status_error(response.status_code)
                    chunks = []
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_RESPONSE_BYTES:
                            raise RouterError("discovery_invalid")
                        chunks.append(chunk)
                body = json.loads(b"".join(chunks))
                rows = body["models" if kind == "gemini" else "data"]
                if not isinstance(rows, list):
                    raise ValueError()
                for row in rows:
                    upstream = row["name" if kind == "gemini" else "id"]
                    if kind == "gemini":
                        upstream = upstream.removeprefix("models/")
                    if not isinstance(upstream, str) or not re.fullmatch(r"[A-Za-z0-9._:/@-]{1,200}", upstream):
                        raise ValueError()
                    if kind == "gemini" and "generateContent" not in row.get("supportedGenerationMethods", []):
                        continue
                    # Exclude clearly non-text endpoints; unknown capabilities remain held.
                    if any(x in upstream.lower() for x in ("embedding", "whisper", "tts", "realtime", "transcribe", "image", "audio", "moderation", "dall-e")):
                        continue
                    known = supported(kind, upstream) or kind == "anthropic" and row.get("type") == "model"
                    result[upstream] = {"upstream_model": upstream, "name": upstream[:120],
                                        "support": "supported" if known else "unknown"}
                    if len(result) > 10000:
                        raise ValueError()
                if kind != "gemini" and type(body.get("has_more", False)) is not bool:
                    raise ValueError()
                cursor = body.get("nextPageToken") if kind == "gemini" else (
                    body.get("last_id") if body.get("has_more") else None)
                if kind != "gemini" and body.get("has_more") and not cursor:
                    raise ValueError()
                if not cursor:
                    return list(result.values())
                if not isinstance(cursor, str) or len(cursor) > 2048 or cursor in cursors:
                    raise ValueError()
                cursors.add(cursor)
                params["pageToken" if kind == "gemini" else "after_id" if kind == "anthropic" else "after"] = cursor
            raise ValueError()
    except (httpx.HTTPError, TimeoutError):
        raise RouterError("provider_unavailable", 503, True) from None
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError, RecursionError):
        raise RouterError("discovery_invalid") from None


class Discovery:
    def __init__(self, store, secrets, client):
        self.store, self.secrets, self.client = store, secrets, client
        self.tasks, self.last = {}, {}

    async def refresh(self, connection_id, *, automatic=False):
        connection = self.store.snapshot()["connections"].get(connection_id)
        if not connection:
            raise RouterError("not_found", 404)
        key = (connection_id, identity(connection))
        task = self.tasks.get(key)
        if task is None:
            previous = self.last.get(connection_id)
            if automatic and previous and previous[0] == key and time.monotonic() - previous[1] < 30:
                return previous[2] | {"throttled": True}
            task = asyncio.create_task(self._refresh(connection))
            self.tasks[key] = task
            task.add_done_callback(lambda completed: self._complete(key, completed))
        return await asyncio.shield(task)

    def _complete(self, key, task):
        self.tasks.pop(key, None)
        if not task.cancelled() and task.exception() is None:
            self.last[key[0]] = (key, time.monotonic(), task.result())

    async def _refresh(self, connection):
        try:
            rows = await list_models(self.client, connection, self.secrets.get(connection["credential_ref"]))
            return self.store.apply_discovery(connection, rows)
        except RouterError as error:
            return self.store.apply_discovery(connection, None, error.code)

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
