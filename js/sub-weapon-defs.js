export const subWeaponDefs = [
  {
    id: 'sword',
    name: 'ソード',
    price: 2500,
    uses: 2,
    effect: '使うと自身が向いている方に1秒間剣を突き出す（貫通　高火力　DPS:ATK×4／射程約76px）',
  },
  {
    id: 'flamethrower',
    name: '火炎放射器',
    price: 3200,
    uses: 5,
    effect: '使うと自身が向いている方に3.5秒火炎放射をする（貫通　広範囲　DPS:ATK×1.8［最低12］／射程約220px）',
  },
  {
    id: 'flashbang',
    name: '閃光弾',
    price: 1200,
    uses: 7,
    effect: '使うと周囲の敵を3.5秒スタンさせる（ボス以外／DPS:0／効果範囲半径約240px）',
  },
  {
    id: 'bomb',
    name: '爆弾',
    price: 2500,
    uses: 3,
    effect: '使うと爆弾を投げて0.85秒後に爆発させる（ダメージ:ATK×6［最低20・対ボス2倍］／射程約180px・爆風半径約110px）',
  },
];

export default subWeaponDefs;
