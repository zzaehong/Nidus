import asyncio
from contextlib import aclosing, asynccontextmanager, suppress
import hmac
import json
from pathlib import Path
import time

from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
import httpx

from .errors import RouterError
from .catalog import model_status
from .discovery import identity
from .boundary import LocalBoundary
from .router import Router, effective_prompt
from .schemas import BudgetApproval, Connection, Generate, Login, Model, Settings
from .secrets import OSSecrets, digest, new_token
from .store import Store, approval_terms, identifier

STATIC = Path(__file__).parent / "static"


def public_connection(value):
    return {k: v for k, v in value.items() if k != "credential_ref"} | {"credential_configured": True}


def sse(event):
    return "event: " + event["event"] + "\ndata: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"


def create_app(directory=None, *, store=None, secrets=None, client=None, port=8787):
    store = store or Store(directory or Path.home() / ".local/share/nidus-router")
    secrets = secrets or OSSecrets(store.directory)
    owns_client = client is None
    client = client or httpx.AsyncClient(follow_redirects=False, trust_env=False)
    router = Router(store, secrets, client)
    sessions = {}

    @asynccontextmanager
    async def lifespan(app):
        store.prune()

        async def cleanup():
            while True:
                await asyncio.sleep(3600)
                store.prune()

        cleanup_task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            cleanup_task.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup_task
            await router.discovery.close()
            if owns_client:
                await client.aclose()

    app = FastAPI(title="Nidus Router", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.router = store, router
    app.add_middleware(LocalBoundary, port=port)

    @app.exception_handler(RouterError)
    async def router_error(request, error):
        return JSONResponse(error.body(request.state.request_id), status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # FastAPI's default validation response includes the rejected input, possibly an API key.
        return JSONResponse(RouterError("invalid_request", 422).body(request.state.request_id), status_code=422)

    def bearer(request: Request):
        header = request.headers.get("authorization", "")
        expected = store.auth_hash("api")
        if not header.startswith("Bearer ") or not expected or not hmac.compare_digest(digest(header[7:]), expected):
            raise RouterError("unauthorized", 401)

    def admin(request: Request):
        session = sessions.get(digest(request.cookies.get("nidus_admin", "")))
        if not session or session[0] <= time.monotonic() or session[1] != store.auth_hash("admin"):
            raise RouterError("unauthorized", 401)

    @app.get("/")
    async def dashboard():
        return FileResponse(STATIC / "index.html")

    @app.get("/static/{name}")
    async def asset(name: str):
        if name not in ("app.js", "style.css"):
            raise RouterError("not_found", 404)
        return FileResponse(STATIC / name)

    @app.post("/admin/login")
    async def login(value: Login):
        expected = store.auth_hash("admin")
        if not expected or not hmac.compare_digest(digest(value.token), expected):
            raise RouterError("unauthorized", 401)
        token = new_token()
        for key, entry in list(sessions.items()):
            if entry[0] <= time.monotonic():
                sessions.pop(key, None)
        if len(sessions) >= 20:
            sessions.pop(next(iter(sessions)))
        sessions[digest(token)] = (time.monotonic() + 8 * 3600, expected)
        response = JSONResponse({"ok": True})
        response.set_cookie("nidus_admin", token, httponly=True, samesite="strict", max_age=8 * 3600, path="/admin")
        return response

    @app.post("/admin/logout", dependencies=[Depends(admin)])
    async def logout(request: Request):
        sessions.pop(digest(request.cookies.get("nidus_admin", "")), None)
        response = JSONResponse({"ok": True})
        response.delete_cookie("nidus_admin", path="/admin")
        return response

    @app.get("/admin/state", dependencies=[Depends(admin)])
    async def state():
        snapshot = store.snapshot()
        return {"settings": snapshot["settings"], "budget": store.budget(),
                "connections": [public_connection(c) for c in snapshot["connections"].values()],
                "models": [m | {"status": model_status(m, snapshot["connections"][m["connection_id"]], snapshot["settings"]),
                                 "effective_prompt": effective_prompt(snapshot["settings"], m),
                                 "approval_terms": approval_terms(m, snapshot["connections"][m["connection_id"]])}
                           for m in snapshot["models"].values()]}

    @app.put("/admin/settings", dependencies=[Depends(admin)])
    async def save_settings(value: Settings):
        return store.save_settings(value.model_dump(), allow_approval_changes=False)

    @app.put("/admin/budget", dependencies=[Depends(admin)])
    async def approve_budget(value: BudgetApproval):
        return store.approve_budget(value.model_dump())

    async def write_connection(value, connection_id=None):
        old = store.snapshot()["connections"].get(connection_id) if connection_id else None
        if connection_id and not old:
            raise RouterError("not_found", 404)
        if not old and not value.api_key:
            raise RouterError("invalid_request", 422)
        reference = identifier() if value.api_key else old["credential_ref"]
        if value.api_key:
            secrets.set(reference, value.api_key)
        data = value.model_dump(exclude={"api_key"}) | {"credential_ref": reference}
        try:
            saved = store.save_connection(data, connection_id)
        except BaseException:
            if value.api_key:
                secrets.delete(reference)
            raise
        if old and reference != old["credential_ref"]:
            secrets.delete(old["credential_ref"])
        if not old or identity(old) != identity(saved):
            await router.discovery.refresh(saved["id"])
            saved = store.snapshot()["connections"].get(saved["id"])
            if saved is None:
                raise RouterError("not_found", 404)
        return public_connection(saved)

    @app.post("/admin/connections", dependencies=[Depends(admin)], status_code=201)
    async def add_connection(value: Connection):
        return await write_connection(value)

    @app.put("/admin/connections/{connection_id}", dependencies=[Depends(admin)])
    async def update_connection(connection_id: str, value: Connection):
        return await write_connection(value, connection_id)

    @app.post("/admin/connections/{connection_id}/refresh", dependencies=[Depends(admin)])
    async def refresh_models(connection_id: str):
        return await router.discovery.refresh(connection_id)

    @app.delete("/admin/connections/{connection_id}", dependencies=[Depends(admin)])
    async def delete_connection(connection_id: str):
        snapshot = store.snapshot()
        old = snapshot["connections"].get(connection_id)
        if not old:
            raise RouterError("not_found", 404)
        if any(m["connection_id"] == connection_id for m in snapshot["models"].values()):
            raise RouterError("configuration_conflict", 409)
        secrets.delete(old["credential_ref"])
        store.delete_connection(connection_id)
        return {"ok": True}

    @app.post("/admin/models", dependencies=[Depends(admin)], status_code=201)
    async def add_model(value: Model):
        return store.save_model(value.model_dump())

    @app.put("/admin/models/{model_id}", dependencies=[Depends(admin)])
    async def update_model(model_id: str, value: Model):
        if model_id not in store.snapshot()["models"]:
            raise RouterError("not_found", 404)
        return store.save_model(value.model_dump(), model_id)

    @app.delete("/admin/models/{model_id}", dependencies=[Depends(admin)])
    async def delete_model(model_id: str):
        store.delete_model(model_id)
        return {"ok": True}

    @app.get("/admin/records", dependencies=[Depends(admin)])
    async def records(offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100)):
        return {"records": store.records(offset, limit)}

    @app.delete("/admin/records", dependencies=[Depends(admin)])
    async def clear_records():
        store.clear_records()
        return {"ok": True}

    @app.post("/admin/api-key/rotate", dependencies=[Depends(admin)])
    async def rotate_api_key():
        return {"api_key": store.rotate_token("api")}

    @app.get("/admin/openapi.json", dependencies=[Depends(admin)])
    async def schema():
        return app.openapi()

    @app.get("/api/v1/models", dependencies=[Depends(bearer)])
    async def models():
        snapshot = store.snapshot()
        return {"models": [{k: m[k] for k in ("id", "name", "pricing")} |
                           {"status": model_status(m, snapshot["connections"][m["connection_id"]], snapshot["settings"])}
                           for m in snapshot["models"].values()
                           if m["enabled"] and snapshot["connections"][m["connection_id"]]["enabled"]]}

    async def generate_response(value, request_id):
        try:
            prepared = router.prepare(value)
        except RouterError as error:
            record = {"request_id": request_id, "timestamp": store.clock().isoformat(),
                      "requested_model": value.model, "status": "error", "error": error.code,
                      "model": None, "attempts": [], "latency_ms": 0}
            store.record(record)
            raise
        events = router.run(value, request_id, prepared)
        if not value.stream:
            async with aclosing(events):
                async for event in events:
                    if event["event"] == "done":
                        return JSONResponse(event["data"])
        # Defer HTTP 200 until routing succeeds or produces its first text chunk.
        try:
            first = await anext(events)
        except BaseException:
            await events.aclose()
            raise

        async def body():
            try:
                async with aclosing(events):
                    yield sse(first)
                    async for event in events:
                        yield sse(event)
            except RouterError as error:
                yield sse({"event": "error", "data": error.body(request_id)})
            except Exception:
                yield sse({"event": "error", "data": RouterError("internal_error", 500).body(request_id)})

        return StreamingResponse(body(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})

    @app.post("/api/v1/generate", dependencies=[Depends(bearer)])
    async def generate(value: Generate, request: Request):
        return await connected_generate(value, request)

    @app.post("/admin/test", dependencies=[Depends(admin)])
    async def test_model(value: Generate, request: Request):
        # Uses the same routing, approvals and ledger as real client calls.
        return await connected_generate(value, request)

    async def connected_generate(value, request):
        # Also cancel while waiting for a non-stream response or the first SSE event.
        task = asyncio.create_task(generate_response(value, request.state.request_id))
        disconnected = False

        async def watch_disconnect():
            nonlocal disconnected
            await request.state.disconnected.wait()
            disconnected = True
            task.cancel()

        watcher = asyncio.create_task(watch_disconnect())
        try:
            return await task
        except asyncio.CancelledError:
            if disconnected:
                error = RouterError("cancelled", 499)
                return JSONResponse(error.body(request.state.request_id), status_code=499)
            raise
        finally:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher

    return app
