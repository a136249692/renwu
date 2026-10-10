// 回归测试：思维导图统一字号
// 用户诉求：在思维里可以设置节点文字大小（整个导图统一，切换导图各自记忆）。
// 覆盖：工具栏 UI + 前端状态/持久化 + CSS 变量 + Rust 后端列与命令。
// 运行方式：node test/mind-font-size.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIND = fs.readFileSync(path.join(ROOT, "src/mindmap.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
const CSS  = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const DB   = fs.readFileSync(path.join(ROOT, "src-tauri/src/db.rs"), "utf8");
const LIB  = fs.readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const CODE = stripComments(MIND);
function fnBody(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) return "";
  const next = src.indexOf("\nfunction ", start + sig.length);
  return src.substring(start, next > 0 ? next : src.length);
}

// ---------- HTML ----------
test("HTML 存在字号控制（A− / 标签 / A＋）", () => {
  assert.ok(/id="mind-font-dec"/.test(HTML), "mind-font-dec 缺失");
  assert.ok(/id="mind-font-inc"/.test(HTML), "mind-font-inc 缺失");
  assert.ok(/id="mind-font-label"/.test(HTML), "mind-font-label 缺失");
});

// ---------- CSS ----------
test("注释节点字号走 CSS 变量 var(--mind-node-font)", () => {
  assert.ok(/font-size:\s*var\(--mind-node-font/.test(CSS),
    ".mind-node-body 应使用 var(--mind-node-font)");
});

// ---------- 常量与状态 ----------
test("定义字号范围常量（MIN/MAX/DEFAULT）", () => {
  assert.ok(/MIND_FONT_MIN\s*=\s*10/.test(CODE), "缺少 MIND_FONT_MIN");
  assert.ok(/MIND_FONT_MAX\s*=\s*28/.test(CODE), "缺少 MIND_FONT_MAX");
  assert.ok(/MIND_FONT_DEFAULT\s*=\s*13/.test(CODE), "缺少 MIND_FONT_DEFAULT");
});

// ---------- API：SQLite 优先 + localStorage 兜底 ----------
test("apiUpdateMapFontSize 走 update_mindmap_font_size 并同步 maps/lsMaps", () => {
  const b = fnBody(CODE, "async function apiUpdateMapFontSize(");
  assert.ok(/update_mindmap_font_size/.test(b), "应调用 update_mindmap_font_size");
  assert.ok(/fontSize:\s*size/.test(b), "应传 fontSize");
  assert.ok(/m\.font_size\s*=\s*size/.test(b), "应更新内存 maps");
  assert.ok(/lm\.font_size\s*=\s*size/.test(b) && /lsSaveOf\(LS_MAPS/.test(b), "应写回 localStorage");
});

test("localStorage 兜底新建导图带 font_size 默认值", () => {
  const b = fnBody(CODE, "async function apiCreateMap(");
  assert.ok(/font_size:\s*MIND_FONT_DEFAULT/.test(b), "apiCreateMap 兜底应带 font_size");
});

// ---------- 应用 / 调整 ----------
test("applyMindFontSize 写入 --mind-node-font 并同步标签与按钮禁用态", () => {
  const b = fnBody(CODE, "function applyMindFontSize(");
  assert.ok(/setProperty\("--mind-node-font"/.test(b), "应写 CSS 变量");
  assert.ok(/fontLabel\.textContent/.test(b), "应更新标签");
  assert.ok(/fontDecBtn\.disabled/.test(b) && /fontIncBtn\.disabled/.test(b), "应同步按钮禁用态");
});

test("setMindFontSize 钳制到 [MIN,MAX] 并取整 + 持久化", () => {
  const b = fnBody(CODE, "function setMindFontSize(");
  assert.ok(/Math\.max\(MIND_FONT_MIN,\s*Math\.min\(MIND_FONT_MAX,\s*Math\.round\(size\)\)\)/.test(b),
    "应钳制并取整");
  assert.ok(/applyMindFontSize\(\)/.test(b), "应立即应用");
  assert.ok(/apiUpdateMapFontSize\(activeMap\.id,\s*s\)/.test(b), "应持久化");
});

test("setActiveMap 恢复该导图字号", () => {
  const b = fnBody(CODE, "async function setActiveMap(");
  assert.ok(/applyMindFontSize\(\)/.test(b), "setActiveMap 应调用 applyMindFontSize");
});

test("bindToolbar 绑定 A− / A＋ 按钮", () => {
  const b = fnBody(CODE, "function bindToolbar(");
  assert.ok(/fontDecBtn\.addEventListener\("click"/.test(b), "应绑定减小按钮");
  assert.ok(/fontIncBtn\.addEventListener\("click"/.test(b), "应绑定增大按钮");
  assert.ok(/setMindFontSize\(/.test(b), "应调用 setMindFontSize");
});

// ---------- Rust 后端 ----------
test("mindmaps 表新增 font_size 列（建表 + 迁移补列）", () => {
  assert.ok(/font_size INTEGER DEFAULT 13/.test(DB), "建表应含 font_size 列");
  assert.ok(/ALTER TABLE mindmaps ADD COLUMN font_size INTEGER DEFAULT 13/.test(DB),
    "旧库迁移应补 font_size 列");
});

test("Mindmap 结构体含 font_size 字段", () => {
  const start = DB.indexOf("pub struct Mindmap {");
  const body = DB.substring(start, DB.indexOf("}", start));
  assert.ok(/pub font_size:\s*i64/.test(body), "Mindmap 应有 font_size 字段");
});

test("list_mindmaps 读取 font_size（COALESCE 兜底 13）", () => {
  const b = DB.substring(DB.indexOf("pub fn list_mindmaps("), DB.indexOf("pub fn create_mindmap("));
  assert.ok(/COALESCE\(font_size,\s*13\)/.test(b), "SELECT 应用 COALESCE(font_size,13)");
  assert.ok(/font_size:\s*row\.get\(6\)/.test(b), "应读取第 7 列");
});

test("db::update_mindmap_font_size 更新 font_size", () => {
  const b = DB.substring(DB.indexOf("pub fn update_mindmap_font_size("));
  assert.ok(/UPDATE mindmaps SET font_size = \?1 WHERE id = \?2/.test(b), "应更新 font_size");
});

test("lib.rs 注册 update_mindmap_font_size 命令", () => {
  assert.ok(/update_mindmap_font_size,/.test(LIB), "命令应加入 invoke_handler");
  assert.ok(/fn update_mindmap_font_size\(/.test(LIB), "应定义该命令");
});

// ---------- 汇总 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);