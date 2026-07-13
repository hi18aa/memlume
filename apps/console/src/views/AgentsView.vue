<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const installations = computed(() => state.value?.status === 'error' ? [] : ((state.value?.data as { readonly installations?: Array<Record<string, unknown>> } | undefined)?.installations ?? []));
const clientType = ref('');
const installationId = ref('');
const profileId = ref('default');
const displayName = ref('');
const issuedToken = ref('');
const actionError = ref('');

async function load(): Promise<void> {
  state.value = props.api === undefined ? undefined : await props.api.loadPage('agents');
}

watch(() => props.api, load, { immediate: true });

async function register(): Promise<void> {
  if (props.api === undefined || clientType.value.trim() === '' || installationId.value.trim() === '' || profileId.value.trim() === '') return;
  actionError.value = '';
  try {
    const result = await props.api.registerInstallation({ clientType: clientType.value.trim(), installationId: installationId.value.trim(), profileId: profileId.value.trim(), displayName: displayName.value.trim() || undefined }) as { readonly token?: string };
    issuedToken.value = result.token ?? '';
    await load();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '註冊 Agent 失敗。';
  }
}

async function rotate(id: string): Promise<void> {
  if (props.api === undefined) return;
  actionError.value = '';
  try {
    issuedToken.value = await props.api.rotateToken(id);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '輪替 token 失敗。';
  }
}
</script>

<template>
  <section>
    <h1>Agents</h1>
    <p class="lede">註冊 Agent、輪替 token，並在 Brains 頁面為它掛載共享記憶。</p>
    <form class="agent-form" @submit.prevent="register">
      <input v-model="clientType" aria-label="Client type" placeholder="Client type，例如 codex" :disabled="api === undefined" />
      <input v-model="installationId" aria-label="Installation ID" placeholder="Installation ID" :disabled="api === undefined" />
      <input v-model="profileId" aria-label="Profile ID" placeholder="Profile ID" :disabled="api === undefined" />
      <input v-model="displayName" aria-label="Display name" placeholder="顯示名稱（可選）" :disabled="api === undefined" />
      <button :disabled="api === undefined || clientType.trim() === '' || installationId.trim() === '' || profileId.trim() === ''">註冊 Agent</button>
    </form>
    <p v-if="issuedToken" class="notice success" role="status" aria-live="polite">新的 token（請立即寫入 Agent 設定）：<code>{{ issuedToken }}</code></p>
    <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可讀取 Agent。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">尚未註冊 Agent。</p>
    <div v-else class="table-wrap"><table><thead><tr><th>顯示名稱</th><th>類型</th><th>Installation</th><th>Profile</th><th>token</th></tr></thead><tbody><tr v-for="agent in installations" :key="String(agent.id)"><td>{{ agent.displayName ?? '—' }}</td><td>{{ agent.clientType }}</td><td>{{ agent.installationId }}</td><td>{{ agent.profileId }}</td><td><button class="rotate" @click="rotate(String(agent.id))">輪替</button></td></tr></tbody></table></div>
  </section>
</template>
