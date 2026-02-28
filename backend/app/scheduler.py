from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .ai_client import GeminiSchedulerClient
from .models import (
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    ScheduledEvent,
    Task,
    TimeWindow,
    UnscheduledTask,
)

POSITIVE_ENERGY_TERMS = ("productive", "focused", "best", "alert", "energetic", "flow")
NEGATIVE_ENERGY_TERMS = ("tired", "slump", "drained", "sleepy", "low energy", "fatigue")


@dataclass
class EnergyHints:
    high_windows: list[tuple[float, float]]
    low_windows: list[tuple[float, float]]


def build_schedule(
    request: ScheduleGenerateRequest,
    tasks: list[Task],
    energy_description: str | None,
    gemini_client: GeminiSchedulerClient,
) -> ScheduleGenerateResponse:
    tasks_by_id = {task.id: task for task in tasks}

    if request.use_ai and gemini_client.enabled:
        ai_payload: dict[str, Any] = {
            "timezone": request.timezone,
            "planning_horizon_days": request.planning_horizon_days,
            "energy_description": energy_description,
            "current_calendar": [event.model_dump(mode="json") for event in request.current_calendar],
            "tasks": [task.model_dump(mode="json") for task in tasks],
        }
        ai_result = gemini_client.generate_schedule(ai_payload)
        ai_response = _validate_ai_response(request.user_id, ai_result, tasks_by_id)
        if ai_response:
            return ai_response

    return _build_heuristic_schedule(request, tasks, energy_description)


def _validate_ai_response(
    user_id: str, ai_result: dict[str, Any] | None, tasks_by_id: dict[str, Task]
) -> ScheduleGenerateResponse | None:
    if not ai_result:
        return None

    raw_events = ai_result.get("schedule_events")
    raw_unscheduled = ai_result.get("unscheduled_tasks")
    if not isinstance(raw_events, list):
        return None
    if raw_unscheduled is not None and not isinstance(raw_unscheduled, list):
        return None

    events: list[ScheduledEvent] = []
    for idx, raw_event in enumerate(raw_events, start=1):
        if not isinstance(raw_event, dict):
            continue
        task_id = str(raw_event.get("task_id", "")).strip()
        if not task_id or task_id not in tasks_by_id:
            continue

        try:
            start = _parse_datetime(raw_event.get("start"))
            end = _parse_datetime(raw_event.get("end"))
        except ValueError:
            continue
        if end <= start:
            continue

        events.append(
            ScheduledEvent(
                id=str(raw_event.get("id") or f"ai_{task_id}_{idx}"),
                title=str(raw_event.get("title") or f"Focus: {tasks_by_id[task_id].title}"),
                task_id=task_id,
                start=start,
                end=end,
                source="gemini",
            )
        )

    unscheduled: list[UnscheduledTask] = []
    for raw_item in raw_unscheduled or []:
        if not isinstance(raw_item, dict):
            continue
        task_id = str(raw_item.get("task_id", "")).strip()
        if not task_id:
            continue
        reason = str(raw_item.get("reason") or "No feasible slot identified.")
        unscheduled.append(UnscheduledTask(task_id=task_id, reason=reason))

    if not events and not unscheduled:
        return None

    return ScheduleGenerateResponse(
        user_id=user_id,
        generated_at=datetime.now(timezone.utc),
        strategy_used="gemini",
        schedule_events=events,
        unscheduled_tasks=unscheduled,
    )


def _build_heuristic_schedule(
    request: ScheduleGenerateRequest, tasks: list[Task], energy_description: str | None
) -> ScheduleGenerateResponse:
    tz = _resolve_timezone(request.timezone)
    now = _round_up_to_half_hour(datetime.now(tz))
    planning_end = now + timedelta(days=request.planning_horizon_days)

    hints = _extract_energy_hints(energy_description or "")
    occupied = [(_to_timezone(event.start, tz), _to_timezone(event.end, tz)) for event in request.current_calendar]

    far_future = datetime.max.replace(tzinfo=tz)
    sorted_tasks = sorted(
        tasks,
        key=lambda task: (
            -task.priority,
            _to_timezone(task.deadline, tz) if task.deadline else far_future,
        ),
    )

    scheduled_events: list[ScheduledEvent] = []
    unscheduled_tasks: list[UnscheduledTask] = []

    for task in sorted_tasks:
        deadline = _to_timezone(task.deadline, tz) if task.deadline else None
        if deadline and deadline <= now:
            unscheduled_tasks.append(
                UnscheduledTask(task_id=task.id, reason="Task deadline has already passed.")
            )
            continue

        if task.split_allowed:
            remaining = task.duration_minutes
            part = 1
            while remaining > 0:
                block_minutes = min(60, remaining)
                slot = _find_best_slot(
                    block_minutes,
                    now,
                    planning_end,
                    deadline,
                    occupied,
                    hints,
                    task.preferred_time_window,
                )
                if not slot:
                    scheduled_minutes = task.duration_minutes - remaining
                    if scheduled_minutes == 0:
                        unscheduled_tasks.append(
                            UnscheduledTask(
                                task_id=task.id,
                                reason="No free slot matched constraints in planning horizon.",
                            )
                        )
                    else:
                        unscheduled_tasks.append(
                            UnscheduledTask(
                                task_id=task.id,
                                reason=(
                                    f"Only scheduled {scheduled_minutes} of "
                                    f"{task.duration_minutes} minutes in available time."
                                ),
                            )
                        )
                    break

                start, end = slot
                occupied.append(slot)
                scheduled_events.append(
                    ScheduledEvent(
                        id=f"sched_{task.id}_{part}",
                        title=f"Focus: {task.title}",
                        task_id=task.id,
                        start=start,
                        end=end,
                        source="heuristic",
                    )
                )
                remaining -= block_minutes
                part += 1
        else:
            slot = _find_best_slot(
                task.duration_minutes,
                now,
                planning_end,
                deadline,
                occupied,
                hints,
                task.preferred_time_window,
            )
            if not slot:
                unscheduled_tasks.append(
                    UnscheduledTask(
                        task_id=task.id,
                        reason="No contiguous slot available for non-splittable task.",
                    )
                )
                continue

            start, end = slot
            occupied.append(slot)
            scheduled_events.append(
                ScheduledEvent(
                    id=f"sched_{task.id}_1",
                    title=f"Focus: {task.title}",
                    task_id=task.id,
                    start=start,
                    end=end,
                    source="heuristic",
                )
            )

    scheduled_events.sort(key=lambda event: event.start)
    return ScheduleGenerateResponse(
        user_id=request.user_id,
        generated_at=datetime.now(timezone.utc),
        strategy_used="heuristic",
        schedule_events=scheduled_events,
        unscheduled_tasks=unscheduled_tasks,
    )


def _find_best_slot(
    duration_minutes: int,
    start_window: datetime,
    end_window: datetime,
    deadline: datetime | None,
    occupied: list[tuple[datetime, datetime]],
    hints: EnergyHints,
    preferred_window: TimeWindow | None,
) -> tuple[datetime, datetime] | None:
    duration = timedelta(minutes=duration_minutes)
    day_cursor = start_window.date()
    final_day = end_window.date()

    best_slot: tuple[float, datetime, datetime] | None = None
    while day_cursor <= final_day:
        day_start = datetime.combine(day_cursor, time(6, 0), tzinfo=start_window.tzinfo)
        day_end = datetime.combine(day_cursor, time(23, 0), tzinfo=start_window.tzinfo)

        local_start = max(day_start, start_window)
        local_end = min(day_end, end_window)
        cursor = _round_up_to_half_hour(local_start)
        while cursor + duration <= local_end:
            slot_end = cursor + duration
            if deadline and slot_end > deadline:
                cursor += timedelta(minutes=30)
                continue
            if _overlaps_any(cursor, slot_end, occupied):
                cursor += timedelta(minutes=30)
                continue

            score = _score_slot(cursor, slot_end, hints, preferred_window)
            if not best_slot or score > best_slot[0] or (
                score == best_slot[0] and cursor < best_slot[1]
            ):
                best_slot = (score, cursor, slot_end)

            cursor += timedelta(minutes=30)

        day_cursor += timedelta(days=1)

    if not best_slot:
        return None
    return best_slot[1], best_slot[2]


def _score_slot(
    start: datetime,
    end: datetime,
    hints: EnergyHints,
    preferred_window: TimeWindow | None,
) -> float:
    score = 0.0
    if _overlaps_windows(start, end, hints.high_windows):
        score += 4.0
    if _overlaps_windows(start, end, hints.low_windows):
        score -= 5.0

    if preferred_window:
        inside_preference = (
            start.hour >= preferred_window.start_hour
            and (end.hour < preferred_window.end_hour or (end.hour == preferred_window.end_hour and end.minute == 0))
        )
        score += 2.0 if inside_preference else -1.0
    return score


def _overlaps_windows(start: datetime, end: datetime, windows: list[tuple[float, float]]) -> bool:
    start_hour = start.hour + (start.minute / 60)
    end_hour = end.hour + (end.minute / 60)
    for window_start, window_end in windows:
        if start_hour < window_end and end_hour > window_start:
            return True
    return False


def _overlaps_any(
    start: datetime, end: datetime, occupied: list[tuple[datetime, datetime]]
) -> bool:
    for busy_start, busy_end in occupied:
        if start < busy_end and end > busy_start:
            return True
    return False


def _extract_energy_hints(description: str) -> EnergyHints:
    high_windows: list[tuple[float, float]] = []
    low_windows: list[tuple[float, float]] = []
    lowered = description.lower()

    pattern = re.compile(
        r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"
    )

    for match in pattern.finditer(lowered):
        start_meridian = match.group(3) or match.group(6)
        end_meridian = match.group(6) or match.group(3)

        start_hour = _to_24_hour(match.group(1), match.group(2), start_meridian)
        end_hour = _to_24_hour(
            match.group(4),
            match.group(5),
            end_meridian,
        )
        if end_hour <= start_hour:
            continue

        context = lowered[max(0, match.start() - 80) : min(len(lowered), match.end() + 80)]
        if any(term in context for term in POSITIVE_ENERGY_TERMS):
            high_windows.append((start_hour, end_hour))
        elif any(term in context for term in NEGATIVE_ENERGY_TERMS):
            low_windows.append((start_hour, end_hour))

    return EnergyHints(high_windows=high_windows, low_windows=low_windows)


def _to_24_hour(hour: str, minute: str | None, meridian: str | None) -> float:
    hour_num = int(hour)
    minute_num = int(minute or "0")

    if meridian:
        meridian = meridian.lower()
        if hour_num == 12:
            hour_num = 0
        if meridian == "pm":
            hour_num += 12

    return float(hour_num + (minute_num / 60))


def _resolve_timezone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _to_timezone(value: datetime | None, tz: ZoneInfo) -> datetime:
    if value is None:
        raise ValueError("Expected datetime value, received None.")
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def _round_up_to_half_hour(value: datetime) -> datetime:
    rounded = value.replace(second=0, microsecond=0)
    if rounded.minute in (0, 30):
        return rounded
    add_minutes = 30 - (rounded.minute % 30)
    return (rounded + timedelta(minutes=add_minutes)).replace(second=0, microsecond=0)


def _parse_datetime(raw_value: Any) -> datetime:
    if isinstance(raw_value, datetime):
        return raw_value
    if isinstance(raw_value, str):
        return datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    raise ValueError("Invalid datetime value.")
