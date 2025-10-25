// API client: all server interactions live here
const rel = (pathAndQuery) => new URL(pathAndQuery, document.baseURI).toString();

const isMobileClient = (() => {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const ua = nav?.userAgent || '';
    const touchPoints = nav ? (nav.maxTouchPoints || nav.msMaxTouchPoints || 0) : 0;
    const hasCoarse = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(pointer: coarse)').matches
        : false;
    const isAppleTablet = /iPad|Macintosh/i.test(ua) && touchPoints > 1;
    const isMobileUA = /Mobi|Android|iPhone|iPod/i.test(ua) || isAppleTablet;
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 0)
        || (typeof window !== 'undefined' && window.screen ? window.screen.width : 0)
        || 0;
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 0)
        || (typeof window !== 'undefined' && window.screen ? window.screen.height : 0)
        || 0;
    const smallScreen = Math.min(vw, vh) < 820;
    return isMobileUA || (hasCoarse && smallScreen);
})();

const REQUEST_TIMEOUT_MS = isMobileClient ? 10000 : 5000;

async function request(pathAndQuery, options) {
    const controller = new AbortController();
    const originalSignal = options?.signal;
    const fetchOptions = { ...(options ?? {}), signal: controller.signal };

    if (originalSignal && originalSignal !== controller.signal) {
        if (originalSignal.aborted) {
            controller.abort();
        } else {
            originalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    let res;
    let text;
    try {
        try {
            res = await fetch(rel(pathAndQuery), fetchOptions);
        } catch (e) {
            if (e.name === 'AbortError') {
                if (timedOut) {
                    window.dispatchEvent(new Event('service-unavailable'));
                    throw new Error('HTTP 503 Service Unavailable - Request timed out');
                }
                throw e;
            }
            throw new Error(`network error: ${e.message}`);
        }
        text = await res.text();
        if (!res.ok) {
            if (res.status === 503) {
                window.dispatchEvent(new Event('service-unavailable'));
            } else if (res.status >= 500) {
                window.dispatchEvent(new Event('server-error'));
            }
            throw new Error(`HTTP ${res.status} ${res.statusText} - ${text}`);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error('Invalid JSON response');
        }
    } finally {
        clearTimeout(timeoutId);
    }
}

export const api = {
    async getRooms() {
        return request('api.php?action=listRooms');
    },
    async listGallery() {
        return request('api.php?action=listGallery');
    },
    async createRoom(playerName, passwordProtected) {
        return request('api.php?action=createRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerName, passwordProtected }),
        });
    },
    async joinRoom(roomId, playerName, password, playerId) {
        const payload = { roomId, playerName, password };
        if (playerId) payload.playerId = playerId;
        return request('api.php?action=joinRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },
    async leaveRoom(roomId, playerId, authToken) {
        return request('api.php?action=leaveRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken }),
        });
    },
    async setLoadout(roomId, playerId, authToken, character, stage, difficulty, options = undefined) {
        const payload = { roomId, playerId, authToken };
        if (character !== undefined) {
            if (typeof character === 'string') {
                const trimmed = character.trim();
                payload.character = trimmed && trimmed !== '-' ? trimmed : null;
            } else {
                payload.character = null;
            }
        }
        if (stage !== undefined) payload.stage = stage;
        if (difficulty !== undefined) payload.difficulty = difficulty;
        if (options && Object.prototype.hasOwnProperty.call(options, 'ignitionMode')) {
            payload.ignitionMode = !!options.ignitionMode;
        }
        return request('api.php?action=setLoadout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },
    async startGame(roomId, playerId, authToken) {
        return request('api.php?action=startGame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken }),
        });
    },
    async setReady(roomId, playerId, authToken, ready) {
        return request('api.php?action=setReady', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken, ready }),
        });
    },
    async postEvent(roomId, playerId, authToken, event) {
        return request('api.php?action=postEvent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken, event }),
        });
    },
    async returnToRoom(roomId, playerId, authToken) {
        return request('api.php?action=postEvent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken, event: { type: 'backToRoom' } }),
        });
    },
    async disbandRoom(roomId, playerId, authToken) {
        return request('api.php?action=disbandRoom', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, playerId, authToken }),
        });
    },
};
