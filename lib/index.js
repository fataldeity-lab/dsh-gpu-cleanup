// dsh-gpu-cleanup — host (node) half.
//
// The browser button cannot talk to llama-swap directly: the GUI runs on
// http://127.0.0.1:3080 and llama-swap on :11435, a cross-origin fetch with no
// CORS headers on the llama-swap side. So every VRAM action happens HERE, on the
// host, and the browser only does one call to the tiny local control server on
// 127.0.0.1:11436.
//
//   GET  /health      -> { ok, version }
//   GET  /status      -> { ok, swapUp, running, configured, engines }
//   POST /free-vram   -> unload every model, sweep orphan engines, report steps
//   GET  /list-llama  -> { processes: [pid...] }        (legacy compat)
//   POST /kill-llama  -> force-kill engines             (legacy compat)
//
// SECURITY: this server can end processes, so it is not open to the web.
//   * bound to 127.0.0.1 and the Host header must be loopback
//   * no `Access-Control-Allow-Origin: *`: a loopback origin is echoed back,
//     anything else gets 403 (before this, any site the user visited could
//     POST /free-vram and taskkill their engines)
//   * every POST must carry `X-DSH-Plugin: gpu-cleanup`; a custom header is
//     unreachable for third-party pages without a CORS preflight we refuse
//
// free-vram never touches llama-swap.exe itself (kill only by the engine image
// names) and never touches an engine younger than MIN_AGE_SEC seconds: this
// very chat is usually served by a freshly spawned engine, and killing it
// would abort the answer the user is reading right now.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KILL_PORT = 11436;
const SWAP_BASE = "http://127.0.0.1:11435";
const LEGACY_BASES = ["http://127.0.0.1:11437"];
const PROBE_MS = 3000;
const UNLOAD_MS = 180000;
const MIN_AGE_SEC = 90;
const LIST_CACHE_MS = 800;

const AUTH_HEADER = "x-dsh-plugin";
const AUTH_TOKEN = "gpu-cleanup";
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i;

const name = "gpu-cleanup";
const inject = [];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

// A PowerShell spawn costs ~0.5-1.5s and free-vram asks for the list three
// times in a row, so remember the last answer for a moment.
let enginesCache = { at: 0, list: [] };

async function listEnginesUncached() {
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

async function listEngines(opts) {
	const fresh = Boolean(opts && opts.fresh);
	const now = Date.now();
	if (!fresh && now - enginesCache.at < LIST_CACHE_MS) return enginesCache.list.slice();
	const list = await listEnginesUncached();
	enginesCache = { at: Date.now(), list };
	return list.slice();
}

function killPid(pid) {
	return new Promise((resolve) => {
		execFile("taskkill", ["/f", "/pid", String(pid)], { windowsHide: true }, () => resolve());
	});
}

// Kill every engine older than minAgeSec and VERIFY the result: taskkill can
// fail (access denied, already gone, protected process) and reporting "已清理"
// for a process that is still resident is worse than reporting nothing.
async function sweepEngines(minAgeSec) {
	const before = await listEngines({ fresh: true });
	const targets = before.filter((p) => p.age >= minAgeSec);
	const kept = before.filter((p) => p.age < minAgeSec);
	if (targets.length > 0) {
		await Promise.all(targets.map((p) => killPid(p.pid)));
		await delay(400);
	}
	const left = await listEngines({ fresh: true });
	const leftIds = new Set(left.map((p) => p.pid));
	return {
		killed: targets.filter((p) => !leftIds.has(p.pid)),
		stubborn: targets.filter((p) => leftIds.has(p.pid)),
		kept,
		left
	};
}

// ---------------------------------------------------------------------------
// llama-swap HTTP helpers
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs, method) {
	const resp = await fetch(url, { method: method || "GET", signal: AbortSignal.timeout(timeoutMs) });
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
		const r = await getJson(SWAP_BASE + "/api/models/unload", UNLOAD_MS, "POST");
		return { ok: r.ok, status: r.status, message: summarize(r) };
	} catch (e) {
		return { ok: false, status: 0, message: errText(e) };
	}
}

// qwen-switch proxy (older setups): POST /__unload
async function legacyUnload(base) {
	try {
		const r = await getJson(base + "/__unload", 15000, "POST");
		return { ok: r.ok, status: r.status, message: summarize(r) };
	} catch (e) {
		return { ok: false, status: 0, message: errText(e) };
	}
}

function errText(e) {
	if (e && e.name === "TimeoutError") return "请求超时";
	return String((e && e.message) || e);
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
		const swept = await sweepEngines(MIN_AGE_SEC);
		for (const k of swept.killed) push("ok", "已清理孤儿引擎 " + k.name + ":" + k.pid + "（已运行 " + k.age + "s）");
		for (const k of swept.stubborn) push("err", "清理失败，仍驻留 " + k.name + ":" + k.pid + "（权限或进程受保护）");
		for (const k of swept.kept) push("info", "保留新引擎 " + k.name + ":" + k.pid + "（仅 " + k.age + "s，可能在推理）");
		return { ok: !steps.some((s) => s.level === "err"), swapUp: false, steps, engines: swept.left };
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
	for (const k of swept.stubborn) push("err", "清理失败，仍驻留 " + k.name + ":" + k.pid + "（权限或进程受保护）");
	for (const k of swept.kept) push("warn", "保留新引擎 " + k.name + ":" + k.pid + "（仅 " + k.age + "s，可能正在推理——稍后再点一次即可）");
	if (swept.killed.length === 0 && swept.left.length === 0) push("info", "已无模型引擎驻留，显存已释放");

	const after = await probeSwap();
	push(after.up ? "ok" : "err", after.up ? "llama-swap 仍在运行（有意保留，不关）" : "llama-swap 无响应，检查 I:\\DPHs\\llama-swap\\logs");
	if (after.up && after.running.length === 0) push("ok", "确认：当前没有已加载模型，显存已释放");

	const failed = steps.some((s) => s.level === "err");
	return { ok: !failed, swapUp: after.up, steps, engines: swept.left };
}

// Two tabs clicking at once must not run two competing sweeps.
let freeInflight = null;
function freeVramOnce() {
	if (freeInflight) return freeInflight;
	freeInflight = freeVram().finally(() => {
		freeInflight = null;
	});
	return freeInflight;
}

// ---------------------------------------------------------------------------
// local control server
// ---------------------------------------------------------------------------

function corsHeaders(req) {
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		Vary: "Origin"
	};
	const origin = req.headers.origin;
	if (typeof origin === "string" && LOOPBACK_ORIGIN.test(origin)) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
		headers["Access-Control-Allow-Headers"] = "Content-Type, X-DSH-Plugin";
		headers["Access-Control-Max-Age"] = "600";
	}
	return headers;
}

function send(req, res, status, body) {
	res.writeHead(status, corsHeaders(req));
	if (status === 204 || body === undefined) {
		res.end();
		return;
	}
	res.end(JSON.stringify(body));
}

function refuse(req, res, reason) {
	send(req, res, 403, { ok: false, message: reason });
}

// Returns true when the request may proceed.
function authorized(req) {
	const host = String(req.headers.host || "");
	if (!LOOPBACK_HOST.test(host)) return false;
	const origin = req.headers.origin;
	if (origin !== undefined && !(typeof origin === "string" && LOOPBACK_ORIGIN.test(origin))) return false;
	if (req.method === "POST" && req.headers[AUTH_HEADER] !== AUTH_TOKEN) return false;
	return true;
}

async function handle(req, res) {
	const url = (req.url || "").split("?")[0];
	if (req.method === "OPTIONS") {
		if (!authorized(req)) {
			refuse(req, res, "origin not allowed");
			return;
		}
		send(req, res, 204);
		return;
	}
	if (!authorized(req)) {
		refuse(req, res, "not allowed: this endpoint only serves the DSH web UI on loopback");
		return;
	}
	try {
		if (req.method === "GET" && (url === "/health" || url === "/")) {
			send(req, res, 200, { ok: true, version: 3, port: KILL_PORT });
			return;
		}
		if (req.method === "GET" && url === "/status") {
			const swap = await probeSwap();
			const engines = await listEngines();
			send(req, res, 200, { ok: true, swapUp: swap.up, running: swap.running, configured: swap.configured, engines });
			return;
		}
		if (req.method === "POST" && url === "/free-vram") {
			const result = await freeVramOnce();
			send(req, res, 200, result);
			return;
		}
		if (req.method === "GET" && url === "/list-llama") {
			const engines = await listEngines();
			send(req, res, 200, { ok: true, processes: engines.map((e) => e.pid), engines });
			return;
		}
		if (req.method === "POST" && url === "/kill-llama") {
			const swept = await sweepEngines(MIN_AGE_SEC);
			send(req, res, 200, { ok: true, killed: swept.killed.length, remaining: swept.left.map((e) => e.pid) });
			return;
		}
		send(req, res, 404, { ok: false, message: "not found: " + url });
	} catch (e) {
		send(req, res, 500, { ok: false, message: String((e && e.message) || e) });
	}
}

let serverRef = null;
let serverStart = null;
// idle | starting | listening | external | blocked
let serverState = "idle";

function probeExistingServer() {
	return fetch("http://127.0.0.1:" + KILL_PORT + "/health", {
		signal: AbortSignal.timeout(1200),
		headers: { "X-DSH-Plugin": AUTH_TOKEN }
	})
		.then((r) => r.ok)
		.catch(() => false);
}

function ensureServer() {
	if (serverRef && serverRef.listening) return Promise.resolve(serverRef);
	if (serverStart) return serverStart;
	serverState = "starting";
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const finish = (value) => {
		serverStart = null;
		return value;
	};
	serverStart = new Promise((resolve) => {
		server.on("error", (e) => {
			const code = e && e.code;
			if (code === "EADDRINUSE") {
				// Another copy of this plugin (or an older one) already owns the
				// port; reuse it instead of pretending we are broken.
				probeExistingServer().then((alive) => {
					serverState = alive ? "external" : "blocked";
					const hint = alive ? "已有控制服务在应答，沿用" : "端口被其他程序占用";
					console.warn("[gpu-cleanup] " + KILL_PORT + " 不可用：" + hint);
					resolve(null);
				});
				return;
			}
			serverState = "blocked";
			console.error("[gpu-cleanup] control server:", (e && e.message) || e);
			resolve(null);
		});
		server.listen(KILL_PORT, "127.0.0.1", () => {
			serverState = "listening";
			console.log("[gpu-cleanup] control server on http://127.0.0.1:" + KILL_PORT);
			resolve(server);
		});
	}).then(finish);
	serverRef = server;
	return serverStart;
}

function stopServer() {
	const server = serverRef;
	serverRef = null;
	serverStart = null;
	serverState = "idle";
	if (!server) return;
	try {
		server.close();
	} catch (e) {
		/* already closed */
	}
}

function apply(ctx) {
	ensureServer();
	ctx.provide("gpuCleanupHost", {
		killPort: KILL_PORT,
		listEngines,
		sweepEngines,
		freeVram: freeVramOnce,
		status: async function () {
			const swap = await probeSwap();
			return { swapUp: swap.up, running: swap.running, configured: swap.configured, engines: await listEngines() };
		}
	});
	if (ctx && typeof ctx.on === "function") ctx.on("dispose", stopServer);
}

export { apply, inject, name };
