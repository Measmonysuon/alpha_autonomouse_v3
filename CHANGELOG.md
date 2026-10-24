# Changelog

All notable changes to Alpha Autonomous Client V3 will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.2.0] - 2026-10-24

### Added
- **Kingfisher & Hyblock Liquidation Heatmap UI**:
  - Live horizontal liquidation rays and volume profile histograms directly overlaid on active position candlestick charts.
  - Directional color-coding: high-density short liquidation clusters above mark price in Mint (`#2dd4bf`), high-density long liquidation clusters below mark in Coral (`#f43f5e`).
  - Target radar bullseye markers (concentric rings) highlighting primary institutional liquidation gravity magnets.
  - Institutional Microstructure HUD with real-time VPIN risk classification, Primary Magnet distance, and Dynamic Safety Wall buffer metrics.
- **ByKaranteli Microstructure & Liquidation Magnet Integration**:
  - Seamless ingestion of ByKaranteli real-time order book asymmetry, VPIN toxicity, and liquidation depth profiles via Sim Lab Alpha Bundle.
  - Dynamic Wall Soft SL Shielding: Positions automatically place and adjust soft stop losses behind the nearest opposing liquidation wall ($\ge \$1.5\text{M}$ cluster depth) with adaptive safety clearance.
  - Magnet-Assisted Dynamic TP1: Snaps TP1 targets just inside the nearest massive liquidation magnet pool to capture cascading squeeze volume.
  - Portfolio Harvester Proximity Hold: Automatically pauses trailing profit harvest execution if price is actively charging toward a high-conviction liquidation cluster ($\le 0.40\%$ away).
  - Multi-Layer AI Shield Vetoes: Evaluates order flow toxicity (VPIN $> 0.38$) and opposes trades entering directly into unyielding counter-liquidation walls.
- **Zero-Config Clean Public Onboarding**:
  - Default connection URLs set to authoritative public Cloudflare endpoints (`https://simlab.measmony.me/api/pipeline/alpha-bundle` and `telemetry`) for seamless new host deployment out of the box.
  - Clean pre-onboarding host state: No local test keys, test databases, or private credentials committed. Fresh hosts launch directly into the guided onboarding wizard.

---

## [3.1.0] - 2026-09-29

### Added
- **Always-Active Dual-Phase Ratchet Mechanism**:
  - **Capital Guard Phase (`[GUARD]`)**: Sits strictly between Entry and Hard SL during drawdown (Red) or initial trade placement. Rendered in Cyan (`#06b6d4` / `#38bdf8`) across candlestick canvas and 4-tile price matrix.
  - **Profit Lock Phase (`[LOCK]`)**: Sits between Entry and Take-Profit during confirmed breakout (Green). Rendered in Emerald (`#10b981`) across charts, matrix tiles, and gauge bars.
  - **Permanent Visibility**: Ratchet is permanently active and displayed in both Red and Green regimes (never hidden).
- **Anti-Pullback / Wick Tolerance Safeguard**:
  - The Ratchet strictly avoids premature profit locking or moving to breakeven on minor market pullbacks, noise, or small wicks (e.g. +0.1% wicks).
  - Profit locking is governed strictly by Sim Lab directives requiring verified statistical breakaway clearance ($\ge 1.50R - 1.75R$ and $\ge 2.0\times\text{ ATR}$).

### Changed
- **Dashboard Overlays & Real-Time Matrix (`dashboard/index.html`)**:
  - Updated Tile 4 to display both `🛑 Hard SL` and `🛡️ Ratchet` side-by-side with dynamic contextual badges (`[GUARD]` or `[LOCK]`).
  - Added dual-phase color styling to candlestick chart execution lines (Cyan for Guard, Emerald for Lock).
  - Synchronized Range Progress Gauge and Chart Legend tags to maintain continuous visibility.
  - Refined Strategy Block Estimated Loss calculation to anchor directly to active soft defense.
- **Trade Execution Engine (`src/trades/executor.ts`)**:
  - Eliminated artificial dependencies on undeclared variables; anchored `effectiveLossSl` to `existing.stopLoss || initialSoftSl`.
  - Harmonized soft ratchet price tracking with Sim Lab directives.

### Fixed
- Fixed issue where the Ratchet disappeared or remained hidden during loss/drawdown states in earlier dashboard builds.
- Ensured consistent trade state persistence between on-chain Decibel DEX orders and internal state journals.

---

## [3.0.0] - 2026-09-28

### Added
- Initial release of Alpha Autonomous Client V3.
- Unified 24/7 autonomous perpetual futures execution engine for Decibel DEX on Aptos.
- Real-time Sim Lab Server pipeline synchronization for fleet directives, regime adaptation, and dynamic risk management.
- Multi-layer AI Shield with Layer 4 Trap Validation and SMC structure break detection.
- Cross-platform desktop standalone distribution (macOS, Windows, Docker).
