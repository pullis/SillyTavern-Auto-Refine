// The SillyTavern side of the engine.
//
// engine/backend.js is the refine engine from Lumiverse Auto Refine, copied as
// it is. It talks to its host through one object, `spindle`. This file builds
// that object out of SillyTavern's own API, so the engine runs in the browser
// tab with no server part of its own.
//
// What each part maps to:
// - chat.getMessages / updateMessage: the open chat, `getContext().chat`.
// - chats.get / characters.get: the open chat's character, or the group's members.
// - generate.quiet: a Connection Manager profile, or the API SillyTavern is
//   connected to when no profile is picked.
// - world_books.getActivated: the lorebook entries the last generation in this
//   chat activated.
// - macros.resolve: `substituteParams`.
// - tokens.countText: `getTokenCountAsync`.
// - userStorage / storage: `extension_settings.auto_refine.store`.
// - on(...): SillyTavern's generation events, turned into the three the engine
//   listens for.
//
// Lumiverse's Decision connections have no SillyTavern match, so `decisions`
// is left out and the engine says two models are not available.

export const MODULE = 'auto_refine';

const ctx = () => SillyTavern.getContext();

// The id the engine knows a message by. SillyTavern knows a message by its
// place in the chat, which moves when a message above it is deleted. A put-back
// held by place could then land on the wrong message, so each message is given
// its own id, kept in `extra` and saved with the chat.
const ID_FIELD = 'auto_refine_id';

function newId() {
    try {
        return ctx().uuidv4();
    } catch (_) {
        return 'arf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
}

export function idAt(index) {
    const chat = ctx().chat;
    const m = Array.isArray(chat) ? chat[index] : null;
    if (!m) return null;
    if (!m.extra || typeof m.extra !== 'object') m.extra = {};
    if (!m.extra[ID_FIELD]) m.extra[ID_FIELD] = newId();
    return String(m.extra[ID_FIELD]);
}

export function indexOf(id) {
    const chat = ctx().chat;
    if (!Array.isArray(chat) || id == null) return -1;
    const want = String(id);
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (m && m.extra && String(m.extra[ID_FIELD] || '') === want) return i;
    }
    return -1;
}

export function currentChatId() {
    try {
        const id = ctx().getCurrentChatId();
        return id == null || id === '' ? null : String(id);
    } catch (_) {
        return null;
    }
}

function openChat(chatId) {
    const now = currentChatId();
    if (!now || String(chatId) !== now) throw new Error('that chat is not open any more');
    return ctx().chat;
}

function roleOf(m) {
    // A message hidden with /hide is marked as a system message, and the engine
    // leaves system messages out of everything, which is what hiding asks for.
    if (m.is_system) return 'system';
    return m.is_user ? 'user' : 'assistant';
}

function asMessage(m, i) {
    const out = {
        id: idAt(i),
        index: i,
        role: roleOf(m),
        content: String(m.mes == null ? '' : m.mes),
        name: m.name,
    };
    if (Array.isArray(m.swipes) && m.swipes.length) {
        out.swipes = m.swipes.slice();
        out.swipe_id = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
    }
    return out;
}

async function getMessages(chatId) {
    const chat = openChat(chatId);
    return chat.map((m, i) => asMessage(m || {}, i));
}

function swipeInfoLike(m) {
    const at = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
    const from = Array.isArray(m.swipe_info) ? m.swipe_info[at] : null;
    if (from && typeof from === 'object') return structuredClone(from);
    return { send_date: m.send_date, gen_started: m.gen_started, gen_finished: m.gen_finished, extra: structuredClone(m.extra || {}) };
}

function refreshSwipes(index, m) {
    try {
        const s = ctx().swipe;
        if (s && typeof s.refresh === 'function') {
            s.refresh(true, false);
            return;
        }
    } catch (_) { /* older SillyTavern, set the counter by hand below */ }
    try {
        const el = document.querySelector(`#chat .mes[mesid="${index}"] .swipes-counter`);
        if (el && Array.isArray(m.swipes)) el.textContent = `${(m.swipe_id || 0) + 1}/${m.swipes.length}`;
    } catch (_) { /* the counter is only a display */ }
}

async function updateMessage(chatId, id, patch) {
    const chat = openChat(chatId);
    const i = indexOf(id);
    if (i < 0) throw new Error('that message is gone');
    const m = chat[i];
    if (patch && Array.isArray(patch.swipes)) {
        if (!Array.isArray(m.swipe_info)) m.swipe_info = (m.swipes || []).map(() => swipeInfoLike(m));
        while (m.swipe_info.length < patch.swipes.length) m.swipe_info.push(swipeInfoLike(m));
        m.swipe_info.length = patch.swipes.length;
        m.swipes = patch.swipes.slice();
    }
    if (patch && typeof patch.swipe_id === 'number') m.swipe_id = patch.swipe_id;
    if (patch && typeof patch.content === 'string') m.mes = patch.content;
    // The swipe on screen and the message text are the same thing in SillyTavern.
    if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipe_id < m.swipes.length) {
        m.swipes[m.swipe_id] = m.mes;
    }
    const c = ctx();
    try {
        c.updateMessageBlock(i, m);
    } catch (e) {
        console.warn('[Auto Refine] the message was saved but could not be redrawn', e);
    }
    refreshSwipes(i, m);
    try {
        await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, i);
    } catch (_) { /* another extension's listener failing is not ours to report */ }
    await c.saveChat();
}

async function getChat(chatId) {
    const now = currentChatId();
    if (!now || String(chatId) !== now) return null;
    const c = ctx();
    if (c.groupId) {
        const group = (c.groups || []).find((g) => String(g.id) === String(c.groupId));
        const ids = (group && Array.isArray(group.members) ? group.members : [])
            .map((avatar) => c.characters.findIndex((ch) => ch && ch.avatar === avatar))
            .filter((n) => n >= 0)
            .map(String);
        return { id: now, character_id: ids[0] || null, metadata: { character_ids: ids } };
    }
    const chid = c.characterId;
    return { id: now, character_id: chid == null || chid === '' ? null : String(chid), metadata: {} };
}

async function getCharacter(id) {
    const c = ctx();
    const n = Number(id);
    if (!Number.isInteger(n) || !c.characters[n]) return null;
    // A character list can be loaded without the long fields, until it is opened.
    try {
        if (typeof c.unshallowCharacter === 'function') await c.unshallowCharacter(n);
    } catch (_) { /* the card is used with what it has */ }
    const ch = c.characters[n];
    return {
        id: String(n),
        name: ch.name,
        description: ch.description ?? ch.data?.description,
        personality: ch.personality ?? ch.data?.personality,
        scenario: ch.scenario ?? ch.data?.scenario,
    };
}

function profiles() {
    try {
        const c = ctx();
        if ((c.extensionSettings.disabledExtensions || []).includes('connection-manager')) return [];
        const list = c.extensionSettings.connectionManager && c.extensionSettings.connectionManager.profiles;
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

export function connectionList() {
    return profiles()
        .filter((p) => p && p.id)
        .map((p) => ({ id: String(p.id), name: String(p.name || p.id), provider: String(p.api || ''), model: String(p.model || '') }));
}

// The samplers a Connection Manager request can carry. max_tokens is passed
// on its own, and max_context is left to the profile.
const PASSED = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty'];
const DEFAULT_LENGTH = 4096;

function abortError(signal) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    e.cause = signal && signal.reason;
    return e;
}

// Rejects when the signal fires. A call to the API SillyTavern is connected to
// cannot be stopped on its own without stopping a chat reply too, so a stop
// or a timeout lets it finish and throws its answer away.
function raceSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
        );
    });
}

function errorText(e) {
    const parts = [];
    let cur = e;
    for (let i = 0; cur && i < 4; i++) {
        const msg = cur.message || (typeof cur === 'string' ? cur : '');
        if (msg && parts.indexOf(msg) < 0) parts.push(msg);
        cur = cur.cause;
    }
    return parts.join(': ') || 'the model call failed with no reason given';
}

async function quiet(req) {
    const c = ctx();
    const messages = (req.messages || []).map((m) => ({ role: m.role, content: String(m.content == null ? '' : m.content) }));
    const params = req.parameters || {};
    const length = Number(params.max_tokens) > 0 ? Number(params.max_tokens) : DEFAULT_LENGTH;
    const signal = req.signal || null;
    if (signal && signal.aborted) throw abortError(signal);

    if (req.connection_id) {
        const svc = c.ConnectionManagerRequestService;
        if (!svc) throw new Error('this SillyTavern has no Connection Manager. Update SillyTavern, or set Refine using to the connected API');
        const extra = {};
        for (const k of PASSED) if (params[k] != null) extra[k] = params[k];
        let prompt = messages;
        try {
            if (typeof svc.constructPrompt === 'function') prompt = svc.constructPrompt(messages, req.connection_id);
        } catch (e) {
            throw new Error('the connection profile could not be used: ' + errorText(e));
        }
        try {
            const out = await svc.sendRequest(req.connection_id, prompt, length, { stream: false, signal: signal, extractData: true, includePreset: true }, extra);
            return { content: String((out && (out.content ?? out)) || '') };
        } catch (e) {
            if (signal && signal.aborted) throw abortError(signal);
            throw new Error(errorText(e));
        }
    }

    if (typeof c.generateRaw !== 'function') throw new Error('this SillyTavern cannot make a background call. Update SillyTavern');
    try {
        const text = await raceSignal(c.generateRaw({ prompt: messages, responseLength: length, trimNames: false }), signal);
        return { content: String(text || '') };
    } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new Error(errorText(e));
    }
}

// ---- storage ----
// The engine keeps its put-back list and other files through userStorage. The
// settings file is not kept here: the panel owns the settings, in
// extension_settings, and hands them over itself.
const SETTINGS_FILE = 'settings.json';

function store() {
    const all = ctx().extensionSettings;
    if (!all[MODULE] || typeof all[MODULE] !== 'object') all[MODULE] = {};
    if (!all[MODULE].store || typeof all[MODULE].store !== 'object') all[MODULE].store = {};
    return all[MODULE].store;
}

const userStorage = {
    async getJson(file, opts) {
        const v = store()[file];
        return v === undefined ? (opts && 'fallback' in opts ? opts.fallback : null) : structuredClone(v);
    },
    async setJson(file, value) {
        if (file === SETTINGS_FILE) return;
        store()[file] = structuredClone(value);
        ctx().saveSettingsDebounced();
    },
};

const storage = {
    async read(file) {
        const v = store()['file:' + file];
        if (v == null) throw new Error('no such file');
        return String(v);
    },
    async write(file, text) {
        store()['file:' + file] = String(text);
        ctx().saveSettingsDebounced();
    },
};

// ---- lore ----
// What the last generation in each chat activated, which is the lore the
// engine is asking for: the entries this chat has active right now.
const lore = new Map();
const LORE_CHATS = 20;

function noteLore(entries) {
    const chatId = currentChatId();
    if (!chatId || !Array.isArray(entries)) return;
    const list = entries
        .filter((e) => e && String(e.content || '').trim())
        .map((e) => ({ id: String(e.world || '') + '|' + String(e.uid ?? ''), name: String(e.comment || ''), content: String(e.content || '') }));
    lore.delete(chatId);
    lore.set(chatId, list);
    while (lore.size > LORE_CHATS) lore.delete(lore.keys().next().value);
}

const worldBooks = {
    async getActivated(chatId) {
        return (lore.get(String(chatId)) || []).map((e) => ({ id: e.id }));
    },
    entries: {
        async get(id) {
            for (const list of lore.values()) {
                const hit = list.find((e) => e.id === String(id));
                if (hit) return hit;
            }
            return null;
        },
    },
};

// ---- events ----
// The engine listens for GENERATION_STARTED, GENERATION_STOPPED and
// GENERATION_ENDED with a chat id, and on the end, the reply's id.
//
// SillyTavern says a reply was rendered, with its place in the chat, and that
// generating ended, with nothing else. The order of the two is not fixed: when
// streaming, generating ends before the reply is rendered. So the replies
// rendered during a generation are collected, and handed to the engine once
// SillyTavern is no longer generating and nothing has arrived for a moment.
// A group chat generates one reply after another, and they are handed over
// together at the end.
//
// A generation you stop is not refined. SillyTavern still renders the part
// that was written, after it says it stopped.
const SETTLE_MS = 400;
const SKIP_TYPES = ['first_message', 'command', 'extension'];

function wireEvents(emit) {
    const c = ctx();
    const es = c.eventSource;
    const ev = c.eventTypes || c.event_types;
    let gen = null;
    let timer = null;

    const stillGenerating = () => document.body.dataset.generating === 'true';

    const flush = () => {
        timer = null;
        if (!gen || gen.stopped) return;
        if (stillGenerating()) {
            settle();
            return;
        }
        const done = gen;
        gen = null;
        if (done.chatId !== currentChatId()) {
            emit('GENERATION_STOPPED', { chatId: done.chatId });
            return;
        }
        if (done.type === 'impersonate') {
            emit('GENERATION_ENDED', { chatId: done.chatId, generationType: 'impersonate' });
            return;
        }
        if (!done.landed.size) {
            emit('GENERATION_STOPPED', { chatId: done.chatId });
            return;
        }
        for (const index of done.landed) {
            const m = ctx().chat[index];
            if (!m || m.is_user || m.is_system) continue;
            emit('GENERATION_ENDED', {
                chatId: done.chatId,
                messageId: idAt(index),
                generationId: newId(),
                generationType: done.type,
            });
        }
    };

    const settle = () => {
        clearTimeout(timer);
        timer = setTimeout(flush, SETTLE_MS);
    };

    es.on(ev.GENERATION_STARTED, (type, _opts, dryRun) => {
        if (dryRun || type === 'quiet') return;
        const chatId = currentChatId();
        if (!chatId) return;
        // The next member of a group chat carries on the same generation.
        if (!gen || gen.stopped || gen.chatId !== chatId) gen = { chatId, type: '', landed: new Set(), stopped: false };
        gen.type = String(type || 'normal');
        emit('GENERATION_STARTED', { chatId });
    });

    es.on(ev.CHARACTER_MESSAGE_RENDERED, (index, type) => {
        if (!gen || gen.stopped) return;
        if (SKIP_TYPES.includes(String(type))) return;
        const n = Number(index);
        if (Number.isInteger(n) && n >= 0) gen.landed.add(n);
        settle();
    });

    es.on(ev.GENERATION_ENDED, () => {
        if (gen && !gen.stopped) settle();
    });

    es.on(ev.GENERATION_STOPPED, () => {
        if (!gen || gen.stopped) return;
        gen.stopped = true;
        clearTimeout(timer);
        emit('GENERATION_STOPPED', { chatId: gen.chatId });
    });

    if (ev.WORLD_INFO_ACTIVATED) es.on(ev.WORLD_INFO_ACTIVATED, noteLore);
    es.on(ev.CHAT_CHANGED, () => {
        if (gen && !gen.stopped) emit('GENERATION_STOPPED', { chatId: gen.chatId });
        gen = null;
        clearTimeout(timer);
    });
}

// ---- the object the engine is given ----
export function createHost(toPanel) {
    const listeners = new Map();
    let fromPanel = null;

    const emit = (name, payload) => {
        for (const fn of listeners.get(name) || []) {
            try {
                const out = fn(payload);
                if (out && typeof out.catch === 'function') out.catch((e) => console.warn('[Auto Refine]', e));
            } catch (e) {
                console.warn('[Auto Refine]', e);
            }
        }
    };

    const toast = {};
    for (const kind of ['success', 'info', 'warning', 'error']) {
        toast[kind] = (text) => {
            try { toastr[kind](String(text), 'Auto Refine'); } catch (_) { /* no toastr */ }
        };
    }

    const spindle = {
        chat: { getMessages, updateMessage },
        chats: {
            get: getChat,
            async getActive() {
                const id = currentChatId();
                return id ? getChat(id) : null;
            },
        },
        characters: { get: getCharacter },
        generate: { quiet },
        world_books: worldBooks,
        macros: {
            async resolve(text) {
                return ctx().substituteParams(String(text));
            },
        },
        tokens: {
            async countText(text) {
                return { total_tokens: await ctx().getTokenCountAsync(String(text || '')) };
            },
        },
        connections: { async list() { return connectionList(); } },
        userStorage,
        storage,
        toast,
        log: {
            info: (...a) => console.info('[Auto Refine]', ...a),
            warn: (...a) => console.warn('[Auto Refine]', ...a),
        },
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        onFrontendMessage(fn) {
            fromPanel = fn;
        },
        sendToFrontend(msg) {
            // Later, like a message between two processes, so a reply never
            // arrives inside the call that asked for it.
            setTimeout(() => {
                try { toPanel(msg); } catch (e) { console.warn('[Auto Refine]', e); }
            }, 0);
        },
        // The engine follows the connection a chat's replies used through this.
        // A refine with no profile picked uses SillyTavern's connected API,
        // which is the chat's connection already, so there is nothing to note.
        registerInterceptor() {},
    };

    wireEvents(emit);

    return {
        spindle,
        send(msg) {
            if (!fromPanel) throw new Error('the engine is not running');
            const out = fromPanel(msg, undefined);
            if (out && typeof out.catch === 'function') out.catch((e) => console.warn('[Auto Refine]', e));
        },
    };
}
