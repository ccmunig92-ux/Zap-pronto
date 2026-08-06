import { buildApp } from "./app.js";

const app = await buildApp();
await app.listen({ host: process.env.API_HOST ?? "127.0.0.1", port: Number(process.env.API_PORT ?? 3000) });
