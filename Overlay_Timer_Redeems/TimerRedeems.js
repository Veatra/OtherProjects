/**
 * ============================================================================
 * SCRIPT CONTEXT & DEVELOPER NOTES (For Future Maintainers & AI Systems)
 * ============================================================================
 * Purpose: 
 * A cross-platform (Twitch, Kick, YouTube) highly customizable countdown timer widget 
 * for StreamElements. Allows specific users (Broadcaster, Mods, or Whitelist) to 
 * start, pause, add, subtract, and set timers dynamically via chat commands.
 * 
 * Architecture & Data Flow:
 * - Uses StreamElements' SE_API.store to persist the timer state globally. This 
 *   ensures the timer survives browser refreshes and OBS scene switches.
 * - Handles Cross-Platform permissions by leveraging StreamElements' unified 
 *   `badges` array, avoiding reliance on platform-specific tags (like Twitch's `mod`).
 * - Whitelisting supports both numeric User IDs AND alphanumeric usernames natively.
 * - UI styling is strictly separated into dynamic JS styles (loaded from fieldData)
 *   and static layout styles (in styles.css).
 * 
 * Future Modification Advice:
 * - If adding new commands, update `parseTimeCommand()` and `handleMessage()`.
 * - The timer intentionally has one canonical command parser. `commandPaused` is
 *   pre-processed in `handleMessage()` into `commandMain` plus a `forceStartPaused`
 *   routing flag so that timer creation logic never forks into duplicate code paths.
 * - If altering state, ensure `TimerState` typedef is updated to reflect new properties.
 * ============================================================================
 */

// --- Type Definitions for Data Structures ---
// Note: Using JSDoc @typedef is the official best practice for adding type-safety 
// to raw JavaScript in environments like StreamElements where TypeScript compilation 
// is not possible. It ensures the editor linter provides proper autocomplete and catches errors.

/**
 * Defines the persistent state structure of the timer.
 * @typedef {Object} TimerState
 * @property {boolean} [isTextOnly] - True if the timer is just displaying text (no countdown)
 * @property {boolean} [isPaused] - True if the countdown is currently paused
 * @property {number} [remainingOnPause] - The seconds left when the pause was triggered
 * @property {number|null} [finishTimestamp] - The exact Epoch timestamp when the timer should hit 0
 * @property {string} [description] - Optional text displayed alongside the timer
 * @property {number} [initialDuration] - The total duration the timer was originally set for
 * @property {boolean} [startedPausedByCommand] - True when a new timer was intentionally created paused through the paused trigger command
 */

let fieldData;
let timerInterval;
let currentTimerState = null; // Holds the parsed TimerState object in active memory.

const WIDGET_STORAGE_KEY = 'customTimerStateV1'; // Key for persistent SE database storage

// --- Helper Functions ---

/**
 * Converts a hex color string to an rgba string with a given opacity.
 * Supports both shorthand (#FFF) and full (#FFFFFF) hex codes.
 * 
 * @param {string} hex - The hex color code.
 * @param {number} opacity - The alpha value (0.0 to 1.0).
 * @returns {string} - Formatted rgba string.
 */
function hexToRgba(hex, opacity) {
    let r = 0, g = 0, b = 0;
    // Handle shorthand hex (e.g., #F03)
    if (hex.length === 4) {
        r = parseInt(hex[1] + hex[1], 16);
        g = parseInt(hex[2] + hex[2], 16);
        b = parseInt(hex[3] + hex[3], 16);
    // Handle full hex (e.g., #FF0033)
    } else if (hex.length === 7) {
        r = parseInt(hex.substring(1, 3), 16);
        g = parseInt(hex.substring(3, 5), 16);
        b = parseInt(hex.substring(5, 7), 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}


/**
 * Sanitizes a single configured chat command into the bare trigger word used by
 * StreamElements chat routing. Settings fields are intentionally user-friendly,
 * so streamers may type either "time" or "!time"; internally we always store
 * the command without leading exclamation marks to avoid accidental "!!time"
 * matching bugs when command strings are assembled.
 *
 * @param {string|undefined|null} rawCommand - The command value from fieldData.
 * @param {string} fallbackCommand - Safe command to use when settings are empty.
 * @returns {string} Lowercase command word without leading exclamation marks.
 */
function sanitizeConfiguredCommand(rawCommand, fallbackCommand) {
    const rawValue = typeof rawCommand === 'string' ? rawCommand : fallbackCommand;
    const sanitizedCommand = rawValue.trim().toLowerCase().replace(/^!+/, '').trim();

    if (!sanitizedCommand) {
        console.warn(`[Timer Widget] COMMAND CONFIG: Empty command detected after sanitization. Falling back to "${fallbackCommand}".`);
        return fallbackCommand;
    }

    return sanitizedCommand;
}

/**
 * Normalizes all command-related settings once during widget initialization.
 * Mutating fieldData here is intentional: every downstream router and parser can
 * rely on clean, exclamation-free command words and avoid repeating defensive
 * cleanup logic. Legacy `triggerCommands` is mapped to `commandMain` only as a
 * backward-compatibility bridge for older installed widget configurations.
 *
 * @param {Object} loadedFieldData - StreamElements fieldData object.
 * @returns {void}
 */
function normalizeCommandSettings(loadedFieldData) {
    const legacyFirstTrigger = loadedFieldData.triggerCommands
        ? loadedFieldData.triggerCommands.split(',')[0]
        : 'time';

    loadedFieldData.commandMain = sanitizeConfiguredCommand(loadedFieldData.commandMain || legacyFirstTrigger, 'time');
    loadedFieldData.commandPaused = sanitizeConfiguredCommand(loadedFieldData.commandPaused, 'timer');
    loadedFieldData.textOnlyCommand = sanitizeConfiguredCommand(loadedFieldData.textOnlyCommand, 'redeem');

    console.log(`[Timer Widget] COMMAND CONFIG: Main trigger="!${loadedFieldData.commandMain}", paused trigger="!${loadedFieldData.commandPaused}", text-only keyword="${loadedFieldData.textOnlyCommand}".`);
}

// --- Core Timer State Management ---

/**
 * Saves the current state of the timer to StreamElements' backend servers
 * and updates the local memory reference.
 * 
 * @param {TimerState} newState - The updated state object.
 */
function saveState(newState) {
    console.log(`[Timer Widget] Saving new state to SE_API.store:`, newState);
    currentTimerState = newState;
    SE_API.store.set(WIDGET_STORAGE_KEY, newState);
}

/**
 * Halts the timer, clears memory, and wipes the persistent storage state.
 * Also resets the UI to a hidden status.
 */
function clearState() {
    console.log(`[Timer Widget] Clearing timer state and hiding UI.`);
    clearInterval(timerInterval);
    timerInterval = null;
    currentTimerState = null;
    SE_API.store.set(WIDGET_STORAGE_KEY, {});
    $('#timer-container').removeClass('visible').addClass('hidden');
    $('#timer-display').removeClass('hidden');
}

// --- UI Update Functions ---

/**
 * Updates the visual DOM elements based on the remaining seconds.
 * Calculates hours, minutes, and seconds, and toggles visual states (blinking, paused).
 * 
 * @param {number} totalSeconds - Remaining time in seconds.
 * @param {boolean} [isPaused=false] - Whether the timer is currently paused.
 */
function updateTimerDisplay(totalSeconds, isPaused = false) {
    if (totalSeconds < 0) totalSeconds = 0;

    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = Math.floor(totalSeconds % 60);

    let displayHours = hours < 10 ? "0" + hours : hours;
    let displayMinutes = minutes < 10 ? "0" + minutes : minutes;
    let displaySeconds = seconds < 10 ? "0" + seconds : seconds;

    let timeString;
    // Only show hours if the initial duration was >= 1 hour, or we are currently >= 1 hour
    if (currentTimerState && (currentTimerState.initialDuration >= 3600 || hours > 0)) {
        timeString = `${displayHours}:${displayMinutes}:${displaySeconds}`;
    } else {
        timeString = `${displayMinutes}:${displaySeconds}`;
    }
    
    $('#timer-display').text(timeString);

    // Handle visual status classes
    $('#timer-display').toggleClass('paused', isPaused);
    $('#timer-display').toggleClass('blink', totalSeconds <= 10 && totalSeconds > 0 && !isPaused);
}

/**
 * Configures the primary layout and dynamic styling of the widget container
 * when a timer is instantiated or restored.
 * 
 * @param {TimerState} state - The active timer state.
 */
function showTimerUI(state) {
    const timerColor = fieldData.timerFontColor;
    
    // Dynamic layered text shadow based on chosen font color for glowing effect
    const dynamicShadow = `
        0 0 10px ${hexToRgba(timerColor, 0.6)}, 
        0 0 20px ${hexToRgba(timerColor, 0.4)}, 
        0 0 35px ${hexToRgba(timerColor, 0.3)}, 
        0 0 50px ${hexToRgba(timerColor, 0.2)}
    `;

    // Apply inline textual styles based on user configurations
    $('#timer-display').css({
        'font-size': fieldData.timerFontSize + 'rem',
        'color': timerColor,
        'text-shadow': dynamicShadow
    });
    
    $('#timer-description')
        .text(state.description || '')
        .css('font-size', fieldData.descriptionFontSize + 'rem');
    
    // Manage flexbox layout direction (Text above or below timer)
    if (fieldData.descriptionPosition === 'top') {
        $('#timer-container').css('flex-direction', 'column-reverse');
    } else {
        $('#timer-container').css('flex-direction', 'column');
    }
    
    $('#timer-container').removeClass('hidden').addClass('visible');
}

// --- Timer Logic Functions ---

/**
 * The main clock cycle. Runs every second to check remaining time against the finishTimestamp.
 */
function tick() {
    if (!currentTimerState || currentTimerState.isPaused) {
        clearInterval(timerInterval);
        return;
    }

    const remainingSeconds = (currentTimerState.finishTimestamp - Date.now()) / 1000;

    if (remainingSeconds <= 0) {
        console.log(`[Timer Widget] Timer reached 0. Clearing state.`);
        clearState();
    } else {
        updateTimerDisplay(remainingSeconds, false);
    }
}

/**
 * Initializes the setInterval loop. Includes an immediate tick to prevent a 1-second delay gap.
 */
function startCountdown() {
    console.log(`[Timer Widget] Starting visual countdown interval.`);
    clearInterval(timerInterval); // Cleanup to prevent overlapping ghost intervals
    if (currentTimerState && !currentTimerState.isPaused && currentTimerState.finishTimestamp) {
        tick(); // Run immediately to prevent 1-second delay on start
        timerInterval = setInterval(tick, 1000);
    }
}

// --- Command Handling Functions ---

// Pauses the currently running timer.
function handlePauseCommand() {
    if (!currentTimerState || currentTimerState.isPaused || currentTimerState.isTextOnly) return;
    
    const remainingSeconds = Math.round((currentTimerState.finishTimestamp - Date.now()) / 1000);

    if (remainingSeconds > 0) {
        console.log(`[Timer Widget] PAUSE command executed. Paused at ${remainingSeconds} seconds remaining.`);
        clearInterval(timerInterval);
        const newState = {
            ...currentTimerState,
            isPaused: true,
            remainingOnPause: remainingSeconds,
            finishTimestamp: null
        };
        saveState(newState);
        updateTimerDisplay(remainingSeconds, true);
    }
}

// Resumes a paused timer.
function handleResumeCommand() {
    if (!currentTimerState || !currentTimerState.isPaused || currentTimerState.isTextOnly) return;

    console.log(`[Timer Widget] RESUME command executed. Restoring ${currentTimerState.remainingOnPause} seconds.`);
    const newFinishTimestamp = Date.now() + (currentTimerState.remainingOnPause * 1000);
    const newState = {
        ...currentTimerState,
        isPaused: false,
        remainingOnPause: 0,
        finishTimestamp: newFinishTimestamp
    };
    saveState(newState);
    updateTimerDisplay(newState.remainingOnPause, false); // For initial display
    startCountdown();
}

// Stops and completely clears the timer.
function handleStopCommand() {
    console.log(`[Timer Widget] STOP command executed. Wiping timer.`);
    clearState();
}

// Handles text-only display (e.g., !time redeem mic rubs)
function handleTextOnlyCommand(description) {
    console.log(`[Timer Widget] TEXT-ONLY command executed. Displaying description: "${description}"`);
    clearInterval(timerInterval);
    const newState = {
        isTextOnly: true,
        description: description,
        finishTimestamp: null,
        isPaused: true,
        remainingOnPause: 0
    };
    saveState(newState);
    showTimerUI(newState);
    $('#timer-display').addClass('hidden');
}

/**
 * Creates a new timer state from parsed command data. The same function handles
 * both normal starts and paused starts so command parsing and state creation stay
 * unified. `forceStartPaused` is only set by the paused trigger pre-processor in
 * `handleMessage()`, preserving the main command's instant-start behavior.
 *
 * @param {number} duration - Timer duration in seconds.
 * @param {string} description - Optional label displayed with the timer.
 * @param {boolean} [forceStartPaused=false] - When true, create the timer paused instead of starting the countdown interval.
 */
function handleNewTimerCommand(duration, description, forceStartPaused = false) {
    console.log(`[Timer Widget] NEW TIMER command executed. Duration: ${duration}s, Description: "${description}", Force paused: ${forceStartPaused}`);

    const newState = {
        finishTimestamp: forceStartPaused ? null : Date.now() + (duration * 1000),
        isPaused: forceStartPaused,
        remainingOnPause: forceStartPaused ? duration : 0,
        description: description,
        initialDuration: duration,
        isTextOnly: false,
        startedPausedByCommand: forceStartPaused
    };

    $('#timer-display').removeClass('hidden');
    saveState(newState);
    showTimerUI(newState);
    updateTimerDisplay(duration, forceStartPaused);

    if (forceStartPaused) {
        clearInterval(timerInterval);
        timerInterval = null;
        console.log(`[Timer Widget] NEW TIMER created paused by paused trigger. Awaiting "!${fieldData.commandMain} start" to begin countdown.`);
        return;
    }

    startCountdown();
}

// Handles adding or subtracting time from the current timer.
function handleTimeModificationCommand(operation, duration, newDescription) {
    if (!currentTimerState || currentTimerState.isTextOnly) return; // Can't modify a timer that doesn't exist or is text-only.

    const currentRemainingSeconds = currentTimerState.isPaused
        ? currentTimerState.remainingOnPause
        : (currentTimerState.finishTimestamp - Date.now()) / 1000;

    let newRemainingSeconds = operation === 'add' 
        ? currentRemainingSeconds + duration 
        : currentRemainingSeconds - duration;

    console.log(`[Timer Widget] MODIFICATION command executed. Operation: ${operation}, Amount: ${duration}s. New remaining time: ${newRemainingSeconds}s.`);

    // Reject operations that drop time below 0, surface a brief UI warning
    if (newRemainingSeconds < 0) {
        console.warn(`[Timer Widget] Modification rejected: Cannot subtract more time than what remains.`);
        const originalDescription = currentTimerState.description || "";
        $('#timer-description').text("Cannot remove that much time!");
        setTimeout(() => {
            $('#timer-description').text(originalDescription);
        }, 5000);
        return;
    }

    const newState = { ...currentTimerState };
    
    // Update description if a new one was provided
    if (newDescription) {
        newState.description = newDescription;
    }

    if (newState.isPaused) {
        newState.remainingOnPause = newRemainingSeconds;
    } else {
        newState.finishTimestamp = Date.now() + (newRemainingSeconds * 1000);
    }

    saveState(newState);
    showTimerUI(newState);
    updateTimerDisplay(newRemainingSeconds, newState.isPaused);
}

/**
 * Helper to get the canonical main trigger command from user settings.
 * The parser intentionally recognizes only this command; the paused trigger is
 * translated to this command before parsing so every timer action flows through
 * one regex and one set of downstream handlers.
 *
 * @returns {string} Clean main trigger word (e.g., 'time').
 */
function getMainTriggerCommand() {
    if (!fieldData) return 'time';
    return sanitizeConfiguredCommand(fieldData.commandMain, 'time');
}

/**
 * Helper to get the paused trigger command from user settings.
 * This command is detected only in `handleMessage()` and converted into the main
 * command plus `forceStartPaused = true` for new timer creation.
 *
 * @returns {string} Clean paused trigger word (e.g., 'timer').
 */
function getPausedTriggerCommand() {
    if (!fieldData) return 'timer';
    return sanitizeConfiguredCommand(fieldData.commandPaused, 'timer');
}

/**
 * Parses regex commands to extract operation type, duration in seconds, and description.
 * Dynamically builds the regex based on the single canonical main trigger word.
 * Supports syntax formats after paused-trigger normalization: !time +5, !time 5:00, !time 1:30:00, etc.
 * 
 * @param {string} command - The raw chat string.
 * @returns {Object|null} - Parsed command details or null if invalid.
 */
function parseTimeCommand(command) {
    const mainTrigger = getMainTriggerCommand();
    
    // Escape standard regex characters in case a user uses special symbols in their command.
    const escapedMainTrigger = mainTrigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Dynamically build: /^!(time)\s+([+-]?)(\d+(?::\d+){1,2}|\d*\.?\d+)\s*(.*)$/i
    const regex = new RegExp(`^!(${escapedMainTrigger})\\s+([+-]?)(\\d+(?::\\d+){1,2}|\\d*\\.?\\d+)\\s*(.*)$`, 'i');
    const match = command.match(regex);

    if (match) {
        // match[1] is the trigger word used, match[2] is the sign, match[3] is the time, match[4] is the description
        const sign = match[2];
        const timeValue = match[3];
        const description = match[4] || "";
        
        let operation = 'set';
        if (sign === '+') {
            operation = 'add';
        } else if (sign === '-') {
            operation = 'subtract';
        }

        let duration = 0;
        if (timeValue.includes(':')) {
            const parts = timeValue.split(':').reverse();
            duration += parseInt(parts[0], 10); // seconds
            if (parts[1]) duration += parseInt(parts[1], 10) * 60; // minutes
            if (parts[2]) duration += parseInt(parts[2], 10) * 3600; // hours
        } else {
            const number = parseFloat(timeValue);
            const minutes = Math.floor(number);
            const seconds = Math.round((number - minutes) * 60);
            duration = (minutes * 60) + seconds;
        }
        
        console.log(`[Timer Widget] Successfully parsed command parameters: { operation: '${operation}', duration: ${duration}, description: '${description}' }`);
        return { operation, duration, description };
    }
    return null;
}

/**
 * Validates whether the user who sent the command has the proper permissions.
 * Fully cross-platform compliant (Twitch, Kick, YouTube).
 * 
 * @param {Object} data - The chat event payload from StreamElements.
 * @returns {boolean} - True if authorized.
 */
const checkPrivileges = (data) => {
    // Fail-safe check
    if (!data) return false;

    const userName = data.nick || data.userId || "Unknown User";

    // TODO: Rmove hardcoded user, always has permission.
    // Hardcoded global override (Owner ID)
    if (data.userId === '29492075') {
        console.log(`[Timer Widget] AUTHENTICATION: Master Override GRANTED for user ID 29492075.`);
        return true;
    }

    // Cross-platform Broadcaster check:
    // 1. Legacy Twitch 'room-id' match
    // 2. StreamElements unified badges array (Checks 'broadcaster' for Twitch/Kick and 'owner' for YouTube)
    // 3. Raw tags string fallback
    const isBroadcaster = 
        (data.tags && data.tags['room-id'] && data.userId === data.tags['room-id']) ||
        (Array.isArray(data.badges) && data.badges.some(b => b.type === 'broadcaster' || b.type === 'owner')) ||
        (data.tags && typeof data.tags.badges === 'string' && (data.tags.badges.includes('broadcaster') || data.tags.badges.includes('owner')));

    // Broadcaster always bypasses lower permission restrictions
    if (isBroadcaster) {
        console.log(`[Timer Widget] AUTHENTICATION: Broadcaster bypass GRANTED for ${userName}.`);
        return true;
    }

    const requiredPermission = fieldData.permissions;

    switch (requiredPermission) {
        case 'broadcaster':
            console.warn(`[Timer Widget] AUTHENTICATION: DENIED for ${userName}. Required: Broadcaster.`);
            return false; // Handled by isBroadcaster check above
        
        case 'mods':
            // Cross-platform Moderator check:
            // 1. Legacy Twitch 'mod' tag (1 or 0)
            // 2. StreamElements unified badges array (Supports Twitch, Kick, and YouTube)
            // 3. Raw tags string fallback
            const isMod = 
                (data.tags && parseInt(data.tags.mod || '0', 10) === 1) ||
                (Array.isArray(data.badges) && data.badges.some(b => b.type === 'moderator')) ||
                (data.tags && typeof data.tags.badges === 'string' && data.tags.badges.includes('moderator'));
            
            if (isMod) {
                console.log(`[Timer Widget] AUTHENTICATION: Moderator status GRANTED for ${userName}.`);
            } else {
                console.warn(`[Timer Widget] AUTHENTICATION: DENIED for ${userName}. Required: Moderator.`);
            }
            return isMod;

        case 'whitelist':
            const whitelistString = fieldData.userWhitelist || "";
            if (!whitelistString) {
                console.warn(`[Timer Widget] AUTHENTICATION: DENIED for ${userName}. Whitelist mode enabled but list is empty.`);
                return false;
            }
            
            // Allow both User IDs and Usernames (Nicks) in the whitelist.
            // This is especially helpful for Kick and YouTube where User IDs are difficult to find manually.
            const whitelistedItems = whitelistString.split(',').map(item => item.trim().toLowerCase());
            
            const userIdMatch = data.userId ? whitelistedItems.includes(data.userId.toString()) : false;
            const userNickMatch = data.nick ? whitelistedItems.includes(data.nick.toLowerCase()) : false;
            
            if (userIdMatch || userNickMatch) {
                console.log(`[Timer Widget] AUTHENTICATION: Whitelist match GRANTED for ${userName}.`);
                return true;
            }
            console.warn(`[Timer Widget] AUTHENTICATION: DENIED for ${userName}. Not found in whitelist.`);
            return false;

        default:
            return false;
    }
};

// --- Main Event Listeners ---

/**
 * Main entry point for processing chat messages.
 * Intercepts incoming chat events, validates them, and routes to appropriate command handlers.
 */
/**
 * Intercepts incoming chat events, validates them, and routes to appropriate command handlers.
 */
const handleMessage = (obj) => {
    const data = obj.detail.event.data;
    const text = data.text.trim();
    
    // Capture the first chat word once, then classify it against the two configured entry points.
    // The paused command is deliberately not parsed directly. Instead, it is normalized into
    // the main command below so `parseTimeCommand()` and all router behavior stay unified.
    const mainCommand = getMainTriggerCommand();
    const pausedCommand = getPausedTriggerCommand();
    const firstWord = text.split(' ')[0].toLowerCase();
    const isMainTriggerCommand = firstWord === `!${mainCommand}`;
    // If both settings are accidentally identical, prefer the main command behavior.
    // This avoids surprising streamers by making their normal command create paused timers.
    const isPausedTriggerCommand = !isMainTriggerCommand && firstWord === `!${pausedCommand}`;

    if (!isMainTriggerCommand && !isPausedTriggerCommand) {
        return; // Ignore regular chat messages and unrelated commands.
    }

    const forceStartPaused = isPausedTriggerCommand;
    const normalizedText = forceStartPaused
        ? text.replace(new RegExp(`^!${pausedCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i'), `!${mainCommand}`)
        : text;

    console.log(`[Timer Widget] Trigger detected: "${text}". Normalized as "${normalizedText}". Force paused: ${forceStartPaused}. Running permission checks...`);

    if (!checkPrivileges(data)) {
        return;
    }

    const commandParts = normalizedText.split(' ');
    const actionOrTime = (commandParts[1] || '').toLowerCase();

    // Get the custom trigger word from settings, fallback to 'redeem' if missing
    const textOnlyCommand = sanitizeConfiguredCommand(fieldData && fieldData.textOnlyCommand, 'redeem');

    switch(actionOrTime) {
        case 'pause':
            handlePauseCommand();
            return;
        case 'start':
        case 'resume':
            handleResumeCommand();
            return;
        case 'stop':
        case 'end':
        case 'clear':
            handleStopCommand();
            return;
        case textOnlyCommand:
            const description = commandParts.slice(2).join(' ');
            handleTextOnlyCommand(description);
            return;
    }

    const parsedCommand = parseTimeCommand(normalizedText);
    if (parsedCommand !== null) {
        switch (parsedCommand.operation) {
            case 'set':
                handleNewTimerCommand(parsedCommand.duration, parsedCommand.description, forceStartPaused);
                break;
            case 'add':
            case 'subtract':
                handleTimeModificationCommand(parsedCommand.operation, parsedCommand.duration, parsedCommand.description);
                break;
        }
    } else {
        console.warn(`[Timer Widget] Trigger detected but command syntax was invalid. Discarding.`);
    }
};

// --- Kick Native Chat Integration ---
let kickWs = null;

/**
 * Attempts to automatically resolve a Kick channel name into a numerical Chatroom ID via API.
 * Contains safeguards against Cloudflare blocks when run from browser sources.
 * 
 * @param {string} input - The user's input (can be "xqc" or "1234567").
 * @returns {Promise<string|null>} - The numerical ID as a string, or null if failed.
 */
async function resolveKickChatroomId(input) {
    const cleanInput = input.trim();
    
    // If it's already a clean number, skip the API call.
    if (/^\d+$/.test(cleanInput)) {
        console.log(`[Timer Widget] Kick ID Input "${cleanInput}" is purely numeric. Bypassing API fetch.`);
        return cleanInput;
    }

    console.log(`[Timer Widget] Kick Input "${cleanInput}" appears to be a username. Attempting to fetch Chatroom ID via Kick API...`);
    
    try {
        const response = await fetch(`https://kick.com/api/v2/channels/${cleanInput}`);
        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}: API denied the request.`);
        }
        const data = await response.json();
        
        if (data && data.chatroom && data.chatroom.id) {
            const fetchedId = data.chatroom.id.toString();
            console.log(`[Timer Widget] SUCCESS: Resolved Kick username "${cleanInput}" to Chatroom ID: ${fetchedId}`);
            return fetchedId;
        } else {
            throw new Error("Invalid Kick API response structure.");
        }
    } catch (error) {
        console.error(`[Timer Widget] FAILED to auto-resolve Kick username "${cleanInput}".`, error);
        console.warn(`[Timer Widget] CRITICAL: StreamElements/OBS might be blocked by Cloudflare from making this API request. Please manually enter your numeric Kick Chatroom ID in the widget settings.`);
        return null;
    }
}

/**
 * Connects directly to Kick's Chat WebSocket (Pusher) without needing third-party bots.
 * Utilizes modern v8.4.0 Pusher protocols to prevent Kick from shadow-dropping frames.
 * Normalizes incoming Kick messages to perfectly match the StreamElements data structure,
 * allowing the existing handleMessage() logic to process them flawlessly.
 * 
 * @param {string} chatroomId - The channel's resolved Kick Chatroom ID.
 */
function connectKickChat(chatroomId) {
    if (!chatroomId) return;

    // Modern Kick public Pusher App Key
    const kickPusherKey = "32cbd69e4b950bf97679"; 
    const wsUrl = `wss://ws-us2.pusher.com/app/${kickPusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;
    
    console.log(`[Timer Widget] Initializing WebSocket connection to Kick: ${wsUrl}`);
    kickWs = new WebSocket(wsUrl);

    kickWs.onopen = () => {
        console.log(`[Timer Widget] Kick WebSocket handshake initiated.`);
    };

    kickWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            const eventType = payload.event || "";
            
            // 1. Handle Pusher Heartbeats (Passive Pong)
            if (eventType === "pusher:ping") {
                if (kickWs.readyState === WebSocket.OPEN) {
                    kickWs.send(JSON.stringify({ event: "pusher:pong", data: {} }));
                }
                return;
            }

            // 2. Handle Connection Authentication
            if (eventType === "pusher:connection_established") {
                console.log(`[Timer Widget] Kick Pusher handshake complete. Subscribing to chatroom channel: chatrooms.${chatroomId}.v2`);
                kickWs.send(JSON.stringify({
                    event: "pusher:subscribe",
                    data: { auth: "", channel: `chatrooms.${chatroomId}.v2` }
                }));
                return;
            }

            if (eventType === "pusher_internal:subscription_succeeded") {
                console.log(`[Timer Widget] SUCCESS: Subscribed to Kick chat stream. Native Cross-Platform Chat is active!`);
                return;
            }
            
            // 3. Process new incoming chat messages
            if (eventType.includes("ChatMessage") || eventType.includes("Message")) {
                let innerData = payload.data;
                
                // Kick frequently double-stringifies the data payload over Pusher
                if (typeof innerData === 'string') {
                    try {
                        innerData = JSON.parse(innerData);
                    } catch (e) {
                        return; // Ignore garbage payload
                    }
                }

                // Suppress AI-Moderated (deleted) messages silently
                if (innerData.aiModerated === true) return;

                // Aggressive extraction logic to handle multiple Kick payload variations
                let content = "";
                let senderName = "";
                let senderId = "";
                let badgesArray = [];

                const msgBlock = innerData.message;
                if (msgBlock && msgBlock.sender) {
                    content = msgBlock.content || msgBlock.message || innerData.content;
                    senderName = msgBlock.sender.username;
                    senderId = (msgBlock.sender.id || "").toString();
                    if (msgBlock.sender.identity && msgBlock.sender.identity.badges) {
                        badgesArray = msgBlock.sender.identity.badges;
                    }
                } else {
                    content = innerData.content || innerData.message;
                    const senderBlock = innerData.sender || {};
                    senderName = senderBlock.username;
                    senderId = (senderBlock.id || "").toString();
                    if (senderBlock.identity && senderBlock.identity.badges) {
                        badgesArray = senderBlock.identity.badges;
                    }
                }

                if (!content || !senderName) return;

                // Normalize Kick's data payload to perfectly mimic the StreamElements Twitch payload
                const normalizedData = {
                    text: content,
                    userId: senderId,
                    nick: senderName,
                    tags: {}, // Dummy object to prevent undefined errors in existing code
                    badges: []
                };
                
                // Translate Kick badges to StreamElements cross-platform badge types
                badgesArray.forEach(badge => {
                    if (badge.type === 'broadcaster' || badge.type === 'creator') {
                        normalizedData.badges.push({ type: 'broadcaster' });
                    }
                    if (badge.type === 'moderator') {
                        normalizedData.badges.push({ type: 'moderator' });
                    }
                });

                // Create a synthetic StreamElements event object and route it directly into the native logic
                const syntheticEvent = {
                    detail: {
                        listener: "message",
                        event: { data: normalizedData }
                    }
                };
                
                handleMessage(syntheticEvent);
            }
        } catch (error) {
            console.error("[Timer Widget] Failed to parse Kick websocket message:", error);
        }
    };

    kickWs.onclose = () => {
        console.warn("[Timer Widget] Kick WebSocket disconnected. Attempting to reconnect in 5 seconds...");
        setTimeout(() => connectKickChat(chatroomId), 6000);
    };
    
    kickWs.onerror = (err) => {
        console.error("[Timer Widget] Kick WebSocket encountered an error:", err);
    };
}

/**
 * Initializes widget upon source load. 
 * Rebuilds dynamic styles and restores previous state from database.
 */
window.addEventListener('onWidgetLoad', async function (obj) {
    console.log("[Timer Widget] --- INITIALIZATION START ---");
    fieldData = obj.detail.fieldData;
    normalizeCommandSettings(fieldData);

    // --- Initiate Native Kick Connection ---
    if (fieldData.kickChatroomId && fieldData.kickChatroomId.trim() !== '') {
        const resolvedId = await resolveKickChatroomId(fieldData.kickChatroomId);
        if (resolvedId) {
            connectKickChat(resolvedId);
        }
    } else {
        console.warn("[Timer Widget] No Kick ID/Username provided in settings. Kick chat integration disabled.");
    }

    // --- Apply Dynamic Visual Styles from Settings ---
    console.log("[Timer Widget] Applying custom visual styles...");
    
    /** @type {Record<string, string|number>} */
    const containerStyles = {};
    const alpha = fieldData.backgroundOpacity / 100;

    // 1. Handle Background Style
    if (fieldData.backgroundStyle === 'standard') {
        containerStyles['background-color'] = '#262833';
        containerStyles['box-shadow'] = '0 10px 30px rgba(0, 0, 0, 0.2)';
    } else if (fieldData.backgroundStyle === 'custom') {
        containerStyles['background-color'] = hexToRgba(fieldData.customBackgroundColor, alpha);
        containerStyles['box-shadow'] = '0 10px 30px rgba(0, 0, 0, 0.2)';
    } else { // 'none'
        containerStyles['background-color'] = 'transparent';
        containerStyles['box-shadow'] = 'none';
    }

    // 2. Handle Border Style
    if (fieldData.borderStyle === 'solid') {
        const borderColorWithAlpha = hexToRgba(fieldData.borderColor, alpha);
        containerStyles['border'] = `${fieldData.borderThickness}px solid ${borderColorWithAlpha}`;
    } else {
        containerStyles['border'] = 'none';
    }

    // Apply batched styles to DOM
    $('#timer-container').css(containerStyles);
    
    // 3. Handle Fade Animation
    if (fieldData.useFadeAnimation) {
        $('#timer-container').addClass('fade-effect');
    }

    // --- Load Timer State and Initialize ---
    console.log("[Timer Widget] Fetching previous timer state from SE Database...");
    
    SE_API.store.get(WIDGET_STORAGE_KEY).then(/** @param {TimerState} state */ state => {
        if (!state || Object.keys(state).length === 0) {
            console.log("[Timer Widget] No active saved state found. Timer is idle.");
            return;
        }

        console.log("[Timer Widget] Restoring previous timer state:", state);
        currentTimerState = state;
        showTimerUI(state);

        if (state.isTextOnly) {
            $('#timer-display').addClass('hidden');
            return;
        }

        if (state.isPaused) {
            updateTimerDisplay(state.remainingOnPause || 0, true);
        } else {
            if (fieldData.offlineBehavior === 'pauseOnOffline') {
                console.log("[Timer Widget] Stream went offline while active. Auto-pausing timer per settings.");
                handlePauseCommand();
            } else {
                const finishTime = state.finishTimestamp || Date.now();
                const remainingSeconds = (finishTime - Date.now()) / 1000;
                
                if (remainingSeconds > 0) {
                    console.log(`[Timer Widget] Resuming live countdown. ${remainingSeconds}s remaining.`);
                    startCountdown();
                } else {
                    console.log("[Timer Widget] Timer expired while stream was offline. Clearing state.");
                    clearState();
                }
            }
        }
        console.log("[Timer Widget] --- INITIALIZATION COMPLETE ---");
    });
});

/**
 * Core event listener for unified chat routing.
 */
window.addEventListener('onEventReceived', function (obj) {
    if (obj.detail.listener !== "message") return;
    handleMessage(obj);
});