import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveSkillLlmTimeoutSeconds } from "./skill-timeouts";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type ModelGatewayRoute = { provider: string; modelId: string };

type GatewayRequest = {
  provider?: unknown;
  model?: unknown;
  body?: unknown;
};

type GatewayResponse = {
  ok: boolean;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
};

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body is invalid");
  return value as Record<string, unknown>;
}

async function forward(route: ModelGatewayRoute, request: GatewayRequest): Promise<GatewayResponse> {
  const provider = text(request.provider, "provider");
  const modelId = text(request.model, "model");
  if (provider !== route.provider || modelId !== route.modelId) {
    throw new Error("model route does not match the session route");
  }
  const runtime = await ModelRuntime.create({
    modelsPath: join(getAgentDir(), "models.json"),
    authPath: join(getAgentDir(), "auth.json"),
    refreshOnCreate: false,
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error("configured model is unavailable");
  if (model.api !== "openai-completions") {
    throw new Error(`sandbox model gateway does not support API ${model.api}`);
  }
  const auth = await runtime.getAuth(model);
  const registered = runtime.getRegisteredProviderConfig(provider);
  const config = runtime.getCompatibilityRequestConfig(model);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...(model.headers ?? {}),
  };
  for (const [key, value] of Object.entries(auth?.auth.headers ?? {})) {
    if (value !== null) headers[key] = value;
  }
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (value !== null) headers[key] = value;
  }
  const apiKey = auth?.auth.apiKey || registered?.apiKey;
  // Custom OpenAI-compatible models commonly leave `authHeader` unset even
  // though their endpoint expects the standard bearer header. The gateway is
  // the only place where the secret is available, so apply it unless an
  // explicit provider header already supplied authorization.
  if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const baseUrl = (auth?.auth.baseUrl || model.baseUrl).replace(/\/+$/, "");
  const body = JSON.stringify(jsonObject(request.body));
  const startedAt = Date.now();
  console.info(`[pi-web model-gateway] request provider=${provider} model=${modelId} body_bytes=${Buffer.byteLength(body)}`);
  // Bound the host-side forwarding call to the same *single-request* budget
  // used by the worker. This signal is never reused as the bridge deadline.
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(resolveSkillLlmTimeoutSeconds() * 1_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  console.info(`[pi-web model-gateway] response provider=${provider} model=${modelId} status=${response.status} body_bytes=${bytes.byteLength} duration_ms=${Date.now() - startedAt}`);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("model response is too large");
  return {
    ok: response.ok,
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    body: bytes.toString("base64"),
    ...(response.ok ? {} : { error: `model gateway HTTP ${response.status}` }),
  };
}

function send(socket: Socket, response: GatewayResponse): void {
  if (socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

export class ModelGateway {
  private constructor(
    readonly directory: string,
    readonly socketPath: string,
    private readonly server: Server,
  ) {}

  static async open(route: ModelGatewayRoute): Promise<ModelGateway> {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-model-gateway-"));
    const socketPath = join(directory, "model-gateway.sock");
    // The worker validates that its selected model belongs to the selected
    // provider before it sends a request. Give it only the route metadata it
    // needs; credentials and the real endpoint stay in the host process.
    // Requests use the sitecustomize hook below, so this URL is deliberately
    // unroutable if the hook is absent or bypassed.
    await writeFile(join(directory, "models.json"), JSON.stringify({
      providers: {
        [route.provider]: {
          baseUrl: "http://pi-web-model-gateway.invalid/v1",
          models: [{ id: route.modelId }],
        },
      },
    }), { mode: 0o600 });
    const hook = `
import base64, json, os, socket, subprocess, urllib.error, urllib.request
import builtins, sys

_gateway_socket = os.environ.get("BIOGRAPHY_LLM_GATEWAY_SOCKET", "")
_llm_timeout_seconds = os.environ.get("BIOGRAPHY_LLM_TIMEOUT_SECONDS", "").strip()
_stage_timeout_seconds = os.environ.get("BIOGRAPHY_STAGE_TIMEOUT_SECONDS", "").strip()
_execution_timeout_seconds = os.environ.get("BIOGRAPHY_EXECUTION_TIMEOUT_SECONDS", "").strip()
_original_urlopen = urllib.request.urlopen
_original_subprocess_run = subprocess.run
_original_import = builtins.__import__

def _run_with_execution_budget(*args, **kwargs):
    # pi_bridge.py owns its subprocess timeout and older releases cap a
    # chapter at 1800s. Extend only those long-running bridge invocations to
    # the host budget; short helper commands and per-request LLM calls keep
    # their own deadlines.
    timeout = kwargs.get("timeout")
    try:
        budget = float(_execution_timeout_seconds)
        if isinstance(timeout, (int, float)) and timeout >= 1500 and budget > timeout:
            kwargs["timeout"] = max(1.0, budget - 30.0)
    except (TypeError, ValueError):
        pass
    return _original_subprocess_run(*args, **kwargs)

subprocess.run = _run_with_execution_budget

def _patch_llm_runtime(module):
    if not _llm_timeout_seconds or getattr(module, "_pi_web_timeout_patch", False):
        return
    try:
        minimum = float(_llm_timeout_seconds)
    except ValueError:
        return
    if minimum <= 0:
        return
    original_loader = getattr(module, "load_worker_settings", None)
    if not callable(original_loader):
        return
    def load_worker_settings_with_timeout():
        settings = original_loader()
        try:
            stage_minimum = float(_stage_timeout_seconds)
        except ValueError:
            stage_minimum = 0
        if stage_minimum > 0:
            stage_timeouts = dict(settings.get("stage_timeout_seconds", {}))
            for stage, current in stage_timeouts.items():
                try:
                    stage_timeouts[stage] = max(float(current), stage_minimum)
                except (TypeError, ValueError):
                    stage_timeouts[stage] = stage_minimum
            settings["stage_timeout_seconds"] = stage_timeouts
        try:
            settings["request_timeout_seconds"] = max(float(settings.get("request_timeout_seconds", 0)), minimum)
        except (TypeError, ValueError):
            settings["request_timeout_seconds"] = minimum
        return settings
    module.load_worker_settings = load_worker_settings_with_timeout
    module._pi_web_timeout_patch = True

def _import_with_runtime_override(name, globals=None, locals=None, fromlist=(), level=0):
    module = _original_import(name, globals, locals, fromlist, level)
    target = sys.modules.get("llm_runtime")
    if target is not None:
        _patch_llm_runtime(target)
    return module

builtins.__import__ = _import_with_runtime_override

class _GatewayResponse:
    def __init__(self, payload):
        self._body = base64.b64decode(payload.get("body", ""))
        self._offset = 0
        self.status = int(payload.get("status", 502))
        self.code = self.status
        self.headers = payload.get("headers", {})
    def read(self, size=-1):
        # urllib callers may read in fixed-size chunks. Advance the cursor;
        # returning the same prefix forever makes llm_runtime join an
        # unbounded response until its timeout/OOMs.
        if size is None or size < 0:
            size = len(self._body) - self._offset
        start = self._offset
        end = min(len(self._body), start + size)
        self._offset = end
        return self._body[start:end]
    def getcode(self):
        return self.status
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

def _gateway_urlopen(request, *args, **kwargs):
    request_method = request.get_method() if isinstance(request, urllib.request.Request) else None
    if not _gateway_socket or not isinstance(request, urllib.request.Request) or request_method != "POST":
        return _original_urlopen(request, *args, **kwargs)
    try:
        body = request.data or b"{}"
        payload = {"provider": os.environ.get("BIOGRAPHY_WORKER_PROVIDER"), "model": os.environ.get("BIOGRAPHY_WORKER_MODEL"), "body": json.loads(body.decode("utf-8"))}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
            # A request timeout belongs to this one model call. It must not
            # become the host-side deadline for the complete bridge run.
            try:
                _gateway_timeout = float(_llm_timeout_seconds or "600")
            except ValueError:
                _gateway_timeout = 600.0
            channel.settimeout(kwargs.get("timeout", _gateway_timeout))
            channel.connect(_gateway_socket)
            channel.sendall((json.dumps(payload, ensure_ascii=False) + "\\n").encode("utf-8"))
            chunks = []
            while True:
                chunk = channel.recv(65536)
                if not chunk: break
                chunks.append(chunk)
                if b"\\n" in chunk: break
        response = json.loads(b"".join(chunks).split(b"\\n", 1)[0].decode("utf-8"))
    except Exception as exc:
        raise urllib.error.URLError(f"model gateway unavailable: {exc}") from exc
    result = _GatewayResponse(response)
    if not response.get("ok", False):
        raise urllib.error.HTTPError(request.full_url, result.status, response.get("error", "model gateway request failed"), result.headers, None)
    return result

urllib.request.urlopen = _gateway_urlopen
`;
    await writeFile(join(directory, "sitecustomize.py"), hook, { mode: 0o600 });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      // A timed-out worker may close its side while the host model request is
      // still finishing. Treat that disconnect as cancellation instead of an
      // uncaught EPIPE that can take down the Next process.
      socket.on("error", () => undefined);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > MAX_LINE_BYTES) {
          send(socket, { ok: false, status: 413, error: "model gateway request is too large" });
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        void (async () => {
          try {
            send(socket, await forward(route, JSON.parse(line) as GatewayRequest));
          } catch (error) {
            send(socket, { ok: false, status: 502, error: error instanceof Error ? error.message : "model gateway request failed" });
          }
          socket.end();
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    return new ModelGateway(directory, socketPath, server);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }
}
