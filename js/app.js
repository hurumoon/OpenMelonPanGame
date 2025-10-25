// App entry point. Imports split modules and bootstraps the app by calling init().
import { api } from './api.js';
import { $, characters, characterDefs, stages, stageDefs, difficulties, difficultyDefs, APP_VERSION as appVersion } from './constants.js';
import { subWeaponDefs } from './sub-weapon-defs.js';
// カード定義をデフォルトとして読み込む
import cardDefs from './cards.js';
import { achievementDefs } from './achievement-defs.js';
import './bootstrap.js';
import { initApp } from './main-controller.js';
import * as Settings from './settings.js';
import * as Audio from './audio.js';
import { storyEpisodes } from './story.js';

// Expose api for quick debugging in console (optional)
// Ensure $ is also available globally for any code that expects a global $ helper
window.$ = $;
window.vlg = Object.assign(
  window.vlg || {},
  {
    api,
    $,
    characters,
    characterDefs,
    stages,
    stageDefs,
    difficulties,
    difficultyDefs,
    subWeaponDefs,
    Settings,
    Audio,
    appVersion,
    cardDefs,
    achievementDefs,
    storyEpisodes,
    galleryItems: [],
  }
);
// Load settings early so UI reflects persisted choices (font, volumes, toggles)
const initState = { settings: {} };
Settings.loadSettings(initState);
// Apply font choice immediately
try { Settings.applyFont(initState.settings.font || 'BestTenDOT'); } catch { }
// Wire global handlers for any settings UI in the document
Settings.syncSettingUI(initState);
Settings.wireSettingHandlers(initState, Audio.applyAudioSettings?.bind(Audio));

initApp({
  api,
  $,
  characters,
  characterDefs,
  stages,
  stageDefs,
  difficulties,
  difficultyDefs,
  subWeaponDefs,
  Settings,
  Audio,
  appVersion,
  cardDefs,
  achievementDefs,
  storyEpisodes,
  galleryItems: window.vlg.galleryItems,
});

(async () => {
  let galleryItems = [];
  try {
    const response = await api.listGallery();
    if (response?.ok && Array.isArray(response.images)) {
      galleryItems = response.images;
    } else if (response) {
      console.warn('ギャラリー一覧の取得に失敗しました: 応答形式が不正です', response);
    }
  } catch (err) {
    console.warn('ギャラリー一覧の取得に失敗しました:', err);
  }
  window.vlg.galleryItems = galleryItems;
  try {
    window.vlg.updateGalleryItems?.(galleryItems);
  } catch (err) {
    console.warn('ギャラリー一覧の更新中にエラーが発生しました:', err);
  }
})();
