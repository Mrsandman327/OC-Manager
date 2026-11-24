// ============================================================
// chat/message-actions.js — 消息卡片外部的操作行
// 用户消息：复制 / 引用 / 分叉
// 助手最终正文：复制 / 引用 / 收藏到知识库
// ============================================================

import { api } from '../core/apicall.js';
import { store } from '../core/state.js';
import { getCachedMessages, copyToClipboard, showToast, showApiError } from '../core/utils.js';
import { selectSession } from './session.js';
import { openSessionTab } from './tabs.js';
import { messageActionText } from './render.js';
import { refreshTree } from './tree.js';
import { openKbEntryModal } from '../views/knowledge.js';

/** 在指定会话的消息缓存里按 id 找消息条目。 */
function findMessage(sessionId, messageId) {
    if (!sessionId || !messageId) return null;
    const list = getCachedMessages(sessionId) || [];
    for (let i = 0; i < list.length; i++) {
        const info = list[i].info || list[i];
        if (String(info.id || '') === String(messageId)) return list[i];
    }
    return null;
}

/** 把文本引用到输入框：已有内容时追加（空一行），光标移到末尾并聚焦。 */
function quoteToPrompt(text) {
    const ta = document.getElementById('ocPrompt');
    if (!ta) return false;
    const cur = ta.value || '';
    const next = cur.trim() ? (cur.replace(/\s+$/, '') + '\n\n' + text) : text;
    ta.value = next;
    // 触发 input 让输入框组件/字数统计等同步
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    ta.selectionStart = ta.selectionEnd = next.length;
    return true;
}

/** 收藏标题：取正文第一行，超过 30 字截断。 */
function collectTitle(text) {
    const first = (text.split('\n').find(function (line) { return line.trim(); }) || '').trim();
    return first.length > 30 ? first.slice(0, 30) + '…' : first;
}

/** 点击操作按钮：所有动作都从当前会话缓存里取原文，避免把大段文本塞进 DOM 属性。 */
export async function handleMessageActionClick(event) {
    const btn = event.target.closest('.oc-msg-action');
    if (!btn) return;
    const row = btn.closest('.oc-msg-actions');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;

    const act = btn.dataset.act || '';
    const messageId = row.dataset.messageId || '';
    const sessionId = row.dataset.sessionId || store.currentSessionId || '';
    const item = findMessage(sessionId, messageId);
    const text = item ? messageActionText(item) : '';

    if (act === 'copy') {
        if (!text) { showToast('没有可复制的文本', 'error'); return; }
        await copyToClipboard(text);
        showToast('已复制', 'success');
        return;
    }

    if (act === 'quote') {
        if (!text) { showToast('没有可引用的文本', 'error'); return; }
        if (quoteToPrompt(text)) showToast('已引用到输入框', 'success');
        return;
    }

    if (act === 'collect') {
        if (!text) { showToast('没有可收藏的文本', 'error'); return; }
        // 复用知识库条目弹窗：预填标题与内容，说明/分类/标签由用户补充
        await openKbEntryModal(null, { title: collectTitle(text), content: text });
        return;
    }

    if (act === 'fork') {
        if (!messageId) { showToast('找不到这条消息', 'error'); return; }
        btn.disabled = true;
        try {
            // before 传选中的用户消息 id，服务端据此复制该消息之前（含该消息边界）的历史
            const res = await api.ForkSession(sessionId, messageId);
            if (!res || res.success === false) {
                throw new Error((res && res.error) || '分支失败');
            }
            const newId = res.body || '';
            if (!newId) throw new Error('分支会话没有返回会话 id');
            const baseTitle = (store.sessionMap && store.sessionMap[sessionId] && store.sessionMap[sessionId].title) || '会话';
            showToast('已创建分支会话', 'success');
            openSessionTab(newId, baseTitle + ' (分支)');
            await selectSession(newId);
            refreshTree();
        } catch (e) {
            showApiError('创建分支失败: ', e);
        } finally {
            btn.disabled = false;
        }
    }
}

/** 绑定消息池上的点击委托（幂等）。 */
export function bindMessageActions() {
    const pool = document.getElementById('ocMessagesPool');
    if (!pool || pool.dataset.msgActionsBound === 'true') return;
    pool.dataset.msgActionsBound = 'true';
    pool.addEventListener('click', handleMessageActionClick);
}
