"""Build a beginner-friendly tree mind map from Python AST."""

from __future__ import annotations

import ast


class MindMapBuilder:
    def __init__(self, code):
        self.code = code
        self.next_id = 1
        self.class_names = set()

    def build(self):
        tree = ast.parse(self.code)
        self.class_names = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
        root = self._node(
            "Program Start",
            "program",
            "Python starts reading the file from top to bottom.",
            line=1,
            children=[],
        )

        for statement in tree.body:
            root["children"].extend(self._top_level_nodes(statement))

        return root

    def _top_level_nodes(self, statement):
        if isinstance(statement, ast.ClassDef):
            return [self._class_node(statement)]
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return [self._function_node(statement)]
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            created = self._object_creation_node(statement)
            if created:
                return [created]
            return [self._assignment_node(statement)]
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
            return self._call_expression_nodes(statement.value, statement)
        if isinstance(statement, (ast.For, ast.While)):
            return [self._loop_node(statement)]
        if isinstance(statement, ast.If):
            return [self._if_node(statement)]
        if isinstance(statement, ast.Try):
            return [self._try_node(statement)]
        if isinstance(statement, ast.Return):
            return [self._return_node(statement)]
        return [self._node("Run Statement", "run", self._source(statement), statement.lineno)]

    def _class_node(self, node):
        children = []
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                children.append(self._function_node(item))
        return self._node(
            f"Class Definition: {node.name}",
            "class",
            "Python creates a reusable blueprint.",
            node.lineno,
            getattr(node, "end_lineno", node.lineno),
            children,
        )

    def _function_node(self, node):
        title = f"{node.name}()"
        note = "Python stores these steps and runs them only when called."
        if node.name == "__init__":
            note = "Constructor steps run when a new object is created."

        children = []
        for statement in node.body:
            children.extend(self._function_body_nodes(statement, node.name))

        return self._node(
            title,
            "function",
            note,
            node.lineno,
            getattr(node, "end_lineno", node.lineno),
            children,
        )

    def _function_body_nodes(self, statement, function_name):
        if isinstance(statement, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            return [self._assignment_node(statement)]
        if isinstance(statement, ast.Return):
            return [self._return_node(statement, function_name)]
        if isinstance(statement, (ast.For, ast.While)):
            return [self._loop_node(statement)]
        if isinstance(statement, ast.If):
            return [self._if_node(statement)]
        if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call):
            return self._call_expression_nodes(statement.value, statement)
        return [self._node("Run Step", "run", self._source(statement), statement.lineno)]

    def _object_creation_node(self, statement):
        value = statement.value if isinstance(statement, ast.Assign) else statement.value
        if not isinstance(value, ast.Call):
            return None
        class_name = self._call_name(value)
        if class_name not in self.class_names:
            return None

        target = self._target_name(statement.target if isinstance(statement, ast.AnnAssign) else statement.targets[0])
        child_title = f"{target} = {class_name}(...)" if target else f"{class_name}(...)"
        return self._node(
            "Object Creation",
            "object",
            "Python builds a real object from the class blueprint.",
            statement.lineno,
            getattr(statement, "end_lineno", statement.lineno),
            [
                self._node(
                    child_title,
                    "assign",
                    "The new object is stored in memory.",
                    statement.lineno,
                    getattr(statement, "end_lineno", statement.lineno),
                )
            ],
        )

    def _call_expression_nodes(self, call, statement):
        if self._call_name(call) == "print":
            method_children = []
            for arg in call.args:
                method_children.extend(self._method_call_nodes(arg))

            nodes = method_children
            nodes.append(
                self._node(
                    "Print Output",
                    "print",
                    "The final value is shown on screen.",
                    statement.lineno,
                    getattr(statement, "end_lineno", statement.lineno),
                )
            )
            return nodes

        method_nodes = self._method_call_nodes(call)
        if method_nodes:
            return method_nodes
        return [self._node("Function Call", "call", self._source(statement), statement.lineno)]

    def _method_call_nodes(self, node):
        if not isinstance(node, ast.Call):
            return []
        name = self._call_name(node)
        if "." not in name:
            return []
        return [
            self._node(
                "Method Call",
                "call",
                "Python asks an object to run one of its methods.",
                node.lineno,
                getattr(node, "end_lineno", node.lineno),
                [
                    self._node(
                        f"{name}()",
                        "call",
                        "Control moves into the method body.",
                        node.lineno,
                        getattr(node, "end_lineno", node.lineno),
                    )
                ],
            )
        ]

    def _assignment_node(self, statement):
        target = self._assignment_target(statement)
        if target:
            return self._node(
                f"Assign {target}",
                "assign",
                "Python stores or updates this value.",
                statement.lineno,
                getattr(statement, "end_lineno", statement.lineno),
            )
        return self._node("Assign Value", "assign", self._source(statement), statement.lineno)

    def _return_node(self, statement, function_name=""):
        title = "Return value"
        if function_name == "greet":
            title = "Return greeting"
        return self._node(
            title,
            "return",
            "The function sends a value back to the caller.",
            statement.lineno,
            getattr(statement, "end_lineno", statement.lineno),
        )

    def _loop_node(self, statement):
        title = "Loop"
        if isinstance(statement, ast.For):
            title = f"Loop over {self._source(statement.target)}"
        children = []
        for item in statement.body:
            children.extend(self._function_body_nodes(item, ""))
        return self._node(
            title,
            "loop",
            "Python repeats the child steps.",
            statement.lineno,
            getattr(statement, "end_lineno", statement.lineno),
            children,
        )

    def _if_node(self, statement):
        children = []
        for item in statement.body:
            children.extend(self._function_body_nodes(item, ""))
        return self._node(
            "Condition Check",
            "condition",
            "Python chooses a branch based on true or false.",
            statement.lineno,
            getattr(statement, "end_lineno", statement.lineno),
            children,
        )

    def _try_node(self, statement):
        children = []
        for item in statement.body + [child for handler in statement.handlers for child in handler.body] + statement.finalbody:
            children.extend(self._function_body_nodes(item, ""))
        return self._node(
            "Error Handling",
            "error",
            "Python tries code and uses handlers if something fails.",
            statement.lineno,
            getattr(statement, "end_lineno", statement.lineno),
            children,
        )

    def _node(self, title, kind, note, line=None, end_line=None, children=None):
        node = {
            "id": f"mind-{self.next_id}",
            "title": title,
            "kind": kind,
            "note": note,
            "line": line,
            "end_line": end_line or line,
            "children": children or [],
        }
        self.next_id += 1
        return node

    def _assignment_target(self, statement):
        if isinstance(statement, ast.Assign) and statement.targets:
            return self._target_name(statement.targets[0])
        if isinstance(statement, ast.AnnAssign):
            return self._target_name(statement.target)
        if isinstance(statement, ast.AugAssign):
            return self._target_name(statement.target)
        return None

    def _target_name(self, target):
        if isinstance(target, ast.Name):
            return target.id
        if isinstance(target, ast.Attribute):
            return target.attr
        if isinstance(target, ast.Tuple) and target.elts:
            return self._target_name(target.elts[0])
        return None

    def _call_name(self, call):
        if isinstance(call.func, ast.Name):
            return call.func.id
        if isinstance(call.func, ast.Attribute):
            base = self._source(call.func.value)
            return f"{base}.{call.func.attr}" if base else call.func.attr
        return self._source(call.func)

    def _source(self, node):
        return ast.get_source_segment(self.code, node) or node.__class__.__name__


def build_mind_map(code):
    return MindMapBuilder(code).build()
