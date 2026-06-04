"""Gemini-powered explanations for traced Python steps."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class LLMExplainError(Exception):
    def __init__(self, message, status_code=500):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def explain_step_and_program(code, step, step_number, total_steps):
    api_key = _gemini_api_key()
    prompt = _build_prompt(code, step, step_number, total_steps)
    response = _call_gemini(api_key, prompt)
    text = _extract_text(response)
    return _parse_explanation(text)


def explain_error_and_fix(code, error):
    api_key = _gemini_api_key()
    prompt = _build_error_prompt(code, error)
    response = _call_gemini(api_key, prompt, max_output_tokens=1200)
    text = _extract_text(response)
    return _parse_error_help(text, code)


def _gemini_api_key():
    _load_local_env()
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise LLMExplainError(
            "Gemini API key missing. Add GEMINI_API_KEY to your environment or project .env file.",
            503,
        )
    if "your_" in api_key.lower() or "here" in api_key.lower() or len(api_key) < 30:
        raise LLMExplainError(
            "Gemini API key looks like a placeholder. Paste the full key from Google AI Studio into .env.",
            400,
        )
    return api_key


def _load_local_env():
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _build_prompt(code, step, step_number, total_steps):
    safe_payload = {
        "code": code,
        "current_step_number": step_number,
        "total_steps": total_steps,
        "current_step": step,
    }
    return (
        "You explain Python code to a beginner.\n"
        "Use only the given traced execution data. Do not invent values.\n"
        "Keep words simple. Be specific to the current line.\n"
        "Return only valid JSON with these exact keys:\n"
        "- step_explanation: one or two short sentences explaining what the current step does.\n"
        "- program_summary: one or two short sentences explaining what the whole program does.\n\n"
        f"TRACE_DATA:\n{json.dumps(safe_payload, ensure_ascii=True)}"
    )


def _build_error_prompt(code, error):
    safe_payload = {
        "code": code,
        "error": error,
    }
    return (
        "You help a beginner fix Python code after it crashes.\n"
        "Explain like the user is new to coding: simple, kind, direct, and concrete.\n"
        "Use only the code and error data provided. Do not invent missing output.\n"
        "When returning fixed_code, make the smallest change that fixes this error.\n"
        "If the code is already impossible to fix with confidence, return the original code as fixed_code.\n"
        "Return only valid JSON with these exact keys:\n"
        "- simple_explanation: one or two short sentences explaining what the error means.\n"
        "- why_it_happened: one short sentence pointing to the problem in this code.\n"
        "- fix_suggestion: one or two short sentences explaining the repair.\n"
        "- fixed_code: the full corrected Python code.\n\n"
        f"ERROR_DATA:\n{json.dumps(safe_payload, ensure_ascii=True)}"
    )


def _call_gemini(api_key, prompt, max_output_tokens=260):
    query = urllib.parse.urlencode({"key": api_key})
    url = f"{GEMINI_ENDPOINT.format(model=GEMINI_MODEL)}?{query}"
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": max_output_tokens,
            "responseMimeType": "application/json",
        },
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise LLMExplainError(_friendly_gemini_error(detail), exc.code) from exc
    except urllib.error.URLError as exc:
        raise LLMExplainError(f"Could not reach Gemini: {exc.reason}", 503) from exc
    except TimeoutError as exc:
        raise LLMExplainError("Gemini took too long to respond. Please try again.", 504) from exc


def _friendly_gemini_error(detail):
    try:
        data = json.loads(detail)
    except json.JSONDecodeError:
        return "Gemini request failed. Check your API key and try again."

    error = data.get("error", {})
    message = error.get("message", "")
    status = error.get("status", "")
    if status == "INVALID_ARGUMENT" and "API key not valid" in message:
        return "Gemini API key is not valid. Copy the full key from Google AI Studio into .env, then restart the backend."
    if status == "PERMISSION_DENIED":
        return "Gemini rejected the request. Check that your API key is active for the Gemini API."
    if status == "RESOURCE_EXHAUSTED":
        return "Gemini free limit is used up for now. Try again later."
    return message or "Gemini request failed. Check your API key and try again."


def _extract_text(response):
    candidates = response.get("candidates") or []
    if not candidates:
        raise LLMExplainError("Gemini returned no explanation.", 502)

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts).strip()
    if not text:
        raise LLMExplainError("Gemini returned an empty explanation.", 502)
    return text


def _parse_explanation(text):
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise LLMExplainError("Gemini returned text that was not valid JSON.", 502)
        data = json.loads(text[start : end + 1])

    return {
        "step_explanation": str(data.get("step_explanation", "")).strip()
        or "This step runs the current line.",
        "program_summary": str(data.get("program_summary", "")).strip()
        or "This program runs the code step by step.",
        "model": GEMINI_MODEL,
    }


def _parse_error_help(text, original_code):
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise LLMExplainError("Gemini returned text that was not valid JSON.", 502)
        data = json.loads(text[start : end + 1])

    fixed_code = str(data.get("fixed_code", "")).strip()
    return {
        "simple_explanation": str(data.get("simple_explanation", "")).strip()
        or "Python found a problem and stopped before it could finish.",
        "why_it_happened": str(data.get("why_it_happened", "")).strip()
        or "The highlighted line needs a small change.",
        "fix_suggestion": str(data.get("fix_suggestion", "")).strip()
        or "Check the highlighted line, fix the mistake, and run the code again.",
        "fixed_code": fixed_code or original_code,
        "model": GEMINI_MODEL,
    }
