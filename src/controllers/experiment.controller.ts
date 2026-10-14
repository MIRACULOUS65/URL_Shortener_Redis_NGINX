import type { Request, Response } from "express";

import {
  incrementSharedCounter
} from "../services/shared-counter.service.js";
import { resolveUrlWithoutCache } from "../experiments/url-resolution-baseline.js";

export async function getSharedCounter(
  _req: Request,
  res: Response
) {
  try {
    const sharedCounter = await incrementSharedCounter();

    return res.status(200).json({
      instance: process.env.INSTANCE_ID ?? "native",
      pid: process.pid,
      sharedCounter,
      storage: "Redis shared state"
    });
  } catch (error) {
    console.error("[Shared counter] Request failed:", error);

    return res.status(503).json({
      error: "Shared counter unavailable"
    });
  }
}

export async function redirectBaseline(
    req: Request,
    res: Response
) {
    const { code } = req.params;

    if (typeof code !== "string") {
        return res.status(400).json({
            error: "Invalid short code"
        });
    }

    try {
        const originalUrl = await resolveUrlWithoutCache(code);

        if (!originalUrl) {
            return res.status(404).json({
                error: "URL not found"
            });
        }

        return res.redirect(originalUrl);
    } catch (error) {
        console.error("[Baseline redirect] Request failed:", error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
}