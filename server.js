import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CyanotypeStore } from "./src/store.js";
import { createApp } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "cyanotype-negative-room.json");
const port = Number(process.env.PORT || 3040);

const store = await new CyanotypeStore(dbPath).load();
createApp(store).listen(port, () => {
  console.log("古法蓝晒底片批次工作台 listening on http://localhost:" + port);
});
