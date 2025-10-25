// Audio module: unlock, BGM (mp3 via <audio>), SFX (synth)

// BGMと効果音のバランス調整用倍率
const BGM_BASE_VOLUME = 0.5;
const SFX_BASE_GAIN = 1.8;

// Map slider value to actual BGM volume so that the lower half becomes quieter
// while keeping higher values unchanged.
function shapeBgmVolume(value) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) return 0;
    if (value < 0.5) return 2 * value * value;
    return Math.min(1, value);
}

function getCtx(state) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.audio.sfxCtx = state.audio.sfxCtx || new Ctx();
    return state.audio.sfxCtx;
}

export function ensureAudioUnlocked(state) {
    if (state.audio.unlocked) return;
    if (state.audio.unlockHandler) return;
    const unlock = async () => {
        try {
            const ctx = getCtx(state);
            const resumeResult = ctx.resume?.();
            if (resumeResult && typeof resumeResult.then === 'function') {
                await resumeResult;
            }
            // tiny silent buffer to unlock
            const b = ctx.createBuffer(1, 1, 22050);
            const src = ctx.createBufferSource();
            src.buffer = b;
            src.connect(ctx.destination);
            src.start(0);
            state.audio.unlocked = true;
            window.removeEventListener('pointerdown', unlock, true);
            window.removeEventListener('keydown', unlock, true);
            state.audio.unlockHandler = null;
        } catch {
            // keep listeners for another user gesture
        }
    };
    state.audio.unlockHandler = unlock;
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
}

function ensureBgmEl(state) {
    if (!state.audio.bgmEl) {
        const a = document.createElement('audio');
        a.loop = true;
        a.preload = 'auto';
        a.style.display = 'none';
        a.addEventListener('error', () => { /* ignore missing bgm */ });
        // append on DOM ready if needed
        if (document.body) document.body.appendChild(a);
        else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(a));
        state.audio.bgmEl = a;
    }
    return state.audio.bgmEl;
}

export function applyAudioSettings(state) {
    const bgm = ensureBgmEl(state);
    // volume 0.0 - 1.0 (ゲーム内のBGMは全体設定より少し小さめにする)
    const v = ('bgmVolume' in (state.settings || {})) ? state.settings.bgmVolume : (state.settings.volume ?? 0.5);
    const shaped = shapeBgmVolume(v) * BGM_BASE_VOLUME;
    bgm.volume = Math.max(0, Math.min(1, shaped));
    if (state.settings.bgm) {
        try {
            const maybePromise = bgm.play();
            if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch(() => { /* ignore play errors */ });
            }
        } catch { }
    } else {
        try { bgm.pause(); } catch { }
    }
}

export function setBgmForStage(state, stageName) {
    const bgm = ensureBgmEl(state);
    const map = {
        'メロンパン広場': 'audio/bgm_plaza.mp3',
        'メロンパン牧場': 'audio/bgm_ranch.mp3',
        'メロンパン迷宮': 'audio/bgm_maze.mp3',
        'メロンパン工業地帯': 'audio/bgm_factory.mp3',
        'メロンパン火山地帯': 'audio/bgm_volcano.mp3',
        'メロンパン氷山': 'audio/bgm_iceberg.mp3',
        'メロンパンスキー場': 'audio/bgm_iceberg.mp3',
        'メロンパン毒沼': 'audio/bgm_poison.mp3',
    };
    const src = map[stageName] || 'audio/bgm_default.mp3';
    // If already set to the same file, just ensure playback based on setting
    if (bgm.src && (bgm.src.endsWith(src) || bgm.src.includes(src))) {
        applyAudioSettings(state);
        if (state.settings.bgm) {
            bgm.play().catch(() => { /* autoplay might be blocked until user gesture */ });
        }
        return;
    }
    try { bgm.pause(); } catch { }
    bgm.src = src;
    applyAudioSettings(state);
    if (state.settings.bgm) {
        bgm.play().catch(() => { /* ignore play errors */ });
    }
}

// 死亡・ポーズなどでBGMを停止（設定は変えずに停止のみ）
// immediate=false の場合はフェードアウトして停止する
export function stopBgm(state, immediate = true) {
    const bgm = ensureBgmEl(state);
    const pause = () => { try { bgm.pause(); } catch { } };
    if (immediate) {
        pause();
        return;
    }
    const original = bgm.volume;
    const fadeStep = () => {
        if (bgm.volume > 0.05) {
            bgm.volume = Math.max(0, bgm.volume - 0.05);
            setTimeout(fadeStep, 50);
        } else {
            bgm.volume = 0;
            pause();
            bgm.volume = original;
        }
    };
    fadeStep();
}

export async function playSfx(state, type = 'kill') {
    if (!state.settings.sfx) return;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (nowMs - (state.audio.lastSfxAt || 0) < 40) return;
    state.audio.lastSfxAt = nowMs;
    try {
        ensureAudioUnlocked(state);
        const ctx = getCtx(state);
        const t = ctx.currentTime;
        const sVol = ('sfxVolume' in (state.settings || {})) ? state.settings.sfxVolume : (state.settings.volume || 0.5);
        const vol = Math.max(0, Math.min(1, sVol));

        // 小さなヘルパー群
        const mkGain = (vMul = 0.22) => {
            const g = ctx.createGain();
            const level = Math.max(0.02, Math.min(1, vMul * vol * SFX_BASE_GAIN));
            g.gain.setValueAtTime(level, t);
            g.connect(ctx.destination);
            return g;
        };
        const tone = (opts) => {
            const { type = 'sine', f1 = 660, f2 = null, dur = 0.1, vMul = 0.22, at = t } = opts || {};
            const g = mkGain(vMul);
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.setValueAtTime(f1, at);
            if (typeof f2 === 'number') o.frequency.exponentialRampToValueAtTime(Math.max(40, f2), at + dur);
            // 短いエンベロープ
            g.gain.setValueAtTime(Math.max(0.01, Math.min(1, vMul * vol * SFX_BASE_GAIN)), at);
            g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.04, dur - 0.01));
            o.connect(g);
            o.start(at);
            o.stop(at + dur);
            setTimeout(() => { try { g.disconnect(); } catch { } }, (dur * 1000) + 80);
        };
        const noiseBurst = (opts) => {
            const { dur = 0.06, vMul = 0.18, cutoff = 2000, at = t } = opts || {};
            const g = mkGain(vMul);
            // ホワイトノイズバッファ
            const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
            const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.9;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(cutoff, at);
            g.gain.setValueAtTime(Math.max(0.01, Math.min(1, vMul * vol * SFX_BASE_GAIN)), at);
            g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
            src.connect(filter); filter.connect(g);
            src.start(at);
            src.stop(at + dur);
            setTimeout(() => { try { filter.disconnect(); g.disconnect(); } catch { } }, (dur * 1000) + 80);
        };

        // イベント別のリッチSFX
        if (type === 'levelup') {
            // 上昇アルペジオ＋軽いノイズで華やかさを演出
            noiseBurst({ dur: 0.08, vMul: 0.15, cutoff: 2600, at: t });
            tone({ type: 'sine', f1: 784, dur: 0.09, vMul: 0.22, at: t });
            tone({ type: 'sine', f1: 988, dur: 0.09, vMul: 0.22, at: t + 0.08 });
            tone({ type: 'sine', f1: 1175, dur: 0.12, vMul: 0.24, at: t + 0.16 });
            tone({ type: 'sine', f1: 1568, dur: 0.14, vMul: 0.25, at: t + 0.24 });
            return;
        }
        if (type === 'hit') {
            // 被ダメ: ノイズ＋低域の短いトーンで手触りを出す
            noiseBurst({ dur: 0.06, vMul: 0.16, cutoff: 1800, at: t });
            tone({ type: 'triangle', f1: 180, f2: 140, dur: 0.07, vMul: 0.12, at: t });
            return;
        }
        if (type === 'death') {
            // 死亡: 降下スイープ＋薄いノイズ
            tone({ type: 'triangle', f1: 520, f2: 110, dur: 0.5, vMul: 0.22, at: t });
            noiseBurst({ dur: 0.22, vMul: 0.08, cutoff: 1200, at: t + 0.05 });
            return;
        }
        if (type === 'gameover') {
            // ゲームオーバー: 深い降下音にノイズを重ねて派手に
            tone({ type: 'sawtooth', f1: 420, f2: 40, dur: 0.7, vMul: 0.28, at: t });
            noiseBurst({ dur: 0.5, vMul: 0.12, cutoff: 900, at: t + 0.1 });
            tone({ type: 'triangle', f1: 90, dur: 0.6, vMul: 0.1, at: t + 0.2 });
            return;
        }
        if (type === 'revive') {
            // 復活: 軽いノイズでフラッシュ→上昇トリル
            noiseBurst({ dur: 0.05, vMul: 0.12, cutoff: 2400, at: t });
            tone({ type: 'sine', f1: 740, dur: 0.08, vMul: 0.18, at: t + 0.02 });
            tone({ type: 'sine', f1: 880, dur: 0.08, vMul: 0.18, at: t + 0.10 });
            tone({ type: 'sine', f1: 1046, dur: 0.12, vMul: 0.20, at: t + 0.18 });
            return;
        }

        if (type === 'activeReady') {
            // アクティブゲージ満タン: 上昇ビープ
            tone({ type: 'sine', f1: 660, f2: 990, dur: 0.15, vMul: 0.22, at: t });
            return;
        }

        if (type === 'activeStart') {
            // アクティブウェポン発動時: 派手な効果音
            noiseBurst({ dur: 0.12, vMul: 0.3, cutoff: 3000, at: t });
            tone({ type: 'sawtooth', f1: 880, f2: 440, dur: 0.25, vMul: 0.28, at: t });
            tone({ type: 'triangle', f1: 660, f2: 220, dur: 0.4, vMul: 0.24, at: t + 0.1 });
            return;
        }

        if (type === 'fullmoonSlam') {
            // フルムーンの盾叩きつけ: 重い衝撃と低音の余韻
            noiseBurst({ dur: 0.12, vMul: 0.32, cutoff: 2600, at: t });
            tone({ type: 'triangle', f1: 320, f2: 140, dur: 0.24, vMul: 0.28, at: t });
            tone({ type: 'sine', f1: 110, f2: 55, dur: 0.35, vMul: 0.22, at: t + 0.05 });
            return;
        }

        if (type === 'fireAtk') {
            noiseBurst({ dur: 0.05, vMul: 0.18, cutoff: 2200, at: t });
            tone({ type: 'square', f1: 660, f2: 440, dur: 0.07, vMul: 0.2, at: t });
            return;
        }
        if (type === 'iceAtk') {
            tone({ type: 'sine', f1: 880, f2: 660, dur: 0.08, vMul: 0.18, at: t });
            return;
        }
        if (type === 'lightningAtk') {
            noiseBurst({ dur: 0.04, vMul: 0.2, cutoff: 3500, at: t });
            tone({ type: 'square', f1: 1200, f2: 600, dur: 0.05, vMul: 0.22, at: t });
            return;
        }
        if (type === 'darkAtk') {
            tone({ type: 'triangle', f1: 200, f2: 80, dur: 0.1, vMul: 0.18, at: t });
            return;
        }

        if (type === 'jumpPad') {
            tone({ type: 'square', f1: 440, f2: 880, dur: 0.15, vMul: 0.2, at: t });
            return;
        }

        if (type === 'enemyShot') {
            // 敵弾幕発射音: 乾いたノイズと高域ビープで弾丸感を出す
            noiseBurst({ dur: 0.04, vMul: 0.12, cutoff: 2500, at: t });
            tone({ type: 'square', f1: 920, f2: 680, dur: 0.05, vMul: 0.14, at: t });
            return;
        }

        if (type === 'sniperAim') {
            // メロの照準表示音: 軽いビープ
            tone({ type: 'sine', f1: 1000, dur: 0.05, vMul: 0.18, at: t });
            return;
        }

        if (type === 'sniperShot') {
            // メロの弾丸発射音: ノイズ＋高域トーンに低音を加えて迫力を強化
            noiseBurst({ dur: 0.05, vMul: 0.35, cutoff: 4000, at: t });
            tone({ type: 'square', f1: 1600, f2: 800, dur: 0.09, vMul: 0.30, at: t });
            tone({ type: 'triangle', f1: 220, f2: 90, dur: 0.12, vMul: 0.28, at: t });
            return;
        }

        if (type === 'subSword') {
            // サブウェポン・ソード: 切り裂くような高音と残響
            noiseBurst({ dur: 0.05, vMul: 0.28, cutoff: 3200, at: t });
            tone({ type: 'square', f1: 1200, f2: 520, dur: 0.12, vMul: 0.28, at: t });
            tone({ type: 'triangle', f1: 360, f2: 180, dur: 0.18, vMul: 0.2, at: t + 0.02 });
            return;
        }

        if (type === 'subFlame') {
            // サブウェポン・火炎放射器: 炎の噴射音と低い唸り
            noiseBurst({ dur: 0.25, vMul: 0.24, cutoff: 2600, at: t });
            noiseBurst({ dur: 0.25, vMul: 0.2, cutoff: 2000, at: t + 0.18 });
            tone({ type: 'sawtooth', f1: 520, f2: 260, dur: 0.35, vMul: 0.22, at: t });
            tone({ type: 'triangle', f1: 180, f2: 120, dur: 0.4, vMul: 0.18, at: t + 0.05 });
            return;
        }

        if (type === 'subBomb') {
            // サブウェポン・爆弾: 投擲の風切り音と導火線の弾ける音
            noiseBurst({ dur: 0.06, vMul: 0.2, cutoff: 2200, at: t });
            tone({ type: 'triangle', f1: 520, f2: 260, dur: 0.16, vMul: 0.2, at: t });
            tone({ type: 'sine', f1: 900, f2: 480, dur: 0.14, vMul: 0.14, at: t + 0.04 });
            return;
        }

        if (type === 'subFlash') {
            // サブウェポン・閃光弾: 爆ぜるノイズと鋭い高音で閃光を表現
            noiseBurst({ dur: 0.08, vMul: 0.32, cutoff: 5200, at: t });
            tone({ type: 'square', f1: 1800, f2: 900, dur: 0.12, vMul: 0.28, at: t });
            tone({ type: 'sine', f1: 1200, f2: 600, dur: 0.2, vMul: 0.2, at: t + 0.03 });
            return;
        }

        if (type === 'bomb') {
            // 爆弾爆発: ノイズと低めの降下音で重さを表現
            noiseBurst({ dur: 0.18, vMul: 0.25, cutoff: 2200, at: t });
            tone({ type: 'sawtooth', f1: 300, f2: 60, dur: 0.25, vMul: 0.26, at: t });
            return;
        }

        if (type === 'alert') {
            // ボス出現アラート: 強いノイズと下降トーンを連続させて緊張感を演出
            noiseBurst({ dur: 0.1, vMul: 0.22, cutoff: 2600, at: t });
            tone({ type: 'sawtooth', f1: 1200, f2: 400, dur: 0.25, vMul: 0.24, at: t });
            tone({ type: 'sawtooth', f1: 1200, f2: 400, dur: 0.25, vMul: 0.24, at: t + 0.26 });
            return;
        }

        // 既定・UI系は従来の単音ビープ
        const g = mkGain(0.2);
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        let freq = 660; let dur = 0.08;
        switch (type) {
            case 'ui': freq = 740; dur = 0.05; break;
            case 'open': freq = 600; dur = 0.06; break;
            case 'close': freq = 520; dur = 0.05; break;
            case 'select': freq = 820; dur = 0.05; break;
            case 'toggle': freq = 680; dur = 0.05; break;
            case 'ok': freq = 900; dur = 0.08; break;
            case 'cancel': freq = 400; dur = 0.06; break;
            case 'error': freq = 220; dur = 0.14; break;
            case 'pickup': freq = 1000; dur = 0.06; break;
            case 'start': freq = 520; dur = 0.1; break;
            case 'menu': freq = 880; dur = 0.05; break;
            case 'kill':
            default: freq = 700; dur = 0.09; break;
        }
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(Math.max(0.02, 0.2 * vol), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.04, dur - 0.01));
        osc.connect(g);
        osc.start(t);
        osc.stop(t + dur);
        setTimeout(() => { try { g.disconnect(); } catch { } }, (dur * 1000) + 50);
    } catch { }
}
