from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from .ai_client import SchedulerAIClient
from .models import EnergyInterval, EnergyProfile, EnergyRecurrence

DAY_NAME_TO_INDEX = {
    "monday": 0,
    "mon": 0,
    "tuesday": 1,
    "tue": 1,
    "wednesday": 2,
    "wed": 2,
    "thursday": 3,
    "thu": 3,
    "friday": 4,
    "fri": 4,
    "saturday": 5,
    "sat": 5,
    "sunday": 6,
    "sun": 6,
}

POSITIVE_TERMS = ("productive", "focused", "energetic", "alert", "best", "flow", "great")
NEGATIVE_TERMS = ("tired", "slump", "drained", "fatigue", "sleepy", "low energy", "exhausted")
BLOCKING_TERMS = ("busy", "test", "exam", "meeting", "class", "unavailable")


def default_energy_profile(timezone_name: str = "UTC") -> EnergyProfile:
    return EnergyProfile(
        version=1,
        timezone=timezone_name,
        intervals=[],
        freeform_notes=None,
        updated_at=datetime.now(timezone.utc),
    )


def coerce_energy_profile(raw_value: Any, timezone_name: str = "UTC") -> EnergyProfile:
    if isinstance(raw_value, EnergyProfile):
        return raw_value
    if isinstance(raw_value, dict):
        try:
            return EnergyProfile.model_validate(raw_value)
        except Exception:
            pass
    if isinstance(raw_value, str):
        profile = default_energy_profile(timezone_name=timezone_name)
        profile.freeform_notes = raw_value.strip() or None
        return profile
    return default_energy_profile(timezone_name=timezone_name)


def merge_energy_profile(
    base_profile: EnergyProfile,
    intervals_add: list[EnergyInterval],
    interval_ids_remove: list[str] | None = None,
    clear_all: bool = False,
    notes_append: str | None = None,
    replace_profile: EnergyProfile | None = None,
) -> EnergyProfile:
    if replace_profile is not None:
        replaced = replace_profile.model_copy()
        replaced.updated_at = datetime.now(timezone.utc)
        return replaced

    merged = base_profile.model_copy(deep=True)
    merged.timezone = merged.timezone or "UTC"
    merged.intervals = [] if clear_all else list(merged.intervals)

    remove_set = {item.strip() for item in (interval_ids_remove or []) if item.strip()}
    if remove_set:
        merged.intervals = [interval for interval in merged.intervals if interval.id not in remove_set]

    by_id: dict[str, EnergyInterval] = {interval.id: interval for interval in merged.intervals}
    for interval in intervals_add:
        by_id[interval.id] = interval
    merged.intervals = list(by_id.values())

    note = (notes_append or "").strip()
    if note:
        if merged.freeform_notes:
            merged.freeform_notes = f"{merged.freeform_notes}\n{note}"
        else:
            merged.freeform_notes = note

    merged.updated_at = datetime.now(timezone.utc)
    return merged


def parse_description_to_intervals(
    description: str,
    timezone_name: str,
    use_ai: bool,
    ai_client: SchedulerAIClient,
    reference_now: datetime | None = None,
) -> tuple[list[EnergyInterval], str | None]:
    text = description.strip()
    if not text:
        return [], None

    if use_ai and ai_client.enabled:
        ai_result = ai_client.extract_energy_profile_intervals(
            {
                "description": text,
                "timezone": timezone_name,
            }
        )
        if ai_result:
            intervals: list[EnergyInterval] = []
            for raw_interval in ai_result.get("intervals", []):
                try:
                    intervals.append(EnergyInterval.model_validate(raw_interval))
                except Exception:
                    continue
            if intervals:
                return intervals, str(ai_result.get("notes_append") or "").strip() or None

    return _fallback_parse_intervals(text, reference_now=reference_now), None


def interval_active_at(interval: EnergyInterval, dt_value: datetime) -> bool:
    start_minutes = _time_string_to_minutes(interval.start_time)
    end_minutes = _time_string_to_minutes(interval.end_time)
    minute_of_day = dt_value.hour * 60 + dt_value.minute
    is_overnight = end_minutes <= start_minutes

    if not is_overnight:
        if minute_of_day < start_minutes or minute_of_day >= end_minutes:
            return False
        return recurrence_applies_on_date(interval.recurrence, dt_value.date())

    if minute_of_day >= start_minutes:
        return recurrence_applies_on_date(interval.recurrence, dt_value.date())

    previous_date = dt_value.date() - timedelta(days=1)
    return recurrence_applies_on_date(interval.recurrence, previous_date)


def recurrence_applies_on_date(recurrence: EnergyRecurrence, day: date) -> bool:
    if recurrence.type == "daily":
        return True
    if recurrence.type == "weekly":
        return day.weekday() in recurrence.days_of_week
    if recurrence.type == "specific_date":
        return recurrence.date == day
    if recurrence.type == "date_range":
        if recurrence.start_date is None or recurrence.end_date is None:
            return False
        if day < recurrence.start_date or day > recurrence.end_date:
            return False
        if recurrence.days_of_week:
            return day.weekday() in recurrence.days_of_week
        return True
    if recurrence.type == "monthly_nth_weekday":
        if recurrence.weekday is None or recurrence.week_of_month is None:
            return False
        return day.weekday() == recurrence.weekday and _week_of_month(day) == recurrence.week_of_month
    if recurrence.type == "monthly_weekdays":
        if recurrence.week_of_month is None:
            return False
        if _week_of_month(day) != recurrence.week_of_month:
            return False
        if recurrence.days_of_week:
            return day.weekday() in recurrence.days_of_week
        return True
    return False


def energy_score_at(profile: EnergyProfile, dt_value: datetime) -> tuple[float, bool]:
    total_energy = 0.0
    hard_block = False
    for interval in profile.intervals:
        if interval_active_at(interval, dt_value):
            total_energy += float(interval.energy_level)
            hard_block = hard_block or interval.hard_block or interval.energy_level <= -5
    return total_energy, hard_block


def _fallback_parse_intervals(description: str, reference_now: datetime | None = None) -> list[EnergyInterval]:
    lowered = description.lower()
    now = reference_now or datetime.now(timezone.utc)
    intervals: list[EnergyInterval] = []
    counter = 1

    month_week_match = re.search(
        r"(1st|2nd|3rd|4th|5th)\s+week\s+of\s+(?:every|each)\s+month",
        lowered,
    )
    if month_week_match:
        week_map = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5}
        week_of_month = week_map[month_week_match.group(1)]
        energy_level, hard_block, label = _infer_energy_from_context(lowered)
        intervals.append(
            EnergyInterval(
                id=f"energy_interval_{int(now.timestamp())}_{counter}",
                start_time="00:00",
                end_time="23:59",
                energy_level=energy_level,
                hard_block=hard_block,
                label=label or "Monthly week pattern",
                recurrence=EnergyRecurrence(
                    type="monthly_weekdays",
                    week_of_month=week_of_month,
                    days_of_week=[0, 1, 2, 3, 4, 5, 6],
                ),
            )
        )
        counter += 1

    time_pattern = re.compile(
        r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?"
    )
    for match in time_pattern.finditer(lowered):
        start_meridian = match.group(3) or match.group(6)
        end_meridian = match.group(6) or match.group(3)
        start_minutes = _to_minutes(match.group(1), match.group(2), start_meridian)
        end_minutes = _to_minutes(match.group(4), match.group(5), end_meridian)
        if start_minutes == end_minutes:
            continue

        context = lowered[max(0, match.start() - 120) : min(len(lowered), match.end() + 120)]
        energy_level, hard_block, label = _infer_energy_from_context(context)
        recurrence = _infer_recurrence_from_context(context, now)

        intervals.append(
            EnergyInterval(
                id=f"energy_interval_{int(now.timestamp())}_{counter}",
                start_time=_minutes_to_time_string(start_minutes),
                end_time=_minutes_to_time_string(end_minutes),
                energy_level=energy_level,
                hard_block=hard_block,
                label=label,
                recurrence=recurrence,
            )
        )
        counter += 1

        if "rest of the day" in context and energy_level < 0:
            intervals.append(
                EnergyInterval(
                    id=f"energy_interval_{int(now.timestamp())}_{counter}",
                    start_time=_minutes_to_time_string(end_minutes),
                    end_time="23:59",
                    energy_level=max(-5, energy_level - 1),
                    hard_block=hard_block,
                    label="Remainder of day",
                    recurrence=recurrence,
                )
            )
            counter += 1

    return intervals


def _infer_energy_from_context(context: str) -> tuple[int, bool, str | None]:
    if any(term in context for term in BLOCKING_TERMS):
        return -5, True, "Unavailable"
    if any(term in context for term in NEGATIVE_TERMS):
        return -3, False, "Low energy"
    if any(term in context for term in POSITIVE_TERMS):
        return 3, False, "High energy"
    return 1, False, "Neutral"


def _infer_recurrence_from_context(context: str, reference_now: datetime) -> EnergyRecurrence:
    next_week_match = re.search(
        r"next\s+week\s+(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)",
        context,
    )
    if next_week_match:
        weekday = DAY_NAME_TO_INDEX[next_week_match.group(1)]
        base_date = _next_weekday(reference_now.date(), weekday, next_week=True)
        return EnergyRecurrence(type="specific_date", date=base_date)

    on_day_match = re.search(
        r"(?:on\s+)?(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)",
        context,
    )
    if on_day_match:
        weekday = DAY_NAME_TO_INDEX[on_day_match.group(1)]
        return EnergyRecurrence(type="weekly", days_of_week=[weekday])

    return EnergyRecurrence(type="daily")


def _week_of_month(day: date) -> int:
    return ((day.day - 1) // 7) + 1


def _next_weekday(start_day: date, target_weekday: int, next_week: bool) -> date:
    days_ahead = (target_weekday - start_day.weekday() + 7) % 7
    if days_ahead == 0:
        days_ahead = 7
    if next_week:
        days_ahead += 7
    return start_day + timedelta(days=days_ahead)


def _to_minutes(hour: str, minute: str | None, meridian: str | None) -> int:
    hour_num = int(hour)
    minute_num = int(minute or "0")
    if meridian:
        meridian = meridian.lower()
        if hour_num == 12:
            hour_num = 0
        if meridian == "pm":
            hour_num += 12
    return (hour_num % 24) * 60 + minute_num


def _minutes_to_time_string(minutes: int) -> str:
    normalized = minutes % (24 * 60)
    hour = normalized // 60
    minute = normalized % 60
    return f"{hour:02d}:{minute:02d}"


def _time_string_to_minutes(value: str) -> int:
    return _time_to_minutes(value)


def _time_to_minutes(value: str) -> int:
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError("Invalid time format")
    return int(parts[0]) * 60 + int(parts[1])
