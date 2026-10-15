import type { Clock, Ids } from "@noderunner/core";
import { ulid } from "ulid";

export const systemClock: Clock = { now: () => Date.now() };

export const ulidIds: Ids = { next: () => ulid() };
