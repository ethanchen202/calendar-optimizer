from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class JsonStore:
    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _default_state(self) -> dict[str, Any]:
        return {"users": {}}

    def _read_state(self) -> dict[str, Any]:
        if not self._file_path.exists():
            return self._default_state()

        try:
            return json.loads(self._file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return self._default_state()

    def _write_state(self, state: dict[str, Any]) -> None:
        temp_path = self._file_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        temp_path.replace(self._file_path)

    def _ensure_user(self, state: dict[str, Any], user_id: str) -> dict[str, Any]:
        users = state.setdefault("users", {})
        user_state = users.setdefault(user_id, {})
        user_state.setdefault("tasks", [])
        user_state.setdefault("energy_profile", None)
        user_state.setdefault("checkins", [])
        return user_state

    def get_user_state(self, user_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            return {
                "tasks": user_state["tasks"],
                "energy_profile": user_state["energy_profile"],
                "checkins": user_state["checkins"],
            }

    def sync_tasks(self, user_id: str, tasks: list[dict[str, Any]]) -> None:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            user_state["tasks"] = tasks
            self._write_state(state)

    def delete_task(self, user_id: str, task_id: str) -> bool:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            before = len(user_state["tasks"])
            user_state["tasks"] = [task for task in user_state["tasks"] if task.get("id") != task_id]
            deleted = len(user_state["tasks"]) < before
            if deleted:
                self._write_state(state)
            return deleted

    def update_energy_profile(self, user_id: str, description: str) -> None:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            user_state["energy_profile"] = description
            self._write_state(state)

    def add_checkin(
        self,
        user_id: str,
        feedback: str,
        satisfaction: int | None = None,
        submitted_at: datetime | None = None,
    ) -> None:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            checkin_timestamp = submitted_at or datetime.now(timezone.utc)
            user_state["checkins"].append(
                {
                    "feedback": feedback,
                    "satisfaction": satisfaction,
                    "submitted_at": checkin_timestamp.isoformat(),
                }
            )
            self._write_state(state)

