from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency at runtime.
    def load_dotenv() -> bool:
        return False

from .ai_client import GeminiSchedulerClient
from .config import get_settings
from .models import (
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


@app.post("/api/v1/schedule/generate", response_model=ScheduleGenerateResponse)
def generate_schedule(payload: ScheduleGenerateRequest) -> ScheduleGenerateResponse:
    current_state = store.get_user_state(payload.user_id)
    stored_tasks = [Task.model_validate(task) for task in current_state.get("tasks", [])]

    merged_tasks: dict[str, Task] = {task.id: task for task in stored_tasks}
    for task in payload.new_tasks:
        merged_tasks[task.id] = task

    final_tasks = list(merged_tasks.values())
    if payload.new_tasks:
        store.sync_tasks(payload.user_id, [task.model_dump(mode="json") for task in final_tasks])

    energy_description = payload.user_description or current_state.get("energy_profile")
    if payload.user_description:
        store.update_energy_profile(payload.user_id, payload.user_description)

    return build_schedule(
        request=payload,
        tasks=final_tasks,
        energy_description=energy_description,
        gemini_client=gemini_client,
    )


def _hydrate_state(user_id: str) -> UserStateResponse:
    state = store.get_user_state(user_id)
    return UserStateResponse(
        user_id=user_id,
        tasks=[Task.model_validate(task) for task in state.get("tasks", [])],
        energy_profile=state.get("energy_profile"),
        checkins=[CheckinRecord.model_validate(checkin) for checkin in state.get("checkins", [])],
    )
