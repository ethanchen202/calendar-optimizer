from __future__ import annotations

from datetime import date as DateType, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


def _time_to_minutes(value: str) -> int:
    hour_str, minute_str = value.split(":")
    hour = int(hour_str)
    minute = int(minute_str)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("Invalid time value. Expected HH:MM in 24-hour time.")
    return hour * 60 + minute


class TimeWindow(BaseModel):
    start_hour: int = Field(..., ge=0, le=23)
    end_hour: int = Field(..., ge=1, le=24)

    @model_validator(mode="after")
    def validate_window(self) -> "TimeWindow":
        if self.end_hour <= self.start_hour:
            raise ValueError("end_hour must be greater than start_hour")
        return self


class Task(BaseModel):
    id: str = Field(..., min_length=1, max_length=64)
    title: str = Field(..., min_length=1, max_length=200)
    duration_minutes: int = Field(..., ge=15, le=720)
    priority: int = Field(default=3, ge=1, le=5)
    deadline: datetime | None = None
    preferred_time_window: TimeWindow | None = None
    split_allowed: bool = True


class CalendarEvent(BaseModel):
    id: str | None = None
    title: str = Field(..., min_length=1, max_length=200)
    start: datetime
    end: datetime

    @model_validator(mode="after")
    def validate_window(self) -> "CalendarEvent":
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


class EnergyRecurrence(BaseModel):
    type: Literal[
        "daily",
        "weekly",
        "specific_date",
        "date_range",
        "monthly_nth_weekday",
        "monthly_weekdays",
    ]
    days_of_week: list[int] = Field(default_factory=list)
    week_of_month: int | None = Field(default=None, ge=1, le=5)
    weekday: int | None = Field(default=None, ge=0, le=6)
    date: DateType | None = None
    start_date: DateType | None = None
    end_date: DateType | None = None

    @model_validator(mode="after")
    def validate_rule(self) -> "EnergyRecurrence":
        if any(day < 0 or day > 6 for day in self.days_of_week):
            raise ValueError("days_of_week must use integers in range 0-6 (Mon=0)")

        if self.type == "daily":
            return self
        if self.type == "weekly":
            if not self.days_of_week:
                raise ValueError("weekly recurrence requires days_of_week")
            return self
        if self.type == "specific_date":
            if self.date is None:
                raise ValueError("specific_date recurrence requires date")
            return self
        if self.type == "date_range":
            if self.start_date is None or self.end_date is None:
                raise ValueError("date_range recurrence requires start_date and end_date")
            if self.end_date < self.start_date:
                raise ValueError("date_range end_date must be on/after start_date")
            return self
        if self.type == "monthly_nth_weekday":
            if self.weekday is None or self.week_of_month is None:
                raise ValueError("monthly_nth_weekday recurrence requires weekday and week_of_month")
            return self
        if self.type == "monthly_weekdays":
            if self.week_of_month is None:
                raise ValueError("monthly_weekdays recurrence requires week_of_month")
            return self
        return self


class EnergyInterval(BaseModel):
    id: str = Field(..., min_length=1, max_length=96)
    start_time: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    end_time: str = Field(..., pattern=r"^\d{2}:\d{2}$")
    energy_level: int = Field(..., ge=-5, le=5)
    hard_block: bool = False
    label: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=400)
    recurrence: EnergyRecurrence

    @model_validator(mode="after")
    def validate_interval(self) -> "EnergyInterval":
        start_minutes = _time_to_minutes(self.start_time)
        end_minutes = _time_to_minutes(self.end_time)
        if start_minutes == end_minutes:
            raise ValueError("start_time and end_time cannot be equal")
        return self


class EnergyProfile(BaseModel):
    version: int = 1
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    intervals: list[EnergyInterval] = Field(default_factory=list)
    freeform_notes: str | None = Field(default=None, max_length=8000)
    updated_at: datetime | None = None


class TasksSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    tasks: list[Task] = Field(default_factory=list)


class CalendarSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    events: list[CalendarEvent] = Field(default_factory=list)


class EnergyProfileUpdateRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=4000)
    profile: EnergyProfile | None = None
    mode: Literal["merge", "replace"] = "merge"
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    use_ai: bool = True

    @model_validator(mode="after")
    def validate_payload(self) -> "EnergyProfileUpdateRequest":
        if not self.description and self.profile is None:
            raise ValueError("Either description or profile must be provided.")
        return self


class CheckinRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    feedback: str = Field(..., min_length=3, max_length=4000)
    satisfaction: int | None = Field(default=None, ge=1, le=5)
    submitted_at: datetime | None = None


class ScheduleGenerateRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    current_calendar: list[CalendarEvent] = Field(default_factory=list)
    new_tasks: list[Task] = Field(default_factory=list)
    user_description: str | None = Field(default=None, max_length=4000)
    planning_horizon_days: int = Field(default=7, ge=1, le=30)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    use_ai: bool = False


class ScheduledEvent(BaseModel):
    id: str
    title: str
    task_id: str
    start: datetime
    end: datetime
    source: Literal["heuristic"]


class UnscheduledTask(BaseModel):
    task_id: str
    reason: str


class ScheduleGenerateResponse(BaseModel):
    user_id: str
    generated_at: datetime
    strategy_used: Literal["heuristic"]
    schedule_events: list[ScheduledEvent] = Field(default_factory=list)
    unscheduled_tasks: list[UnscheduledTask] = Field(default_factory=list)


class CheckinRecord(BaseModel):
    feedback: str
    satisfaction: int | None = None
    submitted_at: datetime


class ChatDelta(BaseModel):
    tasks_add: list[Task] = Field(default_factory=list)
    task_ids_remove: list[str] = Field(default_factory=list)
    task_title_contains_remove: list[str] = Field(default_factory=list)
    calendar_add: list[CalendarEvent] = Field(default_factory=list)
    calendar_ids_remove: list[str] = Field(default_factory=list)
    calendar_title_contains_remove: list[str] = Field(default_factory=list)
    energy_intervals_add: list[EnergyInterval] = Field(default_factory=list)
    energy_interval_ids_remove: list[str] = Field(default_factory=list)
    energy_clear_all: bool = False
    energy_notes_append: str | None = Field(default=None, max_length=2000)

    def requires_confirmation(self) -> bool:
        return any(
            (
                self.tasks_add,
                self.task_ids_remove,
                self.task_title_contains_remove,
                self.calendar_add,
                self.calendar_ids_remove,
                self.calendar_title_contains_remove,
            )
        )


class ChatAnalyzeRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    message: str = Field(..., min_length=1, max_length=4000)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    use_ai: bool = True


class ChatAnalyzeResponse(BaseModel):
    user_id: str
    assistant_message: str
    detected_emotions: list[str] = Field(default_factory=list)
    proposed_delta: ChatDelta = Field(default_factory=ChatDelta)
    requires_confirmation: bool = False
    delta_preview: list[str] = Field(default_factory=list)
    updated_energy_profile: EnergyProfile | None = None


class ChatApplyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    delta: ChatDelta


class UserStateResponse(BaseModel):
    user_id: str
    tasks: list[Task] = Field(default_factory=list)
    calendar_events: list[CalendarEvent] = Field(default_factory=list)
    energy_profile: EnergyProfile
    checkins: list[CheckinRecord] = Field(default_factory=list)


class ChatApplyResponse(BaseModel):
    message: str
    user_state: UserStateResponse


class MessageResponse(BaseModel):
    message: str
