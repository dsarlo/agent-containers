import { setStateDurabilityAdapterForTesting } from '../src/state.js';
import { setConfigDurabilityAdapterForTesting } from '../src/config.js';
import { setCodespacesOpsDurabilityAdapterForTesting } from '../src/codespaces-ops.js';
import { setCodespacesCapacityDurabilityAdapterForTesting } from '../src/codespaces-capacity.js';
import { setCodespacesCommandDurabilityAdapterForTesting } from '../src/codespaces-command.js';
import { setCodespacesHelperDurabilityAdapterForTesting } from '../src/codespaces-helper.js';
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
setCodespacesOpsDurabilityAdapterForTesting(testDurabilityAdapter);
setCodespacesCapacityDurabilityAdapterForTesting(testDurabilityAdapter);
setCodespacesCommandDurabilityAdapterForTesting(testDurabilityAdapter);
setCodespacesHelperDurabilityAdapterForTesting(testDurabilityAdapter);
