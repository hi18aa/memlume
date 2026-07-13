<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const data = computed(() => state.value?.status === 'error' ? {} : (state.value?.data ?? {}) as Record<string, unknown>);

async function load(): Promise<void> {
  state.value = props.api === undefined ? undefined : await props.api.loadPage('dashboard');
}

watch(() => props.api, load, { immediate: true });
</script>

<template>
  <section>
    <h1>Dashboard</h1>
    <p class="lede">確認本機 Shared Brain 的健康狀態、資料庫與已掛載範圍。</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可讀取本機狀態。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">資料庫健康，但尚無其他 Shared Brain。</p>
    <dl v-else class="summary-grid">
      <div><dt>健康</dt><dd>{{ data.health ?? 'unknown' }}</dd></div>
      <div><dt>完整性</dt><dd>{{ data.integrity ?? 'unknown' }}</dd></div>
      <div><dt>Brains</dt><dd>{{ Array.isArray(data.brains) ? data.brains.length : 0 }}</dd></div>
      <div><dt>Mounts</dt><dd>{{ Array.isArray(data.mounts) ? data.mounts.length : 0 }}</dd></div>
    </dl>
  </section>
</template>
