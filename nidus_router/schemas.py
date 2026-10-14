import ipaddress
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Generate(StrictModel):
    input: str = Field(min_length=1, max_length=100_000)
    model: str = Field(default="auto", min_length=1, max_length=100)
    stream: bool = False


class Connection(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    provider: Literal["openai", "anthropic", "gemini", "compatible"]
    base_url: str = Field(max_length=2048)
    api_key: str | None = Field(default=None, min_length=1, max_length=8192)
    enabled: bool = True

    @field_validator("base_url")
    @classmethod
    def url(cls, value):
        url = urlsplit(value)
        try:
            url.port
        except ValueError:
            raise ValueError("invalid URL") from None
        if (url.scheme not in ("http", "https") or not url.hostname or url.username
                or url.password or url.query or url.fragment
                or any(c.isspace() or ord(c) < 32 for c in value)):
            raise ValueError("invalid URL")
        local = url.hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(url.hostname).is_loopback
        except ValueError:
            pass
        if url.scheme == "http" and not local:
            raise ValueError("HTTPS required outside loopback")
        return value.rstrip("/")

    @field_validator("api_key")
    @classmethod
    def key(cls, value):
        if value is not None and any(ord(c) < 32 or ord(c) > 126 for c in value):
            raise ValueError("invalid key")
        return value


class Model(StrictModel):
    connection_id: str
    name: str = Field(min_length=1, max_length=120)
    upstream_model: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._:/@-]+$")
    enabled: bool = True
    pricing: Literal["unknown", "free", "paid"] = "unknown"
    priority: int = Field(default=0, ge=0, le=10000)
    prompt_override: str | None = Field(default=None, max_length=100_000)
    fallback_ids: list[str] = Field(default_factory=list, max_length=50)
    input_per_million: float | None = Field(default=None, ge=0, le=100000)
    output_per_million: float | None = Field(default=None, ge=0, le=100000)


class Settings(StrictModel):
    system_prompt: str = Field(default="You are a helpful assistant.", max_length=100_000)
    output_format: Literal["text", "json"] = "text"
    max_output_tokens: int = Field(default=1024, ge=1, le=16384)
    timeout_seconds: int = Field(default=60, ge=1, le=300)
    approved_model_ids: list[str] = Field(default_factory=list, max_length=200)
    monthly_budget_usd: float = Field(default=0, ge=0, le=100000)
    store_bodies: bool = False
    retention_days: int = Field(default=30, ge=1, le=365)


class Login(StrictModel):
    token: str = Field(min_length=1, max_length=256)


class BudgetApproval(StrictModel):
    approved_model_ids: list[str] = Field(max_length=200)
    monthly_budget_usd: float = Field(ge=0, le=100000)
    terms: dict[str, str]
