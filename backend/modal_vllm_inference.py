from __future__ import annotations

import json
import os
import subprocess
import time
from urllib import error, request

import modal

APP_NAME = "calendar-optimizer-vllm-inference"
MODEL_NAME = os.getenv("VLLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")
GPU_TYPE = os.getenv("VLLM_GPU", "H200")
VLLM_PORT = 8000

HF_CACHE_DIR = "/cache/hf"
VLLM_CACHE_DIR = "/cache/vllm"

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    # Pin HF stack versions to avoid transformer 5.x incompatibilities with vLLM 0.8.5.
    .pip_install(
        "vllm==0.8.5.post1",
        "transformers==4.51.3",
        "tokenizers==0.21.1",
        "hf-transfer",
    )
    .env(
        {
            "HF_HOME": HF_CACHE_DIR,
            "HF_HUB_CACHE": HF_CACHE_DIR,
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "VLLM_CONFIG_ROOT": VLLM_CACHE_DIR,
        }
    )
)

hf_cache = modal.Volume.from_name("calendar-optimizer-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("calendar-optimizer-vllm-cache", create_if_missing=True)


@app.function(
    image=image,
    gpu=GPU_TYPE,
    timeout=60 * 60 * 24,
    scaledown_window=60 * 10,
    volumes={
        HF_CACHE_DIR: hf_cache,
        VLLM_CACHE_DIR: vllm_cache,
    },
)
@modal.web_server(port=VLLM_PORT, startup_timeout=60 * 20)
def serve() -> None:
    api_key = os.getenv("VLLM_API_KEY", "").strip()

    cmd = [
        "vllm",
        "serve",
        MODEL_NAME,
        "--host",
        "0.0.0.0",
        "--port",
        str(VLLM_PORT),
        "--dtype",
        "auto",
        "--served-model-name",
        MODEL_NAME,
    ]
    if api_key:
        cmd += ["--api-key", api_key]

    subprocess.Popen(cmd)


def _http_get(url: str, headers: dict[str, str] | None = None, timeout: float = 15.0) -> tuple[int, str]:
    req = request.Request(url=url, headers=headers or {}, method="GET")
    with request.urlopen(req, timeout=timeout) as response:
        payload = response.read().decode("utf-8")
    return int(response.status), payload


def _post_json(
    url: str, payload: dict, headers: dict[str, str] | None = None, timeout: float = 60.0
) -> dict:
    req = request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body) if body else {}


@app.local_entrypoint()
def smoke_test(prompt: str = "Write one sentence about time blocking.") -> None:
    web_url = serve.get_web_url()
    if not web_url:
        raise RuntimeError("No web URL available. Deploy first with `modal deploy backend/modal_vllm_inference.py`.")

    base_url = web_url.rstrip("/")
    api_key = os.getenv("VLLM_API_KEY", "").strip()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    print(f"vLLM endpoint: {base_url}")

    last_error: Exception | None = None
    for _ in range(120):
        try:
            status_code, _ = _http_get(f"{base_url}/health", headers=headers, timeout=10.0)
            if 200 <= status_code < 300:
                break
        except Exception as exc:
            last_error = exc
        time.sleep(5)
    else:
        raise RuntimeError(f"Timed out waiting for /health: {last_error}")

    completion = _post_json(
        f"{base_url}/v1/chat/completions",
        {
            "model": MODEL_NAME,
            "temperature": 0.1,
            "messages": [{"role": "user", "content": prompt}],
        },
        headers=headers,
    )

    try:
        content = completion["choices"][0]["message"]["content"]
    except Exception as exc:
        raise RuntimeError(f"Unexpected completion payload: {completion}") from exc

    print("\nSmoke test response:\n")
    print(content)
