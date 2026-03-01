from __future__ import annotations

from copy import deepcopy
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .ai_client import SchedulerAIClient
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
    ai_client: SchedulerAIClient,
) -> ChatAnalyzeResponse:
    reference_now = datetime.now(_resolve_timezone(timezone_name))
    ai_payload = {
        "message": message,
        "timezone": timezone_name,
        "current_datetime": reference_now.isoformat(),
        "current_date": reference_now.date().isoformat(),
        "existing_tasks": user_state.get("tasks", []),
        "existing_calendar_events": user_state.get("calendar_events", []),
        "existing_energy_profile": user_state.get("energy_profile"),
    }

    ai_result: dict[str, object] | None = None
    if use_ai and ai_client.enabled:
        ai_result = ai_client.analyze_chat_delta(ai_payload)

    parsed = _coerce_chat_result(message, timezone_name, ai_result, ai_client, user_state)
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
    ai_client: SchedulerAIClient,
    user_state: dict[str, object],
) -> dict[str, object]:
    ai_assistant_message = ""
    ai_emotions: list[str] = []
    if ai_result:
        ai_assistant_message = str(ai_result.get("assistant_message") or "").strip()
        ai_emotions = _normalize_emotions(ai_result.get("detected_emotions", []))
        raw_delta = ai_result.get("delta")
        delta_payload = _normalize_ai_delta_payload(raw_delta)
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
            _normalize_calendar_dates(candidate_delta, user_message, timezone_name)
            return {
                "delta": candidate_delta,
                "detected_emotions": emotions,
                "assistant_message": assistant_message,
            }
        except Exception:
            logger.exception("Unable to validate AI chat delta. Falling back to heuristic parser.")

    fallback_delta = _fallback_delta(user_message, timezone_name, ai_client, user_state)
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
    ai_client: SchedulerAIClient,
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
        ai_client=ai_client,
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


def _normalize_ai_delta_payload(raw_delta: object) -> dict[str, object]:
    if not isinstance(raw_delta, dict):
        return {}

    delta_payload = deepcopy(raw_delta)
    intervals = delta_payload.get("energy_intervals_add")
    if isinstance(intervals, list):
        normalized_intervals: list[object] = []
        for interval in intervals:
            if not isinstance(interval, dict):
                continue
            interval_payload = dict(interval)
            interval_payload["recurrence"] = _normalize_recurrence_payload(interval_payload.get("recurrence"))
            normalized_intervals.append(interval_payload)
        delta_payload["energy_intervals_add"] = normalized_intervals
    return delta_payload


def _normalize_recurrence_payload(raw_recurrence: object) -> dict[str, object]:
    if not isinstance(raw_recurrence, dict):
        return {"type": "daily"}

    recurrence = dict(raw_recurrence)
    requested_type = str(recurrence.get("type") or "").strip().lower()

    if requested_type == "daily":
        return {"type": "daily"}
    if requested_type == "weekly":
        days = _extract_days_of_week(recurrence)
        return {"type": "weekly", "days_of_week": days} if days else {"type": "daily"}
    if requested_type == "specific_date":
        date_value = _coerce_date_value(recurrence.get("date"))
        return {"type": "specific_date", "date": date_value} if date_value is not None else {"type": "daily"}
    if requested_type == "date_range":
        start_date = _coerce_date_value(recurrence.get("start_date"))
        end_date = _coerce_date_value(recurrence.get("end_date"))
        if start_date is not None and end_date is not None:
            normalized: dict[str, object] = {
                "type": "date_range",
                "start_date": start_date,
                "end_date": end_date,
            }
            days = _extract_days_of_week(recurrence)
            if days:
                normalized["days_of_week"] = days
            return normalized
    if requested_type == "monthly_nth_weekday":
        week_of_month = _coerce_int_in_range(recurrence.get("week_of_month"), 1, 5)
        weekday = _coerce_int_in_range(recurrence.get("weekday"), 0, 6)
        if week_of_month is not None and weekday is not None:
            return {
                "type": "monthly_nth_weekday",
                "week_of_month": week_of_month,
                "weekday": weekday,
            }
    if requested_type == "monthly_weekdays":
        week_of_month = _coerce_int_in_range(recurrence.get("week_of_month"), 1, 5)
        if week_of_month is not None:
            normalized = {
                "type": "monthly_weekdays",
                "week_of_month": week_of_month,
            }
            days = _extract_days_of_week(recurrence)
            if days:
                normalized["days_of_week"] = days
            return normalized

    # Fallback inference for malformed/unknown recurrence payloads.
    start_date = _coerce_date_value(recurrence.get("start_date"))
    end_date = _coerce_date_value(recurrence.get("end_date"))
    if start_date is not None and end_date is not None:
        normalized = {
            "type": "date_range",
            "start_date": start_date,
            "end_date": end_date,
        }
        days = _extract_days_of_week(recurrence)
        if days:
            normalized["days_of_week"] = days
        return normalized

    date_value = _coerce_date_value(recurrence.get("date"))
    if date_value is not None:
        return {"type": "specific_date", "date": date_value}

    week_of_month = _coerce_int_in_range(recurrence.get("week_of_month"), 1, 5)
    weekday = _coerce_int_in_range(recurrence.get("weekday"), 0, 6)
    if week_of_month is not None and weekday is not None:
        return {
            "type": "monthly_nth_weekday",
            "week_of_month": week_of_month,
            "weekday": weekday,
        }
    if week_of_month is not None:
        normalized = {"type": "monthly_weekdays", "week_of_month": week_of_month}
        days = _extract_days_of_week(recurrence)
        if days:
            normalized["days_of_week"] = days
        return normalized

    days = _extract_days_of_week(recurrence)
    if days:
        return {"type": "weekly", "days_of_week": days}
    return {"type": "daily"}


def _extract_days_of_week(recurrence: dict[str, object]) -> list[int]:
    days: list[int] = []
    raw_days = recurrence.get("days_of_week")
    if isinstance(raw_days, list):
        for raw_day in raw_days:
            day = _coerce_int_in_range(raw_day, 0, 6)
            if day is not None and day not in days:
                days.append(day)
    if not days:
        weekday = _coerce_int_in_range(recurrence.get("weekday"), 0, 6)
        if weekday is not None:
            days.append(weekday)
    return days


def _coerce_int_in_range(raw_value: object, minimum: int, maximum: int) -> int | None:
    try:
        value = int(raw_value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if value < minimum or value > maximum:
        return None
    return value


def _coerce_date_value(raw_value: object) -> object | None:
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        value = raw_value.strip()
        if not value or value.lower() in {"none", "null"}:
            return None
        return value
    return raw_value


def _normalize_calendar_dates(delta: ChatDelta, user_message: str, timezone_name: str) -> None:
    if not delta.calendar_add:
        return

    lowered_message = user_message.lower()
    tz = _resolve_timezone(timezone_name)
    now_local = datetime.now(tz)
    relative_day_offset: int | None = None
    if "tomorrow" in lowered_message:
        relative_day_offset = 1
    elif "today" in lowered_message:
        relative_day_offset = 0
    elif "yesterday" in lowered_message:
        relative_day_offset = -1

    target_date = now_local.date() + timedelta(days=relative_day_offset) if relative_day_offset is not None else None
    current_year = now_local.year

    for event in delta.calendar_add:
        original_start = _to_timezone(event.start, tz)
        original_end = _to_timezone(event.end, tz)
        duration = original_end - original_start
        if duration.total_seconds() <= 0:
            duration = timedelta(minutes=60)

        if target_date is not None:
            corrected_start = datetime.combine(target_date, original_start.time(), tzinfo=tz)
            event.start = corrected_start
            event.end = corrected_start + duration
            continue

        # Guard against obvious model year drift (e.g., 2023 when current year is 2026).
        if abs(original_start.year - current_year) >= 2:
            corrected_start = _replace_year_safely(original_start, current_year)
            if corrected_start is None:
                continue
            event.start = corrected_start
            event.end = corrected_start + duration


def _to_timezone(value: datetime, tz: ZoneInfo) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def _replace_year_safely(value: datetime, new_year: int) -> datetime | None:
    try:
        return value.replace(year=new_year)
    except ValueError:
        if value.month == 2 and value.day == 29:
            for fallback_day in (28, 27):
                try:
                    return value.replace(year=new_year, day=fallback_day)
                except ValueError:
                    continue
    return None
