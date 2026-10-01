/**
 * System & Hardware Telemetry Utility
 * Reads real-time CPU, Unified RAM, NVMe Swap, Storage, and Thermals
 */

import os from 'os';
import fs from 'fs';
import path from 'path';

export interface SystemHardwareStats {
  nodeName: string;
  platform: string;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    model: string;
    loadAvg: number[];
  };
  memory: {
    totalMb: number;
    availableMb: number;
    usedMb: number;
    usedPct: number;
  };
  swap: {
    totalMb: number;
    usedMb: number;
    freeMb: number;
    usedPct: number;
  };
  storage: {
    totalGb: number;
    freeGb: number;
    usedGb: number;
    usedPct: number;
  };
  thermals: {
    cpuTemp: number | null;
    gpuTemp: number | null;
    socTemp: number | null;
  };
  agentProcess: {
    pid: number;
    uptimeSeconds: number;
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
  desktopGui: {
    active: boolean;
    status: string;
    target: string;
  };
  isHeadless: boolean;
}

export function getSystemHardwareStats(): SystemHardwareStats {
  const cpus = os.cpus();
  const uptime = Math.floor(os.uptime());
  const loadAvg = os.loadavg();

  // Read /proc/meminfo if on Linux
  let totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  let availMemMb = Math.round(os.freemem() / (1024 * 1024));
  let swapTotalMb = 0;
  let swapFreeMb = 0;

  try {
    if (fs.existsSync('/proc/meminfo')) {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8').split('\n');
      const parse = (key: string) => {
        const line = meminfo.find((l) => l.startsWith(key + ':'));
        if (!line) return 0;
        return parseInt(line.replace(/[^0-9]/g, ''), 10);
      };
      const t = parse('MemTotal');
      const a = parse('MemAvailable');
      const st = parse('SwapTotal');
      const sf = parse('SwapFree');
      if (t > 0) totalMemMb = Math.round(t / 1024);
      if (a > 0) availMemMb = Math.round(a / 1024);
      if (st > 0) swapTotalMb = Math.round(st / 1024);
      if (sf > 0) swapFreeMb = Math.round(sf / 1024);
    }
  } catch {}

  const usedMemMb = Math.max(0, totalMemMb - availMemMb);
  const usedMemPct = totalMemMb > 0 ? Number(((usedMemMb / totalMemMb) * 100).toFixed(1)) : 0;
  const usedSwapMb = Math.max(0, swapTotalMb - swapFreeMb);
  const usedSwapPct = swapTotalMb > 0 ? Number(((usedSwapMb / swapTotalMb) * 100).toFixed(1)) : 0;

  // Thermals from /sys/devices/virtual/thermal
  let cpuTemp: number | null = null;
  let gpuTemp: number | null = null;
  let socTemp: number | null = null;

  try {
    for (let i = 0; i < 10; i++) {
      try {
        const typePath = `/sys/devices/virtual/thermal/thermal_zone${i}/type`;
        const tempPath = `/sys/devices/virtual/thermal/thermal_zone${i}/temp`;
        if (fs.existsSync(typePath) && fs.existsSync(tempPath)) {
          const type = fs.readFileSync(typePath, 'utf8').trim().toLowerCase();
          const raw = fs.readFileSync(tempPath, 'utf8').trim();
          const tVal = Number((parseInt(raw, 10) / 1000).toFixed(1));
          if (type.includes('cpu')) cpuTemp = tVal;
          else if (type.includes('gpu')) gpuTemp = tVal;
          else if (type.includes('soc0') || type.includes('soc')) socTemp = tVal;
        }
      } catch {}
    }
  } catch {}

  // Storage stats via statfsSync
  let totalGb = 0;
  let freeGb = 0;
  let usedGb = 0;
  let usedStoragePct = 0;

  try {
    if ((fs as any).statfsSync) {
      const s = (fs as any).statfsSync('/');
      totalGb = Number(((s.blocks * s.bsize) / (1024 * 1024 * 1024)).toFixed(1));
      freeGb = Number(((s.bfree * s.bsize) / (1024 * 1024 * 1024)).toFixed(1));
      usedGb = Number(Math.max(0, totalGb - freeGb).toFixed(1));
      usedStoragePct = totalGb > 0 ? Number(((usedGb / totalGb) * 100).toFixed(1)) : 0;
    }
  } catch {}

  const isMac = os.platform() === 'darwin';
  const nodeName = isMac ? 'Apple Silicon' : 'NVIDIA Jetson Orin Nano';

  return {
    nodeName,
    platform: `${os.platform()} (${os.arch()})`,
    uptimeSeconds: uptime,
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || (isMac ? 'Apple Silicon' : 'ARM Cortex-A78AE'),
      loadAvg: loadAvg.map((l) => Number(l.toFixed(2))),
    },
    memory: {
      totalMb: totalMemMb,
      availableMb: availMemMb,
      usedMb: usedMemMb,
      usedPct: usedMemPct,
    },
    swap: {
      totalMb: swapTotalMb,
      usedMb: usedSwapMb,
      freeMb: swapFreeMb,
      usedPct: usedSwapPct,
    },
    storage: {
      totalGb,
      freeGb,
      usedGb,
      usedPct: usedStoragePct,
    },
    thermals: {
      cpuTemp,
      gpuTemp,
      socTemp,
    },
    agentProcess: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / (1024 * 1024)),
    },
    desktopGui: getDesktopGUIStatus(),
    isHeadless: !getDesktopGUIStatus().active,
  };
}

export function getDesktopGUIStatus(): { active: boolean; status: string; target: string; updatedAt?: string } {
  try {
    const guiPath = path.join(process.cwd(), 'data', 'gui_status.json');
    if (fs.existsSync(guiPath)) {
      const data = JSON.parse(fs.readFileSync(guiPath, 'utf8'));
      if (typeof data.active === 'boolean') {
        return data;
      }
    }
  } catch {}
  return { active: false, status: 'inactive', target: 'multi-user.target' };
}

export async function setDesktopGUIState(enabled: boolean): Promise<{ active: boolean; status: string; target: string }> {
  const cmd = enabled ? 'on' : 'off';
  const cmdPath = path.join(process.cwd(), 'data', 'gui_cmd');
  fs.writeFileSync(cmdPath, cmd, 'utf8');

  // Poll for status update up to 9 seconds (GNOME takes 4-7s to terminate)
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const status = getDesktopGUIStatus();
    if (status.active === enabled) {
      return status;
    }
  }
  return getDesktopGUIStatus();
}
