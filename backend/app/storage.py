from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .energy_profile import default_energy_profile


class JsonStore:
    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path
        self._file_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _default_state(self) -> dict[str, Any]:
        return {"users": {}}

    def _default_energy_profile_payload(self, timezone_name: str = "UTC") -> dict[str, Any]:
        return default_energy_profile(timezone_name=timezone_name).model_dump(mode="json")

    def _normalize_energy_profile(self, value: Any) -> dict[str, Any]:
        if isinstance(value, dict):
            if "intervals" in value and isinstance(value["intervals"], list):
                if "version" not in value:
                    value["version"] = 1
                if "timezone" not in value:
                    value["timezone"] = "UTC"
                if "updated_at" not in value:
                    value["updated_at"] = datetime.now(timezone.utc).isoformat()
                return value
        if isinstance(value, str):
            profile = self._default_energy_profile_payload("UTC")
            profile["freeform_notes"] = value
            return profile
        return self._default_energy_profile_payload("UTC")

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
        user_state.setdefault("calendar_events", [])
        user_state["energy_profile"] = self._normalize_energy_profile(user_state.get("energy_profile"))
        user_state.setdefault("checkins", [])
        return user_state

    def get_user_state(self, user_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            self._write_state(state)
            return {
                "tasks": user_state["tasks"],
                "calendar_events": user_state["calendar_events"],
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

    def sync_calendar_events(self, user_id: str, events: list[dict[str, Any]]) -> None:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            user_state["calendar_events"] = events
            self._write_state(state)

    def update_energy_profile(self, user_id: str, profile: dict[str, Any]) -> None:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)
            user_state["energy_profile"] = self._normalize_energy_profile(profile)
            user_state["energy_profile"]["updated_at"] = datetime.now(timezone.utc).isoformat()
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

    def apply_chat_delta(
        self,
        user_id: str,
        delta: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            state = self._read_state()
            user_state = self._ensure_user(state, user_id)

            tasks_by_id = {
                str(task.get("id", "")).strip(): task
                for task in user_state["tasks"]
                if str(task.get("id", "")).strip()
            }
            for task in delta.get("tasks_add", []):
                task_id = str(task.get("id", "")).strip()
                if task_id:
                    tasks_by_id[task_id] = task

            remove_ids = {
                str(task_id).strip()
                for task_id in delta.get("task_ids_remove", [])
                if str(task_id).strip()
            }
            remove_keywords = [
                str(keyword).strip().lower()
                for keyword in delta.get("task_title_contains_remove", [])
                if str(keyword).strip()
            ]
            user_state["tasks"] = [
                task
                for task in tasks_by_id.values()
                if task.get("id") not in remove_ids
                and not any(keyword in str(task.get("title", "")).lower() for keyword in remove_keywords)
            ]

            events_by_id = {
                str(event.get("id", "")).strip(): event
                for event in user_state["calendar_events"]
                if str(event.get("id", "")).strip()
            }
            for event in delta.get("calendar_add", []):
                event_id = str(event.get("id", "")).strip()
                if event_id:
                    events_by_id[event_id] = event
                else:
                    synthetic_id = f"calendar_{len(events_by_id) + 1}"
                    event_copy = dict(event)
                    event_copy["id"] = synthetic_id
                    events_by_id[synthetic_id] = event_copy

            remove_event_ids = {
                str(event_id).strip()
                for event_id in delta.get("calendar_ids_remove", [])
                if str(event_id).strip()
            }
            remove_event_keywords = [
                str(keyword).strip().lower()
                for keyword in delta.get("calendar_title_contains_remove", [])
                if str(keyword).strip()
            ]
            user_state["calendar_events"] = [
                event
                for event in events_by_id.values()
                if event.get("id") not in remove_event_ids
                and not any(
                    keyword in str(event.get("title", "")).lower() for keyword in remove_event_keywords
                )
            ]

            energy_profile = self._normalize_energy_profile(user_state.get("energy_profile"))
            if delta.get("energy_clear_all"):
                energy_profile["intervals"] = []

            existing_intervals = {
                str(interval.get("id", "")).strip(): interval
                for interval in energy_profile.get("intervals", [])
                if str(interval.get("id", "")).strip()
            }
            remove_energy_ids = {
                str(interval_id).strip()
                for interval_id in delta.get("energy_interval_ids_remove", [])
                if str(interval_id).strip()
            }
            for remove_id in remove_energy_ids:
                existing_intervals.pop(remove_id, None)

            for interval in delta.get("energy_intervals_add", []):
                interval_id = str(interval.get("id", "")).strip()
                if interval_id:
                    existing_intervals[interval_id] = interval

            energy_profile["intervals"] = list(existing_intervals.values())

            note = str(delta.get("energy_notes_append") or "").strip()
            if note:
                existing_notes = str(energy_profile.get("freeform_notes") or "").strip()
                energy_profile["freeform_notes"] = (
                    f"{existing_notes}\n{note}" if existing_notes else note
                )

            energy_profile["updated_at"] = datetime.now(timezone.utc).isoformat()
            user_state["energy_profile"] = energy_profile

            self._write_state(state)
            return {
                "tasks": user_state["tasks"],
                "calendar_events": user_state["calendar_events"],
                "energy_profile": user_state["energy_profile"],
                "checkins": user_state["checkins"],
            }

