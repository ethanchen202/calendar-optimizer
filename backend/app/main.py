from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency at runtime.
    def load_dotenv() -> bool:
        return False

from .ai_client import GeminiSchedulerClient
from .chatbot import analyze_chat_message, build_delta_preview
from .config import get_settings
from .models import (
    CalendarEvent,
    CalendarSyncRequest,
    ChatAnalyzeRequest,
    ChatAnalyzeResponse,
    ChatApplyRequest,
    ChatApplyResponse,
    ChatDelta,
    CheckinRecord,
    CheckinRequest,
    EnergyProfileUpdateRequest,
    MessageResponse,
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    Task,
    TasksSyncRequest,
    UserStateResponse,
)
from .scheduler import build_schedule
from .storage import JsonStore

load_dotenv()
settings = get_settings()
store = JsonStore(settings.data_file)
gemini_client = GeminiSchedulerClient(settings.gemini_api_key, settings.gemini_model)

app = FastAPI(title=settings.app_name, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "ai_provider": "gemini" if gemini_client.enabled else "heuristic-only",
    }


@app.get("/api/v1/state/{user_id}", response_model=UserStateResponse)
def get_user_state(user_id: str) -> UserStateResponse:
    return _hydrate_state(user_id)


@app.post("/api/v1/tasks/sync", response_model=UserStateResponse)
def sync_tasks(payload: TasksSyncRequest) -> UserStateResponse:
    store.sync_tasks(payload.user_id, [task.model_dump(mode="json") for task in payload.tasks])
    return _hydrate_state(payload.user_id)


@app.post("/api/v1/calendar/sync", response_model=UserStateResponse)
def sync_calendar(payload: CalendarSyncRequest) -> UserStateResponse:
    store.sync_calendar_events(
        payload.user_id, [event.model_dump(mode="json") for event in payload.events]
    )
    return _hydrate_state(payload.user_id)


@app.delete("/api/v1/tasks/{task_id}", response_model=MessageResponse)
def delete_task(task_id: str, user_id: str = Query(...)) -> MessageResponse:
    deleted = store.delete_task(user_id, task_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found")
    return MessageResponse(message=f"Task {task_id} deleted")


@app.post("/api/v1/energy-profile", response_model=MessageResponse)
def update_energy_profile(payload: EnergyProfileUpdateRequest) -> MessageResponse:
    store.update_energy_profile(payload.user_id, payload.description)
    return MessageResponse(message="Energy profile updated")


@app.post("/api/v1/checkins", response_model=MessageResponse)
def submit_checkin(payload: CheckinRequest) -> MessageResponse:
    store.add_checkin(
        user_id=payload.user_id,
        feedback=payload.feedback,
        satisfaction=payload.satisfaction,
        submitted_at=payload.submitted_at,
    )
    return MessageResponse(message="Check-in submitted")


@app.post("/api/v1/chat/analyze", response_model=ChatAnalyzeResponse)
def analyze_chat(payload: ChatAnalyzeRequest) -> ChatAnalyzeResponse:
    current_state = store.get_user_state(payload.user_id)
    response = analyze_chat_message(
        user_id=payload.user_id,
        message=payload.message,
        timezone_name=payload.timezone,
        user_state=current_state,
        use_ai=payload.use_ai,
        gemini_client=gemini_client,
    )

    energy_delta = ChatDelta(
        energy_profile_append=response.proposed_delta.energy_profile_append,
        energy_profile_replace=response.proposed_delta.energy_profile_replace,
    )
    if energy_delta.energy_profile_append or energy_delta.energy_profile_replace:
        updated_state = store.apply_chat_delta(
            payload.user_id,
            energy_delta.model_dump(mode="json"),
            apply_energy_update=True,
        )
        response.updated_energy_profile = updated_state.get("energy_profile")
        response.proposed_delta.energy_profile_append = None
        response.proposed_delta.energy_profile_replace = None
        response.delta_preview = build_delta_preview(response.proposed_delta)
        response.requires_confirmation = response.proposed_delta.requires_confirmation()

    return response


@app.post("/api/v1/chat/apply-delta", response_model=ChatApplyResponse)
def apply_chat_delta(payload: ChatApplyRequest) -> ChatApplyResponse:
    has_any_changes = bool(
        payload.delta.requires_confirmation()
        or payload.delta.energy_profile_append
        or payload.delta.energy_profile_replace
    )
    if not has_any_changes:
        return ChatApplyResponse(message="No delta changes to apply.", user_state=_hydrate_state(payload.user_id))

    store.apply_chat_delta(
        payload.user_id,
        payload.delta.model_dump(mode="json"),
        apply_energy_update=True,
    )
    return ChatApplyResponse(
        message="Delta applied successfully.",
        user_state=_hydrate_state(payload.user_id),
    )


@app.post("/api/v1/schedule/generate", response_model=ScheduleGenerateResponse)
def generate_schedule(payload: ScheduleGenerateRequest) -> ScheduleGenerateResponse:
    current_state = store.get_user_state(payload.user_id)
    stored_tasks = [Task.model_validate(task) for task in current_state.get("tasks", [])]
    stored_calendar_events = [
        CalendarEvent.model_validate(event) for event in current_state.get("calendar_events", [])
    ]

    merged_tasks: dict[str, Task] = {task.id: task for task in stored_tasks}
    for task in payload.new_tasks:
        merged_tasks[task.id] = task

    final_tasks = list(merged_tasks.values())
    if payload.new_tasks:
        store.sync_tasks(payload.user_id, [task.model_dump(mode="json") for task in final_tasks])

    final_calendar_events = payload.current_calendar or stored_calendar_events
    if payload.current_calendar:
        store.sync_calendar_events(
            payload.user_id,
            [event.model_dump(mode="json") for event in payload.current_calendar],
        )

    energy_description = payload.user_description or current_state.get("energy_profile")
    if payload.user_description:
        store.update_energy_profile(payload.user_id, payload.user_description)

    effective_payload = payload.model_copy(update={"current_calendar": final_calendar_events})
    return build_schedule(
        request=effective_payload,
        tasks=final_tasks,
        energy_description=energy_description,
        gemini_client=gemini_client,
    )


def _hydrate_state(user_id: str) -> UserStateResponse:
    state = store.get_user_state(user_id)
    return UserStateResponse(
        user_id=user_id,
        tasks=[Task.model_validate(task) for task in state.get("tasks", [])],
        calendar_events=[
            CalendarEvent.model_validate(event) for event in state.get("calendar_events", [])
        ],
        energy_profile=state.get("energy_profile"),
        checkins=[CheckinRecord.model_validate(checkin) for checkin in state.get("checkins", [])],
    )
