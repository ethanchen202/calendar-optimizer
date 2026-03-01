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
from .energy_profile import (
    coerce_energy_profile,
    merge_energy_profile,
    parse_description_to_intervals,
)
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
    EnergyProfile,
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

app = FastAPI(title=settings.app_name, version="0.2.0")
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
        "chat_ai_provider": "gemini" if gemini_client.enabled else "heuristic-fallback",
        "scheduler_strategy": "heuristic-only",
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
    current_state = store.get_user_state(payload.user_id)
    base_profile = coerce_energy_profile(
        current_state.get("energy_profile"),
        timezone_name=payload.timezone or "UTC",
    )

    next_profile: EnergyProfile
    if payload.profile is not None and payload.mode == "replace":
        next_profile = payload.profile
    else:
        intervals_add = []
        notes_append: str | None = None
        if payload.profile is not None:
            intervals_add.extend(payload.profile.intervals)
            if payload.profile.freeform_notes:
                notes_append = payload.profile.freeform_notes
        if payload.description:
            parsed_intervals, parsed_notes = parse_description_to_intervals(
                description=payload.description,
                timezone_name=payload.timezone or base_profile.timezone,
                use_ai=payload.use_ai,
                gemini_client=gemini_client,
            )
            intervals_add.extend(parsed_intervals)
            if parsed_notes:
                notes_append = f"{notes_append}\n{parsed_notes}".strip() if notes_append else parsed_notes
            elif payload.description.strip():
                notes_append = (
                    f"{notes_append}\n{payload.description.strip()}".strip()
                    if notes_append
                    else payload.description.strip()
                )

        if payload.mode == "replace":
            replacement = EnergyProfile(
                timezone=payload.timezone or base_profile.timezone,
                intervals=intervals_add,
                freeform_notes=notes_append,
            )
            next_profile = merge_energy_profile(
                base_profile=base_profile,
                intervals_add=[],
                replace_profile=replacement,
            )
        else:
            next_profile = merge_energy_profile(
                base_profile=base_profile,
                intervals_add=intervals_add,
                notes_append=notes_append,
            )

    store.update_energy_profile(payload.user_id, next_profile.model_dump(mode="json"))
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

    energy_only_delta = ChatDelta(
        energy_intervals_add=response.proposed_delta.energy_intervals_add,
        energy_interval_ids_remove=response.proposed_delta.energy_interval_ids_remove,
        energy_clear_all=response.proposed_delta.energy_clear_all,
        energy_notes_append=response.proposed_delta.energy_notes_append,
    )

    if (
        energy_only_delta.energy_intervals_add
        or energy_only_delta.energy_interval_ids_remove
        or energy_only_delta.energy_clear_all
        or energy_only_delta.energy_notes_append
    ):
        updated_state = store.apply_chat_delta(
            payload.user_id,
            energy_only_delta.model_dump(mode="json"),
        )
        response.updated_energy_profile = coerce_energy_profile(
            updated_state.get("energy_profile"),
            timezone_name=payload.timezone,
        )
        response.proposed_delta.energy_intervals_add = []
        response.proposed_delta.energy_interval_ids_remove = []
        response.proposed_delta.energy_clear_all = False
        response.proposed_delta.energy_notes_append = None
        response.delta_preview = build_delta_preview(response.proposed_delta)
        response.requires_confirmation = response.proposed_delta.requires_confirmation()

    return response


@app.post("/api/v1/chat/apply-delta", response_model=ChatApplyResponse)
def apply_chat_delta(payload: ChatApplyRequest) -> ChatApplyResponse:
    has_any_changes = bool(
        payload.delta.requires_confirmation()
        or payload.delta.energy_intervals_add
        or payload.delta.energy_interval_ids_remove
        or payload.delta.energy_clear_all
        or payload.delta.energy_notes_append
    )
    if not has_any_changes:
        return ChatApplyResponse(
            message="No delta changes to apply.",
            user_state=_hydrate_state(payload.user_id),
        )

    store.apply_chat_delta(
        payload.user_id,
        payload.delta.model_dump(mode="json"),
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
    energy_profile = coerce_energy_profile(
        current_state.get("energy_profile"),
        timezone_name=payload.timezone,
    )

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

    if not energy_profile.intervals and (energy_profile.freeform_notes or "").strip():
        inferred_intervals, _ = parse_description_to_intervals(
            description=energy_profile.freeform_notes or "",
            timezone_name=payload.timezone,
            use_ai=False,
            gemini_client=gemini_client,
        )
        if inferred_intervals:
            energy_profile = merge_energy_profile(
                base_profile=energy_profile,
                intervals_add=inferred_intervals,
            )
            store.update_energy_profile(payload.user_id, energy_profile.model_dump(mode="json"))

    if payload.user_description:
        parsed_intervals, parsed_notes = parse_description_to_intervals(
            description=payload.user_description,
            timezone_name=payload.timezone,
            use_ai=payload.use_ai,
            gemini_client=gemini_client,
        )
        merged_profile = merge_energy_profile(
            base_profile=energy_profile,
            intervals_add=parsed_intervals,
            notes_append=parsed_notes or payload.user_description.strip(),
        )
        store.update_energy_profile(payload.user_id, merged_profile.model_dump(mode="json"))
        energy_profile = merged_profile

    effective_payload = payload.model_copy(update={"current_calendar": final_calendar_events})
    return build_schedule(
        request=effective_payload,
        tasks=final_tasks,
        energy_profile=energy_profile,
    )


def _hydrate_state(user_id: str) -> UserStateResponse:
    state = store.get_user_state(user_id)
    return UserStateResponse(
        user_id=user_id,
        tasks=[Task.model_validate(task) for task in state.get("tasks", [])],
        calendar_events=[CalendarEvent.model_validate(event) for event in state.get("calendar_events", [])],
        energy_profile=coerce_energy_profile(state.get("energy_profile")),
        checkins=[CheckinRecord.model_validate(checkin) for checkin in state.get("checkins", [])],
    )
