// 回归测试：图片夹右下角「富文本笔记」
// 需求：图片夹右下角有悬浮图标，点击弹出富文本框；内容按当前图片夹保存，
//       支持基础格式（加粗/斜体/下划线/列表/清除格式），重开软件后仍在。
// 运行方式：node test/image-note.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const JS = fs.readFileSync(path.join(ROOT, "src/image-wall.js"), "utf8");

const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const CSS_CODE = stripComments(CSS);
const JS_CODE = stripComments(JS);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}
const cssBlock = sel => {
  const start = CSS_CODE.indexOf(sel);
  if (start < 0) return "";
  return CSS_CODE.slice(start, CSS_CODE.indexOf("}", start) + 1);
};

// ---------- 结构与入口 ----------

test("图片画布内含右下角悬浮图标按钮", () => {
  const canvas = HTML.slice(HTML.indexOf('id="image-canvas"'));
  assert.ok(/id="image-note-fab"/.test(canvas), "缺失 #image-note-fab");
  assert.ok(/title="图片夹笔记（富文本）"/.test(canvas), "图标应有说明 title");
  assert.ok(/<svg[\s\S]*?<\/svg>/.test(canvas), "图标应使用内联 SVG");
});

test("图标后面紧跟富文本笔记面板", () => {
  const fab = HTML.indexOf('id="image-note-fab"');
  const panel = HTML.indexOf('id="image-note-panel"');
  assert.ok(fab > 0 && panel > fab, "面板应位于图标之后");
  assert.ok(/id="image-note-editor"[\s\S]*?contenteditable="true"/.test(HTML), "编辑器应为 contenteditable");
  assert.ok(/id="image-note-panel"[^>]*hidden/.test(HTML), "面板默认收起");
});

test("工具栏提供基础格式：加粗/斜体/下划线/列表/清除", () => {
  const tools = HTML.slice(HTML.indexOf('class="image-note-tools"'), HTML.indexOf('id="image-note-editor"'));
  for (const cmd of ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList", "removeFormat"]) {
    assert.ok(new RegExp(`data-cmd="${cmd}"`).test(tools), `缺少格式按钮 ${cmd}`);
  }
});

// ---------- 布局与样式 ----------

test("悬浮图标固定在画布右下角（right/bottom: 18px）", () => {
  const block = cssBlock(".image-note-fab");
  assert.ok(/position:\s*absolute/.test(block), "图标应绝对定位");
  assert.ok(/right:\s*18px/.test(block) && /bottom:\s*18px/.test(block), "图标应位于右下角 18px");
});

test("面板位于图标上方且 hidden 时真正隐藏", () => {
  const block = cssBlock(".image-note-panel");
  assert.ok(/position:\s*absolute/.test(block), "面板应绝对定位");
  assert.ok(/right:\s*18px/.test(block) && /bottom:\s*76px/.test(block), "面板应在图标上方");
  assert.ok(/\.image-note-panel\[hidden\]\s*\{\s*display:\s*none/.test(CSS_CODE), "hidden 时必须 display:none");
});

test("编辑器可滚动并带占位文案", () => {
  const block = cssBlock(".image-note-editor");
  assert.ok(/overflow-y:\s*auto/.test(block), "长笔记应可滚动");
  assert.ok(/content:\s*attr\(data-placeholder\)/.test(CSS_CODE), "应显示 placeholder");
});

// ---------- 保存逻辑 ----------

test("笔记按图片夹 id 存入 localStorage", () => {
  assert.ok(/const NOTE_KEY = "glassCanvas\.imageNotes"/.test(JS_CODE), "缺少笔记存储键");
  assert.ok(/map\[String\(_noteFolderId\)\] = html/.test(JS_CODE), "应按夹 id 写入");
  assert.ok(/delete map\[String\(_noteFolderId\)\]/.test(JS_CODE), "清空笔记时应删除条目");
});

test("输入后 300ms 防抖自动保存", () => {
  assert.ok(/noteEditor\.addEventListener\("input", scheduleNoteSave\)/.test(JS_CODE), "input 应触发自动保存");
  assert.ok(/setTimeout\(\(\)\s*=>\s*\{[^}]*flushNoteNow\(\)/.test(JS_CODE), "应以防抖方式落库");
});

test("切换图片夹前强制保存，并载入新夹笔记", () => {
  const fn = JS_CODE.slice(JS_CODE.indexOf("async function setActiveFolder"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.ok(/flushNoteNow\(\)/.test(body), "切夹前应 flushNoteNow");
  assert.ok(/loadNoteForActive\(\)/.test(body), "面板打开时应载入新夹笔记");
});

test("关闭/隐藏窗口前兜底保存", () => {
  for (const ev of ["pagehide", "beforeunload", "visibilitychange"]) {
    assert.ok(new RegExp(`addEventListener\\("${ev}"`).test(JS_CODE), `缺少 ${ev} 兜底`);
  }
});

// ---------- 与画布/快捷键隔离 ----------

test("笔记内滚轮只滚动内容，不缩放画布", () => {
  const fn = JS_CODE.slice(JS_CODE.indexOf('imageCanvas.addEventListener("wheel"'));
  const body = fn.slice(0, fn.indexOf("}, { passive: false })"));
  assert.ok(/closest\("\.image-note-panel"\)/.test(body), "滚轮应先判断是否在笔记面板内");
});

test("contenteditable 内不劫持 Ctrl+C/V 与 Delete", () => {
  assert.ok(/ae\.isContentEditable/.test(JS_CODE), "isTypingTarget 应识别 contenteditable");
  const kb = JS_CODE.slice(JS_CODE.indexOf("function bindKeyboard"));
  assert.ok(/if \(isTypingTarget\(\)\) return;/.test(kb), "键盘处理应在输入态直接返回");
  const paste = JS_CODE.slice(JS_CODE.indexOf('document.addEventListener("paste"'));
  assert.ok(/if \(isTypingTarget\(\)\) return;/.test(paste), "粘贴处理应在输入态直接返回");
});

test("粘贴/拖入笔记时转为纯文本，避免外部 HTML 注入", () => {
  assert.ok(/addEventListener\("paste"[\s\S]{0,240}?getData\("text\/plain"\)/.test(JS_CODE), "粘贴应只取纯文本");
  assert.ok(/addEventListener\("drop"[\s\S]{0,240}?getData\("text\/plain"\)/.test(JS_CODE), "拖入应只取纯文本");
});

test("init 中完成笔记事件绑定", () => {
  const init = JS_CODE.slice(JS_CODE.indexOf("function init()"));
  assert.ok(/bindNote\(\)/.test(init), "init 应调用 bindNote");
});

// ---------- 输出 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) console.log(`  ${r.pass ? "✓" : `✗ ${r.err}`}  ${r.name}`);
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);