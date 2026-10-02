/* ============================================================
   THRESHOLD — storefront logic (vanilla JS, no frameworks)
   ============================================================ */

// Google Apps Script Web App URL — замени на свой URL (Deploy > New deployment > Web app)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzi5ghDNM7bqtotk4GQL2uZ8TRJlfuYFTbbD_sjXS3swywu_FH1sHk3DcIjNO7EhVlpuQ/exec';

const PAGE_SIZE = 12;
const LS_CART = 'threshold_cart_v1';
const LS_FAV = 'threshold_fav_v1';

const state = {
  products: [],
  filtered: [],
  cart: [],
  favs: [],
  filters: { query: '', brands: new Set(), cats: new Set(), sizes: new Set(), minPrice: 0, maxPrice: Infinity },
  sort: 'new',
  visible: PAGE_SIZE,
  priceBounds: { min: 0, max: 999999 }
};

/* ---------- helpers ---------- */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const money = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' \u20BD';

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function pluralProducts(n) {
  return plural(n, 'товар', 'товара', 'товаров');
}

let toastTimer;
function hideToast() {
  $('#toast').classList.remove('show');
}

function showToast(msg, opts = {}) {
  const t = $('#toast');
  clearTimeout(toastTimer);
  t.innerHTML = '';

  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);

  if (opts.actionLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-btn';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      hideToast();
      if (opts.onAction) opts.onAction();
    });
    t.appendChild(btn);
  }

  t.classList.add('show');
  toastTimer = setTimeout(hideToast, opts.duration || 2600);
}

/* ---------- local SVG placeholders (работают офлайн) ---------- */

const PH_BG = ['#f2f2ef', '#e9e9e5', '#e0e0db', '#d8d8d1'];
const PH_ACCENT = '#e8f542';
const PH_INK = '#111111';

function svgURI(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function glyphSVG(cat, fill, stroke) {
  if (cat === 'apparel') {
    return (
      '<path d="M120 30 L170 8 Q200 40 230 8 L280 30 L344 72 L306 118 L280 100 L280 236 L120 236 L120 100 L94 118 L56 72 Z" fill="' + fill + '"/>' +
      '<path d="M170 8 Q200 40 230 8" fill="none" stroke="' + stroke + '" stroke-width="7" stroke-linecap="round"/>'
    );
  }
  if (cat === 'accessories') {
    return (
      '<path d="M85 180 C85 92 140 44 195 44 C250 44 305 92 305 180 Z" fill="' + fill + '"/>' +
      '<path d="M85 180 L408 180 C420 180 422 200 400 202 L110 202 C88 202 82 190 85 180 Z" fill="' + fill + '"/>' +
      '<circle cx="195" cy="46" r="10" fill="' + stroke + '"/>' +
      '<path d="M195 46 L195 180" stroke="' + stroke + '" stroke-width="5" opacity=".3"/>'
    );
  }
  return (
    '<path d="M0 170 C0 120 22 96 60 88 C96 80 122 58 146 26 C158 10 176 2 194 10 C212 18 220 40 212 60 L196 100 C232 108 268 126 296 152 C316 170 322 190 316 206 C310 220 294 228 272 228 L46 228 C18 228 0 206 0 170 Z" fill="' + fill + '"/>' +
    '<path d="M0 170 C0 120 22 96 60 88 C96 80 122 58 146 26 C158 10 176 2 194 10" fill="none" stroke="' + stroke + '" stroke-width="7" stroke-linecap="round"/>' +
    '<path d="M40 176 C88 156 180 152 262 176" fill="none" stroke="' + stroke + '" stroke-width="7" stroke-linecap="round"/>' +
    '<circle cx="196" cy="24" r="9" fill="' + stroke + '"/>'
  );
}

/*
 * GLYPH_BOX: [w, h, tx, ty, scale] — центрирует bbox глифа в круге cx=320,
 * cy=340, r=178 с учётом обводки (±3.5px) и запаса до окружности.
 *   sneakers:    bbox x −3.5..325.5 (центр 161), y ≈6..231.5 (центр 119)
 *                → scale .97, tx 164, ty 225
 *   apparel:     bbox x 52.5..347.5 (центр 200), y 4.5..239.5 (центр 122)
 *                → scale 1, tx 120, ty 218
 *   accessories: bbox x 82..422 (центр 252), y 36..204.5 (центр 120)
 *                → scale .92, tx 88, ty 229 (кепка: иначе козырёк за кругом)
 */
const GLYPH_BOX = {
  sneakers: [322, 226, 164, 225, 0.97],
  apparel: [288, 228, 120, 218],
  accessories: [340, 166, 88, 229, 0.92]
};

function placeholderSeed(p) {
  let h = 0;
  for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h;
}

function productPlaceholder(p) {
  const isDrop = (p.tags || []).includes('drop');
  const bg = isDrop ? PH_ACCENT : PH_BG[placeholderSeed(p) % PH_BG.length];
  const bar = isDrop ? PH_INK : PH_ACCENT;
  const circle = isDrop ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.6)';
  const box = GLYPH_BOX[p.category] || GLYPH_BOX.sneakers;
  const glyph = glyphSVG(p.category, PH_INK, bg);
  const scale = box[4] ? ' scale(' + box[4] + ')' : '';
  return svgURI(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 800">' +
      '<rect width="640" height="800" fill="' + bg + '"/>' +
      '<circle cx="320" cy="340" r="178" fill="' + circle + '"/>' +
      '<g transform="translate(' + box[2] + ' ' + box[3] + ')' + scale + '">' + glyph + '</g>' +
      '<rect x="60" y="596" width="56" height="10" fill="' + bar + '"/>' +
      '<text x="60" y="668" font-family="Arial, sans-serif" font-size="32" font-weight="bold" letter-spacing="5" fill="' + PH_INK + '">' + escapeHTML(p.brand.toUpperCase()) + '</text>' +
      '<text x="60" y="710" font-family="Arial, sans-serif" font-size="27" fill="#55554f">' + escapeHTML(p.name) + '</text>' +
    '</svg>'
  );
}

function productImg(p) {
  return p.img ? p.img : productPlaceholder(p);
}

function storeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function storeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage full / private mode — игнорируем */ }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- load products ---------- */

async function loadProducts() {
  renderSkeletons(6);
  try {
    const res = await fetch('products.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.products = Array.isArray(data.products) ? data.products : [];
  } catch (err) {
    console.error('Не удалось загрузить products.json:', err);
    renderLoadError();
    return;
  }
  computePriceBounds();
  renderBrandFilters();
  renderCategoryFilters();
  renderSizeFilters();
  initPriceFilter();
  renderCart();
  applyFilters({ resetVisible: true });
  renderRail();
}

function renderSkeletons(n) {
  const grid = $('#productsGrid');
  grid.innerHTML = Array.from({ length: n }, () => (
    '<div class="skeleton" aria-hidden="true">' +
      '<div class="skeleton-media"></div>' +
      '<div class="sk-line w60"></div>' +
      '<div class="sk-line w40"></div>' +
    '</div>'
  )).join('');
}

function renderLoadError() {
  $('#productsGrid').innerHTML =
    '<div class="empty-state" style="grid-column:1/-1">' +
      '<p class="empty-title">Не удалось загрузить каталог</p>' +
      '<p>Проверь, что файл products.json лежит рядом с index.html и страница открыта через локальный сервер.</p>' +
    '</div>';
  $('#catalogCount').textContent = '—';
}

function computePriceBounds() {
  const prices = state.products.map((p) => p.price).filter((x) => Number.isFinite(x));
  const min = prices.length ? Math.floor(Math.min(...prices) / 100) * 100 : 0;
  const max = prices.length ? Math.ceil(Math.max(...prices) / 100) * 100 : 999999;
  state.priceBounds = { min, max };
  state.filters.minPrice = min;
  state.filters.maxPrice = max;
}

/* ---------- filters UI ---------- */

function renderBrandFilters() {
  const counts = new Map();
  state.products.forEach((p) => counts.set(p.brand, (counts.get(p.brand) || 0) + 1));
  const box = $('#brandFilters');
  box.innerHTML = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'ru')).map((brand) => (
    '<label class="f-check">' +
      '<input type="checkbox" name="brand" value="' + escapeHTML(brand) + '">' +
      '<span>' + escapeHTML(brand) + '</span>' +
      '<span class="f-num">' + counts.get(brand) + '</span>' +
    '</label>'
  )).join('');
}

function renderCategoryFilters() {
  const titles = { sneakers: 'Кроссовки', apparel: 'Стритвир', accessories: 'Аксессуары' };
  const cats = Array.from(new Set(state.products.map((p) => p.category)));
  const box = $('#categoryFilters');
  box.innerHTML = cats.map((cat) => (
    '<label class="f-check">' +
      '<input type="checkbox" name="cat" value="' + escapeHTML(cat) + '">' +
      '<span>' + (titles[cat] || escapeHTML(cat)) + '</span>' +
      '<span class="f-num">' + state.products.filter((p) => p.category === cat).length + '</span>' +
    '</label>'
  )).join('');
}

function renderSizeFilters() {
  const sizes = new Set();
  state.products.forEach((p) => (p.sizes || []).forEach((s) => sizes.add(String(s))));
  const sorted = Array.from(sizes).sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    if (!Number.isNaN(na)) return -1;
    if (!Number.isNaN(nb)) return 1;
    return a.localeCompare(b);
  });
  $('#sizeFilters').innerHTML = sorted.map((s) => (
    '<button type="button" class="size-chip" data-size="' + escapeHTML(s) + '">' + escapeHTML(s) + '</button>'
  )).join('');
}

function initPriceFilter() {
  const { min, max } = state.priceBounds;
  const minInput = $('#priceMin');
  const maxInput = $('#priceMax');
  const range = $('#priceRange');
  minInput.value = min;
  maxInput.value = max;
  minInput.min = min;
  maxInput.min = min;
  minInput.max = max;
  maxInput.max = max;
  range.min = min;
  range.max = max;
  range.step = 100;
  range.value = max;
  $('#priceFromLabel').textContent = money(min);
  $('#priceToLabel').textContent = money(max);
}

/* ---------- filtering ---------- */

function applyFilters({ resetVisible = true } = {}) {
  const f = state.filters;
  const q = f.query.trim().toLowerCase();

  state.filtered = state.products.filter((p) => {
    if (f.brands.size && !f.brands.has(p.brand)) return false;
    if (f.cats.size && !f.cats.has(p.category)) return false;

    if (f.sizes.size) {
      const sizes = (p.sizes || []).map(String);
      if (!sizes.some((s) => f.sizes.has(s))) return false;
    }

    if (p.price < f.minPrice) return false;
    if (p.price > f.maxPrice) return false;

    if (q) {
      const hay = [p.name, p.brand, (p.colors || []).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortFiltered();
  if (resetVisible) state.visible = PAGE_SIZE;
  renderGrid();
  updateActiveCount();
  updateApplyCount();
}

/* живое число товаров на кнопке мобильной панели фильтров */
function updateApplyCount() {
  const btn = $('#filtersApply');
  if (!btn) return;
  const n = state.filtered.length;
  btn.textContent = 'Показать ' + n + ' ' + pluralProducts(n);
}

const sorters = {
  new: (a, b) => (b.tags || []).includes('new') - (a.tags || []).includes('new') || a.price - b.price,
  cheap: (a, b) => a.price - b.price,
  expensive: (a, b) => b.price - a.price
};

function sortFiltered() {
  const fn = sorters[state.sort] || sorters.new;
  state.filtered.sort(fn);
}

function renderGrid() {
  const grid = $('#productsGrid');
  const list = state.filtered.slice(0, state.visible);

  if (!state.filtered.length) {
    grid.innerHTML = '';
    $('#emptyState').classList.remove('hidden');
    $('#loadMoreBtn').classList.add('hidden');
  } else {
    $('#emptyState').classList.add('hidden');
    grid.innerHTML = list.map(cardHTML).join('');
    $('#loadMoreBtn').classList.toggle('hidden', state.filtered.length <= state.visible);
  }

  $('#catalogCount').textContent =
    state.products.length + ' ' + pluralProducts(state.products.length);

  observeReveal();
}

function renderRail() {
  const track = $('#railTrack');
  if (!track) return;
  const items = state.products
    .filter((p) => (p.tags || []).includes('new'))
    .slice(0, 10);
  track.innerHTML = items.map(cardHTML).join('');
  observeReveal();
}

function cardHTML(p) {
  const flags = [];
  if ((p.tags || []).includes('new')) flags.push('<span class="flag"><i>•</i>NEW</span>');
  if ((p.tags || []).includes('sale')) flags.push('<span class="flag flag-sale"><i>•</i>SALE</span>');
  if ((p.tags || []).includes('drop')) flags.push('<span class="flag flag-drop"><i>•</i>DROP</span>');

  const old = p.oldPrice ? '<s class="product-old">' + money(p.oldPrice) + '</s>' : '';
  const fav = state.favs.includes(p.id) ? ' active' : '';
  const color = p.colors && p.colors.length ? '<p class="product-color">' + escapeHTML(p.colors.join(', ')) + '</p>' : '';

  return (
    '<article class="product-card reveal" data-id="' + escapeHTML(p.id) + '">' +
      '<div class="product-media">' +
        '<div class="product-flags">' + flags.join('') + '</div>' +
        '<button type="button" class="fav-btn' + fav + '" data-fav="' + escapeHTML(p.id) + '" aria-label="В избранное">' +
          '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 20.5s-6.8-4.4-8.8-8.3C1.7 9 3.3 5.8 6.5 5.8c1.9 0 3 1 3.9 2.1.7.9 1.3.9 1.6.9s.9 0 1.6-.9c.9-1.1 2-2.1 3.9-2.1 3.2 0 4.8 3.2 3.3 6.4-2 3.9-8.8 8.3-8.8 8.3z"/></svg>' +
        '</button>' +
        '<img src="' + escapeHTML(productImg(p)) + '" alt="' + escapeHTML(p.name) + '" loading="lazy">' +
      '</div>' +
      '<div class="product-info">' +
        '<p class="product-brand">' + escapeHTML(p.brand) + '</p>' +
        '<h3 class="product-name">' + escapeHTML(p.name) + '</h3>' +
        color +
        '<p class="product-price-row"><span class="product-price">' + money(p.price) + '</span>' + old + '</p>' +
      '</div>' +
    '</article>'
  );
}

function updateActiveCount() {
  const f = state.filters;
  let n = f.brands.size + f.cats.size + f.sizes.size;
  if (f.minPrice > state.priceBounds.min || f.maxPrice < state.priceBounds.max) n += 1;
  const badge = $('#activeFiltersCount');
  badge.hidden = n === 0;
  badge.textContent = n;
}

function resetFilters() {
  state.filters.query = '';
  state.filters.brands.clear();
  state.filters.cats.clear();
  state.filters.sizes.clear();
  state.filters.minPrice = state.priceBounds.min;
  state.filters.maxPrice = state.priceBounds.max;
  state.sort = 'new';

  $('#searchInput').value = '';
  $$('#brandFilters input, #categoryFilters input').forEach((i) => { i.checked = false; });
  $$('.size-chip.on').forEach((c) => c.classList.remove('on'));
  initPriceFilter();
  $('#sortSelect').value = 'new';

  hideSuggest();
  applyFilters({ resetVisible: true });
}

/* ---------- search + autocomplete ---------- */

function hideSuggest() {
  const box = $('#searchSuggest');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function renderSuggest(query) {
  const q = query.trim().toLowerCase();
  const box = $('#searchSuggest');
  if (q.length < 2) { hideSuggest(); return; }

  const matches = state.products.filter((p) => {
    const hay = (p.name + ' ' + p.brand).toLowerCase();
    return hay.includes(q);
  }).slice(0, 5);

  if (!matches.length) { hideSuggest(); return; }

  box.innerHTML = matches.map((p) => {
    const label = p.name + ' · ' + p.brand;
    const idx = label.toLowerCase().indexOf(q);
    const before = escapeHTML(label.slice(0, idx));
    const mid = escapeHTML(label.slice(idx, idx + q.length));
    const after = escapeHTML(label.slice(idx + q.length));
    return (
      '<button type="button" class="suggest-item" data-suggest="' + escapeHTML(p.id) + '">' +
        '<img src="' + escapeHTML(productImg(p)) + '" alt="">' +
        '<span>' + before + '<mark>' + mid + '</mark>' + after + '</span>' +
        '<span style="margin-left:auto;font-weight:700">' + money(p.price) + '</span>' +
      '</button>'
    );
  }).join('');
  box.classList.remove('hidden');
}

/* ---------- product modal ---------- */

let modalProduct = null;
let modalSize = null;

function openProductModal(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  modalProduct = p;
  modalSize = null;

  $('#modalImg').src = productImg(p);
  $('#modalImg').alt = p.name;
  $('#modalBrand').textContent = p.brand;
  $('#modalName').textContent = p.name;
  $('#modalPrice').textContent = money(p.price);

  const oldEl = $('#modalOld');
  if (p.oldPrice) { oldEl.textContent = money(p.oldPrice); oldEl.hidden = false; }
  else oldEl.hidden = true;

  $('#modalColors').textContent = p.colors && p.colors.length
    ? 'Цвета: ' + p.colors.join(', ')
    : '';

  $('#modalSizes').innerHTML = (p.sizes || []).map((s) => (
    '<button type="button" class="size-chip" data-modal-size="' + escapeHTML(String(s)) + '">' + escapeHTML(String(s)) + '</button>'
  )).join('');

  $('#modalSizeHint').textContent = 'Размер не выбран';
  $('#modalSizeHint').style.color = '';
  updateModalFavBtn();

  openModal('#productModal');
}

function updateModalFavBtn() {
  if (!modalProduct) return;
  const on = state.favs.includes(modalProduct.id);
  const btn = $('#modalFav');
  btn.textContent = on ? 'В избранном \u2713' : 'В избранное';
  btn.classList.toggle('btn-accent', on);
  btn.classList.toggle('btn-ghost', !on);
}

/* ---------- overlays ---------- */

function openModal(sel) {
  const m = $(sel);
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(sel) {
  const m = $(sel);
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  if (!$$('.modal.open').length && !$('#cartPanel').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

function openCart() {
  $('#cartPanel').classList.add('open');
  $('#cartPanel').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  $('#cartPanel').classList.remove('open');
  $('#cartPanel').setAttribute('aria-hidden', 'true');
  if (!$$('.modal.open').length) document.body.style.overflow = '';
}

function openFav() {
  $('#favPanel').classList.add('open');
  $('#favPanel').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeFav() {
  $('#favPanel').classList.remove('open');
  $('#favPanel').setAttribute('aria-hidden', 'true');
  if (!$$('.modal.open').length) document.body.style.overflow = '';
}

function renderFavPanel() {
  const box = $('#favItems');
  const empty = $('#favEmpty');
  const items = state.favs
    .map((id) => state.products.find((x) => x.id === id))
    .filter(Boolean);

  if (!items.length) {
    box.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  box.innerHTML = items.map((p) => (
    '<div class="cart-item fav-row" data-id="' + escapeHTML(p.id) + '">' +
      '<img class="cart-item-img" src="' + escapeHTML(productImg(p)) + '" alt="">' +
      '<div>' +
        '<p class="cart-item-brand">' + escapeHTML(p.brand) + '</p>' +
        '<p class="cart-item-name">' + escapeHTML(p.name) + '</p>' +
        '<p class="cart-item-size">' + money(p.price) + '</p>' +
      '</div>' +
      '<div class="cart-item-right">' +
        '<button type="button" class="cart-item-remove" data-unfav="' + escapeHTML(p.id) + '">Удалить</button>' +
      '</div>' +
    '</div>'
  )).join('');
}

function closeAllOverlays() {
  $$('.modal.open').forEach((m) => {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  });
  closeCart();
  closeFav();
  closeFilters();
  hideSuggest();
  document.body.style.overflow = '';
}

/* mobile filters panel */
function openFilters() {
  $('#filtersPanel').classList.add('open');
  $('#filtersBackdrop').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeFilters() {
  $('#filtersPanel').classList.remove('open');
  $('#filtersBackdrop').classList.remove('show');
  if (!$('.modal.open') && !$('#cartPanel').classList.contains('open')) {
    document.body.style.overflow = '';
  }
}

/* ---------- favorites ---------- */

function toggleFav(id) {
  const i = state.favs.indexOf(id);
  if (i === -1) {
    state.favs.push(id);
    showToast('Добавлено в избранное');
  } else {
    state.favs.splice(i, 1);
    showToast('Убрано из избранного');
  }
  storeSet(LS_FAV, state.favs);

  const p = state.products.find((x) => x.id === id);
  updateFavBadge(p);
  if ($('#favPanel').classList.contains('open')) renderFavPanel();

  if (modalProduct && modalProduct.id === id) updateModalFavBtn();
}

function updateFavBadge(p) {
  const btn = $('.fav-btn[data-fav="' + p.id + '"]');
  if (btn) btn.classList.toggle('active', state.favs.includes(p.id));
  const n = state.favs.length;
  $('#favCount').hidden = n === 0;
  $('#favCount').textContent = n;
}

/* ---------- cart ---------- */

function addToCart(p, size) {
  const key = p.id + '::' + size;
  const existing = state.cart.find((c) => c.key === key);
  if (existing) existing.qty += 1;
  else state.cart.push({ key, id: p.id, size, qty: 1 });
  storeSet(LS_CART, state.cart);
  renderCart();
  flyToCart(p);
  showToast('Товар добавлен — перейти в корзину', {
    actionLabel: 'Корзина',
    duration: 4000,
    onAction: openCart
  });
}

function cartTotalQty() {
  return state.cart.reduce((sum, c) => sum + c.qty, 0);
}

function cartTotalSum() {
  return state.cart.reduce((sum, c) => {
    const p = state.products.find((x) => x.id === c.id);
    return sum + (p ? p.price * c.qty : 0);
  }, 0);
}

function renderCart() {
  const itemsBox = $('#cartItems');
  const foot = $('#cartFoot');
  const empty = $('#cartEmpty');

  $('#cartCount').hidden = cartTotalQty() === 0;
  $('#cartCount').textContent = cartTotalQty();

  if (!state.cart.length) {
    itemsBox.innerHTML = '';
    foot.hidden = true;
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  foot.hidden = false;

  itemsBox.innerHTML = state.cart.map((c) => {
    const p = state.products.find((x) => x.id === c.id);
    if (!p) return '';
    return (
      '<div class="cart-item" data-key="' + escapeHTML(c.key) + '">' +
        '<img class="cart-item-img" src="' + escapeHTML(productImg(p)) + '" alt="">' +
        '<div>' +
          '<p class="cart-item-brand">' + escapeHTML(p.brand) + '</p>' +
          '<p class="cart-item-name">' + escapeHTML(p.name) + '</p>' +
          '<p class="cart-item-size">Размер: ' + escapeHTML(c.size) + '</p>' +
          '<div class="cart-item-ctrl">' +
            '<button type="button" class="qty-btn" data-qty="-1" aria-label="Меньше">−</button>' +
            '<span class="qty-num">' + c.qty + '</span>' +
            '<button type="button" class="qty-btn" data-qty="1" aria-label="Больше">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item-right">' +
          '<span class="cart-item-price">' + money(p.price * c.qty) + '</span>' +
          '<button type="button" class="cart-item-remove" data-remove>Удалить</button>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  $('#cartTotal').textContent = money(cartTotalSum());
}

function changeQty(key, delta) {
  const item = state.cart.find((c) => c.key === key);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter((c) => c.key !== key);
  storeSet(LS_CART, state.cart);
  renderCart();
}

function removeItem(key) {
  state.cart = state.cart.filter((c) => c.key !== key);
  storeSet(LS_CART, state.cart);
  renderCart();
}

/* fly-to-cart animation */
function flyToCart(p) {
  const ghost = $('#flyGhost');
  const card = $('.product-card[data-id="' + p.id + '"] img');
  const cartBtn = $('#cartOpenBtn');
  if (!card || !cartBtn) return;

  const from = card.getBoundingClientRect();
  const to = cartBtn.getBoundingClientRect();

  ghost.style.backgroundImage = 'url("' + productImg(p) + '")';
  ghost.style.setProperty('--fx0', '0px');
  ghost.style.setProperty('--fy0', '0px');
  ghost.style.setProperty('--fx1', (to.left + to.width / 2 - (from.left + from.width / 2)) + 'px');
  ghost.style.setProperty('--fy1', (to.top + to.height / 2 - (from.top + from.height / 2)) + 'px');
  ghost.style.left = (from.left + from.width / 2 - 30) + 'px';
  ghost.style.top = (from.top + from.height / 2 - 37) + 'px';

  ghost.classList.remove('fly');
  void ghost.offsetWidth; // restart animation
  ghost.classList.add('fly');

  const bump = () => {
    const badge = $('#cartCount');
    if (!badge.hidden) {
      badge.style.transform = 'scale(1.4)';
      setTimeout(() => { badge.style.transform = ''; }, 180);
    }
  };
  setTimeout(bump, 700);
}

/* ---------- drop countdown (каждую пятницу 19:00) ---------- */

function nextFriday() {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  d.setHours(19, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

let dropDeadline = nextFriday();

function tickCountdown() {
  const now = new Date();
  let diff = dropDeadline - now;
  if (diff <= 0) { dropDeadline = nextFriday(); diff = dropDeadline - now; }

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor(diff / 3600000) % 24;
  const mins = Math.floor(diff / 60000) % 60;
  const secs = Math.floor(diff / 1000) % 60;

  $('#cdDays').textContent = String(days).padStart(2, '0');
  $('#cdHours').textContent = String(hours).padStart(2, '0');
  $('#cdMins').textContent = String(mins).padStart(2, '0');
  $('#cdSecs').textContent = String(secs).padStart(2, '0');
}

/* ---------- lead forms (Google Apps Script) ---------- */

const PHONE_PREFIX = '+7 ';
const PHONE_FULL_RE = /^\+7 \(\d{3}\) \d{3}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPhoneValue(v) {
  return /^[\d+]/.test(v);
}

function formatPhoneInput(raw) {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d.startsWith('7')) d = d.slice(1);
  d = d.slice(0, 10);

  let out = PHONE_PREFIX;
  if (d.length) out += '(' + d.slice(0, 3);
  if (d.length >= 3) out += ')';
  if (d.length > 3) out += ' ' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  if (d.length > 8) out += '-' + d.slice(8, 10);
  return out;
}

function validateContact(v) {
  const t = v.trim();
  if (!t) return 'Укажи телефон или email';
  if (isPhoneValue(t) && !PHONE_FULL_RE.test(t)) {
    return 'Введи телефон полностью: +7 (XXX) XXX-XX-XX';
  }
  if (!isPhoneValue(t) && !EMAIL_RE.test(t)) {
    return 'Введи корректный email';
  }
  return '';
}

function setFieldError(input, msg) {
  clearFieldError(input);
  input.classList.add('invalid');
  const field = input.closest('.field');
  if (!field) return;
  const p = document.createElement('p');
  p.className = 'field-error';
  p.textContent = msg;
  field.appendChild(p);
}

function clearFieldError(input) {
  input.classList.remove('invalid');
  const field = input.closest('.field');
  if (!field) return;
  const err = field.querySelector('.field-error');
  if (err) err.remove();
}

function bindContactField(input) {
  if (!input) return;
  let prev = input.value;

  input.addEventListener('focus', () => {
    if (input.value.trim() === '') input.value = PHONE_PREFIX;
    input.setSelectionRange(input.value.length, input.value.length);
    prev = input.value;
  });

  input.addEventListener('input', () => {
    const v = input.value;
    clearFieldError(input);

    // первый символ — буква поверх автопрефикса: это email, снимаем префикс
    if (prev === PHONE_PREFIX && v.length > prev.length && /[a-zA-Zа-яА-Я@]/.test(v.charAt(prev.length))) {
      input.value = v.slice(prev.length);
      prev = input.value;
      return;
    }

    if (v && isPhoneValue(v)) {
      input.value = formatPhoneInput(v);
      input.setSelectionRange(input.value.length, input.value.length);
    }
    prev = input.value;
  });
}

async function sendLead(payload) {
  if (!APPS_SCRIPT_URL) {
    console.warn('URL Apps Script не заполнен, отправка пропущена');
    return { ok: true, demo: true };
  }
  if (APPS_SCRIPT_URL.includes('XXXXXXXX')) {
    console.warn('APPS_SCRIPT_URL не настроен — демо-режим, заявка никуда не ушла.');
    return { ok: true, demo: true };
  }
  // ответ opaque — никогда не читаем; успех = fetch завершился без исключения
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return { ok: true };
  } catch (err) {
    console.error('Ошибка отправки:', err);
    return { ok: true };
  }
}

function bindLeadForm(formSel, successSel, submitBtn, payloadFn, onSuccess) {
  const form = $(formSel);
  const contactInput = form.querySelector('[name=contact]');
  const defaultLabel = () => (form.id === 'checkoutForm' ? 'Отправить заявку' : 'Встать в лист ожидания');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.querySelector('[name=name]').value.trim();
    const contact = contactInput.value.trim();
    const consent = form.querySelector('input[type=checkbox]').checked;

    if (!name) { showToast('Укажи имя'); return; }
    const contactError = validateContact(contact);
    if (contactError) {
      setFieldError(contactInput, contactError);
      showToast(contactError);
      return;
    }
    if (!consent) { showToast('Нужно согласие на обработку данных'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляем…';

    try {
      // response с mode:'no-cors прочитать нельзя (opaque) — сам факт
      // завершения fetch (или таймаут 10с) считается успехом
      await Promise.race([
        sendLead(payloadFn(name, contact)),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ]);
    } catch (err) {
      console.error('Ошибка отправки:', err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultLabel();
      form.reset();
      form.hidden = true;
      $(successSel).classList.remove('hidden');
      if (onSuccess) onSuccess();
    }
  });
}

/* ---------- reveal on scroll ---------- */

let revealObserver;

function observeReveal() {
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });
  }
  $$('.reveal:not(.in)').forEach((el) => revealObserver.observe(el));
}

/* ---------- header shrink ---------- */

function bindHeaderShrink() {
  const header = $('#siteHeader');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---------- events ---------- */

function bindEvents() {
  /* grid + rail: card click / fav */
  const onCardClick = (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      toggleFav(favBtn.dataset.fav);
      return;
    }
    const card = e.target.closest('.product-card');
    if (card) openProductModal(card.dataset.id);
  };
  $('#productsGrid').addEventListener('click', onCardClick);
  $('#railTrack').addEventListener('click', onCardClick);

  /* rail arrows */
  const railTrack = $('#railTrack');
  const railStep = () => {
    const cards = railTrack.querySelectorAll('.product-card');
    if (cards.length > 1) {
      return cards[1].getBoundingClientRect().left - cards[0].getBoundingClientRect().left;
    }
    const card = railTrack.querySelector('.product-card');
    return card ? card.getBoundingClientRect().width + 24 : 320;
  };
  $('#railPrev').addEventListener('click', () => railTrack.scrollBy({ left: -railStep(), behavior: 'smooth' }));
  $('#railNext').addEventListener('click', () => railTrack.scrollBy({ left: railStep(), behavior: 'smooth' }));

  /* search */
  $('#searchInput').addEventListener('input', debounce((e) => {
    state.filters.query = e.target.value;
    renderSuggest(e.target.value);
    applyFilters({ resetVisible: true });
  }, 200));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideSuggest();
    const sug = e.target.closest('[data-suggest]');
    if (sug) {
      hideSuggest();
      openProductModal(sug.dataset.suggest);
    }
  });

  /* brand + category checkboxes */
  $('#brandFilters').addEventListener('change', (e) => {
    const input = e.target;
    if (input.name !== 'brand') return;
    if (input.checked) state.filters.brands.add(input.value);
    else state.filters.brands.delete(input.value);
    applyFilters({ resetVisible: true });
  });

  $('#categoryFilters').addEventListener('change', (e) => {
    const input = e.target;
    if (input.name !== 'cat') return;
    if (input.checked) state.filters.cats.add(input.value);
    else state.filters.cats.delete(input.value);
    applyFilters({ resetVisible: true });
  });

  $('#brandReset').addEventListener('click', () => {
    state.filters.brands.clear();
    $$('#brandFilters input').forEach((i) => { i.checked = false; });
    applyFilters({ resetVisible: true });
  });

  /* sizes */
  $('#sizeFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.size-chip');
    if (!chip) return;
    const s = chip.dataset.size;
    chip.classList.toggle('on');
    if (chip.classList.contains('on')) state.filters.sizes.add(s);
    else state.filters.sizes.delete(s);
    applyFilters({ resetVisible: true });
  });

  /* price */
  const minInput = $('#priceMin');
  const maxInput = $('#priceMax');
  const range = $('#priceRange');

  function applyPrice(fromRange) {
    let lo = parseInt(minInput.value, 10);
    let hi = parseInt(maxInput.value, 10);
    if (Number.isNaN(lo)) lo = state.priceBounds.min;
    if (Number.isNaN(hi)) hi = state.priceBounds.max;
    lo = Math.min(Math.max(lo, state.priceBounds.min), state.priceBounds.max);
    hi = Math.min(Math.max(hi, state.priceBounds.min), state.priceBounds.max);
    if (lo > hi) { if (fromRange) { hi = lo; } else { lo = hi; } }

    state.filters.minPrice = lo;
    state.filters.maxPrice = hi;
    minInput.value = lo;
    maxInput.value = hi;
    $('#priceFromLabel').textContent = money(lo);
    $('#priceToLabel').textContent = money(hi);
    if (fromRange) range.value = hi;
    applyFilters({ resetVisible: true });
  }

  minInput.addEventListener('change', () => applyPrice(false));
  maxInput.addEventListener('change', () => applyPrice(false));
  range.addEventListener('input', () => {
    maxInput.value = range.value;
    applyPrice(true);
  });

  $('#resetFilters').addEventListener('click', resetFilters);
  $('#emptyReset').addEventListener('click', resetFilters);

  /* sort */
  $('#sortSelect').addEventListener('change', (e) => {
    state.sort = e.target.value;
    sortFiltered();
    renderGrid();
  });

  /* load more */
  $('#loadMoreBtn').addEventListener('click', () => {
    state.visible += PAGE_SIZE;
    renderGrid();
  });

  /* modal */
  $$('#productModal [data-close-modal], #checkoutModal [data-close-modal]').forEach((el) => {
    el.addEventListener('click', () => closeModal('#' + el.closest('.modal').id));
  });

  $('#modalSizes').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-modal-size]');
    if (!chip) return;
    modalSize = chip.dataset.modalSize;
    $$('#modalSizes .size-chip').forEach((c) => c.classList.remove('on'));
    chip.classList.add('on');
    $('#modalSizeHint').textContent = 'Размер: ' + modalSize;
    $('#modalSizeHint').style.color = 'var(--ink)';
  });

  $('#modalAddCart').addEventListener('click', () => {
    if (!modalProduct) return;
    if (!modalSize) {
      const hint = $('#modalSizeHint');
      hint.textContent = 'Сначала выбери размер';
      hint.style.color = 'var(--danger)';
      return;
    }
    addToCart(modalProduct, modalSize);
    closeModal('#productModal');
  });

  $('#modalFav').addEventListener('click', () => {
    if (modalProduct) toggleFav(modalProduct.id);
  });

  /* cart */
  $('#cartOpenBtn').addEventListener('click', openCart);
  $('#cartClose').addEventListener('click', closeCart);
  $('#cartBackdrop').addEventListener('click', closeCart);
  $('#cartEmptyBtn').addEventListener('click', () => {
    closeCart();
    location.hash = '#catalog';
  });

  $('#cartItems').addEventListener('click', (e) => {
    const row = e.target.closest('.cart-item');
    if (!row) return;
    const key = row.dataset.key;
    const qtyBtn = e.target.closest('[data-qty]');
    if (qtyBtn) { changeQty(key, Number(qtyBtn.dataset.qty)); return; }
    if (e.target.closest('[data-remove]')) removeItem(key);
  });

  /* checkout */
  $('#checkoutBtn').addEventListener('click', () => {
    if (!state.cart.length) return;
    $('#checkoutSum').textContent = money(cartTotalSum());
    $('#checkoutForm').hidden = false;
    $('#checkoutSuccess').classList.add('hidden');
    closeCart();
    openModal('#checkoutModal');
  });

  /* favorites panel */
  $('#favOpenBtn').addEventListener('click', () => {
    renderFavPanel();
    openFav();
  });
  $('#favClose').addEventListener('click', closeFav);
  $('#favBackdrop').addEventListener('click', closeFav);
  $('#favEmptyBtn').addEventListener('click', () => {
    closeFav();
    location.hash = '#catalog';
  });

  $('#favItems').addEventListener('click', (e) => {
    const unfav = e.target.closest('[data-unfav]');
    if (unfav) {
      toggleFav(unfav.dataset.unfav);
      return;
    }
    const row = e.target.closest('.fav-row');
    if (row) {
      closeFav();
      openProductModal(row.dataset.id);
    }
  });

  /* to top */
  const toTopBtn = $('#toTop');
  const onToTopScroll = () => toTopBtn.classList.toggle('show', window.scrollY > 600);
  window.addEventListener('scroll', onToTopScroll, { passive: true });
  onToTopScroll();
  toTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* mobile filters */
  $('#filterToggle').addEventListener('click', openFilters);
  $('#burgerBtn').addEventListener('click', openFilters);
  $('#filtersClose').addEventListener('click', closeFilters);
  $('#filtersBackdrop').addEventListener('click', closeFilters);
  $('#filtersApply').addEventListener('click', closeFilters);

  /* esc */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllOverlays();
  });

  /* contact masks */
  bindContactField($('#dropContact'));
  bindContactField($('#coContact'));

  /* lead forms */
  bindLeadForm('#dropForm', '#dropSuccess', $('#dropSubmit'), (name, contact) => ({
    name, contact,
    source: 'лист ожидания',
    comment: 'Дроп 042 — NB 9060 «Sea Salt» + капсула пополнения'
  }));

  bindLeadForm('#checkoutForm', '#checkoutSuccess', $('#coSubmit'), (name, contact) => ({
    name, contact,
    source: 'заказ',
    comment: 'Заказ на сумму ' + money(cartTotalSum()) + ' — ' + cartTotalQty() + ' ' +
      plural(cartTotalQty(), 'товар', 'товара', 'товаров')
  }), () => {
    state.cart = [];
    storeSet(LS_CART, state.cart);
    renderCart();
  });
}

/* ---------- init ---------- */

function init() {
  state.cart = storeGet(LS_CART, []);
  state.favs = storeGet(LS_FAV, []);

  renderCart();
  $('#favCount').hidden = state.favs.length === 0;
  $('#favCount').textContent = state.favs.length;

  bindEvents();
  bindHeaderShrink();
  observeReveal();

  tickCountdown();
  setInterval(tickCountdown, 1000);

  loadProducts();
}

document.addEventListener('DOMContentLoaded', init);
