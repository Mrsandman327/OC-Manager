// ============================================================
// core/escape.js — HTML 转义与安全文本
// 只依赖浏览器 DOM，不 import 任何项目模块：
// core 与 components 都从这里取，避免 utils ↔ components 的循环依赖。
// ============================================================

/** HTML 文本转义：& < > " ' 由 textContent → innerHTML 自动处理 */
export function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/** HTML 属性值转义：在 escapeHtml 基础上补引号转义，用于 title="..." 等属性上下文 */
export function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 任意值转安全文本：null/undefined → 空串，字符串原样，其它 JSON 化 */
export function safeText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
}
