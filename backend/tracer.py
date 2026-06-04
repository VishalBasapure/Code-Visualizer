"""Trace Python code execution for the Code Visualizer."""

from __future__ import annotations

import ast
import builtins
import contextlib
import io
import sys

MAX_STEPS = 1000
USER_CODE_FILENAME = "<user_code>"


class TracerError(Exception):
    """Structured error raised by the tracer."""

    def __init__(self, error_type, message, line=None, steps=None):
        self.error_type = error_type
        self.message = message
        self.line = line
        self.steps = steps or []
        super().__init__(message)


class TracerInputRequired(TracerError):
    """Raised when user code reaches input() before a value is available."""

    def __init__(self, prompt="", line=None, input_index=0, steps=None):
        self.prompt = prompt
        self.input_index = input_index
        message = "Python is waiting for input."
        super().__init__("InputRequired", message, line, steps)


class ExecutionTracer:
    """Run real Python while recording line-by-line state."""

    def __init__(self, code, inputs=None):
        self.code = code
        self.lines = code.splitlines()
        self.inputs = [str(item) for item in (inputs or [])]
        self.input_index = 0
        self.pending_input_events = []
        self.steps = []
        self.step_count = 0
        self.next_step_id = 1
        self.previous_lines = {}
        self.stdout = io.StringIO()
        self.stdout_pos = 0
        self.globals = {
            "__builtins__": self._builtins(),
            "__name__": "__main__",
        }

    def run(self):
        try:
            compiled = compile(self.code, USER_CODE_FILENAME, "exec")
        except SyntaxError as exc:
            line = exc.lineno
            message = f"Syntax error on line {line}: {exc.msg}"
            raise TracerError("SyntaxError", message, line)

        old_trace = sys.gettrace()
        try:
            with contextlib.redirect_stdout(self.stdout):
                sys.settrace(self._trace)
                exec(compiled, self.globals, self.globals)
        except TracerInputRequired as exc:
            self._flush_pending_steps()
            self.steps = [
                step
                for step in self.steps
                if not (
                    step.get("line") == exc.line
                    and step.get("event") == "input"
                    and "input_value" not in step
                )
            ]
            self.steps.append(
                self._make_step(
                    exc.line,
                    self._line_text(exc.line),
                    event="input_request",
                    input_prompt=exc.prompt,
                    input_index=exc.input_index,
                )
            )
            exc.steps = self.steps
            raise
        except TracerError:
            raise
        except Exception as exc:
            error = self._to_tracer_error(exc)
            self._flush_pending_steps()
            self.steps.append(
                self._make_step(
                    error.line,
                    self._line_text(error.line),
                    error=True,
                    error_type=error.error_type,
                    error_message=error.message,
                    event="error",
                )
            )
            error.steps = self.steps
            raise error
        finally:
            sys.settrace(old_trace)

        self._flush_pending_steps()
        return self.steps

    def _trace(self, frame, event, arg):
        if frame.f_code.co_filename != USER_CODE_FILENAME:
            return self._trace

        if event == "call":
            self._handle_call(frame)
        elif event == "line":
            self._check_step_limit(frame.f_lineno)
            self._finalize_previous_line(frame)
            self.previous_lines[id(frame)] = frame.f_lineno
        elif event == "return":
            self._finalize_previous_line(frame, return_value=arg)
            self.previous_lines.pop(id(frame), None)

        return self._trace

    def _handle_call(self, frame):
        frame_name = frame.f_code.co_name
        if frame_name == "<module>" or frame_name.startswith("<"):
            return

        caller = frame.f_back
        caller_line = caller.f_lineno if caller and caller.f_code.co_filename == USER_CODE_FILENAME else None
        if caller_line == frame.f_code.co_firstlineno:
            return
        self.steps.append(
            self._make_step(
                line_no=frame.f_code.co_firstlineno,
                expression=f"call {frame_name}()",
                variables=self._serialize_variables(frame.f_locals),
                event="call",
                depth=self._frame_depth(frame),
                frame_name=frame_name,
                from_line=caller_line,
            )
        )

    def _finalize_previous_line(self, frame, return_value=None):
        frame_id = id(frame)
        line_no = self.previous_lines.get(frame_id)
        if line_no is None:
            return

        source = self._line_text(line_no)
        if not source.strip():
            return

        output = self._read_stdout_delta()
        condition = self._condition_value(source, frame)
        input_info = self._consume_input_info(line_no) if self._uses_input(source) else {}
        if source.strip().startswith("return "):
            output = return_value

        self.steps.append(
            self._make_step(
                line_no=line_no,
                expression=source.strip(),
                updated_var=self._updated_name(source),
                output=output,
                condition=condition,
                input_prompt=input_info.get("prompt"),
                input_value=input_info.get("value"),
                input_index=input_info.get("index"),
                variables=self._serialize_variables(frame.f_locals),
                event=self._step_event(source, output, condition),
                depth=self._frame_depth(frame),
                frame_name=frame.f_code.co_name,
            )
        )

    def _flush_pending_steps(self):
        for frame_id in list(self.previous_lines):
            self.previous_lines.pop(frame_id, None)

    def _make_step(
        self,
        line_no,
        expression="",
        updated_var=None,
        output=None,
        condition=None,
        variables=None,
        error=False,
        error_type=None,
        error_message=None,
        input_prompt=None,
        input_value=None,
        input_index=None,
        event=None,
        depth=0,
        frame_name="<module>",
        from_line=None,
    ):
        step = {
            "id": self.next_step_id,
            "line": line_no,
            "variables": variables if variables is not None else self._serialize_variables(self.globals),
            "expression": expression,
            "updated_var": updated_var,
            "event": event or "line",
            "depth": depth,
            "frame": frame_name,
        }
        self.next_step_id += 1
        if from_line is not None:
            step["from_line"] = from_line
        if output not in (None, ""):
            step["output"] = output
        if condition is not None:
            step["condition"] = condition
        if input_prompt is not None:
            step["input_prompt"] = input_prompt
        if input_value is not None:
            step["input_value"] = input_value
        if input_index is not None:
            step["input_index"] = input_index
        if error:
            step["error"] = True
            step["error_type"] = error_type
            step["error_message"] = error_message
        return step

    def _step_event(self, source, output=None, condition=None):
        stripped = source.strip()
        if self._uses_input(source):
            return "input"
        if stripped.startswith("return "):
            return "return"
        if stripped.startswith("print"):
            return "print"
        if condition is not None:
            return "condition"
        if stripped.startswith(("for ", "while ")):
            return "loop"
        if stripped.startswith(("try:", "except ", "finally:")):
            return "exception_flow"
        if self._updated_name(source):
            return "assign"
        return "line"

    def _frame_depth(self, frame):
        depth = 0
        cursor = frame
        while cursor:
            if cursor.f_code.co_filename == USER_CODE_FILENAME and cursor.f_code.co_name != "<module>":
                depth += 1
            cursor = cursor.f_back
        return depth

    def _serialize_variables(self, values):
        serialized = {}
        for key, value in values.items():
            if key.startswith("__"):
                continue
            if key == "__builtins__":
                continue
            serialized[key] = self._serialize_value(value)
        return serialized

    def _serialize_value(self, value):
        if isinstance(value, (int, float, str, bool, type(None))):
            return value
        if isinstance(value, (list, tuple)):
            return [self._serialize_value(item) for item in value]
        if isinstance(value, dict):
            return {
                self._serialize_value(key): self._serialize_value(item)
                for key, item in value.items()
            }
        if isinstance(value, set):
            return [self._serialize_value(item) for item in sorted(value, key=repr)]
        if isinstance(value, type):
            return f"class {value.__name__}"
        if callable(value):
            name = getattr(value, "__name__", "function")
            return f"function {name}"
        if hasattr(value, "__dict__"):
            attrs = {
                key: self._serialize_value(item)
                for key, item in vars(value).items()
                if not key.startswith("_")
            }
            return {
                "type": value.__class__.__name__,
                "attributes": attrs,
            }
        return repr(value)

    def _read_stdout_delta(self):
        text = self.stdout.getvalue()
        delta = text[self.stdout_pos :]
        self.stdout_pos = len(text)
        return delta.rstrip("\n")

    def _line_text(self, line_no):
        if not line_no or line_no < 1 or line_no > len(self.lines):
            return ""
        return self.lines[line_no - 1]

    def _updated_name(self, source):
        try:
            tree = ast.parse(source.strip())
        except SyntaxError:
            return None

        if not tree.body:
            return None

        node = tree.body[0]
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return node.name
        if isinstance(node, ast.Assign) and node.targets:
            return self._target_name(node.targets[0])
        if isinstance(node, ast.AnnAssign):
            return self._target_name(node.target)
        if isinstance(node, ast.AugAssign):
            return self._target_name(node.target)
        if isinstance(node, ast.For):
            return self._target_name(node.target)
        if isinstance(node, (ast.Import, ast.ImportFrom)) and node.names:
            alias = node.names[0]
            return alias.asname or alias.name.split(".")[0]
        return None

    def _target_name(self, target):
        if isinstance(target, ast.Name):
            return target.id
        if isinstance(target, ast.Tuple) and target.elts:
            return self._target_name(target.elts[0])
        return None

    def _condition_value(self, source, frame):
        stripped = source.strip()
        if not stripped.startswith(("if ", "elif ", "while ")):
            return None

        try:
            tree = ast.parse(stripped)
        except SyntaxError:
            return None

        node = tree.body[0] if tree.body else None
        test = getattr(node, "test", None)
        if test is None or self._has_side_effect(test):
            return None

        try:
            expr = ast.Expression(test)
            ast.fix_missing_locations(expr)
            return bool(eval(compile(expr, USER_CODE_FILENAME, "eval"), frame.f_globals, frame.f_locals))
        except Exception:
            return None

    def _uses_input(self, source):
        try:
            tree = ast.parse(source.strip())
        except SyntaxError:
            return False

        return any(
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "input"
            for node in ast.walk(tree)
        )

    def _input(self, prompt=""):
        prompt_text = "" if prompt is None else str(prompt)
        line = self._current_user_line()
        if self.input_index >= len(self.inputs):
            raise TracerInputRequired(prompt_text, line, self.input_index, self.steps)

        value = self.inputs[self.input_index]
        self.pending_input_events.append(
            {
                "line": line,
                "prompt": prompt_text,
                "value": value,
                "index": self.input_index,
            }
        )
        self.input_index += 1
        return value

    def _current_user_line(self):
        try:
            frame = sys._getframe(2)
        except ValueError:
            return None

        while frame:
            if frame.f_code.co_filename == USER_CODE_FILENAME:
                return frame.f_lineno
            frame = frame.f_back
        return None

    def _consume_input_info(self, line_no):
        matches = [
            item for item in self.pending_input_events if item.get("line") == line_no
        ]
        if not matches:
            return {}

        self.pending_input_events = [
            item for item in self.pending_input_events if item.get("line") != line_no
        ]
        return {
            "prompt": "\n".join(item["prompt"] for item in matches if item["prompt"]),
            "value": "\n".join(item["value"] for item in matches),
            "index": matches[0]["index"],
        }

    def _has_side_effect(self, node):
        side_effect_nodes = (
            ast.Call,
            ast.Await,
            ast.Yield,
            ast.YieldFrom,
            ast.NamedExpr,
        )
        return any(isinstance(child, side_effect_nodes) for child in ast.walk(node))

    def _to_tracer_error(self, exc):
        line = None
        tb = exc.__traceback__
        while tb:
            if tb.tb_frame.f_code.co_filename == USER_CODE_FILENAME:
                line = tb.tb_lineno
            tb = tb.tb_next

        source = self._line_text(line).strip()
        if isinstance(exc, ZeroDivisionError) and source:
            message = f"Division by zero in: {source}"
        else:
            detail = str(exc) or exc.__class__.__name__
            message = f"{exc.__class__.__name__}: {detail}"

        return TracerError(exc.__class__.__name__, message, line, self.steps)

    def _check_step_limit(self, line_no):
        self.step_count += 1
        if self.step_count > MAX_STEPS:
            raise TracerError(
                "StepLimitExceeded",
                f"Execution stopped after {MAX_STEPS} steps. Check for infinite loops.",
                line_no,
                self.steps,
            )

    def _builtins(self):
        names = [
            "__build_class__",
            "abs",
            "all",
            "any",
            "bool",
            "dict",
            "enumerate",
            "EOFError",
            "float",
            "getattr",
            "hasattr",
            "input",
            "int",
            "isinstance",
            "len",
            "list",
            "max",
            "min",
            "object",
            "print",
            "range",
            "repr",
            "reversed",
            "round",
            "set",
            "setattr",
            "sorted",
            "str",
            "sum",
            "super",
            "tuple",
            "type",
            "zip",
            "BaseException",
            "Exception",
            "ArithmeticError",
            "AttributeError",
            "IndexError",
            "KeyError",
            "NameError",
            "RuntimeError",
            "SyntaxError",
            "TypeError",
            "ValueError",
            "ZeroDivisionError",
        ]
        available = {name: getattr(builtins, name) for name in names if name != "input"}
        available["input"] = self._input
        return available


def run_code(code, inputs=None):
    """Execute code and return visualization steps."""

    tracer = ExecutionTracer(code, inputs)
    return tracer.run()
