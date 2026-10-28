// dsh-gpu-cleanup — browser (web GUI) half.
//
// One click, one job: free the VRAM held by local llama.cpp engines while
// leaving llama-swap itself running. Everything happens on the host
// (lib/index.js, control server on 127.0.0.1:11436) because llama-swap on
// :11435 sends no CORS headers and a browser fetch to it would be blocked.
//
// Surfaces:
//   * conversation header button ("释放显存") — click runs immediately, no
//     confirmation step; progress + result show in a small floating panel.
//   * plugin settings card (设置 → 插件配置, and the plugin's own detail page) —
//     the same single button with the full step log inline.
window.__ModuleLoader__.load({
	id: "@princepainter/dsh-gpu-cleanup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let jsxRuntime = require("react/jsx-runtime");
		let react = require("react");

		const HOST = "http://127.0.0.1:11436";
		const OWN_BUNDLE = "@princepainter/dsh-gpu-cleanup";

		// ---- styles -----------------------------------------------------------
		const css = [
			".pqGPU_btn{border:1px solid var(--dsw-alias-border-l2);min-width:104px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:transparent;border-radius:18px;justify-content:center;align-items:center;gap:6px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex}",
			".pqGPU_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".pqGPU_btn:disabled{color:var(--dsw-alias-label-dimmed);cursor:progress}",
			".pqGPU_btn.pqGPU_busy{border-color:var(--dsw-alias-border-l2)}",
			".pqGPU_dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.55;flex:none}",
			".pqGPU_dot.pqGPU_ok{background:#16a34a;opacity:1}",
			".pqGPU_dot.pqGPU_err{background:#dc2626;opacity:1}",
			".pqGPU_card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base)}",
			".pqGPU_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".pqGPU_primary{border:1px solid transparent;height:36px;padding:0 18px;border-radius:18px;font-size:13px;font-weight:500;font-family:var(--dsw-font-family);cursor:pointer;color:#fff;background:var(--dsw-alias-brand-primary, #2563eb);display:inline-flex;align-items:center;gap:8px}",
			".pqGPU_primary:hover:not(:disabled){filter:brightness(1.06)}",
			".pqGPU_primary:disabled{cursor:progress;opacity:.7}",
			".pqGPU_hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
			".pqGPU_log{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;font-family:var(--dsw-font-family-mono, ui-monospace, monospace);font-size:12px;line-height:1.55;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0;color:var(--dsw-alias-label-secondary)}",
			".pqGPU_ok{color:#16a34a}",
			".pqGPU_err{color:#dc2626}",
			".pqGPU_warn{color:#d97706}",
			".pqGPU_toast{position:fixed;right:20px;bottom:20px;z-index:9999;width:380px;max-width:calc(100vw - 40px);box-shadow:0 12px 32px rgba(0,0,0,.28);background:var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}",
			".pqGPU_toastHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".pqGPU_x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}",
			".pqGPU_smallLog{max-height:180px}"
		].join("");
		const cssTagId = "@princepainter/dsh-gpu-cleanup/release-gpu.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
			const styleTag = document.createElement("style");
			styleTag.dataset.plugin = "@princepainter/dsh-gpu-cleanup";
			styleTag.dataset.pluginCss = cssTagId;
			styleTag.textContent = css;
			document.head.appendChild(styleTag);
		}

		// ---- tiny shared store ------------------------------------------------
		// No dependency on dsh-client-store: the surface contract there changed
		// between 0.1.x and 0.2.x and this plugin must load on both.
		const IDLE = { status: "idle", steps: [], message: "", startedAt: 0, finishedAt: 0 };
		let state = IDLE;
		const listeners = new Set();
		function emit() {
			for (const fn of listeners) {
				try { fn(state); } catch (e) { /* ignore */ }
			}
		}
		function setState(patch) {
			state = Object.assign({}, state, patch);
			emit();
		}
		function useGpuState() {
			const [, force] = react.useState(0);
			react.useEffect(function () {
				const fn = function () { force(function (n) { return n + 1; }); };
				listeners.add(fn);
				return function () { listeners.delete(fn); };
			}, []);
			return state;
		}

		// ---- the action -------------------------------------------------------
		let inflight = null;
		async function runFreeVram() {
			if (inflight) return inflight;
			setState({ status: "running", steps: [], message: "正在释放显存……", startedAt: Date.now(), finishedAt: 0 });
			inflight = (async function () {
				try {
					const resp = await fetch(HOST + "/free-vram", { method: "POST" });
					const body = await resp.json().catch(function () { return null; });
					if (!body) throw new Error("控制服务返回了空响应（HTTP " + resp.status + "）");
					const steps = Array.isArray(body.steps) ? body.steps : [];
					const failed = steps.some(function (s) { return s.level === "err"; });
					setState({
						status: failed ? "error" : "success",
						steps: steps,
						finishedAt: Date.now(),
						message: failed
							? "有步骤失败，见下方日志"
							: (body.swapUp ? "显存已释放，llama-swap 仍在运行" : "显存已释放（llama-swap 未运行）")
					});
				} catch (e) {
					setState({
						status: "error",
						steps: [{ level: "err", text: "连不上本机控制服务 " + HOST + "（" + ((e && e.message) || e) + "）" }],
						finishedAt: Date.now(),
						message: "控制服务不可达——DSH 需要重启一次才能加载本插件的 host 端"
					});
				} finally {
					inflight = null;
				}
			})();
			return inflight;
		}
		function dismissState() {
			setState({ status: "idle", steps: [], message: "", startedAt: 0, finishedAt: 0 });
		}

		// ---- shared bits ------------------------------------------------------
		function stepLine(s) {
			return "[" + s.level + "] " + s.text;
		}
		function logText(steps) {
			return steps.length === 0 ? "（暂无日志）" : steps.map(stepLine).join("\n");
		}
		function levelClass(level) {
			return level === "err" ? "pqGPU_err" : level === "warn" ? "pqGPU_warn" : level === "ok" ? "pqGPU_ok" : "";
		}

		function RunButton(props) {
			const st = useGpuState();
			const busy = st.status === "running";
			const label = busy ? "释放中…" : (props.label || "释放显存");
			return jsxRuntime.jsxs("button", {
				type: "button",
				className: props.primary ? "pqGPU_primary" : "pqGPU_btn",
				disabled: busy,
				title: "卸载本地模型并释放显存（llama-swap 保持运行）",
				onClick: function () { runFreeVram(); },
				children: [
					jsxRuntime.jsx("span", { className: "pqGPU_dot" + (st.status === "success" ? " pqGPU_ok" : st.status === "error" ? " pqGPU_err" : "") }),
					jsxRuntime.jsx("span", { children: label })
				]
			});
		}

		// ---- 1) conversation header button ------------------------------------
		function HeaderButton() {
			const st = useGpuState();
			const showToast = st.status === "running" || st.status === "success" || st.status === "error";
			return jsxRuntime.jsxs(jsxRuntime.Fragment, {
				children: [
					jsxRuntime.jsx(RunButton, { label: "释放显存" }),
					showToast
						? jsxRuntime.jsxs("div", {
							className: "pqGPU_toast",
							children: [
								jsxRuntime.jsxs("div", {
									className: "pqGPU_toastHead",
									children: [
										jsxRuntime.jsx("span", { children: st.status === "running" ? "正在释放显存…" : st.message }),
										jsxRuntime.jsx("button", { type: "button", className: "pqGPU_x", onClick: dismissState, title: "关闭", children: "✕" })
									]
								}),
								jsxRuntime.jsx("pre", { className: "pqGPU_log pqGPU_smallLog", children: logText(st.steps) })
							]
						})
						: null
				]
			});
		}

		// ---- 2) settings / plugin-detail card ---------------------------------
		function SettingsCard(props) {
			const st = useGpuState();
			const busy = st.status === "running";
			const hint = busy
				? "正在卸载模型并清理引擎进程，通常 2–10 秒……"
				: "点一下即可：卸载 llama-swap 里所有已加载模型、清掉残留引擎进程，llama-swap 本身保持运行；90 秒内新起的引擎会保留（可能正在生成回复）。";
			return jsxRuntime.jsxs("div", {
				className: "pqGPU_card",
				children: [
					jsxRuntime.jsxs("div", {
						className: "pqGPU_row",
						children: [
							jsxRuntime.jsx(RunButton, { primary: true, label: "一键释放显存" }),
							st.status !== "idle"
								? jsxRuntime.jsx("button", { type: "button", className: "pqGPU_btn", onClick: dismissState, children: "清空结果" })
								: null,
							st.status !== "idle" && st.message
								? jsxRuntime.jsx("span", { className: "pqGPU_hint" + (st.status === "error" ? " pqGPU_err" : st.status === "success" ? " pqGPU_ok" : ""), children: st.message })
								: null
						]
					}),
					jsxRuntime.jsx("div", { className: "pqGPU_hint", children: hint }),
					st.steps.length > 0 ? jsxRuntime.jsx("pre", { className: "pqGPU_log", children: logText(st.steps) }) : null
				]
			});
		}

		// ---- wiring -----------------------------------------------------------
		const inject = ["slots"];
		function apply(ctx) {
			// header button
			try {
				ctx.slots.inject("conversation.session.header.utilities", function () {
					return ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "gpu-cleanup-release"
					}, HeaderButton);
				});
			} catch (e) {
				console.warn("[gpu-cleanup] header slot unavailable:", e && e.message);
			}

			// settings → plugin config (keyed card)
			try {
				ctx.slots.inject("settings.plugin.item", function () {
					return ctx.slots.register({
						name: "settings.plugin.item",
						key: "gpu-cleanup",
						order: 120
					}, SettingsCard);
				});
			} catch (e) {
				console.warn("[gpu-cleanup] settings slot unavailable:", e && e.message);
			}

			// the plugin's own detail page
			try {
				ctx.slots.inject("plugins.bundle.config", function () {
					return ctx.slots.register({
						name: "plugins.bundle.config",
						key: OWN_BUNDLE
					}, SettingsCard);
				});
			} catch (e) {
				console.warn("[gpu-cleanup] plugin detail slot unavailable:", e && e.message);
			}

			// expose the action for other plugins / console
			try {
				ctx.provide("gpuCleanup", { run: runFreeVram, dismiss: dismissState, getState: function () { return state; } });
			} catch (e) { /* optional */ }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
