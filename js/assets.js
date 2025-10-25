// Shared image cache utilities for the game UI and legacy scripts.
// Provides a common getImage helper that memoizes Image objects by key.

const imageCache = new Map();

function applyImageOptions(img, opts) {
  if (!opts) return;
  if (opts.crossOrigin && img.crossOrigin !== opts.crossOrigin) {
    img.crossOrigin = opts.crossOrigin;
  }
  if (opts.referrerPolicy && img.referrerPolicy !== opts.referrerPolicy) {
    img.referrerPolicy = opts.referrerPolicy;
  }
}

export function getImage(aliasOrSrc, srcOrOpts, maybeOpts) {
  let alias = null;
  let src = aliasOrSrc;
  let opts = srcOrOpts;
  if (typeof srcOrOpts === 'string') {
    alias = aliasOrSrc;
    src = srcOrOpts;
    opts = maybeOpts;
  }
  if (!src) throw new Error('getImage: src is required');
  if (!opts || typeof opts !== 'object') opts = {};
  const cacheKey = alias || src;
  let entry = imageCache.get(cacheKey);
  if (!entry) {
    entry = { img: new Image(), src: '' };
    imageCache.set(cacheKey, entry);
  }
  applyImageOptions(entry.img, opts);
  if (entry.src !== src) {
    entry.img.src = src;
    entry.src = src;
  }
  return entry.img;
}

export function preloadImages(defs) {
  const result = {};
  if (!defs || typeof defs !== 'object') return result;
  for (const [key, value] of Object.entries(defs)) {
    if (!value) continue;
    if (typeof value === 'string') {
      result[key] = getImage(key, value);
      continue;
    }
    if (typeof value === 'object' && typeof value.src === 'string') {
      const { src, ...opts } = value;
      result[key] = getImage(key, src, opts);
    }
  }
  return result;
}

export function clearImage(alias) {
  if (!alias) return;
  const entry = imageCache.get(alias);
  if (!entry) return;
  try { entry.img.src = ''; } catch (err) { console.error('Failed to clear image src:', err); }
  imageCache.delete(alias);
}

export function getCachedImage(alias) {
  const entry = imageCache.get(alias);
  return entry ? entry.img : null;
}

export const assets = { getImage, preloadImages, clearImage, getCachedImage };

if (typeof window !== 'undefined') {
  const root = window.vlg || (window.vlg = {});
  root.assets = Object.assign(root.assets || {}, assets);
}

export default assets;
