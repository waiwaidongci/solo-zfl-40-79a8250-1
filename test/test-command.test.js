import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = process.execPath;

// 回归背景:`node --test test/` 在较新 Node 上会把 test 目录当作模块执行,
// 全部用例跑不起来。这里锁定 package.json 中的命令,并实际以子进程运行一遍,
// 保证同一命令在项目支持的环境里能跑完全部用例、失败时退出码非零。
test("测试命令回归:npm test 跑完全部用例且零失败", { skip: !!process.env.TEST_COMMAND_SELF_CHECK }, async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  // 命令必须是不带目录参数的形式;目录参数在新版 Node 上会被当成模块
  assert.equal(pkg.scripts.test, "node --test");

  const childEnv = { ...process.env, TEST_COMMAND_SELF_CHECK: "1" };
  // 测试运行器会给子进程设置 NODE_TEST_CONTEXT,继承它会被当成嵌套运行而跳过全部文件
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(nodeBin, ["--test"], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 120000,
  });
  const output = (child.stdout || "") + (child.stderr || "");
  assert.equal(child.status, 0, `测试命令应全部通过:\n${output}`);
  // 汇总行同时兼容新旧输出格式(# tests / ℹ tests)
  const tests = /(?:#|ℹ) tests (\d+)/.exec(output);
  const failed = /(?:#|ℹ) fail (\d+)/.exec(output);
  assert.ok(tests && Number(tests[1]) >= 18, `应发现全部用例(含本文件),实际输出:\n${output}`);
  assert.ok(failed && Number(failed[1]) === 0, `不应有用例失败:\n${output}`);
});

test("测试命令回归:存在失败用例时退出码非零", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cyanotype-testcmd-"));
  try {
    const file = join(dir, "failing.test.js");
    await writeFile(file, 'import test from "node:test";\ntest("boom", () => { throw new Error("预期失败"); });\n');
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(nodeBin, ["--test", file], { env: childEnv, encoding: "utf8", timeout: 60000 });
    assert.notEqual(child.status, 0, "存在失败用例时测试命令必须返回非零状态");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
