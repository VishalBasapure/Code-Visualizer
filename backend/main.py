"""FastAPI backend for Code Visualizer — Python tracer + Java/C++ runner."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.llm_explainer import (
    LLMExplainError,
    explain_error_and_fix,
    explain_step_and_program,
)
from backend.mind_map import build_mind_map
from backend.tracer import TracerError, TracerInputRequired, run_code

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Timeouts (seconds) ───────────────────────────────────────────────────────
_COMPILE_TIMEOUT = 15
_RUN_TIMEOUT     = 10


@app.get("/")
def home():
    return {"message": "Code Visualizer API running"}


# ─────────────────────────────────────────────────────────────────────────────
# /analyze  — Python step-by-step tracer (existing endpoint, unchanged)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/analyze")
def analyze_code(data: dict):
    code   = data.get("code", "")
    inputs = data.get("inputs", [])
    if not isinstance(inputs, list):
        inputs = []

    if not code.strip():
        return JSONResponse(
            status_code=400,
            content={
                "error": True,
                "error_type": "EmptyInput",
                "error_message": "No code provided. Please write some code and try again.",
                "line": None,
                "steps": [],
            },
        )

    try:
        steps    = run_code(code, inputs)
        mind_map = build_mind_map(code)
        return {"steps": steps, "mind_map": mind_map, "error": False}

    except TracerInputRequired as exc:
        try:
            mind_map = build_mind_map(code)
        except SyntaxError:
            mind_map = None
        return {
            "error": False,
            "needs_input": True,
            "input_prompt": exc.prompt,
            "input_line": exc.line,
            "input_index": exc.input_index,
            "steps": exc.steps,
            "mind_map": mind_map,
        }

    except TracerError as exc:
        try:
            mind_map = build_mind_map(code)
        except SyntaxError:
            mind_map = None
        return JSONResponse(
            status_code=422,
            content={
                "error": True,
                "error_type": exc.error_type,
                "error_message": exc.message,
                "line": exc.line,
                "steps": exc.steps,
                "mind_map": mind_map,
            },
        )

    except Exception:
        return JSONResponse(
            status_code=500,
            content={
                "error": True,
                "error_type": "InternalError",
                "error_message": "An unexpected server error occurred. Please try again.",
                "line": None,
                "steps": [],
            },
        )


# ─────────────────────────────────────────────────────────────────────────────
# /run-language  — compile & run Java or C/C++ (output only, no step trace)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/run-language")
def run_language(data: dict):
    code     = data.get("code", "").strip()
    language = data.get("language", "python").lower()

    if not code:
        return JSONResponse(
            status_code=400,
            content={"error": True, "error_type": "EmptyInput", "error_message": "No code provided."},
        )

    if language == "java":
        return _run_java(code)

    if language in ("cpp", "c++", "c"):
        return _run_cpp(code)

    return JSONResponse(
        status_code=400,
        content={
            "error": True,
            "error_type": "UnsupportedLanguage",
            "error_message": f"Language '{language}' is not supported by this endpoint. Use /analyze for Python.",
        },
    )


def _run_java(code: str):
    """Compile and run a Java snippet using javac + java."""
    # Extract the public class name; fall back to "Main"
    match = re.search(r"public\s+class\s+([A-Za-z_]\w*)", code)
    classname = match.group(1) if match else "Main"

    with tempfile.TemporaryDirectory() as tmpdir:
        src = os.path.join(tmpdir, f"{classname}.java")
        _write(src, code)

        # Compile
        compile_result = subprocess.run(
            ["javac", src],
            capture_output=True, text=True, timeout=_COMPILE_TIMEOUT,
        )
        if compile_result.returncode != 0:
            return JSONResponse(
                status_code=422,
                content={
                    "error": True,
                    "error_type": "CompileError",
                    "error_message": compile_result.stderr or "Compilation failed.",
                    "output": "",
                },
            )

        # Run
        run_result = subprocess.run(
            ["java", "-cp", tmpdir, classname],
            capture_output=True, text=True, timeout=_RUN_TIMEOUT,
        )
        return {
            "error": False,
            "output": run_result.stdout,
            "stderr": run_result.stderr,
            "return_code": run_result.returncode,
            "steps": [],
        }


def _run_cpp(code: str):
    """Compile and run a C/C++ snippet using g++."""
    with tempfile.TemporaryDirectory() as tmpdir:
        src = os.path.join(tmpdir, "main.cpp")
        exe = os.path.join(tmpdir, "main")
        _write(src, code)

        # Compile
        compile_result = subprocess.run(
            ["g++", "-o", exe, src, "-std=c++17"],
            capture_output=True, text=True, timeout=_COMPILE_TIMEOUT,
        )
        if compile_result.returncode != 0:
            return JSONResponse(
                status_code=422,
                content={
                    "error": True,
                    "error_type": "CompileError",
                    "error_message": compile_result.stderr or "Compilation failed.",
                    "output": "",
                },
            )

        # Run
        run_result = subprocess.run(
            [exe],
            capture_output=True, text=True, timeout=_RUN_TIMEOUT,
        )
        return {
            "error": False,
            "output": run_result.stdout,
            "stderr": run_result.stderr,
            "return_code": run_result.returncode,
            "steps": [],
        }


def _write(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


# ─────────────────────────────────────────────────────────────────────────────
# /ai-explain  — LLM step explanation (unchanged)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/ai-explain")
def ai_explain(data: dict):
    code         = data.get("code", "")
    step         = data.get("step")
    step_number  = data.get("step_number", 0)
    total_steps  = data.get("total_steps", 0)

    if not code.strip() or not isinstance(step, dict):
        return JSONResponse(
            status_code=400,
            content={
                "error": True,
                "error_type": "BadExplainRequest",
                "error_message": "Run code first, then ask AI to explain the current step.",
            },
        )

    try:
        explanation = explain_step_and_program(code, step, step_number, total_steps)
        return {"error": False, **explanation}
    except LLMExplainError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": True, "error_type": "AIExplainError", "error_message": exc.message},
        )


# ─────────────────────────────────────────────────────────────────────────────
# /ai-error-help  — LLM error fix (unchanged)
# ─────────────────────────────────────────────────────────────────────────────
@app.post("/ai-error-help")
def ai_error_help(data: dict):
    code  = data.get("code", "")
    error = data.get("error")

    if not code.strip() or not isinstance(error, dict):
        return JSONResponse(
            status_code=400,
            content={
                "error": True,
                "error_type": "BadErrorHelpRequest",
                "error_message": "Run code first, then ask AI to explain the error.",
            },
        )

    try:
        help_text = explain_error_and_fix(code, error)
        return {"error": False, **help_text}
    except LLMExplainError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": True, "error_type": "AIErrorHelpError", "error_message": exc.message},
        )