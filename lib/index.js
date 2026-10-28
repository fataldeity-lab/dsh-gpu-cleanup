// dsh-gpu-cleanup — host (node) half.
//
// The browser button cannot talk to llama-swap directly: the GUI runs on
// http://127.0.0.1:3080 and llama-swap on :11435, a cross-origin fetch with no
// CORS headers on the llama-swap side. So every VRAM action happens HERE, on the
// host, and the browser only does one same-origin-ish call to the tiny local
// control server on 127.0.0.1:11436 (which does send Access-Control-Allow-Origin).
//
//   GET  /status      -> { swapUp, models, engines }
//   POST /free-vram   -> unload every model, sweep orphan engines, report steps
//   GET  /list-llama  -> { processes: [pid...] }        (legacy compat)
//   POST /kill-llama  -> force-kill engines             (legacy compat)
//   GET  /health      -> { ok }
//
// free-vram never touches llama-swap.exe itself (kill only by the engine
// image names) and never touches an engine younger than MIN_AGE_SEC seconds:
// this very chat is usually served by a freshly spawned engine, and killing it
// would abort the answer the user is reading right now.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KILL_PORT = 11436;
const SWAP_BASE = "http://127.0.0.1:11435";
const LEGACY_BASES = ["http://127.0.0.1:11435", "http://127.0.0.1:11437"];
const PROBE_MS = 3000;
const UNLOAD_MS = 180000;
const MIN_AGE_SEC = 90;
const ENGINE_NAMES = ["llama-server", "ninfer-serve", "strata", "strata-vision"];

const name = "gpu-cleanup";
const inject = [];

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

// One PowerShell round-trip that returns every resident engine with its age.
// ASCII only: Windows PowerShell 5.1 reads scripts as ANSI.
const PS_LIST = [
	"$ErrorActionPreference='SilentlyContinue'",
	"$out=@()",
	"foreach($pat in @('llama-server*','ninfer-serve*','strata*')){",
	"  Get-Process -Name $pat | ForEach-Object {",
	"    $age=[int]((Get-Date)-$_.StartTime).TotalSeconds",
	"    $out += [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id; age=$age }",
	"  }",
	"}",
	"Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -and ($_.CommandLine -match 'serve[\\\\/]server\\.py') } | ForEach-Object {",
	"  $age=[int]((Get-Date)-$_.CreationDate).TotalSeconds",
	"  $out += [pscustomobject]@{ name=$_.Name; pid=$_.ProcessId; age=$age }",
	"}",
	"@($out) | ConvertTo-Json -Compress -Depth 3"
].join("\n");

async function listEngines() {
	try {
		const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST], {
			windowsHide: true,
			timeout: 15000,
			maxBuffer: 2 * 1024 * 1024
		});
		const raw = String(stdout || "").trim();
		if (!raw) return [];
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			return [];
		}
		const list = Array.isArray(parsed) ? parsed : [parsed];
		return list
			.filter((p) => p && typeof p.pid === "number")
			.map((p) => ({ name: String(p.name || "?"), pid: p.pid, age: Number(p.age) || 0 }));
	} catch (e) {
		return [];
	}
}

function killPid(pid) {
	return new Promise((resolve) => {
		execFile("taskkill", ["/f", "/pid", String(pid)], { windowsHide: true }, () => resolve());
	});
}

// Kill every engine older than MIN_AGE_SEC. Fresh ones are assumed to be
// serving a live generation and are reported back untouched.
async function sweepEngines(minAgeSec) {
	const before = await listEngines();
	const killed = [];
	const kept = [];
	for (const p of before) {
		if (p.age < minAgeSec) {
			kept.push(p);
			continue;
		}
		await killPid(p.pid);
		killed.push(p);
	}
	await new Promise((r) => setTimeout(r, 400));
	const left = await listEngines();
	return { killed, kept, left };
}

// ---------------------------------------------------------------------------
// llama-swap HTTP helpers
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs) {
	const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	const text = await resp.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch (e) {
		/* not json */
	}
	return { status: resp.status, ok: resp.ok, json, text };
}

// /v1/models lists every model llama-swap *can* serve (all of config.yaml);
// /running lists the ones actually holding VRAM right now. Both matter, and
// conflating them makes the log claim 13 "current" models when none are loaded.
async function probeSwap() {
	let up = false;
	let configured = [];
	let running = [];
	try {
		const r = await getJson(SWAP_BASE + "/v1/models", PROBE_MS);
		up = r.ok;
		configured = r.json && Array.isArray(r.json.data) ? r.json.data.map((m) => m && m.id).filter(Boolean) : [];
	} catch (e) {
		return { up: false, configured: [], running: [] };
	}
	try {
		const r = await getJson(SWAP_BASE + "/running", PROBE_MS);
		if (r.ok && r.json && Array.isArray(r.json.running)) {
			running = r.json.running
				.map((m) => (typeof m === "string" ? m : m && (m.model || m.name || m.id)))
				.filter(Boolean);
		}
	} catch (e) {
		/* /running may not exist on older builds — keep [] */
	}
	return { up, configured, running };
}

// llama-swap: POST /api/models/unload stops every running model process.
async function unloadAll() {
	try {
		const r = await getJsonCall(SWAP_BASE + "/api/models/unload", "POST", UNLOAD_MS);
		return { ok: r.ok, status: r.status, message: summarize(r) };
	} catch (e) {
		return { ok: false, status: 0, message: String((e && e.message) || e) };
	}
}

// qwen-switch proxy (older setups): POST /__unload
async function legacyUnload(base) {
	try {
		const r = await getJsonCall(base + "/__unload", "POST", 15000);
		return { ok: r.ok, status: r.status, message: summarize(r) };
	} catch (e) {
		return { ok: false, status: 0, message: String((e && e.message) || e) };
	}
}

async function getJsonCall(url, method, timeoutMs) {
	const resp = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
	const text = await resp.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch (e) {
		/* not json */
	}
	return { status: resp.status, ok: resp.ok, json, text };
}

function summarize(r) {
	if (r && r.json) {
		if (typeof r.json === "string") return r.json;
		if (r.json.message) return String(r.json.message);
		if (r.json.status) return String(r.json.status);
		return JSON.stringify(r.json).slice(0, 300);
	}
	return String((r && r.text) || "").slice(0, 300) || "HTTP " + (r && r.status);
}

// ---------------------------------------------------------------------------
// the one action the button calls
// ---------------------------------------------------------------------------

async function freeVram() {
	const steps = [];
	const push = (level, text) => steps.push({ level, text });

	const before = await probeSwap();
	if (!before.up) {
		push("warn", "llama-swap 不在 11435 上运行——没有需要卸载的模型");
		const engines = await listEngines();
		if (engines.length > 0) {
			push("info", "但发现 " + engines.length + " 个引擎进程：" + engines.map((e) => e.name + ":" + e.pid).join(", "));
			const swept = await sweepEngines(MIN_AGE_SEC);
			for (const k of swept.killed) push("ok", "已清理孤儿引擎 " + k.name + ":" + k.pid + "（已运行 " + k.age + "s）");
			for (const k of swept.kept) push("info", "保留新引擎 " + k.name + ":" + k.pid + "（仅 " + k.age + "s，可能在推理）");
		}
		return { ok: true, swapUp: false, steps, engines: await listEngines() };
	}

	if (before.running.length > 0) {
		push("info", "llama-swap 在线，当前已加载：" + before.running.join(", "));
	} else {
		push("info", "llama-swap 在线，当前没有已加载模型（配置了 " + before.configured.length + " 个，按需加载）");
	}

	const un = await unloadAll();
	if (un.ok) push("ok", "已请求 llama-swap 卸载全部模型（HTTP " + un.status + "）");
	else push("err", "卸载请求失败（HTTP " + un.status + "）：" + un.message);

	if (!un.ok) {
		for (const base of LEGACY_BASES) {
			const legacy = await legacyUnload(base);
			if (legacy.ok) {
				push("ok", "旧版代理 " + base + " 已卸载");
				break;
			}
		}
	}

	const swept = await sweepEngines(MIN_AGE_SEC);
	for (const k of swept.killed) push("ok", "清理残留引擎 " + k.name + ":" + k.pid + "（已运行 " + k.age + "s）");
	for (const k of swept.kept) push("warn", "保留新引擎 " + k.name + ":" + k.pid + "（仅 " + k.age + "s，可能正在推理——稍后再点一次即可）");
	if (swept.killed.length === 0 && swept.left.length === 0) push("info", "已无模型引擎驻留，显存已释放");

	const after = await probeSwap();
	push(after.up ? "ok" : "err", after.up ? "llama-swap 仍在运行（有意保留，不关）" : "llama-swap 无响应，检查 I:\\DPHs\\llama-swap\\logs");
	if (after.up && after.running.length === 0) push("ok", "确认：当前没有已加载模型，显存已释放");

	const failed = steps.some((s) => s.level === "err");
	return { ok: !failed, swapUp: after.up, steps, engines: swept.left };
}

// ---------------------------------------------------------------------------
// local control server
// ---------------------------------------------------------------------------

function json(res, status, body) {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type"
	});
	res.end(JSON.stringify(body));
}

let serverRef = null;

function ensureServer() {
	if (serverRef && serverRef.listening) return serverRef;
	const server = createServer(async (req, res) => {
		const url = (req.url || "").split("?")[0];
		if (req.method === "OPTIONS") {
			json(res, 204, {});
			return;
		}
		try {
			if (req.method === "GET" && url === "/health") {
				json(res, 200, { ok: true, version: 2 });
				return;
			}
			if (req.method === "GET" && url === "/status") {
				const swap = await probeSwap();
				const engines = await listEngines();
				json(res, 200, { ok: true, swapUp: swap.up, running: swap.running, configured: swap.configured, engines });
				return;
			}
			if (req.method === "POST" && url === "/free-vram") {
				const result = await freeVram();
				json(res, 200, result);
				return;
			}
			if (req.method === "GET" && url === "/list-llama") {
				const engines = await listEngines();
				json(res, 200, { ok: true, processes: engines.map((e) => e.pid), engines });
				return;
			}
			if (req.method === "POST" && url === "/kill-llama") {
				const swept = await sweepEngines(0);
				json(res, 200, { ok: true, killed: swept.killed.length, remaining: swept.left.map((e) => e.pid) });
				return;
			}
			json(res, 404, { ok: false, message: "not found: " + url });
		} catch (e) {
			json(res, 500, { ok: false, message: String((e && e.message) || e) });
		}
	});
	server.on("error", (e) => {
		console.error("[gpu-cleanup] control server:", e && e.message);
	});
	server.listen(KILL_PORT, "127.0.0.1", () => {
		console.log("[gpu-cleanup] control server on http://127.0.0.1:" + KILL_PORT);
	});
	serverRef = server;
	return server;
}

function apply(ctx) {
	ensureServer();
	ctx.provide("gpuCleanupHost", {
		killPort: KILL_PORT,
		listEngines,
		sweepEngines,
		freeVram,
		status: async function () {
			const swap = await probeSwap();
			return { swapUp: swap.up, running: swap.running, configured: swap.configured, engines: await listEngines() };
		}
	});
}

export { apply, inject, name };
