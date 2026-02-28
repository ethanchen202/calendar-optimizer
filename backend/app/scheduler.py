from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .energy_profile import EnergyProfile, energy_score_at
from .models import (
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    ScheduledEvent,
    Task,
    TimeWindow,
    UnscheduledTask,
)

SLOT_MINUTES = 15
MIN_TASK_CHUNK_MINUTES = 30
MAX_TASK_CHUNK_MINUTES = 90
DAY_START_HOUR = 6
DAY_END_HOUR = 23


def build_schedule(
    request: ScheduleGenerateRequest,
    tasks: list[Task],
    energy_profile: EnergyProfile,
) -> ScheduleGenerateResponse:
    tz = _resolve_timezone(request.timezone or energy_profile.timezone or "UTC")
    now = _round_up_to_step(datetime.now(tz), SLOT_MINUTES)
    planning_end = now + timedelta(days=request.planning_horizon_days)

    occupied = [(_to_timezone(event.start, tz), _to_timezone(event.end, tz)) for event in request.current_calendar]
    tasks_ordered = sorted(tasks, key=lambda item: _task_sort_key(item, now, tz), reverse=True)

    scheduled_events: list[ScheduledEvent] = []
    unscheduled_tasks: list[UnscheduledTask] = []
    task_slot_history: dict[str, list[tuple[datetime, datetime]]] = {}

    for task in tasks_ordered:
        task_deadline = _to_timezone(task.deadline, tz) if task.deadline else None
        hard_end = min(task_deadline, planning_end) if task_deadline else planning_end
        if hard_end <= now:
            unscheduled_tasks.append(
                UnscheduledTask(task_id=task.id, reason="Task deadline has already passed.")
            )
            continue

        chunks = _build_chunks(task.duration_minutes, task.split_allowed)
        scheduled_for_task: list[tuple[datetime, datetime]] = []

        for chunk_minutes in chunks:
            slot = _select_best_slot(
                task=task,
                duration_minutes=chunk_minutes,
                start_bound=now,
                end_bound=hard_end,
                occupied=occupied,
                energy_profile=energy_profile,
                task_existing_slots=scheduled_for_task,
                planning_anchor=now,
            )
            if slot is None:
                completed = sum(int((end - start).total_seconds() // 60) for start, end in scheduled_for_task)
                if completed == 0:
                    unscheduled_tasks.append(
                        UnscheduledTask(
                            task_id=task.id,
                            reason="No feasible slot found given calendar constraints and energy profile.",
                        )
                    )
                else:
                    unscheduled_tasks.append(
                        UnscheduledTask(
                            task_id=task.id,
                            reason=(
                                f"Only scheduled {completed} of {task.duration_minutes} minutes within "
                                "the planning horizon."
                            ),
                        )
                    )
                break

            slot_start, slot_end = slot
            occupied.append(slot)
            scheduled_for_task.append(slot)
            task_slot_history.setdefault(task.id, []).append(slot)

            scheduled_events.append(
                ScheduledEvent(
                    id=f"sched_{task.id}_{len(task_slot_history[task.id])}",
                    title=f"Focus: {task.title}",
                    task_id=task.id,
                    start=slot_start,
                    end=slot_end,
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


def _task_sort_key(task: Task, now: datetime, tz: ZoneInfo) -> float:
    deadline_component = 0.0
    if task.deadline:
        deadline_local = _to_timezone(task.deadline, tz)
        hours_until_deadline = max(0.1, (deadline_local - now).total_seconds() / 3600.0)
        deadline_component = 1500.0 / (hours_until_deadline + 1.0)
    duration_component = task.duration_minutes / 60.0
    return (task.priority * 100.0) + deadline_component + duration_component


def _build_chunks(duration_minutes: int, split_allowed: bool) -> list[int]:
    if not split_allowed:
        return [_round_duration_to_step(duration_minutes)]

    remaining = _round_duration_to_step(duration_minutes)
    chunks: list[int] = []
    while remaining > 0:
        if remaining <= MAX_TASK_CHUNK_MINUTES:
            chunk = remaining
        else:
            chunk = min(60, remaining)
            leftover = remaining - chunk
            if 0 < leftover < MIN_TASK_CHUNK_MINUTES:
                chunk = max(MIN_TASK_CHUNK_MINUTES, remaining // 2)
        chunk = max(SLOT_MINUTES, _round_duration_to_step(chunk))
        chunks.append(chunk)
        remaining -= chunk
    return chunks


def _select_best_slot(
    task: Task,
    duration_minutes: int,
    start_bound: datetime,
    end_bound: datetime,
    occupied: list[tuple[datetime, datetime]],
    energy_profile: EnergyProfile,
    task_existing_slots: list[tuple[datetime, datetime]],
    planning_anchor: datetime,
) -> tuple[datetime, datetime] | None:
    duration = timedelta(minutes=duration_minutes)
    cursor = _round_up_to_step(start_bound, SLOT_MINUTES)
    best: tuple[float, datetime, datetime] | None = None

    while cursor + duration <= end_bound:
        slot_end = cursor + duration

        if not _within_day_bounds(cursor, slot_end):
            cursor += timedelta(minutes=SLOT_MINUTES)
            continue
        if _overlaps_any(cursor, slot_end, occupied):
            cursor += timedelta(minutes=SLOT_MINUTES)
            continue

        energy_stats = _slot_energy_stats(energy_profile, cursor, slot_end)
        if energy_stats is None:
            cursor += timedelta(minutes=SLOT_MINUTES)
            continue
        avg_energy, min_energy = energy_stats

        if task.priority >= 4 and min_energy <= -4.0:
            cursor += timedelta(minutes=SLOT_MINUTES)
            continue

        score = _slot_score(
            task=task,
            slot_start=cursor,
            slot_end=slot_end,
            avg_energy=avg_energy,
            min_energy=min_energy,
            occupied=occupied,
            task_existing_slots=task_existing_slots,
            planning_anchor=planning_anchor,
        )
        if not best or score > best[0]:
            best = (score, cursor, slot_end)

        cursor += timedelta(minutes=SLOT_MINUTES)

    if not best:
        return None
    return best[1], best[2]


def _slot_energy_stats(
    profile: EnergyProfile, slot_start: datetime, slot_end: datetime
) -> tuple[float, float] | None:
    sample_time = slot_start
    total_energy = 0.0
    samples = 0
    minimum_energy = 999.0

    while sample_time < slot_end:
        level, hard_block = energy_score_at(profile, sample_time)
        if hard_block:
            return None
        total_energy += level
        minimum_energy = min(minimum_energy, level)
        samples += 1
        sample_time += timedelta(minutes=SLOT_MINUTES)

    if samples == 0:
        return 0.0, 0.0
    return total_energy / samples, minimum_energy


def _slot_score(
    task: Task,
    slot_start: datetime,
    slot_end: datetime,
    avg_energy: float,
    min_energy: float,
    occupied: list[tuple[datetime, datetime]],
    task_existing_slots: list[tuple[datetime, datetime]],
    planning_anchor: datetime,
) -> float:
    hours_from_now = (slot_start - planning_anchor).total_seconds() / 3600.0
    score = 0.0

    score += avg_energy * 4.2
    score += min_energy * 1.4
    score += task.priority * 0.8
    score -= hours_from_now * 0.02

    if task.deadline:
        deadline = task.deadline
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=slot_end.tzinfo)
        else:
            deadline = deadline.astimezone(slot_end.tzinfo)
        hours_before_deadline = (deadline - slot_end).total_seconds() / 3600.0
        score += min(hours_before_deadline, 120) * 0.03
        if hours_before_deadline < 24:
            score -= (24 - hours_before_deadline) * 0.65

    if task.preferred_time_window:
        score += _preferred_window_score(slot_start, slot_end, task.preferred_time_window)

    if task_existing_slots:
        continuity_bonus = max(
            _continuity_bonus(slot_start, slot_end, existing_start, existing_end)
            for existing_start, existing_end in task_existing_slots
        )
        score += continuity_bonus

    day_busy_minutes = _busy_minutes_for_day(slot_start.date(), occupied)
    score -= max(0.0, (day_busy_minutes - 8 * 60) / 60.0) * 0.3
    return score


def _preferred_window_score(start: datetime, end: datetime, preferred: TimeWindow) -> float:
    pref_start = preferred.start_hour * 60
    pref_end = preferred.end_hour * 60
    slot_start = start.hour * 60 + start.minute
    slot_end = end.hour * 60 + end.minute
    overlap = max(0, min(slot_end, pref_end) - max(slot_start, pref_start))
    duration = max(1, slot_end - slot_start)
    ratio = overlap / duration
    return (ratio * 2.4) - ((1.0 - ratio) * 0.8)


def _continuity_bonus(
    start: datetime, end: datetime, existing_start: datetime, existing_end: datetime
) -> float:
    if start == existing_end or end == existing_start:
        return 1.5
    gap = min(abs((start - existing_end).total_seconds()), abs((end - existing_start).total_seconds()))
    if gap <= 3600:
        return 0.6
    return 0.0


def _busy_minutes_for_day(day: date, occupied: list[tuple[datetime, datetime]]) -> int:
    total = 0
    day_start = datetime.combine(day, time(0, 0), tzinfo=occupied[0][0].tzinfo) if occupied else None
    day_end = datetime.combine(day, time(23, 59), tzinfo=occupied[0][0].tzinfo) if occupied else None
    if day_start is None or day_end is None:
        return 0

    for start, end in occupied:
        overlap_start = max(start, day_start)
        overlap_end = min(end, day_end)
        if overlap_end > overlap_start:
            total += int((overlap_end - overlap_start).total_seconds() // 60)
    return total


def _within_day_bounds(start: datetime, end: datetime) -> bool:
    if end <= start:
        return False
    if start.date() != end.date():
        return False
    if start.hour < DAY_START_HOUR:
        return False
    return end.hour <= DAY_END_HOUR


def _overlaps_any(start: datetime, end: datetime, occupied: list[tuple[datetime, datetime]]) -> bool:
    for busy_start, busy_end in occupied:
        if start < busy_end and end > busy_start:
            return True
    return False


def _resolve_timezone(timezone_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _to_timezone(value: datetime, tz: ZoneInfo) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=tz)
    return value.astimezone(tz)


def _round_up_to_step(value: datetime, step_minutes: int) -> datetime:
    rounded = value.replace(second=0, microsecond=0)
    minute_remainder = rounded.minute % step_minutes
    if minute_remainder == 0:
        return rounded
    add_minutes = step_minutes - minute_remainder
    return rounded + timedelta(minutes=add_minutes)


def _round_duration_to_step(minutes: int) -> int:
    remainder = minutes % SLOT_MINUTES
    if remainder == 0:
        return minutes
    return minutes + (SLOT_MINUTES - remainder)
