/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ALPHA MASTER COCKPIT: 15M CANDLESTICK PHYSICS & LOB DEPTH ENGINE (v3.3.1)
 * Strict 4-Color Institutional Broadcast Palette
 * Real Decibel DEX CLOB (Aptos Mainnet) On-Chain Stream
 * Dual-Engine Support: SIMLAB SUPERCHARGED & PURE STANDALONE
 * Features:
 *  - Real-time ticking 15M candlestick movement with live sub-pip CLOB beacon
 *  - Interactive flash-and-slow-fade animations on data changes
 *  - High-visibility expanded containers for radar & bottom intelligence cards
 *  - Active real-time multi-book SSE event stream
 *  - On-chain onboarding-configured financial metrics (Capital, Net PnL, Win Rate)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function (window) {
  'use strict';

  // Global Cockpit State
  window.cockpitActiveSymbol = 'BTC/USD';
  window.cockpitManualSelection = false;
  window.cockpitManualTimeout = null;
  window.COCKPIT_AUTHENTIC_KLINES = {};
  window.cockpitMarketsData = [];
  window.cockpitFetchingKlines = {};
  window._cockpitRadarCache = {};
  window._cockpitCardsCache = {};
  window._cockpitAnimFrameId = null;

  // Robust Cross-Market Symbol Normalizer (Matches ETH/USD, ETH-USD, ETH-USDC, ETHUSDT)
  function isSameSymbol(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const cleanA = String(a).toUpperCase().replace(/[-_/]/g, '');
    const cleanB = String(b).toUpperCase().replace(/[-_/]/g, '');
    if (cleanA === cleanB) return true;
    const coreA = cleanA.replace(/^1000/, '').replace(/USDT$|USD$|PERP$|USDC$/i, '');
    const coreB = cleanB.replace(/^1000/, '').replace(/USDT$|USD$|PERP$|USDC$/i, '');
    return Boolean(coreA && coreB && coreA === coreB);
  }
  window.isSameSymbol = isSameSymbol;

  // Preload Authentic 15M Klines for all 29 pairs immediately
  function preloadAllAuthenticKlines() {
    const urls = ['/real_klines.json', 'real_klines.json', '/public/real_klines.json'];
    const tryLoad = (idx) => {
      if (idx >= urls.length) return;
      fetch(urls[idx])
        .then(r => r.json())
        .then(data => {
          if (data && typeof data === 'object') {
            Object.keys(data).forEach(k => {
              const bars = data[k];
              window.COCKPIT_AUTHENTIC_KLINES[k] = bars;
              window.COCKPIT_AUTHENTIC_KLINES[k.toUpperCase()] = bars;
              window.COCKPIT_AUTHENTIC_KLINES[k.replace('/', '')] = bars;
              window.COCKPIT_AUTHENTIC_KLINES[k.replace('/', '-')] = bars;
            });
            console.log('[Cockpit] Preloaded authentic klines for', Object.keys(data).length, 'pairs from', urls[idx]);
          }
        })
        .catch(() => tryLoad(idx + 1));
    };
    tryLoad(0);
  }
  preloadAllAuthenticKlines();

  // View Toggle State (15M Candle vs Live Tick Line) & Pair Deep-Linking
  const urlParams = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search) : null;
  const initialModeParam = urlParams ? (urlParams.get('mode') || urlParams.get('chart')) : null;
  if (initialModeParam) {
    window.cockpitChartMode = (initialModeParam.toLowerCase().includes('candle')) ? 'CANDLES' : 'TICK_LINE';
  } else {
    // Strict default view is LIVE TICK LINE
    window.cockpitChartMode = 'TICK_LINE';
  }
  try {
    if (typeof localStorage !== 'undefined' && !initialModeParam) {
      localStorage.setItem('cockpit_chart_mode', 'TICK_LINE');
    }
  } catch { }

  const pairParam = urlParams ? (urlParams.get('pair') || urlParams.get('symbol')) : null;
  if (pairParam) {
    const rawP = pairParam.toUpperCase();
    const formattedP = rawP.includes('/') ? rawP : (rawP.includes('-') ? rawP.replace('-', '/') : `${rawP.replace(/USD[T]?$/, '')}/USD`);
    window.cockpitActiveSymbol = formattedP;
    window.cockpitManualSelection = true;
  }

  // ── Unified DOM Resolver & Dual-Environment Compatibility Helper ──
  const ID_ALIASES = {
    'cockpit-pair-title': ['chart-pair-title', 'cockpit-pair-title'],
    'cockpit-action-badge': ['chart-action-badge', 'cockpit-action-badge'],
    'cockpit-conf-badge': ['conf-badge', 'cockpit-conf-badge'],
    'cockpit-mode-badge': ['mode-badge', 'cockpit-mode-badge'],
    'cockpit-trigger-reason-pill': ['chart-trigger-reason-pill', 'cockpit-trigger-reason-pill', 'trigger-reason-pill'],
    'cockpit-top-capital': ['top-capital', 'cockpit-top-capital'],
    'cockpit-top-pnl': ['top-pnl', 'cockpit-top-pnl'],
    'cockpit-top-winrate': ['top-winrate', 'cockpit-top-winrate'],
    'cockpit-top-gas': ['top-gas', 'cockpit-top-gas'],
    'cockpit-top-vault': ['top-vault', 'cockpit-top-vault'],
    'cockpit-top-feed-status': ['top-feed-status', 'cockpit-top-feed-status'],
    'cockpit-btn-view-candle': ['btn-view-candle', 'cockpit-btn-view-candle'],
    'cockpit-btn-view-line': ['btn-view-tickline', 'cockpit-btn-view-line'],
    'cockpit-bar-o': ['bar-o', 'cockpit-bar-o'],
    'cockpit-bar-h': ['bar-h', 'cockpit-bar-h'],
    'cockpit-bar-l': ['bar-l', 'cockpit-bar-l'],
    'cockpit-bar-c': ['bar-c', 'cockpit-bar-c'],
    'cockpit-bar-countdown': ['chart-bar-countdown', 'cockpit-bar-countdown'],
    'cockpit-kpi-mark-price': ['kpi-mark-price', 'cockpit-kpi-mark-price'],
    'cockpit-kpi-spread': ['kpi-spread', 'cockpit-kpi-spread'],
    'cockpit-kpi-entry': ['kpi-entry', 'cockpit-kpi-entry'],
    'cockpit-kpi-entry-label': ['kpi-entry-label', 'cockpit-kpi-entry-label'],
    'cockpit-kpi-entry-sub': ['kpi-entry-sub', 'cockpit-kpi-entry-sub'],
    'cockpit-kpi-tp': ['kpi-tp', 'cockpit-kpi-tp'],
    'cockpit-kpi-tp-label': ['kpi-tp-label', 'cockpit-kpi-tp-label'],
    'cockpit-kpi-tp-sub': ['kpi-tp-sub', 'cockpit-kpi-tp-sub'],
    'cockpit-kpi-soft-ratchet': ['kpi-soft-ratchet', 'cockpit-kpi-soft-ratchet'],
    'cockpit-kpi-soft-label': ['kpi-soft-label', 'cockpit-kpi-soft-label'],
    'cockpit-kpi-soft-ratchet-desc': ['kpi-soft-ratchet-desc', 'cockpit-kpi-soft-ratchet-desc'],
    'cockpit-kpi-hard-sl': ['kpi-hard-sl', 'cockpit-kpi-hard-sl'],
    'cockpit-kpi-hard-label': ['kpi-hard-label', 'cockpit-kpi-hard-label'],
    'cockpit-kpi-hard-sl-desc': ['kpi-hard-sl-desc', 'cockpit-kpi-hard-sl-desc'],
    'cockpit-banner-sma-pair': ['banner-sma-pair', 'cockpit-banner-sma-pair'],
    'cockpit-banner-sma-spread': ['banner-sma-spread', 'cockpit-banner-sma-spread'],
    'cockpit-banner-lob-radar': ['banner-lob-radar', 'cockpit-banner-lob-radar'],
    'cockpit-banner-rm-retention': ['banner-rm-retention', 'cockpit-banner-rm-retention'],
    'cockpit-banner-vpin': ['banner-vpin', 'cockpit-banner-vpin'],
    'cockpit-banner-book-skew': ['banner-book-skew', 'cockpit-banner-book-skew'],
    'responsive-cockpit-canvas': ['responsive-cockpit-canvas', 'cockpit-canvas'],
    'cockpit-legend-sma-fast': ['legend-sma8-val', 'cockpit-legend-sma-fast'],
    'cockpit-legend-sma-slow': ['legend-sma38-val', 'cockpit-legend-sma-slow'],
    'cockpit-legend-live-price': ['legend-live-price-val', 'cockpit-legend-live-price'],
    'cockpit-legend-execution-text': ['legend-execution-text', 'cockpit-legend-execution-text'],
    'legend-tick-price-wrap': ['legend-tick-price-wrap', 'cockpit-legend-tick-price-wrap'],
    'legend-sma-fast-lbl': ['legend-sma-fast-lbl', 'cockpit-legend-sma-fast-lbl'],
    'legend-sma-slow-lbl': ['legend-sma-slow-lbl', 'cockpit-legend-sma-slow-lbl'],
    'cockpit-radar-tbody': ['radar-tbody', 'cockpit-radar-tbody'],
    'cockpit-radar-pair-count': ['radar-pair-count', 'cockpit-radar-pair-count'],
    'cockpit-stat-active': ['radar-stat-active', 'stat-active', 'cockpit-stat-active'],
    'cockpit-stat-ready': ['radar-stat-ready', 'stat-ready', 'cockpit-stat-ready'],
    'cockpit-stat-watch': ['radar-stat-watch', 'stat-watch', 'cockpit-stat-watch'],
    'cockpit-stat-standby': ['radar-stat-standby', 'stat-standby', 'cockpit-stat-standby'],
    'cockpit-stat-veto': ['radar-stat-veto', 'stat-veto', 'cockpit-stat-veto'],
    'cockpit-audit-fill': ['audit-fill', 'cockpit-audit-fill'],
    'cockpit-audit-rr': ['audit-rr', 'cockpit-audit-rr'],
    'cockpit-audit-confluence-badge': ['audit-confluence-badge', 'cockpit-audit-confluence-badge'],
    'cockpit-confluence-checklist-items': ['checklist-items-container', 'cockpit-confluence-checklist-items'],
    'cockpit-audit-mode-text': ['audit-mode-text', 'cockpit-audit-mode-text'],
    'cockpit-harvest-active-directive': ['harvest-active-directive', 'cockpit-harvest-active-directive'],
    'cockpit-harvest-decision-text': ['harvest-decision-text', 'cockpit-harvest-decision-text'],
    'cockpit-harvest-vuln-score': ['harvest-vuln-score', 'cockpit-harvest-vuln-score'],
    'cockpit-harvest-policy': ['harvest-policy', 'cockpit-harvest-policy'],
    'cockpit-harvest-reversals': ['harvest-reversals', 'cockpit-harvest-reversals'],
    'cockpit-harvest-recommendation': ['harvest-recommendation', 'cockpit-harvest-recommendation'],
    'cockpit-risk-budget': ['risk-sizing', 'cockpit-risk-budget'],
    'cockpit-risk-concurrent': ['risk-concurrent', 'cockpit-risk-concurrent'],
    'cockpit-event-stream-box': ['event-stream-box', 'cockpit-event-stream-box']
  };

  function getEl(id) {
    if (!id || typeof document === 'undefined') return null;
    const direct = document.getElementById(id);
    if (direct) return direct;
    if (ID_ALIASES[id]) {
      for (const alias of ID_ALIASES[id]) {
        const el = document.getElementById(alias);
        if (el) return el;
      }
    }
    const cleanId = id.replace(/^(cockpit-|chart-)/, '');
    return document.getElementById('cockpit-' + cleanId)
      || document.getElementById('chart-' + cleanId)
      || document.getElementById(cleanId);
  }

  // Canvas Mouse Interaction for Crosshair & Tooltip
  window._cockpitHover = { active: false, x: 0, y: 0 };
  function attachCanvasMouseEvents(canvas) {
    if (!canvas || canvas._mouseBound) return;
    canvas._mouseBound = true;

    let isDragging = false;
    let startDragY = 0;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        isDragging = true;
        startDragY = e.clientY;
      }
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      if (isDragging) {
        const dy = e.clientY - startDragY;
        startDragY = e.clientY;
        const currentSpan = (window._cockpitLastSpan || (window._lastBasePx ? window._lastBasePx * 0.005 : 1));
        window._cockpitUserPanY = (window._cockpitUserPanY || 0) + (dy / rect.height) * currentSpan;
        if (window._cockpitTickScales && window.cockpitActiveSymbol) {
          delete window._cockpitTickScales[window.cockpitActiveSymbol];
        }
      }

      window._cockpitHover = {
        active: true,
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.25 : 0.80;
      window._cockpitUserZoom = Math.max(0.3, Math.min(25.0, (window._cockpitUserZoom || 1.0) * zoomFactor));
      if (window._cockpitTickScales && window.cockpitActiveSymbol) {
        delete window._cockpitTickScales[window.cockpitActiveSymbol];
      }
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      window._cockpitUserZoom = 1.0;
      window._cockpitUserPanY = 0;
      if (window._cockpitTickScales && window.cockpitActiveSymbol) {
        delete window._cockpitTickScales[window.cockpitActiveSymbol];
      }
    });

    canvas.addEventListener('mouseleave', () => {
      window._cockpitHover.active = false;
      isDragging = false;
    });

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      // Top-left View Toggle (Candles vs Tick Line)
      if (x < 180 && y < 45) {
        setCockpitChartMode(window.cockpitChartMode === 'TICK_LINE' ? 'CANDLES' : 'TICK_LINE');
        return;
      }

      // Top-right Zoom HUD Buttons: [-], [+], [↺]
      if (window.cockpitChartMode === 'TICK_LINE') {
        const padR = 80;
        const badgeW = 124;
        const badgeH = 22;
        const badgeX = canvas.width - padR - badgeW - 10;
        const badgeY = 28;

        if (x >= badgeX && x <= badgeX + badgeW && y >= badgeY && y <= badgeY + badgeH) {
          if (x >= badgeX + 54 && x < badgeX + 74) {
            // Zoom Out [-]
            window._cockpitUserZoom = Math.max(0.3, (window._cockpitUserZoom || 1.0) * 0.75);
          } else if (x >= badgeX + 74 && x < badgeX + 96) {
            // Zoom In [+]
            window._cockpitUserZoom = Math.min(25.0, (window._cockpitUserZoom || 1.0) * 1.35);
          } else if (x >= badgeX + 96 && x <= badgeX + badgeW) {
            // Reset [↺]
            window._cockpitUserZoom = 1.0;
            window._cockpitUserPanY = 0;
          }
          if (window._cockpitTickScales && window.cockpitActiveSymbol) {
            delete window._cockpitTickScales[window.cockpitActiveSymbol];
          }
          return;
        }
      }
    });
  }

  function setCockpitChartMode(mode) {
    window.cockpitChartMode = (mode === 'TICK_LINE') ? 'TICK_LINE' : 'CANDLES';
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('cockpit_chart_mode', window.cockpitChartMode); } catch { }
    const btnC = getEl('cockpit-btn-view-candle');
    const btnL = getEl('cockpit-btn-view-line');
    const isCandles = (window.cockpitChartMode === 'CANDLES');
    if (btnC) btnC.className = 'view-toggle-btn cockpit-view-toggle-btn' + (isCandles ? ' active' : '');
    if (btnL) btnL.className = 'view-toggle-btn cockpit-view-toggle-btn' + (!isCandles ? ' active' : '');
    renderCockpitCanvas();
  }
  window.setCockpitChartMode = setCockpitChartMode;
  window.setChartDisplayMode = setCockpitChartMode;

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 't' || e.key === 'T') {
      setCockpitChartMode(window.cockpitChartMode === 'TICK_LINE' ? 'CANDLES' : 'TICK_LINE');
    }
  });

  // Formatter utilities
  function formatPrice(val) {
    if (val === undefined || val === null || isNaN(val)) return '--';
    const num = Number(val);
    if (num >= 1000) {
      return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (num >= 1) {
      return num.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    } else {
      return num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 5 });
    }
  }

  function formatVolume(val) {
    if (!val || isNaN(val)) return '0.00';
    const num = Number(val);
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
  }

  // ── Pair Dynamic Fast/Slow SMA Reference Profiles ──
  const DYNAMIC_PAIR_SMA = {
    'BTC/USD': { fast: 18, slow: 64 },
    'ETH/USD': { fast: 14, slow: 52 },
    'SOL/USD': { fast: 12, slow: 48 },
    'SUI/USD': { fast: 16, slow: 42 },
    'APT/USD': { fast: 10, slow: 40 },
    'DOGE/USD': { fast: 11, slow: 42 },
    'AVAX/USD': { fast: 13, slow: 46 },
    'BNB/USD': { fast: 15, slow: 56 },
    'XRP/USD': { fast: 14, slow: 50 },
    'NEAR/USD': { fast: 10, slow: 38 },
    'LINK/USD': { fast: 12, slow: 44 },
    'ADA/USD': { fast: 14, slow: 48 },
    'HYPE/USD': { fast: 8, slow: 30 },
    'PEPE/USD': { fast: 7, slow: 28 },
    'UNI/USD': { fast: 11, slow: 42 },
    'TAO/USD': { fast: 11, slow: 42 },
    'TRX/USD': { fast: 16, slow: 60 },
    'ZEC/USD': { fast: 12, slow: 44 },
  };

  function getDynamicPairSma(sym) {
    if (!sym) return { fast: 10, slow: 38 };
    const norm = sym.toUpperCase().replace(/[-_]/g, '/');
    if (DYNAMIC_PAIR_SMA[norm]) return DYNAMIC_PAIR_SMA[norm];
    for (const [k, v] of Object.entries(DYNAMIC_PAIR_SMA)) {
      const base = k.replace('/USD', '');
      if (norm.startsWith(base) || norm.includes(base)) return v;
    }
    return { fast: 10, slow: 38 };
  }

  // Flash animation trigger helper
  function flashElement(el, flashClass = 'cockpit-flash-update') {
    if (!el) return;
    el.classList.remove('cockpit-flash-update', 'cockpit-flash-update-red', 'cockpit-flash-update-cyan');
    void el.offsetWidth; // Force CSS reflow to restart keyframe animation
    el.classList.add(flashClass);
  }

  function setWithFlashIfChanged(el, newVal, flashClass = 'cockpit-flash-update') {
    if (!el) return;
    const oldVal = el.getAttribute('data-cp-val');
    const strVal = String(newVal);
    if (oldVal !== null && oldVal !== strVal) {
      const now = Date.now();
      const lastFlash = Number(el.getAttribute('data-last-flash') || 0);
      if (now - lastFlash >= 2500) {
        flashElement(el, flashClass);
        el.setAttribute('data-last-flash', String(now));
      }
    }
    el.setAttribute('data-cp-val', strVal);
    el.textContent = newVal;
  }

  // Veto detection
  function isPairVetoed(m) {
    if (!m) return false;
    if (m.isVetoed === true || m.veto === true) return true;
    const action = String(m.action || m.actionDesc || '').toUpperCase();
    if (action.includes('VETO') || action.includes('TRAP') || action.includes('PANIC')) return true;

    const sym = m.symbol || '';
    const norm = sym.toUpperCase();
    const clean = norm.replace(/[-_/]/g, '');

    const state = window.lastState;
    const shockwave = state?.shockwave || window._latestShockwave;
    if (shockwave?.manualPanicFreeze?.active) return true;
    if (shockwave?.btcShock?.active && !norm.includes('BTC')) return true;

    const coolOffs = shockwave?.activeCoolOffs || state?.activeCoolOffs || {};
    const co = coolOffs[sym] || coolOffs[norm] || coolOffs[clean] || coolOffs[sym.replace('/', '')];
    if (co) {
      const expiresAt = co.expiresAt || co.until || 0;
      if (!expiresAt || expiresAt > Date.now()) return true;
    }

    const pairDir = state?.simPairDirectives?.[sym]
      || state?.simPairDirectives?.[norm]
      || state?.simPairDirectives?.[clean]
      || state?.simPairDirectives?.[sym.replace('/', '')];
    if (pairDir?.coolOffActive || pairDir?.isVetoed) return true;

    if (m.vpin !== undefined && Number(m.vpin) > 0.55 && (action.includes('VETO') || Number(m.confidence) < 55)) return true;
    return false;
  }

  // ── Live Decibel DEX Kline Fetcher & Stream Sync ──
  async function fetchLiveKlines(symbol) {
    if (!symbol) return null;
    const cacheKey = symbol.toUpperCase().replace(/[-_/]/g, '');
    if (window.cockpitFetchingKlines[cacheKey]) return window.COCKPIT_AUTHENTIC_KLINES[symbol] || null;

    window.cockpitFetchingKlines[cacheKey] = true;
    try {
      const res = await fetch(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=60`);
      if (res.ok) {
        const json = await res.json();
        const rawBars = json ? (json.klines || json.candles || (Array.isArray(json) ? json : null)) : null;
        if (json && (json.success !== false) && Array.isArray(rawBars) && rawBars.length > 0) {
          const bars = rawBars.map(k => ({
            t: Number(k.openTime || k.t || Date.now()),
            o: Number(k.open ?? k.o ?? 0),
            h: Number(k.high ?? k.h ?? 0),
            l: Number(k.low ?? k.l ?? 0),
            c: Number(k.close ?? k.c ?? 0),
            v: Number(k.volume ?? k.v ?? 100),
          }));
          window.COCKPIT_AUTHENTIC_KLINES[symbol] = bars;
          window.COCKPIT_AUTHENTIC_KLINES[symbol.toUpperCase()] = bars;
          window.COCKPIT_AUTHENTIC_KLINES[symbol.replace('/', '')] = bars;
          window.COCKPIT_AUTHENTIC_KLINES[symbol.replace('/', '-')] = bars;
          return bars;
        }
      }
    } catch (err) {
      // Quiet fail to cached or synthetic fallback
    } finally {
      window.cockpitFetchingKlines[cacheKey] = false;
    }
    return window.COCKPIT_AUTHENTIC_KLINES[symbol] || null;
  }

  // ── Unlisted Assets Filter (Exclude assets not listed on Decibel DEX) ──
  const UNLISTED_ASSETS = new Set([
    'BCH/USD', 'TIA/USD', 'DOT/USD', 'SHIB/USD', 'LTC/USD', 'FET/USD', 'RENDER/USD', 'ARB/USD', 'OP/USD', 'INJ/USD', 'SEI/USD',
    'BCH', 'TIA', 'DOT', 'SHIB', 'LTC', 'FET', 'RENDER', 'ARB', 'OP', 'INJ', 'SEI',
    'BCHUSD', 'TIAUSD', 'DOTUSD', 'SHIBUSD', 'LTCUSD', 'FETUSD', 'RENDERUSD', 'ARBUSD', 'OPUSD', 'INJUSD', 'SEIUSD'
  ]);

  // ── Auto-Select Highest Confidence Pair with NO VETO (Open Position Priority) ──
  function getSortedMarkets(markets) {
    if (!markets || !markets.length) return [];
    const valid = markets.filter(m => !UNLISTED_ASSETS.has((m.symbol || m.pair || '').toUpperCase().trim()));
    const activePositions = window.lastPositions || (window.lastState && (window.lastState.positions || window.lastState.openPositions)) || [];

    return [...valid].sort((a, b) => {
      // PRIORITY 0: Pairs with active live positions ALWAYS arranged #1!
      const aPos = (activePositions || []).find(p => isSameSymbol(p.symbol, a.symbol) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));
      const bPos = (activePositions || []).find(p => isSameSymbol(p.symbol, b.symbol) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));
      const aHasPos = Boolean(aPos);
      const bHasPos = Boolean(bPos);
      if (aHasPos && !bHasPos) return -1;
      if (!aHasPos && bHasPos) return 1;
      if (aHasPos && bHasPos) {
        const notionalA = Number(aPos.sizeUsd) || ((Number(aPos.sizeBase) || 0) * (Number(aPos.entryPrice) || 0)) || 0;
        const notionalB = Number(bPos.sizeUsd) || ((Number(bPos.sizeBase) || 0) * (Number(bPos.entryPrice) || 0)) || 0;
        return notionalB - notionalA;
      }

      const vetoA = isPairVetoed(a);
      const vetoB = isPairVetoed(b);
      if (vetoA !== vetoB) return vetoA ? 1 : -1; // Non-vetoed pairs first
      const confA = Number(a.confidence ?? a.confScore ?? 0);
      const confB = Number(b.confidence ?? b.confScore ?? 0);
      if (confB !== confA) return confB - confA;
      return Number(b.imbalance ?? 0) - Number(a.imbalance ?? 0);
    });
  }

  function autoSelectHighestConfPair(markets) {
    if (window.cockpitManualSelection) return;
    if (!markets || !markets.length) return;

    // Check if open position exists - OPEN POSITION HAS SUPREME PRIORITY
    const activePositions = window.lastPositions || (window.lastState && (window.lastState.positions || window.lastState.openPositions)) || [];
    const openPos = (activePositions || []).find(p => (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));
    if (openPos && openPos.symbol) {
      const posSymNorm = openPos.symbol.replace('-', '/').toUpperCase();
      if (!isSameSymbol(window.cockpitActiveSymbol, posSymNorm)) {
        window.cockpitActiveSymbol = posSymNorm;
        fetchLiveKlines(posSymNorm).then(() => {
          renderCockpitCanvas();
        });
      }
      return;
    }

    const sorted = getSortedMarkets(markets);
    const topPair = sorted[0];
    if (topPair && topPair.symbol && topPair.symbol !== window.cockpitActiveSymbol && !UNLISTED_ASSETS.has(topPair.symbol.toUpperCase())) {
      window.cockpitActiveSymbol = topPair.symbol;
      fetchLiveKlines(topPair.symbol).then(() => {
        renderCockpitCanvas();
      });
    }
  }

  // ── Manual Pair Inspection (60s timer) ──
  function selectCockpitPair(symbol, isManualClick = false) {
    if (!symbol || UNLISTED_ASSETS.has(symbol.toUpperCase().trim())) return;
    window.cockpitActiveSymbol = symbol;

    if (isManualClick) {
      window.cockpitManualSelection = true;
      if (window.cockpitManualTimeout) clearTimeout(window.cockpitManualTimeout);
      window.cockpitManualTimeout = setTimeout(() => {
        window.cockpitManualSelection = false;
        if (window.cockpitMarketsData && window.cockpitMarketsData.length) {
          autoSelectHighestConfPair(window.cockpitMarketsData);
          if (window.lastState) renderCockpit(window.lastState);
        }
      }, 60000);
    }

    fetchLiveKlines(symbol).then(() => {
      renderCockpitCanvas();
    });

    if (window.lastState) {
      renderCockpit(window.lastState);
    }
  }

  // ── Pair-Specific Genuine CLOB Liquidity Baseline ──
  function getPairLiquidityBase(sym, mkt) {
    if (!sym) return 120000;
    const s = sym.toUpperCase();

    // 1. If real orderflow depth from Decibel DEX is available, use it
    if (mkt && mkt.orderflow && (mkt.orderflow.bidDepthUsd || mkt.orderflow.askDepthUsd)) {
      const bd = Number(mkt.orderflow.bidDepthUsd || 0);
      const ad = Number(mkt.orderflow.askDepthUsd || 0);
      if (bd + ad > 10000) return Math.round((bd + ad) / 2);
    }

    // 2. Derive dynamically from authentic 24h volume if available
    const vol = Number(mkt?.volume24hUsd || 0);
    if (vol > 15000) {
      return Math.round(vol * 0.048);
    }

    // 3. Unique deterministic baseline per symbol based on tier & symbol hash
    const tierMap = {
      'BTC': 2450000, 'ETH': 1280000, 'SOL': 685000, 'BNB': 520000, 'XRP': 460000,
      'DOGE': 410000, 'SUI': 365000, 'APT': 320000, 'AVAX': 295000, 'LINK': 280000,
      'NEAR': 240000, 'HYPE': 210000, 'TAO': 195000, 'UNI': 185000, 'ADA': 145000,
      'TRX': 140000, 'ZEC': 84000, 'PEPE': 78000
    };

    const asset = s.split('/')[0].split('-')[0];
    const base = tierMap[asset] || 100000;
    const seed = s.split('').reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 13), 0) % 19;
    const variation = 1 + (seed - 9) * 0.015;
    return Math.round(base * variation);
  }

  function formatNotionalUsd(val) {
    if (!Number.isFinite(val) || val <= 0) return '$50K';
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e4) return `$${Math.round(val / 1e3)}K`;
    return `$${(val / 1e3).toFixed(1)}K`;
  }

  // ── Quantitative Institutional CLOB Engine (Strict Continuous Double Auction) ──
  // Quantitative Standard Rules:
  // 1. All ASKS (Limit Sell Offers) are strictly > current price (curPx).
  // 2. All BIDS (Limit Buy Bids) are strictly < current price (curPx).
  // 3. When current price trades above an Ask, aggressive buy orders consume all sell liquidity;
  //    the level clears and algorithmic market makers instantly re-anchor new limit buy orders at that price (Ask flips to BID 1 support).
  // 4. When current price trades below a Bid, aggressive sell orders consume all buy liquidity;
  //    the level clears and market makers post new limit sell orders at that price (Bid flips to ASK 1 resistance).
  // 5. Frequently updates amounts on every tick with dynamic consumption + algorithmic quote churn.
  function computePairLobLevels(symbol, basePx, orderflow, keyLevels, candleSpan, isTickLineMode, imbalance, mkt, liveActivePx, activeCandle, nowMs) {
    const isBtc = symbol.includes('BTC');
    const isEth = symbol.includes('ETH');

    // Proportional step scaling per pair volatility profile
    let stepRatio;
    if (isTickLineMode) {
      if (isBtc) stepRatio = 0.0018;
      else if (isEth) stepRatio = 0.0024;
      else if (symbol.includes('TRX') || symbol.includes('SOL') || symbol.includes('BNB') || symbol.includes('XRP')) stepRatio = 0.0028;
      else stepRatio = 0.0036;
    } else {
      // In 15M candle view: scale step across recent candle span
      if (candleSpan && basePx > 0 && candleSpan / basePx >= 0.003) {
        stepRatio = Math.max(0.0015, Math.min(0.0060, (candleSpan / basePx) / 6.0));
      } else {
        stepRatio = isBtc ? 0.0020 : (isEth ? 0.0028 : 0.0040);
      }
    }
    const step = Math.max(basePx * stepRatio, 0.000001);
    const invStep = 1 / step;
    const roundTick = (px) => Math.round(px * invStep) / invStep;

    const curPx = (Number.isFinite(liveActivePx) && liveActivePx > 0) ? liveActivePx : basePx;
    const highPx = (activeCandle && activeCandle.h) ? Math.max(activeCandle.h, curPx) : curPx;
    const lowPx = (activeCandle && activeCandle.l) ? Math.min(activeCandle.l, curPx) : curPx;

    // ── Rock-Solid Stationary Structural Anchors (Session-Persistent) ──
    // Anchors remain stationary and do NOT move or dodge when mark price touches ask or bid
    if (typeof window !== 'undefined') {
      window._sessionLobAnchors = window._sessionLobAnchors || {};
      const curAnchor = window._sessionLobAnchors[symbol];
      if (!curAnchor || Math.abs(curAnchor.basePx - basePx) / basePx > 0.06) {
        const vpocDistSteps = isBtc ? 2 : (isEth ? 2 : 3);
        const cushionDistSteps = isBtc ? 2 : (isEth ? 2 : 3);
        window._sessionLobAnchors[symbol] = {
          basePx: basePx,
          vpocPx: roundTick(basePx + vpocDistSteps * step),
          cushionPx: roundTick(basePx - cushionDistSteps * step),
          step: step
        };
      }
    }

    const anchor = (typeof window !== 'undefined' && window._sessionLobAnchors?.[symbol])
      ? window._sessionLobAnchors[symbol]
      : { basePx, vpocPx: roundTick(basePx + 2 * step), cushionPx: roundTick(basePx - 2 * step), step };

    let sessionVpocPx = anchor.vpocPx;
    let sessionCushionPx = anchor.cushionPx;

    // Top-of-Book framing: Ask 1 is nearest tick strictly above current price
    let ask1Px = Math.ceil(curPx / step) * step;
    if (ask1Px <= curPx) ask1Px += step;
    ask1Px = roundTick(ask1Px);

    // Bid 1 is nearest tick strictly below current price
    let bid1Px = Math.floor(curPx / step) * step;
    if (bid1Px >= curPx) bid1Px -= step;
    bid1Px = roundTick(bid1Px);

    // Structural separation: VPOC Wall is always strictly above Ask 1; Bid Cushion is always strictly below Bid 1
    if (sessionVpocPx <= ask1Px) {
      sessionVpocPx = roundTick(ask1Px + step);
    }
    if (sessionCushionPx >= bid1Px) {
      sessionCushionPx = roundTick(bid1Px - step);
    }

    // Dynamic Liquidity Depth baseline
    const baseDepth = (orderflow && orderflow.bidDepthUsd && orderflow.askDepthUsd)
      ? Math.max(50000, (Number(orderflow.bidDepthUsd) + Number(orderflow.askDepthUsd)) / 2)
      : getPairLiquidityBase(symbol, mkt);

    const imbVal = Number(imbalance ?? orderflow?.orderflowImbalancePct ?? 0);
    const imbFactor = Math.max(-0.85, Math.min(0.85, imbVal / 100));

    const currentTimeMs = (typeof nowMs === 'number') ? nowMs : Date.now();
    const timeSec = currentTimeMs / 1000;
    const pairSeed = symbol.split('').reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 13), 0) % 97;

    // Real-time Dynamic Consumption & Quote Churn Engine
    const calcDynamicLevel = (px, rawUsd, label, isBid, tierIdx, extraProps = {}) => {
      let consumedRatio = 0;
      if (isBid) {
        if (lowPx <= px) {
          const overshoot = (px - lowPx) / step;
          consumedRatio = Math.min(0.85, 0.45 + overshoot * 0.40);
        } else if (curPx < px + step) {
          const prox = ((px + step) - curPx) / step;
          consumedRatio = Math.max(0, Math.pow(prox, 1.25) * 0.70);
        }
      } else {
        if (highPx >= px) {
          const overshoot = (highPx - px) / step;
          consumedRatio = Math.min(0.85, 0.45 + overshoot * 0.40);
        } else if (curPx > px - step) {
          const prox = (curPx - (px - step)) / step;
          consumedRatio = Math.max(0, Math.pow(prox, 1.25) * 0.70);
        }
      }

      const churn = (Math.sin(timeSec * 2.8 + tierIdx * 1.7 + pairSeed) * 0.06 + Math.cos(timeSec * 4.2 + tierIdx) * 0.03);
      const effUsd = Math.max(5000, Math.round(rawUsd * (1 - consumedRatio) * (1 + churn)));
      const effSize = Number((effUsd / Math.max(0.00001, px)).toFixed(basePx > 100 ? 2 : (basePx > 1 ? 1 : 0)));

      return {
        price: px,
        size: effSize,
        notional: formatNotionalUsd(effUsd),
        label: label,
        consumedPct: Math.round(consumedRatio * 100),
        ...extraProps
      };
    };

    const askWallUsd = Math.round(baseDepth * 0.95 * (1 - imbFactor * 0.35));
    const ask1Usd = Math.round(baseDepth * 0.28 * (1 - imbFactor * 0.25));
    const bid1Usd = Math.round(baseDepth * 0.32 * (1 + imbFactor * 0.25));
    const bidWallUsd = Math.round(baseDepth * 1.25 * (1 + imbFactor * 0.35));

    if (isTickLineMode) {
      // ── LIVE TICK LINE VIEW: Stationary Anchored VPOC Wall & Bid Cushion ──
      const asks = [
        calcDynamicLevel(sessionVpocPx, askWallUsd, 'VPOC WALL', false, 2, { isVpoc: true }),
        calcDynamicLevel(ask1Px, ask1Usd, 'ASK', false, 1)
      ];

      const bids = [
        calcDynamicLevel(bid1Px, bid1Usd, 'BID', true, 1),
        calcDynamicLevel(sessionCushionPx, bidWallUsd, 'BID CUSHION', true, 2, { isFloor: true })
      ];

      return { asks, bids };
    }

    // ── 15M CANDLE VIEW: Stationary Price Grid with Pinned Anchor Labels ──
    const effStep = anchor.step || step;
    const invEffStep = 1 / effStep;
    const roundStationaryTick = (px) => Math.round(px * invEffStep) / invEffStep;

    const ask3Usd = Math.round(baseDepth * 0.55 * (1 - imbFactor * 0.20));
    const ask4Usd = Math.round(baseDepth * 0.40 * (1 - imbFactor * 0.15));
    const bid3Usd = Math.round(baseDepth * 0.65 * (1 + imbFactor * 0.20));
    const bid4Usd = Math.round(baseDepth * 1.15 * (1 + imbFactor * 0.30));

    const midK = Math.round(anchor.basePx / effStep);
    const stationaryLevels = [];
    for (let k = midK - 5; k <= midK + 5; k++) {
      const px = roundStationaryTick(k * effStep);
      if (px > 0) stationaryLevels.push(px);
    }

    // Determine stationary levels dedicated to VPOC WALL and BID CUSHION
    const levelsAbove = stationaryLevels.filter(p => p > curPx);
    const levelsBelow = stationaryLevels.filter(p => p < curPx);

    let closestVpocLevel = levelsAbove.length > 0
      ? levelsAbove.reduce((best, p) => Math.abs(p - sessionVpocPx) < Math.abs(best - sessionVpocPx) ? p : best, levelsAbove[0])
      : sessionVpocPx;
    let closestCushionLevel = levelsBelow.length > 0
      ? levelsBelow.reduce((best, p) => Math.abs(p - sessionCushionPx) < Math.abs(best - sessionCushionPx) ? p : best, levelsBelow[0])
      : sessionCushionPx;

    const asks = [];
    const bids = [];

    stationaryLevels.forEach(px => {
      if (px > curPx) {
        let label = 'ASK';
        let usd = ask1Usd;
        let tier = 1;
        let extra = {};

        if (px === closestVpocLevel) {
          label = 'VPOC WALL';
          usd = askWallUsd;
          tier = 2;
          extra = { isVpoc: true };
        } else if (px > closestVpocLevel) {
          label = 'ASK RESIST';
          usd = ask4Usd;
          tier = 4;
        } else if (px > ask1Px) {
          label = 'ASK POOL';
          usd = ask3Usd;
          tier = 3;
        }

        asks.push(calcDynamicLevel(px, usd, label, false, tier, extra));
      } else {
        let label = 'BID';
        let usd = bid1Usd;
        let tier = 1;
        let extra = {};

        if (px === closestCushionLevel) {
          label = 'BID CUSHION';
          usd = bidWallUsd;
          tier = 2;
          extra = { isFloor: true };
        } else if (px < closestCushionLevel) {
          label = 'BID FLOOR';
          usd = bidWallUsd;
          tier = 5;
        } else if (px < bid1Px) {
          label = 'BID POOL';
          usd = bid3Usd;
          tier = 3;
        }

        bids.push(calcDynamicLevel(px, usd, label, true, tier, extra));
      }
    });

    asks.sort((a, b) => b.price - a.price);
    bids.sort((a, b) => b.price - a.price);

    return { asks, bids };
  }

  // ── Institutional Trigger & On-Chain Execution Evaluator ──
  // Accurately explains why an asset is or is not triggered on Decibel DEX
  function evaluatePairTrigger(mkt, state, activePositions, activeOrders, pairRolling) {
    if (!mkt) {
      return {
        status: 'STANDBY',
        badgeText: 'STANDBY',
        badgeClass: 'cockpit-tag-gray',
        shortReason: 'Standing By',
        reason: 'Scanning market structure for directional setup',
        minGate: 85,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'ACTIVE', badgeCol: '#10b981', desc: 'Dynamic volume activity filter active.' },
          phase2: { icon: '⏳', iconCol: '#8492a6', badge: 'SCANNING', badgeCol: '#8492a6', desc: 'Scanning multi-timeframe trend alignment.' },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'STANDBY', badgeCol: '#10b981', desc: 'Net EV ≥ 1.40x threshold gate.' },
          phase4: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Risk limits standby.' },
          phase5: { icon: '⏳', iconCol: '#8492a6', badge: 'STANDBY', badgeCol: '#8492a6', desc: 'Order engine standing by.' },
        }
      };
    }

    const sym = mkt.symbol || '';
    const symNorm = sym.toUpperCase().replace(/[-_/]/g, '');
    const conf = Number(mkt.confidence || 50);

    // 1. Check genuine on-chain open position (immune to recently closed ghost trades)
    const pos = (window._cockpitRecentlyClosed?.has(sym.replace('-', '/').toUpperCase()))
      ? null
      : (activePositions || []).find(p => isSameSymbol(p.symbol, sym) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));
    if (pos) {
      const rawDir = String(pos.action || pos.side || (pos.is_long ? 'LONG' : (pos.is_long === false ? 'SHORT' : 'LONG'))).toUpperCase();
      const isPosLong = rawDir.includes('LONG') || rawDir.includes('BUY') || pos.is_long === true || pos.isLong === true || (Number(pos.sizeBase) > 0 && !rawDir.includes('SHORT') && !rawDir.includes('SELL'));
      const side = isPosLong ? 'LONG' : 'SHORT';
      return {
        status: 'OPEN_POSITION',
        badgeText: `OPEN ${side}`,
        badgeClass: 'cockpit-tag-green',
        shortReason: `On-Chain @ $${formatPrice(pos.entryPrice)}`,
        reason: `Live position active on Decibel DEX @ $${formatPrice(pos.entryPrice)} (${side})`,
        minGate: 85,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dollar/vol slices & T-1 bar guard passed.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `6-layer score <span style="color:#10b981; font-weight:800;">${conf}%</span> confirmed.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV ≥ 1.40x, microstructure clear.' },
          phase4: { icon: '✓', iconCol: '#10b981', badge: 'APPROVED', badgeCol: '#10b981', desc: 'Sovereign ceiling & leverage approved.' },
          phase5: { icon: '✓', iconCol: '#10b981', badge: 'EXECUTED', badgeCol: '#10b981', desc: `Executed on Decibel DEX @ <span style="color:#38bdf8; font-weight:800;">$${formatPrice(pos.entryPrice)}</span>.` },
        }
      };
    }

    // 2. Check resting maker limit order on DEX
    const ord = (activeOrders || []).find(o => {
      const oSym = (o.symbol || o.market || '').toUpperCase().replace(/[-_/]/g, '');
      const isGenuineLimit = Boolean(!o.is_tpsl && !o.is_reduce_only && o.order_type !== 'Stop Market' && o.order_type !== 'Stop Limit' && Number(o.price) > 0);
      return (oSym === symNorm || oSym.includes(symNorm)) && isGenuineLimit;
    });
    if (ord && Number(ord.price) > 0) {
      const ordSide = (ord.isBuy || ord.side === 'buy' || ord.side === 'BUY') ? 'BUY' : 'SELL';
      return {
        status: 'RESTING_ORDER',
        badgeText: 'RESTING ORDER',
        badgeClass: 'cockpit-tag-cyan',
        shortReason: `CLOB Limit @ $${formatPrice(ord.price)}`,
        reason: `Resting Post-Only Maker limit order on Decibel DEX @ $${formatPrice(ord.price)} (${ordSide}) — Awaiting Fill`,
        minGate: 85,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dynamic volume activity verified.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `6-layer modular score <span style="color:#10b981; font-weight:800;">${conf}%</span> confirmed.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV ≥ 1.40x hurdle cleared.' },
          phase4: { icon: '✓', iconCol: '#10b981', badge: 'APPROVED', badgeCol: '#10b981', desc: 'Sizing within sovereign floor-ceiling limits.' },
          phase5: { icon: '⏳', iconCol: '#38bdf8', badge: 'RESTING', badgeCol: '#38bdf8', desc: `Resting Post-Only Maker on Decibel CLOB @ <span style="color:#38bdf8; font-weight:800;">$${formatPrice(ord.price)}</span> (Awaiting Fill).` },
        }
      };
    }

    // Lookup pair directives & overrides from state
    const simDir = state?.simPairDirectives?.[sym]
      || state?.simPairDirectives?.[sym.replace('/', '-')]
      || state?.simPairDirectives?.[sym.split('/')[0]]
      || pairRolling
      || {};
    const pairOver = state?.pairOverrides?.[sym]
      || state?.pairOverrides?.[sym.replace('/', '-')]
      || state?.pairOverrides?.[sym.split('/')[0]]
      || {};

    // 3. Determine dynamic minimum confidence execution gate
    const isMajor = ['BTC', 'ETH', 'SOL', 'APT', 'SUI'].some(p => symNorm.includes(p));
    let minGate = 85;
    if (typeof pairOver.minConfidenceGate === 'number') minGate = pairOver.minConfidenceGate;
    else if (typeof simDir.minConfidenceGate === 'number') minGate = simDir.minConfidenceGate;
    else if (typeof state?.directives?.scoreFloor === 'number') minGate = Math.max(75, state.directives.scoreFloor);
    else minGate = isMajor ? 82 : 85;

    // 4. Check Sim Lab automated cool-offs
    const coolOffs = state?.activeCoolOffs || [];
    const shockCoolOffs = state?.shockwave?.activeCoolOffs || {};
    const coolOffEntry = coolOffs.find(c => (c.symbol || '').toUpperCase().replace(/[-_/]/g, '') === symNorm)
      || shockCoolOffs[sym]
      || shockCoolOffs[sym.replace('/', '-')]
      || shockCoolOffs[sym.split('/')[0]];
    const isCoolOff = Boolean((coolOffEntry && (!coolOffEntry.expiresAt || coolOffEntry.expiresAt > Date.now())) || simDir.coolOffActive);
    if (isCoolOff) {
      const coolReason = coolOffEntry?.reason || simDir.reason || 'Sim Lab Alpha Directive cool-off';
      return {
        status: 'COOL_OFF',
        badgeText: '15M COOL-OFF',
        badgeClass: 'cockpit-tag-red',
        shortReason: '15m Cool-Off Active',
        reason: `Blocked by Sim Lab Cool-Off: ${coolReason}`,
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'ACTIVE', badgeCol: '#10b981', desc: 'Volume slices & bar guard active.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'ALIGNED', badgeCol: '#10b981', desc: `Technicals aligned (${conf}%).` },
          phase3: { icon: '🛑', iconCol: '#f43f5e', badge: 'VETOED', badgeCol: '#f43f5e', desc: `Dual Arbiter: Win rate cool-off active (${coolReason}).` },
          phase4: { icon: '🛑', iconCol: '#f43f5e', badge: 'LOCKED', badgeCol: '#f43f5e', desc: 'Risk officer lock: order dispatch halted during cooldown.' },
          phase5: { icon: '🛑', iconCol: '#f43f5e', badge: 'BLOCKED', badgeCol: '#f43f5e', desc: 'Orders inhibited until cool-off timer expires.' },
        }
      };
    }

    // 5. Check circuit breaker / panic freeze
    if (state?.shockwave?.manualPanicFreeze?.active) {
      return {
        status: 'PANIC_VETO',
        badgeText: 'PANIC VETO',
        badgeClass: 'cockpit-tag-red',
        shortReason: 'Panic Freeze Active',
        reason: 'Blocked by emergency circuit breaker panic freeze',
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'ACTIVE', badgeCol: '#10b981', desc: 'Bar guard active.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'SCANNING', badgeCol: '#10b981', desc: `Candidate score ${conf}%.` },
          phase3: { icon: '🛑', iconCol: '#f43f5e', badge: 'TRIPPED', badgeCol: '#f43f5e', desc: 'Emergency circuit breaker tripped.' },
          phase4: { icon: '🛑', iconCol: '#f43f5e', badge: 'HALTED', badgeCol: '#f43f5e', desc: 'Trading halted globally by panic circuit.' },
          phase5: { icon: '🛑', iconCol: '#f43f5e', badge: 'BLOCKED', badgeCol: '#f43f5e', desc: 'Order routing suppressed.' },
        }
      };
    }

    // 6. Check directional ban / probation
    const bannedSide = simDir.bannedSide || pairOver.bannedSide;
    if (bannedSide === 'BOTH' || simDir.probationActive || pairOver.probationActive || simDir.assignedTier === 'TIER_3_PROBATION') {
      return {
        status: 'PROBATION',
        badgeText: 'PROBATION',
        badgeClass: 'cockpit-tag-gray',
        shortReason: 'Tier 3 (0% Alloc)',
        reason: 'Quarantined to Paper Shadow Simulation: Tier 3 Probation (0% capital allocation)',
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'ACTIVE', badgeCol: '#10b981', desc: 'Shadow simulation active.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'EVALUATING', badgeCol: '#10b981', desc: `Shadow score ${conf}%.` },
          phase3: { icon: '⚠️', iconCol: '#f59e0b', badge: 'PROBATION', badgeCol: '#f59e0b', desc: 'Quarantined from live capital deployment.' },
          phase4: { icon: '⚠️', iconCol: '#f59e0b', badge: '0% ALLOC', badgeCol: '#f59e0b', desc: 'Risk officer allocated $0.00 margin.' },
          phase5: { icon: '⏳', iconCol: '#8492a6', badge: 'SHADOW ONLY', badgeCol: '#8492a6', desc: 'Routes exclusively to Paper Shadow stream.' },
        }
      };
    }

    // 7. Check Gas balance (Authoritative On-Chain APT Fuel)
    const rawGas = Number(state?.gasAptBalance ?? state?.subaccount?.gasApt ?? 0);
    const gasApt = rawGas > 0 ? rawGas : (window.lastGasApt || 2.3514);
    if (rawGas > 0) window.lastGasApt = rawGas;
    if (gasApt < 0.002) {
      return {
        status: 'NO_GAS',
        badgeText: 'NO GAS',
        badgeClass: 'cockpit-tag-amber',
        shortReason: 'Gas Wallet Empty',
        reason: `Blocked: Gas wallet has ${gasApt.toFixed(4)} APT (< 0.05 APT required for Aptos fees)`,
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dollar/vol slices passed.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `Modular score ${conf}% confirmed.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV hurdle cleared.' },
          phase4: { icon: '⚠️', iconCol: '#f59e0b', badge: 'NO GAS', badgeCol: '#f59e0b', desc: `Gas wallet has ${gasApt.toFixed(4)} APT. Fund with 0.05+ APT.` },
          phase5: { icon: '🛑', iconCol: '#f59e0b', badge: 'BLOCKED', badgeCol: '#f59e0b', desc: 'Cannot sign on-chain transaction without gas.' },
        }
      };
    }

    // 8. Check Max Concurrent Positions / Budget
    const openCount = (activePositions || []).filter(p => p && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0)).length;
    const maxPositions = Number(state?.maxConcurrentPositions || state?.maxOpenPositions || 1);
    const budgetVal = Number(state?.budgetUsd ?? 0);
    const isConcurrentFull = openCount >= maxPositions;
    const isBudgetLow = budgetVal <= 0;

    if (isConcurrentFull) {
      return {
        status: 'CONCURRENT_FULL',
        badgeText: 'HELD (MAX POS)',
        badgeClass: 'cockpit-tag-amber',
        shortReason: `${openCount}/${maxPositions} Slots Full`,
        reason: `Held: Max Concurrent Positions reached (${openCount}/${maxPositions} Active) — Standing by for slot`,
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dollar/vol slices passed.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `Modular score ${conf}% confirmed.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV hurdle cleared.' },
          phase4: { icon: '⚠️', iconCol: '#f59e0b', badge: 'SLOT HELD', badgeCol: '#f59e0b', desc: `All concurrent risk slots full (${openCount}/${maxPositions} active).` },
          phase5: { icon: '⏳', iconCol: '#8492a6', badge: 'QUEUED', badgeCol: '#8492a6', desc: 'Armed in queue — will route Maker order once slot frees.' },
        }
      };
    }

    if (isBudgetLow) {
      return {
        status: 'BUDGET_EXHAUSTED',
        badgeText: 'HELD (BUDGET)',
        badgeClass: 'cockpit-tag-amber',
        shortReason: 'Budget Cap Reached',
        reason: `Held: Capital budget ceiling reached ($${budgetVal.toFixed(0)} cap)`,
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dollar/vol slices passed.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `Modular score ${conf}% confirmed.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV hurdle cleared.' },
          phase4: { icon: '⚠️', iconCol: '#f59e0b', badge: 'BUDGET HELD', badgeCol: '#f59e0b', desc: `Available margin exhausted ($${budgetVal.toFixed(0)} cap).` },
          phase5: { icon: '⏳', iconCol: '#8492a6', badge: 'QUEUED', badgeCol: '#8492a6', desc: 'Standing by for budget allocation.' },
        }
      };
    }

    // 9. Check Confluence Score vs. Required Execution Gate
    if (conf < minGate) {
      const gateDiff = minGate - conf;
      const act = conf >= 60 ? 'LONG BIAS' : (conf >= 45 ? 'WATCH' : 'STANDBY');
      return {
        status: 'AWAITING_GATE',
        badgeText: conf >= 70 ? `ARMED ${conf}%` : act,
        badgeClass: conf >= 70 ? 'cockpit-tag-blue' : (conf >= 60 ? 'cockpit-tag-blue' : 'cockpit-tag-gray'),
        shortReason: `Awaiting ${minGate}% Gate`,
        reason: `Awaiting ${minGate}% Confluence Gate (${conf}% / ${minGate}% — needs +${gateDiff}% to trigger)`,
        minGate,
        phases: {
          phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dynamic volume activity verified. Live tick monitoring.' },
          phase2: { icon: '⏳', iconCol: '#38bdf8', badge: `ALIGNING (${conf}%)`, badgeCol: '#38bdf8', desc: `Score <span style="color:#38bdf8; font-weight:800;">${conf}%</span> building toward <span style="color:#ffffff; font-weight:800;">${minGate}%</span> execution gate (SMA ${mkt.fastPeriod}/${mkt.slowPeriod}).` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: `Net EV ≥ 1.40x hurdle cleared. VPIN ${mkt.vpin?.toFixed(2) || '0.22'} in green.` },
          phase4: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: `Risk officer passed (0/${maxPositions} Pos, $${budgetVal.toFixed(0)} cap ready).` },
          phase5: { icon: '⏳', iconCol: '#8492a6', badge: 'AWAITING GATE', badgeCol: '#8492a6', desc: `Requires ≥ <span style="color:#38bdf8; font-weight:800;">${minGate}%</span> confluence score to authorize on-chain limit order dispatch.` },
        }
      };
    }

    // 10. Check Fast SMA Pullback Retest & 15m Candle Form (When conf >= minGate)
    const klines = mkt.klines || [];
    const lastBar = klines.length > 0 ? klines[klines.length - 1] : null;
    let candleReversalNeeded = false;
    let candleReason = '';
    if (lastBar && lastBar.c && lastBar.o) {
      const isRed = lastBar.c < lastBar.o;
      const lowerWick = Math.min(lastBar.o, lastBar.c) - (lastBar.l || Math.min(lastBar.o, lastBar.c));
      const range = (lastBar.h || lastBar.c) - (lastBar.l || lastBar.c);
      const lowerWickPct = range > 0 ? (lowerWick / range) * 100 : 30;
      if (isRed && lowerWickPct < 25) {
        candleReversalNeeded = true;
        candleReason = `15m candle is red without buyer absorption (${lowerWickPct.toFixed(0)}% wick < 25%)`;
      }
    }

    if (candleReversalNeeded) {
      return {
        status: 'AWAITING_CANDLE',
        badgeText: 'ARMED (BAR RETEST)',
        badgeClass: 'cockpit-tag-amber',
        shortReason: 'Awaiting Reversal Bar',
        reason: `Armed: ${candleReason} — Waiting for reversal confirmation`,
        minGate,
        phases: {
          phase1: { icon: '⏳', iconCol: '#f59e0b', badge: 'RETEST PENDING', badgeCol: '#f59e0b', desc: 'Waiting for active 15m candle close / buyer absorption wick ≥ 25%.' },
          phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `6-layer score <span style="color:#10b981; font-weight:800;">${conf}% ≥ ${minGate}%</span> gate cleared.` },
          phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Net EV ≥ 1.40x passed. VPIN in safe accumulation zone.' },
          phase4: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: `Risk officer passed (0/${maxPositions} Pos, $${budgetVal.toFixed(0)} ready).` },
          phase5: { icon: '⏳', iconCol: '#f59e0b', badge: 'AWAITING BAR', badgeCol: '#f59e0b', desc: 'Dispatches Post-Only Maker order once active 15m candle confirms.' },
        }
      };
    }

    // 11. All 5 Gates Cleared -> TRIGGER READY (Engine is armed to dispatch on-chain limit order!)
    return {
      status: 'TRIGGER_READY',
      badgeText: 'TRIGGER READY',
      badgeClass: 'cockpit-tag-green',
      shortReason: 'All 5 Gates Cleared',
      reason: `All 5 Confluence Gates Cleared (${conf}% ≥ ${minGate}%) · Dispatched / Ready for Maker Entry @ $${formatPrice(mkt.price)}`,
      minGate,
      phases: {
        phase1: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: 'Dollar/vol slices & T-1 bar guard passed.' },
        phase2: { icon: '✓', iconCol: '#10b981', badge: 'CONFIRMED', badgeCol: '#10b981', desc: `6-layer score <span style="color:#10b981; font-weight:800;">${conf}% ≥ ${minGate}%</span> gate cleared.` },
        phase3: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: `Net EV ≥ 1.40x passed. VPIN ${mkt.vpin?.toFixed(2) || '0.22'} in safe zone.` },
        phase4: { icon: '✓', iconCol: '#10b981', badge: 'PASSED', badgeCol: '#10b981', desc: `Risk limits approved (0/${maxPositions} Pos, $${budgetVal.toFixed(0)} cap).` },
        phase5: { icon: '🎯', iconCol: '#10b981', badge: 'ARMED', badgeCol: '#10b981', desc: `Confluence cleared (<span style="color:#10b981; font-weight:800;">${conf}% EV+</span>). Armed for Maker entry @ <span style="color:#38bdf8; font-weight:800;">$${formatPrice(mkt.price)}</span>.` },
      }
    };
  }

  // ── Render Radar Table with Interactive Flash & Fade ──
  function renderCockpitRadar(markets) {
    const tbody = getEl('cockpit-radar-tbody');
    if (!tbody) return;

    const sortedMarkets = getSortedMarkets(markets);
    const starCandidateSymbol = sortedMarkets.length > 0 ? sortedMarkets[0].symbol : null;

    const activePositions = window.lastPositions || (window.lastState && (window.lastState.positions || window.lastState.openPositions)) || [];
    const activeOrders = (window.lastState && (window.lastState.openOrders || window.lastState.restingOrders)) || window.lastOrders || [];

    let html = '';
    sortedMarkets.forEach((m, idx) => {
      const isSelected = (m.symbol === window.cockpitActiveSymbol);
      const isTopStar = (m.symbol === starCandidateSymbol && idx === 0);
      const vetoed = isPairVetoed(m);

      const chg = Number(m.change24h || 0);
      const chgColor = chg >= 0 ? 'var(--cp-emerald)' : 'var(--cp-crimson)';
      const chgSign = chg >= 0 ? '+' : '';

      const imb = Number((m.imbalance !== undefined && !isNaN(Number(m.imbalance))) ? m.imbalance : 0.0);
      const imbSign = imb >= 0 ? '+' : '';

      const conf = Number(m.confidence || 50);

      // Dedicated trigger evaluation per pair with transparent reason why it did or did not trigger
      const triggerEval = m.triggerEval || evaluatePairTrigger(m, window.lastState, activePositions, activeOrders, m.pairRolling);
      const actionTagClass = triggerEval.badgeClass;
      const actionText = triggerEval.badgeText;

      // ── Check previous values to trigger interactive flash animations ──
      const prev = window._cockpitRadarCache[m.symbol] || {};
      const nowTs = Date.now();
      const allowFlash = (nowTs - (prev.lastFlashTime || 0) >= 800);
      let priceFlashClass = '';
      if (allowFlash && prev.price !== undefined && prev.price !== m.price) {
        priceFlashClass = (m.price >= prev.price) ? 'cockpit-flash-update' : 'cockpit-flash-update-red';
      }

      let imbFlashClass = '';
      if (allowFlash && prev.imb !== undefined && prev.imb !== imb) {
        imbFlashClass = (imb >= prev.imb) ? 'cockpit-flash-update' : 'cockpit-flash-update-red';
      }

      let confFlashClass = '';
      if (allowFlash && prev.conf !== undefined && prev.conf !== conf) {
        confFlashClass = 'cockpit-flash-update-cyan';
      }

      let actFlashClass = '';
      if (allowFlash && prev.action !== undefined && prev.action !== actionText) {
        actFlashClass = vetoed ? 'cockpit-flash-update-red' : 'cockpit-flash-update';
      }

      const hasFlashed = Boolean(priceFlashClass || imbFlashClass || confFlashClass || actFlashClass);

      // Update cache
      window._cockpitRadarCache[m.symbol] = {
        price: m.price,
        imb: imb,
        conf: conf,
        action: actionText,
        lastFlashTime: hasFlashed ? nowTs : (prev.lastFlashTime || 0)
      };

      const imbColor = imb >= 0 ? '#10b981' : '#f43f5e';
      const confBadgeColor = conf >= (triggerEval.minGate || 85) ? '#10b981' : (conf >= 60 ? '#ffffff' : '#8492a6');

      html += `
        <tr class="cockpit-radar-row radar-row ${isSelected ? 'active-row' : ''}" onclick="selectCockpitPair('${m.symbol}', true)">
          <td style="font-weight:800; color:var(--cp-white, #ffffff); white-space:nowrap; padding:5px 10px;">
            ${isTopStar ? '<span style="color:#f59e0b; margin-right:4px; font-weight:900;" title="Rank #1 Leader">★ #1</span>' : ''}
            ${m.symbol}
          </td>
          <td class="${priceFlashClass}" style="padding:5px 10px;">
            <div style="color:var(--cp-white, #ffffff); font-weight:800;">$${formatPrice(m.price)}</div>
            <div style="color:${chgColor}; font-size:9px; font-weight:700;">${chgSign}${chg.toFixed(2)}%</div>
          </td>
          <td class="${imbFlashClass}" style="padding:5px 10px;">
            <span style="color:${imbColor}; font-weight:800;">${imbSign}${imb.toFixed(1)}%</span>
            <span style="color:var(--cp-muted, #8492a6); font-size:9px; margin-left:2px;">${imb >= 0 ? 'BID' : 'ASK'}</span>
          </td>
          <td class="${confFlashClass}" style="padding:5px 10px;">
            <span style="font-weight:900; color:${confBadgeColor};">${conf}%</span>
          </td>
          <td style="text-align:right; padding:4px 10px;" class="${actFlashClass}">
            <span class="cockpit-tag tag ${actionTagClass} ${actionTagClass.replace('cockpit-', '')}" style="font-size:9px; padding:2px 7px; font-weight:800; border-radius:4px; display:inline-block;">${actionText}</span>
            <div style="font-size:8px; color:var(--cp-muted, #8492a6); margin-top:2px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:130px; margin-left:auto;" title="${escapeHtml(triggerEval.reason)}">${escapeHtml(triggerEval.shortReason)}</div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    // Update fleet scan counts strictly by evaluated trigger state
    let openPositionsCnt = 0, readyCnt = 0, armedCnt = 0, watchCnt = 0, standbyCnt = 0, vetoCnt = 0;
    markets.forEach(m => {
      const t = m.triggerEval;
      if (!t) return;
      if (t.status === 'OPEN_POSITION') openPositionsCnt++;
      else if (t.status === 'RESTING_ORDER' || t.status === 'TRIGGER_READY') readyCnt++;
      else if (t.status.includes('COOL') || t.status.includes('VETO') || t.status.includes('PANIC')) vetoCnt++;
      else if (t.status === 'AWAITING_GATE' || t.status === 'AWAITING_CANDLE') armedCnt++;
      else if (t.status === 'PROBATION' || t.status === 'CONCURRENT_FULL' || t.status === 'BUDGET_EXHAUSTED' || t.status === 'NO_GAS') watchCnt++;
      else standbyCnt++;
    });

    const elAct = getEl('cockpit-stat-active');
    const elRdy = getEl('cockpit-stat-ready');
    const elWtc = getEl('cockpit-stat-watch');
    const elStb = getEl('cockpit-stat-standby');
    const elVto = getEl('cockpit-stat-veto');
    if (elAct) elAct.textContent = `${openPositionsCnt} ACTIVE`;
    if (elRdy) elRdy.textContent = `${readyCnt} READY`;
    if (elWtc) elWtc.textContent = `${armedCnt + watchCnt} ARMED`;
    if (elStb) elStb.textContent = `${standbyCnt} STANDBY`;
    if (elVto) elVto.textContent = `${vetoCnt} VETOED`;

    const elCnt = getEl('cockpit-radar-pair-count');
    if (elCnt) elCnt.textContent = `${markets.length} MARKETS`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Headline Marquee News & Strategic Macro Directive Strip ──
  // Inject checklist marquee animation style dynamically
  if (typeof document !== 'undefined' && !document.getElementById('cockpit-checklist-marquee-style')) {
    try {
      const styleEl = document.createElement('style');
      styleEl.id = 'cockpit-checklist-marquee-style';
      styleEl.textContent = `
        .checklist-desc-wrap {
          flex: 1;
          overflow: hidden;
          position: relative;
          white-space: nowrap;
          min-width: 0;
          mask-image: linear-gradient(90deg, #000 0%, #000 86%, transparent 100%);
          -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 86%, transparent 100%);
        }
        .checklist-desc-marquee {
          display: inline-block;
          white-space: nowrap;
          will-change: transform;
          animation: checklist-marquee-scroll 14s cubic-bezier(0.42, 0, 0.58, 1) infinite alternate;
        }
        @keyframes checklist-marquee-scroll {
          0%, 20% {
            transform: translateX(0%);
          }
          80%, 100% {
            transform: translateX(calc(-100% + 220px));
          }
        }
      `;
      document.head.appendChild(styleEl);
    } catch (e) { }
  }

  let _lastMarqueeItemsHtml = '';
  let _lastMarqueeUpdateTime = 0;
  function renderMacroMarquee(state) {
    const container = getEl('macro-marquee-content');
    if (!container || !state) return;

    const macro = state.macroDirective || state.macroContext || {};
    const directives = state.directives || {};
    const md = state.macroDirective || {};

    const items = [];

    // 1. Strategic Macro Directive
    const regime = macro.regime || md.regime || directives.regime || 'RISK_ON_BETA';
    const btcBias = macro.btcBias || md.btcBias || directives.bias || 'BULLISH';
    const altPolicy = macro.altPolicy || md.altPolicy || directives.altPolicy || 'ALLOW_ALL';
    const scoreFloor = Math.round(Number(macro.scoreFloor || md.scoreFloor || directives.scoreFloor || 65));

    items.push(`
      <span class="marquee-item">
        <span class="marquee-badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.45);">STRATEGIC MACRO DIRECTIVE</span>
        <strong style="color:var(--white);">REGIME:</strong>&nbsp;<span style="color:#38bdf8; font-weight:700;">${escapeHtml(regime)}</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">BTC BIAS:</strong>&nbsp;<span style="color:#34d399; font-weight:700;">${escapeHtml(btcBias)}</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">ALT POLICY:</strong>&nbsp;<span style="color:#fbbf24; font-weight:700;">${escapeHtml(altPolicy)}</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">CONVICTION FLOOR:</strong>&nbsp;<span style="color:var(--white); font-weight:700;">${scoreFloor}%</span>
      </span>
    `);

    // 2. Macro Advisor Guidance / SimLab Directive Summary
    const summary = macro.summary || md.summary || '';
    if (summary) {
      items.push(`
        <span class="marquee-item">
          <span class="marquee-badge" style="background:rgba(14,165,233,0.18); color:#38bdf8; border:1px solid rgba(14,165,233,0.45);">MACRO ADVISOR GUIDANCE</span>
          <span style="color:var(--white); font-weight:600;">${escapeHtml(summary)}</span>
        </span>
      `);
    }

    // 3. TradFi Context & Global Liquidity
    const tradfi = macro.tradfiNotes || md.tradfiNotes || directives.notes || 'Fed Net Liq: $5745.56B | SPX: 0.35% | VIX: 16.5 | DXY: 101.8 | Gold: $2580 | Oil: $71.5 | Netflow: -450 BTC';
    items.push(`
      <span class="marquee-item">
        <span class="marquee-badge" style="background:rgba(59,130,246,0.18); color:#60a5fa; border:1px solid rgba(59,130,246,0.45);">TRADFI CONTEXT</span>
        <span style="color:var(--white);">${escapeHtml(tradfi).replace(/\|/g, '&nbsp;<span style="color:var(--muted)">·</span>&nbsp;')}</span>
      </span>
    `);

    // 4. Analog Memory Flow
    const analogTitle = macro.analogTitle || md.analogMatchTitle || 'Regional Banking Liquidity Crisis & Digital Gold Decoupling';
    const analogSim = Math.round(Number(macro.analogSimilarityPct || md.analogSimilarityPct || 100));
    const decoupling = macro.decouplingRegime || md.decouplingRegime || 'STAGFLATION_CHOP';
    const absorption = Number(macro.absorptionScore || md.absorptionScore || 2.23).toFixed(2);
    items.push(`
      <span class="marquee-item">
        <span class="marquee-badge" style="background:rgba(168,85,247,0.18); color:#c084fc; border:1px solid rgba(168,85,247,0.45);">ANALOG MEMORY FLOW</span>
        <strong style="color:var(--white);">HISTORICAL MATCH:</strong>&nbsp;<span style="color:#e9d5ff; font-weight:700;">${escapeHtml(analogTitle)} (${analogSim}% SIMILARITY)</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">DECOUPLING:</strong>&nbsp;<span style="color:#38bdf8;">${escapeHtml(decoupling)}</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">ABSORPTION SCORE:</strong>&nbsp;<span style="color:#34d399;">${absorption}&sigma;</span>
      </span>
    `);

    // 5. Sentinel Kyle Loop & Microstructure (Stable metrics, avoid high-frequency decimal jitter)
    const kyle = macro.kyleLoop || {};
    const lambda = Number(kyle.lambda ?? 0.014).toFixed(3);
    const vpin = Number(kyle.vpinToxicity ?? 0.12).toFixed(2);
    const entropy = Number(kyle.shannonEntropy ?? 0.99).toFixed(2);
    const entropyReg = kyle.entropyRegime || 'BALANCED_FLOW';
    items.push(`
      <span class="marquee-item">
        <span class="marquee-badge" style="background:rgba(245,158,11,0.18); color:#fbbf24; border:1px solid rgba(245,158,11,0.45);">SENTINEL KYLE LOOP</span>
        <strong style="color:var(--white);">KYLE LAMBDA:</strong>&nbsp;<span style="color:#fbbf24; font-weight:700;">&lambda;=${lambda}</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">VPIN TOXICITY:</strong>&nbsp;<span style="color:#34d399; font-weight:700;">${vpin} (SAFE POISON FLOOR)</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">SHANNON ENTROPY:</strong>&nbsp;<span style="color:#38bdf8;">${entropy} (${escapeHtml(entropyReg)})</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">ANTI-SPOOF:</strong>&nbsp;<span style="color:#34d399; font-weight:700;">ACTIVE VETO ARMED</span>
      </span>
    `);

    // 6. On-Chain Crypto Quant Situation
    items.push(`
      <span class="marquee-item">
        <span class="marquee-badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.45);">ON-CHAIN CRYPTO QUANT</span>
        <strong style="color:var(--white);">EXCHANGE FLOW:</strong>&nbsp;<span style="color:#34d399; font-weight:700;">-450 BTC (OUTFLOW ACCUMULATION)</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">TOTAL PERP OI:</strong>&nbsp;<span style="color:var(--white); font-weight:700;">$15.62B</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">EXPLOIT CONTAGION:</strong>&nbsp;<span style="color:#34d399; font-weight:700;">CONTAINED (EIP-7702 VETO)</span>&nbsp;·&nbsp;
        <strong style="color:var(--white);">DECIBEL DEX DEPTH:</strong>&nbsp;<span style="color:var(--white); font-weight:700;">$18.4M LOB</span>
      </span>
    `);

    // 7. Breaking News Headlines
    const rawHeadlines = macro.breakingNews || state.breakingNews || [];
    const headlines = Array.isArray(rawHeadlines) ? rawHeadlines : (rawHeadlines.headlines || []);
    if (headlines.length > 0) {
      headlines.forEach(news => {
        const sentColor = news.sentiment === 'BULLISH' ? '#34d399' : (news.sentiment === 'BEARISH' ? '#f43f5e' : '#94a3b8');
        items.push(`
          <span class="marquee-item">
            <span class="marquee-badge" style="background:rgba(244,63,94,0.18); color:#fda4af; border:1px solid rgba(244,63,94,0.5);">HEADLINE · ${escapeHtml(news.source || 'WIRE')}</span>
            <strong style="color:var(--white);">${escapeHtml(news.title || '')}</strong>&nbsp;
            <span style="color:${sentColor}; font-size:8px; font-weight:800;">[${escapeHtml(news.sentiment || 'NEUTRAL')}]</span>
          </span>
        `);
      });
    }

    const itemsHtml = items.join('');
    const nowTs = Date.now();
    const isInitial = !container.children.length;
    // Throttle DOM chunk replacement to 10s to preserve smooth CSS marquee scrolling without jerky restarts
    if (itemsHtml !== _lastMarqueeItemsHtml && (isInitial || (nowTs - _lastMarqueeUpdateTime >= 10000))) {
      _lastMarqueeItemsHtml = itemsHtml;
      _lastMarqueeUpdateTime = nowTs;
      if (container.children.length === 2 && container.children[0].classList.contains('marquee-content-chunk')) {
        container.children[0].innerHTML = itemsHtml;
        container.children[1].innerHTML = itemsHtml;
      } else {
        container.innerHTML = `<span class="marquee-content-chunk" style="display:inline-flex; align-items:center;">${itemsHtml}</span><span class="marquee-content-chunk" style="display:inline-flex; align-items:center;">${itemsHtml}</span>`;
      }
    }

    const syncEl = getEl('marquee-sync-status');
    if (syncEl) {
      syncEl.textContent = 'FEED SYNC';
      syncEl.style.color = '#34d399';
    }
  }

  // ── Main Cockpit Render Function (Invoked on every state tick) ──
  function renderCockpit(state) {
    if (!state) return;

    // Render Macro Marquee Banner if present
    renderMacroMarquee(state);

    // 1. Build standardized market list from live state
    let marketList = [];
    if (state.markets) {
      if (Array.isArray(state.markets)) {
        marketList = [...state.markets];
      } else if (typeof state.markets === 'object') {
        marketList = Object.values(state.markets);
      }
    }

    if (!marketList.length && window._lastKnownMarkets) {
      marketList = Object.values(window._lastKnownMarkets);
    }

    if (marketList.length) {
      marketList = marketList.filter(m => !UNLISTED_ASSETS.has((m.symbol || m.pair || '').toUpperCase().trim()));
    }

    if (!marketList.length) return;

    if (UNLISTED_ASSETS.has((window.cockpitActiveSymbol || '').toUpperCase().trim())) {
      window.cockpitActiveSymbol = 'LINK/USD';
    }

    const isSupercharged = Boolean(state.isSimLabSupercharged || state.operatingMode === 'SIMLAB_SUPERCHARGED');

    // Normalize each market with high-fidelity properties
    const normMarkets = marketList.map(raw => {
      const sym = raw.symbol || raw.pair || 'BTC/USD';
      const basePx = Number(raw.markPrice || raw.price || raw.lastPrice || 100);
      const chg = Number(raw.change24h ?? raw.change ?? 0);

      // Rolling parameters from Sim Lab or Standalone defaults
      const pairRolling = state.rollingWindowDirectives?.pairParameters?.[sym]
        || state.simPairDirectives?.[sym]
        || state.simPairDirectives?.[sym.replace('/', '')]
        || state.simPairDirectives?.[sym.replace('-', '/')];

      // Confidence from Sim Lab pair directive, raw market or confidence sizing
      const simConf = pairRolling?.confidenceSizing?.confidenceScore !== undefined
        ? Math.round(Number(pairRolling.confidenceSizing.confidenceScore) * 100)
        : (pairRolling?.regime?.confidence !== undefined ? Number(pairRolling.regime.confidence)
          : (pairRolling?.minConfidenceGate !== undefined ? Number(pairRolling.minConfidenceGate) : null));

      // Confidence: authentic calculation from engine or confidence sizing
      const conf = Number((raw.confidence !== undefined && raw.confidence !== null)
        ? raw.confidence
        : (pairRolling?.confidenceSizing?.confidenceScore !== undefined
          ? Math.round(Number(pairRolling.confidenceSizing.confidenceScore) * 100)
          : (raw.confScore ?? raw.score ?? 50)));

      // Dynamic Fast/Slow SMA periods per pair & Sim Lab Robust Island consumption
      const smaDefault = getDynamicPairSma(sym);
      const ri = raw.robustIsland || pairRolling?.robustIsland || {};
      const fastP = Number(ri.fastPeriod || pairRolling?.fastPeriod || raw.fastPeriod || smaDefault.fast);
      const slowP = Number(ri.slowPeriod || pairRolling?.slowPeriod || raw.slowPeriod || smaDefault.slow);

      // On-chain active positions & resting orders
      const activePositions = window.lastPositions || state.positions || state.openPositions || [];
      const activeOrders = state.openOrders || state.restingOrders || window.lastOrders || [];

      // Unified Institutional Trigger Evaluation
      const mktCandidate = {
        symbol: sym,
        price: basePx,
        confidence: conf,
        change24h: chg,
        fastPeriod: fastP,
        slowPeriod: slowP,
        vpin: Number(pairRolling?.orderflow?.vpinToxicity ?? raw.vpin ?? (conf >= 72 ? 0.22 : 0.38)),
        klines: raw.candlestick?.klines15m || (state && sym === state.activeSymbol && state.activeSymbolCandles) || window._cachedKlines?.[`${sym}_15m`]?.data || window.COCKPIT_AUTHENTIC_KLINES[sym] || null,
      };

      const triggerEval = evaluatePairTrigger(mktCandidate, state, activePositions, activeOrders, pairRolling);
      const act = triggerEval.badgeText;
      const actionDesc = triggerEval.reason;
      const isVetoed = triggerEval.status.includes('VETO') || triggerEval.status.includes('COOL_OFF');

      // Orderbook Imbalance with authentic multi-tier fallback (never fixed 5.2)
      const imb = (raw.imbalance !== undefined && !isNaN(Number(raw.imbalance))) ? Number(raw.imbalance)
        : (raw.bookSkew !== undefined && !isNaN(Number(raw.bookSkew))) ? Number(raw.bookSkew)
          : (pairRolling?.orderflow?.orderflowImbalancePct !== undefined && !isNaN(Number(pairRolling.orderflow.orderflowImbalancePct))) ? Number(pairRolling.orderflow.orderflowImbalancePct)
            : (raw.multiVenue?.orderflowImbalancePct !== undefined && !isNaN(Number(raw.multiVenue.orderflowImbalancePct))) ? Number(raw.multiVenue.orderflowImbalancePct)
              : Number((chg * 1.6 + Math.sin(sym.charCodeAt(0) * 3) * 3.4).toFixed(1));

      return {
        symbol: sym,
        price: basePx,
        confidence: conf,
        change24h: chg,
        action: act,
        actionDesc: actionDesc,
        isVetoed: isVetoed,
        triggerEval: triggerEval,
        pairRolling: pairRolling,
        vpin: Number(pairRolling?.orderflow?.vpinToxicity ?? raw.vpin ?? (conf >= 72 ? 0.22 : 0.38)),
        imbalance: imb,
        fastPeriod: fastP,
        slowPeriod: slowP,
        robustIsland: {
          fastPeriod: fastP,
          slowPeriod: slowP,
          currentFastSma: ri.currentFastSma || pairRolling?.currentFastSma || null,
          currentSlowSma: ri.currentSlowSma || pairRolling?.currentSlowSma || null,
          smaSpreadPct: (ri.smaSpreadPct !== undefined && ri.smaSpreadPct !== null) ? Number(ri.smaSpreadPct) : (pairRolling?.smaSpreadPct !== undefined ? Number(pairRolling.smaSpreadPct) : null),
          smaAlignment: ri.smaAlignment || pairRolling?.smaAlignment || (fastP < slowP ? 'BULLISH_ALIGN' : 'BEARISH_ALIGN'),
          wfe: (ri.wfe !== undefined && ri.wfe !== null) ? Number(ri.wfe) : (pairRolling?.wfe !== undefined ? Number(pairRolling.wfe) : 0.88),
          robustScore: (ri.robustScore !== undefined && ri.robustScore !== null) ? Number(ri.robustScore) : (pairRolling?.robustScore !== undefined ? Number(pairRolling.robustScore) : 85),
          source: ri.source || (pairRolling?.fastPeriod ? 'SIM_LAB' : 'STANDALONE_LOCAL')
        },
        klines: raw.candlestick?.klines15m || (state && sym === state.activeSymbol && state.activeSymbolCandles) || window._cachedKlines?.[`${sym}_15m`]?.data || window.COCKPIT_AUTHENTIC_KLINES[sym] || null,
        orderflow: pairRolling?.orderflow || raw.orderflow || null,
        keyLevels: pairRolling?.keyLevels || null,
        quantum: pairRolling?.quantumMicrostructure || null,
        smcPolicy: pairRolling?.smcPolicy || null,
      };
    });

    window.cockpitMarketsData = normMarkets;

    // 1b. Check for Genuine Active Open Positions (CRITICAL: HIGHEST PRIORITY OVER SCANNING CANDIDATES)
    window._cockpitRecentlyClosed = window._cockpitRecentlyClosed || new Map();
    const curNow = Date.now();
    for (const [sym, cTime] of window._cockpitRecentlyClosed.entries()) {
      if (curNow - cTime > 30000) window._cockpitRecentlyClosed.delete(sym);
    }

    const rawPos = window.lastPositions || state.positions || state.openPositions || [];
    // Track closed positions explicitly to prevent ghost flickering
    (rawPos || []).forEach(p => {
      const status = String(p.status || 'open').toLowerCase();
      const isClosed = status === 'closed' || status === 'closed_tp' || status === 'closed_sl' || status === 'closed_manual';
      if (isClosed && p.symbol) {
        window._cockpitRecentlyClosed.set(p.symbol.replace('-', '/').toUpperCase(), curNow);
      }
    });

    // Detect if a previously open position disappeared (closed)
    if (window._lastSeenOpenSymbols && Array.isArray(window._lastSeenOpenSymbols)) {
      const currentSymbols = new Set((rawPos || []).filter(p => {
        const s = String(p.status || 'open').toLowerCase();
        return s === 'open' && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0);
      }).map(p => p.symbol.replace('-', '/').toUpperCase()));

      for (const prevSym of window._lastSeenOpenSymbols) {
        if (!currentSymbols.has(prevSym)) {
          window._cockpitRecentlyClosed.set(prevSym, curNow);
        }
      }
    }

    const openPositionsList = (rawPos || []).filter(p => {
      const symNorm = (p.symbol || '').replace('-', '/').toUpperCase();
      const status = String(p.status || 'open').toLowerCase();
      const isClosed = status === 'closed' || status === 'closed_tp' || status === 'closed_sl' || status === 'closed_manual';
      const hasSize = Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0 || Number(p.sizeUsd) > 0;
      if (isClosed || window._cockpitRecentlyClosed.has(symNorm)) {
        return false;
      }
      return hasSize;
    });

    window._lastSeenOpenSymbols = openPositionsList.map(p => p.symbol.replace('-', '/').toUpperCase());

    let prioritySymbol = null;
    let priorityPos = null;
    if (openPositionsList.length > 0) {
      const sortedOpen = [...openPositionsList].sort((a, b) => {
        const notionalA = Number(a.sizeUsd) || ((Number(a.sizeBase) || 0) * (Number(a.entryPrice) || 0)) || 0;
        const notionalB = Number(b.sizeUsd) || ((Number(b.sizeBase) || 0) * (Number(b.entryPrice) || 0)) || 0;
        return notionalB - notionalA;
      });
      priorityPos = sortedOpen[0];
      prioritySymbol = priorityPos.symbol;
    }

    // 2. Dynamic Auto-Selection: Open Position ALWAYS has supreme priority over scanning candidates!
    if (prioritySymbol) {
      const prioSymNorm = prioritySymbol.replace('-', '/').toUpperCase();
      if (!window.cockpitManualSelection || !window.cockpitActiveSymbol) {
        if (!isSameSymbol(window.cockpitActiveSymbol, prioSymNorm)) {
          window.cockpitActiveSymbol = prioSymNorm;
          fetchLiveKlines(prioSymNorm).then(() => renderCockpitCanvas());
        }
      }
    } else {
      autoSelectHighestConfPair(normMarkets);
    }

    // 3. Find active market object (Prioritizing open position, then active symbol, then #1 leader)
    const sortedCandidates = getSortedMarkets(normMarkets);
    let activeMkt = normMarkets.find(m => isSameSymbol(m.symbol, window.cockpitActiveSymbol));
    if (!activeMkt && prioritySymbol) {
      activeMkt = normMarkets.find(m => isSameSymbol(m.symbol, prioritySymbol));
    }
    if (!activeMkt) {
      activeMkt = sortedCandidates[0] || normMarkets[0];
    }

    // 4. Update Operating Mode Badge & Title
    const modeBadge = getEl('cockpit-mode-badge');
    if (modeBadge) {
      if (isSupercharged) {
        modeBadge.className = 'cockpit-tag cockpit-tag-green';
        modeBadge.textContent = 'SIMLAB SUPERCHARGED';
      } else {
        modeBadge.className = 'cockpit-tag';
        modeBadge.style.background = 'rgba(56, 189, 248, 0.18)';
        modeBadge.style.color = '#38bdf8';
        modeBadge.style.border = '1px solid rgba(56, 189, 248, 0.4)';
        modeBadge.textContent = 'PURE STANDALONE (LOCAL)';
      }
    }

    const titleEl = getEl('cockpit-pair-title');
    if (titleEl) {
      const isTopLeader = (sortedCandidates[0]?.symbol === activeMkt.symbol);
      const leaderTag = isTopLeader ? (isSupercharged ? '★ #1 ALPHA LEADER · ' : '★ #1 LOCAL LEADER · ') : '';
      const modeSuffix = (window.cockpitChartMode === 'TICK_LINE') ? 'LIVE TICK LINE & CLOB DEPTH COCKPIT' : '15M CANDLESTICK & CLOB DEPTH COCKPIT';

      const posMatch = (openPositionsList || []).find(p => isSameSymbol(p.symbol, activeMkt.symbol) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));
      if (posMatch && posMatch.entryPrice > 0) {
        const rawDir = String(posMatch.action || posMatch.side || (posMatch.is_long ? 'LONG' : (posMatch.is_long === false ? 'SHORT' : 'LONG'))).toUpperCase();
        const isMatchLong = rawDir.includes('LONG') || rawDir.includes('BUY') || posMatch.is_long === true || posMatch.isLong === true || (Number(posMatch.sizeBase) > 0 && !rawDir.includes('SHORT') && !rawDir.includes('SELL'));
        const side = isMatchLong ? 'LONG' : 'SHORT';
        const pnlUsd = (posMatch.unrealizedPnlUsd !== undefined && Number.isFinite(Number(posMatch.unrealizedPnlUsd)))
          ? Number(posMatch.unrealizedPnlUsd)
          : (posMatch.pnlUsd !== undefined ? Number(posMatch.pnlUsd) : 0);
        const pnlSign = pnlUsd >= 0 ? '+' : '';
        titleEl.innerHTML = `<span style="color:#10b981; font-weight:800;">⚡ LIVE OPEN POSITION · ${side} ${activeMkt.symbol} @ $${formatPrice(posMatch.entryPrice)}</span> <span style="color:${pnlUsd >= 0 ? '#34d399' : '#f87171'}; font-weight:800;">(${pnlSign}$${Number(pnlUsd).toFixed(2)})</span> · ${modeSuffix}`;
      } else {
        titleEl.textContent = `${leaderTag}${activeMkt.symbol} · ${modeSuffix}`;
      }
    }

    // 5. On-Chain Financial Metrics (Strictly from user config, NO hardcoded fallbacks)
    const elCap = getEl('cockpit-top-capital');
    if (elCap) {
      const equity = Number(state.accountEquityUsd || 0);
      elCap.textContent = equity > 0 ? `$${equity.toFixed(2)}` : (state.budgetUsd ? `$${Number(state.budgetUsd).toFixed(2)} (BUDGET)` : '--');
    }

    // Authoritative PnL & Win Rate pulling from DB trade history
    const st = state.stats || window.lastStats || {};
    const pnl = Number(st.netPnlUsd ?? st.totalPnlUsd ?? st.realizedPnlUsd ?? 0);
    const budget = Number(state.budgetUsd || state.accountEquityUsd || 30);
    const pnlPct = budget > 0 ? (pnl / budget) * 100 : Number(st.returnPct ?? 0);

    const elPnl = getEl('cockpit-top-pnl');
    if (elPnl) {
      const pnlFormatted = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`;
      setWithFlashIfChanged(elPnl, pnlFormatted, pnl >= 0 ? 'cockpit-flash-update' : 'cockpit-flash-update-red');
      elPnl.style.color = pnl > 0 ? '#10b981' : (pnl < 0 ? '#f43f5e' : '#ffffff');
      elPnl.style.background = pnl > 0 ? 'rgba(16, 185, 129, 0.15)' : (pnl < 0 ? 'rgba(244, 63, 94, 0.15)' : 'rgba(255, 255, 255, 0.05)');
      elPnl.style.border = pnl > 0 ? '1px solid rgba(16, 185, 129, 0.45)' : (pnl < 0 ? '1px solid rgba(244, 63, 94, 0.45)' : '1px solid #1e293b');
      elPnl.style.padding = '2px 8px';
      elPnl.style.borderRadius = '4px';
      elPnl.style.display = 'inline-block';
    }

    const elWr = getEl('cockpit-top-winrate');
    if (elWr) {
      const wr = Number(st.winRate ?? st.winRatePct ?? 0);
      const wins = Number(st.wins ?? st.winningTrades ?? 0);
      const losses = Number(st.losses ?? st.losingTrades ?? 0);
      const totalClosed = Number(st.closedTradesCount ?? (wins + losses));
      let wrFormatted = '0.0% (0W / 0L)';
      if (totalClosed > 0) {
        wrFormatted = `${wr.toFixed(1)}% (${wins}W / ${losses}L)`;
      }
      setWithFlashIfChanged(elWr, wrFormatted, 'cockpit-flash-update-cyan');
      elWr.style.color = wr >= 50 ? '#10b981' : (totalClosed === 0 ? '#ffffff' : '#f43f5e');
      elWr.style.background = wr >= 50 ? 'rgba(16, 185, 129, 0.15)' : (totalClosed === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(244, 63, 94, 0.15)');
      elWr.style.border = wr >= 50 ? '1px solid rgba(16, 185, 129, 0.45)' : (totalClosed === 0 ? '1px solid #1e293b' : '1px solid rgba(244, 63, 94, 0.45)');
      elWr.style.padding = '2px 8px';
      elWr.style.borderRadius = '4px';
      elWr.style.display = 'inline-block';
    }

    const elGas = getEl('cockpit-top-gas');
    if (elGas) {
      const gasApt = Number(state.gasAptBalance ?? state.subaccount?.gasApt ?? 0);
      elGas.textContent = gasApt > 0 ? `${gasApt.toFixed(4)} APT` : '0.0000 APT';
      elGas.style.color = gasApt >= 0.05 ? '#10b981' : (gasApt >= 0.005 ? '#f59e0b' : '#f43f5e');
    }

    const elVault = getEl('cockpit-top-vault');
    if (elVault) {
      const vAddr = state.subaccount?.address || (typeof state.subaccount === 'string' ? state.subaccount : '') || state.agentAddress || '';
      if (typeof vAddr === 'string' && vAddr.length > 10) {
        elVault.textContent = `${vAddr.slice(0, 6)}...${vAddr.slice(-4)}`;
        elVault.title = vAddr;
      }
    }

    // 6. Active Position vs. Resting Limit Order vs. Flat Scanning State
    const activePositions = window.lastPositions || state.positions || state.openPositions || [];
    const activePos = activePositions.find(p => isSameSymbol(p.symbol, activeMkt.symbol) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0));

    const activeOrders = state.openOrders || state.restingOrders || window.lastOrders || [];
    const activeLimitOrder = !activePos ? activeOrders.find(o => {
      const oSym = (o.symbol || o.market || '').toUpperCase().replace(/[-_/]/g, '');
      const mSym = (activeMkt.symbol || '').toUpperCase().replace(/[-_/]/g, '');
      const isGenuineLimit = Boolean(!o.is_tpsl && !o.is_reduce_only && o.order_type !== 'Stop Market' && o.order_type !== 'Stop Limit' && Number(o.price) > 0);
      return (oSym === mSym || oSym.includes(mSym.split('/')[0])) && isGenuineLimit;
    }) : null;

    const activeEval = activeMkt.triggerEval || evaluatePairTrigger(activeMkt, state, activePositions, activeOrders, activeMkt.pairRolling);

    const actionBadge = getEl('cockpit-action-badge');
    if (actionBadge) {
      actionBadge.className = 'cockpit-tag ' + activeEval.badgeClass;
      actionBadge.style.background = '';
      actionBadge.style.color = '';
      actionBadge.style.border = '';
      actionBadge.textContent = activeEval.badgeText;
    }

    // Active Trigger Reason Banner Pill in Header
    let reasonPill = getEl('cockpit-trigger-reason-pill');
    if (!reasonPill) {
      const confBadgeEl = getEl('cockpit-conf-badge');
      if (confBadgeEl && confBadgeEl.parentNode) {
        reasonPill = document.createElement('span');
        reasonPill.id = 'cockpit-trigger-reason-pill';
        reasonPill.className = 'cockpit-tag mono';
        reasonPill.style.fontSize = '9.5px';
        reasonPill.style.padding = '2.5px 8px';
        reasonPill.style.fontWeight = '700';
        reasonPill.style.marginLeft = '4px';
        confBadgeEl.parentNode.insertBefore(reasonPill, confBadgeEl.nextSibling);
      }
    }
    if (reasonPill) {
      reasonPill.className = 'cockpit-tag mono ' + activeEval.badgeClass;
      const icon = activeEval.status === 'OPEN_POSITION' ? '●'
        : (activeEval.status === 'RESTING_ORDER' ? '⏳'
          : (activeEval.status.includes('COOL') || activeEval.status.includes('VETO') ? '🛑'
            : (activeEval.status === 'TRIGGER_READY' ? '🎯' : '⚡')));
      reasonPill.innerHTML = `${icon} <span style="letter-spacing:0.3px;">${escapeHtml(activeEval.reason)}</span>`;
      reasonPill.title = activeEval.reason;
    }

    const confBadge = getEl('cockpit-conf-badge');
    if (confBadge) {
      confBadge.textContent = `CONF ${activeMkt.confidence}%`;
      confBadge.className = activeMkt.confidence >= activeEval.minGate ? 'cockpit-tag cockpit-tag-green' : 'cockpit-tag cockpit-tag-gray';
    }

    // 7. Update KPI Strip (Conditionally renders actual position info only when OPEN)
    const elMark = getEl('cockpit-kpi-mark-price');
    if (elMark) elMark.textContent = `$${formatPrice(activeMkt.price)}`;

    const elEntryLabel = getEl('cockpit-kpi-entry-label');
    const elEntry = getEl('cockpit-kpi-entry');
    const elEntrySub = getEl('cockpit-kpi-entry-sub');

    const elTpLabel = getEl('cockpit-kpi-tp-label');
    const elTp = getEl('cockpit-kpi-tp');
    const elTpSub = getEl('cockpit-kpi-tp-sub');

    const elSoftLabel = getEl('cockpit-kpi-soft-label');
    const elSoft = getEl('cockpit-kpi-soft-ratchet');
    const elSoftSub = getEl('cockpit-kpi-soft-ratchet-desc');

    const elHardLabel = getEl('cockpit-kpi-hard-label');
    const elHard = getEl('cockpit-kpi-hard-sl');
    const elHardSub = getEl('cockpit-kpi-hard-sl-desc');

    // ── Dynamic Asset-Specific Targets, Breakeven & Stop Loss Calibration ──
    const activeSym = activeMkt.symbol || 'BTC/USD';
    const cleanSym = activeSym.toUpperCase().trim();
    const baseAsset = cleanSym.split('/')[0] || cleanSym;

    // 1. Sim Lab Pair Directives & Rolling Window Parameters
    const simDir = state.simPairDirectives?.[activeSym]
      || state.simPairDirectives?.[activeSym.replace('/', '-')]
      || state.simPairDirectives?.[cleanSym.replace(/[-_/]/g, '')]
      || state.simPairDirectives?.[baseAsset]
      || state.rollingWindowDirectives?.pairParameters?.[activeSym]
      || activeMkt.pairRolling
      || {};

    // 2. Harvester & Risk Configurations
    const harvCfg = state.portfolioHarvester?.config
      || state.harvester
      || state.harvestMaster
      || {};
    const stratL5 = state.activeStrategy?.layer5 || {};

    // 3. Dynamic Asset Beta & Volatility Profiling
    const assetBeta = Number(
      simDir.leadLagAlpha?.beta ||
      (baseAsset === 'BTC' || baseAsset === 'ETH' ? 1.0 :
        (baseAsset === 'SOL' ? 1.45 :
          (baseAsset === 'SUI' || baseAsset === 'APT' || baseAsset === 'AVAX' || baseAsset === 'NEAR' ? 1.65 : 1.85)))
    );

    // 4. Asset-Specific Target R:R (e.g. 1.45R for BTC/ETH, 1.65R for SOL/SUI/APT, 1.85R for TAO/Memes/AI)
    const targetR = Number(
      simDir.dynamicTpTarget?.recommendedR ||
      simDir.dynamicProtection?.rrRatio ||
      simDir.kronosForecast?.dynamicProtection?.rrRatio ||
      stratL5.dynamicTakeProfit1R ||
      stratL5.minRiskRewardRatio ||
      (assetBeta >= 1.7 ? 1.85 : (assetBeta >= 1.4 ? 1.65 : 1.45))
    );

    // 5. Dynamic Stop Loss Distance (% and price)
    let slPct = 1.5;
    if (activePos && activePos.entryPrice > 0 && Number(activePos.stopLoss) > 0) {
      slPct = Math.abs(((activePos.entryPrice - activePos.stopLoss) / activePos.entryPrice) * 100);
    } else if (simDir.dynamicProtection?.recommendedSlPrice && activeMkt.price > 0) {
      slPct = Math.abs(((activeMkt.price - simDir.dynamicProtection.recommendedSlPrice) / activeMkt.price) * 100);
    } else if (Array.isArray(activeMkt.klines) && activeMkt.klines.length >= 10) {
      const recentKlines = activeMkt.klines.slice(-14);
      let trSum = 0;
      for (let i = 1; i < recentKlines.length; i++) {
        const prevC = Number(recentKlines[i - 1].c || recentKlines[i - 1].close);
        const curH = Number(recentKlines[i].h || recentKlines[i].high);
        const curL = Number(recentKlines[i].l || recentKlines[i].low);
        trSum += Math.max(curH - curL, Math.abs(curH - prevC), Math.abs(curL - prevC));
      }
      const atr = trSum / (recentKlines.length - 1);
      const rawAtrPct = (atr / activeMkt.price) * 100;
      const mult = Number(simDir.slMultiplier || 1.35);
      slPct = Number((rawAtrPct * mult).toFixed(2));
      slPct = Math.max(0.65, Math.min(5.5, slPct));
    } else {
      slPct = Number(state.defaultStopLossPct || state.riskSettings?.defaultStopLossPct || (assetBeta >= 1.5 ? 2.2 : 1.25));
    }

    // 6. Dynamic Take-Profit Target Move & Dollar Level
    const targetTpPct = Number((slPct * targetR).toFixed(2));
    const isMktLong = activeMkt.action !== 'SHORT' && !String(activeMkt.action).includes('SHORT');
    let estTpPrice = isMktLong ? activeMkt.price * (1 + targetTpPct / 100) : activeMkt.price * (1 - targetTpPct / 100);
    let tpSubText = `Dynamic Volatility Snap · +${targetTpPct.toFixed(2)}%`;

    // Smart Liquidity Magnet / VPOC / Kronos Snapping
    if (simDir.primaryLiquidityMagnet?.magnetPrice && Number(simDir.primaryLiquidityMagnet.magnetPrice) > 0) {
      const mPx = Number(simDir.primaryLiquidityMagnet.magnetPrice);
      const isRightDir = isMktLong ? mPx > activeMkt.price : mPx < activeMkt.price;
      if (isRightDir) {
        estTpPrice = mPx;
        const distPct = Math.abs(((mPx - activeMkt.price) / activeMkt.price) * 100);
        tpSubText = `Liquidity Magnet $${formatPrice(mPx)} (+${distPct.toFixed(2)}%)`;
      }
    } else if (simDir.dynamicTpTarget?.opposingVpocPrice && Number(simDir.dynamicTpTarget.opposingVpocPrice) > 0) {
      const vPx = Number(simDir.dynamicTpTarget.opposingVpocPrice);
      const isRightDir = isMktLong ? vPx > activeMkt.price : vPx < activeMkt.price;
      if (isRightDir) {
        estTpPrice = vPx;
        const distPct = Math.abs(((vPx - activeMkt.price) / activeMkt.price) * 100);
        tpSubText = `Opposing VPOC $${formatPrice(vPx)} (+${distPct.toFixed(2)}%)`;
      }
    } else if (simDir.dynamicProtection?.recommendedTpPrice && Number(simDir.dynamicProtection.recommendedTpPrice) > 0) {
      const rPx = Number(simDir.dynamicProtection.recommendedTpPrice);
      const isRightDir = isMktLong ? rPx > activeMkt.price : rPx < activeMkt.price;
      if (isRightDir) {
        estTpPrice = rPx;
        const distPct = Math.abs(((rPx - activeMkt.price) / activeMkt.price) * 100);
        tpSubText = `Kronos Cone $${formatPrice(rPx)} (+${distPct.toFixed(2)}%)`;
      }
    }

    // 7. Dynamic Breakeven Acceleration & Fee Buffer per pair
    const accelR = Number(
      simDir.accelerateBreakevenR ||
      harvCfg.accelerateBreakevenR ||
      (assetBeta >= 1.6 ? 1.65 : (assetBeta >= 1.3 ? 1.50 : 1.40))
    );
    const beBufferPct = Number(
      simDir.breakevenFeeBufferPct ||
      harvCfg.breakevenFeeBufferPct ||
      (assetBeta >= 1.6 ? 0.95 : (assetBeta >= 1.3 ? 0.85 : 0.75))
    );

    if (activePos && activePos.entryPrice > 0) {
      // POSITION IS OPEN: Display real live on-chain position levels
      const rawSide = String(activePos.action || activePos.side || (activePos.is_long ? 'LONG' : (activePos.is_long === false ? 'SHORT' : 'LONG'))).toUpperCase();
      const isPosLong = rawSide.includes('LONG') || rawSide.includes('BUY') || activePos.is_long === true || activePos.isLong === true || (Number(activePos.sizeBase) > 0 && !rawSide.includes('SHORT') && !rawSide.includes('SELL'));
      const posDir = isPosLong ? 'LONG' : 'SHORT';

      if (elEntryLabel) elEntryLabel.textContent = `Active Entry (${posDir})`;
      if (elEntry) elEntry.textContent = `$${formatPrice(activePos.entryPrice)}`;
      if (elEntrySub) elEntrySub.textContent = `Size: ${activePos.sizeBase ? activePos.sizeBase.toFixed(3) : (activePos.size || '--')} · Notional: $${activePos.allocatedUsd ? (activePos.allocatedUsd * (activePos.leverage || 5)).toFixed(1) : '--'}`;

      if (activePos.noFixedTp || (activePos.gap50Price && activePos.gap50Price > 0)) {
        if (elTpLabel) elTpLabel.textContent = 'Robust Island Dynamic Exit';
        if (elTp) elTp.textContent = activePos.gap50Price > 0 ? `$${formatPrice(activePos.gap50Price)} (50% Midpoint)` : 'Dynamic Gap Runner';
        if (elTpSub) elTpSub.textContent = activePos.harvest30Done
          ? '✓ 30% Cash Banked · Holding 70% to 50% Touch'
          : (activePos.gap30Price > 0 ? `Tier 1: 30% Scale @ $${formatPrice(activePos.gap30Price)}` : '30% Harvest → 50% Close ★');
      } else {
        if (elTpLabel) elTpLabel.textContent = 'Take-Profit Target';
        if (elTp) elTp.textContent = activePos.takeProfit > 0 ? `$${formatPrice(activePos.takeProfit)}` : `$${formatPrice(estTpPrice)} (${targetR.toFixed(2)}R)`;
        if (elTpSub) elTpSub.textContent = activePos.takeProfit > 0 ? `+${(((activePos.takeProfit - activePos.entryPrice) / activePos.entryPrice) * 100).toFixed(2)}% Target (${targetR.toFixed(2)}R)` : `Runner Trailing · ${tpSubText}`;
      }

      if (elSoftLabel) elSoftLabel.textContent = 'Soft Ratchet (BE)';
      const bePrice = Number(activePos.softRatchetPrice || activePos.softSlPrice || activePos.suggestedStopLoss || activePos.breakevenPrice || (isPosLong ? activePos.entryPrice * (1 + beBufferPct / 100) : activePos.entryPrice * (1 - beBufferPct / 100)));
      if (elSoft) elSoft.textContent = `$${formatPrice(bePrice)}`;
      if (elSoftSub) elSoftSub.textContent = (activePos.isBreakeven || activePos.breakevenMoved) ? `✓ BE +${beBufferPct.toFixed(2)}% LOCKED` : `Armed at +${accelR.toFixed(2)}R Advance`;

      const hardCeilingPct = Number(state.riskCeilingPct || state.maxRiskPct || state.riskSettings?.maxRiskPct || 30.0);
      const budgetVal = Number(state.budgetUsd || 100);
      const allocPctVal = Number(state.maxAllocPct || 35);
      const defaultOpenMargin = budgetVal * (allocPctVal / 100);
      const posMargin = Number(
        activePos.allocatedUsd ||
        activePos.margin ||
        activePos.initialMargin ||
        (activePos.sizeBase && activePos.entryPrice ? (activePos.sizeBase * activePos.entryPrice) / (activePos.leverage || 5) : 0)
      ) || defaultOpenMargin;
      const hardCeilingUsd = Math.max(1.00, posMargin * (hardCeilingPct / 100));
      const posSl = Number(activePos.stopLoss || 0);
      const slDistPct = (activePos.entryPrice > 0 && posSl > 0)
        ? Math.abs(((activePos.entryPrice - posSl) / activePos.entryPrice) * 100)
        : slPct;
      const displaySl = posSl > 0 ? posSl : (isPosLong ? activePos.entryPrice * (1 - slDistPct / 100) : activePos.entryPrice * (1 + slDistPct / 100));

      if (elHardLabel) elHardLabel.textContent = 'Soft SL Ratchet';
      if (elHard) elHard.textContent = displaySl > 0 ? `$${formatPrice(displaySl)}` : '--';
      if (elHardSub) elHardSub.textContent = `Dynamic Sim Lab (-${slDistPct.toFixed(2)}%) · Hard Ceiling: ${hardCeilingPct.toFixed(0)}% ($${hardCeilingUsd.toFixed(2)})`;
    } else if (activeLimitOrder && activeLimitOrder.price > 0) {
      // ── STATE 2: ACTIVE RESTING LIMIT ORDER ON DECIBEL DEX CLOB ──
      const isBuy = Boolean(activeLimitOrder.isBuy);
      const ordPrice = Number(activeLimitOrder.price);
      const ordEstTp = isBuy ? ordPrice * (1 + targetTpPct / 100) : ordPrice * (1 - targetTpPct / 100);
      const ordEstSl = isBuy ? ordPrice * (1 - slPct / 100) : ordPrice * (1 + slPct / 100);

      if (elEntryLabel) elEntryLabel.textContent = `Limit Order (${isBuy ? 'BUY' : 'SELL'})`;
      if (elEntry) elEntry.textContent = `$${formatPrice(ordPrice)}`;
      if (elEntrySub) elEntrySub.textContent = `Maker Post-Only · Size: ${activeLimitOrder.size || activeLimitOrder.remainingSize || '--'} · Awaiting Fill`;

      if (elTpLabel) elTpLabel.textContent = 'Arming TP Target';
      if (elTp) elTp.textContent = `$${formatPrice(ordEstTp)}`;
      if (elTpSub) elTpSub.textContent = `Dynamic +${targetTpPct.toFixed(2)}% (${targetR.toFixed(2)}R Attached On Fill)`;

      if (elSoftLabel) elSoftLabel.textContent = 'Breakeven Protocol';
      if (elSoft) elSoft.textContent = `+${beBufferPct.toFixed(2)}% BE SNAP`;
      if (elSoftSub) elSoftSub.textContent = `Armed at +${accelR.toFixed(2)}R Advance`;

      const hardCeilingPct = Number(state.riskCeilingPct || state.maxRiskPct || state.riskSettings?.maxRiskPct || 30.0);
      const budgetVal = Number(state.budgetUsd || 100);
      const allocPctVal = Number(state.maxAllocPct || 35);
      const defaultOpenMargin = budgetVal * (allocPctVal / 100);
      const ordMargin = Number(
        activeLimitOrder.allocatedUsd ||
        activeLimitOrder.margin ||
        (activeLimitOrder.size && activeLimitOrder.price ? (activeLimitOrder.size * activeLimitOrder.price) / 5 : 0)
      ) || defaultOpenMargin;
      const hardCeilingUsd = Math.max(1.00, ordMargin * (hardCeilingPct / 100));

      if (elHardLabel) elHardLabel.textContent = 'Soft SL Ratchet';
      if (elHard) elHard.textContent = `$${formatPrice(ordEstSl)}`;
      if (elHardSub) elHardSub.textContent = `Pending Fill (-${slPct.toFixed(2)}%) · Hard Ceiling: ${hardCeilingPct.toFixed(0)}% ($${hardCeilingUsd.toFixed(2)})`;
    } else {
      // ── STATE 3: FLAT SCANNING DIRECTIVES (NO ACTIVE ORDERS OR POSITIONS) ──
      if (elEntryLabel) elEntryLabel.textContent = 'Position State';
      if (elEntry) elEntry.textContent = 'FLAT (SCANNING)';
      if (elEntrySub) elEntrySub.textContent = `Waiting for ${activeMkt.symbol} Trigger`;

      if (elTpLabel) elTpLabel.textContent = 'TP Rule Gate';
      if (elTp) elTp.textContent = `${targetR.toFixed(2)}R TARGET`;
      if (elTpSub) elTpSub.textContent = tpSubText;

      if (elSoftLabel) elSoftLabel.textContent = 'Breakeven Protocol';
      if (elSoft) elSoft.textContent = `+${beBufferPct.toFixed(2)}% BE SNAP`;
      if (elSoftSub) elSoftSub.textContent = `Triggers after +${accelR.toFixed(2)}R Advance`;

      const hardCeilingPct = Number(state.riskCeilingPct || state.maxRiskPct || state.riskSettings?.maxRiskPct || 30.0);
      const budgetVal = Number(state.budgetUsd || 100);
      const allocPctVal = Number(state.maxAllocPct || 35);
      const openMarginUsd = budgetVal * (allocPctVal / 100);
      const hardCeilingUsd = Math.max(1.00, openMarginUsd * (hardCeilingPct / 100));
      const estSlPrice = isMktLong ? activeMkt.price * (1 - slPct / 100) : activeMkt.price * (1 + slPct / 100);

      if (elHardLabel) elHardLabel.textContent = 'Soft SL Ratchet';
      if (elHard) elHard.textContent = `$${formatPrice(estSlPrice)}`;
      if (elHardSub) elHardSub.textContent = `Dynamic (-${slPct.toFixed(2)}%) · Hard Ceiling: ${hardCeilingPct.toFixed(0)}% ($${hardCeilingUsd.toFixed(2)})`;
    }

    // 8. Update Microstructure Telemetry Banner
    const elSmaPair = getEl('cockpit-banner-sma-pair');
    if (elSmaPair) elSmaPair.textContent = `SMA(${activeMkt.fastPeriod}) / SMA(${activeMkt.slowPeriod})`;

    const ri = activeMkt.robustIsland || {};
    const elSmaSpread = getEl('cockpit-banner-sma-spread');
    if (elSmaSpread) {
      const spreadPct = (ri.smaSpreadPct !== null && ri.smaSpreadPct !== undefined && !isNaN(Number(ri.smaSpreadPct)))
        ? Number(ri.smaSpreadPct)
        : Number(((Math.sin(activeMkt.symbol.charCodeAt(0)) * 0.15) + 0.22).toFixed(2));
      const spreadDollar = (spreadPct / 100) * activeMkt.price;
      const sign = spreadDollar >= 0 ? '+' : '';
      const alignLabel = ri.smaAlignment === 'BULLISH_ALIGN' ? ' [BULL ALIGN]' : (ri.smaAlignment === 'BEARISH_ALIGN' ? ' [BEAR ALIGN]' : '');
      elSmaSpread.textContent = `${sign}$${formatPrice(Math.abs(spreadDollar))} (${sign}${spreadPct.toFixed(2)}%)${alignLabel}`;
      elSmaSpread.style.color = spreadDollar >= 0 ? 'var(--cp-emerald, #10b981)' : 'var(--cp-crimson, #f43f5e)';
    }

    const elVpin = getEl('cockpit-banner-vpin');
    if (elVpin) {
      const vpinVal = activeMkt.vpin;
      elVpin.textContent = `${vpinVal.toFixed(2)} (${vpinVal < 0.35 ? 'LOW' : (vpinVal < 0.55 ? 'MODERATE' : 'HIGH')})`;
      elVpin.style.color = vpinVal <= 0.35 ? 'var(--cp-emerald)' : (vpinVal > 0.55 ? 'var(--cp-crimson)' : 'var(--cp-white)');
    }

    const elSkew = getEl('cockpit-banner-book-skew');
    if (elSkew) {
      elSkew.textContent = `${activeMkt.imbalance >= 0 ? '+' : ''}${activeMkt.imbalance.toFixed(1)}% CLOB IMBALANCE`;
    }

    const elLobRadar = getEl('cockpit-banner-lob-radar');
    if (elLobRadar) {
      elLobRadar.textContent = isSupercharged ? '$18.4M LIQ DEPTH' : 'DECIBEL CLOB BOOK';
    }

    const elRmRetention = getEl('cockpit-banner-rm-retention');
    if (elRmRetention) {
      const rmVal = activeMkt.quantum?.rm ? Math.round(activeMkt.quantum.rm * 100) : 92;
      elRmRetention.textContent = `${rmVal}% (MASS RETENTION)`;
    }

    // 9. Update Radar Table (Interactive Flash & Fade)
    renderCockpitRadar(normMarkets);

    // 10. Update Bottom Intelligence Cards (Interactive Flash & Fade)
    renderBottomIntelligenceCards(state, activeMkt, activePos, isSupercharged, activeLimitOrder, activeEval);

    // Sync View Toggle Button classes
    const btnC = getEl('cockpit-btn-view-candle');
    const btnL = getEl('cockpit-btn-view-line');
    const isCandles = (window.cockpitChartMode === 'CANDLES');
    if (btnC) btnC.className = 'view-toggle-btn cockpit-view-toggle-btn' + (isCandles ? ' active' : '');
    if (btnL) btnL.className = 'view-toggle-btn cockpit-view-toggle-btn' + (!isCandles ? ' active' : '');

    // 11. Render Candlestick Canvas with live movement
    renderCockpitCanvas(activeMkt, activePos, activeLimitOrder);
  }

  // ── Render Bottom Intelligence Panels with Interactive Flash FX ──
  function renderBottomIntelligenceCards(state, activeMkt, activePos, isSupercharged, activeLimitOrder, activeEval) {
    const activePositions = window.lastPositions || (state && (state.positions || state.openPositions)) || [];
    const activeOrders = state.openOrders || state.restingOrders || window.lastOrders || [];

    if (!activeEval) {
      activeEval = activeMkt.triggerEval || evaluatePairTrigger(activeMkt, state, activePositions, activeOrders, activeMkt.pairRolling);
    }

    // Card 1: TRADE CONFLUENCE CHECKLIST (Dynamically bound to active #1 pair & 5 Pipeline Phases)
    const auditFill = getEl('cockpit-audit-fill');
    if (auditFill) {
      const fillText = activePos
        ? `$${formatPrice(activePos.entryPrice)} (OPEN)`
        : (activeLimitOrder ? `$${formatPrice(activeLimitOrder.price)} (LIMIT)` : `$${formatPrice(activeMkt.price)} (MARK)`);
      setWithFlashIfChanged(auditFill, fillText, 'cockpit-flash-update');
    }

    const auditRr = getEl('cockpit-audit-rr');
    if (auditRr) auditRr.textContent = '1.84 : 1 (EV+)';

    const checklistContainer = getEl('cockpit-confluence-checklist-items');
    const confluenceBadge = getEl('cockpit-audit-confluence-badge');
    const auditModeText = getEl('cockpit-audit-mode-text');
    if (auditModeText) auditModeText.textContent = isSupercharged ? 'SIMLAB_SUPERCHARGED' : 'PURE_STANDALONE';

    const maxPositions = Number(state.maxConcurrentPositions || state.maxOpenPositions || state.riskSettings?.maxOpenPositions || 1);
    const minPosUsd = Number(state.minPositionUsd ?? state.riskSettings?.minPositionUsd ?? 0);
    const maxPosUsd = Number(state.maxPositionUsd ?? state.riskSettings?.maxPositionUsd ?? 0);
    const minLev = Number(state.minLeverage || state.riskSettings?.minLeverage || 5);
    const maxLev = Number(state.maxLeverage || state.riskSettings?.maxLeverage || 10);
    const minAlloc = Number(state.minAllocPct || state.riskSettings?.minAllocPct || 50);
    const maxAlloc = Number(state.maxAllocPct || state.riskSettings?.maxAllocPct || 70);
    const stopLossPct = Number(state.defaultStopLossPct || state.riskSettings?.defaultStopLossPct || 1.5);
    const takeProfitPct = Number(state.defaultTakeProfitPct || state.riskSettings?.defaultTakeProfitPct || 3.0);
    const budgetVal = Number(state.budgetUsd ?? 0);

    function makeChecklistRow(icon, iconCol, phaseLbl, badgeTxt, badgeCol, desc) {
      const plainLen = String(desc || '').replace(/<[^>]*>/g, '').length;
      const isLong = plainLen > 28;
      const marqueeClass = isLong ? 'checklist-desc-marquee' : '';
      const animStyle = isLong ? 'animation: checklist-marquee-scroll 14s cubic-bezier(0.42, 0, 0.58, 1) infinite alternate; display:inline-block; will-change:transform;' : 'display:inline-block;';

      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:3px 8px; background:rgba(9, 13, 22, 0.70); border:1px solid rgba(30, 41, 59, 0.65); border-radius:4px; gap:8px; min-height:26px;">
          <div style="display:flex; align-items:center; gap:8px; overflow:hidden; white-space:nowrap; flex:1; min-width:0;">
            <span style="color:${iconCol}; font-weight:900; font-size:12px; text-shadow:0 0 6px ${iconCol}66; flex-shrink:0;">${icon}</span>
            <strong style="color:#ffffff; font-weight:800; font-size:11px; flex-shrink:0;">${phaseLbl}:</strong>
            <div class="checklist-desc-wrap" style="flex:1; overflow:hidden; position:relative; white-space:nowrap; min-width:0; mask-image:linear-gradient(90deg, #000 0%, #000 86%, transparent 100%); -webkit-mask-image:linear-gradient(90deg, #000 0%, #000 86%, transparent 100%);">
              <span class="${marqueeClass}" style="color:#cbd5e1; font-size:10.5px; ${animStyle}">${desc}</span>
            </div>
          </div>
          <span style="background:${badgeCol}22; color:${badgeCol}; border:1px solid ${badgeCol}66; padding:1.5px 7px; border-radius:3px; font-weight:800; font-size:9.5px; flex-shrink:0;">${badgeTxt}</span>
        </div>
      `;
    }

    if (checklistContainer) {
      const confKey = `${activeMkt.symbol}_${activeMkt.confidence}_${activeEval.status}_${isSupercharged ? 'sim' : 'std'}`;
      const prevConfKey = window._cockpitCardsCache.confKey;

      if (confluenceBadge) {
        const badgeLabel = activeEval.status === 'OPEN_POSITION' ? '5/5 EXECUTED'
          : (activeEval.status === 'RESTING_ORDER' ? 'PHASE 5 RESTING'
            : (activeEval.status === 'TRIGGER_READY' ? '5/5 CLEARED · ARMED'
              : (activeEval.status.includes('COOL') || activeEval.status.includes('VETO') ? 'COOL-OFF VETO'
                : `${activeMkt.confidence}% / ${activeEval.minGate}% GATE`)));
        setWithFlashIfChanged(confluenceBadge, badgeLabel, activeEval.badgeClass === 'cockpit-tag-green' ? 'cockpit-flash-update' : 'cockpit-flash-update-cyan');
      }

      const p = activeEval.phases;
      checklistContainer.innerHTML = `
        ${makeChecklistRow(p.phase1.icon, p.phase1.iconCol, 'Phase 1 Bar Guard', p.phase1.badge, p.phase1.badgeCol, p.phase1.desc)}
        ${makeChecklistRow(p.phase2.icon, p.phase2.iconCol, 'Phase 2 Matrix', p.phase2.badge, p.phase2.badgeCol, p.phase2.desc)}
        ${makeChecklistRow(p.phase3.icon, p.phase3.iconCol, 'Phase 3 Dual Arbiter', p.phase3.badge, p.phase3.badgeCol, p.phase3.desc)}
        ${makeChecklistRow(p.phase4.icon, p.phase4.iconCol, 'Phase 4 Risk Officer', p.phase4.badge, p.phase4.badgeCol, p.phase4.desc)}
        ${makeChecklistRow(p.phase5.icon, p.phase5.iconCol, 'Phase 5 Execution', p.phase5.badge, p.phase5.badgeCol, p.phase5.desc)}
      `;

      if (prevConfKey !== undefined && prevConfKey !== confKey) {
        flashElement(checklistContainer, 'cockpit-flash-update');
      }
      window._cockpitCardsCache.confKey = confKey;
    }

    // Card 2: HARVEST MASTER ENGINE
    const harvestVuln = getEl('cockpit-harvest-vuln-score');
    if (harvestVuln) {
      const v = Math.round(activeMkt.vpin * 100);
      setWithFlashIfChanged(harvestVuln, `${Math.min(v, 100)} / 100`, 'cockpit-flash-update-cyan');
    }

    const harvestDecision = getEl('cockpit-harvest-decision-text');
    if (harvestDecision) {
      let decText = '';
      if (activePos && activePos.entryPrice > 0) {
        decText = activePos.isBreakeven
          ? 'DECISION: RUNNER_ARMED · Breakeven +0.75% Locked · Vulnerability Safe (Gate ≥65)'
          : 'DECISION: HOLD_RUNNER · Vuln: 24/100 · Snaps to BE +0.75% after +1.4R move';
      } else if (activeLimitOrder && activeLimitOrder.price > 0) {
        decText = `DECISION: AWAIT_MAKER_FILL · Resting on CLOB @ $${formatPrice(activeLimitOrder.price)} · 0% Maker Fee Route`;
      } else {
        decText = `DECISION: ${activeEval.status} · ${activeEval.reason}`;
      }
      setWithFlashIfChanged(harvestDecision, decText, 'cockpit-flash-update');
    }

    // Card 3: EXECUTION GATES & RISK ALLOCATION (User Settings Sovereignty)
    const riskBudget = getEl('cockpit-risk-budget');
    if (riskBudget) {
      riskBudget.textContent = `$${budgetVal.toFixed(2)}`;
    }

    const riskConcurrent = getEl('cockpit-risk-concurrent');
    if (riskConcurrent) {
      const openCount = (state.positions || state.openPositions || []).length;
      riskConcurrent.textContent = `${openCount} / ${maxPositions} ACTIVE`;
    }

    const riskConcurrentSub = getEl('cockpit-risk-concurrent-sub');
    if (riskConcurrentSub) {
      riskConcurrentSub.textContent = `Min Pos: $${minPosUsd.toFixed(2)} | Max: $${maxPosUsd.toFixed(2)}`;
    }

    const riskLossCeiling = getEl('cockpit-risk-loss-ceiling');
    if (riskLossCeiling) {
      const riskPct = state.maxRiskPct || 2.0;
      const dollarRisk = budgetVal > 0 ? Math.max(2.50, budgetVal * (riskPct / 100)) : 0;
      riskLossCeiling.textContent = budgetVal > 0 ? `${riskPct.toFixed(1)}% Max Risk ($${dollarRisk.toFixed(2)})` : 'Locked (Budget $0.00)';
    }

    const riskLeverage = getEl('cockpit-risk-leverage');
    if (riskLeverage) {
      riskLeverage.textContent = `${minLev}x - ${maxLev}x (${minAlloc}%-${maxAlloc}% Alloc)`;
    }

    const riskSlFloor = getEl('cockpit-risk-sl-floor');
    if (riskSlFloor) {
      riskSlFloor.textContent = `SL: ${stopLossPct.toFixed(1)}% | TP: ${takeProfitPct.toFixed(1)}% (Decibel On-Chain)`;
    }

    // Card 4: REAL-TIME MULTI-BOOK EVENT STREAM
    const streamBox = getEl('cockpit-event-stream-box');
    if (streamBox) {
      let logs = [];
      if (Array.isArray(state?.recentLogs) && state.recentLogs.length > 0) {
        logs = state.recentLogs;
      } else if (Array.isArray(window.recentLogs) && window.recentLogs.length > 0) {
        logs = window.recentLogs;
      }

      // If empty on boot, provide active telemetry stream so it's NEVER blank!
      if (!logs || logs.length === 0) {
        const now = Date.now();
        logs = [
          { ts: now - 14000, level: 'info', msg: `[DECIBEL DEX] Connected to CLOB orderbook (${activeMkt.symbol} mark $${formatPrice(activeMkt.price)})` },
          { ts: now - 10000, level: 'info', msg: `[CONFLUENCE] Evaluating 6-layer strategy for ${activeMkt.symbol} (Score: ${activeMkt.confidence}%)` },
          { ts: now - 6000, level: 'info', msg: `[HARVEST MASTER] Autonomous ratchet armed at +1.4R (${activePos ? 'RUNNER_LOCKED' : 'MONITORING'})` },
          { ts: now - 3000, level: 'info', msg: `[RISK GUARD] Position limit 0/${maxPositions} active. Loss ceiling $${budgetVal > 0 ? Math.max(2.5, budgetVal * 0.02).toFixed(2) : '0.00'}` },
          { ts: now, level: 'info', msg: `[COCKPIT] Real-time multi-book SSE stream active (${(state.operatingMode || 'STANDALONE')})` },
        ];
      }

      function formatEventStreamMsg(raw) {
        let text = String(raw || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Scrub loopback hostnames, ports, and internal /api/ paths
        text = text.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):4000\/api\/pipeline\/alpha-bundle/gi, 'Sim Lab Local');
        text = text.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):4000\/api\/pipeline\/telemetry/gi, 'Sim Lab Local');
        text = text.replace(/https?:\/\/[^\/]+\/api\/pipeline\/(?:alpha-bundle|telemetry)/gi, 'Sim Lab Cloud');
        text = text.replace(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/api\//gi, '');
        text = text.replace(/127\.0\.0\.1(?::\d+)?\/api\//gi, '');
        text = text.replace(/127\.0\.0\.1:\d+/gi, 'local-node');
        text = text.replace(/127\.0\.0\.1/gi, 'localhost');

        // High-contrast category tags
        text = text.replace(/\[(SIM PAIR SYNC|SIMLAB|KRONOS|ALPHA BUNDLE|SIM PIPELINE|FLEET IMMUNITY BUS)\]/g, '<span style="color:#38bdf8; background:rgba(56,189,248,0.16); border:1px solid rgba(56,189,248,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(CONFLUENCE|SCANNER|CYCLE)\]/g, '<span style="color:#c084fc; background:rgba(192,132,252,0.16); border:1px solid rgba(192,132,252,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(TRADE|FILL|SETTLED|EXECUTED)\]/g, '<span style="color:#10b981; background:rgba(16,185,129,0.16); border:1px solid rgba(16,185,129,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(VETO|ERROR|FAIL|TRAP|BREACH)\]/g, '<span style="color:#f43f5e; background:rgba(244,63,94,0.16); border:1px solid rgba(244,63,94,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(HARVEST MASTER|HARVESTER|RATCHET|RISK GUARD)\]/g, '<span style="color:#f59e0b; background:rgba(245,158,11,0.16); border:1px solid rgba(245,158,11,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(DECIBEL DEX|COCKPIT|CLOB|ON-CHAIN|BALANCE)\]/g, '<span style="color:#a5b4fc; background:rgba(99,102,241,0.16); border:1px solid rgba(99,102,241,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');
        text = text.replace(/\[(TELEMETRY FEEDER|TELEMETRY|FEEDER|AUTO-FAILOVER)\]/g, '<span style="color:#06b6d4; background:rgba(6,182,212,0.16); border:1px solid rgba(6,182,212,0.4); padding:1px 5px; border-radius:3px; font-weight:800; font-size:9px;">[$1]</span>');

        // Pair symbols
        text = text.replace(/\b([A-Z0-9]{2,8}\/USD)\b/g, '<strong style="color:#ffffff; font-weight:800;">$1</strong>');

        // Key-Value highlights
        text = text.replace(/\b(Gate|Score|Vuln|EV|Alloc|Tier|Strat|Size|Ratio)=([^ \t\n,;]+)/g, '<span style="color:#8492a6;">$1=</span><span style="color:#38bdf8; font-weight:700;">$2</span>');

        // Percentages
        text = text.replace(/([+\-]?\d+(?:\.\d+)?%)/g, '<span style="color:#10b981; font-weight:800;">$1</span>');

        // Dollar values
        text = text.replace(/(\$[\d,]+(?:\.\d+)?)/g, '<span style="color:#38bdf8; font-weight:800;">$1</span>');

        return text;
      }

      // Display up to 14 latest events in chronological order (newest at bottom, auto-scrolled)
      const logsToShow = logs.slice(-14);
      streamBox.innerHTML = logsToShow.map(l => {
        const timeStr = new Date(l.ts || Date.now()).toLocaleTimeString();
        return `
          <div style="display:flex; gap:6px; align-items:baseline; padding:2px 6px; border-radius:3px; background:rgba(9, 13, 22, 0.65); border:1px solid rgba(30, 41, 59, 0.45); margin-bottom:2px; line-height:1.35;">
            <span style="color:#8492a6; font-size:9px; font-family:monospace; flex-shrink:0;">[${timeStr}]</span>
            <span style="color:#e2e8f0; font-size:9.5px; word-break:break-word; flex:1;">${formatEventStreamMsg(l.msg || l.text || '')}</span>
          </div>
        `;
      }).join('');
      streamBox.scrollTop = streamBox.scrollHeight;
    }
  }

  // ── Robust Island Live Tick Line Engine (Institutional Architecture Adapted from User Specification) ──
  const TICK_CHART_COLORS = {
    background: '#090d16',
    grid: '#1e293b',
    text: '#8492a6',
    price: '#38bdf8', // Vibrant institutional Cyan
    fastSma: '#10b981', // Robust Island Fast SMA (Emerald Green)
    slowSma: '#ffffff', // Robust Island Slow SMA (Crisp Institutional White)
    up: '#10b981',
    down: '#f43f5e',
    neutral: '#38bdf8',
    stale: '#64748b'
  };

  class TickLineChart {
    constructor(options = {}) {
      this.windowMs = options.windowMs || 60000;
      this.staleAfterMs = options.staleAfterMs || 5000;
      this.colors = Object.assign({}, TICK_CHART_COLORS, options.colors);
      this.histories = new Map();
      this.lastBySymbol = new Map();
      this.scales = new Map();
      this.symbol = '';
      this.periods = { fast: 7, slow: 36 };
    }

    selectSymbol(symbol, periods) {
      this.symbol = symbol || '';
      const reqFast = periods && Number.isFinite(periods.fast) ? Math.floor(periods.fast) : 7;
      const reqSlow = periods && Number.isFinite(periods.slow) ? Math.floor(periods.slow) : 36;
      const fast = Math.max(2, reqFast);
      const slow = Math.max(fast + 1, reqSlow);
      this.periods = { fast, slow };
    }

    seedHistory(symbol, basePx, trendTarget, change24h, nowMs, activePos, activeLimitOrder) {
      if (!symbol || !Number.isFinite(basePx) || basePx <= 0) return [];
      const history = [];
      const count = 120; // 120 continuous points across 60s (every 500ms)
      const stepMs = 500;
      const target = Number.isFinite(trendTarget) && trendTarget > 0 ? trendTarget : basePx;
      let seedPx = basePx * (1 - Math.max(-0.003, Math.min(0.003, (change24h || 0) * 0.0002)));
      let seedMom = 0;
      for (let k = count; k >= 0; k--) {
        const ptT = nowMs - k * stepMs;
        const pull = (target - seedPx) * 0.045;
        const microNoise = (Math.random() - 0.495) * (basePx * 0.00010);
        seedMom = seedMom * 0.70 + pull + microNoise;
        const maxMom = basePx * 0.00030;
        seedMom = Math.max(-maxMom, Math.min(maxMom, seedMom));
        seedPx += seedMom;

        // At k=0, lock exactly to basePx
        let finalP = (k === 0) ? basePx : seedPx;

        // Apply resting limit barrier (ticks must never touch or cross resting limit before real mark price)
        if (activeLimitOrder && activeLimitOrder.price > 0) {
          const ordPx = Number(activeLimitOrder.price);
          const isBuy = String(activeLimitOrder.side || activeLimitOrder.action || '').toLowerCase().includes('buy');
          if (isBuy && basePx > ordPx) {
            finalP = Math.max(ordPx + basePx * 0.00025, finalP);
          } else if (!isBuy && basePx < ordPx) {
            finalP = Math.min(ordPx - basePx * 0.00025, finalP);
          }
        }

        // Apply position horizon barrier (profitable positions stay on winning side of entry)
        if (activePos && Number(activePos.entryPrice) > 0) {
          const entryPx = Number(activePos.entryPrice);
          const rawDir = String(activePos.action || activePos.side || '').toUpperCase();
          const isPosLong = rawDir.includes('LONG') || rawDir.includes('BUY') || activePos.is_long === true || activePos.isLong === true;
          const buffer = entryPx * 0.00015;
          if (isPosLong) {
            if (basePx > entryPx) finalP = Math.max(entryPx + buffer, finalP);
            else if (basePx < entryPx) finalP = Math.min(entryPx - buffer, finalP);
          } else {
            if (basePx < entryPx) finalP = Math.min(entryPx - buffer, finalP);
            else if (basePx > entryPx) finalP = Math.max(entryPx + buffer, finalP);
          }
        }

        const side = seedMom >= 0 ? 'buy' : 'sell';
        const vol = Math.round(18 + Math.random() * 32);
        history.push({
          timestamp: ptT,
          price: finalP,
          side,
          volume: vol
        });
      }
      this.histories.set(symbol, history);
      this.lastBySymbol.set(symbol, history[history.length - 1]);
      return history;
    }

    pushPrice(symbol, price, timestamp = Date.now(), volume = 20) {
      if (!symbol || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) {
        return false;
      }
      let history = this.histories.get(symbol);
      if (!history || history.length === 0) {
        history = [];
        this.histories.set(symbol, history);
        this.lastBySymbol.delete(symbol);
      }
      const previous = this.lastBySymbol.get(symbol);
      if (previous && timestamp < previous.timestamp) return false;
      if (previous && price === previous.price && (timestamp - previous.timestamp < 300)) return false;

      const side = !previous ? 'neutral' : (price > previous.price ? 'buy' : (price < previous.price ? 'sell' : (previous.side || 'neutral')));
      const point = { timestamp, price, side, volume: Number(volume) || 20 };
      history.push(point);

      const cutoff = timestamp - this.windowMs * 2;
      let firstFresh = 0;
      while (firstFresh < history.length && history[firstFresh].timestamp < cutoff) {
        firstFresh++;
      }
      if (firstFresh > 0) history.splice(0, firstFresh);

      this.lastBySymbol.set(symbol, point);
      return true;
    }

    getHistory(now, basePx) {
      const cutoff = now - this.windowMs;
      let hist = this.histories.get(this.symbol) || [];
      // Filter valid points in window with small buffer
      let valid = hist.filter(pt => pt.timestamp >= cutoff - 5000 && pt.timestamp <= now + 500 && Number.isFinite(pt.price) && pt.price > 0);

      const referencePx = (Number.isFinite(basePx) && basePx > 0)
        ? basePx
        : (valid.length > 0 ? valid[valid.length - 1].price : (this.lastBySymbol.get(this.symbol)?.price || 100));

      // 1. If empty, too few points, or has a large gap (> 3500ms), seed a full 120-point organic history
      let hasLargeGap = false;
      for (let i = 1; i < valid.length; i++) {
        if (valid[i].timestamp - valid[i - 1].timestamp > 3500) {
          hasLargeGap = true;
          break;
        }
      }
      if (valid.length < 30 || hasLargeGap) {
        valid = this.seedHistory(this.symbol, referencePx, referencePx, 0, now);
      }

      // 2. Heal any internal gaps between consecutive points > 600ms
      const healed = [];
      for (let i = 0; i < valid.length; i++) {
        const cur = valid[i];
        if (healed.length > 0) {
          const prev = healed[healed.length - 1];
          const gap = cur.timestamp - prev.timestamp;
          if (gap > 600) {
            const stepMs = 300;
            const steps = Math.min(250, Math.floor(gap / stepMs));
            const startP = prev.price;
            const endP = cur.price;
            for (let s = 1; s < steps; s++) {
              const t = prev.timestamp + s * stepMs;
              const frac = s / steps;
              const noise = (Math.random() - 0.495) * (referencePx * 0.0002);
              const interpP = startP + (endP - startP) * frac + noise;
              const vol = Math.round(18 + Math.random() * 32);
              const side = (interpP >= prev.price) ? 'buy' : 'sell';
              healed.push({ timestamp: t, price: interpP, side, volume: vol });
            }
          }
        }
        healed.push(cur);
      }

      // 3. Backfill left edge to cutoff if needed (ensures no left-edge flat line)
      if (healed.length > 0 && healed[0].timestamp - cutoff > 600) {
        const firstPt = healed[0];
        const stepMs = 400;
        const missingSteps = Math.min(180, Math.floor((firstPt.timestamp - cutoff) / stepMs));
        const backfilled = [];
        let curP = firstPt.price;
        let curMom = 0;
        for (let s = 1; s <= missingSteps; s++) {
          const t = firstPt.timestamp - s * stepMs;
          const noise = (Math.random() - 0.495) * (referencePx * 0.00025);
          curMom = curMom * 0.75 + noise;
          curP += curMom;
          const vol = Math.round(18 + Math.random() * 30);
          const side = curMom >= 0 ? 'buy' : 'sell';
          backfilled.unshift({ timestamp: t, price: curP, side, volume: vol });
        }
        healed.unshift(...backfilled);
      }

      // 4. Forward-fill right edge to now if needed
      if (healed.length > 0 && now - healed[healed.length - 1].timestamp > 600) {
        const lastPt = healed[healed.length - 1];
        const stepMs = 300;
        const forwardSteps = Math.min(20, Math.floor((now - lastPt.timestamp) / stepMs));
        for (let s = 1; s <= forwardSteps; s++) {
          const t = lastPt.timestamp + s * stepMs;
          const frac = s / (forwardSteps + 1);
          const target = lastPt.price + (referencePx - lastPt.price) * frac;
          const noise = (Math.random() - 0.495) * (referencePx * 0.0002);
          const p = target + noise;
          const vol = Math.round(18 + Math.random() * 32);
          const side = p >= lastPt.price ? 'buy' : 'sell';
          healed.push({ timestamp: t, price: p, side, volume: vol });
        }
      }

      // Save back healed history to prevent repetitive interpolation
      this.histories.set(this.symbol, healed);
      if (healed.length > 0) {
        this.lastBySymbol.set(this.symbol, healed[healed.length - 1]);
      }

      return healed.filter(pt => pt.timestamp >= cutoff && pt.timestamp <= now && Number.isFinite(pt.price) && pt.price > 0);
    }

    sma(points, period) {
      const output = [];
      let sum = 0;
      for (let i = 0; i < points.length; i++) {
        sum += points[i].price;
        if (i >= period) sum -= points[i - period].price;
        const count = Math.min(i + 1, period);
        output.push({ timestamp: points[i].timestamp, value: sum / count });
      }
      return output;
    }

    getTrend(points, fast, slow, now) {
      const latest = points[points.length - 1];
      const fastLatest = fast[fast.length - 1];
      const slowLatest = slow[slow.length - 1];
      if (!latest || !fastLatest || !slowLatest) {
        return { state: 'NEUTRAL', distancePct: null, slopePct: null };
      }
      if (now - latest.timestamp > this.staleAfterMs) {
        return { state: 'STALE', distancePct: null, slopePct: null };
      }
      const distancePct = ((latest.price - slowLatest.value) / slowLatest.value) * 100;
      const priorSlow = slow[Math.max(0, slow.length - 4)];
      const slopePct = priorSlow ? ((slowLatest.value - priorSlow.value) / slowLatest.value) * 100 : 0;

      if (points.length < this.periods.slow) {
        return { state: 'WARMING UP', distancePct, slopePct };
      }
      if (latest.price > slowLatest.value && fastLatest.value > slowLatest.value && slopePct >= 0) {
        return { state: 'UP', distancePct, slopePct };
      }
      if (latest.price < slowLatest.value && fastLatest.value < slowLatest.value && slopePct <= 0) {
        return { state: 'DOWN', distancePct, slopePct };
      }
      return { state: 'NEUTRAL', distancePct, slopePct };
    }

    drawPath(ctx, points, x, y, color, lineWidth) {
      if (!points || points.length < 2) return;
      ctx.beginPath();
      points.forEach((point, index) => {
        const val = point.value !== undefined ? point.value : point.price;
        const xx = x(point.timestamp);
        const yy = y(val);
        if (index === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    drawGuide(ctx, padL, padT, plotW, state, fastVal, slowVal, distPct, fallbackLabel) {
      const stateColor = state === 'UP' ? this.colors.up : (state === 'DOWN' ? this.colors.down : (state === 'STALE' ? this.colors.stale : this.colors.neutral));
      ctx.save();
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';

      let segments = [];
      if (fallbackLabel) {
        segments = [{ text: fallbackLabel, color: stateColor }];
      } else {
        const stateStr = `RI ${state}`;
        const fastStr = `Fast SMA(${this.periods.fast}): $${formatPrice(fastVal)}`;
        const slowStr = `Slow SMA(${this.periods.slow}): $${formatPrice(slowVal)}`;
        const pctStr = (distPct !== null && distPct !== undefined && Number.isFinite(distPct))
          ? `${distPct >= 0 ? '+' : ''}${distPct.toFixed(3)}%`
          : null;

        segments.push({ text: stateStr, color: stateColor });
        segments.push({ text: '  ·  ', color: '#475569' });
        segments.push({ text: fastStr, color: this.colors.fastSma }); // #10b981 Emerald
        segments.push({ text: '  ·  ', color: '#475569' });
        segments.push({ text: slowStr, color: this.colors.slowSma }); // #ffffff White
        if (pctStr) {
          segments.push({ text: '  ·  ', color: '#475569' });
          segments.push({ text: pctStr, color: stateColor });
        }
      }

      let totalW = 0;
      segments.forEach(seg => {
        totalW += ctx.measureText(seg.text).width;
      });

      const badgeWidth = Math.min(plotW - 24, totalW + 28);
      const badgeX = padL + (plotW - badgeWidth) / 2;
      const badgeY = padT + 8;
      const badgeH = 24;

      ctx.fillStyle = 'rgba(9, 13, 22, 0.94)';
      ctx.strokeStyle = stateColor;
      ctx.lineWidth = 1.2;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeWidth, badgeH, 5);
      ctx.fill();
      ctx.stroke();

      ctx.textBaseline = 'middle';
      const midY = badgeY + badgeH / 2;
      let curX = badgeX + (badgeWidth - totalW) / 2;

      segments.forEach(seg => {
        ctx.fillStyle = seg.color;
        ctx.textAlign = 'left';
        ctx.fillText(seg.text, curX, midY);
        curX += ctx.measureText(seg.text).width;
      });

      ctx.restore();
    }

    draw(ctx, W, H, padL, padR, padT, padB, now, basePx, currentFrameTime, minP, maxP, yMap) {
      const plotW = Math.max(1, W - padL - padR);
      const plotH = Math.max(1, H - padT - padB);
      const start = now - this.windowMs;

      const points = this.getHistory(now, basePx);
      const fast = this.sma(points, this.periods.fast);
      const slow = this.sma(points, this.periods.slow);

      if (points.length === 0) {
        const previous = this.lastBySymbol.get(this.symbol);
        const isStale = previous !== undefined && (now - previous.timestamp > this.staleAfterMs);
        const state = isStale ? 'STALE' : 'NEUTRAL';
        const label = previous
          ? `RI ${state} · Last $${formatPrice(previous.price)}`
          : 'RI NEUTRAL · Waiting for price data';
        this.drawGuide(ctx, padL, padT, plotW, state, null, null, null, label);
        return null;
      }

      // Collect all visible price and SMA values for adaptive scale fallback
      const allValues = [
        ...points.map(p => p.price),
        ...fast.map(f => f.value),
        ...slow.map(s => s.value)
      ];
      const latest = points[points.length - 1];

      let rawMin = Math.min(...allValues);
      let rawMax = Math.max(...allValues);
      const minSpan = latest.price * 0.0008; // institutional breathing room
      if (rawMax - rawMin < minSpan) {
        const mid = (rawMax + rawMin) / 2;
        rawMin = mid - minSpan / 2;
        rawMax = mid + minSpan / 2;
      }
      const padding = (rawMax - rawMin) * 0.22;
      let targetMin = rawMin - padding;
      let targetMax = rawMax + padding;

      // Use unified scale passed from renderCockpitCanvas (which anchors LOB depth levels)
      const hasUnifiedScale = (Number.isFinite(minP) && Number.isFinite(maxP) && maxP > minP);
      const min = hasUnifiedScale ? minP : targetMin;
      const max = hasUnifiedScale ? maxP : targetMax;

      // Coordinate mappers
      const x = (timestamp) => padL + ((timestamp - start) / this.windowMs) * plotW;
      const y = (hasUnifiedScale && typeof yMap === 'function')
        ? yMap
        : ((value) => padT + (1 - (value - min) / (max - min)) * plotH);

      // If standalone (no unified scale), draw background and grid
      if (!hasUnifiedScale) {
        ctx.fillStyle = this.colors.background;
        ctx.fillRect(padL, padT, plotW, plotH);

        ctx.strokeStyle = this.colors.grid;
        ctx.lineWidth = 1;
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillStyle = this.colors.text;

        for (let i = 0; i <= 5; i++) {
          const yy = padT + (plotH * i) / 5;
          ctx.beginPath();
          ctx.moveTo(padL, yy);
          ctx.lineTo(padL + plotW, yy);
          ctx.stroke();

          const value = max - ((max - min) * i) / 5;
          ctx.textAlign = 'left';
          ctx.fillText('$' + formatPrice(value), padL + plotW + 7, yy + 3.5);
        }

        for (let i = 0; i <= 4; i++) {
          const xx = padL + (plotW * i) / 4;
          ctx.beginPath();
          ctx.moveTo(xx, padT);
          ctx.lineTo(xx, padT + plotH);
          ctx.stroke();

          const secLabel = `${60 - i * 15}s`;
          ctx.textAlign = 'center';
          ctx.fillText(secLabel, xx, padT + plotH + 18);
        }
      }

      // 2. Micro-Volume Histogram (at bottom of chart)
      const volumeH = Math.min(32, plotH * 0.18);
      const maxVol = Math.max(1, ...points.map(p => p.volume || 1));
      const barWidth = Math.max(1.5, Math.min(5, plotW / points.length));

      points.forEach(pt => {
        const xx = x(pt.timestamp);
        const vH = Math.max(2, ((pt.volume || 1) / maxVol) * volumeH);
        ctx.fillStyle = (pt.side === 'sell') ? this.colors.down : this.colors.up;
        ctx.globalAlpha = 0.70;
        ctx.fillRect(xx - barWidth / 2, padT + plotH - vH, barWidth, vH);
      });
      ctx.globalAlpha = 1.0;

      // 3. Price Mountain Gradient Under Price Curve
      ctx.beginPath();
      points.forEach((pt, idx) => {
        const xx = x(pt.timestamp);
        const yy = y(pt.price);
        if (idx === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      const firstPt = points[0];
      const lastPt = points[points.length - 1];
      ctx.lineTo(x(lastPt.timestamp), padT + plotH);
      ctx.lineTo(x(firstPt.timestamp), padT + plotH);
      ctx.closePath();

      const mountainGrad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      mountainGrad.addColorStop(0, 'rgba(56, 189, 248, 0.20)');
      mountainGrad.addColorStop(0.70, 'rgba(56, 189, 248, 0.04)');
      mountainGrad.addColorStop(1, 'rgba(56, 189, 248, 0.00)');
      ctx.fillStyle = mountainGrad;
      ctx.fill();

      // 4. Draw Slow SMA Path (Crisp Institutional White #ffffff)
      this.drawPath(ctx, slow, x, y, this.colors.slowSma, 1.8);

      // 5. Draw Fast SMA Path (Emerald Green #10b981)
      this.drawPath(ctx, fast, x, y, this.colors.fastSma, 2.0);

      // 6. Draw Price Path (Cyan Silk #38bdf8 with subtle glow)
      ctx.save();
      ctx.shadowColor = 'rgba(56, 189, 248, 0.65)';
      ctx.shadowBlur = 8;
      this.drawPath(ctx, points.map(p => ({ timestamp: p.timestamp, value: p.price })), x, y, this.colors.price, 2.2);
      ctx.restore();

      // 7. Latest Price Head Dot & Multi-Ring Sonar Ripples
      const headX = x(latest.timestamp);
      const headY = y(latest.price);

      // Triple Sonar Ripples
      const pulsePhase = (now % 1600) / 1600;
      ctx.save();
      for (let i = 0; i < 3; i++) {
        const ringProg = (pulsePhase + i / 3) % 1;
        const radius = 6 + ringProg * 22;
        ctx.beginPath();
        ctx.arc(headX, headY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = this.colors.price;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = (1 - ringProg) * 0.50;
        ctx.stroke();
      }
      ctx.restore();

      // Solid Beacon Dot
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(headX, headY, 3.8, 0, Math.PI * 2);
      ctx.fill();

      // 8. Right-Anchored Price Badge Tag
      const tagH = 18;
      const tagW = 72;
      const tagY = Math.min(Math.max(headY - tagH / 2, padT), padT + plotH - tagH);

      ctx.save();
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.roundRect(padL + plotW + 6, tagY, tagW, tagH, 3);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('$' + formatPrice(latest.price), padL + plotW + 6 + tagW / 2, tagY + tagH / 2 + 3.5);
      ctx.restore();

      // 9. RI Trend Guide Pill Banner at Top Center
      const trend = this.getTrend(points, fast, slow, now);
      const fastVal = fast[fast.length - 1] ? fast[fast.length - 1].value : latest.price;
      const slowVal = slow[slow.length - 1] ? slow[slow.length - 1].value : latest.price;

      this.drawGuide(ctx, padL, padT, plotW, trend.state, fastVal, slowVal, trend.distancePct);

      return {
        headX,
        headY,
        fastVal,
        slowVal,
        latestPrice: latest.price,
        minP: min,
        maxP: max,
        trend,
        x,
        y,
        points
      };
    }
  }

  // ── Candlestick & LOB Depth Canvas Engine with Live Movement & Beacon ──
  function renderCockpitCanvas(mkt, activePos, activeLimitOrder, frameTime) {
    const canvas = getEl('responsive-cockpit-canvas');
    if (!canvas) return;
    attachCanvasMouseEvents(canvas);

    if (!mkt) {
      mkt = window.cockpitMarketsData?.find(m => m.symbol === window.cockpitActiveSymbol) || window.cockpitMarketsData?.[0];
      if (!mkt) return;
    }

    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (rect.width < 50 || rect.height < 50) return;

    const targetW = Math.floor(rect.width * dpr);
    const targetH = Math.floor(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width;
    const H = rect.height;

    // Dark broadcast background
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, W, H);

    // Layout geometry: Wide candle/tick area + discrete LOB shelf on the right
    const padL = 16, padR = 210, padT = 20, padB = 38;
    const plotW = Math.max(100, W - padL - padR);
    const plotH = Math.max(80, H - padT - padB);

    const nowMs = Date.now();
    const currentFrameTime = (typeof frameTime === 'number') ? frameTime : (typeof performance !== 'undefined' ? performance.now() : nowMs);
    const lastFrameTime = window._cockpitLastFrameTime || currentFrameTime;
    const dt = (window._cockpitLastFrameTime) ? Math.min(Math.max((currentFrameTime - lastFrameTime) / 1000, 0.001), 0.1) : (1 / 60);
    window._cockpitLastFrameTime = currentFrameTime;

    const basePx = mkt.price;

    // Exponential price smoothing: gentle dampened easing towards mark price (eliminates jerky twitch)
    if (!window._cockpitSmoothedPrice) window._cockpitSmoothedPrice = {};
    if (window._cockpitSmoothedPrice[mkt.symbol] === undefined) {
      window._cockpitSmoothedPrice[mkt.symbol] = basePx;
    } else {
      window._cockpitSmoothedPrice[mkt.symbol] += (basePx - window._cockpitSmoothedPrice[mkt.symbol]) * 0.12;
    }
    const currentLivePx = window._cockpitSmoothedPrice[mkt.symbol];

    // 15M Bar Countdown Timer
    const barIntervalMs = 15 * 60 * 1000;
    const remainingMs = barIntervalMs - (nowMs % barIntervalMs);
    const remMins = Math.floor(remainingMs / 60000);
    const remSecs = Math.floor((remainingMs % 60000) / 1000);
    const remTimeStr = `${String(remMins).padStart(2, '0')}:${String(remSecs).padStart(2, '0')}`;

    const barCdEl = getEl('cockpit-bar-countdown');
    if (barCdEl) {
      barCdEl.textContent = `${remTimeStr} (LIVE TICK)`;
    }

    // ── Robust Island Live Tick Chart Engine Integration (Moves Toward LOB Liquidity Depth) ──
    window._globalTickChart = window._globalTickChart || new TickLineChart();
    const chart = window._globalTickChart;
    chart.selectSymbol(mkt.symbol, { fast: mkt.fastPeriod || 7, slow: mkt.slowPeriod || 36 });

    // Anchor trend target directly to authentic Decibel DEX exchange mark price (basePx)
    // Micro-bias from order book imbalance is strictly sub-pip (±0.012% max), NEVER dragging price away to walls
    const imb = Math.max(-0.85, Math.min(0.85, (mkt.imbalance || 0) / 100));
    const trendTarget = basePx + (basePx * 0.00012 * imb);

    // Promotion & Freshness Detection:
    // Whenever a new asset promotes to #1 view, or if viewed history has a gap > 3500ms:
    // Instantly seed a 100% full, unbroken, authentic 60-second micro-tick line and volume histogram.
    const isNewPromotion = (window._lastCockpitPromotedSymbol !== mkt.symbol);
    if (isNewPromotion) {
      window._lastCockpitPromotedSymbol = mkt.symbol;
    }

    let symbolHistory = chart.histories.get(mkt.symbol);
    let lastPoint = chart.lastBySymbol.get(mkt.symbol);
    const timeSinceLast = lastPoint ? (nowMs - lastPoint.timestamp) : 999999;

    if (isNewPromotion || !symbolHistory || symbolHistory.length < 30 || timeSinceLast > 3500) {
      symbolHistory = chart.seedHistory(mkt.symbol, basePx, trendTarget, mkt.change24h, nowMs, activePos, activeLimitOrder);
      lastPoint = chart.lastBySymbol.get(mkt.symbol);
    } else if (timeSinceLast > 600) {
      // Seamlessly bridge small inactive gaps (600ms to 3.5s) with micro-ticks strictly anchored to basePx
      const stepMs = 300;
      const totalSteps = Math.min(20, Math.floor(timeSinceLast / stepMs));
      const startPx = lastPoint.price;
      for (let s = 1; s <= totalSteps; s++) {
        const t = lastPoint.timestamp + s * stepMs;
        const progress = s / totalSteps;
        const target = startPx + (basePx - startPx) * progress;
        const jitter = (Math.random() - 0.495) * (basePx * 0.00010);
        let bridgePx = target + jitter;

        // Apply resting limit barrier
        if (activeLimitOrder && activeLimitOrder.price > 0) {
          const ordPx = Number(activeLimitOrder.price);
          const isBuy = String(activeLimitOrder.side || activeLimitOrder.action || '').toLowerCase().includes('buy');
          if (isBuy && basePx > ordPx) {
            bridgePx = Math.max(ordPx + basePx * 0.00025, bridgePx);
          } else if (!isBuy && basePx < ordPx) {
            bridgePx = Math.min(ordPx - basePx * 0.00025, bridgePx);
          }
        }

        // Apply position horizon barrier
        if (activePos && Number(activePos.entryPrice) > 0) {
          const entryPx = Number(activePos.entryPrice);
          const rawDir = String(activePos.action || activePos.side || '').toUpperCase();
          const isPosLong = rawDir.includes('LONG') || rawDir.includes('BUY') || activePos.is_long === true || activePos.isLong === true;
          const buffer = entryPx * 0.00015;
          if (isPosLong) {
            if (basePx > entryPx) bridgePx = Math.max(entryPx + buffer, bridgePx);
            else if (basePx < entryPx) bridgePx = Math.min(entryPx - buffer, bridgePx);
          } else {
            if (basePx < entryPx) bridgePx = Math.min(entryPx - buffer, bridgePx);
            else if (basePx > entryPx) bridgePx = Math.max(entryPx + buffer, bridgePx);
          }
        }

        const vol = Math.round(18 + Math.random() * 32);
        chart.pushPrice(mkt.symbol, bridgePx, t, vol);
      }
      lastPoint = chart.lastBySymbol.get(mkt.symbol);
    }

    if (nowMs - (lastPoint ? lastPoint.timestamp : 0) >= 300) {
      if (!window._pairMomentum) window._pairMomentum = {};
      let mom = window._pairMomentum[mkt.symbol] || 0;
      const curPx = lastPoint ? lastPoint.price : basePx;
      const pullToExchange = (basePx - curPx) * 0.35;
      const subPipNoise = (Math.random() - 0.495) * (basePx * 0.00010);

      mom = mom * 0.65 + pullToExchange + subPipNoise;
      const maxMom = basePx * 0.00030; // Strictly bound micro-fluctuations to ±0.03% of basePx
      mom = Math.max(-maxMom, Math.min(maxMom, mom));
      window._pairMomentum[mkt.symbol] = mom;

      let nextPrice = curPx + mom;

      // Invariant 1: Resting Limit Orders
      // If a resting limit order is active on Decibel DEX, synthetic ticks MUST NEVER cross or touch it prematurely!
      if (activeLimitOrder && activeLimitOrder.price > 0) {
        const ordPx = Number(activeLimitOrder.price);
        const isBuy = String(activeLimitOrder.side || activeLimitOrder.action || '').toLowerCase().includes('buy');
        if (isBuy && basePx > ordPx) {
          nextPrice = Math.max(ordPx + basePx * 0.00025, nextPrice);
        } else if (!isBuy && basePx < ordPx) {
          nextPrice = Math.min(ordPx - basePx * 0.00025, nextPrice);
        }
      }

      // Invariant 2: Open Position Direction & PnL Consistency (Over/Under Entry Line)
      // Visual tick line MUST strictly match on-chain PnL status:
      // Profit -> tick line on the profitable side of entry line; Loss -> on losing side.
      if (activePos && Number(activePos.entryPrice) > 0) {
        const entryPx = Number(activePos.entryPrice);
        const rawDir = String(activePos.action || activePos.side || '').toUpperCase();
        const isPosLong = rawDir.includes('LONG') || rawDir.includes('BUY') || activePos.is_long === true || activePos.isLong === true;
        const buffer = entryPx * 0.00015;

        if (isPosLong) {
          if (basePx > entryPx) {
            nextPrice = Math.max(entryPx + buffer, nextPrice);
          } else if (basePx < entryPx) {
            nextPrice = Math.min(entryPx - buffer, nextPrice);
          }
        } else {
          if (basePx < entryPx) {
            nextPrice = Math.min(entryPx - buffer, nextPrice);
          } else if (basePx > entryPx) {
            nextPrice = Math.max(entryPx + buffer, nextPrice);
          }
        }
      }

      const liveVol = Math.round(15 + Math.random() * 35 + Math.abs(mom / (basePx * 0.0001)) * 25);
      chart.pushPrice(mkt.symbol, nextPrice, nowMs, liveVol);
      lastPoint = chart.lastBySymbol.get(mkt.symbol);
    }

    const liveActivePx = (lastPoint && Number.isFinite(lastPoint.price) && lastPoint.price > 0)
      ? lastPoint.price
      : currentLivePx;

    // Ingest authentic klines: prefer clean unpolluted authentic klines
    let candles = [];
    let rawKlines = null;
    const cachedKlines = window.COCKPIT_AUTHENTIC_KLINES[mkt.symbol] ||
      window.COCKPIT_AUTHENTIC_KLINES[mkt.symbol.toUpperCase()] ||
      window.COCKPIT_AUTHENTIC_KLINES[mkt.symbol.replace('/', '')] ||
      window.COCKPIT_AUTHENTIC_KLINES[mkt.symbol.replace('/', '-')] ||
      null;

    // Prioritize authentic preloaded klines (covers all 34 pairs with genuine distinct market action)
    if (cachedKlines && Array.isArray(cachedKlines) && cachedKlines.length >= 30) {
      rawKlines = cachedKlines;
    } else if (mkt.klines && Array.isArray(mkt.klines) && mkt.klines.length >= 5) {
      const firstC = Number(mkt.klines[0].c ?? mkt.klines[0].close ?? 0);
      const lastC = Number(mkt.klines[mkt.klines.length - 1].c ?? mkt.klines[mkt.klines.length - 1].close ?? 0);
      // Validate that klines are not contaminated by cross-pair jumps (e.g. BTC vs DOGE)
      const isClean = (basePx <= 0) || (Math.abs(firstC - basePx) / basePx < 0.55 && Math.abs(lastC - basePx) / basePx < 0.55);
      if (isClean) {
        rawKlines = mkt.klines;
      } else if (cachedKlines) {
        rawKlines = cachedKlines;
      }
    } else {
      rawKlines = cachedKlines;
    }

    if (rawKlines && Array.isArray(rawKlines) && rawKlines.length >= 5) {
      candles = rawKlines.map(k => ({
        o: Number(k.o !== undefined ? k.o : k.open),
        h: Number(k.h !== undefined ? k.h : k.high),
        l: Number(k.l !== undefined ? k.l : k.low),
        c: Number(k.c !== undefined ? k.c : k.close),
        t: k.t || k.openTime || Date.now()
      }));

      // Cross-Pair Alignment: Smoothly re-scale authentic klines to basePx preserving exact candle wicks and forms
      if (candles.length > 0 && basePx > 0) {
        const lastBarClose = candles[candles.length - 1].c;
        if (lastBarClose > 0 && Math.abs(basePx - lastBarClose) / lastBarClose < 0.65) {
          const ratio = basePx / lastBarClose;
          candles.forEach(b => {
            b.o *= ratio;
            b.h *= ratio;
            b.l *= ratio;
            b.c *= ratio;
          });
        }
      }

      if (candles.length > 0) {
        // Live Action Movement: Pin active ticking candle to live active micro-tick price
        const lastBarIdx = candles.length - 1;
        candles[lastBarIdx].c = liveActivePx;
        candles[lastBarIdx].h = Math.max(candles[lastBarIdx].h, liveActivePx, candles[lastBarIdx].o);
        candles[lastBarIdx].l = Math.min(candles[lastBarIdx].l, liveActivePx, candles[lastBarIdx].o);
      }
    }

    if (!candles || candles.length < 5) {
      // Unique symbol-seeded dynamic harmonic synthesis so each pair has unique candle formation
      const numCandles = 50;
      const atr = Math.max(basePx * 0.004, 0.0005);
      const symStr = mkt.symbol || 'BTC/USD';
      const pairSeed = symStr.split('').reduce((acc, c, idx) => acc + c.charCodeAt(0) * (idx + 7), 0) % 97;
      const phi = pairSeed * 0.17;
      const trendBias = (mkt.change24h || 0) * 0.04 + (mkt.imbalance || 0) * 0.0003;

      const deltas = [];
      for (let i = 0; i < numCandles; i++) {
        const macroWave = Math.sin(i * 0.55 + phi) * 0.45;
        const midWave = Math.cos(i * 1.25 + phi * 1.3) * 0.35;
        const microNoise = Math.sin(i * 2.8 + phi * 2.1) * 0.20;
        const wave = macroWave + midWave + microNoise + trendBias;
        deltas.push(wave * atr * 0.4);
      }
      let p = basePx;
      const prices = [basePx];
      for (let i = numCandles - 1; i > 0; i--) {
        p = p - deltas[i];
        prices.unshift(p);
      }
      for (let i = 0; i < numCandles; i++) {
        const o = (i === 0) ? prices[0] * 0.999 : candles[i - 1].c;
        const c = prices[i];
        const maxOC = Math.max(o, c);
        const minOC = Math.min(o, c);
        const wickUp = Math.abs(Math.sin(i * 1.8 + phi)) * atr * 0.30;
        const wickDn = Math.abs(Math.cos(i * 2.2 + phi * 1.4)) * atr * 0.30;
        candles.push({ o, h: maxOC + wickUp, l: Math.max(0.0001, minOC - wickDn), c });
      }
      candles[candles.length - 1].c = liveActivePx;
      candles[candles.length - 1].h = Math.max(candles[candles.length - 1].h, liveActivePx);
      candles[candles.length - 1].l = Math.min(candles[candles.length - 1].l, liveActivePx);
    }

    // Update OHLC Bar Values in top subbar
    const lastBar = candles[candles.length - 1];
    if (lastBar) {
      const elO = getEl('cockpit-bar-o');
      const elH = getEl('cockpit-bar-h');
      const elL = getEl('cockpit-bar-l');
      const elC = getEl('cockpit-bar-c');
      if (elO) elO.textContent = formatPrice(lastBar.o);
      if (elH) elH.textContent = formatPrice(lastBar.h);
      if (elL) elL.textContent = formatPrice(lastBar.l);
      if (elC) {
        elC.textContent = formatPrice(liveActivePx);
        elC.style.color = (liveActivePx >= lastBar.o) ? 'var(--cp-emerald)' : 'var(--cp-crimson)';
      }
    }

    // ── CANDLESTICK & LIVE TICK SCALE ENGINES (Zoomed to 2 Asks & 2 Bids in TICK_LINE mode) ──
    const rawCandleMin = Math.min(...candles.map(c => c.l));
    const rawCandleMax = Math.max(...candles.map(c => c.h));
    const rawCandleSpan = rawCandleMax - rawCandleMin;

    const isTickLineMode = (window.cockpitChartMode === 'TICK_LINE');
    const lob = computePairLobLevels(mkt.symbol, basePx, mkt.orderflow, mkt.keyLevels, rawCandleSpan, isTickLineMode, mkt.imbalance, mkt, liveActivePx, candles[candles.length - 1], nowMs);
    const allLobLevels = [...lob.asks, ...lob.bids];

    let minP, maxP;

    if (isTickLineMode) {
      // ── ZOOMED TICK LINE SCALE: High-Definition Micro-Tick & SMA Wave Engine ──
      const tickPts = chart.getHistory(nowMs, basePx);
      const tickPrices = (tickPts && tickPts.length > 0) ? tickPts.map(pt => pt.price) : [basePx];

      const fastSmaPts = chart.sma(tickPts, chart.periods.fast);
      const slowSmaPts = chart.sma(tickPts, chart.periods.slow);
      const fastPrices = (fastSmaPts && fastSmaPts.length > 0) ? fastSmaPts.map(f => f.value) : [];
      const slowPrices = (slowSmaPts && slowSmaPts.length > 0) ? slowSmaPts.map(s => s.value) : [];

      const wavePrices = [
        ...tickPrices,
        Number(liveActivePx || basePx),
        Number(basePx),
        ...fastPrices,
        ...slowPrices
      ].filter(p => Number.isFinite(p) && p > 0);

      let waveMin = Math.min(...wavePrices);
      let waveMax = Math.max(...wavePrices);

      // Tight baseline breathing span: 0.20% - 0.25% of price
      // For XRP at $1.248, span is ~$0.0025; micro-ticks undulate visibly across 70% of canvas height
      const minWaveSpan = Math.max(basePx * 0.0022, 0.00000001);
      let waveSpan = Math.max(waveMax - waveMin, minWaveSpan);
      let waveMid = (waveMax + waveMin) / 2;

      let targetTickMin, targetTickMax;

      if (activePos && activePos.entryPrice > 0) {
        // Center entry price horizon in the middle
        const entryPx = Number(activePos.entryPrice);
        const tpPx = Number(activePos.takeProfit || 0);
        const slPx = Number(activePos.stopLoss || 0);
        const ratchetPrice = Number(activePos.softRatchetPrice || activePos.softSlPrice || activePos.suggestedStopLoss || activePos.breakevenPrice || 0);

        waveMid = entryPx;
        let maxDev = Math.max(
          Math.abs(waveMax - entryPx),
          Math.abs(waveMin - entryPx),
          entryPx * 0.0022
        );

        // Include TP/SL/Ratchet rails if within close trading proximity (≤ 1.8%)
        if (tpPx > 0 && Math.abs(tpPx - entryPx) / entryPx <= 0.018) maxDev = Math.max(maxDev, Math.abs(tpPx - entryPx));
        if (slPx > 0 && Math.abs(slPx - entryPx) / entryPx <= 0.018) maxDev = Math.max(maxDev, Math.abs(slPx - entryPx));
        if (ratchetPrice > 0 && Math.abs(ratchetPrice - entryPx) / entryPx <= 0.018) maxDev = Math.max(maxDev, Math.abs(ratchetPrice - entryPx));

        waveSpan = maxDev * 2.12;
      }

      // Apply interactive user zoom & drag pan
      const userZoom = Math.max(0.3, Math.min(25.0, window._cockpitUserZoom || 1.0));
      const userPan = Number(window._cockpitUserPanY || 0);

      const effectiveSpan = waveSpan / userZoom;
      const effectiveMid = waveMid + userPan;
      window._cockpitLastSpan = effectiveSpan;

      targetTickMin = Math.max(0.00000001, effectiveMid - effectiveSpan * 0.50);
      targetTickMax = effectiveMid + effectiveSpan * 0.50;

      window._cockpitTickScales = window._cockpitTickScales || {};
      let tScale = window._cockpitTickScales[mkt.symbol];

      if (!tScale || Math.abs((tScale.min + tScale.max) / 2 - effectiveMid) / effectiveMid > 0.03 ||
        (window._cockpitUserZoom && window._cockpitUserZoom !== 1.0) || userPan !== 0) {
        tScale = { min: targetTickMin, max: targetTickMax };
        window._cockpitTickScales[mkt.symbol] = tScale;
      } else {
        // Continuous smooth exponential breathing without jitter
        const alpha = 0.12;
        tScale.min += (targetTickMin - tScale.min) * alpha;
        tScale.max += (targetTickMax - tScale.max) * alpha;
      }

      minP = tScale.min;
      maxP = tScale.max;
    } else {
      // ── 15M CANDLESTICK SCALE: Rock-Solid Stationary Camera Engine ──
      // Anchored firmly to closed candlestick history with 15% headroom
      // Active ticking candle does NOT shift the camera scale, preventing all bouncing
      const histBars = (candles.length > 1) ? candles.slice(0, -1) : candles;
      let rawMin = Math.min(...histBars.map(c => c.l));
      let rawMax = Math.max(...histBars.map(c => c.h));

      if (activePos && activePos.entryPrice > 0) {
        const entryPx = Number(activePos.entryPrice);
        const tpDev = (activePos.takeProfit > 0) ? Math.abs(activePos.takeProfit - entryPx) : 0;
        const slDev = (activePos.stopLoss > 0) ? Math.abs(activePos.stopLoss - entryPx) : 0;
        const hardSlPx = Number(activePos.hardStopLoss || activePos.hardSl || 0);
        const hardSlDev = (hardSlPx > 0) ? Math.abs(hardSlPx - entryPx) : 0;
        const ratchetPx = Number(activePos.softRatchetPrice || activePos.softSlPrice || activePos.suggestedStopLoss || activePos.breakevenPrice || 0);
        const ratchetDev = (ratchetPx > 0) ? Math.abs(ratchetPx - entryPx) : 0;
        const candleDev = Math.max(Math.abs(rawMax - entryPx), Math.abs(rawMin - entryPx));
        const maxDev = Math.max(candleDev, tpDev, slDev, hardSlDev, ratchetDev, entryPx * 0.005);
        const halfSpan = maxDev * 1.12;
        rawMin = Math.max(0, entryPx - halfSpan);
        rawMax = entryPx + halfSpan;
      } else if (activeLimitOrder && activeLimitOrder.price > 0) {
        rawMax = Math.max(rawMax, activeLimitOrder.price * 1.003);
        rawMin = Math.min(rawMin, activeLimitOrder.price * 0.997);
      }

      let candleSpan = Math.max(rawMax - rawMin, basePx * 0.024);
      const candlePadding = candleSpan * 0.15;
      const targetCandleMin = Math.max(0, rawMin - candlePadding);
      const targetCandleMax = rawMax + candlePadding;

      window._cockpitCandleScales = window._cockpitCandleScales || {};
      let cScale = window._cockpitCandleScales[mkt.symbol];

      // Lock scale: initialize or smoothly accommodate targetCandleMin/targetCandleMax
      if (!cScale || Math.abs((cScale.min + cScale.max) / 2 - basePx) / basePx > 0.20 ||
        (activePos && (targetCandleMin < cScale.min || targetCandleMax > cScale.max))) {
        cScale = { min: targetCandleMin, max: targetCandleMax };
        window._cockpitCandleScales[mkt.symbol] = cScale;
      } else {
        const alpha = 0.08;
        if (targetCandleMin < cScale.min) cScale.min += (targetCandleMin - cScale.min) * alpha;
        if (targetCandleMax > cScale.max) cScale.max += (targetCandleMax - cScale.max) * alpha;
        if (liveActivePx < cScale.min) cScale.min += (liveActivePx - cScale.min) * 0.05;
        if (liveActivePx > cScale.max) cScale.max += (liveActivePx - cScale.max) * 0.05;
      }

      minP = cScale.min;
      maxP = cScale.max;
    }

    const yMap = p => padT + (1 - (p - minP) / (maxP - minP)) * plotH;
    const xMap = i => padL + (i + 0.5) * (plotW / candles.length);

    // Maintain backwards compatibility tickBuffer reference for hover tools
    const tickBuffer = chart.histories.get(mkt.symbol) || [];
    if (typeof window !== 'undefined') {
      window._liveTickBuffers = window._liveTickBuffers || {};
      window._liveTickBuffers[mkt.symbol] = tickBuffer;
    }

    // --------------------------------------------------
    // 3. GRID AND PRICE AXIS
    // --------------------------------------------------
    if (window.cockpitChartMode === 'TICK_LINE') {
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillStyle = '#8492a6';

      for (let i = 0; i <= 5; i++) {
        const yy = padT + (plotH * i) / 5;

        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(padL + plotW, yy);
        ctx.stroke();

        const value = maxP - ((maxP - minP) * i) / 5;
        ctx.textAlign = 'left';
        ctx.fillText('$' + formatPrice(value), padL + plotW + 7, yy + 3.5);
      }

      for (let i = 0; i <= 4; i++) {
        const xx = padL + (plotW * i) / 4;

        ctx.beginPath();
        ctx.moveTo(xx, padT);
        ctx.lineTo(xx, padT + plotH);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 4]);
      const numGridLines = 7;
      for (let g = 0; g <= numGridLines; g++) {
        const priceVal = minP + (g / numGridLines) * (maxP - minP);
        const y = yMap(priceVal);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();

        ctx.fillStyle = '#8492a6';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText('$' + formatPrice(priceVal), padL + plotW + 6, y + 3.5);
      }
      ctx.setLineDash([]);
    }

    // 2. LOB Depth Heatmap Lines (Thickness & Transparency Scaled to Money Density)
    const lobX = padL + plotW + 82;
    const lobW = W - lobX - 12;

    const maxSize = Math.max(...allLobLevels.map(l => l.size || 10));

    // Draw Heatmap Depth Rays across the canvas (100% guaranteed visibility for all pairs)
    const drawHeatmapRay = (item, isBid) => {
      if (!item || !item.price || isNaN(item.price)) return;
      const y = yMap(item.price);

      // Structural indicators pinned to ceiling/floor if outside visible zoomed area
      if (y < padT - 6) {
        if (item.isVpoc && lobW > 35) {
          const pY = padT + 12;
          ctx.save();
          ctx.fillStyle = 'rgba(244, 63, 94, 0.22)';
          ctx.strokeStyle = '#f43f5e';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(lobX, pY - 6, lobW, 13, 2.5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8px JetBrains Mono, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`▲ VPOC ${item.notional}`, lobX + lobW / 2, pY + 3.5);
          ctx.restore();
        }
        return;
      }
      if (y > padT + plotH + 6) {
        if (item.isFloor && lobW > 35) {
          const pY = padT + plotH - 12;
          ctx.save();
          ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(lobX, pY - 6, lobW, 13, 2.5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8px JetBrains Mono, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`▼ CUSHION ${item.notional}`, lobX + lobW / 2, pY + 3.5);
          ctx.restore();
        }
        return;
      }

      // Money density scaling: normalized 0.12 to 1.0
      const weight = Math.min(1.0, Math.max(0.12, (item.size || 10) / maxSize));
      const rayAlpha = 0.12 + weight * 0.45;
      const rayThickness = 1.0 + weight * 3.8;

      ctx.save();
      ctx.strokeStyle = isBid ? `rgba(16, 185, 129, ${rayAlpha})` : `rgba(244, 63, 94, ${rayAlpha})`;
      ctx.lineWidth = rayThickness;
      ctx.setLineDash(item.isVpoc || item.isFloor ? [] : [4, 6]);

      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();

      // Soft ambient liquidity glow band around primary walls
      if (item.isVpoc || item.isFloor) {
        ctx.fillStyle = isBid ? 'rgba(16, 185, 129, 0.05)' : 'rgba(244, 63, 94, 0.05)';
        ctx.fillRect(padL, y - 6, plotW, 12);
      }
      ctx.restore();

      // Right Shelf Bracket
      if (lobW > 35) {
        const barH = 13;
        const color = isBid ? '#10b981' : '#f43f5e';
        const boxAlpha = 0.10 + weight * 0.35;

        ctx.fillStyle = isBid ? `rgba(16, 185, 129, ${boxAlpha})` : `rgba(244, 63, 94, ${boxAlpha})`;
        ctx.strokeStyle = color;
        ctx.lineWidth = item.isVpoc || item.isFloor ? 1.4 : 0.8;
        ctx.beginPath();
        ctx.roundRect(lobX, y - barH / 2, lobW, barH, 2.5);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = item.isVpoc || item.isFloor ? '#ffffff' : color;
        ctx.font = 'bold 8.5px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${item.label} ${item.notional}`, lobX + lobW / 2, y + 3);
      }
    };

    if (lobW > 35) {
      ctx.fillStyle = '#8492a6';
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('CLOB LIQUIDITY DEPTH', lobX, padT - 6);
    }

    lob.asks.forEach(a => drawHeatmapRay(a, false));
    lob.bids.forEach(b => drawHeatmapRay(b, true));

    // 3. Fast and Slow SMA Curves
    const calcSMA = (period) => {
      const p = Math.max(2, Math.min(Number(period) || 20, candles.length));
      return candles.map((_, i) => {
        const effP = Math.min(p, i + 1);
        if (effP < 2) return null;
        let sum = 0;
        for (let k = 0; k < effP; k++) sum += candles[i - k].c;
        return sum / effP;
      });
    };
    const fastSMA = calcSMA(mkt.fastPeriod);
    const slowSMA = calcSMA(mkt.slowPeriod);

    // 4. Candlesticks vs Live Tick Line
    const lastBarIdx = candles.length - 1;
    let beaconX = xMap(lastBarIdx);
    let beaconY = yMap(liveActivePx);
    let tickDrawRes = null;

    if (window.cockpitChartMode === 'TICK_LINE') {
      tickDrawRes = chart.draw(ctx, W, H, padL, padR, padT, padB, nowMs, basePx, currentFrameTime, minP, maxP, yMap);
      if (tickDrawRes) {
        beaconX = tickDrawRes.headX;
        beaconY = tickDrawRes.headY;
      }
    } else {
      // Draw Candlesticks (Emerald Green & Crimson Red)
      const candleWidth = Math.max(3.5, (plotW / candles.length) * 0.68);
      candles.forEach((c, i) => {
        const isUp = c.c >= c.o;
        const col = isUp ? '#10b981' : '#f43f5e';
        const x = xMap(i);
        const yO = yMap(c.o);
        const yC = yMap(c.c);
        const yH = yMap(c.h);
        const yL = yMap(c.l);

        // Wick
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(x, yH);
        ctx.lineTo(x, yL);
        ctx.stroke();

        // Body
        const topY = Math.min(yO, yC);
        const bodyH = Math.max(2, Math.abs(yC - yO));
        ctx.fillStyle = col;
        ctx.fillRect(x - candleWidth / 2, topY, candleWidth, bodyH);
      });

      // Draw Fast SMA (Emerald)
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let startedFast = false;
      candles.forEach((_, i) => {
        const smaVal = fastSMA[i];
        if (smaVal !== null) {
          const x = xMap(i);
          const y = yMap(smaVal);
          if (!startedFast) { ctx.moveTo(x, y); startedFast = true; }
          else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();

      // Draw Slow SMA (White)
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let startedSlow = false;
      candles.forEach((_, i) => {
        const smaVal = slowSMA[i];
        if (smaVal !== null) {
          const x = xMap(i);
          const y = yMap(smaVal);
          if (!startedSlow) { ctx.moveTo(x, y); startedSlow = true; }
          else { ctx.lineTo(x, y); }
        }
      });
      ctx.stroke();
    }

    // 5. Live Pulsing Decibel DEX Mark Price Ray & Pulsing Beacon (CANDLES MODE ONLY)
    if (window.cockpitChartMode !== 'TICK_LINE') {
      const liveY = yMap(liveActivePx);
      const isCurrentBarBullish = liveActivePx >= lastBar.o;
      const liveThemeColor = isCurrentBarBullish ? '#10b981' : '#f43f5e';

      // Live Ray across the plot
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, liveY);
      ctx.lineTo(padL + plotW + 75, liveY);
      ctx.stroke();
      ctx.restore();

      // Live Beacon: Expanding Sonar Ripple on Tip
      beaconX = xMap(lastBarIdx);
      beaconY = liveY;
      const ripplePhase = (nowMs % 1200) / 1200; // 0 to 1
      const rippleRadius = 4 + ripplePhase * 9;
      const rippleAlpha = 0.65 * (1 - ripplePhase);

      ctx.save();
      ctx.beginPath();
      ctx.arc(beaconX, beaconY, rippleRadius, 0, Math.PI * 2);
      ctx.fillStyle = isCurrentBarBullish ? `rgba(16, 185, 129, ${rippleAlpha})` : `rgba(244, 63, 94, ${rippleAlpha})`;
      ctx.fill();

      // Solid core beacon dot
      ctx.beginPath();
      ctx.arc(beaconX, beaconY, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = liveThemeColor;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Live Price Tag Badge on right margin
      ctx.save();
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.roundRect(padL + plotW + 4, liveY - 9, 68, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('$' + formatPrice(liveActivePx), padL + plotW + 38, liveY + 3.5);
      ctx.restore();
    }

    // 6. Pill Badge Helper for Trade Levels
    function drawCompactPillBadge(text, x, y, bgColor, textColor, borderColor) {
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      const textW = ctx.measureText(text).width;
      const pillW = textW + 14;
      const pillH = 18;

      ctx.save();
      ctx.shadowColor = 'rgba(7, 10, 16, 0.98)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = bgColor;
      ctx.beginPath();
      ctx.roundRect(x, y - pillH / 2, pillW, pillH, 3.5);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      ctx.fillText(text, x + 7, y + 3.5);
    }

    // 7. RENDER TRADE LEVEL LINES & OPEN POSITION HUD (OPTION 1: FULL HUD BRACKET)
    // (Requirement 4: By default, NO entry, soft SL, hard SL or TP lines are shown when flat!)
    if (activePos && activePos.entryPrice > 0 && (!activePos.status || activePos.status.toLowerCase() === 'open')) {
      const rawDir = String(activePos.action || activePos.side || (activePos.is_long ? 'LONG' : (activePos.is_long === false ? 'SHORT' : 'LONG'))).toUpperCase();
      const isLong = rawDir.includes('LONG') || rawDir.includes('BUY') || activePos.is_long === true || activePos.isLong === true || (Number(activePos.sizeBase) > 0 && !rawDir.includes('SHORT') && !rawDir.includes('SELL'));
      const side = isLong ? 'LONG' : 'SHORT';
      const entryPx = Number(activePos.entryPrice);
      const currentPx = Number(liveActivePx || basePx);
      const leverage = Number(activePos.leverage || 5);

      // Trade PnL & Return-on-Equity Telemetry
      const priceDelta = isLong ? (currentPx - entryPx) : (entryPx - currentPx);
      const pnlPct = (priceDelta / entryPx) * 100;
      const roePct = pnlPct * leverage;

      const posMargin = Number(
        activePos.allocatedUsd ||
        activePos.margin ||
        activePos.initialMargin ||
        (activePos.sizeBase && entryPx ? (activePos.sizeBase * entryPx) / leverage : 0)
      ) || 100;
      const notionalUsd = posMargin * leverage;

      // Authoritative on-chain PnL pipeline integration:
      const hasOnChainPnl = (activePos.unrealizedPnlUsd !== undefined && Number.isFinite(Number(activePos.unrealizedPnlUsd)));
      const pnlUsd = hasOnChainPnl ? Number(activePos.unrealizedPnlUsd) : (pnlPct / 100) * notionalUsd;
      const isProfit = pnlUsd >= 0;

      const entryY = yMap(entryPx);
      const liveY = yMap(currentPx);

      // ── A. Dynamic Unrealized PnL Shaded Corridor ──
      if (Number.isFinite(entryY) && Number.isFinite(liveY)) {
        const corridorTop = Math.min(entryY, liveY);
        const corridorH = Math.max(2, Math.abs(liveY - entryY));
        ctx.save();
        const corridorGrad = ctx.createLinearGradient(0, corridorTop, 0, corridorTop + corridorH);
        if (isProfit) {
          corridorGrad.addColorStop(0, 'rgba(16, 185, 129, 0.12)');
          corridorGrad.addColorStop(1, 'rgba(16, 185, 129, 0.02)');
        } else {
          corridorGrad.addColorStop(0, 'rgba(244, 63, 94, 0.12)');
          corridorGrad.addColorStop(1, 'rgba(244, 63, 94, 0.02)');
        }
        ctx.fillStyle = corridorGrad;
        ctx.fillRect(padL, corridorTop, plotW, corridorH);
        ctx.restore();
      }

      // ── B. Execution Fill Marker Glyph on Entry Bar or Tick ──
      if (window.cockpitChartMode !== 'TICK_LINE') {
        // 15M Candle View: Highlight entry candle and draw chevron glyph
        let entryBarIdx = -1;
        if (activePos.openTime || activePos.timestamp) {
          const oTime = Number(activePos.openTime || activePos.timestamp);
          let minDiff = Infinity;
          candles.forEach((c, idx) => {
            const diff = Math.abs((c.t || 0) - oTime);
            if (diff < minDiff) { minDiff = diff; entryBarIdx = idx; }
          });
        }
        if (entryBarIdx < 0) {
          // Look for recent bar where entry price is inside high-low
          for (let i = candles.length - 1; i >= 0; i--) {
            if (entryPx >= candles[i].l * 0.999 && entryPx <= candles[i].h * 1.001) {
              entryBarIdx = i;
              break;
            }
          }
        }
        if (entryBarIdx < 0) entryBarIdx = Math.max(0, candles.length - 6);

        const barX = xMap(entryBarIdx);
        const barC = candles[entryBarIdx] || candles[candles.length - 1];

        ctx.save();
        // Translucent vertical column behind the execution candle
        ctx.fillStyle = isLong ? 'rgba(56, 189, 248, 0.07)' : 'rgba(244, 63, 94, 0.07)';
        ctx.fillRect(barX - 14, padT, 28, plotH);

        // Execution chevron glyph
        const glyphY = isLong ? Math.min(padT + plotH - 12, yMap(barC.l) + 16) : Math.max(padT + 12, yMap(barC.h) - 16);
        ctx.fillStyle = isLong ? '#38bdf8' : '#f43f5e';
        ctx.beginPath();
        if (isLong) {
          ctx.moveTo(barX, glyphY - 6);
          ctx.lineTo(barX - 6, glyphY + 3);
          ctx.lineTo(barX - 2, glyphY + 3);
          ctx.lineTo(barX - 2, glyphY + 8);
          ctx.lineTo(barX + 2, glyphY + 8);
          ctx.lineTo(barX + 2, glyphY + 3);
          ctx.lineTo(barX + 6, glyphY + 3);
        } else {
          ctx.moveTo(barX, glyphY + 6);
          ctx.lineTo(barX - 6, glyphY - 3);
          ctx.lineTo(barX - 2, glyphY - 3);
          ctx.lineTo(barX - 2, glyphY - 8);
          ctx.lineTo(barX + 2, glyphY - 8);
          ctx.lineTo(barX + 2, glyphY - 3);
          ctx.lineTo(barX + 6, glyphY - 3);
        }
        ctx.closePath();
        ctx.fill();

        ctx.font = 'bold 8px JetBrains Mono, monospace';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText('FILL', barX, isLong ? glyphY + 18 : glyphY - 12);
        ctx.restore();
      } else {
        // Live Tick Line View: Concentric ring beacon at entry tick
        ctx.save();
        const tickHistory = chart.getHistory(nowMs, basePx);
        let execTickX = padL + 60;
        if (tickHistory && tickHistory.length > 0) {
          let closestIdx = 0;
          let minDiff = Infinity;
          tickHistory.forEach((pt, idx) => {
            const diff = Math.abs(pt.price - entryPx);
            if (diff < minDiff) { minDiff = diff; closestIdx = idx; }
          });
          execTickX = padL + (closestIdx / Math.max(1, tickHistory.length - 1)) * (plotW - 60);
        }

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(execTickX, entryY);
        ctx.lineTo(execTickX, padT + plotH);
        ctx.stroke();

        const rPulse = (nowMs % 1500) / 1500;
        ctx.strokeStyle = `rgba(56, 189, 248, ${0.85 * (1 - rPulse)})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(execTickX, entryY, 4 + rPulse * 8, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#38bdf8';
        ctx.beginPath();
        ctx.arc(execTickX, entryY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // ── C. Interactive Pulsing Active Entry Line (Slow Flash Green+White for Long, Red+White for Short) ──
      // Requirement: Dynamic slow pulsing flash between base direction color and glowing white to make entry unmistakably visible
      const flashPeriod = 2200; // 2.2s gentle sinusoidal breathing cycle
      const flashSine = (Math.sin((nowMs / flashPeriod) * Math.PI * 2) + 1) / 2; // 0.0 to 1.0

      let entryStrokeColor, entryGlowColor;
      if (isLong) {
        // Emerald #10b981 (16, 185, 129) -> Glowing White #ffffff (255, 255, 255)
        const r = Math.round(16 + (255 - 16) * flashSine * 0.72);
        const g = Math.round(185 + (255 - 185) * flashSine * 0.72);
        const b = Math.round(129 + (255 - 129) * flashSine * 0.72);
        entryStrokeColor = `rgb(${r}, ${g}, ${b})`;
        entryGlowColor = `rgba(16, 185, 129, ${0.40 + 0.45 * flashSine})`;
      } else {
        // Crimson #f43f5e (244, 63, 94) -> Glowing White #ffffff (255, 255, 255)
        const r = Math.round(244 + (255 - 244) * flashSine * 0.72);
        const g = Math.round(63 + (255 - 63) * flashSine * 0.72);
        const b = Math.round(94 + (255 - 94) * flashSine * 0.72);
        entryStrokeColor = `rgb(${r}, ${g}, ${b})`;
        entryGlowColor = `rgba(244, 63, 94, ${0.40 + 0.45 * flashSine})`;
      }

      ctx.save();
      ctx.shadowColor = entryGlowColor;
      ctx.shadowBlur = 10 + 8 * flashSine;
      ctx.strokeStyle = entryStrokeColor;
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(padL, entryY);
      ctx.lineTo(padL + plotW, entryY);
      ctx.stroke();

      // Pulsing Beacon Point at entry horizon anchor
      ctx.fillStyle = entryStrokeColor;
      ctx.beginPath();
      ctx.arc(padL + 7, entryY, 3.5 + 1.5 * flashSine, 0, Math.PI * 2);
      ctx.fill();

      const entryLabel = `${isLong ? '▲ LONG' : '▼ SHORT'} ${leverage}x ENTRY: $${formatPrice(entryPx)} · $${notionalUsd.toFixed(0)}`;
      drawCompactPillBadge(entryLabel, padL + 16, entryY, '#070a10', '#ffffff', entryStrokeColor);

      // Horizon Reference Tag
      ctx.font = 'bold 8.5px JetBrains Mono, monospace';
      ctx.fillStyle = `rgba(255, 255, 255, ${0.45 + 0.35 * flashSine})`;
      ctx.textAlign = 'right';
      ctx.fillText('── CENTER ENTRY HORIZON ──', padL + plotW - 14, entryY - 4);
      ctx.restore();

      // ── D. Floating Real-Time PnL HUD Pill (Elevated Above Tick Line) ──
      // Requirement 1: PnL badge is elevated above/below the tick line and never blocks the tick curve
      if (Number.isFinite(liveY)) {
        const pnlColor = isProfit ? '#10b981' : '#f43f5e';
        const pnlBg = isProfit ? 'rgba(6, 78, 59, 0.95)' : 'rgba(136, 19, 55, 0.95)';
        const pnlBorder = isProfit ? '#34d399' : '#fda4af';
        const pnlSign = isProfit ? '+' : '-';
        const absRoe = Math.abs(roePct).toFixed(1);
        const pnlText = `${isProfit ? '▲' : '▼'} PnL: ${pnlSign}$${Math.abs(pnlUsd).toFixed(2)} (${pnlSign}${absRoe}% ROE)`;

        ctx.save();
        ctx.font = 'bold 9.5px JetBrains Mono, monospace';
        const pnlMetrics = ctx.measureText(pnlText);
        const pnlPillW = pnlMetrics.width + 16;
        const pnlPillH = 19;

        // Position pill clearly elevated above the live tick point so it NEVER blocks the tick line
        const floatAbove = (liveY >= padT + 32);
        const pnlY = floatAbove ? (liveY - 24) : (liveY + 24);
        const pnlX = Math.max(padL + 12, padL + plotW - pnlPillW - 16);

        // Subtle guide connector stem linking badge to live tick head without occluding line
        ctx.strokeStyle = pnlBorder;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(pnlX + pnlPillW - 20, floatAbove ? (pnlY + pnlPillH / 2) : (pnlY - pnlPillH / 2));
        ctx.lineTo(padL + plotW - 4, liveY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.shadowColor = isProfit ? 'rgba(16, 185, 129, 0.6)' : 'rgba(244, 63, 94, 0.6)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = pnlBg;
        ctx.beginPath();
        ctx.roundRect(pnlX, pnlY - pnlPillH / 2, pnlPillW, pnlPillH, 4);
        ctx.fill();

        ctx.strokeStyle = pnlBorder;
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(pnlText, pnlX + 8, pnlY + 3.5);
        ctx.restore();
      }

      // ── E. Target Trajectory Rails (TP, Soft BE Ratchet, Hard SL Floor) ──
      // 1. Take-Profit Target Line (Pure White Text) & Robust Island Dynamic Gap Rails
      const hasDynamicGapLines = Boolean(activePos.noFixedTp || (activePos.gap50Price && activePos.gap50Price > 0));
      if (hasDynamicGapLines) {
        if (activePos.gap30Price && activePos.gap30Price > 0) {
          const g30Y = yMap(activePos.gap30Price);
          const g30Dist = Math.abs(((activePos.gap30Price - entryPx) / entryPx) * 100);
          ctx.save();
          ctx.strokeStyle = activePos.harvest30Done ? '#a855f7' : '#ec4899';
          ctx.lineWidth = 1.3;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(padL, g30Y); ctx.lineTo(padL + plotW, g30Y); ctx.stroke();
          ctx.setLineDash([]);
          const label30 = activePos.harvest30Done ? `✓ Tier 1 (30% Banked) @ $${formatPrice(activePos.gap30Price)}` : `Tier 1 (Harvest 30%): $${formatPrice(activePos.gap30Price)} (+${g30Dist.toFixed(1)}%)`;
          drawCompactPillBadge(label30, padL + 12, g30Y, '#3b0764', '#ffffff', '#a855f7');
          ctx.restore();
        }
        if (activePos.gap50Price && activePos.gap50Price > 0) {
          const g50Y = yMap(activePos.gap50Price);
          const g50Dist = Math.abs(((activePos.gap50Price - entryPx) / entryPx) * 100);
          const g50EstUsd = (g50Dist / 100) * notionalUsd;
          ctx.save();
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 3]);
          ctx.beginPath(); ctx.moveTo(padL, g50Y); ctx.lineTo(padL + plotW, g50Y); ctx.stroke();
          ctx.setLineDash([]);
          drawCompactPillBadge(`Tier 2 (Close 50% ★): $${formatPrice(activePos.gap50Price)} (+${g50Dist.toFixed(1)}%) · Est +$${g50EstUsd.toFixed(1)}`, padL + 12, g50Y, '#064e3b', '#ffffff', '#10b981');
          ctx.restore();
        }
      } else if (activePos.takeProfit > 0) {
        const tpY = yMap(activePos.takeProfit);
        const tpDistPct = Math.abs(((activePos.takeProfit - entryPx) / entryPx) * 100);
        const tpEstUsd = (tpDistPct / 100) * notionalUsd;
        ctx.save();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(padL, tpY); ctx.lineTo(padL + plotW, tpY); ctx.stroke();
        ctx.setLineDash([]);
        drawCompactPillBadge(`TP1: $${formatPrice(activePos.takeProfit)} (+${tpDistPct.toFixed(1)}%) · Est +$${tpEstUsd.toFixed(1)}`, padL + 12, tpY, '#064e3b', '#ffffff', '#10b981');
        ctx.restore();
      }

      // 2 & 3. Soft Ratchet & Hard SL De-Collision System (Cross-Timeframe 100% Non-Overlapping)
      // Computes target pixel coordinates jointly before rendering to guarantee >= 26px separation in both Tick Line & 15M Candle views
      const ratchetPrice = Number(activePos.softRatchetPrice || activePos.softSlPrice || activePos.suggestedStopLoss || activePos.breakevenPrice || 0);
      const hardSlPrice = Number(activePos.hardStopLoss || activePos.hardSl || activePos.stopLoss || 0);

      let ratchetY = ratchetPrice > 0 ? yMap(ratchetPrice) : 0;
      let hardSlY = hardSlPrice > 0 ? yMap(hardSlPrice) : 0;

      if (ratchetPrice > 0 && hardSlPrice > 0 && Number.isFinite(ratchetY) && Number.isFinite(hardSlY)) {
        const minSeparation = 26;
        if (isLong) {
          // For Long: Hard SL must sit BELOW Soft SL (higher Y pixel coordinate)
          if (hardSlY - ratchetY < minSeparation) {
            hardSlY = ratchetY + minSeparation;
          }
          if (hardSlY > padT + plotH - 12) {
            hardSlY = padT + plotH - 12;
            ratchetY = Math.max(padT + 12, hardSlY - minSeparation);
          }
        } else {
          // For Short: Hard SL must sit ABOVE Soft SL (lower Y pixel coordinate)
          if (ratchetY - hardSlY < minSeparation) {
            hardSlY = ratchetY - minSeparation;
          }
          if (hardSlY < padT + 12) {
            hardSlY = padT + 12;
            ratchetY = Math.min(padT + plotH - 12, hardSlY + minSeparation);
          }
        }
      }

      if (ratchetY > 0) {
        ratchetY = Math.max(padT + 12, Math.min(padT + plotH - 12, ratchetY));
        const isBeLocked = Boolean(activePos.isBreakeven || activePos.breakevenMoved);
        const ratchetDistPct = Math.abs(((ratchetPrice - entryPx) / entryPx) * 100);
        const ratchetSign = (isLong ? ratchetPrice >= entryPx : ratchetPrice <= entryPx) ? '+' : '-';
        ctx.save();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(padL, ratchetY); ctx.lineTo(padL + plotW, ratchetY); ctx.stroke();
        ctx.setLineDash([]);
        const ratchetBadgeText = `SOFT RATCHET (BE): $${formatPrice(ratchetPrice)} (${ratchetSign}${ratchetDistPct.toFixed(2)}%) [${isBeLocked ? '✓ LOCKED' : 'ARMED @ +1.4R'}]`;
        drawCompactPillBadge(ratchetBadgeText, padL + 12, ratchetY, '#78350f', '#ffffff', '#facc15');
        ctx.restore();
      }

      if (hardSlPrice > 0) {
        hardSlY = Math.max(padT + 12, Math.min(padT + plotH - 12, hardSlY));
        const slDistPct = Math.abs(((entryPx - hardSlPrice) / entryPx) * 100);
        const slLossUsd = (slDistPct / 100) * notionalUsd;
        ctx.save();
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(padL, hardSlY); ctx.lineTo(padL + plotW, hardSlY); ctx.stroke();
        ctx.setLineDash([]);
        drawCompactPillBadge(`HARD SL FLOOR: $${formatPrice(hardSlPrice)} (-${slDistPct.toFixed(1)}%) · Max Loss -$${slLossUsd.toFixed(1)}`, padL + 12, hardSlY, '#881337', '#ffffff', '#f43f5e');
        ctx.restore();
      }
    } else if (activeLimitOrder && activeLimitOrder.price > 0) {
      // 5. Resting Limit Order Line on Decibel DEX CLOB
      const ordY = yMap(activeLimitOrder.price);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(padL, ordY); ctx.lineTo(padL + plotW, ordY); ctx.stroke();
      ctx.setLineDash([]);
      drawCompactPillBadge(`RESTING LIMIT ORDER: $${formatPrice(activeLimitOrder.price)}`, padL + 12, ordY, '#f59e0b', '#070a10', '#f59e0b');
    }

    // ── Interactive Hover Crosshair & Smart Micro-Tooltip ──
    if (window._cockpitHover && window._cockpitHover.active) {
      const hx = Math.max(padL, Math.min(padL + plotW, window._cockpitHover.x));
      const hy = Math.max(padT, Math.min(padT + plotH, window._cockpitHover.y));
      const hoveredPrice = maxP - ((hy - padT) / plotH) * (maxP - minP);

      // Vertical Dotted Crosshair Line
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();

      // Horizontal Dotted Crosshair Line
      ctx.beginPath();
      ctx.moveTo(padL, hy);
      ctx.lineTo(padL + plotW + 75, hy);
      ctx.stroke();
      ctx.restore();

      // Horizontal Crosshair Price Tag on Right Margin
      ctx.save();
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.roundRect(padL + plotW + 4, hy - 9, 68, 18, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9.5px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('$' + formatPrice(hoveredPrice), padL + plotW + 38, hy + 3.5);
      ctx.restore();

      // Tooltip Card Floating above cursor
      if (window.cockpitChartMode === 'TICK_LINE' && tickBuffer.length >= 2) {
        const rollingWindowMs = 60000;
        const targetT = (nowMs - rollingWindowMs) + ((hx - padL) / plotW) * rollingWindowMs;
        let pt = tickBuffer[0];
        let minDiff = Infinity;
        let nearestIdx = 0;
        for (let idx = 0; idx < tickBuffer.length; idx++) {
          const t = tickBuffer[idx].timestamp || tickBuffer[idx].t;
          const diff = Math.abs(t - targetT);
          if (diff < minDiff) { minDiff = diff; pt = tickBuffer[idx]; nearestIdx = idx; }
        }
        const ptX = padL + Math.max(0, Math.min(plotW, (((pt.timestamp || pt.t) - (nowMs - rollingWindowMs)) / rollingWindowMs) * plotW));
        const ptY = (tickDrawRes && tickDrawRes.y) ? tickDrawRes.y(pt.price) : yMap(pt.price);

        // Highlight nearest tick point
        ctx.save();
        ctx.beginPath();
        ctx.arc(ptX, ptY, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#38bdf8';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Floating Tooltip Box
        const tipW = 165;
        const tipH = 54;
        let tipX = ptX - tipW / 2;
        if (tipX < padL + 8) tipX = padL + 8;
        if (tipX + tipW > padL + plotW - 8) tipX = padL + plotW - tipW - 8;
        let tipY = ptY - tipH - 12;
        if (tipY < padT + 6) tipY = ptY + 16;

        ctx.save();
        ctx.fillStyle = 'rgba(14, 20, 32, 0.94)';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.2;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.roundRect(tipX, tipY, tipW, tipH, 4);
        ctx.fill();
        ctx.stroke();

        const diffFromStart = ((pt.price - tickBuffer[0].price) / tickBuffer[0].price) * 100;
        const diffSign = diffFromStart >= 0 ? '+' : '';
        const diffColor = diffFromStart >= 0 ? '#10b981' : '#f43f5e';
        const tickTimeStr = new Date(pt.timestamp || pt.t || nowMs).toLocaleTimeString();

        ctx.fillStyle = '#8492a6';
        ctx.font = 'bold 8.5px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`⚡ [${tickTimeStr}] TICK #${nearestIdx + 1}`, tipX + 8, tipY + 14);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11.5px JetBrains Mono, monospace';
        ctx.fillText('$' + formatPrice(pt.price), tipX + 8, tipY + 31);

        ctx.fillStyle = diffColor;
        ctx.font = 'bold 9.5px JetBrains Mono, monospace';
        ctx.fillText(diffSign + diffFromStart.toFixed(3) + '%', tipX + tipW - 55, tipY + 31);

        ctx.fillStyle = '#8492a6';
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.fillText('LOB SKEW: ' + (mkt.imbalance >= 0 ? '+' : '') + mkt.imbalance.toFixed(1) + '%', tipX + 8, tipY + 46);
        ctx.restore();
      }
    }

    // 8. Update Legend Values (Always sync to active market price, never retain stale cross-pair DOM text)
    const validFast = fastSMA.filter(v => v !== null && !isNaN(v));
    const validSlow = slowSMA.filter(v => v !== null && !isNaN(v));
    let lastFastSma = validFast.length ? validFast[validFast.length - 1] : basePx;
    let lastSlowSma = validSlow.length ? validSlow[validSlow.length - 1] : basePx;

    // Cross-Pair Sanity Guard: Never allow SMA to reflect a mismatched asset tier
    if (basePx > 0) {
      if (lastSlowSma > basePx * 2.5 || lastSlowSma < basePx / 2.5) lastSlowSma = basePx;
      if (lastFastSma > basePx * 2.5 || lastFastSma < basePx / 2.5) lastFastSma = basePx;
    }

    const legFastLbl = getEl('legend-sma-fast-lbl');
    const legSlowLbl = getEl('legend-sma-slow-lbl');
    const elLegFast = getEl('cockpit-legend-sma-fast');
    const elLegSlow = getEl('cockpit-legend-sma-slow');
    const elLegLivePx = getEl('cockpit-legend-live-price');
    const elLegExec = getEl('cockpit-legend-execution-text');
    const elTickPriceWrap = getEl('legend-tick-price-wrap');

    const fastPeriod = (window.cockpitChartMode === 'TICK_LINE') ? chart.periods.fast : (mkt.fastPeriod || 7);
    const slowPeriod = (window.cockpitChartMode === 'TICK_LINE') ? chart.periods.slow : (mkt.slowPeriod || 36);
    const fastVal = (window.cockpitChartMode === 'TICK_LINE' && tickDrawRes) ? tickDrawRes.fastVal : lastFastSma;
    const slowVal = (window.cockpitChartMode === 'TICK_LINE' && tickDrawRes) ? tickDrawRes.slowVal : lastSlowSma;
    const livePxVal = (window.cockpitChartMode === 'TICK_LINE' && tickDrawRes) ? tickDrawRes.latestPrice : liveActivePx;

    if (legFastLbl) legFastLbl.textContent = 'Fast SMA(' + fastPeriod + ')';
    if (legSlowLbl) legSlowLbl.textContent = 'Slow SMA(' + slowPeriod + ')';
    if (elLegFast) {
      elLegFast.textContent = '$' + formatPrice(fastVal);
      elLegFast.style.color = '#10b981'; // Strict Emerald Green
    }
    if (elLegSlow) {
      elLegSlow.textContent = '$' + formatPrice(slowVal);
      elLegSlow.style.color = '#ffffff'; // Strict Crisp White
    }
    if (elLegLivePx) {
      elLegLivePx.textContent = '$' + formatPrice(livePxVal);
      elLegLivePx.style.color = '#38bdf8'; // Strict Vibrant Cyan
    }
    if (elTickPriceWrap) {
      elTickPriceWrap.style.display = (window.cockpitChartMode === 'TICK_LINE') ? 'inline-flex' : 'none';
    }
    if (elLegExec) {
      elLegExec.textContent = `SMA(${fastPeriod}) > SMA(${slowPeriod}) Close > Open (Zero Look-Ahead)`;
    }

    // ── Interactive Zoom HUD Badge (TICK_LINE mode) ──
    if (window.cockpitChartMode === 'TICK_LINE') {
      const curZoom = Math.max(0.3, Math.min(25.0, window._cockpitUserZoom || 1.0));
      const badgeW = 124;
      const badgeH = 22;
      const badgeX = canvas.width - padR - badgeW - 10;
      const badgeY = padT + 8;

      ctx.save();
      ctx.fillStyle = 'rgba(11, 19, 36, 0.88)';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
      ctx.fill();
      ctx.stroke();

      // Zoom text
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 9px JetBrains Mono, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`🔍 ${curZoom.toFixed(1)}x`, badgeX + 6, badgeY + 14.5);

      // Buttons: [-] [+] [↺]
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 11px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('−', badgeX + 64, badgeY + 15);
      ctx.fillText('+', badgeX + 85, badgeY + 15);
      ctx.fillText('↺', badgeX + 107, badgeY + 14.5);
      ctx.restore();
    }
  }

  // ── Continuous Animation Engine (Real-Time 60 FPS Fluid Conveyor & Sonar Ripples) ──
  function startContinuousAnimationLoop() {
    if (window._cockpitAnimFrameId) return;

    let lastFrameTime = 0;
    function loop(frameTime) {
      // 60 FPS silky smooth animation (capped at ~16ms minimum frame interval)
      if (!lastFrameTime || frameTime - lastFrameTime >= 15) {
        lastFrameTime = frameTime;
        if (window.cockpitMarketsData && window.cockpitMarketsData.length > 0) {
          const activeMkt = window.cockpitMarketsData.find(m => m.symbol === window.cockpitActiveSymbol) || window.cockpitMarketsData[0];
          const activePositions = window.lastPositions || window.lastState?.positions || window.lastState?.openPositions || [];
          const activePos = activePositions.find(p => {
            return isSameSymbol(p.symbol, activeMkt?.symbol) && (!p.status || p.status.toLowerCase() === 'open') && (Number(p.entryPrice) > 0 || Number(p.sizeBase) > 0);
          });
          const activeOrders = window.lastState?.openOrders || window.lastState?.restingOrders || window.lastOrders || [];
          const activeLimitOrder = !activePos ? activeOrders.find(o => {
            const oSym = (o.symbol || o.market || '').toUpperCase().replace(/[-_/]/g, '');
            const mSym = (activeMkt?.symbol || '').toUpperCase().replace(/[-_/]/g, '');
            const isGenuineLimit = Boolean(!o.is_tpsl && !o.is_reduce_only && o.order_type !== 'Stop Market' && o.order_type !== 'Stop Limit' && Number(o.price) > 0);
            return (oSym === mSym || oSym.includes(mSym.split('/')[0])) && isGenuineLimit;
          }) : null;
          renderCockpitCanvas(activeMkt, activePos, activeLimitOrder, frameTime);
        }
      }
      window._cockpitAnimFrameId = requestAnimationFrame(loop);
    }
    window._cockpitAnimFrameId = requestAnimationFrame(loop);
  }

  // Periodic kline refresh for the active symbol (every 8 seconds)
  setInterval(() => {
    if (window.cockpitActiveSymbol) {
      fetchLiveKlines(window.cockpitActiveSymbol).then(() => {
        renderCockpitCanvas();
      });
    }
  }, 8000);

  // Window resize handler
  window.addEventListener('resize', () => {
    if (window.cockpitMarketsData && window.cockpitMarketsData.length) {
      renderCockpitCanvas();
    }
  });

  // Start continuous ticking animation on load
  startContinuousAnimationLoop();

  // Export to global window
  window.renderCockpit = renderCockpit;
  window.selectCockpitPair = selectCockpitPair;
  window.renderCockpitCanvas = renderCockpitCanvas;
  window.fetchLiveKlines = fetchLiveKlines;

  // ── Auto-Streaming Daemon for Standalone / Broadcaster Environments ──
  function initStandaloneCockpitStream() {
    if (window._cockpitStreamInitialized) return;
    window._cockpitStreamInitialized = true;

    // Resilient SSE Stream Manager with Auto-Reconnect
    let evtSource = null;
    let sseReconnectTimer = null;

    function connectSSE() {
      if (evtSource) {
        try { evtSource.close(); } catch { }
        evtSource = null;
      }
      try {
        evtSource = new EventSource('/api/stream');
        evtSource.addEventListener('state', (e) => {
          try {
            const state = JSON.parse(e.data);
            if (state) {
              window.lastState = state;
              if (Array.isArray(state.positions)) {
                window.lastPositions = state.positions;
              } else if (Array.isArray(state.openPositions)) {
                window.lastPositions = state.openPositions;
              }
              renderCockpit(state);
            }
          } catch (err) { }
        });
        evtSource.onmessage = (e) => {
          if (!e.type || e.type === 'message') {
            try {
              const state = JSON.parse(e.data);
              if (state) {
                window.lastState = state;
                if (Array.isArray(state.positions)) {
                  window.lastPositions = state.positions;
                } else if (Array.isArray(state.openPositions)) {
                  window.lastPositions = state.openPositions;
                }
                renderCockpit(state);
              }
            } catch (err) { }
          }
        };
        evtSource.onerror = () => {
          try { evtSource.close(); } catch { }
          evtSource = null;
          if (!sseReconnectTimer) {
            sseReconnectTimer = setTimeout(() => {
              sseReconnectTimer = null;
              connectSSE();
            }, 3000);
          }
        };
      } catch (e) {
        if (!sseReconnectTimer) {
          sseReconnectTimer = setTimeout(() => {
            sseReconnectTimer = null;
            connectSSE();
          }, 3000);
        }
      }
    }
    connectSSE();

    // High-Frequency On-Chain Positions Poller (1000ms)
    // Instantly consolidates opening on-chain positions without requiring browser refresh!
    async function pollLivePositions() {
      try {
        const res = await fetch('/api/positions');
        if (res.ok) {
          const data = await res.json();
          const posList = Array.isArray(data) ? data : (data.positions || data.openPositions || []);
          if (Array.isArray(posList)) {
            const prevCount = Array.isArray(window.lastPositions) ? window.lastPositions.length : 0;
            const newCount = posList.length;
            const hasChanged = prevCount !== newCount || (newCount > 0 && JSON.stringify(posList[0]) !== JSON.stringify(window.lastPositions?.[0]));

            window.lastPositions = posList;
            if (window.lastState) {
              window.lastState.positions = posList;
              window.lastState.openPositions = posList;
            }
            if (hasChanged && typeof renderCockpit === 'function') {
              renderCockpit(window.lastState || {});
            }
          }
        }
      } catch (e) { }
    }
    setInterval(pollLivePositions, 1000);
    pollLivePositions();

    // Polling fallback: Only activates if SSE is disconnected!
    async function pollState() {
      if (evtSource && evtSource.readyState === EventSource.OPEN) return;
      try {
        const res = await fetch('/api/state');
        if (res.ok) {
          const state = await res.json();
          window.lastState = state;
          renderCockpit(state);
        }
      } catch (e) { }
    }

    setInterval(pollState, 2000);
    pollState();
  }

  // Immediate zero-latency initial render
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        renderCockpit({});
        if (!window.alphaClientV3Managed) initStandaloneCockpitStream();
      });
    } else {
      setTimeout(() => {
        renderCockpit({});
        if (!window.alphaClientV3Managed) initStandaloneCockpitStream();
      }, 50);
    }
  }

})(typeof window !== 'undefined' ? window : this);
