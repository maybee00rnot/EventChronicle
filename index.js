/**
 * EventChronicle — Structured event-based summary extension for SillyTavern.
 *
 * Six generation types:
 *   1. Events        — plot events grouped by in-world day
 *   2. Characters    — character profiles
 *   3. Preferences   — adult character preferences (18+)
 *   4. Locations     — scene/location memory for world consistency
 *   5. Relationships — relationship network between all characters
 *   6. Secrets      — character secrets with status tracking
 *
 * Data lives in chat[0].extra.EventChronicle (per-character storage).
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

const GEN_EVENTS = "events";
const GEN_CHARACTERS = "characters";
const GEN_PREFERENCES = "preferences";
const GEN_LOCATIONS = "locations";
const GEN_RELATIONSHIPS = "relationships";
const GEN_SECRETS = "secrets";

// ---------- default prompts ----------

const DEFAULT_PROMPTS = {
    [GEN_EVENTS]: `You are a skilled reteller of roleplay events. Extract ALL significant plot events from the provided chat messages.

For EACH event, provide these fields:
- date: the in-world date when this event happens (see date rules below)
- title: short name for the event
- location: where it happened
- characters: who was involved
- detail: detailed retelling — why it started, what happened, how it ended
- consequences: what consequences followed, if any

═══ How to determine the "date" field ═══
Scan the chat for time indicators:
- Explicit dates/timestamps (e.g., "2026/02/14", "14 февраля", time markers in narration)
- Day transitions: sleeping/waking, "next morning", "на следующий день", time skips
- Relative references: "three days later", "the following week"
- Fantasy calendars: "Third Day of Frostfall Moon", festival names
- Context: meals (breakfast=morning), sunlight/darkness

Date rules:
- If explicit dates exist in the text, use them exactly.
- If no explicit date but day boundaries are clear, use "Day 1", "Day 2", etc.
- Multiple events on the same day MUST have the same date value.
- A new day starts ONLY at clear transitions (sleep, explicit "next day", time jump).
- When unsure, keep events on the same day.

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example:
[
  {
    "date": "2026/02/14",
    "title": "Arrival at the tavern",
    "location": "The Silver Goblet tavern",
    "characters": "{{user}}, Elara",
    "detail": "{{user}} entered the tavern seeking information about the missing merchant. Elara offered to help.",
    "consequences": "Elara revealed the merchant was last seen heading north."
  },
  {
    "date": "2026/02/14",
    "title": "Bar fight",
    "location": "The Silver Goblet tavern",
    "characters": "{{user}}, drunk patron",
    "detail": "A drunk patron provoked {{user}}. {{user}} defused the situation by buying the man a drink.",
    "consequences": "The patron shared a rumor about bandits on the northern road."
  },
  {
    "date": "2026/02/15",
    "title": "Journey to the forest",
    "location": "Northern Forest road",
    "characters": "{{user}}, Elara",
    "detail": "{{user}} and Elara set out at dawn following the merchant's trail.",
    "consequences": "They found tracks leading off the main road."
  }
]

Rules:
- Extract ALL events, not just major ones.
- Events on the same in-world day must share the same "date" value.
- Do NOT use asterisks (*), only plain text.
- Write in English.
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

    [GEN_LOCATIONS]: `You are analyzing a roleplay chat. Extract information about ALL locations/places that appear or are described in the chat.

For each location, provide:
- name: location name. Use the · separator to show hierarchy (e.g., "Silver Goblet·Hall", "Silver Goblet·Room 203", "Royal Palace·Throne Room")
- description: PERMANENT physical features only — structure, materials, fixed furniture, architectural details, window directions, permanent decorations, relative position within parent location. Do NOT include temporary states like weather, lighting, crowd size, time-specific ambiance.
- parentLocation: the parent location name if this is a sub-location (e.g., for "Silver Goblet·Hall" the parent is "Silver Goblet"). Empty string if top-level.

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example format:
[
  {
    "name": "Silver Goblet",
    "description": "Two-story wooden building at the north road near the forest edge. Ground floor has the main hall and kitchen, upper floor has guest rooms. Faded wooden sign above the entrance.",
    "parentLocation": ""
  },
  {
    "name": "Silver Goblet·Hall",
    "description": "Located on the first floor. Tall wooden hall with a long bar counter in the center, several round tables, fireplace on the east wall, trophy antlers above the mantle.",
    "parentLocation": "Silver Goblet"
  }
]

Important rules:
- Only permanent physical features. No weather, lighting, mood, crowds, temporary objects.
- Same location must always use exactly the same name.
- Sub-locations describe position relative to their parent, not repeating the parent's external geography.
- Write in English.
- Output valid JSON only.`,

    [GEN_RELATIONSHIPS]: `You are analyzing a roleplay chat. Extract ALL notable relationships between characters — not just with {{user}}, but between all characters.

For each relationship, provide:
- character1: first character's name
- character2: second character's name
- type: relationship type (friend, enemy, lover, employer, rival, family, ally, acquaintance, mentor, servant, etc.)
- details: specifics about the relationship — how it formed, current state, any tensions or dynamics

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example format:
[
  {
    "character1": "{{user}}",
    "character2": "Elara",
    "type": "ally",
    "details": "Elara helps {{user}} find the missing merchant. She seems to have a personal stake in the investigation."
  },
  {
    "character1": "Elara",
    "character2": "Marcus",
    "type": "former lovers",
    "details": "They were together years ago. Elara still holds resentment over how it ended."
  }
]

Important rules:
- Include ALL character pairs that have a notable relationship.
- Include relationships between NPCs, not just with {{user}}.
- Mention {{user}} by name in descriptions where relevant.
- Write in English.
- Output valid JSON only.`,

    [GEN_SECRETS]: `You are analyzing a roleplay chat. Extract ALL character secrets — information known to some characters but hidden from others, or strong hints of hidden truths.

For each secret, provide:
- holder: the character who holds or knows the secret
- secret: what the secret is
- knownBy: who else knows about this secret (comma-separated names, or "no one" if only the holder knows)
- status: one of "hidden" (actively concealed), "suspected" (others have hints/suspicions), "revealed" (has been uncovered/confessed)
- hints: any clues or foreshadowing that appeared in the chat about this secret

Output ONLY a valid JSON array. No commentary, no markdown fences.

Example format:
[
  {
    "holder": "Elara",
    "secret": "She is actually a spy sent by the Northern Kingdom to monitor the tavern's visitors",
    "knownBy": "no one",
    "status": "hidden",
    "hints": "She asked unusually specific questions about travelers from the north. She was seen writing a coded letter late at night."
  },
  {
    "holder": "Marcus",
    "secret": "He murdered the merchant and hid the body in the cellar",
    "knownBy": "Elara",
    "status": "suspected",
    "hints": "Blood stains on his sleeve he tried to hide. Elara noticed the cellar door was locked with a new padlock."
  }
]

Important rules:
- Only include secrets known to characters but hidden from others, or strong hints of hidden truths.
- Do NOT include completely unknown twists that no character has any awareness of.
- Include the current status accurately — if a secret was revealed during the chat, mark it as "revealed".
- Write in English.
- Output valid JSON only.`,
};

// ---------- default settings ----------

const DEFAULT_SETTINGS = {
    enabled: true,
    injectionPosition: 0,
    injectionDepth: 0,
    injectionRole: 0,
    scanWI: true,
    promptEvents: DEFAULT_PROMPTS[GEN_EVENTS],
    promptCharacters: DEFAULT_PROMPTS[GEN_CHARACTERS],
    promptPreferences: DEFAULT_PROMPTS[GEN_PREFERENCES],
    promptLocations: DEFAULT_PROMPTS[GEN_LOCATIONS],
    promptRelationships: DEFAULT_PROMPTS[GEN_RELATIONSHIPS],
    promptSecrets: DEFAULT_PROMPTS[GEN_SECRETS],
    rangeMode: "auto",
    rangeManualCount: 50,
    connectionProfileId: "",
    autoUpdateEnabled: false,
    autoUpdateEvents: 0,
    autoUpdateCharacters: 0,
    autoUpdatePreferences: 0,
    autoUpdateLocations: 0,
    autoUpdateRelationships: 0,
    autoUpdateSecrets: 0,
    activeTab: GEN_EVENTS,
    activeLibraryTab: GEN_EVENTS,
    activeMainTab: "settings",
};

// ---------- state ----------

let currentAbortController = null;
let isGenerating = false;
let autoUpdateQueue = [];
let autoUpdateProcessing = false;

// ---------- helpers ----------

// Old default prompts for migration detection — if user's saved prompt matches
// an old default, it gets replaced with the new one automatically.
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

    // Migrate: if the events prompt doesn't contain the date-detection block or still has horae refs, upgrade it
    if (
        s.promptEvents &&
        (!s.promptEvents.includes("How to determine the") || s.promptEvents.includes("horae"))
    ) {
        console.log(`${extensionName}: Migrating events prompt to v3 (flat format with date detection)`);
        s.promptEvents = DEFAULT_PROMPTS[GEN_EVENTS];
        saveSettingsDebounced();
    }

    // Migrate: add new prompt fields that didn't exist before
    if (!s.promptLocations) { s.promptLocations = DEFAULT_PROMPTS[GEN_LOCATIONS]; }
    if (!s.promptRelationships) { s.promptRelationships = DEFAULT_PROMPTS[GEN_RELATIONSHIPS]; }
    if (!s.promptSecrets) { s.promptSecrets = DEFAULT_PROMPTS[GEN_SECRETS]; }

    return s;
}

/**
 * Data is stored in chat[0].extra (same approach as SunnyMemories).
 * ctx.chat is a reference to the real chat array, so modifications persist.
 * Each chat is per-character, so records are automatically separated.
 */
function getChatMemory() {
    const ctx = getContext();
    if (!ctx || !ctx.chat || ctx.chat.length === 0) return { records: [] };
    const mes = ctx.chat[0];
    if (!mes.extra) mes.extra = {};
    if (!mes.extra[extensionName]) {
        mes.extra[extensionName] = { records: [] };
    }
    // Migrate old event records: add date field to items that don't have it
    const data = mes.extra[extensionName];
    for (const rec of data.records || []) {
        if (rec.type === GEN_EVENTS) {
            for (const item of rec.items || []) {
                if (!item.date) item.date = "Unknown";
            }
        }
    }
    return data;
}

function setChatMemory(data) {
    const ctx = getContext();
    if (!ctx || !ctx.chat || ctx.chat.length === 0) return;
    const mes = ctx.chat[0];
    if (!mes.extra) mes.extra = {};
    if (!mes.extra[extensionName]) {
        mes.extra[extensionName] = { records: [] };
    }
    Object.assign(mes.extra[extensionName], data);
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

// ---------- connection profiles ----------

function getCurrentProfileName() {
    try {
        const cm = extension_settings?.connectionManager;
        if (!cm || !cm.selectedProfile) return "";
        const profile = cm.profiles?.find((p) => p.id === cm.selectedProfile);
        return profile ? profile.name : "";
    } catch { return ""; }
}

function getExtensionProfileId() {
    return extension_settings[extensionName]?.connectionProfileId || "";
}

function getExtensionProfileName() {
    const id = getExtensionProfileId();
    if (!id) return "";
    const profile = extension_settings?.connectionManager?.profiles?.find(
        (p) => p.id === id,
    );
    return profile?.name || "";
}

async function switchProfile(profileName) {
    const cm = extension_settings?.connectionManager;
    if (!cm || !cm.profiles) return;

    const profilesSelect = document.getElementById("connection_profiles");
    if (!profilesSelect) return;

    let targetId = "";
    if (profileName) {
        const profile = cm.profiles.find((p) => p.name === profileName);
        if (profile) targetId = profile.id;
    }

    const awaitPromise = new Promise((resolve) => {
        const onLoaded = () => {
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
            resolve();
        };
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
        setTimeout(() => {
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, onLoaded);
            resolve();
        }, 5000);
    });

    /** @type {HTMLSelectElement} */ (profilesSelect).value = targetId;
    profilesSelect.dispatchEvent(new Event("change"));

    await awaitPromise;
    await new Promise((resolve) => setTimeout(resolve, 1000));
}

function updateProfilesList() {
    const select = $("#ec-connection-profile");
    if (!select.length) return;

    const savedId = getExtensionProfileId();
    select.empty().append('<option value="">Same as current</option>');

    try {
        const cm = extension_settings?.connectionManager;
        if (cm && cm.profiles) {
            for (const p of cm.profiles) {
                select.append($("<option></option>").val(p.id).text(p.name));
            }
        }
    } catch {}

    select.val(savedId);
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
    cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");
    const startIdx = cleaned.indexOf("[");
    const endIdx = cleaned.lastIndexOf("]");
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        throw new Error("No JSON array found in AI response");
    }
    const jsonStr = cleaned.substring(startIdx, endIdx + 1);
    return JSON.parse(jsonStr);
}

// ---------- message collection ----------

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

    // Profile switching: use a different API profile if configured
    const targetProfileName = getExtensionProfileName();
    const originalProfileName = targetProfileName ? getCurrentProfileName() : "";
    const needsProfileSwitch = targetProfileName && targetProfileName !== originalProfileName;

    try {
        if (needsProfileSwitch) {
            console.log(`${extensionName}: Switching to profile "${targetProfileName}" for generation`);
            await switchProfile(targetProfileName);
        }
        const chatText = messages
            .map((m) => `${m.name}: ${m.text}`)
            .join("\n\n");

        let prompt;
        if (type === GEN_EVENTS) {
            prompt = settings.promptEvents || DEFAULT_PROMPTS[GEN_EVENTS];
        } else if (type === GEN_CHARACTERS) {
            prompt = settings.promptCharacters || DEFAULT_PROMPTS[GEN_CHARACTERS];
        } else if (type === GEN_PREFERENCES) {
            prompt = settings.promptPreferences || DEFAULT_PROMPTS[GEN_PREFERENCES];
        } else if (type === GEN_LOCATIONS) {
            prompt = settings.promptLocations || DEFAULT_PROMPTS[GEN_LOCATIONS];
        } else if (type === GEN_RELATIONSHIPS) {
            prompt = settings.promptRelationships || DEFAULT_PROMPTS[GEN_RELATIONSHIPS];
        } else {
            prompt = settings.promptSecrets || DEFAULT_PROMPTS[GEN_SECRETS];
        }

        const ctx = getContext();
        const userName = ctx.name1 || "User";
        const charName = ctx.name2 || "Character";
        prompt = prompt.replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);

        let fullPrompt = prompt + "\n\n";
        fullPrompt += `CHAT MESSAGES (messages ${fromIdx + 1} to ${toIdx + 1}):\n${chatText}`;

        const prefill =
            "Here is the extracted information as a valid JSON array:\n[";
        const result = await safeGenerateRaw(fullPrompt, prefill);

        let parsed;
        try {
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

        // Build record items
        let items;
        let totalCount;

        if (type === GEN_EVENTS) {
            // AI returns array of {date, events[]} or flat array of events
            items = [];
            if (parsed.length > 0 && parsed[0].events && Array.isArray(parsed[0].events)) {
                // Grouped by day format
                for (const day of parsed) {
                    const date = day.date || "Unknown";
                    for (const ev of day.events || []) {
                        items.push({ id: `evt-${uid()}`, date, ...ev });
                    }
                }
            } else {
                // Flat format (fallback)
                for (const ev of parsed) {
                    items.push({ id: `evt-${uid()}`, date: ev.date || "Unknown", ...ev });
                }
            }
            totalCount = items.length;
        } else {
            items = parsed.map((item) => ({
                id: `evt-${uid()}`,
                ...item,
            }));
            totalCount = items.length;
        }

        const record = {
            id: `rec-${uid()}`,
            type,
            messageRange: { from: fromIdx, to: toIdx },
            createdAt: Date.now(),
            items,
        };

        const mem = getChatMemory();
        const records = [...(mem.records || []), record];
        setChatMemory({ records });

        const typeLabel = {
            [GEN_EVENTS]: "events",
            [GEN_CHARACTERS]: "characters",
            [GEN_PREFERENCES]: "preferences",
            [GEN_LOCATIONS]: "locations",
            [GEN_RELATIONSHIPS]: "relationships",
            [GEN_SECRETS]: "secrets",
        }[type] || type;

        toastr.success(
            `Generated ${totalCount} ${typeLabel} from messages ${fromIdx + 1}–${toIdx + 1}`,
        );

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
        if (needsProfileSwitch && originalProfileName !== undefined) {
            console.log(`${extensionName}: Switching back to profile "${originalProfileName || "default"}"`);
            try {
                await switchProfile(originalProfileName);
            } catch (e) {
                console.warn(`${extensionName}: Failed to switch back to original profile`, e);
            }
        }
        isGenerating = false;
        btn.html(originalText);
        btn.prop("disabled", false);
    }
}

// ---------- auto-update ----------

function getMessagesSinceLastRecord(type) {
    const mem = getChatMemory();
    const records = (mem.records || []).filter((r) => r.type === type);
    if (records.length === 0) {
        const ctx = getContext();
        return Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    }
    const lastRecord = records[records.length - 1];
    const lastTo = lastRecord.messageRange?.to ?? 0;
    const ctx = getContext();
    const chatLen = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    return Math.max(0, chatLen - 1 - lastTo);
}

function checkAutoUpdate() {
    const settings = getSettings();
    if (!settings.autoUpdateEnabled || isGenerating) return;

    const typeMap = {
        [GEN_EVENTS]: settings.autoUpdateEvents,
        [GEN_CHARACTERS]: settings.autoUpdateCharacters,
        [GEN_PREFERENCES]: settings.autoUpdatePreferences,
        [GEN_LOCATIONS]: settings.autoUpdateLocations,
        [GEN_RELATIONSHIPS]: settings.autoUpdateRelationships,
        [GEN_SECRETS]: settings.autoUpdateSecrets,
    };

    for (const [type, interval] of Object.entries(typeMap)) {
        if (!interval || interval <= 0) continue;
        const messagesSince = getMessagesSinceLastRecord(type);
        if (messagesSince >= interval && !autoUpdateQueue.includes(type)) {
            autoUpdateQueue.push(type);
        }
    }

    processAutoUpdateQueue();
}

async function processAutoUpdateQueue() {
    if (autoUpdateProcessing || isGenerating || autoUpdateQueue.length === 0) return;
    autoUpdateProcessing = true;

    while (autoUpdateQueue.length > 0 && !isGenerating) {
        const type = autoUpdateQueue.shift();
        console.log(`${extensionName}: Auto-generating ${type}`);
        try {
            await generate(type);
        } catch (e) {
            console.warn(`${extensionName}: Auto-update failed for ${type}`, e);
        }
        // Small delay between consecutive auto-generations
        if (autoUpdateQueue.length > 0) {
            await new Promise((r) => setTimeout(r, 2000));
        }
    }

    autoUpdateProcessing = false;
}

// ---------- context injection ----------

function buildInjectionTextForType(type) {
    const mem = getChatMemory();
    const records = (mem.records || [])
        .filter((r) => r.type === type)
        .sort((a, b) => (a.messageRange?.from || 0) - (b.messageRange?.from || 0));

    if (records.length === 0) return "";

    if (type === GEN_EVENTS) {
        // Collect all events, group by date across all records
        const byDate = new Map();
        for (const rec of records) {
            for (const item of rec.items || []) {
                const date = item.date || "Unknown";
                if (!byDate.has(date)) byDate.set(date, []);
                byDate.get(date).push(item);
            }
        }
        const parts = [];
        for (const [date, events] of byDate) {
            let section = `=== ${date} ===\n`;
            for (let i = 0; i < events.length; i++) {
                const ev = events[i];
                section += `\nEVENT ${i + 1}: ${ev.title || "Untitled"}\n`;
                if (ev.location) section += `Location: ${ev.location}\n`;
                if (ev.characters) section += `Characters: ${ev.characters}\n`;
                if (ev.detail) section += `Detail: ${ev.detail}\n`;
                if (ev.consequences) section += `Consequences: ${ev.consequences}\n`;
            }
            parts.push(section.trim());
        }
        return parts.join("\n\n");
    }

    if (type === GEN_CHARACTERS) {
        const parts = [];
        for (const rec of records) {
            for (const ch of rec.items || []) {
                let text = `${ch.name || "Unknown"}:\n`;
                if (ch.appearance) text += `  Appearance: ${ch.appearance}\n`;
                if (ch.relationship) text += `  Relationship: ${ch.relationship}\n`;
                if (ch.personality) text += `  Personality: ${ch.personality}\n`;
                parts.push(text.trim());
            }
        }
        return parts.join("\n\n");
    }

    if (type === GEN_PREFERENCES) {
        const parts = [];
        for (const rec of records) {
            for (const p of rec.items || []) {
                parts.push(`${p.name || "Unknown"}: ${p.preferences || "N/A"}`);
            }
        }
        return parts.join("\n");
    }

    if (type === GEN_LOCATIONS) {
        const parts = [];
        for (const rec of records) {
            for (const loc of rec.items || []) {
                let text = `${loc.name || "Unknown"}:`;
                if (loc.description) text += ` ${loc.description}`;
                parts.push(text);
            }
        }
        return parts.join("\n\n");
    }

    if (type === GEN_RELATIONSHIPS) {
        const parts = [];
        for (const rec of records) {
            for (const rel of rec.items || []) {
                const c1 = rel.character1 || "?";
                const c2 = rel.character2 || "?";
                const rtype = rel.type || "unknown";
                const details = rel.details || "";
                parts.push(`${c1} → ${c2}: ${rtype}${details ? " — " + details : ""}`);
            }
        }
        return parts.join("\n");
    }

    if (type === GEN_SECRETS) {
        const parts = [];
        for (const rec of records) {
            for (const s of rec.items || []) {
                const holder = s.holder || "Unknown";
                const status = (s.status || "hidden").toUpperCase();
                let text = `[${status}] ${holder}'s secret: ${s.secret || "N/A"}`;
                if (s.knownBy && s.knownBy !== "no one") text += `\n  Known by: ${s.knownBy}`;
                if (s.hints) text += `\n  Hints: ${s.hints}`;
                parts.push(text);
            }
        }
        return parts.join("\n\n");
    }

    return "";
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

    const eventText = buildInjectionTextForType(GEN_EVENTS);
    const charText = buildInjectionTextForType(GEN_CHARACTERS);
    const prefText = buildInjectionTextForType(GEN_PREFERENCES);
    const locText = buildInjectionTextForType(GEN_LOCATIONS);
    const relText = buildInjectionTextForType(GEN_RELATIONSHIPS);
    const secText = buildInjectionTextForType(GEN_SECRETS);

    const sections = [];
    if (eventText) sections.push(`<story_events>\n${eventText}\n</story_events>`);
    if (charText) sections.push(`<character_profiles>\n${charText}\n</character_profiles>`);
    if (prefText) sections.push(`<character_preferences>\n${prefText}\n</character_preferences>`);
    if (locText) sections.push(`<story_locations>\n${locText}\n</story_locations>`);
    if (relText) sections.push(`<character_relationships>\n${relText}\n</character_relationships>`);
    if (secText) sections.push(`<character_secrets>\n${secText}\n</character_secrets>`);

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

function createBlankItem(type, extraData = {}) {
    if (type === GEN_EVENTS) {
        return {
            id: `evt-${uid()}`,
            date: extraData.date || "New Day",
            title: "New Event",
            location: "",
            characters: "",
            detail: "",
            consequences: "",
        };
    } else if (type === GEN_CHARACTERS) {
        return {
            id: `evt-${uid()}`,
            name: "New Character",
            appearance: "",
            relationship: "",
            personality: "",
        };
    } else if (type === GEN_PREFERENCES) {
        return {
            id: `evt-${uid()}`,
            name: "Character Name",
            preferences: "",
        };
    } else if (type === GEN_LOCATIONS) {
        return {
            id: `evt-${uid()}`,
            name: "New Location",
            description: "",
            parentLocation: "",
        };
    } else if (type === GEN_RELATIONSHIPS) {
        return {
            id: `evt-${uid()}`,
            character1: "",
            character2: "",
            type: "",
            details: "",
        };
    } else if (type === GEN_SECRETS) {
        return {
            id: `evt-${uid()}`,
            holder: "",
            secret: "",
            knownBy: "no one",
            status: "hidden",
            hints: "",
        };
    }
    return { id: `evt-${uid()}` };
}

function addManualItem(recordId, type, extraData = {}) {
    const mem = getChatMemory();
    const records = mem.records || [];
    const rec = records.find((r) => r.id === recordId);
    if (!rec) {
        toastr.warning("Record not found");
        return;
    }

    const newItem = createBlankItem(type, extraData);
    rec.items.push(newItem);
    setChatMemory({ records });
    renderLibrary();
    updateContextInjection();

    // Auto-expand the record and open edit form on the new item
    const recEl = $(`.ec-record[data-record-id="${recordId}"]`);
    if (recEl.length) {
        const itemsDiv = recEl.find(".ec-record-items");
        itemsDiv.show();
        recEl.find("> .ec-record-header .ec-btn-toggle-record i")
            .removeClass("fa-chevron-down")
            .addClass("fa-chevron-up");

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

    const newItem = createBlankItem(type);
    const record = {
        id: `rec-${uid()}`,
        type,
        messageRange: { from: 0, to: Math.max(0, chatLength - 1) },
        createdAt: Date.now(),
        items: [newItem],
    };
    const records = [...(mem.records || []), record];
    setChatMemory({ records });
    renderLibrary();
    updateContextInjection();

    // Auto-expand the new record and open edit form
    const recEl = $(`.ec-record[data-record-id="${record.id}"]`);
    if (recEl.length) {
        const itemsDiv = recEl.find(".ec-record-items");
        itemsDiv.show();
        recEl.find("> .ec-record-header .ec-btn-toggle-record i")
            .removeClass("fa-chevron-down")
            .addClass("fa-chevron-up");
        const newItemEl = recEl.find(`.ec-item[data-item-id="${newItem.id}"]`);
        if (newItemEl.length) {
            newItemEl.find(".ec-item-body").hide();
            newItemEl.find(".ec-item-edit-form").show();
            newItemEl.find(".ec-item-actions").hide();
        }
    }
}

// ---------- import / export ----------

function exportRecords() {
    const mem = getChatMemory();
    const records = mem.records || [];
    if (records.length === 0) {
        toastr.warning("Nothing to export — no records found");
        return;
    }

    const ctx = getContext();
    const charName = (ctx.name2 || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `EventChronicle_${charName}_${timestamp}.json`;

    const data = JSON.stringify({ version: 3, exportedAt: Date.now(), records }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${records.length} records to ${filename}`);
}

function importRecords(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const parsed = JSON.parse(e.target.result);
            let importedRecords;

            if (parsed.version && Array.isArray(parsed.records)) {
                importedRecords = parsed.records;
            } else if (Array.isArray(parsed)) {
                importedRecords = parsed;
            } else {
                throw new Error("Unrecognized format");
            }

            if (importedRecords.length === 0) {
                toastr.warning("The file contains no records");
                return;
            }

            for (const rec of importedRecords) {
                if (!rec.type || !Array.isArray(rec.items)) {
                    throw new Error("Invalid record structure — each record needs 'type' and 'items'");
                }
                if (!rec.id) rec.id = `rec-${uid()}`;
                for (const item of rec.items) {
                    if (!item.id) item.id = `evt-${uid()}`;
                }
                // Migrate old events: ensure date field
                if (rec.type === GEN_EVENTS) {
                    for (const item of rec.items) {
                        if (!item.date) item.date = "Unknown";
                    }
                }
            }

            const mem = getChatMemory();
            const mode = confirm(
                `Import ${importedRecords.length} records.\n\nOK = Merge with existing records\nCancel = Replace all existing records`
            );

            if (mode) {
                const existing = mem.records || [];
                const records = [...existing, ...importedRecords];
                setChatMemory({ records });
                toastr.success(`Merged ${importedRecords.length} records (total: ${records.length})`);
            } else {
                setChatMemory({ records: importedRecords });
                toastr.success(`Replaced with ${importedRecords.length} imported records`);
            }

            renderLibrary();
            updateContextInjection();
        } catch (err) {
            console.error(`${extensionName}: Import failed`, err);
            toastr.error(`Import failed: ${err.message}`);
        }
    };
    reader.readAsText(file);
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

        let countLabel;
        let itemsHtml = "";

        if (activeType === GEN_EVENTS) {
            // Group items by date for display
            const dateGroups = new Map();
            for (const item of rec.items || []) {
                const d = item.date || "Unknown";
                if (!dateGroups.has(d)) dateGroups.set(d, []);
                dateGroups.get(d).push(item);
            }
            const totalEvents = (rec.items || []).length;
            const totalDays = dateGroups.size;
            countLabel = `${totalDays} ${totalDays === 1 ? "day" : "days"}, ${totalEvents} ${totalEvents === 1 ? "event" : "events"}`;

            for (const [dayDate, events] of dateGroups) {
                itemsHtml += `<div class="ec-day-group" data-day-date="${escapeHtml(dayDate)}">
                    <div class="ec-day-header">
                        <div class="ec-day-info">
                            <i class="fa-regular fa-calendar"></i>
                            <span class="ec-day-date">${escapeHtml(dayDate)}</span>
                            <span class="ec-day-count">${events.length} ${events.length === 1 ? "event" : "events"}</span>
                        </div>
                        <div class="ec-day-actions">
                            <button class="ec-btn-icon ec-btn-add-event-to-day" title="Add event to this day">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                            <button class="ec-btn-icon ec-btn-toggle-day" title="Collapse/expand day">
                                <i class="fa-solid fa-chevron-up"></i>
                            </button>
                        </div>
                    </div>
                    <div class="ec-day-events">`;

                for (const ev of events) {
                    itemsHtml += renderEventCard(rec.id, ev);
                }

                itemsHtml += `</div></div>`;
            }
        } else {
            countLabel = `${(rec.items || []).length} items`;
            for (const item of rec.items || []) {
                itemsHtml += renderItemCard(rec.id, item, activeType);
            }
        }

        const recordHtml = `
        <div class="ec-record" data-record-id="${escapeHtml(rec.id)}">
            <div class="ec-record-header">
                <div class="ec-record-info">
                    <span class="ec-record-range">Messages ${from}–${to}</span>
                    <span class="ec-record-date">${escapeHtml(date)}</span>
                    <span class="ec-record-count">${countLabel}</span>
                </div>
                <div class="ec-record-actions">
                    <button class="ec-btn-icon ec-btn-add-item" title="${activeType === GEN_EVENTS ? 'Add new day' : 'Add item'}">
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

function renderEventCard(recordId, item) {
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
            <label>Day/Date</label>
            <input type="text" class="text_pole ec-edit-date" value="${escapeHtml(item.date || "")}">
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
}

function renderItemCard(recordId, item, type) {
    if (type === GEN_CHARACTERS) {
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
    }

    if (type === GEN_PREFERENCES) {
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

    if (type === GEN_LOCATIONS) {
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title"><i class="fa-solid fa-map-pin" style="opacity:0.5; margin-right:4px;"></i>${escapeHtml(item.name || "Unknown")}</span>
                <div class="ec-item-actions">
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                ${item.parentLocation ? `<div class="ec-item-field"><strong>Part of:</strong> ${escapeHtml(item.parentLocation)}</div>` : ""}
                <div class="ec-item-field">${escapeHtml(item.description || "—")}</div>
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Name (use · for hierarchy, e.g. "Tavern·Hall")</label>
                <input type="text" class="text_pole ec-edit-name" value="${escapeHtml(item.name || "")}">
                <label>Parent Location</label>
                <input type="text" class="text_pole ec-edit-parentLocation" value="${escapeHtml(item.parentLocation || "")}">
                <label>Description (permanent physical features only)</label>
                <textarea class="text_pole ec-edit-description" rows="3">${escapeHtml(item.description || "")}</textarea>
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    if (type === GEN_RELATIONSHIPS) {
        const label = (item.character1 && item.character2)
            ? `${item.character1} → ${item.character2}`
            : "New Relationship";
        const typeLabel = item.type ? ` (${item.type})` : "";
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title"><i class="fa-solid fa-arrows-left-right" style="opacity:0.5; margin-right:4px;"></i>${escapeHtml(label)}${escapeHtml(typeLabel)}</span>
                <div class="ec-item-actions">
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                <div class="ec-item-field">${escapeHtml(item.details || "—")}</div>
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Character 1</label>
                <input type="text" class="text_pole ec-edit-character1" value="${escapeHtml(item.character1 || "")}">
                <label>Character 2</label>
                <input type="text" class="text_pole ec-edit-character2" value="${escapeHtml(item.character2 || "")}">
                <label>Relationship Type</label>
                <input type="text" class="text_pole ec-edit-reltype" value="${escapeHtml(item.type || "")}">
                <label>Details</label>
                <textarea class="text_pole ec-edit-details" rows="2">${escapeHtml(item.details || "")}</textarea>
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    if (type === GEN_SECRETS) {
        const status = item.status || "hidden";
        const statusClass = `status-${status}`;
        return `
        <div class="ec-item" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}">
            <div class="ec-item-header">
                <span class="ec-item-title"><i class="fa-solid fa-user-secret" style="opacity:0.5; margin-right:4px;"></i>${escapeHtml(item.holder || "Unknown")}</span>
                <div class="ec-item-actions">
                    <button class="ec-secret-status-btn ${statusClass}" data-record-id="${escapeHtml(recordId)}" data-item-id="${escapeHtml(item.id)}" title="Click to change status">${escapeHtml(status.toUpperCase())}</button>
                    <button class="ec-btn-icon ec-btn-edit-item" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="ec-btn-icon ec-btn-delete-item" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
            <div class="ec-item-body">
                <div class="ec-item-field"><strong>Secret:</strong> ${escapeHtml(item.secret || "—")}</div>
                <div class="ec-item-field"><strong>Known by:</strong> ${escapeHtml(item.knownBy || "no one")}</div>
                ${item.hints ? `<div class="ec-item-field"><strong>Hints:</strong> ${escapeHtml(item.hints)}</div>` : ""}
            </div>
            <div class="ec-item-edit-form" style="display: none;">
                <label>Secret Holder</label>
                <input type="text" class="text_pole ec-edit-holder" value="${escapeHtml(item.holder || "")}">
                <label>Secret</label>
                <textarea class="text_pole ec-edit-secret" rows="2">${escapeHtml(item.secret || "")}</textarea>
                <label>Known By (comma-separated, or "no one")</label>
                <input type="text" class="text_pole ec-edit-knownBy" value="${escapeHtml(item.knownBy || "")}">
                <label>Status</label>
                <select class="text_pole ec-edit-status">
                    <option value="hidden" ${status === "hidden" ? "selected" : ""}>Hidden</option>
                    <option value="suspected" ${status === "suspected" ? "selected" : ""}>Suspected</option>
                    <option value="revealed" ${status === "revealed" ? "selected" : ""}>Revealed</option>
                </select>
                <label>Hints / Foreshadowing</label>
                <textarea class="text_pole ec-edit-hints" rows="2">${escapeHtml(item.hints || "")}</textarea>
                <div class="ec-edit-buttons">
                    <button class="menu_button ec-btn-save-item">Save</button>
                    <button class="menu_button ec-btn-cancel-edit">Cancel</button>
                </div>
            </div>
        </div>`;
    }

    return "";
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

                <!-- Main section tabs: Settings vs Chronicle -->
                <div class="ec-tabs ec-main-tabs">
                    <button class="ec-main-tab active" data-main-tab="settings">
                        <i class="fa-solid fa-gear"></i> Settings
                    </button>
                    <button class="ec-main-tab" data-main-tab="chronicle">
                        <i class="fa-solid fa-book"></i> Chronicle
                    </button>
                </div>

                <!-- ========== SETTINGS PANEL ========== -->
                <div class="ec-main-panel" data-main-panel="settings">

                    <!-- Enable toggle -->
                    <div class="ec-setting-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="ec-enabled">
                            <span>Enable context injection</span>
                        </label>
                    </div>

                    <!-- Injection settings -->
                    <div class="ec-setting-group">
                        <div class="ec-setting-row" style="margin-bottom: 2px;">
                            <b style="font-size: 0.85em; opacity: 0.7;"><i class="fa-solid fa-syringe" style="margin-right: 4px;"></i>Context Injection</b>
                        </div>
                        <div class="ec-setting-row">
                            <label>Position:</label>
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

                    <!-- Generation settings -->
                    <div class="ec-setting-group">
                        <div class="ec-setting-row" style="margin-bottom: 2px;">
                            <b style="font-size: 0.85em; opacity: 0.7;"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right: 4px;"></i>Generation</b>
                        </div>
                        <div class="ec-setting-row">
                            <label>Message range:</label>
                            <select id="ec-range-mode" class="text_pole">
                                <option value="auto">Auto (from last record)</option>
                                <option value="manual">Last N messages</option>
                                <option value="all">All messages</option>
                            </select>
                            <input type="number" id="ec-range-count" class="text_pole ec-range-count-input"
                                   min="1" value="50" placeholder="Count">
                        </div>
                        <div class="ec-setting-row">
                            <label>API profile:</label>
                            <select id="ec-connection-profile" class="text_pole">
                                <option value="">Same as current</option>
                            </select>
                        </div>
                        <div class="ec-setting-row" style="opacity: 0.5; font-size: 0.78em; padding-left: 4px;">
                            Use a cheaper model for generation while keeping your main model for RP
                        </div>
                    </div>

                    <!-- Auto-update settings -->
                    <div class="ec-setting-group">
                        <div class="ec-setting-row" style="margin-bottom: 2px;">
                            <b style="font-size: 0.85em; opacity: 0.7;"><i class="fa-solid fa-arrows-rotate" style="margin-right: 4px;"></i>Auto-Update</b>
                        </div>
                        <div class="ec-setting-row">
                            <label class="checkbox_label">
                                <input type="checkbox" id="ec-auto-update-enabled">
                                <span>Enable auto-update</span>
                            </label>
                        </div>
                        <div class="ec-auto-update-sections">
                            <div class="ec-auto-row"><i class="fa-solid fa-scroll"></i><span class="ec-auto-label">Events</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-events" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div class="ec-auto-row"><i class="fa-solid fa-users"></i><span class="ec-auto-label">Characters</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-characters" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div class="ec-auto-row"><i class="fa-solid fa-heart"></i><span class="ec-auto-label">Preferences</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-preferences" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div class="ec-auto-row"><i class="fa-solid fa-map-marker-alt"></i><span class="ec-auto-label">Locations</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-locations" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div class="ec-auto-row"><i class="fa-solid fa-project-diagram"></i><span class="ec-auto-label">Relationships</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-relationships" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div class="ec-auto-row"><i class="fa-solid fa-user-secret"></i><span class="ec-auto-label">Secrets</span><span class="ec-auto-mid">every</span><input type="number" id="ec-auto-secrets" class="text_pole ec-auto-input" min="0" value="0"><span class="ec-auto-suffix">msg</span></div>
                            <div style="font-size: 0.75em; opacity: 0.45; padding: 2px 0 0 4px;">0 = disabled for that type</div>
                        </div>
                    </div>

                </div>

                <!-- ========== CHRONICLE PANEL ========== -->
                <div class="ec-main-panel" data-main-panel="chronicle" style="display: none;">

                    <!-- Generation tabs -->
                    <div class="ec-tabs ec-gen-tabs">
                        <button class="ec-tab active" data-tab="${GEN_EVENTS}">
                            <i class="fa-solid fa-scroll"></i> Events
                        </button>
                        <button class="ec-tab" data-tab="${GEN_CHARACTERS}">
                            <i class="fa-solid fa-users"></i> Chars
                        </button>
                        <button class="ec-tab" data-tab="${GEN_PREFERENCES}">
                            <i class="fa-solid fa-heart"></i> Prefs
                        </button>
                        <button class="ec-tab" data-tab="${GEN_LOCATIONS}">
                            <i class="fa-solid fa-map-marker-alt"></i> Locs
                        </button>
                        <button class="ec-tab" data-tab="${GEN_RELATIONSHIPS}">
                            <i class="fa-solid fa-project-diagram"></i> Rels
                        </button>
                        <button class="ec-tab" data-tab="${GEN_SECRETS}">
                            <i class="fa-solid fa-user-secret"></i> Secrets
                        </button>
                    </div>

                    <!-- Per-tab prompt + generate -->
                    <div class="ec-tab-content" data-for="${GEN_EVENTS}">
                        <div class="ec-prompt-header"><label>Events prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_EVENTS}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-events" rows="6"></textarea>
                    </div>
                    <div class="ec-tab-content" data-for="${GEN_CHARACTERS}" style="display: none;">
                        <div class="ec-prompt-header"><label>Characters prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_CHARACTERS}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-characters" rows="6"></textarea>
                    </div>
                    <div class="ec-tab-content" data-for="${GEN_PREFERENCES}" style="display: none;">
                        <div class="ec-prompt-header"><label>Preferences prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_PREFERENCES}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-preferences" rows="6"></textarea>
                    </div>
                    <div class="ec-tab-content" data-for="${GEN_LOCATIONS}" style="display: none;">
                        <div class="ec-prompt-header"><label>Locations prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_LOCATIONS}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-locations" rows="6"></textarea>
                    </div>
                    <div class="ec-tab-content" data-for="${GEN_RELATIONSHIPS}" style="display: none;">
                        <div class="ec-prompt-header"><label>Relationships prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_RELATIONSHIPS}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-relationships" rows="6"></textarea>
                    </div>
                    <div class="ec-tab-content" data-for="${GEN_SECRETS}" style="display: none;">
                        <div class="ec-prompt-header"><label>Secrets prompt:</label><button class="ec-btn-icon ec-btn-reset-prompt" data-prompt-type="${GEN_SECRETS}" title="Reset to default"><i class="fa-solid fa-rotate-left"></i></button></div>
                        <textarea class="text_pole ec-prompt-input" id="ec-prompt-secrets" rows="6"></textarea>
                    </div>

                    <!-- Generate buttons (one per type, only active one is visible) -->
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
                        <button class="menu_button" id="ec-btn-generate-locations" style="display: none;">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Locations
                        </button>
                        <button class="menu_button" id="ec-btn-generate-relationships" style="display: none;">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Relationships
                        </button>
                        <button class="menu_button" id="ec-btn-generate-secrets" style="display: none;">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> Generate Secrets
                        </button>
                    </div>

                    <hr>

                    <!-- Library -->
                    <div class="ec-library-header">
                        <b>Library</b>
                        <div style="display: flex; gap: 4px; align-items: center;">
                            <button class="ec-btn-icon" id="ec-btn-export" title="Export all records to JSON">
                                <i class="fa-solid fa-file-export"></i>
                            </button>
                            <button class="ec-btn-icon" id="ec-btn-import" title="Import records from JSON">
                                <i class="fa-solid fa-file-import"></i>
                            </button>
                            <button class="ec-btn-icon" id="ec-btn-add-record" title="Add record manually">
                                <i class="fa-solid fa-plus"></i>
                            </button>
                        </div>
                    </div>
                    <input type="file" id="ec-import-file" accept=".json" style="display: none;">

                    <div id="ec-library-list" class="ec-library-list"></div>

                </div>

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

    // Main section tabs (Settings / Chronicle)
    $(document).on("click", ".ec-main-tabs .ec-main-tab", function () {
        const tab = $(this).data("main-tab");
        $(".ec-main-tabs .ec-main-tab").removeClass("active");
        $(this).addClass("active");
        $(".ec-main-panel").hide();
        $(`.ec-main-panel[data-main-panel="${tab}"]`).show();
        settings.activeMainTab = tab;
        saveSettingsDebounced();
        if (tab === "chronicle") renderLibrary();
    });

    // Generation tabs (also switches library view)
    $(document).on("click", ".ec-gen-tabs .ec-tab", function () {
        const tab = $(this).data("tab");
        $(".ec-gen-tabs .ec-tab").removeClass("active");
        $(this).addClass("active");
        $(".ec-tab-content").hide();
        $(`.ec-tab-content[data-for="${tab}"]`).show();
        $('[id^="ec-btn-generate-"]').hide();
        $(`#ec-btn-generate-${tab}`).show();
        settings.activeTab = tab;
        settings.activeLibraryTab = tab;
        saveSettingsDebounced();
        renderLibrary();
    });

    // Prompt inputs
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
    $(document).on("input", "#ec-prompt-locations", function () {
        settings.promptLocations = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on("input", "#ec-prompt-relationships", function () {
        settings.promptRelationships = $(this).val();
        saveSettingsDebounced();
    });
    $(document).on("input", "#ec-prompt-secrets", function () {
        settings.promptSecrets = $(this).val();
        saveSettingsDebounced();
    });

    // Reset prompt to default
    $(document).on("click", ".ec-btn-reset-prompt", function () {
        const promptType = $(this).data("prompt-type");
        if (!confirm("Reset this prompt to the default? Your custom changes will be lost.")) return;

        const promptMap = {
            [GEN_EVENTS]: { key: "promptEvents", el: "#ec-prompt-events" },
            [GEN_CHARACTERS]: { key: "promptCharacters", el: "#ec-prompt-characters" },
            [GEN_PREFERENCES]: { key: "promptPreferences", el: "#ec-prompt-preferences" },
            [GEN_LOCATIONS]: { key: "promptLocations", el: "#ec-prompt-locations" },
            [GEN_RELATIONSHIPS]: { key: "promptRelationships", el: "#ec-prompt-relationships" },
            [GEN_SECRETS]: { key: "promptSecrets", el: "#ec-prompt-secrets" },
        };

        const info = promptMap[promptType];
        if (!info) return;

        settings[info.key] = DEFAULT_PROMPTS[promptType];
        $(info.el).val(settings[info.key]);
        saveSettingsDebounced();
        toastr.success("Prompt reset to default");
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

    // Connection profile selector
    $(document).on("change", "#ec-connection-profile", function () {
        const settings = getSettings();
        settings.connectionProfileId = $(this).val() || "";
        saveSettingsDebounced();
    });

    // Auto-update settings
    $("#ec-auto-update-enabled").on("change", function () {
        settings.autoUpdateEnabled = $(this).prop("checked");
        $(".ec-auto-update-sections").toggle(settings.autoUpdateEnabled);
        saveSettingsDebounced();
    });
    $(".ec-auto-update-sections").toggle(!!settings.autoUpdateEnabled);

    const autoFields = {
        "#ec-auto-events": "autoUpdateEvents",
        "#ec-auto-characters": "autoUpdateCharacters",
        "#ec-auto-preferences": "autoUpdatePreferences",
        "#ec-auto-locations": "autoUpdateLocations",
        "#ec-auto-relationships": "autoUpdateRelationships",
        "#ec-auto-secrets": "autoUpdateSecrets",
    };
    for (const [sel, key] of Object.entries(autoFields)) {
        $(sel)
            .val(settings[key] || 0)
            .on("input", function () {
                settings[key] = parseInt($(this).val()) || 0;
                saveSettingsDebounced();
            });
    }

    // Generate buttons
    $(document).on("click", "#ec-btn-generate-events", () => generate(GEN_EVENTS));
    $(document).on("click", "#ec-btn-generate-characters", () => generate(GEN_CHARACTERS));
    $(document).on("click", "#ec-btn-generate-preferences", () => generate(GEN_PREFERENCES));
    $(document).on("click", "#ec-btn-generate-locations", () => generate(GEN_LOCATIONS));
    $(document).on("click", "#ec-btn-generate-relationships", () => generate(GEN_RELATIONSHIPS));
    $(document).on("click", "#ec-btn-generate-secrets", () => generate(GEN_SECRETS));

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
        $(this).closest(".ec-record").find("> .ec-record-header .ec-btn-toggle-record").click();
    });

    // Library — toggle day group expand/collapse
    $(document).on("click", ".ec-btn-toggle-day", function (e) {
        e.stopPropagation();
        const dayGroup = $(this).closest(".ec-day-group");
        const events = dayGroup.find(".ec-day-events");
        const icon = $(this).find("i");
        events.slideToggle(200);
        icon.toggleClass("fa-chevron-down fa-chevron-up");
    });

    // Also toggle day on clicking the day info area
    $(document).on("click", ".ec-day-header .ec-day-info", function () {
        $(this).closest(".ec-day-group").find(".ec-btn-toggle-day").click();
    });

    // Delete record
    $(document).on("click", ".ec-btn-delete-record", function () {
        const recordId = $(this).closest(".ec-record").data("record-id");
        if (confirm("Delete this record and all its items?")) {
            deleteRecord(recordId);
        }
    });

    // Add item to record (for events: adds a new day with blank event; for others: adds item)
    $(document).on("click", ".ec-btn-add-item", function () {
        const recordId = $(this).closest(".ec-record").data("record-id");
        const type = settings.activeLibraryTab || GEN_EVENTS;
        addManualItem(recordId, type);
    });

    // Add event to specific day (events only)
    $(document).on("click", ".ec-btn-add-event-to-day", function () {
        const recordId = $(this).closest(".ec-record").data("record-id");
        const dayDate = $(this).closest(".ec-day-group").data("day-date");
        addManualItem(recordId, GEN_EVENTS, { date: dayDate });
    });

    // Add new record manually
    $(document).on("click", "#ec-btn-add-record", function (e) {
        e.stopPropagation();
        const type = settings.activeLibraryTab || GEN_EVENTS;
        addManualRecord(type);
    });

    // Export records
    $(document).on("click", "#ec-btn-export", () => exportRecords());

    // Import records
    $(document).on("click", "#ec-btn-import", () => {
        $("#ec-import-file").val("").click();
    });
    $(document).on("change", "#ec-import-file", function () {
        const file = this.files?.[0];
        if (file) {
            importRecords(file);
            $(this).val("");
        }
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
                date: el.find(".ec-edit-date").val(),
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
        } else if (type === GEN_PREFERENCES) {
            newData = {
                name: el.find(".ec-edit-name").val(),
                preferences: el.find(".ec-edit-preferences").val(),
            };
        } else if (type === GEN_LOCATIONS) {
            newData = {
                name: el.find(".ec-edit-name").val(),
                parentLocation: el.find(".ec-edit-parentLocation").val(),
                description: el.find(".ec-edit-description").val(),
            };
        } else if (type === GEN_RELATIONSHIPS) {
            newData = {
                character1: el.find(".ec-edit-character1").val(),
                character2: el.find(".ec-edit-character2").val(),
                type: el.find(".ec-edit-reltype").val(),
                details: el.find(".ec-edit-details").val(),
            };
        } else if (type === GEN_SECRETS) {
            newData = {
                holder: el.find(".ec-edit-holder").val(),
                secret: el.find(".ec-edit-secret").val(),
                knownBy: el.find(".ec-edit-knownBy").val(),
                status: el.find(".ec-edit-status").val(),
                hints: el.find(".ec-edit-hints").val(),
            };
        }

        updateItem(recordId, itemId, newData);
        renderLibrary();
    });

    // Cycle secret status on badge click
    $(document).on("click", ".ec-secret-status-btn", function (e) {
        e.stopPropagation();
        const btn = $(this);
        const recordId = btn.data("record-id");
        const itemId = btn.data("item-id");
        const cycle = ["hidden", "suspected", "revealed"];
        const current = btn.hasClass("status-hidden") ? "hidden"
            : btn.hasClass("status-suspected") ? "suspected" : "revealed";
        const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
        const next = cycle[nextIdx];

        updateItem(recordId, itemId, { status: next });

        // Update badge in-place without full re-render
        btn.removeClass("status-hidden status-suspected status-revealed")
           .addClass(`status-${next}`)
           .text(next.toUpperCase());

        updateContextInjection();
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
    $("#ec-prompt-locations").val(settings.promptLocations);
    $("#ec-prompt-relationships").val(settings.promptRelationships);
    $("#ec-prompt-secrets").val(settings.promptSecrets);
    $("#ec-range-mode").val(settings.rangeMode);
    $("#ec-range-count").val(settings.rangeManualCount);
    $("#ec-injection-position").val(settings.injectionPosition);
    $("#ec-injection-depth").val(settings.injectionDepth);
    $("#ec-injection-role").val(settings.injectionRole);

    // Connection profile
    updateProfilesList();

    // Auto-update
    $("#ec-auto-update-enabled").prop("checked", settings.autoUpdateEnabled);
    $("#ec-auto-events").val(settings.autoUpdateEvents || 0);
    $("#ec-auto-characters").val(settings.autoUpdateCharacters || 0);
    $("#ec-auto-preferences").val(settings.autoUpdatePreferences || 0);
    $("#ec-auto-locations").val(settings.autoUpdateLocations || 0);
    $("#ec-auto-relationships").val(settings.autoUpdateRelationships || 0);
    $("#ec-auto-secrets").val(settings.autoUpdateSecrets || 0);
    $(".ec-auto-update-sections").toggle(!!settings.autoUpdateEnabled);

    // Activate the right main tab
    const activeMainTab = settings.activeMainTab || "settings";
    $(".ec-main-tabs .ec-main-tab").removeClass("active");
    $(`.ec-main-tabs .ec-main-tab[data-main-tab="${activeMainTab}"]`).addClass("active");
    $(".ec-main-panel").hide();
    $(`.ec-main-panel[data-main-panel="${activeMainTab}"]`).show();

    // Activate the right gen tab
    const activeTab = settings.activeTab || GEN_EVENTS;
    $(".ec-gen-tabs .ec-tab").removeClass("active");
    $(`.ec-gen-tabs .ec-tab[data-tab="${activeTab}"]`).addClass("active");
    $(".ec-tab-content").hide();
    $(`.ec-tab-content[data-for="${activeTab}"]`).show();
    $('[id^="ec-btn-generate-"]').hide();
    $(`#ec-btn-generate-${activeTab}`).show();
}

// ---------- initialization ----------

jQuery(async () => {
    const settingsHtml = getSettingsHtml();
    $("#extensions_settings2").append(settingsHtml);

    loadSettingsUI();
    bindEventHandlers();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderLibrary();
        updateContextInjection();
        updateProfilesList();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        updateContextInjection();
        checkAutoUpdate();
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
        updateContextInjection();
    });

    renderLibrary();
    updateContextInjection();

    console.log(`${extensionName}: loaded v3.0`);
});
