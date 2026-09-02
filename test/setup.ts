import { setStateDurabilityAdapterForTesting } from '../src/state.js';
import { setConfigDurabilityAdapterForTesting } from '../src/config.js';
import type { StateDurabilityAdapter } from '../src/durability.js';

const testDurabilityAdapter: StateDurabilityAdapter = {
  publicationMode: async () => 'strict',
  assertStateWriteSupport: async () => undefined,
  syncFile: async () => undefined,
  syncDirectory: async () => undefined,
  moveFileWriteThrough: async () => undefined,
};

setStateDurabilityAdapterForTesting(testDurabilityAdapter);
setConfigDurabilityAdapterForTesting(testDurabilityAdapter);
