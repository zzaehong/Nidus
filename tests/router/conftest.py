import secrets as random_secrets

import httpx
import pytest

from nidus_router.schemas import Connection, Model
from nidus_router.store import Store, identifier


class MemorySecrets:
    """Only tests inject this; production never falls back to memory or plaintext."""
    def __init__(self):
        self.values = {}

    def get(self, reference):
        return self.values[reference]

    def set(self, reference, value):
        self.values[reference] = value

    def delete(self, reference):
        del self.values[reference]


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "data")


@pytest.fixture
def credentials():
    return MemorySecrets()


@pytest.fixture
def add_model(store, credentials):
    def add(provider="compatible", **kwargs):
        reference = identifier()
        credentials.set(reference, random_secrets.token_urlsafe(24))
        connection = store.save_connection(Connection(name=provider, provider=provider,
            base_url="https://provider.invalid/v1").model_dump(exclude={"api_key"}) | {"credential_ref": reference})
        return store.save_model(Model(connection_id=connection["id"], name=provider,
            upstream_model="example-model", **kwargs).model_dump())
    return add


def response(text="hello", finish="stop", usage=True):
    body = {"choices": [{"message": {"content": text}, "finish_reason": finish}]}
    if usage:
        body["usage"] = {"prompt_tokens": 10, "completion_tokens": 3}
    return httpx.Response(200, json=body)
