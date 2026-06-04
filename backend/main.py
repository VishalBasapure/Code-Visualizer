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


@app.get("/")
def home():
    return {"message": "Code Visualizer API running"}


@app.post("/analyze")
def analyze_code(data: dict):
    code = data.get("code", "")
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
        steps = run_code(code, inputs)
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


@app.post("/ai-explain")
def ai_explain(data: dict):
    code = data.get("code", "")
    step = data.get("step")
    step_number = data.get("step_number", 0)
    total_steps = data.get("total_steps", 0)

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
            content={
                "error": True,
                "error_type": "AIExplainError",
                "error_message": exc.message,
            },
        )


@app.post("/ai-error-help")
def ai_error_help(data: dict):
    code = data.get("code", "")
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
            content={
                "error": True,
                "error_type": "AIErrorHelpError",
                "error_message": exc.message,
            },
        )
