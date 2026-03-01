from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .ai_client import GeminiSchedulerClient
from .energy_profile import parse_description_to_intervals
from .models import CalendarEvent, ChatAnalyzeResponse, ChatDelta, EnergyInterval, EnergyRecurrence, Task

EMOTION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "happy": ("happy", "great", "good", "excited", "motivated", "energized"),
    "stressed": ("stressed", "overwhelmed", "anxious", "worried", "panic"),
    "tired": ("tired", "sleepy", "exhausted", "drained", "fatigued"),
    "frustrated": ("frustrated", "annoyed", "upset", "irritated"),
    "calm": ("calm", "relaxed", "peaceful"),
    "sad": ("sad", "down", "depressed", "low"),
}

EMOTION_ENERGY_LEVEL = {
    "happy": 2,
    "calm": 1,
    "stressed": -2,
    "tired": -3,
    "frustrated": -2,
    "sad": -2,
}

logger = logging.getLogger(__name__)


def analyze_chat_message(
    user_id: str,
    message: str,
    timezone_name: str,
    user_state: dict[str, object],
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

    ai_result: dict[str, object] | None = None
    if use_ai and gemini_client.enabled:
        ai_result = gemini_client.analyze_chat_delta(ai_payload)

    parsed = _coerce_chat_result(message, timezone_name, ai_result, gemini_client, user_state)
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
    user_message: str,
    timezone_name: str,
    ai_result: dict[str, object] | None,
    gemini_client: GeminiSchedulerClient,
    user_state: dict[str, object],
) -> dict[str, object]:
    ai_assistant_message = ""
    ai_emotions: list[str] = []
    if ai_result:
        ai_assistant_message = str(ai_result.get("assistant_message") or "").strip()
        ai_emotions = _normalize_emotions(ai_result.get("detected_emotions", []))
        raw_delta = ai_result.get("delta")
        delta_payload = raw_delta if isinstance(raw_delta, dict) else {}
        try:
            candidate_delta = ChatDelta.model_validate(delta_payload)
            emotions = ai_emotions
            assistant_message = ai_assistant_message
            if not assistant_message:
                assistant_message = _default_assistant_reply(candidate_delta)
            if not emotions:
                emotions = _detect_emotions(user_message)
            if not candidate_delta.energy_intervals_add and not candidate_delta.energy_interval_ids_remove:
                candidate_delta.energy_intervals_add = _energy_intervals_from_emotions(
                    emotions,
                    timezone_name=timezone_name,
                )
            return {
                "delta": candidate_delta,
                "detected_emotions": emotions,
                "assistant_message": assistant_message,
            }
        except Exception:
            logger.exception("Unable to validate AI chat delta. Falling back to heuristic parser.")

    fallback_delta = _fallback_delta(user_message, timezone_name, gemini_client, user_state)
    fallback_emotions = ai_emotions or _detect_emotions(user_message)
    if not fallback_delta.energy_intervals_add and not fallback_delta.energy_interval_ids_remove:
        fallback_delta.energy_intervals_add = _energy_intervals_from_emotions(
            fallback_emotions,
            timezone_name=timezone_name,
        )
    return {
        "delta": fallback_delta,
        "detected_emotions": fallback_emotions,
        "assistant_message": ai_assistant_message or _default_assistant_reply(fallback_delta),
    }


def _default_assistant_reply(delta: ChatDelta) -> str:
    structural_changes = delta.requires_confirmation()
    if structural_changes:
        return "I parsed requested task/calendar changes. Please review and confirm the delta."
    if delta.energy_intervals_add or delta.energy_interval_ids_remove or delta.energy_clear_all:
        return "I updated your energy profile intervals based on your message."
    return "I understood your message. No task/calendar changes were detected."


def _detect_emotions(message: str) -> list[str]:
    lowered = message.lower()
    detected: list[str] = []
    for emotion, keywords in EMOTION_KEYWORDS.items():
        if any(keyword in lowered for keyword in keywords):
            detected.append(emotion)
    return detected


def _normalize_emotions(raw_value: object) -> list[str]:
    if isinstance(raw_value, str):
        candidates = [raw_value]
    elif isinstance(raw_value, (list, tuple, set)):
        candidates = list(raw_value)
    else:
        candidates = []
    return [str(item).strip().lower() for item in candidates if str(item).strip()]


def _energy_intervals_from_emotions(emotions: list[str], timezone_name: str) -> list[EnergyInterval]:
    if not emotions:
        return []
    tz = _resolve_timezone(timezone_name)
    now_local = datetime.now(tz)
    end_local = min(now_local + timedelta(hours=4), now_local.replace(hour=23, minute=59, second=0, microsecond=0))
    energy = int(round(sum(EMOTION_ENERGY_LEVEL.get(emotion, 0) for emotion in emotions) / len(emotions)))
    energy = max(-5, min(5, energy))
    return [
        EnergyInterval(
            id=f"energy_chat_{int(now_local.timestamp())}",
            start_time=f"{now_local.hour:02d}:{now_local.minute:02d}",
            end_time=f"{end_local.hour:02d}:{end_local.minute:02d}",
            energy_level=energy,
            hard_block=energy <= -5,
            label="Mood update",
            notes=f"Detected emotions: {', '.join(emotions)}",
            recurrence=EnergyRecurrence(type="specific_date", date=now_local.date()),
        )
    ]


def _fallback_delta(
    message: str,
    timezone_name: str,
    gemini_client: GeminiSchedulerClient,
    user_state: dict[str, object],
) -> ChatDelta:
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
            delta.tasks_add.append(
                Task(
                    id=f"chat_task_{int(datetime.now(timezone.utc).timestamp())}",
                    title=title[:200],
                    duration_minutes=max(15, min(720, duration)),
                    priority=max(1, min(5, priority)),
                    split_allowed=True,
                )
            )

    remove_task_match = re.search(r"(?:remove|delete)\s+task\s*[:\-]?\s*(.+)", message, flags=re.IGNORECASE)
    if remove_task_match:
        target = remove_task_match.group(1).strip()
        existing_task_ids = {str(task.get("id", "")).strip() for task in user_state.get("tasks", []) if isinstance(task, dict)}
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
        parts = [part.strip() for part in payload.split("|") if part.strip()]
        if len(parts) >= 3:
            title = parts[0]
            start_iso = _coerce_datetime(parts[1])
            end_iso = _coerce_datetime(parts[2])
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
            str(event.get("id", "")).strip()
            for event in user_state.get("calendar_events", [])
            if isinstance(event, dict)
        }
        if target in existing_event_ids:
            delta.calendar_ids_remove.append(target)
        elif target:
            delta.calendar_title_contains_remove.append(target.lower())

    intervals, _ = parse_description_to_intervals(
        description=message,
        timezone_name=timezone_name,
        use_ai=False,
        gemini_client=gemini_client,
    )
    delta.energy_intervals_add.extend(intervals)
    return delta


def build_delta_preview(delta: ChatDelta) -> list[str]:
    preview: list[str] = []
    for task in delta.tasks_add:
        preview.append(f'Add task "{task.title}" ({task.duration_minutes}m, priority {task.priority}).')
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

    for interval in delta.energy_intervals_add:
        preview.append(
            f'Update energy interval "{interval.start_time}-{interval.end_time}" '
            f"level {interval.energy_level} ({interval.recurrence.type})."
        )
    for interval_id in delta.energy_interval_ids_remove:
        preview.append(f"Remove energy interval by id: {interval_id}.")
    if delta.energy_clear_all:
        preview.append("Clear all existing energy intervals.")

    return preview


def _resolve_timezone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _coerce_datetime(raw_value: str) -> str | None:
    normalized = raw_value.strip()
    if not normalized:
        return None
    normalized = normalized.replace(" ", "T")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()
