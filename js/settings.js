// Settings module: persistence and UI wiring
// All functions accept `state` so the caller controls ownership.

export function loadSettings(state) {
  try {
    const raw = localStorage.getItem('vlg.settings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch { }
}

export function saveSettings(state) {
  try {
    localStorage.setItem('vlg.settings', JSON.stringify(state.settings));
  } catch { }
}

export function syncSettingUI(state, root = document) {
  root.querySelectorAll('.set-bgm').forEach(el => el.checked = !!state.settings.bgm);
  root.querySelectorAll('.set-sfx').forEach(el => el.checked = !!state.settings.sfx);
  root.querySelectorAll('.set-fps').forEach(el => el.checked = !!state.settings.fps);
  root.querySelectorAll('.set-ping').forEach(el => el.checked = !!state.settings.ping);
  root.querySelectorAll('.set-load-stats').forEach(el => el.checked = !!state.settings.loadStats);
  root.querySelectorAll('.set-coords').forEach(el => el.checked = !!state.settings.showCoordinates);
  root.querySelectorAll('.set-damage').forEach(el => el.checked = !!state.settings.damageNumbers);
  // font select
  root.querySelectorAll('.set-font').forEach(el => el.value = state.settings.font || 'BestTenDOT');
  const bgmVol = (state.settings.bgmVolume ?? state.settings.volume ?? 0.5);
  const sfxVol = (state.settings.sfxVolume ?? state.settings.volume ?? 0.5);
  root.querySelectorAll('.set-bgm-volume').forEach(el => el.value = String(bgmVol));
  root.querySelectorAll('.set-sfx-volume').forEach(el => el.value = String(sfxVol));
}

// applyAudioSettings is injected to avoid cyclic dependencies
export function wireSettingHandlers(state, applyAudioSettings, root = document) {
  root.querySelectorAll('.set-bgm').forEach(el => el.onchange = (e) => { state.settings.bgm = e.target.checked; applyAudioSettings?.(state); saveSettings(state); });
  root.querySelectorAll('.set-sfx').forEach(el => el.onchange = (e) => { state.settings.sfx = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-fps').forEach(el => el.onchange = (e) => { state.settings.fps = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-ping').forEach(el => el.onchange = (e) => { state.settings.ping = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-load-stats').forEach(el => el.onchange = (e) => { state.settings.loadStats = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-coords').forEach(el => el.onchange = (e) => { state.settings.showCoordinates = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-damage').forEach(el => el.onchange = (e) => { state.settings.damageNumbers = e.target.checked; saveSettings(state); });
  root.querySelectorAll('.set-bgm-volume').forEach(el => el.oninput = (e) => { state.settings.bgmVolume = parseFloat(e.target.value); applyAudioSettings?.(state); saveSettings(state); });
  root.querySelectorAll('.set-sfx-volume').forEach(el => el.oninput = (e) => { state.settings.sfxVolume = parseFloat(e.target.value); saveSettings(state); });

  // font handler: apply immediately and persist
  root.querySelectorAll('.set-font').forEach(el => el.onchange = (e) => {
    const v = e.target.value;
    state.settings.font = v;
    try { applyFont(v); } catch { }
    saveSettings(state);
  });
}

// Apply font by setting a CSS variable on documentElement. Keeps styles simple.
export function applyFont(fontName) {
  if (!fontName) fontName = 'BestTenDOT';
  // map friendly names to CSS font-family values
  const mapping = {
    'BestTenDOT': '"BestTenDOT", "M PLUS Rounded 1c", "Noto Sans JP", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    'M PLUS Rounded 1c': '"M PLUS Rounded 1c", "Noto Sans JP", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    'Noto Sans JP': '"Noto Sans JP", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    'system-ui': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  };
  const val = mapping[fontName] || mapping['BestTenDOT'];
  try { document.documentElement.style.setProperty('--vlg-font-family', val); } catch { }
}

// Export settings as a downloadable JSON file
export function exportSettings(state) {
  try {
    let name = '';
    try { name = localStorage.getItem('vlg.playerName') || ''; } catch (e) { console.error('Error accessing localStorage for playerName:', e); }
    const data = JSON.stringify({
      settings: state.settings,
      money: state.money || 0,
      unlockedStages: state.unlockedStages || [],
      unlockedChars: state.unlockedChars || [],
      cardShopUnlocked: !!state.cardShopUnlocked,
      subWeaponUnlocked: !!state.subWeaponUnlocked,
      secondSubWeaponUnlocked: !!state.secondSubWeaponUnlocked,
      characterGrowthUnlocked: !!state.characterGrowthUnlocked,
      characterGrowth: normalizeCharacterGrowth(state.characterGrowth),
      subWeapons: (() => {
        const owned = {};
        if (state.subWeapons && typeof state.subWeapons === 'object') {
          for (const [id, value] of Object.entries(state.subWeapons)) {
            if (value) owned[id] = true;
          }
        }
        return owned;
      })(),
      selectedSubWeapon: (typeof state.selectedSubWeapon === 'string' && state.selectedSubWeapon && state.subWeapons?.[state.selectedSubWeapon])
        ? state.selectedSubWeapon
        : null,
      selectedSecondSubWeapon: (typeof state.selectedSecondSubWeapon === 'string'
        && state.selectedSecondSubWeapon
        && state.subWeapons?.[state.selectedSecondSubWeapon]
        && state.secondSubWeaponUnlocked
        && state.subWeaponUnlocked)
        ? state.selectedSecondSubWeapon
        : null,
      armorUnlocked: !!state.armorUnlocked,
      activeWeaponUnlocked: !!state.activeWeaponUnlocked,
      energyUnlocked: !!state.energyUnlocked,
      ignitionModeUnlocked: !!state.ignitionModeUnlocked,
      cards: state.cards || {},
      perks: state.perks || {},
      stageClears: state.stageClears || {},
      cheats: state.cheats || {},
      name
    });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vlg-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { }
}

// Validate imported settings object
function validateSettings(obj) {
  // Define allowed keys and their expected types
  const schema = {
    bgm: 'boolean',
    sfx: 'boolean',
    fps: 'boolean',
    ping: 'boolean',
    damageNumbers: 'boolean',
    showCoordinates: 'boolean',
    loadStats: 'boolean',
    font: 'string',
    bgmVolume: 'number',
    sfxVolume: 'number',
    volume: 'number'
  };
  const valid = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const expectedType = schema[key];
      const value = obj[key];
      if (
        (expectedType === 'boolean' && typeof value === 'boolean') ||
        (expectedType === 'string' && typeof value === 'string') ||
        (expectedType === 'number' && typeof value === 'number')
      ) {
        valid[key] = value;
      }
    }
  }
  return valid;
}

function validateCheats(obj) {
  const keys = ['mass', 'midBoss', 'boss', 'reaper', 'reward', 'riskReward', 'items'];
  const valid = {};
  for (const k of keys) {
    if (typeof obj[k] === 'boolean') valid[k] = obj[k];
  }
  return valid;
}

function normalizeCharacterGrowth(source) {
  const normalized = {};
  if (!source || typeof source !== 'object') return normalized;
  for (const [name, value] of Object.entries(source)) {
    if (typeof name !== 'string' || !name) continue;
    if (!value || typeof value !== 'object') continue;
    const rawLevel = Number.isFinite(value.level) ? Math.floor(value.level) : 1;
    const rawExp = Number.isFinite(value.exp) ? Math.floor(value.exp) : 0;
    const level = Math.max(1, rawLevel);
    const exp = Math.max(0, rawExp);
    normalized[name] = { level, exp };
  }
  return normalized;
}

function normalizeStageClearEntry(value) {
  if (value && typeof value === 'object') {
    const baseCleared = value.cleared ?? value.clear ?? value.done ?? value.status ?? value.ignition ?? false;
    return { cleared: !!baseCleared, ignition: !!value.ignition };
  }
  return { cleared: !!value, ignition: false };
}

function normalizeImportedStageClears(map) {
  if (!map || typeof map !== 'object') return {};
  const normalized = {};
  for (const [stage, diffs] of Object.entries(map)) {
    if (!diffs || typeof diffs !== 'object') continue;
    const nextDiffs = {};
    for (const [diff, value] of Object.entries(diffs)) {
      const entry = normalizeStageClearEntry(value);
      if (value != null || entry.cleared || entry.ignition) {
        nextDiffs[diff] = entry;
      }
    }
    if (Object.keys(nextDiffs).length > 0) {
      normalized[stage] = nextDiffs;
    }
  }
  return normalized;
}

// Import settings from a JSON file
export async function importSettings(state, file, applyAudioSettings, root = document) {
  if (!file) return false;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const src = obj.settings ? obj : { settings: obj };
    const validated = validateSettings(src.settings || {});
    Object.assign(state.settings, validated);
    saveSettings(state);
    try { applyFont(state.settings.font); } catch { }
    applyAudioSettings?.(state);
    syncSettingUI(state, root);

    if (typeof src.money === 'number') state.money = src.money;
    if (Array.isArray(src.unlockedStages)) state.unlockedStages = src.unlockedStages.filter(v => typeof v === 'string');
    if (Array.isArray(src.unlockedChars)) state.unlockedChars = src.unlockedChars.filter(v => typeof v === 'string');
    if ('cardShopUnlocked' in src) state.cardShopUnlocked = !!src.cardShopUnlocked;
    if ('subWeaponUnlocked' in src) state.subWeaponUnlocked = !!src.subWeaponUnlocked;
    if ('secondSubWeaponUnlocked' in src) state.secondSubWeaponUnlocked = !!src.secondSubWeaponUnlocked;
    if ('characterGrowthUnlocked' in src) state.characterGrowthUnlocked = !!src.characterGrowthUnlocked;
    {
      const owned = {};
      if (src.subWeapons && typeof src.subWeapons === 'object') {
        for (const [id, value] of Object.entries(src.subWeapons)) {
          if (typeof id === 'string' && id && value) owned[id] = true;
        }
      }
      state.subWeapons = owned;
    }
    {
      let selected = null;
      if (typeof src.selectedSubWeapon === 'string' && src.selectedSubWeapon) {
        selected = src.selectedSubWeapon;
      }
      if (selected && !state.subWeapons?.[selected]) selected = null;
      state.selectedSubWeapon = selected;
    }
    {
      let selected = null;
      if (typeof src.selectedSecondSubWeapon === 'string' && src.selectedSecondSubWeapon) {
        selected = src.selectedSecondSubWeapon;
      }
      if (selected && !state.subWeapons?.[selected]) selected = null;
      if (!state.secondSubWeaponUnlocked || !state.subWeaponUnlocked) selected = null;
      state.selectedSecondSubWeapon = selected;
    }
    if ('armorUnlocked' in src) state.armorUnlocked = !!src.armorUnlocked;
    if ('activeWeaponUnlocked' in src) state.activeWeaponUnlocked = !!src.activeWeaponUnlocked;
    if ('energyUnlocked' in src) state.energyUnlocked = !!src.energyUnlocked;
    if ('ignitionModeUnlocked' in src) state.ignitionModeUnlocked = !!src.ignitionModeUnlocked;
    if (src.cards && typeof src.cards === 'object') state.cards = src.cards;
    if (src.perks && typeof src.perks === 'object') state.perks = src.perks;
    if (src.stageClears && typeof src.stageClears === 'object') {
      state.stageClears = normalizeImportedStageClears(src.stageClears);
    }

    if ('characterGrowth' in src) {
      state.characterGrowth = normalizeCharacterGrowth(src.characterGrowth);
    }

    state.cheats = src.cheats && typeof src.cheats === 'object' ? validateCheats(src.cheats) : {};

    let name = '';
    if (typeof src.name === 'string') name = src.name.trim().slice(0, 10);
    try { localStorage.setItem('vlg.playerName', name); } catch { }
    const nameInput = document.getElementById('playerName');
    if (nameInput) nameInput.value = name;
    const cur = document.getElementById('currentName');
    if (cur) cur.textContent = name || '未設定';
    if (state.me) state.me.name = name;

    try { localStorage.setItem('vlg.money', JSON.stringify({ money: state.money })); } catch { }
    try { localStorage.setItem('vlg.unlockedStages', JSON.stringify(state.unlockedStages)); } catch { }
    try { localStorage.setItem('vlg.unlockedChars', JSON.stringify(state.unlockedChars)); } catch { }
    try { localStorage.setItem('vlg.cardShopUnlocked', state.cardShopUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.subWeaponUnlocked', state.subWeaponUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.secondSubWeaponUnlocked', state.secondSubWeaponUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.subWeapons', JSON.stringify(state.subWeapons || {})); } catch { }
    try {
      if (state.selectedSubWeapon) {
        localStorage.setItem('vlg.selectedSubWeapon', state.selectedSubWeapon);
      } else {
        localStorage.removeItem('vlg.selectedSubWeapon');
      }
    } catch { }
    try {
      if (state.selectedSecondSubWeapon) {
        localStorage.setItem('vlg.selectedSecondSubWeapon', state.selectedSecondSubWeapon);
      } else {
        localStorage.removeItem('vlg.selectedSecondSubWeapon');
      }
    } catch { }
    try { localStorage.setItem('vlg.armorUnlocked', state.armorUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.activeWeaponUnlocked', state.activeWeaponUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.energyUnlocked', state.energyUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.ignitionModeUnlocked', state.ignitionModeUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.cards', JSON.stringify(state.cards)); } catch { }
    try { localStorage.setItem('vlg.perks', JSON.stringify(state.perks)); } catch { }
    try { localStorage.setItem('vlg.stageClears', JSON.stringify(state.stageClears)); } catch { }
    try { localStorage.setItem('vlg.characterGrowthUnlocked', state.characterGrowthUnlocked ? '1' : '0'); } catch { }
    try { localStorage.setItem('vlg.characterGrowth', JSON.stringify(state.characterGrowth || {})); } catch { }

    state.resetRoomItems?.();
    state.updateCardShopVisibility?.();
    state.updateWeaponShopVisibility?.();
    state.updateIgnitionControls?.();
    state.rebuildCharacterOptions?.();
    if (typeof state.updateCharacterInfo === 'function') {
      const characterSelect = document.getElementById('characterSelect');
      const selected = characterSelect?.value;
      if (selected) {
        state.updateCharacterInfo(selected);
      } else if (state.room?.members && state.me?.playerId) {
        const meMember = state.room.members.find(m => m.id === state.me.playerId);
        if (meMember?.character) state.updateCharacterInfo(meMember.character);
      }
    }
    return true;
  } catch {
    return false;
  }
}
