/**
 * Muse bridge tertiary AI tier (Hardening Pass 3, W6).
 *
 * A stub HTTP server stands in for the VM muse-bridge (:9100). The tier
 * must (1) use the bridge verdict when the bridge answers, (2) fall back
 * to local rules — never fabricate a confirmation — when it does not.
 */
import * as http from 'http';
import { LocalAIBrain } from '../src/ai/brain';

let server: http.Server;
let mode: 'confirm' | 'actions-hold' | 'garbage' | 'down' = 'confirm';

const signal: any = {
  symbol: 'BTC/USD',
  action: 'LONG',
  trend: 'BULLISH',
  riskLevel: 'MEDIUM',
  triggered: true,
  entryPrice: 100,
  stopLoss: 98.5,
  takeProfit: 103,
  riskRewardRatio: 2,
  suggestedLeverage: 5,
  confidence: 80,
  baseScore: 80,
  indicators: {},
  reasons: ['tertiary test'],
  strategyName: 'test-strategy',
  strategyTags: [],
  entryRationale: 'tertiary test',
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (mode === 'down') {
        res.writeHead(500);
        res.end('stub bridge down');
        return;
      }
      const content =
        mode === 'confirm'
          ? JSON.stringify({
              confirmed: true,
              confidenceScore: 88,
              sentiment: 'BULLISH',
              reasoning: 'stub confirm',
              riskFlags: [],
            })
          : mode === 'actions-hold'
            ? JSON.stringify({
                decided_by: 'Muse (bridge wake)',
                actions: [{ asset: 'BTC', action: 'HOLD', size_usd: 0, reason: 'weak setup, no evidence' }],
              })
            : 'this is not json';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  process.env.MUSE_BRIDGE_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.MUSE_BRIDGE_URL;
  await new Promise((resolve) => server.close(resolve));
});

describe('muse bridge tertiary tier', () => {
  it('uses the bridge verdict when the bridge answers', async () => {
    // 20s: first-call module/network warm-up in the sandbox can exceed the
    // 5s jest default even though the stub answers instantly.
    mode = 'confirm';
    const brain = new LocalAIBrain();
    const ev = await (brain as any).evaluateViaBridgeOrLocal(signal, 'PRIMARY_VALIDATOR', undefined);
    expect(ev.provider).toBe('muse_bridge');
    expect(ev.confirmed).toBe(true);
    expect(ev.action).toBe('LONG');
    expect(ev.confidenceScore).toBe(88);
  }, 20000);

  it('maps the real bridge actions format (HOLD -> not confirmed, reason kept)', async () => {
    mode = 'actions-hold';
    const brain = new LocalAIBrain();
    const ev = await (brain as any).evaluateViaBridgeOrLocal(
      { ...signal, entryPrice: 101 },
      'PRIMARY_VALIDATOR',
      undefined,
    );
    expect(ev.provider).toBe('muse_bridge');
    expect(ev.confirmed).toBe(false);
    expect(ev.action).toBe('HOLD');
    expect(ev.reasoning).toContain('weak setup, no evidence');
  });

  it('falls back to local rules when the bridge is down', async () => {
    mode = 'down';
    const brain = new LocalAIBrain();
    const ev = await (brain as any).evaluateViaBridgeOrLocal(
      { ...signal, symbol: 'ETH/USD', entryPrice: 50 },
      'PRIMARY_VALIDATOR',
      undefined,
    );
    expect(ev.provider).toBe('local_rules');
  });

  it('never fabricates a confirmation from a garbled bridge reply', async () => {
    mode = 'garbage';
    const brain = new LocalAIBrain();
    const ev = await (brain as any).evaluateViaBridgeOrLocal(
      { ...signal, symbol: 'SOL/USD', entryPrice: 10 },
      'PRIMARY_VALIDATOR',
      undefined,
    );
    // Either the parse fails (local-rules fallback) or the parsed verdict
    // lacks confirmed === true — in both cases the bridge itself must not
    // be the source of a confirmation.
    if (ev.provider === 'muse_bridge') {
      expect(ev.confirmed).toBe(false);
    }
  });
});
