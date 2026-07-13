<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const memories = computed(() => state.value?.status === 'error' ? [] : ((state.value?.data as { readonly memories?: Array<Record<string, unknown>> } | undefined)?.memories ?? []));
const copyMessage = ref('');

async function load(): Promise<void> {
  state.value = props.api === undefined ? undefined : await props.api.loadPage('memories');
}

watch(() => props.api, load, { immediate: true });

async function copyMemoryId(id: string): Promise<void> {
  try {
    if (navigator.clipboard === undefined) {
      throw new Error('Clipboard unavailable.');
    }
    await navigator.clipboard.writeText(id);
    copyMessage.value = '已複製 memory ID。';
  } catch {
    copyMessage.value = '請選取並複製 memory ID。';
  }
}
</script>

<template>
  <section>
    <h1>Memories</h1>
    <p class="lede">檢視已保存的共享記憶、scope、來源與最後更新時間。</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可讀取記憶。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">目前沒有記憶。</p>
    <p v-if="copyMessage" class="notice success" role="status" aria-live="polite">{{ copyMessage }}</p>
    <div v-if="state?.status === 'success'" class="table-wrap"><table><thead><tr><th>內容</th><th>Memory ID</th><th>狀態</th><th>Brain</th><th>更新時間</th></tr></thead><tbody><tr v-for="memory in memories" :key="String(memory.id)"><td>{{ memory.canonicalText }}</td><td><code class="memory-id" tabindex="0">{{ memory.id }}</code><button class="copy-memory-id" :aria-label="`Copy memory ID ${memory.id}`" @click="copyMemoryId(String(memory.id))">複製</button></td><td>{{ memory.status }}</td><td><code>{{ memory.brainId }}</code></td><td>{{ memory.updatedAt }}</td></tr></tbody></table></div>
  </section>
</template>
