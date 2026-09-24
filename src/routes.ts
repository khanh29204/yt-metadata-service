/** Router: map HTTP -> controller (thin adapter, giống Nest router). */
import express, { Router } from "express";
import { container } from "./di.js";
import { ResolveController } from "./resolve.controller.js";
import { ConfigService } from "./config.js";

export function createRouter(): Router {
  const controller = container.resolve(ResolveController);
  const config = container.resolve(ConfigService);
  const router = Router();

  router.use(express.json());

  // auth đơn giản: header x-api-key (tạm tắt — bật lại khi mở public)
  router.use((req, res, next) => {
    if (!config.apiKey || req.header("x-api-key") === config.apiKey) return next();
    res.status(401).json({ error: "invalid api key" });
  });

  // SSE mode khi ?sse=1: stream bước xử lý (event: step), kết thúc bằng done/error.
  // Không có flag thì trả JSON bình thường.
  const handle = (input: Record<string, unknown>, req: express.Request, res: express.Response) => {
    return (async () => {
      if (req.query.sse !== "1") {
        const { status, body } = await controller.resolve(input);
        res.status(status).json(body);
        return;
      }
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => clearInterval(ping));
      try {
        const { status, body } = await controller.resolve(input, (step, pct) => send("step", { step, pct }));
        if (status === 200) send("done", body);
        else send("error", body);
      } catch {
        send("error", { error: "internal error" });
      }
      clearInterval(ping);
      res.end();
    })();
  };

  router.post("/resolve", (req, res) => handle(req.body, req, res));
  router.get("/api/v1/audio-url", (req, res) => handle(req.query, req, res));

  return router;
}
