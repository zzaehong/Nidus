"""Local-only ASGI boundary with bounded bodies and reliable disconnect signals."""
import asyncio
from contextlib import suppress
import ipaddress

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

from .errors import RouterError
from .store import identifier


class LocalBoundary:
    def __init__(self, app, port):
        self.app = app
        self.origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        state = scope.setdefault("state", {})
        state["request_id"] = identifier()
        disconnected = state["disconnected"] = asyncio.Event()
        headers = Headers(scope=scope)
        response_started = False

        async def secure_send(message):
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                outgoing = MutableHeaders(scope=message)
                outgoing.update({"X-Request-ID": state["request_id"], "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
                    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
            await send(message)

        async def fail(error):
            await JSONResponse(error.body(state["request_id"]), status_code=error.status)(scope, receive, secure_send)

        try:
            local = ipaddress.ip_address((scope.get("client") or ("", 0))[0]).is_loopback
        except ValueError:
            local = False
        origin = headers.get("origin")
        host = headers.get("host")
        if not local or host not in self.hosts or (origin is not None and origin not in self.origins):
            return await fail(RouterError("forbidden", 403))
        if scope["path"].startswith("/admin/") and scope["method"] not in ("GET", "HEAD"):
            if origin != f"http://{host}":
                return await fail(RouterError("forbidden", 403))

        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > 512 * 1024:
                return await fail(RouterError("invalid_request", 413))
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def replay_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def observe_disconnect():
            while True:
                if (await receive())["type"] == "http.disconnect":
                    disconnected.set()
                    return

        monitor = asyncio.create_task(observe_disconnect())
        try:
            await self.app(scope, replay_receive, secure_send)
        except Exception:
            # Never log raw upstream exceptions: they can contain credentials or content.
            if not response_started:
                await fail(RouterError("internal_error", 500))
        finally:
            monitor.cancel()
            with suppress(asyncio.CancelledError):
                await monitor
