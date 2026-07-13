<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const name = ref('');
const kind = ref<'personal' | 'project' | 'domain'>('project');
const actionError = ref('');
const actionMessage = ref('');
const brains = computed(() => state.value?.status === 'error' ? [] : ((state.value?.data as { readonly brains?: Array<Record<string, unknown>> } | undefined)?.brains ?? []));
const agentState = ref<ConsolePageState>();
const installations = computed(() => agentState.value?.status === 'error' ? [] : ((agentState.value?.data as { readonly installations?: Array<Record<string, unknown>> } | undefined)?.installations ?? []));
const mountBrainId = ref('');
const mountAgentId = ref('');
const mountAccess = ref<'read' | 'read_write'>('read');

async function load(): Promise<void> {
  if (props.api === undefined) {
    state.value = undefined;
    agentState.value = undefined;
    return;
  }
  const [brainState, nextAgentState] = await Promise.all([props.api.loadPage('brains'), props.api.loadPage('agents')]);
  state.value = brainState;
  agentState.value = nextAgentState;
}

async function mount(): Promise<void> {
  if (props.api === undefined || mountBrainId.value === '' || mountAgentId.value === '') return;
  actionError.value = '';
  actionMessage.value = '';
  try {
    await props.api.mountBrain({ brainId: mountBrainId.value, agentInstallationId: mountAgentId.value, access: mountAccess.value });
    actionMessage.value = 'Brain 掛載權限已更新。';
    await load();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '掛載 Brain 失敗。';
  }
}

async function create(): Promise<void> {
  if (props.api === undefined || name.value.trim() === '') return;
  actionError.value = '';
  actionMessage.value = '';
  try {
    await props.api.createBrain({ name: name.value.trim(), kind: kind.value });
    actionMessage.value = 'Brain 已建立。';
    name.value = '';
    await load();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '建立 Brain 失敗。';
  }
}

watch(() => props.api, load, { immediate: true });
</script>

<template>
  <section>
    <h1>Brains</h1>
    <p class="lede">每個 Brain 是可獨立掛載、備份與維護的共享記憶空間。</p>
    <form class="inline-form" @submit.prevent="create">
      <input v-model="name" aria-label="Brain name" placeholder="Brain 名稱" :disabled="api === undefined" />
      <select v-model="kind" aria-label="Brain kind" :disabled="api === undefined"><option value="project">Project</option><option value="domain">Domain</option><option value="personal">Personal</option></select>
      <button :disabled="api === undefined || name.trim() === ''">建立 Brain</button>
    </form>
    <form class="mount-form" @submit.prevent="mount">
      <select v-model="mountBrainId" aria-label="Mount Brain" :disabled="api === undefined"><option value="">選擇 Brain</option><option v-for="brain in brains" :key="String(brain.id)" :value="String(brain.id)">{{ brain.name }}</option></select>
      <select v-model="mountAgentId" aria-label="Mount Agent" :disabled="api === undefined"><option value="">選擇 Agent</option><option v-for="agent in installations" :key="String(agent.id)" :value="String(agent.id)">{{ agent.displayName ?? agent.clientType }}</option></select>
      <select v-model="mountAccess" aria-label="Mount access" :disabled="api === undefined"><option value="read">Read</option><option value="read_write">Read + write</option></select>
      <button class="mount" :disabled="api === undefined || mountBrainId === '' || mountAgentId === ''">掛載 / 更新權限</button>
    </form>
    <p v-if="actionMessage" class="notice success" role="status" aria-live="polite">{{ actionMessage }}</p>
    <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可管理 Brain。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">尚無 Brain。</p>
    <div v-else class="table-wrap"><table><thead><tr><th>名稱</th><th>類型</th><th>ID</th></tr></thead><tbody><tr v-for="brain in brains" :key="String(brain.id)"><td>{{ brain.name }}</td><td>{{ brain.kind }}</td><td><code>{{ brain.id }}</code></td></tr></tbody></table></div>
  </section>
</template>
