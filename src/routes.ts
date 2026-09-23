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

  router.post("/resolve", async (req, res) => {
    const { status, body } = await controller.resolve(req.body);
    res.status(status).json(body);
  });

  router.get("/api/v1/audio-url", async (req, res) => {
    const { status, body } = await controller.resolve(req.query);
    res.status(status).json(body);
  });

  return router;
}
