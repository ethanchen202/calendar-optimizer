from __future__ import annotations

import json
import re
from typing import Any


class GeminiSchedulerClient:
    def __init__(self, api_key: str | None, model_name: str) -> None:
        self._model = None
        self._model_name = model_name
        self._api_key = api_key
        if not api_key:
            return

        try:
            import google.generativeai as genai
        except ImportError:
            return

        try:
            genai.configure(api_key=api_key)
            self._model = genai.GenerativeModel(model_name=model_name)
        except Exception:
            self._model = None

    @property
    def enabled(self) -> bool:
        return self._model is not None

    def generate_schedule(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self._model:
            return None

        prompt = (
            "You are a scheduling engine.\n"
            "Generate a schedule for tasks around existing calendar events and user energy notes.\n"
            "Output strict JSON only with this schema:\n"
            "{\n"
            '  "schedule_events": [{"id": "str", "task_id": "str", "title": "str", "start": "ISO-8601", "end": "ISO-8601"}],\n'
            '  "unscheduled_tasks": [{"task_id": "str", "reason": "str"}]\n'
            "}\n"
            "Do not include markdown or extra commentary.\n\n"
            f"Input JSON:\n{json.dumps(payload, indent=2, default=str)}"
        )

        try:
            response = self._model.generate_content(prompt)
            content = getattr(response, "text", None)
            if not content:
                return None
            return self._extract_json(content)
        except Exception:
            return None

    def analyze_chat_delta(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self._model:
            return None

        prompt = (
            "You are an assistant that interprets user chat into structured scheduling changes.\n"
            "Return strict JSON only with this schema:\n"
            "{\n"
            '  "assistant_message": "string",\n'
            '  "detected_emotions": ["string"],\n'
            '  "delta": {\n'
            '    "tasks_add": [{"id":"str","title":"str","duration_minutes":60,"priority":3,"deadline":"ISO-8601 or null","preferred_time_window":{"start_hour":0,"end_hour":0} or null,"split_allowed":true}],\n'
            '    "task_ids_remove": ["str"],\n'
            '    "task_title_contains_remove": ["str"],\n'
            '    "calendar_add": [{"id":"str","title":"str","start":"ISO-8601","end":"ISO-8601"}],\n'
            '    "calendar_ids_remove": ["str"],\n'
            '    "calendar_title_contains_remove": ["str"],\n'
            '    "energy_profile_append": "string or null",\n'
            '    "energy_profile_replace": "string or null"\n'
            "  }\n"
            "}\n"
            "Guidance:\n"
            "- Detect emotions from the chat text.\n"
            "- If user asks for task/calendar changes, include only intended changes.\n"
            "- If user only shares mood/energy, set energy_profile_append with a concise note.\n"
            "- Do not include markdown.\n\n"
            f"Input JSON:\n{json.dumps(payload, indent=2, default=str)}"
        )

        try:
            response = self._model.generate_content(prompt)
            content = getattr(response, "text", None)
            if not content:
                return None
            return self._extract_json(content)
        except Exception:
            return None

    def _extract_json(self, text: str) -> dict[str, Any] | None:
        fenced_match = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, flags=re.DOTALL)
        if fenced_match:
            candidate = fenced_match.group(1)
        else:
            start = text.find("{")
            end = text.rfind("}")
            if start == -1 or end == -1 or end <= start:
                return None
            candidate = text[start : end + 1]

        try:
            parsed = json.loads(candidate)
            if not isinstance(parsed, dict):
                return None
            return parsed
        except json.JSONDecodeError:
            return None
