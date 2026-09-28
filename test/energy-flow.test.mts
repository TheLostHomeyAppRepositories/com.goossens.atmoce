import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { energyFlow } from '../lib/energy-flow.mts';
import type { Snapshot } from '../lib/gateway.mts';

/** Gateway sign conventions: storage + discharging, grid + importing. */
function snapshot(pvPowerW: number, storagePowerW: number, gridPowerW: number, socPercent = 50): Snapshot {
  return {
    status: {
      stationFault: false,
      storageStatus: 'idle',
      storageMode: 'self_consumption',
      pvPowerW,
      storagePowerW,
      gridPowerW,
      pvReactivePowerVar: 0,
      storageReactivePowerVar: 0,
      raw: { stationStatus: 0, storageStatus: 99, storageMode: 1 },
    },
    phases: { phases: [{ voltageV: 230, currentA: 0 }, { voltageV: 0, currentA: 0 }, { voltageV: 0, currentA: 0 }], socPercent },
    energy: {
      pvTotalKwh: 0,
      pvTodayKwh: 15.84,
      chargedTotalKwh: 0,
      chargedTodayKwh: 8.19,
      dischargedTotalKwh: 0,
      dischargedTodayKwh: 6.57,
      exportedTotalKwh: 0,
      exportedTodayKwh: 0.2,
      importedTotalKwh: 0,
      importedTodayKwh: 2.45,
    },
    limits: null,
    control: null,
    gridState: null,
    powerLimits: null,
    startedAt: 0,
  };
}

describe('energyFlow', () => {
  it('evening on a real MC100: the battery covers the home', () => {
    const flow = energyFlow('SN', snapshot(0, 966, 9), true);
    assert.equal(flow.homeW, 975);
    assert.equal(flow.batteryW, -966);
    assert.equal(flow.flows.batteryToHome, 966);
    assert.equal(flow.flows.gridToHome, 9);
    assert.equal(flow.flows.solarToHome, 0);
    assert.equal(flow.today.selfSufficiencyPercent, 85);
  });

  it('sunny afternoon: solar serves home, battery, then grid', () => {
    const flow = energyFlow('SN', snapshot(5494, -4127, 0), true);
    assert.equal(flow.homeW, 1367);
    assert.deepEqual(flow.flows, {
      solarToHome: 1367, solarToBattery: 4127, solarToGrid: 0, batteryToHome: 0, gridToHome: 0, gridToBattery: 0, batteryToGrid: 0,
    });
  });

  it('battery full: surplus goes to the grid', () => {
    // Real MC100 reading: the battery idles at a stray +8 W while 2070 W is exported.
    const flow = energyFlow('SN', snapshot(3539, 8, -2070), true);
    assert.equal(flow.flows.solarToHome, flow.homeW);
    assert.equal(flow.flows.solarToGrid + flow.flows.batteryToGrid, 2070);
    assert.ok(flow.flows.batteryToGrid < 10); // noise, hidden by the widget
  });

  it('forced charging from the grid at night', () => {
    const flow = energyFlow('SN', snapshot(0, -3000, 3400), true);
    assert.equal(flow.homeW, 400);
    assert.equal(flow.flows.gridToHome, 400);
    assert.equal(flow.flows.gridToBattery, 3000);
  });

  it('discharging into the grid (forced discharge)', () => {
    const flow = energyFlow('SN', snapshot(0, 2500, -2000), true);
    assert.equal(flow.flows.batteryToHome, 500);
    assert.equal(flow.flows.batteryToGrid, 2000);
  });

  it('never produces negative flows from inconsistent readings', () => {
    const flow = energyFlow('SN', snapshot(100, -500, -300), true);
    for (const value of Object.values(flow.flows)) assert.ok(value >= 0);
  });
});
