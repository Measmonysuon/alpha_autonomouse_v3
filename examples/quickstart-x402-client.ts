/**
 * Sim Lab Alpha Intelligence — MCP & x402 Quickstart Client
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates:
 * 1. Connecting to remote MCP SSE endpoint (https://simlab.measmony.me/mcp/sse)
 * 2. Querying free macro regime (get_market_regime) at zero cost ($0.00)
 * 3. Inspecting real-time x402 credit balance
 * 4. Executing high-conviction paid pre_trade_check ($0.15 USDC)
 */

import axios from 'axios';

const SIMLAB_HOST = process.env.SIMLAB_HOST || 'https://simlab.measmony.me';
const CLIENT_ID = process.env.CLIENT_ID || 'quickstart-bot-01';

async function main() {
  console.log(`\n======================================================`);
  console.log(`🤖 CONNECTING TO SIM LAB MCP SSE (${SIMLAB_HOST})`);
  console.log(`   Client ID: ${CLIENT_ID}`);
  console.log(`======================================================\n`);

  // Step 1: Connect to Remote MCP SSE Stream
  console.log(`[1] Establishing SSE stream connection...`);
  const sseRes = await axios.get(`${SIMLAB_HOST}/mcp/sse`, {
    headers: {
      'x-client-id': CLIENT_ID,
      'x-wallet': 'all',
      'Accept': 'text/event-stream',
    },
    responseType: 'stream',
  });

  let messageEndpoint = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSE connection timeout')), 8000);
    sseRes.data.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/data:\s*([^\r\n]+)/);
      if (match && match[1].includes('/mcp/messages')) {
        messageEndpoint = match[1].trim();
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const postUrl = messageEndpoint.startsWith('http')
    ? messageEndpoint
    : `${SIMLAB_HOST}${messageEndpoint}`;
  console.log(`   SSE Connected. Session Endpoint: ${postUrl}`);

  // Helper to send JSON-RPC tool calls
  const callTool = async (name: string, args: Record<string, any>, id: string) => {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tool ${name} timeout`)), 10000);
      const listener = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.substring(6));
              if (parsed.id === id) {
                clearTimeout(timer);
                sseRes.data.off('data', listener);
                resolve(parsed);
              }
            } catch {}
          }
        }
      };
      sseRes.data.on('data', listener);

      axios.post(postUrl, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': CLIENT_ID,
          'x-wallet': 'all',
        },
      }).catch(reject);
    });
  };

  // Step 2: Query Free Headline Market Regime ($0.00)
  console.log(`\n[2] Calling get_market_regime (100% Free / $0.00)...`);
  const regimeRes = await callTool('get_market_regime', {}, 'call_regime_1');
  const regimeData = JSON.parse(regimeRes.result?.content?.[0]?.text || '{}');
  console.log(`   Headline Regime: ${regimeData.headlineRegime || regimeData.regime}`);
  console.log(`   Market Bias:     ${regimeData.bias || regimeData.marketBias}`);
  console.log(`   Risk Multiplier: ${regimeData.riskMultiplier || '1.0x'}`);

  // Step 3: Query Account Balance on /x402/balance
  console.log(`\n[3] Checking x402 credit balance...`);
  const balRes = await axios.get(`${SIMLAB_HOST}/x402/balance?clientId=${CLIENT_ID}`);
  console.log(`   Current Balance: ${balRes.data.balanceMicro} micro ($${balRes.data.balanceUsd} USD)`);

  // Step 4: Execute Evaluative pre_trade_check
  console.log(`\n[4] Executing pre_trade_check for ETH/USD (SHORT)...`);
  const checkRes = await callTool('pre_trade_check', { symbol: 'ETH/USD', side: 'SHORT' }, 'call_check_1');

  if (checkRes.error) {
    if (checkRes.error.code === -32042) {
      console.log(`   ⚡ HTTP 402 / JSON-RPC -32042 Payment Required returned!`);
      console.log(`   Teaser Risk Band: ${checkRes.error.data?.teaser?.riskBand}`);
      console.log(`   Proof Record:     ${checkRes.error.data?.teaser?.proof}`);
      console.log(`   Top-up via POST:  ${checkRes.error.data?.topup}`);
    } else {
      console.error(`   Error:`, checkRes.error);
    }
  } else {
    const verdictData = JSON.parse(checkRes.result?.content?.[0]?.text || '{}');
    console.log(`   Verdict: ${verdictData.verdict}`);
    console.log(`   Advice:  ${verdictData.advice}`);
    console.log(`   VPIN:    ${verdictData.underlying?.trapShield?.vpinToxicity}`);
  }

  console.log(`\n======================================================`);
  console.log(`🎉 QUICKSTART COMPLETED SUCCESSFULLY`);
  console.log(`======================================================\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Quickstart error:', err);
  process.exit(1);
});
