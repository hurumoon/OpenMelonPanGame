// DOM-level bootstrap utilities shared by modules
(function ensureDamageContainer() {
    if (document.getElementById('vlg-dmg-container')) return;
    const dmgContainer = document.createElement('div');
    dmgContainer.id = 'vlg-dmg-container';
    Object.assign(dmgContainer.style, { position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none', zIndex: 1000 });
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(dmgContainer));
})();
