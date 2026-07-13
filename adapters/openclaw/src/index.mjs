import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { registerMemlumeOpenClawPlugin } from './runtime.mjs';

export default definePluginEntry({
  id: 'memlume-openclaw',
  name: 'Memlume Shared Brain',
  description: 'Connect OpenClaw turns to a local Memlume Shared Brain.',
  register(api) {
    registerMemlumeOpenClawPlugin(api);
  },
});
