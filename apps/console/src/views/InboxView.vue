<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ConsoleApi, ConsolePageState } from '../api.js';

const props = defineProps<{ readonly api?: ConsoleApi }>();
const state = ref<ConsolePageState>();
const candidates = computed(() => state.value?.status === 'error' ? [] : ((state.value?.data as { readonly memories?: Array<Record<string, unknown>> } | undefined)?.memories ?? []));
const reason = ref('');
const supersedeMemoryId = ref('');
const actionError = ref('');
const actionMessage = ref('');

async function load(): Promise<void> {
  state.value = props.api === undefined ? undefined : await props.api.loadPage('inbox');
}

watch(() => props.api, load, { immediate: true });

async function review(id: string, action: 'approve' | 'reject'): Promise<void> {
  if (props.api === undefined || reason.value.trim() === '') return;
  actionError.value = '';
  actionMessage.value = '';
  try {
    await props.api.reviewCandidate(id, action, reason.value.trim(), action === 'approve' ? supersedeMemoryId.value.trim() || undefined : undefined);
    actionMessage.value = action === 'approve' ? 'Candidate 已核准。' : 'Candidate 已拒絕。';
    await load();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '候選治理失敗。';
  }
}
</script>

<template>
  <section>
    <h1>Inbox</h1>
    <p class="lede">核准或拒絕 candidate 前必須記錄原因，治理結果會立即寫入 Shared Brain。</p>
    <label class="review-reason">治理原因<input v-model="reason" aria-label="Review reason" placeholder="為什麼核准或拒絕？" :disabled="api === undefined" /></label>
    <label class="review-reason">取代的 memory ID（只有衝突核准時需要）<input v-model="supersedeMemoryId" aria-label="Supersede memory ID" placeholder="可選填" :disabled="api === undefined" /></label>
    <p v-if="actionMessage" class="notice success" role="status" aria-live="polite">{{ actionMessage }}</p>
    <p v-if="actionError" class="notice error" role="alert">{{ actionError }}</p>
    <p v-if="state === undefined" class="notice">輸入 setup token 後即可讀取 Inbox。</p>
    <p v-else-if="state.status === 'error'" class="notice error" role="alert">{{ state.message }}</p>
    <p v-else-if="state.status === 'empty'" class="notice">沒有等待確認的 candidate。</p>
    <div v-else class="table-wrap"><table><thead><tr><th>內容</th><th>Brain</th><th>建立時間</th><th>治理</th></tr></thead><tbody><tr v-for="candidate in candidates" :key="String(candidate.id)"><td>{{ candidate.canonicalText }}</td><td><code>{{ candidate.brainId }}</code></td><td>{{ candidate.createdAt }}</td><td class="actions"><button class="approve" :disabled="reason.trim() === ''" @click="review(String(candidate.id), 'approve')">核准</button><button class="reject danger" :disabled="reason.trim() === ''" @click="review(String(candidate.id), 'reject')">拒絕</button></td></tr></tbody></table></div>
  </section>
</template>
