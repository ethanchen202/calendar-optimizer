from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from .ai_client import GeminiSchedulerClient
from .models import CalendarEvent, ChatAnalyzeResponse, ChatDelta, Task

EMOTION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "happy": ("happy", "great", "good", "excited", "motivated", "energized"),
    "stressed": ("stressed", "overwhelmed", "anxious", "worried", "panic"),
    "tired": ("tired", "sleepy", "exhausted", "drained", "fatigued"),
    "frustrated": ("frustrated", "annoyed", "upset", "irritated"),
    "calm": ("calm", "relaxed", "peaceful"),
    "sad": ("sad", "down", "depressed", "low"),
}


def analyze_chat_message(
    user_id: str,
    message: str,
    timezone_name: str,
    user_state: dict[str, Any],
    use_ai: bool,
    gemini_client: GeminiSchedulerClient,
) -> ChatAnalyzeResponse:
    ai_payload = {
        "message": message,
        "timezone": timezone_name,
        "existing_tasks": user_state.get("tasks", []),
        "existing_calendar_events": user_state.get("calendar_events", []),
        "existing_energy_profile": user_state.get("energy_profile"),
    }

    ai_result: dict[str, Any] | None = None
    if use_ai and gemini_client.enabled:
        ai_result = gemini_client.analyze_chat_delta(ai_payload)

    parsed = _coerce_chat_result(message, ai_result, user_state)
    delta = parsed["delta"]
    detected_emotions = parsed["detected_emotions"]
    assistant_message = parsed["assistant_message"]
    delta_preview = build_delta_preview(delta)

    return ChatAnalyzeResponse(
        user_id=user_id,
        assistant_message=assistant_message,
        detected_emotions=detected_emotions,
        proposed_delta=delta,
        requires_confirmation=delta.requires_confirmation(),
        delta_preview=delta_preview,
        updated_energy_profile=None,
    )


def _coerce_chat_result(
    user_message: str, ai_result: dict[str, Any] | None, user_state: dict[str, Any]
) -> dict[str, Any]:
    if ai_result:
        try:
            candidate_delta = ChatDelta.model_validate(ai_result.get("delta", {}))
            emotions = [str(item).strip().lower() for item in ai_result.get("detected_emotions", []) if str(item).strip()]
            assistant_message = str(ai_result.get("assistant_message") or "").strip()
            if not assistant_message:
                assistant_message = _default_assistant_reply(candidate_delta)

            if not emotions:
                emotions = _detect_emotions(user_message)
            if not candidate_delta.energy_profile_append and not candidate_delta.energy_profile_replace:
                candidate_delta.energy_profile_append = _energy_append_from_emotions(emotions)

            return {
                "delta": candidate_delta,
                "detected_emotions": emotions,
                "assistant_message": assistant_message,
            }
        except Exception:
            pass

    fallback_delta = _fallback_delta(user_message, user_state)
    fallback_emotions = _detect_emotions(user_message)
    if not fallback_delta.energy_profile_append and not fallback_delta.energy_profile_replace:
        fallback_delta.energy_profile_append = _energy_append_from_emotions(fallback_emotions)

    return {
        "delta": fallback_delta,
        "detected_emotions": fallback_emotions,
        "assistant_message": _default_assistant_reply(fallback_delta),
    }


def _default_assistant_reply(delta: ChatDelta) -> str:
    structural_changes = delta.requires_confirmation()
    if structural_changes:
        return "I parsed requested changes. Review the proposed delta and confirm to apply it."
    if delta.energy_profile_append or delta.energy_profile_replace:
        return "I updated your energy profile based on your mood and message."
    return "I understood your message. No task or calendar changes were detected."


def _detect_emotions(message: str) -> list[str]:
    lowered = message.lower()
    detected: list[str] = []
    for emotion, keywords in EMOTION_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            detected.append(emotion)
    return detected


def _energy_append_from_emotions(emotions: list[str]) -> str | None:
    if not emotions:
        return None
    joined = ", ".join(emotions)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"Chat mood update ({timestamp}): user reported feeling {joined}."


def _fallback_delta(message: str, user_state: dict[str, Any]) -> ChatDelta:
    lowered = message.lower()
    delta = ChatDelta()

    add_task_match = re.search(r"(?:add task|create task)\s*[:\-]?\s*(.+)", message, flags=re.IGNORECASE)
    if add_task_match:
        title = add_task_match.group(1).strip()
        title = re.split(r"\b(for|duration|priority|by|deadline)\b", title, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if title:
            duration_match = re.search(r"(\d+)\s*(?:min|minute)", lowered)
            priority_match = re.search(r"priority\s*(\d)", lowered)
            duration = int(duration_match.group(1)) if duration_match else 60
            priority = int(priority_match.group(1)) if priority_match else 3
            task = Task(
                id=f"chat_task_{int(datetime.now(timezone.utc).timestamp())}",
                title=title[:200],
                duration_minutes=max(15, min(720, duration)),
                priority=max(1, min(5, priority)),
                split_allowed=True,
            )
            delta.tasks_add.append(task)

    remove_task_match = re.search(r"(?:remove|delete)\s+task\s*[:\-]?\s*(.+)", message, flags=re.IGNORECASE)
    if remove_task_match:
        target = remove_task_match.group(1).strip()
        existing_task_ids = {str(task.get("id", "")).strip() for task in user_state.get("tasks", [])}
        if target in existing_task_ids:
            delta.task_ids_remove.append(target)
        elif target:
            delta.task_title_contains_remove.append(target.lower())

    add_event_match = re.search(
        r"(?:add|create)\s+(?:calendar\s+)?event\s*[:\-]?\s*(.+)",
        message,
        flags=re.IGNORECASE,
    )
    if add_event_match:
        payload = add_event_match.group(1).strip()
        parts = [part.strip() for part in payload.split("|")]
        parts = [part for part in parts if part]
        if len(parts) >= 3:
            title = parts[0]
            start_raw = parts[1]
            end_raw = parts[2]
            start_iso = _coerce_datetime(start_raw)
            end_iso = _coerce_datetime(end_raw)
            if title and start_iso and end_iso:
                delta.calendar_add.append(
                    CalendarEvent(
                        id=f"chat_event_{int(datetime.now(timezone.utc).timestamp())}",
                        title=title,
                        start=start_iso,
                        end=end_iso,
                    )
                )

    remove_event_match = re.search(
        r"(?:remove|delete)\s+(?:calendar\s+)?event\s*[:\-]?\s*(.+)",
        message,
        flags=re.IGNORECASE,
    )
    if remove_event_match:
        target = remove_event_match.group(1).strip()
        existing_event_ids = {
            str(event.get("id", "")).strip() for event in user_state.get("calendar_events", [])
        }
        if target in existing_event_ids:
            delta.calendar_ids_remove.append(target)
        elif target:
            delta.calendar_title_contains_remove.append(target.lower())

    replace_energy_match = re.search(
        r"(?:set|replace)\s+(?:my\s+)?energy\s+profile\s*[:\-]?\s*(.+)",
        message,
        flags=re.IGNORECASE,
    )
    if replace_energy_match:
        profile_text = replace_energy_match.group(1).strip()
        if profile_text:
            delta.energy_profile_replace = profile_text

    return delta


def _coerce_datetime(raw_value: str) -> str | None:
    normalized = raw_value.strip()
    if not normalized:
        return None

    # Supports straightforward ISO-like text used in MVP chat prompts.
    normalized = normalized.replace(" ", "T")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def build_delta_preview(delta: ChatDelta) -> list[str]:
    preview: list[str] = []

    for task in delta.tasks_add:
        preview.append(
            f'Add task "{task.title}" ({task.duration_minutes}m, priority {task.priority}).'
        )
    for task_id in delta.task_ids_remove:
        preview.append(f"Remove task by id: {task_id}.")
    for keyword in delta.task_title_contains_remove:
        preview.append(f'Remove tasks whose title contains "{keyword}".')

    for event in delta.calendar_add:
        preview.append(
            f'Add calendar event "{event.title}" from {event.start.isoformat()} to {event.end.isoformat()}.'
        )
    for event_id in delta.calendar_ids_remove:
        preview.append(f"Remove calendar event by id: {event_id}.")
    for keyword in delta.calendar_title_contains_remove:
        preview.append(f'Remove calendar events whose title contains "{keyword}".')

    if delta.energy_profile_replace:
        preview.append("Replace energy profile from chat mood/context.")
    elif delta.energy_profile_append:
        preview.append("Append mood note to energy profile.")

    return preview
