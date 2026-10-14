import { Router } from "express";

import {
  getSharedCounter,
  redirectBaseline
} from "../controllers/experiment.controller.js";

const router = Router();

router.get("/debug/shared-counter", getSharedCounter);
router.get("/debug/redirect-baseline/:code", redirectBaseline);

export default router;