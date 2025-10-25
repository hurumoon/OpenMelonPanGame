import { getImage } from './assets.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UINT32_MAX = 0xffffffff;
const MAX_EXCLUDE_TOKENS = 5;

const fnv1a32 = (str) => {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

const tankSpeedMultiplierFromId = (id) => {
  if (!id) return 0.8; // フォールバックで中央値
  const hash = fnv1a32(`tankSpeed:${id}`);
  const rand = hash / UINT32_MAX;
  return 0.7 + rand * 0.2;
};

const generateEnemyId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    let hex = '';
    for (let i = 0; i < buf.length; i++) {
      hex += buf[i].toString(16).padStart(2, '0');
    }
    return hex.slice(0, 8);
  }
  const fallback = Math.random().toString(16).slice(2, 10);
  return fallback.padEnd(8, '0').slice(0, 8);
};

const STUN_STAR_BASE_OUTER = 7;
const STUN_RING_BASE_RADIUS = STUN_STAR_BASE_OUTER + 4;

const REMOTE_PAUSE_TIMEOUT_MS = 20000;
const RISK_REWARD_BASE_DURATION = 60;

const getNowMs = () => (
  (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now()
);

const getStunIndicatorSprites = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      cache = {
        star: null,
        ring: null,
        baseOuter: STUN_STAR_BASE_OUTER,
        baseRing: STUN_RING_BASE_RADIUS
      };
      return cache;
    }
    try {
      const starCanvasSize = 64;
      const starCanvas = document.createElement('canvas');
      starCanvas.width = starCanvas.height = starCanvasSize;
      const starCtx = starCanvas.getContext('2d');
      if (!starCtx) throw new Error('missing stun star context');
      const starCenter = starCanvasSize / 2;
      starCtx.translate(starCenter, starCenter);
      starCtx.shadowColor = 'rgba(255,240,0,0.85)';
      starCtx.shadowBlur = 12;
      starCtx.fillStyle = 'rgba(255,240,0,0.95)';
      starCtx.strokeStyle = '#fff';
      starCtx.lineWidth = 1.5;
      starCtx.lineJoin = 'round';
      starCtx.beginPath();
      const starOuter = STUN_STAR_BASE_OUTER;
      const starInner = starOuter * 0.5;
      for (let i = 0; i < 5; i++) {
        const outerAng = (i * 2 * Math.PI) / 5;
        const innerAng = outerAng + Math.PI / 5;
        const ox = Math.cos(outerAng) * starOuter;
        const oy = Math.sin(outerAng) * starOuter;
        if (i === 0) starCtx.moveTo(ox, oy);
        else starCtx.lineTo(ox, oy);
        const ix = Math.cos(innerAng) * starInner;
        const iy = Math.sin(innerAng) * starInner;
        starCtx.lineTo(ix, iy);
      }
      starCtx.closePath();
      starCtx.fill();
      starCtx.stroke();
      starCtx.setTransform(1, 0, 0, 1, 0, 0);
      starCtx.shadowBlur = 0;

      const ringCanvasSize = 64;
      const ringCanvas = document.createElement('canvas');
      ringCanvas.width = ringCanvas.height = ringCanvasSize;
      const ringCtx = ringCanvas.getContext('2d');
      if (!ringCtx) throw new Error('missing stun ring context');
      const ringCenter = ringCanvasSize / 2;
      ringCtx.translate(ringCenter, ringCenter);
      ringCtx.strokeStyle = 'rgba(255,240,0,0.7)';
      ringCtx.lineWidth = 1.2;
      ringCtx.setLineDash([4, 4]);
      ringCtx.beginPath();
      ringCtx.arc(0, 0, STUN_RING_BASE_RADIUS, 0, Math.PI * 2);
      ringCtx.stroke();
      ringCtx.setTransform(1, 0, 0, 1, 0, 0);

      cache = {
        star: { canvas: starCanvas, size: starCanvasSize },
        ring: { canvas: ringCanvas, size: ringCanvasSize },
        baseOuter: STUN_STAR_BASE_OUTER,
        baseRing: STUN_RING_BASE_RADIUS
      };
    } catch (err) {
      console.warn('Failed to prepare stun indicator sprites:', err);
      cache = {
        star: null,
        ring: null,
        baseOuter: STUN_STAR_BASE_OUTER,
        baseRing: STUN_RING_BASE_RADIUS
      };
    }
    return cache;
  };
})();

// Controller: extracts high-level app state and wires UI

export function initApp(ctx) {
  const {
    api,
    $,
    characters,
    characterDefs,
    stages,
    stageDefs,
    difficulties,
    difficultyDefs,
    subWeaponDefs: subWeaponDefsRaw = [],
    Settings,
    Audio,
    appVersion,
    cardDefs,
    achievementDefs: achievementDefsRaw = [],
    storyEpisodes: storyEpisodesRaw = [],
    galleryItems: galleryItemsRaw = [],
  } = ctx;
  const subWeaponDefs = Array.isArray(subWeaponDefsRaw) ? subWeaponDefsRaw : [];
  const subWeaponMap = new Map(subWeaponDefs.map(def => [def.id, def]));
  const achievementDefs = Array.isArray(achievementDefsRaw) ? [...achievementDefsRaw] : [];
  achievementDefs.sort((a, b) => {
    const noA = Number.isFinite(a?.no) ? a.no : Infinity;
    const noB = Number.isFinite(b?.no) ? b.no : Infinity;
    if (noA !== noB) return noA - noB;
    const nameA = a?.name || '';
    const nameB = b?.name || '';
    return nameA.localeCompare(nameB, 'ja');
  });
  const galleryItems = [];
  const galleryItemMap = new Map();
  const galleryCollator = typeof Intl?.Collator === 'function'
    ? new Intl.Collator('ja', { numeric: true, sensitivity: 'base' })
    : null;
  const storyEpisodes = [];
  if (Array.isArray(storyEpisodesRaw)) {
    storyEpisodesRaw.forEach((episode, index) => {
      if (!episode) return;
      let title = '';
      if (typeof episode.title === 'string') title = episode.title.trim();
      if (!title) title = `第${index + 1}話`;
      let id = '';
      if (typeof episode.id === 'string') id = episode.id.trim();
      if (!id) id = `episode-${index + 1}`;
      let paragraphs = [];
      if (Array.isArray(episode.paragraphs)) {
        paragraphs = episode.paragraphs
          .map((p) => (typeof p === 'string' ? p.trim() : ''))
          .filter(Boolean);
      } else if (typeof episode.body === 'string' && episode.body.trim()) {
        paragraphs = [episode.body.trim()];
      }
      storyEpisodes.push({ id, title, paragraphs });
    });
  }

  function renderRoomStoryEpisode(index) {
    const totalEpisodes = storyEpisodes.length;
    if (!totalEpisodes) {
      currentStoryIndex = 0;
      if (roomStoryTitle) roomStoryTitle.textContent = 'ストーリー未登録';
      if (roomStoryBody) {
        roomStoryBody.innerHTML = '';
        const message = document.createElement('p');
        message.textContent = 'ストーリーがまだ追加されていません。';
        roomStoryBody.appendChild(message);
      }
      if (roomStoryIndicator) roomStoryIndicator.textContent = '0 / 0';
      if (roomStoryPrev) roomStoryPrev.disabled = true;
      if (roomStoryNext) roomStoryNext.disabled = true;
      return;
    }
    const safeIndex = Number.isFinite(index)
      ? Math.min(Math.max(Math.floor(index), 0), totalEpisodes - 1)
      : 0;
    currentStoryIndex = safeIndex;
    const episode = storyEpisodes[safeIndex] ?? null;
    if (roomStoryTitle) roomStoryTitle.textContent = episode?.title || `第${safeIndex + 1}話`;
    if (roomStoryBody) {
      roomStoryBody.innerHTML = '';
      const paragraphs = Array.isArray(episode?.paragraphs) && episode.paragraphs.length
        ? episode.paragraphs
        : ['このエピソードにはまだ本文がありません。'];
      for (const paragraph of paragraphs) {
        const text = typeof paragraph === 'string' ? paragraph.trim() : '';
        const p = document.createElement('p');
        p.textContent = text || '　';
        roomStoryBody.appendChild(p);
      }
    }
    if (roomStoryIndicator) roomStoryIndicator.textContent = `${safeIndex + 1} / ${totalEpisodes}`;
    if (roomStoryPrev) roomStoryPrev.disabled = safeIndex <= 0;
    if (roomStoryNext) roomStoryNext.disabled = safeIndex >= totalEpisodes - 1;
  }

  function openRoomStoryModal(startIndex = 0) {
    if (!roomStoryModal) return;
    renderRoomStoryEpisode(startIndex);
    roomStoryModal.classList.remove('hidden');
  }

  function closeRoomStoryModal() {
    if (!roomStoryModal) return;
    roomStoryModal.classList.add('hidden');
    try { roomStoryBtn?.focus(); } catch { }
  }

  function showPreviousStoryEpisode() {
    if (!storyEpisodes.length) return;
    renderRoomStoryEpisode(currentStoryIndex - 1);
  }

  function showNextStoryEpisode() {
    if (!storyEpisodes.length) return;
    renderRoomStoryEpisode(currentStoryIndex + 1);
  }
  const compareGallery = (a, b) => {
    const keyA = a?.sortKey || a?.filename || a?.title || '';
    const keyB = b?.sortKey || b?.filename || b?.title || '';
    if (galleryCollator) return galleryCollator.compare(keyA, keyB);
    return keyA.localeCompare(keyB, 'ja');
  };
  function populateGalleryCollections(rawItems) {
    galleryItems.length = 0;
    galleryItemMap.clear();
    if (!Array.isArray(rawItems)) return null;
    const normalizedItems = [];
    const seenIds = new Set();
    for (const item of rawItems) {
      let filename = '';
      let url = '';
      let thumb = '';
      let idRaw = null;
      if (typeof item === 'string') {
        filename = item;
      } else if (item && typeof item === 'object') {
        if (typeof item.filename === 'string') filename = item.filename;
        else if (typeof item.title === 'string') filename = item.title;
        if (typeof item.url === 'string') url = item.url;
        if (typeof item.thumbnail === 'string') thumb = item.thumbnail;
        if (typeof item.id === 'string' || typeof item.id === 'number') idRaw = item.id;
      } else {
        continue;
      }
      filename = String(filename || '').trim();
      if (!filename) continue;
      let id = '';
      if (typeof idRaw === 'string') id = idRaw.trim();
      else if (typeof idRaw === 'number' && Number.isFinite(idRaw)) id = String(idRaw);
      if (!id) id = filename;
      if (!id) continue;
      let uniqueId = id;
      let attempts = 1;
      while (seenIds.has(uniqueId)) {
        uniqueId = `${id}_${++attempts}`;
      }
      const normalizedFilename = filename.replace(/^[\\/]+/, '');
      const encodedSegments = normalizedFilename
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment));
      const fallbackSrc = encodedSegments.length
        ? `gallery/${encodedSegments.join('/')}`
        : `gallery/${encodeURIComponent(normalizedFilename)}`;
      const srcCandidate = typeof url === 'string' ? url.trim() : '';
      const normalizedSrc = srcCandidate
        ? srcCandidate
        : fallbackSrc;
      const thumbCandidate = typeof thumb === 'string' ? thumb.trim() : '';
      const normalizedThumb = thumbCandidate || normalizedSrc;
      const segmentsForName = normalizedFilename.split('/').filter(Boolean);
      const displayName = segmentsForName.length ? segmentsForName[segmentsForName.length - 1] : normalizedFilename;
      const normalized = {
        id: uniqueId,
        title: displayName,
        filename: normalizedFilename,
        src: normalizedSrc,
        thumb: normalizedThumb,
        sortKey: normalizedFilename.toLowerCase(),
      };
      normalizedItems.push(normalized);
      seenIds.add(uniqueId);
    }
    normalizedItems.sort(compareGallery);
    for (const normalized of normalizedItems) {
      galleryItems.push(normalized);
      galleryItemMap.set(normalized.id, normalized);
    }
    return galleryItems.length ? galleryItems[0].id : null;
  }
  const initialGallerySelection = populateGalleryCollections(galleryItemsRaw);
  const galleryState = {
    selectedId: initialGallerySelection,
  };
  const MAX_CHARACTER_LEVEL = 99;
  const CHARACTER_HP_MAX_MUL = 2.5;
  const CHARACTER_SPD_MAX_MUL = 2.0;
  const CHARACTER_ARMOR_MAX_MUL = 3.0;
  const CHARACTER_GROWTH_UNLOCK_PRICE = 24000;
  const CHARACTER_GROWTH_STORAGE_KEY = 'vlg.characterGrowth';
  const CHARACTER_GROWTH_UNLOCK_KEY = 'vlg.characterGrowthUnlocked';
  const CHARACTER_GROWTH_DAILY_DEAL_ID = 'unlock:characterGrowth';
  const CHARACTER_XP_BASE_RATE = 0.25; // 秒数に掛ける基礎取得量（経験値が上がりすぎないよう調整）

  function isPlayableCharacter(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    return !!trimmed && trimmed !== '-';
  }

  function normalizeCharacterSelection(name) {
    return isPlayableCharacter(name) ? name.trim() : null;
  }

  const defaultPlayableCharacter = (() => {
    for (const name of characters) {
      const normalized = normalizeCharacterSelection(name);
      if (normalized) return normalized;
    }
    return null;
  })();

  function defaultCharacterGrowth() {
    const growth = {};
    for (const name of characters) {
      const key = normalizeCharacterSelection(name);
      if (!key) continue;
      growth[key] = { level: 1, exp: 0 };
    }
    return growth;
  }

  function characterExpToNext(level) {
    let lv = Number.isFinite(level) ? Math.floor(level) : 1;
    if (lv < 1) lv = 1;
    if (lv >= MAX_CHARACTER_LEVEL) return 0;
    const baseCost = 35 + lv * 10 + Math.pow(lv, 1.35) * 3.4;
    const cost = Math.round(baseCost * 1.10);
    return Math.max(1, cost);
  }

  function computeGrowthMultiplier(level, maxMul) {
    if (!Number.isFinite(level) || level <= 1) return 1;
    const progress = Math.min(1, Math.max(0, (level - 1) / (MAX_CHARACTER_LEVEL - 1)));
    return 1 + (maxMul - 1) * progress;
  }

  function getDifficultyXpMultiplier(diffName) {
    switch (diffName) {
      case 'かんたん':
      case 'やさしい':
        return 0.8;
      case 'むずかしい':
        return 1.5;
      case 'ふつう':
      default:
        return 1.0;
    }
  }

  function getStageXpMultiplier(stageName) {
    if (!stageName) return 1.0;
    const stage = stageDefs?.[stageName];
    if (!stage || !Number.isFinite(stage.difficulty)) return 1.0;
    const diff = Math.max(1, Math.floor(stage.difficulty));
    switch (diff) {
      case 2:
        return 1.02;
      case 3:
        return 1.05;
      case 4:
        return 1.07;
      case 5:
        return 1.2;
      default:
        if (diff >= 5) return 1.2;
        return 1.0;
    }
  }
  const achievementMap = new Map();
  for (const def of achievementDefs) {
    if (!def || typeof def.id !== 'string') continue;
    achievementMap.set(def.id, def);
  }
  const difficultyOrder = new Map([
    ['かんたん', 0],
    ['ふつう', 1],
    ['むずかしい', 2],
  ]);
  const okpExBossDamageMultipliers = Object.freeze({
    'かんたん': 0.95,
    'ふつう': 0.85,
    'むずかしい': 0.75,
  });
  function difficultyAtLeast(actual, required) {
    const actualRank = difficultyOrder.has(actual) ? difficultyOrder.get(actual) : -Infinity;
    const requiredRank = difficultyOrder.has(required) ? difficultyOrder.get(required) : Infinity;
    return actualRank >= requiredRank;
  }
  const survivalAchievements = achievementDefs.filter(def => def?.type === 'surviveTime' && Number.isFinite(def?.seconds));
  const achievementCountAchievements = achievementDefs.filter(def => def?.type === 'achievementCount' && Number.isFinite(def?.count));
  const hardClearCountAchievements = achievementDefs.filter(def => def?.type === 'hardClearCount' && Number.isFinite(def?.count));
  const cardUsageAchievements = achievementDefs.filter(def => def?.type === 'cardUsageCount' && Number.isFinite(def?.count));
  const damageAchievements = achievementDefs.filter(def => def?.type === 'maxDamage' && Number.isFinite(def?.damage));
  const specialKillAchievements = achievementDefs.filter(def => def?.type === 'specialKill');
  const stageClearAchievements = achievementDefs.filter(def => def?.type === 'stageClear');
  const ignitionClearAchievements = achievementDefs.filter(def => def?.type === 'ignitionClear');
  function beginIsoscelesTrianglePath(ctx, size) {
    ctx.beginPath();
    ctx.moveTo(size, 0);
    const back = -size * 0.65;
    const halfHeight = size * 0.9;
    ctx.lineTo(back, halfHeight);
    ctx.lineTo(back, -halfHeight);
    ctx.closePath();
  }
  const poisonDamageAchievements = achievementDefs.filter(def => def?.type === 'poisonDamageClear' && Number.isFinite(def?.damage));
  const melonPanAchievements = achievementDefs.filter(def => def?.type === 'melonPanClear' && Number.isFinite(def?.count));
  const hpHalfHardAchievements = achievementDefs.filter(def => def?.type === 'hpHalfHardClear');
  const shopPurchaseAchievements = achievementDefs.filter(def => def?.type === 'shopPurchaseCount' && Number.isFinite(def?.count));
  let maxDamageRecord = 0;
  function checkDamageAchievements(amount) {
    if (!damageAchievements.length) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (!state.inGame || !state.stats?.alive) return;
    if (amount <= maxDamageRecord) return;
    maxDamageRecord = amount;
    for (const def of damageAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      if (amount >= def.damage) {
        unlockAchievement(def.id);
      }
    }
  }
  let checkingAchievementCounts = false;

  // DOM refs
  const screenLobby = $('#screen-lobby');
  const screenRoom = $('#screen-room');
  const screenGame = $('#screen-game');
  const screenResult = $('#screen-result');
  const adSection = document.querySelector('.ad-section');
  const roomList = $('#roomList');
  const playerNameInput = $('#playerName');
  const btnSetName = $('#btnSetName');
  const currentName = $('#currentName');
  const roomIdLabel = $('#roomIdLabel');
  const memberList = $('#memberList');
  const subWeaponRow = $('#subWeaponRow');
  const subWeaponList = $('#subWeaponList');
  const secondSubWeaponSection = $('#secondSubWeaponSection');
  const secondSubWeaponList = $('#secondSubWeaponList');
  let subWeaponSelectionDisabled = false;
  const roleLabel = document.getElementById('roleLabel');
  const roomPasswordWrapper = $('#roomPasswordWrapper');
  const roomPasswordLabel = $('#roomPasswordLabel');
  const chkRoomPassword = $('#chkRoomPassword');
  const characterSelect = $('#characterSelect');
  const characterImage = $('#characterImage');
  const characterDescription = $('#characterDescription');
  const characterStats = $('#characterStats');
  const characterAbility = $('#characterAbility');
  const characterExSkill = $('#characterExSkill');
  const characterActive = $('#characterActive');
  const stageSelect = $('#stageSelect');
  const stageImage = $('#stageImage');
  const stageDescription = $('#stageDescription');
  const stageDifficulty = $('#stageDifficulty');
  const stageCorrection = $('#stageCorrection');
  const stageClearStatus = $('#stageClearStatus');
  const difficultySelect = $('#difficultySelect');
  const difficultyDescription = $('#difficultyDescription');
  const difficultyCorrection = $('#difficultyCorrection');
  const ignitionModeRow = $('#ignitionModeRow');
  const ignitionModeToggle = $('#chkIgnitionMode');
  const ignitionModeStatus = $('#ignitionModeStatus');
  const ignitionModeHelp = $('#ignitionModeHelp');
  const hudStats = $('#hudStats');
  const hudEnergy = $('#hudEnergy');
  const hudEnergyMul = $('#hudEnergyMul');
  const hudEnergyMulRow = $('#hudEnergyMulRow');
  const hudPerksLobby = document.getElementById('hudPerks');
  const hudPerksGame = document.getElementById('hudPerksGame');
  const hudCoordinatesRow = document.getElementById('hudCoordinatesRow');
  const hudCoordinates = document.getElementById('hudCoordinates');
  let hudCoordinatesVisible = false;
  let lastCoordinateText = '';
  function resetCoordinateHud() {
    if (!hudCoordinatesRow || !hudCoordinates) return;
    hudCoordinatesRow.classList.add('hidden');
    hudCoordinates.textContent = '';
    hudCoordinatesVisible = false;
    lastCoordinateText = '';
  }
  function updateCoordinateHud(x, y) {
    if (!hudCoordinatesRow || !hudCoordinates) return;
    const enabled = !!state.settings.showCoordinates && state.inGame;
    const valid = Number.isFinite(x) && Number.isFinite(y);
    if (!enabled || !valid) {
      if (hudCoordinatesVisible) {
        resetCoordinateHud();
      }
      return;
    }
    const text = `座標: X=${Math.round(x)} / Y=${Math.round(y)}`;
    if (!hudCoordinatesVisible) {
      hudCoordinatesRow.classList.remove('hidden');
      hudCoordinatesVisible = true;
    }
    if (text !== lastCoordinateText) {
      hudCoordinates.textContent = text;
      lastCoordinateText = text;
    }
  }
  const shopLog = $('#shopLog');
  const moneyBalanceRoom = $('#moneyBalanceRoom');
  const moneyBalanceShop = $('#moneyBalanceShop');
  const moneyBalanceCardShop = $('#moneyBalanceCardShop');
  const moneyBalanceWeaponShop = $('#moneyBalanceWeaponShop');
  const btnOpenShop = $('#btnOpenShop');
  const btnOpenCardShop = $('#btnOpenCardShop');
  const btnOpenWeaponShop = $('#btnOpenWeaponShop');
  const shopModal = $('#shopModal');
  const shopItems = $('#shopItems');
  const btnShopClose = $('#btnShopClose');
  const cardShopModal = $('#cardShopModal');
  const cardShopItems = $('#cardShopItems');
  const cardSynergyToggle = $('#cardSynergyToggle');
  const cardSynergyHint = $('#cardSynergyHint');
  const btnCardShopClose = $('#btnCardShopClose');
  const weaponShopModal = $('#weaponShopModal');
  const weaponShopItems = $('#weaponShopItems');
  const btnWeaponShopClose = $('#btnWeaponShopClose');
  const cardDeckEl = $('#cardDeck');
  const hudCardBuffs = $('#hudCardBuffs');
  const hudSubWeaponRow = $('#hudSubWeaponRow');
  const hudSubWeaponName = $('#hudSubWeaponName');
  const hudSubWeaponUses = $('#hudSubWeaponUses');
  const hudSubWeaponGauge = $('#hudSubWeaponGauge');
  const hudSubWeaponGaugeFill = hudSubWeaponGauge ? hudSubWeaponGauge.querySelector('.fill') : null;
  const hudActiveName = $('#hudActiveName');
  const reviveGaugeWrap = document.getElementById('reviveGauge');
  const reviveGaugeLabel = document.getElementById('reviveGaugeLabel');
  const reviveGaugeFill = reviveGaugeWrap ? reviveGaugeWrap.querySelector('.fill') : null;
  const cardSelectModal = $('#cardSelectModal');
  const cardSelectHeading = $('#cardSelectHeading');
  const cardSelectChoices = $('#cardSelectChoices');
  const converterModal = $('#converterModal');
  const convertFrom = $('#convertFrom');
  const convertTo = $('#convertTo');
  const convertAmount = $('#convertAmount');
  const convertRate = $('#convertRate');
  const convertEnergyStatus = $('#convertEnergyStatus');
  const btnConvert = $('#btnConvert');
  const btnConvertCancel = $('#btnConvertCancel');
  let converterTimer = null;
  let converterCountdown = null;
  let converterFocusIndex = 0;
  const converterControlIds = ['convertFrom', 'convertTo', 'convertAmountDown', 'convertAmount', 'convertAmountUp', 'btnConvert', 'btnConvertCancel'];
  const convertAmountButtons = converterModal?.querySelector('.convert-amount-buttons');
  let disbandRequestInFlight = false;
  let currentStoryIndex = 0;
  const getConverterControls = () => converterControlIds
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const resultStats = $('#resultStats');
  const energyGauges = $('#energyGauges');
  const energyGaugeFills = {};
  ['tension', 'sugar', 'yeast', 'cuteness', 'brand'].forEach(t => {
    energyGaugeFills[t] = document.getElementById(`energyGauge-${t}`)?.querySelector('.fill');
  });
  // Single source of truth for energy types
  const energyTypes = [
    { value: 'yeast', label: 'イースト菌' },
    { value: 'sugar', label: '糖分' },
    { value: 'cuteness', label: '可愛さ' },
    { value: 'brand', label: 'ブランド力' }
  ];
  if (convertFrom) convertFrom.innerHTML = energyTypes.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  if (convertTo) convertTo.innerHTML = convertFrom ? convertFrom.innerHTML : '';
  const toastEl = $('#toast');
  const lobbySettingsBtn = $('#btnLobbySettings');
  const lobbySettingsModal = $('#lobbySettingsModal');
  const btnExportSettings = $('#btnExportSettings');
  const btnImportSettings = $('#btnImportSettings');
  const fileImportSettings = $('#fileImportSettings');
  const roomSettingsBtn = $('#btnRoomSettings');
  const roomSettingsModal = $('#roomSettingsModal');
  const roomSettingsClose = $('#btnRoomSettingsClose');
  const helpBtn = $('#btnHelp');
  const helpModal = $('#helpModal');
  const roomHelpBtn = $('#btnRoomHelp');
  const roomHelpModal = $('#roomHelpModal');
  const roomHelpClose = $('#btnRoomHelpClose');
  const roomStoryBtn = $('#btnRoomStory');
  const roomStoryModal = $('#roomStoryModal');
  const roomStoryClose = $('#btnRoomStoryClose');
  const roomStoryTitle = $('#roomStoryTitle');
  const roomStoryBody = $('#roomStoryBody');
  const roomStoryPrev = $('#btnRoomStoryPrev');
  const roomStoryNext = $('#btnRoomStoryNext');
  const roomStoryIndicator = $('#roomStoryIndicator');
  if (roomStoryBody || roomStoryTitle || roomStoryIndicator) {
    renderRoomStoryEpisode(0);
  }
  const achievementsBtn = $('#btnAchievements');
  const roomAchievementsBtn = $('#btnRoomAchievements');
  const roomGalleryBtn = $('#btnRoomGallery');
  const achievementsModal = $('#achievementsModal');
  const achievementsClose = $('#btnAchievementsClose');
  const achievementsList = $('#achievementList');
  const galleryModal = $('#galleryModal');
  const galleryClose = $('#btnGalleryClose');
  const galleryGrid = $('#galleryGrid');
  const galleryPreviewImage = $('#galleryPreviewImage');
  const galleryPreviewTitle = $('#galleryPreviewTitle');
  const disbandConfirmModal = $('#disbandConfirmModal');
  const btnDisbandConfirm = $('#btnDisbandConfirm');
  const btnDisbandCancel = $('#btnDisbandCancel');
  const serverErrorModal = $('#serverErrorModal');
  const versionLabel = document.getElementById('versionLabel');
  // const btnBuy = $('#btnBuy'); // deprecated
  const levelUpModal = $('#levelUpModal');
  const levelChoices = $('#levelChoices');
  const gameCanvas = document.getElementById('gameCanvas');
  const stunSprites = getStunIndicatorSprites();
  // 重複リスナーを防止するための管理
  if (initApp._listeners) {
    for (const [t, type, h, options] of initApp._listeners) {
      try { t.removeEventListener(type, h, options); } catch { }
    }
  }
  if (typeof initApp._detachConverterKeyHandler === 'function') {
    try { initApp._detachConverterKeyHandler(); } catch { }
  }
  initApp._detachConverterKeyHandler = null;
  initApp._listeners = [];
  const addListener = (target, type, handler, options) => {
    if (!target) return;
    for (const [t, ty, h, opts] of initApp._listeners) {
      // Compare options by reference or primitive value
      if (t === target && ty === type && h === handler && opts === options) return;
    }
    target.addEventListener(type, handler, options);
    initApp._listeners.push([target, type, handler, options]);
  };
  const wqhdQuery = window.matchMedia('(min-width: 2560px), (min-height: 1440px)');
  function adjustGameCanvas(e) {
    if (!gameCanvas) return;
    if (e.matches) {
      gameCanvas.width = 960;
      gameCanvas.height = 540;
    } else {
      gameCanvas.width = 640;
      gameCanvas.height = 360;
    }
  }
  adjustGameCanvas(wqhdQuery);
  try { addListener(wqhdQuery, 'change', adjustGameCanvas); } catch { wqhdQuery.addListener(adjustGameCanvas); }
  // Level-up modal opener (assigned during game start)
  let openLevelUp = () => { /* no-op until game loop initializes */ };
  openLevelUp.autoTimer = null;
  openLevelUp.countdownTimer = null;
  openLevelUp.keyHandler = null;

  const BASE_UPGRADE_LIMIT = 10;
  const BASE_SKILL_LIMIT = 5;
  const EXP_ORB_PULL_SPEED = 2;
  let UPGRADE_LIMIT = BASE_UPGRADE_LIMIT;
  let SKILL_LIMIT = BASE_SKILL_LIMIT;
  const upgradeLabels = {
    'atk+': '攻撃力',
    'hp+': '最大HP',
    'spd+': '移動速度',
    'regen': '再生',
    'rate': '攻撃間隔',
    'multi': '弾数',
    'range': '射程',
    'exp+': '吸収範囲',
    'skill': 'スキル',
    'supportBook': '支援魔法：本',
    'supportLaser': '支援魔法：レーザー',
    'supportBomb': '支援魔法：爆撃'
  };

  const SUPPORT_BOOK_BASE_MAX = 3;
  const SUPPORT_LASER_BASE_MAX = 3;
  const SUPPORT_BOMB_BASE_MAX = 3;
  function getSupportMagicBonus() {
    return Math.max(0, state?.perks?.support || 0);
  }
  function getSupportBookMax() {
    return SUPPORT_BOOK_BASE_MAX + getSupportMagicBonus();
  }
  function getSupportLaserMax() {
    return SUPPORT_LASER_BASE_MAX + getSupportMagicBonus();
  }
  function getSupportBombMax() {
    return SUPPORT_BOMB_BASE_MAX + getSupportMagicBonus();
  }
  let clampSupportMagicCounts = () => { };

  const statLabels = { hp: 'HP', spd: '移動速度', armor: 'アーマー' };

  const elementLabels = { fire: '炎', ice: '氷', lightning: '雷', dark: '闇' };
  const elementColors = { fire: '#ff4500', ice: '#66ccff', lightning: '#ffff33', dark: '#9933ff' };
  const elementTypes = Object.keys(elementLabels);
  const ELEMENT_STAGE_MAX = 5;
  const elementWeaknessStageMultipliers = [0, 1.5, 1.75, 2.0, 2.25, 2.5];
  const elementOtherStageMultipliers = [0, 0.8, 0.725, 0.65, 0.575, 0.5];
  const stageElementWeights = {
    'メロンパン火山地帯': { fire: 1.3, ice: 1, lightning: 1, dark: 1 },
  };

  function pickStageElement(stageName) {
    const weights = stageElementWeights[stageName];
    if (!weights) {
      return elementTypes[Math.floor(Math.random() * elementTypes.length)];
    }
    let total = 0;
    for (const elem of elementTypes) {
      total += weights[elem] ?? 1;
    }
    let roll = Math.random() * total;
    for (const elem of elementTypes) {
      roll -= weights[elem] ?? 1;
      if (roll < 0) return elem;
    }
    return elementTypes[elementTypes.length - 1];
  }
  const elementWeakness = { fire: 'ice', ice: 'lightning', lightning: 'dark', dark: 'fire' };
  const elemSpawnDefs = {
    'かんたん': { start: 30, chance: 0.9 },
    'ふつう': { start: 20, chance: 0.95 },
    'むずかしい': { start: 10, chance: 1.0 }
  };
  function clampElementStage(stage) {
    if (!Number.isFinite(stage)) return 0;
    const clamped = Math.max(0, Math.min(ELEMENT_STAGE_MAX, Math.floor(stage)));
    return clamped;
  }

  function getPlayerElementStage(atkElem) {
    if (!atkElem) return 1;
    if (!state.stats || state.stats.elem !== atkElem) return 1;
    const stage = clampElementStage(state.stats.elemStage);
    return stage > 0 ? stage : 1;
  }

  function applyElementalMultiplier(dmg, atkElem, defElem, stage = 1) {
    if (!defElem) return dmg;
    if (!atkElem) return dmg * 0.3;
    const clamped = Math.max(1, Math.min(ELEMENT_STAGE_MAX, Math.floor(stage || 1)));
    const weakMul = elementWeaknessStageMultipliers[clamped] ?? elementWeaknessStageMultipliers[1];
    const otherMul = elementOtherStageMultipliers[clamped] ?? elementOtherStageMultipliers[1];
    return dmg * (elementWeakness[defElem] === atkElem ? weakMul : otherMul);
  }
  function applyBossBonus(dmg, enemy) {
    if (!isFinite(dmg) || dmg <= 0) return dmg;
    if (enemy?.boss) {
      let mul = state.stats?.bossDmgMul || 1;
      if (state.energyUnlocked) {
        const t = state.energy.tension;
        const tMul = 0.00008 * t * t + 0.004 * t + 0.6;
        mul *= tMul;
      }
      return dmg * mul;
    }
    return dmg;
  }

  function applyHealBonus(amount) {
    if (!isFinite(amount) || amount <= 0) return amount;
    if (!state.energyUnlocked) return amount;
    const s = state.energy.sugar;
    const mul = 0.00016 * s * s - 0.002 * s + 0.7;
    return amount * mul;
  }
  function getAtk() {
    let atk = state.stats.atk;
    if (state.energyUnlocked) {
      const c = state.energy.cuteness;
      atk *= 0.00004 * c * c + 0.9;
    }
    return atk;
  }

  function gainPlayerElement(newElem, options = {}) {
    const { playSfx = true, toast = true, adjustStage = true, forcedStage } = options;
    if (!state.stats) return 0;
    if (!newElem) {
      state.stats.elem = null;
      state.stats.elemStage = 0;
      return 0;
    }
    const prevElem = state.stats.elem;
    let stage = clampElementStage(state.stats.elemStage);
    if (adjustStage) {
      if (prevElem === newElem) {
        stage = Math.min(ELEMENT_STAGE_MAX, (stage || 0) + 1);
      } else {
        stage = Math.max(1, stage > 0 ? stage - 1 : 1);
      }
    } else if (Number.isFinite(forcedStage)) {
      stage = clampElementStage(forcedStage);
      if (stage <= 0) stage = 1;
    } else if (stage <= 0) {
      stage = 1;
    }
    state.stats.elem = newElem;
    state.stats.elemStage = stage;
    if (playSfx) {
      try { Audio?.playSfx?.(state, `${newElem}Atk`); } catch { }
    }
    if (toast) {
      const label = elementLabels[newElem] || '';
      showToast(`${label}属性を得た！ (${stage}/${ELEMENT_STAGE_MAX})`);
    }
    return stage;
  }
  function calcMoneyGain(amount, options = {}) {
    const { applyBrandMultiplier = true } = options;
    if (!applyBrandMultiplier) return amount;
    if (!state.energyUnlocked) return amount;
    const b = state.energy.brand;
    const mul = 0.00002 * b * b + 0.001 * b + 0.9;
    return amount * mul;
  }
  function addMoney(amount, options = {}) {
    const { applyRiskMultiplier = true, preview = false } = options;
    let effectiveAmount = amount;
    if (applyRiskMultiplier && riskEventEffect?.type === 'money') {
      effectiveAmount *= 3;
    }
    const gain = Math.round(calcMoneyGain(effectiveAmount, options));
    if (!preview) {
      state.money += gain;
    }
    return gain;
  }
  function refundMoney(basePrice) {
    return addMoney(basePrice, { applyBrandMultiplier: false, applyRiskMultiplier: false });
  }
  // Conversion rates between energy types.
  // yeast -> sugar: 0.7 (i.e., 1 yeast converts to 0.7 sugar)
  // sugar -> yeast: 0.8 (i.e., 1 sugar converts to 0.8 yeast)
  // sugar -> cuteness: 0.8 (i.e., 1 sugar converts to 0.8 cuteness)
  // cuteness -> brand: 0.85 (i.e., 1 cuteness converts to 0.85 brand)
  const conversionRates = {
    yeast: { sugar: 0.7 },                   // Conversion rate from yeast to sugar
    sugar: { yeast: 0.8, cuteness: 0.8 },    // Conversion rates from sugar to yeast and cuteness
    cuteness: { brand: 0.85 }                // Conversion rate from cuteness to brand
  };
  const focusConverterControl = (index) => {
    const controls = getConverterControls();
    if (!controls.length) return;
    const len = controls.length;
    converterFocusIndex = ((index % len) + len) % len;
    const el = controls[converterFocusIndex];
    if (!el || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: true });
    } catch (err1) {
      console.error("Error focusing element with preventScroll:", err1);
      try { el.focus(); } catch (err2) {
        console.error("Error focusing element without preventScroll:", err2);
      }
    }
  };
  const onConverterKeyDown = (ev) => {
    if (!converterModal || converterModal.classList.contains('hidden')) return;
    const controls = getConverterControls();
    if (!controls.length) return;
    const active = document.activeElement;
    const idx = controls.indexOf(active);
    if (idx >= 0) converterFocusIndex = idx;
    const moveFocus = (delta) => {
      focusConverterControl(converterFocusIndex + delta);
    };
    switch (ev.key) {
      case 'ArrowRight':
        moveFocus(1);
        ev.preventDefault();
        break;
      case 'ArrowLeft':
        moveFocus(-1);
        ev.preventDefault();
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        const tagName = active?.tagName;
        const type = active?.type;
        if (tagName === 'SELECT') return;
        if (tagName === 'INPUT' && (type === 'number' || type === 'range')) return;
        moveFocus(ev.key === 'ArrowDown' ? 1 : -1);
        ev.preventDefault();
        break;
      }
      case 'Enter': {
        let handled = false;
        if (btnConvertCancel && active === btnConvertCancel) {
          btnConvertCancel.click();
          handled = true;
        } else if (btnConvert && !btnConvert.disabled) {
          btnConvert.click();
          handled = true;
        }
        if (handled) ev.preventDefault();
        break;
      }
      default:
        break;
    }
  };
  let converterKeyHandlerAttached = false;
  const attachConverterKeyHandler = () => {
    if (converterKeyHandlerAttached) return;
    window.addEventListener('keydown', onConverterKeyDown, true);
    converterKeyHandlerAttached = true;
  };
  const detachConverterKeyHandler = () => {
    if (!converterKeyHandlerAttached) return;
    window.removeEventListener('keydown', onConverterKeyDown, true);
    converterKeyHandlerAttached = false;
  };
  initApp._detachConverterKeyHandler = detachConverterKeyHandler;
  function sanitizeConvertAmountInput(ev) {
    const isHtmlInput = typeof HTMLInputElement !== 'undefined' && ev?.target instanceof HTMLInputElement;
    const amountInput = isHtmlInput ? ev.target : (convertAmount || $('#convertAmount'));
    if (!amountInput) return;
    const rawValue = Number(amountInput.value);
    if (!Number.isFinite(rawValue)) return;
    const minRaw = Number.parseFloat(amountInput.min);
    const maxRaw = Number.parseFloat(amountInput.max);
    const min = Number.isFinite(minRaw) ? Math.ceil(minRaw) : null;
    const max = Number.isFinite(maxRaw) ? Math.floor(maxRaw) : null;
    let next = Math.floor(rawValue);
    if (min != null) next = Math.max(next, min);
    if (max != null) next = Math.min(next, max);
    if (String(next) !== amountInput.value) amountInput.value = String(next);
  }
  function updateConvertButton() {
    if (!btnConvert) return;
    const fromSel = convertFrom || $('#convertFrom');
    const toSel = convertTo || $('#convertTo');
    const from = fromSel?.value;
    const to = toSel?.value;
    const rate = conversionRates[from]?.[to];
    btnConvert.disabled = !(from && to && rate);
    if (convertRate) {
      if (rate) {
        const fromLabel = energyTypes.find(e => e.value === from)?.label;
        const toLabel = energyTypes.find(e => e.value === to)?.label;
        convertRate.textContent = `変換倍率: 1${fromLabel} → ${rate.toFixed(2)}${toLabel}`;
      } else {
        convertRate.textContent = '';
      }
    }
  }
  function adjustConvertAmount(delta) {
    const amountInput = convertAmount || $('#convertAmount');
    if (!amountInput) return;
    const min = Number(amountInput.min);
    const max = Number(amountInput.max);
    const step = Number(amountInput.step);
    const current = Number(amountInput.value) || 0;
    let next = current + delta;
    if (!Number.isNaN(step) && step > 0) {
      next = Math.round(next / step) * step;
    }
    if (!Number.isNaN(min)) {
      next = Math.max(next, min);
    }
    if (!Number.isNaN(max)) {
      next = Math.min(next, max);
    }
    if (next === current) return;
    amountInput.value = String(next);
    try {
      amountInput.focus({ preventScroll: true });
    } catch {
      try { amountInput.focus(); } catch { }
    }
    const amountIdx = converterControlIds.indexOf('convertAmount');
    if (amountIdx >= 0) converterFocusIndex = amountIdx;
    amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    amountInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  addListener(convertFrom, 'change', updateConvertButton);
  addListener(convertTo, 'change', updateConvertButton);
  addListener(convertAmount, 'input', sanitizeConvertAmountInput);
  addListener(convertAmount, 'change', sanitizeConvertAmountInput);
  addListener(convertAmountButtons, 'click', (ev) => {
    const btn = ev.target?.closest('[data-convert-delta]');
    if (!btn || !(btn instanceof HTMLElement)) return;
    if (convertAmountButtons && !convertAmountButtons.contains(btn)) return;
    const delta = Number(btn.dataset.convertDelta);
    if (!Number.isFinite(delta) || delta === 0) return;
    ev.preventDefault();
    adjustConvertAmount(delta);
  });
  updateConvertButton();
  function formatEnergyValues(energy) {
    if (!energy) return '';
    const toInt = (value) => {
      const num = Number(value ?? 0);
      return Number.isFinite(num) ? Math.floor(num) : 0;
    };
    return `テンション: ${toInt(energy.tension)} / 糖分: ${toInt(energy.sugar)} / イースト菌: ${toInt(energy.yeast)} / 可愛さ: ${toInt(energy.cuteness)} / ブランド力: ${toInt(energy.brand)}`;
  }
  function updateConverterEnergyStatus(currentState) {
    if (!convertEnergyStatus) return;
    if (!currentState?.energyUnlocked) {
      convertEnergyStatus.textContent = 'エネルギーシステム未解禁';
      return;
    }
    convertEnergyStatus.textContent = `現在値: ${formatEnergyValues(currentState.energy)}`;
  }
  function updateSubWeaponHud(runtime = state.subWeaponRuntime) {
    if (!hudSubWeaponRow) return;
    if (!runtime || !runtime.id || runtime.usesMax == null) {
      hudSubWeaponRow.classList.add('hidden');
      hudSubWeaponRow.classList.remove('empty', 'active');
      return;
    }
    const def = subWeaponMap.get(runtime.id);
    hudSubWeaponRow.classList.remove('hidden');
    hudSubWeaponRow.classList.toggle('empty', (runtime.usesLeft ?? 0) <= 0);
    hudSubWeaponRow.classList.toggle('active', !!runtime.active);
    if (hudSubWeaponName) {
      const name = def?.name || runtime.id;
      hudSubWeaponName.textContent = `サブウェポン: ${name}`;
    }
    if (hudSubWeaponUses) {
      const left = Math.max(0, Math.floor(runtime.usesLeft ?? 0));
      const max = Math.max(0, Math.floor(runtime.usesMax ?? 0));
      hudSubWeaponUses.textContent = `${left}/${max}`;
    }
    if (hudSubWeaponGaugeFill) {
      const ratio = runtime.usesMax > 0 ? Math.max(0, Math.min(1, (runtime.usesLeft ?? 0) / runtime.usesMax)) : 0;
      hudSubWeaponGaugeFill.style.width = `${ratio * 100}%`;
    }
  }

  function createSubWeaponRuntime(id) {
    if (!id || !subWeaponMap.has(id)) return null;
    const def = subWeaponMap.get(id);
    const uses = Math.max(0, Math.floor(def?.uses ?? 0));
    return { id: def.id, usesLeft: uses, usesMax: uses, active: false, activeTimer: 0 };
  }

  function trySwitchToSecondSubWeapon(force = false) {
    const current = state.subWeaponRuntime;
    if (!force && current?.active) return false;
    const next = state.secondSubWeaponRuntime;
    if (!next || next.usesMax == null) return false;
    state.subWeaponRuntime = next;
    state.secondSubWeaponRuntime = null;
    state.subWeaponRuntime.active = false;
    state.subWeaponRuntime.activeTimer = 0;
    updateSubWeaponHud();
    showToast('セカンドサブウェポンに切り替わった！');
    return true;
  }

  function handleSubWeaponDepletion(force = false) {
    const runtime = state.subWeaponRuntime;
    if (runtime && runtime.usesLeft <= 0) {
      if (trySwitchToSecondSubWeapon(force)) return;
    }
    updateSubWeaponHud();
  }

  function getUpgradeLimitForHud(key) {
    switch (key) {
      case 'skill':
        return SKILL_LIMIT;
      case 'supportBook':
        return getSupportBookMax();
      case 'supportLaser':
        return getSupportLaserMax();
      case 'supportBomb':
        return getSupportBombMax();
      default:
        return UPGRADE_LIMIT;
    }
  }

  function refreshHud() {
    if (!hudStats) return;
    const t = state._timeAlive || 0;
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60).toString().padStart(2, '0');
    const upgEntries = Object.entries(state.upgradeCounts || {});
    const upgText = upgEntries.filter(([, v]) => v > 0)
      .map(([k, v]) => {
        const limitRaw = getUpgradeLimitForHud(k);
        const limit = Number.isFinite(limitRaw) ? limitRaw : UPGRADE_LIMIT;
        const displayLimit = limit < v ? v : limit;
        return `${upgradeLabels[k] || k}:${v}/${displayLimit}`;
      })
      .join(' ');
    let attrText = '';
    if (state.stats.elem) {
      const rawStage = clampElementStage(state.stats.elemStage);
      const stage = rawStage > 0 ? rawStage : 1;
      attrText = ` / 属性: ${elementLabels[state.stats.elem] || state.stats.elem} ${stage}/${ELEMENT_STAGE_MAX}`;
    }
    const armorText = state.armorUnlocked ? ` / AR: ${Math.floor(state.stats.armor)}/${state.stats.maxArmor}` : '';
    const energyText = state.energyUnlocked ? formatEnergyValues(state.energy) : '';
    const energyMulText = state.energyUnlocked ? (() => {
      const e = state.energy;
      const tMul = 0.00008 * e.tension * e.tension + 0.004 * e.tension + 0.6;
      const sMul = 0.00016 * e.sugar * e.sugar - 0.002 * e.sugar + 0.7;
      const atkMul = 0.00004 * e.cuteness * e.cuteness + 0.9;
      const armorMul = 0.006 * e.cuteness + 0.5;
      const bMul = 0.00002 * e.brand * e.brand - 0.005 * e.brand + 1.1;
      const moneyMul = 0.00002 * e.brand * e.brand + 0.001 * e.brand + 0.9;
      return `対ボス火力:×${tMul.toFixed(2)} / 回復:×${sMul.toFixed(2)} / 攻撃:×${atkMul.toFixed(2)} / AR:×${armorMul.toFixed(2)} / 被ダメ:×${bMul.toFixed(2)} / マネー:×${moneyMul.toFixed(2)}`;
    })() : '';
    hudStats.textContent = `HP: ${Math.max(0, Math.floor(state.stats.hp))}/${state.stats.maxHp}${armorText} / ATK: ${Math.floor(getAtk())}${attrText} / LV: ${state.stats.lvl} (${Math.floor(state.stats.exp)}/${Math.floor(state.stats.nextExp)})${upgText ? ' / UPG: ' + upgText : ''} / TIME: ${mm}:${ss}`;
    if (hudEnergy) hudEnergy.textContent = energyText;
    if (hudEnergyMul) hudEnergyMul.textContent = energyMulText;
    if (hudEnergyMulRow) {
      if (state.energyUnlocked) hudEnergyMulRow.classList.remove('hidden');
      else hudEnergyMulRow.classList.add('hidden');
    }
    if (energyGauges) {
      if (state.energyUnlocked) energyGauges.classList.remove('hidden');
      else energyGauges.classList.add('hidden');
    }
    updateConverterEnergyStatus(state);
    for (const [type, el] of Object.entries(energyGaugeFills)) {
      if (!el) continue;
      const val = state.energyUnlocked ? state.energy[type] : 0;
      el.style.width = `${val}%`;
    }
    updateSubWeaponHud();
  }
  function openConverter() {
    if (!converterModal) return;
    attachConverterKeyHandler();
    updateConvertButton();
    const myId = state.me?.playerId;
    if (myId && !state.pauseBy.has(myId)) {
      const token = allocatePauseTokenFor(myId);
      const result = markPause(myId, state.me?.privateId, token);
      if (result) {
        const payload = { type: 'pause' };
        if (result.token != null) payload.token = result.token;
        sendEvent(payload).catch(() => { });
      }
    }
    const heading = converterModal.querySelector('h3');
    let remaining = 20;
    if (heading) heading.textContent = `リソース変換（${remaining}）`;
    clearTimeout(converterTimer);
    clearInterval(converterCountdown);
    converterTimer = setTimeout(() => { closeConverter(); }, 20000);
    converterCountdown = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) clearInterval(converterCountdown);
      if (heading) heading.textContent = `リソース変換（${remaining}）`;
    }, 1000);
    updateConverterEnergyStatus(state);
    converterModal.classList.remove('hidden');
    focusConverterControl(0);
  }
  function closeConverter() {
    detachConverterKeyHandler();
    if (!converterModal) return;
    converterModal.classList.add('hidden');
    clearTimeout(converterTimer);
    clearInterval(converterCountdown);
    const heading = converterModal.querySelector('h3');
    if (heading) heading.textContent = 'リソース変換';
    const myId = state.me?.playerId;
    if (myId && state.pauseBy.has(myId)) {
      const resumeInfo = clearPause(myId);
      const pc = state.room?.members?.length || 1;
      const freezeMs = [0, 500, 750, 1000, 1500, 2000][Math.min(pc, 5)];
      state._enemyFreezeUntil = performance.now() + freezeMs;
      const payload = { type: 'resume' };
      if (resumeInfo?.token != null) payload.token = resumeInfo.token;
      setTimeout(() => { sendEvent(payload).catch(() => { }); }, freezeMs);
    }
  }
  addListener(btnConvert, 'click', () => {
    if (!state.energyUnlocked) { showToast('エネルギーシステム未解禁', 'error'); closeConverter(); return; }
    const fromSel = convertFrom || $('#convertFrom');
    const toSel = convertTo || $('#convertTo');
    const from = fromSel?.value;
    const to = toSel?.value;
    const amountInput = convertAmount || $('#convertAmount');
    const rawAmount = Number(amountInput?.value);
    if (!Number.isFinite(rawAmount)) { showToast('有効な変換量を入力してください', 'error'); return; }
    const minRaw = Number.parseFloat(amountInput?.min);
    const maxRaw = Number.parseFloat(amountInput?.max);
    const min = Number.isFinite(minRaw) ? Math.ceil(minRaw) : null;
    const max = Number.isFinite(maxRaw) ? Math.floor(maxRaw) : null;
    let amount = Math.floor(rawAmount);
    if (min != null) amount = Math.max(amount, min);
    if (max != null) amount = Math.min(amount, max);
    if (amountInput && String(amount) !== amountInput.value) amountInput.value = String(amount);
    if (amount <= 0) { showToast('変換量は1以上を入力してください', 'error'); return; }
    const rate = conversionRates[from]?.[to];
    if (!rate) { showToast('その変換はできません', 'error'); closeConverter(); return; }
    if (!state.energy || typeof state.energy !== 'object') state.energy = {};
    const fromEnergyRaw = Number(state.energy[from]);
    const fromEnergy = Number.isFinite(fromEnergyRaw) ? fromEnergyRaw : 0;
    if (fromEnergy < amount) { showToast('リソースが不足しています', 'error'); return; }
    state.energy[from] = Math.max(0, fromEnergy - amount);
    const toEnergyRaw = Number(state.energy[to]);
    const toEnergy = Number.isFinite(toEnergyRaw) ? toEnergyRaw : 0;
    state.energy[to] = Math.max(0, Math.min(100, toEnergy + amount * rate));
    refreshHud();
    closeConverter();
  });
  addListener(btnConvertCancel, 'click', () => { closeConverter(); });
  function updateCharacterInfo(name) {
    const playableName = normalizeCharacterSelection(name);
    if (!playableName) {
      if (characterImage) {
        characterImage.onerror = null;
        characterImage.src = 'image/MelonPan.png';
      }
      if (characterDescription) characterDescription.textContent = 'キャラを選択してください';
      if (characterStats) characterStats.innerHTML = '<li>キャラ未選択</li>';
      if (characterAbility) characterAbility.textContent = '';
      if (characterExSkill) characterExSkill.textContent = '';
      if (characterActive) characterActive.textContent = '';
      return;
    }
    if (characterImage) {
      characterImage.onerror = () => {
        characterImage.onerror = null;
        characterImage.src = 'image/MelonPan.png';
      };
      characterImage.src = 'image/' + encodeURIComponent(playableName) + '.png';
    }
    if (characterDescription) characterDescription.textContent = characterDefs[playableName]?.description || '';
    if (characterStats) {
      const stats = characterDefs[playableName]?.stats || {};
      const { level, exp, nextExp, hpMul, spdMul, armorMul } = getCharacterGrowthDetails(playableName);
      const lines = [];
      if (state.characterGrowthUnlocked) {
        const progressText = nextExp > 0 ? `${exp}/${nextExp}` : 'MAX';
        lines.push(`<li>Lv: ${level}${nextExp > 0 ? ` (EXP ${progressText})` : ' (MAX)'}</li>`);
      } else {
        lines.push(`<li>Lv: ${level} (キャラ成長未解禁)</li>`);
      }
      if (typeof stats.hp === 'number') {
        lines.push(`<li>${statLabels.hp}: ${Math.round(stats.hp * hpMul)}</li>`);
      }
      if (typeof stats.spd === 'number') {
        lines.push(`<li>${statLabels.spd}: ${Math.round(stats.spd * spdMul * 100)}%</li>`);
      }
      if (state.armorUnlocked && typeof stats.armor === 'number') {
        lines.push(`<li>${statLabels.armor}: ${Math.round(stats.armor * armorMul)}</li>`);
      }
      characterStats.innerHTML = lines.join('');
    }
    if (characterAbility) {
      const text = characterDefs[playableName]?.ability;
      characterAbility.textContent = text ? `固有能力: ${text}` : '';
    }
    if (characterExSkill) {
      const text = characterDefs[playableName]?.ex;
      characterExSkill.textContent = text ? `EXスキル: ${text}` : '';
    }
    if (characterActive) {
      const text = characterDefs[playableName]?.active;
      characterActive.textContent = text ? `アクティブウェポン：${text}` : '';
    }
  }
  function updateStageInfo(name) {
    if (stageImage) {
      stageImage.onerror = () => {
        stageImage.onerror = null;
        stageImage.src = 'image/MelonPan.png';
      };
      stageImage.src = 'image/stage_' + encodeURIComponent(name) + '.png';
    }
    if (stageDescription) {
      const base = stageDefs[name]?.description || '';
      stageDescription.textContent = base;
    }
    if (stageDifficulty) {
      //test
      const raw = stageDefs[name]?.difficulty;
      if (raw == null) {
        stageDifficulty.textContent = '';
      } else {
        const diff = Number(raw) || 0;
        const stars = Math.max(0, Math.min(5, Math.floor(diff)));
        stageDifficulty.textContent = `難易度: ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;
      }
    }
    if (stageCorrection) {
      const corr = stageDefs[name]?.mobHpMul ?? 1;
      stageCorrection.textContent = `ステージ補正: 敵HPx${corr}`;
    }
    if (stageClearStatus) {
      if (!name || !Array.isArray(difficulties) || difficulties.length === 0) {
        stageClearStatus.textContent = '';
      } else {
        const clears = state.stageClears?.[name] || {};
        const rows = difficulties.map((diff, idx) => {
          const label = idx === 0 ? 'クリア：' : '　　　　';
          const diffLabel = (diff || '').padEnd(6, '　');
          const status = formatStageClearStatus(clears?.[diff]);
          return `${label}${diffLabel}${status}`;
        });
        stageClearStatus.textContent = rows.join('\n');
      }
    }
  }
  function normalizeStageClearValue(value) {
    if (value && typeof value === 'object') {
      const baseCleared = value.cleared ?? value.clear ?? value.done ?? value.status ?? value.ignition ?? false;
      return { cleared: !!baseCleared, ignition: !!value.ignition };
    }
    return { cleared: !!value, ignition: false };
  }

  function mergeStageClearValue(prevValue, updates) {
    const prev = normalizeStageClearValue(prevValue);
    const cleared = prev.cleared || !!updates?.cleared;
    const ignition = prev.ignition || !!updates?.ignition;
    return { cleared, ignition };
  }

  function formatStageClearStatus(value) {
    const entry = normalizeStageClearValue(value);
    if (!entry.cleared) return '未';
    return entry.ignition ? '済（ｲｸﾞﾆｯｼｮﾝ）' : '済';
  }

  function normalizeStageClearsState(map) {
    if (!map || typeof map !== 'object') return {};
    const normalized = {};
    for (const [stage, diffs] of Object.entries(map)) {
      if (!diffs || typeof diffs !== 'object') continue;
      const nextDiffs = {};
      for (const [diff, value] of Object.entries(diffs)) {
        const entry = normalizeStageClearValue(value);
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
  function updateDifficultyInfo(name) {
    const cfg = (difficultyDescription || difficultyCorrection) ? getDifficultyConfig(name) : null;
    if (difficultyDescription) {
      difficultyDescription.textContent = cfg?.description || '';
    }
    if (difficultyCorrection) {
      if (cfg) {
        const isIgnitionHard = name === 'むずかしい' && isIgnitionModeActive();
        const spawnMulText = isIgnitionHard ? '2.0' : cfg.spawnMul;
        difficultyCorrection.textContent = `難易度補正: 敵HPx${cfg.hpMul}, 出現数x${spawnMulText}, 弾発射頻度x${cfg.bulletMul}, 弾ダメージx${cfg.bulletDmgMul}`;
        difficultyCorrection.style.color = isIgnitionHard ? '#d11' : '';
      } else {
        difficultyCorrection.textContent = '';
        difficultyCorrection.style.color = '';
      }
    }
  }
  function ensureRoomFlags(room) {
    if (!room || typeof room !== 'object') return;
    if (!room.flags || typeof room.flags !== 'object') room.flags = {};
  }
  function normalizeRoom(room) {
    if (!room || typeof room !== 'object') return room;
    ensureRoomFlags(room);
    if (Array.isArray(room.members)) {
      room.members = room.members.map((member) => {
        if (member && typeof member === 'object') {
          const next = { ...member };
          if (next.publicId && !next.id) next.id = next.publicId;
          return next;
        }
        return member;
      });
    }
    if (room.ownerPublicId && !room.owner) room.owner = room.ownerPublicId;
    return room;
  }
  function normalizeRooms(list) {
    if (!Array.isArray(list)) return list;
    return list.map((room) => cloneRoomPayload(room) ?? room);
  }
  function cloneRoomPayload(room) {
    if (!room || typeof room !== 'object') return null;
    const clone = {
      ...room,
      members: Array.isArray(room.members) ? room.members.map(m => (m && typeof m === 'object' ? { ...m } : m)) : room.members,
    };
    return normalizeRoom(clone);
  }
  function sendEvent(event) {
    if (!state.room || !state.me?.authToken) return Promise.resolve();
    return api.postEvent(state.room.id, state.me.privateId, state.me.authToken, event);
  }
  function updateIgnitionControls() {
    const room = state.room;
    const active = !!(room?.flags?.ignitionMode);
    const hasUnlock = !!state.ignitionModeUnlocked;
    const shouldShow = !!(room && (hasUnlock || active));
    if (ignitionModeRow) ignitionModeRow.classList.toggle('hidden', !shouldShow);
    if (ignitionModeHelp) ignitionModeHelp.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    const isOwner = room?.owner === state.me?.playerId;
    const meMember = room?.members?.find(m => m.id === state.me?.playerId);
    const imReady = !!meMember?.ready;
    const isHardDifficulty = room?.difficulty === 'むずかしい';
    if (ignitionModeToggle) {
      ignitionModeToggle.checked = active;
      const disable = !isOwner || imReady || !hasUnlock || !isHardDifficulty;
      ignitionModeToggle.disabled = disable;
      const reasons = [];
      if (!hasUnlock && isOwner) reasons.push('ショップで解禁してください');
      if (!isOwner) reasons.push('部屋主のみ変更できます');
      if (imReady) reasons.push('準備中は変更できません');
      if (!isHardDifficulty) reasons.push('難易度「むずかしい」でのみ切り替えできます');
      ignitionModeToggle.title = reasons.join(' / ');
    }
    if (ignitionModeStatus) {
      ignitionModeStatus.textContent = active ? 'ON' : 'OFF';
      ignitionModeStatus.className = active ? 'badge ready' : 'badge';
      ignitionModeStatus.title = '難易度「むずかしい」選択時に効果が適用されます';
    }
    if (ignitionModeHelp) {
      ignitionModeHelp.textContent = '※「むずかしい」選択時に効果が適用されます';
    }
  }
  const bossElemBonus = {
    '大型個体': { fire: 1.2, ice: 1.1, lightning: 1.15, dark: 1.15 },
    '中型個体': { fire: 1.1, ice: 1.2, lightning: 1.15, dark: 1.15 },
    'default': { fire: 1.1, ice: 1.1, lightning: 1.1, dark: 1.1 }
  };
  // Cached image for heal pickups (MelonPan)
  const melonImg = new Image(); melonImg.src = 'image/MelonPan.png';
  // Cached image for rare rainbow heal pickup
  const rainbowImg = new Image(); rainbowImg.src = 'image/RainbowMelonPan.png';
  // Cached image for money pickup
  const moneyImg = new Image();
  moneyImg.src = 'image/Money.png';
  const rainbowMoneyImg = new Image();
  rainbowMoneyImg.src = 'image/RainbowMoney.png';
  // Cached image for EXP orb
  const expImg = new Image();
  expImg.src = 'image/exp-x1-orb.png';
  // Cached image for 5x EXP orb
  const exp5Img = new Image();
  exp5Img.src = 'image/exp-x5-orb.png';
  // Cached images for grimoire (MagicBook1..4) mapped by element
  const magicBookImgs = {
    fire: new Image(),
    ice: new Image(),
    lightning: new Image(),
    dark: new Image()
  };
  magicBookImgs.fire.src = 'image/MagicBook3.png';
  magicBookImgs.ice.src = 'image/MagicBook4.png';
  magicBookImgs.lightning.src = 'image/MagicBook1.png';
  magicBookImgs.dark.src = 'image/MagicBook2.png';

  // Cached image for attack boost pickup
  const swordImg = new Image(); swordImg.src = 'image/sword.png';

  // Cached image for sub-weapon sword effect
  const subSwordImg = new Image(); subSwordImg.src = 'image/sub-sword.png';

  // Cached image for energy converter facility
  const converterImg = new Image();
  converterImg.src = 'image/com.png';

  // Cached image for bombs
  const bombImg = new Image();
  bombImg.src = 'image/bom.png';

  // Cached image for bat projectiles
  const batImg = getImage('bat', 'image/bat.png');
  const supportBookImg = getImage('support-book', 'image/book.png');

  // Cached images for specific enemy types
  const shooterImg = getImage('enemy-shooter', 'image/shooter.png');
  const tankImg = getImage('enemy-tank', 'image/tank.png');
  const freezerImg = getImage('enemy-freezer', 'image/freezer.png');
  const bomberImg = getImage('enemy-bomber', 'image/bomber.png');
  const dasherImg = getImage('enemy-dasher', 'image/dasher.png');
  const zigImg = getImage('enemy-zig', 'image/zig.png');
  const barrageImg = getImage('enemy-barrage', 'image/barrage.png');
  const ignitionSuppressorImg = getImage('enemy-ignition-suppressor', 'image/ignitionSuppressor.png');

  // Cached images for bosses
  const CONVERTER_DRAW_SIZE = Math.max(12, 24 * 2) * 1.5;
  const MID_BOSS_DRAW_SIZE = CONVERTER_DRAW_SIZE * 1.5;
  const BOSS_DRAW_SIZE = CONVERTER_DRAW_SIZE * 3;
  const midBossImg = new Image(); midBossImg.src = 'image/MidBoss.png';
  const bossImg = new Image(); bossImg.src = 'image/Boss.png';
  const reaperImg = new Image(); reaperImg.src = 'image/reaper.png';
  const specialImg = new Image(); specialImg.src = 'image/special.png';
  const defaultEnemyImg = getImage('enemy', 'image/enemy.png');

  // Cached image for decoys
  const decoyImg = new Image();
  decoyImg.src = 'image/decoy.png';

  // Cached images for card orbs (1:銅 2:銀 3:金 4:虹)
  const cardOrbImgs = [null, new Image(), new Image(), new Image(), new Image()];
  cardOrbImgs[1].src = 'image/card-orb1.png';
  cardOrbImgs[2].src = 'image/card-orb2.png';
  cardOrbImgs[3].src = 'image/card-orb3.png';
  cardOrbImgs[4].src = 'image/card-orb4.png';

  // Cached images for character 'U' (facing sprites)
  const uImgs = {
    up: new Image(),    // 後ろ向き
    down: new Image(),  // 正面
    left: new Image(),
    right: new Image(),
  };
  uImgs.up.src = 'image/u-back.png';
  uImgs.down.src = 'image/u-top.png';
  uImgs.left.src = 'image/u-left.png';
  uImgs.right.src = 'image/u-right.png';

  // Cached images for other characters
  const charImgs = {};
  // Known simple aliases for characters -> used to try romaji/short filenames like `ando-back.png`
  const charFileAliases = {
    'あんどー': ['ando', 'あんどー'],
    'あたち': ['atc', 'あたち'],
    'おきーぱー': ['okipa', 'おきーぱー'],
    'ナタリア': ['nata', 'ナタリア'],
    'ハクシキ': ['haku', 'ハクシキ'],
    'メロ': ['mero', 'メロ'],
    'フルムーン': ['fullmoon', 'フルムーン'],
    '恋恋': ['koi', '恋恋'],
    'U': ['U', 'u']
  };

  // Helper: try a list of candidate urls by switching src onerror until one loads
  function loadImageWithFallback(img, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) return;
      img.onerror = () => { idx++; tryNext(); };
      img.onload = () => { img.onerror = null; };
      img.src = candidates[idx];
    };
    tryNext();
  }

  function buildCandidatesForName(name) {
    const baseEnc = 'image/' + encodeURIComponent(name) + '.png';
    const vals = (charFileAliases[name] || [name]).slice();
    // ensure unique and try alias.png then alias-facing variants
    const seen = new Set();
    const cand = [];
    // first try the encoded name (kana/utf8) which is the legacy behavior
    if (!seen.has(baseEnc)) { seen.add(baseEnc); cand.push(baseEnc); }
    for (const v of vals) {
      const normal = `image/${v}.png`;
      if (!seen.has(normal)) { seen.add(normal); cand.push(normal); }
    }
    return cand;
  }

  function getCharImg(name) {
    if (name === 'U') return uImgs.down;
    if (!charImgs[name]) {
      const img = new Image();
      const candidates = buildCandidatesForName(name);
      loadImageWithFallback(img, candidates);
      charImgs[name] = img;
    }
    return charImgs[name];
  }

  // Facing-aware loader: try to load alias-facing files like `ando-back.png` etc.
  const facingMap = { up: 'back', down: 'top', left: 'left', right: 'right' };
  const facingCache = {}; // key: name|facing -> Image
  function getFacingCharImg(name, facing) {
    if (name === 'U') return uImgs[facing] || uImgs.down;
    const key = `${name}|${facing}`;
    if (facingCache[key]) return facingCache[key];
    const dir = facingMap[facing] || facing;
    const aliases = charFileAliases[name] || [name];
    const candidates = [];
    // try encoded utf8 name + facing suffix first
    candidates.push('image/' + encodeURIComponent(name) + '-' + dir + '.png');
    for (const a of aliases) {
      candidates.push(`image/${a}-${dir}.png`);
    }
    // finally fall back to base candidates
    candidates.push(...buildCandidatesForName(name));
    const img = new Image();
    loadImageWithFallback(img, candidates);
    facingCache[key] = img;
    return img;
  }


  const defaultPerks = () => ({ hp: 0, hphalf: 0, spd: 0, atk: 0, boss: 0, cdr: 0, gain: 0, exp: 0, rez: 0, upglim: 0, sklim: 0, support: 0, ex: 0, dmgcut: 0 });
  const defaultEnergy = () => ({ tension: 50, sugar: 30, yeast: 10, cuteness: 30, brand: 15 });
  const DAMAGE_REDUCTION_UNLOCK_ACHIEVEMENT_ID = 'unlock-dmgcut';
  const DAMAGE_REDUCTION_LIMIT = 10;
  const DAMAGE_REDUCTION_KEY = 'dmgcut';
  const DAMAGE_REDUCTION_STEP = 0.99;
  // Mobile detection (robust):
  // - Avoid classifying Windows touch-enabled PCs as mobile just because they have touch points
  // - Handle iPadOS Safari which may report 'Macintosh' in UA but with touch points
  // - Fall back to coarse pointer on small screens
  const isMobile = (() => {
    const ua = navigator.userAgent || '';
    const touchPoints = (navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0);
    const hasCoarse = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
    const isAppleTablet = /iPad|Macintosh/i.test(ua) && touchPoints > 1; // iPadOS Safari case
    const isMobileUA = /Mobi|Android|iPhone|iPod/i.test(ua) || isAppleTablet; // note: 'iPad' covered via isAppleTablet
    const vw = (typeof window !== 'undefined' ? window.innerWidth : 0) || (typeof window !== 'undefined' && window.screen ? window.screen.width : 0) || 0;
    const vh = (typeof window !== 'undefined' ? window.innerHeight : 0) || (typeof window !== 'undefined' && window.screen ? window.screen.height : 0) || 0;
    const smallScreen = Math.min(vw, vh) < 820; // typical tablet/phone breakpoint
    // Treat as mobile if UA indicates mobile, or if coarse pointer AND small screen
    return isMobileUA || (hasCoarse && smallScreen);
  })();

  // App state
  const state = {
    me: null,
    room: null,
    sse: null,
    sseReconnecting: false,
    gold: 0,
    money: 0, // 永続マネー
    excludeTokens: 0, // 所持している除外数
    perks: defaultPerks(), // 購入済み個数
    limits: { hp: 5, hphalf: 1, spd: 5, atk: 15, boss: 3, cdr: 3, gain: 15, exp: 15, rez: 1, upglim: 1, sklim: 1, support: 2, ex: 1, dmgcut: 0 },
    stats: { hp: 100, atk: 10, maxHp: 100, exp: 0, lvl: 1, nextExp: 10, alive: true, elem: null, elemStage: 0, expRange: 80, armor: 0, maxArmor: 0, dmgTakenMul: 1, baseArmor: 0 },
    energyUnlocked: false,
    ignitionModeUnlocked: false,
    energy: defaultEnergy(),
    cheats: {},
    upgradeCounts: {},
    // レベルアップの保留数（多重レベルアップ時に順次表示）
    pendingLvls: 0,
    inGame: false,
    settings: { bgm: true, sfx: true, fps: false, ping: false, loadStats: false, damageNumbers: true, showCoordinates: false, volume: 0.5, bgmVolume: 0.5, sfxVolume: 0.5, cardSynergy: true },
    audio: { bgmEl: null, lastSfxAt: 0, lastHitAt: 0, sfxCtx: null, unlocked: false },
    camera: { x: 0, y: 0 },
    allies: {},
    hbTimer: null,
    pauseBy: new Set(),
    _pauseByTimes: new Map(),
    _pauseTokenStore: new Map(),
    _pauseTokenSeq: new Map(),
    _timeAlive: 0,
    _kills: 0,
    _raf: 0,
    _hasPersonalResult: false,
    _rezUsed: false,
    _deathAt: 0,
    spectating: false,
    _spectateTarget: null,
    _nextSpectateSwitch: 0,
    _pendingPersonalResult: null,
    _freezeTimeAlive: false,
    _enemyFreezeUntil: 0,
    _lastSelfResumeRequestAt: 0,
    _poisonDamageTaken: 0,
    _melonPanConsumed: 0,
    _runHpHalfActive: false,
    _reviveState: { targetId: null, progress: 0 },
    _revivePendingTarget: null,
    _pendingReviveApply: null,
    // server-authoritative time support
    serverGameStartAtSec: null, // epoch seconds from server
    _svtOffsetMs: 0,           // estimate of (serverNowMs - performance.now())
    _svtSmoothed: false,
    _lastResultReward: 0,
    _pickedMoney: 0,
    cardKeyHandler: null,
    // server-authoritative enemies
    serverSim: false,
    // [{id,type,x,y,r,hp?,maxHp?,boss?,name?,elem?}]
    // null/undefined: keep existing enemy list; []: clear enemy list
    svEnemiesRaw: [],
    svBulletsRaw: [], // [{id,type,x,y,vx,vy,r,ttl,dmg,arm}]
    svHazardsRaw: [], // [{type,x,y,r,ttl,dmg}]
    svItemsRaw: [],   // [{id,type,x,y,r,value}]
    _pendingEnemyDeads: [], // server-notified enemy deaths
    _riskAreaAckIndex: null,
    unlockedStages: [], // 永続ステージ開放
    stageClears: {}, // ステージクリア実績
    achievements: {},
    unlockedChars: [], // 永続キャラ開放
    cardShopUnlocked: false, // レシピカードショップ解禁
    subWeaponUnlocked: false, // サブウェポン解禁
    secondSubWeaponUnlocked: false, // セカンドサブウェポン解禁
    armorUnlocked: false, // アーマー解禁
    characterGrowthUnlocked: false, // キャラ成長解禁
    activeWeaponUnlocked: false, // アクティブウェポン解禁
    activeGauge: 0,
    _activeTtl: 0,
    _activeDur: 0,
    _activeReadyNotified: false,
    subWeapons: {}, // 所持サブウェポン
    selectedSubWeapon: null, // 装備中のサブウェポンID
    selectedSecondSubWeapon: null, // 装備中のセカンドサブウェポンID
    subWeaponRuntime: null, // 戦闘中のサブウェポン状態
    secondSubWeaponRuntime: null, // セカンドサブウェポンの戦闘状態
    cards: {}, // 所持カード
    cardUsageTotal: 0, // カードの累計使用回数
    cardEaterUsedThisBattle: false,
    shopPurchaseTotal: 0, // ショップ購入数の累計
    perkPurchaseHistory: {}, // 強化購入履歴（価格）
    unlockPurchasePrices: {}, // 解禁系購入価格
    deck: [], // 現在のデッキ
    activeCardEffects: [], // 発動中のカード効果
    cardOrbRareMul: 1, // 金・虹カードオーブ出現率倍率
    cardHealOnUse: 0,
    runExcludedLevelUps: new Set(),
    runExcludedCards: new Set(),
    characterGrowth: defaultCharacterGrowth(),
    timeSinceLastMelonPan: 0,
    isMobile,
    _characterXpRecord: null,
    _latestCharacterXpSummary: '',
    _resultStatsBaseText: '',
    _activeCharacterName: null,
  };

  let riskChoiceAreas = null;
  let riskEventEffect = null;
  let riskEventTriggered = false;
  let riskActivationPending = false;

  function ensurePauseMap() {
    if (!(state._pauseByTimes instanceof Map)) {
      state._pauseByTimes = new Map();
    }
    return state._pauseByTimes;
  }

  function ensurePauseAliasMap() {
    if (!(state._pauseAliasMap instanceof Map)) {
      state._pauseAliasMap = new Map();
    }
    return state._pauseAliasMap;
  }

  function ensureRunExcludedLevelUps() {
    if (!(state.runExcludedLevelUps instanceof Set)) {
      state.runExcludedLevelUps = new Set();
    }
    return state.runExcludedLevelUps;
  }

  function ensureRunExcludedCards() {
    if (!(state.runExcludedCards instanceof Set)) {
      state.runExcludedCards = new Set();
    }
    return state.runExcludedCards;
  }

  function ensurePauseTokenStore() {
    if (!(state._pauseTokenStore instanceof Map)) {
      state._pauseTokenStore = new Map();
    }
    return state._pauseTokenStore;
  }

  function ensurePauseTokenSeq() {
    if (!(state._pauseTokenSeq instanceof Map)) {
      state._pauseTokenSeq = new Map();
    }
    return state._pauseTokenSeq;
  }

  function normalizePauseTokenValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const intVal = Math.trunc(value);
      return intVal >= 0 ? intVal : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (!/^\d+$/.test(trimmed)) return null;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return null;
      const intVal = Math.trunc(parsed);
      return intVal >= 0 ? intVal : null;
    }
    return null;
  }

  function getPauseEntry(canonical, create = true) {
    const store = ensurePauseTokenStore();
    if (!store.has(canonical)) {
      if (!create) return null;
      store.set(canonical, { latestToken: null, activeToken: null, supportsTokens: false, lastResolvedToken: null });
    }
    const entry = store.get(canonical);
    if (entry && !Object.prototype.hasOwnProperty.call(entry, 'lastResolvedToken')) {
      entry.lastResolvedToken = null;
    }
    return entry;
  }

  function getKnownPauseToken(canonical) {
    const entry = ensurePauseTokenStore().get(canonical);
    if (!entry) return null;
    if (typeof entry.activeToken === 'number') return entry.activeToken;
    if (typeof entry.latestToken === 'number') return entry.latestToken;
    return null;
  }

  function allocatePauseTokenFor(canonical) {
    if (!canonical) return null;
    const seq = ensurePauseTokenSeq();
    const prev = seq.get(canonical);
    let next = (typeof prev === 'number' && Number.isFinite(prev)) ? prev + 1 : 1;
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
      next = 1;
    }
    seq.set(canonical, next);
    return next;
  }

  function resolvePauseId(pid, privateId) {
    const aliases = ensurePauseAliasMap();
    if (pid && aliases.has(pid)) return aliases.get(pid);
    if (pid) return pid;
    if (privateId && aliases.has(privateId)) return aliases.get(privateId);
    return privateId || pid || null;
  }

  function markPause(pid, privateId, token) {
    const canonical = pid || privateId;
    if (!canonical) return null;
    const normalizedToken = normalizePauseTokenValue(token);
    const entry = getPauseEntry(canonical);
    if (normalizedToken != null) {
      if (typeof entry.lastResolvedToken === 'number' && normalizedToken === entry.lastResolvedToken) {
        return null;
      }
      if (typeof entry.latestToken === 'number' && normalizedToken < entry.latestToken) {
        return null;
      }
      entry.latestToken = normalizedToken;
      entry.activeToken = normalizedToken;
      entry.supportsTokens = true;
      entry.lastResolvedToken = null;
    } else if (entry.supportsTokens) {
      return null;
    } else {
      entry.activeToken = null;
    }
    ensurePauseTokenStore().set(canonical, entry);
    state.pauseBy.add(canonical);
    try {
      ensurePauseMap().set(canonical, getNowMs());
      if (privateId && privateId !== canonical) {
        ensurePauseAliasMap().set(privateId, canonical);
      }
    } catch { }
    return { canonicalId: canonical, token: normalizedToken, supportsTokens: entry.supportsTokens };
  }

  function clearPause(pid, privateId, token) {
    const canonical = resolvePauseId(pid, privateId);
    if (!canonical) return null;
    const entry = getPauseEntry(canonical);
    let resolvedToken = token;
    if ((resolvedToken === undefined || resolvedToken === null) && entry.supportsTokens && typeof entry.activeToken === 'number') {
      resolvedToken = entry.activeToken;
    }
    const normalizedToken = normalizePauseTokenValue(resolvedToken);
    if (normalizedToken != null) {
      if (typeof entry.latestToken === 'number' && normalizedToken < entry.latestToken) {
        return null;
      }
      if (typeof entry.activeToken === 'number' && normalizedToken < entry.activeToken) {
        return null;
      }
      entry.latestToken = normalizedToken;
      entry.activeToken = null;
      entry.supportsTokens = true;
      entry.lastResolvedToken = normalizedToken;
    } else if (entry.supportsTokens) {
      return null;
    } else {
      entry.activeToken = null;
      entry.lastResolvedToken = null;
    }
    ensurePauseTokenStore().set(canonical, entry);
    state.pauseBy.delete(canonical);
    try {
      ensurePauseMap().delete(canonical);
      const aliases = ensurePauseAliasMap();
      if (privateId) aliases.delete(privateId);
      if (pid) aliases.delete(pid);
      for (const [key, value] of [...aliases.entries()]) {
        if (value === canonical) aliases.delete(key);
      }
    } catch { }
    return { canonicalId: canonical, token: normalizedToken, supportsTokens: entry.supportsTokens };
  }

  function cleanupPauseBy(nowMs) {
    if (!(state.pauseBy instanceof Set) || state.pauseBy.size === 0) return;
    const times = ensurePauseMap();
    const memberIds = new Set(
      (Array.isArray(state.room?.members) ? state.room.members : [])
        .map(m => m?.id)
        .filter(id => !!id)
    );
    for (const pid of [...state.pauseBy]) {
      if (!pid || pid === 'boss') continue;
      if (pid === state.me?.playerId) continue;
      if (pid === 'server') continue;
      if (memberIds.size > 0 && !memberIds.has(pid)) {
        state.pauseBy.delete(pid);
        times.delete(pid);
        try { ensurePauseTokenStore().delete(pid); } catch { }
        try {
          const aliases = ensurePauseAliasMap();
          for (const [key, value] of [...aliases.entries()]) {
            if (value === pid || key === pid) aliases.delete(key);
          }
        } catch { }
        continue;
      }
      const last = times.get(pid) || 0;
      if (last > 0 && nowMs - last > REMOTE_PAUSE_TIMEOUT_MS) {
        console.warn(`[pause] Removing stale pause from ${pid} after ${Math.round(nowMs - last)}ms`);
        state.pauseBy.delete(pid);
        times.delete(pid);
        try { ensurePauseTokenStore().delete(pid); } catch { }
      }
    }
  }

  function hasActiveLocalPauseUi() {
    if (levelUpModal && !levelUpModal.classList.contains('hidden')) return true;
    if (cardSelectModal && !cardSelectModal.classList.contains('hidden')) return true;
    if (converterModal && !converterModal.classList.contains('hidden')) return true;
    return false;
  }

  function requestSelfResume(tokenHint = null, reason = '') {
    const myId = state.me?.playerId;
    if (!myId) return false;
    const now = performance.now();
    const last = typeof state._lastSelfResumeRequestAt === 'number' ? state._lastSelfResumeRequestAt : 0;
    if (now - last < 750) return false;
    state._lastSelfResumeRequestAt = now;
    const payload = { type: 'resume' };
    const normalized = normalizePauseTokenValue(tokenHint);
    if (normalized != null) {
      payload.token = normalized;
    } else {
      const known = getKnownPauseToken(myId);
      if (known != null) payload.token = known;
    }
    if (reason) {
      try { console.warn(`[pause] Force-resume requested: ${reason}`); } catch { }
    }
    sendEvent(payload).catch(() => { });
    return true;
  }

  function resetPauseTracking() {
    try { state.pauseBy?.clear?.(); } catch { }
    try { state._pauseByTimes?.clear?.(); } catch { }
    try { state._pauseAliasMap?.clear?.(); } catch { }
    try { state._pauseTokenStore?.clear?.(); } catch { }
    try {
      if (state._pauseTokenSeq instanceof Map) {
        const myCanonicalId = state.me?.playerId || state.me?.privateId || null;
        if (myCanonicalId) {
          for (const key of [...state._pauseTokenSeq.keys()]) {
            if (key !== myCanonicalId) state._pauseTokenSeq.delete(key);
          }
        }
      }
    } catch { }
  }

  const IGNITION_HARD_OVERRIDES = {
    hpMul: 1.5,
    spawnMul: 2.0,
    bulletMul: 1.5,
    bulletDmgMul: 2.0,
  };
  const IGNITION_ON_STRINGS = ['on', 'true', 'enabled', 'active', '1', 'ignition'];
  const IGNITION_OFF_STRINGS = ['off', 'false', 'disabled', 'inactive', '0'];
  const IGNITION_OFF_HINTS = ['off', 'false', 'disable', 'inactive'];

  function coerceIgnitionValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (IGNITION_ON_STRINGS.includes(normalized)) return true;
      if (IGNITION_OFF_STRINGS.includes(normalized)) return false;
      if (normalized.startsWith('no ') || normalized.startsWith('no-')) return false;
      if (normalized.includes('ignition')) {
        if (IGNITION_OFF_HINTS.some(hint => normalized.includes(hint))) return false;
        return true;
      }
    }
    return null;
  }

  function collectionHasIgnition(collection) {
    if (!Array.isArray(collection)) return false;
    return collection.some(item => coerceIgnitionValue(item) === true);
  }

  function isIgnitionModeActive() {
    const room = state.room;
    if (!room) return false;
    const directCandidates = [
      room.ignitionMode,
      room.ignition,
      room.mode,
      room.options?.ignitionMode,
      room.options?.ignition,
      room.settings?.ignitionMode,
      room.settings?.ignition,
      room.flags?.ignitionMode,
      room.flags?.ignition,
    ];
    for (const candidate of directCandidates) {
      const result = coerceIgnitionValue(candidate);
      if (result != null) return result;
    }
    const arrayCandidates = [
      room.mods,
      room.modifiers,
      room.modes,
      room.options?.mods,
      room.flags,
    ];
    for (const collection of arrayCandidates) {
      if (collectionHasIgnition(collection)) return true;
    }
    return false;
  }

  function getDifficultyConfig(name) {
    const base = difficultyDefs[name];
    if (!base) return null;
    if (name === 'むずかしい' && isIgnitionModeActive()) {
      return { ...base, ...IGNITION_HARD_OVERRIDES };
    }
    return base;
  }

  function hasMelonPanEnergy() {
    if (!state.energyUnlocked) return false;
    const energy = state.energy || {};
    return ['tension', 'sugar', 'yeast', 'cuteness', 'brand']
      .some(type => (Number(energy[type]) || 0) > 0);
  }

  let rewardArea = null;

  addListener(window, 'service-unavailable', () => {
    if (state.pauseBy.has('server')) return;
    markPause('server');
    serverErrorModal?.classList?.remove('hidden');
    setTimeout(() => {
      serverErrorModal?.classList?.add('hidden');
      clearPause('server');
    }, 3000);
  });

  // addListener(window, 'server-error', () => {
  //   alert('サーバー内部でエラーが発生しました。ページをリロードしてください。');
  // });

  // stage unlock persistence (global)
  function loadStageUnlocks() {
    try {
      const raw = localStorage.getItem('vlg.unlockedStages');
      state.unlockedStages = raw ? JSON.parse(raw) : [];
    } catch { state.unlockedStages = []; }
  }
  function saveStageUnlocks() {
    try { localStorage.setItem('vlg.unlockedStages', JSON.stringify(state.unlockedStages)); } catch { }
  }
  loadStageUnlocks();

  // stage clear achievements persistence (global)
  function loadStageClears() {
    try {
      const raw = localStorage.getItem('vlg.stageClears');
      const parsed = raw ? JSON.parse(raw) : {};
      state.stageClears = normalizeStageClearsState(parsed);
    } catch { state.stageClears = {}; }
    updateDamageReductionLimit();
  }
  function saveStageClears() {
    try { localStorage.setItem('vlg.stageClears', JSON.stringify(state.stageClears)); } catch { }
  }
  loadStageClears();

  // achievements persistence (global)
  function loadAchievements() {
    try {
      const raw = localStorage.getItem('vlg.achievements');
      if (raw) {
        const parsed = JSON.parse(raw);
        state.achievements = (parsed && typeof parsed === 'object') ? parsed : {};
      } else {
        state.achievements = {};
      }
    } catch { state.achievements = {}; }
  }
  function saveAchievements() {
    try { localStorage.setItem('vlg.achievements', JSON.stringify(state.achievements || {})); } catch { }
  }
  loadAchievements();
  updateAchievementCountAchievements();
  updateHardClearAchievements();
  updateDamageReductionLimit();
  refreshStageClearAchievementsFromStorage();
  refreshIgnitionClearAchievementsFromStorage();

  function isAchievementUnlocked(id) {
    if (!id) return false;
    if (!state.achievements || typeof state.achievements !== 'object') return false;
    const value = state.achievements[id];
    return value === true || typeof value === 'number' || typeof value === 'string';
  }

  function countUnlockedAchievements() {
    if (!achievementDefs.length) return 0;
    let total = 0;
    for (const def of achievementDefs) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) total++;
    }
    return total;
  }

  function updateGalleryPreview(item) {
    if (!galleryPreviewTitle || !galleryPreviewImage) return;
    if (!item) {
      galleryPreviewTitle.textContent = 'イラスト未選択';
      galleryPreviewImage.src = '';
      galleryPreviewImage.alt = '';
      galleryPreviewImage.classList.add('hidden');
      return;
    }
    const previewLabel = item.title || item.filename || '';
    galleryPreviewTitle.textContent = previewLabel;
    galleryPreviewImage.src = item.src;
    galleryPreviewImage.alt = previewLabel;
    galleryPreviewImage.classList.remove('hidden');
  }

  function selectGalleryItem(id) {
    if (!galleryGrid) return;
    const item = id ? galleryItemMap.get(id) : null;
    const tiles = galleryGrid.querySelectorAll('.gallery-tile');
    tiles.forEach(tile => {
      const match = tile?.dataset?.id === (item?.id || '');
      if (match) tile.classList.add('selected');
      else tile.classList.remove('selected');
    });
    if (item) {
      galleryState.selectedId = item.id;
      updateGalleryPreview(item);
    } else {
      galleryState.selectedId = null;
      updateGalleryPreview(null);
    }
  }

  function buildGalleryGrid() {
    if (!galleryGrid) return;
    galleryGrid.innerHTML = '';
    if (!galleryItems.length) {
      const empty = document.createElement('p');
      empty.className = 'gallery-empty';
      empty.textContent = '閲覧できるイラストがありません。';
      galleryGrid.appendChild(empty);
      galleryState.selectedId = null;
      updateGalleryPreview(null);
      return;
    }
    for (const item of galleryItems) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'gallery-tile';
      tile.dataset.id = item.id;
      tile.title = item.filename || item.title || '';
      const img = document.createElement('img');
      img.src = item.thumb;
      img.alt = `${item.title}のサムネイル`;
      const titleLabel = document.createElement('div');
      titleLabel.className = 'gallery-tile-title';
      titleLabel.textContent = item.title;
      tile.appendChild(img);
      tile.appendChild(titleLabel);
      addListener(tile, 'click', () => {
        selectGalleryItem(item.id);
      });
      galleryGrid.appendChild(tile);
    }
    if (!galleryState.selectedId || !galleryItemMap.has(galleryState.selectedId)) {
      galleryState.selectedId = galleryItems[0].id;
    }
    selectGalleryItem(galleryState.selectedId);
  }

  function closeGalleryModal() {
    if (!galleryModal) return;
    if (galleryModal.classList.contains('hidden')) return;
    try { Audio?.playSfx?.(state, 'close'); } catch { }
    galleryModal.classList.add('hidden');
  }

  function openGalleryModal() {
    if (!galleryModal) return;
    if (!galleryModal.classList.contains('hidden')) return;
    if (countUnlockedAchievements() < 5) return;
    buildGalleryGrid();
    try { Audio?.playSfx?.(state, 'open'); } catch { }
    galleryModal.classList.remove('hidden');
  }

  function updateGalleryUnlock(totalUnlocked) {
    const unlocked = Number.isFinite(totalUnlocked) ? totalUnlocked : countUnlockedAchievements();
    const shouldShow = unlocked >= 5;
    if (!roomGalleryBtn) return;
    if (shouldShow) {
      roomGalleryBtn.classList.remove('hidden');
    } else {
      roomGalleryBtn.classList.add('hidden');
      closeGalleryModal();
    }
  }

  function replaceGalleryItems(rawItems) {
    const previousSelected = galleryState.selectedId;
    const firstId = populateGalleryCollections(rawItems);
    if (previousSelected && galleryItemMap.has(previousSelected)) {
      galleryState.selectedId = previousSelected;
    } else {
      galleryState.selectedId = firstId;
    }
    if (!galleryItems.length) {
      galleryState.selectedId = null;
    }
    if (galleryGrid) {
      buildGalleryGrid();
    }
    updateGalleryUnlock();
  }

  if (typeof window !== 'undefined') {
    window.vlg = window.vlg || {};
    window.vlg.updateGalleryItems = replaceGalleryItems;
  }

  function updateAchievementCountAchievements() {
    if (!achievementCountAchievements.length) return;
    if (checkingAchievementCounts) return;
    checkingAchievementCounts = true;
    try {
      const unlocked = countUnlockedAchievements();
      for (const def of achievementCountAchievements) {
        if (!def?.id) continue;
        if (isAchievementUnlocked(def.id)) continue;
        if (unlocked >= def.count) {
          unlockAchievement(def.id);
        }
      }
    } finally {
      checkingAchievementCounts = false;
    }
  }

  function updateHardClearAchievements() {
    if (!hardClearCountAchievements.length) return;
    const clears = countHardClears();
    for (const def of hardClearCountAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      if (clears >= def.count) {
        unlockAchievement(def.id);
      }
    }
  }

  function updateCardUsageAchievements() {
    if (!cardUsageAchievements.length) return;
    const totalUses = Number.isFinite(state.cardUsageTotal) ? state.cardUsageTotal : 0;
    for (const def of cardUsageAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      if (totalUses >= def.count) {
        unlockAchievement(def.id);
      }
    }
  }

  function updateShopPurchaseAchievements() {
    if (!shopPurchaseAchievements.length) return;
    const total = Number.isFinite(state.shopPurchaseTotal) ? state.shopPurchaseTotal : 0;
    for (const def of shopPurchaseAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const required = Number.isFinite(def.count) ? def.count : Infinity;
      if (total >= required) {
        unlockAchievement(def.id);
      }
    }
  }

  function checkStageClearAchievements(stageName, difficultyName) {
    if (!stageClearAchievements.length) return;
    const actualStage = stageName || '';
    const actualDiff = difficultyName || 'かんたん';
    for (const def of stageClearAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      if (requiredStage && actualStage !== requiredStage) continue;
      const minDiff = def.difficulty;
      if (minDiff && !difficultyAtLeast(actualDiff, minDiff)) continue;
      unlockAchievement(def.id);
    }
  }

  function refreshStageClearAchievementsFromStorage() {
    if (!stageClearAchievements.length) return;
    for (const def of stageClearAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      const minDiff = def.difficulty;
      if (!requiredStage) continue;
      const clears = state.stageClears?.[requiredStage];
      if (!clears || typeof clears !== 'object') continue;
      const cleared = Object.entries(clears).some(([diff, value]) => {
        if (!value) return false;
        if (minDiff) return difficultyAtLeast(diff, minDiff);
        return true;
      });
      if (cleared) {
        unlockAchievement(def.id);
      }
    }
  }

  function checkIgnitionClearAchievements(stageName, difficultyName, ignitionCleared) {
    if (!ignitionClearAchievements.length) return;
    if (!ignitionCleared) return;
    const actualStage = stageName || '';
    const actualDiff = difficultyName || 'むずかしい';
    for (const def of ignitionClearAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      if (requiredStage && actualStage !== requiredStage) continue;
      const minDiff = def.difficulty || 'むずかしい';
      if (minDiff && !difficultyAtLeast(actualDiff, minDiff)) continue;
      unlockAchievement(def.id);
    }
  }

  function refreshIgnitionClearAchievementsFromStorage() {
    if (!ignitionClearAchievements.length) return;
    const clears = state.stageClears || {};
    for (const def of ignitionClearAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      const minDiff = def.difficulty || 'むずかしい';
      const stageEntries = requiredStage
        ? [[requiredStage, clears?.[requiredStage]]]
        : Object.entries(clears);
      let matched = false;
      for (const [stageName, diffs] of stageEntries) {
        if (!diffs || typeof diffs !== 'object') continue;
        for (const [diff, value] of Object.entries(diffs)) {
          if (minDiff && !difficultyAtLeast(diff, minDiff)) continue;
          const entry = normalizeStageClearValue(value);
          if (entry.ignition) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (matched) {
        unlockAchievement(def.id);
      }
    }
  }

  function checkPoisonDamageAchievements(stageName, difficultyName) {
    if (!poisonDamageAchievements.length) return;
    const actualStage = stageName || '';
    const actualDiff = difficultyName || 'ふつう';
    const taken = Number.isFinite(state._poisonDamageTaken) ? state._poisonDamageTaken : 0;
    for (const def of poisonDamageAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      const minDiff = def.difficulty || 'ふつう';
      const requiredDamage = Number.isFinite(def.damage) ? def.damage : Infinity;
      if (requiredStage && actualStage !== requiredStage) continue;
      if (!difficultyAtLeast(actualDiff, minDiff)) continue;
      if (taken >= requiredDamage) {
        unlockAchievement(def.id);
      }
    }
  }

  function recordMelonPanConsumption(amount = 1) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const prev = Number.isFinite(state._melonPanConsumed) ? state._melonPanConsumed : 0;
    state._melonPanConsumed = prev + amount;
  }

  function checkMelonPanAchievements() {
    if (!melonPanAchievements.length) return;
    const consumed = Number.isFinite(state._melonPanConsumed) ? state._melonPanConsumed : 0;
    for (const def of melonPanAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const required = Number.isFinite(def.count) ? def.count : Infinity;
      if (consumed >= required) {
        unlockAchievement(def.id);
      }
    }
  }

  function checkHpHalfHardAchievements(stageName, difficultyName) {
    if (!hpHalfHardAchievements.length) return;
    if (!state._runHpHalfActive) return;
    const actualStage = stageName || '';
    const actualDiff = difficultyName || 'ふつう';
    for (const def of hpHalfHardAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      const requiredStage = def.stage || '';
      const minDiff = def.difficulty || 'むずかしい';
      if (requiredStage && actualStage !== requiredStage) continue;
      if (!difficultyAtLeast(actualDiff, minDiff)) continue;
      unlockAchievement(def.id);
    }
  }

  function rebuildAchievementList() {
    if (!achievementsList) return;
    achievementsList.innerHTML = '';
    if (!achievementDefs.length) {
      const empty = document.createElement('p');
      empty.className = 'achievement-empty';
      empty.textContent = '実績はまだ登録されていません。';
      achievementsList.appendChild(empty);
      updateGalleryUnlock(0);
      return;
    }
    const total = achievementDefs.length;
    let unlocked = 0;
    for (const def of achievementDefs) {
      if (def?.id && isAchievementUnlocked(def.id)) unlocked++;
    }
    updateGalleryUnlock(unlocked);
    const summary = document.createElement('div');
    summary.className = 'achievement-summary';
    summary.textContent = `達成状況: ${unlocked}/${total}`;
    achievementsList.appendChild(summary);
    for (const def of achievementDefs) {
      if (!def) continue;
      const unlockedNow = def.id ? isAchievementUnlocked(def.id) : false;
      const item = document.createElement('div');
      item.className = 'achievement-item';
      const header = document.createElement('div');
      header.className = 'achievement-header';
      const title = document.createElement('div');
      title.className = 'achievement-title';
      const no = Number.isFinite(def.no) ? def.no : '?';
      const label = def.name || def.id || '名称未設定';
      title.textContent = `No.${no} ${label}`;
      const status = document.createElement('span');
      status.className = `badge ${unlockedNow ? 'achievement-done' : 'achievement-pending'}`;
      status.textContent = unlockedNow ? '済' : '未';
      header.appendChild(title);
      header.appendChild(status);
      item.appendChild(header);
      if (def.description) {
        const desc = document.createElement('div');
        desc.className = 'achievement-desc';
        desc.textContent = def.description;
        item.appendChild(desc);
      }
      achievementsList.appendChild(item);
    }
  }

  function unlockAchievement(id) {
    if (!id || !achievementMap.has(id)) return;
    if (!state.achievements || typeof state.achievements !== 'object') {
      state.achievements = {};
    }
    if (isAchievementUnlocked(id)) return;
    state.achievements[id] = Date.now();
    saveAchievements();
    rebuildAchievementList();
    const def = achievementMap.get(id);
    const label = def?.name || def?.id || '新しい実績';
    try { Audio?.playSfx?.(state, 'ok'); } catch { }
    showToast(`実績「${label}」を達成しました！`);
    updateDamageReductionLimit();
    updateAchievementCountAchievements();
  }

  function updateAchievementProgress(seconds) {
    if (!Number.isFinite(seconds)) return;
    if (!state.inGame) return;
    if (!state.stats?.alive) return;
    if (!survivalAchievements.length) return;
    for (const def of survivalAchievements) {
      if (!def?.id) continue;
      if (isAchievementUnlocked(def.id)) continue;
      if (seconds >= def.seconds) {
        unlockAchievement(def.id);
      }
    }
  }

  rebuildAchievementList();

  // character unlock persistence (global)
  function loadCharUnlocks() {
    try {
      const raw = localStorage.getItem('vlg.unlockedChars');
      state.unlockedChars = raw ? JSON.parse(raw) : [];
    } catch { state.unlockedChars = []; }
  }
  function saveCharUnlocks() {
    try { localStorage.setItem('vlg.unlockedChars', JSON.stringify(state.unlockedChars)); } catch { }
  }
  loadCharUnlocks();

  // card shop unlock persistence (global)
  function loadCardShopUnlock() {
    try {
      state.cardShopUnlocked = localStorage.getItem('vlg.cardShopUnlocked') === '1';
    } catch { state.cardShopUnlocked = false; }
  }
  function saveCardShopUnlock() {
    try { localStorage.setItem('vlg.cardShopUnlocked', state.cardShopUnlocked ? '1' : '0'); } catch { }
  }
  loadCardShopUnlock();

  // sub weapon unlock persistence (global)
  function loadSubWeaponUnlock() {
    try {
      state.subWeaponUnlocked = localStorage.getItem('vlg.subWeaponUnlocked') === '1';
    } catch { state.subWeaponUnlocked = false; }
  }
  function saveSubWeaponUnlock() {
    try { localStorage.setItem('vlg.subWeaponUnlocked', state.subWeaponUnlocked ? '1' : '0'); } catch { }
  }
  loadSubWeaponUnlock();

  function loadSecondSubWeaponUnlock() {
    try {
      state.secondSubWeaponUnlocked = localStorage.getItem('vlg.secondSubWeaponUnlocked') === '1';
    } catch { state.secondSubWeaponUnlocked = false; }
  }
  function saveSecondSubWeaponUnlock() {
    try { localStorage.setItem('vlg.secondSubWeaponUnlocked', state.secondSubWeaponUnlocked ? '1' : '0'); } catch { }
  }
  loadSecondSubWeaponUnlock();

  // armor unlock persistence (global)
  function loadArmorUnlock() {
    try {
      state.armorUnlocked = localStorage.getItem('vlg.armorUnlocked') === '1';
    } catch { state.armorUnlocked = false; }
  }
  function saveArmorUnlock() {
    try { localStorage.setItem('vlg.armorUnlocked', state.armorUnlocked ? '1' : '0'); } catch { }
  }
  loadArmorUnlock();

  function normalizeStoredPrice(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const normalized = Math.floor(num);
    if (!Number.isFinite(normalized)) return null;
    return normalized < 0 ? 0 : normalized;
  }

  function ensureUnlockPurchasePrices() {
    if (!state.unlockPurchasePrices || typeof state.unlockPurchasePrices !== 'object') {
      state.unlockPurchasePrices = {};
    }
    return state.unlockPurchasePrices;
  }

  function loadUnlockPurchasePrices() {
    const store = {};
    try {
      const raw = localStorage.getItem('vlg.unlockPurchasePrices');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            const normalized = normalizeStoredPrice(value);
            if (normalized !== null) store[key] = normalized;
          }
        }
      }
    } catch {
      // ignore and fallback to empty store
    }
    state.unlockPurchasePrices = store;
  }

  function saveUnlockPurchasePrices() {
    const current = ensureUnlockPurchasePrices();
    const normalized = {};
    for (const [key, value] of Object.entries(current)) {
      const price = normalizeStoredPrice(value);
      if (price !== null) normalized[key] = price;
    }
    state.unlockPurchasePrices = normalized;
    try { localStorage.setItem('vlg.unlockPurchasePrices', JSON.stringify(normalized)); } catch { }
  }

  function recordUnlockPurchasePrice(id, price) {
    const normalized = normalizeStoredPrice(price);
    const store = ensureUnlockPurchasePrices();
    if (normalized === null) {
      delete store[id];
    } else {
      store[id] = normalized;
    }
    saveUnlockPurchasePrices();
  }

  function consumeUnlockRefundPrice(id, fallback) {
    const store = ensureUnlockPurchasePrices();
    const stored = normalizeStoredPrice(store?.[id]);
    if (stored !== null) {
      delete store[id];
      saveUnlockPurchasePrices();
      return stored;
    }
    return fallback;
  }

  loadUnlockPurchasePrices();

  function ensureCharacterGrowthEntry(name) {
    if (!state.characterGrowth || typeof state.characterGrowth !== 'object') {
      state.characterGrowth = defaultCharacterGrowth();
    }
    const key = normalizeCharacterSelection(name);
    if (key && !state.characterGrowth[key]) {
      state.characterGrowth[key] = { level: 1, exp: 0 };
    }
    const entry = key ? state.characterGrowth[key] : { level: 1, exp: 0 };
    let level = Number.isFinite(entry?.level) ? Math.floor(entry.level) : 1;
    if (level < 1) level = 1;
    if (level > MAX_CHARACTER_LEVEL) level = MAX_CHARACTER_LEVEL;
    let exp = Number.isFinite(entry?.exp) ? Math.floor(entry.exp) : 0;
    if (exp < 0) exp = 0;
    const cap = level >= MAX_CHARACTER_LEVEL ? 0 : characterExpToNext(level);
    if (cap > 0 && exp >= cap) exp = cap - 1;
    if (key) {
      entry.level = level;
      entry.exp = exp;
      return entry;
    }
    return { level, exp };
  }

  function getCharacterGrowthDetails(name) {
    const entry = ensureCharacterGrowthEntry(name);
    const level = entry.level;
    const exp = entry.exp;
    const nextExp = level >= MAX_CHARACTER_LEVEL ? 0 : characterExpToNext(level);
    const hpMul = computeGrowthMultiplier(level, CHARACTER_HP_MAX_MUL);
    const spdMul = computeGrowthMultiplier(level, CHARACTER_SPD_MAX_MUL);
    const armorMul = computeGrowthMultiplier(level, CHARACTER_ARMOR_MAX_MUL);
    return { entry, level, exp, nextExp, hpMul, spdMul, armorMul };
  }

  function loadCharacterGrowth() {
    state.characterGrowth = defaultCharacterGrowth();
    try {
      const raw = localStorage.getItem(CHARACTER_GROWTH_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          for (const [name, value] of Object.entries(obj)) {
            if (!value || typeof value !== 'object') continue;
            const level = Number.isFinite(value.level) ? Math.floor(value.level) : 1;
            const exp = Number.isFinite(value.exp) ? Math.floor(value.exp) : 0;
            state.characterGrowth[name] = { level, exp };
          }
        }
      }
    } catch {
      state.characterGrowth = defaultCharacterGrowth();
    }
    for (const name of characters) ensureCharacterGrowthEntry(name);
  }

  function saveCharacterGrowth() {
    try { localStorage.setItem(CHARACTER_GROWTH_STORAGE_KEY, JSON.stringify(state.characterGrowth)); } catch { }
  }

  function loadCharacterGrowthUnlock() {
    try {
      state.characterGrowthUnlocked = localStorage.getItem(CHARACTER_GROWTH_UNLOCK_KEY) === '1';
    } catch {
      state.characterGrowthUnlocked = false;
    }
  }

  function saveCharacterGrowthUnlock() {
    try { localStorage.setItem(CHARACTER_GROWTH_UNLOCK_KEY, state.characterGrowthUnlocked ? '1' : '0'); } catch { }
  }

  function applyCharacterExperience(name, amount) {
    if (!name || !Number.isFinite(amount) || amount <= 0) return null;
    const entry = ensureCharacterGrowthEntry(name);
    let remaining = Math.floor(amount);
    if (remaining <= 0) return null;
    const prevLevel = entry.level;
    let level = entry.level;
    let exp = entry.exp;
    while (remaining > 0 && level < MAX_CHARACTER_LEVEL) {
      const need = characterExpToNext(level) - exp;
      if (remaining >= need) {
        remaining -= need;
        level += 1;
        exp = 0;
      } else {
        exp += remaining;
        remaining = 0;
      }
    }
    const appliedXp = Math.floor(amount) - remaining;
    if (level >= MAX_CHARACTER_LEVEL) {
      exp = 0;
    }
    entry.level = level;
    entry.exp = exp;
    saveCharacterGrowth();
    return {
      appliedXp,
      prevLevel,
      newLevel: level,
      gainedLevels: Math.max(0, level - prevLevel),
      currentExp: exp,
      nextExp: level >= MAX_CHARACTER_LEVEL ? 0 : characterExpToNext(level),
    };
  }

  loadCharacterGrowthUnlock();
  loadCharacterGrowth();

  // active weapon unlock persistence (global)
  function loadActiveWeaponUnlock() {
    try {
      state.activeWeaponUnlocked = localStorage.getItem('vlg.activeWeaponUnlocked') === '1';
    } catch { state.activeWeaponUnlocked = false; }
  }
  function saveActiveWeaponUnlock() {
    try { localStorage.setItem('vlg.activeWeaponUnlocked', state.activeWeaponUnlocked ? '1' : '0'); } catch { }
  }
  loadActiveWeaponUnlock();

  // melon energy system unlock persistence (global)
  function loadEnergyUnlock() {
    try {
      state.energyUnlocked = localStorage.getItem('vlg.energyUnlocked') === '1';
    } catch { state.energyUnlocked = false; }
    state.energy = defaultEnergy();
  }
  function saveEnergyUnlock() {
    try { localStorage.setItem('vlg.energyUnlocked', state.energyUnlocked ? '1' : '0'); } catch { }
  }
  loadEnergyUnlock();

  // ignition mode unlock persistence (global)
  function loadIgnitionModeUnlock() {
    try {
      state.ignitionModeUnlocked = localStorage.getItem('vlg.ignitionModeUnlocked') === '1';
    } catch { state.ignitionModeUnlocked = false; }
  }
  function saveIgnitionModeUnlock() {
    try { localStorage.setItem('vlg.ignitionModeUnlocked', state.ignitionModeUnlocked ? '1' : '0'); } catch { }
  }
  loadIgnitionModeUnlock();

  // card inventory persistence (global)
  function loadCards() {
    try {
      const raw = localStorage.getItem('vlg.cards');
      state.cards = raw ? JSON.parse(raw) : {};
    } catch { state.cards = {}; }
  }
  function saveCards() {
    try { localStorage.setItem('vlg.cards', JSON.stringify(state.cards)); } catch { }
  }
  loadCards();

  // card usage persistence (global)
  function loadCardUsageStats() {
    let stored = 0;
    try {
      const raw = localStorage.getItem('vlg.cardUsageTotal');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'number') {
          stored = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const value = parsed.totalUses ?? parsed.total ?? parsed.count;
          if (Number.isFinite(value)) stored = value;
        }
      }
    } catch {
      stored = 0;
    }
    if (!Number.isFinite(stored) || stored < 0) stored = 0;
    state.cardUsageTotal = Math.floor(stored);
  }
  function saveCardUsageStats() {
    const current = Number.isFinite(state.cardUsageTotal) ? state.cardUsageTotal : 0;
    const normalized = Math.max(0, Math.floor(current));
    state.cardUsageTotal = normalized;
    try { localStorage.setItem('vlg.cardUsageTotal', JSON.stringify(normalized)); } catch { }
  }
  function recordCardUsage() {
    const current = Number.isFinite(state.cardUsageTotal) ? state.cardUsageTotal : 0;
    state.cardUsageTotal = current + 1;
    saveCardUsageStats();
    updateCardUsageAchievements();
  }
  loadCardUsageStats();
  updateCardUsageAchievements();

  // shop purchase persistence (global)
  function loadShopPurchaseStats() {
    let stored = 0;
    try {
      const raw = localStorage.getItem('vlg.shopPurchaseTotal');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'number') {
          stored = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const value = parsed.totalPurchases ?? parsed.total ?? parsed.count;
          if (Number.isFinite(value)) stored = value;
        }
      }
    } catch {
      stored = 0;
    }
    if (!Number.isFinite(stored) || stored < 0) stored = 0;
    state.shopPurchaseTotal = Math.floor(stored);
  }
  function saveShopPurchaseStats() {
    const current = Number.isFinite(state.shopPurchaseTotal) ? state.shopPurchaseTotal : 0;
    const normalized = Math.max(0, Math.floor(current));
    state.shopPurchaseTotal = normalized;
    try { localStorage.setItem('vlg.shopPurchaseTotal', JSON.stringify(normalized)); } catch { }
  }
  function recordShopPurchase() {
    const current = Number.isFinite(state.shopPurchaseTotal) ? state.shopPurchaseTotal : 0;
    state.shopPurchaseTotal = current + 1;
    saveShopPurchaseStats();
    updateShopPurchaseAchievements();
  }
  loadShopPurchaseStats();
  updateShopPurchaseAchievements();

  // sub weapon inventory persistence (global)
  function loadSubWeapons() {
    const owned = {};
    try {
      const raw = localStorage.getItem('vlg.subWeapons');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [id, value] of Object.entries(parsed)) {
            if (value && subWeaponMap.has(id)) owned[id] = true;
          }
        }
      }
    } catch {
      // ignore and fall back to empty inventory
    }
    state.subWeapons = owned;
  }
  function saveSubWeapons() {
    try { localStorage.setItem('vlg.subWeapons', JSON.stringify(state.subWeapons || {})); } catch { }
  }
  loadSubWeapons();

  function loadSelectedSubWeapon() {
    let stored = null;
    try {
      const raw = localStorage.getItem('vlg.selectedSubWeapon');
      if (typeof raw === 'string' && raw) stored = raw;
    } catch {
      stored = null;
    }
    if (stored && !state.subWeapons?.[stored]) stored = null;
    state.selectedSubWeapon = stored;
  }
  function saveSelectedSubWeapon() {
    try {
      if (state.selectedSubWeapon) {
        localStorage.setItem('vlg.selectedSubWeapon', state.selectedSubWeapon);
      } else {
        localStorage.removeItem('vlg.selectedSubWeapon');
      }
    } catch { }
  }
  function setSelectedSubWeapon(id) {
    const normalized = (typeof id === 'string' && id) ? id : null;
    const newValue = normalized && state.subWeapons?.[normalized] ? normalized : null;
    if (state.selectedSubWeapon === newValue) return;
    state.selectedSubWeapon = newValue;
    saveSelectedSubWeapon();
    if (!state.selectedSubWeapon || state.selectedSecondSubWeapon === state.selectedSubWeapon) {
      setSelectedSecondSubWeapon(null);
    }
  }
  loadSelectedSubWeapon();

  function loadSelectedSecondSubWeapon() {
    let stored = null;
    try {
      const raw = localStorage.getItem('vlg.selectedSecondSubWeapon');
      if (typeof raw === 'string' && raw) stored = raw;
    } catch {
      stored = null;
    }
    if (!state.secondSubWeaponUnlocked || !state.subWeaponUnlocked || !state.selectedSubWeapon) stored = null;
    if (stored && stored === state.selectedSubWeapon) stored = null;
    if (stored && !state.subWeapons?.[stored]) stored = null;
    state.selectedSecondSubWeapon = stored;
  }
  function saveSelectedSecondSubWeapon() {
    try {
      if (state.selectedSecondSubWeapon) {
        localStorage.setItem('vlg.selectedSecondSubWeapon', state.selectedSecondSubWeapon);
      } else {
        localStorage.removeItem('vlg.selectedSecondSubWeapon');
      }
    } catch { }
  }
  function setSelectedSecondSubWeapon(id) {
    const normalized = (typeof id === 'string' && id) ? id : null;
    let newValue = normalized && state.subWeapons?.[normalized] ? normalized : null;
    if (!state.secondSubWeaponUnlocked || !state.subWeaponUnlocked || !state.selectedSubWeapon) newValue = null;
    if (newValue && newValue === state.selectedSubWeapon) newValue = null;
    if (state.selectedSecondSubWeapon === newValue) return;
    state.selectedSecondSubWeapon = newValue;
    saveSelectedSecondSubWeapon();
  }
  loadSelectedSecondSubWeapon();

  function awardRandomCard(rarity) {
    const candidates = cardDefs.filter(c => c.rarity === rarity && !state.cards[c.id]);
    const pool = candidates.length ? candidates : cardDefs.filter(c => c.rarity === rarity);
    if (!pool.length) return null;
    const card = pool[Math.floor(Math.random() * pool.length)];
    state.cards[card.id] = true;
    saveCards();
    return card;
  }

  // perk persistence (global)
  function loadPerks() {
    try {
      const raw = localStorage.getItem('vlg.perks');
      state.perks = raw ? { ...defaultPerks(), ...JSON.parse(raw) } : defaultPerks();
    } catch { state.perks = defaultPerks(); }
    applyPerkEffects();
  }
  function savePerks() {
    try { localStorage.setItem('vlg.perks', JSON.stringify(state.perks)); } catch { }
  }

  function ensurePerkPurchaseHistory() {
    if (!state.perkPurchaseHistory || typeof state.perkPurchaseHistory !== 'object') {
      state.perkPurchaseHistory = {};
    }
    return state.perkPurchaseHistory;
  }

  function loadPerkPurchaseHistory() {
    const history = {};
    try {
      const raw = localStorage.getItem('vlg.perkPurchaseHistory');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [key, values] of Object.entries(parsed)) {
            if (!Array.isArray(values)) continue;
            const cleaned = values
              .map(value => normalizeStoredPrice(value))
              .filter(value => value !== null);
            if (cleaned.length) history[key] = cleaned;
          }
        }
      }
    } catch {
      // ignore and fallback to empty history
    }
    state.perkPurchaseHistory = history;
  }

  function savePerkPurchaseHistory() {
    const current = ensurePerkPurchaseHistory();
    const normalized = {};
    for (const [key, values] of Object.entries(current)) {
      if (!Array.isArray(values) || !values.length) continue;
      const cleaned = values
        .map(value => normalizeStoredPrice(value))
        .filter(value => value !== null);
      if (cleaned.length) normalized[key] = cleaned;
    }
    state.perkPurchaseHistory = normalized;
    try { localStorage.setItem('vlg.perkPurchaseHistory', JSON.stringify(normalized)); } catch { }
  }

  function recordPerkPurchasePrice(key, price) {
    const normalized = normalizeStoredPrice(price);
    if (normalized === null) return;
    const history = ensurePerkPurchaseHistory();
    if (!Array.isArray(history[key])) history[key] = [];
    history[key].push(normalized);
    savePerkPurchaseHistory();
  }

  function popPerkPurchasePrice(key, fallback) {
    const history = ensurePerkPurchaseHistory();
    if (Array.isArray(history[key]) && history[key].length) {
      const price = normalizeStoredPrice(history[key].pop());
      savePerkPurchaseHistory();
      if (price !== null) return price;
    }
    return fallback;
  }

  function applyPerkEffects() {
    const p = state.perks || {};
    UPGRADE_LIMIT = BASE_UPGRADE_LIMIT + (p.upglim || 0) * 2;
    SKILL_LIMIT = BASE_SKILL_LIMIT + (p.sklim || 0) * 3;
    const baseHp = 100 + (p.hp || 0) * 12;
    const baseAtk = 10 + (p.atk || 0) * 2;
    const dmgTakenMul = Math.pow(DAMAGE_REDUCTION_STEP, p[DAMAGE_REDUCTION_KEY] || 0);
    state.stats = { hp: baseHp, atk: baseAtk, maxHp: baseHp, exp: 0, lvl: 1, nextExp: 10, alive: true, elem: null, elemStage: 0, expRange: 80, armor: 0, maxArmor: 0, dmgTakenMul, baseArmor: 0 };
    updateDamageReductionLimit();
    renderHudPerks();
    clampSupportMagicCounts();
  }
  loadPerks();
  loadPerkPurchaseHistory();

  // money persistence (localStorage) — global across rooms
  function loadMoney() {
    try {
      const raw = localStorage.getItem('vlg.money');
      if (raw) {
        const obj = JSON.parse(raw);
        state.money = (typeof obj.money === 'number') ? obj.money : 0;
      } else {
        state.money = 0;
      }
    } catch {
      state.money = 0;
    }
  }
  function saveMoney() {
    try {
      localStorage.setItem('vlg.money', JSON.stringify({ money: state.money }));
    } catch { }
  }

  function loadExcludeTokens() {
    let stored = 0;
    try {
      const raw = localStorage.getItem('vlg.excludeTokens');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed)) {
          stored = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const value = parsed.count ?? parsed.tokens ?? parsed.value;
          if (Number.isFinite(value)) stored = value;
        }
      }
    } catch {
      stored = 0;
    }
    if (!Number.isFinite(stored) || stored < 0) stored = 0;
    const normalized = Math.min(MAX_EXCLUDE_TOKENS, Math.floor(stored));
    state.excludeTokens = normalized;
  }

  function saveExcludeTokens() {
    const current = Number.isFinite(state.excludeTokens) ? state.excludeTokens : 0;
    const normalized = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, Math.floor(current)));
    state.excludeTokens = normalized;
    try { localStorage.setItem('vlg.excludeTokens', JSON.stringify(normalized)); } catch { }
  }
  function renderSubWeaponInventory() {
    if (!subWeaponRow) return;
    const ownedList = subWeaponDefs.filter(def => state.subWeapons?.[def.id]);
    if (!state.subWeaponUnlocked || !ownedList.length) {
      subWeaponRow.classList.add('hidden');
      if (subWeaponList) subWeaponList.innerHTML = '';
      if (secondSubWeaponList) secondSubWeaponList.innerHTML = '';
      if (secondSubWeaponSection) secondSubWeaponSection.classList.add('hidden');
      setSelectedSubWeapon(null);
      setSelectedSecondSubWeapon(null);
      return;
    }
    subWeaponRow.classList.remove('hidden');
    const ownedIds = new Set(ownedList.map(def => def.id));
    if (state.selectedSubWeapon && !ownedIds.has(state.selectedSubWeapon)) {
      setSelectedSubWeapon(null);
    }
    if (state.selectedSecondSubWeapon && !ownedIds.has(state.selectedSecondSubWeapon)) {
      setSelectedSecondSubWeapon(null);
    }
    const metaFormatter = (def) => `使用可能回数:${def.uses}回 - ${def.effect}`;
    renderSubWeaponList(subWeaponList, ownedList, {
      group: 'subWeaponChoice',
      selectedId: state.selectedSubWeapon,
      onSelect: (id) => { setSelectedSubWeapon(id); renderSubWeaponInventory(); },
      noneLabel: '装備なし',
      noneMeta: 'サブウェポンを装備しません',
      metaFormatter,
    });
    const canUseSecond = state.secondSubWeaponUnlocked && !!state.selectedSubWeapon;
    if (!canUseSecond) {
      if (secondSubWeaponSection) secondSubWeaponSection.classList.add('hidden');
      if (secondSubWeaponList) secondSubWeaponList.innerHTML = '';
      setSelectedSecondSubWeapon(null);
    } else {
      if (secondSubWeaponSection) secondSubWeaponSection.classList.remove('hidden');
      const secondOwnedList = ownedList.filter(def => def.id !== state.selectedSubWeapon);
      if (state.selectedSecondSubWeapon && state.selectedSecondSubWeapon === state.selectedSubWeapon) {
        setSelectedSecondSubWeapon(null);
      }
      renderSubWeaponList(secondSubWeaponList, secondOwnedList, {
        group: 'secondSubWeaponChoice',
        selectedId: state.selectedSecondSubWeapon,
        onSelect: (id) => { setSelectedSecondSubWeapon(id); renderSubWeaponInventory(); },
        noneLabel: '装備なし',
        noneMeta: 'セカンドサブウェポンを使用しません',
        metaFormatter,
      });
    }
    setSubWeaponSelectionDisabled(subWeaponSelectionDisabled);
  }

  function renderSubWeaponList(listEl, ownedList, options) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const { group, selectedId, onSelect, noneLabel, noneMeta, metaFormatter } = options;
    const entries = [null, ...ownedList];
    entries.forEach((def) => {
      const isNone = !def;
      const value = isNone ? '' : (def.id ?? '');
      const li = document.createElement('li');
      li.className = 'subweapon-item';
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = group;
      input.value = value;
      const isSelected = isNone ? !selectedId : selectedId === def.id;
      input.checked = isSelected;
      input.disabled = subWeaponSelectionDisabled;
      input.addEventListener('change', () => {
        onSelect(isNone ? null : def.id);
      });
      const content = document.createElement('div');
      const nameEl = document.createElement('span');
      nameEl.className = 'subweapon-name';
      nameEl.textContent = isNone ? noneLabel : def.name;
      const metaEl = document.createElement('span');
      metaEl.className = 'subweapon-meta';
      const metaText = isNone ? (noneMeta ?? '') : (metaFormatter ? metaFormatter(def) : '');
      metaEl.textContent = metaText;
      content.appendChild(nameEl);
      content.appendChild(metaEl);
      label.appendChild(input);
      label.appendChild(content);
      li.appendChild(label);
      if (isSelected) li.classList.add('selected');
      listEl.appendChild(li);
    });
  }

  function setSubWeaponSelectionDisabled(disabled) {
    subWeaponSelectionDisabled = !!disabled;
    [subWeaponList, secondSubWeaponList].forEach((list) => {
      if (!list) return;
      list.querySelectorAll('input[type="radio"]').forEach((input) => {
        input.disabled = subWeaponSelectionDisabled;
      });
    });
  }
  function resetRoomItems() {
    loadPerks();
    loadCards();
    loadSubWeapons();
    loadSelectedSubWeapon();
    loadSelectedSecondSubWeapon();
    // Reload money from storage in case state was cleared elsewhere
    loadMoney();
    loadExcludeTokens();
    state.energy = defaultEnergy();
    if (shopLog) shopLog.innerHTML = '';
    saveMoney();
    savePerks();
    saveCards();
    saveSubWeapons();
    saveSelectedSubWeapon();
    saveSelectedSecondSubWeapon();
    updateMoneyLabels();
    renderSubWeaponInventory();
  }
  function updateMoneyLabels() {
    if (moneyBalanceRoom) moneyBalanceRoom.textContent = String(state.money);
    if (moneyBalanceShop) moneyBalanceShop.textContent = String(state.money);
    if (moneyBalanceCardShop) moneyBalanceCardShop.textContent = String(state.money);
    if (moneyBalanceWeaponShop) moneyBalanceWeaponShop.textContent = String(state.money);
  }
  function updateCardShopVisibility() {
    if (btnOpenCardShop) {
      btnOpenCardShop.classList.toggle('hidden', !state.cardShopUnlocked);
    }
  }
  function isCardSynergyEnabled() {
    return state.settings?.cardSynergy !== false;
  }
  function updateCardSynergyUI() {
    const enabled = isCardSynergyEnabled();
    if (cardSynergyToggle) {
      cardSynergyToggle.checked = enabled;
    }
    if (cardSynergyHint) {
      cardSynergyHint.textContent = enabled
        ? '同属性カードの追加効果が発動します'
        : '同属性カードの追加効果は発動しません';
    }
  }
  function updateWeaponShopVisibility() {
    if (btnOpenWeaponShop) {
      btnOpenWeaponShop.classList.toggle('hidden', !state.subWeaponUnlocked && !state.secondSubWeaponUnlocked);
    }
  }
  // 起動時にマネーをロード
  loadMoney();
  loadExcludeTokens();
  updateMoneyLabels();
  updateCardShopVisibility();
  updateCardSynergyUI();
  updateWeaponShopVisibility();
  updateIgnitionControls();
  renderSubWeaponInventory();
  if (cardSynergyToggle) {
    addListener(cardSynergyToggle, 'change', (e) => {
      const enabled = !!e?.target?.checked;
      state.settings.cardSynergy = enabled;
      Settings?.saveSettings?.(state);
      updateCardSynergyUI();
      try { Audio?.playSfx?.(state, 'toggle'); } catch { }
      showToast(`シナジー効果を${enabled ? '有効' : '無効'}にしました`, 'info');
    });
  }
  // expose helpers for external modules
  state.resetRoomItems = resetRoomItems;
  state.updateCardShopVisibility = updateCardShopVisibility;
  state.updateWeaponShopVisibility = updateWeaponShopVisibility;
  state.updateIgnitionControls = updateIgnitionControls;
  state.rebuildCharacterOptions = rebuildCharacterOptions;
  state.updateCharacterInfo = updateCharacterInfo;

  function updateEnergy(dt, moving) {
    if (!state.energyUnlocked) return;
    if (!state?.stats?.alive) return;
    state.timeSinceLastMelonPan += dt;
    const e = state.energy;
    const yeastMul = 1 + (e.yeast - 10) * 0.002;
    const sugarMul = 1 + (e.sugar - 30) * 0.006;
    if (moving) {
      const dec = Math.max(0, (1.3 - sugarMul) * dt);
      e.tension = Math.max(0, e.tension - dec);
    } else {
      const brandMul = 0.00006 * e.brand * e.brand + 0.005 * e.brand + 0.6;
      const regen = (100 / 60) * yeastMul * sugarMul * brandMul * dt;
      e.tension = Math.min(100, e.tension + regen);
    }
    if (state.timeSinceLastMelonPan >= 60) {
      e.sugar = Math.max(0, e.sugar - (1 / 60) * dt);
    }
    e.yeast = Math.min(100, e.yeast + (50 / 60) * dt);
    const brandDecRate = e.tension >= 80 ? 1 / 30 : 1 / 15;
    e.brand = Math.max(0, e.brand - brandDecRate * dt);
    const armorMul = 0.006 * e.cuteness + 0.5;
    const baseArmor = state.stats.baseArmor || 0;
    state.stats.maxArmor = Math.round(baseArmor * armorMul);
    state.stats.armor = Math.min(state.stats.armor, state.stats.maxArmor);
  }

  // HUD chip helpers
  const hudChip = document.getElementById('hudChip');
  const hudChipImg = document.getElementById('hudChipImg');
  const hudChipCName = document.getElementById('hudChipCName');
  const hudChipPName = document.getElementById('hudChipPName');
  function setHudChip(characterName, playerName) {
    if (!hudChip) return;
    const playable = normalizeCharacterSelection(characterName);
    if (!playable) { hudChip.classList.add('hidden'); return; }
    hudChip.classList.remove('hidden');
    hudChipCName.textContent = playable;
    hudChipPName.textContent = playerName || '';
    if (hudChipImg) hudChipImg.src = 'image/' + encodeURIComponent(playable) + '.png';
  }
  function memberById(pid) { return state.room?.members.find(m => m.id === pid) || null; }

  function setScreen(name) {
    const screens = {
      lobby: screenLobby,
      room: screenRoom,
      game: screenGame,
      result: screenResult,
    };
    const target = screens[name];
    if (name !== 'game') {
      resetCoordinateHud();
    }
    // 非表示にする画面をフェードアウト
    for (const el of Object.values(screens)) {
      if (el === target) continue;
      if (!el.classList.contains('hidden')) {
        el.classList.add('fade');
        // Add a timeout fallback in case transitionend doesn't fire
        let transitionEnded = false;
        const cleanup = () => {
          if (transitionEnded) return;
          transitionEnded = true;
          el.classList.add('hidden');
          el.classList.remove('fade');
        };
        // Listen for transitionend on opacity only
        el.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'opacity') {
            cleanup();
          }
        }, { once: true });
        // Fallback timeout (e.g., 500ms)
        setTimeout(cleanup, 500);
      }
    }
    // 表示する画面をフェードイン
    if (target.classList.contains('hidden')) {
      target.classList.remove('hidden');
      target.classList.add('fade');
      // reflow を強制してトランジションを開始
      void target.offsetWidth;
      target.classList.remove('fade');
    }
    // 現在の画面名を保持（デバッグ/ガード用）
    state._screen = name;
    if (adSection) {
      adSection.classList.toggle('hidden', name !== 'lobby');
    }
    // 画面に応じてBGMを切り替え
    if (name === 'lobby') {
      try { Audio?.setBgmForStage?.(state, null); } catch { }
    } else if (name === 'room') {
      try { Audio?.setBgmForStage?.(state, state.room?.stage); } catch { }
    }
  }

  function showToast(msg, type = 'info', ms = 3500) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden', 'error');
    if (type === 'error') toastEl.classList.add('error');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function hideReviveGauge() {
    if (reviveGaugeWrap) reviveGaugeWrap.classList.add('hidden');
    if (reviveGaugeFill) reviveGaugeFill.style.width = '0%';
  }

  function updateReviveGauge(label, ratio) {
    if (!reviveGaugeWrap || !reviveGaugeFill) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    reviveGaugeWrap.classList.remove('hidden');
    if (reviveGaugeLabel) reviveGaugeLabel.textContent = label;
    reviveGaugeFill.style.width = `${clamped * 100}%`;
  }

  function resetReviveState() {
    state._reviveState = { targetId: null, progress: 0 };
    state._revivePendingTarget = null;
    state._pendingReviveApply = null;
    hideReviveGauge();
  }
  // Log detailed error to console for debugging
  // Attach a scoped handler for unhandled promise rejections so we can show a toast
  // while keeping the handler inside initApp where showToast and state are defined.
  addListener(window, 'unhandledrejection', (e) => {
    try { console.error('Unhandled rejection:', e.reason); } catch { }
    try { showToast('サーバーエラーが発生しました。しばらくしてから再度お試しください。', 'error', 5000); } catch { }
  });

  function clearActiveTimeouts() {
    const arr = state._activeTimeouts;
    if (!arr) return;
    for (const t of arr) {
      clearTimeout(t.id);
      try { t.revert?.(); } catch { }
    }
    arr.length = 0;
    state._activeTtl = 0;
  }

  // 戦闘終了時の一括クリーンアップ（安全に何度呼んでもOK）
  function cleanupBattle(reason = '') {
    if (reason !== 'personalResult') {
      state._runHpHalfActive = false;
    }
    resetCoordinateHud();
    try { if (state._raf) { clearTimeout(state._raf); state._raf = 0; } } catch { }
    try {
      state.inGame = false;
      state._hasPersonalResult = false;
      state._rezUsed = false;
      state._lastResultReward = 0;
      state._activeCharacterName = null;
      state.pendingLvls = 0;
      // reset exp/level flags in case of rematch
      state.stats.exp = 0;
      state.stats.lvl = 1;
      state.stats.nextExp = 10;
      // clear level-up modifiers carried over between games
      openLevelUp.rateMul = 1;
      openLevelUp.regen = 0;
      openLevelUp.supportBooks = 0;
      openLevelUp.supportLasers = 0;
      openLevelUp.supportBombs = 0;
      clampSupportMagicCounts = () => { };
      state.upgradeCounts = {};
      // clear run-specific card state (gold persists across battles)
      state.deck = [];
      state.activeCardEffects = [];
      state.cardHealOnUse = 0;
      ensureRunExcludedLevelUps().clear();
      ensureRunExcludedCards().clear();
      try { if (state.cardKeyHandler) window.removeEventListener('keydown', state.cardKeyHandler, true); } catch { }
      state.cardKeyHandler = null;
      // clear any pending level-up timers or handlers
      try { clearTimeout(openLevelUp.autoTimer); } catch { }
      try { clearInterval(openLevelUp.countdownTimer); } catch { }
      try { window.removeEventListener('keydown', openLevelUp.keyHandler, true); } catch { }
      openLevelUp.autoTimer = null;
      openLevelUp.countdownTimer = null;
      openLevelUp.keyHandler = null;
      // clear any pending personal result timer to avoid leftover cleanup
      try { clearTimeout(showPersonalResult._t); } catch { }
      showPersonalResult._t = 0;
    } catch { }
    try { clearActiveTimeouts(); } catch { }
    try { resetReviveState(); } catch { }
    try {
      const myId = state.me?.playerId;
      const hadLocalPause = !!(myId && state.pauseBy instanceof Set && state.pauseBy.has(myId));
      let resumePayload = null;
      if (hadLocalPause) {
        const info = clearPause(myId);
        if (info) {
          resumePayload = { type: 'resume' };
          if (info.token != null) resumePayload.token = info.token;
        }
      }
      if (resumePayload) {
        sendEvent(resumePayload).catch(() => { });
      } else if (hadLocalPause) {
        const fallbackPayload = { type: 'resume' };
        const fallbackToken = getKnownPauseToken(myId);
        if (fallbackToken != null) fallbackPayload.token = fallbackToken;
        sendEvent(fallbackPayload).catch(() => { });
      }
      resetPauseTracking();
    } catch { }
    try { window.__vlgClearPressed?.(); } catch { }
    // サーバー同期まわりの状態を初期化
    try { state.serverGameStartAtSec = null; state._svtSmoothed = false; state._svtOffsetMs = 0; } catch { }
    try { state.serverSim = false; state.svEnemiesRaw = []; state.svBulletsRaw = []; state.svHazardsRaw = []; state.svItemsRaw = []; } catch { }
    try {
      state.spectating = false;
      state._spectateTarget = null;
      state._nextSpectateSwitch = 0;
      state._pendingPersonalResult = null;
      state._freezeTimeAlive = false;
      state._enemyFreezeUntil = 0;
      if (reason !== 'personalResult') {
        state._poisonDamageTaken = 0;
        state._melonPanConsumed = 0;
      }
    } catch { }
    try { state.allies = {}; } catch { }
    // ダメージ数字やFXのDOMを掃除
    try { resetDamageNumberPool(); } catch {
      try { const cont = document.getElementById('vlg-dmg-container'); if (cont) cont.innerHTML = ''; } catch { }
    }
    try { const fx = document.getElementById('vlg-fx'); if (fx) fx.innerHTML = ''; } catch { }
    try { document.body?.classList?.remove('vlg-death-filter'); } catch { }
    // トーストを即時非表示にし、タイマーも解除
    try { clearTimeout(showToast._t); } catch { }
    try { toastEl?.classList?.add('hidden'); } catch { }
    // 各種モーダルを閉じる
    try { levelUpModal?.classList?.add('hidden'); } catch { }
    try { const pause = document.getElementById('pauseModal'); pause?.classList?.add('hidden'); } catch { }
    try { shopModal?.classList?.add('hidden'); } catch { }
    try { document.getElementById('vlg-start-countdown')?.remove(); } catch { }
    try { clearTimeout(startCountdown._timer); } catch { }
    try { cancelAnimationFrame(startCountdown._raf); } catch { }
    startCountdown._timer = null;
    startCountdown._raf = null;
    try {
      riskChoiceAreas = null;
      riskEventEffect = null;
      riskEventTriggered = false;
      riskActivationPending = false;
      state._riskEventEffect = null;
      state._riskAreaAckIndex = null;
    } catch { }
    // キャンバスをクリア（一瞬見えた時のちらつき対策）
    try { const cvs = $('#gameCanvas'); const ctx = cvs?.getContext?.('2d'); if (ctx && cvs) ctx.clearRect(0, 0, cvs.width, cvs.height); } catch { }
    // BGM停止
    try { Audio?.stopBgm?.(state, true); } catch { try { state.audio.bgmEl?.pause(); } catch { } }
    // レベルアップ待ちオーバーレイとステータスを確実にリセット
    try { hideWaitLvOverlay(); } catch { }
    try {
      state.subWeaponRuntime = null;
      state.secondSubWeaponRuntime = null;
      updateSubWeaponHud();
    } catch { }
  }

  // HUD: 購入済みアイテム（パーク）バッジ表示
  function renderHudPerks() {
    const targets = [hudPerksLobby, hudPerksGame];
    const p = state.perks || {};
    const items = [
      { key: 'hp', label: 'HP', color: '#22c55e' },
      { key: 'hphalf', label: 'HP/2', color: '#dc2626' },
      { key: 'spd', label: 'SPD', color: '#3b82f6' },
      { key: 'atk', label: 'ATK', color: '#f59e0b' },
      { key: 'boss', label: 'BOSS', color: '#ea580c' },
      { key: 'cdr', label: 'CDR', color: '#a855f7' },
      { key: 'gain', label: 'GAIN', color: '#14b8a6' },
      { key: 'exp', label: 'EXP', color: '#0ea5e9' },
      { key: 'rez', label: 'REZ', color: '#ef4444' },
      { key: 'dmgcut', label: 'DMG-', color: '#f97316' },
      { key: 'support', label: 'SUP+', color: '#38bdf8' },
      { key: 'upglim', label: 'UPG+', color: '#6b7280' },
      { key: 'sklim', label: 'SKL+', color: '#f472b6' },
      { key: 'ex', label: 'EX', color: '#2563eb' },
    ];
    for (const hud of targets) {
      if (!hud) continue;
      hud.innerHTML = '';
      for (const it of items) {
        const cnt = p[it.key] || 0; if (cnt <= 0) continue;
        const span = document.createElement('span');
        span.className = 'badge';
        span.textContent = `${it.label} x${cnt}`;
        span.style.backgroundColor = 'transparent';
        span.style.border = `1px solid ${it.color}`;
        span.style.color = it.color;
        hud.appendChild(span);
      }
      if (hud.children.length === 0) {
        const hint = document.createElement('span');
        hint.className = 'badge';
        hint.textContent = 'PERKS: なし';
        hint.style.opacity = '0.6';
        hud.appendChild(hint);
      }
    }
  }

  // Personal result helpers
  function computeReward(durationSec, killsCount) {
    const gainUp = 1 + (state.perks.gain || 0) * 0.3; // もらえるマネーUP 1段階ごと+30%
    const baseKills = Math.max(0, killsCount);
    const baseTime = Math.max(0, durationSec);
    if (baseTime < 60) return 0;
    return Math.floor((baseKills * 2 + Math.floor(baseTime / 10)) * gainUp);
  }
  function refreshResultStatsDisplay() {
    if (!resultStats) return;
    const base = state._resultStatsBaseText || '';
    const xpSummary = state._latestCharacterXpSummary;
    resultStats.textContent = xpSummary ? `${base}\n${xpSummary}` : base;
  }
  function setResultStatsBaseText(text) {
    state._resultStatsBaseText = typeof text === 'string' ? text : '';
    refreshResultStatsDisplay();
  }
  // Personal result (local)
  function showPersonalResult(durationSec, killsCount, delayMs = 0) {
    const show = () => {
      showPersonalResult._t = 0;
      try {
        // 統一クリーンアップ（ちらつき/残留イベント防止）
        cleanupBattle('personalResult');
        if (durationSec >= 900) {
          const st = state.room?.stage;
          const diff = state.room?.difficulty || 'ふつう';
          if (st) {
            state.stageClears[st] = state.stageClears[st] || {};
            const prevValue = state.stageClears[st][diff];
            const prevEntry = normalizeStageClearValue(prevValue);
            const ignitionClear = diff === 'むずかしい' && isIgnitionModeActive();
            const nextEntry = mergeStageClearValue(prevValue, { cleared: true, ignition: ignitionClear });
            const changed = prevEntry.cleared !== nextEntry.cleared || prevEntry.ignition !== nextEntry.ignition;
            state.stageClears[st][diff] = nextEntry;
            if (changed) {
              saveStageClears();
              updateDamageReductionLimit();
              updateHardClearAchievements();
              checkStageClearAchievements(st, diff);
            }
            if (ignitionClear) {
              checkIgnitionClearAchievements(st, diff, true);
            }
            checkPoisonDamageAchievements(st, diff);
          }
          checkHpHalfHardAchievements(st, diff);
          checkMelonPanAchievements();
          state._poisonDamageTaken = 0;
          state._melonPanConsumed = 0;
        }
        state._runHpHalfActive = false;
        state._hasPersonalResult = true;
        state.inGame = false;
        setScreen('result');
        // 報酬計算: 撃破と生存時間に応じて
        const reward = computeReward(durationSec, killsCount);
        const gain = addMoney(reward);
        state._lastResultReward = gain;
        saveMoney(); updateMoneyLabels();
        setResultStatsBaseText(`あなたのリザルト  生存時間: ${Math.max(0, durationSec)}s / 撃破数: ${Math.max(0, killsCount)} / 拾ったマネー: +${state._pickedMoney} / 獲得マネー: +${gain} (合計: ${state.money})`);
        const diffName = state.room?.difficulty || 'ふつう';
        awardCharacterExperienceFromResult(durationSec, diffName);
        state._deathAt = 0;
      } catch { }
    };
    if (showPersonalResult._t) clearTimeout(showPersonalResult._t);
    if (delayMs > 0) {
      showPersonalResult._t = setTimeout(show, delayMs);
    } else {
      show();
    }
  }

  function getMyCharacterName() {
    const member = state.room?.members?.find(m => m.id === state.me?.playerId);
    const fromMember = normalizeCharacterSelection(member?.character);
    if (fromMember) return fromMember;
    const active = normalizeCharacterSelection(state._activeCharacterName);
    if (active) return active;
    if (characterSelect && typeof characterSelect.value === 'string') {
      const fromSelect = normalizeCharacterSelection(characterSelect.value);
      if (fromSelect) return fromSelect;
    }
    return null;
  }

  function awardCharacterExperienceFromResult(durationSec, difficultyName) {
    if (!state.characterGrowthUnlocked) return;
    const charName = getMyCharacterName();
    const normalizedChar = normalizeCharacterSelection(charName);
    if (!normalizedChar) return;
    const seconds = Math.max(0, Number(durationSec) || 0);
    const stageName = state.room?.stage;
    const xpMultiplier = getDifficultyXpMultiplier(difficultyName) * getStageXpMultiplier(stageName);
    const xpGain = seconds >= 60 ? Math.floor(seconds * xpMultiplier * CHARACTER_XP_BASE_RATE) : 0;
    if (!state._characterXpRecord || state._characterXpRecord.char !== normalizedChar) {
      state._characterXpRecord = { char: normalizedChar, xpApplied: 0, duration: 0, diff: difficultyName };
    }
    const record = state._characterXpRecord;
    const delta = xpGain - (record.xpApplied || 0);
    record.xpApplied = xpGain;
    record.duration = Math.max(record.duration || 0, seconds);
    record.diff = difficultyName;
    if (delta <= 0) {
      if (!state._latestCharacterXpSummary) {
        const details = getCharacterGrowthDetails(normalizedChar);
        const progressText = details.nextExp > 0 ? `${details.exp}/${details.nextExp}` : 'MAX';
        state._latestCharacterXpSummary = details.nextExp > 0
          ? `キャラ経験値: +0 (Lv${details.level}, EXP ${progressText})`
          : `キャラ経験値: +0 (Lv${details.level}/MAX)`;
        refreshResultStatsDisplay();
      }
      return;
    }
    const result = applyCharacterExperience(normalizedChar, delta);
    const details = getCharacterGrowthDetails(normalizedChar);
    const appliedXp = result?.appliedXp ?? 0;
    const gainedLevels = result?.gainedLevels ?? 0;
    const prevLevel = result?.prevLevel ?? details.level;
    const progressText = details.nextExp > 0 ? `${details.exp}/${details.nextExp}` : 'MAX';
    let summary;
    if (details.nextExp === 0) {
      summary = `キャラ経験値: +${appliedXp} (Lv${details.level}/MAX)`;
    } else if (gainedLevels > 0 && result) {
      summary = `キャラ経験値: +${appliedXp} (Lv${prevLevel} → Lv${details.level}, EXP ${progressText})`;
    } else {
      summary = `キャラ経験値: +${appliedXp} (Lv${details.level}, EXP ${progressText})`;
    }
    state._latestCharacterXpSummary = summary;
    refreshResultStatsDisplay();
    updateCharacterInfo(characterSelect?.value || normalizedChar);
    if (appliedXp > 0) {
      if (gainedLevels > 0) {
        try { Audio?.playSfx?.(state, 'ok'); } catch { }
      }
      showToast(`「${normalizedChar}」の経験値が${appliedXp}増加しました`, 'info');
    }
  }

  function applyCharacterGrowthBonuses(charName, player) {
    if (!charName) return;
    const { hpMul, spdMul, armorMul } = getCharacterGrowthDetails(charName);
    if (hpMul !== 1) {
      const prevMax = state.stats.maxHp || 0;
      if (prevMax > 0) {
        const ratio = prevMax > 0 ? (state.stats.hp || prevMax) / prevMax : 1;
        const newMax = Math.round(prevMax * hpMul);
        state.stats.maxHp = newMax;
        const clampedRatio = Math.min(1, Math.max(0, ratio));
        const newHp = Math.round(newMax * clampedRatio);
        state.stats.hp = Math.max(1, Math.min(newMax, newHp));
      }
    }
    if (state.armorUnlocked && armorMul !== 1) {
      state.stats.baseArmor = Math.round(state.stats.baseArmor * armorMul);
      state.stats.maxArmor = Math.round(state.stats.maxArmor * armorMul);
      state.stats.armor = Math.round(state.stats.armor * armorMul);
    }
    if (player && spdMul !== 1) {
      player.spd *= spdMul;
    }
  }

  // FPS/Ping/Resource overlay
  let fpsEl = null;
  let netStatsContainer = null;
  let pingEl = null;
  let resourceEl = null;
  let lastResourceSetting = null;
  let fpsAccum = 0;
  let fpsCount = 0;
  let pingElapsed = 30;
  let pingChecking = false;
  let resourceElapsed = 30;
  let resourceChecking = false;
  function ensureFpsEl() {
    if (!netStatsContainer) {
      netStatsContainer = document.createElement('div');
      netStatsContainer.id = 'netStatsContainer';
      Object.assign(netStatsContainer.style, {
        position: 'fixed',
        right: '12px',
        top: '56px',
        background: '#0008',
        color: '#fff',
        padding: '4px 6px',
        font: '12px/1.6 monospace',
        borderRadius: '6px',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        alignItems: 'flex-end',
        minWidth: '96px',
      });
      netStatsContainer.style.display = 'none';
      document.body.appendChild(netStatsContainer);
    }
    if (!fpsEl) {
      fpsEl = document.createElement('div');
      fpsEl.id = 'fpsCounter';
      fpsEl.textContent = '-- FPS';
      Object.assign(fpsEl.style, {
        width: '100%',
        textAlign: 'right',
      });
      netStatsContainer.appendChild(fpsEl);
    }
    if (!pingEl) {
      pingEl = document.createElement('div');
      pingEl.id = 'pingCounter';
      pingEl.textContent = '--';
      pingEl.style.width = '100%';
      pingEl.style.textAlign = 'right';
      netStatsContainer.appendChild(pingEl);
    }
    if (!resourceEl) {
      resourceEl = document.createElement('div');
      resourceEl.id = 'resourceStats';
      resourceEl.style.width = '100%';
      resourceEl.style.textAlign = 'right';
      resourceEl.style.whiteSpace = 'pre';
      netStatsContainer.appendChild(resourceEl);
    }
    const showPing = !!state.settings.ping;
    const showResource = !!state.settings.loadStats;
    const showFps = !!state.settings.fps;
    fpsEl.style.display = showFps ? 'block' : 'none';
    pingEl.style.display = showPing ? 'block' : 'none';
    resourceEl.style.display = showResource ? 'block' : 'none';
    netStatsContainer.style.display = (showPing || showResource || showFps) ? 'flex' : 'none';
    if (lastResourceSetting !== showResource) {
      lastResourceSetting = showResource;
      if (showResource) {
        resourceElapsed = 30;
        resourceEl.textContent = '計測中…';
      } else {
        resourceEl.textContent = '';
      }
    }
  }

  function connectSSE(roomId, playerId, authToken) {
    if (state.sse) state.sse.close();
    const safeRoomId = (typeof roomId === 'string') ? roomId : '';
    const safePlayerId = (typeof playerId === 'string') ? playerId : '';
    const effectiveToken = (typeof authToken === 'string' && authToken)
      ? authToken
      : (state.me?.authToken ?? '');
    const safeToken = (typeof effectiveToken === 'string') ? effectiveToken : '';
    const key = `vlg.lastEventId.${safeRoomId || 'lobby'}`;
    const raw = localStorage.getItem(key);
    let rec = null;
    try { rec = raw ? JSON.parse(raw) : null; } catch { rec = raw; }
    const now = Date.now();
    let lastId = null;
    if (rec && typeof rec === 'object' && 'id' in rec) {
      const maxAge = 10 * 60 * 1000; // 10分で期限切れ
      if (!rec.ts || now - rec.ts > maxAge) {
        try { localStorage.removeItem(key); } catch { }
      } else {
        lastId = rec.id;
      }
    } else if (rec) {
      lastId = rec; // 旧形式
    }
    const url = new URL('api.php', document.baseURI);
    url.searchParams.set('action', 'events');
    url.searchParams.set('roomId', safeRoomId);
    if (safePlayerId)
      url.searchParams.set('playerId', safePlayerId);
    if (safeToken)
      url.searchParams.set('authToken', safeToken);
    if (lastId)
      url.searchParams.set('lastEventId', lastId);
    const es = new EventSource(url.toString());
    state.sse = es;
    const fallback = lastId ? setTimeout(() => {
      try { localStorage.removeItem(key); } catch { }
      es.close();
      connectSSE(safeRoomId, safePlayerId, safeToken);
    }, 5000) : null;
    es.onopen = () => {
      if (state.sseReconnecting) {
        showToast('再接続に成功しました', 'success', 3000);
        state.sseReconnecting = false;
      }
    };
    es.onmessage = (ev) => {
      if (fallback) clearTimeout(fallback);
      if (ev.lastEventId) {
        try { localStorage.setItem(key, JSON.stringify({ id: ev.lastEventId, ts: Date.now(), v: 1 })); } catch { }
      }
      try {
        // 一部環境で先頭にBOMや余計なカンマが紛れる場合に備えクリーニング
        let raw = ev.data;
        if (typeof raw !== 'string') return;
        // 削除: 先頭/末尾の不可視文字やカンマ
        raw = raw.replace(/^\uFEFF/, '').trim();
        raw = raw.replace(/^,+/, '');
        if (!raw) return;
        const msg = JSON.parse(raw);
        if (msg && typeof msg === 'object') handleServerEvent(msg);
      } catch (e) {
        // 断片や未完行などは無視（次のイベントで再取得される）
        // console.debug('SSE parse skip', e, ev.data);
      }
    };
    es.onerror = () => {
      if (fallback) clearTimeout(fallback);
      if (!state.sseReconnecting) {
        showToast('接続が切れました。再接続中…', 'error', 4500);
      }
      state.sseReconnecting = true;
      setTimeout(() => connectSSE(safeRoomId, safePlayerId, safeToken), 1500);
    };
    startHeartbeat();
  }

  function renderRoomList(list) {
    roomList.innerHTML = '';
    const rooms = Array.isArray(list) ? normalizeRooms(list) : [];
    if (!rooms.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'room-list-empty';
      emptyLi.textContent = '公開中の部屋はありません';
      roomList.appendChild(emptyLi);
      return;
    }
    rooms.forEach(r => {
      const li = document.createElement('li');
      li.classList.add('room-item');
      const full = (r.members?.length ?? 0) >= 5;
      const inGame = r.status === 'game';
      const inResult = r.status === 'result';
      const meta = document.createElement('span');
      const owner = r.members?.find(m => m.id === r.owner);
      const b = document.createElement('b');
      b.textContent = r.id;
      meta.appendChild(b);
      meta.appendChild(document.createTextNode(` / ${(r.members?.length ?? 0)}/5 - ${owner ? owner.name : '不明'}`));
      if (r.stage) meta.appendChild(document.createTextNode(' - ' + r.stage));
      if (r.difficulty) meta.appendChild(document.createTextNode(' - ' + r.difficulty));
      const ignitionActive = !!(r.flags && (r.flags.ignitionMode || r.flags.ignition));
      if (ignitionActive) {
        meta.appendChild(document.createTextNode(' '));
        const igBadge = document.createElement('span');
        igBadge.className = 'badge ready';
        igBadge.textContent = 'イグニッション';
        meta.appendChild(igBadge);
      }
      if (r.hasPassword) { meta.appendChild(document.createTextNode(' 🔒')); }
      if (inGame || inResult) {
        const badge = document.createElement('span');
        badge.className = 'badge wait';
        badge.textContent = inGame ? '進行中' : 'リザルト';
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(badge);
      }
      li.appendChild(meta);
      const btn = document.createElement('button');
      btn.textContent = '入室';
      btn.className = 'join-btn';
      btn.disabled = full || inGame || inResult;
      btn.title = btn.disabled ? (full ? '満員です' : inGame ? '進行中です' : 'リザルト中です') : '入室する';
      btn.onclick = async (e) => { e.stopPropagation(); await joinExistingRoom(r.id, r.hasPassword); };
      li.appendChild(btn);
      roomList.appendChild(li);
    });
  }

  // 入室直後に呼ぶ: 進捗ロードとUI反映
  function onRoomEntered() {
    try {
      loadMoney();
      loadExcludeTokens();
      updateMoneyLabels();
      renderHudPerks();
    } catch { }
  }

  function updateRoomUI() {
    if (!state.room) return;
    roomIdLabel.textContent = state.room.id;
    if (roomPasswordWrapper && roomPasswordLabel) {
      const knownPassword = state.room.password ?? null;
      const hasPassword = !!(state.room.hasPassword ?? (knownPassword !== null));
      if (hasPassword) {
        roomPasswordWrapper.classList.remove('hidden');
        roomPasswordLabel.textContent = knownPassword ?? '******';
      } else {
        roomPasswordWrapper.classList.add('hidden');
      }
    }
    // role label (host/guest)
    if (roleLabel) {
      roleLabel.className = 'badge ' + ((state.room.owner === state.me?.playerId) ? 'host' : 'guest');
      roleLabel.textContent = (state.room.owner === state.me?.playerId) ? 'ホスト' : 'ゲスト';
    }
    memberList.innerHTML = '';
    const resolveMemberCharacterName = (member) => {
      const normalized = normalizeCharacterSelection(member?.character);
      return normalized ?? '未選択';
    };
    state.room.members.forEach(m => {
      const li = document.createElement('li');
      li.className = 'member-item';
      const isMe = state.me && m.id === state.me.playerId;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.name;
      const char = document.createElement('span');
      char.className = 'char';
      char.textContent = `キャラ: ${resolveMemberCharacterName(m)}`;
      const badges = document.createElement('span');
      if ((state.room.owner ?? '') === (m.id ?? '')) {
        const b = document.createElement('span'); b.className = 'badge host'; b.textContent = 'ホスト'; badges.appendChild(b);
      } else {
        const b = document.createElement('span'); b.className = 'badge guest'; b.textContent = 'ゲスト'; badges.appendChild(b);
      }
      if (isMe) { const b = document.createElement('span'); b.className = 'badge me'; b.textContent = 'あなた'; badges.appendChild(b); }
      const ready = document.createElement('span'); ready.className = 'badge ' + (m.ready ? 'ready' : 'wait'); ready.textContent = m.ready ? 'Ready' : '待機';
      li.appendChild(name); li.appendChild(char); li.appendChild(badges); li.appendChild(ready);
      memberList.appendChild(li);
    });
    const allReady = state.room.members.length > 0 && state.room.members.every(m => m.ready);
    const me = state.room.members.find(m => m.id === state.me?.playerId);
    const imReady = me?.ready ?? false;
    const btnStart = document.getElementById('btnStart');
    const btnReady = document.getElementById('btnReady');
    const btnDisband = document.getElementById('btnDisband');
    const btnBackToRoom = document.getElementById('btnBackToRoom');
    const isOwner = state.room.owner === state.me?.playerId;
    btnStart.disabled = !(allReady && isOwner);
    const readyChar = normalizeCharacterSelection(me?.character ?? characterSelect?.value);
    if (btnReady) {
      btnReady.textContent = imReady ? '準備解除' : '準備';
      btnReady.disabled = imReady ? false : !readyChar;
      btnReady.title = (!imReady && !readyChar) ? 'キャラを選択してください' : '';
    }
    btnDisband.disabled = !isOwner;
    if (btnBackToRoom) btnBackToRoom.disabled = !isOwner;
    if (characterSelect) characterSelect.disabled = imReady;
    if (stageSelect) stageSelect.disabled = imReady || !isOwner;
    if (difficultySelect) difficultySelect.disabled = imReady || !isOwner;
    if (btnOpenShop) btnOpenShop.disabled = imReady;
    if (btnOpenCardShop) btnOpenCardShop.disabled = imReady;
    if (btnOpenWeaponShop) btnOpenWeaponShop.disabled = imReady;
    updateMoneyLabels();
    updateIgnitionControls();
    if (characterSelect) {
      const charValue = normalizeCharacterSelection(me?.character);
      characterSelect.value = charValue ?? '-';
      updateCharacterInfo(characterSelect.value);
    }
    if (state.room.stage && stageSelect) stageSelect.value = state.room.stage;
    if (state.room.difficulty && difficultySelect) difficultySelect.value = state.room.difficulty;
    if (difficultySelect) updateDifficultyInfo(difficultySelect.value);
    if (stageSelect) updateStageInfo(stageSelect.value);
    renderSubWeaponInventory();
    setSubWeaponSelectionDisabled(imReady);
    if (state._screen === 'room') {
      try { Audio?.setBgmForStage?.(state, state.room.stage); } catch { }
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.hbTimer = setInterval(() => {
      try {
        if (!state.room || !state.me) return;
        if (state.inGame) return;
        sendEvent({ type: 'heartbeat' }).catch(() => { });
      } catch { }
    }, 15000);
  }
  function stopHeartbeat() { if (state.hbTimer) { clearInterval(state.hbTimer); state.hbTimer = null; } }

  function handleServerEvent(msg) {
    switch (msg.type) {
      case 'rooms': renderRoomList(msg.rooms); break;
      case 'roomUpdate': {
        const prevPassword = state.room?.password;
        const nextRoom = cloneRoomPayload(msg.room);
        if (!nextRoom) break;
        if (prevPassword && (nextRoom.hasPassword ?? false)) {
          nextRoom.password = prevPassword;
        }
        state.room = nextRoom;
        updateRoomUI();
        break;
      }
      case 'personalResult': {
        if (!state.me) break;
        if (msg.playerId === state.me.playerId) {
          const dur = Math.max(0, Math.round(msg.duration || 0));
          const ks = Math.max(0, msg.kills || 0);
          const othersAlive = Object.keys(state.allies).some(pid => state.allies[pid]?.alive);
          if (state.spectating || (state.stats?.alive === false && othersAlive)) {
            state._pendingPersonalResult = { dur, ks };
            if (!state.spectating && othersAlive) {
              state.spectating = true;
              state._spectateTarget = Object.keys(state.allies).find(pid => state.allies[pid]?.alive) || null;
              state._nextSpectateSwitch = performance.now() + 5000;
            }
          } else if (!state._hasPersonalResult) {
            // 初回は通常フロー（BGM停止・報酬加算）
            if (state.stats?.alive === false) {
              const base = typeof state._deathAt === 'number' && state._deathAt > 0 ? performance.now() - state._deathAt : 0;
              const delay = Math.max(0, 2000 - base);
              showPersonalResult(dur, ks, delay);
            } else {
              showPersonalResult(dur, ks);
            }
          } else {
            // 既にローカル表示済みなら、サーバー確定値で差分調整して上書き表示
            const newReward = computeReward(dur, ks);
            const adjReward = addMoney(newReward, { preview: true });
            const delta = adjReward - (state._lastResultReward || 0);
            if (delta !== 0) { state.money += delta; state._lastResultReward = adjReward; saveMoney(); updateMoneyLabels(); }
            setResultStatsBaseText(`あなたのリザルト  生存時間: ${dur}s / 撃破数: ${ks} / 拾ったマネー: +${state._pickedMoney} / 獲得マネー: +${adjReward} (合計: ${state.money})`);
          }
        }
        break;
      }
      case 'revive': {
        const targetId = typeof msg.playerId === 'string' ? msg.playerId : '';
        if (!targetId) break;
        const newHp = Number.isFinite(msg.hp) ? msg.hp : null;
        const maxHp = Number.isFinite(msg.maxHp) ? msg.maxHp : null;
        const armor = Number.isFinite(msg.armor) ? msg.armor : null;
        const maxArmor = Number.isFinite(msg.maxArmor) ? msg.maxArmor : null;
        const posX = Number.isFinite(msg.x) ? msg.x : null;
        const posY = Number.isFinite(msg.y) ? msg.y : null;
        const revivedFlag = msg.revived === true;
        const reviverId = typeof msg.reviverId === 'string' ? msg.reviverId : null;
        if (state._reviveState?.targetId === targetId) {
          state._reviveState.targetId = null;
          state._reviveState.progress = 0;
          hideReviveGauge();
        }
        if (state._revivePendingTarget === targetId) {
          state._revivePendingTarget = null;
        }
        if (state.me && targetId === state.me.playerId) {
          state.stats.alive = true;
          state.inGame = true;
          state._freezeTimeAlive = false;
          state.spectating = false;
          state._deathAt = 0;
          if (newHp !== null) state.stats.hp = newHp;
          if (maxHp !== null) state.stats.maxHp = maxHp;
          if (armor !== null) state.stats.armor = armor;
          if (maxArmor !== null) state.stats.maxArmor = maxArmor;
          state._pendingReviveApply = { x: posX, y: posY };
          try { Audio?.setBgmForStage?.(state, state.room?.stage); } catch { }
          try { Audio?.playSfx?.(state, 'revive'); } catch { try { Audio?.playSfx?.(state, 'levelup'); } catch { } }
          try { playReviveFx(); } catch { }
          hideReviveGauge();
          showToast('蘇生しました！', 'info', 2200);
        } else {
          const ally = state.allies[targetId] = state.allies[targetId] || {};
          ally.alive = true;
          if (newHp !== null) ally.hp = newHp;
          if (maxHp !== null) ally.maxHp = maxHp;
          if (armor !== null) ally.armor = armor;
          if (maxArmor !== null) ally.maxArmor = maxArmor;
          if (posX !== null && posY !== null) {
            ally.x = posX;
            ally.y = posY;
            ally.sx = posX;
            ally.sy = posY;
          }
          if (revivedFlag) ally.revivedOnce = true;
          const revivedName = ally.name
            || state.room?.members?.find(m => m.id === targetId)?.name
            || '味方';
          if (reviverId === state.me?.playerId) {
            showToast(`${revivedName}を蘇生しました！`, 'info', 2400);
          }
        }
        break;
      }
      case 'gameStart':
        if (state.inGame) break; // guard against duplicate start events during battle
        state.inGame = true; state._hasPersonalResult = false; state._rezUsed = false; setScreen('game');
        maxDamageRecord = 0;
        state._poisonDamageTaken = 0;
        state._melonPanConsumed = 0;
        state._runHpHalfActive = (state.perks?.hphalf || 0) > 0;
        state._characterXpRecord = null;
        state._latestCharacterXpSummary = '';
        state._resultStatsBaseText = '';
        refreshResultStatsDisplay();
        riskChoiceAreas = null;
        riskEventEffect = null;
        riskEventTriggered = false;
        riskActivationPending = false;
        state._riskEventEffect = null;
        state._riskAreaAckIndex = null;
        resetReviveState();
        for (const ally of Object.values(state.allies)) {
          if (ally) ally.revivedOnce = false;
        }
        // reset timing sync fields up-front
        state.serverGameStartAtSec = null;
        state._svtOffsetMs = 0;
        state._svtSmoothed = false;
        // capture server start time if provided
        if (typeof msg.gameStartAt === 'number') {
          state.serverGameStartAtSec = msg.gameStartAt;
        }
        // initialize server clock estimate if provided
        if (typeof msg.svt === 'number') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          state._svtOffsetMs = msg.svt - now;
          state._svtSmoothed = true;
          // verify consistency of svt vs gameStartAt
          if (typeof msg.gameStartAt === 'number') {
            const diff = msg.svt - msg.gameStartAt * 1000;
            if (Math.abs(diff) > 1000) {
              console.warn('[gameStart] svt mismatch', { svt: msg.svt, gameStartAt: msg.gameStartAt, diff });
            }
          }
        }
        if ((typeof msg.gameStartAt === 'number') !== (typeof msg.svt === 'number')) {
          console.warn('[gameStart] Inconsistent gameStartAt/svt presence', { gameStartAt: msg.gameStartAt, svt: msg.svt });
        }
        // server sim toggle
        state.serverSim = (msg.sim === 'server');
        // ensure time-alive counter resumes on start
        // Resume time counter at game start regardless of server simulation status
        state._freezeTimeAlive = false;
        state.svEnemiesRaw = [];
        state.svBulletsRaw = [];
        state.svHazardsRaw = [];
        state.svItemsRaw = [];
        state._pendingEnemyDeads = [];
        try { const btnBack = document.getElementById('btnBackToRoom'); if (btnBack) btnBack.disabled = (state.room?.owner !== state.me?.playerId); } catch { }
        try {
          const meM = state.room?.members.find(m => m.id === state.me?.playerId);
          const hudChar = normalizeCharacterSelection(meM?.character);
          setHudChip(hudChar, meM?.name || state.me?.name);
          const stName = state.room?.stage || 'メロンパン広場';
          Audio?.setBgmForStage?.(state, stName);
        } catch { }
        renderHudPerks();
        const serverStartMs = (state.serverGameStartAtSec || 0) * 1000;
        const localStartMs = serverStartMs - (state._svtOffsetMs || 0);
        startCountdown(localStartMs, () => {
          startLocalGameLoop();
        });
        break;
      case 'riskRewardAreas': {
        const normalizeArea = (area) => {
          if (!area || typeof area !== 'object') return null;
          const x = Number(area.x);
          const y = Number(area.y);
          const r = Number(area.r);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return null;
          const type = area.type === 'melon' ? 'melon' : (area.type === 'money' ? 'money' : 'exp');
          const expiresAtRaw = Number(area.expiresAt);
          const countdownRaw = Number(area.countdownAt);
          const durationRaw = Number(area.duration);
          const serverExpiresAt = Number.isFinite(expiresAtRaw) ? expiresAtRaw : null;
          const countdownAt = Number.isFinite(countdownRaw) ? countdownRaw : null;
          let duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
          if (duration === null && serverExpiresAt !== null && countdownAt !== null) {
            duration = Math.max(0, serverExpiresAt - countdownAt);
          }
          if (!Number.isFinite(duration) || duration <= 0) duration = RISK_REWARD_BASE_DURATION;
          const localTimeAlive = typeof state._timeAlive === 'number' ? state._timeAlive : 0;
          const localExpiresAt = localTimeAlive + duration;
          return {
            x,
            y,
            r,
            type,
            countdownAt,
            duration,
            serverExpiresAt,
            expiresAt: localExpiresAt,
            localExpiresAt,
          };
        };
        const rawAreas = Array.isArray(msg.areas) ? msg.areas : [];
        const normalized = rawAreas.map(normalizeArea).filter(Boolean);
        riskChoiceAreas = normalized.length > 0 ? normalized : null;
        riskEventEffect = null;
        state._riskEventEffect = null;
        riskEventTriggered = Array.isArray(riskChoiceAreas) && riskChoiceAreas.length > 0;
        riskActivationPending = false;
        if (state.serverSim && riskChoiceAreas && typeof msg.eventIndex === 'number') {
          const idx = Number(msg.eventIndex);
          const isOwner = state.room?.owner === state.me?.playerId;
          if (isOwner && Number.isFinite(idx) && state._riskAreaAckIndex !== idx) {
            const longest = riskChoiceAreas.reduce((max, area) => {
              if (!area || typeof area !== 'object') return max;
              const dur = Number(area.duration);
              if (!Number.isFinite(dur) || dur <= 0) return max;
              return Math.max(max, dur);
            }, 0);
            const ackDuration = longest > 0 ? longest : RISK_REWARD_BASE_DURATION;
            state._riskAreaAckIndex = idx;
            sendEvent({ type: 'riskRewardCountdown', duration: ackDuration, eventIndex: idx }).catch(() => {
              if (state._riskAreaAckIndex === idx) state._riskAreaAckIndex = null;
            });
          } else if (!isOwner && state._riskAreaAckIndex === idx) {
            state._riskAreaAckIndex = null;
          }
        }
        if (typeof msg.svt === 'number') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const sample = msg.svt - now;
          if (!state._svtSmoothed) { state._svtOffsetMs = sample; state._svtSmoothed = true; }
          else { state._svtOffsetMs = state._svtOffsetMs + (sample - state._svtOffsetMs) * 0.08; }
        }
        if (state.serverSim && riskChoiceAreas) {
          showToast('リスク報酬エリアが出現！');
          try { Audio?.playSfx?.(state, 'alert'); } catch { }
        }
        break;
      }
      case 'neutralWaveWarning': {
        if (!state.serverSim) break;
        showToast('警告！まもなく敵が大量に現れる！');
        try { Audio?.playSfx?.(state, 'alert'); } catch { }
        break;
      }
      case 'neutralWaveSpawn': {
        if (!state.serverSim) break;
        showToast('敵が大量に現れた！');
        try { Audio?.playSfx?.(state, 'alert'); } catch { }
        break;
      }
      case 'riskRewardActivate': {
        const normalizeArea = (area) => {
          if (!area || typeof area !== 'object') return null;
          const x = Number(area.x);
          const y = Number(area.y);
          const r = Number(area.r);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return null;
          const type = area.type === 'melon' ? 'melon' : (area.type === 'money' ? 'money' : 'exp');
          const expiresAtRaw = Number(area.expiresAt);
          const countdownRaw = Number(area.countdownAt);
          const durationRaw = Number(area.duration);
          const serverExpiresAt = Number.isFinite(expiresAtRaw) ? expiresAtRaw : null;
          const countdownAt = Number.isFinite(countdownRaw) ? countdownRaw : null;
          let duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
          if (duration === null && serverExpiresAt !== null && countdownAt !== null) {
            duration = Math.max(0, serverExpiresAt - countdownAt);
          }
          if (!Number.isFinite(duration) || duration <= 0) duration = RISK_REWARD_BASE_DURATION;
          const localTimeAlive = typeof state._timeAlive === 'number' ? state._timeAlive : 0;
          const localExpiresAt = localTimeAlive + duration;
          return {
            x,
            y,
            r,
            type,
            countdownAt,
            duration,
            serverExpiresAt,
            expiresAt: localExpiresAt,
            localExpiresAt,
          };
        };
        const rawAreas = Array.isArray(msg.areas) ? msg.areas : [];
        const normalizedAreas = rawAreas.map(normalizeArea).filter(Boolean);
        riskChoiceAreas = normalizedAreas.length > 0 ? normalizedAreas : null;
        riskActivationPending = false;
        riskEventTriggered = false;
        let effect = null;
        if (msg.effect && typeof msg.effect === 'object') {
          const type = msg.effect.type === 'melon' ? 'melon' : (msg.effect.type === 'money' ? 'money' : (msg.effect.type === 'exp' ? 'exp' : null));
          if (type) {
            const startedAt = Number(msg.effect.startedAt);
            effect = {
              type,
              startedAt: Number.isFinite(startedAt) ? startedAt : 0,
            };
          }
        }
        riskEventEffect = effect;
        state._riskEventEffect = effect;
        let buffsChanged = false;
        for (let i = state.activeCardEffects.length - 1; i >= 0; i--) {
          const t = state.activeCardEffects[i]?.type;
          if (t === 'risk-exp' || t === 'risk-melon' || t === 'risk-money') {
            state.activeCardEffects.splice(i, 1);
            buffsChanged = true;
          }
        }
        if (effect) {
          const buffMeta = {
            exp: { type: 'risk-exp', name: '経験値オーブ3倍' },
            melon: { type: 'risk-melon', name: 'メロンパン出現率5倍' },
            money: { type: 'risk-money', name: 'マネー獲得量3倍' },
          };
          const buff = buffMeta[effect.type] || buffMeta.exp;
          const buffType = buff.type;
          const buffName = buff.name;
          state.activeCardEffects.push({ type: buffType, ttl: Infinity, dur: Infinity, name: buffName });
          buffsChanged = true;
        }
        if (buffsChanged) refreshCardBuffs();
        if (typeof msg.svt === 'number') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const sample = msg.svt - now;
          if (!state._svtSmoothed) { state._svtOffsetMs = sample; state._svtSmoothed = true; }
          else { state._svtOffsetMs = state._svtOffsetMs + (sample - state._svtOffsetMs) * 0.08; }
        }
        if (state.serverSim) {
          if (effect) {
            const toastMap = {
              exp: '経験値オーブが3倍ドロップ！',
              melon: 'メロンパン出現率が5倍！',
              money: 'マネー獲得量が3倍！',
            };
            showToast(toastMap[effect.type] || toastMap.exp);
            try { Audio?.playSfx?.(state, 'pickup'); } catch { }
            const spawned = Number(msg.spawned);
            if (Number.isFinite(spawned) && spawned > 0) {
              setTimeout(() => { showToast('弾幕の敵が現れた！'); }, 600);
              try { Audio?.playSfx?.(state, 'alert'); } catch { }
            }
          }
        }
        break;
      }
      case 'svEnemies': {
        // update last server enemies snapshot
        if (Array.isArray(msg.enemies)) {
          const prev = Array.isArray(state.svEnemiesRaw) ? state.svEnemiesRaw : [];
          const prevMap = new Map(prev.map(e => [e.id, e]));
          const prevIds = new Set(prevMap.keys());
          const next = [];
          const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
          for (const se of msg.enemies) {
            if (!se) continue;
            const prevEnemy = se.id != null ? prevMap.get(se.id) : undefined;
            const rawX = parseNumber(se.x);
            const rawY = parseNumber(se.y);
            const rawR = parseNumber(se.r);
            const x = Number.isFinite(rawX) ? rawX : (Number.isFinite(prevEnemy?.x) ? prevEnemy.x : Number.NaN);
            const y = Number.isFinite(rawY) ? rawY : (Number.isFinite(prevEnemy?.y) ? prevEnemy.y : Number.NaN);
            const r = Number.isFinite(rawR) ? rawR : (Number.isFinite(prevEnemy?.r) ? prevEnemy.r : Number.NaN);
            const fallbackFields = [];
            if (!Number.isFinite(rawX) && Number.isFinite(prevEnemy?.x)) fallbackFields.push('x');
            if (!Number.isFinite(rawY) && Number.isFinite(prevEnemy?.y)) fallbackFields.push('y');
            if (!Number.isFinite(rawR) && Number.isFinite(prevEnemy?.r)) fallbackFields.push('r');
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) {
              console.warn('[svEnemies] Dropping enemy with invalid numeric fields', { id: se.id, x: se?.x, y: se?.y, r: se?.r });
              continue;
            }
            if (fallbackFields.length > 0) {
              console.warn('[svEnemies] Fallback applied for enemy fields', { id: se.id, fields: fallbackFields, raw: { x: se?.x, y: se?.y, r: se?.r } });
            }
            next.push({ id: se.id, type: se.type || 'chaser', x, y, r, hp: se.hp, maxHp: se.maxHp, boss: !!se.boss, name: se.name, state: se.state, fuse: se.fuse, blast: se.blast, elem: se.elem, dmgTakenMul: se.dmgTakenMul });
          }
          const nextIds = new Set(next.map(e => e.id));
          // detect newly appeared boss
          for (const e of next) {
            if (e.boss && e.id && !prevIds.has(e.id)) {
              try { Audio?.playSfx?.(state, 'alert'); } catch { }
              try {
                const toast = document.getElementById('toast');
                if (toast) {
                  toast.textContent = `${e.name || '大型の敵'}が現れた！`;
                  toast.classList.remove('hidden', 'error');
                  clearTimeout(showToast._t);
                  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3500);
                }
              } catch { }
              try { playBossAppearFx(e.name, e.type); } catch { }
              break;
            }
          }
          // detect disappeared enemies and queue local kill effects
          const deadIds = new Set((state._pendingEnemyDeads || []).map(ev => ev.id));
          for (const id of prevIds) {
            if (!nextIds.has(id) && !deadIds.has(id)) {
              const p = prevMap.get(id);
              if (p) {
                if (!Array.isArray(state._pendingEnemyDeads)) state._pendingEnemyDeads = [];
                state._pendingEnemyDeads.push({ id, x: p.x, y: p.y, boss: !!p.boss });
              }
            }
          }
          state.svEnemiesRaw = next;
        }
        if (Array.isArray(msg.bullets)) {
          const prevBullets = Array.isArray(state.svBulletsRaw) ? state.svBulletsRaw : [];
          const prevBIds = new Set(prevBullets.map(b => b.id));
          const prevBMap = new Map(prevBullets.map(b => [b.id, b]));
          const nextBullets = [];
          const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
          for (const b of msg.bullets) {
            if (!b) continue;
            const prevBullet = b.id != null ? prevBMap.get(b.id) : undefined;
            const rawX = parseNumber(b.x);
            const rawY = parseNumber(b.y);
            const rawVx = parseNumber(b.vx);
            const rawVy = parseNumber(b.vy);
            const rawR = parseNumber(b.r);
            const x = Number.isFinite(rawX) ? rawX : (Number.isFinite(prevBullet?.x) ? prevBullet.x : Number.NaN);
            const y = Number.isFinite(rawY) ? rawY : (Number.isFinite(prevBullet?.y) ? prevBullet.y : Number.NaN);
            const vx = Number.isFinite(rawVx) ? rawVx : (Number.isFinite(prevBullet?.vx) ? prevBullet.vx : Number.NaN);
            const vy = Number.isFinite(rawVy) ? rawVy : (Number.isFinite(prevBullet?.vy) ? prevBullet.vy : Number.NaN);
            const r = Number.isFinite(rawR) ? rawR : (Number.isFinite(prevBullet?.r) ? prevBullet.r : Number.NaN);
            const fallbackFields = [];
            if (!Number.isFinite(rawX) && Number.isFinite(prevBullet?.x)) fallbackFields.push('x');
            if (!Number.isFinite(rawY) && Number.isFinite(prevBullet?.y)) fallbackFields.push('y');
            if (!Number.isFinite(rawVx) && Number.isFinite(prevBullet?.vx)) fallbackFields.push('vx');
            if (!Number.isFinite(rawVy) && Number.isFinite(prevBullet?.vy)) fallbackFields.push('vy');
            if (!Number.isFinite(rawR) && Number.isFinite(prevBullet?.r)) fallbackFields.push('r');
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(r)) {
              console.warn('[svBullets] Dropping bullet with invalid numeric fields', { id: b.id, x: b?.x, y: b?.y, vx: b?.vx, vy: b?.vy, r: b?.r });
              continue;
            }
            if (fallbackFields.length > 0) {
              console.warn('[svBullets] Fallback applied for bullet fields', { id: b.id, fields: fallbackFields, raw: { x: b?.x, y: b?.y, vx: b?.vx, vy: b?.vy, r: b?.r } });
            }
            nextBullets.push({ id: b.id, type: b.type || 'enemy', x, y, vx, vy, r, ttl: +b.ttl, dmg: +b.dmg, arm: +b.arm });
          }
          state.svBulletsRaw = nextBullets;
          const hasNew = state.svBulletsRaw.some(b => !prevBIds.has(b.id));
          if (hasNew) { try { Audio?.playSfx?.(state, 'enemyShot'); } catch { } }
        }
        if (Array.isArray(msg.hazards)) {
          const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
          const safeHazards = [];
          for (const h of msg.hazards) {
            if (!h) continue;
            const type = h.type || 'explosion';
            const rawX = parseNumber(h.x);
            const rawY = parseNumber(h.y);
            const rawR = parseNumber(h.r);
            const rawTtl = parseNumber(h.ttl);
            const rawDmg = parseNumber(h.dmg);
            if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawR)) {
              console.warn('[svEnemies] Dropping hazard with invalid position or radius', { hazard: h });
              continue;
            }
            const warnings = [];
            const ttl = Number.isFinite(rawTtl) ? rawTtl : 0;
            const dmg = Number.isFinite(rawDmg) ? rawDmg : 0;
            if (!Number.isFinite(rawTtl)) warnings.push('ttl');
            if (!Number.isFinite(rawDmg)) warnings.push('dmg');
            if (warnings.length > 0) {
              console.warn('[svEnemies] Hazard fields defaulted', { hazard: h, fields: warnings });
            }
            safeHazards.push({ ...h, type, x: rawX, y: rawY, r: rawR, ttl, dmg });
          }
          state.svHazardsRaw = safeHazards;
        }
        if (Array.isArray(msg.items)) { state.svItemsRaw = msg.items.map(it => ({ id: it.id, type: it.type || 'heal', elem: it.elem || null, x: +it.x, y: +it.y, r: +it.r, value: +it.value })); }
        // refresh server clock estimate if provided
        if (typeof msg.svt === 'number') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const sample = msg.svt - now; // serverNowMs - perfNow
          if (!state._svtSmoothed) { state._svtOffsetMs = sample; state._svtSmoothed = true; }
          else { state._svtOffsetMs = state._svtOffsetMs + (sample - state._svtOffsetMs) * 0.08; }
        }
        break;
      }
      case 'enemyDead':
        if (!Array.isArray(state._pendingEnemyDeads)) state._pendingEnemyDeads = [];
        state._pendingEnemyDeads.push({ id: msg.id, x: +msg.x, y: +msg.y, boss: !!msg.boss });
        break;
      case 'allyPos':
        // update server clock estimate using server receive time
        if (typeof msg.svt === 'number') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const sample = msg.svt - now; // serverNowMs - perfNow
          // EWMA smoothing; first sample snaps
          if (!state._svtSmoothed) { state._svtOffsetMs = sample; state._svtSmoothed = true; }
          else { state._svtOffsetMs = state._svtOffsetMs + (sample - state._svtOffsetMs) * 0.08; }
        }
        if (!state.me || msg.playerId === state.me.playerId) break;
        const nowArr = performance.now();
        const prev = state.allies[msg.playerId] || {};
        const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
        const rawX = parseNumber(msg.x);
        const rawY = parseNumber(msg.y);
        const prevX = Number.isFinite(prev.x) ? prev.x : Number.NaN;
        const prevY = Number.isFinite(prev.y) ? prev.y : Number.NaN;
        const nx = Number.isFinite(rawX) ? rawX : prevX;
        const ny = Number.isFinite(rawY) ? rawY : prevY;
        const fallbackFields = [];
        if (!Number.isFinite(rawX) && Number.isFinite(prevX)) fallbackFields.push('x');
        if (!Number.isFinite(rawY) && Number.isFinite(prevY)) fallbackFields.push('y');
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
          console.warn('[allyPos] Ignoring update with invalid coordinates', { playerId: msg.playerId, x: msg?.x, y: msg?.y });
          break;
        }
        if (fallbackFields.length > 0) {
          console.warn('[allyPos] Fallback applied for ally fields', { playerId: msg.playerId, fields: fallbackFields, raw: { x: msg?.x, y: msg?.y } });
        }
        const a = { ...prev, x: nx, y: ny, tx: nx, ty: ny, sx: (prev.sx !== undefined ? prev.sx : nx), sy: (prev.sy !== undefined ? prev.sy : ny), alive: msg.alive !== false, hp: typeof msg.hp === 'number' ? msg.hp : prev.hp, maxHp: typeof msg.maxHp === 'number' ? msg.maxHp : prev.maxHp, armor: typeof msg.armor === 'number' ? msg.armor : prev.armor, maxArmor: typeof msg.maxArmor === 'number' ? msg.maxArmor : prev.maxArmor, name: msg.name || (state.room?.members.find(m => m.id === msg.playerId)?.name) || 'ALLY', t: nowArr, ts: typeof msg.ts === 'number' ? msg.ts : (prev.ts ?? 0), svt: typeof msg.svt === 'number' ? msg.svt : (prev.svt ?? 0), elem: msg.elem !== undefined ? msg.elem : prev.elem, revivedOnce: msg.revived === true ? true : prev.revivedOnce };
        state.allies[msg.playerId] = a;
        break;
      case 'allyExp':
        if (msg.playerId === state.me?.playerId) break;
        if (!msg.playerId) break;
        const ally = state.allies[msg.playerId] = state.allies[msg.playerId] || {};
        if (typeof msg.lvl === 'number') ally.lvl = msg.lvl;
        if (typeof msg.exp === 'number') ally.exp = msg.exp;
        break;
      case 'allyDead':
        if (!state.me || msg.playerId === state.me.playerId) break;
        state.allies[msg.playerId] = state.allies[msg.playerId] || { x: 0, y: 0, name: (state.room?.members.find(m => m.id === msg.playerId)?.name) || 'ALLY', t: performance.now() };
        state.allies[msg.playerId].alive = false;
        break;
      case 'heal':
        if (msg.playerId === state.me?.playerId) {
          if (state.stats.alive && typeof msg.hp === 'number') state.stats.hp = msg.hp;
        } else {
          const ally = state.allies[msg.playerId] = state.allies[msg.playerId] || {};
          if (ally.alive !== false && typeof msg.hp === 'number') ally.hp = msg.hp;
        }
        break;
      case 'stun': {
        const en = enemies.find(e => e.id === msg.id);
        if (en) en.stun = Math.max(en.stun || 0, msg.dur || 0);
        break;
      }
      case 'attr':
        if (msg.playerId === state.me?.playerId) {
          if (msg.elem) {
            if (Number.isFinite(msg.elemStage)) {
              gainPlayerElement(msg.elem, { playSfx: false, toast: false, adjustStage: false, forcedStage: msg.elemStage });
            } else {
              gainPlayerElement(msg.elem, { playSfx: false, toast: false });
            }
          } else {
            gainPlayerElement(null, { playSfx: false, toast: false });
          }
        } else {
          state.allies[msg.playerId] = state.allies[msg.playerId] || {};
          state.allies[msg.playerId].elem = msg.elem || null;
        }
        break;
      case 'rewardArea': {
        const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
        const rawX = parseNumber(msg.x);
        const rawY = parseNumber(msg.y);
        const rawR = msg.r == null ? 80 : parseNumber(msg.r);
        if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawR)) {
          console.warn('[rewardArea] Ignoring update with invalid values', { x: msg?.x, y: msg?.y, r: msg?.r });
          break;
        }
        rewardArea = { x: rawX, y: rawY, r: rawR };
        showToast('報酬エリアが出現！');
        try { Audio?.playSfx?.(state, 'alert'); } catch { }
        break;
      }
      case 'pause': {
        const eventId = resolvePauseId(msg.playerId, msg.privateId);
        if (eventId === state.me?.playerId && !state.pauseBy.has(eventId)) {
          if (!hasActiveLocalPauseUi()) {
            requestSelfResume(msg?.token ?? null, 'server-echo');
          }
          // レベルアップ直後などで resume が先に届いた過去の pause を無視して、敵が再開しない状態を防ぐ。
          break;
        }
        if (eventId) markPause(eventId, msg.privateId, msg.token);
        break;
      }
      case 'resume':
        clearPause(msg.playerId, msg.privateId, msg.token);
        break;
      case 'result': {
        if (state._hasPersonalResult) break;
        const pr = state._pendingPersonalResult;
        // 統一クリーンアップ
        const poisonDamageTaken = state._poisonDamageTaken;
        const melonPanConsumed = state._melonPanConsumed;
        const runHpHalfActive = state._runHpHalfActive;
        cleanupBattle('serverResult');
        state._poisonDamageTaken = poisonDamageTaken;
        state._melonPanConsumed = melonPanConsumed;
        state._runHpHalfActive = runHpHalfActive;
        const dur = pr?.dur ?? Math.round(state._timeAlive || 0);
        const ks = pr?.ks ?? (state._kills || 0);
        showPersonalResult(dur, ks);
        state._pendingPersonalResult = null;
        const base = state._resultStatsBaseText || '';
        const appended = base ? `${base}\nゲーム終了（全員倒れました）` : 'ゲーム終了（全員倒れました）';
        setResultStatsBaseText(appended);
        try { if (state.room && Array.isArray(state.room.members)) { state.room.members.forEach(m => { m.ready = false; if (m.dead) delete m.dead; }); state.room.status = 'room'; updateRoomUI(); } } catch { }
        break;
      }
      case 'backToRoom':
        // 統一クリーンアップ
        cleanupBattle('backToRoom');
        try { if (state.room && Array.isArray(state.room.members)) { state.room.members.forEach(m => { m.ready = false; if (m.dead) delete m.dead; }); state.room.status = 'room'; updateRoomUI(); } } catch { }
        resetRoomItems();
        setScreen('room');
        showToast('部屋に戻りました');
        break;
      case 'roomClosed':
        showToast('部屋が解散されました');
        cleanupBattle('roomClosed');
        resetRoomItems();
        state.room = null; state.me = null; state.sse?.close(); stopHeartbeat(); setScreen('lobby'); updateIgnitionControls();
        break;
    }
  }

  // Floating numbers helpers
  let dmgContainer = document.getElementById('vlg-dmg-container');
  if (!dmgContainer) {
    dmgContainer = document.createElement('div');
    dmgContainer.id = 'vlg-dmg-container';
    Object.assign(dmgContainer.style, { position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none', zIndex: 1000 });
    document.body.appendChild(dmgContainer);
  }
  const DMG_POOL_SIZE = 64;
  const dmgPool = [];
  const dmgCanvasRectCache = { rect: null, canvas: null, observer: null, dirty: true, lastWidth: null, lastHeight: null };
  const markCanvasRectDirty = () => { dmgCanvasRectCache.dirty = true; };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', markCanvasRectDirty);
  }
  function ensureCanvasObserver(cvs) {
    if (!cvs) return;
    if (dmgCanvasRectCache.canvas !== cvs) {
      if (dmgCanvasRectCache.observer && typeof dmgCanvasRectCache.observer.disconnect === 'function') {
        dmgCanvasRectCache.observer.disconnect();
      }
      dmgCanvasRectCache.observer = null;
      dmgCanvasRectCache.canvas = cvs;
      dmgCanvasRectCache.rect = null;
      dmgCanvasRectCache.dirty = true;
      dmgCanvasRectCache.lastWidth = cvs.width;
      dmgCanvasRectCache.lastHeight = cvs.height;
      if (typeof ResizeObserver === 'function') {
        try {
          dmgCanvasRectCache.observer = new ResizeObserver(() => { dmgCanvasRectCache.dirty = true; });
          dmgCanvasRectCache.observer.observe(cvs);
        } catch { dmgCanvasRectCache.observer = null; }
      }
    }
    if (dmgCanvasRectCache.lastWidth !== cvs.width || dmgCanvasRectCache.lastHeight !== cvs.height) {
      dmgCanvasRectCache.lastWidth = cvs.width;
      dmgCanvasRectCache.lastHeight = cvs.height;
      dmgCanvasRectCache.dirty = true;
    }
  }
  function getCanvasRectCached(cvs) {
    if (!cvs) return null;
    ensureCanvasObserver(cvs);
    if (dmgCanvasRectCache.dirty || !dmgCanvasRectCache.rect) {
      dmgCanvasRectCache.rect = cvs.getBoundingClientRect();
      dmgCanvasRectCache.dirty = false;
    }
    return dmgCanvasRectCache.rect;
  }
  function createDamageElement() {
    const div = document.createElement('div');
    div.className = 'vlg-dmg-number';
    div._dmgInPool = false;
    div._dmgTicket = 0;
    Object.assign(div.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      pointerEvents: 'none',
      opacity: '0',
      visibility: 'hidden',
      transform: 'translate(-50%, -50%)',
      willChange: 'top, opacity',
    });
    dmgContainer.appendChild(div);
    return div;
  }
  function releaseDamageElement(div, ticket) {
    if (!div || div._dmgInPool) return;
    if (typeof ticket === 'number' && div._dmgTicket !== ticket) return;
    if (div._dmgReleaseTimer) { clearTimeout(div._dmgReleaseTimer); div._dmgReleaseTimer = null; }
    if (div._dmgRaf) { cancelAnimationFrame(div._dmgRaf); div._dmgRaf = null; }
    div.textContent = '';
    div.style.transition = 'none';
    div.style.visibility = 'hidden';
    div.style.opacity = '0';
    div.style.textShadow = '';
    div.style.webkitTextStroke = '';
    div.style.webkitTextFillColor = '';
    div.style.transform = 'translate(-50%, -50%)';
    div._dmgInPool = true;
    dmgPool.push(div);
  }
  function acquireDamageElement() {
    let div = dmgPool.pop();
    if (!div) {
      div = createDamageElement();
    } else {
      div._dmgInPool = false;
    }
    if (div._dmgReleaseTimer) { clearTimeout(div._dmgReleaseTimer); div._dmgReleaseTimer = null; }
    if (div._dmgRaf) { cancelAnimationFrame(div._dmgRaf); div._dmgRaf = null; }
    div.style.visibility = 'visible';
    return div;
  }
  function resetDamageNumberPool() {
    if (!dmgContainer) {
      dmgContainer = document.getElementById('vlg-dmg-container') || dmgContainer;
    }
    if (!dmgContainer) return;
    try {
      const children = Array.from(dmgContainer.children);
      for (const div of children) {
        if (div._dmgReleaseTimer) { clearTimeout(div._dmgReleaseTimer); div._dmgReleaseTimer = null; }
        if (div._dmgRaf) { cancelAnimationFrame(div._dmgRaf); div._dmgRaf = null; }
        div._dmgInPool = false;
        releaseDamageElement(div);
      }
      dmgContainer.innerHTML = '';
    } catch {
      dmgContainer.innerHTML = '';
    }
    dmgPool.length = 0;
    for (let i = 0; i < DMG_POOL_SIZE; i++) {
      releaseDamageElement(createDamageElement());
    }
  }
  resetDamageNumberPool();
  function spawnDamageNumber(x, y, text, opts = {}) {
    // ゲーム外は原則生成しない（ただしopts.allowOutsideGameで例外許可）
    if (!state.inGame && !opts.allowOutsideGame) return;
    if (!state.settings.damageNumbers) return;
    const cvs = $('#gameCanvas'); if (!cvs) return;
    const rect = getCanvasRectCached(cvs);
    // 非表示キャンバス（幅/高さ0）の場合は生成しない（左上に出る誤表示対策）
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const screen = { x: cvs.width / 2 + (x - state.camera.x), y: cvs.height / 2 + (y - state.camera.y) };
    const scaleX = rect.width / cvs.width; const scaleY = rect.height / cvs.height;
    const div = acquireDamageElement();
    const ticket = (div._dmgTicket || 0) + 1;
    div._dmgTicket = ticket;
    div.textContent = text;
    const rise = opts.rise ?? 20; const dur = opts.dur ?? 650;
    const transitionDur = Math.max(200, dur - 50);
    let color = opts.color || '#ff4545';
    let weight = opts.weight || '800';
    let shadow = opts.shadow || '0 1px 0 #0008';
    let stroke = opts.stroke || '';
    let scale = 1;
    const num = parseFloat(String(text).replace(/[^0-9.-]/g, ''));
    if (!isNaN(num)) {
      const abs = Math.abs(num);
      if (abs >= 400) {
        if (!opts.color) color = '#facc15';
        if (!opts.shadow) shadow = '0 0 6px #facc15';
        if (!opts.weight) weight = '900';
        if (!opts.stroke) stroke = '2px #000';
        scale = 1.5;
      } else if (abs >= 100) {
        if (!opts.color) color = '#fb923c';
        if (!opts.shadow) shadow = '0 0 3px #fb923c';
        if (!opts.stroke) stroke = '1px #000';
        scale = 1.2;
      }
    }
    Object.assign(div.style, {
      position: 'fixed',
      left: `${rect.left + screen.x * scaleX}px`,
      top: `${rect.top + screen.y * scaleY}px`,
      transform: `translate(-50%, -50%) scale(${scale})`,
      color,
      fontWeight: weight,
      textShadow: shadow,
      transition: 'none',
      opacity: '1',
      pointerEvents: 'none',
    });
    if (stroke) {
      div.style.webkitTextStroke = stroke;
      // ストローク適用時に文字色が黒くなる問題への対策
      div.style.webkitTextFillColor = color;
    } else {
      div.style.webkitTextStroke = '';
      div.style.webkitTextFillColor = '';
    }
    const targetTop = `${rect.top + (screen.y - rise) * scaleY}px`;
    div._dmgRaf = requestAnimationFrame(() => {
      if (div._dmgTicket !== ticket) return;
      div.style.transition = `all ${transitionDur}ms ease-out`;
      div._dmgRaf = requestAnimationFrame(() => {
        if (div._dmgTicket !== ticket) return;
        div.style.top = targetTop;
        div.style.opacity = '0';
        div._dmgRaf = null;
      });
    });
    div._dmgReleaseTimer = setTimeout(() => releaseDamageElement(div, ticket), dur);
  }
  function spawnHealNumber(x, y, amount) { spawnDamageNumber(x, y, `+${amount}`, { color: '#22c55e', shadow: '0 1px 0 #000a', weight: '800', allowOutsideGame: true }); }
  function spawnCardEffect(x, y, name) { spawnDamageNumber(x, y, `カード: ${name}`, { color: '#f0abfc', shadow: '0 0 6px #f0abfc', weight: '800', allowOutsideGame: true, rise: 30, dur: 800 }); }

  // Server-authoritative damage visualization accumulator
  // Accumulates per-enemy damage locally and bursts a single number periodically
  const __svDmgAcc = new Map(); // enemyId -> { acc, x, y, last }
  function accumServerDamage(eid, amount, x, y) {
    if (!eid || !isFinite(amount) || amount <= 0) return;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const it = __svDmgAcc.get(eid) || { acc: 0, x, y, last: now };
    it.acc += amount; it.x = x; it.y = y; it.last = it.last || now; __svDmgAcc.set(eid, it);
  }
  function flushServerDamage(now = (typeof performance !== 'undefined') ? performance.now() : Date.now()) {
    for (const [eid, it] of __svDmgAcc) {
      if ((now - (it.last || 0)) > 250 && it.acc >= 0.9) {
        try { spawnDamageNumber(it.x, it.y, '-' + Math.round(it.acc)); } catch { }
        it.acc = 0; it.last = now; __svDmgAcc.set(eid, it);
      }
    }
  }

  // Countdown overlay synced with server time before game loop starts
  function startCountdown(targetMs, onDone) {
    const startAt = state.serverGameStartAtSec;
    if (startCountdown._timer) clearTimeout(startCountdown._timer);
    startCountdown._timer = setTimeout(() => {
      if (!state.inGame || state.serverGameStartAtSec !== startAt) return;
      const overlay = document.createElement('div');
      overlay.id = 'vlg-start-countdown';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.3)', color: '#fff', fontSize: '72px', fontWeight: 'bold',
        textShadow: '0 2px 4px #000', zIndex: 2500, pointerEvents: 'none'
      });
      document.body.appendChild(overlay);
      let last = 0;
      function step() {
        const now = performance.now();
        const remain = Math.ceil((targetMs - now) / 1000);
        if (remain > 0) {
          if (remain !== last) {
            last = remain;
            overlay.textContent = remain;
            try { Audio?.playSfx?.(state, 'ui'); } catch { }
          }
          startCountdown._raf = requestAnimationFrame(step);
        } else {
          overlay.textContent = 'スタート!';
          try { Audio?.playSfx?.(state, 'start'); } catch { }
          setTimeout(() => { try { overlay.remove(); } catch { } if (onDone) onDone(); }, 300);
        }
      }
      startCountdown._raf = requestAnimationFrame(step);
    }, 2000);
  }
  startCountdown._timer = null;
  startCountdown._raf = null;

  // Minimal local game loop (ported)
  function startLocalGameLoop() {
    const cvs = $('#gameCanvas');
    if (!cvs || typeof cvs.getContext !== 'function') {
      console.error('Failed to acquire game canvas element or unsupported context API.');
      try { showToast('ゲーム画面の初期化に失敗しました。ブラウザの設定をご確認ください。', 'error', 6000); } catch { }
      return;
    }
    const ctx2d = cvs.getContext('2d');
    if (!ctx2d) {
      console.error('Failed to acquire 2D rendering context for the game canvas.');
      try { showToast('ゲーム描画の準備に失敗しました。2Dコンテキストが利用できません。', 'error', 6000); } catch { }
      return;
    }
    const drawScale = state.isMobile ? 2 : 1;
    try { cvs.setAttribute('tabindex', '0'); cvs.focus(); } catch { }
    let raf = 0; let t0 = performance.now(); let timeAlive = 0; let kills = 0;
    state._activeTimeouts = [];
    function registerActiveTimeout(revert, ms) {
      const id = setTimeout(() => {
        try { revert(); } finally {
          const idx = state._activeTimeouts.findIndex(t => t.id === id);
          if (idx >= 0) state._activeTimeouts.splice(idx, 1);
        }
      }, ms);
      state._activeTimeouts.push({ id, revert });
      return id;
    }
    state._timeAlive = 0; state._kills = 0; state._raf = 0; state._pickedMoney = 0; state._melonPanConsumed = 0;
    // clear any lingering personal result timer from a previous session
    try { clearTimeout(showPersonalResult._t); } catch { }
    showPersonalResult._t = 0;
    // apply purchased permanent perks to base stats
    const baseHp = (100 + (state.perks.hp || 0) * 12) * (state.perks.hphalf ? 0.5 : 1);
    const baseAtk = 10 + (state.perks.atk || 0) * 2;
    const spdBonus = 1 + (state.perks.spd || 0) * 0.05; // +5% each
    const cdrMul = Math.pow(0.93, state.perks.cdr || 0); // 約-7%間隔×段階
    const bossDmgMul = 1 + (state.perks.boss || 0) * 0.05;
    const dmgTakenMul = Math.pow(DAMAGE_REDUCTION_STEP, state.perks[DAMAGE_REDUCTION_KEY] || 0);
    state.stats = { hp: baseHp, maxHp: baseHp, atk: baseAtk, exp: 0, lvl: 1, nextExp: 10, alive: true, elem: null, elemStage: 0, expRange: 80, bossDmgMul, armor: 0, maxArmor: 0, dmgTakenMul, baseArmor: 0 };
    state.upgradeCounts = {};
    state.pendingLvls = 0;
    state.deck = [];
    state.activeCardEffects = [];
    state.cardOrbRareMul = 1;
    state.cardHealOnUse = 0;
    state.cardEaterUsedThisBattle = false;
    ensureRunExcludedLevelUps().clear();
    ensureRunExcludedCards().clear();
    function refreshCardDeck() {
      if (!cardDeckEl) return;
      if (!state.cardShopUnlocked) {
        cardDeckEl.classList.add('hidden');
        cardDeckEl.innerHTML = '';
        return;
      }
      cardDeckEl.classList.remove('hidden');
      cardDeckEl.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const card = state.deck[i];
        const slot = document.createElement('div');
        slot.className = 'slot';
        slot.textContent = card ? `${i + 1}: ${card.name}` : `${i + 1}: -`;
        if (card) {
          slot.style.cursor = 'pointer';
          addListener(slot, 'click', () => useCardAt(i));
        }
        cardDeckEl.appendChild(slot);
      }
    }
    function refreshCardBuffs() {
      if (!hudCardBuffs) return;
      hudCardBuffs.innerHTML = '';
      if (state.activeCardEffects.length === 0) {
        hudCardBuffs.classList.add('hidden');
        return;
      }
      const head = document.createElement('div');
      head.className = 'buffs-heading';
      head.textContent = 'カード効果発動中';
      hudCardBuffs.appendChild(head);
      state.activeCardEffects.forEach(e => {
        const row = document.createElement('div');
        row.className = 'card-buff';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = e.name;
        const bar = document.createElement('div');
        bar.className = 'bar';
        const fill = document.createElement('div');
        fill.className = 'fill';
        bar.appendChild(fill);
        row.appendChild(label);
        row.appendChild(bar);
        hudCardBuffs.appendChild(row);
        e.el = fill;
        e.dur ??= e.ttl;
      });
      hudCardBuffs.classList.remove('hidden');
    }
    const stageName = state.room?.stage || 'メロンパン広場';
    const stage = stageDefs[stageName] || stageDefs['メロンパン広場'];
    const isSnowStage = stageName === 'メロンパン氷山';
    const snowflakes = [];
    const SNOWFLAKE_COUNT = isSnowStage ? (state.isMobile ? 80 : 150) : 0;
    const SNOWFLAKE_MIN_SPEED = 45;
    const SNOWFLAKE_MAX_SPEED = 110;
    const SNOWFLAKE_MIN_RADIUS = 1.1;
    const SNOWFLAKE_MAX_RADIUS = 2.6;
    const SNOWFLAKE_SPAWN_MARGIN = 64;
    function resetSnowflake(flake, fromTop = false) {
      const width = Math.max(1, cvs?.width || 0);
      const height = Math.max(1, cvs?.height || 0);
      flake.baseX = Math.random() * (width + SNOWFLAKE_SPAWN_MARGIN * 2) - SNOWFLAKE_SPAWN_MARGIN;
      flake.y = fromTop ? -Math.random() * (height * 0.3 + 40) : Math.random() * height;
      flake.radius = SNOWFLAKE_MIN_RADIUS + Math.random() * (SNOWFLAKE_MAX_RADIUS - SNOWFLAKE_MIN_RADIUS);
      flake.speed = SNOWFLAKE_MIN_SPEED + Math.random() * (SNOWFLAKE_MAX_SPEED - SNOWFLAKE_MIN_SPEED);
      flake.swayRange = 14 + Math.random() * 26;
      flake.swaySpeed = 0.6 + Math.random() * 1.3;
      flake.swayPhase = Math.random() * Math.PI * 2;
      flake.wind = (Math.random() * 2 - 1) * 14;
    }
    if (isSnowStage) {
      for (let i = 0; i < SNOWFLAKE_COUNT; i++) {
        const flake = {};
        resetSnowflake(flake, false);
        snowflakes.push(flake);
      }
    }
    function updateSnowflakes(dt) {
      if (!isSnowStage || SNOWFLAKE_COUNT <= 0) return;
      const width = Math.max(1, cvs?.width || 0);
      const height = Math.max(1, cvs?.height || 0);
      const wrapWidth = width + SNOWFLAKE_SPAWN_MARGIN * 2;
      while (snowflakes.length < SNOWFLAKE_COUNT) {
        const flake = {};
        resetSnowflake(flake, true);
        snowflakes.push(flake);
      }
      for (const flake of snowflakes) {
        flake.swayPhase = (flake.swayPhase + flake.swaySpeed * dt) % (Math.PI * 2);
        flake.y += flake.speed * dt;
        flake.baseX += flake.wind * dt;
        if (height > 0 && flake.y - flake.radius > height) {
          resetSnowflake(flake, true);
          continue;
        }
        if (wrapWidth > 0) {
          if (flake.baseX < -SNOWFLAKE_SPAWN_MARGIN) {
            flake.baseX += wrapWidth;
          } else if (flake.baseX > width + SNOWFLAKE_SPAWN_MARGIN) {
            flake.baseX -= wrapWidth;
          }
        }
      }
    }
    const slipperyCellSize = 80;
    const poisonCellSize = 80;
    // chunkSz is used by obstacle/pad generation and lookup functions.
    // Initialize it early to avoid TDZ when those functions are invoked
    // before later declarations are processed.
    const chunkSz = stage.chunk || 320;
    const NORMAL_FLOOR_COLOR =
      stageName === 'メロンパン迷宮' ? '#ffffdd'
        : stageName === 'メロンパン工業地帯' ? '#ffffdd'
          : '#f5e6c9';
    const ICE_FLOOR_COLOR = '#eaf2ff';
    const POISON_FLOOR_COLOR = '#4b145b';
    const POISON_SAFE_COLOR = '#34263d';
    const poisonTileVariants = stage.poison ? createPoisonTileVariants(poisonCellSize) : [];
    const POISON_PHASE_BUCKETS = 64;
    const poisonPhaseAngles = stage.poison ? new Float32Array(POISON_PHASE_BUCKETS) : null;
    const poisonPhaseValues = stage.poison ? new Float32Array(POISON_PHASE_BUCKETS) : null;
    if (poisonPhaseAngles && poisonPhaseValues) {
      for (let i = 0; i < POISON_PHASE_BUCKETS; i++) {
        poisonPhaseAngles[i] = (i / POISON_PHASE_BUCKETS) * Math.PI * 2;
        poisonPhaseValues[i] = 0.5;
      }
    }
    const poisonCellCache = stage.poison ? new Map() : null;
    const poisonContaminationCache = stage.poison ? new Map() : null;
    const POISON_NEIGHBOR_OFFSETS = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, 0.5], [-1, 1, 0.5], [1, -1, 0.5], [-1, -1, 0.5],
    ];

    // Obstacle/pad chunk helpers (must be defined before any spawn that queries nearby obstacles)
    let obsByChunk = new Map();
    function keyOf(cx, cy) { return cx + ',' + cy; }
    const CHUNK_CACHE_RADIUS = stage.chunkCacheRadius ?? 6;
    const CHUNK_CACHE_MAX = stage.chunkCacheLimit ?? Math.max(((CHUNK_CACHE_RADIUS * 2) + 1) ** 2, 256);
    function pruneChunkCache(cache) {
      if (!cache || cache.size === 0) return;
      const camX = state?.camera?.x;
      const camY = state?.camera?.y;
      const camCx = Number.isFinite(camX) && chunkSz ? Math.floor(camX / chunkSz) : 0;
      const camCy = Number.isFinite(camY) && chunkSz ? Math.floor(camY / chunkSz) : 0;
      const keysToRemove = [];
      for (const key of cache.keys()) {
        const idx = key.indexOf(',');
        if (idx === -1) continue;
        const cx = Number.parseInt(key.slice(0, idx), 10);
        const cy = Number.parseInt(key.slice(idx + 1), 10);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        if (Math.abs(cx - camCx) > CHUNK_CACHE_RADIUS || Math.abs(cy - camCy) > CHUNK_CACHE_RADIUS) {
          keysToRemove.push(key);
        }
      }
      if (keysToRemove.length) {
        for (const key of keysToRemove) cache.delete(key);
      }
      if (cache.size > CHUNK_CACHE_MAX) {
        let removeCount = cache.size - CHUNK_CACHE_MAX;
        for (const key of cache.keys()) {
          cache.delete(key);
          removeCount--;
          if (removeCount <= 0) break;
        }
      }
    }
    let iceBlocks = [];
    function placeIceBlock(x, y) {
      const size = 32;
      iceBlocks.push({ x: x - size / 2, y: y - size / 2, w: size, h: size, hp: 40 });
    }
    function seeded(cx, cy, n = 1) {
      let h = Math.imul(cx, 73856093);
      h = (h ^ Math.imul(cy, 19349663)) | 0;
      h = (h ^ Math.imul(n, 83492791)) | 0;
      h = (h ^ (h << 13)) | 0;
      h = (h ^ (h >> 17)) | 0;
      h = (h ^ (h << 5)) | 0;
      const u = h >>> 0;
      return u / 0xffffffff;
    }
    if (stage.iceBlocks) {
      const count = 60;
      const radius = (stage.radius || 600) - 16;
      for (let i = 0; i < count; i++) {
        const ang = seeded(i, 0) * Math.PI * 2;
        const dist = seeded(i, 1) * radius;
        placeIceBlock(Math.cos(ang) * dist, Math.sin(ang) * dist);
      }
    }
    function genChunk(cx, cy) {
      const k = keyOf(cx, cy); if (obsByChunk.has(k)) return obsByChunk.get(k);
      const rects = [];
      if (stage.type === 'maze') {
        const baseX = cx * chunkSz, baseY = cy * chunkSz; const count = 1 + Math.floor(seeded(cx, cy) * 3);
        for (let i = 0; i < count; i++) { const rx = baseX + 20 + seeded(cx, cy, i + 1) * (chunkSz - 60); const ry = baseY + 20 + seeded(cx + 11, cy - 7, i + 2) * (chunkSz - 60); const rw = 60 + seeded(cx - 3, cy + 5, i + 3) * 160; const rh = 40 + seeded(cx + 9, cy + 13, i + 4) * 140; rects.push({ x: rx | 0, y: ry | 0, w: rw | 0, h: rh | 0 }); }
      }
      obsByChunk.set(k, rects); return rects;
    }
    function getNearbyObstacles(px, py) {
      const cx = Math.floor(px / chunkSz), cy = Math.floor(py / chunkSz);
      const res = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          res.push(...genChunk(cx + dx, cy + dy));
      pruneChunkCache(obsByChunk);
      if (stage.iceBlocks) res.push(...iceBlocks);
      return res;
    }
    // Circle vs AABB collision helper (used in many spawn/movement checks)
    function circleRectCollide(cx, cy, cr, r) {
      // find closest point on rect to circle center
      const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
      const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
      const dx = cx - nx, dy = cy - ny;
      return dx * dx + dy * dy < cr * cr;
    }
    let padsByChunk = new Map();
    function seededPad(cx, cy, n = 1) { return seeded(cx, cy, n + 1000); }
    function genPadChunk(cx, cy) {
      const k = keyOf(cx, cy); if (padsByChunk.has(k)) return padsByChunk.get(k);
      const pads = [];
      if (stage.jumpPad) {
        const baseX = cx * chunkSz, baseY = cy * chunkSz;
        if (seededPad(cx, cy) < 0.3) {
          const px = baseX + 40 + seededPad(cx, cy, 2) * (chunkSz - 80);
          const py = baseY + 40 + seededPad(cx, cy, 3) * (chunkSz - 80);
          const dir = Math.floor(seededPad(cx, cy, 4) * 4);
          const dirs = [{ x: 1, y: 0, arrow: '→' }, { x: -1, y: 0, arrow: '←' }, { x: 0, y: 1, arrow: '↓' }, { x: 0, y: -1, arrow: '↑' }];
          const d = dirs[dir] || dirs[0];
          pads.push({ x: px | 0, y: py | 0, dx: d.x, dy: d.y, arrow: d.arrow, r: 16, dist: 360 });
        }
      }
      padsByChunk.set(k, pads); return pads;
    }
    function getNearbyPads(px, py) {
      const cx = Math.floor(px / chunkSz), cy = Math.floor(py / chunkSz);
      const res = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          res.push(...genPadChunk(cx + dx, cy + dy));
      pruneChunkCache(padsByChunk);
      return res;
    }

    function slipperySeed(cx, cy) {
      let n = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) | 0;
      n = Math.imul(n ^ (n >> 13), 1274126177);
      return ((n ^ (n >> 16)) >>> 0) / 0xffffffff;
    }
    function isSlipperyCell(cx, cy) {
      return slipperySeed(cx, cy) < (stage.slipperyFrac ?? 1);
    }
    function isSlipperyAt(x, y) {
      if (!stage.slippery) return false;
      if (stage.slipperyFrac == null) return true;
      return isSlipperyCell(Math.floor(x / slipperyCellSize), Math.floor(y / slipperyCellSize));
    }
    function poisonSeed(cx, cy, variant = 0) {
      let seed = (Math.imul(cx, 1234567) + Math.imul(cy, 891011) + Math.imul(variant, 198491317)) | 0;
      seed = Math.imul(seed ^ (seed >> 13), 1274126177);
      return ((seed ^ (seed >> 16)) >>> 0) / 0xffffffff;
    }
    function createRng(seed) {
      let s = (seed >>> 0) || 1;
      return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function createPoisonTileVariants(size) {
      const count = 12;
      const tiles = [];
      for (let i = 0; i < count; i++) {
        const tile = createPoisonTile(size, i + 1);
        if (tile) tiles.push(tile);
      }
      return tiles;
    }
    function createPoisonTile(size, variant) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = size;
      const ctx = tile.getContext('2d');
      if (!ctx) return tile;
      const rng = createRng(0x9e3779b9 ^ (variant * 0x85ebca6b));
      const centerX = size * (0.3 + rng() * 0.4);
      const centerY = size * (0.3 + rng() * 0.4);
      const outerR = size * (0.55 + rng() * 0.25);
      const innerR = outerR * (0.25 + rng() * 0.2);
      const grad = ctx.createRadialGradient(centerX, centerY, innerR, centerX, centerY, outerR);
      grad.addColorStop(0, '#a05fff');
      grad.addColorStop(0.45, '#5e1a7c');
      grad.addColorStop(1, '#16031c');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      const swirlCount = 3 + Math.floor(rng() * 4);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < swirlCount; i++) {
        ctx.beginPath();
        ctx.moveTo(size * rng(), size * rng());
        ctx.bezierCurveTo(size * rng(), size * rng(), size * rng(), size * rng(), size * rng(), size * rng());
        ctx.lineWidth = 2 + rng() * 3;
        const alpha = 0.05 + rng() * 0.05;
        ctx.strokeStyle = `rgba(${80 + rng() * 40}, ${180 + rng() * 60}, ${200 + rng() * 40}, ${alpha})`;
        ctx.stroke();
      }
      const spotCount = 18 + Math.floor(rng() * 6);
      for (let i = 0; i < spotCount; i++) {
        const r = size * (0.008 + rng() * 0.02);
        const x = size * rng();
        const y = size * rng();
        ctx.fillStyle = `rgba(${90 + rng() * 80}, ${150 + rng() * 80}, ${255}, ${0.04 + rng() * 0.06})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      const edgeGrad = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.72);
      edgeGrad.addColorStop(0, 'rgba(0,0,0,0)');
      edgeGrad.addColorStop(1, 'rgba(10,0,20,0.55)');
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(0, 0, size, size);
      return tile;
    }
    function smoothstep(t) {
      return t * t * (3 - 2 * t);
    }
    function poisonValueNoise(x, y, scale, variant = 0) {
      const sx = x * scale;
      const sy = y * scale;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const wx = smoothstep(Math.max(0, Math.min(1, fx)));
      const wy = smoothstep(Math.max(0, Math.min(1, fy)));
      const v00 = poisonSeed(ix, iy, variant);
      const v10 = poisonSeed(ix + 1, iy, variant);
      const v01 = poisonSeed(ix, iy + 1, variant);
      const v11 = poisonSeed(ix + 1, iy + 1, variant);
      const vx0 = v00 + (v10 - v00) * wx;
      const vx1 = v01 + (v11 - v01) * wx;
      return vx0 + (vx1 - vx0) * wy;
    }
    function poisonFractalNoise(x, y, scales, weights, variantBase = 0) {
      if (!Array.isArray(scales) || !scales.length) return 0.5;
      let total = 0;
      let weightSum = 0;
      for (let i = 0; i < scales.length; i++) {
        const scale = scales[i];
        if (!(scale > 0)) continue;
        const weight = (weights && weights[i] != null ? weights[i] : 1);
        total += poisonValueNoise(x, y, scale, variantBase + i) * weight;
        weightSum += weight;
      }
      if (!(weightSum > 0)) return 0.5;
      return total / weightSum;
    }
    function getPoisonCellData(cx, cy) {
      if (!stage.poison) {
        const value = poisonSeed(cx, cy);
        return { value, isPoison: false, variant: -1, phaseIdx: 0, bubbleXFactor: 0.5, bubbleYFactor: 0.5, bubbleBaseFactor: 0.22 };
      }
      const key = keyOf(cx, cy);
      let data = poisonCellCache.get(key);
      if (!data) {
        let baseValue = poisonSeed(cx, cy);
        let isPoison;
        if (stage.poisonShape === 'lake') {
          const centerX = (cx + 0.5) * poisonCellSize;
          const centerY = (cy + 0.5) * poisonCellSize;
          const ellipseA = stage.poisonEllipseA || 1500;
          const ellipseB = stage.poisonEllipseB || 1050;
          const nx = centerX / ellipseA;
          const ny = centerY / ellipseB;
          const ellipseScore = 1 - (nx * nx + ny * ny);
          const edgeNoiseStrength = stage.poisonEdgeNoise ?? 0.65;
          const detailNoiseStrength = stage.poisonDetailNoise ?? 0.25;
          const largeNoise = (poisonFractalNoise(centerX, centerY, [0.0025, 0.005, 0.009], [0.6, 0.3, 0.1], 31) - 0.5) * edgeNoiseStrength;
          const detailNoise = (poisonFractalNoise(centerX, centerY, [0.015, 0.032], [0.7, 0.3], 43) - 0.5) * detailNoiseStrength;
          let score = ellipseScore + largeNoise + detailNoise;
          const islandDensity = stage.poisonIslandDensity ?? 0.28;
          if (islandDensity > 0) {
            const cavityNoise = poisonFractalNoise(centerX + 4000, centerY - 7000, [0.01, 0.02], [0.5, 0.5], 59);
            const cavity = cavityNoise - (1 - islandDensity);
            if (cavity > 0) score -= cavity * 0.6;
          }
          isPoison = score > 0;
          baseValue = isPoison ? 0 : 1;
        } else if (stage.poisonShape === 'puddles') {
          const centerX = (cx + 0.5) * poisonCellSize;
          const centerY = (cy + 0.5) * poisonCellSize;
          const gridSize = stage.poisonPuddleGrid || 1600;
          const radiusMin = stage.poisonPuddleRadiusMin || 240;
          const radiusMax = Math.max(radiusMin + 10, stage.poisonPuddleRadiusMax || 780);
          const chance = Math.max(0, Math.min(1, stage.poisonPuddleChance ?? 0.7));
          const maxCount = Math.max(1, Math.floor(stage.poisonPuddleCountMax ?? 2));
          const aspectMin = stage.poisonPuddleAspectMin ?? 0.5;
          const aspectMax = stage.poisonPuddleAspectMax ?? 1.35;
          const radiusBias = stage.poisonPuddleRadiusBias ?? 0.6;
          const threshold = stage.poisonPuddleThreshold ?? 0.05;
          const largeNoiseStrength = stage.poisonPuddleNoise ?? 0.25;
          const detailNoiseStrength = stage.poisonPuddleDetailNoise ?? 0.18;
          const rippleNoiseStrength = stage.poisonPuddleRippleNoise ?? 0.06;
          const blend = Math.max(0, Math.min(1, stage.poisonPuddleBlend ?? 0.35));
          const falloff = Math.max(0.2, stage.poisonPuddleFalloff ?? 1.2);
          const radiusJitter = Math.max(0, stage.poisonPuddleRadiusJitter ?? 0.18);
          const coarseX = Math.floor(centerX / gridSize);
          const coarseY = Math.floor(centerY / gridSize);
          const searchRange = Math.max(1, Math.ceil((radiusMax * 1.6) / gridSize));
          let bestScore = 0;
          let totalScore = 0;
          let totalWeight = 0;
          for (let gy = coarseY - searchRange; gy <= coarseY + searchRange; gy++) {
            for (let gx = coarseX - searchRange; gx <= coarseX + searchRange; gx++) {
              if (poisonSeed(gx, gy, 101) >= chance) continue;
              const puddleCountSeed = poisonSeed(gx, gy, 102);
              const puddleCount = 1 + Math.floor(puddleCountSeed * maxCount);
              for (let i = 0; i < puddleCount; i++) {
                const variantBase = 200 + i * 11;
                const offsetX = (poisonSeed(gx, gy, variantBase) - 0.5) * gridSize * 0.9;
                const offsetY = (poisonSeed(gx, gy, variantBase + 1) - 0.5) * gridSize * 0.9;
                const puddleCenterX = (gx + 0.5) * gridSize + offsetX;
                const puddleCenterY = (gy + 0.5) * gridSize + offsetY;
                const radiusSeed = poisonSeed(gx, gy, variantBase + 2);
                const radiusWeight = Math.pow(radiusSeed, radiusBias);
                const baseMajor = radiusMin + (radiusMax - radiusMin) * radiusWeight;
                const aspectSeed = poisonSeed(gx, gy, variantBase + 3);
                const aspect = aspectMin + aspectSeed * (aspectMax - aspectMin);
                const jitterSeed = poisonSeed(gx, gy, variantBase + 5);
                const jitterMul = 1 + (jitterSeed - 0.5) * radiusJitter * 2;
                const majorRadius = Math.max(radiusMin * 0.6, baseMajor * jitterMul);
                const minorRadius = Math.max(radiusMin * 0.55, majorRadius * aspect);
                const angle = poisonSeed(gx, gy, variantBase + 4) * Math.PI * 2;
                const cosA = Math.cos(angle);
                const sinA = Math.sin(angle);
                const dx = centerX - puddleCenterX;
                const dy = centerY - puddleCenterY;
                const rx = cosA * dx + sinA * dy;
                const ry = -sinA * dx + cosA * dy;
                const dist = Math.sqrt((rx * rx) / (majorRadius * majorRadius) + (ry * ry) / (minorRadius * minorRadius));
                if (!(dist < 1.8)) continue;
                const normalized = Math.max(0, 1 - dist);
                if (!(normalized > 0)) continue;
                const weight = 1 + poisonSeed(gx, gy, variantBase + 6) * 0.35;
                const shaped = Math.pow(normalized, falloff) * weight;
                bestScore = Math.max(bestScore, shaped);
                totalScore += shaped;
                totalWeight += weight;
              }
            }
          }
          if (totalWeight > 0) {
            const avgScore = totalScore / totalWeight;
            let score = bestScore * (1 - blend) + avgScore * blend;
            const largeNoise = (poisonFractalNoise(centerX + 5000, centerY - 4000, [0.0032, 0.0065, 0.011], [0.5, 0.3, 0.2], 73) - 0.5) * largeNoiseStrength;
            const detailNoise = (poisonFractalNoise(centerX - 9000, centerY + 6000, [0.015, 0.032], [0.6, 0.4], 91) - 0.5) * detailNoiseStrength;
            const rippleNoise = (poisonFractalNoise(centerX + 14000, centerY + 2200, [0.065], [1], 127) - 0.5) * rippleNoiseStrength;
            score += largeNoise + detailNoise + rippleNoise;
            isPoison = score > threshold;
            baseValue = Math.max(0, Math.min(1, score));
          } else {
            baseValue = 1;
            isPoison = false;
          }
        } else {
          baseValue = poisonSeed(cx, cy);
          isPoison = baseValue < (stage.poisonFrac ?? 0);
        }
        if (isPoison) {
          const variantCount = poisonTileVariants.length;
          const variant = variantCount > 0 ? Math.floor(poisonSeed(cx, cy, 7) * variantCount) % variantCount : -1;
          const phaseIdx = POISON_PHASE_BUCKETS > 0 ? Math.floor(poisonSeed(cx, cy, 8) * POISON_PHASE_BUCKETS) % POISON_PHASE_BUCKETS : 0;
          const bubbleXFactor = 0.2 + poisonSeed(cx, cy, 9) * 0.6;
          const bubbleYFactor = 0.2 + poisonSeed(cx, cy, 10) * 0.6;
          const bubbleBaseFactor = 0.16 + poisonSeed(cx, cy, 11) * 0.12;
          data = { value: baseValue, isPoison, variant, phaseIdx, bubbleXFactor, bubbleYFactor, bubbleBaseFactor };
        } else {
          data = { value: baseValue, isPoison, variant: -1, phaseIdx: 0, bubbleXFactor: 0.5, bubbleYFactor: 0.5, bubbleBaseFactor: 0.22 };
        }
        poisonCellCache.set(key, data);
      }
      return data;
    }
    function isPoisonCell(cx, cy) {
      if (!stage.poison) return false;
      return getPoisonCellData(cx, cy).isPoison;
    }
    function isPoisonAt(x, y) {
      if (!stage.poison) return false;
      return isPoisonCell(Math.floor(x / poisonCellSize), Math.floor(y / poisonCellSize));
    }
    function poisonNeighborIntensity(cx, cy) {
      if (!stage.poison) return 0;
      const key = keyOf(cx, cy);
      if (poisonContaminationCache && poisonContaminationCache.has(key)) {
        return poisonContaminationCache.get(key);
      }
      let sum = 0;
      for (const [dx, dy, weight] of POISON_NEIGHBOR_OFFSETS) {
        if (isPoisonCell(cx + dx, cy + dy)) sum += weight;
      }
      const intensity = Math.max(0, Math.min(1, sum / 4));
      if (poisonContaminationCache) poisonContaminationCache.set(key, intensity);
      return intensity;
    }
    function drawPoisonTile(ctx, cellSize, cellX, cellY, px, py) {
      const data = getPoisonCellData(cellX, cellY);
      const variantCount = poisonTileVariants.length;
      if (variantCount > 0) {
        const idx = data.variant != null && data.variant >= 0 ? data.variant % variantCount : -1;
        const tile = idx >= 0 ? poisonTileVariants[idx] : null;
        if (tile) {
          ctx.drawImage(tile, px, py, cellSize, cellSize);
        } else {
          ctx.fillStyle = POISON_FLOOR_COLOR;
          ctx.fillRect(px, py, cellSize, cellSize);
        }
      } else {
        ctx.fillStyle = POISON_FLOOR_COLOR;
        ctx.fillRect(px, py, cellSize, cellSize);
      }
      const waveNorm = poisonPhaseValues && data.phaseIdx != null ? (poisonPhaseValues[data.phaseIdx] ?? 0.5) : 0.5;
      ctx.save();
      ctx.globalAlpha = 0.08 + waveNorm * 0.1;
      ctx.fillStyle = '#2d0a35';
      ctx.fillRect(px, py, cellSize, cellSize);
      ctx.restore();
      const bubbleX = px + cellSize * (data.bubbleXFactor ?? 0.5);
      const bubbleY = py + cellSize * (data.bubbleYFactor ?? 0.5);
      const bubbleBase = cellSize * (data.bubbleBaseFactor ?? 0.22);
      const outerR = bubbleBase * (1.2 + waveNorm * 0.6);
      const glow = ctx.createRadialGradient(bubbleX, bubbleY, bubbleBase * 0.1, bubbleX, bubbleY, outerR);
      const innerAlpha = 0.35 + waveNorm * 0.25;
      const midAlpha = 0.25 + waveNorm * 0.15;
      glow.addColorStop(0, `rgba(140, 255, 220, ${innerAlpha})`);
      glow.addColorStop(0.6, `rgba(180, 120, 255, ${midAlpha})`);
      glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bubbleX, bubbleY, outerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = `rgba(200, 140, 255, ${0.12 + waveNorm * 0.18})`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 0.75, py + 0.75, cellSize - 1.5, cellSize - 1.5);
      ctx.restore();
    }
    function starMaxRadius(angle) {
      const outer = stage.radius || 600;
      const inner = stage.innerRadius || outer * 0.5;
      let a = angle % (Math.PI * 2);
      if (a < 0) a += Math.PI * 2;
      const step = Math.PI / 5;
      const seg = Math.floor(a / step);
      const frac = (a - seg * step) / step;
      const r1 = (seg % 2 === 0) ? outer : inner;
      const r2 = (seg % 2 === 0) ? inner : outer;
      return r1 + (r2 - r1) * frac;
    }
    function clampToStar(x, y, r = 0) {
      const ang = Math.atan2(y, x);
      const maxR = starMaxRadius(ang) - r;
      const dist = Math.hypot(x, y);
      if (dist > maxR) {
        return { x: Math.cos(ang) * maxR, y: Math.sin(ang) * maxR };
      }
      return { x, y };
    }
    const RISK_EVENT_TIME = 300;
    const riskEventTimes = [RISK_EVENT_TIME, 550];
    const RISK_AREA_RADIUS = 90;
    const RISK_AREA_DURATION = RISK_REWARD_BASE_DURATION;
    const RISK_EVENT_RETRY_DELAY = 10;
    const RISK_EVENT_MAX_RETRIES = 5;
    const RISK_EVENT_AREA_TYPES = [
      ['exp', 'melon'],
      ['money'],
    ];
    const BARRAGE_BULLET_LIMIT = 180;
    riskChoiceAreas = null;
    riskEventTriggered = false;
    riskEventEffect = null;
    riskActivationPending = false;
    state._riskAreaAckIndex = null;
    let nextRiskEventIdx = 0;
    let nextRiskEventAt = riskEventTimes[nextRiskEventIdx] ?? Infinity;
    let riskEventSpawnRetry = 0;

    const player = { x: 0, y: 0, r: 10, spd: 120 * spdBonus, vx: 0, vy: 0 };
    const REVIVE_DURATION = 10;
    const REVIVE_DISTANCE = Math.max(28, (player.r || 10) + 18);
    function getReviveTargetName(pid, ally) {
      return ally?.name
        || state.room?.members?.find(m => m.id === pid)?.name
        || '味方';
    }
    function handleReviveProgress(deltaTime, isMoving) {
      if (!state.stats.alive) {
        if (state._reviveState) state._reviveState.progress = 0;
        hideReviveGauge();
        return;
      }
      const reviveState = state._reviveState || (state._reviveState = { targetId: null, progress: 0 });
      if (jumpState.active) {
        reviveState.progress = 0;
        hideReviveGauge();
        return;
      }
      let candidateId = null;
      let candidate = null;
      let bestDist = Infinity;
      for (const [pid, ally] of Object.entries(state.allies)) {
        if (!ally || ally.alive !== false) continue;
        if (ally.revivedOnce) continue;
        const ax = Number.isFinite(ally.x) ? ally.x : Number.isFinite(ally.sx) ? ally.sx : null;
        const ay = Number.isFinite(ally.y) ? ally.y : Number.isFinite(ally.sy) ? ally.sy : null;
        if (ax === null || ay === null) continue;
        const dist = Math.hypot(player.x - ax, player.y - ay);
        const reach = REVIVE_DISTANCE + (Number.isFinite(ally.r) ? ally.r * 0.5 : 0);
        if (dist <= reach && dist < bestDist) {
          bestDist = dist;
          candidateId = pid;
          candidate = ally;
        }
      }
      if (!candidateId) {
        reviveState.targetId = null;
        if (reviveState.progress > 0) reviveState.progress = 0;
        hideReviveGauge();
        return;
      }
      if (reviveState.targetId !== candidateId) {
        reviveState.targetId = candidateId;
        reviveState.progress = 0;
      }
      if (isMoving) {
        if (reviveState.progress > 0) reviveState.progress = 0;
        hideReviveGauge();
        return;
      }
      if (state._revivePendingTarget && state._revivePendingTarget !== candidateId) {
        hideReviveGauge();
        return;
      }
      reviveState.progress = Math.min(REVIVE_DURATION, reviveState.progress + deltaTime);
      const ratio = Math.min(1, reviveState.progress / REVIVE_DURATION);
      const remaining = Math.max(0, REVIVE_DURATION - reviveState.progress);
      const allyName = getReviveTargetName(candidateId, candidate);
      const label = remaining > 0
        ? `${allyName} 蘇生中 (${remaining.toFixed(1)}s)`
        : `${allyName} 蘇生完了！`;
      updateReviveGauge(label, ratio);
      if (reviveState.progress >= REVIVE_DURATION && state._revivePendingTarget !== candidateId) {
        state._revivePendingTarget = candidateId;
        sendEvent({ type: 'revive', target: candidateId })
          .catch(() => { state._revivePendingTarget = null; });
      }
    }
    // lastFacing: 'up'|'down'|'left'|'right' - used for character 'U' sprite selection
    let lastFacing = 'down';
    let shield = null;
    const enemies = []; const orbs = []; const projectiles = []; const decoys = [];
    const killFxs = []; // enemy death effects
    const MAX_ORBS = 200;
    const pushOrbRaw = (orb) => {
      if (!orb) return;
      if (orbs.length >= MAX_ORBS) orbs.shift();
      orbs.push(orb);
    };
    const pushOrb = (orb) => {
      if (!orb) return;
      pushOrbRaw(orb);
      if (riskEventEffect?.type === 'exp' && typeof orb.value === 'number') {
        const EXTRA_ORB_COUNT = 2;
        for (let i = 0; i < EXTRA_ORB_COUNT; i++) {
          const extra = { ...orb };
          if (Number.isFinite(extra.x) && Number.isFinite(extra.y)) {
            const ang = Math.random() * Math.PI * 2;
            const dist = 6 + Math.random() * 10;
            extra.x += Math.cos(ang) * dist;
            extra.y += Math.sin(ang) * dist;
          }
          pushOrbRaw(extra);
        }
      }
    };
    const spawnKillFx = (x, y) => {
      killFxs.push({ type: 'ring', x, y, r: 4, ttl: 0.5, max: 0.5 });
      for (let i = 0; i < 6; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 60 + Math.random() * 80;
        killFxs.push({
          type: 'particle',
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 3,
          ttl: 0.4,
          max: 0.4,
        });
      }
    };
    const spawnBomberExplosionFx = (x, y, radius = 56) => {
      const base = Math.max(30, radius);
      killFxs.push({
        type: 'blast',
        x,
        y,
        inner: base * 0.3,
        outer: base,
        targetOuter: base * 1.4,
        growRate: base * 7,
        fadeSpeed: base * 4,
        ttl: 0.35,
        max: 0.35,
        color: '255,140,80',
      });
      killFxs.push({
        type: 'ring',
        x,
        y,
        r: base * 0.7,
        ttl: 0.45,
        max: 0.45,
        growRate: base * 4.5,
        color: 'rgba(255,215,170,0.85)',
      });
      for (let i = 0; i < 12; i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = base * (1.8 + Math.random() * 0.7);
        killFxs.push({
          type: 'particle',
          x,
          y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          r: 4.5,
          ttl: 0.45 + Math.random() * 0.15,
          max: 0.55,
          color: 'rgba(255,170,90,1)',
          shrink: base * 3.2,
        });
      }
    };
    const heals = [];
    const moneys = [];
    const converters = [];
    const cardOrbs = [];
    const atkBoosts = [];
    rewardArea = null;
    riskChoiceAreas = null;
    riskEventTriggered = false;
    riskEventEffect = null;
    riskActivationPending = false;
    state._riskAreaAckIndex = null;
    nextRiskEventIdx = 0;
    nextRiskEventAt = riskEventTimes[nextRiskEventIdx] ?? Infinity;
    riskEventSpawnRetry = 0;
    state._riskEventEffect = null;
    const rewardTimes = [60, 420, 600];
    let nextRewardIdx = 0;
    let nextRewardAt = rewardTimes[nextRewardIdx] ?? Infinity;
    let rewardRetry = 0;
    // 復活後の一時無敵（ダメージ無効化＋オーラ表示）
    let invulnT = 0; const invulnMax = 2.5; // 秒
    refreshCardDeck();
    refreshCardBuffs();
    function useCardAt(idx) {
      if (!state.stats.alive) return;
      const card = state.deck[idx];
      if (!card) return;
      const synergyEnabled = isCardSynergyEnabled();
      let grantCardHealEffect = false;
      let removeCardEaterCopies = false;
      if (card.id.includes('MelonPan')) {
        state.timeSinceLastMelonPan = 0;
      }
      if (card.id === 'deliciousMelonPan') {
        const healAmount = applyHealBonus(20);
        const healed = Math.round(healAmount);
        state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
        try { spawnHealNumber(player.x, player.y, healed); } catch { }
        recordMelonPanConsumption();
      } else if (card.id === 'chocoSauce') {
        let healAmount = applyHealBonus(5);
        let syIdx = -1;
        let partner = null;
        if (synergyEnabled) {
          syIdx = state.deck.findIndex((c, i) => i !== idx && c.attr === card.attr);
          partner = syIdx >= 0 ? state.deck[syIdx] : null;
        }
        if (synergyEnabled && partner && partner.id === 'deliciousMelonPan') {
          state.deck.splice(syIdx, 1);
          if (syIdx < idx) idx--;
          healAmount = applyHealBonus(20 * 3);
          recordMelonPanConsumption();
          state.timeSinceLastMelonPan = 0;
        }
        const prevHp = state.stats.hp;
        state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
        const healed = Math.round(state.stats.hp - prevHp);
        if (healed > 0) {
          try { spawnHealNumber(player.x, player.y, healed); } catch { }
        }
      } else if (card.id === 'speedMelonPan') {
        player.spd *= 1.1;
        state.activeCardEffects.push({ type: 'spd', mul: 1.1, ttl: 30, name: card.name, dur: 30 });
      } else if (card.id === 'fatMelonPan') {
        player.spd *= 0.8;
        state.stats.dmgTakenMul *= 0.8;
        state.activeCardEffects.push({ type: 'spd', mul: 0.8, ttl: 30, name: card.name, dur: 30 });
        state.activeCardEffects.push({ type: 'dmgTakenMul', mul: 0.8, ttl: 30, name: card.name, dur: 30 });
      } else if (card.id === 'redMelonPan') {
        gainPlayerElement('fire');
      } else if (card.id === 'blueMelonPan') {
        gainPlayerElement('ice');
      } else if (card.id === 'yellowMelonPan') {
        gainPlayerElement('lightning');
      } else if (card.id === 'blackMelonPan') {
        gainPlayerElement('dark');
      } else if (card.id === 'hyperSpeedMelonPan') {
        player.spd *= 1.3;
        state.activeCardEffects.push({ type: 'spd', mul: 1.3, ttl: 30, name: card.name, dur: 30 });
      } else if (card.id === 'decoyMelonPan') {
        if (decoys.length < cfg.ando.max) {
          decoys.push({ x: player.x, y: player.y, hp: cfg.ando.hp, maxHp: cfg.ando.hp });
        }
      } else if (card.id === 'superDecoyMelonPan') {
        const spawn = Math.min(10, cfg.ando.max - decoys.length);
        for (let i = 0; i < spawn; i++) {
          const ang = Math.random() * Math.PI * 2;
          const dist = 200 + Math.random() * 200;
          let dx = player.x + Math.cos(ang) * dist;
          let dy = player.y + Math.sin(ang) * dist;
          if (stage.star) { const c = clampToStar(dx, dy, 8); dx = c.x; dy = c.y; }
          if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
            let tries = 12;
            while (tries-- > 0) {
              const obs = getNearbyObstacles(dx, dy);
              let blocked = obs.some(r => circleRectCollide(dx, dy, 8, r));
              if (stage.poison && isPoisonAt(dx, dy)) blocked = true;
              if (!blocked) break;
              const ang2 = Math.random() * Math.PI * 2;
              dx = player.x + Math.cos(ang2) * dist;
              dy = player.y + Math.sin(ang2) * dist;
              if (stage.star) { const c2 = clampToStar(dx, dy, 8); dx = c2.x; dy = c2.y; }
            }
          }
          decoys.push({ x: dx, y: dy, hp: cfg.ando.hp, maxHp: cfg.ando.hp });
        }
      } else if (card.id === 'piercingShot') {
        state.activeCardEffects.push({ type: 'pierce', ttl: 7, name: card.name, dur: 7 });
        showToast('7秒間通常弾が貫通するようになった！');
      } else if (card.id === 'recipeResearch') {
        const prevMul = Math.max(state.cardOrbRareMul || 1, 1);
        const newMul = prevMul * 1.2;
        state.cardOrbRareMul = newMul;
        const label = `${card.name} x${newMul.toFixed(2)}`;
        const existingIdx = state.activeCardEffects.findIndex(e => e.type === 'cardOrbRate');
        if (existingIdx >= 0) {
          const existing = state.activeCardEffects[existingIdx];
          existing.name = label;
          existing.ttl = Number.POSITIVE_INFINITY;
          existing.dur = Number.POSITIVE_INFINITY;
          existing.persistent = true;
        } else {
          state.activeCardEffects.push({
            type: 'cardOrbRate',
            ttl: Number.POSITIVE_INFINITY,
            dur: Number.POSITIVE_INFINITY,
            name: label,
            persistent: true,
          });
        }
        showToast(`金と虹カードオーブの出現率が${newMul.toFixed(2)}倍になった！`);
      } else if (card.id === 'oniMelonPan') {
        state.stats.atk *= 1.2;
        state.activeCardEffects.push({ type: 'atk', mul: 1.2, ttl: 30, name: card.name, dur: 30 });
      } else if (card.id === 'gekioniMelonPan') {
        state.stats.atk *= 1.5;
        state.activeCardEffects.push({ type: 'atk', mul: 1.5, ttl: 60, name: card.name, dur: 60 });
      } else if (card.id === 'knockbackMelonPan') {
        let syIdx = -1;
        let partner = null;
        if (synergyEnabled) {
          syIdx = state.deck.findIndex((c, i) => i !== idx && c.attr === card.attr);
          partner = syIdx >= 0 ? state.deck[syIdx] : null;
        }
        if (synergyEnabled && partner && partner.id === 'invincibleMelonPan') {
          state.deck.splice(syIdx, 1);
          if (syIdx < idx) idx--;
          invulnT = Math.max(invulnT, 15);
          state.activeCardEffects.push({ type: 'inv', ttl: 15, name: partner.name, dur: 15 });
          state.activeCardEffects.push({ type: 'knockback', ttl: 15, name: card.name, dur: 15 });
        } else {
          state.activeCardEffects.push({ type: 'knockback', ttl: 12, name: card.name, dur: 12 });
        }
      } else if (card.id === 'invincibleMelonPan') {
        let syIdx = -1;
        let partner = null;
        if (synergyEnabled) {
          syIdx = state.deck.findIndex((c, i) => i !== idx && c.attr === card.attr);
          partner = syIdx >= 0 ? state.deck[syIdx] : null;
        }
        if (synergyEnabled && partner && partner.id === 'knockbackMelonPan') {
          state.deck.splice(syIdx, 1);
          if (syIdx < idx) idx--;
          invulnT = Math.max(invulnT, 15);
          state.activeCardEffects.push({ type: 'inv', ttl: 15, name: card.name, dur: 15 });
          state.activeCardEffects.push({ type: 'knockback', ttl: 15, name: partner.name, dur: 15 });
        } else {
          invulnT = Math.max(invulnT, 7);
          state.activeCardEffects.push({ type: 'inv', ttl: 7, name: card.name, dur: 7 });
        }
      } else if (card.id === 'cardEater') {
        grantCardHealEffect = true;
        removeCardEaterCopies = true;
        state.cardEaterUsedThisBattle = true;
        showToast('カードを使うたびHPが10回復するようになった！');
      }
      try { spawnCardEffect(player.x, player.y, card.name); } catch { }
      if (state.cardHealOnUse > 0) {
        const healAmount = applyHealBonus(state.cardHealOnUse);
        if (healAmount > 0) {
          const prevHp = state.stats.hp;
          state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
          const gained = state.stats.hp - prevHp;
          const displayHeal = Math.round(gained);
          if (displayHeal > 0) {
            try { spawnHealNumber(player.x, player.y, displayHeal); } catch { }
          }
        }
      }
      recordCardUsage();
      if (grantCardHealEffect) {
        state.cardHealOnUse = 10;
        state.activeCardEffects = state.activeCardEffects.filter(e => e.type !== 'cardHealOnUse');
        state.activeCardEffects.push({ type: 'cardHealOnUse', ttl: 999999, name: card.name, dur: 999999 });
      }
      state.deck.splice(idx, 1);
      if (removeCardEaterCopies) {
        for (let i = state.deck.length - 1; i >= 0; i--) {
          if (state.deck[i]?.id === 'cardEater') state.deck.splice(i, 1);
        }
      }
      refreshCardDeck();
      refreshCardBuffs();
    }
    if (state.cardKeyHandler) window.removeEventListener('keydown', state.cardKeyHandler, true);
    state.cardKeyHandler = (ev) => {
      if (!state.inGame || state.pauseBy.size > 0) return;
      if (cardSelectModal && !cardSelectModal.classList.contains('hidden')) return;
      if (levelUpModal && !levelUpModal.classList.contains('hidden')) return;
      if (/^[1-3]$/.test(ev.key)) {
        useCardAt(parseInt(ev.key, 10) - 1);
      }
    };
    addListener(window, 'keydown', state.cardKeyHandler, true);
    const enemyProjectiles = []; // local-only when client sim
    const IGNITION_SUPPRESSOR_LIMIT = 5;
    const TANK_LIMIT = 10;
    const IGNITION_STAR_BULLET_LIMIT = 360;
    const IGNITION_STAR_EMIT_INTERVAL = 0.28;
    const hazards = []; // local-only telegraphs when client sim
    const jumpState = { active: false, t: 0, dur: 0, sx: 0, sy: 0, ex: 0, ey: 0 };
    // batched hit reporting (server-authoritative damage)
    const BATCH_BASE_RATE = 15;
    const HIT_FLUSH_INTERVAL = 1 / BATCH_BASE_RATE;
    const STUN_FLUSH_BASE_INTERVAL = 1 / BATCH_BASE_RATE;
    const STUN_FLUSH_MIN_INTERVAL = 1 / 120;
    const STUN_FLUSH_EARLY_THRESHOLD = 0.04;
    const STUN_FLUSH_EARLY_MARGIN = 0.008;
    const _hitBatch = new Map();
    let _hitFlushT = HIT_FLUSH_INTERVAL;
    const _stunBatch = new Map();
    const _stunActiveUntil = new Map();
    let _stunFlushT = STUN_FLUSH_BASE_INTERVAL;
    const getNowSeconds = () => {
      if (typeof performance === 'object' && typeof performance.now === 'function') {
        return performance.now() / 1000;
      }
      return Date.now() / 1000;
    };
    function queueHit(enemyId, dmg, actualDamage = dmg) {
      // guard: skip when not in game or player already dead
      if (!state.inGame || !state.stats?.alive) return;
      if (!enemyId || !isFinite(dmg) || dmg <= 0) return;
      const dmgForAchievement = Number.isFinite(actualDamage) && actualDamage > 0 ? actualDamage : dmg;
      checkDamageAchievements(dmgForAchievement);
      _hitBatch.set(enemyId, (_hitBatch.get(enemyId) || 0) + dmg);
    }
    function applyLocalStun(enemyId, dur) {
      if (!enemyId || !isFinite(dur) || dur <= 0) return;
      const target = enemies.find(en => en?.id === enemyId && en.alive !== false);
      if (target) {
        target.stun = Math.max(target.stun || 0, dur);
      }
    }
    function queueStun(enemyId, dur) {
      if (!state.inGame || !state.stats?.alive) return;
      if (!enemyId || !Number.isFinite(dur) || dur <= 0) return;
      applyLocalStun(enemyId, dur);
      const nowSec = getNowSeconds();
      const expireAt = nowSec + dur;
      const entry = _stunBatch.get(enemyId);
      if (entry && typeof entry.expireAt === 'number') {
        entry.expireAt = Math.max(entry.expireAt, expireAt);
      } else {
        _stunBatch.set(enemyId, { expireAt });
      }
      const flushLead = dur - STUN_FLUSH_EARLY_MARGIN;
      const targetFlush = flushLead <= 0 ? 0 : Math.max(STUN_FLUSH_MIN_INTERVAL, flushLead);
      _stunFlushT = Math.min(_stunFlushT, targetFlush);
      const activeUntil = _stunActiveUntil.get(enemyId);
      if (typeof activeUntil === 'number') {
        const remaining = activeUntil - nowSec;
        if (remaining <= STUN_FLUSH_EARLY_THRESHOLD) {
          const earlyBase = remaining - STUN_FLUSH_EARLY_MARGIN;
          const early = earlyBase <= 0 ? 0 : Math.max(STUN_FLUSH_MIN_INTERVAL, earlyBase);
          _stunFlushT = Math.min(_stunFlushT, early);
        }
      }
    }
    function healAlly(targetId, amount) {
      if (!state.inGame || !state.stats?.alive) return;
      if (!targetId || !isFinite(amount) || amount <= 0) return;
      sendEvent({ type: 'allyHeal', target: targetId, v: amount }).catch(() => { });
    }
    function flushHitBatchNow() {
      if (!state.serverSim) { _hitBatch.clear(); return; }
      if (!state.inGame || !state.stats?.alive) { _hitBatch.clear(); return; }
      if (_hitBatch.size === 0) return;
      const hits = Array.from(_hitBatch.entries()).map(([enemyId, dmg]) => ({ enemyId, dmg }));
      _hitBatch.clear();
      sendEvent({ type: 'hits', hits }).catch(() => { });
    }
    function flushStunBatchNow() {
      if (_stunBatch.size === 0) return;
      if (!state.serverSim) { _stunBatch.clear(); _stunActiveUntil.clear(); return; }
      if (!state.inGame || !state.stats?.alive) { _stunBatch.clear(); _stunActiveUntil.clear(); return; }
      const nowSec = getNowSeconds();
      const stuns = [];
      for (const [enemyId, info] of _stunBatch.entries()) {
        if (!enemyId || !info) { _stunActiveUntil.delete(enemyId); continue; }
        const expireAt = typeof info.expireAt === 'number' ? info.expireAt : NaN;
        const dur = expireAt - nowSec;
        if (!Number.isFinite(dur) || dur <= 0) {
          _stunActiveUntil.delete(enemyId);
          continue;
        }
        stuns.push({ enemyId, dur });
        _stunActiveUntil.set(enemyId, nowSec + dur);
      }
      _stunBatch.clear();
      if (stuns.length === 0) return;
      sendEvent({ type: 'stuns', stuns }).catch(() => { });
    }
    let spawnTimer = 0; let shootTimer = 0; let posTimer = 0; let waveTimer = 0;
    let lavaX = -600;
    let specialSpawned = false;
    let rainbowMoneySpawned = false;
    let ignitionFifteenMoneySpawned = false;
    let fiveMinExpOrbSpawned = false;
    let tenMinuteHealSpawned = false;
    const IGNITION_EXP_ORB_TIMES = [60, 230, 350];
    let nextIgnitionExpOrbIdx = 0;
    // boss spawn control (mid-boss every 2.5 minutes, boss every 6)
    let nextBossAt = 360; // seconds
    let nextMidBossAt = 150; // seconds
    let midBossSpawned = false;
    let bossRetry = 0;
    let midBossRetry = 0;
    // neutral wave event at fixed times
    const neutralWaveTimes = [240, 600, 720, 870]; // seconds
    let neutralWaveTimesSession = [...neutralWaveTimes];
    let nextNeutralWaveAt = neutralWaveTimesSession.shift();
    let neutralWaveRetry = 0;
    let neutralWarned = false;
    // death reaper spawn (once at 15 minutes)
    let nextReaperAt = 900; // seconds
    if (state.me?.name === '中ボス') {
      nextMidBossAt = 20;
    }
    if (state.me?.name === 'ボス') {
      nextBossAt = 30;
    }
    const HEAL_INTERVAL = 40; // seconds
    let healTimer = HEAL_INTERVAL;
    const MONEY_INTERVAL = HEAL_INTERVAL;
    let moneyTimer = MONEY_INTERVAL;
    const CARD_ORB_INTERVAL = 50; // seconds
    let cardOrbTimer = CARD_ORB_INTERVAL;
    const ATK_BOOST_INTERVAL = 40; // seconds
    let atkBoostTimer = ATK_BOOST_INTERVAL;

    // Extracted function for converter spawn chance calculation
    function calculateConverterSpawnChance(sugar) {
      const sugarMul = 0.6 + 0.002 * sugar + 0.00012 * sugar * sugar;
      return Math.min(1, 1.5 * sugarMul);
    }

    function spawnHealPickup() {
      const ang = Math.random() * Math.PI * 2;
      const dist = 200 + Math.random() * 200;
      const sugar = state.energy?.sugar || 0;
      const spawnChance = state.energyUnlocked
        ? calculateConverterSpawnChance(sugar)
        : 0;
      const isConverter = Math.random() < spawnChance;
      const baseR = isConverter ? 24 : 8;
      const healVal = Math.round(20 * (stage.healValueMul || 1));
      let ix = player.x + Math.cos(ang) * dist;
      let iy = player.y + Math.sin(ang) * dist;
      if (stage.star) { const c = clampToStar(ix, iy, baseR); ix = c.x; iy = c.y; }
      if (stage.type === 'ranch') {
        const hh = stage.halfHeight;
        const margin = baseR + 4;
        iy = Math.max(-hh + margin, Math.min(hh - margin, iy));
      }
      if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
        let tries = 6;
        while (tries-- > 0) {
          const obs = getNearbyObstacles(ix, iy);
          let blocked = false;
          for (const rect of obs) { if (circleRectCollide(ix, iy, baseR, rect)) { blocked = true; break; } }
          if (stage.poison && isPoisonAt(ix, iy)) blocked = true;
          if (!blocked) break;
          const ang2 = Math.random() * Math.PI * 2;
          ix = player.x + Math.cos(ang2) * dist;
          iy = player.y + Math.sin(ang2) * dist;
          if (stage.star) { const c2 = clampToStar(ix, iy, baseR); ix = c2.x; iy = c2.y; }
        }
      }
      if (isConverter) {
        converters.push({ id: 'cv' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: baseR });
      } else {
        // Rare rainbow melonpan: very low probability (1%) — restores 50 HP
        if (Math.random() < 0.01) {
          heals.push({ id: 'rb' + Math.random().toString(36).slice(2, 8), type: 'rainbow', x: ix, y: iy, r: 12, value: 50 });
        } else {
          heals.push({ id: 'lh' + Math.random().toString(36).slice(2, 8), type: 'heal', x: ix, y: iy, r: 8, value: healVal });
        }
      }
      if (riskEventEffect?.type === 'melon') {
        const EXTRA_HEAL_COUNT = 4;
        for (let extraIdx = 0; extraIdx < EXTRA_HEAL_COUNT; extraIdx++) {
          let ex = ix;
          let ey = iy;
          let triesExtra = 4;
          const extraDist = 30 + Math.random() * 30;
          let extraAng = Math.random() * Math.PI * 2;
          const clampExtra = () => {
            if (stage.star) { const c3 = clampToStar(ex, ey, 8); ex = c3.x; ey = c3.y; }
            if (stage.type === 'ranch') {
              const hh3 = stage.halfHeight;
              ey = Math.max(-hh3 + 12, Math.min(hh3 - 12, ey));
            }
          };
          const blockedExtra = () => {
            if (!(stage.type === 'maze' || stage.iceBlocks || stage.poison)) return false;
            const obsExtra = getNearbyObstacles(ex, ey);
            let blocked = obsExtra.some(rect => circleRectCollide(ex, ey, 8, rect));
            if (stage.poison && isPoisonAt(ex, ey)) blocked = true;
            return blocked;
          };
          while (triesExtra-- > 0) {
            ex = ix + Math.cos(extraAng) * extraDist;
            ey = iy + Math.sin(extraAng) * extraDist;
            clampExtra();
            if (!blockedExtra()) break;
            extraAng = Math.random() * Math.PI * 2;
          }
          heals.push({ id: 'lh' + Math.random().toString(36).slice(2, 8), type: 'heal', x: ex, y: ey, r: 8, value: healVal });
        }
      }
      if (Math.random() < 0.6) {
        let gang = Math.random() * Math.PI * 2;
        let gr = 240 + Math.random() * 240;
        let gx = player.x + Math.cos(gang) * gr;
        let gy = player.y + Math.sin(gang) * gr;
        if (stage.star) { const c = clampToStar(gx, gy, 8); gx = c.x; gy = c.y; }
        if (stage.type === 'ranch') {
          const hh2 = stage.halfHeight;
          gy = Math.max(-hh2 + 12, Math.min(hh2 - 12, gy));
        }
        if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
          let gtries = 6;
          while (gtries-- > 0) {
            const gobs = getNearbyObstacles(gx, gy);
            let gblocked = false;
            for (const rect of gobs) { if (circleRectCollide(gx, gy, 8, rect)) { gblocked = true; break; } }
            if (stage.poison && isPoisonAt(gx, gy)) gblocked = true;
            if (!gblocked) break;
            const gang2 = Math.random() * Math.PI * 2;
            gx = player.x + Math.cos(gang2) * gr;
            gy = player.y + Math.sin(gang2) * gr;
            if (stage.star) { const c2 = clampToStar(gx, gy, 8); gx = c2.x; gy = c2.y; }
          }
        }
        const elems = ['fire', 'ice', 'lightning', 'dark'];
        if (stageName === 'メロンパンスキー場') elems.push('fire');
        const elem = elems[Math.floor(Math.random() * elems.length)];
        heals.push({ id: 'gh' + Math.random().toString(36).slice(2, 8), type: 'grimoire', elem, x: gx, y: gy, r: 8, value: 0 });
      }
    }
    function findPickupPosition(minDist, maxDist, radius = 8) {
      const dist = minDist + Math.random() * (maxDist - minDist);
      let ang = Math.random() * Math.PI * 2;
      let ix = player.x + Math.cos(ang) * dist;
      let iy = player.y + Math.sin(ang) * dist;
      const clampPos = () => {
        if (stage.star) {
          const c = clampToStar(ix, iy, radius);
          ix = c.x; iy = c.y;
        }
        if (stage.type === 'ranch') {
          const hh = stage.halfHeight;
          const margin = radius === 8 ? 12 : radius + 4;
          iy = Math.max(-hh + margin, Math.min(hh - margin, iy));
        }
      };
      clampPos();
      if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
        let tries = 6;
        while (tries-- > 0) {
          const obs = getNearbyObstacles(ix, iy);
          let blocked = false;
          for (const rect of obs) { if (circleRectCollide(ix, iy, radius, rect)) { blocked = true; break; } }
          if (stage.poison && isPoisonAt(ix, iy)) blocked = true;
          if (!blocked) break;
          ang = Math.random() * Math.PI * 2;
          ix = player.x + Math.cos(ang) * dist;
          iy = player.y + Math.sin(ang) * dist;
          clampPos();
        }
      }
      return { x: ix, y: iy };
    }
    function spawnMoneyPickup() {
      const { x: ix, y: iy } = findPickupPosition(200, 400);
      moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: 8, value: 100 });
    }
    function spawnRainbowMoney() {
      const { x: ix, y: iy } = findPickupPosition(60, 100);
      moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: 8, value: 1000 });
    }
    function spawnIgnitionMoneyBurst(count = 10) {
      for (let i = 0; i < count; i++) {
        const { x: ix, y: iy } = findPickupPosition(60, 120);
        moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: 8, value: 1000 });
      }
    }
    function spawnCardOrb(rarityOverride) {
      if (!state.cardShopUnlocked) return;
      const { x: ix, y: iy } = findPickupPosition(200, 400);
      let rarity;
      if (typeof rarityOverride === 'number') {
        rarity = rarityOverride;
      } else {
        const rareMul = Math.max(state.cardOrbRareMul || 1, 1);
        const baseRainbow = 0.015;
        const baseGold = 0.04;
        const baseSilver = 0.145;
        const baseBronze = 1 - baseRainbow - baseGold - baseSilver;
        let rainbowChance = Math.min(baseRainbow * rareMul, 1);
        let goldChance = Math.min(baseGold * rareMul, Math.max(0, 1 - rainbowChance));
        let silverChance = baseSilver;
        let bronzeChance = baseBronze;
        let total = rainbowChance + goldChance + silverChance + bronzeChance;
        if (total > 1) {
          const excess = total - 1;
          const bronzeReduction = Math.min(bronzeChance, excess);
          bronzeChance -= bronzeReduction;
          const remainingExcess = excess - bronzeReduction;
          if (remainingExcess > 0) {
            silverChance = Math.max(0, silverChance - remainingExcess);
          }
        }
        const roll = Math.random();
        const goldThreshold = rainbowChance + goldChance;
        const silverThreshold = goldThreshold + silverChance;
        rarity = 1;
        if (roll < rainbowChance) rarity = 4; // 虹
        else if (roll < goldThreshold) rarity = 3; // 金
        else if (roll < silverThreshold) rarity = 2; // 銀
      }
      cardOrbs.push({ id: 'co' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: 8, rarity });
    }
    function spawnAtkBoostPickup() {
      const { x: ix, y: iy } = findPickupPosition(200, 400);
      atkBoosts.push({ id: 'sw' + Math.random().toString(36).slice(2, 8), x: ix, y: iy, r: 8 });
    }
    function spawnRewardArea() {
      if (stage.circular) return;
      if (stage.type === 'volcano') {
        const { x: ix, y: iy } = findPickupPosition(800, 1000, 80);
        rewardArea = { x: ix, y: iy, r: 80 };
      } else {
        const { x: ix, y: iy } = findPickupPosition(800, 1000, 80);
        rewardArea = { x: ix, y: iy, r: 80 };
      }
      showToast('報酬エリアが出現！');
      try { Audio?.playSfx?.(state, 'alert'); } catch { }
    }
    const riskEnemyConfigs = {
      'かんたん': { count: 2, hp: 260, interval: 2.4, volley: 16, rings: 1, bulletSpeed: 90, bulletTtl: 5.6, bulletDmg: 5, sprayInterval: 1.2, sprayShots: 4, spraySpeed: 80, spd: 36, fan: 0.45 },
      'ふつう': { count: 3, hp: 320, interval: 2.0, volley: 20, rings: 1, bulletSpeed: 110, bulletTtl: 5.8, bulletDmg: 7, sprayInterval: 1.0, sprayShots: 5, spraySpeed: 95, spd: 38, fan: 0.48 },
      'むずかしい': { count: 4, hp: 380, interval: 1.6, volley: 24, rings: 2, bulletSpeed: 130, bulletTtl: 6.2, bulletDmg: 9, sprayInterval: 0.85, sprayShots: 6, spraySpeed: 110, spd: 42, fan: 0.55, bulletLimit: 220 },
    };
    function spawnRiskRewardAreas(eventIdx = 0) {
      const placed = [];
      const typeSet = RISK_EVENT_AREA_TYPES[eventIdx] || RISK_EVENT_AREA_TYPES[RISK_EVENT_AREA_TYPES.length - 1] || ['exp', 'melon'];
      for (const type of typeSet) {
        let tries = 8;
        let pos = null;
        while (tries-- > 0) {
          const candidate = findPickupPosition(650, 950, RISK_AREA_RADIUS);
          if (placed.every(area => Math.hypot(area.x - candidate.x, area.y - candidate.y) >= RISK_AREA_RADIUS * 1.8)) {
            pos = candidate;
            break;
          }
        }
        if (!pos) pos = findPickupPosition(600, 900, RISK_AREA_RADIUS);
        placed.push({ ...pos, r: RISK_AREA_RADIUS, type, expiresAt: timeAlive + RISK_AREA_DURATION });
      }
      riskChoiceAreas = placed;
      riskEventSpawnRetry = 0;
      showToast('リスク報酬エリアが出現！');
      try { Audio?.playSfx?.(state, 'alert'); } catch { }
    }
    function spawnRiskEventEnemies(effectType) {
      const diffName = state.room?.difficulty || 'ふつう';
      const cfgRisk = riskEnemyConfigs[diffName] || riskEnemyConfigs['ふつう'];
      const diffCfg = getDifficultyConfig(diffName) || { hpMul: 1, mobHpMul: 1, bulletMul: 1, bulletDmgMul: 1 };
      const hpMul = (diffCfg.mobHpMul || 1) * (stage.mobHpMul || 1);
      const baseHp = Math.max(50, Math.round((cfgRisk.hp + Math.max(0, timeAlive - RISK_EVENT_TIME) * 0.6) * hpMul));
      const bulletDmg = Math.max(1, Math.round(cfgRisk.bulletDmg * (diffCfg.bulletDmgMul || 1)));
      const interval = Math.max(0.6, cfgRisk.interval / Math.max(0.6, diffCfg.bulletMul || 1));
      const sprayInterval = Math.max(0.4, (cfgRisk.sprayInterval || 1) / Math.max(0.6, diffCfg.bulletMul || 1));
      let spawned = 0;
      for (let i = 0; i < (cfgRisk.count || 2); i++) {
        const pos = findPickupPosition(520, 760, 14);
        const enemyNames = {
          exp: '弾幕守護機',
          melon: '弾幕供給機',
          money: '弾幕財務機',
        };
        const enemy = {
          id: 'br' + Math.random().toString(36).slice(2, 10),
          type: 'barrage',
          name: enemyNames[effectType] || '弾幕供給機',
          x: pos.x,
          y: pos.y,
          r: 14,
          hp: baseHp,
          maxHp: baseHp,
          spd: cfgRisk.spd || 40,
          alive: true,
          t: 0,
          interval,
          cd: Math.random() * interval,
          volley: cfgRisk.volley,
          rings: cfgRisk.rings,
          bulletSpd: cfgRisk.bulletSpeed,
          bulletTtl: cfgRisk.bulletTtl,
          bulletDmg,
          sprayInterval,
          sprayCd: Math.random() * sprayInterval,
          sprayShots: cfgRisk.sprayShots,
          spraySpeed: cfgRisk.spraySpeed,
          fan: cfgRisk.fan,
          bulletLimit: cfgRisk.bulletLimit || BARRAGE_BULLET_LIMIT,
        };
        enemies.push(enemy);
        spawned++;
      }
      return spawned;
    }
    function activateRiskArea(area) {
      if (!area) return 0;
      const validAreaTypes = ['exp', 'melon', 'money'];
      const areaType = validAreaTypes.includes(area.type) ? area.type : 'exp';
      if (state.serverSim) {
        if (riskActivationPending) return 0;
        riskActivationPending = true;
        const payload = {
          type: 'riskRewardActivate',
          areaType,
          area: {
            type: areaType,
            x: Number.isFinite(area.x) ? area.x : 0,
            y: Number.isFinite(area.y) ? area.y : 0,
            r: Number.isFinite(area.r) ? area.r : 0,
          },
        };
        sendEvent(payload).catch(() => {
          riskActivationPending = false;
        });
        return 0;
      }
      riskChoiceAreas = null;
      riskEventEffect = { type: areaType, startedAt: timeAlive };
      state._riskEventEffect = riskEventEffect;
      const buffMeta = {
        exp: { type: 'risk-exp', name: '経験値オーブ3倍', toast: '経験値オーブが3倍ドロップ！' },
        melon: { type: 'risk-melon', name: 'メロンパン出現率5倍', toast: 'メロンパン出現率が5倍！' },
        money: { type: 'risk-money', name: 'マネー獲得量3倍', toast: 'マネー獲得量が3倍！' },
      };
      const selectedBuff = buffMeta[areaType] || buffMeta.exp;
      if (!state.activeCardEffects.some(eff => eff.type === selectedBuff.type)) {
        state.activeCardEffects.push({ type: selectedBuff.type, ttl: Infinity, dur: Infinity, name: selectedBuff.name });
        refreshCardBuffs();
      }
      showToast(selectedBuff.toast);
      try { Audio?.playSfx?.(state, 'pickup'); } catch { }
      const spawned = spawnRiskEventEnemies(areaType);
      if (spawned > 0) {
        setTimeout(() => { showToast('弾幕の敵が現れた！'); }, 600);
        try { Audio?.playSfx?.(state, 'alert'); } catch { }
      }
      return spawned;
    }
    function grantReward() {
      if (!rewardArea) return;
      const rand = () => Math.random().toString(36).slice(2, 8);
      const cx = rewardArea.x, cy = rewardArea.y;
      const diff = state.room?.difficulty || 'ふつう';
      if (diff === 'かんたん') {
        pushOrb({ x: cx, y: cy, r: 8, value: 20 });
        moneys.push({ id: 'mn' + rand(), x: cx + 20, y: cy, r: 8, value: 100 });
        heals.push({ id: 'lh' + rand(), type: 'heal', x: cx - 20, y: cy, r: 8, value: 20 });
        if (state.cardShopUnlocked) cardOrbs.push({ id: 'co' + rand(), x: cx, y: cy + 20, r: 8, rarity: 2 });
      } else if (diff === 'ふつう') {
        pushOrb({ x: cx, y: cy, r: 8, value: 100, type: 'exp5' });
        moneys.push({ id: 'mn' + rand(), x: cx + 20, y: cy, r: 8, value: 100 });
        heals.push({ id: 'lh' + rand(), type: 'heal', x: cx - 20, y: cy, r: 8, value: 20 });
        if (state.cardShopUnlocked) cardOrbs.push({ id: 'co' + rand(), x: cx, y: cy + 20, r: 8, rarity: 3 });
      } else {
        pushOrb({ x: cx, y: cy, r: 8, value: 100, type: 'exp5' });
        moneys.push({ id: 'mn' + rand(), x: cx + 20, y: cy, r: 8, value: 1000 });
        heals.push({ id: 'rb' + rand(), type: 'rainbow', x: cx - 20, y: cy, r: 12, value: 50 });
        if (state.cardShopUnlocked) cardOrbs.push({ id: 'co' + rand(), x: cx, y: cy + 20, r: 8, rarity: 4 });
      }
      if (state.energyUnlocked) converters.push({ id: 'cv' + rand(), x: cx, y: cy - 20, r: 24 });
      showToast('報酬が支給された！');
      try { Audio?.playSfx?.(state, 'pickup'); } catch { }
      rewardArea = null;
    }
    spawnHealPickup();
    spawnMoneyPickup();
    // カードショップ解禁後のみカードオーブを生成する
    spawnCardOrb();
    if (Math.random() < 0.15) spawnAtkBoostPickup();
    const myMember = state.room?.members.find(m => m.id === state.me?.playerId);
    const charName = normalizeCharacterSelection(myMember?.character) ?? defaultPlayableCharacter;
    state._activeCharacterName = charName;
    state.subWeaponRuntime = createSubWeaponRuntime(state.selectedSubWeapon);
    if (state.secondSubWeaponUnlocked && state.selectedSecondSubWeapon && subWeaponMap.has(state.selectedSecondSubWeapon)) {
      state.secondSubWeaponRuntime = createSubWeaponRuntime(state.selectedSecondSubWeapon);
    } else {
      state.secondSubWeaponRuntime = null;
    }
    if (!state.subWeaponRuntime && state.secondSubWeaponRuntime) {
      state.subWeaponRuntime = state.secondSubWeaponRuntime;
      state.secondSubWeaponRuntime = null;
    }
    updateSubWeaponHud();
    const baseArmor = charName && state.armorUnlocked ? (characterDefs[charName]?.stats?.armor || 0) : 0;
    state.stats.baseArmor = baseArmor;
    state.stats.armor = baseArmor;
    state.stats.maxArmor = baseArmor;
    if (charName === 'おきーぱー') player.spd *= 0.9;
    if (charName === '恋恋') player.spd *= 1.1;
    if (charName === 'U') player.spd *= 1.3;
    if (charName === 'あたち') { state.stats.hp += 20; state.stats.maxHp += 20; }
    if (charName === 'メロ') {
      player.spd *= 0.6;
      const base = (60 + (state.perks.hp || 0) * 12) * (state.perks.hphalf ? 0.5 : 1);
      state.stats.hp = base;
      state.stats.maxHp = base;
    }
    applyCharacterGrowthBonuses(charName, player);
    const activeGaugeWrap = document.getElementById('activeGaugeWrapper');
    const activeGaugeEl = document.getElementById('activeGauge');
    const activeGaugeFill = activeGaugeEl?.querySelector('.fill');
    const activeGaugeTime = document.getElementById('activeGaugeTime');
    const activeTimes = { 'おきーぱー': 180, 'ナタリア': 260, 'あたち': 150, 'U': 180, 'ハクシキ': 90, '恋恋': 105, 'メロ': 300, 'フルムーン': 160, 'あんどー': 110 };
    const activeCharge = activeTimes[charName] || 0;
    const activeDescRaw = characterDefs[charName]?.activeName || characterDefs[charName]?.active || '';
    if (hudActiveName) {
      const activeName = (() => {
        const raw = (typeof activeDescRaw === 'string') ? activeDescRaw.trim() : '';
        if (!raw) return '';
        const idx = raw.search(/[（(]/);
        const main = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
        return main || raw;
      })();
      const labelText = (state.activeWeaponUnlocked && activeName)
        ? `アクティブウェポン：${activeName}`
        : 'アクティブウェポン：-';
      hudActiveName.textContent = labelText;
    }
    state.activeGauge = 0;
    state._activeTtl = 0;
    state._activeDur = 0;
    state._activeReadyNotified = false;
    let activeGaugeVisible = state.activeWeaponUnlocked;
    if (!state.activeWeaponUnlocked) {
      activeGaugeWrap?.classList.add('hidden');
    } else {
      activeGaugeWrap?.classList.remove('hidden');
      if (activeGaugeFill) activeGaugeFill.style.width = '0%';
      if (activeGaugeTime) activeGaugeTime.textContent = `0/${activeCharge}`;
    }
    let batTimer = 0;
    function triggerActiveWeapon() {
      if (!state.activeWeaponUnlocked || state.activeGauge < activeCharge || state._activeTtl > 0) return;
      state._activeReadyNotified = false;
      try { Audio?.playSfx?.(state, 'activeStart'); } catch { }
      let dur = 1;
      switch (charName) {
        case 'おきーぱー': {
          const viewWidth = (typeof cvs !== 'undefined' && cvs?.width && typeof drawScale !== 'undefined' && Number.isFinite(drawScale) && drawScale > 0)
            ? cvs.width / drawScale
            : 0;
          const viewHeight = (typeof cvs !== 'undefined' && cvs?.height && typeof drawScale !== 'undefined' && Number.isFinite(drawScale) && drawScale > 0)
            ? cvs.height / drawScale
            : 0;
          const hasViewSize = Number.isFinite(viewWidth) && viewWidth > 0 && Number.isFinite(viewHeight) && viewHeight > 0;
          const left = hasViewSize ? state.camera.x - viewWidth / 2 : player.x;
          const top = hasViewSize ? state.camera.y - viewHeight / 2 : player.y;
          for (let i = 0; i < 20; i++) {
            const spawnX = hasViewSize ? left + Math.random() * viewWidth : player.x;
            const spawnY = hasViewSize ? top + Math.random() * viewHeight : player.y;
            projectiles.push({ type: 'bat', x: spawnX, y: spawnY, r: cfg.okp.pr, spd: cfg.okp.spd, dmg: cfg.okp.dmg, ttl: 3, pierce: true });
          }
          batTimer = cfg.okp.interval;
          state.activeGauge = 0;
          break;
        }
        case 'ナタリア': {
          const healFrac = Math.max(0, Math.min(1, cfg.nata.activeHealFraction ?? 1));
          const missingSelfHp = Math.max(0, (state.stats.maxHp || 0) - (state.stats.hp || 0));
          const selfHeal = missingSelfHp * healFrac;
          if (selfHeal > 0) {
            state.stats.hp = Math.min(state.stats.maxHp || 0, state.stats.hp + selfHeal);
            healAlly(state.me.playerId, selfHeal);
          }
          if (state.stats.maxArmor != null) {
            const currentSelfArmor = state.stats.armor ?? 0;
            const missingSelfArmor = Math.max(0, (state.stats.maxArmor || 0) - currentSelfArmor);
            if (missingSelfArmor > 0) {
              state.stats.armor = Math.min(state.stats.maxArmor, currentSelfArmor + missingSelfArmor * healFrac);
            }
          }
          for (const [pid, ally] of Object.entries(state.allies)) {
            if (ally.alive === false) continue;
            const missingHp = Math.max(0, (ally.maxHp || 0) - (ally.hp || 0));
            const allyHeal = missingHp * healFrac;
            if (allyHeal > 0) healAlly(pid, allyHeal);
            if (ally.maxArmor != null) {
              const currentArmor = ally.armor ?? 0;
              const missingArmor = Math.max(0, ally.maxArmor - currentArmor);
              if (missingArmor > 0) {
                ally.armor = Math.min(ally.maxArmor, currentArmor + missingArmor * healFrac);
              }
            }
          }
          const origSpd = player.spd;
          const origLeftRange = cfg.nata.leftRange, origLeftHeight = cfg.nata.leftHeight, origHealRange = cfg.nata.healRange;
          const spdMul = cfg.nata.activeSpdMul ?? 1.2;
          const rangeMul = cfg.nata.activeRangeMul ?? 1.5;
          player.spd *= spdMul;
          cfg.nata.leftRange *= rangeMul; cfg.nata.leftHeight *= rangeMul; cfg.nata.healRange *= rangeMul;
          registerActiveTimeout(() => {
            player.spd = origSpd;
            cfg.nata.leftRange = origLeftRange;
            cfg.nata.leftHeight = origLeftHeight;
            cfg.nata.healRange = origHealRange;
          }, 30000);
          dur = 30;
          break;
        }
        case 'あたち':
          beamSpeedMul = 3;
          atcKbActive = true;
          registerActiveTimeout(() => { beamSpeedMul = 1; atcKbActive = false; }, 60000);
          dur = 60;
          break;
        case 'U': {
          const prevZone = cfg.u.zone ?? cfg.u.baseZone ?? 0.5;
          const prevBoss = state.stats.bossDmgMul;
          const prevDps = cfg.u.dps ?? 0;
          const dpsBoost = Math.max(0, 7.5 - prevDps);
          const overrideZone = 0;
          cfg.u.zone = overrideZone;
          cfg.u.dps = prevDps + dpsBoost;
          state.stats.bossDmgMul = prevBoss * 3.5;
          registerActiveTimeout(() => {
            const zone = cfg.u.zone;
            if (zone == null || zone === overrideZone) {
              const baseZone = cfg.u.baseZone ?? prevZone;
              cfg.u.zone = baseZone;
            }
            if (dpsBoost > 0) {
              const currentDps = cfg.u.dps ?? 0;
              cfg.u.dps = Math.max(prevDps, currentDps - dpsBoost);
            }
            state.stats.bossDmgMul = prevBoss;
          }, 60000);
          dur = 60;
          break;
        }
        case 'ハクシキ': {
          const interval = setInterval(() => {
            let dirX = lastMoveDir.x;
            let dirY = lastMoveDir.y;
            const len = Math.hypot(dirX, dirY);
            if (len === 0) { dirX = -1; dirY = 0; }
            else { dirX /= len; dirY /= len; }
            projectiles.push({ type: 'pew', x: player.x, y: player.y, vx: -dirX * 400, vy: -dirY * 400, r: 4, dmg: getAtk(), ttl: 1.2, pierce: true });
          }, 200);
          registerActiveTimeout(() => clearInterval(interval), 15000);
          dur = 15;
          break;
        }
        case '恋恋': {
          let far = null, maxD = -1;
          for (const e of enemies) {
            if (!e.alive) continue;
            const s = toScreen(e.x, e.y);
            if (s.x < 0 || s.x > cvs.width || s.y < 0 || s.y > cvs.height) continue;
            const d = Math.hypot(e.x - player.x, e.y - player.y);
            if (d > maxD) { maxD = d; far = e; }
          }
          if (far) {
            const dx = far.x - player.x, dy = far.y - player.y, dist = Math.hypot(dx, dy) || 1;
            projectiles.push({ type: 'bomb', x: player.x, y: player.y, vx: (dx / dist) * 300, vy: (dy / dist) * 300, r: 6, dmg: cfg.koi.dmg * 7, air: 0.3, fuse: 0, radius: cfg.koi.radius * 3, bossMul: 5, knockback: cfg.koi.knockback });
          }
          break;
        }
        case 'メロ': {
          const targets = enemies.filter(e => e.alive).sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y)).slice(0, 10);
          if (targets.length) {
            const dmg = Math.max(1, Math.round(getAtk() * cfg.mero.dmgScale));
            for (const tgt of targets) {
              const dx = tgt.x - player.x, dy = tgt.y - player.y, dist = Math.hypot(dx, dy) || 1;
              projectiles.push({ type: 'sniper', x: player.x, y: player.y, vx: (dx / dist) * cfg.mero.spd, vy: (dy / dist) * cfg.mero.spd, r: cfg.mero.r, dmg, ttl: cfg.mero.ttl, elem: state.stats.elem, pierce: true, ex: true, knockback: 200, stun: 3 });
              selfLines.push({ x1: player.x, y1: player.y, x2: tgt.x, y2: tgt.y, ttl: 0.12, w: 2, col: '#ffdf5c' });
            }
            try { Audio?.playSfx?.(state, 'sniperShot'); } catch { }
          }
          break;
        }
        case 'フルムーン': {
          const revivedShield = reviveFullmoonShield();
          if (revivedShield) {
            const dir = getFullmoonDir({ dirX: revivedShield.dirX, dirY: revivedShield.dirY });
            const baseSize = revivedShield.size;
            const baseWidth = revivedShield.w;
            const lockDuration = 0.45;
            const chargeDuration = 0.35;
            const slamDuration = 0.3;
            const targetDist = baseSize + 30;
            const slamRadius = baseSize * 1.4;
            const lockRadius = baseSize * 1.1;
            fullmoonActive = {
              elapsed: 0,
              phase: 'lockon',
              lockDuration,
              chargeDuration,
              slamDuration,
              totalDuration: lockDuration + chargeDuration + slamDuration,
              dirX: dir.x,
              dirY: dir.y,
              baseSize,
              baseWidth,
              targetDist,
              lockRadius,
              slamRadius,
              didSlam: false,
            };
            dur = fullmoonActive.totalDuration;
          } else {
            showToast('フルムーンのアクティブを発動できません: シールドがありません');
          }
          break;
        }
        case 'あんどー': {
          andoActive = true;
          const prevHp = cfg.ando.hp;
          const prevDmg = cfg.ando.dmg;
          const prevMax = cfg.ando.max;
          const prevInterval = cfg.ando.interval;
          cfg.ando.hp *= 5; cfg.ando.dmg *= 5; cfg.ando.max *= 5; cfg.ando.interval /= 5;
          decoyTimer = Math.min(decoyTimer, cfg.ando.interval);
          for (const d of decoys) { d.hp *= 5; d.maxHp *= 5; }
          registerActiveTimeout(() => {
            cfg.ando.hp = prevHp;
            cfg.ando.dmg = prevDmg;
            cfg.ando.max = prevMax;
            cfg.ando.interval = prevInterval;
            decoyTimer = Math.min(decoyTimer, cfg.ando.interval);
            andoActive = false;
          }, 80000);
          dur = 80;
          break;
        }
        default:
          showToast(`アクティブ発動: ${charName}`);
      }
      state._activeDur = dur;
      state._activeTtl = dur;
    }
    function triggerSubWeapon() {
      let runtime = state.subWeaponRuntime;
      if (!runtime || runtime.usesMax == null) return;
      if (runtime.active) return;
      if (runtime.usesLeft <= 0) {
        if (trySwitchToSecondSubWeapon()) {
          runtime = state.subWeaponRuntime;
          if (!runtime || runtime.usesMax == null) return;
          if (runtime.active) return;
          if (runtime.usesLeft <= 0) { handleSubWeaponDepletion(); return; }
        } else {
          handleSubWeaponDepletion();
          return;
        }
      }
      switch (runtime.id) {
        case 'bomb':
          useSubWeaponBomb(runtime);
          break;
        case 'sword':
          useSubWeaponSword(runtime);
          break;
        case 'flamethrower':
          useSubWeaponFlamethrower(runtime);
          break;
        case 'flashbang':
          useSubWeaponFlashbang(runtime);
          break;
        default:
          break;
      }
    }
    function useSubWeaponBomb(runtime) {
      let dirX = lastMoveDir.x;
      let dirY = lastMoveDir.y;
      const len = Math.hypot(dirX, dirY);
      if (len > 0.0001) {
        dirX /= len;
        dirY /= len;
      } else {
        switch (lastFacing) {
          case 'left': dirX = -1; dirY = 0; break;
          case 'up': dirX = 0; dirY = -1; break;
          case 'down': dirX = 0; dirY = 1; break;
          case 'right':
          default: dirX = 1; dirY = 0; break;
        }
      }
      if (dirX === 0 && dirY === 0) { dirX = 1; dirY = 0; }
      const startX = player.x;
      const startY = player.y;
      const range = 180;
      let targetX = startX + dirX * range;
      let targetY = startY + dirY * range;
      const adjustTarget = () => {
        if (stage.star) {
          const clamped = clampToStar(targetX, targetY, 8);
          targetX = clamped.x; targetY = clamped.y;
        }
        if (stage.type === 'ranch') {
          const hh = stage.halfHeight || 0;
          targetY = clamp(targetY, -hh + 12, hh - 12);
        }
        if (stage.type === 'volcano') {
          targetX = Math.max(targetX, lavaX + 12);
        }
      };
      adjustTarget();
      let tries = 6;
      const checkRadius = Math.max(10, player.r + 4);
      while (tries-- > 0) {
        let blocked = false;
        const obs = getNearbyObstacles(targetX, targetY);
        for (const rect of obs) { if (circleRectCollide(targetX, targetY, checkRadius, rect)) { blocked = true; break; } }
        if (!blocked && stage.poison && isPoisonAt(targetX, targetY)) blocked = true;
        if (!blocked) break;
        targetX -= dirX * 16;
        targetY -= dirY * 16;
        adjustTarget();
      }
      const travelTime = 0.6;
      const fuse = 0.25;
      const arcHeight = Math.max(60, range * 0.6);
      const explosionRadius = 110;
      const baseDmg = Math.max(20, Math.round(getAtk() * 6));
      const bossMul = 2;
      const spriteRadius = 8;
      const shadowRadius = spriteRadius * 0.9;
      projectiles.push({
        type: 'subBomb',
        runtimeRef: runtime,
        startX,
        startY,
        targetX,
        targetY,
        travelTime,
        elapsed: 0,
        arcHeight,
        explosionRadius,
        dmg: baseDmg,
        bossMul,
        fuse,
        initialFuse: fuse,
        r: spriteRadius,
        shadowRadius,
        landed: false,
        displayHeight: 0,
      });
      runtime.usesLeft = Math.max(0, (runtime.usesLeft || 0) - 1);
      runtime.active = true;
      runtime.activeTimer = travelTime + fuse;
      updateSubWeaponHud();
      try { Audio?.playSfx?.(state, 'subBomb'); } catch { }
    }
    function useSubWeaponSword(runtime) {
      let dirX = lastMoveDir.x;
      let dirY = lastMoveDir.y;
      const len = Math.hypot(dirX, dirY);
      if (len > 0.0001) {
        dirX /= len;
        dirY /= len;
      } else {
        switch (lastFacing) {
          case 'left': dirX = -1; dirY = 0; break;
          case 'up': dirX = 0; dirY = -1; break;
          case 'down': dirX = 0; dirY = 1; break;
          case 'right':
          default: dirX = 1; dirY = 0; break;
        }
      }
      if (dirX === 0 && dirY === 0) { dirX = 1; dirY = 0; }
      const length = 60;
      const halfWidth = 14;
      const offset = player.r + 6;
      const baseDmg = Math.max(1, Math.round(getAtk() * 4));
      projectiles.push({
        type: 'subSword',
        ttl: 1,
        maxTtl: 1,
        dirX,
        dirY,
        len: length,
        halfWidth,
        offset,
        dmg: baseDmg,
        hit: [],
        runtimeRef: runtime,
        follow: true,
      });
      runtime.usesLeft = Math.max(0, (runtime.usesLeft || 0) - 1);
      runtime.active = true;
      runtime.activeTimer = 1;
      updateSubWeaponHud();
      try { Audio?.playSfx?.(state, 'subSword'); } catch { }
    }
    function useSubWeaponFlamethrower(runtime) {
      let dirX = lastMoveDir.x;
      let dirY = lastMoveDir.y;
      const len = Math.hypot(dirX, dirY);
      if (len > 0.0001) {
        dirX /= len;
        dirY /= len;
      } else {
        switch (lastFacing) {
          case 'left': dirX = -1; dirY = 0; break;
          case 'up': dirX = 0; dirY = -1; break;
          case 'down': dirX = 0; dirY = 1; break;
          case 'right':
          default: dirX = 1; dirY = 0; break;
        }
      }
      if (dirX === 0 && dirY === 0) { dirX = 1; dirY = 0; }
      const duration = 3.5;
      const offset = player.r + 12;
      const length = 200;
      const halfWidth = 58;
      const baseDps = Math.max(12, getAtk() * 1.8);
      const knockback = 160;
      projectiles.push({
        type: 'subFlame',
        ttl: duration,
        maxTtl: duration,
        dirX,
        dirY,
        follow: true,
        offset,
        len: length,
        halfWidth,
        dps: baseDps,
        elem: 'fire',
        knockback,
        runtimeRef: runtime,
        seed: Math.random() * Math.PI * 2,
      });
      runtime.usesLeft = Math.max(0, (runtime.usesLeft || 0) - 1);
      runtime.active = true;
      runtime.activeTimer = duration;
      updateSubWeaponHud();
      try { Audio?.playSfx?.(state, 'subFlame'); } catch { }
    }
    function useSubWeaponFlashbang(runtime) {
      const radius = 240;
      const stunDuration = 3.5;
      const effectDuration = 0.6;
      projectiles.push({
        type: 'subFlash',
        x: player.x,
        y: player.y,
        radius,
        stun: stunDuration,
        ttl: effectDuration,
        maxTtl: effectDuration,
        runtimeRef: runtime,
        applied: false,
      });
      runtime.usesLeft = Math.max(0, (runtime.usesLeft || 0) - 1);
      runtime.active = true;
      runtime.activeTimer = effectDuration;
      updateSubWeaponHud();
      try { Audio?.playSfx?.(state, 'subFlash'); } catch { }
      playFlashbangFx();
    }
    if (startLocalGameLoop._keyHandler) window.removeEventListener('keydown', startLocalGameLoop._keyHandler, true);
    startLocalGameLoop._keyHandler = (e) => {
      if (e.repeat) return;
      const key = e.key;
      if (key === 'q' || key === 'Q') {
        triggerActiveWeapon();
      } else if (key === 'e' || key === 'E') {
        triggerSubWeapon();
      }
    };
    addListener(window, 'keydown', startLocalGameLoop._keyHandler, true);
    if (startLocalGameLoop._gaugeClickHandler && activeGaugeEl) activeGaugeEl.removeEventListener('click', startLocalGameLoop._gaugeClickHandler);
    startLocalGameLoop._gaugeClickHandler = () => { triggerActiveWeapon(); };
    if (activeGaugeEl) addListener(activeGaugeEl, 'click', startLocalGameLoop._gaugeClickHandler);
    if (startLocalGameLoop._subGaugeClickHandler && hudSubWeaponGauge) hudSubWeaponGauge.removeEventListener('click', startLocalGameLoop._subGaugeClickHandler);
    startLocalGameLoop._subGaugeClickHandler = () => { triggerSubWeapon(); };
    if (hudSubWeaponGauge) addListener(hudSubWeaponGauge, 'click', startLocalGameLoop._subGaugeClickHandler);
    const diffName = state.room?.difficulty || 'ふつう';
    if (charName === 'メロ') {
      const meroPenalty = { 'かんたん': 0.8, 'ふつう': 0.7, 'むずかしい': 0.5 }[diffName] || 1;
      state.stats.bossDmgMul *= meroPenalty;
    }
    const koiRadius = { 'かんたん': 100, 'ふつう': 80, 'むずかしい': 70 }[diffName] || 80;
    let beamAng = 0; let uPulse = 0; let bombTimer = 0; let sniperTimer = 0; let sniperTargets = []; let decoyTimer = 0; let armorTimer = 0; let beamSpeedMul = 1; let atcKbActive = false; let andoActive = false; let lastMoveDir = { x: 1, y: 0 }; // timers
    // 自キャラ用の簡易FX（U用ライン演出など）
    let selfUTimer = 0;
    let uExCooldown = 0;
    const selfLines = [];
    let fullmoonActive = null;
    const fullmoonShockwaves = [];
    let fullmoonShieldHpBonus = 0;
    const supportBooks = [];
    let supportBookSpin = Math.random() * Math.PI * 2;
    let supportLaserTimer = 0;
    let lastSupportLaserCount = 0;
    let supportBombCooldown = 0;
    let lastSupportBombCount = 0;
    const andoDifficultyTable = {
      'かんたん': { interval: 3.5, hp: 30, dmg: 5.5, max: 15 },
      'ふつう': { interval: 3.0, hp: 25, dmg: 6.5, max: 12 },
      'むずかしい': { interval: 2.5, hp: 22, dmg: 7.5, max: 9 },
    };
    const andoBase = andoDifficultyTable[diffName] || andoDifficultyTable['ふつう'];
    const SUPPORT_BOOK_ORBIT_RADIUS = 72;
    const SUPPORT_BOOK_COLLISION_RADIUS = 14;
    const SUPPORT_BOOK_SPIN_SPEED = Math.PI * 1.6;
    const SUPPORT_BOOK_HIT_COOLDOWN = 0.35;
    const SUPPORT_BOOK_DRAW_SIZE = 30;
    const SUPPORT_LASER_SPEED = 200;
    const SUPPORT_LASER_COOLDOWN = 3;
    const SUPPORT_LASER_MAX_BOUNCES = 5;
    const SUPPORT_LASER_RADIUS = 6;
    const SUPPORT_LASER_DAMAGE_MUL = 0.5;
    const SUPPORT_LASER_HIT_COOLDOWN = 0.2;
    const SUPPORT_LASER_MAX_LIFETIME = 12;
    const SUPPORT_BOMB_RADIUS = 80;
    const SUPPORT_BOMB_COOLDOWN = 10;
    const SUPPORT_BOMB_TRAVEL_TIME = 0.6;
    const SUPPORT_BOMB_DROP_HEIGHT = 260;
    const SUPPORT_BOMB_ARC_HEIGHT = 160;
    const SUPPORT_BOMB_DAMAGE_MUL = 1.5;
    const SUPPORT_BOMB_FIRE_TIME = 3;
    const SUPPORT_BOMB_FIRE_MUL = 0.5;
    const SUPPORT_BOMB_KNOCKBACK = 250;
    const nataBase = {
      regen: 0.35,
      leftRange: 40,
      leftHeight: 60,
      leftDps: 7,
      healRange: 60,
      healRate: 2,
      activeRangeMul: 1.5,
      activeSpdMul: 1.2,
      activeHealFraction: 1,
    };
    const nataDifficultyOverrides = {
      'むずかしい': {
        regen: 0.2,
        healRate: 1,
        activeRangeMul: 1.25,
        activeSpdMul: 1.1,
        activeHealFraction: 0.5,
      },
    };
    const cfg = {
      okp: { interval: 1.2, dmg: 8, spd: 260, pr: 9, count: 1, range: 200 },
      nata: { ...nataBase, ...(nataDifficultyOverrides[diffName] || {}) },
      atc: { radius: 110, width: 0.28, dps: 40 },
      haku: { radius: 70, dps: 16, kb: 180 },
      koi: { interval: 1.5, dmg: 20, spd: 200, fuse: 2, radius: koiRadius, air: 0, fireTime: 2.5, fireDps: 12, knockback: 350 },
      mero: { charge: 2.3, dmgScale: 6, spd: 800, r: 3, ttl: 2.0, exRadius: 80, exDmgScale: 3 },
      fullmoon: { baseHp: 300, regen: 60, dmg: 9, kb: 160, sizeEasy: 60, sizeNormal: 50, sizeHard: 40, rotSpd: 2, skillHpGain: 60 },
      u: { dps: 1.2, zone: 0.5, baseZone: 0.5 },
      ando: {
        ...andoBase,
        spd: 120,
        exRadius: 40,
        exFireTime: 1.5,
        exFireDps: 6,
        exKnockback: 100,
      },
      common: { interval: 1.0, spd: 380, r: 3.5, dmgScale: 0.5, range: 320, ttl: 1.2, count: 1, spread: 0.15 },
    };
    function syncSupportBookCount() {
      const desired = Math.max(0, Math.min(getSupportBookMax(), openLevelUp.supportBooks || 0));
      while (supportBooks.length > desired) { supportBooks.pop(); }
      while (supportBooks.length < desired) {
        supportBooks.push({ hitCooldowns: new Map(), x: player.x, y: player.y });
      }
    }
    clampSupportMagicCounts = () => {
      const maxBooks = getSupportBookMax();
      const maxLasers = getSupportLaserMax();
      const maxBombs = getSupportBombMax();
      const currentBooks = Math.max(0, openLevelUp.supportBooks || 0);
      const currentLasers = Math.max(0, openLevelUp.supportLasers || 0);
      const currentBombs = Math.max(0, openLevelUp.supportBombs || 0);
      const clampedBooks = Math.min(maxBooks, currentBooks);
      const clampedLasers = Math.min(maxLasers, currentLasers);
      const clampedBombs = Math.min(maxBombs, currentBombs);
      if (clampedBooks !== currentBooks) openLevelUp.supportBooks = clampedBooks;
      if (clampedLasers !== currentLasers) openLevelUp.supportLasers = clampedLasers;
      if (clampedBombs !== currentBombs) openLevelUp.supportBombs = clampedBombs;
      syncSupportBookCount();
    };
    clampSupportMagicCounts();
    function triggerSupportBombs(count) {
      if (!Number.isFinite(count) || count <= 0) return;
      const camSource = Number.isFinite(state.camera?.x) && Number.isFinite(state.camera?.y)
        ? state.camera
        : (state._lastSafeCamera || { x: player.x, y: player.y });
      const camX = Number.isFinite(camSource?.x) ? camSource.x : player.x;
      const camY = Number.isFinite(camSource?.y) ? camSource.y : player.y;
      const halfW = cvs.width / 2;
      const halfH = cvs.height / 2;
      const margin = SUPPORT_BOMB_RADIUS;
      const minX = camX - halfW + margin;
      const maxX = camX + halfW - margin;
      const minY = camY - halfH + margin;
      const maxY = camY + halfH - margin;
      const rangeX = Math.max(0, maxX - minX);
      const rangeY = Math.max(0, maxY - minY);
      for (let i = 0; i < count; i++) {
        const targetX = rangeX <= 0 ? camX : (minX + Math.random() * rangeX);
        const targetY = rangeY <= 0 ? camY : (minY + Math.random() * rangeY);
        const startX = targetX + (Math.random() - 0.5) * 60;
        const drop = Number.isFinite(SUPPORT_BOMB_DROP_HEIGHT) ? SUPPORT_BOMB_DROP_HEIGHT : 240;
        const startY = targetY - drop;
        projectiles.push({
          type: 'supportBomb',
          startX,
          startY,
          targetX,
          targetY,
          travelTime: SUPPORT_BOMB_TRAVEL_TIME,
          arcHeight: SUPPORT_BOMB_ARC_HEIGHT,
          radius: SUPPORT_BOMB_RADIUS,
          dmgMul: SUPPORT_BOMB_DAMAGE_MUL,
          fireTime: SUPPORT_BOMB_FIRE_TIME,
          fireMul: SUPPORT_BOMB_FIRE_MUL,
          knockback: SUPPORT_BOMB_KNOCKBACK,
          dropHeight: drop,
        });
      }
    }
    const isAndoPriorityTarget = (target) => {
      if (!target) return false;
      if (target.type === 'tank' || target.type === 'special') return true;
      const name = target.name || '';
      if (name === '中型個体' || name === '大型個体') return true;
      if (target.boss) {
        const idStr = typeof target.id === 'string' ? target.id : String(target.id ?? '');
        if (idStr.startsWith('mb') || idStr.startsWith('b')) return true;
      }
      return false;
    };
    const fullmoonShieldSize = { 'かんたん': cfg.fullmoon.sizeEasy, 'ふつう': cfg.fullmoon.sizeNormal, 'むずかしい': cfg.fullmoon.sizeHard }[diffName] || cfg.fullmoon.sizeNormal;
    function getFullmoonDir(activeState = fullmoonActive) {
      const rawX = typeof activeState?.dirX === 'number' ? activeState.dirX : (shield?.dirX ?? 1);
      const rawY = typeof activeState?.dirY === 'number' ? activeState.dirY : (shield?.dirY ?? 0);
      const len = Math.hypot(rawX, rawY) || 1;
      return { x: rawX / len, y: rawY / len };
    }
    function getFullmoonShieldMaxHp() { return cfg.fullmoon.baseHp + fullmoonShieldHpBonus; }
    function reviveFullmoonShield() {
      if (charName !== 'フルムーン') return null;
      const maxHp = getFullmoonShieldMaxHp();
      if (!shield) {
        shield = { hp: maxHp, maxHp, cd: 0, size: fullmoonShieldSize, dirX: 1, dirY: 0, w: fullmoonShieldSize * 0.4, ang: 0 };
      } else {
        shield.maxHp = maxHp;
        shield.hp = maxHp;
        shield.cd = 0;
      }
      return shield;
    }
    function getFullmoonTarget(activeState = fullmoonActive) {
      const dist = typeof activeState?.targetDist === 'number'
        ? activeState.targetDist
        : ((shield?.size ?? 50) + 30);
      const { x: dirX, y: dirY } = getFullmoonDir(activeState);
      return { x: player.x + dirX * dist, y: player.y + dirY * dist };
    }
    function triggerFullmoonSlam(activeState = fullmoonActive) {
      const active = activeState || fullmoonActive;
      if (!active) return;
      const { x: dirX, y: dirY } = getFullmoonDir(active);
      const dist = typeof active.targetDist === 'number' ? active.targetDist : ((shield?.size ?? 50) + 30);
      const centerX = player.x + dirX * dist;
      const centerY = player.y + dirY * dist;
      const slamRadius = typeof active.slamRadius === 'number' ? active.slamRadius : ((shield?.size ?? 50) * 1.4);
      const serverSim = !!state.serverSim;
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = e.x - centerX;
        const dy = e.y - centerY;
        const distEnemy = Math.hypot(dx, dy);
        if (distEnemy <= slamRadius + (e.r || 0)) {
          let dmg = getAtk() * 8;
          const elemStage = getPlayerElementStage(state.stats.elem);
          dmg = applyElementalMultiplier(dmg, state.stats.elem, e.elem, elemStage);
          dmg = applyBossBonus(dmg, e);
          const mul = e.dmgTakenMul ?? 1;
          if (serverSim) {
            queueHit(e.id, dmg, dmg * mul);
            accumServerDamage(e.id, dmg * mul, e.x, e.y);
          } else {
            const actual = dmg * mul;
            e.hp -= actual;
            if (e.hp <= 0 && e.alive) { pushKill(e); }
          }
          const kb = 800;
          const kdx = e.x - player.x;
          const kdy = e.y - player.y;
          const kdist = Math.hypot(kdx, kdy) || 1;
          e.x += (kdx / kdist) * kb;
          e.y += (kdy / kdist) * kb;
        }
      }
      fullmoonShockwaves.push({ x: centerX, y: centerY, baseRadius: slamRadius * 0.6, maxRadius: slamRadius * 2.1, elapsed: 0, dur: 0.5 });
      selfLines.push({ x1: player.x, y1: player.y, x2: centerX, y2: centerY, ttl: 0.2, w: 6, col: '#fff' });
      try { Audio?.playSfx?.(state, 'fullmoonSlam'); } catch { }
    }
    // Fixed reaper sniper configuration (independent of Mero enhancements)
    const reaperCfg = { charge: 2.3, spd: 800, r: 3, ttl: 2.0 };
    if (charName === 'フルムーン') {
      reviveFullmoonShield();
    }
    state.allies = {};
    const allyFx = {};
    function startJump(pad) {
      jumpState.active = true; jumpState.t = 0; jumpState.dur = 0.35;
      jumpState.sx = player.x; jumpState.sy = player.y;
      jumpState.ex = player.x + pad.dx * pad.dist;
      jumpState.ey = player.y + pad.dy * pad.dist;
      player.vx = 0; player.vy = 0;
      try { Audio?.playSfx?.(state, 'jumpPad'); } catch { }
    }
    function updateJump(dt) {
      jumpState.t += dt;
      const r = Math.min(1, jumpState.t / jumpState.dur);
      player.x = jumpState.sx + (jumpState.ex - jumpState.sx) * r;
      player.y = jumpState.sy + (jumpState.ey - jumpState.sy) * r;
      if (r >= 1) jumpState.active = false;
    }
    function applySpikeDamage(dt, px = player.x, py = player.y) {
      const obs = getNearbyObstacles(px, py);
      for (const rect of obs) {
        if (circleRectCollide(px, py, player.r, rect)) {
          const dmg = (stage.spikeDamage || 10) * dt;
          const { hp: takenHp } = applyPlayerDamage(dmg);
          playerDmgAcc += takenHp;
          const nowHit = performance.now();
          if (nowHit - state.audio.lastHitAt > 300) {
            try { Audio?.playSfx?.(state, 'hit'); } catch { }
            state.audio.lastHitAt = nowHit;
          }
          break;
        }
      }
    }
    function applyLavaDamage(px = player.x) {
      if (px < lavaX) {
        const dmg = stage.lavaDamage || 999;
        const { hp: taken } = applyPlayerDamage(dmg);
        playerDmgAcc += taken;
      }
    }
    // segment-rect intersection helper (for wall checks in maze)
    function lineIntersectsRect(x1, y1, x2, y2, r) {
      // Cohen–Sutherland-like quick reject using AABB
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      if (maxX < r.x || minX > r.x + r.w || maxY < r.y || minY > r.y + r.h) {
        // bounding boxes do not overlap -> might still clip corners but good early reject
        // keep checking edges only when AABBs overlap to reduce cost
      } else {
        // Check intersection with each edge of the rectangle
        const edges = [
          [r.x, r.y, r.x + r.w, r.y], // top
          [r.x + r.w, r.y, r.x + r.w, r.y + r.h], // right
          [r.x, r.y + r.h, r.x + r.w, r.y + r.h], // bottom
          [r.x, r.y, r.x, r.y + r.h], // left
        ];
        for (const [ex1, ey1, ex2, ey2] of edges) { if (segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2)) return true; }
        // fully inside rectangle (both points inside) also counts as blocked
        if (x1 >= r.x && x1 <= r.x + r.w && y1 >= r.y && y1 <= r.y + r.h &&
          x2 >= r.x && x2 <= r.x + r.w && y2 >= r.y && y2 <= r.y + r.h) return true;
      }
      return false;
      function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
        const o1 = orient(ax, ay, bx, by, cx, cy);
        const o2 = orient(ax, ay, bx, by, dx, dy);
        const o3 = orient(cx, cy, dx, dy, ax, ay);
        const o4 = orient(cx, cy, dx, dy, bx, by);
        if (o1 * o2 < 0 && o3 * o4 < 0) return true; // proper intersection
        // collinear/touching cases
        if (o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
        if (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
        if (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
        if (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
        return false;
      }
      function orient(ax, ay, bx, by, cx, cy) { return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)); }
      function onSeg(ax, ay, bx, by, px, py) { return Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by); }
    }
    function hasWallBetween(ax, ay, bx, by) {
      if (stage.type !== 'maze' && !stage.iceBlocks) return false;
      if (stage.ignoreMobWalls) return false;
      // Limit checks to nearby chunks to keep it light
      const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      const obs = getNearbyObstacles(mx, my);
      for (const r of obs) { if (lineIntersectsRect(ax, ay, bx, by, r)) return true; }
      return false;
    }
    function distToSegmentSq(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1;
      const dy = y2 - y1;
      if (dx === 0 && dy === 0) {
        const ddx = px - x1;
        const ddy = py - y1;
        return ddx * ddx + ddy * ddy;
      }
      const t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
      const clamped = Math.max(0, Math.min(1, t));
      const cx = x1 + clamped * dx;
      const cy = y1 + clamped * dy;
      const ddx = px - cx;
      const ddy = py - cy;
      return ddx * ddx + ddy * ddy;
    }
    // Convert world coordinates to screen coordinates based on the camera
    function toScreen(x, y) {
      let camX = state.camera.x;
      let camY = state.camera.y;
      if (!Number.isFinite(camX) || !Number.isFinite(camY)) {
        const safeCam = state._lastSafeCamera;
        if (safeCam && Number.isFinite(safeCam.x) && Number.isFinite(safeCam.y)) {
          camX = safeCam.x;
          camY = safeCam.y;
          state.camera.x = camX;
          state.camera.y = camY;
        } else {
          return { x: cvs.width / 2, y: cvs.height / 2 };
        }
      }
      return { x: cvs.width / 2 + (x - camX), y: cvs.height / 2 + (y - camY) };
    }
    function applyCameraPosition(cx, cy, reason = 'update') {
      if (Number.isFinite(cx) && Number.isFinite(cy)) {
        state.camera.x = cx;
        state.camera.y = cy;
        state._lastSafeCamera = { x: cx, y: cy };
      } else {
        const safeCam = state._lastSafeCamera;
        if (safeCam && Number.isFinite(safeCam.x) && Number.isFinite(safeCam.y)) {
          state.camera.x = safeCam.x;
          state.camera.y = safeCam.y;
        } else {
          state.camera.x = 0;
          state.camera.y = 0;
        }
        console.warn(`camera position became non-finite during ${reason}; reverting`, cx, cy);
      }
    }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    // Helper: check if world point is on current screen (with margin px)
    function isOnScreen(wx, wy, margin = 0) {
      const s = toScreen(wx, wy);
      return s.x >= -margin && s.x <= cvs.width + margin && s.y >= -margin && s.y <= cvs.height + margin;
    }
    // FX overlay layer（死亡・復活・レベルアップの画面演出）
    let fxLayer = document.getElementById('vlg-fx');
    if (!fxLayer) {
      fxLayer = document.createElement('div');
      fxLayer.id = 'vlg-fx';
      Object.assign(fxLayer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 2000 });
      document.body.appendChild(fxLayer);
    }
    function playGameOverFx() {
      try {
        document.body.classList.add('vlg-death-filter');
        const el = document.createElement('div');
        el.className = 'vlg-fx-gameover';
        el.textContent = 'ゲームオーバー';
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } document.body.classList.remove('vlg-death-filter'); }, 2000);
      } catch { }
    }
    function playReviveFx() {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-revive';
        el.textContent = '復活！';
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 800);
      } catch { }
    }
    function playLevelUpFx() {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-levelup';
        el.textContent = 'LEVEL UP!';
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 900);
      } catch { }
    }
    function playBossAppearFx(name, _type) {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-boss';
        el.textContent = `${name || 'BOSS'}出現！`;
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 900);
      } catch { }
    }
    function playBossAttackFx() {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-boss-attack';
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 400);
      } catch { }
    }
    function playFlashbangFx() {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-flashbang';
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 450);
      } catch { }
    }
    function playBossKillFx(name) {
      try {
        const el = document.createElement('div');
        el.className = 'vlg-fx-boss-kill';
        el.textContent = `${name || 'ボス'}撃破！`;
        fxLayer.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch { } }, 1200);
      } catch { }
    }
    // Helper: in maze, ensure there is line-of-sight between two points; otherwise allow by default
    function canSee(ax, ay, bx, by) {
      if (stage.ignoreMobWalls) return true;
      return (stage.type !== 'maze' && !stage.iceBlocks) ? true : !hasWallBetween(ax, ay, bx, by);
    }
    function pushKill(e) {
      if (e._accDmg && e._accDmg > 0) { spawnDamageNumber(e.x, e.y, '-' + Math.round(e._accDmg)); e._accDmg = 0; }
      e.alive = false; kills++;
      spawnKillFx(e.x, e.y);
      if (e.boss) {
        // generous rewards for boss: burst of high-value orbs
        const base = 10 + Math.floor(timeAlive / 120);
        const count = 24;
        for (let i = 0; i < count; i++) {
          const ang = (Math.PI * 2 * i) / count;
          const dist = 12 + (i % 3) * 6;
          pushOrb({ x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 5, value: base });
        }
        try { Audio?.playSfx?.(state, 'boss'); } catch { try { Audio?.playSfx?.(state, 'kill'); } catch { } }
        try { playBossKillFx(e.name); } catch { }
        // ドロップ: 中ボス/ボスで回復アイテムを確定ドロップ
        try {
          const idStr = String(e.id || '');
          const nameStr = e.name || '';
          // 中型個体判定: id が mb で始まる、または name が 中型個体
          if (idStr.startsWith('mb') || nameStr === '中型個体') {
            const healVal = Math.round(20 * (stage.healValueMul || 1));
            heals.push({ id: 'lh' + Math.random().toString(36).slice(2, 8), type: 'heal', x: e.x, y: e.y, r: 8, value: healVal });
            if (state.cardShopUnlocked) {
              cardOrbs.push({ id: 'co' + Math.random().toString(36).slice(2, 8), x: e.x, y: e.y, r: 8, rarity: 2 });
            }
            for (let i = 0; i < 5; i++) {
              const ang = Math.random() * Math.PI * 2;
              const dist = 10 + Math.random() * 20;
              moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 8, value: 100 });
            }
            // 中ボスは5倍経験値オーブを1つドロップ
            pushOrb({ x: e.x, y: e.y, r: 8, value: base * 5, type: 'exp5' });
          }
          // 大型個体判定: id が b で始まる（reaper は別扱いでも虹にする）または name が 大型個体/死神
          else if (idStr.startsWith('b') || idStr.startsWith('rp') || nameStr === '大型個体' || nameStr === '死神') {
            heals.push({ id: 'rb' + Math.random().toString(36).slice(2, 8), type: 'rainbow', x: e.x, y: e.y, r: 12, value: 50 });
            const rroll = Math.random();
            const rarity = (rroll < 0.05) ? 4 : 3;
            if (state.cardShopUnlocked) {
              cardOrbs.push({ id: 'co' + Math.random().toString(36).slice(2, 8), x: e.x, y: e.y, r: 8, rarity });
            }
            moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: e.x, y: e.y, r: 10, value: 1000 });
            for (let i = 0; i < 20; i++) {
              const ang = (Math.PI * 2 * i) / 20;
              const dist = 18 + (i % 4) * 4;
              pushOrb({ x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 5, value: base });
            }
            // ボスは5倍経験値オーブを3つドロップ
            for (let i = 0; i < 3; i++) {
              const ang = Math.random() * Math.PI * 2;
              const dist = 10 + Math.random() * 15;
              pushOrb({ x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 8, value: base * 5, type: 'exp5' });
            }
          }
        } catch (err) { }
      } else {
        const baseExp = 1 + Math.floor(timeAlive / 20);
        pushOrb({ x: e.x, y: e.y, r: 4, value: baseExp });
        if (e.type === 'tank' && Math.random() < 0.3) {
          pushOrb({ x: e.x, y: e.y, r: 8, value: baseExp * 5, type: 'exp5' });
        }
        if (e.type === 'special') {
          for (let i = 0; i < 3; i++) {
            const ang = Math.random() * Math.PI * 2;
            const dist = 10 + Math.random() * 18;
            heals.push({ id: 'rb' + Math.random().toString(36).slice(2, 8), type: 'rainbow', x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 12, value: 50 });
          }
          for (let i = 0; i < 3; i++) {
            const ang = Math.random() * Math.PI * 2;
            const dist = 10 + Math.random() * 18;
            moneys.push({ id: 'mn' + Math.random().toString(36).slice(2, 8), x: e.x + Math.cos(ang) * dist, y: e.y + Math.sin(ang) * dist, r: 10, value: 1000 });
          }
          for (const def of specialKillAchievements) {
            if (!def?.id) continue;
            if (isAchievementUnlocked(def.id)) continue;
            unlockAchievement(def.id);
          }
        }
      }
      try { Audio?.playSfx?.(state, 'kill'); } catch { }
    }

    function spawnBoss() {
      // spawn a large enemy just outside the view so it's encountered quickly
      const angle = Math.random() * Math.PI * 2; const radius = 360; const spawnR = 22;
      let ex = player.x + Math.cos(angle) * radius; let ey = player.y + Math.sin(angle) * radius;
      if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
      if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 24, hh - 24); }
      if (stage.type === 'maze' || stage.iceBlocks || stage.poison) { let tries = 12; while (tries-- > 0) { const obs = getNearbyObstacles(ex, ey); let blocked = obs.some(r => circleRectCollide(ex, ey, 20, r)); if (stage.poison && isPoisonAt(ex, ey)) blocked = true; if (!blocked) break; const ang2 = Math.random() * Math.PI * 2; ex = player.x + Math.cos(ang2) * radius; ey = player.y + Math.sin(ang2) * radius; if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; } } }
      if (stage.type === 'volcano') {
        ex = Math.max(ex, lavaX + spawnR + 1);
      }
      const diffName = state.room?.difficulty || 'ふつう';
      const diffCfg = getDifficultyConfig(diffName) || { hpMul: 1, spawnMul: 1, bulletMul: 1, bulletDmgMul: 1, mobHpMul: 1, tankHpMul: 1, midBossHpMul: 1, bossHpMul: 1 };
      // boss HP now scales with time and number of participants
      const timeFactor = Math.floor(timeAlive / 600); // number of 10-minute intervals elapsed
      const playerCount = Math.max(1, state.room?.members?.length || 1);
      const hpMax = Math.floor((1500 + Math.floor(timeAlive * 2)) * Math.pow(1.5, timeFactor) * diffCfg.hpMul * diffCfg.bossHpMul * (stage.bossHpMul || 1) * 1.5 * playerCount);
      const e = {
        id: 'b' + Math.random().toString(36).slice(2, 10),
        boss: true,
        name: '大型個体',
        type: 'boss',
        x: ex, y: ey, r: spawnR,
        hp: hpMax, maxHp: hpMax,
        spd: 70,
        alive: true,
        t: 0,
        cd: 1.0 / diffCfg.bulletMul,      // bullet ring cooldown
        stompCd: 4.0, // stomp aoe cooldown
      };
      enemies.push(e);
      showToast('大型の敵が現れた！');
      try { Audio?.playSfx?.(state, 'alert'); } catch { }
      try { playBossAppearFx(e.name, e.type); } catch { }
    }

    function spawnMidBoss() {
      const angle = Math.random() * Math.PI * 2; const radius = 340; const spawnR = 20;
      let ex = player.x + Math.cos(angle) * radius; let ey = player.y + Math.sin(angle) * radius;
      if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
      if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 24, hh - 24); }
      if (stage.type === 'maze' || stage.iceBlocks || stage.poison) { let tries = 12; while (tries-- > 0) { const obs = getNearbyObstacles(ex, ey); let blocked = obs.some(r => circleRectCollide(ex, ey, 20, r)); if (stage.poison && isPoisonAt(ex, ey)) blocked = true; if (!blocked) break; const ang2 = Math.random() * Math.PI * 2; ex = player.x + Math.cos(ang2) * radius; ey = player.y + Math.sin(ang2) * radius; if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; } } }
      if (stage.type === 'volcano') {
        ex = Math.max(ex, lavaX + spawnR + 1);
      }
      const diffName = state.room?.difficulty || 'ふつう';
      const diffCfg = getDifficultyConfig(diffName) || { hpMul: 1, spawnMul: 1, bulletMul: 1, bulletDmgMul: 1, mobHpMul: 1, tankHpMul: 1, midBossHpMul: 1, bossHpMul: 1 };
      const timeFactor = Math.floor(timeAlive / 600);
      const playerCount = Math.max(1, state.room?.members?.length || 1);
      const hpMax = Math.floor((800 + Math.floor(timeAlive * 1.5)) * Math.pow(1.5, timeFactor) * diffCfg.hpMul * diffCfg.midBossHpMul * (stage.midBossHpMul || 1) * 1.5 * playerCount);
      const e = {
        id: 'mb' + Math.random().toString(36).slice(2, 10),
        boss: true,
        name: '中型個体',
        type: 'boss',
        x: ex, y: ey, r: spawnR,
        hp: hpMax, maxHp: hpMax,
        spd: 60,
        alive: true,
        t: 0,
        cd: 1.0 / diffCfg.bulletMul,
        stompCd: 4.0,
      };
      enemies.push(e);
      showToast('中型の敵が現れた！');
      try { Audio?.playSfx?.(state, 'alert'); } catch { }
      try { playBossAppearFx(e.name, e.type); } catch { }
    }

    // spawn multiple death reapers with massive HP and dark attribute
    function spawnReapers() {
      const count = 3; // spawn three reapers
      const radius = 360; const spawnR = 22;
      let spawned = 0;
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        let ex = player.x + Math.cos(angle) * radius;
        let ey = player.y + Math.sin(angle) * radius;
        if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
        if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 24, hh - 24); }
        if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
          let tries = 12;
          while (tries-- > 0) {
            const obs = getNearbyObstacles(ex, ey);
            let blocked = obs.some(r => circleRectCollide(ex, ey, 20, r));
            if (stage.poison && isPoisonAt(ex, ey)) blocked = true;
            if (!blocked) break;
            const ang2 = Math.random() * Math.PI * 2;
            ex = player.x + Math.cos(ang2) * radius;
            ey = player.y + Math.sin(ang2) * radius;
            if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; }
          }
        }
        if (stage.type === 'volcano') {
          ex = Math.max(ex, lavaX + spawnR + 1);
        }
        const rHp = Math.round(999999 * (stage.mobHpMul || 1));
        const e = {
          id: 'rp' + Math.random().toString(36).slice(2, 10),
          boss: true,
          name: '死神',
          type: 'reaper',
          elem: 'dark',
          x: ex, y: ey, r: spawnR,
          hp: rHp, maxHp: rHp,
          spd: 270,
          alive: true,
          t: 0,
          cd: 1.0,
        };
        enemies.push(e);
        spawned++;
      }
      showToast('死神が現れた！');
      try { Audio?.playSfx?.(state, 'alert'); } catch { }
      try { playBossAppearFx('死神', 'reaper'); } catch { }
      return spawned;
    }

    function spawnNeutralWave() {
      const diffCfg = getDifficultyConfig(diffName) || { maxEnemies: 40, hpMul: 1, mobHpMul: 1 };
      const playerCount = Math.max(1, state.room?.members?.length || 1);
      const baseCount = Math.round((diffCfg.maxEnemies || 40) * 0.75);
      const count = Math.round(baseCount * playerCount);
      const diffMul = (1 + Math.min(1.8, timeAlive * 0.001)) * diffCfg.hpMul * diffCfg.mobHpMul * (stage.mobHpMul || 1);
      const baseHp = 8 + Math.floor(timeAlive / 20);
      const durabilityMul = 1 + Math.floor(timeAlive / 120) * 0.1;
      const hp = Math.round(baseHp * diffMul * durabilityMul);
      const baseSpd = 40 + Math.min(120, timeAlive * 0.08);
      let spawned = 0;
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2; const radius = 380; const spawnR = 9;
        let ex = player.x + Math.cos(angle) * radius; let ey = player.y + Math.sin(angle) * radius;
        if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
        if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 12, hh - 12); }
        if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
          let tries = 8;
          while (tries-- > 0) {
            const obs = getNearbyObstacles(ex, ey);
            let blocked = obs.some(r => circleRectCollide(ex, ey, 8, r));
            if (stage.poison && isPoisonAt(ex, ey)) blocked = true;
            if (!blocked) break;
            const ang2 = Math.random() * Math.PI * 2;
            ex = player.x + Math.cos(ang2) * radius;
            ey = player.y + Math.sin(ang2) * radius;
            if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; }
          }
        }
        if (stage.type === 'volcano') {
          ex = Math.max(ex, lavaX + spawnR + 1);
        }
        enemies.push({ x: ex, y: ey, r: spawnR, hp, spd: baseSpd, alive: true, type: 'chaser', ttl: 30 });
        spawned++;
      }
      return spawned;
    }

    // Global input manager: ensure listeners are attached once and always reference the same Set
    const input = (() => {
      if (!window.__vlgInput) {
        const pressed = new Set();
        const isTypingTarget = (el) => {
          const tag = el?.tagName;
          return tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable;
        };
        const onKeyDown = (e) => {
          if (isTypingTarget(e.target)) return;
          const low = (e.key || '').toLowerCase();
          const isArrow = low.startsWith('arrow');
          const isWASD = ['w', 'a', 's', 'd'].includes(low);
          if (isArrow || isWASD) {
            try { e.preventDefault(); } catch { }
            const keyId = isArrow ? ('Arrow' + low.replace('arrow', '')[0].toUpperCase() + low.replace('arrow', '').slice(1)) : low;
            pressed.add(keyId);
          }
        };
        const onKeyUp = (e) => {
          if (isTypingTarget(e.target)) return;
          const low = (e.key || '').toLowerCase();
          const isArrow = low.startsWith('arrow');
          const isWASD = ['w', 'a', 's', 'd'].includes(low);
          const keyId = isArrow ? ('Arrow' + low.replace('arrow', '')[0].toUpperCase() + low.replace('arrow', '').slice(1)) : low;
          if (isArrow || isWASD) pressed.delete(keyId);
        };
        const onBlur = () => { try { pressed.clear(); } catch { } };
        addListener(window, 'keydown', onKeyDown, { capture: true });
        addListener(window, 'keyup', onKeyUp, { capture: true });
        addListener(window, 'blur', onBlur);
        addListener(document, 'visibilitychange', () => { if (document.visibilityState !== 'visible') try { pressed.clear(); } catch { } });

        if (isMobile) {
          let startX = 0, startY = 0, movementId = null;
          const updateDir = (dx, dy) => {
            pressed.delete('ArrowLeft');
            pressed.delete('ArrowRight');
            pressed.delete('ArrowUp');
            pressed.delete('ArrowDown');
            const th = 10;
            if (dx < -th) pressed.add('ArrowLeft');
            if (dx > th) pressed.add('ArrowRight');
            if (dy < -th) pressed.add('ArrowUp');
            if (dy > th) pressed.add('ArrowDown');
          };
          const isInteractive = (e) => !!e.target.closest('button, input, select, textarea, label, a');
          const onTouchStart = (e) => {
            if (!state.inGame || movementId !== null || isInteractive(e) || !e.target.closest('#gameCanvas')) return;
            const t = e.changedTouches[0];
            startX = t.clientX;
            startY = t.clientY;
            movementId = t.identifier;
            e.preventDefault();
          };
          const getMovementTouch = (touchList) => {
            for (const t of touchList) if (t.identifier === movementId) return t;
            return null;
          };
          const onTouchMove = (e) => {
            if (!state.inGame) return;
            const t = getMovementTouch(e.touches);
            if (!t) return;
            e.preventDefault();
            updateDir(t.clientX - startX, t.clientY - startY);
          };
          const onTouchEnd = (e) => {
            if (!state.inGame) return;
            const t = getMovementTouch(e.changedTouches);
            if (!t) return;
            e.preventDefault();
            movementId = null;
            updateDir(0, 0);
          };
          addListener(window, 'touchstart', onTouchStart, { passive: false });
          addListener(window, 'touchmove', onTouchMove, { passive: false });
          addListener(window, 'touchend', onTouchEnd, { passive: false });
          addListener(window, 'touchcancel', onTouchEnd, { passive: false });
        }
        window.__vlgInput = {
          pressed,
          clear: () => { try { pressed.clear(); } catch { } },
        };
      }
      return window.__vlgInput;
    })();
    const pressed = input.pressed;
    // Clear any sticky keys from previous session
    input.clear();
    // Backward compatibility for existing calls
    window.__vlgClearPressed = () => { try { input.clear(); } catch { } };
    ensureFpsEl();

    // ===== Death camera controls =====
    let camDrag = false; let camDragPrevX = 0; let camDragPrevY = 0;
    addListener(window, 'mousedown', (e) => {
      if (e.button !== 0) return; // left button only
      if (state.stats.alive) return; // only when player is dead
      camDrag = true;
      camDragPrevX = e.clientX;
      camDragPrevY = e.clientY;
      state.spectating = false;
    });
    addListener(window, 'mousemove', (e) => {
      if (!camDrag || state.stats.alive) return;
      const dx = e.clientX - camDragPrevX;
      const dy = e.clientY - camDragPrevY;
      camDragPrevX = e.clientX;
      camDragPrevY = e.clientY;
      const camNx = state.camera.x + dx;
      const camNy = state.camera.y + dy;
      applyCameraPosition(camNx, camNy, 'death-drag-mouse');
    });
    const stopCamDrag = () => { camDrag = false; };
    addListener(window, 'mouseup', stopCamDrag);
    addListener(window, 'mouseleave', stopCamDrag);

    // Switch spectate target with Tab while dead
    addListener(window, 'keydown', (e) => {
      if (e.key !== 'Tab') return;
      if (state.stats.alive) return;
      const alive = Object.keys(state.allies).filter(pid => state.allies[pid]?.alive);
      if (alive.length === 0) return;
      e.preventDefault();
      const idx = alive.indexOf(state._spectateTarget);
      const next = alive[(idx + 1) % alive.length];
      state._spectateTarget = next;
      state.spectating = true;
      state._nextSpectateSwitch = performance.now() + 5000;
      const target = state.allies[next];
      if (target) { applyCameraPosition(target.x, target.y, 'spectate-switch'); }
    });

    // damage/heal visualization accumulators
    let playerDmgAcc = 0; let playerHealAcc = 0; let lastPlayerDmgAt = 0; let lastPlayerHealAt = 0;
    function applyPlayerDamage(dmg) {
      if (!isFinite(dmg) || dmg <= 0) return { hp: 0, armor: 0 };
      dmg *= state.stats.dmgTakenMul;
      if (state.energyUnlocked) {
        const b = state.energy.brand;
        // ブランド力に応じて被ダメージを補正
        // b=100 -> 0.8, b=50 -> 0.9, b=0 -> 1.1
        const bMul = 0.00002 * b * b - 0.005 * b + 1.1;
        dmg *= bMul;
      }
      let armorLoss = 0; let hpLoss = 0;
      if (state.stats.armor > 0) {
        const use = Math.min(state.stats.armor, dmg);
        state.stats.armor -= use;
        armorLoss = use;
        dmg -= use;
      }
      if (dmg > 0) {
        state.stats.hp -= dmg;
        hpLoss = dmg;
      }
      return { hp: hpLoss, armor: armorLoss };
    }
    function accumEnemyDamage(e, amount) {
      checkDamageAchievements(amount);
      e._accDmg = (e._accDmg || 0) + amount; const now = performance.now(); e._lastNumAt = e._lastNumAt || 0;
      if (now - e._lastNumAt > 250) { const show = Math.round(e._accDmg); if (show >= 1) { spawnDamageNumber(e.x, e.y, '-' + show); e._accDmg = 0; e._lastNumAt = now; } }
    }
    function flushPlayerNumbers(now) {
      if (playerDmgAcc >= 1 && now - lastPlayerDmgAt > 300) { const val = Math.round(playerDmgAcc); spawnDamageNumber(state.camera.x, state.camera.y, '-' + val, { color: '#f87171' }); playerDmgAcc = 0; lastPlayerDmgAt = now; }
      if (playerHealAcc >= 1 && now - lastPlayerHealAt > 350) { const val = Math.round(playerHealAcc); spawnHealNumber(state.camera.x, state.camera.y, val); playerHealAcc = 0; lastPlayerHealAt = now; }
    }

    // overlay for waiting other players to finish level-up
    const WAIT_LV_TEXT = '他人の操作で待機中。。。';
    let waitLvOverlay = null;
    let waitLvOverlayTimer = null;
    let waitLvOverlaySession = 0;
    function showWaitLvOverlay() {
      if (!waitLvOverlay) {
        waitLvOverlay = document.createElement('div');
        waitLvOverlay.id = 'vlg-wait-levelup';
        waitLvOverlay.textContent = WAIT_LV_TEXT;
        Object.assign(waitLvOverlay.style, {
          position: 'fixed', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: '32px', fontWeight: 'bold', textShadow: '0 2px 4px #000',
          zIndex: 2050, pointerEvents: 'none'
        });
        document.body.appendChild(waitLvOverlay);
      }
      const sessionId = String(++waitLvOverlaySession);
      waitLvOverlay.dataset.waitOverlayId = sessionId;
      if (waitLvOverlayTimer) clearTimeout(waitLvOverlayTimer);
      waitLvOverlayTimer = setTimeout(() => {
        if (waitLvOverlay?.dataset.waitOverlayId === sessionId) {
          hideWaitLvOverlay();
        }
      }, 20000);
    }
    function hideWaitLvOverlay() {
      if (waitLvOverlayTimer) { clearTimeout(waitLvOverlayTimer); waitLvOverlayTimer = null; }
      if (waitLvOverlay) { try { waitLvOverlay.remove(); } catch { } waitLvOverlay = null; }
    }

    function tick() {
      if (state._hasPersonalResult) return;
      const now = performance.now();
      const tickStart = t0;
      let dt = (now - tickStart) / 1000;
      t0 = now;
      let elapsed = dt;
      let processed = 0;
      cleanupPauseBy(now);
      const othersPausing = [...state.pauseBy].some(pid => pid !== state.me?.playerId && pid !== 'boss');
      if (othersPausing || state.pauseBy.has(state.me?.playerId) || !levelUpModal.classList.contains('hidden')) {
        if (othersPausing) {
          showWaitLvOverlay();
        } else {
          hideWaitLvOverlay();
        }
        raf = setTimeout(tick, 33); return;
      }
      hideWaitLvOverlay();
      const MAX_STEPS = 1000; // 遅延時の過剰なループを防ぐ
      let steps = 0;
      while (elapsed > 0 && steps < MAX_STEPS) {
        const step = Math.min(elapsed, 0.1);
        elapsed -= step;
        processed += step;
        dt = step;
        const sliceNow = tickStart + processed * 1000;
        steps++;
        // server-authoritative TIME: prefer server start time + server clock estimate
        if (!state._freezeTimeAlive) {
          if (typeof state.serverGameStartAtSec === 'number') {
            const serverNowMs = sliceNow + (state._svtOffsetMs || 0);
            const ta = (serverNowMs - state.serverGameStartAtSec * 1000) / 1000;
            if (Number.isFinite(ta)) {
              timeAlive = Math.max(0, ta);
            } else {
              timeAlive += dt;
            }
          } else {
            timeAlive += dt;
          }
          if (stage.type === 'volcano') {
            lavaX += (stage.lavaSpeed || 20) * dt;
          }
        }
        if (state._pendingReviveApply) {
          const reviveInfo = state._pendingReviveApply;
          state._pendingReviveApply = null;
          if (Number.isFinite(reviveInfo?.x)) player.x = reviveInfo.x;
          if (Number.isFinite(reviveInfo?.y)) player.y = reviveInfo.y;
          player.vx = 0;
          player.vy = 0;
          invulnT = Math.max(invulnT, 2);
          state._lastSafePlayer = { x: player.x, y: player.y };
        }
        state._timeAlive = timeAlive; state._kills = kills;
        updateAchievementProgress(timeAlive);
        if (state.settings.fps) { fpsAccum += dt; fpsCount++; if (fpsAccum >= 0.25) { const fps = Math.round(fpsCount / fpsAccum); if (fpsEl) fpsEl.textContent = `${fps} FPS`; fpsAccum = 0; fpsCount = 0; } }
        if (state.settings.ping) {
          pingElapsed += dt;
          if (pingElapsed >= 30 && !pingChecking) {
            pingChecking = true;
            const start = performance.now();
            const url = new URL('api.php?action=listRooms', document.baseURI);
            fetch(url, { cache: 'no-store' })
              .then(() => {
                const latency = performance.now() - start;
                if (pingEl) pingEl.textContent = `${latency.toFixed(0)}ms`;
              })
              .catch(() => {
                if (pingEl) pingEl.textContent = 'N/A';
              })
              .finally(() => { pingElapsed = 0; pingChecking = false; });
          }
        }
        if (state.settings.loadStats) {
          resourceElapsed += dt;
          if (resourceElapsed >= 30 && !resourceChecking) {
            resourceChecking = true;
            const url = new URL('api.php?action=resourceStats', document.baseURI);
            fetch(url, { cache: 'no-store' })
              .then((res) => {
                if (!res.ok) throw new Error('bad status');
                return res.json();
              })
              .then((data) => {
                if (!resourceEl) return;
                if (data && typeof data === 'object' && data.ok && data.stats) {
                  const stats = data.stats;
                  const memory = stats.memory ?? '-';
                  const peak = stats.peak ?? '-';
                  const cpuUser = stats.cpu_user ?? '-';
                  const cpuSys = stats.cpu_sys ?? '-';
                  resourceEl.textContent = `memory: ${memory}\npeak: ${peak}\ncpu_user: ${cpuUser}\ncpu_sys: ${cpuSys}`;
                } else {
                  resourceEl.textContent = 'N/A';
                }
              })
              .catch(() => {
                if (resourceEl) resourceEl.textContent = 'N/A';
              })
              .finally(() => { resourceElapsed = 0; resourceChecking = false; });
          }
        }
        if (state.activeWeaponUnlocked) {
          if (!activeGaugeVisible) {
            activeGaugeWrap?.classList.remove('hidden');
            activeGaugeVisible = true;
          }
          if (state._activeTtl > 0) {
            state._activeTtl = Math.max(0, state._activeTtl - dt);
            // Always decrease gauge during activation, avoid division by zero
            const dur = state._activeDur > 0 ? state._activeDur : 1;
            state.activeGauge = Math.max(0, state.activeGauge - (activeCharge / dur) * dt);
          } else {
            state.activeGauge = Math.min(activeCharge, state.activeGauge + dt);
          }
          if (activeGaugeFill && activeCharge > 0) activeGaugeFill.style.width = `${(state.activeGauge / activeCharge) * 100}%`;
          if (activeGaugeTime && activeCharge > 0) activeGaugeTime.textContent = `${Math.floor(state.activeGauge)}/${activeCharge}`;
          const ready = state.activeGauge >= activeCharge && state._activeTtl <= 0;
          if (activeGaugeEl) activeGaugeEl.classList.toggle('ready', ready);
          if (ready) {
            if (!state._activeReadyNotified) {
              state._activeReadyNotified = true;
              try { Audio?.playSfx?.(state, 'activeReady'); } catch { }
              showToast('アクティブウェポンが使用可能！');
            }
          } else {
            state._activeReadyNotified = false;
          }
        } else if (activeGaugeVisible) {
          activeGaugeWrap?.classList.add('hidden');
          activeGaugeVisible = false;
        }
        uPulse += dt;
        if (uExCooldown > 0) uExCooldown = Math.max(0, uExCooldown - dt);
        let buffsChanged = false;
        state.activeCardEffects = state.activeCardEffects.filter(e => {
          if (Number.isFinite(e.ttl)) {
            e.ttl -= dt;
          }
          if (e.el) {
            if (!Number.isFinite(e.dur) || !Number.isFinite(e.ttl) || e.dur <= 0) {
              e.el.style.width = '100%';
            } else {
              const ratio = Math.max(0, Math.min(1, e.ttl / e.dur));
              e.el.style.width = `${ratio * 100}%`;
            }
          }
          if (Number.isFinite(e.ttl) && e.ttl <= 0) {
            if (e.type === 'spd') player.spd /= e.mul;
            else if (e.type === 'atk') state.stats.atk /= e.mul;
            else if (e.type === 'dmgTakenMul') state.stats.dmgTakenMul /= (e.dmgMul || e.mul);
            buffsChanged = true;
            return false;
          }
          return true;
        });
        if (buffsChanged) refreshCardBuffs();
        ensureFpsEl();

        const sp = player.spd * dt; let ix = 0, iy = 0; let moving = false;
        // 無敵時間の減衰
        if (invulnT > 0) invulnT = Math.max(0, invulnT - dt);
        if (jumpState.active) {
          updateJump(dt);
          moving = true;
        } else {
          if (pressed.has('ArrowLeft') || pressed.has('a')) ix -= 1;
          if (pressed.has('ArrowRight') || pressed.has('d')) ix += 1;
          if (pressed.has('ArrowUp') || pressed.has('w')) iy -= 1;
          if (pressed.has('ArrowDown') || pressed.has('s')) iy += 1;
          moving = ix !== 0 || iy !== 0;
          updateEnergy(dt, moving);
          const ilen = Math.hypot(ix, iy) || 0; if (ilen > 0) { ix /= ilen; iy /= ilen; lastMoveDir.x = ix; lastMoveDir.y = iy; }
          let nx, ny;
          const prevPlayerPos = { x: player.x, y: player.y };
          const safePlayer = state._lastSafePlayer;
          const fallbackPlayer = (safePlayer && Number.isFinite(safePlayer.x) && Number.isFinite(safePlayer.y)) ? safePlayer : prevPlayerPos;
          if (isSlipperyAt(player.x, player.y)) {
            const friction = stage.slipperyFriction ?? 0.94;
            player.vx = (player.vx || 0) * friction + ix * sp;
            player.vy = (player.vy || 0) * friction + iy * sp;
            nx = player.x + player.vx;
            ny = player.y + player.vy;
          } else {
            player.vx = 0; player.vy = 0;
            nx = player.x + ix * sp; ny = player.y + iy * sp;
          }
          if (!Number.isFinite(nx)) {
            console.warn('player x became non-finite; reverting', nx);
            nx = fallbackPlayer.x;
          }
          if (!Number.isFinite(ny)) {
            console.warn('player y became non-finite; reverting', ny);
            ny = fallbackPlayer.y;
          }
          if (state.stats.alive) {
            if (stage.spikes) {
              applySpikeDamage(dt, nx, ny);
            }
            if (stage.type === 'volcano') {
              applyLavaDamage(nx);
            }
            if (stage.type === 'ranch') { const hh = stage.halfHeight; ny = Math.max(-hh + player.r, Math.min(hh - player.r, ny)); }
            if (stage.star) {
              const s = clampToStar(nx, ny, player.r);
              nx = s.x;
              ny = s.y;
            }
            // (no change)
            if (stage.circular) {
              const dist = Math.hypot(nx, ny);
              const maxR = (stage.radius || 400) - player.r;
              if (dist > maxR) { const ang = Math.atan2(ny, nx); nx = Math.cos(ang) * maxR; ny = Math.sin(ang) * maxR; }
            }
            if (!Number.isFinite(nx)) {
              console.warn('player x became non-finite after stage checks; reverting', nx);
              nx = fallbackPlayer.x;
            }
            if (!Number.isFinite(ny)) {
              console.warn('player y became non-finite after stage checks; reverting', ny);
              ny = fallbackPlayer.y;
            }
            if (stage.type === 'maze' || stage.iceBlocks) {
              const obs = getNearbyObstacles(nx, player.y);
              if (!obs.some(r => circleRectCollide(nx, player.y, player.r, r))) player.x = nx;
              const obsY = getNearbyObstacles(player.x, ny);
              if (!obsY.some(r => circleRectCollide(player.x, ny, player.r, r))) player.y = ny;
            } else {
              player.x = nx;
              player.y = ny;
            }
            if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) {
              console.warn('player position became non-finite after assignment; reverting');
              player.x = fallbackPlayer.x;
              player.y = fallbackPlayer.y;
            }
            state._lastSafePlayer = { x: player.x, y: player.y };
            if (stage.poison && isPoisonAt(player.x, player.y)) {
              const dmg = state.stats.maxHp * 0.05 * dt;
              const dmgResult = applyPlayerDamage(dmg) || { hp: 0, armor: 0 };
              const takenHp = Number.isFinite(dmgResult.hp) ? dmgResult.hp : 0;
              const takenArmor = Number.isFinite(dmgResult.armor) ? dmgResult.armor : 0;
              playerDmgAcc += takenHp;
              if (stageName === 'メロンパン毒沼') {
                const poisonGain = takenHp + takenArmor;
                if (Number.isFinite(poisonGain) && poisonGain > 0) {
                  state._poisonDamageTaken = (state._poisonDamageTaken || 0) + poisonGain;
                }
              }
            }
            if (stage.type === 'volcano') {
              applyLavaDamage();
            }
            if (stage.jumpPad) {
              const pads = getNearbyPads(player.x, player.y);
              for (const pad of pads) {
                if (Math.hypot(pad.x - player.x, pad.y - player.y) < player.r + pad.r) { startJump(pad); break; }
              }
            }
          }
        }
        handleReviveProgress(dt, moving);
        if (charName === 'フルムーン' && shield) {
          if (fullmoonActive) {
            const dir = getFullmoonDir(fullmoonActive);
            shield.dirX = dir.x;
            shield.dirY = dir.y;
            shield.ang = Math.atan2(dir.y, dir.x);
          } else {
            shield.ang -= cfg.fullmoon.rotSpd * dt;
            shield.dirX = Math.cos(shield.ang);
            shield.dirY = Math.sin(shield.ang);
          }
          if (shield.hp <= 0) {
            shield.cd -= dt;
            if (shield.cd <= 0) { shield.hp = shield.maxHp; shield.cd = 0; }
          }
        }
        // Server-authoritative enemies support: when enabled, don't spawn locally
        const serverSim = !!state.serverSim;

        // adjust difficulty by player count (include self)
        const playerCount = Math.max(1, state.room?.members?.length || 1);
        const diffName = state.room?.difficulty || 'ふつう';
        const diffCfg = getDifficultyConfig(diffName) || { hpMul: 1, spawnMul: 1, bulletMul: 1, bulletDmgMul: 1, maxEnemies: Infinity, mobHpMul: 1, tankHpMul: 1 };
        const isHard = diffName === 'むずかしい';
        const ignitionActive = isIgnitionModeActive();
        const isIgnitionHard = isHard && ignitionActive;
        const elemCfg = elemSpawnDefs[diffName] || { start: 0, chance: 0.3 };
        const elemChance = timeAlive >= elemCfg.start ? elemCfg.chance : 0;
        const maxEnemies = diffCfg.maxEnemies ?? Infinity;
        let aliveCount = enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
        let ignitionSuppressorAlive = enemies.reduce((n, e) => n + (e.alive && e.type === 'ignitionSuppressor' ? 1 : 0), 0);

        if (state.pauseBy instanceof Set && state.me?.playerId && state.pauseBy.has(state.me.playerId) && !hasActiveLocalPauseUi()) {
          const myId = state.me.playerId;
          const privateId = state.me?.privateId ?? null;
          const canonicalId = resolvePauseId(myId, privateId) || myId;
          let tokenHint = getKnownPauseToken(canonicalId);
          if (tokenHint == null && canonicalId !== myId) {
            tokenHint = getKnownPauseToken(myId);
          }
          const resumeInfo = clearPause(myId, privateId, tokenHint ?? undefined);
          let resumeToken = resumeInfo?.token;
          if (resumeToken == null) resumeToken = tokenHint ?? null;
          state._enemyFreezeUntil = 0;
          if (resumeInfo) {
            const payload = { type: 'resume' };
            if (resumeToken != null) payload.token = resumeToken;
            sendEvent(payload).catch(() => { });
          } else {
            const forcedCanonical = resolvePauseId(myId, privateId);
            if (forcedCanonical) {
              state.pauseBy.delete(forcedCanonical);
              state.pauseBy.delete(myId);
              if (privateId && privateId !== forcedCanonical) state.pauseBy.delete(privateId);
              try {
                ensurePauseMap().delete(forcedCanonical);
                const aliases = ensurePauseAliasMap();
                aliases.delete(forcedCanonical);
                if (privateId && privateId !== forcedCanonical) aliases.delete(privateId);
                if (myId && myId !== forcedCanonical) aliases.delete(myId);
                for (const [key, value] of [...aliases.entries()]) {
                  if (value === forcedCanonical) aliases.delete(key);
                }
              } catch { }
              const entry = getPauseEntry(forcedCanonical, false);
              if (entry) {
                entry.activeToken = null;
                ensurePauseTokenStore().set(forcedCanonical, entry);
              }
            }
            requestSelfResume(resumeToken ?? null, 'local-desync');
          }
        }
        let freezeUntil = state._enemyFreezeUntil || 0;
        const freezeCheckNow = now;
        if (freezeUntil > 0 && freezeCheckNow > freezeUntil + 3000) {
          console.warn(`enemy freeze exceeded by ${Math.round(freezeCheckNow - (freezeUntil + 3000))}ms; resetting`);
          state._enemyFreezeUntil = 0;
          freezeUntil = 0;
          const payload = { type: 'resume' };
          const knownToken = getKnownPauseToken(state.me?.playerId);
          if (knownToken != null) payload.token = knownToken;
          sendEvent(payload).catch(() => { });
        }
        const enemyFrozen = freezeUntil > freezeCheckNow;
        const enemyDt = enemyFrozen ? 0 : dt;

        // Progressive spawning: add tougher types over time (client-side only when not serverSim)
        spawnTimer -= enemyDt; waveTimer -= enemyDt;
        healTimer -= dt;
        if (healTimer <= 0) {
          healTimer = HEAL_INTERVAL;
          if (heals.length < 2) spawnHealPickup();
        }
        moneyTimer -= dt;
        if (moneyTimer <= 0) {
          moneyTimer = MONEY_INTERVAL;
          if (moneys.length < 2) spawnMoneyPickup();
        }
        if (state.cardShopUnlocked) {
          cardOrbTimer -= dt;
          if (cardOrbTimer <= 0) {
            cardOrbTimer = CARD_ORB_INTERVAL;
            spawnCardOrb();
          }
        }
        atkBoostTimer -= dt;
        if (atkBoostTimer <= 0) {
          atkBoostTimer = ATK_BOOST_INTERVAL;
          if (atkBoosts.length < 1 && Math.random() < 0.15) spawnAtkBoostPickup();
        }
        if (!serverSim && nextRiskEventIdx < riskEventTimes.length && timeAlive >= nextRiskEventAt) {
          if (!stage.circular) {
            const hasActiveRiskArea = Array.isArray(riskChoiceAreas) && riskChoiceAreas.length > 0;
            if (!hasActiveRiskArea) {
              spawnRiskRewardAreas(nextRiskEventIdx);
              riskEventTriggered = true;
              nextRiskEventIdx++;
              nextRiskEventAt = riskEventTimes[nextRiskEventIdx] ?? Infinity;
              riskEventSpawnRetry = 0;
            } else if (riskEventSpawnRetry < RISK_EVENT_MAX_RETRIES) {
              nextRiskEventAt = timeAlive + RISK_EVENT_RETRY_DELAY;
              riskEventSpawnRetry++;
            } else {
              nextRiskEventIdx++;
              nextRiskEventAt = riskEventTimes[nextRiskEventIdx] ?? Infinity;
              riskEventSpawnRetry = 0;
            }
          }
        }
        // slower ramp: keep spawn reasonable over ~30min
        const spawnInterval = Math.max(0.45, 1.2 - timeAlive * 0.0004) / diffCfg.spawnMul;
        // global HP scaling reaches cap around 30min
        const diffMul = (1 + Math.min(1.8, timeAlive * 0.001)) * diffCfg.hpMul * diffCfg.mobHpMul * (stage.mobHpMul || 1);

        if (isIgnitionHard && nextIgnitionExpOrbIdx < IGNITION_EXP_ORB_TIMES.length) {
          while (nextIgnitionExpOrbIdx < IGNITION_EXP_ORB_TIMES.length && timeAlive >= IGNITION_EXP_ORB_TIMES[nextIgnitionExpOrbIdx]) {
            const baseExp = 1 + Math.floor(timeAlive / 20);
            for (let i = 0; i < 5; i++) {
              const { x: orbX, y: orbY } = findPickupPosition(60, 120, 8);
              pushOrb({ x: orbX, y: orbY, r: 8, value: baseExp * 5, type: 'exp5' });
            }
            nextIgnitionExpOrbIdx++;
          }
        }

        if (!fiveMinExpOrbSpawned && timeAlive >= 300) {
          if (diffName === 'ふつう' || diffName === 'かんたん') {
            const { x: orbX, y: orbY } = findPickupPosition(60, 120, 8);
            const baseExp = 1 + Math.floor(timeAlive / 20);
            pushOrb({ x: orbX, y: orbY, r: 8, value: baseExp * 5, type: 'exp5' });
          }
          fiveMinExpOrbSpawned = true;
        }
        if (!tenMinuteHealSpawned && timeAlive >= 600) {
          tenMinuteHealSpawned = true;
          const radius = isHard ? 8 : 12;
          const { x: healX, y: healY } = findPickupPosition(40, 80, radius);
          if (isHard) {
            const healVal = Math.round(20 * (stage.healValueMul || 1));
            heals.push({ id: 'lh' + Math.random().toString(36).slice(2, 8), type: 'heal', x: healX, y: healY, r: 8, value: healVal });
          } else {
            heals.push({ id: 'rb' + Math.random().toString(36).slice(2, 8), type: 'rainbow', x: healX, y: healY, r: 12, value: 50 });
          }
        }
        if (!serverSim && !specialSpawned && ((diffName === 'ふつう' && timeAlive >= 600) || (diffName === 'むずかしい' && timeAlive >= 120))) {
          specialSpawned = true;
          const angle = Math.random() * Math.PI * 2; const radius = 380; const spawnR = 14;
          let ex = player.x + Math.cos(angle) * radius; let ey = player.y + Math.sin(angle) * radius;
          if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
          if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 20, hh - 20); }
          if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
            let tries = 8;
            while (tries-- > 0) {
              const obs = getNearbyObstacles(ex, ey);
              let blocked = obs.some(r => circleRectCollide(ex, ey, 12, r));
              if (stage.poison && isPoisonAt(ex, ey)) blocked = true;
              if (!blocked) break;
              const ang2 = Math.random() * Math.PI * 2;
              ex = player.x + Math.cos(ang2) * radius;
              ey = player.y + Math.sin(ang2) * radius;
              if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; }
            }
          }
          if (stage.type === 'volcano') {
            ex = Math.max(ex, lavaX + spawnR + 1);
          }
          const elem = pickStageElement(stageName);
          const shp = Math.round(2000 * diffCfg.hpMul * (stage.mobHpMul || 1));
          enemies.push({ x: ex, y: ey, r: spawnR, hp: shp, maxHp: shp, spd: 30, alive: true, type: 'special', dmgTakenMul: 0.1, elem });
          aliveCount++;
        }

        // pick nearest target (me or a live ally) for enemy AI
        const pickNearestTarget = (ex, ey, enemy = null) => {
          // default is local player
          let best = { x: player.x, y: player.y, isMe: true, pid: state.me?.playerId };
          let bd = Math.hypot(player.x - ex, player.y - ey);
          const nowMs = performance.now();
          // search allies (skip dead or very stale positions)
          for (const [pid, a] of Object.entries(state.allies)) {
            if (!a) continue;
            if (a.alive === false) continue;
            const stale = nowMs - (a.t || 0);
            if (stale > 5000) continue; // ignore if no update for >5s
            const ax = (a.sx ?? a.x);
            const ay = (a.sy ?? a.y);
            const d = Math.hypot(ax - ex, ay - ey);
            if (d < bd) { bd = d; best = { x: ax, y: ay, isMe: false, pid }; }
          }
          if (charName === 'あんどー' && state?.perks?.ex && decoys.length && !(enemy?.boss)) {
            const DECOY_PULL_RADIUS = 360;
            const DECOY_PULL_RADIUS_SQ = DECOY_PULL_RADIUS * DECOY_PULL_RADIUS;
            const AGGRO_BIAS = 80;
            for (const d of decoys) {
              if (!d) continue;
              const dx = d.x - ex;
              const dy = d.y - ey;
              const distSq = dx * dx + dy * dy;
              if (distSq > DECOY_PULL_RADIUS_SQ) continue;
              const dist = Math.sqrt(distSq);
              const effective = Math.max(0, dist - AGGRO_BIAS);
              if (effective < bd) {
                bd = effective;
                best = { x: d.x, y: d.y, decoy: d };
              }
            }
          }
          return best;
        };
        let aliveTankCount = enemies.reduce((acc, e) => acc + (e.alive && e.type === 'tank' ? 1 : 0), 0);
        if (!serverSim && spawnTimer <= 0 && aliveCount < maxEnemies) {
          spawnTimer = spawnInterval;
          for (let s = 0; s < playerCount * diffCfg.spawnMul && aliveCount < maxEnemies; s++) {
            const angle = Math.random() * Math.PI * 2; const radius = 380; const spawnR = 9;
            let ex = player.x + Math.cos(angle) * radius; let ey = player.y + Math.sin(angle) * radius;
            if (stage.star) { const c = clampToStar(ex, ey, spawnR); ex = c.x; ey = c.y; }
            if (stage.type === 'ranch') { const hh = stage.halfHeight; ey = clamp(ey, -hh + 12, hh - 12); }
            if (stage.type === 'maze' || stage.iceBlocks || stage.poison) {
              let tries = 8;
              while (tries-- > 0) {
                const obs = getNearbyObstacles(ex, ey);
                let blocked = obs.some(r => circleRectCollide(ex, ey, 8, r));
                if (stage.poison && isPoisonAt(ex, ey)) blocked = true;
                if (!blocked) break;
                const ang2 = Math.random() * Math.PI * 2;
                ex = player.x + Math.cos(ang2) * radius;
                ey = player.y + Math.sin(ang2) * radius;
                if (stage.star) { const c2 = clampToStar(ex, ey, spawnR); ex = c2.x; ey = c2.y; }
              }
            }
            if (stage.type === 'volcano') {
              ex = Math.max(ex, lavaX + spawnR + 1);
            }

            // decide type by timeAlive (unlock tougher types later)
            const t = timeAlive;
            const roll = Math.random();
            let type = 'chaser';
            if (stage.iceBlocks) {
              const iceChance = { 'かんたん': 0.06, 'ふつう': 0.10, 'むずかしい': 0.16 }[diffName] || 0;
              if (Math.random() < iceChance) type = 'freezer';
            }
            if (isHard) {
              if (t > 20 && roll < 0.20) type = 'zig';
              if (t > 60 && roll < 0.25) type = 'shooter';
              if (t > 120 && roll < 0.55) type = 'dasher';
              if (t > 180 && roll < 0.70) type = 'bomber';
              if (t > 240 && roll < 0.85) type = 'tank';
            } else {
              if (t > 30 && roll < 0.25) type = 'zig';
              if (t > 90 && roll < 0.30) type = 'shooter';
              if (t > 180 && roll < 0.60) type = 'dasher';
              if (t > 270 && roll < 0.72) type = 'bomber';
              if (t > 360 && roll < 0.80) type = 'tank';
            }
            if (isIgnitionHard && ignitionSuppressorAlive < IGNITION_SUPPRESSOR_LIMIT && t > 45) {
              const ignitionChance = t > 240 ? 0.12 : (t > 120 ? 0.09 : 0.06);
              if (Math.random() < ignitionChance) {
                type = 'ignitionSuppressor';
              }
            }
            // base HP grows more slowly
            const baseHp = 8 + Math.floor(t / 20);
            // additional durability boost every 2 minutes (10% each)
            const durabilityMul = 1 + Math.floor(t / 120) * 0.1;
            const hp = Math.round(baseHp * diffMul * durabilityMul);
            // enemy move speed ramps slowly over time
            const baseSpd = 40 + Math.min(120, t * 0.08);
            const enemyId = generateEnemyId();
            if (type === 'tank') {
              if (aliveTankCount >= TANK_LIMIT) {
                type = 'chaser';
              } else {
                aliveTankCount++;
              }
            }
            const baseMoveSpd = baseSpd;
            const e = { id: enemyId, x: ex, y: ey, r: spawnR, hp, spd: baseMoveSpd, alive: true, type, t: 0, cd: 0, phase: Math.random() * Math.PI * 2 };
            if (type === 'ignitionSuppressor') {
              e.hp = Math.round(hp * 1.35);
              e.spd = Math.max(14, baseSpd * 0.25);
              e.cd = (3.6 + Math.random() * 1.4) / Math.max(0.6, diffCfg.bulletMul);
              e.r = 11;
              e.burstShots = 0;
              e.burstGap = 0;
              e.burstPhase = Math.random() * Math.PI * 2;
            }
            if (type === 'freezer') { e.elem = 'ice'; e.hp *= 3; e.r = 12; e.blockCd = 0; }
            else if (type !== 'ignitionSuppressor' && Math.random() < elemChance) {
              e.elem = pickStageElement(stageName);
            }
            if (type === 'shooter') { e.cd = (2.8 + Math.random() * 1.5) / diffCfg.bulletMul; e.range = 260 + Math.random() * 120; e.spd *= 0.85; }
            if (type === 'dasher') { e.state = 'stalk'; e.cd = 1.2; e.dash = { wind: 0, vx: 0, vy: 0, time: 0 }; }
            if (type === 'bomber') { e.fuse = -1; e.blast = { r: 56, fuseTime: 0.8 }; e.spd *= 0.9; }
            if (type === 'tank') {
              e.hp *= diffCfg.tankHpMul;
              e.r = 12;
              const tankSpeedMul = tankSpeedMultiplierFromId(enemyId);
              e.tankSpeedMul = tankSpeedMul;
              e.spd = baseSpd * 0.6 * tankSpeedMul;
            }
            if (type === 'freezer') { e.spd *= 0.6; }
            enemies.push(e);
            if (type === 'ignitionSuppressor') ignitionSuppressorAlive++;
            aliveCount++;
          }
        }
        if (!serverSim && !stage.circular && nextRewardIdx < rewardTimes.length && timeAlive >= nextRewardAt) {
          if (!rewardArea) {
            spawnRewardArea();
            nextRewardIdx++;
            nextRewardAt = rewardTimes[nextRewardIdx] ?? Infinity;
            rewardRetry = 0;
          } else if (rewardRetry < 5) {
            nextRewardAt = timeAlive + 5;
            rewardRetry++;
          } else {
            nextRewardIdx++;
            nextRewardAt = rewardTimes[nextRewardIdx] ?? Infinity;
            rewardRetry = 0;
          }
        }
        // mid-boss schedule (every 2.5 minutes)
        if (!serverSim && timeAlive >= nextMidBossAt) {
          const midBossAlive = enemies.some(e => e.boss && e.alive && e.name === '中型個体');
          if (!midBossAlive || !midBossSpawned) {
            spawnMidBoss();
            aliveCount++;
            midBossSpawned = true;
            nextMidBossAt += 150;
            midBossRetry = 0;
          } else if (midBossRetry < 5) {
            nextMidBossAt = timeAlive + 5;
            midBossRetry++;
          } else {
            nextMidBossAt += 150;
            midBossRetry = 0;
          }
        }
        // boss schedule (every 6 minutes)
        if (!serverSim && timeAlive >= nextBossAt) {
          const bossAlive = enemies.some(e => e.boss && e.alive && e.name === '大型個体');
          if (!bossAlive) {
            spawnBoss();
            aliveCount++;
            nextBossAt += 360;
            bossRetry = 0;
          } else if (bossRetry < 5) {
            nextBossAt = timeAlive + 5;
            bossRetry++;
          } else {
            nextBossAt += 360;
            bossRetry = 0;
          }
        }
        if (!rainbowMoneySpawned && timeAlive >= 900) {
          rainbowMoneySpawned = true;
          spawnRainbowMoney();
        }
        if (!ignitionFifteenMoneySpawned && ignitionActive && timeAlive >= 900) {
          ignitionFifteenMoneySpawned = true;
          spawnIgnitionMoneyBurst();
        }
        // death reaper schedule (once at 15 minutes)
        // spawn if not already present
        if (timeAlive >= nextReaperAt && !enemies.some(e => e.type === 'reaper')) {
          const spawned = spawnReapers();
          aliveCount += spawned;
          nextReaperAt = Infinity;
        }
        if (!serverSim && nextNeutralWaveAt !== undefined) {
          if (!neutralWarned && timeAlive >= nextNeutralWaveAt - 5) {
            showToast('警告！まもなく敵が大量に現れる！');
            neutralWarned = true;
          }
          if (timeAlive >= nextNeutralWaveAt) {
            const spawned = spawnNeutralWave();
            aliveCount += spawned;
            neutralWarned = false;
            if (spawned > 0 || neutralWaveRetry >= 5) {
              nextNeutralWaveAt = neutralWaveTimesSession.shift() ?? Infinity; // 予定が尽きたら以降は発生しない
              neutralWaveRetry = 0;
            } else {
              nextNeutralWaveAt = timeAlive + 5;
              neutralWaveRetry++;
            }
          }
        }
        // wave events: small packs (gradual unlock; avoid sudden 30s spike)
        if (!serverSim && waveTimer <= 0 && aliveCount < maxEnemies) {
          // keep packs from becoming too frequent early; slow decrease
          waveTimer = Math.max(10, 16 - timeAlive * 0.005);
          if (timeAlive > 30) {
            // choose pack size by time to smooth difficulty growth
            const t = timeAlive;
            const baseCount = (t > 150) ? (3 + Math.floor(Math.random() * 2))
              : (t > 90) ? (2 + Math.floor(Math.random() * 2))
                : (1 + Math.floor(Math.random() * 2));
            const count = Math.round(baseCount * playerCount * diffCfg.spawnMul);
            for (let i = 0; i < count && aliveCount < maxEnemies; i++) {
              const ang = Math.random() * Math.PI * 2; const r = 420 + Math.random() * 60;
              let ex = player.x + Math.cos(ang) * r; let ey = player.y + Math.sin(ang) * r;
              // type mix varies by difficulty; hard adds tougher enemies sooner
              let tRoll = Math.random();
              let type = 'chaser';
              if (stage.iceBlocks) {
                const iceChance = { 'かんたん': 0.06, 'ふつう': 0.10, 'むずかしい': 0.16 }[diffName] || 0;
                if (Math.random() < iceChance) type = 'freezer';
              }
              if (isHard) {
                if (t <= 40) {
                  type = (tRoll < 0.4) ? 'zig' : 'chaser';
                } else if (t <= 80) {
                  type = (tRoll < 0.7) ? 'zig' : 'chaser';
                } else if (t <= 120) {
                  if (tRoll < 0.15) type = 'shooter'; else type = (tRoll < 0.7 ? 'zig' : 'chaser');
                } else {
                  if (tRoll < 0.25) type = 'shooter';
                  else if (tRoll < 0.65) type = 'zig';
                  else if (tRoll < 0.80) type = 'dasher';
                  else type = 'bomber';
                }
              } else {
                if (t <= 60) {
                  type = (tRoll < 0.3) ? 'zig' : 'chaser';
                } else if (t <= 90) {
                  type = (tRoll < 0.6) ? 'zig' : 'chaser';
                } else if (t <= 150) {
                  if (tRoll < 0.10) type = 'shooter'; else type = (tRoll < 0.65 ? 'zig' : 'chaser');
                } else {
                  if (tRoll < 0.40) type = 'shooter'; else type = (tRoll < 0.8 ? 'zig' : 'chaser');
                }
              }
              // base stats scale gently with time
              const baseHp = 10 + t / 30;
              const hp = Math.round(baseHp * (1 + t * 0.001) * diffCfg.hpMul * diffCfg.mobHpMul);
              const e = { x: ex, y: ey, r: 9, hp, spd: 70, alive: true, type, t: 0, cd: 0 };
              if (Math.random() < elemChance) {
                e.elem = pickStageElement(stageName);
              }
              if (type === 'shooter') { e.cd = (1.8 + Math.random() * 1.2) / diffCfg.bulletMul; e.range = 300; }
              if (type === 'zig') { e.phase = Math.random() * Math.PI * 2; }
              if (type === 'dasher') { e.state = 'stalk'; e.cd = 1.2; e.dash = { wind: 0, vx: 0, vy: 0, time: 0 }; }
              if (type === 'bomber') { e.fuse = -1; e.blast = { r: 56, fuseTime: 0.8 }; e.spd *= 0.9; }
              if (type === 'freezer') { e.elem = 'ice'; e.hp *= 3; e.r = 12; e.blockCd = 0; e.spd *= 0.6; }
              enemies.push(e);
              aliveCount++;
            }
          }
        }

        shootTimer -= dt; {
          const rateMul = (openLevelUp.rateMul || 1) * cdrMul; const fireInterval = Math.max(0.28, cfg.common.interval * rateMul);
          if (shootTimer <= 0 && state.stats.alive) {
            shootTimer = fireInterval; let target = null, bestDist = 1e9;
            for (const e of enemies) { if (!e.alive) continue; const scr = toScreen(e.x, e.y); const onScreen = scr.x >= -20 && scr.x <= cvs.width + 20 && scr.y >= -20 && scr.y <= cvs.height + 20; if (!onScreen) continue; const d = Math.hypot(e.x - player.x, e.y - player.y); if (d < bestDist) { bestDist = d; target = e; } }
            const range = (charName === 'おきーぱー') ? cfg.okp.range : cfg.common.range;
            if (target && bestDist <= range) {
              const dx = target.x - player.x, dy = target.y - player.y;
              const ang0 = Math.atan2(dy, dx);
              const spd2 = cfg.common.spd; const dmg = Math.max(1, Math.round(getAtk() * cfg.common.dmgScale));
              const count = cfg.common.count || 1; const spread = cfg.common.spread || 0.15;
              const elem = state.stats.elem;
              const hasPierceCard = state.activeCardEffects.some(eff => eff.type === 'pierce');
              if (elem) { try { Audio?.playSfx?.(state, elem + 'Atk'); } catch { } }
              for (let i = 0; i < count; i++) {
                const ang = ang0 + spread * (i - (count - 1) / 2);
                // サーバー権威でも可視化用に弾を生成（当たり時はqueueHitのみ）
                projectiles.push({ type: 'pew', elem, x: player.x, y: player.y, vx: Math.cos(ang) * spd2, vy: Math.sin(ang) * spd2, r: cfg.common.r, dmg, ttl: cfg.common.ttl, pierce: hasPierceCard });
              }
            }
          }
        }

        // Update enemies: in serverSim, sync from server snapshot; else run local AI
        if (serverSim) {
          if (!enemyFrozen) {
            // Apply server-reported enemy deaths
            if (Array.isArray(state._pendingEnemyDeads) && state._pendingEnemyDeads.length > 0) {
              for (const ev of state._pendingEnemyDeads) {
                if (!isFinite(ev.x) || !isFinite(ev.y)) continue;
                const en = enemies.find(e => e.id === ev.id);
                if (en) en.alive = false;
                spawnKillFx(ev.x, ev.y);
                // count server-confirmed kills
                kills++;
                if (ev.boss) {
                  const base = 10 + Math.floor(timeAlive / 120);
                  const count = 12;
                  for (let i = 0; i < count; i++) {
                    const ang = (Math.PI * 2 * i) / count;
                    const dist = 12 + (i % 3) * 6;
                    pushOrb({ x: ev.x + Math.cos(ang) * dist, y: ev.y + Math.sin(ang) * dist, r: 5, value: base });
                  }
                  try { Audio?.playSfx?.(state, 'boss'); } catch { try { Audio?.playSfx?.(state, 'kill'); } catch { } }
                  // サーバー側のボス死亡時も確定ドロップを追加: 中型->メロン、大型->レインボー
                  try {
                    const idStr = String(ev.id || '');
                    const nameStr = ev.name || '';
                    // 中型個体判定: id が mb で始まる、または name が 中型個体
                    if (idStr.startsWith('mb') || nameStr === '中型個体') {
                      const healVal = Math.round(20 * (stage.healValueMul || 1));
                      heals.push({ id: 'lh' + Math.random().toString(36).slice(2, 8), type: 'heal', x: ev.x, y: ev.y, r: 8, value: healVal });
                      if (state.cardShopUnlocked) {
                        cardOrbs.push({ id: 'co' + Math.random().toString(36).slice(2, 8), x: ev.x, y: ev.y, r: 8, rarity: 2 });
                      }
                    }
                    // 大型個体判定: id が b で始まる（reaper は別扱いでも虹にする）または name が 大型個体
                    else if (idStr.startsWith('b') || idStr.startsWith('rp') || nameStr === '大型個体' || nameStr === '死神') {
                      heals.push({ id: 'rb' + Math.random().toString(36).slice(2, 8), type: 'rainbow', x: ev.x, y: ev.y, r: 12, value: 50 });
                      const rroll = Math.random();
                      const rarity = (rroll < 0.05) ? 4 : 3;
                      if (state.cardShopUnlocked) {
                        cardOrbs.push({ id: 'co' + Math.random().toString(36).slice(2, 8), x: ev.x, y: ev.y, r: 8, rarity });
                      }
                    }
                  } catch (err) { }
                } else {
                  pushOrb({ x: ev.x, y: ev.y, r: 4, value: 1 + Math.floor(timeAlive / 20) });
                  try { Audio?.playSfx?.(state, 'kill'); } catch { }
                }
              }
              state._pendingEnemyDeads.length = 0;
            }
            // Replace enemies list with snapshot positions
            if (state.svEnemiesRaw == null) {
              // snapshot missing: keep current enemies untouched
            } else if (Array.isArray(state.svEnemiesRaw)) {
              const prevById = new Map();
              for (const prevEnemy of enemies) {
                if (prevEnemy && prevEnemy.id != null) {
                  prevById.set(prevEnemy.id, prevEnemy);
                }
              }
              const prevBosses = enemies.filter(e => e.boss && e.alive);
              enemies.length = 0;
              const ids = new Set();
              if (state.svEnemiesRaw.length === 0) {
                // 空配列は完全クリア: ボスも復元しない
              } else {
                for (const se of state.svEnemiesRaw) {
                  const prev = (se.id != null) ? prevById.get(se.id) : null;
                  const nextEnemy = {
                    id: se.id,
                    type: se.type || 'chaser',
                    boss: !!se.boss,
                    name: se.name,
                    elem: se.elem,
                    x: se.x,
                    y: se.y,
                    r: se.r || 9,
                    hp: se.hp ?? 10,
                    maxHp: se.maxHp,
                    alive: true,
                    t: prev?.t ?? 0,
                    cd: prev?.cd ?? 0,
                    spd: Number.isFinite(se.spd) ? se.spd : (prev?.spd ?? 0),
                    state: se.state,
                    fuse: se.fuse,
                    blast: se.blast,
                    dmgTakenMul: se.dmgTakenMul
                  };
                  if (nextEnemy.type === 'tank') {
                    const serverMul = Number.isFinite(se.tankSpeedMul) ? se.tankSpeedMul : null;
                    const prevMul = Number.isFinite(prev?.tankSpeedMul) ? prev.tankSpeedMul : null;
                    const tankSpeedMul = serverMul ?? prevMul ?? (se.id ? tankSpeedMultiplierFromId(se.id) : null);
                    if (tankSpeedMul != null) {
                      nextEnemy.tankSpeedMul = tankSpeedMul;
                    }
                  }
                  if (prev?.stun && prev.stun > 0) {
                    nextEnemy.stun = prev.stun;
                  }
                  enemies.push(nextEnemy);
                  ids.add(se.id);
                }
                for (const b of prevBosses) {
                  if (!ids.has(b.id)) enemies.push(b);
                }
              }
            }
            // Server bullets/hazards: copy for rendering/HP checks
            // We don't simulate bullet motion; server sends current positions.
            // Clear local array and repopulate from snapshot each frame, reusing
            // existing objects when possible so that px/py (previous frame
            // position) can be preserved for trail rendering.
            const withId = [];
            const withoutId = [];
            for (const b of enemyProjectiles) {
              if (b.id) {
                withId.push(b);
              } else {
                withoutId.push(b);
              }
            }
            const prevBMap = new Map(withId.map(b => [b.id, b]));
            const localBullets = withoutId;
            enemyProjectiles.length = 0;
            for (const b of (state.svBulletsRaw || [])) {
              const existing = prevBMap.get(b.id);
              if (existing) {
                // Preserve previous location before updating to new snapshot
                existing.px = existing.x;
                existing.py = existing.y;
                Object.assign(existing, b);
                enemyProjectiles.push(existing);
              } else {
                // Initialize px/py so trail starts correctly
                enemyProjectiles.push({ ...b, px: b.x, py: b.y });
              }
            }
            // preserve locally simulated bullets (e.g., reaper attacks)
            enemyProjectiles.push(...localBullets);
            // hazards (explosions only; telegraphs may be client-only visuals)
            hazards.length = 0;
            if (Array.isArray(state.svHazardsRaw)) {
              const parseNumber = (value) => (typeof value === 'number' ? value : Number(value));
              for (const h of state.svHazardsRaw) {
                if (!h) continue;
                const type = h.type || 'explosion';
                const rawX = parseNumber(h.x);
                const rawY = parseNumber(h.y);
                const rawR = parseNumber(h.r);
                const rawTtl = parseNumber(h.ttl);
                const rawDmg = parseNumber(h.dmg);
                if (!Number.isFinite(rawX) || !Number.isFinite(rawY) || !Number.isFinite(rawR)) {
                  console.warn('[svHazards] Skipping render of hazard with invalid position or radius', { hazard: h });
                  continue;
                }
                const ttl = Number.isFinite(rawTtl) ? rawTtl : 0;
                const dmg = Number.isFinite(rawDmg) ? rawDmg : 0;
                if (!Number.isFinite(rawTtl) || !Number.isFinite(rawDmg)) {
                  console.warn('[svHazards] Hazard fields defaulted before render', { hazard: h, ttl: rawTtl, dmg: rawDmg });
                }
                hazards.push({ ...h, type, x: rawX, y: rawY, r: rawR, ttl, dmg });
              }
            }
            // アイテムはクライアント側で管理するため、サーバーからのスナップショットは使用しない
          }
        }

        enemies.forEach(e => {
          if (!e.alive) return;
          if (e.ttl != null) {
            e.ttl -= enemyDt;
            if (e.ttl <= 0) { e.alive = false; return; }
          }
          e.t += enemyDt; e.cd = (e.cd ?? 0) - enemyDt;
          if (e.stun && e.stun > 0) { e.stun -= enemyDt; return; }
          // decide target per enemy (nearest player on this client)
          const tgt = pickNearestTarget(e.x, e.y, e);
          const dx = tgt.x - e.x, dy = tgt.y - e.y; const dist = Math.hypot(dx, dy) || 1;
          let nx = e.x, ny = e.y;
          const moveTowards = (spdMul = 1) => { nx = e.x + (dx / dist) * e.spd * spdMul * enemyDt; ny = e.y + (dy / dist) * e.spd * spdMul * enemyDt; };
          const avoidWalls = () => {
            if (stage.circular) {
              const dist = Math.hypot(nx, ny);
              const maxR = (stage.radius || 400) - e.r;
              if (dist > maxR) { const ang = Math.atan2(ny, nx); nx = Math.cos(ang) * maxR; ny = Math.sin(ang) * maxR; }
            }
            if (stage.type === 'ranch') { const hh = stage.halfHeight; ny = clamp(ny, -hh + e.r, hh - e.r); }
            if (!stage.ignoreMobWalls && (stage.type === 'maze' || stage.iceBlocks)) {
              const obs = getNearbyObstacles(nx, e.y);
              const blockedX = obs.some(r => circleRectCollide(nx, e.y, e.r, r));
              if (!blockedX) e.x = nx;
              const obsY = getNearbyObstacles(e.x, ny);
              const blockedY = obsY.some(r => circleRectCollide(e.x, ny, e.r, r));
              if (!blockedY) e.y = ny;
              if (blockedX && blockedY) {
                const ang = Math.atan2(dy, dx) + Math.PI / 2;
                const sx = e.x + Math.cos(ang) * e.spd * enemyDt;
                const sy = e.y + Math.sin(ang) * e.spd * enemyDt;
                const slideObs = getNearbyObstacles(sx, sy);
                if (!slideObs.some(r => circleRectCollide(sx, sy, e.r, r))) {
                  e.x = sx;
                  e.y = sy;
                }
              }
            } else { e.x = nx; e.y = ny; }
          };

          // behavior by type
          if (serverSim && e.type !== 'reaper') {
            // movement already simulated on server; only handle contact/FX locally
          } else switch (e.type) { // run reaper locally even in serverSim
            case 'boss': {
              // slow approach + periodic radial shots, spreads, and stomps
              moveTowards(0.75);
              avoidWalls();
              const ignitionHardMidBoss = (e.name === '中型個体' && diffName === 'むずかしい' && isIgnitionModeActive());
              // radial bullet ring
              if (e.cd <= 0) {
                e.cd = 1.8 / diffCfg.bulletMul; // fire slower on lower difficulties
                // 可視性・回避性: ボスが画面内のときのみ発射（不可視弾禁止）
                if (isOnScreen(e.x, e.y, 24)) {
                  const n = Math.max(1, Math.round(12 * diffCfg.bulletMul));
                  const baseSpd = 200 + Math.min(200, timeAlive * 0.2);
                  const dmg = Math.max(1, Math.round((6 + Math.floor(timeAlive / 120)) * diffCfg.bulletDmgMul));
                  const offset = (e.t * 0.8) % (Math.PI * 2);
                  for (let k = 0; k < n; k++) {
                    const ang = offset + (Math.PI * 2 * k) / n;
                    // 最小武装時間を設定し、出現直後に当たらないようにする
                    enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 2.6, dmg, arm: 0.12 });
                  }
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                  try { playBossAttackFx(); } catch { }
                }
              }
              // aimed spread toward target
              e.spreadCd = (e.spreadCd ?? 5.5) - enemyDt;
              if (e.spreadCd <= 0) {
                e.spreadCd = 6.5;
                if (isOnScreen(e.x, e.y, 24)) {
                  const baseSpd = 220 + Math.min(200, timeAlive * 0.25);
                  const dmg = Math.max(1, Math.round((5 + Math.floor(timeAlive / 160)) * diffCfg.bulletDmgMul));
                  const baseAng = Math.atan2(dy, dx);
                  for (let k = -2; k <= 2; k++) {
                    const ang = baseAng + k * 0.2;
                    enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 2.6, dmg, arm: 0.12 });
                  }
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                  try { playBossAttackFx(); } catch { }
                }
              }
              // stomp AoE when close
              e.stompCd = (e.stompCd ?? 3.5) - enemyDt;
              if (e.stompCd <= 0 && dist < 140) {
                e.stompCd = 4.0;
                // 直接ダメージせず、まずテレグラフを表示。その後に実爆発。
                hazards.push({ type: 'telegraph', x: e.x, y: e.y, r: 80, tele: 0.6, dmg: 24 + Math.floor(timeAlive / 150), next: { r: 80, ttl: 0.16 } });
                try { Audio?.playSfx?.(state, 'warn'); } catch { }
              }
              // spiral bullet pairs (normal difficulty+)
              if (diffName !== 'かんたん') {
                e.spinCd = (e.spinCd ?? 0.3) - enemyDt;
                if (e.spinCd <= 0) {
                  e.spinCd = 0.3;
                  e.spinAng = (e.spinAng ?? 0) + 0.3;
                  if (isOnScreen(e.x, e.y, 24)) {
                    const baseSpd = 180 + Math.min(200, timeAlive * 0.2);
                    const dmg = Math.max(1, Math.round((4 + Math.floor(timeAlive / 180)) * diffCfg.bulletDmgMul));
                    for (let s = 0; s < 2; s++) {
                      const ang = e.spinAng + s * Math.PI;
                      enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 2.6, dmg, arm: 0.12 });
                    }
                    try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                    try { playBossAttackFx(); } catch { }
                  }
                }
              }
              // ignition mode hard mid-boss: dense, slow spiral barrages
              if (ignitionHardMidBoss) {
                if ((e.ignitionSpiralShots ?? 0) <= 0) {
                  e.ignitionSpiralCd = (e.ignitionSpiralCd ?? 6) - enemyDt;
                  if (e.ignitionSpiralCd <= 0) {
                    e.ignitionSpiralCd = 12;
                    e.ignitionSpiralShots = Math.max(18, Math.round(24 * diffCfg.bulletMul));
                    e.ignitionSpiralGap = 0;
                    e.ignitionSpiralPhase = Math.random() * Math.PI * 2;
                    e._ignitionSpiralFxReady = true;
                  }
                }
                if ((e.ignitionSpiralShots ?? 0) > 0) {
                  e.ignitionSpiralGap = (e.ignitionSpiralGap ?? 0) - enemyDt;
                  if (e.ignitionSpiralGap <= 0) {
                    e.ignitionSpiralGap = 0.08;
                    e.ignitionSpiralShots--;
                    e.ignitionSpiralPhase = (e.ignitionSpiralPhase ?? Math.random() * Math.PI * 2) + 0.32;
                    if (isOnScreen(e.x, e.y, 36)) {
                      const baseSpd = 70;
                      const dmg = Math.max(1, Math.round((8 + Math.floor(timeAlive / 160)) * diffCfg.bulletDmgMul));
                      const shotCount = Math.max(10, Math.round(10 * diffCfg.bulletMul));
                      for (let k = 0; k < shotCount; k++) {
                        const ang = e.ignitionSpiralPhase + (Math.PI * 2 * k) / shotCount;
                        enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 6.5, dmg, arm: 0.12 });
                      }
                      if (e._ignitionSpiralFxReady) {
                        try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                        try { playBossAttackFx(); } catch { }
                        e._ignitionSpiralFxReady = false;
                      }
                    }
                  }
                }
              }
              const ignitionMidBoss = (e.name === '中型個体' && isIgnitionModeActive());
              if (ignitionMidBoss && !e._ignitionStarFinished) {
                if (!e._ignitionStarActive && e.t >= 15) {
                  e._ignitionStarActive = true;
                  e._ignitionStarTimer = 15;
                  e._ignitionStarEmitCd = 0;
                  e._ignitionStarAngle = Math.random() * Math.PI * 2;
                }
                if (e._ignitionStarActive) {
                  e._ignitionStarTimer = Math.max(0, (e._ignitionStarTimer ?? 0) - enemyDt);
                  e._ignitionStarEmitCd = (e._ignitionStarEmitCd ?? 0) - enemyDt;
                  if (e._ignitionStarEmitCd <= 0) {
                    const intervalBase = IGNITION_STAR_EMIT_INTERVAL / Math.max(0.7, diffCfg.bulletMul || 1);
                    e._ignitionStarEmitCd = intervalBase;
                    e._ignitionStarAngle = (e._ignitionStarAngle ?? Math.random() * Math.PI * 2) + 0.42;
                    if (isOnScreen(e.x, e.y, 72)) {
                      let existingStars = enemyProjectiles.filter(b => b.type === 'ignitionStar').length;
                      if (existingStars < IGNITION_STAR_BULLET_LIMIT) {
                        const branchCount = 5;
                        const perBranch = Math.max(5, Math.round(6 * (diffCfg.bulletMul || 1)));
                        const baseSpeed = 40;
                        const speedStep = 3.5;
                        const dmg = Math.max(1, Math.round((7 + Math.floor(timeAlive / 140)) * diffCfg.bulletDmgMul));
                        let spawned = 0;
                        for (let branch = 0; branch < branchCount; branch++) {
                          const baseAng = e._ignitionStarAngle + (Math.PI * 2 * branch) / branchCount;
                          const paletteEven = (branch % 2) === 0;
                          for (let j = 0; j < perBranch; j++) {
                            if (existingStars >= IGNITION_STAR_BULLET_LIMIT) break;
                            const rel = j - (perBranch - 1) / 2;
                            const ang = baseAng + rel * 0.07;
                            const speed = baseSpeed + Math.abs(rel) * speedStep;
                            const spinDir = rel < 0 ? -1 : 1;
                            const spin = spinDir * (0.55 + Math.abs(rel) * 0.04);
                            const scale = 1.2 + (Math.abs(rel) / Math.max(1, perBranch - 1)) * 0.6;
                            enemyProjectiles.push({
                              type: 'ignitionStar',
                              x: e.x,
                              y: e.y,
                              vx: Math.cos(ang) * speed,
                              vy: Math.sin(ang) * speed,
                              speed,
                              maxSpeed: speed + 55,
                              accel: 9,
                              ang,
                              spin,
                              r: 5,
                              ttl: 11.5,
                              dmg,
                              arm: 0.16,
                              starScale: scale,
                              starPulseRate: 6 + (j % 4),
                              starRotation: ang,
                              starFill: paletteEven ? '#ffe87d' : '#8fd4ff',
                              starGlow: paletteEven ? '#fff4b1' : '#c7f1ff',
                              starStroke: paletteEven ? '#fffbe6' : '#f0f8ff',
                              starTrail: paletteEven ? 'rgba(255,236,170,0.55)' : 'rgba(180,226,255,0.55)'
                            });
                            existingStars++;
                            spawned++;
                          }
                          if (existingStars >= IGNITION_STAR_BULLET_LIMIT) break;
                        }
                        if (spawned > 0) {
                          try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                          try { playBossAttackFx(); } catch { }
                        }
                      }
                    }
                  }
                  if ((e._ignitionStarTimer ?? 0) <= 0) {
                    e._ignitionStarActive = false;
                    e._ignitionStarFinished = true;
                  }
                }
              }
              // star-shaped barrages
              const starIntervalLookup = { 'かんたん': 20, 'むずかしい': 12 };
              const starInterval = starIntervalLookup[diffName] ?? 15;
              e.starCd = (e.starCd ?? starInterval) - enemyDt;
              if (e.starCd <= 0) {
                e.starCd = starInterval;
                e.starShots = 3;
                e.starSeqCd = 0;
              }
              if (e.starShots > 0) {
                e.starSeqCd = (e.starSeqCd ?? 0) - enemyDt;
                if (e.starSeqCd <= 0) {
                  e.starSeqCd = 1;
                  e.starShots--;
                  if (isOnScreen(e.x, e.y, 24)) {
                    const baseSpd = 160 + Math.min(160, timeAlive * 0.2);
                    const dmg = Math.max(1, Math.round((6 + Math.floor(timeAlive / 150)) * diffCfg.bulletDmgMul));
                    // e.t is the elapsed time for this enemy entity; using it here causes the star pattern to rotate over time.
                    const offset = e.t % (Math.PI * 2);
                    for (let k = 0; k < 5; k++) {
                      const ang = offset + (Math.PI * 2 * k) / 5;
                      enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 3.2, dmg, arm: 0.12 });
                      const ang2 = ang + Math.PI / 5;
                      enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang2) * baseSpd * 0.6, vy: Math.sin(ang2) * baseSpd * 0.6, r: 4, ttl: 3.2, dmg, arm: 0.12 });
                    }
                    try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                    try { playBossAttackFx(); } catch { }
                  }
                }
              }
              // dense bullet barrage every 20 seconds
              e.barrageCd = (e.barrageCd ?? 20) - enemyDt;
              if (e.barrageCd <= 0) {
                e.barrageCd = 20;
                if (isOnScreen(e.x, e.y, 24)) {
                  const n = Math.max(1, Math.round(40 * diffCfg.bulletMul));
                  const baseSpd = 120;
                  const dmg = Math.max(1, Math.round((5 + Math.floor(timeAlive / 150)) * diffCfg.bulletDmgMul));
                  const offset = e.t % (Math.PI * 2);
                  for (let k = 0; k < n; k++) {
                    const ang = offset + (Math.PI * 2 * k) / n;
                    enemyProjectiles.push({ type: 'boss', x: e.x, y: e.y, vx: Math.cos(ang) * baseSpd, vy: Math.sin(ang) * baseSpd, r: 4, ttl: 4.5, dmg, arm: 0.12 });
                  }
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                  try { playBossAttackFx(); } catch { }
                }
              }
              break;
            }
            case 'reaper': {
              // fast pursuit and sniper assaults like Mero
              moveTowards(1.0);
              avoidWalls();
              // avoidWalls may fail to reposition when spawning inside obstacles; ensure movement
              e.x = nx;
              e.y = ny;
              // Regular attack cooldown
              e.cd = (e.cd ?? 0.6) - enemyDt;
              if (e.cd <= 0) {
                e.cd = 0.6;
                const t = pickNearestTarget(e.x, e.y, e);
                const dx = t.x - e.x, dy = t.y - e.y;
                const dist = Math.hypot(dx, dy) || 1;
                if (isOnScreen(e.x, e.y, 24)) {
                  const dmg = 40;
                  enemyProjectiles.push({
                    type: 'boss',
                    x: e.x, y: e.y,
                    vx: (dx / dist) * 180,
                    vy: (dy / dist) * 180,
                    r: 4,
                    ttl: 1.6,
                    dmg,
                    arm: 0.08
                  });
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                }
              }
              // Sniper attack cooldown
              e.snipeCd = (e.snipeCd ?? reaperCfg.charge) - enemyDt;
              if (e.snipeCd <= 0) {
                e.snipeCd = reaperCfg.charge;
                const t = pickNearestTarget(e.x, e.y, e);
                const dx2 = t.x - e.x, dy2 = t.y - e.y;
                const dist2 = Math.hypot(dx2, dy2) || 1;
                if (isOnScreen(e.x, e.y, 24)) {
                  const dmg = 200;
                  enemyProjectiles.push({
                    type: 'boss',
                    x: e.x, y: e.y,
                    vx: (dx2 / dist2) * reaperCfg.spd,
                    vy: (dy2 / dist2) * reaperCfg.spd,
                    r: reaperCfg.r,
                    ttl: reaperCfg.ttl,
                    dmg,
                    arm: 0.12
                  });
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                  try { playBossAttackFx(); } catch { }
                }
              }
              break;
            } // end reaper
            case 'zig': {
              // snake-like zigzag while approaching
              const ang = Math.atan2(dy, dx) + Math.sin(e.t * 4 + e.phase) * 0.6;
              nx = e.x + Math.cos(ang) * e.spd * enemyDt;
              ny = e.y + Math.sin(ang) * e.spd * enemyDt;
              avoidWalls();
              break;
            }
            case 'shooter': {
              // maintain medium distance; strafe sideways
              const want = e.range || 280;
              const toMe = Math.atan2(dy, dx);
              const side = toMe + Math.PI / 2;
              const toward = dist > want ? 1 : (dist < want * 0.7 ? -0.7 : 0);
              nx = e.x + (Math.cos(toMe) * e.spd * toward + Math.cos(side) * e.spd * 0.5 * Math.sin(e.t * 2 + e.phase)) * enemyDt;
              ny = e.y + (Math.sin(toMe) * e.spd * toward + Math.sin(side) * e.spd * 0.5 * Math.sin(e.t * 2 + e.phase)) * enemyDt;
              avoidWalls();
              // fire
              if (e.cd <= 0 && dist < (e.range || 300) + 40) {
                e.cd = (2.8 + Math.random() * 1.5) / diffCfg.bulletMul; // slower firing on lower difficulties
                // 可視性: 画面内かつ（迷宮では）視線が通るときのみ発射
                if (isOnScreen(e.x, e.y, 8) && canSee(e.x, e.y, tgt.x, tgt.y)) {
                  const bSpd = 180 + Math.min(180, timeAlive * 0.2);
                  const dmg = Math.max(1, Math.round((3 + Math.floor(timeAlive / 180)) * diffCfg.bulletDmgMul));
                  const vx = (dx / dist) * bSpd, vy = (dy / dist) * bSpd;
                  // 最小武装時間（フレーム落ち等で出現即ヒットを防止）
                  enemyProjectiles.push({ type: 'shooter', x: e.x, y: e.y, vx, vy, r: 4, ttl: 2.2, dmg, arm: 0.08 });
                  try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                }
              }
              break;
            }
            case 'dasher': {
              // stalk -> windup -> dash straight
              if (e.state === 'stalk') {
                moveTowards(0.85);
                avoidWalls();
                if (dist < 180 && e.cd <= 0) { e.state = 'wind'; e.dash.wind = 0.3; e.dash.vx = (dx / dist) * (320 + Math.min(220, timeAlive * 0.2)); e.dash.vy = (dy / dist) * (320 + Math.min(220, timeAlive * 0.2)); }
              } else if (e.state === 'wind') {
                e.dash.wind -= enemyDt;
                // no movement; telegraph handled in draw
                if (e.dash.wind <= 0) { e.state = 'dash'; e.dash.time = 0.22; }
              } else if (e.state === 'dash') {
                nx = e.x + e.dash.vx * enemyDt; ny = e.y + e.dash.vy * enemyDt;
                // collide with walls in maze to stop
                if (!stage.ignoreMobWalls && (stage.type === 'maze' || stage.iceBlocks)) {
                  const obs = getNearbyObstacles(nx, ny);
                  if (obs.some(r => circleRectCollide(nx, ny, e.r, r))) { e.state = 'stalk'; e.cd = 1.0; }
                }
                e.dash.time -= enemyDt;
                e.x = nx; e.y = ny;
                if (e.dash.time <= 0) { e.state = 'stalk'; e.cd = 0.8; }
              }
              break;
            }
            case 'bomber': {
              // slow chase; start fuse near player
              moveTowards(0.8);
              avoidWalls();
              if (dist < 70 && e.fuse < 0) { e.fuse = e.blast.fuseTime; }
              if (e.fuse >= 0) {
                e.fuse -= enemyDt;
                if (e.fuse <= 0) {
                  // explode
                  hazards.push({
                    type: 'explosion',
                    x: e.x,
                    y: e.y,
                    r: e.blast.r,
                    ttl: 0.12,
                    maxTtl: 0.12,
                    dmg: 12 + Math.floor(timeAlive / 200),
                    fx: 'bomber',
                  });
                  pushKill(e);
                }
              }
              break;
            }
            case 'freezer': {
              moveTowards(0.6);
              avoidWalls();
              e.blockCd -= enemyDt;
              if (e.blockCd <= 0) { e.blockCd = 4; if (stage.iceBlocks) placeIceBlock(e.x, e.y); }
              break;
            }
            case 'ignitionSuppressor': {
              moveTowards(0.25);
              avoidWalls();
              const burstReady = e.cd <= 0;
              if (burstReady) {
                e.cd = (3.4 + Math.random() * 1.0) / Math.max(0.6, diffCfg.bulletMul);
                e.burstShots = 3;
                e.burstGap = 0;
              }
              if ((e.burstShots ?? 0) > 0) {
                e.burstGap = (e.burstGap ?? 0) - enemyDt;
                if (e.burstGap <= 0) {
                  e.burstGap = 0.24;
                  e.burstShots--;
                  if (isOnScreen(e.x, e.y, 16)) {
                    const shotCount = Math.max(18, Math.round(24 * diffCfg.bulletMul));
                    const baseSpd = 200 + Math.min(160, timeAlive * 0.18);
                    const dmg = Math.max(1, Math.round((4 + Math.floor(timeAlive / 150)) * diffCfg.bulletDmgMul));
                    const phase = (e.burstPhase = (e.burstPhase ?? Math.random() * Math.PI * 2) + 0.18);
                    for (let k = 0; k < shotCount; k++) {
                      const ang = phase + (Math.PI * 2 * k) / shotCount;
                      enemyProjectiles.push({
                        type: 'ignitionSuppressor',
                        x: e.x,
                        y: e.y,
                        vx: Math.cos(ang) * baseSpd,
                        vy: Math.sin(ang) * baseSpd,
                        r: 3.2,
                        ttl: 2.6,
                        dmg,
                        arm: 0.1
                      });
                    }
                    try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                  }
                }
              }
              break;
            }
            case 'barrage': {
              const moveSpd = e.spd || 40;
              e.wanderTimer = (e.wanderTimer ?? 0) - enemyDt;
              if (e.wanderTimer <= 0) {
                e.wanderTimer = 2.5 + Math.random() * 2.5;
                e.wanderAng = Math.random() * Math.PI * 2;
              }
              const wanderAng = e.wanderAng ?? 0;
              nx = e.x + Math.cos(wanderAng) * moveSpd * enemyDt;
              ny = e.y + Math.sin(wanderAng) * moveSpd * enemyDt;
              avoidWalls();
              if (e.interval) {
                e.cd = (e.cd ?? e.interval) - enemyDt;
                if (e.cd <= 0) {
                  e.cd = e.interval;
                  if (isOnScreen(e.x, e.y, 16)) {
                    const volley = Math.max(6, Math.round(e.volley || 12));
                    const rings = Math.max(1, Math.round(e.rings || 1));
                    const bulletSpd = e.bulletSpd || 100;
                    const ttl = e.bulletTtl || 5.5;
                    const dmg = Math.max(1, Math.round(e.bulletDmg || 6));
                    e.patternPhase = (e.patternPhase ?? Math.random() * Math.PI * 2) + 0.35;
                    const activeBarrage = enemyProjectiles.reduce((n, b) => n + (b.type === 'barrage' ? 1 : 0), 0);
                    const limit = e.bulletLimit || BARRAGE_BULLET_LIMIT;
                    if (activeBarrage < limit) {
                      for (let r = 0; r < rings; r++) {
                        const offset = e.patternPhase + (r * Math.PI) / rings;
                        for (let k = 0; k < volley; k++) {
                          const ang = offset + (Math.PI * 2 * k) / volley;
                          enemyProjectiles.push({
                            type: 'barrage',
                            x: e.x,
                            y: e.y,
                            vx: Math.cos(ang) * bulletSpd,
                            vy: Math.sin(ang) * bulletSpd,
                            r: 4,
                            ttl,
                            dmg,
                            arm: 0.25
                          });
                        }
                      }
                      try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                    }
                  }
                }
              }
              if (e.sprayInterval) {
                e.sprayCd = (e.sprayCd ?? e.sprayInterval) - enemyDt;
                if (e.sprayCd <= 0) {
                  e.sprayCd = e.sprayInterval;
                  if (isOnScreen(e.x, e.y, 16)) {
                    const shots = Math.max(3, Math.round(e.sprayShots || 4));
                    const fan = e.fan ?? 0.4;
                    const spraySpeed = e.spraySpeed || (e.bulletSpd || 100) * 0.8;
                    const ttl = (e.bulletTtl || 5.5) * 0.8;
                    const dmg = Math.max(1, Math.round((e.sprayDmg || e.bulletDmg || 6)));
                    const limit = e.bulletLimit || BARRAGE_BULLET_LIMIT;
                    const activeBarrage = enemyProjectiles.reduce((n, b) => n + (b.type === 'barrage' ? 1 : 0), 0);
                    if (activeBarrage + shots <= limit) {
                      for (let k = 0; k < shots; k++) {
                        const ratio = shots > 1 ? (k / (shots - 1)) - 0.5 : 0;
                        const ang = Math.atan2(dy, dx) + fan * ratio;
                        enemyProjectiles.push({
                          type: 'barrage',
                          x: e.x,
                          y: e.y,
                          vx: Math.cos(ang) * spraySpeed,
                          vy: Math.sin(ang) * spraySpeed,
                          r: 4,
                          ttl,
                          dmg,
                          arm: 0.15
                        });
                      }
                      try { Audio?.playSfx?.(state, 'enemyShot'); } catch { }
                    }
                  }
                }
              }
              break;
            }
            default: {
              // chaser (base)
              moveTowards(1);
              avoidWalls();
            }
          }
          if (stage.type === 'volcano' && e.x < lavaX) {
            if (e.boss) {
              e.x = lavaX + e.r + 1;
            } else if (serverSim) {
              queueHit(e.id, e.hp || (stage.lavaDamage || 999), stage.lavaDamage || 999);
              accumServerDamage(e.id, stage.lavaDamage || 999, e.x, e.y);
            } else {
              e.hp = 0;
              if (e.alive) {
                pushKill(e);
                spawnDamageNumber(e.x, e.y, '-' + (stage.lavaDamage || 999));
                e._accDmg = 0;
              }
            }
          }
          // shield block
          if (charName === 'フルムーン' && shield && shield.hp > 0) {
            const sx = player.x + shield.dirX * shield.size;
            const sy = player.y + shield.dirY * shield.size;
            const ang = Math.atan2(shield.dirY, shield.dirX);
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dx = e.x - sx, dy = e.y - sy;
            const rx = dx * cos + dy * sin;
            const ry = -dx * sin + dy * cos;
            const halfW = shield.w / 2, halfH = shield.size;
            if (Math.abs(rx) <= halfW + e.r && Math.abs(ry) <= halfH + e.r) {
              const dmg = cfg.fullmoon.dmg * enemyDt;
              const mul = e.dmgTakenMul ?? 1;
              if (serverSim) {
                queueHit(e.id, dmg, dmg * mul);
                accumServerDamage(e.id, dmg * mul, e.x, e.y);
              } else {
                const actual = dmg * mul; e.hp -= actual; accumEnemyDamage(e, actual);
                if (e.hp <= 0 && e.alive) { pushKill(e); }
              }
              const norm = Math.hypot(dx, dy) || 1;
              const nx = dx / norm, ny = dy / norm;
              const rad = Math.max(halfW, halfH);
              if (state.perks.ex) { const kb = cfg.fullmoon.kb * enemyDt; e.x += nx * kb; e.y += ny * kb; }
              else { e.x = sx + nx * (rad + e.r); e.y = sy + ny * (rad + e.r); }
              shield.hp -= dmg;
              if (shield.hp <= 0) { shield.cd = cfg.fullmoon.regen; }
              return;
            }
          }
          // contact damage (all types) — only damage local player on actual contact with them
          const dMe = Math.hypot(player.x - e.x, player.y - e.y);
          let decoyIntercepted = false;
          let enemyOnScreen = null;
          if (charName === 'あんどー' && state?.perks?.ex && decoys.length && !e.boss) {
            const contactRadius = e.r + 10;
            let nearestDecoy = null;
            let nearestDist = contactRadius;
            for (const d of decoys) {
              if (!d) continue;
              const dist = Math.hypot(d.x - e.x, d.y - e.y);
              if (dist < nearestDist) { nearestDist = dist; nearestDecoy = d; }
            }
            if (nearestDecoy) {
              const clearLine = !hasWallBetween(nearestDecoy.x, nearestDecoy.y, e.x, e.y);
              enemyOnScreen = enemyOnScreen ?? isOnScreen(e.x, e.y, e.r + 8);
              if (clearLine && enemyOnScreen) {
                nearestDecoy.hp -= 5 * enemyDt;
                decoyIntercepted = true;
              }
            }
          }
          if (!decoyIntercepted && !jumpState.active && dMe < player.r + e.r) {
            // 迷宮では壁越しの接触は無効、かつ不可視（画面外）からの接触ダメも無効化
            enemyOnScreen = enemyOnScreen ?? isOnScreen(e.x, e.y, e.r + 8);
            if (!hasWallBetween(player.x, player.y, e.x, e.y) && enemyOnScreen) {
              if (invulnT <= 0) {
                const { hp: taken } = applyPlayerDamage(5 * enemyDt); playerDmgAcc += taken;
                const nowHit = performance.now();
                if (nowHit - state.audio.lastHitAt > 300) { try { Audio?.playSfx?.(state, 'hit'); } catch { } state.audio.lastHitAt = nowHit; }
              }
            }
          }
          if (state.activeCardEffects.some(eff => eff.type === 'knockback')) {
            const dist = Math.hypot(player.x - e.x, player.y - e.y);
            if (dist < player.r + e.r + 40) {
              const kb = 600 * enemyDt;
              const nx = (e.x - player.x) / (dist || 1);
              const ny = (e.y - player.y) / (dist || 1);
              e.x += nx * kb;
              e.y += ny * kb;
            }
          }
        });

        let regenRate = 0; if (openLevelUp.regen) regenRate += openLevelUp.regen; if (charName === 'ナタリア') regenRate += cfg.nata.regen;
        if (state.stats.alive && regenRate > 0) {
          const before = state.stats.hp;
          const regenVal = applyHealBonus(regenRate * dt);
          state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + regenVal);
          const healed = state.stats.hp - before;
          if (healed > 0) playerHealAcc += healed;
        }
        if (state.stats.alive && state.stats.armor < state.stats.maxArmor) {
          const arSpeed = state.energyUnlocked && state.energy.cuteness >= 80 ? 1.5 : 1;
          armorTimer += dt * arSpeed;
          if (armorTimer >= 10) { state.stats.armor = Math.min(state.stats.maxArmor, state.stats.armor + 1); armorTimer -= 10; }
        }

        if (state.stats.alive && charName === 'ナタリア') {
          const range = cfg.nata.leftRange || 40;
          const halfH = (cfg.nata.leftHeight || 60) * 0.5;
          const elemStage = getPlayerElementStage(state.stats.elem);
          enemies.forEach(e => {
            if (!e.alive) return;
            if (e.x < player.x && player.x - e.x <= range && Math.abs(e.y - player.y) <= halfH) {
              let dealt = (cfg.nata.leftDps || 2) * dt;
              dealt = applyElementalMultiplier(dealt, state.stats.elem, e.elem, elemStage);
              dealt = applyBossBonus(dealt, e);
              const mul = e.dmgTakenMul ?? 1;
              if (serverSim) {
                queueHit(e.id, dealt, dealt * mul);
                accumServerDamage(e.id, dealt * mul, e.x, e.y);
              } else {
                const actual = dealt * mul;
                e.hp -= actual; accumEnemyDamage(e, actual);
                if (e.hp <= 0 && e.alive) { pushKill(e); }
              }
            }
          });
          if (state.perks.ex) {
            const healR = cfg.nata.healRange;
            const rate = cfg.nata.healRate * dt;
            for (const [pid, ally] of Object.entries(state.allies)) {
              if (!ally.alive) continue;
              const d = Math.hypot(ally.x - player.x, ally.y - player.y);
              if (d <= healR) {
                if (serverSim) { healAlly(pid, applyHealBonus(rate)); }
              }
            }
          }
        }
        if (state.stats.alive && charName === 'おきーぱー') { batTimer -= dt; if (batTimer <= 0) { batTimer = cfg.okp.interval; const count = cfg.okp.count || 1; for (let i = 0; i < count; i++) { projectiles.push({ type: 'bat', x: player.x, y: player.y, r: cfg.okp.pr, spd: cfg.okp.spd, dmg: cfg.okp.dmg, ttl: 1, pierce: !!state.perks.ex }); } } }
        if (state.stats.alive && charName === '恋恋') {
          bombTimer -= dt;
          if (bombTimer <= 0) {
            bombTimer = cfg.koi.interval;
            projectiles.push({ type: 'bomb', x: player.x, y: player.y, vx: 0, vy: 0, r: 6, dmg: cfg.koi.dmg, air: 0, fuse: cfg.koi.fuse, radius: cfg.koi.radius, knockback: cfg.koi.knockback });
          }
        }
        if (state.stats.alive && charName === 'あんどー') {
          decoyTimer -= dt;
          if (decoyTimer <= 0) {
            decoyTimer = cfg.ando.interval;
            if (decoys.length < cfg.ando.max) {
              decoys.push({ x: player.x, y: player.y, hp: cfg.ando.hp, maxHp: cfg.ando.hp });
            }
          }
        }
        if (state.stats.alive && charName === 'メロ') {
          sniperTargets = sniperTargets.filter(t => t.alive);
          if (sniperTargets.length < 2) {
            const hadTargets = sniperTargets.length > 0;
            sniperTargets = [];
            const candidates = enemies.filter(e => e.alive)
              .sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));
            sniperTargets = candidates.slice(0, 2);
            if (sniperTargets.length > 0) {
              sniperTimer = cfg.mero.charge;
              if (!hadTargets) try { Audio?.playSfx?.(state, 'sniperAim'); } catch { }
            }
          } else {
            sniperTimer -= dt;
            if (sniperTimer <= 0) {
              const dmg = Math.max(1, Math.round(getAtk() * cfg.mero.dmgScale));
              for (const tgt of sniperTargets) {
                const dx = tgt.x - player.x, dy = tgt.y - player.y; const dist = Math.hypot(dx, dy) || 1;
                projectiles.push({ type: 'sniper', x: player.x, y: player.y, vx: (dx / dist) * cfg.mero.spd, vy: (dy / dist) * cfg.mero.spd, r: cfg.mero.r, dmg, ttl: cfg.mero.ttl, elem: state.stats.elem, pierce: true });
                selfLines.push({ x1: player.x, y1: player.y, x2: tgt.x, y2: tgt.y, ttl: 0.12, w: 2, col: '#ffdf5c' });
              }
              try { Audio?.playSfx?.(state, 'sniperShot'); } catch { }
              sniperTargets = [];
            }
          }
        }
        if (state.stats.alive) {
          syncSupportBookCount();
          const laserCount = Math.max(0, openLevelUp.supportLasers || 0);
          if (laserCount === 0 && lastSupportLaserCount > 0) {
            for (let i = projectiles.length - 1; i >= 0; i--) {
              if (projectiles[i].type === 'supportLaser') { projectiles.splice(i, 1); }
            }
          }
          if (laserCount > 0) {
            supportLaserTimer -= dt;
            if (supportLaserTimer <= 0) {
              supportLaserTimer = SUPPORT_LASER_COOLDOWN;
              const baseAngle = Math.random() * Math.PI * 2;
              const dmg = Math.max(1, Math.round(getAtk() * SUPPORT_LASER_DAMAGE_MUL));
              for (let i = 0; i < laserCount; i++) {
                const angle = baseAngle + (Math.PI * 2 * i) / laserCount;
                projectiles.push({
                  type: 'supportLaser',
                  x: player.x,
                  y: player.y,
                  vx: Math.cos(angle) * SUPPORT_LASER_SPEED,
                  vy: Math.sin(angle) * SUPPORT_LASER_SPEED,
                  radius: SUPPORT_LASER_RADIUS,
                  dmg,
                  bounces: 0,
                  maxBounces: SUPPORT_LASER_MAX_BOUNCES,
                  ttl: SUPPORT_LASER_MAX_LIFETIME,
                  hitCooldowns: new Map(),
                });
              }
              try { Audio?.playSfx?.(state, 'laser'); } catch { }
            }
          } else {
            supportLaserTimer = 0;
          }
          lastSupportLaserCount = laserCount;
          const supportBombCount = Math.max(0, openLevelUp.supportBombs || 0);
          const prevBombCount = lastSupportBombCount;
          if (supportBombCount !== lastSupportBombCount) {
            if (supportBombCount > lastSupportBombCount) supportBombCooldown = 0;
            lastSupportBombCount = supportBombCount;
          }
          if (supportBombCount === 0 && prevBombCount > 0) {
            for (let i = projectiles.length - 1; i >= 0; i--) {
              const proj = projectiles[i];
              if (proj.type === 'supportBomb' || (proj.type === 'fire' && proj.owner === 'supportBomb')) {
                projectiles.splice(i, 1);
              }
            }
          }
          if (supportBombCount > 0) {
            supportBombCooldown -= dt;
            if (supportBombCooldown <= 0) {
              supportBombCooldown = SUPPORT_BOMB_COOLDOWN;
              triggerSupportBombs(supportBombCount);
            }
          } else {
            supportBombCooldown = 0;
          }
          if (supportBooks.length > 0) {
            const serverSim = !!state.serverSim;
            supportBookSpin = (supportBookSpin + dt * SUPPORT_BOOK_SPIN_SPEED) % (Math.PI * 2);
            const count = supportBooks.length;
            const elemStage = getPlayerElementStage(state.stats.elem);
            for (let i = 0; i < count; i++) {
              const book = supportBooks[i];
              const angle = supportBookSpin + (Math.PI * 2 * i) / count;
              const bx = player.x + Math.cos(angle) * SUPPORT_BOOK_ORBIT_RADIUS;
              const by = player.y + Math.sin(angle) * SUPPORT_BOOK_ORBIT_RADIUS;
              book.x = bx;
              book.y = by;
              book.angle = angle;
              const timers = book.hitCooldowns || (book.hitCooldowns = new Map());
              for (const [target, remain] of Array.from(timers.entries())) {
                const next = remain - dt;
                if (!target?.alive || next <= 0) timers.delete(target);
                else timers.set(target, next);
              }
              for (const enemy of enemies) {
                if (!enemy.alive) continue;
                const dx = enemy.x - bx;
                const dy = enemy.y - by;
                const rad = (enemy.r || 0) + SUPPORT_BOOK_COLLISION_RADIUS;
                if (dx * dx + dy * dy > rad * rad) continue;
                if (timers.has(enemy)) continue;
                let dmg = getAtk();
                dmg = applyElementalMultiplier(dmg, state.stats.elem, enemy.elem, elemStage);
                dmg = applyBossBonus(dmg, enemy);
                dmg = Math.max(1, Math.round(dmg));
                const mul = enemy.dmgTakenMul ?? 1;
                if (serverSim) {
                  queueHit(enemy.id, dmg, dmg * mul);
                  accumServerDamage(enemy.id, dmg * mul, enemy.x, enemy.y);
                } else {
                  const actual = dmg * mul;
                  enemy.hp -= actual;
                  accumEnemyDamage(enemy, actual);
                  if (state.settings.damageNumbers) {
                    spawnDamageNumber(enemy.x, enemy.y, '-' + Math.round(actual));
                  }
                  if (enemy.hp <= 0 && enemy.alive) { pushKill(enemy); }
                }
                timers.set(enemy, SUPPORT_BOOK_HIT_COOLDOWN);
              }
            }
          }
        } else {
          supportBooks.length = 0;
          supportLaserTimer = 0;
          lastSupportLaserCount = 0;
          supportBombCooldown = 0;
          lastSupportBombCount = 0;
          for (let i = projectiles.length - 1; i >= 0; i--) {
            const proj = projectiles[i];
            if (proj.type === 'supportLaser' || proj.type === 'supportBomb' || (proj.type === 'fire' && proj.owner === 'supportBomb')) {
              projectiles.splice(i, 1);
            }
          }
        }
        if (!state.stats.alive) {
          fullmoonActive = null;
        }
        if (charName === 'フルムーン' && fullmoonActive) {
          const lockDur = fullmoonActive.lockDuration ?? 0;
          const chargeDur = fullmoonActive.chargeDuration ?? 0;
          const slamDur = fullmoonActive.slamDuration ?? 0;
          const total = fullmoonActive.totalDuration ?? (lockDur + chargeDur + slamDur);
          fullmoonActive.elapsed += dt;
          const elapsed = fullmoonActive.elapsed;
          let nextPhase = 'lockon';
          if (elapsed < lockDur) nextPhase = 'lockon';
          else if (elapsed < lockDur + chargeDur) nextPhase = 'charge';
          else if (elapsed < total) nextPhase = 'slam';
          else nextPhase = 'done';
          if (nextPhase === 'slam' && !fullmoonActive.didSlam) {
            triggerFullmoonSlam(fullmoonActive);
            fullmoonActive.didSlam = true;
          }
          if (nextPhase === 'done') {
            if (!fullmoonActive.didSlam) triggerFullmoonSlam(fullmoonActive);
            fullmoonActive = null;
          } else {
            fullmoonActive.phase = nextPhase;
          }
        }
        for (let i = fullmoonShockwaves.length - 1; i >= 0; i--) {
          const wave = fullmoonShockwaves[i];
          wave.elapsed += dt;
          if (wave.elapsed >= wave.dur) { fullmoonShockwaves.splice(i, 1); }
        }
        if (state.stats.alive && charName === 'あたち') {
          beamAng = (beamAng + 2.5 * beamSpeedMul * dt) % (Math.PI * 2);
          const R = cfg.atc.radius;
          const halfW = cfg.atc.width * 0.5;
          const beamDps = cfg.atc.dps * (2 * Math.PI / cfg.atc.width);
          const beams = state.perks.ex ? [beamAng, (beamAng + Math.PI) % (Math.PI * 2)] : [beamAng];
          enemies.forEach(e => {
            if (!e.alive) return;
            const dx = e.x - player.x;
            const dy = e.y - player.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ang = Math.atan2(dy, dx);
            for (const bAng of beams) {
              let dAng = Math.atan2(Math.sin(ang - bAng), Math.cos(ang - bAng));
              if (Math.abs(dAng) < halfW && dist <= R) {
                let dealt = beamDps * dt;
                dealt = applyBossBonus(dealt, e);
                const mul = e.dmgTakenMul ?? 1;
                if (serverSim) {
                  queueHit(e.id, dealt, dealt * mul);
                  accumServerDamage(e.id, dealt * mul, e.x, e.y);
                } else {
                  const actual = dealt * mul;
                  e.hp -= actual;
                  accumEnemyDamage(e, actual);
                  if (e.hp <= 0 && e.alive) { pushKill(e); }
                }
                if (atcKbActive) {
                  const kb = 200 * dt;
                  e.x += (e.x - player.x) / dist * kb;
                  e.y += (e.y - player.y) / dist * kb;
                }
                break;
              }
            }
          });
        }
        if (state.stats.alive && charName === 'ハクシキ') {
          const R = cfg.haku.radius;
          const elemStage = getPlayerElementStage(state.stats.elem);
          enemies.forEach(e => {
            if (!e.alive) return;
            const dist = Math.hypot(e.x - player.x, e.y - player.y);
            if (dist <= R) {
              let dealt = cfg.haku.dps * dt;
              dealt = applyElementalMultiplier(dealt, state.stats.elem, e.elem, elemStage);
              dealt = applyBossBonus(dealt, e);
              const mul = e.dmgTakenMul ?? 1;
              if (serverSim) {
                queueHit(e.id, dealt, dealt * mul);
                accumServerDamage(e.id, dealt * mul, e.x, e.y);
              } else {
                const actual = dealt * mul;
                e.hp -= actual;
                accumEnemyDamage(e, actual);
                if (e.hp <= 0 && e.alive) { pushKill(e); }
              }
              if (state.perks.ex) {
                const kb = cfg.haku.kb * dt;
                e.x += (e.x - player.x) / dist * kb;
                e.y += (e.y - player.y) / dist * kb;
              }
            }
          });
        }
        if (state.stats.alive && charName === 'U') {
          const zone = cfg.u.zone ?? cfg.u.baseZone ?? 0.5;
          const threshold = zone * cvs.width;
          const elemStage = getPlayerElementStage(state.stats.elem);
          enemies.forEach(e => {
            if (!e.alive) return;
            const s = toScreen(e.x, e.y);
            const onScreen = s.x >= 0 && s.x <= cvs.width && s.y >= 0 && s.y <= cvs.height;
            if (onScreen && s.x > threshold) {
              let dealt = cfg.u.dps * dt;
              dealt = applyElementalMultiplier(dealt, state.stats.elem, e.elem, elemStage);
              dealt = applyBossBonus(dealt, e);
              const mul = e.dmgTakenMul ?? 1;
              if (serverSim) {
                queueHit(e.id, dealt, dealt * mul);
                accumServerDamage(e.id, dealt * mul, e.x, e.y);
              } else {
                const actual = dealt * mul;
                e.hp -= actual;
                accumEnemyDamage(e, actual);
                if (e.hp <= 0 && e.alive) { pushKill(e); }
              }
              if (state.perks.ex && uExCooldown <= 0 && !e.boss && Math.random() < 0.05) {
                if (serverSim) { queueStun(e.id, 1); }
                else { e.stun = Math.max(e.stun || 0, 1); }
                uExCooldown = 3;
              }
            }
          });
        }

        if (state.stats.alive) {
          for (const orb of orbs) {
            const dx = player.x - orb.x;
            const dy = player.y - orb.y;
            const dist = Math.hypot(dx, dy) || 1;
            const range = state.stats.expRange || 80;
            if (dist < range) {
              const pull = Math.max(range, range * 2 - dist) * dt * EXP_ORB_PULL_SPEED;
              orb.x += (dx / dist) * pull;
              orb.y += (dy / dist) * pull;
            }
          }
        }
        for (let i = orbs.length - 1; i >= 0; i--) {
          const orb = orbs[i];
          const dist = Math.hypot(player.x - orb.x, player.y - orb.y);
          if (state.stats.alive && dist < player.r + orb.r) {
            const expUp = 1 + (state.perks.exp || 0) * 0.3;
            const gain = orb.value * expUp;
            if (Number.isFinite(gain) && gain > 0) {
              const rawExp = Number.isFinite(state.stats.exp) ? state.stats.exp : 0;
              state.stats.exp = Math.max(0, rawExp) + gain;
            }
            try { Audio?.playSfx?.(state, 'pickup'); } catch { }
            orbs.splice(i, 1);
          }
        }

        for (let i = killFxs.length - 1; i >= 0; i--) {
          const fx = killFxs[i];
          fx.ttl -= dt;
          if (fx.type === 'ring') {
            const grow = fx.growRate ?? 80;
            fx.r += grow * dt;
          } else if (fx.type === 'blast') {
            const grow = fx.growRate ?? 360;
            const fade = fx.fadeSpeed ?? 160;
            fx.outer = Math.min(fx.targetOuter ?? fx.outer ?? 0, (fx.outer ?? 0) + grow * dt);
            fx.inner = Math.max(0, (fx.inner ?? 0) - fade * dt);
          } else {
            fx.x += (fx.vx ?? 0) * dt;
            fx.y += (fx.vy ?? 0) * dt;
            const shrink = fx.shrink ?? 30;
            fx.r = Math.max(0, fx.r - shrink * dt);
          }
          if (fx.ttl <= 0) killFxs.splice(i, 1);
        }

        if (state.stats.alive) {
          if (converterModal?.classList.contains('hidden')) {
            for (let i = converters.length - 1; i >= 0; i--) {
              const c = converters[i];
              const dist = Math.hypot(player.x - c.x, player.y - c.y);
              if (dist < player.r + c.r) {
                converters.splice(i, 1);
                openConverter();
                break;
              }
            }
          }
          for (let i = heals.length - 1; i >= 0; i--) {
            const h = heals[i];
            const dist = Math.hypot(player.x - h.x, player.y - h.y);
            if (dist < player.r + h.r) {
              if (h.type === 'heal') {
                const healAmount = applyHealBonus(h.value);
                const healed = Math.round(healAmount);
                state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
                if (state.energyUnlocked) {
                  state.energy.sugar = Math.min(100, state.energy.sugar + 20);
                  state.timeSinceLastMelonPan = 0;
                }
                try { Audio?.playSfx?.(state, 'pickup'); } catch { }
                spawnHealNumber(player.x, player.y, healed);
                showToast(`メロンパンを取得！HPが${healed}回復しました`);
                recordMelonPanConsumption();
              } else if (h.type === 'rainbow') {
                // Rare rainbow melonpan
                const base = Number.isFinite(h.value) ? h.value : 50;
                const healAmount = applyHealBonus(base);
                const healed = Math.round(healAmount);
                state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
                if (state.energyUnlocked) {
                  state.energy.sugar = Math.min(100, state.energy.sugar + 20);
                  state.timeSinceLastMelonPan = 0;
                }
                try { Audio?.playSfx?.(state, 'pickup'); } catch { }
                spawnHealNumber(player.x, player.y, healed);
                showToast(`レインボーメロンパンを取得！HPが${healed}回復しました`);
                recordMelonPanConsumption();
              } else if (h.type === 'grimoire') {
                if (h.elem) {
                  gainPlayerElement(h.elem);
                } else {
                  gainPlayerElement(null, { playSfx: false, toast: false });
                }
              }
              heals.splice(i, 1);
            }
          }
          for (let i = moneys.length - 1; i >= 0; i--) {
            const m = moneys[i];
            const dist = Math.hypot(player.x - m.x, player.y - m.y);
            if (dist < player.r + m.r) {
              const gain = addMoney(m.value);
              state._pickedMoney += m.value;
              saveMoney(); updateMoneyLabels();
              try { Audio?.playSfx?.(state, 'pickup'); } catch { }
              showToast(`マネーを取得！+${gain}`);
              moneys.splice(i, 1);
            }
          }
          for (let i = atkBoosts.length - 1; i >= 0; i--) {
            const b = atkBoosts[i];
            const dist = Math.hypot(player.x - b.x, player.y - b.y);
            if (dist < player.r + b.r) {
              state.stats.atk *= 1.5;
              try { Audio?.playSfx?.(state, 'pickup'); } catch { }
              state.activeCardEffects.push({ type: 'atk', mul: 1.5, ttl: 30, name: '攻撃力UP', dur: 30 });
              refreshCardBuffs();
              showToast('攻撃力が30秒間1.5倍！');
              atkBoosts.splice(i, 1);
            }
          }
        }

        for (let i = cardOrbs.length - 1; i >= 0; i--) {
          const o = cardOrbs[i];
          const dist = Math.hypot(player.x - o.x, player.y - o.y);
          if (dist < player.r + o.r) {
            try { Audio?.playSfx?.(state, 'pickup'); } catch { }
            if (state.deck.length >= 3) {
              showToast('デッキがいっぱいでカードを取得できない');
            } else {
              openCardSelect(o.rarity);
            }
            cardOrbs.splice(i, 1);
          }
        }
        if (riskChoiceAreas && riskChoiceAreas.length > 0) {
          const now = timeAlive;
          const activeAreas = riskChoiceAreas.filter(area => {
            if (!area) return false;
            if (typeof area.expiresAt !== 'number') return true;
            return now < area.expiresAt;
          });
          if (activeAreas.length !== riskChoiceAreas.length) {
            if (activeAreas.length === 0) {
              riskChoiceAreas = null;
            } else {
              riskChoiceAreas = activeAreas;
            }
          }
        }
        const needsAreaCheck = !!rewardArea || (Array.isArray(riskChoiceAreas) && riskChoiceAreas.length > 0);
        let areaPlayers = null;
        if (needsAreaCheck) {
          areaPlayers = [{ x: player.x, y: player.y, alive: state.stats.alive }];
          for (const a of Object.values(state.allies)) { if (a) areaPlayers.push({ x: a.x, y: a.y, alive: a.alive }); }
        }
        if (rewardArea && areaPlayers) {
          const allInside = areaPlayers.every(p => p.alive && Math.hypot(p.x - rewardArea.x, p.y - rewardArea.y) < rewardArea.r);
          if (allInside) grantReward();
        }
        if (riskChoiceAreas && areaPlayers) {
          for (const area of riskChoiceAreas) {
            if (!area) continue;
            const allInside = areaPlayers.every(p => p.alive && Math.hypot(p.x - area.x, p.y - area.y) < area.r);
            if (allInside) {
              const spawned = activateRiskArea(area);
              if (spawned > 0) aliveCount += spawned;
              break;
            }
          }
        }

        // 多重レベルアップは一括で計算し、モーダルは1回ずつ表示する
        // nextExp や exp が異常値の場合は補正する
        let exp = Number.isFinite(state.stats.exp) ? state.stats.exp : 0;
        if (exp < 0) exp = 0;
        let lvl = Number.isFinite(state.stats.lvl) ? Math.max(1, Math.floor(state.stats.lvl)) : 1;
        let nextExp = Number.isFinite(state.stats.nextExp) && state.stats.nextExp > 0 ? state.stats.nextExp : 1;
        if (exp >= nextExp) {
          let gained = 0;
          while (exp >= nextExp) {
            exp -= nextExp;
            lvl++;
            nextExp = Math.round(nextExp * 1.4 + 4);
            gained++;
          }
          state.stats.exp = exp;
          state.stats.lvl = lvl;
          state.stats.nextExp = nextExp;
          if (gained > 0) {
            state.pendingLvls = (state.pendingLvls || 0) + gained;
            // まだモーダルが出ていなければ今から1回だけ開く
            if (levelUpModal && levelUpModal.classList.contains('hidden')) {
              openLevelUp();
            }
          }
        } else {
          state.stats.exp = exp;
          state.stats.lvl = lvl;
          state.stats.nextExp = nextExp;
        }

        // flush batched hits at ~15Hz
        _hitFlushT -= dt;
        if (_hitFlushT <= 0 && _hitBatch.size > 0) { flushHitBatchNow(); _hitFlushT = HIT_FLUSH_INTERVAL; }
        _stunFlushT -= dt;
        if (_stunFlushT <= 0 && _stunBatch.size > 0) { flushStunBatchNow(); _stunFlushT = STUN_FLUSH_BASE_INTERVAL; }


        posTimer += dt;
        if (posTimer >= 1 / 15 && state.inGame) {
          posTimer = 0;
          let decoyPayload = [];
          if (charName === 'あんどー' && state?.perks?.ex && decoys.length) {
            const MAX_DECOYS_SYNC = 16;
            const next = [];
            for (let i = 0; i < decoys.length && next.length < MAX_DECOYS_SYNC; i++) {
              const d = decoys[i];
              if (!d) continue;
              const dx = Number.isFinite(d.x) ? d.x : null;
              const dy = Number.isFinite(d.y) ? d.y : null;
              if (dx === null || dy === null) continue;
              const entry = { x: dx, y: dy };
              if (Number.isFinite(d.hp)) entry.hp = d.hp;
              if (Number.isFinite(d.maxHp)) entry.maxHp = d.maxHp;
              next.push(entry);
            }
            decoyPayload = next;
          }
          const posPayload = {
            type: 'pos',
            x: player.x,
            y: player.y,
            alive: state.stats.alive,
            hp: Math.max(0, state.stats.hp),
            maxHp: state.stats.maxHp,
            armor: state.armorUnlocked ? state.stats.armor : 0,
            maxArmor: state.armorUnlocked ? state.stats.maxArmor : 0,
            ts: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            decoys: decoyPayload,
          };
          sendEvent(posPayload).catch(() => { });
        }

        if (isSnowStage) updateSnowflakes(dt);

        // draw
        if (!ctx2d) { cancelAnimationFrame(raf); return; }
        const ctx = ctx2d; ctx.clearRect(0, 0, cvs.width, cvs.height);
        ctx.save();
        if (drawScale !== 1) {
          ctx.translate(cvs.width / 2, cvs.height / 2);
          ctx.scale(drawScale, drawScale);
          ctx.translate(-cvs.width / 2, -cvs.height / 2);
        }
        const camX = state.camera.x, camY = state.camera.y;
        if (stage.poison) {
          if (poisonPhaseAngles && poisonPhaseValues) {
            const basePhase = timeAlive * 0.8;
            for (let i = 0; i < poisonPhaseAngles.length; i++) {
              const wave = Math.sin(basePhase + poisonPhaseAngles[i]);
              poisonPhaseValues[i] = (wave + 1) * 0.5;
            }
          }
          const cell = poisonCellSize;
          const startX = Math.floor((camX - cvs.width / 2) / cell) - 1;
          const endX = Math.floor((camX + cvs.width / 2) / cell) + 1;
          const startY = Math.floor((camY - cvs.height / 2) / cell) - 1;
          const endY = Math.floor((camY + cvs.height / 2) / cell) + 1;
          for (let cx = startX; cx <= endX; cx++) {
            for (let cy = startY; cy <= endY; cy++) {
              const p = toScreen(cx * cell, cy * cell);
              if (isPoisonCell(cx, cy)) {
                drawPoisonTile(ctx, cell, cx, cy, p.x, p.y);
              } else {
                ctx.fillStyle = POISON_SAFE_COLOR;
                ctx.fillRect(p.x, p.y, cell, cell);
                const contamination = poisonNeighborIntensity(cx, cy);
                if (contamination > 0) {
                  ctx.save();
                  ctx.globalAlpha = 0.12 + contamination * 0.18;
                  ctx.fillStyle = '#5c2a7a';
                  ctx.fillRect(p.x, p.y, cell, cell);
                  ctx.restore();
                  ctx.save();
                  ctx.strokeStyle = `rgba(150, 90, 200, ${0.08 + contamination * 0.16})`;
                  ctx.lineWidth = 1;
                  ctx.strokeRect(p.x + 0.5, p.y + 0.5, cell - 1, cell - 1);
                  ctx.restore();
                }
              }
            }
          }
        } else if (stage.slippery && stage.slipperyFrac != null) {
          const cell = slipperyCellSize;
          const startX = Math.floor((camX - cvs.width / 2) / cell) - 1;
          const endX = Math.floor((camX + cvs.width / 2) / cell) + 1;
          const startY = Math.floor((camY - cvs.height / 2) / cell) - 1;
          const endY = Math.floor((camY + cvs.height / 2) / cell) + 1;
          for (let cx = startX; cx <= endX; cx++) {
            for (let cy = startY; cy <= endY; cy++) {
              const p = toScreen(cx * cell, cy * cell);
              ctx.fillStyle = isSlipperyCell(cx, cy) ? ICE_FLOOR_COLOR : NORMAL_FLOOR_COLOR;
              ctx.fillRect(p.x, p.y, cell, cell);
            }
          }
        } else {
          const bgColor =
            stageName === 'メロンパン広場' ? '#ffffdd' :
              stageName === 'メロンパン牧場' ? '#eafff3' :
                stageName === 'メロンパン氷山' ? ICE_FLOOR_COLOR :
                  null;
          if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, cvs.width, cvs.height); }
        }
        ctx.save();
        const SHOW_GRID = true;
        if (SHOW_GRID) {
          ctx.strokeStyle = stage.poison ? 'rgba(120, 80, 150, 0.35)' : '#eee6c9';
          ctx.lineWidth = 1;
          const grid = 40;
          const offsetX = ((-camX) % grid + grid) % grid;
          const offsetY = ((-camY) % grid + grid) % grid;
          for (let x = offsetX; x < cvs.width; x += grid) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, cvs.height);
            ctx.stroke();
          }
          for (let y = offsetY; y < cvs.height; y += grid) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(cvs.width, y);
            ctx.stroke();
          }
        }
        ctx.restore();
        const needsVolcanoShade = stage.type === 'volcano' || stageName === 'メロンパン工業地帯';
        if (needsVolcanoShade) {
          // Slightly darken the whole background for volcano atmosphere
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.fillRect(0, 0, cvs.width, cvs.height);
        }
        if (stage.type === 'volcano') {
          const lavaScreen = toScreen(lavaX, 0).x;
          const lavaLeft = lavaScreen < 0 ? lavaScreen : 0;
          const lavaWidth = Math.abs(lavaScreen);
          ctx.save();
          const lavaGrad = ctx.createLinearGradient(0, 0, 0, cvs.height);
          lavaGrad.addColorStop(0, '#5b0f1a');
          lavaGrad.addColorStop(0.3, '#c81d25');
          lavaGrad.addColorStop(0.65, '#ff6b3d');
          lavaGrad.addColorStop(1, '#ffd166');
          ctx.fillStyle = lavaGrad;
          ctx.fillRect(lavaLeft, 0, lavaWidth, cvs.height);

          const frontVisible = lavaScreen > -cvs.width && lavaScreen < cvs.width + 200;
          if (frontVisible) {
            const samples = Math.max(12, Math.ceil(cvs.height / 28));
            const step = cvs.height / samples;
            const waveAmp = 18;
            const waveFreq = 0.045;
            const waveSpeed = 2.3;
            const edgeStart = Math.max(lavaScreen - 160, lavaLeft);
            const edgeEnd = lavaScreen + 60;
            const edgeGrad = ctx.createLinearGradient(edgeStart, 0, edgeEnd, 0);
            edgeGrad.addColorStop(0, 'rgba(255, 120, 60, 0.25)');
            edgeGrad.addColorStop(0.55, 'rgba(255, 196, 120, 0.85)');
            edgeGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

            ctx.beginPath();
            ctx.moveTo(lavaScreen, 0);
            for (let i = 0; i <= samples; i++) {
              const y = Math.min(cvs.height, i * step);
              const wave = Math.sin(timeAlive * waveSpeed + y * waveFreq) * waveAmp;
              const ripple = Math.sin(timeAlive * 0.8 + y * 0.015) * (waveAmp * 0.4);
              ctx.lineTo(lavaScreen + wave + ripple, y);
            }
            ctx.lineTo(lavaLeft, cvs.height);
            ctx.lineTo(lavaLeft, 0);
            ctx.closePath();
            ctx.fillStyle = edgeGrad;
            ctx.fill();

            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.35;
            const glowWidth = 120;
            const glowX = lavaScreen - glowWidth;
            const glowGrad = ctx.createLinearGradient(glowX, 0, lavaScreen + 20, 0);
            glowGrad.addColorStop(0, 'rgba(255, 120, 60, 0)');
            glowGrad.addColorStop(0.6, 'rgba(255, 220, 160, 0.55)');
            glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = glowGrad;
            ctx.fillRect(glowX, 0, glowWidth + 20, cvs.height);

            ctx.globalAlpha = 0.18;
            ctx.fillStyle = '#ffeab6';
            const sparkSpacing = 52;
            const sparkOffset = (timeAlive * 35) % sparkSpacing;
            for (let y = -sparkSpacing; y < cvs.height + sparkSpacing; y += sparkSpacing) {
              const sparkY = y + sparkOffset;
              const sparkX = lavaScreen - 26 - Math.sin(timeAlive * 1.3 + y * 0.25) * 30;
              ctx.fillRect(sparkX, sparkY, 10, 24);
            }
          }
          ctx.restore();
        }
        if (stage.type === 'ranch') { const top = toScreen(0, -stage.halfHeight).y; const bot = toScreen(0, stage.halfHeight).y; ctx.strokeStyle = '#c7b08a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(cvs.width, top); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, bot); ctx.lineTo(cvs.width, bot); ctx.stroke(); }
        if (stage.type === 'maze') {
          const obs = getNearbyObstacles(camX, camY);
          if (stage.spikes) {
            const base = '#ff6b6b';
            const tip = '#ffe5e5';
            const step = 6;
            for (const r of obs) {
              const p = toScreen(r.x, r.y);
              ctx.fillStyle = base;
              ctx.fillRect(p.x, p.y, r.w, r.h);
              ctx.fillStyle = tip;
              for (let x = p.x; x < p.x + r.w; x += step) {
                ctx.beginPath();
                ctx.moveTo(x, p.y);
                ctx.lineTo(x + step / 2, p.y - step / 2);
                ctx.lineTo(x + step, p.y);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(x, p.y + r.h);
                ctx.lineTo(x + step / 2, p.y + r.h + step / 2);
                ctx.lineTo(x + step, p.y + r.h);
                ctx.fill();
              }
              for (let y = p.y; y < p.y + r.h; y += step) {
                ctx.beginPath();
                ctx.moveTo(p.x, y);
                ctx.lineTo(p.x - step / 2, y + step / 2);
                ctx.lineTo(p.x, y + step);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(p.x + r.w, y);
                ctx.lineTo(p.x + r.w + step / 2, y + step / 2);
                ctx.lineTo(p.x + r.w, y + step);
                ctx.fill();
              }
            }
          } else {
            ctx.fillStyle = '#d8c8a5';
            for (const r of obs) {
              const p = toScreen(r.x, r.y);
              ctx.fillRect(p.x, p.y, r.w, r.h);
            }
          }
        }
        if (stage.iceBlocks) {
          for (const b of iceBlocks) {
            const p = toScreen(b.x, b.y);
            ctx.fillStyle = '#a0d8ef';
            ctx.fillRect(p.x, p.y, b.w, b.h);
          }
        }
        if (stage.circular) {
          const c = toScreen(0, 0);
          ctx.strokeStyle = '#c7b0ff';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(c.x, c.y, stage.radius, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (stage.star) {
          ctx.strokeStyle = '#c7b0ff';
          ctx.lineWidth = 4;
          ctx.beginPath();
          const outer = stage.radius || 600;
          const inner = stage.innerRadius || outer * 0.5;
          const c = toScreen(0, 0);
          for (let i = 0; i < 10; i++) {
            const ang = -Math.PI / 2 + i * Math.PI / 5;
            const r = (i % 2 === 0) ? outer : inner;
            const p = toScreen(Math.cos(ang) * r, Math.sin(ang) * r);
            // Offset by center coordinates
            const px = c.x + Math.cos(ang) * r;
            const py = c.y + Math.sin(ang) * r;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
        if (stage.jumpPad) {
          ctx.save();
          const pads = getNearbyPads(player.x, player.y);
          const size = 32;
          ctx.font = '20px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (const pad of pads) {
            const p = toScreen(pad.x, pad.y);
            ctx.fillStyle = '#c0f0ff';
            ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size);
            ctx.fillStyle = '#333';
            ctx.fillText(pad.arrow, p.x, p.y);
          }
          ctx.restore();
        }

        if (charName === 'フルムーン') {
          if (fullmoonActive) {
            const center = getFullmoonTarget(fullmoonActive);
            const sp = toScreen(center.x, center.y);
            const lockRadius = fullmoonActive.lockRadius ?? (shield?.size ?? 50);
            const lockDur = fullmoonActive.lockDuration ?? 0;
            const chargeDur = fullmoonActive.chargeDuration ?? 0;
            const slamDur = fullmoonActive.slamDuration ?? 0;
            const safeCharge = chargeDur > 0 ? chargeDur : 0.0001;
            const safeSlam = slamDur > 0 ? slamDur : 0.0001;
            const chargeProgress = Math.min(1, Math.max(0, (fullmoonActive.elapsed - lockDur) / safeCharge));
            const slamProgress = Math.min(1, Math.max(0, (fullmoonActive.elapsed - lockDur - chargeDur) / safeSlam));
            const chargeEase = 1 - Math.pow(1 - chargeProgress, 3);
            const slamEase = 1 - Math.pow(1 - slamProgress, 3);
            const pulse = 1 + 0.1 * Math.sin(performance.now() / 140);
            if (fullmoonActive.phase === 'lockon' || fullmoonActive.phase === 'charge') {
              const r = lockRadius * (0.95 + 0.25 * chargeEase) * pulse;
              ctx.save();
              ctx.globalAlpha = 0.18 + 0.18 * chargeEase;
              ctx.fillStyle = 'rgba(254,240,138,0.35)';
              ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2); ctx.fill();
              ctx.globalAlpha = 0.65;
              ctx.strokeStyle = '#facc15';
              ctx.lineWidth = 3;
              ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2); ctx.stroke();
              ctx.lineWidth = 2;
              const cross = r * 0.55;
              ctx.beginPath();
              ctx.moveTo(sp.x - cross, sp.y); ctx.lineTo(sp.x + cross, sp.y);
              ctx.moveTo(sp.x, sp.y - cross); ctx.lineTo(sp.x, sp.y + cross);
              ctx.stroke();
              ctx.restore();
            } else if (fullmoonActive.phase === 'slam') {
              const slamRadius = (fullmoonActive.slamRadius ?? lockRadius * 1.4) * (1 - 0.25 * slamEase);
              ctx.save();
              ctx.globalAlpha = 0.25;
              const grad = ctx.createRadialGradient(sp.x, sp.y, slamRadius * 0.2, sp.x, sp.y, slamRadius);
              grad.addColorStop(0, 'rgba(226, 232, 255, 0.6)');
              grad.addColorStop(0.6, 'rgba(191, 219, 254, 0.28)');
              grad.addColorStop(1, 'rgba(191, 219, 254, 0)');
              ctx.fillStyle = grad;
              ctx.beginPath(); ctx.arc(sp.x, sp.y, slamRadius, 0, Math.PI * 2); ctx.fill();
              ctx.restore();
            }
          }
          if (fullmoonShockwaves.length) {
            for (const wave of fullmoonShockwaves) {
              const progress = Math.max(0, Math.min(1, wave.elapsed / Math.max(0.0001, wave.dur)));
              const radius = wave.baseRadius + (wave.maxRadius - wave.baseRadius) * progress;
              const scr = toScreen(wave.x, wave.y);
              ctx.save();
              ctx.globalAlpha = 0.4 * (1 - progress);
              ctx.strokeStyle = '#e0f2fe';
              ctx.lineWidth = 5;
              ctx.beginPath(); ctx.arc(scr.x, scr.y, radius, 0, Math.PI * 2); ctx.stroke();
              ctx.globalAlpha = 0.18 * (1 - progress);
              ctx.fillStyle = 'rgba(226, 232, 255, 0.25)';
              ctx.beginPath(); ctx.arc(scr.x, scr.y, radius * 0.55, 0, Math.PI * 2); ctx.fill();
              ctx.restore();
            }
          }
        }

        if (charName === 'フルムーン' && shield) {
          if (shield.hp > 0) {
            const active = fullmoonActive;
            const lockDur = active?.lockDuration ?? 0;
            const chargeDur = active?.chargeDuration ?? 0;
            const slamDur = active?.slamDuration ?? 0;
            const safeCharge = chargeDur > 0 ? chargeDur : 0.0001;
            const safeSlam = slamDur > 0 ? slamDur : 0.0001;
            const elapsed = active?.elapsed ?? 0;
            const chargeProgress = Math.min(1, Math.max(0, (elapsed - lockDur) / safeCharge));
            const slamProgress = Math.min(1, Math.max(0, (elapsed - lockDur - chargeDur) / safeSlam));
            const chargeEase = 1 - Math.pow(1 - chargeProgress, 3);
            const slamEase = 1 - Math.pow(1 - slamProgress, 3);
            let shieldScale = 1;
            if (active) {
              if (active.phase === 'lockon') shieldScale = 1;
              else if (active.phase === 'charge') shieldScale = 1 + 0.45 * chargeEase;
              else if (active.phase === 'slam') shieldScale = 1.45 - 0.3 * slamEase;
            }
            const drawSize = shield.size * shieldScale;
            const drawWidth = shield.w * (0.8 + 0.2 * shieldScale);
            const offset = shield.size + (drawSize - shield.size) * 0.5;
            const sx = player.x + shield.dirX * offset;
            const sy = player.y + shield.dirY * offset;
            const sp = toScreen(sx, sy);
            const ang = Math.atan2(shield.dirY, shield.dirX);
            ctx.save();
            ctx.translate(sp.x, sp.y);
            ctx.rotate(ang);
            const baseAlpha = active ? (active.phase === 'slam' ? 0.7 : 0.5 + 0.25 * chargeEase) : 0.4;
            ctx.globalAlpha = baseAlpha;
            ctx.fillStyle = '#e0f2fe';
            ctx.fillRect(-drawWidth / 2, -drawSize, drawWidth, drawSize * 2);
            if (active) {
              ctx.globalAlpha = Math.min(0.6, 0.35 + 0.35 * chargeEase);
              const innerW = drawWidth * 0.6;
              const innerH = drawSize * 1.6;
              ctx.fillStyle = 'rgba(191,219,254,0.35)';
              ctx.fillRect(-innerW / 2, -innerH / 2, innerW, innerH);
            }
            ctx.globalAlpha = 1;
            ctx.strokeStyle = active ? '#bfdbfe' : '#bae6fd';
            ctx.lineWidth = active ? 3 : 2;
            ctx.strokeRect(-drawWidth / 2, -drawSize, drawWidth, drawSize * 2);
            ctx.restore();
            (function drawHpBar(x, y, r, hp, maxHp) {
              const w = 40, h = 4, pad = 12;
              const ratio = Math.max(0, Math.min(1, (maxHp > 0 ? hp / maxHp : 0)));
              ctx.save();
              ctx.translate(x, y - r - pad);
              ctx.fillStyle = '#000a';
              ctx.fillRect(-w / 2, -h / 2, w, h);
              ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
              ctx.fillRect(-w / 2, -h / 2, w * ratio, h);
              ctx.strokeStyle = '#ffffffaa';
              ctx.lineWidth = 1;
              ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
              ctx.restore();
            })(sp.x, sp.y, drawSize, shield.hp, shield.maxHp);
          } else if (shield.cd > 0) {
            const pp = toScreen(player.x, player.y);
            (function drawCdBar(x, y, r, cd, maxCd) {
              const w = 40, h = 4, pad = 22;
              const ratio = Math.max(0, Math.min(1, maxCd > 0 ? cd / maxCd : 0));
              ctx.save();
              ctx.translate(x, y - r - pad);
              ctx.fillStyle = '#000a';
              ctx.fillRect(-w / 2, -h / 2, w, h);
              ctx.fillStyle = '#60a5fa';
              ctx.fillRect(-w / 2, -h / 2, w * ratio, h);
              ctx.strokeStyle = '#ffffffaa';
              ctx.lineWidth = 1;
              ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
              ctx.restore();
            })(pp.x, pp.y, player.r, shield.cd, cfg.fullmoon.regen);
          }
        }

        const pPos = toScreen(player.x, player.y);
        // Draw player: use 'U' images when character is U, otherwise fallback to circle
        if (charName === 'U') {
          // Determine facing from current input (pressed keys). Keep lastFacing when idle.
          let facing = lastFacing;
          if (pressed.has('ArrowLeft') || pressed.has('a')) facing = 'left';
          else if (pressed.has('ArrowRight') || pressed.has('d')) facing = 'right';
          else if (pressed.has('ArrowUp') || pressed.has('w')) facing = 'up';
          else if (pressed.has('ArrowDown') || pressed.has('s')) facing = 'down';
          lastFacing = facing;
          const img = uImgs && uImgs[facing];
          if (img && img.complete && img.naturalWidth && img.naturalHeight) {
            // Images are vertical: use image aspect ratio and target height based on player.r
            const targetH = player.r * 4; // adjust visible character height
            const ar = img.naturalWidth / img.naturalHeight;
            const w = targetH * ar;
            const h = targetH;
            try { ctx.drawImage(img, pPos.x - w / 2, pPos.y - h / 2, w, h); } catch { /* ignore drawing errors */ }
          } else {
            // fallback: simple circle
            ctx.fillStyle = '#1f6feb'; ctx.beginPath(); ctx.arc(pPos.x, pPos.y, player.r, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          // For non-U characters, prefer facing-specific images when available
          let facing = lastFacing;
          if (pressed.has('ArrowLeft') || pressed.has('a')) facing = 'left';
          else if (pressed.has('ArrowRight') || pressed.has('d')) facing = 'right';
          else if (pressed.has('ArrowUp') || pressed.has('w')) facing = 'up';
          else if (pressed.has('ArrowDown') || pressed.has('s')) facing = 'down';
          lastFacing = facing;
          const fimg = getFacingCharImg(charName, facing);
          if (fimg && fimg.complete && fimg.naturalWidth && fimg.naturalHeight) {
            const targetH = player.r * 4;
            const ar = fimg.naturalWidth / fimg.naturalHeight;
            const w = targetH * ar;
            const h = targetH;
            try { ctx.drawImage(fimg, pPos.x - w / 2, pPos.y - h / 2, w, h); } catch { ctx.fillStyle = '#1f6feb'; ctx.beginPath(); ctx.arc(pPos.x, pPos.y, player.r, 0, Math.PI * 2); ctx.fill(); }
          } else {
            ctx.fillStyle = '#1f6feb'; ctx.beginPath(); ctx.arc(pPos.x, pPos.y, player.r, 0, Math.PI * 2); ctx.fill();
          }
        }
        // アクティブウェポン発動中は虹色のオーラを描画
        if (state._activeTtl > 0) {
          const pulse = 1 + 0.1 * Math.sin(uPulse * 8);
          ctx.save();
          ctx.globalAlpha = 0.7;
          for (let i = 0; i < 6; i++) {
            ctx.strokeStyle = `hsl(${i * 60}, 100%, 60%)`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(pPos.x, pPos.y, player.r + 8 + i * 4 * pulse, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        // 復活無敵オーラの描画（パルス）
        if (invulnT > 0) {
          const ratio = Math.max(0, Math.min(1, invulnT / invulnMax));
          const pulse = 1 + 0.08 * Math.sin(uPulse * 10);
          ctx.save();
          ctx.globalAlpha = 0.35 + 0.35 * ratio;
          ctx.strokeStyle = 'rgba(80,220,150,0.9)';
          ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(pPos.x, pPos.y, player.r + 6 + 10 * pulse, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(pPos.x, pPos.y, player.r + 16 + 20 * pulse, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }

        (function drawBars(x, y, r, hp, maxHp, armor, maxArmor) {
          const w = 32, h = 4, pad = 12;
          const ratio = Math.max(0, Math.min(1, (maxHp > 0 ? hp / maxHp : 0)));
          ctx.save();
          ctx.translate(x, y - r - pad);
          ctx.fillStyle = '#000a';
          ctx.fillRect(-w / 2, -h / 2, w, h);
          ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
          ctx.fillRect(-w / 2, -h / 2, w * ratio, h);
          ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1;
          ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
          ctx.restore();
          if (state.armorUnlocked && maxArmor > 0) {
            const arRatio = Math.max(0, Math.min(1, armor / maxArmor));
            const pad2 = pad + h + 2;
            ctx.save();
            ctx.translate(x, y - r - pad2);
            ctx.fillStyle = '#000a';
            ctx.fillRect(-w / 2, -h / 2, w, h);
            ctx.fillStyle = '#60a5fa';
            ctx.fillRect(-w / 2, -h / 2, w * arRatio, h);
            ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1;
            ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
            ctx.restore();
          }
        })(pPos.x, pPos.y, player.r, state.stats.hp, state.stats.maxHp, state.stats.armor, state.stats.maxArmor);

        // 自分にも固有攻撃の可視演出を表示
        if (state.stats.alive) {
          if (charName === 'ナタリア') {
            const range = cfg.nata.leftRange || 40;
            const halfH = (cfg.nata.leftHeight || 60) * 0.5;
            ctx.save();
            ctx.translate(pPos.x, pPos.y);
            // 左側ダメージゾーン
            ctx.fillStyle = 'rgba(240,80,120,0.25)';
            ctx.strokeStyle = 'rgba(240,80,120,0.6)';
            ctx.lineWidth = 2;
            ctx.fillRect(-range, -halfH, range, halfH * 2);
            ctx.strokeRect(-range, -halfH, range, halfH * 2);
            // EXスキル: 回復範囲を表示
            if (state.perks.ex) {
              const healR = cfg.nata.healRange;
              ctx.beginPath();
              ctx.fillStyle = 'rgba(80,200,120,0.15)';
              ctx.strokeStyle = 'rgba(80,200,120,0.4)';
              ctx.arc(0, 0, healR, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            }
            ctx.restore();
          }
          if (charName === 'ハクシキ') {
            ctx.save();
            ctx.strokeStyle = 'rgba(100,200,255,0.35)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pPos.x, pPos.y, cfg.haku.radius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
          if (charName === 'あたち') {
            ctx.save();
            ctx.translate(pPos.x, pPos.y);
            const beams = state.perks.ex ? [beamAng, beamAng + Math.PI] : [beamAng];
            for (const ang of beams) {
              ctx.save();
              ctx.rotate(ang);
              ctx.strokeStyle = '#ff99dd';
              ctx.lineWidth = 5;
              ctx.beginPath();
              ctx.moveTo(0, 0);
              ctx.lineTo(cfg.atc.radius, 0);
              ctx.stroke();
              ctx.restore();
            }
            ctx.restore();
          }
          if (charName === 'U') {
            // 一定間隔で右方向に短いビームラインを出す（見た目用）
            selfUTimer -= dt;
            if (selfUTimer <= 0) {
              selfUTimer = 0.4;
              selfLines.push({ x1: player.x, y1: player.y, x2: player.x + 80, y2: player.y, ttl: 0.18, w: 4, col: '#7aa2ff' });
            }
          }
          if (charName === 'メロ') {
            if (sniperTargets.length && sniperTimer > 0) {
              for (const t of sniperTargets) {
                const sp = toScreen(t.x, t.y);
                ctx.save();
                ctx.strokeStyle = '#ff7f7f';
                ctx.lineWidth = 2;
                const s = 12;
                ctx.beginPath(); ctx.moveTo(sp.x - s, sp.y); ctx.lineTo(sp.x + s, sp.y);
                ctx.moveTo(sp.x, sp.y - s); ctx.lineTo(sp.x, sp.y + s);
                ctx.stroke();
                ctx.restore();
              }
            }
          }
          if (supportBooks.length > 0) {
            for (const book of supportBooks) {
              const sp = toScreen(book.x, book.y);
              ctx.save();
              ctx.translate(sp.x, sp.y);
              ctx.rotate((book.angle ?? 0) + Math.PI / 2);
              const size = SUPPORT_BOOK_DRAW_SIZE;
              if (supportBookImg.complete && supportBookImg.naturalWidth > 0 && supportBookImg.naturalHeight > 0) {
                ctx.drawImage(supportBookImg, -size / 2, -size / 2, size, size);
              } else {
                ctx.fillStyle = '#f97316';
                ctx.beginPath();
                ctx.arc(0, 0, SUPPORT_BOOK_COLLISION_RADIUS, 0, Math.PI * 2);
                ctx.fill();
              }
              ctx.restore();
            }
          }
        }
        // 自キャラ用ラインFXの更新＆描画
        for (let i = selfLines.length - 1; i >= 0; i--) {
          const L = selfLines[i];
          L.ttl -= dt;
          const alpha = Math.max(0, Math.min(1, L.ttl / 0.18));
          const p1 = toScreen(L.x1, L.y1), p2 = toScreen(L.x2, L.y2);
          ctx.save();
          ctx.strokeStyle = L.col;
          ctx.globalAlpha = 0.6 * alpha;
          ctx.lineWidth = L.w || 2;
          ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
          ctx.restore();
          if (L.ttl <= 0) selfLines.splice(i, 1);
        }

        const nowMs = performance.now(); const cx = cvs.width / 2, cy = cvs.height / 2;
        const displayScale = (() => {
          if (!cvs) return 1;
          const cssWidth = cvs.clientWidth || 0;
          const cssHeight = cvs.clientHeight || 0;
          const scaleX = cssWidth > 0 ? cvs.width / cssWidth : 1;
          const scaleY = cssHeight > 0 ? cvs.height / cssHeight : 1;
          const scale = Math.max(scaleX, scaleY);
          return Number.isFinite(scale) && scale > 0 ? Math.max(1, scale) : 1;
        })();
        const computeArrowScale = () => {
          const viewWidth = drawScale > 0 ? cvs.width / drawScale : cvs.width;
          const viewHeight = drawScale > 0 ? cvs.height / drawScale : cvs.height;
          const minDim = Math.min(viewWidth, viewHeight);
          const sizeFactor = Math.max(1, Math.min(1.4, minDim / 360));
          return sizeFactor * (state.isMobile ? 1.3 : 1) * displayScale;
        };
        const getArrowMargin = () => {
          const scale = computeArrowScale();
          return Math.max(24, Math.round(20 * scale));
        };
        const drawBombSprite = (sp, radius) => {
          if (bombImg.complete && bombImg.naturalWidth > 0 && bombImg.naturalHeight > 0) {
            const targetHeight = Math.max(1, radius * 2);
            const aspect = bombImg.naturalWidth / bombImg.naturalHeight;
            const width = targetHeight * aspect;
            const height = targetHeight;
            try {
              ctx.drawImage(bombImg, sp.x - width / 2, sp.y - height / 2, width, height);
              return;
            } catch {
              // 失敗時はフォールバック描画へ
            }
          }
          ctx.fillStyle = '#555';
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
          ctx.fill();
        };
        const drawBatSprite = (sp, radius, angle = 0) => {
          if (batImg.complete && batImg.naturalWidth > 0 && batImg.naturalHeight > 0) {
            const targetHeight = Math.max(1, radius * 2);
            const aspect = batImg.naturalWidth / batImg.naturalHeight;
            const width = targetHeight * aspect;
            const height = targetHeight;
            const rot = Number.isFinite(angle) ? angle : 0;
            ctx.save();
            try {
              ctx.translate(sp.x, sp.y);
              ctx.rotate(rot);
              ctx.drawImage(batImg, -width / 2, -height / 2, width, height);
              ctx.restore();
              return;
            } catch {
              ctx.restore();
            }
          }
          ctx.fillStyle = '#8b5cf6';
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
          ctx.fill();
        };
        function drawArrow(px, py, angle, color, name) {
          const scale = computeArrowScale();
          const arrowLength = 10 * scale;
          const arrowHalfWidth = 6 * scale;
          const labelOffsetX = 8 * scale;
          const labelOffsetY = -8 * scale;
          const strokeWidth = Math.max(2, Math.round(2 * scale * 0.75));
          const labelStrokeWidth = Math.max(3, Math.round(3 * scale * 0.6));
          const fontSize = Math.max(12, Math.round(12 * scale * 0.95));
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(angle);
          ctx.fillStyle = color;
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = strokeWidth;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(-arrowLength, arrowHalfWidth);
          ctx.lineTo(-arrowLength, -arrowHalfWidth);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.rotate(-angle);
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.lineWidth = labelStrokeWidth;
          ctx.strokeStyle = '#000a';
          ctx.fillStyle = '#fff';
          ctx.strokeText(name, labelOffsetX, labelOffsetY);
          ctx.fillText(name, labelOffsetX, labelOffsetY);
          ctx.restore();
        }
        for (const [pid, a] of Object.entries(state.allies)) {
          if (!a) continue; const staleMs = nowMs - (a.t || 0); const isStale = a.alive && staleMs > 3000; const k = 1 - Math.pow(0.001, dt); a.sx = (a.sx ?? a.x) + (a.x - (a.sx ?? a.x)) * k; a.sy = (a.sy ?? a.y) + (a.y - (a.sy ?? a.y)) * k; const s = toScreen(a.sx ?? a.x, a.sy ?? a.y); const color = a.alive ? '#22d3ee' : '#9ca3af'; const name = a.name || 'ALLY'; const onScreen = s.x >= 0 && s.x <= cvs.width && s.y >= 0 && s.y <= cvs.height;
          if (onScreen) {
            ctx.save(); if (isStale) ctx.globalAlpha = 0.6; const meb = allyFx[pid] || (allyFx[pid] = { shootTimer: Math.random() * 0.5, beamAng: Math.random() * Math.PI * 2, batTimer: 0.6 + Math.random() * 0.6, uTimer: 0.2, bombTimer: cfg.koi.interval, projectiles: [], bombs: [], lines: [], sniperTimer: 0, sniperTargets: [] }); const member = state.room?.members.find(m => m.id === pid); const cName = normalizeCharacterSelection(member?.character) ?? defaultPlayableCharacter; const worldX = a.sx ?? a.x, worldY = a.sy ?? a.y; const scr = s;
            const nearestEnemy = () => { let best = null, bd = 1e9; for (const e of enemies) { if (!e.alive) continue; const d = Math.hypot(e.x - worldX, e.y - worldY); if (d < bd) { bd = d; best = e; } } return best; };
            const nearestEnemies = (count = 2) => { const arr = []; for (const e of enemies) { if (!e.alive) continue; const d = Math.hypot(e.x - worldX, e.y - worldY); arr.push({ e, d }); } arr.sort((a, b) => a.d - b.d); return arr.slice(0, count).map(o => o.e); };
            if (a.alive) {
              // 生存中のみエフェクトを生成
              meb.shootTimer -= dt; meb.batTimer -= dt; meb.uTimer -= dt; meb.beamAng = (meb.beamAng + 2.2 * dt) % (Math.PI * 2);
              if (cName === 'ナタリア') {
                const range = cfg.nata.leftRange || 40;
                const halfH = (cfg.nata.leftHeight || 60) * 0.5;
                ctx.save();
                ctx.translate(scr.x, scr.y);
                ctx.fillStyle = 'rgba(240,80,120,0.25)';
                ctx.strokeStyle = 'rgba(240,80,120,0.6)';
                ctx.lineWidth = 2;
                ctx.fillRect(-range, -halfH, range, halfH * 2);
                ctx.strokeRect(-range, -halfH, range, halfH * 2);
                const healR = cfg.nata.healRange;
                ctx.beginPath();
                ctx.fillStyle = 'rgba(80,200,120,0.15)';
                ctx.strokeStyle = 'rgba(80,200,120,0.4)';
                ctx.arc(0, 0, healR, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
              }
              if (cName === 'ハクシキ') { ctx.save(); ctx.strokeStyle = 'rgba(100,200,255,0.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(scr.x, scr.y, 70, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
              if (cName === 'あたち') { ctx.save(); ctx.translate(scr.x, scr.y); ctx.rotate(meb.beamAng); ctx.strokeStyle = '#ff99dd'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(110, 0); ctx.stroke(); ctx.restore(); }
              if (cName === 'U') { if (meb.uTimer <= 0) { meb.uTimer = 0.4; meb.lines.push({ x1: worldX, y1: worldY, x2: worldX + 80, y2: worldY, ttl: 0.18, w: 4, col: '#7aa2ff' }); } }
              if (cName === 'メロ') {
                meb.sniperTargets = meb.sniperTargets.filter(t => t.alive);
                if (meb.sniperTargets.length < 2) {
                  const hadTargets = meb.sniperTargets.length > 0;
                  meb.sniperTargets = nearestEnemies();
                  if (meb.sniperTargets.length > 0) {
                    meb.sniperTimer = cfg.mero.charge;
                    if (!hadTargets) try { Audio?.playSfx?.(state, 'sniperAim'); } catch { }
                  }
                } else {
                  meb.sniperTimer -= dt;
                  if (meb.sniperTimer <= 0) {
                    for (const t of meb.sniperTargets) {
                      meb.lines.push({ x1: worldX, y1: worldY, x2: t.x, y2: t.y, ttl: 0.12, w: 2, col: '#ffdf5c' });
                    }
                    try { Audio?.playSfx?.(state, 'sniperShot'); } catch { }
                    meb.sniperTargets = [];
                  }
                }
                if (meb.sniperTargets.length) {
                  for (const t of meb.sniperTargets) {
                    const spT = toScreen(t.x, t.y);
                    ctx.save();
                    ctx.strokeStyle = '#ff7f7f';
                    ctx.lineWidth = 2;
                    const s = 10;
                    ctx.beginPath(); ctx.moveTo(spT.x - s, spT.y); ctx.lineTo(spT.x + s, spT.y);
                    ctx.moveTo(spT.x, spT.y - s); ctx.lineTo(spT.x, spT.y + s);
                    ctx.stroke();
                    ctx.restore();
                  }
                }
              }
              if (cName === 'おきーぱー') { if (meb.batTimer <= 0) { meb.batTimer = 1.2; meb.projectiles.push({ x: worldX, y: worldY, r: 9, spd: 260, ttl: 1 }); } }
              if (cName === '恋恋') { if (meb.bombTimer <= 0) { meb.bombTimer = cfg.koi.interval; meb.bombs.push({ x: worldX, y: worldY, vx: 0, vy: 0, air: 0, fuse: cfg.koi.fuse }); } }
              const fireIntervalAlly = 1.0; if (meb.shootTimer <= 0) { meb.shootTimer = fireIntervalAlly; const tgt = nearestEnemy(); if (tgt) meb.lines.push({ x1: worldX, y1: worldY, x2: tgt.x, y2: tgt.y, ttl: 0.12, w: 2, col: '#ffee99' }); }
            } else {
              // 死亡中はエフェクトを停止・即時クリア
              meb.projectiles.length = 0;
              meb.lines.length = 0;
              meb.bombs.length = 0;
            }
            for (let i = meb.projectiles.length - 1; i >= 0; i--) {
              const p = meb.projectiles[i];
              p.ttl -= dt;
              if (p.ttl <= 0) { meb.projectiles.splice(i, 1); continue; }
              const tgt = nearestEnemy();
              if (tgt) {
                const dx = tgt.x - p.x, dy = tgt.y - p.y; const d = Math.hypot(dx, dy) || 1;
                const ux = dx / d, uy = dy / d;
                p.x += ux * p.spd * dt; p.y += uy * p.spd * dt;
                p.ang = Math.atan2(uy, ux);
              } else {
                p.x += p.spd * dt;
                if (!Number.isFinite(p.ang)) p.ang = 0;
              }
              const sp2 = toScreen(p.x, p.y);
              const angle = Number.isFinite(p.ang) ? p.ang : 0;
              drawBatSprite(sp2, p.r, angle);
            }
            for (let i = meb.bombs.length - 1; i >= 0; i--) {
              const b = meb.bombs[i];
              if (b.air > 0) {
                b.air -= dt; b.x += b.vx * dt; b.y += b.vy * dt;
                if (b.air <= 0) { b.vx = 0; b.vy = 0; }
              } else {
                b.fuse -= dt;
                if (b.fuse <= 0) {
                  const sp2 = toScreen(b.x, b.y);
                  ctx.fillStyle = 'rgba(255,96,96,0.5)';
                  ctx.beginPath(); ctx.arc(sp2.x, sp2.y, cfg.koi.radius, 0, Math.PI * 2); ctx.fill();
                  try { Audio?.playSfx?.(state, 'bomb'); } catch { }
                  meb.bombs.splice(i, 1);
                  continue;
                }
              }
              const sp2 = toScreen(b.x, b.y);
              drawBombSprite(sp2, 6);
            }
            for (let i = meb.lines.length - 1; i >= 0; i--) { const L = meb.lines[i]; L.ttl -= dt; const apha = Math.max(0, Math.min(1, L.ttl / 0.18)); const p1 = toScreen(L.x1, L.y1), p2 = toScreen(L.x2, L.y2); ctx.save(); ctx.strokeStyle = L.col; ctx.globalAlpha = 0.6 * apha; ctx.lineWidth = L.w || 2; ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke(); ctx.restore(); if (L.ttl <= 0) meb.lines.splice(i, 1); }
            const size = (a.r ?? 10) * 4;
            const img = getCharImg(a.character);
            let drewImg = false;
            if (img && img.complete && img.naturalWidth && img.naturalHeight) {
              try { ctx.drawImage(img, s.x - size / 2, s.y - size / 2, size, size); drewImg = true; } catch { }
            }
            if (!drewImg) {
              ctx.beginPath(); ctx.fillStyle = color; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            }
            if (!a.alive) { ctx.save(); ctx.font = '12px sans-serif'; ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('☠', s.x, s.y + 1); ctx.restore(); }
            if (a.alive && typeof a.hp === 'number' && typeof a.maxHp === 'number' && a.maxHp > 0) {
              const w = 28, h = 4, pad = 12; const ratio = Math.max(0, Math.min(1, a.hp / a.maxHp));
              ctx.save(); ctx.translate(s.x, s.y - (drewImg ? size / 2 : 8) - pad); ctx.fillStyle = '#000a'; ctx.fillRect(-w / 2, -h / 2, w, h);
              ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444'; ctx.fillRect(-w / 2, -h / 2, w * ratio, h);
              ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1; ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1); ctx.restore();
            }
            if (a.alive && typeof a.maxArmor === 'number' && a.maxArmor > 0) {
              const w = 28, h = 4, pad = 12;
              const arRatio = Math.max(0, Math.min(1, (a.armor || 0) / a.maxArmor));
              const baseY = s.y - (drewImg ? size / 2 : 8);
              const apad = pad + h + 2;
              ctx.save(); ctx.translate(s.x, baseY - apad); ctx.fillStyle = '#000a'; ctx.fillRect(-w / 2, -h / 2, w, h);
              ctx.fillStyle = '#60a5fa'; ctx.fillRect(-w / 2, -h / 2, w * arRatio, h);
              ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1; ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1); ctx.restore();
            }
            ctx.font = '12px sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#000a'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; const labelY = s.y - (drewImg ? size / 2 : 8) - 2; ctx.strokeText(name, s.x + 12, labelY); ctx.fillText(name, s.x + 12, labelY); ctx.restore();
          } else {
            const dx = s.x - cx, dy = s.y - cy; const ang = Math.atan2(dy, dx); const m = getArrowMargin(); const rx = (cvs.width / 2 - m) / Math.max(0.0001, Math.abs(Math.cos(ang))); const ry = (cvs.height / 2 - m) / Math.max(0.0001, Math.abs(Math.sin(ang))); const t = Math.min(rx, ry); const px = cx + Math.cos(ang) * t; const py = cy + Math.sin(ang) * t; ctx.save(); if (isStale) ctx.globalAlpha = 0.6; drawArrow(px, py, ang, color, name); ctx.restore();
          }
        }

        const boss = enemies.find(e => e.boss && e.alive);
        if (boss) {
          const bs = toScreen(boss.x, boss.y);
          const onScreenB = bs.x >= 0 && bs.x <= cvs.width && bs.y >= 0 && bs.y <= cvs.height;
          if (!onScreenB) {
            const dx = bs.x - cx, dy = bs.y - cy;
            const ang = Math.atan2(dy, dx);
            const m = getArrowMargin();
            const rx = (cvs.width / 2 - m) / Math.max(0.0001, Math.abs(Math.cos(ang)));
            const ry = (cvs.height / 2 - m) / Math.max(0.0001, Math.abs(Math.sin(ang)));
            const t = Math.min(rx, ry);
            const px = cx + Math.cos(ang) * t;
            const py = cy + Math.sin(ang) * t;
            drawArrow(px, py, ang, '#f87171', 'BOSS');
          }
        }
        if (rewardArea) {
          const rs = toScreen(rewardArea.x, rewardArea.y);
          const onScreenR = rs.x >= 0 && rs.x <= cvs.width && rs.y >= 0 && rs.y <= cvs.height;
          if (!onScreenR) {
            const dx = rs.x - cx, dy = rs.y - cy;
            const ang = Math.atan2(dy, dx);
            const m = getArrowMargin();
            const rx = (cvs.width / 2 - m) / Math.max(0.0001, Math.abs(Math.cos(ang)));
            const ry = (cvs.height / 2 - m) / Math.max(0.0001, Math.abs(Math.sin(ang)));
            const t = Math.min(rx, ry);
            const px = cx + Math.cos(ang) * t;
            const py = cy + Math.sin(ang) * t;
            drawArrow(px, py, ang, '#facc15', '報酬');
          }
        }
        if (riskChoiceAreas && riskChoiceAreas.length > 0) {
          for (const area of riskChoiceAreas) {
            if (!area) continue;
            const rs = toScreen(area.x, area.y);
            const onScreenR = rs.x >= 0 && rs.x <= cvs.width && rs.y >= 0 && rs.y <= cvs.height;
            if (onScreenR) continue;
            const dx = rs.x - cx, dy = rs.y - cy;
            const ang = Math.atan2(dy, dx);
            const m = getArrowMargin();
            const rx = (cvs.width / 2 - m) / Math.max(0.0001, Math.abs(Math.cos(ang)));
            const ry = (cvs.height / 2 - m) / Math.max(0.0001, Math.abs(Math.sin(ang)));
            const t = Math.min(rx, ry);
            const px = cx + Math.cos(ang) * t;
            const py = cy + Math.sin(ang) * t;
            let label = '経験値';
            let color = '#60a5fa';
            if (area.type === 'melon') {
              label = 'メロンパン';
              color = '#34d399';
            } else if (area.type === 'money') {
              label = 'マネー';
              color = '#f59e0b';
            }
            drawArrow(px, py, ang, color, label);
          }
        }

        // Limit decoy targeting to nearby enemies for performance
        const DECOY_SEARCH_RADIUS = 300; // pixels, adjust as needed
        const DECOY_SEARCH_RADIUS_SQ = DECOY_SEARCH_RADIUS * DECOY_SEARCH_RADIUS;
        if (decoys.length) {
          const elemStage = getPlayerElementStage(state.stats.elem);
          for (let i = decoys.length - 1; i >= 0; i--) {
            const d = decoys[i];
            let target = null, best = 1e9;
            for (const e of enemies) {
              if (!e.alive) continue;
              const dx = e.x - d.x, dy = e.y - d.y;
              const distSq = dx * dx + dy * dy;
              if (distSq > DECOY_SEARCH_RADIUS_SQ) continue;
              const dist = Math.sqrt(distSq);
              if (dist < best) { best = dist; target = e; }
            }
            if (target) {
              const dx = target.x - d.x, dy = target.y - d.y; const dist = Math.hypot(dx, dy) || 1;
              if (dist < target.r + 8) {
                let dealt = cfg.ando.dmg * dt;
                dealt = applyElementalMultiplier(dealt, state.stats.elem, target.elem, elemStage);
                dealt = applyBossBonus(dealt, target);
                if (isAndoPriorityTarget(target)) dealt *= 1.2;
                const mul = target.dmgTakenMul ?? 1;
                if (serverSim) { queueHit(target.id, dealt, dealt * mul); accumServerDamage(target.id, dealt * mul, target.x, target.y); }
                else { const actual = dealt * mul; target.hp -= actual; accumEnemyDamage(target, actual); if (target.hp <= 0 && target.alive) { pushKill(target); } }
                d.hp -= 5 * dt;
              } else {
                d.x += (dx / dist) * cfg.ando.spd * dt;
                d.y += (dy / dist) * cfg.ando.spd * dt;
              }
            }
            const sp = toScreen(d.x, d.y);
            ctx.save();
            if (decoyImg.complete && decoyImg.naturalWidth > 0) {
              const targetH = player.r * 4;
              const ar = decoyImg.naturalWidth / decoyImg.naturalHeight;
              const w = targetH * ar;
              const h = targetH;
              ctx.drawImage(decoyImg, sp.x - w / 2, sp.y - h / 2, w, h);
            } else {
              ctx.fillStyle = '#888';
              ctx.beginPath(); ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2); ctx.fill();
            }
            const ratio = Math.max(0, Math.min(1, d.hp / d.maxHp));
            ctx.fillStyle = '#000a'; ctx.fillRect(sp.x - 10, sp.y - 14, 20, 4);
            ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
            ctx.fillRect(sp.x - 10, sp.y - 14, 20 * ratio, 4);
            ctx.restore();
            if (d.hp <= 0) {
              if (state.perks.ex) {
                const bombDmg = cfg.koi?.dmg ?? cfg.ando.dmg;
                let bombRadius = Number.isFinite(cfg.ando?.exRadius) ? cfg.ando.exRadius : null;
                if (!Number.isFinite(bombRadius)) {
                  const baseRadius = Number.isFinite(cfg.koi?.radius) ? cfg.koi.radius : 16;
                  const radiusMul = Number.isFinite(cfg.ando?.exRadiusMul) ? cfg.ando.exRadiusMul : 1;
                  bombRadius = Math.max(0, baseRadius * radiusMul);
                }
                const bombKnockback = Number.isFinite(cfg.ando?.exKnockback)
                  ? cfg.ando.exKnockback
                  : (cfg.koi?.knockback ?? 0);
                const fireTime = Number.isFinite(cfg.ando?.exFireTime)
                  ? cfg.ando.exFireTime
                  : (cfg.koi?.fireTime ?? 0);
                const fireDps = Number.isFinite(cfg.ando?.exFireDps)
                  ? cfg.ando.exFireDps
                  : (cfg.koi?.fireDps ?? 0);
                projectiles.push({
                  type: 'bomb',
                  x: d.x,
                  y: d.y,
                  vx: 0,
                  vy: 0,
                  r: 6,
                  dmg: bombDmg,
                  air: 0,
                  fuse: 0,
                  radius: bombRadius,
                  knockback: bombKnockback,
                  fireTime,
                  fireDps,
                });
              }
              decoys.splice(i, 1);
              continue;
            }
          }
        }
        if (projectiles.length) {
          for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            if (p.type === 'bat') {
              p.ttl -= dt; if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              let best = null, bd = 1e9;
              for (const e of enemies) {
                if (!e.alive) continue;
                if (p.hit && p.hit.includes(e)) continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (d < bd) { bd = d; best = e; }
              }
              if (best) {
                const dx = best.x - p.x, dy = best.y - p.y; const d = Math.hypot(dx, dy) || 1;
                const ux = dx / d, uy = dy / d;
                p.x += ux * p.spd * dt; p.y += uy * p.spd * dt;
                p.ang = Math.atan2(uy, ux);
                if (d < p.r + best.r + 2) {
                  const atkElem = p.elem || state.stats.elem;
                  const atkStage = getPlayerElementStage(atkElem);
                  let dmg = applyElementalMultiplier(p.dmg, atkElem, best.elem, atkStage);
                  if (!best.elem && atkElem && best.boss) {
                    const tbl = bossElemBonus[best.name] || bossElemBonus['default'];
                    dmg *= (tbl[atkElem] || 1.1);
                  }
                  dmg = applyBossBonus(dmg, best);
                  if (best.boss && state._activeCharacterName === 'おきーぱー' && state?.perks?.ex) {
                    const diffName = state.room?.difficulty || 'ふつう';
                    const bossMul = okpExBossDamageMultipliers[diffName];
                    if (Number.isFinite(bossMul)) dmg *= bossMul;
                  }
                  dmg = Math.round(dmg);
                  const mul = best.dmgTakenMul ?? 1;
                  if (serverSim) {
                    queueHit(best.id, dmg, dmg * mul);
                    accumServerDamage(best.id, dmg * mul, best.x, best.y);
                  } else {
                    const actual = dmg * mul;
                    best.hp -= actual;
                    spawnDamageNumber(best.x, best.y, '-' + Math.round(actual));
                    if (best.hp <= 0 && best.alive) { best.alive = false; kills++; pushOrb({ x: best.x, y: best.y, r: 4, value: 1 + Math.floor(timeAlive / 20) }); }
                  }
                  if (p.pierce) { p.hit = p.hit || []; p.hit.push(best); }
                  else { projectiles.splice(i, 1); continue; }
                }
              } else { p.x += p.spd * dt; if (!Number.isFinite(p.ang)) p.ang = 0; }
              const sp2 = toScreen(p.x, p.y);
              const angle = Number.isFinite(p.ang) ? p.ang : 0;
              drawBatSprite(sp2, p.r, angle);
            }
            else if (p.type === 'bomb') {
              if (p.air > 0) {
                p.air -= dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                if (p.air <= 0) { p.vx = 0; p.vy = 0; }
              } else {
                p.fuse -= dt;
                if (p.fuse <= 0) {
                  const sp2 = toScreen(p.x, p.y);
                  ctx.fillStyle = '#ff6b6b';
                  ctx.beginPath(); ctx.arc(sp2.x, sp2.y, p.radius, 0, Math.PI * 2); ctx.fill();
                  try { Audio?.playSfx?.(state, 'bomb'); } catch { }
                  const elemStage = getPlayerElementStage(state.stats.elem);
                  const knockback = typeof p.knockback === 'number' ? p.knockback : 0;
                  for (const e of enemies) {
                    if (!e.alive) continue;
                    const d = Math.hypot(e.x - p.x, e.y - p.y);
                    if (d <= p.radius + e.r) {
                      let dmg = applyElementalMultiplier(p.dmg, state.stats.elem, e.elem, elemStage);
                      if (!e.elem && state.stats.elem && e.boss) {
                        const tbl = bossElemBonus[e.name] || bossElemBonus['default'];
                        dmg *= (tbl[state.stats.elem] || 1.1);
                      }
                      if (e.boss && p.bossMul) dmg *= p.bossMul;
                      dmg = applyBossBonus(dmg, e);
                      dmg = Math.round(dmg);
                      const mul = e.dmgTakenMul ?? 1;
                      if (serverSim) {
                        queueHit(e.id, dmg, dmg * mul);
                        accumServerDamage(e.id, dmg * mul, e.x, e.y);
                      } else {
                        const actual = dmg * mul;
                        e.hp -= actual;
                        if (state.settings.damageNumbers) spawnDamageNumber(e.x, e.y, '-' + Math.round(actual));
                        if (e.hp <= 0 && e.alive) { pushKill(e); }
                        if (knockback > 0 && actual > 0) {
                          const nx = (e.x - p.x) / (d || 1);
                          const ny = (e.y - p.y) / (d || 1);
                          e.x += nx * knockback;
                          e.y += ny * knockback;
                        }
                      }
                    }
                  }
                  projectiles.splice(i, 1);
                  if (state.perks.ex) {
                    const fireTime = Number.isFinite(p.fireTime) ? p.fireTime : cfg.koi.fireTime;
                    const fireDps = Number.isFinite(p.fireDps) ? p.fireDps : cfg.koi.fireDps;
                    if (fireTime > 0 && fireDps > 0) {
                      projectiles.push({ type: 'fire', x: p.x, y: p.y, radius: p.radius, ttl: fireTime, dps: fireDps });
                    }
                  }
                  continue;
                }
              }
              const sp2 = toScreen(p.x, p.y);
              drawBombSprite(sp2, p.r);
            }
            else if (p.type === 'supportBomb') {
              const targetX = Number.isFinite(p.targetX) ? p.targetX : player.x;
              const targetY = Number.isFinite(p.targetY) ? p.targetY : player.y;
              const startX = Number.isFinite(p.startX) ? p.startX : targetX;
              const drop = Number.isFinite(p.dropHeight) ? p.dropHeight : SUPPORT_BOMB_DROP_HEIGHT;
              const startY = Number.isFinite(p.startY) ? p.startY : (targetY - drop);
              const travelTime = Math.max(0.0001, Number.isFinite(p.travelTime) ? p.travelTime : SUPPORT_BOMB_TRAVEL_TIME);
              const arcHeight = Math.max(0, Number.isFinite(p.arcHeight) ? p.arcHeight : SUPPORT_BOMB_ARC_HEIGHT);
              const radius = Math.max(0, Number.isFinite(p.radius) ? p.radius : SUPPORT_BOMB_RADIUS);
              p.elapsed = (p.elapsed || 0);
              if (!p.landed) {
                p.elapsed += dt;
                const progress = Math.max(0, Math.min(1, p.elapsed / travelTime));
                const height = Math.sin(progress * Math.PI) * arcHeight;
                p.displayHeight = height;
                p.x = startX + (targetX - startX) * progress;
                p.y = startY + (targetY - startY) * progress;
                if (progress >= 1) {
                  p.landed = true;
                  p.x = targetX;
                  p.y = targetY;
                  p.displayHeight = 0;
                }
              }
              const px = targetX;
              const py = targetY;
              const sp2 = toScreen(px, py);
              ctx.save();
              ctx.globalAlpha = p.landed ? 0.35 : 0.2;
              ctx.strokeStyle = '#f97316';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.arc(sp2.x, sp2.y, radius, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
              const shadowRadius = Math.max(12, radius * 0.35);
              ctx.save();
              ctx.globalAlpha = p.landed ? 0.35 : 0.25;
              ctx.fillStyle = 'rgba(0,0,0,0.45)';
              ctx.beginPath();
              ctx.arc(sp2.x, sp2.y, shadowRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
              const height = Math.max(0, p.displayHeight || 0);
              const offsetY = height * 0.6;
              const heightRatio = arcHeight > 0 ? Math.max(0, Math.min(1, height / arcHeight)) : 0;
              const spriteScale = 0.75 + 0.25 * (1 - heightRatio);
              const spriteRadius = Math.max(6, radius * 0.28) * spriteScale;
              drawBombSprite({ x: sp2.x, y: sp2.y - offsetY }, spriteRadius);
              if (p.landed && !p.exploded) {
                p.exploded = true;
                try { Audio?.playSfx?.(state, 'bomb'); } catch { }
                spawnBomberExplosionFx(px, py, radius);
                const elemStage = getPlayerElementStage(state.stats.elem);
                const serverSim = !!state.serverSim;
                const dmgMul = Number.isFinite(p.dmgMul) ? p.dmgMul : SUPPORT_BOMB_DAMAGE_MUL;
                const baseDmg = Math.max(1, Math.round(getAtk() * dmgMul));
                const knockback = Number.isFinite(p.knockback) ? p.knockback : SUPPORT_BOMB_KNOCKBACK;
                for (const enemy of enemies) {
                  if (!enemy.alive) continue;
                  const dist = Math.hypot(enemy.x - px, enemy.y - py);
                  if (dist > radius + (enemy.r || 0)) continue;
                  let dmg = baseDmg;
                  dmg = applyElementalMultiplier(dmg, state.stats.elem, enemy.elem, elemStage);
                  dmg = applyBossBonus(dmg, enemy);
                  dmg = Math.max(1, Math.round(dmg));
                  const mul = enemy.dmgTakenMul ?? 1;
                  if (serverSim) {
                    queueHit(enemy.id, dmg, dmg * mul);
                    accumServerDamage(enemy.id, dmg * mul, enemy.x, enemy.y);
                  } else {
                    const actual = dmg * mul;
                    enemy.hp -= actual;
                    if (state.settings.damageNumbers) spawnDamageNumber(enemy.x, enemy.y, '-' + Math.round(actual));
                    if (enemy.hp <= 0 && enemy.alive) { pushKill(enemy); }
                    if (knockback > 0 && actual > 0) {
                      const nx = (enemy.x - px) / (dist || 1);
                      const ny = (enemy.y - py) / (dist || 1);
                      enemy.x += nx * knockback;
                      enemy.y += ny * knockback;
                    }
                  }
                }
                const fireTime = Math.max(0, Number.isFinite(p.fireTime) ? p.fireTime : SUPPORT_BOMB_FIRE_TIME);
                const fireMul = Number.isFinite(p.fireMul) ? p.fireMul : SUPPORT_BOMB_FIRE_MUL;
                const fireDps = Math.max(0, getAtk() * fireMul);
                if (fireTime > 0 && fireDps > 0) {
                  projectiles.push({ type: 'fire', x: px, y: py, radius, ttl: fireTime, dps: fireDps, owner: 'supportBomb' });
                }
                projectiles.splice(i, 1);
                continue;
              }
              continue;
            }
            else if (p.type === 'subBomb') {
              const runtime = p.runtimeRef || state.subWeaponRuntime;
              const travelTime = Math.max(0.0001, p.travelTime ?? 0.6);
              const arcHeight = Math.max(0, p.arcHeight ?? 80);
              const spriteRadius = p.r ?? 8;
              const shadowRadius = p.shadowRadius ?? spriteRadius;
              const radius = Math.max(0, p.explosionRadius ?? 110);
              const bossMul = typeof p.bossMul === 'number' ? p.bossMul : 1;
              const startX = typeof p.startX === 'number' ? p.startX : player.x;
              const startY = typeof p.startY === 'number' ? p.startY : player.y;
              const targetX = typeof p.targetX === 'number' ? p.targetX : startX;
              const targetY = typeof p.targetY === 'number' ? p.targetY : startY;
              p.elapsed = p.elapsed || 0;
              if (!p.landed) {
                p.elapsed += dt;
                const progress = Math.max(0, Math.min(1, p.elapsed / travelTime));
                const height = Math.sin(progress * Math.PI) * arcHeight;
                p.displayHeight = height;
                p.x = startX + (targetX - startX) * progress;
                p.y = startY + (targetY - startY) * progress;
                if (runtime) {
                  const remainTravel = Math.max(0, travelTime - p.elapsed);
                  const fuseRemain = Math.max(0, p.fuse ?? 0);
                  runtime.activeTimer = remainTravel + fuseRemain;
                }
                if (progress >= 1) {
                  p.landed = true;
                  p.displayHeight = 0;
                  p.elapsed = travelTime;
                }
              } else {
                p.displayHeight = 0;
                p.fuse = (p.fuse ?? 0) - dt;
                if (runtime) runtime.activeTimer = Math.max(0, p.fuse ?? 0);
                if ((p.fuse ?? 0) <= 0) {
                  const px = p.x, py = p.y;
                  const sp2 = toScreen(px, py);
                  ctx.save();
                  ctx.fillStyle = 'rgba(255,120,64,0.65)';
                  ctx.beginPath(); ctx.arc(sp2.x, sp2.y, radius, 0, Math.PI * 2); ctx.fill();
                  ctx.restore();
                  try { Audio?.playSfx?.(state, 'bomb'); } catch { }
                  const atkElem = state.stats.elem;
                  const rawDmg = p.dmg ?? Math.max(20, Math.round(getAtk() * 6));
                  const atkStage = getPlayerElementStage(atkElem);
                  for (const e of enemies) {
                    if (!e.alive) continue;
                    const d = Math.hypot(e.x - px, e.y - py);
                    if (d > radius + e.r) continue;
                    let dmg = applyElementalMultiplier(rawDmg, atkElem, e.elem, atkStage);
                    if (!e.elem && atkElem && e.boss) {
                      const tbl = bossElemBonus[e.name] || bossElemBonus['default'];
                      dmg *= (tbl[atkElem] || 1.1);
                    }
                    if (e.boss && bossMul) dmg *= bossMul;
                    dmg = applyBossBonus(dmg, e);
                    dmg = Math.round(dmg);
                    const mul = e.dmgTakenMul ?? 1;
                    if (serverSim) {
                      queueHit(e.id, dmg, dmg * mul);
                      accumServerDamage(e.id, dmg * mul, e.x, e.y);
                    } else {
                      const actual = dmg * mul;
                      e.hp -= actual;
                      if (state.settings.damageNumbers) spawnDamageNumber(e.x, e.y, '-' + Math.round(actual));
                      if (e.hp <= 0 && e.alive) { pushKill(e); }
                    }
                  }
                  projectiles.splice(i, 1);
                  if (runtime && runtime.active) {
                    runtime.active = false;
                    runtime.activeTimer = 0;
                    handleSubWeaponDepletion(true);
                  }
                  const fireTime = Number.isFinite(p.fireTime) ? p.fireTime : cfg.koi.fireTime;
                  const fireDps = Number.isFinite(p.fireDps) ? p.fireDps : cfg.koi.fireDps;
                  if (state.perks.ex && fireTime > 0 && fireDps > 0) {
                    projectiles.push({ type: 'fire', x: px, y: py, radius, ttl: fireTime, dps: fireDps });
                  }
                  continue;
                }
              }
              const sp2 = toScreen(p.x, p.y);
              ctx.save();
              ctx.globalAlpha = p.landed ? 0.28 : 0.18;
              ctx.strokeStyle = p.landed ? '#fb923c' : '#f97316';
              ctx.lineWidth = 2;
              ctx.beginPath(); ctx.arc(sp2.x, sp2.y, radius, 0, Math.PI * 2); ctx.stroke();
              ctx.restore();
              if (p.landed) {
                const maxFuse = Math.max(0.0001, p.initialFuse ?? 0.0001);
                const remainFuse = Math.max(0, p.fuse ?? 0);
                const fuseRatio = Math.max(0, Math.min(1, 1 - remainFuse / maxFuse));
                ctx.save();
                ctx.globalAlpha = 0.2 + 0.3 * fuseRatio;
                ctx.fillStyle = 'rgba(249,115,22,0.4)';
                ctx.beginPath();
                ctx.arc(sp2.x, sp2.y, radius * (0.45 + 0.35 * fuseRatio), 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
              }
              ctx.save();
              ctx.globalAlpha = 0.25;
              ctx.fillStyle = 'rgba(0,0,0,0.45)';
              ctx.beginPath();
              ctx.arc(sp2.x, sp2.y, shadowRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
              const height = Math.max(0, p.displayHeight ?? 0);
              const offsetY = height * 0.6;
              const heightRatio = arcHeight > 0 ? Math.max(0, Math.min(1, height / arcHeight)) : 0;
              const scale = 0.75 + 0.25 * (1 - heightRatio);
              drawBombSprite({ x: sp2.x, y: sp2.y - offsetY }, spriteRadius * scale);
            }
            else if (p.type === 'subSword') {
              const runtime = p.runtimeRef || state.subWeaponRuntime;
              if (p.follow) {
                let fx = lastMoveDir.x;
                let fy = lastMoveDir.y;
                const flen = Math.hypot(fx, fy);
                if (flen > 0.0001) {
                  fx /= flen;
                  fy /= flen;
                } else {
                  switch (lastFacing) {
                    case 'left': fx = -1; fy = 0; break;
                    case 'up': fx = 0; fy = -1; break;
                    case 'down': fx = 0; fy = 1; break;
                    case 'right':
                    default: fx = 1; fy = 0; break;
                  }
                }
                if (fx === 0 && fy === 0) { fx = 1; fy = 0; }
                p.dirX = fx;
                p.dirY = fy;
              }
              const rawDirX = typeof p.dirX === 'number' ? p.dirX : 1;
              const rawDirY = typeof p.dirY === 'number' ? p.dirY : 0;
              const vecLen = Math.hypot(rawDirX, rawDirY) || 1;
              const dirX = rawDirX / vecLen;
              const dirY = rawDirY / vecLen;
              const offset = p.offset ?? 0;
              const length = p.len ?? 0;
              const startX = player.x + dirX * offset;
              const startY = player.y + dirY * offset;
              const endX = startX + dirX * length;
              const endY = startY + dirY * length;
              const maxTtl = p.maxTtl ?? 1;
              const remain = Math.max(0, Math.min(p.ttl, maxTtl));
              const ratio = maxTtl > 0 ? Math.max(0, Math.min(1, remain / maxTtl)) : 0;
              const halfWidth = p.halfWidth ?? 12;
              for (const e of enemies) {
                if (!e.alive) continue;
                if (p.hit && p.hit.includes(e)) continue;
                const distSq = distToSegmentSq(e.x, e.y, startX, startY, endX, endY);
                const rad = e.r + halfWidth;
                if (distSq <= rad * rad) {
                  const atkElem = state.stats.elem;
                  const atkStage = getPlayerElementStage(atkElem);
                  let dmg = applyElementalMultiplier(p.dmg, atkElem, e.elem, atkStage);
                  if (!e.elem && atkElem && e.boss) {
                    const tbl = bossElemBonus[e.name] || bossElemBonus['default'];
                    dmg *= (tbl[atkElem] || 1.1);
                  }
                  dmg = applyBossBonus(dmg, e);
                  dmg = Math.round(dmg);
                  const mul = e.dmgTakenMul ?? 1;
                  if (serverSim) {
                    queueHit(e.id, dmg, dmg * mul);
                    accumServerDamage(e.id, dmg * mul, e.x, e.y);
                  } else {
                    const actual = dmg * mul;
                    e.hp -= actual;
                    if (state.settings.damageNumbers) spawnDamageNumber(e.x, e.y, '-' + Math.round(actual));
                    if (e.hp <= 0 && e.alive) { pushKill(e); }
                  }
                  p.hit = p.hit || [];
                  p.hit.push(e);
                }
              }
              const playerSp = toScreen(player.x, player.y);
              const ang = Math.atan2(dirY, dirX);
              ctx.save();
              ctx.translate(playerSp.x, playerSp.y);
              const swordAngle = ang - Math.PI / 2;
              ctx.rotate(swordAngle);
              ctx.globalAlpha = 0.45 + 0.55 * ratio;
              if (subSwordImg.complete && subSwordImg.naturalWidth > 0 && subSwordImg.naturalHeight > 0) {
                const swordWidth = halfWidth * 2;
                const drawLen = length + offset;
                try {
                  ctx.drawImage(subSwordImg, -swordWidth / 2, -offset, swordWidth, drawLen);
                } catch {
                  ctx.fillStyle = '#f97316';
                  ctx.fillRect(-halfWidth, -offset, halfWidth * 2, drawLen);
                }
              } else {
                ctx.strokeStyle = '#f97316';
                ctx.lineWidth = halfWidth * 1.35;
                ctx.beginPath();
                ctx.moveTo(0, -offset);
                ctx.lineTo(0, length);
                ctx.stroke();
              }
              ctx.restore();
              p.ttl -= dt;
              if (runtime) {
                runtime.activeTimer = Math.max(0, Math.min(maxTtl, p.ttl));
              }
              if (p.ttl <= 0) {
                if (runtime && runtime.active) {
                  runtime.active = false;
                  runtime.activeTimer = 0;
                  handleSubWeaponDepletion(true);
                }
                projectiles.splice(i, 1);
                continue;
              }
            }
            else if (p.type === 'subFlame') {
              const runtime = p.runtimeRef || state.subWeaponRuntime;
              if (p.follow) {
                let fx = lastMoveDir.x;
                let fy = lastMoveDir.y;
                const flen = Math.hypot(fx, fy);
                if (flen > 0.0001) {
                  fx /= flen;
                  fy /= flen;
                } else {
                  switch (lastFacing) {
                    case 'left': fx = -1; fy = 0; break;
                    case 'up': fx = 0; fy = -1; break;
                    case 'down': fx = 0; fy = 1; break;
                    case 'right':
                    default: fx = 1; fy = 0; break;
                  }
                }
                if (fx === 0 && fy === 0) { fx = 1; fy = 0; }
                p.dirX = fx;
                p.dirY = fy;
              }
              const rawDirX = typeof p.dirX === 'number' ? p.dirX : 1;
              const rawDirY = typeof p.dirY === 'number' ? p.dirY : 0;
              const dirLen = Math.hypot(rawDirX, rawDirY) || 1;
              const dirX = rawDirX / dirLen;
              const dirY = rawDirY / dirLen;
              const offset = p.offset ?? (player.r + 12);
              const length = p.len ?? 180;
              const maxTtl = p.maxTtl ?? 0;
              const baseHalfWidth = p.halfWidth ?? 56;
              const dps = p.dps ?? Math.max(12, getAtk() * 1.8);
              const knockback = p.knockback ?? 0;
              const atkElem = p.elem || state.stats.elem;
              const atkStage = getPlayerElementStage(atkElem);
              p.time = (p.time || 0) + dt;
              const remain = Math.max(0, Math.min(p.ttl, maxTtl));
              const lifeRatio = maxTtl > 0 ? remain / maxTtl : 0;
              const flicker = 0.85 + 0.15 * Math.sin((p.time + (p.seed || 0)) * 14);
              const halfWidth = baseHalfWidth * (0.9 + 0.2 * (1 - lifeRatio)) * flicker;
              const start = offset;
              const end = offset + length;
              for (const e of enemies) {
                if (!e.alive) continue;
                const relX = e.x - player.x;
                const relY = e.y - player.y;
                const proj = relX * dirX + relY * dirY;
                if (proj < start - e.r) continue;
                if (proj > end + e.r) continue;
                const perp = Math.abs(relX * -dirY + relY * dirX);
                if (perp > halfWidth + e.r) continue;
                let dealt = dps * dt;
                dealt = applyElementalMultiplier(dealt, atkElem || 'fire', e.elem, atkElem ? atkStage : 1);
                dealt = applyBossBonus(dealt, e);
                const mul = e.dmgTakenMul ?? 1;
                if (serverSim) {
                  queueHit(e.id, dealt, dealt * mul);
                  accumServerDamage(e.id, dealt * mul, e.x, e.y);
                } else {
                  const actual = dealt * mul;
                  e.hp -= actual;
                  accumEnemyDamage(e, actual);
                  if (knockback > 0 && actual > 0) {
                    const push = knockback * dt;
                    e.x += dirX * push;
                    e.y += dirY * push;
                  }
                  if (e.hp <= 0 && e.alive) { pushKill(e); }
                }
              }
              const playerSp = toScreen(player.x, player.y);
              const ang = Math.atan2(dirY, dirX);
              ctx.save();
              ctx.translate(playerSp.x, playerSp.y);
              ctx.rotate(ang);
              const outerHalf = halfWidth * 1.15;
              const innerHalf = halfWidth * 0.6;
              const far = start + length;
              const baseAlpha = 0.55 + 0.25 * Math.sin((p.time + (p.seed || 0)) * 6 + 1.5);
              let grad = ctx.createLinearGradient(start, 0, far, 0);
              ctx.globalAlpha = Math.max(0.35, baseAlpha * 0.85);
              grad.addColorStop(0, 'rgba(255,190,90,0.95)');
              grad.addColorStop(0.45, 'rgba(255,120,40,0.7)');
              grad.addColorStop(1, 'rgba(255,30,0,0)');
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.moveTo(start, -outerHalf);
              ctx.quadraticCurveTo(start + length * 0.35, -outerHalf * 1.2, far, -outerHalf * 0.6);
              ctx.lineTo(far, outerHalf * 0.6);
              ctx.quadraticCurveTo(start + length * 0.35, outerHalf * 1.2, start, outerHalf);
              ctx.closePath();
              ctx.fill();
              grad = ctx.createLinearGradient(start, 0, far, 0);
              ctx.globalAlpha = Math.max(0.45, baseAlpha);
              grad.addColorStop(0, 'rgba(255,255,210,0.95)');
              grad.addColorStop(0.4, 'rgba(255,200,80,0.75)');
              grad.addColorStop(1, 'rgba(255,90,0,0)');
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.moveTo(start, -innerHalf);
              ctx.quadraticCurveTo(start + length * 0.25, -innerHalf * 0.5, far - length * 0.08, -innerHalf * 0.2);
              ctx.lineTo(far - length * 0.08, innerHalf * 0.2);
              ctx.quadraticCurveTo(start + length * 0.25, innerHalf * 0.5, start, innerHalf);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
              p.ttl -= dt;
              if (runtime) {
                runtime.activeTimer = Math.max(0, Math.min(maxTtl, p.ttl));
              }
              if (p.ttl <= 0) {
                if (runtime && runtime.active) {
                  runtime.active = false;
                  runtime.activeTimer = 0;
                  handleSubWeaponDepletion(true);
                }
                projectiles.splice(i, 1);
                continue;
              }
            }
            else if (p.type === 'subFlash') {
              const runtime = p.runtimeRef || state.subWeaponRuntime;
              const centerX = typeof p.x === 'number' ? p.x : player.x;
              const centerY = typeof p.y === 'number' ? p.y : player.y;
              const rawRadius = typeof p.radius === 'number' ? p.radius : 240;
              const radius = Math.max(0, rawRadius);
              const stunDuration = typeof p.stun === 'number' ? Math.max(0, p.stun) : 0;
              if (!p.applied) {
                p.applied = true;
                if (stunDuration > 0) {
                  for (const e of enemies) {
                    if (!e.alive || e.boss) continue;
                    const enemyRadius = typeof e.r === 'number' ? e.r : 0;
                    const dist = Math.hypot(e.x - centerX, e.y - centerY);
                    if (dist <= radius + enemyRadius) {
                      if (serverSim) {
                        queueStun(e.id, stunDuration);
                      } else {
                        e.stun = Math.max(e.stun || 0, stunDuration);
                      }
                    }
                  }
                }
              }
              const maxTtl = p.maxTtl ?? 0.6;
              p.ttl -= dt;
              const remain = Math.max(0, p.ttl);
              if (runtime) {
                runtime.activeTimer = Math.max(0, Math.min(maxTtl, remain));
              }
              const sp2 = toScreen(centerX, centerY);
              const lifeRatio = maxTtl > 0 ? Math.max(0, Math.min(1, remain / maxTtl)) : 0;
              const outerRadius = radius * (1.1 + 0.35 * (1 - lifeRatio));
              ctx.save();
              ctx.globalCompositeOperation = 'lighter';
              const grad = ctx.createRadialGradient(sp2.x, sp2.y, radius * 0.25, sp2.x, sp2.y, outerRadius);
              grad.addColorStop(0, `rgba(255,255,210,${0.4 + 0.4 * lifeRatio})`);
              grad.addColorStop(0.6, `rgba(255,255,255,${0.35 + 0.35 * lifeRatio})`);
              grad.addColorStop(1, 'rgba(255,255,255,0)');
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.arc(sp2.x, sp2.y, outerRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
              if (p.ttl <= 0) {
                if (runtime && runtime.active) {
                  runtime.active = false;
                  runtime.activeTimer = 0;
                  handleSubWeaponDepletion(true);
                }
                projectiles.splice(i, 1);
                continue;
              }
            }
            else if (p.type === 'supportLaser') {
              if (typeof p.ttl === 'number') {
                p.ttl -= dt;
                if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              }
              const timers = p.hitCooldowns || (p.hitCooldowns = new Map());
              for (const [target, remain] of Array.from(timers.entries())) {
                const next = remain - dt;
                if (!target?.alive || next <= 0) timers.delete(target);
                else timers.set(target, next);
              }
              const radius = typeof p.radius === 'number' ? p.radius : SUPPORT_LASER_RADIUS;
              const camSource = Number.isFinite(state.camera?.x) && Number.isFinite(state.camera?.y)
                ? state.camera
                : (state._lastSafeCamera || { x: player.x, y: player.y });
              const camX = Number.isFinite(camSource?.x) ? camSource.x : player.x;
              const camY = Number.isFinite(camSource?.y) ? camSource.y : player.y;
              const halfW = cvs.width / 2;
              const halfH = cvs.height / 2;
              const minX = camX - halfW + radius;
              const maxX = camX + halfW - radius;
              const minY = camY - halfH + radius;
              const maxY = camY + halfH - radius;
              let nextX = p.x + p.vx * dt;
              let nextY = p.y + p.vy * dt;
              let bounced = false;
              if (nextX < minX) { nextX = minX + (minX - nextX); p.vx = Math.abs(p.vx); bounced = true; }
              else if (nextX > maxX) { nextX = maxX - (nextX - maxX); p.vx = -Math.abs(p.vx); bounced = true; }
              if (nextY < minY) { nextY = minY + (minY - nextY); p.vy = Math.abs(p.vy); bounced = true; }
              else if (nextY > maxY) { nextY = maxY - (nextY - maxY); p.vy = -Math.abs(p.vy); bounced = true; }
              if (bounced) {
                p.bounces = (p.bounces || 0) + 1;
                const maxB = Number.isFinite(p.maxBounces) ? p.maxBounces : SUPPORT_LASER_MAX_BOUNCES;
                if (p.bounces >= maxB) { projectiles.splice(i, 1); continue; }
              }
              p.x = nextX;
              p.y = nextY;
              const elemStage = getPlayerElementStage(state.stats.elem);
              for (const enemy of enemies) {
                if (!enemy.alive) continue;
                const dx = enemy.x - p.x;
                const dy = enemy.y - p.y;
                const colR = (enemy.r || 0) + radius;
                if (dx * dx + dy * dy > colR * colR) continue;
                if (timers.has(enemy)) continue;
                let dmg = typeof p.dmg === 'number' ? p.dmg : Math.max(1, Math.round(getAtk() * SUPPORT_LASER_DAMAGE_MUL));
                dmg = applyElementalMultiplier(dmg, state.stats.elem, enemy.elem, elemStage);
                dmg = applyBossBonus(dmg, enemy);
                dmg = Math.max(1, Math.round(dmg));
                const mul = enemy.dmgTakenMul ?? 1;
                if (serverSim) {
                  queueHit(enemy.id, dmg, dmg * mul);
                  accumServerDamage(enemy.id, dmg * mul, enemy.x, enemy.y);
                } else {
                  const actual = dmg * mul;
                  enemy.hp -= actual;
                  accumEnemyDamage(enemy, actual);
                  if (state.settings.damageNumbers) {
                    spawnDamageNumber(enemy.x, enemy.y, '-' + Math.round(actual));
                  }
                  if (enemy.hp <= 0 && enemy.alive) { pushKill(enemy); }
                }
                timers.set(enemy, SUPPORT_LASER_HIT_COOLDOWN);
              }
              const sp2 = toScreen(p.x, p.y);
              const ang = Math.atan2(p.vy, p.vx);
              ctx.save();
              ctx.translate(sp2.x, sp2.y);
              ctx.rotate(ang);
              const len = 42;
              const w = Math.max(2, radius * 1.5);
              ctx.fillStyle = 'rgba(60, 200, 255, 0.5)';
              ctx.fillRect(-len / 2, -w, len, w * 2);
              ctx.fillStyle = 'rgba(200, 255, 255, 0.9)';
              ctx.fillRect(-len / 2, -w / 2, len, w);
              ctx.restore();
              continue;
            }
            else if (p.type === 'fire') {
              p.ttl -= dt; if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              const elemStage = getPlayerElementStage(state.stats.elem);
              const fireDps = Number.isFinite(p.dps) ? p.dps : cfg.koi.fireDps;
              for (const e of enemies) {
                if (!e.alive) continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (d <= p.radius + e.r) {
                  let dealt = fireDps * dt;
                  dealt = applyElementalMultiplier(dealt, state.stats.elem, e.elem, elemStage);
                  dealt = applyBossBonus(dealt, e);
                  const mul = e.dmgTakenMul ?? 1;
                  if (serverSim) {
                    queueHit(e.id, dealt, dealt * mul);
                    accumServerDamage(e.id, dealt * mul, e.x, e.y);
                  } else {
                    const actual = dealt * mul;
                    e.hp -= actual;
                    accumEnemyDamage(e, actual);
                    if (e.hp <= 0 && e.alive) { pushKill(e); }
                  }
                }
              }
              const sp2 = toScreen(p.x, p.y);
              ctx.fillStyle = 'rgba(255,96,96,0.4)';
              ctx.beginPath(); ctx.arc(sp2.x, sp2.y, p.radius, 0, Math.PI * 2); ctx.fill();
            }
            else if (p.type === 'sniper') {
              p.ttl -= dt; if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              p.x += p.vx * dt; p.y += p.vy * dt;
              const hitEnemy = enemies.find(e => {
                if (!e.alive) return false;
                if (p.pierce && p.hit && p.hit.includes(e)) return false;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                return d < p.r + e.r;
              });
              if (hitEnemy) {
                const atkElem = p.elem || state.stats.elem;
                const atkStage = getPlayerElementStage(atkElem);
                let dmg = applyElementalMultiplier(p.dmg, atkElem, hitEnemy.elem, atkStage);
                if (!hitEnemy.elem && atkElem && hitEnemy.boss) {
                  const tbl = bossElemBonus[hitEnemy.name] || bossElemBonus['default'];
                  dmg *= (tbl[atkElem] || 1.1);
                }
                dmg = applyBossBonus(dmg, hitEnemy);
                dmg = Math.round(dmg);
                const mul = hitEnemy.dmgTakenMul ?? 1;
                if (serverSim) {
                  queueHit(hitEnemy.id, dmg, dmg * mul);
                  accumServerDamage(hitEnemy.id, dmg * mul, hitEnemy.x, hitEnemy.y);
                } else {
                  const actual = dmg * mul;
                  hitEnemy.hp -= actual;
                  if (state.settings.damageNumbers) spawnDamageNumber(hitEnemy.x, hitEnemy.y, '-' + Math.round(actual));
                  if (hitEnemy.hp <= 0 && hitEnemy.alive) { pushKill(hitEnemy); }
                }
                if (p.knockback) {
                  const kb = p.knockback;
                  const dx = hitEnemy.x - player.x, dy = hitEnemy.y - player.y;
                  const dist = Math.hypot(dx, dy) || 1;
                  hitEnemy.x += (dx / dist) * kb;
                  hitEnemy.y += (dy / dist) * kb;
                }
                if (p.stun) {
                  if (serverSim) { queueStun(hitEnemy.id, p.stun); }
                  else { hitEnemy.stun = Math.max(hitEnemy.stun || 0, p.stun); }
                }
                if (state.perks.ex || p.ex) {
                  const exDmg = Math.max(1, Math.round(getAtk() * cfg.mero.exDmgScale));
                  projectiles.push({ type: 'meroExp', x: p.x, y: p.y, radius: cfg.mero.exRadius, ttl: 0.2 });
                  for (const e2 of enemies) {
                    if (!e2.alive) continue;
                    const d2 = Math.hypot(e2.x - p.x, e2.y - p.y);
                    if (d2 <= cfg.mero.exRadius + e2.r) {
                      let dmg2 = applyElementalMultiplier(exDmg, atkElem, e2.elem, atkStage);
                      if (!e2.elem && atkElem && e2.boss) {
                        const tbl = bossElemBonus[e2.name] || bossElemBonus['default'];
                        dmg2 *= (tbl[atkElem] || 1.1);
                      }
                      dmg2 = applyBossBonus(dmg2, e2);
                      dmg2 = Math.round(dmg2);
                      const mul2 = e2.dmgTakenMul ?? 1;
                      if (serverSim) {
                        queueHit(e2.id, dmg2, dmg2 * mul2);
                        accumServerDamage(e2.id, dmg2 * mul2, e2.x, e2.y);
                      } else {
                        const actual2 = dmg2 * mul2;
                        e2.hp -= actual2;
                        if (state.settings.damageNumbers) spawnDamageNumber(e2.x, e2.y, '-' + Math.round(actual2));
                        if (e2.hp <= 0 && e2.alive) { pushKill(e2); }
                      }
                    }
                  }
                }
                if (p.pierce) { p.hit = p.hit || []; p.hit.push(hitEnemy); }
                else { projectiles.splice(i, 1); continue; }
              }
              const sp2 = toScreen(p.x, p.y);
              ctx.fillStyle = '#ffee88';
              ctx.beginPath(); ctx.arc(sp2.x, sp2.y, p.r, 0, Math.PI * 2); ctx.fill();
            }
            else if (p.type === 'meroExp') {
              p.ttl -= dt; if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              const sp2 = toScreen(p.x, p.y);
              const alpha = Math.max(0, Math.min(1, p.ttl / 0.2));
              ctx.fillStyle = `rgba(255,223,92,${0.5 * alpha})`;
              ctx.beginPath(); ctx.arc(sp2.x, sp2.y, p.radius, 0, Math.PI * 2); ctx.fill();
            }
            else if (p.type === 'pew') {
              p.ttl -= dt; if (p.ttl <= 0) { projectiles.splice(i, 1); continue; }
              const nx = p.x + p.vx * dt; const ny = p.y + p.vy * dt;
              if (stage.type === 'maze' || stage.iceBlocks) {
                const obs = getNearbyObstacles(nx, ny);
                let blocked = false;
                for (const r of obs) {
                  if (circleRectCollide(nx, ny, p.r, r)) {
                    if (r.hp != null && p.elem === 'fire') {
                      r.hp -= p.dmg;
                      if (r.hp <= 0) {
                        const idx = iceBlocks.indexOf(r); if (idx >= 0) iceBlocks.splice(idx, 1);
                      }
                    }
                    blocked = true;
                    break;
                  }
                }
                if (blocked) { projectiles.splice(i, 1); continue; }
              }
              p.x = nx; p.y = ny;
              let hit = false;
              for (const e of enemies) {
                if (!e.alive) continue;
                if (p.pierce && p.hit && p.hit.includes(e)) continue;
                const d = Math.hypot(e.x - p.x, e.y - p.y);
                if (d < p.r + e.r) {
                  const atkElem = p.elem || state.stats.elem;
                  const atkStage = getPlayerElementStage(atkElem);
                  let dmg = applyElementalMultiplier(p.dmg, atkElem, e.elem, atkStage);
                  if (!e.elem && atkElem && e.boss) { const tbl = bossElemBonus[e.name] || bossElemBonus['default']; dmg *= (tbl[atkElem] || 1.1); }
                  dmg = applyBossBonus(dmg, e);
                  dmg = Math.round(dmg);
                  const mul = e.dmgTakenMul ?? 1;
                  if (serverSim) {
                    queueHit(e.id, dmg, dmg * mul);
                    accumServerDamage(e.id, dmg * mul, e.x, e.y);
                  } else {
                    const actual = dmg * mul;
                    e.hp -= actual;
                    if (state.settings.damageNumbers) spawnDamageNumber(e.x, e.y, '-' + Math.round(actual));
                    if (e.hp <= 0 && e.alive) { pushKill(e); }
                  }
                  if (p.pierce) { p.hit = p.hit || []; p.hit.push(e); }
                  else { hit = true; break; }
                }
              }
              if (hit) { projectiles.splice(i, 1); continue; }
              const sp2 = toScreen(p.x, p.y);
              ctx.fillStyle = p.elem ? (elementColors[p.elem] || '#ffee88') : '#ffee88';
              ctx.beginPath(); ctx.arc(sp2.x, sp2.y, p.r, 0, Math.PI * 2); ctx.fill();
            }
          }
        }

        if (state.subWeaponRuntime && state.subWeaponRuntime.active) {
          const runtime = state.subWeaponRuntime;
          let hasActive = false;
          for (const proj of projectiles) {
            if (!proj || proj.runtimeRef !== runtime) continue;
            if (proj.ttl == null || proj.ttl > 0) { hasActive = true; break; }
          }
          if (!hasActive) {
            runtime.active = false;
            runtime.activeTimer = 0;
            handleSubWeaponDepletion(true);
          }
        }

        // enemy bullets update/draw
        for (let i = enemyProjectiles.length - 1; i >= 0; i--) {
          const b = enemyProjectiles[i];
          // In serverSim, bullets with id are updated by server; others are local
          b.ttl -= enemyDt; if (b.ttl <= 0) { enemyProjectiles.splice(i, 1); continue; }
          if (!serverSim || !b.id) {
            if (b.arm !== undefined) b.arm = Math.max(0, b.arm - enemyDt);
            b.px = (b.px === undefined ? b.x : b.px);
            b.py = (b.py === undefined ? b.y : b.py);
            if (b.type === 'ignitionStar') {
              const prevSpeed = b.speed ?? (Math.hypot(b.vx, b.vy) || 0);
              const accel = b.accel ?? 0;
              const maxSpeed = b.maxSpeed ?? prevSpeed;
              const nextSpeed = Math.min(maxSpeed, prevSpeed + accel * enemyDt);
              const spin = b.spin ?? 0;
              b.ang = (b.ang ?? Math.atan2(b.vy, b.vx)) + spin * enemyDt;
              b.speed = Math.max(10, nextSpeed);
              const curSpeed = b.speed;
              b.vx = Math.cos(b.ang) * curSpeed;
              b.vy = Math.sin(b.ang) * curSpeed;
            }
            const nx = b.x + b.vx * enemyDt, ny = b.y + b.vy * enemyDt;
            if (stage.type === 'maze' || stage.iceBlocks) { const obs = getNearbyObstacles(nx, ny); if (obs.some(r => circleRectCollide(nx, ny, b.r, r))) { enemyProjectiles.splice(i, 1); continue; } }
            b.x = nx; b.y = ny;
          } else {
            // keep previous for trail drawing
            b.px = (b.px === undefined ? b.x : b.px);
            b.py = (b.py === undefined ? b.y : b.py);
          }
          if (b.type === 'ignitionStar') {
            const spin = b.spin ?? 0;
            b.starRotation = (b.starRotation ?? (b.ang ?? Math.atan2(b.vy, b.vx))) + spin * enemyDt * 0.5;
            b.starPhase = (b.starPhase ?? 0) + (b.starPulseRate ?? 6) * enemyDt;
          }
          if (charName === 'フルムーン' && shield && shield.hp > 0) {
            const sx = player.x + shield.dirX * shield.size;
            const sy = player.y + shield.dirY * shield.size;
            const ang = Math.atan2(shield.dirY, shield.dirX);
            const cos = Math.cos(ang), sin = Math.sin(ang);
            const dx = b.x - sx, dy = b.y - sy;
            const rx = dx * cos + dy * sin;
            const ry = -dx * sin + dy * cos;
            const halfW = shield.w / 2, halfH = shield.size;
            if (Math.abs(rx) <= halfW + b.r && Math.abs(ry) <= halfH + b.r && isOnScreen(b.x, b.y, b.r + 6)) {
              enemyProjectiles.splice(i, 1);
              shield.hp -= b.dmg;
              if (shield.hp <= 0) { shield.cd = cfg.fullmoon.regen; }
              continue;
            }
          }
          // hit player（不可視の敵弾は当たらないように、画面内チェックを追加）
          const d = Math.hypot(player.x - b.x, player.y - b.y);
          if ((b.arm === undefined || b.arm <= 0) && d < player.r + b.r && isOnScreen(b.x, b.y, b.r + 6)) {
            // 無敵中はダメージ無効化（弾は消す）
            enemyProjectiles.splice(i, 1);
            if (invulnT <= 0) {
              const { hp: taken } = applyPlayerDamage(b.dmg); playerDmgAcc += taken;
              const nowHit = performance.now(); if (nowHit - state.audio.lastHitAt > 250) { try { Audio?.playSfx?.(state, 'hit'); } catch { } state.audio.lastHitAt = nowHit; }
            }
            continue;
          }
          // draw with high-visibility styling per type
          const sp2 = toScreen(b.x, b.y);
          const prev = toScreen(b.px, b.py);
          b.px = b.x; b.py = b.y;
          let col = '#ffb4b4';
          let trailColor = 'rgba(255,200,200,0.45)';
          let trailAlpha = 0.85;
          let trailWidth = Math.max(1, b.r * 0.6);
          if (b.type === 'shooter') {
            col = '#ff4444';
            trailColor = 'rgba(255,80,80,0.55)';
          } else if (b.type === 'boss') {
            col = '#ff9f1a';
            trailColor = 'rgba(255,170,60,0.55)';
          } else if (b.type === 'ignitionSuppressor') {
            col = '#4da3ff';
            trailColor = 'rgba(77,163,255,0.6)';
            trailAlpha = 0.9;
          } else if (b.type === 'ignitionStar') {
            col = b.starFill || '#ffe066';
            trailColor = b.starTrail || 'rgba(255,236,170,0.55)';
            trailAlpha = 0.95;
            const baseWidth = (b.r || 4.5) * (b.starScale ? b.starScale * 0.3 : 0.5);
            trailWidth = Math.max(0.75, baseWidth);
          } else if (b.type === 'barrage') {
            col = '#a855f7';
            trailColor = 'rgba(168,85,247,0.55)';
            trailAlpha = 0.92;
            trailWidth = Math.max(1.5, b.r * 0.9);
          }
          // トレイル（シンプルな半透明ライン）
          ctx.save();
          ctx.globalAlpha = trailAlpha;
          ctx.strokeStyle = trailColor;
          ctx.lineWidth = trailWidth;
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(sp2.x, sp2.y); ctx.stroke();
          // 本体（白縁＋塗り＋グロー）
          if (b.type === 'ignitionStar') {
            const glow = b.starGlow || col;
            ctx.globalAlpha = 1;
            ctx.shadowColor = glow;
            ctx.shadowBlur = 18;
            ctx.fillStyle = b.starFill || col;
            ctx.strokeStyle = b.starStroke || '#fff8dc';
            ctx.lineWidth = 1.4;
            const outerBase = (b.r || 4.5) * (b.starScale || 1.6);
            const pulse = 1 + 0.12 * Math.sin(b.starPhase ?? 0);
            const outer = outerBase * pulse;
            const inner = outer * 0.52;
            const rotation = b.starRotation ?? 0;
            ctx.translate(sp2.x, sp2.y);
            ctx.rotate(rotation);
            ctx.beginPath();
            for (let p = 0; p < 5; p++) {
              const outerAng = (p * 2 * Math.PI) / 5;
              const innerAng = outerAng + Math.PI / 5;
              const ox = Math.cos(outerAng) * outer;
              const oy = Math.sin(outerAng) * outer;
              if (p === 0) ctx.moveTo(ox, oy);
              else ctx.lineTo(ox, oy);
              const ix = Math.cos(innerAng) * inner;
              const iy = Math.sin(innerAng) * inner;
              ctx.lineTo(ix, iy);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.shadowColor = col;
            ctx.shadowBlur = 10;
            ctx.fillStyle = col;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sp2.x, sp2.y, b.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }

        // hazards (AoE) update/draw and damage（テレグラフ対応）
        for (let i = hazards.length - 1; i >= 0; i--) {
          const h = hazards[i];
          if (h.maxTtl == null) h.maxTtl = h.ttl;
          h.ttl -= enemyDt; if (h.ttl <= 0) { hazards.splice(i, 1); continue; }
          if (h.type === 'telegraph') {
            // 事前警告リング: 一定時間表示後に爆発を発生させる
            h.tele = (h.tele ?? 0) - enemyDt;
            const s = toScreen(h.x, h.y);
            // pulsing ring
            const alpha = 0.35 + 0.25 * Math.sin((h.tele ?? 0) * 16);
            const grow = 1.0 + 0.12 * Math.sin((h.tele ?? 0) * 10);
            ctx.save();
            ctx.strokeStyle = `rgba(255,80,80,${Math.max(0.15, alpha)})`;
            ctx.lineWidth = 3;
            ctx.setLineDash([10, 6]);
            ctx.beginPath(); ctx.arc(s.x, s.y, (h.r || 80) * grow, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
            if ((h.tele ?? 0) <= 0) {
              // 予告終了 -> 実爆発を投入
              const next = h.next || { r: h.r || 80, ttl: 0.14, dmg: h.dmg || 18 };
              const fx = next.fx ?? h.fx;
              hazards.splice(i, 1);
              hazards.push({
                type: 'explosion',
                x: h.x,
                y: h.y,
                r: next.r,
                ttl: next.ttl,
                maxTtl: next.maxTtl ?? next.ttl,
                dmg: next.dmg ?? h.dmg,
                fx,
              });
            }
            continue;
          } else if (h.type === 'explosion') {
            // draw
            const s = toScreen(h.x, h.y);
            const lifeRatio = h.maxTtl > 0 ? Math.max(0, Math.min(1, h.ttl / h.maxTtl)) : 0;
            if (h.fx === 'bomber' && !h._fxSpawned) {
              spawnBomberExplosionFx(h.x, h.y, h.r || 56);
              h._fxSpawned = true;
            }
            if (h.fx === 'bomber') {
              const outer = (h.r || 0) * (1.1 + 0.25 * (1 - lifeRatio));
              const inner = (h.r || 0) * 0.25 * lifeRatio;
              ctx.save();
              ctx.globalCompositeOperation = 'lighter';
              const grad = ctx.createRadialGradient(s.x, s.y, Math.max(0, inner), s.x, s.y, Math.max(outer, 1));
              grad.addColorStop(0, `rgba(255,245,225,${0.45 * lifeRatio})`);
              grad.addColorStop(0.45, `rgba(255,180,90,${0.35 * lifeRatio})`);
              grad.addColorStop(1, 'rgba(255,90,70,0)');
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.arc(s.x, s.y, outer, 0, Math.PI * 2);
              ctx.fill();
              ctx.restore();
            }
            ctx.save();
            ctx.globalAlpha = 0.55 * lifeRatio;
            ctx.fillStyle = 'rgba(255,70,70,0.5)';
            ctx.beginPath();
            ctx.arc(s.x, s.y, h.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            // damage once per hazard
            // 可視性: 画面内（AoE半径ぶんのマージン込み）のときのみヒット判定
            if (!h._hit && invulnT <= 0 && isOnScreen(h.x, h.y, (h.r || 0) + 8) && Math.hypot(player.x - h.x, player.y - h.y) < h.r + player.r) {
              const { hp: taken } = applyPlayerDamage(h.dmg); playerDmgAcc += taken; h._hit = true;
            }
          }
        }

        // enemies render with type-specific styles and telegraphs
        enemies.forEach(e => {
          if (!e.alive) return; const s = toScreen(e.x, e.y);
          // telegraphs
          if (e.type === 'dasher' && (e.state === 'wind')) {
            const tgt = pickNearestTarget(e.x, e.y, e);
            const dx = tgt.x - e.x, dy = tgt.y - e.y; const dist = Math.hypot(dx, dy) || 1; const ang = Math.atan2(dy, dx);
            ctx.save(); ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.lineWidth = 3; ctx.setLineDash([8, 8]); ctx.beginPath();
            ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + Math.cos(ang) * 120, s.y + Math.sin(ang) * 120); ctx.stroke(); ctx.restore();
          }
          if (e.type === 'bomber' && (e.fuse ?? -1) >= 0) {
            ctx.save(); const p = toScreen(e.x, e.y); ctx.strokeStyle = 'rgba(255,60,60,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, (e.blast?.r ?? 56), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
          }
          // body
          ctx.save();
          let color = '#f78166';
          if (e.type === 'shooter') color = '#f59e0b';
          else if (e.type === 'zig') color = '#ef4444';
          else if (e.type === 'dasher') color = '#ef4444';
          else if (e.type === 'bomber') color = '#e11d48';
          else if (e.type === 'tank') color = '#6b7280';
          else if (e.type === 'freezer') color = '#93c5fd';
          else if (e.type === 'reaper') color = '#111827';
          else if (e.type === 'special') color = '#fbbf24';
          else if (e.type === 'boss') color = '#7c3aed';
          let drewImg = false;
          if (e.boss && e.name === '中型個体' && midBossImg.complete && midBossImg.naturalWidth > 0) {
            try {
              ctx.drawImage(midBossImg, s.x - MID_BOSS_DRAW_SIZE / 2, s.y - MID_BOSS_DRAW_SIZE / 2, MID_BOSS_DRAW_SIZE, MID_BOSS_DRAW_SIZE);
              drewImg = true;
            } catch { }
          } else if (e.boss && e.name === '大型個体' && bossImg.complete && bossImg.naturalWidth > 0) {
            try {
              ctx.drawImage(bossImg, s.x - BOSS_DRAW_SIZE / 2, s.y - BOSS_DRAW_SIZE / 2, BOSS_DRAW_SIZE, BOSS_DRAW_SIZE);
              drewImg = true;
            } catch { }
          } else if (e.type === 'reaper' && reaperImg.complete && reaperImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2, 48);
              ctx.drawImage(reaperImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'special' && specialImg.complete && specialImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2, 48);
              ctx.drawImage(specialImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'shooter' && shooterImg.complete && shooterImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.2, 40);
              ctx.drawImage(shooterImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'dasher' && dasherImg.complete && dasherImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.2, 40);
              ctx.drawImage(dasherImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'tank' && tankImg.complete && tankImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.4, 44);
              ctx.drawImage(tankImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'ignitionSuppressor' && ignitionSuppressorImg.complete && ignitionSuppressorImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.4, 44);
              ctx.drawImage(ignitionSuppressorImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'zig' && zigImg.complete && zigImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.1, 36);
              ctx.drawImage(zigImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'freezer' && freezerImg.complete && freezerImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.2, 40);
              ctx.drawImage(freezerImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'bomber' && bomberImg.complete && bomberImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.4, 44);
              ctx.drawImage(bomberImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          } else if (e.type === 'barrage' && barrageImg.complete && barrageImg.naturalWidth > 0) {
            try {
              const drawSize = Math.max(e.r * 2.6, 52);
              ctx.drawImage(barrageImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { }
          }
          if (!drewImg && defaultEnemyImg && defaultEnemyImg.complete && defaultEnemyImg.naturalWidth > 0) {
            const drawSize = Math.max(e.r * 2, 32);
            try {
              ctx.drawImage(defaultEnemyImg, s.x - drawSize / 2, s.y - drawSize / 2, drawSize, drawSize);
              drewImg = true;
            } catch { /* ignore drawing errors */ }
          }
          if (!drewImg) {
            if (e.type === 'shooter') {
              const bodyRadius = Math.max(e.r, 8);
              const wingSpan = bodyRadius * 2.5;
              const wingHeight = bodyRadius * 1.4;
              const wingAttach = bodyRadius * 0.45;
              ctx.save();
              ctx.translate(s.x, s.y);
              ctx.fillStyle = 'rgba(253,224,71,0.6)';
              ctx.strokeStyle = 'rgba(251,191,36,0.85)';
              ctx.lineWidth = Math.max(1.2, bodyRadius * 0.22);
              for (const dir of [-1, 1]) {
                ctx.save();
                ctx.scale(dir, 1);
                ctx.beginPath();
                ctx.moveTo(wingAttach, -bodyRadius * 0.35);
                ctx.quadraticCurveTo(wingSpan, -wingHeight, wingSpan * 0.7, -bodyRadius * 0.15);
                ctx.quadraticCurveTo(wingSpan * 0.85, 0, wingSpan * 0.7, bodyRadius * 0.15);
                ctx.quadraticCurveTo(wingSpan, wingHeight, wingAttach, bodyRadius * 0.35);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
              }
              ctx.shadowColor = 'rgba(245,158,11,0.45)';
              ctx.shadowBlur = bodyRadius * 0.9;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(0, 0, bodyRadius, 0, Math.PI * 2);
              ctx.fill();
              ctx.shadowBlur = 0;
              ctx.strokeStyle = 'rgba(255,255,255,0.75)';
              ctx.lineWidth = Math.max(1, bodyRadius * 0.18);
              ctx.stroke();
              ctx.strokeStyle = 'rgba(245,158,11,0.9)';
              ctx.lineWidth = Math.max(1, bodyRadius * 0.12);
              ctx.beginPath();
              ctx.moveTo(-bodyRadius * 0.4, -bodyRadius * 0.3);
              ctx.quadraticCurveTo(0, -bodyRadius * 0.6, bodyRadius * 0.4, -bodyRadius * 0.3);
              ctx.stroke();
              ctx.restore();
              drewImg = true;
            } else {
              ctx.fillStyle = color;
              ctx.beginPath(); ctx.arc(s.x, s.y, e.r, 0, Math.PI * 2); ctx.fill();
            }
          }
          if (e.elem) {
            const glow = elementColors[e.elem] || '#ffffff';
            ctx.shadowColor = glow;
            ctx.shadowBlur = 10;
            ctx.strokeStyle = glow;
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(s.x, s.y, e.r + 2, 0, Math.PI * 2); ctx.stroke();

            // draw cursor above attribute enemies
            ctx.shadowBlur = 0;
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.moveTo(s.x, s.y - e.r - 6);
            ctx.lineTo(s.x - 6, s.y - e.r - 18);
            ctx.lineTo(s.x + 6, s.y - e.r - 18);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          if (e.stun && e.stun > 0) {
            const spin = e.t * 8;
            const pulse = 1 + 0.25 * Math.sin(e.t * 12);
            const bob = Math.sin(e.t * 6) * 2;
            const starOuter = STUN_STAR_BASE_OUTER * pulse;
            const starInner = starOuter * 0.5;
            const ringRadius = starOuter + 4;
            const offsetY = s.y - e.r - 10 + bob;
            const { star, ring, baseOuter, baseRing } = stunSprites;

            if (star?.canvas) {
              const referenceOuter = baseOuter || STUN_STAR_BASE_OUTER;
              const starScale = referenceOuter > 0 ? starOuter / referenceOuter : pulse;
              ctx.save();
              ctx.translate(s.x, offsetY);
              ctx.rotate(spin);
              ctx.scale(starScale, starScale);
              ctx.drawImage(star.canvas, -star.size / 2, -star.size / 2);
              ctx.restore();
            } else {
              ctx.save();
              ctx.translate(s.x, offsetY);
              ctx.rotate(spin);
              ctx.fillStyle = 'rgba(255,240,0,0.95)';
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              for (let i = 0; i < 5; i++) {
                const outerAng = (i * 2 * Math.PI) / 5;
                const innerAng = outerAng + Math.PI / 5;
                const ox = Math.cos(outerAng) * starOuter;
                const oy = Math.sin(outerAng) * starOuter;
                if (i === 0) ctx.moveTo(ox, oy);
                else ctx.lineTo(ox, oy);
                const ix = Math.cos(innerAng) * starInner;
                const iy = Math.sin(innerAng) * starInner;
                ctx.lineTo(ix, iy);
              }
              ctx.closePath();
              ctx.fill();
              ctx.stroke();
              ctx.restore();
            }

            if (ring?.canvas) {
              const referenceRing = baseRing || STUN_RING_BASE_RADIUS;
              const ringScale = referenceRing > 0 ? ringRadius / referenceRing : pulse;
              ctx.save();
              ctx.translate(s.x, offsetY);
              ctx.scale(ringScale, ringScale);
              ctx.drawImage(ring.canvas, -ring.size / 2, -ring.size / 2);
              ctx.restore();
            } else {
              ctx.save();
              ctx.translate(s.x, offsetY);
              ctx.strokeStyle = 'rgba(255,240,0,0.7)';
              ctx.lineWidth = 1.2;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
              ctx.stroke();
              ctx.restore();
            }
          }
          // boss head HP bar
          if (e.boss) {
            const w = 64, h = 6, pad = 18; const ratio = Math.max(0, Math.min(1, e.hp / (e.maxHp || e.hp || 1)));
            ctx.save(); ctx.translate(s.x, s.y - e.r - pad);
            ctx.fillStyle = '#000b'; ctx.fillRect(-w / 2, -h / 2, w, h);
            ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
            ctx.fillRect(-w / 2, -h / 2, w * ratio, h);
            ctx.strokeStyle = '#ffffffaa'; ctx.lineWidth = 1; ctx.strokeRect(-w / 2 + 0.5, -h / 2 + 0.5, w - 1, h - 1);
            ctx.restore();
          }
        });
        killFxs.forEach(fx => {
          const s = toScreen(fx.x, fx.y);
          const rawAlpha = fx.max > 0 ? fx.ttl / fx.max : 0;
          const alpha = Math.max(0, Math.min(1, rawAlpha));
          if (fx.type === 'blast') {
            const rgb = fx.color ?? '255,140,80';
            const inner = Math.max(0, (fx.inner ?? 0) * 0.6);
            const outer = Math.max(inner + 1, fx.outer ?? fx.r ?? 0);
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const grad = ctx.createRadialGradient(s.x, s.y, inner, s.x, s.y, outer);
            grad.addColorStop(0, `rgba(${rgb},${0.28 * alpha})`);
            grad.addColorStop(0.4, `rgba(${rgb},${0.22 * alpha})`);
            grad.addColorStop(1, 'rgba(255,90,70,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(s.x, s.y, outer, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            return;
          }
          ctx.globalAlpha = alpha;
          if (fx.type === 'ring') {
            ctx.strokeStyle = fx.color ?? '#fffa';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, fx.r, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = fx.color ?? '#ffea00';
            ctx.beginPath();
            ctx.arc(s.x, s.y, Math.max(0, fx.r), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        });
        ctx.fillStyle = '#66ccff';
        orbs.forEach(o => {
          const s = toScreen(o.x, o.y);
          let drew = false;
          if (o.type === 'exp5' && exp5Img && exp5Img.complete && exp5Img.naturalWidth > 0) {
            const size = Math.max(12, o.r * 2) * 1.5 * 1.5;
            try { ctx.drawImage(exp5Img, s.x - size / 2, s.y - size / 2, size, size); drew = true; } catch { drew = false; }
          } else if (o.type !== 'exp5' && expImg && expImg.complete && expImg.naturalWidth > 0) {
            const size = Math.max(12, o.r * 2) * 1.5;
            try { ctx.drawImage(expImg, s.x - size / 2, s.y - size / 2, size, size); drew = true; } catch { drew = false; }
          }
          if (!drew) {
            ctx.beginPath();
            ctx.arc(s.x, s.y, o.r, 0, Math.PI * 2);
            ctx.fill();
          }
        });
        cardOrbs.forEach(o => {
          const s = toScreen(o.x, o.y);
          const img = cardOrbImgs[o.rarity];
          if (img && img.complete) {
            const size = Math.max(12, o.r * 2) * 1.5;
            try { ctx.drawImage(img, s.x - size / 2, s.y - size / 2, size, size); } catch { /* fallback below */ }
          } else {
            ctx.fillStyle = '#ffaa00';
            ctx.beginPath(); ctx.arc(s.x, s.y, o.r, 0, Math.PI * 2); ctx.fill();
          }
        });
        moneys.forEach(m => {
          const s = toScreen(m.x, m.y);
          let img = moneyImg;
          let scale = 1.5;
          if (m.value >= 1000 && rainbowMoneyImg.complete && rainbowMoneyImg.naturalWidth > 0) {
            img = rainbowMoneyImg;
            scale *= 1.5;
          }
          if (img && img.complete && img.naturalWidth > 0) {
            const size = Math.max(12, m.r * 2) * scale;
            ctx.drawImage(img, s.x - size / 2, s.y - size / 2, size, size);
          }
        });
        if (rewardArea) {
          const s = toScreen(rewardArea.x, rewardArea.y);
          ctx.save();
          ctx.fillStyle = 'rgba(250,204,21,0.15)';
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(s.x, s.y, rewardArea.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        if (riskChoiceAreas && riskChoiceAreas.length > 0) {
          for (const area of riskChoiceAreas) {
            if (!area) continue;
            const s = toScreen(area.x, area.y);
            ctx.save();
            let fill = 'rgba(96,165,250,0.14)';
            let stroke = '#60a5fa';
            if (area.type === 'melon') {
              fill = 'rgba(52,211,153,0.14)';
              stroke = '#34d399';
            } else if (area.type === 'money') {
              fill = 'rgba(245,158,11,0.14)';
              stroke = '#f59e0b';
            }
            ctx.fillStyle = fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(s.x, s.y, area.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
            if (typeof area.expiresAt === 'number') {
              const limitSeconds = Math.max(0, Math.floor(area.expiresAt - timeAlive));
              const limitText = `リミット ${limitSeconds}秒`;
              ctx.font = 'bold 18px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              ctx.lineWidth = 4;
              ctx.strokeStyle = '#000a';
              ctx.fillStyle = '#fff';
              const textY = Math.max(20, s.y - area.r - 12);
              ctx.strokeText(limitText, s.x, textY);
              ctx.fillText(limitText, s.x, textY);
            }
            ctx.fillStyle = stroke;
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            let label = '経験値3倍';
            if (area.type === 'melon') label = 'メロンパン5倍';
            else if (area.type === 'money') label = 'マネー3倍';
            ctx.fillText(label, s.x, s.y);
            ctx.restore();
          }
        }
        converters.forEach(c => {
          const s = toScreen(c.x, c.y);
          const size = Math.max(12, c.r * 2) * 1.5;
          if (converterImg.complete && converterImg.naturalWidth > 0) {
            try { ctx.drawImage(converterImg, s.x - size / 2, s.y - size / 2, size, size); } catch (err) { console.warn("Failed to draw converter image:", err); /* fallback below */ }
          } else {
            ctx.fillStyle = '#cc66ff';
            ctx.beginPath(); ctx.arc(s.x, s.y, c.r, 0, Math.PI * 2); ctx.fill();
          }
        });
        atkBoosts.forEach(b => {
          const s = toScreen(b.x, b.y);
          const displayScale = 1.5;
          if (swordImg && swordImg.complete) {
            const baseSize = Math.max(12, b.r * 2) * 1.5;
            const size = baseSize * displayScale;
            try { ctx.drawImage(swordImg, s.x - size / 2, s.y - size / 2, size, size); } catch { /* fallback below */ }
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(s.x, s.y, b.r * displayScale, 0, Math.PI * 2); ctx.fill();
          }
        });
        heals.forEach(h => {
          const s = toScreen(h.x, h.y);
          const type = (h.type || 'heal');
          if (type === 'rainbow' && rainbowImg && rainbowImg.complete) {
            const size = Math.max(18, h.r * 2.4) * 1.6;
            try { ctx.drawImage(rainbowImg, s.x - size / 2, s.y - size / 2, size, size); } catch { /* fallback below */ }
          } else if (type === 'heal' && melonImg && melonImg.complete) {
            const size = Math.max(12, h.r * 2) * 1.5;
            try { ctx.drawImage(melonImg, s.x - size / 2, s.y - size / 2, size, size); } catch { /* fallback below */ }
          } else if (type === 'grimoire') {
            const el = h.elem || 'fire';
            const img = magicBookImgs[el];
            if (img && img.complete) {
              const size = Math.max(14, h.r * 2.2) * 1.5;
              try { ctx.drawImage(img, s.x - size / 2, s.y - size / 2, size, size); } catch { /* fallback below */ }
            } else {
              ctx.fillStyle = elementColors[el] || '#ffaa00';
              ctx.beginPath(); ctx.arc(s.x, s.y, h.r, 0, Math.PI * 2); ctx.fill();
            }
          } else {
            ctx.fillStyle = '#ff66aa';
            ctx.beginPath(); ctx.arc(s.x, s.y, h.r, 0, Math.PI * 2); ctx.fill();
          }
        });

        // global boss HP bar (top HUD) for the first alive boss
        {
          const boss = enemies.find(en => en?.boss && en.alive);
          if (boss) {
            const ratio = Math.max(0, Math.min(1, (boss.maxHp ? boss.hp / boss.maxHp : 0)));
            const barW = Math.min(cvs.width - 40, 480);
            const hudScale = displayScale;
            const barH = Math.max(12, Math.round(12 * hudScale));
            const x = (cvs.width - barW) / 2; const y = Math.round(16 * hudScale);
            ctx.save();
            // shadow/background
            const bgPadding = Math.max(2, Math.round(2 * hudScale));
            ctx.fillStyle = '#000a'; ctx.fillRect(x - bgPadding, y - bgPadding, barW + bgPadding * 2, barH + bgPadding * 2);
            // bar
            ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
            ctx.fillRect(x, y, Math.max(0, barW * ratio), barH);
            ctx.strokeStyle = '#ffffffcc';
            ctx.lineWidth = Math.max(1.5, Math.round(2 * hudScale));
            ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);
            // text
            const labelFontSize = Math.max(14, Math.round(14 * hudScale));
            const textOffset = Math.max(4, Math.round(4 * hudScale));
            ctx.font = `bold ${labelFontSize}px sans-serif`;
            ctx.lineWidth = Math.max(3, Math.round(3 * hudScale));
            ctx.strokeStyle = '#000a'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            const label = `${boss.name || 'BOSS'}  ${Math.max(0, Math.ceil(boss.hp))}/${boss.maxHp}`;
            ctx.strokeText(label, x + barW / 2, y - textOffset);
            ctx.fillText(label, x + barW / 2, y - textOffset);
            ctx.restore();
          }
        }

        refreshHud();

        flushPlayerNumbers(performance.now());
        // flush visual damage numbers for server-authoritative hits
        flushServerDamage();

        if (isSnowStage && snowflakes.length > 0) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.lineCap = 'round';
          for (const flake of snowflakes) {
            const px = flake.baseX + Math.sin(flake.swayPhase) * flake.swayRange;
            const py = flake.y;
            const radius = flake.radius;
            ctx.globalAlpha = 0.75;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(px, py, radius, 0, Math.PI * 2);
            ctx.fill();
            if (radius > 1.6) {
              ctx.globalAlpha = 0.35;
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = Math.max(0.6, radius * 0.4);
              ctx.beginPath();
              ctx.moveTo(px, py - flake.speed * 0.05);
              ctx.lineTo(px, py);
              ctx.stroke();
            }
          }
          ctx.restore();
        }

        ctx.restore();

        if (state.stats.hp <= 0 && state.stats.alive) {
          // Resurrection: if purchased and not used yet -> consume and revive at 50% HP
          if (!state._rezUsed && (state.perks.rez || 0) > 0) {
            state._rezUsed = true;
            state.stats.hp = Math.max(1, Math.floor(state.stats.maxHp * 0.5));
            state._freezeTimeAlive = false;
            // 復活演出＋無敵
            try { Audio?.playSfx?.(state, 'revive'); } catch { try { Audio?.playSfx?.(state, 'levelup'); } catch { } }
            try { playReviveFx(); } catch { }
            invulnT = invulnMax;
            try {
              renderHudPerks();
              const rezBadge = document.querySelector('#hudPerksGame .badge:nth-last-child(1)')
                || document.querySelector('#hudPerks .badge:nth-last-child(1)');
              if (rezBadge && rezBadge.textContent && rezBadge.textContent.startsWith('REZ')) {
                rezBadge.style.animation = 'vlg-blink 0.8s ease 2';
                setTimeout(() => { rezBadge.style.animation = ''; }, 1800);
              }
            } catch { }
          } else {
            state.stats.alive = false;
            state.inGame = false;
            state._freezeTimeAlive = true;
            state.serverGameStartAtSec = null;
            state._svtOffsetMs = 0;
            state._svtSmoothed = false;
            clearActiveTimeouts();
            try { projectiles.length = 0; } catch { }
            try { playGameOverFx(); } catch { }
            try {
              if (hudStats) hudStats.textContent = 'ステータス: 死亡 / 他の人の挑戦を見守っててください。。。';
            } catch { }
            try { Audio?.stopBgm?.(state, true); } catch { try { state.audio.bgmEl?.pause(); } catch { } }
            try { Audio?.playSfx?.(state, 'gameover'); } catch { }
            state._deathAt = performance.now();
            sendEvent({ type: 'death', kills, duration: Math.round(timeAlive) }).catch(() => { });
            const aliveIds = Object.keys(state.allies).filter(pid => state.allies[pid]?.alive);
            if (aliveIds.length === 0) {
              showPersonalResult(Math.round(timeAlive), kills, 2000);
            } else {
              state.spectating = true;
              state._spectateTarget = aliveIds[Math.floor(Math.random() * aliveIds.length)];
              state._nextSpectateSwitch = performance.now() + 5000;
            }
          }
        }
        if (state.stats.alive) {
          applyCameraPosition(player.x, player.y, 'player-follow');
        } else {
          let ix = 0, iy = 0;
          if (pressed.has('ArrowLeft') || pressed.has('a')) ix -= 1;
          if (pressed.has('ArrowRight') || pressed.has('d')) ix += 1;
          if (pressed.has('ArrowUp') || pressed.has('w')) iy -= 1;
          if (pressed.has('ArrowDown') || pressed.has('s')) iy += 1;
          const moving = ix !== 0 || iy !== 0;
          updateEnergy(dt, moving);
          if (moving) {
            const sp = player.spd * dt;
            const len = Math.hypot(ix, iy) || 0;
            if (len > 0) { ix /= len; iy /= len; }
            const camNx = state.camera.x + ix * sp;
            const camNy = state.camera.y + iy * sp;
            applyCameraPosition(camNx, camNy, 'death-drag');
            state.spectating = false;
          } else {
            if (state.spectating) {
              const nowSp = performance.now();
              let target = state._spectateTarget ? state.allies[state._spectateTarget] : null;
              if (!target || !target.alive || nowSp >= (state._nextSpectateSwitch || 0)) {
                const alive = Object.keys(state.allies).filter(pid => state.allies[pid]?.alive);
                if (alive.length > 0) {
                  state._spectateTarget = alive[Math.floor(Math.random() * alive.length)];
                  target = state.allies[state._spectateTarget];
                  state._nextSpectateSwitch = nowSp + 5000;
                } else {
                  state.spectating = false;
                  target = null;
                }
              }
              if (target) { applyCameraPosition(target.x, target.y, 'spectate-follow'); }
            } else {
              const alive = Object.keys(state.allies).filter(pid => state.allies[pid]?.alive);
              if (alive.length > 0) {
                state.spectating = true;
                state._spectateTarget = alive[Math.floor(Math.random() * alive.length)];
                state._nextSpectateSwitch = performance.now() + 5000;
              }
            }
          }
        }
      } // end while loop
      updateCoordinateHud(player.x, player.y);
      if (!state._hasPersonalResult) { raf = setTimeout(tick, 33); state._raf = raf; }
    }
    // define real openLevelUp that closes over helpers and state
    openLevelUp = function () {
      if (!levelUpModal || !levelChoices) return;
      if ((state.pendingLvls || 0) <= 0) return;
      if (!state.pauseBy.has(state.me?.playerId)) {
        const token = allocatePauseTokenFor(state.me.playerId);
        const result = markPause(state.me.playerId, state.me?.privateId, token);
        if (result) {
          const payload = { type: 'pause' };
          if (result.token != null) payload.token = result.token;
          sendEvent(payload).catch(() => { });
        }
      }
      try { Audio?.playSfx?.(state, 'levelup'); } catch { }

      const counts = state.upgradeCounts || (state.upgradeCounts = {});

      try { playLevelUpFx(); } catch { }

      const levelHeading = levelUpModal.querySelector('h3');
      let remaining = 15;
      let rerolls = 1;
      let excludeUsed = false;
      let excludePending = false;
      let excludeBtn = null;
      let rerollBtn = null;
      const bannedLevelUpIds = ensureRunExcludedLevelUps();
      let buttons = [];
      let idx = 0;
      let keyHandler;
      let autoTimer;
      let countdownTimer;
      if (levelHeading) levelHeading.textContent = `レベルアップ！（${remaining}）`;

      const getExcludeTokenCount = () => Math.max(0, state.excludeTokens || 0);

      function updateExcludeButtonLabel() {
        if (!excludeBtn) return;
        if (excludePending) {
          excludeBtn.textContent = '除外対象を選択';
        } else {
          excludeBtn.textContent = `除外 (${getExcludeTokenCount()})`;
        }
      }

      function updateRerollButtonState() {
        if (!rerollBtn) return;
        rerollBtn.disabled = excludePending;
      }

      const getChoiceLimit = (choice, charSkillRef = null) => {
        if (!choice) return UPGRADE_LIMIT;
        if (charSkillRef && choice.id === charSkillRef.id) return SKILL_LIMIT;
        if (typeof choice.limit === 'number') return choice.limit;
        return UPGRADE_LIMIT;
      };

      function pickChoices() {
        const atkLevel = counts['atk+'] || 0;
        const atkInc = 5 * (atkLevel + 1);
        const pool = [
          { id: 'atk+', label: `攻撃力 +${atkInc}`, apply: () => state.stats.atk += atkInc },
          {
            id: 'hp+', label: '最大HP +10', apply: () => {
              state.stats.maxHp += 10;
              const healAmount = applyHealBonus(10);
              const healed = Math.round(healAmount);
              state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + healAmount);
              try { spawnHealNumber(state.camera.x, state.camera.y, healed); } catch { }
            }
          },
          { id: 'spd+', label: '移動速度 +10%', apply: () => { try { player.spd *= 1.10; } catch { } } },
          { id: 'regen', label: '再生 +0.5/秒', apply: () => { openLevelUp.regen = (openLevelUp.regen || 0) + 0.5; } },
          { id: 'rate', label: '攻撃間隔 -5%', apply: () => { openLevelUp.rateMul = (openLevelUp.rateMul || 1) * 0.95; } },
          { id: 'multi', label: '弾数 +1', apply: () => { cfg.common.count = (cfg.common.count || 1) + 1; } },
          { id: 'range', label: '射程 +20%', apply: () => { cfg.common.range *= 1.2; cfg.okp.range *= 1.2; } },
          { id: 'exp+', label: '吸収範囲 +5', apply: () => { state.stats.expRange = (state.stats.expRange || 80) + 5; } },
          {
            id: 'supportBook',
            limit: getSupportBookMax(),
            label: '支援魔法：本（周囲に本を追加）',
            apply: () => {
              const next = Math.min(getSupportBookMax(), (openLevelUp.supportBooks || 0) + 1);
              openLevelUp.supportBooks = next;
            }
          },
          {
            id: 'supportLaser',
            limit: getSupportLaserMax(),
            label: '支援魔法：レーザー（反射レーザーを追加）',
            apply: () => {
              const next = Math.min(getSupportLaserMax(), Math.max(0, (openLevelUp.supportLasers || 0) + 1));
              openLevelUp.supportLasers = next;
            }
          },
          {
            id: 'supportBomb',
            limit: getSupportBombMax(),
            label: '支援魔法：爆撃（ランダム地点を空爆）',
            apply: () => {
              const next = Math.min(getSupportBombMax(), Math.max(0, (openLevelUp.supportBombs || 0) + 1));
              openLevelUp.supportBombs = next;
            }
          },
        ];
        const charSkill = {
          id: 'skill',
          label: `${charName}のスキル強化`,
          apply: () => {
            switch (charName) {
              case 'ナタリア':
                cfg.nata.regen += 0.2;
                cfg.nata.leftDps += 1;
                cfg.common.interval *= 0.95;
                break;
              case 'おきーぱー':
                cfg.okp.dmg += 2;
                cfg.okp.interval *= 0.95;
                cfg.okp.count = (cfg.okp.count || 1) + 1;
                cfg.okp.pr *= 1.01;
                break;
              case '恋恋': {
                const level = (counts['skill'] || 0) + 1;
                const dmgGain = 6 + (level - 1) * 2;
                cfg.koi.dmg += dmgGain;
                cfg.koi.interval *= 0.95;
                break;
              }
              case 'メロ':
                cfg.mero.charge *= 0.82;
                break;
              case 'あたち': {
                const level = (counts['skill'] || 0) + 1;
                cfg.atc.dps += 5 * level;
                cfg.atc.radius += 10;
                break;
              }
              case 'ハクシキ':
                cfg.haku.dps += 3;
                cfg.haku.radius += 8;
                break;
              case 'フルムーン': {
                const level = (counts['skill'] || 0) + 1;
                const dpsGain = level + 2;
                const hpGain = cfg.fullmoon.skillHpGain ?? 60;
                fullmoonShieldHpBonus += hpGain;
                cfg.fullmoon.dmg += dpsGain;
                if (shield) {
                  const newMaxHp = getFullmoonShieldMaxHp();
                  const bonus = Math.max(0, newMaxHp - shield.maxHp);
                  shield.maxHp = newMaxHp;
                  shield.hp = Math.min(newMaxHp, shield.hp + bonus);
                }
                break;
              }
              case 'U': {
                cfg.u.dps += 0.4;
                const baseZone = cfg.u.baseZone = Math.max(0.2, (cfg.u.baseZone ?? 0.5) - 0.05);
                if (cfg.u.zone == null || cfg.u.zone > baseZone) {
                  cfg.u.zone = baseZone;
                }
                break;
              }
              case 'あんどー':
                cfg.ando.dmg += 2;
                cfg.ando.hp += 5;
                if (cfg.ando.max < 15) cfg.ando.max += 1;
                cfg.ando.interval *= 0.95;
                break;
            }
          }
        };
        const availPool = pool.filter(p => !bannedLevelUpIds.has(p.id) && (counts[p.id] || 0) < getChoiceLimit(p));
        const charAvailable = charSkill && !bannedLevelUpIds.has(charSkill.id) && (counts[charSkill.id] || 0) < getChoiceLimit(charSkill, charSkill);
        let choices;
        const mergedPool = availPool.slice();
        if (charAvailable) mergedPool.push(charSkill);
        if (mergedPool.length === 0) {
          choices = [{ id: 'money', label: 'マネーを取得 +100', apply: () => { state.gold += 100; } }];
        } else {
          choices = mergedPool.sort(() => Math.random() - 0.5).slice(0, Math.min(3, mergedPool.length));
        }
        return { choices, charSkill };
      }

      function handleExcludeChoice(choice) {
        excludePending = false;
        updateRerollButtonState();
        if (!choice || typeof choice.id !== 'string' || choice.id === 'money') {
          updateExcludeButtonLabel();
          showToast('この選択肢は除外できません', 'error');
          startTimers();
          return;
        }
        if (bannedLevelUpIds.has(choice.id)) {
          updateExcludeButtonLabel();
          showToast('既に除外済みです', 'error');
          startTimers();
          return;
        }
        const tokens = getExcludeTokenCount();
        if (tokens <= 0) {
          updateExcludeButtonLabel();
          showToast('除外を所持していません', 'error');
          startTimers();
          return;
        }
        state.excludeTokens = tokens - 1;
        saveExcludeTokens();
        excludeUsed = true;
        bannedLevelUpIds.add(choice.id);
        showToast(`「${choice.label}」を戦闘終了まで除外しました`);
        clearTimeout(autoTimer);
        clearInterval(countdownTimer);
        remaining = 15;
        if (levelHeading) levelHeading.textContent = `レベルアップ！（${remaining}）`;
        renderChoices();
        startTimers();
      }

      function renderChoices() {
        const { choices, charSkill } = pickChoices();
        levelChoices.innerHTML = '';
        excludeBtn = null;
        rerollBtn = null;
        if (excludeUsed) excludePending = false;
        choices.forEach(c => {
          const limit = c.id === 'money' ? 0 : getChoiceLimit(c, charSkill);
          const remainingCount = c.id === 'money' ? 0 : Math.max(0, limit - (counts[c.id] || 0));
          const btn = document.createElement('button');
          btn.textContent = c.id === 'money' ? c.label : `${c.label} (残り${remainingCount})`;
          btn.onclick = () => {
            if (excludePending) {
              handleExcludeChoice(c);
              return;
            }
            clearTimeout(autoTimer);
            clearInterval(countdownTimer);
            if (levelHeading) levelHeading.textContent = 'レベルアップ！';
            c.apply();
            if (c.id !== 'money') counts[c.id] = (counts[c.id] || 0) + 1;
            const remLimit = c.id === 'money' ? 0 : getChoiceLimit(c, charSkill);
            const rem = c.id === 'money' ? 0 : Math.max(0, remLimit - counts[c.id]);
            const line = document.createElement('div');
            line.textContent = c.id === 'money' ? `強化: ${c.label}` : `強化: ${c.label} (残り${rem})`;
            state.pendingLvls = Math.max(0, (state.pendingLvls || 1) - 1);
            levelUpModal.classList.add('hidden');
            window.removeEventListener('keydown', keyHandler, true);
            openLevelUp.autoTimer = null;
            openLevelUp.countdownTimer = null;
            openLevelUp.keyHandler = null;
            if ((state.pendingLvls || 0) > 0) {
              setTimeout(() => openLevelUp(), 0);
            } else {
              const resumeInfo = clearPause(state.me.playerId);
              const pc = state.room?.members?.length || 1;
              const freezeMs = [0, 500, 750, 1000, 1500, 2000][Math.min(pc, 5)];
              state._enemyFreezeUntil = performance.now() + freezeMs;
              const payload = { type: 'resume' };
              if (resumeInfo?.token != null) payload.token = resumeInfo.token;
              setTimeout(() => {
                sendEvent(payload).catch(() => { });
              }, freezeMs);
            }
          };
          levelChoices.appendChild(btn);
        });

        if (rerolls > 0) {
          rerollBtn = document.createElement('button');
          rerollBtn.textContent = `リロール (${rerolls})`;
          rerollBtn.onclick = () => {
            rerolls -= 1;
            clearTimeout(autoTimer); clearInterval(countdownTimer);
            remaining = 15;
            if (levelHeading) levelHeading.textContent = `レベルアップ！（${remaining}）`;
            renderChoices();
            startTimers();
          };
          levelChoices.appendChild(rerollBtn);
        }

        if (!excludeUsed && getExcludeTokenCount() > 0) {
          excludeBtn = document.createElement('button');
          updateExcludeButtonLabel();
          excludeBtn.onclick = () => {
            if (excludePending) {
              excludePending = false;
              updateExcludeButtonLabel();
              updateRerollButtonState();
              return;
            }
            if (getExcludeTokenCount() <= 0) {
              updateExcludeButtonLabel();
              showToast('除外を所持していません', 'error');
              return;
            }
            excludePending = true;
            showToast('除外する選択肢をクリックしてください');
            updateExcludeButtonLabel();
            updateRerollButtonState();
          };
          levelChoices.appendChild(excludeBtn);
        }

        buttons = Array.from(levelChoices.querySelectorAll('button'));
        idx = 0;
        buttons[0]?.focus();
        updateExcludeButtonLabel();
        updateRerollButtonState();
      }

      function startTimers() {
        clearTimeout(autoTimer);
        clearInterval(countdownTimer);
        autoTimer = setTimeout(() => {
          if (!levelUpModal.classList.contains('hidden')) {
            buttons[0]?.click();
          }
        }, 15000);
        countdownTimer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(countdownTimer);
          }
          if (levelHeading) levelHeading.textContent = `レベルアップ！（${remaining}）`;
        }, 1000);
        openLevelUp.autoTimer = autoTimer;
        openLevelUp.countdownTimer = countdownTimer;
      }

      renderChoices();
      startTimers();

      keyHandler = (ev) => {
        if (levelUpModal.classList.contains('hidden')) return;
        switch (ev.key) {
          case 'ArrowDown':
          case 'ArrowRight':
            idx = (idx + 1) % buttons.length;
            buttons[idx].focus();
            ev.preventDefault();
            break;
          case 'ArrowUp':
          case 'ArrowLeft':
            idx = (idx - 1 + buttons.length) % buttons.length;
            buttons[idx].focus();
            ev.preventDefault();
            break;
          case 'Enter':
            buttons[idx].click();
            ev.preventDefault();
            break;
          default:
            if (/^[1-9]$/.test(ev.key)) {
              const n = parseInt(ev.key, 10) - 1;
              if (buttons[n]) buttons[n].click();
            }
        }
      };
      addListener(window, 'keydown', keyHandler, true);
      levelUpModal.classList.remove('hidden');
      openLevelUp.keyHandler = keyHandler;
    };
    // reset level-up modifiers for new game loop
    openLevelUp.rateMul = 1;
    openLevelUp.regen = 0;
    openLevelUp.supportBooks = 0;
    openLevelUp.supportLasers = 0;
    openLevelUp.supportBombs = 0;

    function openCardSelect(rarity) {
      if (!cardSelectModal || !cardSelectChoices) return;
      if (state.deck.length >= 3) { showToast('デッキがいっぱいです', 'error'); return; }
      let pool = cardDefs
        .filter(c => c.rarity === rarity && state.cards[c.id])
        .filter(c => !(state.cardEaterUsedThisBattle && c.id === 'cardEater'));
      const bannedCardIds = ensureRunExcludedCards();
      pool = pool.filter(card => !bannedCardIds.has(card.id));
      if (!pool.length) { showToast('利用可能なカードがありません', 'error'); return; }
      let rerolls = 1;
      let excludeUsed = false;
      let excludePending = false;
      let excludeBtn = null;
      let rerollBtn = null;
      let buttons = [];
      let selectedIndex = 0;
      let autoTimer;
      let countdownTimer;
      let remaining = 15;
      let keyHandler;
      if (cardSelectHeading) cardSelectHeading.textContent = `カード選択（${remaining}）`;

      const getExcludeTokenCount = () => Math.max(0, state.excludeTokens || 0);

      function updateExcludeButtonLabel() {
        if (!excludeBtn) return;
        if (excludePending) {
          excludeBtn.textContent = '除外対象を選択';
        } else {
          excludeBtn.textContent = `除外 (${getExcludeTokenCount()})`;
        }
      }

      function updateRerollButtonState() {
        if (!rerollBtn) return;
        rerollBtn.disabled = excludePending;
      }

      function resumeFromCardSelect() {
        cardSelectModal.classList.add('hidden');
        window.removeEventListener('keydown', keyHandler, true);
        const resumeInfo = clearPause(state.me.playerId);
        const pc = state.room?.members?.length || 1;
        const freezeMs = [0, 500, 750, 1000, 1500, 2000][Math.min(pc, 5)];
        state._enemyFreezeUntil = performance.now() + freezeMs;
        const payload = { type: 'resume' };
        if (resumeInfo?.token != null) payload.token = resumeInfo.token;
        setTimeout(() => { sendEvent(payload).catch(() => { }); }, freezeMs);
      }

      function handleExcludeCard(card) {
        excludePending = false;
        updateRerollButtonState();
        if (!card || typeof card.id !== 'string') {
          updateExcludeButtonLabel();
          showToast('このカードは除外できません', 'error');
          startTimers();
          return;
        }
        if (bannedCardIds.has(card.id)) {
          updateExcludeButtonLabel();
          showToast('既に除外済みのカードです', 'error');
          startTimers();
          return;
        }
        const tokens = getExcludeTokenCount();
        if (tokens <= 0) {
          updateExcludeButtonLabel();
          showToast('除外を所持していません', 'error');
          startTimers();
          return;
        }
        state.excludeTokens = tokens - 1;
        saveExcludeTokens();
        excludeUsed = true;
        bannedCardIds.add(card.id);
        pool = pool.filter(c => c.id !== card.id);
        showToast(`カード「${card.name}」を戦闘終了まで除外しました`);
        clearTimeout(autoTimer);
        clearInterval(countdownTimer);
        remaining = 15;
        if (cardSelectHeading) cardSelectHeading.textContent = `カード選択（${remaining}）`;
        if (!pool.length) {
          updateExcludeButtonLabel();
          showToast('選択肢がなくなったためカード選択を終了しました', 'info');
          resumeFromCardSelect();
          return;
        }
        renderChoices();
        startTimers();
      }

      function renderChoices() {
        const choices = pool.sort(() => Math.random() - 0.5).slice(0, Math.min(3, pool.length));
        cardSelectChoices.innerHTML = '';
        excludeBtn = null;
        rerollBtn = null;
        if (excludeUsed) excludePending = false;
        choices.forEach(card => {
          const btn = document.createElement('button');
          btn.textContent = `${card.name} (属性${card.attr} レア${card.rarity}) - ${card.effect}`;
          btn.onclick = () => {
            if (excludePending) {
              handleExcludeCard(card);
              return;
            }
            clearTimeout(autoTimer); clearInterval(countdownTimer);
            if (cardSelectHeading) cardSelectHeading.textContent = 'カード選択';
            state.deck.push(card);
            refreshCardDeck();
            resumeFromCardSelect();
          };
          cardSelectChoices.appendChild(btn);
        });

        if (rerolls > 0) {
          rerollBtn = document.createElement('button');
          rerollBtn.textContent = `リロール (${rerolls})`;
          rerollBtn.onclick = () => {
            rerolls -= 1;
            clearTimeout(autoTimer); clearInterval(countdownTimer);
            remaining = 15;
            if (cardSelectHeading) cardSelectHeading.textContent = `カード選択（${remaining}）`;
            renderChoices();
            startTimers();
          };
          cardSelectChoices.appendChild(rerollBtn);
        }

        if (!excludeUsed && getExcludeTokenCount() > 0) {
          excludeBtn = document.createElement('button');
          updateExcludeButtonLabel();
          excludeBtn.onclick = () => {
            if (excludePending) {
              excludePending = false;
              updateExcludeButtonLabel();
              updateRerollButtonState();
              return;
            }
            if (getExcludeTokenCount() <= 0) {
              updateExcludeButtonLabel();
              showToast('除外を所持していません', 'error');
              return;
            }
            excludePending = true;
            showToast('除外するカードをクリックしてください');
            updateExcludeButtonLabel();
            updateRerollButtonState();
          };
          cardSelectChoices.appendChild(excludeBtn);
        }

        buttons = Array.from(cardSelectChoices.querySelectorAll('button'));
        selectedIndex = 0;
        buttons[selectedIndex]?.focus();
        updateExcludeButtonLabel();
        updateRerollButtonState();
      }

      function startTimers() {
        clearTimeout(autoTimer); clearInterval(countdownTimer);
        autoTimer = setTimeout(() => { cardSelectChoices.querySelector('button')?.click(); }, 15000);
        countdownTimer = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) clearInterval(countdownTimer);
          if (cardSelectHeading) cardSelectHeading.textContent = `カード選択（${remaining}）`;
        }, 1000);
      }

      renderChoices();
      startTimers();

      keyHandler = (ev) => {
        if (cardSelectModal.classList.contains('hidden')) return;
        const len = buttons.length;
        switch (ev.key) {
          case 'ArrowUp':
          case 'ArrowLeft':
            selectedIndex = (selectedIndex + len - 1) % len;
            buttons[selectedIndex]?.focus();
            ev.preventDefault();
            break;
          case 'ArrowDown':
          case 'ArrowRight':
            selectedIndex = (selectedIndex + 1) % len;
            buttons[selectedIndex]?.focus();
            ev.preventDefault();
            break;
          case 'Enter':
            buttons[selectedIndex]?.click();
            ev.preventDefault();
            break;
          default:
            if (/^[1-3]$/.test(ev.key)) {
              const n = parseInt(ev.key, 10) - 1;
              buttons[n]?.click();
            }
        }
      };
      addListener(window, 'keydown', keyHandler, true);
      cardSelectModal.classList.remove('hidden');
      cardSelectModal.classList.remove('rarity1', 'rarity2', 'rarity3', 'rarity4');
      cardSelectModal.classList.add(`rarity${rarity}`);
      if (!state.pauseBy.has(state.me?.playerId)) {
        const token = allocatePauseTokenFor(state.me.playerId);
        const result = markPause(state.me.playerId, state.me?.privateId, token);
        if (result) {
          const payload = { type: 'pause' };
          if (result.token != null) payload.token = result.token;
          sendEvent(payload).catch(() => { });
        }
      }
    }
    const cheats = state.cheats || {};
    if (cheats.mass) spawnNeutralWave();
    if (cheats.midBoss) spawnMidBoss();
    if (cheats.boss) spawnBoss();
    if (cheats.reaper) spawnReapers();
    if (cheats.reward) spawnRewardArea();
    if (cheats.riskReward) spawnRiskRewardAreas(0);
    if (cheats.items) {
      for (let i = 0; i < 3; i++) {
        spawnHealPickup();
        spawnMoneyPickup();
        spawnAtkBoostPickup();
      }
      for (let r = 1; r <= 4; r++) {
        for (let i = 0; i < 3; i++) {
          spawnCardOrb(r);
        }
      }
    }

    setTimeout(tick, 33);
  }

  // UI wiring
  function ensureClientId() {
    const storageKey = 'vlg.clientId';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const length = 16;
    const minReuse = 8;
    const makeExtra = (count) => Array.from({ length: count }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    try {
      const stored = localStorage.getItem(storageKey);
      if (typeof stored === 'string' && stored) {
        const normalized = stored.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (normalized.length >= minReuse) {
          if (normalized.length >= length) {
            const trimmed = normalized.slice(0, length);
            try { localStorage.setItem(storageKey, trimmed); } catch { }
            return trimmed;
          }
          const supplemented = (normalized + makeExtra(length - normalized.length)).slice(0, length);
          try { localStorage.setItem(storageKey, supplemented); } catch { }
          return supplemented;
        }
      }
    } catch { }
    const fresh = makeExtra(length);
    try { localStorage.setItem(storageKey, fresh); } catch { }
    return fresh;
  }
  const clientId = ensureClientId();
  // name set/save
  function loadSavedName() {
    try { const n = localStorage.getItem('vlg.playerName') || ''; saveName(n); } catch { }
  }
  function saveName(name) {
    name = (name || '').trim().slice(0, 10);
    if (playerNameInput) playerNameInput.value = name;
    try { localStorage.setItem('vlg.playerName', name); if (currentName) currentName.textContent = name || '未設定'; } catch { }
    return name;
  }
  if (btnSetName) btnSetName.onclick = () => { const n = saveName(playerNameInput.value); showToast(n ? `名前を「${n}」に設定しました` : '未設定にしました'); };

  $('#btnCreateRoom').onclick = async () => {
    const btnCreate = $('#btnCreateRoom');
    const btnJoin = $('#btnJoinRandom');
    if (!btnCreate || btnCreate.disabled) return;
    try { Audio?.playSfx?.(state, 'ok'); } catch { }
    const prevCreateText = btnCreate.textContent;
    btnCreate.disabled = true; if (btnJoin) btnJoin.disabled = true;
    btnCreate.textContent = '通信中・・・';
    try {
      const name = saveName(playerNameInput.value || localStorage.getItem('vlg.playerName') || `P${Math.floor(Math.random() * 1000)}`);
      let res;
      try {
        res = await api.createRoom(name, chkRoomPassword?.checked);
      } catch (err) {
        console.error('createRoom:requestFailed', err);
        showToast(`部屋作成 失敗: サーバーに接続できません (${err?.message ?? err})`, 'error');
        return;
      }
      if (!res || typeof res !== 'object') {
        showToast('部屋作成 失敗: サーバー応答を確認できませんでした (rid:-)', 'error');
        return;
      }
      const rid = res.rid || '-';
      if (!res.ok) { showToast(`部屋作成 失敗: ${res.error || '不明なエラー'} (rid:${rid})`, 'error'); return; }
      if (!res.room || !res.playerId || !res.authToken) {
        console.error('createRoom:invalidResponse', res);
        showToast(`部屋作成 失敗: サーバー応答が不正です (rid:${rid})`, 'error');
        return;
      }
      if (res.ok) {
        state.me = {
          playerId: res.publicId || res.playerId,
          publicId: res.publicId || res.playerId,
          privateId: res.playerId,
          authToken: res.authToken,
          name,
        };
        state.room = cloneRoomPayload(res.room) || null;
        if (state.room) {
          const roomPassword = (typeof res.password === 'string' && res.password.length > 0) ? res.password : null;
          state.room.password = roomPassword;
        }
        if (state.room) {
          setScreen('room');
          connectSSE(state.room.id, state.me.privateId, state.me.authToken);
          fillSelectors();
          updateRoomUI();
          onRoomEntered();
          showToast(`部屋作成 成功 (rid:${rid})${state.room.password ? ' パスワード:' + state.room.password : ''}`);
        }
      }
    } finally {
      btnCreate.disabled = false; if (btnJoin) btnJoin.disabled = false;
      btnCreate.textContent = prevCreateText;
    }
  };

  async function joinExistingRoom(roomId, needsPass) {
    const name = saveName(playerNameInput.value || localStorage.getItem('vlg.playerName') || `P${Math.floor(Math.random() * 1000)}`);
    let password;
    if (needsPass) {
      password = prompt('パスワードを入力してください');
      if (password === null) return;
    }
    const res = await api.joinRoom(roomId, name, password, clientId);
    if (res.ok) {
      state.me = {
        playerId: res.publicId || res.playerId,
        publicId: res.publicId || res.playerId,
        privateId: res.playerId,
        authToken: res.authToken,
        name,
      };
      state.room = cloneRoomPayload(res.room) || null;
      if (state.room) {
        const roomPassword = (typeof res.password === 'string' && res.password.length > 0) ? res.password : null;
        state.room.password = roomPassword;
      }
      if (state.room) {
        setScreen('room');
        connectSSE(state.room.id, state.me.privateId, state.me.authToken);
        fillSelectors();
        updateRoomUI();
        onRoomEntered();
        showToast(`入室 成功 (rid:${res.rid})`);
      }
    } else { showToast(`入室 失敗: ${res.error} (rid:${res.rid || '-'})`, 'error'); }
  }

  $('#btnJoinRandom').onclick = async () => {
    const btnCreate = $('#btnCreateRoom');
    const btnJoin = $('#btnJoinRandom');
    if (!btnJoin || btnJoin.disabled) return;
    try { Audio?.playSfx?.(state, 'ui'); } catch { }
    const prevJoinText = btnJoin.textContent;
    btnJoin.disabled = true; if (btnCreate) btnCreate.disabled = true;
    btnJoin.textContent = '通信中・・・';
    try {
      const data = await api.getRooms();
      const candidates = (data.rooms || []).filter(r => (r.members?.length ?? 0) < 5 && r.status === 'room' && !r.hasPassword);
      if (!candidates.length) { showToast('入室可能な部屋がありません', 'error'); return; }
      candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const r of candidates) {
        const before = performance.now();
        const ok = await (async () => {
          const name = saveName(playerNameInput.value || localStorage.getItem('vlg.playerName') || `P${Math.floor(Math.random() * 1000)}`);
          const res = await api.joinRoom(r.id, name, undefined, clientId);
          if (res.ok) {
            state.me = {
              playerId: res.publicId || res.playerId,
              publicId: res.publicId || res.playerId,
              privateId: res.playerId,
              authToken: res.authToken,
              name,
            };
            state.room = cloneRoomPayload(res.room) || null;
            if (state.room) {
              const roomPassword = (typeof res.password === 'string' && res.password.length > 0) ? res.password : null;
              state.room.password = roomPassword;
            }
            if (state.room) {
              setScreen('room');
              connectSSE(state.room.id, state.me.privateId, state.me.authToken);
              fillSelectors();
              updateRoomUI();
              onRoomEntered();
              showToast(`入室 成功 (rid:${res.rid})`);
              return true;
            }
          }
          return false;
        })();
        if (ok) return; const spent = performance.now() - before; if (spent < 120) await new Promise(r => setTimeout(r, 120 - spent));
      }
      showToast('入室に失敗しました（満員/進行中/リザルト中）', 'error');
    } catch (err) { showToast(`部屋取得に失敗しました: ${err.message}`, 'error'); }
    finally {
      btnJoin.disabled = false; if (btnCreate) btnCreate.disabled = false;
      btnJoin.textContent = prevJoinText;
    }
  };

  $('#btnLeave').onclick = async () => {
    try { Audio?.playSfx?.(state, 'close'); } catch { }
    if (!state.room || !state.me) return;
    const { room, me, sse } = state;
    const roomId = room.id;
    const privateId = me.privateId;
    const authToken = me.authToken;
    try {
      await api.leaveRoom(roomId, privateId, authToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : (err?.toString?.() || '不明なエラー');
      showToast(`退室に失敗しました: ${message}`, 'error');
      if (err && typeof console?.error === 'function') console.error('leaveRoom failed', err);
    } finally {
      cleanupBattle('leaveRoom');
      resetRoomItems();
      state.room = null;
      state.me = null;
      try { sse?.close(); } catch (closeErr) { if (typeof console?.warn === 'function') console.warn('Failed closing SSE', closeErr); }
      state.sse = null;
      stopHeartbeat();
      setScreen('lobby');
    }
  };

  $('#btnStart').onclick = async () => {
    try { Audio?.playSfx?.(state, 'ok'); } catch { }
    if (!state.room) return; const res = await api.startGame(state.room.id, state.me.privateId, state.me.authToken); if (!res.ok) showToast(`開始失敗: ${res.error} (rid:${res.rid || '-'})`, 'error');
  };

  $('#btnDisband').onclick = async () => {
    try { Audio?.playSfx?.(state, 'error'); } catch { }
    if (!state.room || !state.me) return;
    if (!disbandConfirmModal) {
      if (confirm('本当に部屋を解散しますか？メンバー全員がロビーに戻ります。')) await disbandRoomConfirmed();
      return;
    }
    disbandConfirmModal.classList.remove('hidden');
    if (btnDisbandConfirm && !btnDisbandConfirm.disabled) {
      try { btnDisbandConfirm.focus?.(); } catch { }
    }
  };

  async function disbandRoomConfirmed() {
    if (!state.room || !state.me || disbandRequestInFlight) return;
    disbandRequestInFlight = true;
    if (btnDisbandConfirm) btnDisbandConfirm.disabled = true;
    try {
      const res = await api.disbandRoom(state.room.id, state.me.privateId, state.me.authToken);
      if (res.ok) {
        showToast(`部屋を解散しました (rid:${res.rid})`);
        cleanupBattle('disband');
        resetRoomItems();
        state.room = null;
        state.me = null;
        state.sse?.close();
        stopHeartbeat();
        setScreen('lobby');
        if (disbandConfirmModal) disbandConfirmModal.classList.add('hidden');
      } else {
        showToast(`解散失敗: ${res.error} (rid:${res.rid || '-'})`, 'error');
      }
    } catch (err) {
      showToast(`解散失敗: ${err?.message || err}`, 'error');
    } finally {
      disbandRequestInFlight = false;
      if (btnDisbandConfirm) btnDisbandConfirm.disabled = false;
    }
  }

  $('#btnReady').onclick = async () => {
    try { Audio?.playSfx?.(state, 'toggle'); } catch { }
    if (!state.room || !state.me) return;
    const me = state.room.members.find(m => m.id === state.me.playerId);
    const next = !(me?.ready);
    if (next) {
      const selected = normalizeCharacterSelection(me?.character ?? characterSelect?.value);
      if (!selected) {
        showToast('キャラを選択してください', 'error');
        return;
      }
    }
    const res = await api.setReady(state.room.id, state.me.privateId, state.me.authToken, next); if (!res.ok) showToast(`準備切替 失敗: ${res.error} (rid:${res.rid || '-'})`, 'error'); else showToast(`準備状態: ${next ? 'Ready' : '待機'} (rid:${res.rid})`);
  };

  // Shop
  const PERK_PRICE_MULT = 4.0; // すべての価格を一括で4倍
  function calcPerkBasePrice(key, level = 0) {
    const cur = Math.max(0, level || 0);
    switch (key) {
      case 'hp': return Math.round((50 + cur * 25) * PERK_PRICE_MULT);
      case 'hphalf': return 0;
      case 'spd': return Math.round((60 + cur * 30) * PERK_PRICE_MULT);
      case 'atk': return Math.round((70 + cur * 35) * PERK_PRICE_MULT);
      case 'boss': return Math.round((200 + cur * 100) * PERK_PRICE_MULT);
      case 'cdr': return Math.round((120 + cur * 60) * PERK_PRICE_MULT);
      case 'gain': return Math.round(300 * PERK_PRICE_MULT); // 固定
      case 'exp': return Math.round((300 + cur * 150) * PERK_PRICE_MULT);
      case 'rez': return Math.round(550 * PERK_PRICE_MULT); // 固定
      case 'upglim': return Math.round(1005 * PERK_PRICE_MULT); // 固定 5500
      case 'sklim': return Math.round(2200 * PERK_PRICE_MULT); // 固定 8000
      case 'support': return Math.round(10000 * (1 + cur));
      case 'ex': return 10000;
      case 'dmgcut': return Math.round((180 + cur * 90) * PERK_PRICE_MULT);
    }
    return 9999;
  }
  function priceOf(key) {
    return calcPerkBasePrice(key, state.perks[key] || 0);
  }
  function labelOf(key) {
    const cur = state.perks[key] || 0; const lim = state.limits[key] || 0;
    const left = Math.max(0, lim - cur);
    const base = {
      hp: 'HP強化 (+最大HP+12/段)',
      spd: '速度UP (+5%/段)',
      atk: '火力UP (+2 ATK/段)',
      boss: '対ボス火力UP (+5%/段)',
      cdr: 'クールタイムUP (攻撃間隔-7%/段)',
      gain: 'もらえるマネーUP (+30%)',
      exp: '経験値獲得量UP (+30%)',
      rez: 'リザレクション (一度だけHP半分で即復活)',
      upglim: '強化枠拡張 (全体+2)',
      sklim: '固有攻撃枠拡張 (+3)',
      support: '支援魔法拡張 (+1)',
      ex: 'EX強化 (固有攻撃強化)',
      hphalf: '体力半減 (最大HPが半分になる)',
      dmgcut: '被ダメージ軽減 (被ダメ-1%/段)',
    }[key];
    return `${base} 残り:${left}`;
  }
  function applyImmediateEffect(key, dir = 1) {
    if (key === 'hp') {
      const add = 12 * dir;
      state.stats.maxHp += add;
      if (dir > 0) {
        const healAmount = applyHealBonus(add);
        const healed = Math.round(healAmount);
        state.stats.hp = Math.min(state.stats.hp + healAmount, state.stats.maxHp);
        try { spawnHealNumber(state.camera.x, state.camera.y, healed); } catch { }
      } else {
        state.stats.hp = Math.min(state.stats.hp + add, state.stats.maxHp);
      }
    }
    if (key === 'hphalf') {
      const mul = dir > 0 ? 0.5 : 2;
      state.stats.maxHp = Math.round(state.stats.maxHp * mul);
      state.stats.hp = Math.min(state.stats.hp, state.stats.maxHp);
    }
    if (key === 'atk') { state.stats.atk += 2 * dir; }
    if (key === 'spd') { /* 次ゲームに本適用。現在値は据え置き */ }
    if (key === 'cdr') { /* 次ゲームに本適用。現在のレートは据え置き */ }
    if (key === 'upglim') { UPGRADE_LIMIT += 2 * dir; }
    if (key === 'sklim') { SKILL_LIMIT += 3 * dir; }
    if (key === 'support') { clampSupportMagicCounts(); }
    if (key === 'ex') { /* 固有攻撃強化のみ。即時効果なし */ }
    if (key === 'boss') {
      const base = 1 + (state.perks.boss || 0) * 0.05;
      const myChar = state.room?.members.find(m => m.id === state.me?.playerId)?.character;
      if (myChar === 'メロ') {
        const diffName = state.room?.difficulty || 'ふつう';
        const meroPenalty = { 'かんたん': 0.8, 'ふつう': 0.7, 'むずかしい': 0.5 }[diffName] || 1;
        state.stats.bossDmgMul = base * meroPenalty;
      } else {
        state.stats.bossDmgMul = base;
      }
    }
    if (key === DAMAGE_REDUCTION_KEY) {
      const mul = dir > 0 ? DAMAGE_REDUCTION_STEP : (1 / DAMAGE_REDUCTION_STEP);
      state.stats.dmgTakenMul *= mul;
    }
    renderHudPerks();
  }
  function rebuildCharacterOptions() {
    if (!characterSelect) return;
    const cur = characterSelect.value;
    characterSelect.innerHTML = '';
    characters.forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c;
      if ((c === '恋恋' || c === 'メロ' || c === 'あんどー') && !state.unlockedChars.includes(c)) {
        o.disabled = true; o.textContent += ' (未購入)';
      }
      characterSelect.appendChild(o);
    });
    if (cur && !(((cur === '恋恋' || cur === 'メロ' || cur === 'あんどー') && !state.unlockedChars.includes(cur)))) {
      characterSelect.value = cur;
    }
    updateCharacterInfo(characterSelect.value);
  }
  function rebuildStageOptions() {
    if (!stageSelect) return;
    const cur = stageSelect.value;
    stageSelect.innerHTML = '';
    stages.forEach(s => {
      const o = document.createElement('option'); o.value = s; o.textContent = s;
      if ((s === 'メロンパン氷山' && !state.unlockedStages.includes('メロンパン氷山')) ||
        (s === 'メロンパン毒沼' && !state.unlockedStages.includes('メロンパン毒沼'))) {
        o.disabled = true; o.textContent += ' (未購入)';
      }
      stageSelect.appendChild(o);
    });
    if (cur) stageSelect.value = cur;
    updateStageInfo(stageSelect.value);
  }

  function appendArmorUnlockRow(target) {
    // アーマーは売却が可能なため、解禁済みでも行を表示しておく
    const basePrice = 10000;
    const { price, discounted } = getDailyDealPrice('unlock:armor', basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'アーマーの解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const btnBuy = document.createElement('button'); btnBuy.textContent = '購入';
    btnBuy.disabled = state.armorUnlocked || state.money < price;
    btnBuy.onclick = () => {
      if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
      if (state.armorUnlocked) { showToast('既に解禁済みです', 'error'); return; }
      state.money -= price; state.armorUnlocked = true;
      recordUnlockPurchasePrice('armor', price);
      recordShopPurchase();
      saveArmorUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `購入: アーマーの解禁 -${price}`; shopLog?.prepend?.(line);
      updateCharacterInfo(characterSelect.value);
      rebuildShop();
    };
    const purchasedBadge = state.armorUnlocked ? createPurchasedBadge() : null;
    const btnSell = document.createElement('button'); btnSell.textContent = '売却';
    const energyHeld = hasMelonPanEnergy();
    btnSell.disabled = !state.armorUnlocked || energyHeld;
    btnSell.title = energyHeld ? 'メロンパンエナジーを保有している間は売却できません' : '';
    btnSell.onclick = () => {
      if (!state.armorUnlocked) { showToast('売却できません', 'error'); return; }
      if (hasMelonPanEnergy()) { showToast('メロンパンエナジーを保有しているため売却できません', 'error'); return; }
      const refundAmount = consumeUnlockRefundPrice('armor', basePrice);
      const gain = refundMoney(refundAmount);
      state.armorUnlocked = false;
      saveArmorUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `売却: アーマーの解禁 +${gain}`; shopLog?.prepend?.(line);
      updateCharacterInfo(characterSelect.value);
      rebuildShop();
    };
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    row.appendChild(btnSell);
    if (discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }

  function appendActiveWeaponUnlockRow(target) {
    // アクティブウェポンも売却できるので常に表示する
    const basePrice = 13000;
    const { price, discounted } = getDailyDealPrice('unlock:activeWeapon', basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'アクティブウェポンの解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const btnBuy = document.createElement('button'); btnBuy.textContent = '購入';
    btnBuy.disabled = state.activeWeaponUnlocked || state.money < price;
    btnBuy.onclick = () => {
      if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
      if (state.activeWeaponUnlocked) { showToast('既に解禁済みです', 'error'); return; }
      state.money -= price; state.activeWeaponUnlocked = true;
      recordUnlockPurchasePrice('activeWeapon', price);
      recordShopPurchase();
      saveActiveWeaponUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `購入: アクティブウェポンの解禁 -${price}`; shopLog?.prepend?.(line);
      rebuildShop();
    };
    const purchasedBadge = state.activeWeaponUnlocked ? createPurchasedBadge() : null;
    const btnSell = document.createElement('button'); btnSell.textContent = '売却';
    btnSell.disabled = !state.activeWeaponUnlocked;
    btnSell.onclick = () => {
      if (!state.activeWeaponUnlocked) { showToast('売却できません', 'error'); return; }
      const refundAmount = consumeUnlockRefundPrice('activeWeapon', basePrice);
      const gain = refundMoney(refundAmount);
      state.activeWeaponUnlocked = false;
      saveActiveWeaponUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `売却: アクティブウェポンの解禁 +${gain}`; shopLog?.prepend?.(line);
      rebuildShop();
    };
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    row.appendChild(btnSell);
    if (discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }
  const HARD_CLEAR_REQUIREMENT_FOR_IGNITION = 3;

  function countHardClears() {
    let total = 0;
    const clears = state.stageClears || {};
    for (const diffs of Object.values(clears)) {
      if (!diffs || typeof diffs !== 'object') continue;
      const entry = normalizeStageClearValue(diffs['むずかしい']);
      if (entry.cleared) total += 1;
    }
    return total;
  }

  function isDamageReductionUnlocked() {
    return isAchievementUnlocked(DAMAGE_REDUCTION_UNLOCK_ACHIEVEMENT_ID);
  }

  function updateDamageReductionLimit() {
    if (!state?.limits) return;
    const cur = state.perks?.[DAMAGE_REDUCTION_KEY] || 0;
    if (isDamageReductionUnlocked()) {
      state.limits[DAMAGE_REDUCTION_KEY] = DAMAGE_REDUCTION_LIMIT;
    } else {
      state.limits[DAMAGE_REDUCTION_KEY] = Math.max(cur, 0);
    }
  }

  function appendSubWeaponUnlockRow(target) {
    const basePrice = 8500;
    const { price, discounted } = getDailyDealPrice('unlock:subWeapon', basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'サブウェポンの解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const purchasedBadge = state.subWeaponUnlocked ? createPurchasedBadge() : null;
    const btnBuy = document.createElement('button');
    if (state.subWeaponUnlocked) {
      btnBuy.textContent = '解禁済み';
      btnBuy.disabled = true;
    } else {
      btnBuy.textContent = '購入';
      btnBuy.disabled = state.money < price;
      btnBuy.onclick = () => {
        if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
        if (state.subWeaponUnlocked) { showToast('既に解禁済みです', 'error'); return; }
        state.money -= price; state.subWeaponUnlocked = true;
        recordShopPurchase();
        saveSubWeaponUnlock(); saveMoney();
        updateWeaponShopVisibility();
        const line = document.createElement('div'); line.textContent = `購入: サブウェポンの解禁 -${price}`; shopLog?.prepend?.(line);
        rebuildShop();
      };
    }
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    if (!state.subWeaponUnlocked && discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }
  function appendSecondSubWeaponUnlockRow(target) {
    const basePrice = 18000;
    const { price, discounted } = getDailyDealPrice('unlock:secondSubWeapon', basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'セカンドサブウェポンの解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const btnBuy = document.createElement('button'); btnBuy.textContent = '購入';
    btnBuy.disabled = !state.subWeaponUnlocked || state.secondSubWeaponUnlocked || state.money < price;
    btnBuy.onclick = () => {
      if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
      if (!state.subWeaponUnlocked) { showToast('先にサブウェポンを解禁してください', 'error'); return; }
      if (state.secondSubWeaponUnlocked) { showToast('既に解禁済みです', 'error'); return; }
      state.money -= price;
      recordShopPurchase();
      state.secondSubWeaponUnlocked = true;
      recordUnlockPurchasePrice('secondSubWeapon', price);
      saveSecondSubWeaponUnlock();
      saveMoney();
      const line = document.createElement('div'); line.textContent = `購入: セカンドサブウェポンの解禁 -${price}`;
      shopLog?.prepend?.(line);
      renderSubWeaponInventory();
      updateWeaponShopVisibility();
      rebuildShop();
    };
    const purchasedBadge = state.secondSubWeaponUnlocked ? createPurchasedBadge() : null;
    const btnSell = document.createElement('button'); btnSell.textContent = '売却';
    btnSell.disabled = !state.secondSubWeaponUnlocked;
    btnSell.onclick = () => {
      if (!state.secondSubWeaponUnlocked) { showToast('売却できません', 'error'); return; }
      if (state.subWeaponUnlocked) { showToast('サブウェポンを先に売却してください', 'error'); return; }
      const refundAmount = consumeUnlockRefundPrice('secondSubWeapon', basePrice);
      const gain = refundMoney(refundAmount);
      state.secondSubWeaponUnlocked = false;
      setSelectedSecondSubWeapon(null);
      saveSecondSubWeaponUnlock();
      saveMoney();
      const line = document.createElement('div'); line.textContent = `売却: セカンドサブウェポンの解禁 +${gain}`;
      shopLog?.prepend?.(line);
      renderSubWeaponInventory();
      updateWeaponShopVisibility();
      rebuildShop();
    };
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    row.appendChild(btnSell);
    if (discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }
  function appendEnergySystemUnlockRow(target) {
    const basePrice = 18000;
    const { price, discounted } = getDailyDealPrice('unlock:energy', basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'メロンパンエナジーシステム解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const btnBuy = document.createElement('button'); btnBuy.textContent = '購入';
    btnBuy.disabled = state.energyUnlocked || state.money < price || !state.armorUnlocked;
    btnBuy.onclick = () => {
      if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
      if (!state.armorUnlocked) { showToast('先にアーマーを購入してください', 'error'); return; }
      if (state.energyUnlocked) { showToast('既に解禁済みです', 'error'); return; }
      state.money -= price; state.energyUnlocked = true; state.energy = defaultEnergy();
      recordUnlockPurchasePrice('energy', price);
      recordShopPurchase();
      saveEnergyUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `購入: メロンパンエナジーシステム解禁 -${price}`; shopLog?.prepend?.(line);
      rebuildShop();
    };
    const purchasedBadge = state.energyUnlocked ? createPurchasedBadge() : null;
    const btnSell = document.createElement('button'); btnSell.textContent = '売却';
    btnSell.disabled = !state.energyUnlocked;
    btnSell.onclick = () => {
      if (!state.energyUnlocked) { showToast('売却できません', 'error'); return; }
      const refundAmount = consumeUnlockRefundPrice('energy', basePrice);
      const gain = refundMoney(refundAmount);
      state.energyUnlocked = false; state.energy = defaultEnergy();
      saveEnergyUnlock(); saveMoney();
      const line = document.createElement('div'); line.textContent = `売却: メロンパンエナジーシステム解禁 +${gain}`; shopLog?.prepend?.(line);
      rebuildShop();
    };
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    row.appendChild(btnSell);
    if (discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }
  function appendCharacterGrowthRow(target) {
    if (!state.armorUnlocked && !state.characterGrowthUnlocked) return;
    const basePrice = CHARACTER_GROWTH_UNLOCK_PRICE;
    const { price, discounted } = getDailyDealPrice(CHARACTER_GROWTH_DAILY_DEAL_ID, basePrice);
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'キャラ成長の解禁';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
    if (discounted) cost.title = `通常価格: ${basePrice}`;
    const btnBuy = document.createElement('button'); btnBuy.textContent = state.characterGrowthUnlocked ? '解禁済み' : '購入';
    btnBuy.disabled = state.characterGrowthUnlocked || state.money < price || !state.armorUnlocked;
    btnBuy.onclick = () => {
      if (state.characterGrowthUnlocked) { showToast('既に解禁済みです', 'error'); return; }
      if (!state.armorUnlocked) { showToast('先にアーマーを購入してください', 'error'); return; }
      if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
      state.money -= price;
      recordShopPurchase();
      state.characterGrowthUnlocked = true;
      saveCharacterGrowthUnlock();
      saveMoney();
      const line = document.createElement('div');
      line.textContent = `購入: キャラ成長の解禁 -${price}`;
      shopLog?.prepend?.(line);
      showToast('キャラ成長を解禁しました！', 'info');
      rebuildShop();
      updateCharacterInfo(characterSelect?.value);
    };
    const purchasedBadge = state.characterGrowthUnlocked ? createPurchasedBadge() : null;
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btnBuy);
    if (discounted) decorateDailyDealRow(row, cost);
    target.appendChild(row);
  }
  function appendIgnitionModeRow(target) {
    const clears = countHardClears();
    if (clears < HARD_CLEAR_REQUIREMENT_FOR_IGNITION) return;
    const price = 0;
    const row = document.createElement('div'); row.className = 'row'; row.style.gap = '8px'; row.style.alignItems = 'center';
    const name = document.createElement('div'); name.style.flex = '1 1 auto'; name.textContent = 'イグニッションモード';
    if (isMobile) name.style.flexBasis = '100%';
    const cost = document.createElement('span'); cost.className = 'badge'; cost.textContent = `${price}`;
    const btn = document.createElement('button');
    const purchasedBadge = state.ignitionModeUnlocked ? createPurchasedBadge() : null;
    if (state.ignitionModeUnlocked) {
      btn.textContent = '解禁済み';
      btn.disabled = true;
    } else {
      btn.textContent = '購入';
      btn.title = '難易度「むずかしい」で切り替え可能になります';
      btn.onclick = () => {
        if (state.ignitionModeUnlocked) { showToast('既に解禁済みです', 'error'); return; }
        state.ignitionModeUnlocked = true;
        saveIgnitionModeUnlock();
        const line = document.createElement('div'); line.textContent = `購入: イグニッションモード -${price}`;
        shopLog?.prepend?.(line);
        showToast('イグニッションモードを解禁しました。部屋画面でON/OFFを切り替えられます。', 'info');
        updateIgnitionControls();
        rebuildShop();
      };
    }
    row.appendChild(name);
    row.appendChild(cost);
    if (purchasedBadge) row.appendChild(purchasedBadge);
    row.appendChild(btn);
    target.appendChild(row);
  }

  const DAILY_DEAL_DISCOUNT_RATE = 0.9;
  const DAILY_DEAL_PERCENT = Math.round((1 - DAILY_DEAL_DISCOUNT_RATE) * 100);
  const SHOP_DAILY_DEAL_ITEMS = [
    'perk:hp',
    'perk:spd',
    'perk:atk',
    'perk:boss',
    'perk:cdr',
    'perk:gain',
    'perk:exp',
    'perk:rez',
    'perk:upglim',
    'perk:sklim',
    'perk:ex',
    `perk:${DAMAGE_REDUCTION_KEY}`,
    'stage:メロンパン氷山',
    'stage:メロンパン毒沼',
    'char:恋恋',
    'char:メロ',
    'char:あんどー',
    'unlock:armor',
    'unlock:activeWeapon',
    'unlock:subWeapon',
    'unlock:secondSubWeapon',
    'unlock:energy',
    CHARACTER_GROWTH_DAILY_DEAL_ID,
    'unlock:cardShop',
  ];
  let currentShopDailyDealId = null;

  function getDailyDealSeed() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function hashDailyDealSeed(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash >>> 0;
  }

  function isDailyDealCandidateAvailable(id) {
    if (!id) return false;
    const [type, key] = id.split(':');
    switch (type) {
      case 'perk': {
        if (key === 'hphalf') return false;
        if (key === DAMAGE_REDUCTION_KEY && !isDamageReductionUnlocked() && !(state.perks?.[key] > 0)) return false;
        const lim = state.limits?.[key] ?? 0;
        const cur = state.perks?.[key] ?? 0;
        return lim > cur;
      }
      case 'stage':
        if (key === 'メロンパン氷山') return !state.unlockedStages.includes('メロンパン氷山');
        if (key === 'メロンパン毒沼') return !state.unlockedStages.includes('メロンパン毒沼');
        return false;
      case 'char':
        return !state.unlockedChars.includes(key);
      case 'unlock':
        switch (key) {
          case 'armor': return !state.armorUnlocked;
          case 'activeWeapon': return !state.activeWeaponUnlocked;
          case 'subWeapon': return !state.subWeaponUnlocked;
          case 'secondSubWeapon': return state.subWeaponUnlocked && !state.secondSubWeaponUnlocked;
          case 'energy': return state.armorUnlocked && !state.energyUnlocked;
          case 'characterGrowth': return state.armorUnlocked && !state.characterGrowthUnlocked;
          case 'cardShop': return !state.cardShopUnlocked;
          default: return false;
        }
      default:
        return false;
    }
  }

  function chooseDailyDealForToday() {
    if (!SHOP_DAILY_DEAL_ITEMS.length) return null;
    const seed = getDailyDealSeed();
    const startIndex = hashDailyDealSeed(seed) % SHOP_DAILY_DEAL_ITEMS.length;
    for (let i = 0; i < SHOP_DAILY_DEAL_ITEMS.length; i += 1) {
      const id = SHOP_DAILY_DEAL_ITEMS[(startIndex + i) % SHOP_DAILY_DEAL_ITEMS.length];
      if (isDailyDealCandidateAvailable(id)) return id;
    }
    return null;
  }

  function getDailyDealPrice(id, basePrice) {
    if (!id || typeof basePrice !== 'number' || Number.isNaN(basePrice)) {
      return { price: basePrice, discounted: false };
    }
    const discounted = currentShopDailyDealId === id;
    const price = discounted ? Math.max(1, Math.floor(basePrice * DAILY_DEAL_DISCOUNT_RATE)) : basePrice;
    return { price, discounted };
  }

  function decorateDailyDealRow(row, costEl) {
    if (!row) return;
    row.classList.add('daily-deal');
    if (costEl) costEl.classList.add('daily-deal-price');
    const badge = document.createElement('span');
    badge.className = 'badge daily-deal-flag';
    badge.textContent = '本日のお買い得';
    if (costEl) {
      row.insertBefore(badge, costEl);
    } else {
      row.appendChild(badge);
    }
  }
  function createPurchasedBadge() {
    const badge = document.createElement('span');
    badge.className = 'badge purchased';
    badge.textContent = '購入済み';
    return badge;
  }

  function createSection(container, title) {
    if (!container) return null;
    const section = document.createElement('section');
    section.className = 'shop-section';
    const heading = document.createElement('h4');
    heading.className = 'shop-section-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'shop-section-body';
    section.appendChild(heading);
    section.appendChild(body);
    container.appendChild(section);
    return body;
  }

  function createShopSection(title) {
    return createSection(shopItems, title);
  }

  function createCardShopSection(title) {
    return createSection(cardShopItems, title);
  }


  function rebuildShop() {
    updateMoneyLabels();
    if (!shopItems) return;
    shopItems.innerHTML = '';
    updateDamageReductionLimit();
    currentShopDailyDealId = chooseDailyDealForToday();

    const perkSection = createShopSection('能力強化');
    const order = ['hp', 'spd', 'atk', 'boss', 'cdr', 'gain', 'exp', 'rez', 'dmgcut', 'support', 'upglim', 'sklim', 'ex', 'hphalf'];
    const damageReductionUnlocked = isDamageReductionUnlocked();
    for (const key of order) {
      if (key === DAMAGE_REDUCTION_KEY && !damageReductionUnlocked && !(state.perks?.[key] > 0)) {
        continue;
      }
      const cur = state.perks[key] || 0;
      const lim = state.limits[key] || 0;
      const basePrice = priceOf(key);
      const { price, discounted } = getDailyDealPrice(`perk:${key}`, basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = labelOf(key);
      if (isMobile) name.style.flexBasis = '100%';
      const cnt = document.createElement('span');
      cnt.className = 'badge';
      cnt.textContent = `${cur}/${lim}`;
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const btnBuy = document.createElement('button');
      btnBuy.textContent = '購入';
      btnBuy.disabled = cur >= lim || state.money < price;
      btnBuy.onclick = () => {
        if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
        if (cur >= lim) { showToast('上限に達しています', 'error'); return; }
        state.money -= price;
        state.perks[key] = cur + 1;
        recordPerkPurchasePrice(key, price);
        saveMoney();
        savePerks();
        recordShopPurchase();
        applyImmediateEffect(key, 1);
        const line = document.createElement('div');
        line.textContent = `購入: ${labelOf(key)} (残り:${(state.limits[key] || 0) - (state.perks[key] || 0)}) -${price}`;
        shopLog?.prepend?.(line);
        rebuildShop();
      };
      const purchasedBadge = (lim > 0 && cur >= lim) ? createPurchasedBadge() : null;
      const btnSell = document.createElement('button');
      btnSell.textContent = '売却';
      btnSell.disabled = cur <= 0;
      btnSell.onclick = () => {
        if (cur <= 0) { showToast('売却できません', 'error'); return; }
        const nextLevel = Math.max(0, cur - 1);
        const basePriceForRefund = calcPerkBasePrice(key, nextLevel);
        const refundAmount = popPerkPurchasePrice(key, basePriceForRefund);
        const gain = refundMoney(refundAmount);
        state.perks[key] = nextLevel;
        saveMoney();
        savePerks();
        applyImmediateEffect(key, -1);
        const line = document.createElement('div');
        line.textContent = `売却: ${labelOf(key)} (残り:${(state.limits[key] || 0) - (state.perks[key] || 0)}) +${gain}`;
        shopLog?.prepend?.(line);
        rebuildShop();
      };
      row.appendChild(name);
      row.appendChild(cnt);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btnBuy);
      row.appendChild(btnSell);
      if (discounted) decorateDailyDealRow(row, cost);
      perkSection.appendChild(row);
    }

    const utilitySection = createShopSection('便利アイテム');
    {
      const formatExcludeTokenCount = (count) => {
        const normalized = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, count || 0));
        return `${normalized}/${MAX_EXCLUDE_TOKENS}`;
      };
      const EXCLUDE_BASE_PRICE = 1200;
      const tokens = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, state.excludeTokens || 0));
      const nextPrice = tokens >= MAX_EXCLUDE_TOKENS ? null : EXCLUDE_BASE_PRICE * (tokens + 1);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = '除外';
      if (isMobile) name.style.flexBasis = '100%';
      const leftBadge = document.createElement('span');
      leftBadge.className = 'badge';
      leftBadge.textContent = formatExcludeTokenCount(tokens);
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = nextPrice === null ? '-' : `${nextPrice}`;
      const btnBuy = document.createElement('button');
      btnBuy.textContent = '購入';
      btnBuy.disabled = nextPrice === null || state.money < nextPrice;
      btnBuy.onclick = () => {
        const currentTokens = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, state.excludeTokens || 0));
        if (currentTokens >= MAX_EXCLUDE_TOKENS) { showToast('除外は5個までしか所持できません', 'error'); return; }
        const price = EXCLUDE_BASE_PRICE * (currentTokens + 1);
        if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
        state.money -= price;
        state.excludeTokens = Math.min(MAX_EXCLUDE_TOKENS, currentTokens + 1);
        saveMoney();
        saveExcludeTokens();
        recordShopPurchase();
        updateMoneyLabels();
        const line = document.createElement('div');
        const updatedTokens = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, state.excludeTokens || 0));
        line.textContent = `購入: 除外 (残り:${formatExcludeTokenCount(updatedTokens)}) -${price}`;
        shopLog?.prepend?.(line);
        rebuildShop();
      };
      const btnSell = document.createElement('button');
      btnSell.textContent = '売却';
      btnSell.disabled = tokens <= 0;
      btnSell.onclick = () => {
        const currentTokens = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, state.excludeTokens || 0));
        if (currentTokens <= 0) { showToast('除外を所持していません', 'error'); return; }
        const sellPrice = EXCLUDE_BASE_PRICE * currentTokens;
        const gain = refundMoney(sellPrice);
        state.excludeTokens = currentTokens - 1;
        saveMoney();
        saveExcludeTokens();
        updateMoneyLabels();
        const line = document.createElement('div');
        const updatedTokens = Math.max(0, Math.min(MAX_EXCLUDE_TOKENS, state.excludeTokens || 0));
        line.textContent = `売却: 除外 (残り:${formatExcludeTokenCount(updatedTokens)}) +${gain}`;
        shopLog?.prepend?.(line);
        rebuildShop();
      };
      row.appendChild(name);
      row.appendChild(leftBadge);
      row.appendChild(cost);
      row.appendChild(btnBuy);
      row.appendChild(btnSell);
      utilitySection.appendChild(row);
    }

    const stageSection = createShopSection('ステージ');
    {
      const basePrice = 5000;
      const unlocked = state.unlockedStages.includes('メロンパン氷山');
      const { price, discounted } = getDailyDealPrice('stage:メロンパン氷山', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'ステージ「メロンパン氷山」';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.unlockedStages.push('メロンパン氷山');
          recordShopPurchase();
          saveStageUnlocks();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: ステージ「メロンパン氷山」 -${price}`;
          shopLog?.prepend?.(line);
          rebuildStageOptions();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      stageSection.appendChild(row);
    }
    {
      const basePrice = 15000;
      const unlocked = state.unlockedStages.includes('メロンパン毒沼');
      const { price, discounted } = getDailyDealPrice('stage:メロンパン毒沼', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'ステージ「メロンパン毒沼」';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.unlockedStages.push('メロンパン毒沼');
          recordShopPurchase();
          saveStageUnlocks();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: ステージ「メロンパン毒沼」 -${price}`;
          shopLog?.prepend?.(line);
          rebuildStageOptions();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      stageSection.appendChild(row);
    }

    const characterSection = createShopSection('キャラクター');
    {
      const basePrice = 5600;
      const unlocked = state.unlockedChars.includes('恋恋');
      const { price, discounted } = getDailyDealPrice('char:恋恋', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'キャラ「恋恋」';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.unlockedChars.push('恋恋');
          recordShopPurchase();
          saveCharUnlocks();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: キャラ「恋恋」 -${price}`;
          shopLog?.prepend?.(line);
          rebuildCharacterOptions();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      characterSection.appendChild(row);
    }
    {
      const basePrice = 13000;
      const unlocked = state.unlockedChars.includes('メロ');
      const { price, discounted } = getDailyDealPrice('char:メロ', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'キャラ「メロ」';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.unlockedChars.push('メロ');
          recordShopPurchase();
          saveCharUnlocks();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: キャラ「メロ」 -${price}`;
          shopLog?.prepend?.(line);
          rebuildCharacterOptions();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      characterSection.appendChild(row);
    }
    {
      const basePrice = 9900;
      const unlocked = state.unlockedChars.includes('あんどー');
      const { price, discounted } = getDailyDealPrice('char:あんどー', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'キャラ「あんどー」';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.unlockedChars.push('あんどー');
          recordShopPurchase();
          saveCharUnlocks();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: キャラ「あんどー」 -${price}`;
          shopLog?.prepend?.(line);
          rebuildCharacterOptions();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      characterSection.appendChild(row);
    }

    const featureSection = createShopSection('システム解禁');
    appendArmorUnlockRow(featureSection);
    appendActiveWeaponUnlockRow(featureSection);
    appendSubWeaponUnlockRow(featureSection);
    appendSecondSubWeaponUnlockRow(featureSection);
    appendEnergySystemUnlockRow(featureSection);
    appendCharacterGrowthRow(featureSection);
    appendIgnitionModeRow(featureSection);
    {
      const basePrice = 20000;
      const unlocked = state.cardShopUnlocked;
      const { price, discounted } = getDailyDealPrice('unlock:cardShop', basePrice);
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = 'レシピカードの解禁';
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = discounted ? `${price} (${DAILY_DEAL_PERCENT}%OFF)` : `${price}`;
      if (discounted) cost.title = `通常価格: ${basePrice}`;
      const purchasedBadge = unlocked ? createPurchasedBadge() : null;
      const btn = document.createElement('button');
      if (unlocked) {
        btn.textContent = '解禁済み';
        btn.disabled = true;
      } else {
        btn.textContent = '購入';
        btn.disabled = state.money < price;
        btn.onclick = () => {
          if (state.money < price) { showToast('マネーが不足しています', 'error'); return; }
          state.money -= price;
          state.cardShopUnlocked = true;
          recordShopPurchase();
          saveCardShopUnlock();
          saveMoney();
          const line = document.createElement('div');
          line.textContent = `購入: レシピカードの解禁 -${price}`;
          shopLog?.prepend?.(line);
          updateCardShopVisibility();
          rebuildShop();
        };
      }
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btn);
      if (!unlocked && discounted) decorateDailyDealRow(row, cost);
      featureSection.appendChild(row);
    }
  }

  function rebuildCardShop() {
    updateMoneyLabels();
    updateCardSynergyUI();
    if (!cardShopItems) return;
    cardShopItems.innerHTML = '';
    const rarityOrder = [1, 2, 3, 4];
    const rarityTitles = {
      1: 'レア1（銅）',
      2: 'レア2（銀）',
      3: 'レア3（金）',
      4: 'レア4（虹）',
    };
    rarityOrder.forEach(rarity => {
      const cardsInRarity = cardDefs.filter(card => card.rarity === rarity);
      if (!cardsInRarity.length) return;
      const section = createCardShopSection(rarityTitles[rarity] || `レア${rarity}`);
      if (!section) return;
      cardsInRarity.forEach(card => {
        const owned = !!state.cards[card.id];
        const row = document.createElement('div');
        row.className = 'row';
        row.style.gap = '8px';
        row.style.alignItems = 'center';
        const name = document.createElement('div');
        name.style.flex = '1 1 auto';
        name.textContent = `${card.name} (属性${card.attr} レア${card.rarity}) - ${card.effect}`;
        if (isMobile) name.style.flexBasis = '100%';
        const cost = document.createElement('span');
        cost.className = 'badge';
        cost.textContent = `${card.price}`;
        const btnBuy = document.createElement('button');
        btnBuy.textContent = '購入';
        btnBuy.disabled = owned || state.money < card.price;
        btnBuy.onclick = () => {
          if (state.money < card.price) { showToast('マネーが不足しています', 'error'); return; }
          if (owned) { showToast('既に解禁済みです', 'error'); return; }
          state.money -= card.price; state.cards[card.id] = true;
          recordShopPurchase();
          saveMoney(); saveCards();
          const line = document.createElement('div'); line.textContent = `購入: カード「${card.name}」 -${card.price}`; shopLog?.prepend?.(line);
          rebuildCardShop();
        };
        const purchasedBadge = owned ? createPurchasedBadge() : null;
        const btnSell = document.createElement('button');
        btnSell.textContent = '売却';
        btnSell.disabled = !owned;
        btnSell.onclick = () => {
          if (!owned) { showToast('売却できません', 'error'); return; }
          const gain = addMoney(card.price, { applyBrandMultiplier: false, applyRiskMultiplier: false }); delete state.cards[card.id];
          saveMoney(); saveCards();
          const line = document.createElement('div'); line.textContent = `売却: カード「${card.name}」 +${gain}`; shopLog?.prepend?.(line);
          rebuildCardShop();
        };
        row.appendChild(name);
        row.appendChild(cost);
        if (purchasedBadge) row.appendChild(purchasedBadge);
        row.appendChild(btnBuy);
        row.appendChild(btnSell);
        section.appendChild(row);
      });
    });
  }
  function rebuildWeaponShop() {
    updateMoneyLabels();
    if (!weaponShopItems) return;
    weaponShopItems.innerHTML = '';
    if (!state.subWeaponUnlocked) {
      const locked = document.createElement('p');
      locked.textContent = 'サブウェポンは未解禁です';
      weaponShopItems.appendChild(locked);
      return;
    }
    if (!subWeaponDefs.length) {
      const info = document.createElement('p');
      info.textContent = '現在取り扱い準備中です';
      weaponShopItems.appendChild(info);
      return;
    }
    subWeaponDefs.forEach(weapon => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      const name = document.createElement('div');
      name.style.flex = '1 1 auto';
      name.textContent = `${weapon.name} (使用可能回数:${weapon.uses}回) - ${weapon.effect}`;
      if (isMobile) name.style.flexBasis = '100%';
      const cost = document.createElement('span');
      cost.className = 'badge';
      cost.textContent = `${weapon.price}`;
      const btnBuy = document.createElement('button');
      btnBuy.textContent = '購入';
      btnBuy.disabled = !!state.subWeapons?.[weapon.id] || state.money < weapon.price;
      btnBuy.onclick = () => {
        if (state.money < weapon.price) { showToast('マネーが不足しています', 'error'); return; }
        if (state.subWeapons?.[weapon.id]) { showToast('既に所持しています', 'error'); return; }
        state.money -= weapon.price;
        recordShopPurchase();
        if (!state.subWeapons) state.subWeapons = {};
        state.subWeapons[weapon.id] = true;
        setSelectedSubWeapon(weapon.id);
        saveMoney();
        saveSubWeapons();
        const line = document.createElement('div');
        line.textContent = `購入: サブウェポン「${weapon.name}」 -${weapon.price}`;
        shopLog?.prepend?.(line);
        renderSubWeaponInventory();
        rebuildWeaponShop();
      };
      const purchasedBadge = state.subWeapons?.[weapon.id] ? createPurchasedBadge() : null;
      const btnSell = document.createElement('button');
      btnSell.textContent = '売却';
      btnSell.disabled = !state.subWeapons?.[weapon.id];
      btnSell.onclick = () => {
        if (!state.subWeapons?.[weapon.id]) { showToast('売却できません', 'error'); return; }
        const gain = addMoney(weapon.price, { applyBrandMultiplier: false, applyRiskMultiplier: false });
        delete state.subWeapons[weapon.id];
        if (state.selectedSubWeapon === weapon.id) setSelectedSubWeapon(null);
        if (state.selectedSecondSubWeapon === weapon.id) setSelectedSecondSubWeapon(null);
        saveMoney();
        saveSubWeapons();
        const line = document.createElement('div');
        line.textContent = `売却: サブウェポン「${weapon.name}」 +${gain}`;
        shopLog?.prepend?.(line);
        renderSubWeaponInventory();
        rebuildWeaponShop();
      };
      row.appendChild(name);
      row.appendChild(cost);
      if (purchasedBadge) row.appendChild(purchasedBadge);
      row.appendChild(btnBuy);
      row.appendChild(btnSell);
      weaponShopItems.appendChild(row);
    });
  }
  if (btnOpenShop) btnOpenShop.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } rebuildShop(); shopModal.classList.remove('hidden'); };
  if (btnShopClose) btnShopClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } shopModal.classList.add('hidden'); };
  if (shopModal) addListener(shopModal, 'click', (e) => { if (e.target === shopModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } shopModal.classList.add('hidden'); } });
  if (btnOpenCardShop) btnOpenCardShop.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } rebuildCardShop(); cardShopModal.classList.remove('hidden'); };
  if (btnCardShopClose) btnCardShopClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } cardShopModal.classList.add('hidden'); };
  if (cardShopModal) addListener(cardShopModal, 'click', (e) => { if (e.target === cardShopModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } cardShopModal.classList.add('hidden'); } });
  if (btnOpenWeaponShop) btnOpenWeaponShop.onclick = () => {
    try { Audio?.playSfx?.(state, 'open'); } catch { }
    rebuildWeaponShop();
    if (weaponShopModal) weaponShopModal.classList.remove('hidden');
  };
  if (btnWeaponShopClose) btnWeaponShopClose.onclick = () => {
    try { Audio?.playSfx?.(state, 'close'); } catch { }
    if (weaponShopModal) weaponShopModal.classList.add('hidden');
  };
  if (weaponShopModal) addListener(weaponShopModal, 'click', (e) => { if (e.target === weaponShopModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } weaponShopModal.classList.add('hidden'); } });
  // UX: Escでショップを閉じる
  addListener(window, 'keydown', (ev) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      if (shopModal && !shopModal.classList.contains('hidden')) {
        try { Audio?.playSfx?.(state, 'close'); } catch { }
        shopModal.classList.add('hidden');
      } else if (cardShopModal && !cardShopModal.classList.contains('hidden')) {
        try { Audio?.playSfx?.(state, 'close'); } catch { }
        cardShopModal.classList.add('hidden');
      } else if (weaponShopModal && !weaponShopModal.classList.contains('hidden')) {
        try { Audio?.playSfx?.(state, 'close'); } catch { }
        weaponShopModal.classList.add('hidden');
      }
    }
  }, { capture: true });

  $('#characterSelect').onchange = async () => {
    try { Audio?.playSfx?.(state, 'select'); } catch { }
    if (!state.room || !state.me) return;
    const me = state.room.members.find(m => m.id === state.me.playerId);
    if (me?.ready) {
      showToast('準備中は変更できません', 'error');
      const fallback = normalizeCharacterSelection(me?.character) ?? '-';
      characterSelect.value = fallback;
      updateCharacterInfo(characterSelect.value);
      return;
    }
    const prev = normalizeCharacterSelection(me?.character);
    updateCharacterInfo(characterSelect.value);
    const res = await api.setLoadout(state.room.id, state.me.privateId, state.me.authToken, characterSelect.value, null, null);
    if (!res?.ok) {
      showToast(`変更失敗: ${res?.error ?? 'unknown'}`, 'error');
      const fallback = prev ?? '-';
      characterSelect.value = fallback;
      updateCharacterInfo(characterSelect.value);
    }
    try {
      const meM = state.room?.members.find(m => m.id === state.me?.playerId);
      const hudChar = normalizeCharacterSelection(meM?.character ?? characterSelect.value);
      setHudChip(hudChar, meM?.name || state.me?.name);
    } catch { }
  };

  $('#stageSelect').onchange = async () => {
    try { Audio?.playSfx?.(state, 'select'); } catch { }
    if (!state.room || !state.me) return; const isOwner = state.room.owner === state.me.playerId;
    if (!isOwner) { showToast('ステージ選択は部屋主のみです', 'error'); if (state.room.stage) stageSelect.value = state.room.stage; updateStageInfo(stageSelect.value); return; }
    const me = state.room.members.find(m => m.id === state.me.playerId); if (me?.ready) { showToast('準備中は変更できません', 'error'); if (state.room.stage) stageSelect.value = state.room.stage; updateStageInfo(stageSelect.value); return; }
    if ((stageSelect.value === 'メロンパン氷山' && !state.unlockedStages.includes('メロンパン氷山')) ||
      (stageSelect.value === 'メロンパン毒沼' && !state.unlockedStages.includes('メロンパン毒沼'))) {
      showToast('ステージが未購入です', 'error'); if (state.room.stage) stageSelect.value = state.room.stage; updateStageInfo(stageSelect.value); return;
    }
    const prevStage = state.room.stage; updateStageInfo(stageSelect.value); const res = await api.setLoadout(state.room.id, state.me.privateId, state.me.authToken, characterSelect.value, stageSelect.value, null);
    if (!res?.ok) {
      showToast(`変更失敗: ${res?.error ?? 'unknown'}`, 'error');
      if (prevStage) stageSelect.value = prevStage;
      updateStageInfo(stageSelect.value);
      try { Audio?.setBgmForStage?.(state, prevStage); } catch { }
    } else {
      try { Audio?.setBgmForStage?.(state, stageSelect.value); } catch { }
    }
  };

  $('#difficultySelect').onchange = async () => {
    try { Audio?.playSfx?.(state, 'select'); } catch { }
    if (!state.room || !state.me) return; const isOwner = state.room.owner === state.me.playerId;
    if (!isOwner) { showToast('難易度選択は部屋主のみです', 'error'); if (state.room.difficulty) difficultySelect.value = state.room.difficulty; updateDifficultyInfo(difficultySelect.value); updateStageInfo(stageSelect.value); return; }
    const me = state.room.members.find(m => m.id === state.me.playerId); if (me?.ready) { showToast('準備中は変更できません', 'error'); if (state.room.difficulty) difficultySelect.value = state.room.difficulty; updateDifficultyInfo(difficultySelect.value); updateStageInfo(stageSelect.value); return; }
    const prevDiff = state.room.difficulty;
    const nextDiff = difficultySelect.value;
    const shouldDisableIgnition = nextDiff !== 'むずかしい' && !!(state.room.flags?.ignitionMode);
    const options = shouldDisableIgnition ? { ignitionMode: false } : undefined;
    updateDifficultyInfo(nextDiff); updateStageInfo(stageSelect.value); const res = await api.setLoadout(state.room.id, state.me.privateId, state.me.authToken, characterSelect.value, null, nextDiff, options);
    if (!res?.ok) {
      showToast(`変更失敗: ${res?.error ?? 'unknown'}`, 'error');
      if (prevDiff) difficultySelect.value = prevDiff;
      updateDifficultyInfo(difficultySelect.value);
      updateStageInfo(stageSelect.value);
    } else if (shouldDisableIgnition) {
      ensureRoomFlags(state.room);
      delete state.room.flags.ignitionMode;
      updateIgnitionControls();
    }
  };
  if (ignitionModeToggle) ignitionModeToggle.onchange = async () => {
    try { Audio?.playSfx?.(state, 'select'); } catch { }
    if (!state.room || !state.me) return;
    const desired = !!ignitionModeToggle.checked;
    const current = !!(state.room.flags?.ignitionMode);
    if (desired === current) return;
    const isOwner = state.room.owner === state.me.playerId;
    const meMember = state.room.members.find(m => m.id === state.me.playerId);
    if (!isOwner) { showToast('イグニッションモードは部屋主のみ変更できます', 'error'); ignitionModeToggle.checked = current; return; }
    if (!state.ignitionModeUnlocked) { showToast('先にショップで解禁してください', 'error'); ignitionModeToggle.checked = current; return; }
    if (meMember?.ready) { showToast('準備中は変更できません', 'error'); ignitionModeToggle.checked = current; return; }
    const charValue = characterSelect?.value ?? (meMember?.character ?? null);
    try {
      const res = await api.setLoadout(state.room.id, state.me.privateId, state.me.authToken, charValue, null, null, { ignitionMode: desired });
      if (!res?.ok) throw new Error(res?.error ?? 'unknown');
      ensureRoomFlags(state.room);
      if (desired) state.room.flags.ignitionMode = true;
      else delete state.room.flags.ignitionMode;
      updateIgnitionControls();
      if (difficultySelect) updateDifficultyInfo(difficultySelect.value);
      const baseMsg = desired ? 'イグニッションモードをONにしました' : 'イグニッションモードをOFFにしました';
      if (desired && state.room.difficulty !== 'むずかしい') {
        showToast(`${baseMsg}（難易度「むずかしい」で適用されます）`, 'info');
      } else {
        showToast(baseMsg);
      }
    } catch (err) {
      ignitionModeToggle.checked = current;
      showToast(`変更失敗: ${err?.message ?? err}`, 'error');
    }
  };

  $('#btnPause').onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } window.__vlgClearPressed?.(); Settings?.syncSettingUI?.(state, $('#pauseModal')); $('#pauseModal').classList.remove('hidden'); };
  $('#btnResume').onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } window.__vlgClearPressed?.(); $('#pauseModal').classList.add('hidden'); };
  $('#btnExit').onclick = () => {
    try { Audio?.playSfx?.(state, 'cancel'); } catch { }
    cleanupBattle('pauseExit');
    try { state.stats.alive = false; } catch { }
    const dur = Math.round(state._timeAlive || 0); const k = Math.max(0, state._kills || 0);
    showPersonalResult(dur, k);
    sendEvent({ type: 'death', kills: k, duration: dur }).catch(() => { });
    $('#pauseModal').classList.add('hidden');
  };
  $('#btnBackToRoom').onclick = async () => {
    try { Audio?.playSfx?.(state, 'ui'); } catch { }
    if (!state.room || !state.me) return;
    const isOwner = state.room.owner === state.me.playerId;
    if (!isOwner) { showToast('「部屋に戻る」は部屋主のみ操作できます', 'error'); return; }
    const res = await api.returnToRoom(state.room.id, state.me.privateId, state.me.authToken);
    if (!res?.ok) {
      showToast(`戻る指示 失敗: ${res?.error ?? 'unknown'} (rid:${res?.rid || '-'})`, 'error');
    } else {
      // Fall back to local cleanup in case the server event is missed
      cleanupBattle('backToRoomLocal');
      resetRoomItems();
      setScreen('room');
      showToast('部屋に戻りました');
    }
  };

  try {
    const __lobbyBtn = (typeof lobbySettingsBtn !== 'undefined') ? lobbySettingsBtn : $('#btnLobbySettings');
    if (__lobbyBtn) __lobbyBtn.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } Settings?.syncSettingUI?.(state, lobbySettingsModal); lobbySettingsModal.classList.remove('hidden'); };
  } catch { }
  try {
    const __lobbyClose = (typeof lobbyClose !== 'undefined') ? lobbyClose : $('#btnLobbySettingsClose');
    if (__lobbyClose) __lobbyClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } lobbySettingsModal.classList.add('hidden'); };
  } catch { }
  if (lobbySettingsModal) addListener(lobbySettingsModal, 'click', (e) => { if (e.target === lobbySettingsModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } lobbySettingsModal.classList.add('hidden'); } });
  try {
    if (btnExportSettings) btnExportSettings.onclick = () => { Settings?.exportSettings?.(state); };
  } catch { }
  try {
    if (btnImportSettings && fileImportSettings) {
      btnImportSettings.onclick = () => fileImportSettings.click();
      fileImportSettings.onchange = async (e) => {
        const file = e.target.files[0];
        if (file) {
          const ok = await Settings?.importSettings?.(
            state,
            file,
            Audio?.applyAudioSettings?.bind(Audio),
            lobbySettingsModal
          );
          if (ok) {
            showToast('設定をインポートしました');
            updateCardSynergyUI();
          } else {
            showToast('設定のインポートに失敗しました', 'error');
          }
        }
        e.target.value = '';
      };
    }
  } catch { }

  const openAchievementsModal = () => {
    if (!achievementsModal) return;
    if (!achievementsModal.classList.contains('hidden')) return;
    rebuildAchievementList();
    try { Audio?.playSfx?.(state, 'open'); } catch { }
    achievementsModal.classList.remove('hidden');
  };
  const closeAchievementsModal = () => {
    if (!achievementsModal) return;
    if (achievementsModal.classList.contains('hidden')) return;
    try { Audio?.playSfx?.(state, 'close'); } catch { }
    achievementsModal.classList.add('hidden');
  };
  try {
    const __achievementsBtn = (typeof achievementsBtn !== 'undefined') ? achievementsBtn : $('#btnAchievements');
    if (__achievementsBtn) __achievementsBtn.onclick = () => { openAchievementsModal(); };
  } catch { }
  try {
    const __roomAchievementsBtn = (typeof roomAchievementsBtn !== 'undefined') ? roomAchievementsBtn : $('#btnRoomAchievements');
    if (__roomAchievementsBtn) __roomAchievementsBtn.onclick = () => { openAchievementsModal(); };
  } catch { }
  try {
    const __roomGalleryBtn = (typeof roomGalleryBtn !== 'undefined') ? roomGalleryBtn : $('#btnRoomGallery');
    if (__roomGalleryBtn) __roomGalleryBtn.onclick = () => { openGalleryModal(); };
  } catch { }
  try {
    const __achievementsClose = (typeof achievementsClose !== 'undefined') ? achievementsClose : $('#btnAchievementsClose');
    if (__achievementsClose) __achievementsClose.onclick = () => { closeAchievementsModal(); };
  } catch { }
  if (achievementsModal) addListener(achievementsModal, 'click', (e) => { if (e.target === achievementsModal) { closeAchievementsModal(); } });
  try {
    const __galleryClose = (typeof galleryClose !== 'undefined') ? galleryClose : $('#btnGalleryClose');
    if (__galleryClose) __galleryClose.onclick = () => { closeGalleryModal(); };
  } catch { }
  if (galleryModal) addListener(galleryModal, 'click', (e) => { if (e.target === galleryModal) { closeGalleryModal(); } });
  try {
    const __helpBtn = (typeof helpBtn !== 'undefined') ? helpBtn : $('#btnHelp');
    if (__helpBtn) __helpBtn.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } helpModal.classList.remove('hidden'); };
  } catch { }
  try {
    const __helpClose = (typeof helpClose !== 'undefined') ? helpClose : $('#btnHelpClose');
    if (__helpClose) __helpClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } helpModal.classList.add('hidden'); };
  } catch { }
  if (helpModal) addListener(helpModal, 'click', (e) => { if (e.target === helpModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } helpModal.classList.add('hidden'); } });
  try {
    const __roomStoryBtn = (typeof roomStoryBtn !== 'undefined') ? roomStoryBtn : $('#btnRoomStory');
    if (__roomStoryBtn) __roomStoryBtn.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } openRoomStoryModal(0); };
  } catch { }
  try {
    const __roomStoryClose = (typeof roomStoryClose !== 'undefined') ? roomStoryClose : $('#btnRoomStoryClose');
    if (__roomStoryClose) __roomStoryClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } closeRoomStoryModal(); };
  } catch { }
  try {
    const __roomStoryPrev = (typeof roomStoryPrev !== 'undefined') ? roomStoryPrev : $('#btnRoomStoryPrev');
    if (__roomStoryPrev) __roomStoryPrev.onclick = () => { try { Audio?.playSfx?.(state, 'select'); } catch { } showPreviousStoryEpisode(); };
  } catch { }
  try {
    const __roomStoryNext = (typeof roomStoryNext !== 'undefined') ? roomStoryNext : $('#btnRoomStoryNext');
    if (__roomStoryNext) __roomStoryNext.onclick = () => { try { Audio?.playSfx?.(state, 'select'); } catch { } showNextStoryEpisode(); };
  } catch { }
  if (roomStoryModal) addListener(roomStoryModal, 'click', (e) => { if (e.target === roomStoryModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } closeRoomStoryModal(); } });
  try {
    const __roomHelpBtn = (typeof roomHelpBtn !== 'undefined') ? roomHelpBtn : $('#btnRoomHelp');
    if (__roomHelpBtn) __roomHelpBtn.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } roomHelpModal.classList.remove('hidden'); };
  } catch { }
  try {
    const __roomHelpClose = (typeof roomHelpClose !== 'undefined') ? roomHelpClose : $('#btnRoomHelpClose');
    if (__roomHelpClose) __roomHelpClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } roomHelpModal.classList.add('hidden'); };
  } catch { }
  if (roomHelpModal) addListener(roomHelpModal, 'click', (e) => { if (e.target === roomHelpModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } roomHelpModal.classList.add('hidden'); } });
  if (btnDisbandConfirm) addListener(btnDisbandConfirm, 'click', async () => { try { Audio?.playSfx?.(state, 'ok'); } catch { } await disbandRoomConfirmed(); });
  if (btnDisbandCancel) addListener(btnDisbandCancel, 'click', () => { try { Audio?.playSfx?.(state, 'close'); } catch { } if (disbandConfirmModal) disbandConfirmModal.classList.add('hidden'); });
  if (disbandConfirmModal) addListener(disbandConfirmModal, 'click', (e) => {
    if (e.target === disbandConfirmModal) {
      try { Audio?.playSfx?.(state, 'close'); } catch { }
      disbandConfirmModal.classList.add('hidden');
    }
  });
  try {
    const __roomSettingsBtn = (typeof roomSettingsBtn !== 'undefined') ? roomSettingsBtn : $('#btnRoomSettings');
    if (__roomSettingsBtn) __roomSettingsBtn.onclick = () => { try { Audio?.playSfx?.(state, 'open'); } catch { } Settings?.syncSettingUI?.(state, roomSettingsModal); roomSettingsModal.classList.remove('hidden'); };
  } catch { }
  try {
    const __roomSettingsClose = (typeof roomSettingsClose !== 'undefined') ? roomSettingsClose : $('#btnRoomSettingsClose');
    if (__roomSettingsClose) __roomSettingsClose.onclick = () => { try { Audio?.playSfx?.(state, 'close'); } catch { } roomSettingsModal.classList.add('hidden'); };
  } catch { }
  if (roomSettingsModal) addListener(roomSettingsModal, 'click', (e) => { if (e.target === roomSettingsModal) { try { Audio?.playSfx?.(state, 'close'); } catch { } roomSettingsModal.classList.add('hidden'); } });
  // Safely set version label. appVersion should come from init context, but guard in case
  // the value is missing at runtime (prevents Uncaught ReferenceError).
  if (versionLabel) {
    try {
      versionLabel.textContent = (typeof appVersion !== 'undefined') ? appVersion : (window?.vlg?.appVersion || 'unknown');
    } catch {
      // Defensive: in some build/run setups `appVersion` may be truly undefined in scope.
      versionLabel.textContent = window?.vlg?.appVersion || 'unknown';
    }
  }

  // Settings
  Settings?.wireSettingHandlers?.(state, (st) => Audio?.applyAudioSettings?.(st), document);
  function fillSelectors() {
    rebuildCharacterOptions();
    rebuildStageOptions();
    if (difficultySelect) {
      difficultySelect.innerHTML = '';
      difficulties.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; difficultySelect.appendChild(o); });
      updateDifficultyInfo(difficultySelect.value);
      updateStageInfo(stageSelect.value);
    }
  }
  // Lobby room list refresher
  const ROOM_REFRESH_INTERVAL = 3000;
  let refreshingRooms = false;
  let refreshRoomsTimer = 0;
  async function refreshRooms() {
    if (refreshingRooms) return;
    refreshingRooms = true;
    if (state.room) {
      refreshingRooms = false;
      clearTimeout(refreshRoomsTimer);
      refreshRoomsTimer = setTimeout(refreshRooms, ROOM_REFRESH_INTERVAL);
      return;
    }
    try {
      const data = await api.getRooms();
      renderRoomList(data.rooms);
    } catch {
    } finally {
      refreshingRooms = false;
      clearTimeout(refreshRoomsTimer);
      refreshRoomsTimer = setTimeout(refreshRooms, ROOM_REFRESH_INTERVAL);
    }
  }

  // Initial boot
  Settings?.loadSettings?.(state);
  loadSavedName();
  Settings?.syncSettingUI?.(state, document);
  Audio?.applyAudioSettings?.(state);
  ensureFpsEl();
  setScreen('lobby');
  fillSelectors();
  refreshRooms();

  // best-effort leave on page unload
  addListener(window, 'beforeunload', () => {
    try {
      if (!state.room || !state.me) return;
      const url = new URL('api.php?action=leaveRoom', document.baseURI);
      const payload = JSON.stringify({ roomId: state.room.id, playerId: state.me.privateId, authToken: state.me.authToken });
      if (navigator.sendBeacon) { const blob = new Blob([payload], { type: 'application/json' }); navigator.sendBeacon(url.toString(), blob); }
      else { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => { }); }
    } catch { }
  });

}
