from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


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


class TasksSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    tasks: list[Task] = Field(default_factory=list)


class CalendarSyncRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    events: list[CalendarEvent] = Field(default_factory=list)


class EnergyProfileUpdateRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    description: str = Field(..., min_length=5, max_length=4000)


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
    use_ai: bool = True


class ScheduledEvent(BaseModel):
    id: str
    title: str
    task_id: str
    start: datetime
    end: datetime
    source: Literal["gemini", "heuristic"]


class UnscheduledTask(BaseModel):
    task_id: str
    reason: str


class ScheduleGenerateResponse(BaseModel):
    user_id: str
    generated_at: datetime
    strategy_used: Literal["gemini", "heuristic"]
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
    energy_profile_append: str | None = Field(default=None, max_length=1000)
    energy_profile_replace: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def validate_energy_ops(self) -> "ChatDelta":
        if self.energy_profile_append and self.energy_profile_replace:
            raise ValueError("Only one of energy_profile_append or energy_profile_replace may be set")
        return self

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
    updated_energy_profile: str | None = None


class ChatApplyRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=128)
    delta: ChatDelta


class ChatApplyResponse(BaseModel):
    message: str
    user_state: "UserStateResponse"


class UserStateResponse(BaseModel):
    user_id: str
    tasks: list[Task] = Field(default_factory=list)
    calendar_events: list[CalendarEvent] = Field(default_factory=list)
    energy_profile: str | None = None
    checkins: list[CheckinRecord] = Field(default_factory=list)


class MessageResponse(BaseModel):
    message: str
