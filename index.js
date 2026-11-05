// Auto Refine for SillyTavern.
//
// Sends a finished reply, or a message of your own, to a model with a prompt
// of writing rules you can read and edit, and saves the rewrite only if it
// passes its checks. The text it replaced is kept, so you can put it back.
//
// The refining is done by engine/backend.js, the engine from Lumiverse Auto
// Refine, copied as it is. host.js runs it on SillyTavern's API. This file is
// the panel in the Extensions drawer, the message buttons, the wand menu items
// and the slash commands. It talks to the engine with the same messages the
// Lumiverse panel uses.

import { startEngine, ENGINE_VERSION } from './engine/backend.js';
import {
    PROTECT_NOTE, ASK_NOTE_REFUSED, ASK_NOTE_SOFTENED, ASK_NOTE_EMPTY, ASK_NOTE_BROKEN,
    MACROS, DEFAULT_BLOCKS, YOURS_DEFAULT, BUILT_IN_PROMPTS,
} from './engine/prompts.js';
import { MODULE, createHost, idAt, indexOf, currentChatId, connectionList } from './host.js';

const ctx = () => SillyTavern.getContext();

// ---- settings ----
// The engine's settings, with the defaults Lumiverse Auto Refine starts on,
// and a few of this port's own at the end.
const DEFAULTS = Object.freeze({
    enabled: true,
    refineOn: false,
    refineSide: 'both',
    refineAgain: false,
    refineGreeting: false,
    confirmBeforeSave: false,
    asSwipe: false,
    refineGap: 0,
    connectionId: '',
    thinkingMode: 'off',
    thinkingEffort: 'medium',
    timeoutSecs: 240,
    costIn: 0,
    costOut: 0,
    samplers: {},
    contextMessages: 4,
    nameSpeakers: true,
    maxHistoryTokens: 4500,
    maxLoreTokens: 2500,
    loreNames: true,
    historyCut: '',
    maxGrowthPct: 60,
    minShrinkPct: 40,
    guardRefusal: true,
    skipRefusals: true,
    guardPreamble: true,
    guardSoften: true,
    softenPct: 60,
    softenWords: '',
    softenSwaps: '',
    guardStars: false,
    guardBroken: true,
    wrapOutput: true,
    requireTags: true,
    retryRefine: 0,
    askNote: false,
    askNoteRole: 'user',
    askNoteRefused: ASK_NOTE_REFUSED,
    askNoteSoftened: ASK_NOTE_SOFTENED,
    askNoteEmpty: ASK_NOTE_EMPTY,
    askNoteBroken: ASK_NOTE_BROKEN,
    refineAtOnce: false,
    refineAtOnceCount: 2,
    rateWaits: 2,
    protectOn: true,
    protectThinking: true,
    protectInline: false,
    stripAnswerThinking: true,
    shieldAdd: '',
    shieldKeep: '',
    thinkTags: '',
    protectNote: PROTECT_NOTE,
    wornOn: false,
    wornBack: 60,
    wornLeast: 3,
    wornFine: [],
    keepOriginal: true,
    keepPutBack: false,
    blocks: [],
    userBlocks: [],
    // Engine settings this port does not offer. Two models needs Lumiverse's
    // Decision connections, and several passes needs its preset store.
    judgeMode: 'one',
    passMode: 'one',
    // SillyTavern has no way to stream a background call to an extension.
    streamProgress: false,
    // This port's own.
    messageButton: true,
    notifyAuto: true,
    sideBySide: false,
    chatsOff: [],
});

let cfg = structuredClone(DEFAULTS);

function loadSettings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    const saved = all[MODULE].settings && typeof all[MODULE].settings === 'object' ? all[MODULE].settings : {};
    cfg = Object.assign(structuredClone(DEFAULTS), saved);
    // Never two models or several passes, whatever an imported file says.
    cfg.judgeMode = 'one';
    cfg.passMode = 'one';
    cfg.streamProgress = false;
    all[MODULE].settings = cfg;
}

function usable(list) {
    return (Array.isArray(list) ? list : []).filter((b) => b && typeof b === 'object' && b.id);
}

function forEngine() {
    const out = structuredClone(cfg);
    out.blocks = usable(cfg.blocks).length ? usable(cfg.blocks) : structuredClone(DEFAULT_BLOCKS);
    out.userBlocks = usable(cfg.userBlocks).length ? usable(cfg.userBlocks) : structuredClone(YOURS_DEFAULT);
    out.passes = [];
    out.passesYours = [];
    return out;
}

let sendTimer = null;
function saveSoon() {
    ctx().extensionSettings[MODULE].settings = cfg;
    ctx().saveSettingsDebounced();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
        sendTimer = null;
        tellEngine();
    }, 250);
    applyBodyClasses();
}

function tellEngine() {
    send({ type: 'set_settings', settings: forEngine() });
    send({ type: 'set_chats_off', chats: cfg.chatsOff || [] });
}

// ---- the engine ----
let host = null;
let reqSeq = 0;
const newRequestId = () => 'arf-' + Date.now().toString(36) + '-' + (++reqSeq);

function send(msg) {
    try {
        host.send(msg);
    } catch (e) {
        toastr.error('The refine engine is not running: ' + (e.message || e), 'Auto Refine');
    }
}

// ---- small helpers ----
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
}

function chatOffHere() {
    const id = currentChatId();
    return !!id && (cfg.chatsOff || []).includes(id);
}

function messageLabel(chatId, messageId) {
    if (chatId !== currentChatId()) return 'a message in another chat';
    const i = indexOf(messageId);
    return i >= 0 ? 'message #' + i : 'a message no longer in the chat';
}

// ---- the log ----
const LOG_MAX = 80;
const logLines = [];

function log(text) {
    const at = new Date();
    logLines.push({ at, text: String(text) });
    while (logLines.length > LOG_MAX) logLines.shift();
    const box = document.getElementById('arf_log');
    if (box) paintLog(box);
}

function paintLog(box) {
    box.innerHTML = logLines
        .slice()
        .reverse()
        .map((l) => `<div class="arf-logline"><span class="arf-logtime">${esc(l.at.toLocaleTimeString())}</span> ${esc(l.text)}</div>`)
        .join('') || '<div class="arf-dim">Nothing yet.</div>';
}

function setStatus(text) {
    const box = document.getElementById('arf_status');
    if (box) box.textContent = text || 'Ready.';
}

// ---- what can be put back ----
const undo = new Map();
const undoKey = (chatId, messageId) => String(chatId) + '\u0001' + String(messageId);

function addUndo(item) {
    const k = undoKey(item.chatId, item.messageId);
    undo.delete(k);
    undo.set(k, item);
    while (undo.size > 30) undo.delete(undo.keys().next().value);
    paintUndo();
    markMessages();
}

function dropUndo(chatId, messageId) {
    undo.delete(undoKey(chatId, messageId));
    paintUndo();
    markMessages();
}

function paintUndo() {
    const box = document.getElementById('arf_undo');
    if (!box) return;
    const here = currentChatId();
    const rows = Array.from(undo.values()).filter((u) => u.chatId === here).reverse();
    if (!rows.length) {
        box.innerHTML = '<div class="arf-dim">No refines in this chat to put back.</div>';
        return;
    }
    box.innerHTML = '';
    for (const u of rows) {
        const row = el(`<div class="arf-undorow">
            <span class="arf-grow">${esc(messageLabel(u.chatId, u.messageId))}, ${esc(new Date(u.at).toLocaleTimeString())}${u.kind === 'snip' ? ' (cut)' : ''}</span>
            <div class="menu_button arf-small" data-act="show">Changes</div>
            <div class="menu_button arf-small" data-act="back">Put it back</div>
            <div class="menu_button arf-small" data-act="forget" title="Forget this one">&times;</div>
        </div>`);
        row.querySelector('[data-act="show"]').addEventListener('click', () => showChanges(u.before, u.after, 'What the refine changed'));
        row.querySelector('[data-act="back"]').addEventListener('click', () => putBack(u.chatId, u.messageId));
        row.querySelector('[data-act="forget"]').addEventListener('click', () => {
            send({ type: 'forget_undo', items: [{ chatId: u.chatId, messageId: u.messageId }] });
            dropUndo(u.chatId, u.messageId);
        });
        box.appendChild(row);
    }
}

function putBack(chatId, messageId) {
    send({ type: 'undo_refine', requestId: newRequestId(), chatId, messageId });
}

// ---- the before and after ----
function words(text) {
    return String(text || '').split(/(\s+)/).filter((x) => x !== '');
}

// A word diff by longest common subsequence. Long texts fall back to null and
// the two are shown side by side.
function diff(a, b) {
    const x = words(a);
    const y = words(b);
    const n = x.length;
    const m = y.length;
    if (n * m > 6e6) return null;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
    }
    const out = [];
    let i = 0;
    let j = 0;
    const push = (kind, t) => {
        const last = out[out.length - 1];
        if (last && last.kind === kind) last.text += t;
        else out.push({ kind, text: t });
    };
    while (i < n && j < m) {
        if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { push('cut', x[i]); i++; }
        else { push('add', y[j]); j++; }
    }
    while (i < n) push('cut', x[i++]);
    while (j < m) push('add', y[j++]);
    return out;
}

function changesHtml(before, after, sideBySide) {
    const parts = diff(before, after);
    const mark = (p) => (p.kind === 'same' ? esc(p.text) : `<span class="arf-${p.kind}">${esc(p.text)}</span>`);
    if (sideBySide || !parts) {
        // Each column shows its own side of the diff: cut words in Before,
        // added words in After. Text too long to compare is shown plain.
        const left = parts ? parts.filter((p) => p.kind !== 'add').map(mark).join('') : esc(before);
        const right = parts ? parts.filter((p) => p.kind !== 'cut').map(mark).join('') : esc(after);
        return `<div class="arf-sides">
            <div><div class="arf-sidehead">Before</div><div class="arf-text">${left}</div></div>
            <div><div class="arf-sidehead">After</div><div class="arf-text">${right}</div></div>
        </div>`;
    }
    return `<div class="arf-text">${parts.map(mark).join('')}</div>`;
}

function changesView(before, after, title) {
    const wrap = el(`<div class="arf-changes">
        <h3>${esc(title)}</h3>
        <label class="checkbox_label"><input type="checkbox" class="arf-sbs"> Side by side</label>
        <div class="arf-changebody"></div>
    </div>`);
    const box = wrap.querySelector('.arf-sbs');
    const body = wrap.querySelector('.arf-changebody');
    const paint = () => { body.innerHTML = changesHtml(before, after, box.checked); };
    box.checked = !!cfg.sideBySide;
    box.addEventListener('change', () => {
        cfg.sideBySide = box.checked;
        saveSoon();
        paint();
    });
    paint();
    return wrap;
}

function showChanges(before, after, title) {
    const c = ctx();
    c.callGenericPopup(changesView(before, after, title), c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

async function askToSave(msg) {
    const c = ctx();
    const view = changesView(msg.before, msg.after, 'Save this refine of ' + messageLabel(msg.chatId, msg.messageId) + '?');
    const answer = await c.callGenericPopup(view, c.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Accept it',
        cancelButton: 'Turn it down',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
    if (answer === c.POPUP_RESULT.AFFIRMATIVE) {
        send({ type: 'apply_refine', requestId: newRequestId(), chatId: msg.chatId, messageId: msg.messageId, before: msg.before, after: msg.after });
    } else {
        log('You turned down the refine of ' + messageLabel(msg.chatId, msg.messageId) + '.');
    }
}

// ---- asking for refines ----
// Requests started from a button or command, so their answer can be shown.
const asked = new Map();

function latestIndex(role) {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (role === 'user' ? m.is_user : !m.is_user) return i;
    }
    return -1;
}

function guardOn() {
    if (!cfg.enabled) {
        toastr.info('Auto Refine is switched off.', 'Auto Refine');
        return false;
    }
    if (!currentChatId()) {
        toastr.info('Open a chat first.', 'Auto Refine');
        return false;
    }
    return true;
}

function sideAllowed(isUser) {
    if (isUser && cfg.refineSide === 'replies') {
        toastr.info('Only replies are refined, as set in What to refine.', 'Auto Refine');
        return false;
    }
    if (!isUser && cfg.refineSide === 'mine') {
        toastr.info('Only your own messages are refined, as set in What to refine.', 'Auto Refine');
        return false;
    }
    return true;
}

function refineIndex(index) {
    if (!guardOn()) return;
    const m = (ctx().chat || [])[index];
    if (!m) {
        toastr.warning('There is no message #' + index + '.', 'Auto Refine');
        return;
    }
    if (m.is_system) {
        toastr.info('That message is hidden, so it is not refined.', 'Auto Refine');
        return;
    }
    if (!sideAllowed(!!m.is_user)) return;
    const requestId = newRequestId();
    const messageId = idAt(index);
    const chatId = currentChatId();
    asked.set(requestId, { kind: 'refine', chatId, messageId });
    setBusy(messageId, true);
    setStatus('Refining message #' + index + '...');
    send({ type: 'refine_now', requestId, chatId, messageId, mine: !!m.is_user });
}

function refineLatest(mine) {
    const i = latestIndex(mine ? 'user' : 'assistant');
    if (i < 0) {
        toastr.info(mine ? 'You have no message in this chat yet.' : 'There is no reply in this chat yet.', 'Auto Refine');
        return;
    }
    refineIndex(i);
}

function refineAll(mine) {
    if (!guardOn() || !sideAllowed(mine)) return;
    const requestId = newRequestId();
    asked.set(requestId, { kind: 'all' });
    setStatus('Starting to refine every ' + (mine ? 'message of yours' : 'reply') + ' in this chat...');
    send({ type: 'refine_all', requestId, chatId: currentChatId(), mine: !!mine });
}

function stopAll() {
    send({ type: 'cancel_refine', requestId: newRequestId() });
}

// The selection in a message, held as it is made. Opening the wand menu on a
// phone can clear the selection before the menu item is pressed.
let picked = null;

function noteSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const text = node && node.closest ? node.closest('#chat .mes .mes_text') : null;
    if (!text || !text.contains(range.endContainer)) return;
    const mes = text.closest('.mes');
    const index = Number(mes.getAttribute('mesid'));
    if (!Number.isInteger(index)) return;
    const lead = document.createRange();
    lead.setStart(text, 0);
    lead.setEnd(range.startContainer, range.startOffset);
    picked = { index, text: sel.toString(), ahead: lead.toString(), at: Date.now(), chatId: currentChatId() };
}

function takeSelection() {
    const p = picked;
    if (!p || Date.now() - p.at > 5 * 60 * 1000 || p.chatId !== currentChatId() || !p.text.trim()) {
        toastr.info('Select some text in a message first.', 'Auto Refine');
        return null;
    }
    return p;
}

function refineSelection() {
    if (!guardOn()) return;
    const p = takeSelection();
    if (!p) return;
    const m = (ctx().chat || [])[p.index];
    if (!m || !sideAllowed(!!m.is_user)) return;
    const requestId = newRequestId();
    const messageId = idAt(p.index);
    asked.set(requestId, { kind: 'refine', chatId: p.chatId, messageId });
    setBusy(messageId, true);
    setStatus('Refining the selected text in message #' + p.index + '...');
    send({ type: 'refine_selection', requestId, chatId: p.chatId, messageId, picked: p.text, ahead: p.ahead });
}

function cutSelection() {
    if (!guardOn()) return;
    const p = takeSelection();
    if (!p) return;
    const requestId = newRequestId();
    asked.set(requestId, { kind: 'snip' });
    send({ type: 'snip_selection', requestId, chatId: p.chatId, messageId: idAt(p.index), picked: p.text, ahead: p.ahead });
    picked = null;
}

let draftBefore = null;
function refineDraft() {
    if (!cfg.enabled) {
        toastr.info('Auto Refine is switched off.', 'Auto Refine');
        return;
    }
    const box = document.getElementById('send_textarea');
    const text = box ? String(box.value || '') : '';
    if (!text.trim()) {
        toastr.info('Type something in the message box first.', 'Auto Refine');
        return;
    }
    const requestId = newRequestId();
    asked.set(requestId, { kind: 'draft', text });
    setStatus('Refining what you are typing...');
    send({ type: 'try_refine', requestId, text });
}

function previewRequest() {
    const chatId = currentChatId();
    const i = Math.max(latestIndex('assistant'), latestIndex('user'));
    const requestId = newRequestId();
    asked.set(requestId, { kind: 'preview' });
    send({ type: 'preview_prompt', requestId, chatId, messageId: chatId && i >= 0 ? idAt(i) : null });
}

function showPreview(msg) {
    if (!msg.ok) {
        toastr.warning('The request could not be built: ' + (msg.why || 'no reason given'), 'Auto Refine');
        return;
    }
    const t = msg.tokens || {};
    const parts = (msg.messages || [])
        .map((m) => `<div class="arf-prevmsg"><div class="arf-sidehead">${esc(m.role)}</div><div class="arf-text">${esc(m.content)}</div></div>`)
        .join('');
    const conn = msg.connectionId ? (connectionList().find((c) => c.id === msg.connectionId) || { name: msg.connectionId }).name : 'the API SillyTavern is connected to';
    const view = el(`<div class="arf-changes">
        <h3>The request a refine would send</h3>
        <p class="arf-dim">${msg.real ? 'Built from the latest message in this chat.' : 'No message to build it from, so a stand-in is used.'}
        About ${esc(t.total || 0)} tokens${t.counted ? '' : ' (estimated)'}. Sent to ${esc(conn)}. No model was called.</p>
        ${parts}
    </div>`);
    const c = ctx();
    c.callGenericPopup(view, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

// ---- a spinner on a message being refined ----
function setBusy(messageId, on) {
    const i = indexOf(messageId);
    if (i < 0) return;
    const mes = document.querySelector(`#chat .mes[mesid="${i}"]`);
    if (mes) mes.classList.toggle('arf-busy', !!on);
}

function clearBusy() {
    document.querySelectorAll('#chat .mes.arf-busy').forEach((m) => m.classList.remove('arf-busy'));
}

// ---- what the engine says ----
const STAGES = {
    queued: 'Waiting for the refine before it to finish...',
    waiting: 'Waiting before asking again...',
    asking: 'Asking the model...',
    thinking: 'Waiting for the model...',
    writing: 'The model is writing...',
    checking: 'Checking the rewrite...',
    retrying: 'The rewrite failed a check. Asking again...',
    again: 'Refining again...',
    pass: 'Running the next pass...',
    judging: 'Checking the reply...',
    rechecking: 'Checking the rewrite again...',
};

function onEngine(msg) {
    if (!msg || typeof msg !== 'object') return;
    const mine = msg.requestId ? asked.get(msg.requestId) : null;
    switch (msg.type) {
        case 'refine_progress': {
            let text = STAGES[msg.stage] || 'Refining...';
            if (msg.stage === 'waiting' && msg.waitMs) text = 'Waiting ' + Math.round(msg.waitMs / 1000) + 's before ' + (msg.gap ? 'the next refine' : 'asking again') + '...';
            setStatus(text);
            return;
        }
        case 'refine_used': {
            const cost = msg.cost > 0 ? ', about $' + msg.cost.toFixed(4) : '';
            log('The last refine sent ' + msg.sent + ' tokens and got ' + msg.back + ' back' + (msg.counted ? '' : ' (estimated)') + cost + '.');
            return;
        }
        case 'refined': {
            setBusy(msg.messageId, false);
            const what = messageLabel(msg.chatId, msg.messageId);
            log((msg.kind === 'snip' ? 'Cut text from ' : 'Saved a refine of ') + what + (msg.swiped ? ', as a new swipe.' : '.'));
            if (msg.canUndo) addUndo({ chatId: msg.chatId, messageId: msg.messageId, before: msg.before, after: msg.after, at: Date.now(), kind: msg.kind });
            setStatus('Ready.');
            const wasAsked = Array.from(asked.values()).some((a) => a.messageId === msg.messageId);
            if ((wasAsked || cfg.notifyAuto) && msg.kind !== 'snip') {
                toastr.success('Refined ' + what + '. Click to see what changed.', 'Auto Refine', {
                    onclick: () => showChanges(msg.before, msg.after, 'What the refine changed'),
                });
            }
            return;
        }
        case 'confirm_refine':
            setBusy(msg.messageId, false);
            setStatus('Waiting for you to accept or turn down the refine.');
            askToSave(msg);
            return;
        case 'refine_result': {
            if (mine) asked.delete(msg.requestId);
            if (msg.messageId) setBusy(msg.messageId, false);
            setStatus('Ready.');
            if (msg.ok) return;
            if (msg.why === 'waiting for you to say yes') return;
            if (msg.notes) log('The model\'s notes: ' + String(msg.notes).slice(0, 1500));
            log('Not saved: ' + (msg.why || 'no reason given') + '.');
            if (msg.same) toastr.info('The model changed nothing, so there was nothing to save.', 'Auto Refine');
            else toastr.warning('Nothing was saved: ' + (msg.why || 'no reason given') + '.', 'Auto Refine');
            return;
        }
        case 'refine_skipped':
            setBusy(msg.messageId, false);
            setStatus('Ready.');
            log('The automatic refine of ' + messageLabel(msg.chatId, msg.messageId) + ' was not saved: ' + msg.why + '.');
            if (cfg.notifyAuto && !msg.same) toastr.warning('The refine of ' + messageLabel(msg.chatId, msg.messageId) + ' was not saved: ' + msg.why + '.', 'Auto Refine');
            return;
        case 'refine_stood_down':
            if (msg.messageId) setBusy(msg.messageId, false);
            setStatus('Ready.');
            log('No automatic refine: ' + msg.why + '.');
            return;
        case 'refine_notes':
            log('The model\'s notes on ' + messageLabel(msg.chatId, msg.messageId) + ': ' + String(msg.notes || '').slice(0, 1500));
            return;
        case 'refine_all_progress':
            setStatus('Refining ' + msg.at + ' of ' + msg.of + '. Saved ' + msg.saved + ', not saved ' + msg.skipped + '.');
            return;
        case 'refine_all_done':
            if (mine) asked.delete(msg.requestId);
            setStatus('Ready.');
            clearBusy();
            log('Refine all: saved ' + (msg.saved || 0) + ', not saved ' + (msg.skipped || 0) + (msg.stopped ? ', stopped' : '') + (msg.why ? '. Reasons: ' + msg.why : '') + '.');
            toastr.info('Saved ' + (msg.saved || 0) + ', not saved ' + (msg.skipped || 0) + (msg.stopped ? '. You stopped it.' : '.') + (msg.why ? ' ' + msg.why + '.' : ''), 'Auto Refine');
            return;
        case 'refine_stopped':
            setStatus('Ready.');
            clearBusy();
            log(msg.stopped ? 'Stopped.' : 'There was nothing to stop.');
            return;
        case 'undo_result':
            if (msg.ok || msg.gone) dropUndo(msg.chatId, msg.messageId);
            if (msg.ok) log('Put back ' + messageLabel(msg.chatId, msg.messageId) + '.');
            else toastr.warning('It could not be put back: ' + (msg.why || 'no reason given') + '.', 'Auto Refine');
            return;
        case 'undoable_list':
            for (const u of msg.list || []) {
                undo.set(undoKey(u.chatId, u.messageId), { chatId: u.chatId, messageId: u.messageId, before: u.before, after: u.after, at: u.at || Date.now() });
            }
            paintUndo();
            markMessages();
            return;
        case 'snip_result':
            if (mine) asked.delete(msg.requestId);
            if (!msg.ok) toastr.warning('Nothing was cut: ' + (msg.why || 'no reason given') + '.', 'Auto Refine');
            return;
        case 'try_result': {
            if (mine) asked.delete(msg.requestId);
            setStatus('Ready.');
            if (!msg.ok) {
                toastr.warning('The draft was left as it is: ' + (msg.why || 'no reason given') + '.', 'Auto Refine');
                return;
            }
            const box = document.getElementById('send_textarea');
            if (!box) return;
            if (mine && String(box.value) !== mine.text) {
                toastr.warning('The draft changed while it was being refined, so it was left as it is.', 'Auto Refine');
                return;
            }
            draftBefore = String(box.value);
            box.value = msg.after;
            box.dispatchEvent(new Event('input', { bubbles: true }));
            toastr.info('Draft refined. Click here to put the old draft back.', 'Auto Refine', {
                onclick: () => {
                    if (draftBefore == null) return;
                    box.value = draftBefore;
                    box.dispatchEvent(new Event('input', { bubbles: true }));
                    draftBefore = null;
                },
            });
            return;
        }
        case 'prompt_preview':
            if (mine) asked.delete(msg.requestId);
            showPreview(msg);
            return;
        case 'account_save_failed':
            toastr.warning('Auto Refine could not save its ' + (msg.what || 'data') + '.', 'Auto Refine');
            return;
        case 'shield_bad':
        case 'history_bad': {
            const bad = Array.isArray(msg.patterns) ? msg.patterns.filter(Boolean) : [];
            if (!bad.length) return;
            const where = msg.type === 'shield_bad' ? 'Also hide these, or Never hide these' : 'Take this out of earlier messages';
            log('These patterns in ' + where + ' could not be used: ' + bad.join(', '));
            toastr.warning('Some patterns in ' + where + ' could not be used. The log says which.', 'Auto Refine');
            return;
        }
        case 'refine_again_dropped':
            if (msg.why) log('A second refine was not saved: ' + msg.why + '.');
            return;
        default:
            return;
    }
}

// ---- message buttons ----
function addMessageButtons() {
    const slot = document.querySelector('#message_template .mes_buttons .extraMesButtons');
    if (!slot || slot.querySelector('.arf-mes-refine')) return;
    slot.prepend(
        el('<div title="Put back the text from before the refine" class="mes_button arf-mes-undo fa-solid fa-rotate-left interactable" tabindex="0"></div>'),
    );
    slot.prepend(
        el('<div title="Refine this message" class="mes_button arf-mes-refine fa-solid fa-wand-magic-sparkles interactable" tabindex="0"></div>'),
    );
}

function markMessages() {
    const here = currentChatId();
    const chat = ctx().chat || [];
    const ids = new Set(Array.from(undo.values()).filter((u) => u.chatId === here).map((u) => String(u.messageId)));
    document.querySelectorAll('#chat .mes[mesid]').forEach((mes) => {
        const m = chat[Number(mes.getAttribute('mesid'))];
        const id = m && m.extra ? m.extra.auto_refine_id : null;
        mes.classList.toggle('arf-can-undo', !!id && ids.has(String(id)));
    });
}

function applyBodyClasses() {
    const b = document.body.classList;
    b.toggle('arf-off', !cfg.enabled);
    b.toggle('arf-no-buttons', !cfg.messageButton);
    b.toggle('arf-side-replies', cfg.refineSide === 'replies');
    b.toggle('arf-side-mine', cfg.refineSide === 'mine');
}

function wireMessageButtons() {
    $(document).on('click', '.arf-mes-refine', function () {
        const index = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(index)) refineIndex(index);
    });
    $(document).on('click', '.arf-mes-undo', function () {
        const index = Number($(this).closest('.mes').attr('mesid'));
        const m = (ctx().chat || [])[index];
        const id = m && m.extra ? m.extra.auto_refine_id : null;
        if (id) putBack(currentChatId(), String(id));
    });
}

// ---- the wand menu ----
function addWandItems(tries = 0) {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        // The menu is drawn by SillyTavern while extensions load.
        if (tries < 20) setTimeout(() => addWandItems(tries + 1), 500);
        return;
    }
    if (menu.querySelector('#arf_wand')) return;
    const items = [
        ['arf_wand', 'fa-wand-magic-sparkles', 'Refine latest reply', () => refineLatest(false)],
        ['arf_wand_mine', 'fa-pen-nib', 'Refine my latest message', () => refineLatest(true)],
        ['arf_wand_sel', 'fa-i-cursor', 'Refine selected text', refineSelection],
        ['arf_wand_cut', 'fa-scissors', 'Cut selected text', cutSelection],
        ['arf_wand_draft', 'fa-keyboard', 'Refine what I am typing', refineDraft],
    ];
    for (const [id, icon, label, fn] of items) {
        const item = el(`<div id="${id}" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
            <div class="fa-solid ${icon} extensionsMenuExtensionButton"></div><span>${esc(label)}</span></div>`);
        item.addEventListener('click', fn);
        menu.appendChild(item);
    }
}

// ---- slash commands ----
function addCommands() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser || !SlashCommand) return;
    const indexArg = () => SlashCommandArgument.fromProps({
        description: 'message number. Empty uses the latest reply.',
        typeList: [ARGUMENT_TYPE.NUMBER],
        isRequired: false,
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine',
        callback: (_args, value) => {
            const n = String(value ?? '').trim();
            if (n === '') refineLatest(false);
            else refineIndex(Number(n));
            return '';
        },
        unnamedArgumentList: [indexArg()],
        helpString: 'Refine a message with Auto Refine. Give a message number, or nothing for the latest reply.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine-mine',
        callback: () => { refineLatest(true); return ''; },
        helpString: 'Refine your latest message with Auto Refine.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine-all',
        callback: (args) => { refineAll(String(args.mine) === 'true'); return ''; },
        namedArgumentList: [SlashCommandNamedArgument.fromProps({
            name: 'mine',
            description: 'refine your own messages instead of the replies',
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            defaultValue: 'false',
        })],
        helpString: 'Refine every reply in this chat with Auto Refine, or every message of yours with mine=true.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine-undo',
        callback: (_args, value) => {
            const n = String(value ?? '').trim();
            const here = currentChatId();
            let id = null;
            if (n === '') {
                const last = Array.from(undo.values()).filter((u) => u.chatId === here).pop();
                id = last ? last.messageId : null;
            } else {
                const m = (ctx().chat || [])[Number(n)];
                id = m && m.extra ? m.extra.auto_refine_id : null;
            }
            if (!id) toastr.info('There is no refine to put back there.', 'Auto Refine');
            else putBack(here, String(id));
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'message number. Empty uses the latest refine.',
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: false,
        })],
        helpString: 'Put back the text a refine replaced.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine-stop',
        callback: () => { stopAll(); return ''; },
        helpString: 'Stop the refine that is running, and the rest of a refine all.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'refine-draft',
        callback: () => { refineDraft(); return ''; },
        helpString: 'Refine the text in the message box before you send it.',
    }));
}

// ---- the panel ----
// [key, kind, label, hint, extra]. Kinds: bool, num, text, area, lines, select.
const SECTIONS = [
    {
        title: 'When to refine',
        open: true,
        fields: [
            ['refineOn', 'bool', 'Refine each new reply automatically', 'Off by default. Each refine is a second model call.'],
            ['refineSide', 'select', 'What to refine', 'Your own messages are only refined when you ask.',
                [['both', 'Replies and my messages'], ['replies', 'Replies only'], ['mine', 'My messages only']]],
            ['refineGreeting', 'bool', 'Refine the greeting', 'A person wrote it, so it is left alone unless this is on.'],
            ['refineAgain', 'bool', 'Refine a reply that was already refined', 'Off, the automatic pass leaves a refined reply alone.'],
            ['confirmBeforeSave', 'bool', 'Ask before saving a refine', 'Shows the changes and waits for your answer.'],
            ['asSwipe', 'bool', 'Save the rewrite as a new swipe', 'The original stays as the swipe before it.'],
            ['refineGap', 'num', 'Seconds between automatic refines', 'For a provider that limits calls per minute. 0 is no wait.', { min: 0, max: 120 }],
            ['messageButton', 'bool', 'Buttons on each message', 'Refine and Put it back, in each message\'s menu.'],
            ['notifyAuto', 'bool', 'Say when an automatic refine is saved or dropped', 'A refine you start yourself always says.'],
        ],
    },
    {
        title: 'Model',
        fields: [
            ['connectionId', 'connection', 'Refine using', 'A Connection Manager profile, or the API SillyTavern is connected to now.'],
            ['timeoutSecs', 'num', 'Give up after (seconds)', '0 waits as long as the model takes.', { min: 0, max: 3600 }],
            ['samplers.max_tokens', 'num', 'Longest answer (tokens)', 'Empty is 4096. A cut-off answer is not saved.', { min: 1, blank: true }],
            ['samplers.temperature', 'num', 'Temperature', 'Empty leaves it to the profile. Samplers are sent only with a profile.', { min: 0, max: 2, step: 0.05, blank: true }],
            ['samplers.top_p', 'num', 'Top P', '', { min: 0, max: 1, step: 0.01, blank: true }],
            ['samplers.top_k', 'num', 'Top K', '', { min: 0, max: 500, blank: true }],
            ['samplers.min_p', 'num', 'Min P', '', { min: 0, max: 1, step: 0.01, blank: true }],
            ['samplers.frequency_penalty', 'num', 'Frequency penalty', '', { min: -2, max: 2, step: 0.05, blank: true }],
            ['samplers.presence_penalty', 'num', 'Presence penalty', '', { min: -2, max: 2, step: 0.05, blank: true }],
            ['samplers.repetition_penalty', 'num', 'Repetition penalty', '', { min: 0, max: 2, step: 0.01, blank: true }],
            ['costIn', 'num', 'Price per million tokens sent', 'For the cost line in the log. 0 shows tokens only.', { min: 0, step: 0.01 }],
            ['costOut', 'num', 'Price per million tokens received', '', { min: 0, step: 0.01 }],
        ],
    },
    {
        title: 'Context',
        fields: [
            ['contextMessages', 'num', 'Messages before it to send', 'Filled in where a block holds {{history}}.', { min: 0, max: 40 }],
            ['maxHistoryTokens', 'num', 'Most tokens of history', '', { min: 0 }],
            ['nameSpeakers', 'bool', 'Name who said each message', ''],
            ['historyCut', 'area', 'Take this out of earlier messages', 'Patterns, one per line, such as a status line. The chat is not changed.'],
            ['maxLoreTokens', 'num', 'Most tokens of lore', 'Lore is what the last generation in this chat activated.', { min: 0 }],
            ['loreNames', 'bool', 'Start each lore entry with its name', ''],
        ],
    },
    {
        title: 'What it refuses to save',
        fields: [
            ['maxGrowthPct', 'num', 'Longest a rewrite can grow (%)', '', { min: 0, max: 1000 }],
            ['minShrinkPct', 'num', 'Most a rewrite can shrink (%)', '', { min: 0, max: 100 }],
            ['guardRefusal', 'bool', 'A rewrite that declines', ''],
            ['skipRefusals', 'bool', 'Leave a reply that is itself a refusal', 'No model call is made for it.'],
            ['guardPreamble', 'bool', 'A rewrite that talks about the edit', 'Such as "Here is the revised passage".'],
            ['guardSoften', 'bool', 'A rewrite that tones down strong words', ''],
            ['softenPct', 'num', 'Share of strong words that must stay (%)', '', { min: 0, max: 100 }],
            ['softenWords', 'area', 'More strong words', 'One per line, added to the built-in list.'],
            ['softenSwaps', 'area', 'More softened swaps', 'One per line, as: strong word = soft word, soft word.'],
            ['guardStars', 'bool', 'A rewrite that drops *actions*', 'Off by default. Cutting a sentence with an action trips it.'],
            ['guardBroken', 'bool', 'A rewrite that came back garbled or looping', ''],
            ['wrapOutput', 'bool', 'Ask for the rewrite inside <REFINED> tags', ''],
            ['requireTags', 'bool', 'Drop an answer with no tags', 'Only when the prompt asks for tags.'],
        ],
    },
    {
        title: 'Asking again',
        fields: [
            ['retryRefine', 'num', 'Ask again after a failed check', 'Each ask is a whole call. 0 to 3.', { min: 0, max: 3 }],
            ['askNote', 'bool', 'Send a note when it asks again', ''],
            ['askNoteRole', 'select', 'The note is sent as', '', [['user', 'User'], ['system', 'System'], ['assistant', 'Assistant']]],
            ['askNoteRefused', 'area', 'Note after a refusal', ''],
            ['askNoteSoftened', 'area', 'Note after a toned-down rewrite', ''],
            ['askNoteEmpty', 'area', 'Note after an empty answer', ''],
            ['askNoteBroken', 'area', 'Note after a broken rewrite', ''],
            ['refineAtOnce', 'bool', 'Write several rewrites at once', 'The first that passes is used. Each one is a whole call.'],
            ['refineAtOnceCount', 'num', 'How many at once', '', { min: 2, max: 5 }],
            ['rateWaits', 'num', 'Wait out a provider that will not take the call', 'How many times. 0 to 5.', { min: 0, max: 5 }],
        ],
    },
    {
        title: 'Protecting formatting',
        fields: [
            ['protectOn', 'bool', 'Hide markup and code from the model', 'They are put back exactly after the rewrite.'],
            ['protectThinking', 'bool', 'Hold back the thinking in a message', ''],
            ['protectInline', 'bool', 'Also hide plain <i> and <b>', ''],
            ['stripAnswerThinking', 'bool', 'Take the model\'s own thinking out of its answer', ''],
            ['thinkTags', 'area', 'Extra thinking tag names', 'One per line.'],
            ['shieldAdd', 'area', 'Also hide these', 'Patterns, one per line.'],
            ['shieldKeep', 'area', 'Never hide these', 'Patterns, one per line.'],
            ['protectNote', 'area', 'What the model is told about the stand-ins', 'Filled in where a block holds {{protect_notes}}.'],
        ],
    },
    {
        title: 'Worn-out phrases',
        fields: [
            ['wornOn', 'bool', 'Find phrases this chat has worn out', 'Filled in where a block holds {{overused}}.'],
            ['wornBack', 'num', 'Replies to look back through', '', { min: 1, max: 200 }],
            ['wornLeast', 'num', 'Replies a phrase has to be in', '', { min: 2, max: 50 }],
            ['wornFine', 'lines', 'Phrases to leave alone', 'One per line.'],
        ],
    },
    {
        title: 'Put it back',
        fields: [
            ['keepOriginal', 'bool', 'Keep the text a refine replaced', 'Needed for Put it back.'],
            ['keepPutBack', 'bool', 'Keep it after a reload', 'Saved in SillyTavern\'s settings.'],
        ],
    },
];

function getPath(key) {
    if (key.startsWith('samplers.')) return (cfg.samplers || {})[key.slice(9)];
    return cfg[key];
}

function setPath(key, v) {
    if (key.startsWith('samplers.')) {
        cfg.samplers = Object.assign({}, cfg.samplers || {});
        if (v === '' || v == null) delete cfg.samplers[key.slice(9)];
        else cfg.samplers[key.slice(9)] = v;
        return;
    }
    cfg[key] = v;
}

function fieldRow([key, kind, label, hint, extra]) {
    const id = 'arf_f_' + key.replace(/\W/g, '_');
    const hintHtml = hint ? `<div class="arf-hint">${esc(hint)}</div>` : '';
    let row;
    if (kind === 'bool') {
        row = el(`<div class="arf-field"><label class="checkbox_label" for="${id}"><input id="${id}" type="checkbox"><span>${esc(label)}</span></label>${hintHtml}</div>`);
        const input = row.querySelector('input');
        input.checked = !!getPath(key);
        input.addEventListener('change', () => { setPath(key, input.checked); saveSoon(); });
        return row;
    }
    if (kind === 'num') {
        const o = extra || {};
        row = el(`<div class="arf-field"><label for="${id}">${esc(label)}</label>
            <input id="${id}" class="text_pole" type="number" ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''} step="${o.step || 1}">${hintHtml}</div>`);
        const input = row.querySelector('input');
        const now = getPath(key);
        input.value = now == null ? '' : String(now);
        input.addEventListener('change', () => {
            const raw = input.value.trim();
            if (raw === '' && o.blank) setPath(key, '');
            else {
                let n = Number(raw);
                if (!Number.isFinite(n)) n = DEFAULTS[key] ?? 0;
                if (o.min != null) n = Math.max(o.min, n);
                if (o.max != null) n = Math.min(o.max, n);
                input.value = String(n);
                setPath(key, n);
            }
            saveSoon();
        });
        return row;
    }
    if (kind === 'select' || kind === 'connection') {
        row = el(`<div class="arf-field"><label for="${id}">${esc(label)}</label><select id="${id}" class="text_pole"></select>${hintHtml}</div>`);
        const sel = row.querySelector('select');
        const fill = () => {
            const opts = kind === 'connection'
                ? [['', 'The API SillyTavern is connected to']].concat(connectionList().map((c) => [c.id, c.name + (c.model ? ' (' + c.model + ')' : '')]))
                : extra;
            const now = String(getPath(key) ?? '');
            if (kind === 'connection' && now && !opts.some((o) => o[0] === now)) opts.push([now, 'A profile that is gone']);
            sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
            sel.value = now;
        };
        fill();
        if (kind === 'connection') sel.addEventListener('focus', fill);
        sel.addEventListener('change', () => { setPath(key, sel.value); saveSoon(); });
        return row;
    }
    // area, lines, text
    row = el(`<div class="arf-field"><label for="${id}">${esc(label)}</label><textarea id="${id}" class="text_pole" rows="3"></textarea>${hintHtml}</div>`);
    const area = row.querySelector('textarea');
    const now = getPath(key);
    area.value = kind === 'lines' ? (Array.isArray(now) ? now.join('\n') : '') : String(now ?? '');
    area.addEventListener('change', () => {
        setPath(key, kind === 'lines' ? area.value.split('\n').map((x) => x.trim()).filter(Boolean) : area.value);
        saveSoon();
    });
    return row;
}

// ---- the prompt editor ----
let promptSide = 'replies';

function listKey() {
    return promptSide === 'mine' ? 'userBlocks' : 'blocks';
}

function currentBlocks() {
    const own = usable(cfg[listKey()]);
    return own.length ? own : structuredClone(promptSide === 'mine' ? YOURS_DEFAULT : DEFAULT_BLOCKS);
}

function setBlocks(list) {
    cfg[listKey()] = list;
    saveSoon();
}

function paintPrompt() {
    const box = document.getElementById('arf_prompt');
    if (!box) return;
    box.innerHTML = '';
    const mine = promptSide === 'mine';
    const builtIns = BUILT_IN_PROMPTS.filter((p) => !!p.mine === mine);
    const head = el(`<div class="arf-prompthead">
        <select class="text_pole arf-side">
            <option value="replies">The prompt for replies</option>
            <option value="mine">The prompt for my messages</option>
        </select>
        <div class="arf-row">
            <select class="text_pole arf-builtin">${builtIns.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}</select>
            <div class="menu_button arf-load">Use this built-in prompt</div>
        </div>
        <div class="arf-hint arf-builtin-what"></div>
        <div class="arf-hint">${usable(cfg[listKey()]).length ? 'You have edited this prompt.' : 'This is the built-in prompt. Editing a block makes it your own.'}</div>
    </div>`);
    const side = head.querySelector('.arf-side');
    side.value = promptSide;
    side.addEventListener('change', () => { promptSide = side.value; paintPrompt(); });
    const pick = head.querySelector('.arf-builtin');
    const what = head.querySelector('.arf-builtin-what');
    const sayWhat = () => { what.textContent = (builtIns[Number(pick.value)] || {}).what || ''; };
    pick.addEventListener('change', sayWhat);
    sayWhat();
    head.querySelector('.arf-load').addEventListener('click', async () => {
        const p = builtIns[Number(pick.value)];
        if (!p) return;
        const c = ctx();
        const ok = await c.callGenericPopup(`Replace this prompt with "${esc(p.label)}"? Your edits to it are lost.`, c.POPUP_TYPE.CONFIRM);
        if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;
        setBlocks(structuredClone(p.blocks));
        paintPrompt();
    });
    box.appendChild(head);

    const list = currentBlocks();
    list.forEach((b, i) => {
        const card = el(`<details class="arf-block">
            <summary><span class="arf-blockname"></span><span class="arf-dim arf-blockrole"></span></summary>
            <div class="arf-row">
                <input class="text_pole arf-bname" placeholder="Name">
                <select class="text_pole arf-brole"><option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option></select>
                <label class="checkbox_label"><input type="checkbox" class="arf-bon"> On</label>
            </div>
            <textarea class="text_pole arf-btext" rows="10"></textarea>
            <div class="arf-row">
                <div class="menu_button arf-small" data-act="up" title="Move up">&uarr;</div>
                <div class="menu_button arf-small" data-act="down" title="Move down">&darr;</div>
                <div class="menu_button arf-small" data-act="del">Delete block</div>
            </div>
        </details>`);
        const name = card.querySelector('.arf-bname');
        const role = card.querySelector('.arf-brole');
        const on = card.querySelector('.arf-bon');
        const text = card.querySelector('.arf-btext');
        const summary = () => {
            card.querySelector('.arf-blockname').textContent = (b.name || b.id) + (b.on === false ? ' (off)' : '');
            card.querySelector('.arf-blockrole').textContent = ' ' + (b.role || 'system');
        };
        name.value = b.name || '';
        role.value = b.role || 'system';
        on.checked = b.on !== false;
        text.value = b.text || '';
        summary();
        const commit = () => {
            const next = currentBlocks();
            next[i] = { id: b.id, name: name.value, role: role.value, on: on.checked, text: text.value };
            Object.assign(b, next[i]);
            setBlocks(next);
            summary();
        };
        name.addEventListener('change', commit);
        role.addEventListener('change', commit);
        on.addEventListener('change', commit);
        text.addEventListener('change', commit);
        card.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
            const next = currentBlocks();
            const act = btn.getAttribute('data-act');
            if (act === 'up' && i > 0) [next[i - 1], next[i]] = [next[i], next[i - 1]];
            else if (act === 'down' && i < next.length - 1) [next[i + 1], next[i]] = [next[i], next[i + 1]];
            else if (act === 'del') next.splice(i, 1);
            else return;
            if (!next.length) {
                toastr.info('A prompt needs at least one block.', 'Auto Refine');
                return;
            }
            setBlocks(next);
            paintPrompt();
        }));
        box.appendChild(card);
    });

    const tail = el(`<div class="arf-row">
        <div class="menu_button arf-add">Add a block</div>
        <div class="menu_button arf-reset">Back to the built-in prompt</div>
    </div>`);
    tail.querySelector('.arf-add').addEventListener('click', () => {
        const next = currentBlocks();
        next.push({ id: 'b' + Date.now().toString(36), name: 'New block', on: true, role: 'system', text: '' });
        setBlocks(next);
        paintPrompt();
        const last = box.querySelectorAll('.arf-block');
        if (last.length) last[last.length - 1].open = true;
    });
    tail.querySelector('.arf-reset').addEventListener('click', () => {
        setBlocks([]);
        paintPrompt();
    });
    box.appendChild(tail);

    if (!list.some((b) => b.on !== false && String(b.text || '').includes('{{message}}'))) {
        box.appendChild(el('<div class="arf-warn">No block that is on holds {{message}}, so the model is never shown the message.</div>'));
    }
}

function macroHelp() {
    const rows = MACROS.map((m) => `<div class="arf-macro"><code>${esc(m.tag)}</code> <span class="arf-dim">${esc(String(m.what).replace(/Lumiverse/g, 'SillyTavern'))}</span></div>`).join('');
    return `<details class="arf-sub"><summary>Macros a block can use</summary>${rows}
        <div class="arf-hint">{{memories}} and {{checks_found}} are always empty in SillyTavern.</div></details>`;
}

// ---- import, export, reset ----
function exportSettings() {
    const data = JSON.stringify({ autoRefine: ENGINE_VERSION, settings: Object.assign({}, cfg, { chatsOff: undefined }) }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'auto-refine-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importSettings() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
            const got = JSON.parse(await f.text());
            const s = got && typeof got === 'object' ? (got.settings || got) : null;
            if (!s || typeof s !== 'object') throw new Error('the file holds no settings');
            const keep = cfg.chatsOff;
            const next = Object.assign(structuredClone(DEFAULTS), {});
            for (const k of Object.keys(DEFAULTS)) if (k in s) next[k] = s[k];
            next.chatsOff = keep;
            next.judgeMode = 'one';
            next.passMode = 'one';
            next.streamProgress = false;
            cfg = next;
            ctx().extensionSettings[MODULE].settings = cfg;
            saveSoon();
            buildPanel();
        } catch (e) {
            toastr.warning('The settings could not be read: ' + (e.message || e), 'Auto Refine');
        }
    });
    input.click();
}

async function resetSettings() {
    const c = ctx();
    const ok = await c.callGenericPopup('Put every Auto Refine setting, and both prompts, back to the defaults?', c.POPUP_TYPE.CONFIRM);
    if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return;
    const keep = cfg.chatsOff;
    cfg = structuredClone(DEFAULTS);
    cfg.chatsOff = keep;
    ctx().extensionSettings[MODULE].settings = cfg;
    saveSoon();
    buildPanel();
}

function buildPanel() {
    let root = document.getElementById('auto_refine_settings');
    if (!root) {
        root = el(`<div id="auto_refine_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Auto Refine</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content arf-panel"></div>
            </div>
        </div>`);
        const parent = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        parent.appendChild(root);
    }
    const panel = root.querySelector('.arf-panel');
    panel.innerHTML = '';

    const top = el(`<div class="arf-top">
        <label class="checkbox_label"><input type="checkbox" id="arf_enabled"><b>Auto Refine is on</b></label>
        <label class="checkbox_label"><input type="checkbox" id="arf_chatoff"><span>Turn off in this chat</span></label>
        <div id="arf_status" class="arf-status">Ready.</div>
        <div class="arf-buttons">
            <div class="menu_button" data-act="latest"><i class="fa-solid fa-wand-magic-sparkles"></i> Refine latest reply</div>
            <div class="menu_button" data-act="mine"><i class="fa-solid fa-pen-nib"></i> Refine my latest message</div>
            <div class="menu_button" data-act="all"><i class="fa-solid fa-layer-group"></i> Refine every reply</div>
            <div class="menu_button" data-act="allmine"><i class="fa-solid fa-layer-group"></i> Refine all my messages</div>
            <div class="menu_button" data-act="stop"><i class="fa-solid fa-stop"></i> Stop</div>
            <div class="menu_button" data-act="preview"><i class="fa-solid fa-eye"></i> Show me the request</div>
        </div>
        <div class="arf-sub"><b>Put it back</b><div id="arf_undo"></div></div>
    </div>`);
    const enabled = top.querySelector('#arf_enabled');
    enabled.checked = !!cfg.enabled;
    enabled.addEventListener('change', () => { cfg.enabled = enabled.checked; saveSoon(); });
    top.querySelector('#arf_chatoff').addEventListener('change', (e) => {
        const id = currentChatId();
        if (!id) {
            e.target.checked = false;
            toastr.info('Open a chat first.', 'Auto Refine');
            return;
        }
        const set = new Set(cfg.chatsOff || []);
        if (e.target.checked) set.add(id);
        else set.delete(id);
        cfg.chatsOff = Array.from(set).slice(-500);
        saveSoon();
    });
    const acts = {
        latest: () => refineLatest(false),
        mine: () => refineLatest(true),
        all: () => refineAll(false),
        allmine: () => refineAll(true),
        stop: stopAll,
        preview: previewRequest,
    };
    top.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', acts[b.getAttribute('data-act')]));
    panel.appendChild(top);

    const prompt = el(`<details class="arf-section"><summary>Prompt</summary><div id="arf_prompt"></div>${macroHelp()}</details>`);
    panel.appendChild(prompt);

    for (const s of SECTIONS) {
        const sec = el(`<details class="arf-section"${s.open ? ' open' : ''}><summary>${esc(s.title)}</summary><div class="arf-fields"></div></details>`);
        const box = sec.querySelector('.arf-fields');
        for (const f of s.fields) box.appendChild(fieldRow(f));
        panel.appendChild(sec);
    }

    const tools = el(`<details class="arf-section"><summary>Log, import and export</summary>
        <div id="arf_log" class="arf-log"></div>
        <div class="arf-buttons">
            <div class="menu_button" data-act="export">Export settings</div>
            <div class="menu_button" data-act="import">Import settings</div>
            <div class="menu_button" data-act="reset">Reset everything</div>
        </div>
        <div class="arf-hint">Refine engine ${esc(ENGINE_VERSION)}, from Lumiverse Auto Refine.</div>
    </details>`);
    tools.querySelector('[data-act="export"]').addEventListener('click', exportSettings);
    tools.querySelector('[data-act="import"]').addEventListener('click', importSettings);
    tools.querySelector('[data-act="reset"]').addEventListener('click', resetSettings);
    panel.appendChild(tools);

    paintPrompt();
    paintLog(document.getElementById('arf_log'));
    paintUndo();
    paintChat();
}

function paintChat() {
    const box = document.getElementById('arf_chatoff');
    if (box) {
        box.checked = chatOffHere();
        box.disabled = !currentChatId();
    }
    paintUndo();
}

// ---- start ----
jQuery(async () => {
    try {
        loadSettings();
        host = createHost(onEngine);
        startEngine(host.spindle);
        buildPanel();
        addMessageButtons();
        wireMessageButtons();
        addWandItems();
        addCommands();
        applyBodyClasses();
        document.addEventListener('selectionchange', noteSelection);

        const c = ctx();
        const ev = c.eventTypes || c.event_types;
        c.eventSource.on(ev.CHAT_CHANGED, () => {
            picked = null;
            paintChat();
            setTimeout(markMessages, 0);
        });
        for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) {
            if (ev[name]) c.eventSource.on(ev[name], () => setTimeout(markMessages, 0));
        }

        tellEngine();
        send({ type: 'list_undoable', requestId: newRequestId() });
        log('Ready. Engine ' + ENGINE_VERSION + '.');
    } catch (e) {
        console.error('[Auto Refine] could not start', e);
        toastr.error('Auto Refine could not start: ' + (e.message || e), 'Auto Refine');
    }
});
