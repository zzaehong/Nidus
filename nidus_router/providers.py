"""Small native adapters. Upstream bodies and exceptions are never user-facing."""
import codecs
import json
from urllib.parse import quote

import httpx

from .errors import RouterError

MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def status_error(status):
    if status in (401, 403):
        return RouterError("authentication_failed", 502, True)
    if status in (402, 429):
        return RouterError("rate_limited", 503, True)
    if status in (408, 504) or status >= 500:
        return RouterError("provider_unavailable", 503, True)
    return RouterError("provider_request_rejected", 502)


def token_count(value):
    return value if type(value) is int and 0 <= value <= 1_000_000_000 else None


def usage_event(input_tokens=None, output_tokens=None):
    return {"type": "usage", "input_tokens": token_count(input_tokens),
            "output_tokens": token_count(output_tokens)}


async def sse_data(response):
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    buffer, data, size = "", [], 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise RouterError("invalid_output")
        buffer += decoder.decode(chunk)
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.rstrip("\r")
            if not line:
                if data:
                    yield "\n".join(data)
                    data = []
            elif line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
    buffer += decoder.decode(b"", final=True)
    if buffer.startswith("data:"):
        data.append(buffer[5:].removeprefix(" ").rstrip("\r"))
    if data:
        yield "\n".join(data)


class Provider:
    def __init__(self, client):
        self.client = client

    def build(self, connection, model, key, prompt, text, settings, stream):
        kind = connection["provider"]
        base = connection["base_url"]
        upstream = model["upstream_model"]
        headers = {"Content-Type": "application/json"}
        maximum = settings["max_output_tokens"]
        if kind in ("openai", "compatible"):
            url = base + "/chat/completions"
            headers["Authorization"] = "Bearer " + key
            body = {"model": upstream, "messages": [
                {"role": "system", "content": prompt}, {"role": "user", "content": text}], "stream": stream,
                ("max_completion_tokens" if kind == "openai" else "max_tokens"): maximum}
            if stream:
                body["stream_options"] = {"include_usage": True}
        elif kind == "anthropic":
            url = base + "/messages"
            headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
            body = {"model": upstream, "system": prompt, "messages": [{"role": "user", "content": text}],
                    "max_tokens": maximum, "stream": stream}
        else:
            action = "streamGenerateContent?alt=sse" if stream else "generateContent"
            url = base + "/models/" + quote(upstream.removeprefix("models/"), safe="") + ":" + action
            headers["x-goog-api-key"] = key
            body = {"systemInstruction": {"parts": [{"text": prompt}]},
                    "contents": [{"role": "user", "parts": [{"text": text}]}],
                    "generationConfig": {"maxOutputTokens": maximum}}
            if settings["output_format"] == "json":
                body["generationConfig"]["responseMimeType"] = "application/json"
        return url, headers, body

    async def events(self, connection, model, key, prompt, text, settings, stream):
        url, headers, payload = self.build(connection, model, key, prompt, text, settings, stream)
        try:
            async with self.client.stream("POST", url, headers=headers, json=payload,
                                          timeout=settings["timeout_seconds"]) as response:
                if response.status_code != 200:
                    raise status_error(response.status_code)
                if stream:
                    async for raw in sse_data(response):
                        if raw == "[DONE]":
                            break
                        for event in self.parse(connection["provider"], json.loads(raw), True):
                            yield event
                else:
                    chunks, length = [], 0
                    async for chunk in response.aiter_bytes():
                        length += len(chunk)
                        if length > MAX_RESPONSE_BYTES:
                            raise RouterError("invalid_output")
                        chunks.append(chunk)
                    for event in self.parse(connection["provider"], json.loads(b"".join(chunks)), False):
                        yield event
        except httpx.HTTPError:
            raise RouterError("provider_unavailable", 503, True) from None
        except (ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError):
            raise RouterError("invalid_output") from None

    def parse(self, kind, body, stream):
        if "error" in body:
            raise RouterError("provider_unavailable", 503, True)
        if kind in ("openai", "compatible"):
            usage = body.get("usage") or {}
            yield usage_event(usage.get("prompt_tokens"), usage.get("completion_tokens"))
            choices = body.get("choices", [])
            if choices:
                choice = choices[0]
                content = choice.get("delta" if stream else "message", {}).get("content")
                if content is not None:
                    if not isinstance(content, str):
                        raise RouterError("invalid_output")
                    yield {"type": "text", "text": content}
                if choice.get("finish_reason"):
                    yield {"type": "finish", "ok": choice["finish_reason"] == "stop"}
        elif kind == "anthropic":
            if not stream:
                usage = body.get("usage", {})
                yield usage_event(usage.get("input_tokens"), usage.get("output_tokens"))
                for block in body.get("content", []):
                    if block.get("type") == "text":
                        yield {"type": "text", "text": block["text"]}
                yield {"type": "finish", "ok": body.get("stop_reason") in ("end_turn", "stop_sequence")}
            elif body.get("type") == "message_start":
                usage = body.get("message", {}).get("usage", {})
                yield usage_event(usage.get("input_tokens"), usage.get("output_tokens"))
            elif body.get("type") == "content_block_delta":
                delta = body.get("delta", {})
                if delta.get("type") == "text_delta":
                    yield {"type": "text", "text": delta["text"]}
            elif body.get("type") == "message_delta":
                yield usage_event(output_tokens=body.get("usage", {}).get("output_tokens"))
                yield {"type": "finish", "ok": body.get("delta", {}).get("stop_reason") in ("end_turn", "stop_sequence")}
        else:
            usage = body.get("usageMetadata", {})
            candidates_tokens = token_count(usage.get("candidatesTokenCount"))
            thoughts_tokens = token_count(usage.get("thoughtsTokenCount"))
            output_tokens = None if candidates_tokens is None else candidates_tokens + (thoughts_tokens or 0)
            yield usage_event(usage.get("promptTokenCount"), output_tokens)
            candidates = body.get("candidates", [])
            if candidates:
                candidate = candidates[0]
                for part in candidate.get("content", {}).get("parts", []):
                    if "text" in part and not part.get("thought", False):
                        yield {"type": "text", "text": part["text"]}
                if candidate.get("finishReason"):
                    yield {"type": "finish", "ok": candidate["finishReason"] == "STOP"}
