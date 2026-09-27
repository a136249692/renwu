/* ═══════════════════════════════════════════════════ *
 *  思维导图模块（任务/思维 双模式）
 *  桌面端走 invoke → Rust/SQLite；浏览器预览走 localStorage 兜底。
 *  左侧：思维导图名称列表（新建/重命名/删除）
 *  右侧：思维导图画布（节点拖拽 / 连线 / 缩放 / 平移 / 编辑）
 * ═══════════════════════════════════════════════════ */
import { invoke as invokeImpl } from "@tauri-apps/api/core";

const $ = id => document.getElementById(id);

function detectTauri() {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  const t = window.__TAURI__;
  return !!(t && (t.core || t.invoke));
}
const isTauri = detectTauri;

/* 远端优先，失败回退 localStorage 的轻量封装 */
async function mi(cmd, args) {
  if (isTauri()) {
    try { return await invokeImpl(cmd, args); }
    catch (e) { console.warn(`[思维导图] invoke("${cmd}") 失败:`, e); }
  }
  return null;
}
/* 严格版：Tauri 端错误直接抛出（用于保存图片等需要暴露真实失败原因的场景）。 */
async function miStrict(cmd, args) {
  if (isTauri()) return await invokeImpl(cmd, args);
  return null;
}

/* ---------- localStorage 兜底 ---------- */
const LS_MAPS = "glassCanvas.mindmaps";
const LS_NODES = "glassCanvas.mindNodes";
const LS_EDGES = "glassCanvas.mindEdges";
const LS_NODE_IMGS = "glassCanvas.mindNodeImgs";   // 思维节点图片元数据（浏览器兜底）
const LS_MAP_ORDER = "glassCanvas.mindOrder";   // { mapId: 0..n-1 } 手动排序
function lsLoadOrder() {
  try { return JSON.parse(localStorage.getItem(LS_MAP_ORDER) || "{}"); } catch { return {}; }
}
function lsSaveOrder(m) { try { localStorage.setItem(LS_MAP_ORDER, JSON.stringify(m)); } catch {} }
function lsLoadOf(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}
function lsSaveOf(key, arr) { try { localStorage.setItem(key, JSON.stringify(arr)); } catch {} }
let lsMaps = lsLoadOf(LS_MAPS);
let lsNodesArr = lsLoadOf(LS_NODES);
let lsEdgesArr = lsLoadOf(LS_EDGES);
let lsNodeImgs = lsLoadOf(LS_NODE_IMGS);
let _lsIdSeq = 0;

/* toast 反馈：复用与 main.js / image-wall.js 同一套 DOM 节点（#app-toast） */
let _toastTimer = null;
function toast(msg, ms) {
  let t = document.getElementById("app-toast");
  if (!t) { t = document.createElement("div"); t.id = "app-toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), ms || 3000);
}
function guessMime(p) {
  const ext = (String(p).split(".").pop() || "").toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" }[ext]) || "application/octet-stream";
}
function bytesToBase64(u8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ? s : "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
/* 节点内容 → HTML：换行转 <br/>。思维块支持回车换行（见 enterEdit 里对 Enter 的拦截），
   存储格式是 \n；渲染时把 \n 转回 <br/>，让视觉上真的是多行而不是被压成一坨。 */
function escWithBreaks(s) {
  return esc(s).replace(/\n/g, "<br/>");
}
function nowTs() { return Date.now(); }

/* ---------- DOM 引用 ---------- */
const confirmModal = $("confirm-modal");
const confirmTitle = $("confirm-title");
const confirmMsgEl = $("confirm-msg");
const confirmOkBtn = $("confirm-ok");
const confirmCancelBtn = $("confirm-cancel");
const tabTasks = $("tab-tasks");
const tabMind = $("tab-mind");
const tabImages = $("tab-images");
const newFolderBtn = $("new-folder-btn");
const folderListEl = $("folder-list");
const modeBodyMind = $("mode-body-mind");
const modeBodyImages = $("mode-body-images");
const folderPane = $("mode-pane-tasks");
const mindPane = $("mode-pane-mind");
const imagePane = $("mode-pane-images");
const mapListEl = $("map-list");
const newMapBtn = $("new-map-btn");
const mindTitle = $("mind-title");
const mindMeta = $("mind-meta");
const mindToolbar = $("mind-toolbar");
const zoomOutBtn = $("mind-zoom-out");
const zoomInBtn = $("mind-zoom-in");
const zoomLabel = $("mind-zoom-label");
const fitBtn = $("mind-fit");
const mindCanvas = $("mind-canvas");
const mindWorld = $("mind-world");
const mindEdgesSvg = $("mind-edges");
const mindNodesWrap = $("mind-nodes");
const mindEmpty = $("mind-empty");
const mindImageInput = $("mind-image-input");
const mindLightbox = $("mind-lightbox");
const mindLightboxStage = $("mind-lightbox-stage");
const mindLightboxImg = $("mind-lightbox-img");
const mindLightboxClose = $("mind-lightbox-close");
const mindLightboxBackdrop = $("mind-lightbox-backdrop");
const mindLightboxZoomIn = $("mind-lightbox-zoom-in");
const mindLightboxZoomOut = $("mind-lightbox-zoom-out");
const mindLightboxZoomLabel = $("mind-lightbox-zoom-label");
const mindLightboxReset = $("mind-lightbox-reset");
const mindLightboxPrev = $("mind-lightbox-prev");
const mindLightboxNext = $("mind-lightbox-next");
const mindLightboxCount = $("mind-lightbox-count");

/* ---------- 状态 ---------- */
let mode = "tasks";          // tasks | mind
let maps = [];               // Mindmap[]
let activeMapId = null;      // 当前打开的思维导图 id
let activeMap = null;        // { id,name,pan_x,pan_y,zoom }
let view = { x: 40, y: 40, zoom: 1 };   // 平移 + 缩放
let nodes = [];              // MindmapNode[] (当前导图)
let edges = [];              // MindmapEdge[] (当前导图)
let pendingEdges = [];       // 编辑中新增的边（连线是否会合并）
const nodeEls = new Map();   // nodeId -> DOM el

let selectedNodeId = null;
let selectedEdgeId = null;
let editingNode = null;      // 正在编辑内容的节点对象
let connectingPort = null;   // { node, x, y } 连线起点
let tempEdgeEl = null;       // 临时连线 <path>
let drag = null;               // 当前拖拽/平移会话
let _viewTimer = null;         // 视野防抖保存定时器

/* 节点图片状态 */
const nodeImages = new Map();  // nodeId -> [{ id, node_id, file_name, file_path }]
const expandedImgs = new Set();// 处于「展开画廊」状态的 nodeId
const imgUrlCache = new Map(); // file_path -> objectURL/dataURL（或正在读取的 Promise）
let _pendingImgNodeId = null;  // 文件选择框当前要写入的目标节点
/* 思维块图片剪贴板：复制/剪切后可到其它思维块粘贴（Ctrl+V 或点「粘贴」）。
   bytes 提前读出，粘贴时不再依赖源图片/源节点是否还在。
   type 标记：
     - "image"（默认）：仅图片复制/剪切（旧逻辑）
     - "mindBlock"：整块思维块的复制（含文本 + 图片），粘贴新建节点 */
let _mindClip = null;          // { mode:"copy"|"cut", type:"image"|"mindBlock", nodeId, items:[...] }
let _sawPasteEvent = false;    // Ctrl/⌘+V 时 paste 事件是否已到达（用于键盘兜底判定）
let _vFallbackTimer = null;    // 键盘兜底的延迟定时器
/* 应用内跨模块图片剪贴板桥：图片夹「复制 / 剪切」后会把快照挂到 window.__glassImgClip，
   思维块粘贴时（系统剪贴板里没有图片）也能取用它——这样在图片夹里复制的图也能贴进思维块。 */
const SHARED_CLIP_KEY = "__glassImgClip";
function readSharedClip() {
  try {
    const c = window[SHARED_CLIP_KEY];
    return (c && Array.isArray(c.items) && c.items.length) ? c : null;
  } catch { return null; }
}
/* list / index：灯箱当前围绕的图片集合与下标，用于多图左右切换 */
let lb = { scale: 1, tx: 0, ty: 0, dragging: false, moved: false, list: [], index: 0 };

const NODE_W = 210;
const MIN_ZOOM = 0.25, MAX_ZOOM = 2.5;

/* ---------- 应用内确认弹窗 ----------
   返回 Promise<boolean>。不用 window.confirm()：原生 confirm 依赖宿主 WebView
   的原生对话框能力，在部分宿主环境里支持不完整（可能弹不出来甚至触发宿主
   自身的 UI 异常）。应用内弹窗由我们自己的 DOM 控制，行为完全可预期。 */
let _confirmResolve = null;
let _renaming = false;        // 是否有导图名称输入框处于编辑中（用于 renderMapList 跳过重建）
let _mapDragSuppressed = false;   // 拖动结束后吞掉一次随后的 click（避免拖拽变成选图）
let _mapDragSrc = null;         // 当前拖动源导图 id
let _mapDragSrcEl = null;
let _mapDragX = null, _mapDragY = null;
function askConfirm(message, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    confirmTitle.textContent = o.title || "确认操作";
    confirmMsgEl.innerHTML = message;
    confirmOkBtn.textContent = o.okText || "确认";
    _confirmResolve = resolve;
    confirmModal.hidden = false;
    // 把 resolve 挂到全局，让 image-wall.js 等其他模块也能触发同一弹窗。
    window.__confirmResolve = resolve;
  });
}
function closeConfirm(ok) {
  if (confirmModal.hidden) return;
  confirmModal.hidden = true;
  const r = _confirmResolve || window.__confirmResolve;
  _confirmResolve = null;
  window.__confirmResolve = null;
  if (r) r(ok);
}

/* ---------- API（SQLite 优先，localStorage 兜底） ---------- */
async function apiListMaps() {
  const r = await mi("list_mindmaps");
  if (r) return r;
  return lsMaps.slice();
}
async function apiCreateMap(name) {
  const r = await mi("create_mindmap", { name });
  if (r) return r;
  const id = (_lsIdSeq--); // 负数 id，不与 SQLite 自增冲突
  const m = { id, name: (name && name.trim()) || "未命名思维导图", created_at: nowTs(), pan_x: 40, pan_y: 40, zoom: 1 };
  lsMaps.push(m); lsSaveOf(LS_MAPS, lsMaps);
  return m;
}
async function apiRenameMap(id, name) {
  if (isTauri()) await mi("rename_mindmap", { id, name });
  const name_ = name || "未命名思维导图";
  const m = maps.find(x => x.id === id);
  if (m) m.name = name_;
  const lm = lsMaps.find(x => x.id === id);
  if (lm) { lm.name = name_; lsSaveOf(LS_MAPS, lsMaps); }
}
async function apiDeleteMap(id) {
  if (isTauri()) await mi("delete_mindmap", { id });
  maps = maps.filter(x => x.id !== id);
  lsMaps = lsMaps.filter(x => x.id !== id); lsSaveOf(LS_MAPS, lsMaps);
  lsNodesArr = lsNodesArr.filter(n => n.map_id !== id); lsSaveOf(LS_NODES, lsNodesArr);
  lsEdgesArr = lsEdgesArr.filter(e => e.map_id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
}
async function apiSaveView(id, x, y, zoom) {
  if (isTauri()) await mi("update_mindmap_view", { id, panX: x, panY: y, zoom });
  const m = maps.find(v => v.id === id);
  if (m) { m.pan_x = x; m.pan_y = y; m.zoom = zoom; }
  const lm = lsMaps.find(v => v.id === id);
  if (lm) { lm.pan_x = x; lm.pan_y = y; lm.zoom = zoom; lsSaveOf(LS_MAPS, lsMaps); }
}
async function apiListNodes(mapId) {
  const r = await mi("list_mindmap_nodes", { mapId });
  if (r) return r;
  return lsNodesArr.filter(n => n.map_id === mapId).slice();
}
async function apiCreateNode(mapId, content, x, y) {
  const r = await mi("create_mindmap_node", { mapId, content, x, y });
  if (r) {
    nodes.push(r);
    return r;
  }
  const id = (_lsIdSeq--);
  const n = { id, map_id: mapId, content, x, y, created_at: nowTs() };
  lsNodesArr.push(n); lsSaveOf(LS_NODES, lsNodesArr);
  nodes.push(n);
  return n;
}
async function apiUpdateNodeContent(id, content) {
  if (isTauri()) await mi("update_mindmap_node_content", { id, content });
  const n = nodes.find(v => v.id === id);
  if (n) n.content = content;
  const ln = lsNodesArr.find(v => v.id === id);
  if (ln) { ln.content = content; lsSaveOf(LS_NODES, lsNodesArr); }
}
async function apiUpdateNodePos(id, x, y) {
  if (isTauri()) await mi("update_mindmap_node_position", { id, x, y });
  const n = nodes.find(v => v.id === id);
  if (n) { n.x = x; n.y = y; }
  const ln = lsNodesArr.find(v => v.id === id);
  if (ln) { ln.x = x; ln.y = y; lsSaveOf(LS_NODES, lsNodesArr); }
}
async function apiDeleteNode(id) {
  if (isTauri()) await mi("delete_mindmap_node", { id });
  nodes = nodes.filter(n => n.id !== id);
  edges = edges.filter(e => e.from_id !== id && e.to_id !== id);
  lsNodesArr = lsNodesArr.filter(n => n.id !== id); lsSaveOf(LS_NODES, lsNodesArr);
  lsEdgesArr = lsEdgesArr.filter(e => e.from_id !== id && e.to_id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
  // 同步清掉该节点在浏览器兜底里的图片（含 dataURL），Tauri 端由命令层删文件
  const orphans = lsNodeImgs.filter(im => im.node_id === id);
  for (const im of orphans) { try { localStorage.removeItem(`glassCanvas.mindImg.${im.file_path}`); } catch {} }
  lsNodeImgs = lsNodeImgs.filter(im => im.node_id !== id); lsSaveOf(LS_NODE_IMGS, lsNodeImgs);
}
async function apiListEdges(mapId) {
  const r = await mi("list_mindmap_edges", { mapId });
  if (r) return r;
  return lsEdgesArr.filter(e => e.map_id === mapId).slice();
}
async function apiAddEdge(mapId, fromId, toId) {
  const r = await mi("add_mindmap_edge", { mapId, fromId, toId });
  if (r) {
    edges.push(r);
    return r;
  }
  const id = (_lsIdSeq--);
  const e = { id, map_id: mapId, from_id: fromId, to_id: toId };
  lsEdgesArr.push(e); lsSaveOf(LS_EDGES, lsEdgesArr);
  edges.push(e);
  return e;
}
async function apiDeleteEdge(id) {
  if (isTauri()) await mi("delete_mindmap_edge", { id });
  edges = edges.filter(e => e.id !== id);
  lsEdgesArr = lsEdgesArr.filter(e => e.id !== id); lsSaveOf(LS_EDGES, lsEdgesArr);
}

/* ---------- 思维节点图片 API（SQLite 优先，localStorage 兜底） ---------- */
async function apiListMapImages(mapId) {
  const r = await mi("list_map_node_images", { mapId });
  if (r) return r;
  const ids = new Set(lsNodesArr.filter(n => n.map_id === mapId).map(n => n.id));
  return lsNodeImgs.filter(im => ids.has(im.node_id)).map(im => ({ ...im }));
}
async function apiSaveNodeImage(nodeId, fileName, data) {
  if (isTauri()) {
    // 用 miStrict：保存失败要抛出真实错误，而不是被吞成 null 让用户查不出原因。
    return await miStrict("save_mindmap_node_image", {
      nodeId,
      fileName,
      data: Array.from(data, b => b & 0xff),
    });
  }
  const id = (_lsIdSeq--);
  const im = { id, node_id: nodeId, file_name: fileName, file_path: `mindmap/${nodeId}/${fileName}`, created_at: nowTs() };
  lsNodeImgs.push(im); lsSaveOf(LS_NODE_IMGS, lsNodeImgs);
  const mime = guessMime(fileName);
  try { localStorage.setItem(`glassCanvas.mindImg.${im.file_path}`, `data:${mime};base64,` + bytesToBase64(data)); }
  catch (e) { console.warn("[思维导图] localStorage 保存图片失败（可能超出配额）:", e); }
  return im;
}
async function apiDeleteNodeImage(id) {
  if (isTauri()) await mi("delete_mindmap_node_image", { id });
  const im = lsNodeImgs.find(x => x.id === id);
  if (im) {
    try { localStorage.removeItem(`glassCanvas.mindImg.${im.file_path}`); } catch {}
    lsNodeImgs = lsNodeImgs.filter(x => x.id !== id); lsSaveOf(LS_NODE_IMGS, lsNodeImgs);
  }
}
async function apiReadNodeImage(filePath) {
  if (isTauri()) {
    const bytes = await mi("read_mindmap_node_image", { filePath });
    if (!bytes) return null;
    const u8 = new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([u8], { type: guessMime(filePath) }));
  }
  try { return localStorage.getItem(`glassCanvas.mindImg.${filePath}`) || null; } catch { return null; }
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
/* 读取图片原始字节（复制/剪切到剪贴板时用；与 apiReadNodeImage 的区别是不转成 URL） */
async function apiReadNodeImageBytes(filePath) {
  if (isTauri()) {
    const bytes = await mi("read_mindmap_node_image", { filePath });
    return bytes ? new Uint8Array(bytes) : null;
  }
  const url = await apiReadNodeImage(filePath);
  if (!url) return null;
  const b64 = url.includes(",") ? url.slice(url.indexOf(",") + 1) : url;
  try { return base64ToBytes(b64); } catch { return null; }
}
/* 把 RGBA8 原始像素画进 canvas 再转成 PNG File（供剪贴板兜底用） */
async function rgbaToPngFile(rgba, width, height) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    const data = ctx.createImageData(width, height);
    data.data.set(rgba);
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    if (!blob) return null;
    return new File([blob], `clipboard-${Date.now()}.png`, { type: "image/png" });
  } catch (e) { console.warn("[思维导图] 剪贴板图片转 PNG 失败:", e); return null; }
}
/* 直接向后端要一张系统剪贴板图片，返回 PNG File 或 null。
   后端返回的二进制前 8 字节是小端 u32 的 width/height，其后为 RGBA8 像素。
   用于兜底「WebView 没把截图塞进 paste 事件」的场景（尤其 macOS WKWebView）。 */
async function apiReadClipboardImage() {
  if (!isTauri()) return null;
  let buf = null;
  try { buf = await invokeImpl("read_clipboard_image"); }
  catch (e) { console.warn("[思维导图] 读取系统剪贴板图片失败:", e); return null; }
  if (!buf) return null;
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  if (u8.length <= 8) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const width = dv.getUint32(0, true);
  const height = dv.getUint32(4, true);
  if (!width || !height || u8.byteLength < 8 + width * height * 4) return null;
  return rgbaToPngFile(new Uint8Array(u8.buffer, u8.byteOffset + 8, width * height * 4), width, height);
}
/* 图片 URL 缓存：node 会频繁重渲染，缓存避免重复读盘；并发时先用 Promise 占位。 */
function nodeImageUrl(im) {
  const key = im.file_path;
  if (imgUrlCache.has(key)) return imgUrlCache.get(key);
  const p = apiReadNodeImage(key)
    .then(u => { imgUrlCache.set(key, u); return u; })
    .catch(() => { imgUrlCache.set(key, null); return null; });
  imgUrlCache.set(key, p);
  return p;
}
function releaseImgUrl(filePath) {
  const u = imgUrlCache.get(filePath);
  if (u && typeof u === "string" && u.startsWith("blob:")) { try { URL.revokeObjectURL(u); } catch {} }
  imgUrlCache.delete(filePath);
}

/* ═══════════ 模式切换 ═══════════ */
function setMode(m) {
  if (mode === m) return;
  mode = m;
  tabTasks.classList.toggle("active", m === "tasks");
  tabMind.classList.toggle("active", m === "mind");
  tabImages.classList.toggle("active", m === "images");
  tabTasks.setAttribute("aria-selected", String(m === "tasks"));
  tabMind.setAttribute("aria-selected", String(m === "mind"));
  tabImages.setAttribute("aria-selected", String(m === "images"));
  // 侧栏列表
  newFolderBtn.hidden = m !== "tasks";
  folderListEl.hidden = m !== "tasks";
  modeBodyMind.hidden = m !== "mind";
  modeBodyImages.hidden = m !== "images";
  // 画布容器
  folderPane.hidden = m !== "tasks";
  mindPane.hidden = m !== "mind";
  imagePane.hidden = m !== "images";
  if (m === "mind") requestAnimationFrame(() => loadMaps());
  // 图片墙模块自行注册加载钩子（image-wall.js 里挂到 window），
  // 这里只负责在切到图片模式时触发，避免本模块反向依赖图片墙实现。
  if (m === "images") requestAnimationFrame(() => window.__loadImageWall && window.__loadImageWall());
  // 切回任务 tab 时：canvas 从 display:none 恢复后 clientHeight 在单帧内
  // 可能还没就绪（浏览器尚未完成 reflow），此时 relayout 会用 0 尺寸算分界线、
  // 把堆叠块挤到画布顶部 → 视觉上"内容块错乱"。用双 rAF：第一帧触发 reflow，
  // 第二帧 clientHeight 已正确，再 renderAll + relayout 重算分界线位置。
  //
  // ⚠ renderAll 是 main.js 的模块私有函数，必须通过 window 钩子访问
  //    （main.js 末尾已挂 window.renderAll / window.__alignPendingBlocks 等）。
  //    旧代码在模块作用域下引用未暴露的全局符号会永远为 undefined，
  //    导致切回任务 tab 时布局从不重算 → todo 区内容块堆积/重叠。
  if (m === "tasks") {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (typeof window.renderAll === "function") window.renderAll();
      // 若用户开启了「靠左对齐」且当前不是便利贴夹，切回后再对齐一次，
      // 保证对齐偏好在跨 tab 往返后仍生效（relayout 本身不强制重新对齐）。
      const tg = window.__getAlignToggle && window.__getAlignToggle();
      const alignOn = tg && tg.checked;
      const sticky = window.__isStickyFolderActive && window.__isStickyFolderActive();
      if (alignOn && !sticky && typeof window.__alignPendingBlocks === "function") {
        window.__alignPendingBlocks([]);
      }
    }));
  }
}

/* ═══════════ 左侧：导图列表 ═══════════ */
/* 排序：手动拖拽顺序持久化在 localStorage（与任务夹 orderMap 一致的做法）。
   后端 list_mindmaps 返回按 created_at/id 升序的原始顺序，这里再按 orderMap
   覆盖显示顺序——orderMap 是唯一可信的视觉顺序来源。 */
let mapOrder = lsLoadOrder();
function cmpByOrder(a, b) {
  const oa = mapOrder[String(a.id)], ob = mapOrder[String(b.id)];
  if (oa == null && ob == null) return (a.created_at || 0) - (b.created_at || 0) || (a.id || 0) - (b.id || 0);
  if (oa == null) return 1;
  if (ob == null) return -1;
  return oa - ob;
}
async function loadMaps() {
  try { maps = await apiListMaps(); } catch { maps = []; }
  maps.sort(cmpByOrder);
  renderMapList();
  // 保留上一个选中的导图
  if (activeMapId && maps.find(m => m.id === activeMapId)) {
    setActiveMap(activeMapId);
  } else if (maps.length) {
    setActiveMap(maps[0].id);
  } else {
    setActiveMap(null);
  }
}
function renderMapList() {
  // 若某个导图正处于重命名输入中，跳过整体重绘——否则 input 被销毁会触发 blur，
  // 打断正在进行的提交，并把光标焦点一并丢掉了。
  // 注意：必须用 _renaming 标志，而不能用「列表里是否还存在 input」来判断——
  // 重命名刚提交/取消时 input 仍挂在 DOM 上，若据此 return 会导致列表永不重建，
  // 输入框卡住(回车后仍处于编辑态)、并遮挡住该导图名字。
  if (_renaming) return;
  mapListEl.innerHTML = "";
  for (const m of maps) {
    const li = document.createElement("li");
    li.className = "folder-item" + (m.id === activeMapId ? " active" : "");
    li.dataset.mapId = m.id;
    li.title = "拖动可调整位置 · 双击重命名";
    // li 不设 draggable="true"——WebView2 上 HTML5 DnD 会接管 pointer 事件流，
    // 导致下面的 pointerdown 拖动走不到 onUp（与任务夹列表同一处理）。
    li.setAttribute("draggable", "false");
    li.innerHTML =
      `<span class="drag-handle" title="拖动可调整位置">⋮⋮</span>` +
      `<span class="ico">🧠</span>` +
      `<span class="name">${esc(m.name)}</span>` +
      `<button class="rm" title="删除思维导图">×</button>`;
    li.addEventListener("click", e => {
      if (e.target.classList.contains("rm") || e.target.classList.contains("drag-handle")) return;
      if (_mapDragSuppressed) { _mapDragSuppressed = false; return; }
      setActiveMap(m.id);
    });
    li.addEventListener("dblclick", e => {
      if (e.target.classList.contains("rm")) return;
      startRenameMap(li, m);
    });
    li.querySelector(".rm").addEventListener("click", async e => {
      e.stopPropagation();
      const ok = await askConfirm(
        `确定删除思维导图「<b>${esc(m.name)}</b>」吗？<br/>其所有节点与连线将一并删除，此操作不可撤销。`,
        { title: "删除思维导图", okText: "删除" }
      );
      if (!ok) return;
      try {
        await apiDeleteMap(m.id);
        // 删除后从 orderMap 里清掉该项，避免旧 index 影响后续排序
        delete mapOrder[String(m.id)]; lsSaveOrder(mapOrder);
      } catch (err) {
        console.warn("[思维导图] 删除导图失败:", err);
      }
      if (activeMapId === m.id) await setActiveMap(null);
      await loadMaps();
    });
    // 拖动排序：pointer 模式（与任务夹列表一致）
    li.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      if (e.target.closest(".rm")) return;
      startMapPointerDrag(e, m.id, li);
    });
    mapListEl.appendChild(li);
  }
}
function startRenameMap(li, m) {
  const nameEl = li.querySelector(".name");
  const old = m.name;
  const input = document.createElement("input");
  input.value = old;
  input.className = "map-rename-input";
  input.maxLength = 30;
  nameEl.replaceWith(input);
  input.select();
  _renaming = true;
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    _renaming = false;   // 先复位标志，renderMapList 才会真正重建（否则输入框永远清不掉）
    const val = (input.value || "").trim() || old;
    if (save && val !== old) {
      // apiRenameMap 是异步的：m.name 要在其内部 await 完成后才更新。
      // 必须把列表刷新放进 .then() 里，否则渲染发生在名字落库之前，界面仍是旧名。
      apiRenameMap(m.id, val).then(() => {
        if (m.id === activeMapId) renderMindHeader();
        renderMapList();
      });
    } else {
      renderMapList();
    }
  };
  input.addEventListener("blur", () => commit(true));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { commit(false); }
  });
}
/* 强制结束当前进行中的重命名（用于「新建导图」等会重建列表的操作前）。
   直接 blur 即可触发 commit → _renaming=false → 列表重建。 */
function finalizeRename() {
  const input = mapListEl.querySelector(".map-rename-input");
  if (!input) return;
  _renaming = false;
  input.blur();
}

/* 拖动思维导图到目标位置：把源插到目标之前/之后。
   与任务夹 reorderFolders 同思路——以当前 DOM 顺序为基准（DOM 就是刚渲染出的、
   最权威的视觉顺序），再按视觉顺序重算 mapOrder 让 index 从 0 连续递增。
   后端不存 sort_order，排序只持久化在 localStorage，切会话不丢。 */
function reorderMaps(srcId, targetId) {
  // 用 DOM 中的当前顺序作为基准
  const items = Array.from(mapListEl.querySelectorAll(".folder-item"))
    .map(li => Number(li.dataset.mapId));
  const srcIdx = items.indexOf(srcId);
  const tgtIdx = items.indexOf(targetId);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;

  // 落点在目标中线之上/下决定插入位置
  const tgtEl = mapListEl.querySelector(`li[data-map-id="${targetId}"]`);
  let pastMid = false;
  if (tgtEl) {
    const r = tgtEl.getBoundingClientRect();
    const isVertical = getComputedStyle(mapListEl).flexDirection !== "row";
    pastMid = isVertical
      ? (_mapDragY != null && _mapDragY > r.top + r.height / 2)
      : (_mapDragX != null && _mapDragX > r.left + r.width / 2);
  }

  items.splice(srcIdx, 1);
  let insertAt = items.indexOf(targetId);
  if (insertAt < 0) return;
  if (pastMid) insertAt += 1;
  items.splice(insertAt, 0, srcId);

  // 写回 orderMap：让 index 从 0 连续递增
  const order = {};
  items.forEach((id, i) => { order[String(id)] = i; });
  mapOrder = order; lsSaveOrder(mapOrder);

  // 关键：renderMapList 是按 maps 数组顺序渲染的，不是按 mapOrder。
  // 只更新 mapOrder 再 renderMapList 会让索引变了但列表文字序不变——
  // 视觉上「拖不动」。必须把 maps 数组重排成与 items(新视觉顺序)一致，再渲染。
  maps.sort((a, b) => items.indexOf(Number(a.id)) - items.indexOf(Number(b.id)));
  renderMapList();
}

/* 思维导图 pointer 排序：pointerdown + setPointerCapture + window pointermove/pointerup，
   与任务夹 startFolderPointerDrag 一致。不用 HTML5 DnD——WebView2 打包后 li 作为
   拖源不稳定，会让 pointermove/pointerup 不再触发。交互细节：
   - 4px 阈值内不当拖动，避免普通点击误触；
   - 移动时用 elementFromPoint 命中最近的 .folder-item，按鼠标相对中线挂
     fold-drop-before / fold-drop-after 显示插入指示线；
   - 松手按当前 hover 目标调用 reorderMaps。 */
function startMapPointerDrag(e, srcId, srcEl) {
  if (_mapDragSrc != null) return;
  // 若正在重命名（input 已替换掉 name），不要开启拖动——否则 blur 后 input 消失
  if (mapListEl.querySelector(".map-rename-input")) return;
  e.preventDefault();
  const startX = e.clientX, startY = e.clientY;
  const startElt = e.target;
  let activated = false;

  try { startElt.setPointerCapture(e.pointerId); } catch (_) {}

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!activated) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      activated = true;
      _mapDragSrc = srcId;
      _mapDragSrcEl = srcEl;
      srcEl.classList.add("fold-dragging");
      mapListEl.classList.add("reordering");
      _mapDragX = ev.clientX; _mapDragY = ev.clientY;
    }
    ev.preventDefault();
    _mapDragX = ev.clientX; _mapDragY = ev.clientY;
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    mapListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    if (!tgt || Number(tgt.dataset.mapId) === Number(srcId)) return;
    const r = tgt.getBoundingClientRect();
    const isVertical = getComputedStyle(mapListEl).flexDirection !== "row";
    const pastMid = isVertical
      ? (ev.clientY > r.top + r.height / 2)
      : (ev.clientX > r.left + r.width / 2);
    tgt.classList.add(pastMid ? "fold-drop-after" : "fold-drop-before");
  };

  const onUp = (ev) => {
    try { startElt.releasePointerCapture(e.pointerId); } catch (_) {}
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const tgt = activated && el ? (el.classList.contains("folder-item") ? el : el.closest(".folder-item")) : null;
    const tgtId = tgt ? Number(tgt.dataset.mapId) : null;
    const wasDragging = activated;
    srcEl.classList.remove("fold-dragging");
    mapListEl.classList.remove("reordering");
    mapListEl.querySelectorAll(".fold-drop-before,.fold-drop-after").forEach(x => {
      x.classList.remove("fold-drop-before"); x.classList.remove("fold-drop-after");
    });
    _mapDragSrc = null; _mapDragSrcEl = null;
    if (wasDragging) {
      _mapDragSuppressed = true;   // 拖拽结束的 click 不再触发选图
      if (tgtId != null && tgtId !== Number(srcId)) reorderMaps(srcId, tgtId);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/* ═══════════ 打开导图 ═══════════ */
async function setActiveMap(id) {
  // 若正有重命名输入框挂起，先提交它——否则 renderMapList 会因 _renaming 跳过重建，
  // 导致切图后 input 还挂在原列表项上、active 高亮不更新。
  finalizeRename();
  // 切换前先保存上一个导图的视野。必须在此刻捕获 id 与坐标到局部变量：
  // 下面的 activeMapId 会被覆盖，若依赖 saveViewDebounced 的闭包，
  // 定时器回调时读到的是新导图 id，旧视图会被错误地写到新导图上。
  const prevId = activeMapId;
  if (prevId != null) {
    clearTimeout(_viewTimer);
    const pv = { x: Math.round(view.x), y: Math.round(view.y), zoom: view.zoom };
    apiSaveView(prevId, pv.x, pv.y, pv.zoom);
  }
  activeMapId = id;
  activeMap = id != null ? (maps.find(m => m.id === id) || null) : null;
  selectedNodeId = null; selectedEdgeId = null; editingNode = null;
  clearMindImages();
  renderMapList();
  if (!activeMap) {
    nodes = []; edges = []; renderMindCanvas();
    mindEmpty.innerHTML = `<b>还没有思维导图</b><br/>点击左侧「＋ 新建思维导图」开始创建`;
    mindEmpty.hidden = false;
    return;
  }
  view = { x: activeMap.pan_x != null ? activeMap.pan_x : 40, y: activeMap.pan_y != null ? activeMap.pan_y : 40, zoom: activeMap.zoom || 1 };
  try {
    nodes = await apiListNodes(id);
    edges = await apiListEdges(id);
  } catch { nodes = []; edges = []; }
  try { loadNodeImages(await apiListMapImages(id)); } catch {}
  renderMindHeader();
  renderMindCanvas();
}
/* 把扁平图片列表按 node_id 归组到 nodeImages */
function loadNodeImages(list) {
  nodeImages.clear();
  for (const im of (list || [])) {
    if (!nodeImages.has(im.node_id)) nodeImages.set(im.node_id, []);
    nodeImages.get(im.node_id).push(im);
  }
}
/* 切换导图时清空节点图片相关状态与已缓存的 blob URL */
function clearMindImages() {
  nodeImages.clear();
  expandedImgs.clear();
  for (const key of Array.from(imgUrlCache.keys())) releaseImgUrl(key);
}
function renderMindHeader() {
  mindTitle.textContent = activeMap ? activeMap.name : "思维导图";
  mindMeta.textContent = activeMap ? `${nodes.length} 节点 · ${edges.length} 连线` : "";
  mindToolbar.hidden = !activeMap;
}

/* ═══════════ 画布渲染 ═══════════ */
function applyView() {
  mindWorld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  zoomLabel.textContent = Math.round(view.zoom * 100) + "%";
}
function renderMindCanvas() {
  applyView();
  if (!activeMap) {
    mindNodesWrap.innerHTML = "";
    mindEdgesSvg.innerHTML = "";
    mindEmpty.hidden = false;
    return;
  }
  // 节点
  nodeEls.clear();
  mindNodesWrap.innerHTML = "";
  for (const n of nodes) {
    const el = makeNodeEl(n);
    mindNodesWrap.appendChild(el);
  }
  renderEdges();
  // 空状态提示
  if (nodes.length === 0) {
    mindEmpty.innerHTML = `<b>双击空白处</b> 即可新建思维节点<br/>拖动节点可自由移动（正文/边框/把手均可拖）· 双击正文编辑文字<br/>悬停节点显示连接点，从连接点拖到另一节点连线<br/>节点内点「＋ 图片」可为该内容块加图（可多张，点击展开、再点放大）<br/>选中节点后 <kbd>Ctrl/⌘ + V</kbd> 可粘贴截图或任意位置复制的图片 · 悬停缩略图可「复制 / 剪切」到其它思维块`;
    mindEmpty.hidden = false;
  } else {
    mindEmpty.hidden = true;
  }
}
function makeNodeEl(n) {
  const el = document.createElement("div");
  el.className = "mind-node" + (n.id === selectedNodeId ? " selected" : "");
  el.dataset.nodeId = n.id;
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  el.innerHTML =
    `<div class="drag-hint" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>` +
    `<div class="mind-port port-top" data-side="top"></div>` +
    `<div class="mind-port port-right" data-side="right"></div>` +
    `<div class="mind-port port-bottom" data-side="bottom"></div>` +
    `<div class="mind-port port-left" data-side="left"></div>` +
    `<div class="mind-node-body" contenteditable="false" spellcheck="false">${escWithBreaks(n.content)}</div>` +
    `<div class="mind-node-imgs" hidden></div>` +
    `<button class="rm-node" title="删除节点">×</button>`;
  nodeEls.set(n.id, el);
  bindNodeEvents(el, n);
  renderNodeImages(n, el);
  return el;
}

/* ---------- 节点图片渲染 ---------- */
/* 思维图片不支持「下载 / 另存为」：关掉原生右键菜单（WebView 的「图片另存为/下载图片」），
   同时禁止把图拖出去保存——避免误存一份到系统里。复制/剪切用悬停操作条即可。 */
function forbidImageDownload(imgEl) {
  if (!imgEl) return;
  imgEl.draggable = false;
  imgEl.addEventListener("contextmenu", e => e.preventDefault());
  imgEl.addEventListener("dragstart", e => e.preventDefault());
}
/* 折叠态：一张封面缩略图 + 张数角标（点击展开）。
   展开态：一行多列横向画廊（点击单张进灯箱缩放查看）。
   无图时只显示「＋ 图片」按钮，让用户随时为该内容块补充图片。 */
function renderNodeImages(n, el) {
  if (!el) return;
  const wrap = el.querySelector(".mind-node-imgs");
  if (!wrap) return;
  wrap.innerHTML = "";
  const list = nodeImages.get(n.id) || [];
  wrap.hidden = false;

  if (list.length === 0) {
    const bar = document.createElement("div");
    bar.className = "mind-node-img-bar";
    bar.appendChild(makeAddImgBtn(n.id, "🖼 ＋ 图片"));
    appendPasteBtn(bar, n.id);
    wrap.appendChild(bar);
    return;
  }

  const expanded = expandedImgs.has(n.id);
  if (!expanded) {
    // 折叠：封面缩略图 + 计数
    const cover = document.createElement("div");
    cover.className = "mind-node-cover";
    cover.title = `共 ${list.length} 张 · 点击展开查看`;
    const img = document.createElement("img");
    img.alt = "";
    forbidImageDownload(img);
    applyThumbSrc(img, list[0]);
    cover.appendChild(img);
    const cnt = document.createElement("span");
    cnt.className = "cover-count";
    cnt.textContent = String(list.length);
    cover.appendChild(cnt);
    const doExpand = e => { e.stopPropagation(); expandedImgs.add(n.id); renderNodeImages(n, el); renderEdges(); };
    cover.addEventListener("click", doExpand);
    wrap.appendChild(cover);

    const toggle = document.createElement("button");
    toggle.className = "mind-node-img-toggle";
    toggle.textContent = `展开 ${list.length} 张 ▸`;
    toggle.addEventListener("click", doExpand);
    wrap.appendChild(toggle);
    const bar = document.createElement("div");
    bar.className = "mind-node-img-bar";
    bar.appendChild(makeAddImgBtn(n.id, "＋ 图片"));
    appendPasteBtn(bar, n.id);
    wrap.appendChild(bar);
    return;
  }

  // 展开：一行多列
  const gallery = document.createElement("div");
  gallery.className = "mind-node-gallery";
  for (const im of list) {
    const thumb = document.createElement("div");
    thumb.className = "mind-node-thumb";
    thumb.title = "点击放大查看";
    const img = document.createElement("img");
    img.alt = "";
    forbidImageDownload(img);
    applyThumbSrc(img, im);
    thumb.appendChild(img);
    const del = document.createElement("button");
    del.className = "thumb-del";
    del.textContent = "×";
    del.title = "移除这张图片";
    del.addEventListener("click", e => { e.stopPropagation(); removeNodeImage(n, im); });
    thumb.appendChild(del);
    // 悬停操作条：复制 / 剪切到其它思维块
    const acts = document.createElement("div");
    acts.className = "thumb-acts";
    const cp = document.createElement("button");
    cp.className = "thumb-act";
    cp.textContent = "⧉";
    cp.title = "复制到其它思维块";
    cp.addEventListener("click", e => { e.stopPropagation(); copyNodeImage(n, im, "copy"); });
    const ct = document.createElement("button");
    ct.className = "thumb-act";
    ct.textContent = "✂";
    ct.title = "剪切到其它思维块";
    ct.addEventListener("click", e => { e.stopPropagation(); copyNodeImage(n, im, "cut"); });
    acts.appendChild(cp);
    acts.appendChild(ct);
    thumb.appendChild(acts);
    thumb.addEventListener("click", e => { e.stopPropagation(); openLightbox(im, list); });
    gallery.appendChild(thumb);
  }
  wrap.appendChild(gallery);

  const toggle = document.createElement("button");
  toggle.className = "mind-node-img-toggle";
  toggle.textContent = "收起 ▾";
  toggle.addEventListener("click", e => { e.stopPropagation(); expandedImgs.delete(n.id); renderNodeImages(n, el); renderEdges(); });
  wrap.appendChild(toggle);
  const bar = document.createElement("div");
  bar.className = "mind-node-img-bar";
  bar.appendChild(makeAddImgBtn(n.id, "＋ 图片"));
  appendPasteBtn(bar, n.id);
  wrap.appendChild(bar);
}
function makeAddImgBtn(nodeId, label) {
  const add = document.createElement("button");
  add.className = "mind-node-add-img";
  add.textContent = label;
  add.title = "给这个思维块添加图片（可多选）";
  add.addEventListener("click", e => { e.stopPropagation(); pickImagesForNode(nodeId); });
  return add;
}
async function applyThumbSrc(imgEl, im) {
  const u = await nodeImageUrl(im);
  if (u && imgEl.isConnected) imgEl.src = u;
}

/* ---------- 节点事件 ----------
   交互约定：
   - 任意位置 pointerdown 均可选中并拖拽整个节点（正文/边框/图片条/按钮区）
   - 单击正文 = 仅选中（不进编辑，方便连续选多个或马上拖）
   - 双击正文 = 进入文本编辑
   - 正在编辑中：正文允许选文字/输入，不触发拖拽
   - 图片条（画廊/缩略图/加图按钮）与删除按钮各自处理，不冒泡到节点拖动 */
function bindNodeEvents(el, n) {
  el.addEventListener("pointerdown", e => { downOnNode(e, el, n); });
  el.querySelector(".rm-node").addEventListener("click", e => {
    e.stopPropagation();
    removeNode(n.id);
  });
  el.querySelectorAll(".mind-port").forEach(port => {
    port.addEventListener("pointerdown", e => { startConnect(e, n); });
  });
  const body = el.querySelector(".mind-node-body");
  body.addEventListener("click", e => {
    e.stopPropagation();
    // 拖动刚结束（真实移动过）→ 屏蔽这次 click，避免误触发编辑
    if (Date.now() < _suppressClickUntil) return;
    // 单击：仅选中（若处于编辑态则保持编辑，不打断输入）
    if (editingNode && editingNode.id === n.id) return;
    selectNode(n.id);
  });
  body.addEventListener("dblclick", e => {
    e.stopPropagation();
    if (Date.now() < _suppressClickUntil) return;
    if (editingNode && editingNode.id === n.id) return;
    selectNode(n.id);
    // 把双击坐标传给 enterEdit，让光标落在用户点的那一位置，
    // 而不是永远被拉到最后——见 enterEdit 里的定位逻辑。
    enterEdit(n, body, { x: e.clientX, y: e.clientY });
  });
}
async function removeNode(id) {
  const n = nodes.find(x => x.id === id);
  const label = (n && String(n.content || "").trim()) ? esc(n.content.trim().replace(/\s+/g, " ").slice(0, 24)) : "";
  const ok = await askConfirm(
    `确定删除思维块${label ? `「<b>${label}</b>」` : ""}吗？<br/>其挂载的图片与相关连线将一并删除，此操作不可撤销。`,
    { title: "删除思维块", okText: "删除" }
  );
  if (!ok) return;
  if (selectedNodeId === id) selectedNodeId = null;
  if (editingNode && editingNode.id === id) editingNode = null;
  if (nodeImages.has(id)) { for (const im of nodeImages.get(id)) releaseImgUrl(im.file_path); nodeImages.delete(id); }
  expandedImgs.delete(id);
  await apiDeleteNode(id);   // 后端同步级联删除相关连线，API 内部会清理内存状态
  renderMindCanvas();
  renderMindHeader();
}

/* ---------- 节点图片：增删 ---------- */
function pickImagesForNode(nodeId) {
  if (!mindImageInput) return;
  _pendingImgNodeId = nodeId;
  mindImageInput.value = "";
  mindImageInput.click();
}
async function addImagesToNode(nodeId, files) {
  if (!files || !files.length) return 0;
  let ok = 0;
  for (const file of files) {
    if (!file) continue;
    if (file.type && !/^image\//.test(file.type)) continue;
    if (!file.size) { toast("添加失败：图片为空", 3000); continue; }
    if (file.size > 30 * 1024 * 1024) { toast(`添加失败：图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB，限制 30MB）`, 4000); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = (file.name.split(".").pop() || (file.type.split("/")[1] || "png")).replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const im = await apiSaveNodeImage(nodeId, fileName, bytes);
      if (!im) { toast("添加失败：后端未返回图片信息", 3500); continue; }
      if (!nodeImages.has(nodeId)) nodeImages.set(nodeId, []);
      nodeImages.get(nodeId).push(im);
      ok++;
    } catch (e) {
      console.warn("[思维导图] 添加图片失败:", e);
      toast("添加失败：" + (e.message || String(e)).slice(0, 60), 3500);
    }
  }
  if (!ok) return 0;
  const n = nodes.find(x => x.id === nodeId);
  const el = nodeEls.get(nodeId);
  expandedImgs.add(nodeId);   // 添加后自动展开，便于立刻看到刚加的图
  if (n && el) { renderNodeImages(n, el); renderEdges(); }
  toast(`已添加 ${ok} 张图片`);
  return ok;
}
async function removeNodeImage(n, im) {
  const ok = await askConfirm(
    `确定删除这张图片吗？<br/>删除后不可撤销。`,
    { title: "删除图片", okText: "删除" }
  );
  if (!ok) return;
  try { await apiDeleteNodeImage(im.id); } catch (e) { console.warn("[思维导图] 移除图片失败:", e); }
  const list = nodeImages.get(n.id) || [];
  nodeImages.set(n.id, list.filter(x => x.id !== im.id));
  releaseImgUrl(im.file_path);
  const el = nodeEls.get(n.id);
  if (el) { renderNodeImages(n, el); renderEdges(); }
  toast("已移除图片", 2000);
}

/* ---------- 节点图片：复制 / 剪切 / 粘贴（跨思维块） ----------
   语义与图片夹一致：复制/剪切先把图片「快照」（含字节）存进内存剪贴板，
   剪切仅打标记、不动源图，真正的删除发生在粘贴成功之后——这样中途取消
   或贴错地方都不会丢数据。 */
async function copyNodeImage(n, im, mode) {
  const bytes = await apiReadNodeImageBytes(im.file_path);
  if (!bytes || !bytes.length) { toast("操作失败：无法读取图片数据", 3200); return; }
  _mindClip = {
    mode,
    type: "image",
    nodeId: n.id,
    items: [{ id: im.id, node_id: im.node_id, file_name: im.file_name, file_path: im.file_path, bytes }],
  };
  refreshAllNodeImages();   // 各节点出现「粘贴」按钮
  toast(mode === "cut" ? "已剪切 1 张 —— 到目标思维块按 Ctrl+V 或点「粘贴」"
                       : "已复制 1 张 —— 到目标思维块按 Ctrl+V 或点「粘贴」", 3600);
}

/* ---------- 思维块（文本 + 图片）整块复制 / 粘贴 ----------
   语义：Ctrl+Shift+C 复制当前选中思维块；Ctrl+Shift+V 在画布可视区中心新建
   一个节点，把该思维块的文本与图片快照带过去。剪切与粘贴一致，粘贴后清空。
   与「仅图片」剪贴板互斥：写入 mindBlock 剪贴板时清空图片剪贴板，反之亦然，
   避免 Ctrl+V 与 Ctrl+Shift+V 混用时语义混乱。 */
async function copyMindBlock(nodeId) {
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return;
  // 把内容快照存下来（含图片字节），粘贴时不依赖源节点是否还在
  const list = nodeImages.get(nodeId) || [];
  const items = [];
  for (const im of list) {
    try {
      const bytes = await apiReadNodeImageBytes(im.file_path);
      if (!bytes || !bytes.length) continue;
      items.push({ file_name: im.file_name, bytes });
    } catch (e) { console.warn("[思维导图] 快照图片失败:", e); }
  }
  _mindClip = {
    mode: "copy",
    type: "mindBlock",
    nodeId,
    content: String(n.content || ""),
    items,
  };
  // 清空「仅图片」剪贴板，避免 Ctrl+V 与 Ctrl+Shift+V 语义冲突
  try { window[SHARED_CLIP_KEY] = null; } catch {}
  // 顺带把文本 + 图片写入系统剪贴板，便于粘贴到任意应用。
  // 包 try/catch：剪贴板 API 在权限受限/无用户手势的场景（如自动测试）可能挂起，
  // 不能让系统剪贴板失败阻塞应用内状态同步与工具栏刷新。
  try { await writeMindBlockToSystemClipboard(String(n.content || ""), items); }
  catch (e) { console.warn("[思维导图] 系统剪贴板写入失败，仅保留应用内剪贴板:", e); }
  refreshAllNodeImages();
  syncMindToolbarBtns();
  const label = (n.content || "").trim().replace(/\s+/g, " ").slice(0, 20);
  toast(label ? `已复制思维块「${label}」${items.length ? `（含 ${items.length} 张图）` : ""} —— 到目标位置按 Ctrl+Shift+V`
              : `已复制空思维块${items.length ? `（含 ${items.length} 张图）` : ""} —— 到目标位置按 Ctrl+Shift+V`, 3600);
}

/* 把思维块写入系统剪贴板（Ctrl+V 到其它应用时也能用）。
   优先策略：只有图片 → 写图片；只有文本 → 写文本；两者皆有 → 仅写文本
   （因为 WKWebView 的 ClipboardItem 需要构造时同步持有 Blob，混写文本+图片
   在多张图时容易失败，且思维块场景下文本更重要，图片走应用内 _mindClip）。 */
async function writeMindBlockToSystemClipboard(content, items) {
  const cb = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (!cb) return;
  const text = String(content || "");
  const imgs = (items || []).filter(it => it && it.bytes && it.bytes.length);
  try {
    if (imgs.length && typeof cb.write === "function" && !text) {
      // 纯图片：写系统剪贴板图片，供其它 App 直接粘贴
      const types = {};
      for (const it of imgs) {
        const name = it.file_name || "clip.png";
        const mime = guessMime(name);
        if (!types[mime]) types[mime] = new Blob([it.bytes], { type: mime });
      }
      await cb.write([new ClipboardItem(types)]);
      return;
    }
    if (text) {
      if (typeof cb.writeText === "function") await cb.writeText(text);
      return;
    }
    // 图片多于一种、无文本时：只把第一张写成剪贴板
    if (imgs.length && typeof cb.write === "function") {
      const it = imgs[0];
      const name = it.file_name || "clip.png";
      const mime = guessMime(name);
      await cb.write([new ClipboardItem({ [mime]: new Blob([it.bytes], { type: mime }) })]);
    }
  } catch (e) { console.warn("[思维导图] 写入系统剪贴板失败:", e); }
}
/* 在视口中心粘贴思维块副本。位置：以画布可视区中心为基准，
   与源节点重叠时轻微错位，方便肉眼看到新旧节点关系。 */
async function pasteMindBlock() {
  if (!_mindClip || _mindClip.type !== "mindBlock") {
    toast("没有思维块可粘贴：请先选中一个思维块后按 Ctrl+Shift+C", 3200);
    return;
  }
  if (!activeMap) return;
  const r = mindCanvas.getBoundingClientRect();
  const cwx = (r.width / 2 - view.x) / view.zoom - 60;
  const cwy = (r.height / 2 - view.y) / view.zoom - 25;
  // 源节点若就在这个位置，往右下错位 40px，避免完全叠在一起
  const src = nodes.find(x => x.id === _mindClip.nodeId);
  let px = cwx, py = cwy;
  if (src && Math.abs(src.x - px) < 30 && Math.abs(src.y - py) < 30) { px += 40; py += 40; }
  // createNodeAt 内部已经做了选中 + 进入编辑
  const n = await createNodeAt(px, py, _mindClip.content || "");
  if (!n) return;
  // 粘贴后把图片文件写进新节点
  if (_mindClip.items.length) {
    const files = _mindClip.items.map((it, i) => {
      const name = it.file_name || `clip-${Date.now()}-${i}.png`;
      return new File([it.bytes], name, { type: guessMime(name) });
    });
    await addImagesToNode(n.id, files);
  }
  // 复制语义：保留剪贴板，允许连续粘贴
}
/* 把剪贴板里的图片贴入目标思维块；剪切模式下成功后再删除源图。 */
async function pasteNodeImages(targetNodeId) {
  if (!_mindClip || !_mindClip.items.length) { toast("剪贴板为空：请先复制或剪切一张图片", 3000); return; }
  const isCut = _mindClip.mode === "cut";
  const items = _mindClip.items;
  const files = items.map(it => new File([it.bytes], it.file_name, { type: guessMime(it.file_name) }));
  const ok = await addImagesToNode(targetNodeId, files);
  if (!isCut || !ok) return;   // 复制模式保留剪贴板；剪切但没贴成功也不动源图
  // 剪切：粘贴成功后删除源图，并刷新源节点
  for (const it of items) {
    const srcNode = nodes.find(x => x.id === it.node_id);
    const srcIm = (nodeImages.get(it.node_id) || []).find(x => x.id === it.id);
    if (!srcNode || !srcIm) continue;   // 源节点/源图已不存在则跳过
    try { await apiDeleteNodeImage(it.id); } catch (e) { console.warn("[思维导图] 剪切后删除源图失败:", e); }
    nodeImages.set(it.node_id, (nodeImages.get(it.node_id) || []).filter(x => x.id !== it.id));
    releaseImgUrl(srcIm.file_path);
    const el = nodeEls.get(it.node_id);
    if (el) renderNodeImages(srcNode, el);
  }
  _mindClip = null;   // 剪切语义：粘贴后清空剪贴板
  refreshAllNodeImages();
  renderEdges();
}
/* 贴入「应用内共享剪贴板」里的图片（例如在图片夹复制的图）。
   剪切模式：贴成功后回调源模块的 onConsume 删除源图，再清空共享剪贴板。 */
async function pasteSharedImages(targetNodeId) {
  const c = readSharedClip();
  if (!c) { toast("剪贴板为空：请先复制或剪切一张图片", 3000); return; }
  const files = c.items.map(it => {
    const name = it.name || it.file_name || "clipboard.png";
    return new File([it.bytes], name, { type: guessMime(name) });
  });
  const ok = await addImagesToNode(targetNodeId, files);
  if (!ok) return;   // 没贴成功就不清理源，避免丢数据
  if (c.mode === "cut" && typeof c.onConsume === "function") {
    try { await c.onConsume(); } catch (e) { console.warn("[思维导图] 跨模块剪切清理源图失败:", e); }
  }
  if (c.mode === "cut") { try { window[SHARED_CLIP_KEY] = null; } catch {} }
}
/* 剪贴板有图片内容时，为图片操作条追加「粘贴」按钮；
   mindBlock 类型的剪贴板不在此处显示——那走 Ctrl+Shift+V，在画布中心新建节点。 */
function appendPasteBtn(bar, nodeId) {
  if (!_mindClip || !_mindClip.items.length) return;
  if (_mindClip.type === "mindBlock") return;
  const btn = document.createElement("button");
  btn.className = "mind-node-paste-img";
  btn.textContent = _mindClip.mode === "cut" ? "📋 粘贴（剪切）" : "📋 粘贴";
  btn.title = "把复制的图片粘贴到这个思维块（Ctrl+V）";
  btn.addEventListener("click", e => { e.stopPropagation(); pasteNodeImages(nodeId); });
  bar.appendChild(btn);
}
/* 重渲染所有节点的图片区（复制/剪切后「粘贴」按钮显隐需要全局刷新） */
function refreshAllNodeImages() {
  for (const n of nodes) {
    const el = nodeEls.get(n.id);
    if (el) renderNodeImages(n, el);
  }
}

/* ---------- 图片灯箱（缩放查看 + 多图切换） ---------- */
/* 打开灯箱：list 为同一思维块内的全部图片，用于左右切换查看。 */
async function openLightbox(im, list) {
  const arr = (Array.isArray(list) && list.length) ? list.slice() : [im];
  let idx = arr.findIndex(x => x.id === im.id);
  if (idx < 0) { arr.push(im); idx = arr.length - 1; }
  lb.list = arr;
  lb.index = idx;
  mindLightbox.hidden = false;
  await showLightboxImage(idx);
}
/* 展示第 i 张（下标循环）。切换时重置缩放/平移，避免上一张的变换残留。 */
async function showLightboxImage(i) {
  const arr = lb.list;
  if (!arr.length) return;
  const n = arr.length;
  lb.index = ((i % n) + n) % n;
  const im = arr[lb.index];
  const url = await nodeImageUrl(im);
  if (mindLightbox.hidden) return;            // 读取期间灯箱被关闭
  if (!url) { toast("图片读取失败", 3000); return; }
  mindLightboxImg.src = url;
  lb.scale = 1; lb.tx = 0; lb.ty = 0; lb.dragging = false; lb.moved = false;
  applyLightboxTransform();
  updateLightboxChrome();
}
/* 上一张 / 下一张（仅多图时有实际作用） */
function lightboxStep(delta) {
  if (mindLightbox.hidden || lb.list.length <= 1) return;
  showLightboxImage(lb.index + delta);
}
/* 同步切换按钮显隐与「当前/总数」计数 */
function updateLightboxChrome() {
  const n = lb.list.length;
  const multi = n > 1;
  if (mindLightboxPrev) mindLightboxPrev.hidden = !multi;
  if (mindLightboxNext) mindLightboxNext.hidden = !multi;
  if (mindLightboxCount) {
    mindLightboxCount.hidden = !multi;
    mindLightboxCount.textContent = multi ? `${lb.index + 1} / ${n}` : "";
  }
}
function closeLightbox() {
  if (!mindLightbox || mindLightbox.hidden) return;
  mindLightbox.hidden = true;
  mindLightboxImg.removeAttribute("src");
  lb = { scale: 1, tx: 0, ty: 0, dragging: false, moved: false, list: [], index: 0 };
  updateLightboxChrome();
}
function applyLightboxTransform() {
  mindLightboxImg.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
  if (mindLightboxZoomLabel) mindLightboxZoomLabel.textContent = Math.round(lb.scale * 100) + "%";
}
/* 以光标（clientX/clientY）为锚点缩放，非光标处调用则绕中心缩放 */
function lightboxZoomAt(factor, clientX, clientY) {
  const ns = Math.min(8, Math.max(0.2, lb.scale * factor));
  if (ns === lb.scale) return;
  if (clientX != null) {
    const r = mindLightboxStage.getBoundingClientRect();
    const px = clientX - (r.left + r.width / 2);
    const py = clientY - (r.top + r.height / 2);
    const k = ns / lb.scale;
    lb.tx = px - k * (px - lb.tx);
    lb.ty = py - k * (py - lb.ty);
  }
  lb.scale = ns;
  if (lb.scale <= 1) { lb.tx = 0; lb.ty = 0; }
  applyLightboxTransform();
}
function lightboxReset() { lb.scale = 1; lb.tx = 0; lb.ty = 0; applyLightboxTransform(); }
function bindLightbox() {
  if (!mindLightbox) return;
  forbidImageDownload(mindLightboxImg);   // 灯箱里也不给「下载 / 另存为」
  mindLightboxClose.addEventListener("click", closeLightbox);
  mindLightboxBackdrop.addEventListener("click", closeLightbox);
  mindLightboxZoomIn.addEventListener("click", () => lightboxZoomAt(1.2));
  mindLightboxZoomOut.addEventListener("click", () => lightboxZoomAt(0.8333));
  mindLightboxReset.addEventListener("click", lightboxReset);
  if (mindLightboxPrev) mindLightboxPrev.addEventListener("click", e => { e.stopPropagation(); lightboxStep(-1); });
  if (mindLightboxNext) mindLightboxNext.addEventListener("click", e => { e.stopPropagation(); lightboxStep(1); });
  // 点击舞台空白处（非图片）关闭；拖拽平移后不误关
  mindLightboxStage.addEventListener("click", e => {
    if (e.target === mindLightboxStage && !lb.moved) closeLightbox();
  });
  // 滚轮缩放（以光标为锚点）
  mindLightboxStage.addEventListener("wheel", e => {
    if (mindLightbox.hidden) return;
    e.preventDefault();
    lightboxZoomAt(e.deltaY < 0 ? 1.15 : 0.8696, e.clientX, e.clientY);
  }, { passive: false });
  // 拖拽平移
  mindLightboxStage.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    lb.dragging = true; lb.moved = false;
    const sx = e.clientX, sy = e.clientY, ox = lb.tx, oy = lb.ty;
    mindLightboxStage.classList.add("dragging");
    const onMove = ev => {
      if (!lb.dragging) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lb.moved = true;
      lb.tx = ox + dx; lb.ty = oy + dy;
      applyLightboxTransform();
    };
    const onUp = () => {
      lb.dragging = false;
      mindLightboxStage.classList.remove("dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  document.addEventListener("keydown", e => {
    if (mindLightbox.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); lightboxZoomAt(1.2); }
    else if (e.key === "-") { e.preventDefault(); lightboxZoomAt(0.8333); }
    else if (e.key === "0") { e.preventDefault(); lightboxReset(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); lightboxStep(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); lightboxStep(1); }
  }, true);
}

/* ---------- 选择 / 编辑 ---------- */
function selectNode(id) {
  selectedNodeId = id;
  selectedEdgeId = null;
  for (const [nid, el] of nodeEls) {
    el.classList.toggle("selected", nid === id);
  }
  if (typeof syncMindToolbarBtns === "function") syncMindToolbarBtns();
}
/* 在纯文本的可编辑区里，按 (x,y) 坐标定位光标。
   思路：在目标 text node 里对每个字符边界构造一个 collapsed range，
   用 range.getBoundingClientRect() 拿到该「点」的 rect，再判断点击坐标
   是否落在该点的矩形附近（±1px 容忍）。这样能正确处理多行换行——
   每行的每个字符都有自己的 rect，不会因为点击第二行而算到第一行的字符数。
   命中不了任何字符边界（比如点在空白 padding 上）返回 false，让调用方兜底。 */
function caretAtXY(body, x, y) {
  const sel = window.getSelection();
  for (const child of body.childNodes) {
    if (child.nodeType !== 3) continue;
    const len = child.data.length;
    const range = document.createRange();
    // 遍历 [0, len] 共 len+1 个字符边界；每个边界对应的矩形就是该处可停的光标位置。
    for (let idx = 0; idx <= len; idx++) {
      range.setStart(child, idx);
      range.collapse(true);
      const r = range.getBoundingClientRect();
      // 光标 rect 宽度常为 0，中心点即 r.left；容差 ±1px 处理亚像素偏差
      const cx = r.width > 0 ? r.left + r.width / 2 : r.left;
      if (x >= cx - 1 && x <= cx + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      }
    }
  }
  return false;
}
function enterEdit(n, body, anchor) {
  editingNode = n;
  selectedNodeId = n.id;
  body.setAttribute("contenteditable", "true");
  body.focus();
  // 光标定位：双击/回车进入编辑时优先落在用户点击的位置（更符合直觉），
  // 只在拿不到坐标或点在了文本外（比如空白 padding）时才退化为行首。
  // 之前的实现是无脑 collapse(false) 把光标送到末尾，即使用户明明点在开头，
  // 结果还得用方向键手动挪回——这就是「光标无法随意定位」的直接原因。
  let placed = false;
  if (anchor && typeof anchor.x === "number" && typeof anchor.y === "number") {
    placed = caretAtXY(body, anchor.x, anchor.y);
  }
  if (!placed) {
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  body.addEventListener("blur", () => exitEdit(n, body), { once: true });
  // 回车支持：contenteditable 默认会把 Enter 转成 <div>/<br>，但存储格式用 \n。
  // 这里手工在光标位置插入 <br>，退出编辑时用 innerText 读回（innerText 会把
  // <br> 自动转成 \n），保证多行文本进/出一致。
  body.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    insertBreakAtCaret(body);
  });
}
/* 在 contenteditable 当前光标位置插入一个 <br>。
   用 Range API 而不是 execCommand('insertText', '\n')——后者在不同内核下
   行为不一致（Chromium 会插字面 \n，Safari 会插 <br>，WebKit 视具体版本），
   统一手工插入 <br> 最稳。 */
function insertBreakAtCaret(body) {
  if (!body || !body.isContentEditable) return;
  body.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return;
  // 若选区覆盖了跨行文本，直接压平，避免 Enter 静默删掉用户已选中的内容
  range.deleteContents();
  const br = document.createElement("br");
  range.insertNode(br);
  // 光标落到新 <br> 之后（视觉上就是"下一行起点"）
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
async function exitEdit(n, body) {
  body.setAttribute("contenteditable", "false");
  editingNode = null;
  // innerText 会把 <br> 转成 \n、把 <div> 之间的分隔转成 \n，比 textContent 更贴近
  // "用户在多行文本框里看到的内容"；同时把 Windows 上可能出现的 \r\n 归一成 \n。
  const content = String(body.innerText != null ? body.innerText : body.textContent || "")
                    .replace(/\r\n?/g, "\n").trim();
  if (content !== (n.content || "")) {
    n.content = content;
    await apiUpdateNodeContent(n.id, content);
    renderMindHeader();
  }
  if (n.id === selectedNodeId) {
    const el = nodeEls.get(n.id);
    if (el) { const nb = el.querySelector(".mind-node-body"); nb.innerHTML = escWithBreaks(content); }
  }
}

/* ---------- 节点拖拽 ----------
   拖动结束后的 click 事件会在 pointerup 之后才派发，此时 drag 已清空，
   单靠 drag 判空是拦不住的——用 _suppressClickUntil 时间戳窗口兜底，
   只在「真的发生了移动」时才屏蔽后续 click/dblclick，避免用户拖完节点
   又被误触发文本编辑或选中状态抖动。 */
let _suppressClickUntil = 0;
function downOnNode(e, el, n) {
  if (e.button !== 0) return;
  e.stopPropagation();
  // 图片区（封面/画廊/加图/删除按钮）交互不触发整节点拖动
  if (e.target.closest(".mind-node-imgs")) return;
  // 正在编辑的节点：允许选择文字，不触发整节点拖动
  if (editingNode && editingNode.id === n.id && e.target.closest(".mind-node-body")) return;
  // 正文（非编辑态）上按下的瞬间立刻 preventDefault，
  // 阻止浏览器在 pointerdown 期间启动任何文本选择/光标定位——
  // 否则拖拽开始那 4px 阈值内用户会先看到「文本被选中」再进入拖动，
  // 视觉上像「先选字再拖」，是「很难选择并拖动」的直接原因之一。
  if (e.target.closest(".mind-node-body")) e.preventDefault();
  selectNode(n.id, el);
  const startX = e.clientX, startY = e.clientY;
  const oX = n.x, oY = n.y;
  drag = { kind: "node", moved: false, id: null };
  const onMove = ev => {
    if (!drag || drag.kind !== "node") return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const nz = view.zoom;
    n.x = oX + dx / nz;
    n.y = oY + dy / nz;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    placeNodeOnTop(el, n);
    renderEdges();
  };
  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    const moved = drag && drag.moved;
    drag = null;
    if (moved) {
      _suppressClickUntil = Date.now() + 300;   // 拖过才屏蔽后续 click
      await apiUpdateNodePos(n.id, n.x, n.y);
      renderEdges();
    }
  };
  placeNodeOnTop(el, n);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function placeNodeOnTop(el, n) {
  const top = nodeEls.get(n.id) || el;
  for (const [ , other] of nodeEls) {
    other.style.zIndex = other === top ? "3" : "2";
  }
  top.style.zIndex = "3";
}

/* ---------- 连线 ---------- */
function startConnect(e, node) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  e.stopImmediatePropagation();
  selectedNodeId = node.id;
  selectNode(node.id);
  connectingPort = { node, x: e.clientX, y: e.clientY };
  tempEdgeEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempEdgeEl.setAttribute("class", "mind-edge-temp");
  mindEdgesSvg.appendChild(tempEdgeEl);
  document.body.classList.add("is-dragging");
  updateTempEdge(e.clientX, e.clientY);
  const onMove = ev => { if (connectingPort) updateTempEdge(ev.clientX, ev.clientY); };
  const onUp = async ev => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("is-dragging");
    const from = connectingPort ? connectingPort.node : null;
    const toNode = hitTestNode(ev.clientX, ev.clientY);
    if (tempEdgeEl) { tempEdgeEl.remove(); tempEdgeEl = null; }
    connectingPort = null;
    if (from && toNode && from.id !== toNode.id) {
      await addEdge(from.id, toNode.id);
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function updateTempEdge(cx, cy) {
  if (!connectingPort || !tempEdgeEl) return;
  const w1 = toWorld(cx, cy);
  const p0 = nodeCenter(connectingPort.node);
  tempEdgeEl.setAttribute("d", edgeCurvePath(p0.x, p0.y, w1.x, w1.y));
}
function nodeCenter(n) {
  const el = nodeEls.get(n.id);
  const h = el ? el.offsetHeight : 70;
  return { x: n.x + NODE_W / 2, y: n.y + h / 2 };
}
function edgeCurvePath(ax, ay, bx, by) {
  const cdx = Math.max(36, Math.abs(bx - ax) / 2);
  return `M${ax},${ay} C ${ax + cdx},${ay} ${bx - cdx},${by} ${bx},${by}`;
}
function edgePointOn(n, o) {
  const c1 = nodeCenter(n), c2 = nodeCenter(o);
  const el = nodeEls.get(n.id);
  const h = el ? el.offsetHeight : 70;
  const w = NODE_W;
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { x: n.x + w, y: c1.y } : { x: n.x, y: c1.y };
  }
  return dy >= 0 ? { x: c1.x, y: n.y + h } : { x: c1.x, y: n.y };
}
function edgePath(a, b) {
  const p1 = edgePointOn(a, b), p2 = edgePointOn(b, a);
  const cdx = Math.max(36, Math.abs(p2.x - p1.x) / 2);
  return `M${p1.x},${p1.y} C ${p1.x + cdx},${p1.y} ${p2.x - cdx},${p2.y} ${p2.x},${p2.y}`;
}
function hitTestNode(cx, cy) {
  const w = toWorld(cx, cy);
  let nearest = null, best = Infinity;
  for (const n of nodes) {
    const el = nodeEls.get(n.id);
    const h = el ? el.offsetHeight : 70;
    if (w.x >= n.x - 6 && w.x <= n.x + NODE_W + 6 && w.y >= n.y - 6 && w.y <= n.y + h + 6) {
      const d2 = (w.x - (n.x + NODE_W / 2)) ** 2 + (w.y - (n.y + h / 2)) ** 2;
      if (d2 < best) { best = d2; nearest = n; }
    }
  }
  return nearest;
}
async function addEdge(fromId, toId) {
  // 避免重复边
  if (edges.some(e => (e.from_id === fromId && e.to_id === toId) || (e.from_id === toId && e.to_id === fromId))) return;
  const e = await apiAddEdge(activeMapId, fromId, toId);
  if (e) { renderEdges(); renderMindHeader(); }
}
function renderEdges() {
  if (!activeMap) { mindEdgesSvg.innerHTML = ""; return; }
  mindEdgesSvg.innerHTML = "";
  for (const e of edges) {
    const a = nodes.find(n => n.id === e.from_id);
    const b = nodes.find(n => n.id === e.to_id);
    if (!a || !b) continue;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "mind-edge" + (e.id === selectedEdgeId ? " selected" : ""));
    g.dataset.edgeId = e.id;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "mind-edge-path");
    p.setAttribute("d", edgePath(a, b));
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("class", "mind-edge-hit");
    hit.setAttribute("d", edgePath(a, b));
    g.appendChild(p);
    g.appendChild(hit);
    g.addEventListener("click", ev => {
      ev.stopPropagation();
      selectEdge(e.id);
    });
    mindEdgesSvg.appendChild(g);
  }
}
function selectEdge(id) {
  selectedEdgeId = id;
  selectedNodeId = null;
  for (const [ , el] of nodeEls) el.classList.remove("selected");
  const ge = mindEdgesSvg.querySelector(`.mind-edge[data-edge-id="${id}"]`);
  mindEdgesSvg.querySelectorAll(".mind-edge").forEach(g => g.classList.toggle("selected", g === ge));
}
async function deleteEdge(id) {
  if (selectedEdgeId === id) selectedEdgeId = null;
  await apiDeleteEdge(id);
  renderEdges();
  renderMindHeader();
}

/* ---------- 坐标换算 ---------- */
function canvasRect() { return mindCanvas.getBoundingClientRect(); }
function toWorld(cx, cy) {
  const r = canvasRect();
  return { x: (cx - r.left - view.x) / view.zoom, y: (cy - r.top - view.y) / view.zoom };
}

/* ---------- 新建节点 ---------- */
async function createNodeAt(wx, wy, content) {
  const n = await apiCreateNode(activeMapId, content || "", wx, wy);
  if (!n) return null;
  mindEmpty.hidden = true;
  renderEdges();
  renderMindHeader();
  // 定位到 DOM 并进入编辑
  const existing = nodeEls.get(n.id);
  if (existing) existing.remove();
  const el = makeNodeEl(n);
  mindNodesWrap.appendChild(el);
  selectNode(n.id);
  enterEdit(n, el.querySelector(".mind-node-body"));
  return n;
}

/* ---------- 缩放 / 平移 ---------- */
function zoomBy(factor, cx, cy) {
  const r = canvasRect();
  const wx = cx != null ? (cx - r.left - view.x) / view.zoom : 0;
  const wy = cy != null ? (cy - r.top - view.y) / view.zoom : 0;
  const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  if (nz === view.zoom) return;
  if (cx != null) {
    view.x = cx - r.left - wx * nz;
    view.y = cy - r.top - wy * nz;
  }
  view.zoom = nz;
  applyView();
  saveViewDebounced(400);
}
function fitView() {
  if (!activeMap || !nodes.length) return;
  const r = canvasRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const el = nodeEls.get(n.id);
    const h = el ? el.offsetHeight : 70;
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + h);
  }
  const margin = 60;
  const zx = (r.width - margin * 2) / (maxX - minX || 1);
  const zy = (r.height - margin * 2) / (maxY - minY || 1);
  view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zx, zy, 1.2)));
  view.x = r.width / 2 - ((minX + maxX) / 2) * view.zoom;
  view.y = r.height / 2 - ((minY + maxY) / 2) * view.zoom;
  applyView();
  saveViewDebounced(400);
}
function saveViewDebounced(delay) {
  if (!activeMap) return;
  clearTimeout(_viewTimer);
  _viewTimer = setTimeout(() => {
    apiSaveView(activeMapId, Math.round(view.x), Math.round(view.y), view.zoom);
  }, delay || 300);
}

/* ---------- 画布：平移 / 双击建点 / 滚轮缩放 ---------- */
function bindCanvasEvents() {
  mindCanvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (e.target !== mindCanvas && e.target !== mindWorld && !e.target.closest(".mind-empty")) return;
    // 空白处：开始平移
    const sx = e.clientX, sy = e.clientY;
    const ox = view.x, oy = view.y;
    const wasEmpty = e.target === mindCanvas || e.target === mindWorld;
    if (!wasEmpty) return;
    mindCanvas.classList.add("panning");
    document.body.classList.add("is-dragging");
    drag = { kind: "pan", moved: false };
    selectedNodeId = null; selectedEdgeId = null;
    deselectAll();
    const onMove = ev => {
      if (!drag || drag.kind !== "pan") return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      view.x = ox + dx;
      view.y = oy + dy;
      applyView();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      mindCanvas.classList.remove("panning");
      document.body.classList.remove("is-dragging");
      const moved = drag && drag.moved;
      drag = null;
      if (moved) saveViewDebounced();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  mindCanvas.addEventListener("dblclick", e => {
    if (!activeMap) return;
    if (e.target.closest(".mind-node")) return;
    const w = toWorld(e.clientX, e.clientY);
    createNodeAt(w.x - 60, w.y - 25, "");
  });
  mindCanvas.addEventListener("wheel", e => {
    if (!activeMap) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9091;
    zoomBy(factor, e.clientX, e.clientY);
  }, { passive: false });
  mindCanvas.addEventListener("click", e => {
    if (e.target === mindCanvas || e.target === mindWorld) { deselectAll(); }
  });
}
function deselectAll() {
  selectedNodeId = null; selectedEdgeId = null;
  for (const [ , el] of nodeEls) el.classList.remove("selected");
  mindEdgesSvg.querySelectorAll(".mind-edge").forEach(g => g.classList.remove("selected"));
  if (typeof syncMindToolbarBtns === "function") syncMindToolbarBtns();
}

/* ---------- 工具栏 / 键盘 ---------- */
const mindCopyBlockBtn = $("mind-copy-block");
const mindPasteBlockBtn = $("mind-paste-block");
function syncMindToolbarBtns() {
  if (mindCopyBlockBtn) {
    const show = !!(activeMap && selectedNodeId != null);
    mindCopyBlockBtn.hidden = !show;
  }
  if (mindPasteBlockBtn) {
    const ok = !!(activeMap && _mindClip && _mindClip.type === "mindBlock");
    mindPasteBlockBtn.hidden = !ok;
  }
}
function bindToolbar() {
  zoomInBtn.addEventListener("click", e => zoomBy(1.1, e.clientX, e.clientY));
  zoomOutBtn.addEventListener("click", e => zoomBy(0.9091, e.clientX, e.clientY));
  fitBtn.addEventListener("click", fitView);
  if (mindCopyBlockBtn) mindCopyBlockBtn.addEventListener("click", () => {
    if (selectedNodeId == null) { toast("请先选中一个思维块再复制", 2600); return; }
    copyMindBlock(selectedNodeId);
  });
  if (mindPasteBlockBtn) mindPasteBlockBtn.addEventListener("click", () => pasteMindBlock());
}
/* 确认弹窗：确定/取消按钮 + 点击遮罩关闭 + Enter/Escape 快捷键。
   事件在 init 里注册一次，全局复用；askConfirm 每次只显示/隐藏。 */
function bindConfirm() {
  confirmOkBtn.addEventListener("click", () => closeConfirm(true));
  confirmCancelBtn.addEventListener("click", () => closeConfirm(false));
  confirmModal.addEventListener("click", e => {
    if (e.target === confirmModal) closeConfirm(false);
  });
  document.addEventListener("keydown", e => {
    if (confirmModal.hidden) return;
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); closeConfirm(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeConfirm(false); }
  }, true);
}
/* Ctrl/⌘+V：把剪贴板里的图片粘贴到当前选中的思维块。
   图片来源优先级：系统剪贴板里的图片文件（截图 / 复制的图片文件）→ 剪贴板 HTML/URL 里的图片
   （从网页或其它 App 复制）→ 系统剪贴板 API 兜底 → 应用内共享剪贴板（图片夹里复制/剪切的图）。
   全都没有时不拦截，正常走默认粘贴（例如在编辑文字时粘贴文本）。 */
function bindImagePaste() {
  document.addEventListener("paste", async e => {
    _sawPasteEvent = true;   // 标记：本次 Ctrl/⌘+V 已经被 paste 事件接管（不再走键盘兜底）
    if (mindPane.hidden || !activeMap) return;
    if (mindLightbox && !mindLightbox.hidden) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    // 优先使用应用内剪贴板（_mindClip / __glassImgClip）——它们代表用户最近的显式
    // 复制/剪切意图；系统剪贴板（cd 里的 files 或 fallback 兜底读出的图）可能是
    // 上次截图/其他应用的旧残留，若优先走它，剪切就退化成复制（源图不会被清理）。
    // 因此只有当内部剪贴板为空时才读取系统剪贴板图片。
    const cd = e.clipboardData;
    // 「仅图片」剪贴板：mindBlock 类型的剪贴板走 Ctrl+Shift+V，Ctrl+V 不处理
    const hasInternal = !!(_mindClip && _mindClip.items.length && (_mindClip.type || "image") === "image");
    const hasShared = !!readSharedClip();
    // 直接来自 paste 事件（浏览器/系统）的图片——通常是外部截图/其它应用复制
    let extFiles = [];
    if (!hasInternal && !hasShared) {
      for (const it of Array.from((cd && cd.items) || [])) {
        if (it.kind === "file" && it.type && /^image\//i.test(it.type)) {
          const f = it.getAsFile();
          if (f) extFiles.push(f);
        }
      }
      // 复制自网页/其它应用的图片常常只出现在 HTML/URL 里，或干脆没进 paste 事件，逐个兜底。
      if (!extFiles.length) extFiles.push(...await clipboardImageFallbacks(cd));
    }
    // 正在编辑文字、且剪贴板里是纯文本时，让浏览器默认粘贴生效——
    // 否则应用内图片剪贴板会「抢走」本该粘贴进去的文字。
    const plainText = (cd && cd.getData ? cd.getData("text/plain") : "") || "";
    const editingText = !!editingNode || !!(ae && ae.isContentEditable);
    if (!extFiles.length && !hasInternal && !hasShared && plainText.trim() && editingText) return;
    if (!extFiles.length && !hasInternal && !hasShared) return;   // 非图片粘贴：不打扰默认行为
    e.preventDefault();
    // 正在编辑文字时优先写入被编辑的节点，否则写入当前选中节点
    const targetId = editingNode ? editingNode.id : selectedNodeId;
    if (targetId == null) { toast("请先选中一个思维块，再粘贴图片", 3200); return; }
    if (hasInternal) await pasteNodeImages(targetId);
    else if (hasShared) await pasteSharedImages(targetId);
    else await addImagesToNode(targetId, extFiles);
  });
  // 键盘兜底：个别 WebView（如 macOS WKWebView）在剪贴板里只有图片时可能「不派发 paste 事件」，
  // 这样上面的剪贴板兜底也就无从谈起。这里在按下 Ctrl/⌘+V 后延迟检查一次：
  // 若 paste 事件始终没来，就直接向后端要系统剪贴板里的图片贴进当前节点。
  document.addEventListener("keydown", e => {
    if (mindPane.hidden || !activeMap) return;
    if ((e.key !== "v" && e.key !== "V") || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    _sawPasteEvent = false;
    if (_vFallbackTimer) clearTimeout(_vFallbackTimer);
    _vFallbackTimer = setTimeout(() => { if (!_sawPasteEvent) fallbackPasteClipboardImage(); }, 180);
  });
}
/* 键盘兜底的实际动作：把系统剪贴板图片贴进当前编辑/选中的节点（仅桌面端）。
   优先走内部剪贴板（_mindClip / __glassImgClip），避免残留的系统截图把
   「剪切」意图覆盖成「复制」——这是与 bindImagePaste 相同的优先级规则。 */
async function fallbackPasteClipboardImage() {
  if (!isTauri()) return;
  const targetId = editingNode ? editingNode.id : selectedNodeId;
  if (targetId == null) return;
  if (_mindClip && _mindClip.items.length && (_mindClip.type || "image") === "image") { await pasteNodeImages(targetId); return; }
  if (readSharedClip()) { await pasteSharedImages(targetId); return; }
  const f = await apiReadClipboardImage();
  if (f) await addImagesToNode(targetId, [f]);
}
/* 解析剪贴板 HTML：取出 <img src> 与可见文字。
   只有「HTML 里没有可见文字」时才把它当图片粘贴，避免把含图片的文字选区误当图片。 */
function parseClipboardHtml(html) {
  const srcs = [];
  let text = "";
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img[src]").forEach(im => { const s = im.getAttribute("src"); if (s) srcs.push(s); });
    text = doc.body ? doc.body.textContent : "";
  } catch { /* 解析失败就当没有 */ }
  return { srcs, text };
}
function isImageUrl(s) {
  if (!s) return false;
  if (/^blob:/i.test(s) || /^data:image\//i.test(s)) return true;
  return /^https?:\/\//i.test(s) && /\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?|#|$)/i.test(s);
}
/* 把剪贴板里的一段图片来源（data: / blob: / http(s)）取成 File；跨域或非图片返回 null。 */
async function urlToImageFile(src) {
  if (!src) return null;
  const schemeOk = /^https?:/i.test(src) || /^blob:/i.test(src) || /^data:image\//i.test(src);
  if (!schemeOk) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const type = blob.type || guessMime(src);
    if (!/^image\//i.test(type)) return null;
    const ext = (type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
    return new File([blob], `clipboard.${ext}`, { type });
  } catch { return null; }
}
/* paste 事件里没有图片文件时的兜底：HTML → URL/纯文本 → navigator.clipboard.read()。
   纯文本粘贴（用户其实想贴文字）时不介入，交给浏览器默认行为。 */
async function clipboardImageFallbacks(cd) {
  const out = [];
  if (cd && cd.getData) {
    const html = cd.getData("text/html");
    if (html) {
      const { srcs, text } = parseClipboardHtml(html);
      if (!text.trim()) for (const src of srcs) { const f = await urlToImageFile(src); if (f) out.push(f); }
    }
    if (!out.length) {
      const txt = (cd.getData("text/uri-list") || cd.getData("text/plain") || "").trim();
      if (isImageUrl(txt)) { const f = await urlToImageFile(txt); if (f) out.push(f); }
    }
    // 有可见文字 → 用户多半想贴文字，别再动系统剪贴板免得抢了默认粘贴
    if (out.length || (cd.getData("text/plain") || "").trim()) return out;
  }
  // 兜底一：直接向后端要系统剪贴板图片（部分 WebView，尤其 macOS WKWebView，不会把截图塞进 paste 事件）
  if (!out.length) {
    const f = await apiReadClipboardImage();
    if (f) out.push(f);
  }
  // 兜底二：浏览器 clipboard API（Chromium 等内核截图会走这里）
  if (!out.length && typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.read) {
    try {
      for (const ci of await navigator.clipboard.read()) {
        const type = (ci.types || []).find(t => /^image\//i.test(t));
        if (!type) continue;
        const blob = await ci.getType(type);
        const ext = (type.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
        out.push(new File([blob], `clipboard.${ext}`, { type }));
      }
    } catch { /* 无权限或内核不支持：忽略 */ }
  }
  return out;
}
function bindKeyboard() {
  document.addEventListener("keydown", e => {
    if (mindPane.hidden || !activeMap) return;
    if (mindLightbox && !mindLightbox.hidden) return;   // 灯箱打开时不吃删除键
    // Ctrl/⌘+Shift+C：复制当前选中思维块（含文本 + 图片）
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyC") {
      if (selectedNodeId == null) { toast("请先选中一个思维块再复制", 2600); return; }
      e.preventDefault();
      copyMindBlock(selectedNodeId);
      return;
    }
    // Ctrl/⌘+Shift+V：把剪贴板里的思维块贴到画布可视区中心
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyV") {
      e.preventDefault();
      pasteMindBlock();
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    if (selectedEdgeId != null) { e.preventDefault(); deleteEdge(selectedEdgeId); }
    else if (selectedNodeId != null) { e.preventDefault(); removeNode(selectedNodeId); }
  });
}

/* ---------- 初始化 ---------- */
function bindModeTabs() {
  tabTasks.addEventListener("click", () => setMode("tasks"));
  tabMind.addEventListener("click", () => setMode("mind"));
  tabImages.addEventListener("click", () => setMode("images"));
}
async function init() {
  newMapBtn.addEventListener("click", async () => {
    // 若上一张导图的重命名还停着（未回车/未失焦），先提交关闭，否则 _renaming
    // 会让 renderMapList 跳过重建，导致新建的导图不在列表里，且旧输入框仍遮挡名字。
    finalizeRename();
    const m = await apiCreateMap("");
    maps.push(m);
    await setActiveMap(m.id);   // 内部会 renderMapList，并激活新导图
    // 立即进入名称编辑，给用户「新建即改名」的体验
    const li = mapListEl.querySelector(`li[data-map-id="${m.id}"]`);
    if (li) startRenameMap(li, m);
  });
  bindModeTabs();
  bindCanvasEvents();
  bindToolbar();
  bindConfirm();
  bindKeyboard();
  bindImagePaste();
  bindLightbox();
  // 文件选择框：把选中的图片写入 _pendingImgNodeId 指向的节点
  if (mindImageInput) {
    mindImageInput.addEventListener("change", async () => {
      const nodeId = _pendingImgNodeId;
      _pendingImgNodeId = null;
      const files = Array.from(mindImageInput.files || []);
      mindImageInput.value = "";
      if (nodeId == null) return;
      await addImagesToNode(nodeId, files);
    });
  }
}
init();