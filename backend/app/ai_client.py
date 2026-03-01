from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Protocol
from urllib import error, request

logger = logging.getLogger(__name__)


class SchedulerAIClient(Protocol):
    @property
    def enabled(self) -> bool:
        ...

    @property
    def provider_name(self) -> str:
        ...

    def generate_schedule(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        ...

    def analyze_chat_delta(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        ...

    def extract_energy_profile_intervals(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        ...

    def warm_up(self) -> bool:
        ...


class PromptDrivenSchedulerClient:
    provider_name = "unknown"

    @property
    def enabled(self) -> bool:
        return False

    def generate_schedule(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self.enabled:
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

        return self._run_json_prompt(prompt, f"{self.provider_name} schedule generation failed.")

    def analyze_chat_delta(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self.enabled:
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
            '    "energy_intervals_add": [{"id":"str","start_time":"HH:MM","end_time":"HH:MM","energy_level":-3,"hard_block":false,"label":"str or null","notes":"str or null","recurrence":{"type":"daily|weekly|specific_date|date_range|monthly_nth_weekday|monthly_weekdays","days_of_week":[0],"week_of_month":1,"weekday":0,"date":"YYYY-MM-DD","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD"}}],\n'
            '    "energy_interval_ids_remove": ["str"],\n'
            '    "energy_clear_all": false,\n'
            '    "energy_notes_append": "string or null"\n'
            "  }\n"
            "}\n"
            "Guidance:\n"
            "- Detect emotions from the chat text.\n"
            "- If user asks for task/calendar changes, include only intended changes.\n"
            "- Put meetings, appointments, calls, and classes in `calendar_add` (fixed-time events).\n"
            "- Put actionable to-dos in `tasks_add` only when user asks for tasks/to-dos.\n"
            "- Do not convert calendar events into tasks.\n"
            "- If user shares mood/energy constraints, convert them into energy_intervals_add.\n"
            "- Do not add `energy_intervals_add` for plain event/task creation unless user explicitly states energy/mood/productivity constraints.\n"
            "- Use hard_block true when user says they are unavailable, busy, in exam/class, or cannot work.\n"
            "- Use `current_datetime` from the input JSON as the authoritative reference for relative dates.\n"
            "- For words like today/tomorrow/next week, never invent a past year.\n"
            "- Do not include markdown.\n\n"
            f"Input JSON:\n{json.dumps(payload, indent=2, default=str)}"
        )

        return self._run_json_prompt(prompt, f"{self.provider_name} chat analysis failed.")

    def extract_energy_profile_intervals(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not self.enabled:
            return None

        prompt = (
            "Convert this user energy description into structured energy intervals.\n"
            "Return strict JSON only with schema:\n"
            "{\n"
            '  "intervals": [\n'
            '    {\n'
            '      "id": "str",\n'
            '      "start_time": "HH:MM",\n'
            '      "end_time": "HH:MM",\n'
            '      "energy_level": -5 to 5,\n'
            '      "hard_block": true/false,\n'
            '      "label": "str or null",\n'
            '      "notes": "str or null",\n'
            '      "recurrence": {\n'
            '        "type": "daily|weekly|specific_date|date_range|monthly_nth_weekday|monthly_weekdays",\n'
            '        "days_of_week": [0],\n'
            '        "week_of_month": 1,\n'
            '        "weekday": 0,\n'
            '        "date": "YYYY-MM-DD",\n'
            '        "start_date": "YYYY-MM-DD",\n'
            '        "end_date": "YYYY-MM-DD"\n'
            "      }\n"
            "    }\n"
            "  ],\n"
            '  "notes_append": "string or null"\n'
            "}\n"
            "Mapping guidance:\n"
            "- Positive productivity windows -> positive energy_level (2 to 5).\n"
            "- Tired/slump windows -> negative energy_level (-2 to -4).\n"
            "- Unavailable/busy/exam windows -> energy_level -5 and hard_block true.\n"
            "- For phrases like '3rd week of every month', use monthly_weekdays with week_of_month=3.\n"
            "- For next-week/day-specific references, use specific_date.\n"
            "- No markdown.\n\n"
            f"Input JSON:\n{json.dumps(payload, indent=2, default=str)}"
        )

        return self._run_json_prompt(prompt, f"{self.provider_name} energy profile extraction failed.")

    def warm_up(self) -> bool:
        if not self.enabled:
            return False
        # Trigger one lightweight model call so first user interaction is less likely to pay cold-start costs.
        content = self._invoke_prompt('Return JSON only: {"ready": true}')
        return bool(content)

    def _run_json_prompt(self, prompt: str, error_log: str) -> dict[str, Any] | None:
        try:
            content = self._invoke_prompt(prompt)
            if not content:
                return None
            return self._extract_json(content)
        except Exception:
            logger.exception(error_log)
            return None

    def _invoke_prompt(self, prompt: str) -> str | None:
        raise NotImplementedError

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


class GeminiSchedulerClient(PromptDrivenSchedulerClient):
    provider_name = "gemini"

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

    def _invoke_prompt(self, prompt: str) -> str | None:
        if not self._model:
            return None
        try:
            response = self._model.generate_content(prompt)
            content = getattr(response, "text", None)
            return str(content) if content else None
        except Exception:
            logger.exception("Gemini prompt execution failed.")
            return None

class ModalVLLMSchedulerClient(PromptDrivenSchedulerClient):
    provider_name = "modal-vllm"

    def __init__(
        self,
        endpoint: str | None,
        model_name: str,
        api_key: str | None,
        request_timeout_seconds: float,
    ) -> None:
        self._endpoint = _normalize_endpoint(endpoint)
        self._model_name = model_name.strip()
        self._api_key = api_key.strip() if api_key else None
        self._timeout_seconds = max(1.0, request_timeout_seconds)

    @property
    def enabled(self) -> bool:
        return bool(self._endpoint and self._model_name)

    def warm_up(self) -> bool:
        if not self.enabled:
            return False

        health_url = self._health_url
        if health_url:
            headers = {}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"

            deadline = time.monotonic() + max(15.0, min(self._timeout_seconds * 3.0, 180.0))
            while True:
                try:
                    health_request = request.Request(url=health_url, headers=headers, method="GET")
                    with request.urlopen(health_request, timeout=min(5.0, self._timeout_seconds)):
                        break
                except Exception:
                    if time.monotonic() >= deadline:
                        return False
                    time.sleep(2.0)

        return super().warm_up()

    def _invoke_prompt(self, prompt: str) -> str | None:
        if not self.enabled:
            return None

        payload = {
            "model": self._model_name,
            "temperature": 0.1,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a scheduling assistant. Return only valid JSON when asked.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        request_obj = request.Request(
            url=self._chat_completions_url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with request.urlopen(request_obj, timeout=self._timeout_seconds) as response:
                raw_response = response.read().decode("utf-8")
        except error.HTTPError as exc:
            response_body = ""
            try:
                response_body = exc.read().decode("utf-8", errors="ignore")
            except Exception:
                response_body = ""
            logger.warning(
                "Modal vLLM request failed with status %s: %s",
                exc.code,
                response_body[:300],
            )
            return None
        except Exception:
            logger.exception("Modal vLLM request failed.")
            return None

        try:
            parsed_response = json.loads(raw_response)
        except json.JSONDecodeError:
            logger.warning("Modal vLLM returned non-JSON response payload.")
            return None

        choices = parsed_response.get("choices")
        if not isinstance(choices, list) or not choices:
            return None
        first_choice = choices[0]
        if not isinstance(first_choice, dict):
            return None
        message_payload = first_choice.get("message")
        if not isinstance(message_payload, dict):
            return None
        content = message_payload.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts = []
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        text_parts.append(text)
            return "".join(text_parts) if text_parts else None
        return None

    @property
    def _chat_completions_url(self) -> str:
        if not self._endpoint:
            return ""
        if self._endpoint.endswith("/chat/completions"):
            return self._endpoint
        if self._endpoint.endswith("/v1"):
            return f"{self._endpoint}/chat/completions"
        return f"{self._endpoint}/v1/chat/completions"

    @property
    def _health_url(self) -> str:
        if not self._endpoint:
            return ""
        if self._endpoint.endswith("/v1/chat/completions"):
            root = self._endpoint[: -len("/v1/chat/completions")]
            return f"{root}/health"
        if self._endpoint.endswith("/chat/completions"):
            root = self._endpoint[: -len("/chat/completions")]
            if root.endswith("/v1"):
                root = root[: -len("/v1")]
            return f"{root}/health"
        if self._endpoint.endswith("/v1"):
            return f"{self._endpoint[: -len('/v1')]}/health"
        return f"{self._endpoint}/health"


def _normalize_endpoint(endpoint: str | None) -> str | None:
    if endpoint is None:
        return None
    normalized = endpoint.strip().rstrip("/")
    return normalized or None


def create_scheduler_ai_client(
    provider: str,
    *,
    gemini_api_key: str | None,
    gemini_model: str,
    modal_vllm_endpoint: str | None,
    modal_vllm_api_key: str | None,
    modal_vllm_model: str,
    modal_vllm_timeout_seconds: float,
) -> SchedulerAIClient:
    normalized_provider = provider.strip().lower()
    if normalized_provider == "modal":
        return ModalVLLMSchedulerClient(
            endpoint=modal_vllm_endpoint,
            model_name=modal_vllm_model,
            api_key=modal_vllm_api_key,
            request_timeout_seconds=modal_vllm_timeout_seconds,
        )
    if normalized_provider == "gemini":
        return GeminiSchedulerClient(api_key=gemini_api_key, model_name=gemini_model)

    logger.warning("Unknown AI provider '%s'. Falling back to Gemini.", provider)
    return GeminiSchedulerClient(api_key=gemini_api_key, model_name=gemini_model)
