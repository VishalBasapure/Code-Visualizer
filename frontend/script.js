let steps = [];
let mindMap = null;
let currentStep = 0;
let codeLines = [];
let interval = null;
let speed = 1200;
let isPlaying = false;
let activeCodeLine = null;
let originalCode = "";
let codeViewMode = "original";
let currentError = null;
let latestAIFixedCode = "";
let pendingInputRequest = null;
const aiExplanationCache = new Map();
const aiErrorHelpCache = new Map();
const CODE_HISTORY_KEY = "codeVisualizer.history.v1";
const CODE_HISTORY_LIMIT = 5;
const API_BASE_URL =
    ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? "http://127.0.0.1:8000"
        : "https://your-render-backend.onrender.com";
async function runCode() {
    const code = document.getElementById("code").value;
    const inputs = readProgramInputs();

    if (!code.trim()) {
        codeLines = code.split("\n");
        renderFlowMap();
        updateLineNumbers();
        showError("EmptyInput", "Please write some code before running.", null);
        setStepMessage("No code yet", "Write a few lines, then run them.");
        return;
    }

    saveCodeHistory(code);
    pause();
    steps = [];
    mindMap = null;
    currentStep = 0;
    aiExplanationCache.clear();
    aiErrorHelpCache.clear();
    currentError = null;
    latestAIFixedCode = "";
    clearInputRequest();
    codeLines = code.split("\n");
    activeCodeLine = null;
    updateLineNumbers();
    clearError();
    renderFlowMap();
    renderMemory({});
    resetInspectorLists();
    setText("flow", "");
    setText("stepCounter", "Running...");
    setProgress(0);
    setStepMessage("Preparing code", "Python is checking the code before it starts.");

    try {
        const response = await fetch(`${API_BASE_URL}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, inputs }),
        });
        const data = await response.json();

        steps = data.steps || [];
        mindMap = data.mind_map || buildCodeMindMap(code);
        if (data.needs_input) {
            if (steps.length > 0) {
                currentStep = steps.length - 1;
                showStep();
            }
            showInputRequest(data);
            setStepMessage("Waiting for input", inputRequestMessage(data));
            setText("stepCounter", steps.length > 0 ? `Step ${currentStep + 1} of ${steps.length}` : "Waiting for input");
            return;
        }

        if (data.error) {
            if (steps.length > 0) {
                currentStep = steps.length - 1;
                showStep();
            }
            showError(data.error_type, data.error_message, data.line);
            setStepMessage("Execution stopped", explainError(data));
            return;
        }

        if (steps.length === 0) {
            showError("NoSteps", "No executable steps found in the code.", null);
            setStepMessage("Nothing ran", "Only blank lines or comments were found.");
            return;
        }

        showStep();
    } catch (error) {
        showError("ConnectionError", "Could not reach the backend on port 8000.", null);
        setStepMessage("Backend not connected", "Start the FastAPI server, then run the code again.");
    }
}

function showStep() {
    if (steps.length === 0) {
        return;
    }

    const step = steps[currentStep];
    activeCodeLine = step.line || null;
    updateLineNumbers(activeCodeLine);
    renderFlowMap(currentStep);
    renderMemory(step);
    renderEncountered();
    renderChangeHistory();
    renderFlow(step);
    renderOutput();
    renderStepExplanation(step);
    resetAIExplanation();
    setText("stepCounter", `Step ${currentStep + 1} of ${steps.length}`);
    setProgress(((currentStep + 1) / steps.length) * 100);

    if (step.error) {
        showError(step.error_type, step.error_message, step.line);
    } else {
        clearError();
    }
}

async function explainWithAI() {
    const button = document.getElementById("aiExplainButton");
    const box = document.getElementById("aiExplainBox");
    const code = document.getElementById("code").value;

    if (steps.length === 0 || !steps[currentStep]) {
        showAIExplanationMessage("Run code first, then click AI Explain.");
        return;
    }

    const cacheKey = `${currentStep}:${valueSignature(code)}:${valueSignature(steps[currentStep])}`;
    if (aiExplanationCache.has(cacheKey)) {
        renderAIExplanation(aiExplanationCache.get(cacheKey));
        return;
    }

    button.disabled = true;
    box.classList.add("empty-state");
    box.textContent = "AI is explaining this step...";

    try {
        const response = await fetch(`${API_BASE_URL}/ai-explain`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code,
                step: steps[currentStep],
                step_number: currentStep + 1,
                total_steps: steps.length,
            }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error_message || "AI explanation failed.");
        }
        aiExplanationCache.set(cacheKey, data);
        renderAIExplanation(data);
    } catch (error) {
        showAIExplanationMessage(error.message || "AI explanation failed.");
    } finally {
        button.disabled = false;
    }
}

function renderAIExplanation(data) {
    const box = document.getElementById("aiExplainBox");
    box.innerHTML = "";
    box.classList.remove("empty-state");

    const stepTitle = document.createElement("div");
    stepTitle.className = "ai-explain-title";
    stepTitle.textContent = "This step";

    const stepText = document.createElement("div");
    stepText.className = "ai-explain-text";
    stepText.textContent = data.step_explanation;

    const programTitle = document.createElement("div");
    programTitle.className = "ai-explain-title";
    programTitle.textContent = "Whole program";

    const programText = document.createElement("div");
    programText.className = "ai-explain-text";
    programText.textContent = data.program_summary;

    box.append(stepTitle, stepText, programTitle, programText);
}

function resetAIExplanation() {
    showAIExplanationMessage("Click AI Explain for perticular step and program summary.");
}

function showAIExplanationMessage(message) {
    const box = document.getElementById("aiExplainBox");
    box.innerHTML = "";
    box.classList.add("empty-state");
    box.textContent = message;
}

function renderFlowMap(activeIndex = -1) {
    const content = document.getElementById("flowContent");
    const svg = document.getElementById("flowSvg");
    const empty = document.getElementById("flowEmpty");
    content.querySelectorAll(".flow-node, .mind-node, .mind-hub, .mind-root").forEach((node) => node.remove());
    svg.innerHTML = "";

    if (!mindMap && steps.length === 0) {
        empty.hidden = false;
        content.style.width = "";
        content.style.height = "";
        svg.setAttribute("height", "0");
        return;
    }

    empty.hidden = true;
    const layout = buildMindMapLayout(activeIndex);
    content.style.width = `${layout.width}px`;
    content.style.height = `${layout.height}px`;
    svg.setAttribute("width", String(layout.width));
    svg.setAttribute("height", String(layout.height));
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.innerHTML = `
        <defs>
            <marker id="flowArrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                <path d="M0,0 L10,4 L0,8 Z" fill="currentColor"></path>
            </marker>
        </defs>
    `;

    layout.edges.forEach((edge) => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", edge.path);
        path.setAttribute("class", pipeClass(edge, activeIndex));
        path.setAttribute("marker-end", "url(#flowArrow)");
        svg.appendChild(path);
    });

    layout.nodes.forEach((node, index) => {
        const el = document.createElement("div");
        el.className = mindNodeClass(node, activeIndex);
        el.style.left = `${node.x}px`;
        el.style.top = `${node.y}px`;
        el.style.width = `${node.width}px`;
        el.style.minHeight = `${node.height}px`;

        const kind = document.createElement("div");
        kind.className = "node-kind";
        kind.textContent = node.kind;

        const title = document.createElement("div");
        title.className = "node-title";
        title.textContent = node.title;

        const meta = document.createElement("div");
        meta.className = "node-meta";
        meta.textContent = node.meta || nodeLineMeta(node);

        el.append(kind, title, meta);
        if (node.note) {
            const note = document.createElement("div");
            note.className = "node-note";
            note.textContent = node.note;
            el.appendChild(note);
        }
        content.appendChild(el);
    });

    const activeNode = content.querySelector(".mind-node.active");
    if (activeNode) {
        window.setTimeout(() => activeNode.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }), 30);
    }
}

function buildTreeLayout(tree, activeIndex = -1) {
    const nodeWidth = 196;
    const nodeHeight = 116;
    const xGap = 54;
    const yGap = 38;
    const marginX = 26;
    const marginY = 30;
    const nodes = [];
    const edges = [];
    let leafCursor = 0;
    let maxDepth = 0;

    function place(source, depth, parent = null) {
        const children = source.children || [];
        const placedChildren = children.map((child) => place(child, depth + 1, source));
        let slot;
        if (placedChildren.length === 0) {
            slot = leafCursor;
            leafCursor += 1;
        } else {
            slot = (placedChildren[0].slot + placedChildren[placedChildren.length - 1].slot) / 2;
        }

        const node = {
            ...source,
            type: depth === 0 ? "root" : "leaf",
            category: source.kind || "run",
            stepIndex: firstStepIndexForLine(source.line, source.end_line),
            x: marginX + depth * (nodeWidth + xGap),
            y: marginY + slot * (nodeHeight + yGap),
            width: nodeWidth,
            height: nodeHeight,
            slot,
        };
        nodes.push(node);
        maxDepth = Math.max(maxDepth, depth);

        if (parent) {
            edges.push({ parent, child: node });
        }
        return node;
    }

    const root = place(tree, 0);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const paths = edges.map((edge) => ({
        event: eventForKind(edge.child.kind),
        state: edgeStateForTreeNode(edge.child, activeIndex),
        kind: "tree-branch",
        path: treePath(byId.get(edge.parent.id) || root, edge.child),
    }));

    return {
        nodes,
        edges: paths,
        width: marginX * 2 + (maxDepth + 1) * nodeWidth + maxDepth * xGap,
        height: marginY * 2 + Math.max(1, leafCursor) * (nodeHeight + yGap),
    };
}

function treePath(from, to) {
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const midX = startX + (endX - startX) / 2;
    return `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
}

function firstStepIndexForLine(line, endLine) {
    if (!line) {
        return -1;
    }
    return steps.findIndex((step) => step.line >= line && step.line <= (endLine || line));
}

function edgeStateForTreeNode(node, activeIndex) {
    if (node.stepIndex === -1) {
        return "complete";
    }
    if (node.stepIndex === activeIndex || lineIsActive(node, activeIndex)) {
        return "active-flow";
    }
    if (node.stepIndex < activeIndex) {
        return "complete";
    }
    return "future";
}

function eventForKind(kind) {
    if (kind === "call" || kind === "object") {
        return "call";
    }
    if (kind === "return") {
        return "return";
    }
    if (kind === "condition" || kind === "loop") {
        return "condition";
    }
    if (kind === "error") {
        return "error";
    }
    return "line";
}

function buildCodeMindMap(code) {
    const lines = code.split("\n");
    const root = makeCodeNode("Program Start", "program", "Python starts reading the file from top to bottom.", 1);

    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || raw.search(/\S/) !== 0) {
            continue;
        }

        const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
            const classNode = makeCodeNode(`Class Definition: ${classMatch[1]}`, "class", "Python creates a reusable blueprint.", i + 1);
            i = fillClassChildren(classNode, lines, i + 1) - 1;
            root.children.push(classNode);
            continue;
        }

        const creationMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Z][A-Za-z0-9_]*)\s*\(/);
        if (creationMatch) {
            root.children.push(makeCodeNode("Object Creation", "object", "Python builds a real object from a class blueprint.", i + 1, [
                makeCodeNode(`${creationMatch[1]} = ${creationMatch[2]}(...)`, "assign", "The object is stored in memory.", i + 1),
            ]));
            continue;
        }

        if (trimmed.startsWith("print(")) {
            const methodMatch = trimmed.match(/([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*\(/);
            if (methodMatch) {
                root.children.push(makeCodeNode("Method Call", "call", "Python asks an object to run one of its methods.", i + 1, [
                    makeCodeNode(`${methodMatch[1]}()`, "call", "Control moves into the method body.", i + 1),
                ]));
            }
            root.children.push(makeCodeNode("Print Output", "print", "The final value is shown on screen.", i + 1));
            continue;
        }

        if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) {
            const target = trimmed.split("=")[0].trim();
            root.children.push(makeCodeNode(`Assign ${target}`, "assign", "Python stores or updates this value.", i + 1));
        }
    }

    return root;
}

function fillClassChildren(classNode, lines, startIndex) {
    for (let i = startIndex; i < lines.length; i += 1) {
        const raw = lines[i];
        const trimmed = raw.trim();
        const indent = raw.search(/\S/);
        if (trimmed && indent === 0) {
            return i;
        }
        if (!trimmed || indent !== 4) {
            continue;
        }
        const methodMatch = trimmed.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (!methodMatch) {
            continue;
        }
        const methodNode = makeCodeNode(`${methodMatch[1]}()`, "function", "Python stores these steps and runs them only when called.", i + 1);
        i = fillMethodChildren(methodNode, lines, i + 1) - 1;
        classNode.children.push(methodNode);
    }
    return lines.length;
}

function fillMethodChildren(methodNode, lines, startIndex) {
    for (let i = startIndex; i < lines.length; i += 1) {
        const raw = lines[i];
        const trimmed = raw.trim();
        const indent = raw.search(/\S/);
        if (trimmed && indent <= 4) {
            return i;
        }
        if (!trimmed) {
            continue;
        }
        const assignMatch = trimmed.match(/^self\.([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (assignMatch) {
            methodNode.children.push(makeCodeNode(`Assign ${assignMatch[1]}`, "assign", "Python stores this value inside the object.", i + 1));
            continue;
        }
        if (trimmed.startsWith("return ")) {
            const title = methodNode.title === "greet()" ? "Return greeting" : "Return value";
            methodNode.children.push(makeCodeNode(title, "return", "The function sends a value back to the caller.", i + 1));
        }
    }
    return lines.length;
}

function makeCodeNode(title, kind, note, line, children = []) {
    return {
        id: `local-${line}-${kind}-${title}`,
        title,
        kind,
        note,
        line,
        end_line: line,
        children,
    };
}

function buildMindMapLayout(activeIndex = -1) {
    if (mindMap) {
        return buildTreeLayout(mindMap, activeIndex);
    }

    const categories = [
        {
            id: "definition",
            kind: "define",
            title: "Blueprints",
            note: "Classes and functions Python stores before it uses them.",
            event: "line",
        },
        {
            id: "call",
            kind: "call",
            title: "Function movement",
            note: "Places where Python jumps into work or sends a value back.",
            event: "call",
        },
        {
            id: "decision",
            kind: "decide",
            title: "Questions",
            note: "Branches, loops, and protected blocks that choose the next path.",
            event: "condition",
        },
        {
            id: "memory",
            kind: "memory",
            title: "Memory changes",
            note: "Names and object fields that receive new values.",
            event: "assign",
        },
        {
            id: "output",
            kind: "output",
            title: "Visible result",
            note: "Values that leave the program through print or return.",
            event: "print",
        },
        {
            id: "error",
            kind: "error",
            title: "Stops and fixes",
            note: "Errors and handlers that redirect the program.",
            event: "error",
        },
        {
            id: "runtime",
            kind: "run",
            title: "Other actions",
            note: "Useful steps that do not fit another bucket.",
            event: "line",
        },
    ];

    const grouped = new Map(categories.map((category) => [category.id, []]));
    steps.forEach((step, index) => {
        grouped.get(categoryForStep(step)).push({ step, index });
    });

    const usedCategories = categories.filter((category) => grouped.get(category.id).length > 0);
    const nodes = [];
    const edges = [];
    const stepNodes = new Map();
    const margin = 32;
    const rootWidth = 190;
    const rootHeight = 88;
    const hubWidth = 178;
    const hubHeight = 74;
    const leafWidth = 248;
    const leafHeight = 94;
    const leafGap = 14;
    const laneGap = 34;
    const laneMinHeight = 132;
    const rootX = 34;
    const hubX = 284;
    const leafX = 520;
    let y = margin;

    usedCategories.forEach((category) => {
        const items = grouped.get(category.id);
        const laneHeight = Math.max(laneMinHeight, items.length * (leafHeight + leafGap) + 12);
        const hubY = y + (laneHeight - hubHeight) / 2;
        const hub = {
            id: `hub-${category.id}`,
            type: "hub",
            category: category.id,
            kind: category.kind,
            title: category.title,
            meta: `${items.length} ${items.length === 1 ? "idea" : "ideas"}`,
            note: category.note,
            x: hubX,
            y: hubY,
            width: hubWidth,
            height: hubHeight,
            firstIndex: items[0]?.index ?? Infinity,
            lastIndex: items[items.length - 1]?.index ?? -1,
        };
        nodes.push(hub);

        items.forEach((item, itemIndex) => {
            const info = explainStep(item.step);
            const depthOffset = Math.min(item.step.depth || 0, 3) * 34;
            const node = {
                id: `step-${item.index}`,
                type: "leaf",
                category: category.id,
                step: item.step,
                stepIndex: item.index,
                kind: eventLabel(item.step),
                title: info.title,
                meta: nodeMeta(item.step),
                note: info.body,
                x: leafX + depthOffset,
                y: y + 6 + itemIndex * (leafHeight + leafGap),
                width: leafWidth,
                height: leafHeight,
            };
            nodes.push(node);
            stepNodes.set(item.index, node);

            edges.push({
                event: item.step.event,
                state: edgeState(item.index, activeIndex),
                kind: "branch",
                path: curveBetween(hub, node),
            });
        });

        y += laneHeight + laneGap;
    });

    const height = Math.max(y + margin - laneGap, 440);
    const root = {
        id: "root",
        type: "root",
        category: "root",
        kind: "program",
        title: "Code starts here",
        meta: `${steps.length} traced ${steps.length === 1 ? "step" : "steps"}`,
        note: "Python builds the ideas first, then follows the active path.",
        x: rootX,
        y: height / 2 - rootHeight / 2,
        width: rootWidth,
        height: rootHeight,
    };
    nodes.unshift(root);

    nodes.filter((node) => node.type === "hub").forEach((hub) => {
        edges.unshift({
            event: hub.category === "error" ? "error" : "line",
            state: hub.firstIndex <= activeIndex ? "complete" : "future",
            kind: "root-branch",
            path: curveBetween(root, hub),
        });
    });

    for (let i = 1; i < steps.length; i += 1) {
        const from = stepNodes.get(i - 1);
        const to = stepNodes.get(i);
        if (!from || !to) {
            continue;
        }
        edges.push({
            event: to.step.event,
            toIndex: i,
            kind: "thought-path",
            path: softStepPath(from, to),
        });
    }

    const maxDepth = Math.max(0, ...steps.map((step) => Math.min(step.depth || 0, 3)));
    return {
        nodes,
        edges,
        width: leafX + leafWidth + maxDepth * 34 + margin,
        height,
    };
}

function curveBetween(from, to) {
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const bend = Math.max(72, (endX - startX) * 0.48);
    return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function softStepPath(from, to) {
    const startX = from.x + from.width - 12;
    const startY = from.y + from.height;
    const endX = to.x + 18;
    const endY = to.y;
    const midY = startY + (endY - startY) / 2;
    return `M ${startX} ${startY} C ${startX + 42} ${midY}, ${endX - 42} ${midY}, ${endX} ${endY}`;
}

function categoryForStep(step) {
    const expression = step.expression.trim();
    if (step.error || step.event === "error") {
        return "error";
    }
    if (expression.startsWith("class ") || expression.startsWith("def ")) {
        return "definition";
    }
    if (step.event === "call" || step.event === "return") {
        return "call";
    }
    if (step.event === "input" || step.event === "input_request") {
        return "runtime";
    }
    if (step.event === "condition" || step.event === "loop" || step.event === "exception_flow") {
        return "decision";
    }
    if (step.event === "print") {
        return "output";
    }
    if (step.updated_var) {
        return "memory";
    }
    return "runtime";
}

function edgeState(index, activeIndex) {
    if (index === activeIndex) {
        return "active-flow";
    }
    if (index < activeIndex) {
        return "complete";
    }
    return "future";
}

function pipeClass(edge, activeIndex) {
    const classes = ["pipe", edgeType(edge.event)];
    if (edge.kind) {
        classes.push(edge.kind);
    }
    if (edge.state) {
        classes.push(edge.state);
    } else if (edge.toIndex <= activeIndex) {
        classes.push("complete");
    }
    if (edge.toIndex === activeIndex) {
        classes.push("active-flow");
    }
    return classes.join(" ");
}

function mindNodeClass(node, activeIndex) {
    const classes = [`mind-${node.type}`, node.category];
    if (node.type === "leaf") {
        const event = node.step ? node.step.event : eventForKind(node.kind);
        classes.push("mind-node", edgeType(event));
        if (node.stepIndex === activeIndex || lineIsActive(node, activeIndex)) {
            classes.push("active");
        } else if (node.stepIndex > activeIndex) {
            classes.push("future");
        } else {
            classes.push("complete");
        }
    } else if (node.type === "hub") {
        classes.push("mind-hub");
        if (node.firstIndex <= activeIndex && node.lastIndex >= activeIndex) {
            classes.push("active");
        } else if (node.firstIndex > activeIndex) {
            classes.push("future");
        } else {
            classes.push("complete");
        }
    }
    return classes.join(" ");
}

function lineIsActive(node, activeIndex) {
    if (activeIndex < 0 || !steps[activeIndex] || !node.line) {
        return false;
    }
    const line = steps[activeIndex].line;
    return line >= node.line && line <= (node.end_line || node.line);
}

function nodeLineMeta(node) {
    if (!node.line) {
        return "";
    }
    if (node.end_line && node.end_line !== node.line) {
        return `lines ${node.line}-${node.end_line}`;
    }
    return `line ${node.line}`;
}

function nodeClass(step, index, activeIndex) {
    const classes = ["flow-node", edgeType(step.event)];
    if (index === activeIndex) {
        classes.push("active");
    } else if (index > activeIndex) {
        classes.push("future");
    }
    return classes.join(" ");
}

function renderMemory(stepOrVars) {
    const vars = stepOrVars.variables || stepOrVars;
    const container = document.getElementById("variables");
    const entries = Object.entries(vars || {});
    container.innerHTML = "";
    container.classList.toggle("empty-state", entries.length === 0);
    setText("memoryCount", `${entries.length} ${entries.length === 1 ? "value" : "values"}`);

    if (entries.length === 0) {
        container.textContent = "No values are stored yet.";
        return;
    }

    entries.forEach(([key, value]) => {
        const box = document.createElement("div");
        box.className = key === stepOrVars.updated_var ? "var-box active" : "var-box";

        const label = document.createElement("div");
        label.className = "var-label";
        label.textContent = valueKind(value);

        const name = document.createElement("div");
        name.className = "var-name";
        name.textContent = key;

        const val = document.createElement("div");
        val.className = "var-value";
        val.textContent = formatValue(value);

        box.append(label, name, val);

        if (key === stepOrVars.updated_var) {
            const change = document.createElement("div");
            change.className = "var-change";
            change.textContent = "changed now";
            box.appendChild(change);
        }

        container.appendChild(box);
    });
}

function renderEncountered() {
    const seen = new Set();
    const items = [];
    steps.slice(0, currentStep + 1).forEach((step, stepIndex) => {
        Object.entries(step.variables || {}).forEach(([name, value]) => {
            if (seen.has(name)) {
                return;
            }
            seen.add(name);
            items.push({
                name,
                value,
                stepIndex,
                line: step.line,
                kind: valueKind(value),
            });
        });
    });

    setText("encounterCount", `${items.length} seen`);
    renderTimeline(
        "encounteredList",
        items,
        "New names appear here.",
        (item, index) => ({
            title: item.name,
            tag: item.kind,
            meta: `First seen: step ${item.stepIndex + 1}, line ${item.line}`,
            value: `value: ${formatShortValue(item.value)}`,
        })
    );
}

function renderChangeHistory() {
    const changes = [];
    const previous = new Map();
    steps.slice(0, currentStep + 1).forEach((step, stepIndex) => {
        Object.entries(step.variables || {}).forEach(([name, value]) => {
            const signature = valueSignature(value);
            if (previous.get(name) !== signature) {
                previous.set(name, signature);
                changes.push({
                    name,
                    value,
                    stepIndex,
                    line: step.line,
                    active: name === step.updated_var,
                });
            }
        });
    });

    setText("changeCount", `${changes.length} updates`);
    renderTimeline(
        "changeList",
        changes,
        "Updates appear here.",
        (item) => ({
            title: item.name,
            tag: item.active ? "now" : "update",
            meta: `Step ${item.stepIndex + 1}, line ${item.line}`,
            value: `now: ${formatShortValue(item.value)}`,
            active: item.active,
        })
    );
}

function renderTimeline(id, items, emptyText, formatter) {
    const container = document.getElementById(id);
    container.innerHTML = "";
    container.classList.toggle("empty-state", items.length === 0);
    container.classList.toggle("flow-list", id === "changeList" && items.length > 0);

    if (items.length === 0) {
        container.textContent = emptyText;
        return;
    }

    items.forEach((item, index) => {
        const data = formatter(item, index);
        const row = document.createElement("div");
        row.className = "timeline-item";
        row.classList.toggle("is-current", Boolean(data.active));

        const number = document.createElement("div");
        number.className = "timeline-index";
        number.textContent = String(index + 1);

        const content = document.createElement("div");
        const titleRow = document.createElement("div");
        titleRow.className = "timeline-title-row";

        const title = document.createElement("div");
        title.className = "timeline-title";
        title.textContent = data.title;
        titleRow.appendChild(title);

        if (data.tag) {
            const tag = document.createElement("div");
            tag.className = "timeline-tag";
            tag.textContent = data.tag;
            titleRow.appendChild(tag);
        }

        const meta = document.createElement("div");
        meta.className = "timeline-meta";
        meta.textContent = data.meta;

        content.append(titleRow, meta);
        if (data.value) {
            const value = document.createElement("div");
            value.className = "timeline-value";
            value.textContent = data.value;
            content.appendChild(value);
        }
        row.append(number, content);
        container.appendChild(row);
    });
}

function renderStepExplanation(step) {
    const info = explainStep(step);
    setStepMessage(info.title, info.body);
}

function explainStep(step) {
    const expression = step.expression.trim();

    if (step.error) {
        return {
            title: "This line caused an error",
            body: step.error_message,
        };
    }

    if (step.event === "call") {
        const name = step.expression.replace(/^call\s+/, "").replace(/\(\)$/, "");
        return {
            title: `Flow enters ${name}()`,
            body: `Python jumps from line ${step.from_line || "the caller"} into ${name} so that function can do its work.`,
        };
    }

    if (step.event === "input") {
        return {
            title: "Python reads input",
            body: `Python takes the next line from Program Input and stores it${step.updated_var ? ` in ${step.updated_var}` : ""}.`,
        };
    }

    if (step.event === "input_request") {
        return {
            title: "Python is waiting for input",
            body: inputRequestMessage(step),
        };
    }

    if (expression.startsWith("class ")) {
        const name = expression.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || "class";
        return {
            title: `Python creates ${name}`,
            body: `A class is a blueprint. Python stores the blueprint named ${name} in memory.`,
        };
    }

    if (expression.startsWith("def ")) {
        const name = expression.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] || "function";
        return {
            title: `Python remembers ${name}()`,
            body: `The function body is saved. It will run later when ${name}() is called.`,
        };
    }

    if (expression.startsWith("return ")) {
        return {
            title: "A value goes back",
            body: `This function returns ${formatValue(step.output)} to the line that called it.`,
        };
    }

    if (expression.startsWith("print")) {
        return {
            title: "Something appears on screen",
            body: `Python prints ${formatValue(step.output)} in the output area.`,
        };
    }

    if (expression.startsWith("if ") || expression.startsWith("elif ") || expression.startsWith("while ")) {
        const result = step.condition ? "true" : "false";
        return {
            title: `Python checks a question: ${result}`,
            body: `The condition is ${result}, so Python chooses the next line from that result.`,
        };
    }

    if (expression.startsWith("for ")) {
        return {
            title: "Python starts or continues a loop",
            body: "The loop takes the next value and runs the indented lines again.",
        };
    }

    if (expression.startsWith("try:")) {
        return {
            title: "Python enters a protected block",
            body: "If something fails inside this block, Python can jump to a matching except line.",
        };
    }

    if (expression.startsWith("except ")) {
        return {
            title: "Python found a matching error handler",
            body: "The previous error is handled here, so the program can keep going.",
        };
    }

    if (expression.startsWith("finally:")) {
        return {
            title: "Python runs the cleanup block",
            body: "A finally block runs whether the try block succeeds or fails.",
        };
    }

    if (step.updated_var) {
        return {
            title: `${step.updated_var} is updated`,
            body: `Python runs "${expression}" and stores the new value in memory.`,
        };
    }

    return {
        title: "Python runs this line",
        body: `The current instruction is "${expression}".`,
    };
}

function renderFlow(step) {
    if (step.condition !== undefined) {
        const result = step.condition ? "true" : "false";
        setText("flow", `Condition result: ${result}`);
    } else if (step.event === "input") {
        setText("flow", step.updated_var ? `Input stored in ${step.updated_var}` : "Input read");
    } else if (step.event === "input_request") {
        setText("flow", "Waiting for Program Input");
    } else if (step.updated_var) {
        setText("flow", `Memory change: ${step.updated_var}`);
    } else if (step.output !== undefined && step.expression.trim().startsWith("return ")) {
        setText("flow", `Returned value: ${formatValue(step.output)}`);
    } else {
        setText("flow", "");
    }
}

function renderOutput() {
    const printed = [];
    for (let i = 0; i <= currentStep; i += 1) {
        const expression = steps[i].expression.trim();
        if (steps[i].output !== undefined && (steps[i].event === "print" || expression.startsWith("print"))) {
            printed.push({
                value: formatValue(steps[i].output),
                kind: "output",
                stepIndex: i,
                line: steps[i].line,
            });
        }
    }

    const outputBox = document.getElementById("outputBox");
    outputBox.innerHTML = "";
    outputBox.classList.toggle("empty-state", printed.length === 0);
    setText("printCount", `${printed.length} ${printed.length === 1 ? "output" : "outputs"}`);

    if (printed.length === 0) {
        outputBox.textContent = "Nothing printed yet.";
        return;
    }

    printed.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "output-row";

        const number = document.createElement("div");
        number.className = "output-index";
        number.textContent = `#${index + 1}`;

        const value = document.createElement("div");
        value.className = "output-value";
        value.textContent = `${item.value}  (${item.kind}, step ${item.stepIndex + 1}, line ${item.line})`;

        row.append(number, value);
        outputBox.appendChild(row);
    });
}

function nextStep() {
    if (currentStep < steps.length - 1) {
        currentStep += 1;
        showStep();
    }
}

function prevStep() {
    if (currentStep > 0) {
        currentStep -= 1;
        showStep();
    }
}

function play() {
    if (steps.length === 0) {
        return;
    }

    pause();
    isPlaying = true;
    interval = window.setInterval(() => {
        if (currentStep < steps.length - 1) {
            currentStep += 1;
            showStep();
        } else {
            pause();
        }
    }, speed);
}

function pause() {
    window.clearInterval(interval);
    interval = null;
    isPlaying = false;
}

function updateSpeed() {
    speed = Number(document.getElementById("speed").value);
    if (isPlaying) {
        play();
    }
}

function showCodeSection(mode) {
    const editor = document.getElementById("code");
    if (codeViewMode === "original") {
        originalCode = editor.value;
    }

    codeViewMode = mode;
    editor.value = mode === "original" ? originalCode : extractCodeSection(originalCode, mode);
    resetAfterCodeViewChange();
    updateCodeViewButtons();

    const labels = {
        original: "Original code restored",
        loops: "Loop code shown",
        objects: "Object code shown",
        errors: "Error-handling code shown",
    };
    setStepMessage(labels[mode] || "Code section shown", "Run this section to visualize it.");
}

function extractCodeSection(source, mode) {
    const lines = source.split("\n");
    const ranges = [];
    const used = new Set();
    const classNames = new Set();

    lines.forEach((line) => {
        const match = line.trim().match(/^class\s+([A-Za-z_]\w*)\b/);
        if (match) {
            classNames.add(match[1]);
        }
    });

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return;
        }

        if (mode === "loops" && /^(for|while)\b/.test(trimmed)) {
            ranges.push(codeBlockRange(lines, index));
        }

        if (mode === "objects") {
            if (/^class\b/.test(trimmed)) {
                ranges.push(codeBlockRange(lines, index));
            } else if (isObjectUseLine(trimmed, classNames)) {
                ranges.push([index, index]);
            }
        }

        if (mode === "errors") {
            if (/^try\s*:/.test(trimmed)) {
                ranges.push(errorBlockRange(lines, index));
            } else if (/^(except\b|finally\s*:|raise\b)/.test(trimmed)) {
                ranges.push(codeBlockRange(lines, index));
            }
        }
    });

    const result = [];
    ranges
        .sort((a, b) => a[0] - b[0])
        .forEach(([start, end]) => {
            const chunk = [];
            for (let i = start; i <= end; i += 1) {
                if (!used.has(i)) {
                    used.add(i);
                    chunk.push(lines[i]);
                }
            }
            if (chunk.length > 0) {
                if (result.length > 0) {
                    result.push("");
                }
                result.push(...dedentLines(chunk));
            }
        });

    if (result.length === 0) {
        const label = mode === "loops" ? "loops" : mode === "objects" ? "object code" : "error-handling code";
        return `# No ${label} found in the original code.\n# Click Original Code to return to your pasted code.`;
    }

    return result.join("\n");
}

function codeBlockRange(lines, start) {
    const startIndent = indentSize(lines[start]);
    let end = start;

    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) {
            end = i;
            continue;
        }
        if (indentSize(line) <= startIndent) {
            break;
        }
        end = i;
    }

    return [start, end];
}

function errorBlockRange(lines, start) {
    const startIndent = indentSize(lines[start]);
    let end = start;

    for (let i = start + 1; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) {
            end = i;
            continue;
        }

        const indent = indentSize(line);
        const isTryPart = indent === startIndent && /^(except\b|else\s*:|finally\s*:)/.test(trimmed);
        if (indent <= startIndent && !isTryPart) {
            break;
        }
        end = i;
    }

    return [start, end];
}

function isObjectUseLine(trimmed, classNames) {
    for (const className of classNames) {
        if (new RegExp(`\\b${className}\\s*\\(`).test(trimmed)) {
            return true;
        }
    }
    return /\bself\./.test(trimmed) || /\b\w+\.\w+\s*\(/.test(trimmed);
}

function indentSize(line) {
    const match = line.match(/^[\t ]*/);
    return match ? match[0].replace(/\t/g, "    ").length : 0;
}

function dedentLines(lines) {
    const indents = lines
        .filter((line) => line.trim())
        .map(indentSize);
    const minIndent = Math.min(...indents, 0);
    if (minIndent <= 0) {
        return lines;
    }
    return lines.map((line) => {
        let remaining = minIndent;
        let index = 0;
        while (index < line.length && remaining > 0) {
            if (line[index] === " ") {
                remaining -= 1;
                index += 1;
            } else if (line[index] === "\t") {
                remaining -= 4;
                index += 1;
            } else {
                break;
            }
        }
        return line.slice(index);
    });
}

function resetAfterCodeViewChange() {
    const editor = document.getElementById("code");
    steps = [];
    mindMap = null;
    currentStep = 0;
    codeLines = editor.value.split("\n");
    activeCodeLine = null;
    updateLineNumbers();
    pause();
    clearError();
    clearInputRequest();
    renderFlowMap();
    renderMemory({});
    resetInspectorLists();
    aiExplanationCache.clear();
    aiErrorHelpCache.clear();
    showAIExplanationMessage("Run code, then click AI Explain.");
    setText("flow", "");
    setText("stepCounter", "Not run yet");
    setProgress(0);
    syncProgramInputHint();
}

function readProgramInputs() {
    const inputBox = document.getElementById("programInput");
    if (!inputBox || inputBox.value === "") {
        return [];
    }
    return inputBox.value.replace(/\r\n/g, "\n").split("\n");
}

function showInputRequest(data) {
    pendingInputRequest = {
        prompt: data.input_prompt || "",
        line: data.input_line || null,
        inputIndex: data.input_index || 0,
    };
    clearError();
    activeCodeLine = pendingInputRequest.line;
    updateLineNumbers(activeCodeLine);
    renderFlowMap(currentStep);
    renderProgramInputPrompt();
    openProgramInputBox();
}

function clearInputRequest() {
    pendingInputRequest = null;
    renderProgramInputPrompt();
}

function renderProgramInputPrompt() {
    const promptBox = document.getElementById("programInputPrompt");
    const continueButton = document.getElementById("programInputContinue");
    const hint = document.getElementById("programInputHint");
    if (!promptBox || !continueButton || !hint) {
        return;
    }

    if (!pendingInputRequest) {
        promptBox.hidden = true;
        continueButton.hidden = true;
        return;
    }

    const prompt = pendingInputRequest.prompt || "input() is waiting for a value.";
    const line = pendingInputRequest.line ? `line ${pendingInputRequest.line}: ` : "";
    promptBox.textContent = `${line}${prompt}`;
    promptBox.hidden = false;
    continueButton.hidden = false;
    hint.textContent = "Type the answer below, then press Continue.";
}

function continueWithInput() {
    const inputBox = document.getElementById("programInput");
    if (!inputBox || !inputBox.value.trim()) {
        const hint = document.getElementById("programInputHint");
        if (hint) {
            hint.textContent = "Type an answer first, then press Continue.";
        }
        openProgramInputBox();
        return;
    }

    clearInputRequest();
    runCode();
}

function inputRequestMessage(data) {
    const prompt = data.input_prompt || data.prompt || "input()";
    return `${prompt} is waiting for your answer in Program Input.`;
}

function syncProgramInputHint() {
    const editor = document.getElementById("code");
    const hint = document.getElementById("programInputHint");
    const inputBox = document.getElementById("programInputBox");
    if (!editor || !hint || !inputBox) {
        return;
    }

    if (pendingInputRequest) {
        renderProgramInputPrompt();
        return;
    }

    const count = countInputCalls(editor.value);
    if (count > 0) {
        hint.textContent = `${count} input() ${count === 1 ? "call" : "calls"} found. Add one answer per line.`;
        inputBox.open = true;
    } else {
        hint.textContent = "One line is used for each input() call.";
    }
}

function countInputCalls(code) {
    const matches = code.match(/\binput\s*\(/g);
    return matches ? matches.length : 0;
}

function openProgramInputBox() {
    const inputBox = document.getElementById("programInputBox");
    const input = document.getElementById("programInput");
    if (inputBox) {
        inputBox.open = true;
    }
    if (input) {
        input.focus();
    }
}

function updateCodeViewButtons() {
    document.querySelectorAll("[data-code-view]").forEach((button) => {
        button.classList.toggle("active", button.dataset.codeView === codeViewMode);
    });
}

function saveCodeHistory(code) {
    const normalized = normalizedCode(code);
    if (!normalized) {
        return;
    }

    const history = readCodeHistory();
    if (history[0] && normalizedCode(history[0].code) === normalized) {
        return;
    }

    const nextHistory = history.filter((item) => normalizedCode(item.code) !== normalized);
    nextHistory.unshift({
        code,
        savedAt: Date.now(),
    });
    writeCodeHistory(nextHistory.slice(0, CODE_HISTORY_LIMIT));
    renderCodeHistory();
}

function readCodeHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(CODE_HISTORY_KEY) || "[]");
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .filter((item) => item && typeof item.code === "string" && Number.isFinite(item.savedAt))
            .slice(0, CODE_HISTORY_LIMIT);
    } catch (error) {
        return [];
    }
}

function writeCodeHistory(history) {
    try {
        localStorage.setItem(CODE_HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
        // History is optional; the app should keep running if storage is unavailable.
    }
}

function renderCodeHistory() {
    const history = readCodeHistory();
    const list = document.getElementById("historyList");
    if (!list) {
        return;
    }

    list.innerHTML = "";
    list.classList.toggle("empty-state", history.length === 0);
    setText("historyCount", `${history.length} ${history.length === 1 ? "saved" : "saved"}`);

    if (history.length === 0) {
        list.textContent = "Executed code appears here.";
        return;
    }

    history.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "history-item";

        const content = document.createElement("div");
        content.className = "history-content";

        const title = document.createElement("div");
        title.className = "history-title";
        title.textContent = codeHistoryTitle(item.code);

        const meta = document.createElement("div");
        meta.className = "history-meta";
        meta.textContent = `${relativeTime(item.savedAt)} · ${item.code.split("\n").length} lines`;

        const preview = document.createElement("div");
        preview.className = "history-preview";
        preview.textContent = codeHistoryPreview(item.code);

        content.append(title, meta, preview);

        const actions = document.createElement("div");
        actions.className = "history-actions";

        const loadButton = document.createElement("button");
        loadButton.type = "button";
        loadButton.textContent = "Load";
        loadButton.onclick = () => loadCodeHistory(index);

        const runButton = document.createElement("button");
        runButton.type = "button";
        runButton.textContent = "Run";
        runButton.onclick = () => runCodeHistory(index);

        actions.append(loadButton, runButton);
        row.append(content, actions);
        list.appendChild(row);
    });
}

function loadCodeHistory(index) {
    const item = readCodeHistory()[index];
    if (!item) {
        return;
    }

    const editor = document.getElementById("code");
    editor.value = item.code;
    codeViewMode = "original";
    originalCode = item.code;
    updateCodeViewButtons();
    resetAfterCodeViewChange();
    setStepMessage("History loaded", "Run this saved code when you are ready.");
}

function runCodeHistory(index) {
    loadCodeHistory(index);
    runCode();
}

function normalizedCode(code) {
    return code.replace(/\r\n/g, "\n").trim();
}

function codeHistoryTitle(code) {
    const firstLine = code.split("\n").map((line) => line.trim()).find(Boolean) || "Saved code";
    return firstLine.length > 42 ? `${firstLine.slice(0, 39)}...` : firstLine;
}

function codeHistoryPreview(code) {
    const preview = code
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join("  ");
    return preview.length > 82 ? `${preview.slice(0, 79)}...` : preview;
}

function relativeTime(savedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
    if (seconds < 45) {
        return "just now";
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} ${minutes === 1 ? "min" : "min"} ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} ${hours === 1 ? "hr" : "hr"} ago`;
    }

    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function showError(type, message, line) {
    const box = document.getElementById("errorBox");
    const suffix = line ? ` (line ${line})` : "";
    currentError = {
        error_type: type || "Error",
        error_message: message || "Python stopped before finishing the program.",
        line: line || null,
    };
    latestAIFixedCode = "";
    box.hidden = false;
    box.open = false;
    setText("errorHeadline", `${currentError.error_type}${suffix}: ${currentError.error_message}`);
    setText("errorSimple", beginnerErrorSummary(currentError));
    showAIErrorHelpMessage("Open this box, then choose Explain Simply or Fix Code.");
    document.getElementById("fixedCodeBox").hidden = true;
    document.getElementById("fixedCodePreview").textContent = "";
    setErrorHelpButtonsDisabled(false);
    if (line) {
        activeCodeLine = line;
        updateLineNumbers(activeCodeLine);
        renderFlowMap(currentStep);
    }
}

function clearError() {
    const box = document.getElementById("errorBox");
    box.hidden = true;
    box.open = false;
    currentError = null;
    latestAIFixedCode = "";
    setErrorHelpButtonsDisabled(false);
    document.getElementById("fixedCodeBox").hidden = true;
}

async function explainErrorWithAI() {
    await requestAIErrorHelp(false);
}

async function fixErrorWithAI() {
    await requestAIErrorHelp(true);
}

async function requestAIErrorHelp(showFixedCode) {
    if (!currentError) {
        return;
    }

    const code = document.getElementById("code").value;
    const cacheKey = `${valueSignature(code)}:${valueSignature(currentError)}`;
    if (aiErrorHelpCache.has(cacheKey)) {
        renderAIErrorHelp(aiErrorHelpCache.get(cacheKey), showFixedCode);
        return;
    }

    setErrorHelpButtonsDisabled(true);
    showAIErrorHelpMessage(showFixedCode ? "AI is fixing the code..." : "AI is explaining the error...");

    try {
        const response = await fetch(`${API_BASE_URL}/ai-error-help`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                code,
                error: currentError,
            }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error_message || "AI error help failed.");
        }
        aiErrorHelpCache.set(cacheKey, data);
        renderAIErrorHelp(data, showFixedCode);
    } catch (error) {
        showAIErrorHelpMessage(error.message || "AI error help failed.");
    } finally {
        setErrorHelpButtonsDisabled(false);
    }
}

function renderAIErrorHelp(data, showFixedCode) {
    const box = document.getElementById("aiErrorHelpBox");
    box.innerHTML = "";
    box.classList.remove("empty-state");

    box.append(
        errorHelpSection("What it means", data.simple_explanation),
        errorHelpSection("Why it happened", data.why_it_happened),
        errorHelpSection("How to fix it", data.fix_suggestion)
    );

    latestAIFixedCode = data.fixed_code || "";
    const fixedBox = document.getElementById("fixedCodeBox");
    fixedBox.hidden = !showFixedCode || !latestAIFixedCode;
    document.getElementById("fixedCodePreview").textContent = latestAIFixedCode;
}

function errorHelpSection(title, text) {
    const section = document.createElement("div");
    section.className = "error-help-section";

    const heading = document.createElement("div");
    heading.className = "error-help-title";
    heading.textContent = title;

    const body = document.createElement("div");
    body.className = "error-help-text";
    body.textContent = text || "No extra detail was returned.";

    section.append(heading, body);
    return section;
}

function showAIErrorHelpMessage(message) {
    const box = document.getElementById("aiErrorHelpBox");
    box.innerHTML = "";
    box.classList.add("empty-state");
    box.textContent = message;
}

function setErrorHelpButtonsDisabled(disabled) {
    document.getElementById("aiErrorExplainButton").disabled = disabled;
    document.getElementById("aiFixButton").disabled = disabled;
}

function applyAIFix() {
    if (!latestAIFixedCode) {
        return;
    }

    const editor = document.getElementById("code");
    editor.value = latestAIFixedCode;
    if (codeViewMode === "original") {
        originalCode = latestAIFixedCode;
    }
    resetAfterCodeViewChange();
    setStepMessage("AI fix applied", "Run the code again to check it.");
}

function resetInspectorLists() {
    setText("outputBox", "Nothing printed yet.");
    document.getElementById("outputBox").classList.add("empty-state");
    setText("encounteredList", "New names appear here.");
    document.getElementById("encounteredList").classList.add("empty-state");
    setText("changeList", "Updates appear here.");
    document.getElementById("changeList").classList.add("empty-state");
    document.getElementById("changeList").classList.remove("flow-list");
    setText("encounterCount", "0 seen");
    setText("changeCount", "0 updates");
    setText("printCount", "0 outputs");
    showAIExplanationMessage("Run code, then click AI Explain.");
}

function setStepMessage(title, body) {
    setText("stepTitle", title);
    setText("stepExplain", body);
}

function setProgress(percent) {
    document.getElementById("progressFill").style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function setText(id, value) {
    document.getElementById(id).textContent = value;
}

function updateLineNumbers(activeLine = activeCodeLine) {
    const editor = document.getElementById("code");
    const gutter = document.getElementById("lineNumbers");
    if (!editor || !gutter) {
        return;
    }

    const count = Math.max(1, editor.value.split("\n").length);
    gutter.innerHTML = "";
    for (let line = 1; line <= count; line += 1) {
        const row = document.createElement("div");
        row.className = line === activeLine ? "line-number active" : "line-number";
        row.textContent = String(line);
        gutter.appendChild(row);
    }
    gutter.scrollTop = editor.scrollTop;
}

function syncLineNumberScroll() {
    const editor = document.getElementById("code");
    const gutter = document.getElementById("lineNumbers");
    if (editor && gutter) {
        gutter.scrollTop = editor.scrollTop;
    }
}

function explainError(data) {
    if (data.error_type === "EOFError") {
        return "Python reached input(), but Program Input did not have another line to read.";
    }
    if (data.error_type === "ZeroDivisionError") {
        return "Python stopped because division by zero is not allowed.";
    }
    if (data.error_type === "SyntaxError") {
        return "Python could not understand the code structure yet.";
    }
    return data.error_message || "Python stopped before finishing the program.";
}

function beginnerErrorSummary(error) {
    if (error.error_type === "ZeroDivisionError") {
        return "Python tried to split a number into zero parts. That is not possible, so it stopped.";
    }
    if (error.error_type === "SyntaxError") {
        return "Python could not read the code yet. It is like a sentence with a missing word or mark.";
    }
    if (error.error_type === "NameError") {
        return "Python saw a name it does not know yet. The name may be misspelled or not created before this line.";
    }
    if (error.error_type === "TypeError") {
        return "Python got the wrong kind of value for this action, like trying to use a word where a number is needed.";
    }
    if (error.error_type === "IndexError") {
        return "Python looked for a list position that is not there.";
    }
    if (error.error_type === "KeyError") {
        return "Python looked for a dictionary key that is not there.";
    }
    if (error.error_type === "AttributeError") {
        return "Python looked for a property or method that this value does not have.";
    }
    if (error.error_type === "ConnectionError") {
        return "The page could not talk to the Python backend, so it cannot run the code yet.";
    }
    if (error.error_type === "EmptyInput") {
        return "There is no code to run yet.";
    }
    if (error.error_type === "EOFError") {
        return "The program asked for input, but the input box ran out of lines. Add one value per input() call and run again.";
    }
    return error.error_message || "Python found a problem and stopped before it could finish.";
}

function edgeType(event) {
    if (event === "call") {
        return "call";
    }
    if (event === "return") {
        return "return";
    }
    if (event === "condition" || event === "loop") {
        return "condition";
    }
    if (event === "error") {
        return "error";
    }
    return "normal";
}

function eventLabel(step) {
    const labels = {
        assign: "set value",
        call: "call",
        return: "return",
        print: "print",
        input: "input",
        input_request: "input",
        condition: "check",
        loop: "loop",
        exception_flow: "try flow",
        error: "error",
        line: "run line",
    };
    return labels[step.event] || "run line";
}

function nodeTitle(step) {
    if (step.event === "call") {
        return step.expression.replace(/^call\s+/, "enter ");
    }
    if (step.event === "input") {
        return step.updated_var ? `${step.updated_var} receives input` : "read input";
    }
    if (step.event === "input_request") {
        return "waiting for input";
    }
    if (step.updated_var) {
        return `${step.updated_var} changes`;
    }
    if (step.event === "return") {
        return "send value back";
    }
    if (step.event === "print") {
        return "show output";
    }
    if (step.event === "condition") {
        return step.condition ? "question is true" : "question is false";
    }
    if (step.event === "error") {
        return step.error_type || "error";
    }
    return step.expression;
}

function nodeMeta(step) {
    if (step.event === "call" && step.from_line) {
        return `line ${step.from_line} -> line ${step.line}`;
    }
    if (step.event === "return" && step.output !== undefined) {
        return `value: ${formatValue(step.output)}`;
    }
    if (step.event === "print" && step.output !== undefined) {
        return `prints: ${formatValue(step.output)}`;
    }
    if (step.event === "input") {
        return step.updated_var ? `input stored in ${step.updated_var}` : "input read";
    }
    if (step.event === "input_request") {
        return step.input_prompt ? `prompt: ${step.input_prompt}` : "input needed";
    }
    if (step.condition !== undefined) {
        return `line ${step.line}: ${step.condition ? "true" : "false"}`;
    }
    return `line ${step.line}: ${step.expression}`;
}

function valueKind(value) {
    if (value && typeof value === "object" && (value.type || value.__type)) {
        return "object";
    }
    if (Array.isArray(value)) {
        return "list";
    }
    if (typeof value === "number") {
        return "number";
    }
    if (typeof value === "boolean") {
        return "boolean";
    }
    if (typeof value === "string" && value.startsWith("class ")) {
        return "class";
    }
    if (typeof value === "string" && value.startsWith("function ")) {
        return "function";
    }
    if (typeof value === "string") {
        return "text";
    }
    if (value === null) {
        return "empty";
    }
    return "value";
}

function formatValue(value) {
    if (value && typeof value === "object" && (value.type || value.__type)) {
        const attrs = Object.entries(value.attributes || {})
            .map(([key, item]) => `${key}: ${formatValue(item)}`)
            .join(", ");
        return `${value.type || value.__type} { ${attrs} }`;
    }
    if (Array.isArray(value)) {
        return `[${value.map(formatValue).join(", ")}]`;
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .map(([key, item]) => `${key}: ${formatValue(item)}`)
            .join(", ");
        return `{ ${entries} }`;
    }
    if (typeof value === "string") {
        return value;
    }
    return String(value);
}

function formatShortValue(value) {
    const text = formatValue(value);
    return text.length > 46 ? `${text.slice(0, 43)}...` : text;
}

function valueSignature(value) {
    if (Array.isArray(value)) {
        return `[${value.map(valueSignature).join(",")}]`;
    }
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${key}:${valueSignature(value[key])}`).join(",")}}`;
    }
    return String(value);
}

codeLines = document.getElementById("code").value.split("\n");
originalCode = document.getElementById("code").value;
document.getElementById("code").addEventListener("input", () => {
    activeCodeLine = null;
    const editor = document.getElementById("code");
    codeLines = editor.value.split("\n");
    if (codeViewMode === "original") {
        originalCode = editor.value;
    }
    if (currentError) {
        clearError();
    }
    if (pendingInputRequest) {
        clearInputRequest();
    }
    aiErrorHelpCache.clear();
    updateLineNumbers();
    syncProgramInputHint();
});
document.getElementById("code").addEventListener("scroll", syncLineNumberScroll);
updateLineNumbers();
updateCodeViewButtons();
syncProgramInputHint();
renderFlowMap();
renderMemory({});
resetInspectorLists();
renderCodeHistory();
window.setInterval(renderCodeHistory, 60000);
