import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface FailoverChannelState {
  primaryUrl: string;
  fallbackUrl: string;
  activeUrl: string;
  usingFallback: boolean;
  lastProbeTime: number;
}

class SimConnectionManager {
  private telemetryState: FailoverChannelState;
  private pipelineState: FailoverChannelState;
  private readonly PROBE_INTERVAL_MS = 180_000; // Probe primary every 3 minutes when on fallback

  constructor() {
    const defaultTelemPrimary = config.SIM_TELEMETRY_URL || 'https://simlab.measmony.me/api/pipeline/telemetry';
    const defaultTelemFallback = config.SIM_TELEMETRY_FALLBACK_URL || 'https://simlab.measmony.me/api/pipeline/telemetry';

    const defaultPipePrimary = config.SIM_PIPELINE_URL || 'https://simlab.measmony.me/api/pipeline/alpha-bundle';
    const defaultPipeFallback = config.SIM_PIPELINE_FALLBACK_URL || 'https://simlab.measmony.me/api/pipeline/alpha-bundle';

    this.telemetryState = {
      primaryUrl: defaultTelemPrimary,
      fallbackUrl: defaultTelemFallback,
      activeUrl: defaultTelemPrimary,
      usingFallback: false,
      lastProbeTime: 0,
    };

    this.pipelineState = {
      primaryUrl: defaultPipePrimary,
      fallbackUrl: defaultPipeFallback,
      activeUrl: defaultPipePrimary,
      usingFallback: false,
      lastProbeTime: 0,
    };
  }

  public getTelemetryStatus(): { active: string; isFallback: boolean; primary: string; fallback: string } {
    return {
      active: this.telemetryState.activeUrl,
      isFallback: this.telemetryState.usingFallback,
      primary: this.telemetryState.primaryUrl,
      fallback: this.telemetryState.fallbackUrl,
    };
  }

  public getPipelineStatus(): { active: string; isFallback: boolean; primary: string; fallback: string } {
    return {
      active: this.pipelineState.activeUrl,
      isFallback: this.pipelineState.usingFallback,
      primary: this.pipelineState.primaryUrl,
      fallback: this.pipelineState.fallbackUrl,
    };
  }

  /**
   * Post telemetry with zero-latency local first, instant fallback to public Cloudflare
   */
  public async postTelemetry(payload: any, headers: Record<string, string>): Promise<{ success: boolean; urlUsed: string }> {
    const state = this.telemetryState;
    const candidates = Array.from(new Set([
      state.activeUrl,
      state.primaryUrl,
      config.SIM_TELEMETRY_URL,
      'http://127.0.0.1:4000/api/pipeline/telemetry',
      'http://192.168.100.21:4000/api/pipeline/telemetry',
      state.fallbackUrl,
    ].filter(Boolean) as string[]));

    for (const url of candidates) {
      try {
        const res = await axios.post(url, payload, {
          headers,
          timeout: url.includes('measmony.me') ? 6000 : 3500,
        });
        if (res.status >= 200 && res.status < 300) {
          state.activeUrl = url;
          state.usingFallback = url.includes('measmony.me');
          return { success: true, urlUsed: url };
        }
      } catch (err: any) {
        // try next candidate
      }
    }

    logger.warn(`⚠️ [TELEMETRY] Push failed across all endpoints (${candidates.join(', ')})`);
    return { success: false, urlUsed: state.activeUrl };
  }

  /**
   * Fetch Alpha Bundle with local first, auto-failover to public Cloudflare
   */
  public async fetchAlphaBundle(params: any, headers: Record<string, string>): Promise<{ data: any; urlUsed: string } | null> {
    const state = this.pipelineState;

    // Background recovery probe
    if (state.usingFallback && Date.now() - state.lastProbeTime > this.PROBE_INTERVAL_MS) {
      state.lastProbeTime = Date.now();
      const primaryHealthy = await this.probeHealth(state.primaryUrl);
      if (primaryHealthy) {
        logger.info(`🔄 [AUTO-FAILOVER] Primary local alpha pipeline restored: ${state.primaryUrl}. Switching back from public fallback.`);
        state.activeUrl = state.primaryUrl;
        state.usingFallback = false;
      }
    }

    const targetUrl = state.activeUrl;
    try {
      const res = await axios.get(targetUrl, {
        params,
        headers,
        timeout: state.usingFallback ? 8000 : 3500,
      });

      if (res.data) {
        return { data: res.data, urlUsed: targetUrl };
      }
    } catch (err: any) {
      // If primary failed, try fallback
      if (!state.usingFallback && state.fallbackUrl && state.fallbackUrl !== state.primaryUrl) {
        logger.warn(`⚠️ [AUTO-FAILOVER] Primary local alpha pipeline (${targetUrl}) unreachable (${err.message}). Failing over to public Cloudflare: ${state.fallbackUrl}`);
        try {
          const fallbackRes = await axios.get(state.fallbackUrl, {
            params,
            headers,
            timeout: 8000,
          });

          if (fallbackRes.data) {
            state.activeUrl = state.fallbackUrl;
            state.usingFallback = true;
            state.lastProbeTime = Date.now();
            logger.info(`✅ [AUTO-FAILOVER] Alpha pipeline successfully received via public Cloudflare: ${state.fallbackUrl}`);
            return { data: fallbackRes.data, urlUsed: state.fallbackUrl };
          }
        } catch (fbErr: any) {
          logger.error(`❌ [AUTO-FAILOVER] Both local and public alpha pipeline endpoints failed. Local: ${err.message}, Public: ${fbErr.message}`);
          return null;
        }
      }

      return null;
    }

    return null;
  }

  private async probeHealth(targetUrl: string): Promise<boolean> {
    try {
      const origin = new URL(targetUrl).origin;
      const res = await axios.get(`${origin}/health`, { timeout: 2000 });
      return res.status === 200 && res.data?.status === 'ok';
    } catch {
      return false;
    }
  }
}

export const simConnectionManager = new SimConnectionManager();
