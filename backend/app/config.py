from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str
    ai_provider: str
    gemini_api_key: str | None
    gemini_model: str
    modal_vllm_endpoint: str | None
    modal_vllm_api_key: str | None
    modal_vllm_model: str
    modal_vllm_timeout_seconds: float
    data_file: Path


def _float_env(var_name: str, default: float) -> float:
    raw_value = os.getenv(var_name)
    if not raw_value:
        return default
    try:
        return float(raw_value)
    except ValueError:
        return default


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    backend_root = Path(__file__).resolve().parent.parent
    data_path = os.getenv("DATA_STORE_PATH", str(backend_root / "data" / "store.json"))
    return Settings(
        app_name="Calendar Optimizer API",
        ai_provider=os.getenv("AI_PROVIDER", "gemini").strip().lower(),
        gemini_api_key=os.getenv("GEMINI_API_KEY"),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-1.5-flash"),
        modal_vllm_endpoint=os.getenv("MODAL_VLLM_ENDPOINT"),
        modal_vllm_api_key=os.getenv("MODAL_VLLM_API_KEY"),
        modal_vllm_model=os.getenv("MODAL_VLLM_MODEL", "Qwen/Qwen2.5-7B-Instruct"),
        modal_vllm_timeout_seconds=_float_env("MODAL_VLLM_TIMEOUT_SECONDS", 30.0),
        data_file=Path(data_path),
    )
