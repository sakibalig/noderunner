import { pad } from "./util";

export function routes(app: { get(path: string, handler: () => string): void }) {
  app.get("/", () => pad("ok"));
}
