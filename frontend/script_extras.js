/* ═══════════════════════════════════════════════════════════════════════
   script_extras.js  — load AFTER script.js
   Adds: sidebar toggle · dark/light theme · Tab key fix · resizable panels
         language selector · keep-alive ping (Render cold-start fix)
═══════════════════════════════════════════════════════════════════════ */

/* ── Theme (dark / light) ──────────────────────────────────────────── */
(function initTheme() {
    const saved = localStorage.getItem("cv.theme") || "light";
    document.documentElement.dataset.theme = saved;
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = saved === "dark" ? "☀️" : "🌙";
})();

function toggleTheme() {
    const html = document.documentElement;
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    html.dataset.theme = next;
    localStorage.setItem("cv.theme", next);
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = next === "dark" ? "☀️" : "🌙";
}

/* ── Sidebar ────────────────────────────────────────────────────────── */
var _sidebarOpen = false;

function toggleSidebar() {
    _sidebarOpen = !_sidebarOpen;
    const sb = document.getElementById("sidebar");
    const ov = document.getElementById("sidebarOverlay");
    if (sb) sb.classList.toggle("open", _sidebarOpen);
    if (ov) ov.classList.toggle("active", _sidebarOpen);
    // Refresh history list whenever sidebar opens
    if (_sidebarOpen && typeof renderCodeHistory === "function") {
        renderCodeHistory();
    }
}

/* ── Global text size (A- / A+) ──────────────────────────────────────
   Only FONT sizes change. Every font-size in style.css / style_additions.css is
   written as calc(Npx * var(--ui-scale)), so panes, columns, heights and the
   mind-map layout keep exactly the same pixel size. No CSS zoom is used.        */
var UI_SCALE_MIN = 0.8, UI_SCALE_MAX = 1.5, UI_SCALE_STEP = 0.1;
var UI_SCALE_KEY = "cv.uiScale";

function setUiScale(next) {
    let scale = Math.round((Number(next) || 1) * 10) / 10;
    scale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale));
    const root = document.documentElement;
    root.style.setProperty("--ui-scale", String(scale));
    // Mind-map cards have a fixed pixel size, so their text grows at half speed.
    root.style.setProperty("--node-scale", String(1 + (scale - 1) * 0.5));
    try { localStorage.setItem(UI_SCALE_KEY, String(scale)); } catch (e) {}
    const up = document.getElementById("historyTextSizeUp");
    const down = document.getElementById("historyTextSizeDown");
    if (up)   up.disabled   = scale >= UI_SCALE_MAX;
    if (down) down.disabled = scale <= UI_SCALE_MIN;
    return scale;
}
function currentUiScale() {
    return Number(document.documentElement.style.getPropertyValue("--ui-scale")) || 1;
}

(function initUiScale() {
    // Clean up old experiments (zoom + separate history size)
    try {
        localStorage.removeItem("cv.globalTextScale");
        localStorage.removeItem("cv.historyTextSize");
    } catch (e) {}
    document.body.style.zoom = "";
    document.documentElement.style.removeProperty("--history-font-size");

    let saved = 1;
    try { saved = Number(localStorage.getItem(UI_SCALE_KEY)) || 1; } catch (e) {}
    setUiScale(saved);

    const up = document.getElementById("historyTextSizeUp");
    const down = document.getElementById("historyTextSizeDown");
    if (up)   up.addEventListener("click",   () => setUiScale(currentUiScale() + UI_SCALE_STEP));
    if (down) down.addEventListener("click", () => setUiScale(currentUiScale() - UI_SCALE_STEP));
})();

/* ── Tab key → 4 spaces in the code textarea ───────────────────────── */
(function installTabFix() {
    const editor = document.getElementById("code");
    if (!editor) return;
    editor.addEventListener("keydown", function (e) {
        if (e.key !== "Tab") return;
        e.preventDefault();
        const start = this.selectionStart;
        const end = this.selectionEnd;
        const spaces = "    "; // 4 spaces
        this.value = this.value.slice(0, start) + spaces + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + 4;
        // Trigger input listeners so line numbers stay in sync
        this.dispatchEvent(new Event("input"));
    });
})();

/* ── Resizable panels ──────────────────────────────────────────────── */
(function initResizeHandles() {
    const editor    = document.getElementById("editorPane");
    const inspector = document.getElementById("inspectorPane");
    const handle1   = document.getElementById("handle1");
    const handle2   = document.getElementById("handle2");

    if (!editor || !inspector || !handle1 || !handle2) return;

    function makeDraggable(handle, onDrag) {
        document.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            const bounds = handle.getBoundingClientRect();
            const nearHandle =
                e.clientX >= bounds.left - 6 &&
                e.clientX <= bounds.right + 6 &&
                e.clientY >= bounds.top &&
                e.clientY <= bounds.bottom;
            if (!nearHandle) return;

            e.preventDefault();
            let lastX = e.clientX;
            handle.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";

            function onMove(e) {
                const dx = e.clientX - lastX;
                lastX = e.clientX;
                onDrag(dx);
            }
            function onUp() {
                handle.classList.remove("dragging");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            }
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        }, true);
    }

    function layoutWidth(element) {
        const basis = parseFloat(getComputedStyle(element).flexBasis);
        return Number.isFinite(basis) ? basis : element.offsetWidth;
    }

    function layoutDelta(dx) {
        return dx;
    }

    // Handle 1 — resize editor pane
    makeDraggable(handle1, function (dx) {
        const current = layoutWidth(editor);
        const next = Math.max(240, Math.min(680, current + layoutDelta(dx)));
        editor.style.flex = `0 0 ${next}px`;
    });

    // Handle 2 — resize inspector pane (drag left = wider inspector)
    makeDraggable(handle2, function (dx) {
        const current = layoutWidth(inspector);
        const next = Math.max(210, Math.min(580, current - layoutDelta(dx)));
        inspector.style.flex = `0 0 ${next}px`;
    });
})();

/* ── Language selector ──────────────────────────────────────────────── */
var _currentLanguage = "python";

function changeLanguage(lang) {
    _currentLanguage = lang;
    const badge = document.getElementById("langBadge");
    const banner = document.getElementById("langInfoBanner");

    const labels = {
        python: "Only For Python",
        java:   "Java — output only (no step-by-step trace)",
        cpp:    "C / C++ — output only (no step-by-step trace)",
    };
    if (badge) badge.textContent = labels[lang] || lang;

    if (banner) {
        if (lang !== "python") {
            banner.textContent =
                `⚠️ Step-by-step tracing is only available for Python. ` +
                `For ${lang === "java" ? "Java" : "C/C++"}, click Run Code to see the program output.`;
            banner.classList.add("visible");
        } else {
            banner.classList.remove("visible");
        }
    }

    // Reset the visualizer state
    if (typeof resetAfterCodeViewChange === "function") {
        resetAfterCodeViewChange();
    }

    // Update editor placeholder-like hint
    if (typeof setStepMessage === "function") {
        if (lang !== "python") {
            setStepMessage(
                "Language: " + (lang === "java" ? "Java" : "C / C++"),
                "Click Run Code to compile and see the output. Step tracing is Python-only."
            );
        }
    }
}

/* Override runCode to handle Java / C++ ────────────────────────────── */
(function installLanguageAwareRunCode() {
    const originalRunCode = typeof window.runCode === "function" ? window.runCode : null;

    window.runCode = async function runCode() {
        if (_currentLanguage === "python") {
            // Fall through to the existing script.js runCode
            if (originalRunCode) {
                return originalRunCode.apply(this, arguments);
            }
            // script.js is missing / wrong file -> say so instead of failing silently
            console.error("[Code Visualizer] script.js did not load: runCode() is missing.");
            const msg = document.createElement("div");
            msg.className = "warmup-notice";
            msg.textContent = "⚠️ script.js did not load correctly. Re-deploy the real script.js, then hard refresh.";
            document.body.appendChild(msg);
            setTimeout(() => msg.remove(), 8000);
            return;
        }

        // ── Java / C++ — send to /run-language ─────────────────────────
        const code = document.getElementById("code").value.trim();
        if (!code) {
            if (typeof showError === "function") {
                showError("EmptyInput", "Please write some code before running.", null);
            }
            return;
        }

        if (typeof clearError === "function") clearError();
        if (typeof setStepMessage === "function") {
            setStepMessage("Compiling…", `Sending ${_currentLanguage === "java" ? "Java" : "C/C++"} code to the server.`);
        }

        const base =
            ["localhost", "127.0.0.1"].includes(window.location.hostname)
                ? "http://127.0.0.1:8000"
                : "https://code-visualizer-otf6.onrender.com";

        try {
            const response = await fetch(`${base}/run-language`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code, language: _currentLanguage }),
            });
            const data = await response.json();

            const outputBox = document.getElementById("outputBox");
            if (data.error) {
                if (typeof showError === "function") {
                    showError(data.error_type || "Error", data.error_message || "Compilation failed.", null);
                }
                if (outputBox) {
                    outputBox.textContent = data.error_message || "Compilation error.";
                    outputBox.classList.add("empty-state");
                }
                return;
            }

            if (outputBox) {
                outputBox.classList.remove("empty-state");
                outputBox.innerHTML = "";
                const pre = document.createElement("pre");
                pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;";
                pre.textContent = data.output || "(no output)";
                outputBox.appendChild(pre);
                if (data.stderr) {
                    const err = document.createElement("pre");
                    err.style.cssText = "margin:8px 0 0;white-space:pre-wrap;color:#f85149;";
                    err.textContent = data.stderr;
                    outputBox.appendChild(err);
                }
            }

            if (typeof setStepMessage === "function") {
                setStepMessage(
                    "Done",
                    `Program finished. Check Program Output on the right.`
                );
            }
            if (typeof setText === "function") {
                setText("printCount", "1 output");
            }
        } catch (err) {
            if (typeof showError === "function") {
                showError("ConnectionError", "Could not reach the backend. Is the server running?", null);
            }
        }
    };
})();

/* ── Keep-alive ping (prevents Render.com free-tier cold start) ─────── */
(function startKeepAlive() {
    const base =
        ["localhost", "127.0.0.1"].includes(window.location.hostname)
            ? "http://127.0.0.1:8000"
            : "https://code-visualizer-otf6.onrender.com";

    // Then every 13 minutes to keep it warm
    setInterval(() => fetch(base + "/").catch(() => {}), 13 * 60 * 1000);

    // Show a transient notice if the first ping takes > 4 s
    let warmed = false;
    const warmTimer = setTimeout(() => {
        if (!warmed) {
            const div = document.createElement("div");
            div.className = "warmup-notice";
            div.textContent = "⏳ Server warming up — first run may take ~20 s";
            document.body.appendChild(div);
            setTimeout(() => div.remove(), 12000);
        }
    }, 4000);

    fetch(base + "/")
        .then(() => { warmed = true; clearTimeout(warmTimer); })
        .catch(() => { warmed = true; clearTimeout(warmTimer); });
})();

/* ── Inject language info banner into editor pane ──────────────────── */
(function injectLangBanner() {
    const editor = document.getElementById("editorPane");
    if (!editor) return;
    const banner = document.createElement("div");
    banner.id = "langInfoBanner";
    banner.className = "lang-info-banner";
    // Insert right after the code editor frame
    const frame = editor.querySelector(".editor-frame");
    if (frame && frame.nextSibling) {
        editor.insertBefore(banner, frame.nextSibling);
    } else if (frame) {
        editor.appendChild(banner);
    }
})();