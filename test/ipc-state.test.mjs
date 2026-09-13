// IPC 健康跟踪状态机测试
// 提取 main.js 里的 ipcState / notifyFallback 逻辑做纯函数断言，
// 验证降级→告警→恢复→迁移的状态转移。
import assert from "node:assert";

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// ── 模拟 ipcState ──
function makeState() {
  return {
    failures: 0,
    fallback: false,
    toastShown: false,
    lastTier: 0,
    toasts: [],
    migrated: false,
    orphanCleared: false,
    reloadCalled: false,
  };
}

function notifyFallback(s) {
  if (!s.toastShown) {
    s.toastShown = true;
    s.lastTier = 1;
    s.toasts.push("数据库连接异常，已切换本地缓存。数据仍在本机可用，但重启后可能丢失。");
    return;
  }
  const tiers = [[10, 2], [50, 3]];
  for (const [threshold, tier] of tiers) {
    if (s.failures >= threshold && s.lastTier < tier) {
      s.lastTier = tier;
      s.toasts.push(`数据库仍异常（已累计 ${s.failures} 次）。请检查路径权限或重启应用。`);
      return;
    }
  }
}

// 模拟 invoke 的 catch 路径
function invokeFail(s) {
  s.failures++;
  s.fallback = true;
  notifyFallback(s);
  return null;
}

// 模拟 invoke 的成功路径（含恢复迁移触发）
function invokeSuccess(s, hadOrphans) {
  if (s.fallback) {
    s.fallback = false;
    if (hadOrphans) {
      s.migrated = true;
      s.orphanCleared = true;
      s.reloadCalled = true;
      s.toasts.push("数据库已恢复，1 条本地缓存已同步。");
    }
  }
  return { ok: true };
}

// ── 测试用例 ──

test("首次失败：立即弹 toast，标记降级", () => {
  const s = makeState();
  invokeFail(s);
  assert.strictEqual(s.fallback, true);
  assert.strictEqual(s.failures, 1);
  assert.strictEqual(s.toastShown, true);
  assert.strictEqual(s.lastTier, 1);
  assert.strictEqual(s.toasts.length, 1);
  assert.ok(s.toasts[0].includes("已切换本地缓存"));
});

test("连续 2-9 次失败：不再连环弹（去重）", () => {
  const s = makeState();
  for (let i = 0; i < 9; i++) invokeFail(s);
  assert.strictEqual(s.failures, 9);
  assert.strictEqual(s.toasts.length, 1, "只弹了首次，不应连环弹");
});

test("第 10 次失败：弹阈值更新", () => {
  const s = makeState();
  for (let i = 0; i < 10; i++) invokeFail(s);
  assert.strictEqual(s.failures, 10);
  assert.strictEqual(s.toasts.length, 2);
  assert.strictEqual(s.lastTier, 2);
  assert.ok(s.toasts[1].includes("累计 10 次"));
});

test("第 11-49 次失败：不再弹", () => {
  const s = makeState();
  for (let i = 0; i < 49; i++) invokeFail(s);
  assert.strictEqual(s.toasts.length, 2);
});

test("第 50 次失败：弹第二档阈值更新", () => {
  const s = makeState();
  for (let i = 0; i < 50; i++) invokeFail(s);
  assert.strictEqual(s.toasts.length, 3);
  assert.strictEqual(s.lastTier, 3);
  assert.ok(s.toasts[2].includes("累计 50 次"));
});

test("恢复 + 有孤儿数据：触发迁移 + 清空 + 重新加载", () => {
  const s = makeState();
  invokeFail(s);  // 降级
  invokeSuccess(s, true);  // 恢复，有孤儿
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.migrated, true);
  assert.strictEqual(s.orphanCleared, true);
  assert.strictEqual(s.reloadCalled, true);
  assert.strictEqual(s.toasts.length, 2);
  assert.ok(s.toasts[1].includes("已恢复"));
});

test("恢复 + 无孤儿数据：不弹恢复 toast", () => {
  const s = makeState();
  invokeFail(s);
  invokeSuccess(s, false);
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.migrated, false);
  assert.strictEqual(s.toasts.length, 1, "只有首次降级 toast，不弹恢复 toast");
});

test("非降级 → 成功：不触发迁移", () => {
  const s = makeState();
  const r = invokeSuccess(s, true);
  assert.strictEqual(s.migrated, false, "从未降级过，不应触发迁移");
  assert.deepStrictEqual(r, { ok: true });
});

test("降级→恢复→再次降级→再次恢复：状态机循环正确", () => {
  const s = makeState();
  invokeFail(s);         // 第 1 次降级
  assert.strictEqual(s.fallback, true);
  invokeSuccess(s, true); // 第 1 次恢复 + 迁移
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.migrated, true);
  s.migrated = false;    // 重置迁移标记
  invokeFail(s);         // 第 2 次降级（failures=2, toastShown 已 true → 不弹）
  assert.strictEqual(s.fallback, true);
  assert.strictEqual(s.toasts.length, 2, "不因第 2 次降级新增 toast");
  invokeSuccess(s, true);  // 第 2 次恢复 + 迁移
  assert.strictEqual(s.fallback, false);
  assert.strictEqual(s.migrated, true);
});

test("失败计数只增不减：恢复不归零", () => {
  const s = makeState();
  for (let i = 0; i < 5; i++) invokeFail(s);
  invokeSuccess(s, false);
  assert.strictEqual(s.failures, 5, "failures 是累计值，恢复不归零");
  assert.strictEqual(s.fallback, false);
});

// ── 输出 ──
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  const tag = r.pass ? "✓" : `✗ ${r.err}`;
  console.log(`  ${tag}  ${r.name}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
