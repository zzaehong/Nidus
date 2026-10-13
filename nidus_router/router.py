import asyncio
from contextlib import aclosing
from datetime import timezone
from decimal import Decimal
import json
import time

from .errors import RouterError
from .providers import MAX_RESPONSE_BYTES, Provider
from .store import money, usd

JSON_INSTRUCTION = "Return only one valid JSON value. No Markdown fences or surrounding explanation."


def effective_prompt(settings, model):
    prompt = model["prompt_override"] if model["prompt_override"] is not None else settings["system_prompt"]
    if settings["output_format"] == "json":
        prompt += "\n\n" + JSON_INSTRUCTION
    return prompt


def cost(model, input_tokens, output_tokens):
    if model["pricing"] == "free":
        return 0
    if input_tokens is None or output_tokens is None:
        return None
    return money((Decimal(str(model["input_per_million"])) * input_tokens
                  + Decimal(str(model["output_per_million"])) * output_tokens) / 1_000_000)


def strict_json(text):
    def invalid(_):
        raise ValueError()

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError()
            value[key] = item
        return value

    try:
        value = json.loads(text, parse_constant=invalid, object_pairs_hook=unique)
        # Catch overflowing JSON numbers too (e.g. 1e999).
        json.dumps(value, allow_nan=False)
        return value
    except (ValueError, TypeError, RecursionError):
        raise RouterError("invalid_output") from None


class Router:
    def __init__(self, store, secrets, client):
        self.store, self.secrets = store, secrets
        self.provider = Provider(client)

    def prepare(self, request):
        snapshot = self.store.snapshot()
        settings, models, connections = snapshot["settings"], snapshot["models"], snapshot["connections"]
        if len(request.input.encode("utf-8")) > 128 * 1024:
            raise RouterError("invalid_request", 413)
        if request.stream and settings["output_format"] == "json":
            raise RouterError("json_stream_not_supported", 422)
        if request.model == "auto":
            candidates = sorted((m for m in models.values() if m["pricing"] != "unknown"),
                                key=lambda m: (m["pricing"] != "free", m["priority"], m["id"]))
        else:
            if request.model not in models:
                raise RouterError("not_found", 404)
            first = models[request.model]
            if first["pricing"] == "unknown":
                raise RouterError("unknown_pricing", 422)
            if first["pricing"] == "paid" and (first["id"] not in settings["approved_model_ids"]
                                              or settings["monthly_budget_usd"] <= 0):
                raise RouterError("paid_not_approved", 403)
            candidates = [first] + [models[x] for x in first["fallback_ids"] if x in models]
        candidates = [m for m in candidates if m["enabled"] and connections[m["connection_id"]]["enabled"]]
        if not candidates:
            raise RouterError("no_available_model", 503)
        return snapshot, candidates

    async def run(self, request, request_id, prepared):
        snapshot, candidates = prepared
        settings = snapshot["settings"]
        began = time.monotonic()
        record = {"request_id": request_id, "timestamp": self.store.clock().astimezone(timezone.utc).isoformat(),
                  "requested_model": request.model, "status": "error", "model": None, "attempts": []}
        if settings["store_bodies"]:
            record["input"] = request.input
        last_error = RouterError("no_available_model", 503)
        try:
            for model in candidates:
                connection = snapshot["connections"][model["connection_id"]]
                attempt = {"model": model["id"], "status": "error", "error": None,
                           "input_tokens": None, "output_tokens": None, "estimated_cost_usd": None}
                record["attempts"].append(attempt)
                reservation, charged, emitted, invoked = None, None, False, False
                parts, length, finished = [], 0, False
                started = time.monotonic()
                try:
                    if model["pricing"] == "unknown":
                        raise RouterError("unknown_pricing", 422, True)
                    if model["pricing"] == "paid":
                        if model["id"] not in settings["approved_model_ids"] or settings["monthly_budget_usd"] <= 0:
                            raise RouterError("paid_not_approved", 403, True)
                        if model["input_per_million"] is None or model["output_per_million"] is None:
                            raise RouterError("unknown_pricing", 422, True)
                    key = self.secrets.get(connection["credential_ref"])
                    prompt = effective_prompt(settings, model)
                    if model["pricing"] == "paid":
                        # Conservative byte-based estimate, including allowance for provider framing.
                        # This is a local estimate, not a provider billing guarantee.
                        estimate = cost(model, len((prompt + request.input).encode("utf-8")) + 256,
                                        settings["max_output_tokens"])
                        reservation = self.store.reserve(request_id, model, estimate, settings["monthly_budget_usd"])
                        charged = estimate
                    invoked = True
                    async with asyncio.timeout(settings["timeout_seconds"]):
                        async with aclosing(self.provider.events(connection, model, key, prompt,
                                                                  request.input, settings, request.stream)) as events:
                            async for event in events:
                                if event["type"] == "usage":
                                    for field in ("input_tokens", "output_tokens"):
                                        if event[field] is not None:
                                            attempt[field] = event[field]
                                elif event["type"] == "finish":
                                    finished = event["ok"]
                                elif event["type"] == "text":
                                    if not isinstance(event["text"], str):
                                        raise RouterError("invalid_output")
                                    length += len(event["text"].encode("utf-8"))
                                    if length > MAX_RESPONSE_BYTES:
                                        raise RouterError("invalid_output")
                                    parts.append(event["text"])
                                    if request.stream and event["text"]:
                                        emitted = True
                                        yield {"event": "delta", "data": {"request_id": request_id,
                                               "model": model["id"], "text": event["text"]}}
                    output = "".join(parts)
                    if not finished or not output.strip():
                        raise RouterError("invalid_output")
                    if settings["output_format"] == "json":
                        output = strict_json(output)
                    attempt["status"] = "success"
                    record.update({"status": "success", "model": model["id"]})
                    if settings["store_bodies"]:
                        record["output"] = output
                except (asyncio.CancelledError, GeneratorExit):
                    attempt["error"] = "cancelled"
                    record["error"] = "cancelled"
                    raise
                except (RouterError, TimeoutError) as error:
                    if isinstance(error, TimeoutError):
                        error = RouterError("provider_unavailable", 503, True)
                    last_error = error
                    attempt["error"] = error.code
                    if emitted or (not error.retryable and error.code not in
                                   ("paid_not_approved", "budget_exceeded", "unknown_pricing")):
                        raise error
                    continue
                finally:
                    if invoked:
                        actual = cost(model, attempt["input_tokens"], attempt["output_tokens"])
                        self.store.settle(reservation, actual)
                        if actual is not None:
                            charged = actual
                    elif reservation:
                        self.store.settle(reservation, 0)
                        charged = 0
                    attempt["estimated_cost_usd"] = usd(charged) if charged is not None else None
                    attempt["latency_ms"] = round((time.monotonic() - started) * 1000)
                response = {"request_id": request_id, "model": model["id"], "output": output,
                            "usage": {k: attempt[k] for k in ("input_tokens", "output_tokens", "estimated_cost_usd")}}
                # Persist before emitting done, so a successful response has an audit record.
                record["latency_ms"] = round((time.monotonic() - began) * 1000)
                self.store.record(record)
                yield {"event": "done", "data": response}
                return
            raise last_error
        except RouterError as error:
            record["error"] = error.code
            raise
        finally:
            record["latency_ms"] = round((time.monotonic() - began) * 1000)
            self.store.record(record)
