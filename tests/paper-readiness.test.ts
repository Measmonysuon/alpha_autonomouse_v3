/**
 * Paper-readiness gate (Hardening Pass 3, W3).
 *
 * The trading loop's readiness is: isClientConfigured() || isPaperReady().
 * Before the fix, isClientOnboarded() returned false whenever no Decibel
 * credentials were configured, which made the paper branch unreachable —
 * a paper activation could never unlock simulated fills. These tests pin
 * the intended matrix against hermetic fixture settings files.
 */
import * as fs from 'fs';

const settingsPath = process.env.ALPHA_SETTINGS_FILE as string;

const BASE: any = {
  trading: { budgetUsd: 200, maxLeverage: 13, paperTrading: true },
  ai: { model: 'gemini-4-argon' },
};

function freshConfig(settings: any) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  jest.resetModules();
  return require('../src/config');
}

describe('paper readiness gate', () => {
  it('no creds + paper + onboarded -> onboarded and paper-ready', () => {
    const cfg = freshConfig({ ...BASE, onboarded: true });
    expect(cfg.isClientConfigured()).toBe(false);
    expect(cfg.isClientOnboarded()).toBe(true);
    expect(cfg.isPaperReady()).toBe(true);
  });

  it('no creds + paper + paperActivated -> paper-ready (onboard-later path)', () => {
    const cfg = freshConfig({ ...BASE, paperActivated: true });
    expect(cfg.isClientConfigured()).toBe(false);
    expect(cfg.isClientOnboarded()).toBe(true);
    expect(cfg.isPaperReady()).toBe(true);
  });

  it('no creds + paper + never onboarded -> locked', () => {
    const cfg = freshConfig({ ...BASE });
    expect(cfg.isClientConfigured()).toBe(false);
    expect(cfg.isClientOnboarded()).toBe(false);
    expect(cfg.isPaperReady()).toBe(false);
  });

  it('paper OFF + onboarded -> onboarded but NOT paper-ready', () => {
    const cfg = freshConfig({
      trading: { budgetUsd: 200, maxLeverage: 13, paperTrading: false },
      ai: { model: 'gemini-4-argon' },
      onboarded: true,
    });
    expect(cfg.isClientOnboarded()).toBe(true);
    expect(cfg.isPaperReady()).toBe(false);
  });

  it('credentials configured -> configured and onboarded regardless of flags', () => {
    const key = 'ed25519-priv-0x' + 'a'.repeat(64);
    const sub = '0x' + 'b'.repeat(64);
    const cfg = freshConfig({
      ...BASE,
      credentials: { decibelDelegateKey: key, decibelSubaccount: sub },
      decibelPrivateKey: key,
      decibelSubaccount: sub,
    });
    expect(cfg.isClientConfigured()).toBe(true);
    expect(cfg.isClientOnboarded()).toBe(true);
  });
});
