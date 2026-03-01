from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_name: str
    gemini_api_key: str | None
    gemini_model: str
    data_file: Path


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    backend_root = Path(__file__).resolve().parent.parent
    data_path = os.getenv("DATA_STORE_PATH", str(backend_root / "data" / "store.json"))
    return Settings(
        app_name="Calendar Optimizer API",
        gemini_api_key=os.getenv("GEMINI_API_KEY"),
        gemini_model=os.getenv("GEMINI_MODEL", "gemini-1.5-flash"),
        data_file=Path(data_path),
    )

