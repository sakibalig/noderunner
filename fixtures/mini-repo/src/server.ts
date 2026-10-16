import express from "express";
import { routes } from "./routes";

export function start() {
  const app = express();
  routes(app);
  return app.listen(3000);
}
