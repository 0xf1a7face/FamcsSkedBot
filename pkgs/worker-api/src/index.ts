import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerScheduleRoutes } from "./routes/schedule";
import { registerSystemRoutes } from "./routes/system";
import { registerColorRoutes } from "./routes/colors";
import type { AppEnvironment } from "./types";

const app = new Hono<AppEnvironment>();

app.use("*", cors({
  origin: [
    "https://famcs.online",
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  maxAge: 7200,
}));

app.use("*", async (c, next) => {
  console.log(`📥 ${c.req.method} ${c.req.path}`);
  await next();
});

registerSystemRoutes(app);
registerColorRoutes(app);
registerScheduleRoutes(app);

app.all("*", (c) => c.json({ success: false, error: "Not Found", message: `Маршрут ${c.req.path} не существует` }, 404));

export default app;
