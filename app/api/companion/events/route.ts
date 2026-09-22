import { companionEventKey, subscribeCompanionEvents } from "@/lib/companion-events";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = requireTenantSession(request);
    const key = companionEventKey(auth.tenant.id, auth.membership.id);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        send({ type: "connected" });
        const unsubscribe = subscribeCompanionEvents(key, send);
        const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try { controller.close(); } catch { /* already closed */ }
        };
        request.signal.addEventListener("abort", cleanup, { once: true });
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return new Response(error instanceof Error ? error.message : String(error), { status });
  }
}
