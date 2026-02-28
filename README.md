# calendar-optimizer
AI-backed scheduling that optimizes tasks around user energy rhythms.

## Backend MVP (Implemented)
Tech stack: `Python + FastAPI + Pydantic`.

The backend now supports:
1. Task create/update sync + delete from frontend JSON.
2. User free-text daily energy description storage.
3. Schedule generation from current calendar + tasks + description.
4. Periodic user check-ins for schedule feedback.

If Gemini is configured, the backend tries Gemini first; otherwise it falls back to a deterministic heuristic scheduler.

## Run backend
From repo root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

Open API docs at:
- `http://localhost:8000/docs`

## API payload design

### 1) Sync tasks
`POST /api/v1/tasks/sync`

```json
{
  "user_id": "user_123",
  "tasks": [
    {
      "id": "task_write_report",
      "title": "Write product report",
      "duration_minutes": 120,
      "priority": 5,
      "deadline": "2026-03-03T22:00:00-06:00",
      "preferred_time_window": { "start_hour": 16, "end_hour": 20 },
      "split_allowed": true
    }
  ]
}
```

### 2) Delete task
`DELETE /api/v1/tasks/{task_id}?user_id=user_123`

### 3) Update energy profile
`POST /api/v1/energy-profile`

```json
{
  "user_id": "user_123",
  "description": "I generally feel most productive from 4-8 pm and unusually tired from 1-3 pm."
}
```

### 4) Generate schedule
`POST /api/v1/schedule/generate`

```json
{
  "user_id": "user_123",
  "current_calendar": [
    {
      "id": "class_1",
      "title": "Lecture",
      "start": "2026-03-01T10:00:00-06:00",
      "end": "2026-03-01T11:30:00-06:00"
    }
  ],
  "new_tasks": [
    {
      "id": "task_alg_hw",
      "title": "Algorithms homework",
      "duration_minutes": 90,
      "priority": 4,
      "split_allowed": true
    }
  ],
  "user_description": "Best focus 4-8 pm, low energy 1-3 pm.",
  "planning_horizon_days": 7,
  "timezone": "America/Chicago",
  "use_ai": true
}
```

Sample response:

```json
{
  "user_id": "user_123",
  "generated_at": "2026-02-28T18:10:11.215447+00:00",
  "strategy_used": "heuristic",
  "schedule_events": [
    {
      "id": "sched_task_alg_hw_1",
      "title": "Focus: Algorithms homework",
      "task_id": "task_alg_hw",
      "start": "2026-03-01T16:00:00-06:00",
      "end": "2026-03-01T17:00:00-06:00",
      "source": "heuristic"
    }
  ],
  "unscheduled_tasks": []
}
```

### 5) Submit periodic feedback/check-in
`POST /api/v1/checkins`

```json
{
  "user_id": "user_123",
  "feedback": "This schedule is better in afternoons but mornings are overloaded.",
  "satisfaction": 4
}
```

### 6) Read current user state
`GET /api/v1/state/{user_id}`

## Environment variables
- `GEMINI_API_KEY`: Optional. Enables Gemini scheduling attempt.
- `GEMINI_MODEL`: Optional. Default `gemini-1.5-flash`.
- `DATA_STORE_PATH`: Optional path to JSON persistence store. Default `backend/data/store.json`.

## Project structure
```text
backend/
  app/
    main.py        # FastAPI routes
    models.py      # Request/response models
    scheduler.py   # Gemini + heuristic schedule engine
    storage.py     # JSON persistence
    ai_client.py   # Gemini wrapper
    config.py
  data/
  requirements.txt
  .env.example
frontend/
  src/
    App.tsx        # MVP single-page UI
    api.ts         # Backend API client
    types.ts       # Shared frontend types
    styles.css
  package.json
  .env.example
```

## Frontend MVP
Tech stack: `React + TypeScript + Vite`.

What the frontend supports:
1. Configure `backend URL` and `user ID`.
2. Add/delete tasks and sync task JSON to backend.
3. Save user energy description text.
4. Add current calendar events, generate schedule JSON, and render results.
5. Submit and view periodic user check-ins.

### Run frontend
From repo root:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open frontend at:
- `http://localhost:5173`

By default it calls backend at:
- `http://localhost:8000`

If your backend uses a different URL, update it in the UI Connection panel or set:
- `VITE_API_BASE_URL` in `frontend/.env`
