/**
 * EventChronicle — Structured event-based summary extension for SillyTavern.
 *
 * Three generation types:
 *   1. Events   — plot events with location, characters, detail, consequences
 *   2. Characters — character cards (name, appearance, relationship)
 *   3. Preferences — adult character preferences/fetishes
 *
 * Data lives in chat metadata under `extension_settings.EventChronicle`.
 * Per-chat data (records) lives in `chat_metadata.EventChronicle`.
 */

import {
    saveSettingsDebounced,
    generateRaw,
    setExtensionPrompt as baseSetExtensionPrompt,
    eventSource,
    event_types,
} from "../../../../script.js";

import {
    extension_settings,
    getContext,
} from "../../../extensions.js";

// ---------- constants ----------

const extensionName = "EventChronicle";
const extensionFolderPath = `scripts/extensions/third_party/${extensionName}`;
const setExtensionPrompt = /** @type {any} */ (baseSetExtensionPrompt);
const generateRawUnsafe = /** @type {any} */ (generateRaw);

// Generation types
const GEN_EVENTS = "events";
const GEN_CHARACTERS = "characters";
const GEN_PREFERENCES = "preferences";

// ---------- default prompts ----------

const DEFAULT_PROMPTS = {
    [GEN_EVENTS]: `You are a skilled reteller of roleplay events. Your task is to extract ALL significant plot events from the provided chat messages.

For each event, provide:
- title: short name for the event
- location: where it happened
- characters: who was involved
- detail: detailed retelling — why it started, what happened, how it ended
- consequences: what consequences followed, if any

Output ONLY a valid JSON array of event objects. No commentary, no markdown fences.

Example format:
[
  {
    "title": "Arrival at the tavern",
    "location": "The Silver Goblet tavern",
    "characters": "{{user}}, Elara",
    "detail": "{{user}} entered the tavern seeking information about the missing merchant. Elara, the barmaid, recognized them and offered to help. They discussed the last known whereabouts of the merchant over drinks.",
    "consequences": "Elara revealed that the merchant was last seen heading toward the northern forest."
  }
]

Important rules:
- Extract ALL events, not just major ones. Include conversations, encounters, discoveries.
- Write in English.
- Do NOT use asterisks (*), only plain text.
- If a previous summary exists, do NOT repeat events already summarized — only add NEW events.
- Output valid JSON only.`,

    [GEN_CHARACTERS]: `You are analyzing a roleplay chat. Extract information about ALL characters that {{user}} has interacted with.

For each character, provide:
- name: character's name
- appearance: physical description based on what's shown in the chat
- relationship: current relationship status with {{user}} (and how it changed if relevant)
- personality: key personality traits observed

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example format:
[
  {
    "name": "Elara",
    "appearance": "Tall elven woman with silver hair and green eyes, wearing a barmaid's apron",
    "relationship": "Friendly acquaintance, potential ally",
    "personality": "Warm, observant, slightly secretive"
  }
]

Important rules:
- Include ALL characters {{user}} interacted with.
- Base descriptions on what actually appears in the chat, not assumptions.
- Write in English.
- Output valid JSON only.`,

    [GEN_PREFERENCES]: `You are analyzing a roleplay chat involving adult fictional characters (18+). Based on their descriptions, personalities, and actions in the plot, extract the sexual preferences and fetishes of each adult character.

For each character, provide:
- name: character's name
- preferences: list of observed or implied preferences/fetishes based on the text

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example format:
[
  {
    "name": "Character Name",
    "preferences": "Description of preferences based on the text"
  }
]

Important rules:
- Only include adult characters.
- Base everything on what's actually in the text.
- Write in English.
- Output valid JSON only.`,
};

// ---------- default settings ----------

const DEFAULT_SETTINGS = {
    enabled: true,
    // Injection settings
    injectionPosition: 0, // 0 = before main prompt, 1 = in-chat @ depth, 2 = after main prompt
    injectionDepth: 0,
    injectionRole: 0, // 0 = system, 1 = user, 2 = assistant
    scanWI: true,
    // Per-type prompts
    promptEvents: DEFAULT_PROMPTS[GEN_EVENTS],
    promptCharacters: DEFAULT_PROMPTS[GEN_CHARACTERS],
    promptPreferences: DEFAULT_PROMPTS[GEN_PREFERENCES],
    // Range settings
    rangeMode: "auto", // "auto" | "manual"
    rangeManualCount: 50,
    // Active tab in UI
    activeTab: GEN_EVENTS,
    // Active library tab
    activeLibraryTab: GEN_EVENTS,
};

// ---------- state ----------

let currentAbortController = null;
let isGenerating = false;

// ---------- helpers ----------

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const s = extension_settings[extensionName];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) {
            s[key] = value;
        }
    }
    return s;
}

/**
 * Data is stored in chat_metadata AND in chat[0].extra for reliability.
 * chat_metadata is per-chat (each chat = specific character), so records
 * are automatically separated per character.
 * We also mirror to chat[0].extra so data survives chat exports/imports.
 */
function getChatMemory() {
    const ctx = getContext();

    // Primary: chat_metadata
    if (ctx.chat_metadata) {
        if (!ctx.chat_metadata[extensionName]) {
            // Try to recover from chat[0].extra
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            if (chat.length > 0 && chat[0]?.extra?.[extensionName]) {
                ctx.chat_metadata[extensionName] = chat[0].extra[extensionName];
            } else {
                ctx.chat_metadata[extensionName] = { records: [] };
            }
        }
        return ctx.chat_metadata[extensionName];
    }

    return { records: [] };
}

function setChatMemory(data) {
    const ctx = getContext();
    if (!ctx.chat_metadata) return;

    if (!ctx.chat_metadata[extensionName]) {
        ctx.chat_metadata[extensionName] = { records: [] };
    }
    Object.assign(ctx.chat_metadata[extensionName], data);

    // Mirror to chat[0].extra for persistence across exports
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (chat.length > 0) {
        if (!chat[0].extra) chat[0].extra = {};
        chat[0].extra[extensionName] = ctx.chat_metadata[extensionName];
    }

    if (ctx.saveMetadata) {
        ctx.saveMetadata();
    }
    if (ctx.saveChat) {
        ctx.saveChat();
    }
}

function getAbsoluteChatLength() {
    const ctx = getContext();
    return Array.isArray(ctx.chat) ? ctx.chat.length : 0;
}

function uid() {
    return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
}

function cleanMessage(mes) {
    if (!mes) return "";
    return String(mes)
        .replace(/<[^>]*>/g, "")
        .replace(/\r\n/g, "\n")
        .trim();
}

// ---------- AI generation ----------

async function safeGenerateRaw(promptText, prefillText = "") {
    if (currentAbortController) {
        currentAbortController.abort();
    }
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    const finalPrompt = prefillText
        ? `${promptText}\n\n${prefillText}`
        : promptText;

    let result;
    try {
        if (generateRawUnsafe.length === 1) {
            result = await generateRawUnsafe({ prompt: finalPrompt, signal });
        } else {
            result = await generateRawUnsafe(finalPrompt, undefined, true, true);
        }
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.error(`${extensionName}: generateRaw failed`, err);
        throw err;
    }
    return String(result || "").trim();
}

function parseJSONResponse(text) {
    let cleaned = String(text || "");
    // Strip markdown fences
    cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");
    // Find the JSON array
    const startIdx = cleaned.indexOf("[");
    const endIdx = cleaned.lastIndexOf("]");
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        throw new Error("No JSON array found in AI response");
    }
    const jsonStr = cleaned.substring(startIdx, endIdx + 1);
    return JSON.parse(jsonStr);
}

// ---------- message collection ----------

/**
 * Get the message index where the last record of a given type ends.
 * Returns -1 if no records exist for this type.
 */
function getLastRecordEndIndex(type) {
    const mem = getChatMemory();
    const records = (mem.records || []).filter((r) => r.type === type);
    if (records.length === 0) return -1;

    let maxEnd = -1;
    for (const rec of records) {
        if (rec.messageRange && rec.messageRange.to > maxEnd) {
            maxEnd = rec.messageRange.to;
        }
    }
    return maxEnd;
}

/**
 * Collect chat messages for generation.
 * In "auto" mode: from the end of last record to current end of chat.
 * In "manual" mode: last N messages.
 * If "all": all visible messages.
 */
function collectMessages(type, mode, manualCount) {
    const ctx = getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (chat.length === 0) return { messages: [], fromIdx: 0, toIdx: 0 };

    let fromIdx = 0;
    let toIdx = chat.length - 1;

    if (mode === "auto") {
        const lastEnd = getLastRecordEndIndex(type);
        if (lastEnd >= 0) {
            fromIdx = lastEnd + 1;
        }
    } else if (mode === "manual") {
        const count = Math.max(1, parseInt(manualCount) || 50);
        fromIdx = Math.max(0, chat.length - count);
    }
    // else "all" — fromIdx stays 0

    if (fromIdx > toIdx) {
        return { messages: [], fromIdx, toIdx };
    }

    const messages = [];
    for (let i = fromIdx; i <= toIdx; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const name = m.name || (m.is_user ? "User" : "Character");
        const text = cleanMessage(m.mes);
        if (text) {
            messages.push({ index: i, name, text, is_user: m.is_user });
        }
    }

    return { messages, fromIdx, toIdx };
}

// ---------- generation ----------

async function generate(type) {
    if (isGenerating) {
        toastr.warning("Generation already in progress");
        return;
    }

    const settings = getSettings();
    const { messages, fromIdx, toIdx } = collectMessages(
        type,
        settings.rangeMode,
        settings.rangeManualCount,
    );

    if (messages.length === 0) {
        toastr.warning("No messages to summarize in this range");
        return;
    }

    isGenerating = true;
    const btn = $(`#ec-btn-generate-${type}`);
    const originalText = btn.html();
    btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Generating...');
    btn.prop("disabled", true);

    try {
        // Build the chat text
        const chatText = messages
            .map((m) => `${m.name}: ${m.text}`)
            .join("\n\n");

        // Get the existing summary for context (so AI doesn't repeat)
        const mem = getChatMemory();
        const existingRecords = (mem.records || []).filter(
            (r) => r.type === type,
        );
        let existingContext = "";
        if (existingRecords.length > 0) {
            existingContext = buildInjectionTextForType(type);
        }

        // Get the prompt for this type
        let prompt;
        if (type === GEN_EVENTS) {
            prompt = settings.promptEvents || DEFAULT_PROMPTS[GEN_EVENTS];
        } else if (type === GEN_CHARACTERS) {
            prompt = settings.promptCharacters || DEFAULT_PROMPTS[GEN_CHARACTERS];
        } else {
            prompt = settings.promptPreferences || DEFAULT_PROMPTS[GEN_PREFERENCES];
        }

        // Replace {{user}} placeholder
        const ctx = getContext();
        const userName = ctx.name1 || "User";
        const charName = ctx.name2 || "Character";
        prompt = prompt.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);

        // Compose the full prompt
        let fullPrompt = prompt + "\n\n";
        if (existingContext) {
            fullPrompt += `EXISTING SUMMARY (do NOT repeat these, only add NEW information):\n${existingContext}\n\n`;
        }
        fullPrompt += `CHAT MESSAGES (messages ${fromIdx + 1} to ${toIdx + 1}):\n${chatText}`;

        const prefill =
            "Here is the extracted information as a valid JSON array:\n[";
        const result = await safeGenerateRaw(fullPrompt, prefill);

        // Parse the response
        let parsed;
        try {
            // Try to parse — the prefill starts with "[" so the result might not include it
            const fullResult = "[" + result;
            parsed = parseJSONResponse(fullResult);
        } catch {
            try {
                parsed = parseJSONResponse(result);
            } catch (e2) {
                console.error(`${extensionName}: Failed to parse AI response`, result);
                throw new Error("AI returned invalid JSON. Try again or adjust the prompt.");
            }
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
            toastr.warning("AI returned no items. The chat may not contain relevant content for this type.");
            return;
        }

        // Create a new record
        const record = {
            id: `rec-${uid()}`,
            type,
            messageRange: { from: fromIdx, to: toIdx },
            createdAt: Date.now(),
            items: parsed.map((item) => ({
                id: `evt-${uid()}`,
                ...item,
            })),
        };

        // Save
        const records = [...(mem.records || []), record];
        setChatMemory({ records });

        toastr.success(
            `Generated ${record.items.length} ${type === GEN_EVENTS ? "events" : type === GEN_CHARACTERS ? "characters" : "preferences"} from messages ${fromIdx + 1}–${toIdx + 1}`,
        );

        // Refresh UI
        renderLibrary();
        updateContextInjection();
    } catch (err) {
        if (err.name === "AbortError") {
            toastr.info("Generation cancelled");
            return;
        }
        console.error(`${extensionName}:`, err);
        toastr.error(`Generation failed: ${err.message}`);
    } finally {
        isGenerating = false;
        btn.html(originalText);
        btn.prop("disabled", false);
    }
}

// ---------- context injection ----------

function buildInjectionTextForType(type) {
    const mem = getChatMemory();
    const records = (mem.records || [])
        .filter((r) => r.type === type)
        .sort((a, b) => (a.messageRange?.from || 0) - (b.messageRange?.from || 0));

    if (records.length === 0) return "";

    const parts = [];

    for (const rec of records) {
        const from = (rec.messageRange?.from || 0) + 1;
        const to = (rec.messageRange?.to || 0) + 1;
        let recText = `[Record: messages ${from}–${to}]\n`;

        if (type === GEN_EVENTS) {
            for (let i = 0; i < rec.items.length; i++) {
                const ev = rec.items[i];
                recText += `\nEVENT ${i + 1}: ${ev.title || "Untitled"}\n`;
                if (ev.location) recText += `Location: ${ev.location}\n`;
                if (ev.characters) recText += `Characters: ${ev.characters}\n`;
                if (ev.detail) recText += `Detail: ${ev.detail}\n`;
                if (ev.consequences) recText += `Consequences: ${ev.consequences}\n`;
            }
        } else if (type === GEN_CHARACTERS) {
            for (const ch of rec.items) {
                recText += `\n${ch.name || "Unknown"}:\n`;
                if (ch.appearance) recText += `  Appearance: ${ch.appearance}\n`;
                if (ch.relationship) recText += `  Relationship: ${ch.relationship}\n`;
                if (ch.personality) recText += `  Personality: ${ch.personality}\n`;
            }
        } else if (type === GEN_PREFERENCES) {
            for (const p of rec.items) {
                recText += `\n${p.name || "Unknown"}: ${p.preferences || "N/A"}\n`;
            }
        }

        parts.push(recText.trim());
    }

    return parts.join("\n\n");
}

function updateContextInjection() {
    const settings = getSettings();
    if (!settings.enabled) {
        setExtensionPrompt(extensionName, "", 0, 0, false, 0);
        return;
    }

    const chatLength = getAbsoluteChatLength();
    if (chatLength === 0) {
        setExtensionPrompt(extensionName, "", 0, 0, false, 0);
        return;
    }

    // Build combined text from all types
    const eventText = buildInjectionTextForType(GEN_EVENTS);
    const charText = buildInjectionTextForType(GEN_CHARACTERS);
    const prefText = buildInjectionTextForType(GEN_PREFERENCES);

    const sections = [];
    if (eventText) sections.push(`<story_events>\n${eventText}\n</story_events>`);
    if (charText) sections.push(`<character_profiles>\n${charText}\n</character_profiles>`);
    if (prefText) sections.push(`<character_preferences>\n${prefText}\n</character_preferences>`);

    const fullText = sections.join("\n\n");

    if (!fullText.trim()) {
        setExtensionPrompt(extensionName, "", 0, 0, false, 0);
        return;
    }

    setExtensionPrompt(
        extensionName,
        fullText + "\n",
        parseInt(settings.injectionPosition) || 0,
        parseInt(settings.injectionDepth) || 0,
        settings.scanWI !== false,
        parseInt(settings.injectionRole) || 0,
    );
}

// ---------- library / record management ----------

function deleteRecord(recordId) {
    const mem = getChatMemory();
    const records = (mem.records || []).filter((r) => r.id !== recordId);
    setChatMemory({ records });
    renderLibrary();
    updateContextInjection();
}

function deleteItem(recordId, itemId) {
    const mem = getChatMemory();
    const records = mem.records || [];
    const rec = records.find((r) => r.id === recordId);
    if (!rec) return;
    rec.items = (rec.items || []).filter((it) => it.id !== itemId);
    if (rec.items.length === 0) {
        // Remove the whole record if empty
        setChatMemory({ records: records.filter((r) => r.id !== recordId) });
    } else {
        setChatMemory({ records });
    }
    renderLibrary();
    updateContextInjection();
}

function updateItem(recordId, itemId, newData) {
    const mem = getChatMemory();
    const records = mem.records || [];
    const rec = records.find((r) => r.id === recordId);
    if (!rec) return;
    const item = (rec.items || []).find((it) => it.id === itemId);
    if (!item) return;
    Object.assign(item, newData);
    setChatMemory({ records });
    updateContextInjection();
}

function addManualItem(recordId, type) {
    const mem = getChatMemory();
    const records = mem.records || [];
    const rec = records.find((r) => r.id === recordId);
    if (!rec) return;

    let newItem;
    if (type === GEN_EVENTS) {
        newItem = {
            id: `evt-${uid()}`,
            title: "New Event",
            location: "",
            characters: "",
            detail: "",
            consequences: "",
        };
    } else if (type === GEN_CHARACTERS) {
        newItem = {
            id: `evt-${uid()}`,
            name: "New Character",
            appearance: "",
            relationship: "",
            personality: "",
        };
    } else {
        newItem = {
            id: `evt-${uid()}`,
            name: "Character Name",
            preferences: "",
        };
    }

    rec.items.push(newItem);
    setChatMemory({ records });
    renderLibrary();
    updateContextInjection();

    // Auto-expand the record and open edit form on the new item
    const recEl = $(`.ec-record[data-record-id="${recordId}"]`);
    if (recEl.length) {
        const itemsDiv = recEl.find(".ec-record-items");
        itemsDiv.show();
        recEl.find(".ec-btn-toggle-record i")
            .removeClass("fa-chevron-down")
            .addClass("fa-chevron-up");
        // Open edit form on the newly added item
        const newItemEl = recEl.find(`.ec-item[data-item-id="${newItem.id}"]`);
        if (newItemEl.length) {
            newItemEl.find(".ec-item-body").hide();
            newItemEl.find(".ec-item-edit-form").show();
            newItemEl.find(".ec-item-actions").hide();
        }
    }
}

function addManualRecord(type) {
    const mem = getChatMemory();
    const chatLength = getAbsoluteChatLength();
    const record = {
        id: `rec-${uid()}`,
        type,
        messageRange: { from: 0, to: Math.max(0, chatLength - 1) },
        createdAt: Date.now(),
        items: [],
    };
    const records = [...(mem.records || []), record];
    setChatMemory({ records });

    // Immediately add one empty item
    addManualItem(record.id, type);
}

// ---------- UI rendering ----------

function renderLibrary() {
    const settings = getSettings();
    const mem = getChatMemory();
    const activeType = settings.activeLibraryTab || GEN_EVENTS;
    const records = (mem.records || [])
        .filter((r) => r.type === activeType)
        .sort((a, b) => (a.messageRange?.from || 0) - (b.messageRange?.from || 0));

    const container = $("#ec-library-list");
    if (!container.length) return;
    container.empty();

    if (records.length === 0) {
        container.html(
            '<div class="ec-empty">No records yet. Generate a summary or add one manually.</div>',
        );
        return;
    }

    for (const rec of records) {
        const from = (rec.messageRange?.from || 0) + 1;
        const to = (rec.messageRange?.to || 0) + 1;
        const date = new Date(rec.createdAt).toLocaleString();

        let itemsHtml = "";

        for (const item of rec.items || []) {
            itemsHtml += renderItemCard(rec.id, item, activeType);
        }

        const recordHtml = `
        <div class="ec-record" data-record-id="${escapeHtml(rec.id)}">
            <div class="ec-record-header">
                <div class="ec-record-info">
                    <span class="ec-record-range">Messages ${from}–${to}</span>
                    <span class="ec-record-date">${escapeHtml(date)}</span>
                    <span class="ec-record-count">${(rec.items || []).length} items</span>
                </div>
                <div class="ec-record-actions">
                    <button class="ec-btn-icon ec-btn-add-item" title="Add item">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button class="ec-btn-icon ec-btn-toggle-record" title="Expand/collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <button class="ec-btn-icon ec-btn-delete-record" title="Delete record">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="ec-record-items" style="display: none;">
                ${itemsHtml}
            </div>
        </div>`;

        container.append(recordHtml);
    }
}

function renderItemCard(recordId, item, type) {
    if (type === GEN_EVENTS) {
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title">${escapeHtml(item.title || "Untitled")}</span>
                <div class="ec-item-actions">
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                <div class="ec-item-field"><strong>Location:</strong> ${escapeHtml(item.location || "—")}</div>
                <div class="ec-item-field"><strong>Characters:</strong> ${escapeHtml(item.characters || "—")}</div>
                <div class="ec-item-field"><strong>Detail:</strong> ${escapeHtml(item.detail || "—")}</div>
                <div class="ec-item-field"><strong>Consequences:</strong> ${escapeHtml(item.consequences || "—")}</div>
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Title</label>
                <input type="text" class="text_pole ec-edit-title" value="${escapeHtml(item.title || "")}">
                <label>Location</label>
                <input type="text" class="text_pole ec-edit-location" value="${escapeHtml(item.location || "")}">
                <label>Characters</label>
                <input type="text" class="text_pole ec-edit-characters" value="${escapeHtml(item.characters || "")}">
                <label>Detail</label>
                <textarea class="text_pole ec-edit-detail" rows="3">${escapeHtml(item.detail || "")}</textarea>
                <label>Consequences</label>
                <textarea class="text_pole ec-edit-consequences" rows="2">${escapeHtml(item.consequences || "")}</textarea>
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    } else if (type === GEN_CHARACTERS) {
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title">${escapeHtml(item.name || "Unknown")}</span>
                <div class="ec-item-actions">
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                <div class="ec-item-field"><strong>Appearance:</strong> ${escapeHtml(item.appearance || "—")}</div>
                <div class="ec-item-field"><strong>Relationship:</strong> ${escapeHtml(item.relationship || "—")}</div>
                <div class="ec-item-field"><strong>Personality:</strong> ${escapeHtml(item.personality || "—")}</div>
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Name</label>
                <input type="text" class="text_pole ec-edit-name" value="${escapeHtml(item.name || "")}">
                <label>Appearance</label>
                <textarea class="text_pole ec-edit-appearance" rows="2">${escapeHtml(item.appearance || "")}</textarea>
                <label>Relationship</label>
                <input type="text" class="text_pole ec-edit-relationship" value="${escapeHtml(item.relationship || "")}">
                <label>Personality</label>
                <input type="text" class="text_pole ec-edit-personality" value="${escapeHtml(item.personality || "")}">
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    } else {
        // Preferences
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title">${escapeHtml(item.name || "Unknown")}</span>
                <div class="ec-item-actions">
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                <div class="ec-item-field">${escapeHtml(item.preferences || "—")}</div>
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Character Name</label>
                <input type="text" class="text_pole ec-edit-name" value="${escapeHtml(item.name || "")}">
                <label>Preferences</label>
                <textarea class="text_pole ec-edit-preferences" rows="3">${escapeHtml(item.preferences || "")}</textarea>
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    }
}

// ---------- settings HTML ----------

function getSettingsHtml() {
    return `
    <div id="ec-settings" class="ec-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>EventChronicle</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display: none;">

                <!-- Enable toggle -->
                <div class="ec-setting-row">
                    <label class="checkbox_label">
                        <input type="checkbox" id="ec-enabled">
                        <span>Enable context injection</span>
                    </label>
                </div>

                <!-- Generation tabs -->
                <div class="ec-tabs ec-gen-tabs">
                    <button class="ec-tab active" data-tab="${GEN_EVENTS}">
                        <i class="fa-solid fa-scroll"></i> Events
                    </button>
                    <button class="ec-tab" data-tab="${GEN_CHARACTERS}">
                        <i class="fa-solid fa-users"></i> Characters
                    </button>
                    <button class="ec-tab" data-tab="${GEN_PREFERENCES}">
                        <i class="fa-solid fa-heart"></i> Preferences
                    </button>
                </div>

                <!-- Per-tab content -->
                <div class="ec-tab-content" data-for="${GEN_EVENTS}">
                    <label>Events prompt:</label>
                    <textarea class="text_pole ec-prompt-input" id="ec-prompt-events" rows="6"></textarea>
                </div>
                <div class="ec-tab-content" data-for="${GEN_CHARACTERS}" style="display: none;">
                    <label>Characters prompt:</label>
                    <textarea class="text_pole ec-prompt-input" id="ec-prompt-characters" rows="6"></textarea>
                </div>
                <div class="ec-tab-content" data-for="${GEN_PREFERENCES}" style="display: none;">
                    <label>Preferences prompt:</label>
                    <textarea class="text_pole ec-prompt-input" id="ec-prompt-preferences" rows="6"></textarea>
                </div>

                <!-- Range settings -->
                <div class="ec-setting-row ec-range-row">
                    <label>Message range:</label>
                    <select id="ec-range-mode" class="text_pole">
                        <option value="auto">Auto (from last record)</option>
                        <option value="manual">Last N messages</option>
                        <option value="all">All messages</option>
                    </select>
                    <input type="number" id="ec-range-count" class="text_pole ec-range-count-input"
                           min="1" value="50" placeholder="Count">
                </div>

                <!-- Generate button -->
                <div class="ec-setting-row ec-gen-row">
                    <button class="menu_button" id="ec-btn-generate-events">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Events
                    </button>
                    <button class="menu_button" id="ec-btn-generate-characters" style="display: none;">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Characters
                    </button>
                    <button class="menu_button" id="ec-btn-generate-preferences" style="display: none;">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Preferences
                    </button>
                </div>

                <!-- Injection settings -->
                <div class="ec-setting-group">
                    <div class="ec-setting-row">
                        <label>Injection position:</label>
                        <select id="ec-injection-position" class="text_pole">
                            <option value="0">Before Main Prompt</option>
                            <option value="1">In-Chat @ Depth</option>
                            <option value="2">After Main Prompt</option>
                        </select>
                    </div>
                    <div class="ec-setting-row ec-depth-row">
                        <label>Depth:</label>
                        <input type="number" id="ec-injection-depth" class="text_pole" min="0" value="0">
                    </div>
                    <div class="ec-setting-row">
                        <label>Role:</label>
                        <select id="ec-injection-role" class="text_pole">
                            <option value="0">System</option>
                            <option value="1">User</option>
                            <option value="2">Assistant</option>
                        </select>
                    </div>
                </div>

                <hr>

                <!-- Library -->
                <div class="ec-library-header">
                    <b>Library</b>
                    <button class="ec-btn-icon" id="ec-btn-add-record" title="Add record manually">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>

                <!-- Library type tabs -->
                <div class="ec-tabs ec-lib-tabs">
                    <button class="ec-lib-tab active" data-type="${GEN_EVENTS}">Events</button>
                    <button class="ec-lib-tab" data-type="${GEN_CHARACTERS}">Characters</button>
                    <button class="ec-lib-tab" data-type="${GEN_PREFERENCES}">Preferences</button>
                </div>

                <div id="ec-library-list" class="ec-library-list"></div>

            </div>
        </div>
    </div>`;
}

// ---------- event handlers ----------

function bindEventHandlers() {
    const settings = getSettings();

    // Enable toggle
    $("#ec-enabled")
        .prop("checked", settings.enabled)
        .on("change", function () {
            settings.enabled = $(this).prop("checked");
            saveSettingsDebounced();
            updateContextInjection();
        });

    // Generation tabs
    $(document).on("click", ".ec-gen-tabs .ec-tab", function () {
        const tab = $(this).data("tab");
        $(".ec-gen-tabs .ec-tab").removeClass("active");
        $(this).addClass("active");
        $(".ec-tab-content").hide();
        $(`.ec-tab-content[data-for="${tab}"]`).show();

        // Show the right generate button
        $('[id^="ec-btn-generate-"]').hide();
        $(`#ec-btn-generate-${tab}`).show();

        settings.activeTab = tab;
        saveSettingsDebounced();
    });

    // Library type tabs
    $(document).on("click", ".ec-lib-tabs .ec-lib-tab", function () {
        const type = $(this).data("type");
        $(".ec-lib-tabs .ec-lib-tab").removeClass("active");
        $(this).addClass("active");
        settings.activeLibraryTab = type;
        saveSettingsDebounced();
        renderLibrary();
    });

    // Prompt inputs — save on change
    $(document).on("input", "#ec-prompt-events", function () {
        settings.promptEvents = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on("input", "#ec-prompt-characters", function () {
        settings.promptCharacters = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on("input", "#ec-prompt-preferences", function () {
        settings.promptPreferences = $(this).val();
        saveSettingsDebounced();
    });

    // Range settings
    $("#ec-range-mode")
        .val(settings.rangeMode)
        .on("change", function () {
            settings.rangeMode = $(this).val();
            $(".ec-range-count-input").toggle(settings.rangeMode === "manual");
            saveSettingsDebounced();
        });

    $("#ec-range-count")
        .val(settings.rangeManualCount)
        .on("change", function () {
            settings.rangeManualCount = parseInt($(this).val()) || 50;
            saveSettingsDebounced();
        });

    // Injection settings
    $("#ec-injection-position")
        .val(settings.injectionPosition)
        .on("change", function () {
            settings.injectionPosition = parseInt($(this).val());
            $(".ec-depth-row").toggle(settings.injectionPosition === 1);
            saveSettingsDebounced();
            updateContextInjection();
        });

    $("#ec-injection-depth")
        .val(settings.injectionDepth)
        .on("change", function () {
            settings.injectionDepth = parseInt($(this).val()) || 0;
            saveSettingsDebounced();
            updateContextInjection();
        });

    $("#ec-injection-role")
        .val(settings.injectionRole)
        .on("change", function () {
            settings.injectionRole = parseInt($(this).val());
            saveSettingsDebounced();
            updateContextInjection();
        });

    // Generate buttons
    $(document).on("click", "#ec-btn-generate-events", () => generate(GEN_EVENTS));
    $(document).on("click", "#ec-btn-generate-characters", () => generate(GEN_CHARACTERS));
    $(document).on("click", "#ec-btn-generate-preferences", () => generate(GEN_PREFERENCES));

    // Library — toggle record expand
    $(document).on("click", ".ec-btn-toggle-record", function () {
        const record = $(this).closest(".ec-record");
        const items = record.find(".ec-record-items");
        const icon = $(this).find("i");
        items.slideToggle(200);
        icon.toggleClass("fa-chevron-down fa-chevron-up");
    });

    // Library — also toggle on header click (but not on buttons)
    $(document).on("click", ".ec-record-header .ec-record-info", function () {
        $(this).closest(".ec-record").find(".ec-btn-toggle-record").click();
    });

    // Delete record
    $(document).on("click", ".ec-btn-delete-record", function () {
        const recordId = $(this).closest(".ec-record").data("record-id");
        if (confirm("Delete this record and all its items?")) {
            deleteRecord(recordId);
        }
    });

    // Add item to record
    $(document).on("click", ".ec-btn-add-item", function () {
        const recordId = $(this).closest(".ec-record").data("record-id");
        const type = settings.activeLibraryTab || GEN_EVENTS;
        addManualItem(recordId, type);
    });

    // Add new record manually
    $(document).on("click", "#ec-btn-add-record", function () {
        const type = settings.activeLibraryTab || GEN_EVENTS;
        addManualRecord(type);
    });

    // Delete item
    $(document).on("click", ".ec-btn-delete-item", function () {
        const el = $(this).closest(".ec-item");
        const recordId = el.data("record-id");
        const itemId = el.data("item-id");
        deleteItem(recordId, itemId);
    });

    // Edit item — show form
    $(document).on("click", ".ec-btn-edit-item", function () {
        const el = $(this).closest(".ec-item");
        el.find(".ec-item-body").hide();
        el.find(".ec-item-edit-form").show();
        el.find(".ec-item-actions").hide();
    });

    // Cancel edit
    $(document).on("click", ".ec-btn-cancel-edit", function () {
        const el = $(this).closest(".ec-item");
        el.find(".ec-item-body").show();
        el.find(".ec-item-edit-form").hide();
        el.find(".ec-item-actions").show();
    });

    // Save edit
    $(document).on("click", ".ec-btn-save-item", function () {
        const el = $(this).closest(".ec-item");
        const recordId = el.data("record-id");
        const itemId = el.data("item-id");
        const type = settings.activeLibraryTab || GEN_EVENTS;

        let newData;
        if (type === GEN_EVENTS) {
            newData = {
                title: el.find(".ec-edit-title").val(),
                location: el.find(".ec-edit-location").val(),
                characters: el.find(".ec-edit-characters").val(),
                detail: el.find(".ec-edit-detail").val(),
                consequences: el.find(".ec-edit-consequences").val(),
            };
        } else if (type === GEN_CHARACTERS) {
            newData = {
                name: el.find(".ec-edit-name").val(),
                appearance: el.find(".ec-edit-appearance").val(),
                relationship: el.find(".ec-edit-relationship").val(),
                personality: el.find(".ec-edit-personality").val(),
            };
        } else {
            newData = {
                name: el.find(".ec-edit-name").val(),
                preferences: el.find(".ec-edit-preferences").val(),
            };
        }

        updateItem(recordId, itemId, newData);
        renderLibrary();
    });

    // Initialize UI state
    $(".ec-range-count-input").toggle(settings.rangeMode === "manual");
    $(".ec-depth-row").toggle(parseInt(settings.injectionPosition) === 1);
}

function loadSettingsUI() {
    const settings = getSettings();
    $("#ec-enabled").prop("checked", settings.enabled);
    $("#ec-prompt-events").val(settings.promptEvents);
    $("#ec-prompt-characters").val(settings.promptCharacters);
    $("#ec-prompt-preferences").val(settings.promptPreferences);
    $("#ec-range-mode").val(settings.rangeMode);
    $("#ec-range-count").val(settings.rangeManualCount);
    $("#ec-injection-position").val(settings.injectionPosition);
    $("#ec-injection-depth").val(settings.injectionDepth);
    $("#ec-injection-role").val(settings.injectionRole);

    // Activate the right tabs
    const activeTab = settings.activeTab || GEN_EVENTS;
    $(".ec-gen-tabs .ec-tab").removeClass("active");
    $(`.ec-gen-tabs .ec-tab[data-tab="${activeTab}"]`).addClass("active");
    $(".ec-tab-content").hide();
    $(`.ec-tab-content[data-for="${activeTab}"]`).show();
    $('[id^="ec-btn-generate-"]').hide();
    $(`#ec-btn-generate-${activeTab}`).show();

    const activeLibTab = settings.activeLibraryTab || GEN_EVENTS;
    $(".ec-lib-tabs .ec-lib-tab").removeClass("active");
    $(`.ec-lib-tabs .ec-lib-tab[data-type="${activeLibTab}"]`).addClass("active");
}

// ---------- initialization ----------

jQuery(async () => {
    const settingsHtml = getSettingsHtml();
    $("#extensions_settings2").append(settingsHtml);

    loadSettingsUI();
    bindEventHandlers();

    // Hook into ST events
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderLibrary();
        updateContextInjection();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        updateContextInjection();
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
        updateContextInjection();
    });

    // Initial render
    renderLibrary();
    updateContextInjection();

    console.log(`${extensionName}: loaded`);
});
