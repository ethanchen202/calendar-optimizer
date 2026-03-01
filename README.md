# calendar-optimizer
Calendar optimization app with a deterministic heuristic scheduler and structured energy profile JSON.

## What Changed
1. Energy profile is now structured JSON, not a single long text string.
2. Chatbot and energy text updates both map into the same interval-based energy profile.
3. Scheduling is heuristic-only (no AI scheduling path).
4. Chat/energy parsing can use either Gemini or Modal vLLM via `AI_PROVIDER`.

## Energy Profile JSON Design
Each user has an `energy_profile` object:

```json
{
  "version": 1,
  "timezone": "America/Chicago",
  "intervals": [],
  "freeform_notes": null,
  "updated_at": "2026-02-28T21:00:00+00:00"
}
```

Each interval has:
- `id`
- `start_time` (`HH:MM`)
- `end_time` (`HH:MM`)
- `energy_level` (`-5` to `5`)
- `hard_block` (`true` means do not schedule)
- `recurrence` rule

### Recurrence types
- `daily`
- `weekly` with `days_of_week` (`0=Mon ... 6=Sun`)
- `specific_date` with `date`
- `date_range` with `start_date`, `end_date`, optional `days_of_week`
- `monthly_nth_weekday` with `week_of_month` + `weekday`
- `monthly_weekdays` with `week_of_month` + optional `days_of_week`

### Example: regular productive/tired windows
```json
{
  "id": "focus_evening",
  "start_time": "16:00",
  "end_time": "20:00",
  "energy_level": 3,
  "hard_block": false,
  "label": "Peak focus",
  "recurrence": { "type": "daily" }
}
```

```json
{
  "id": "slump_afternoon",
  "start_time": "13:00",
  "end_time": "15:00",
  "energy_level": -3,
  "hard_block": false,
  "label": "Afternoon slump",
  "recurrence": { "type": "daily" }
}
```

### Example: “busy on 3rd week of every month”
```json
{
  "id": "monthly_busy_week_3",
  "start_time": "00:00",
  "end_time": "23:59",
  "energy_level": -5,
  "hard_block": true,
  "label": "3rd week busy",
  "recurrence": {
    "type": "monthly_weekdays",
    "week_of_month": 3,
    "days_of_week": [0, 1, 2, 3, 4, 5, 6]
  }
}
```

### Example: “test next week Monday 2-4 pm, too tired rest of day”
```json
[
  {
    "id": "test_block",
    "start_time": "14:00",
    "end_time": "16:00",
    "energy_level": -5,
    "hard_block": true,
    "label": "Test",
    "recurrence": { "type": "specific_date", "date": "2026-03-02" }
  },
  {
    "id": "post_test_tired",
    "start_time": "16:00",
    "end_time": "23:59",
    "energy_level": -4,
    "hard_block": false,
    "label": "Post-test fatigue",
    "recurrence": { "type": "specific_date", "date": "2026-03-02" }
  }
]
```

## Scheduling Algorithm (Heuristic Only)
The scheduler is deterministic and uses:
1. Tasks (priority, duration, deadline, split/non-split, preferred window)
2. Existing calendar events (hard occupied intervals)
3. Structured energy intervals (recurring + date-specific)

Core strategy:
1. Build planning horizon in local timezone.
2. Sort tasks by urgency score:
   - high priority first
   - then tighter deadline
3. Split splittable tasks into bounded chunks (roughly 30-90 min).
4. Search candidate slots in 15-minute steps.
5. Reject slots that:
   - overlap calendar/events
   - violate hard energy blocks
   - miss deadline
6. Score remaining slots by:
   - average/minimum energy in slot
   - priority and deadline slack
   - preferred-time overlap
   - continuity with same-task chunks
   - overloading penalty for already-heavy days
7. Assign best slot, reserve it, continue until task is complete or unschedulable.

Output includes:
- `schedule_events`
- `unscheduled_tasks` with explicit reasons

## API Endpoints

### Sync tasks
`POST /api/v1/tasks/sync`

### Sync calendar
`POST /api/v1/calendar/sync`

### Update energy profile from text/profile JSON
`POST /api/v1/energy-profile`

Text update example:
```json
{
  "user_id": "user_123",
  "description": "I generally feel productive from 4-8 pm and tired from 1-3 pm.",
  "mode": "merge",
  "use_ai": true
}
```

### Analyze chatbot message
`POST /api/v1/chat/analyze`

### Warm up chat AI in background
`POST /api/v1/chat/warmup`

### Apply confirmed chatbot delta
`POST /api/v1/chat/apply-delta`

### Generate schedule
`POST /api/v1/schedule/generate`

### Read user state
`GET /api/v1/state/{user_id}`

## Run Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

## Deploy Modal vLLM (Python 3.11.x)
Use this when `AI_PROVIDER=modal`.

```bash
cd backend
source .venv/bin/activate
pip install -U "modal>=1.0.0,<2.0.0"
modal setup
modal deploy modal_vllm_inference.py
```

After deploy, copy the printed URL (for example `https://<workspace>--<app>-serve.modal.run`) and set:

```bash
AI_PROVIDER=modal
MODAL_VLLM_ENDPOINT=https://<workspace>--<app>-serve.modal.run
MODAL_VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct
MODAL_VLLM_API_KEY=
```

Optional smoke test from your local machine:

```bash
modal run modal_vllm_inference.py --prompt "Say hello in one sentence."
```

## Run Frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

## Environment Variables
- `AI_PROVIDER`: `gemini` (default) or `modal`
- `GEMINI_API_KEY`: optional, used when `AI_PROVIDER=gemini`
- `GEMINI_MODEL`: optional, default `gemini-1.5-flash`
- `MODAL_VLLM_ENDPOINT`: Modal web URL for deployed `serve` function (base URL, no `/v1/chat/completions`)
- `MODAL_VLLM_MODEL`: must match the model served by Modal (default `Qwen/Qwen2.5-7B-Instruct`)
- `MODAL_VLLM_API_KEY`: optional bearer token if vLLM is started with `--api-key`
- `MODAL_VLLM_TIMEOUT_SECONDS`: HTTP timeout for backend->Modal inference calls
- `DATA_STORE_PATH`: optional JSON storage path

## AI Tools used
- Codex: scaffolding code base.
- ChatGPT: fixing small bugs and understanding code.
- Claude: converting Figma into frontend code.