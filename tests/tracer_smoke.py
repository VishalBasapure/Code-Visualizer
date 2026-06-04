"""Smoke tests for the Code Visualizer tracer.

Run with:
    python tests/tracer_smoke.py
"""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.tracer import TracerError, TracerInputRequired, run_code


def final_vars(code):
    steps = run_code(code)
    assert steps, "expected at least one traced step"
    return steps[-1]["variables"]


def test_try_except_finally():
    variables = final_vars(
        """
try:
    result = 10 / 0
except ZeroDivisionError:
    result = 0
except IndexError:
    result = None
finally:
    done = True
"""
    )
    assert variables["result"] == 0
    assert variables["done"] is True


def test_functions():
    variables = final_vars(
        """
def add(a, b):
    return a + b

result = add(5, 3)
"""
    )
    assert variables["result"] == 8
    assert "add" in variables


def test_classes_and_methods():
    variables = final_vars(
        """
class Animal:
    def __init__(self, name):
        self.name = name

class Dog(Animal):
    def speak(self):
        return self.name + " barks"

mydog = Dog("Buddy")
message = mydog.speak()
"""
    )
    assert "Dog" in variables
    assert "mydog" in variables
    assert variables["message"] == "Buddy barks"


def test_loops_break_and_append():
    variables = final_vars(
        """
result = []
for i in range(10):
    if i == 5:
        break
    result.append(i)
"""
    )
    assert variables["result"] == [0, 1, 2, 3, 4]


def test_unhandled_error_has_line():
    try:
        run_code("x = 10\nresult = x / 0\n")
    except TracerError as exc:
        assert exc.error_type == "ZeroDivisionError"
        assert exc.line == 2
        assert exc.steps
    else:
        raise AssertionError("expected ZeroDivisionError")


def test_input_values_are_consumed():
    steps = run_code(
        'x = input("enter a number: ")\nprint("you typed", x)\n',
        ["42"],
    )

    assert steps[-1]["variables"]["x"] == "42"
    input_step = next(step for step in steps if step["event"] == "input")
    assert input_step["input_prompt"] == "enter a number: "
    assert input_step["input_value"] == "42"
    assert "output" not in input_step
    assert any(step.get("output") == "you typed 42" for step in steps)


def test_missing_input_waits_without_runtime_error():
    try:
        run_code('x = input("enter a number: ")\nprint(x)\n')
    except TracerInputRequired as exc:
        assert exc.error_type == "InputRequired"
        assert exc.prompt == "enter a number: "
        assert exc.line == 1
        assert exc.steps[-1]["event"] == "input_request"
        assert not exc.steps[-1].get("error")
    else:
        raise AssertionError("expected input request")


def run_all():
    tests = [
        test_try_except_finally,
        test_functions,
        test_classes_and_methods,
        test_loops_break_and_append,
        test_unhandled_error_has_line,
        test_input_values_are_consumed,
        test_missing_input_waits_without_runtime_error,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"PASS {len(tests)} tracer smoke tests")


if __name__ == "__main__":
    run_all()
