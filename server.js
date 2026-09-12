import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CyanotypeStore } from "./src/store.js";
import { createApp } from "./src/app.js";
import { attachGracefulShutdown } from "./src/lifecycle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);

let store;
try {
  store = await new CyanotypeStore(dbPath).load();
} catch (error) {
  console.error(`启动失败:${error.message}`);
  process.exit(1);
}

const server = createApp(store, { logger: console.log });
attachGracefulShutdown(server, store, { logger: console.log });
server.listen(port, () => {
  console.log("古法蓝晒底片批次工作台 listening on http://localhost:" + port);
});
