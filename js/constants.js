// Static game constants and simple helpers
export const APP_VERSION = '2.99';

export const characters = ['-', 'おきーぱー', 'ナタリア', 'あたち', 'ハクシキ', '恋恋', 'メロ', 'U', 'フルムーン', 'あんどー'];
export const characterDefs = {
  'おきーぱー': {
    description: '追尾弾を打つが移動速度がやや低い。',
    stats: { hp: 100, spd: 0.9, armor: 40 },
    ability: '1.2秒ごとにダメージ8の追尾コウモリ弾（射程200、速度260）を放つ',
    ex: 'コウモリ弾が貫通する（対ボスダメージはかんたん95％・ふつう85％・むずかしい75％に制限）',
    active: 'その場で貫通コウモリ弾を20発放つ（生存時間3秒、チャージ180秒）'
  },
  'ナタリア': {
    description: '超回復したり近距離を攻撃できる',
    stats: { hp: 100, spd: 1.0, armor: 50 },
    ability: '毎秒0.35HP回復し、左40px・高さ60px内の敵に毎秒7ダメージ（むずかしいでは回復量が0.2HPに制限）',
    ex: '半径60px以内の味方を毎秒2HP回復（むずかしいでは1HP）',
    active: '全員のアーマーとHPを全回復し、30秒間移動速度と自固有範囲1.5倍（むずかしいでは回復量半分・倍率1.25倍／チャージ260秒）'
  },
  'あたち': {
    description: 'くるくるする',
    stats: { hp: 120, spd: 1.0, armor: 30 },
    ability: '半径110pxの回転レーザー（幅0.28rad）で毎秒40ダメージ',
    ex: '反対方向にもレーザーを追加',
    active: '60秒間レーザー速度が3倍になり、命中した敵を毎秒200px押し返す（チャージ150秒）'
  },
  'ハクシキ': {
    description: '周囲を攻撃するメロンパン愛好家',
    stats: { hp: 100, spd: 1.0, armor: 45 },
    ability: '半径70pxのオーラで毎秒16ダメージ',
    ex: 'オーラが敵を毎秒180px押し返す',
    active: '15秒間移動方向とは逆に毎秒5発、攻撃力と同じダメージの貫通弾（速度400）を放つ（チャージ90秒）'
  },
  '恋恋': {
    description: '移動速度がやや速く爆弾を設置する',
    stats: { hp: 100, spd: 1.1, armor: 30 },
    ability: '1.5秒ごとにダメージ20の爆弾を設置（爆風半径はかんたん100px／ふつう80px／むずかしい70px）',
    ex: '爆発後2.5秒間、毎秒12ダメージの炎を残し爆風に触れた敵を350px吹き飛ばす',
    active: '画面内の最も遠い敵に威力7倍・範囲3倍の爆弾を投げる（チャージ105秒）'
  },
  'メロ': {
    description: '強力な射撃があるが移動速度と体力が低い',
    stats: { hp: 60, spd: 0.6, armor: 35 },
    ability: '2.3秒でチャージしATK×6の貫通スナイプ弾を最大2体に発射（射程約1600px／対ボスダメージはかんたん80％・ふつう70％・むずかしい50％に制限）',
    ex: '命中地点で半径80px、ATK×3の爆発を起こす',
    active: '周囲の敵最大10体をスナイプし着弾で爆発（チャージ300秒）'
  },
  'U': {
    description: '画面の右半分を攻撃する上級者向け性能',
    stats: { hp: 100, spd: 1.3, armor: 30 },
    ability: '画面右半分の敵に毎秒5ダメージ',
    ex: '通常敵を5%の確率で1秒スタン（クールタイム3秒）',
    active: '60秒間攻撃範囲が画面全体になりDPS毎秒7.5にUP、更に対ボスダメージ3.5倍（チャージ180秒）'
  },
  'フルムーン': {
    description: '回転するシールドを展開して敵や弾を防ぐ',
    stats: { hp: 100, spd: 1.0, armor: 50 },
    ability: '耐久300（固有強化ごとに+60）・毎秒9ダメージのシールドが毎秒60で再生（シールド半径はかんたん60px／ふつう50px／むずかしい40px）',
    ex: 'シールド接触時に毎秒160pxノックバック',
    active: 'シールドを突き出し攻撃力×8のダメージとノックバック800pxを与える（チャージ160秒）'
  },
  'あんどー': {
    description: 'デコイを召喚する戦術家',
    stats: { hp: 100, spd: 1.0, armor: 35 },
    ability: '約3秒ごとに難易度に応じたHP20〜30のデコイを最大9〜15体召喚し接触で毎秒約6.5ダメージ（タンク/虹スライム/中型個体/大型個体への与ダメージ1.2倍）',
    ex: 'デコイ破壊時に爆発（爆風範囲約40px・炎1.5秒毎秒6ダメージ・ノックバック100px）/敵のヘイトを買うようになる（ボスでは無効）',
    active: '80秒間デコイの最大数・生産速度・HP・与ダメージが5倍（チャージ110秒）'
  },
};
export const stages = ['メロンパン広場', 'メロンパン牧場', 'メロンパン迷宮', 'メロンパン工業地帯', 'メロンパン火山地帯', 'メロンパン氷山', 'メロンパンスキー場', 'メロンパン毒沼'];
export const difficulties = ['かんたん', 'ふつう', 'むずかしい'];

export const stageDefs = {
  'メロンパン広場': { type: 'plaza', jumpPad: true, description: '無限に広がる基本ステージ', difficulty: 1, mobHpMul: 1 },
  'メロンパン牧場': { type: 'ranch', halfHeight: 140, description: '上下に狭い牧場ステージ', difficulty: 2, mobHpMul: 1 },
  'メロンパン迷宮': { type: 'maze', chunk: 320, ignoreMobWalls: true, description: 'ランダムな障害物が現れる迷宮', difficulty: 3, mobHpMul: 1 },
  'メロンパン工業地帯': { type: 'maze', chunk: 320, spikes: true, spikeDamage: 10, mobHpMul: 2, midBossHpMul: 3, bossHpMul: 5, ignoreMobWalls: true, description: '壁のトゲに触れるとダメージ', difficulty: 4 },
  'メロンパン火山地帯': { type: 'volcano', lavaSpeed: 25, lavaDamage: 999, jumpPad: true, description: '左から迫る溶岩に触れると999ダメージ', difficulty: 4, mobHpMul: 6, midBossHpMul: 4, bossHpMul: 5 },
  'メロンパン氷山': { type: 'plaza', slippery: true, slipperyFrac: 0.3, slipperyFriction: 0.9, mobHpMul: 3, midBossHpMul: 5, bossHpMul: 12, healValueMul: 0.5, description: '床の3割が滑るステージ', difficulty: 4 },
  'メロンパンスキー場': { type: 'plaza', circular: true, slippery: true, iceBlocks: true, radius: 600, slipperyFrac: 0.3, slipperyFriction: 0.9, description: '氷ブロックが並ぶ円形のステージ', difficulty: 3, mobHpMul: 1 },
  'メロンパン毒沼': {
    type: 'plaza',
    poison: true,
    poisonFrac: 0.2,
    poisonShape: 'puddles',
    poisonPuddleGrid: 1400,
    poisonPuddleChance: 0.9,
    poisonPuddleCountMax: 3,
    poisonPuddleRadiusMin: 220,
    poisonPuddleRadiusMax: 940,
    poisonPuddleRadiusBias: 0.52,
    poisonPuddleAspectMin: 0.45,
    poisonPuddleAspectMax: 1.75,
    poisonPuddleBlend: 0.4,
    poisonPuddleFalloff: 1.35,
    poisonPuddleRadiusJitter: 0.26,
    poisonPuddleThreshold: 0.08,
    poisonPuddleNoise: 0.24,
    poisonPuddleDetailNoise: 0.2,
    poisonPuddleRippleNoise: 0.08,
    description: '床の2割が毒沼のステージ',
    difficulty: 6,
    mobHpMul: 12,
    midBossHpMul: 15,
    bossHpMul: 16
  },
};

export const difficultyDefs = {
  'かんたん': { hpMul: 0.8, spawnMul: 0.8, bulletMul: 0.6, bulletDmgMul: 0.5, maxEnemies: 40, mobHpMul: 1, tankHpMul: 4.5, midBossHpMul: 3, bossHpMul: 4.5, description: '初心者向けのやさしい難易度' },
  'ふつう': { hpMul: 1.0, spawnMul: 1.0, bulletMul: 0.8, bulletDmgMul: 0.75, maxEnemies: 60, mobHpMul: 1, tankHpMul: 9, midBossHpMul: 5, bossHpMul: 10.5, description: '標準的な難易度' },
  'むずかしい': { hpMul: 1.3, spawnMul: 1.2, bulletMul: 1.0, bulletDmgMul: 1.0, maxEnemies: 80, mobHpMul: 2, tankHpMul: 20, midBossHpMul: 14, bossHpMul: 37.5, description: '熟練者向けの高難易度' },
};

export function $(sel, root = document) { return root.querySelector(sel); }
